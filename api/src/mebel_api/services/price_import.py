"""Прайс поставщика: загрузка файла с предпросмотром и источник цен по ссылке/API (§5.1, §5.5).

Разбор и публикация — общий конвейер services/catalog/pipeline.py (parser_runs → raw_price_records →
сопоставление → изменения > 15% на подтверждение → публикация в каталог и price_history).
- Файл (CSV `;`/`,`, XLSX, JSON): колонки `sku;name;price;available` (рус. названия тоже). Для известного
  артикула наименование можно не указывать. Предпросмотр = запуск парсера; подтверждение публикует всё.
- Источник цен: изменения ≤ 15% применяются сразу, остальные ждут подтверждения владельца
  (`/vendor/price-source/runs/{id}/confirm`); не подтвердил за 24 часа — видны суперадмину (очередь проверки).
- Загрузка по URL: только https, только публичные адреса (защита от SSRF), без редиректов; соединение — с уже
  проверенным IP (имя хоста — в Host и SNI, сертификат проверяется по имени); общий срок и лимит размера.
  «Обновить сейчас» — фоновой задачей (services/tasks.py), запрос сразу отвечает запуском в статусе `running`.
- XLSX — это zip: до openpyxl проверяем архив (размер распакованного, степень сжатия, число файлов) — защита
  от zip-бомбы; читаем не больше MAX_ROWS строк и MAX_COLS колонок.
"""

import csv
import io
import ipaddress
import json
import socket
import time
import zipfile
from datetime import timedelta
from typing import Any, Iterable
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError
from ..models import CatalogItem, ParserRun, RawPriceRecord, Supplier, SupplierPriceSource
from .catalog import pipeline
from .catalog.sources import CSV_ALIASES, RawItem, item_from_fields

PREVIEW_TTL = timedelta(hours=1)
MAX_ROWS = 20_000
MAX_COLS = 100
FORMATS = ("csv", "xlsx", "json")
# Zip-бомба: распакованный XLSX не больше 50 МБ, файлов в архиве не больше 1000, степень сжатия файла
# больше 1 МБ — не больше 100 (обычный прайс сжимается в 5–30 раз)
XLSX_MAX_UNCOMPRESSED = 50 * 1024 * 1024
XLSX_MAX_MEMBERS = 1000
XLSX_MAX_RATIO = 100
XLSX_RATIO_MIN_SIZE = 1024 * 1024
RUNNING_STALE = timedelta(minutes=10)  # «обновить сейчас» в работе дольше — считаем зависшим


# --- Чтение файла ---


def detect_format(file_name: str | None, data: bytes) -> str:
    name = (file_name or "").lower()
    if name.endswith(".xlsx") or data[:2] == b"PK":
        return "xlsx"
    if name.endswith(".json") or data.lstrip()[:1] in (b"[", b"{"):
        return "json"
    return "csv"


def read_rows(data: bytes, fmt: str) -> list[dict[str, Any]]:
    if fmt == "xlsx":
        return _xlsx_rows(data)
    if fmt == "json":
        try:
            obj = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(422, "invalid_file", "Не удалось прочитать JSON") from None
        if isinstance(obj, dict):
            obj = obj.get("items") or obj.get("data") or obj.get("products") or []
        if not isinstance(obj, list):
            raise ApiError(422, "invalid_file", "В JSON нужен список позиций")
        return [r for r in obj[:MAX_ROWS] if isinstance(r, dict)]
    text = None
    for enc in ("utf-8-sig", "cp1251"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ApiError(422, "invalid_file", "Нужна кодировка UTF-8 или Windows-1251")
    first = text.splitlines()[0] if text else ""
    reader = csv.DictReader(io.StringIO(text), delimiter=";" if first.count(";") >= first.count(",") else ",")
    rows = []
    for i, row in enumerate(reader):
        if i >= MAX_ROWS:
            break
        rows.append({k: v for k, v in row.items() if k})
    return rows


def check_xlsx_archive(data: bytes) -> None:
    """До openpyxl: архив не должен распаковываться в гигабайты (zip-бомба). Размеры из заголовков zip
    надёжны как верхняя граница: zipfile не отдаёт больше объявленного file_size."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()
    except (zipfile.BadZipFile, ValueError, OSError):
        raise ApiError(422, "invalid_file", "Не удалось прочитать XLSX") from None
    too_big = ApiError(413, "file_too_large", "XLSX слишком большой после распаковки — разбейте прайс или "
                                              "сохраните в CSV")
    if len(infos) > XLSX_MAX_MEMBERS:
        raise too_big
    total = 0
    for i in infos:
        total += i.file_size
        if total > XLSX_MAX_UNCOMPRESSED:
            raise too_big
        if i.file_size > XLSX_RATIO_MIN_SIZE and i.file_size > XLSX_MAX_RATIO * max(i.compress_size, 1):
            raise too_big


def _xlsx_rows(data: bytes) -> list[dict[str, Any]]:
    check_xlsx_archive(data)
    try:
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception:
        raise ApiError(422, "invalid_file", "Не удалось прочитать XLSX") from None
    try:
        ws = wb.worksheets[0]
        # Границы явно: размер листа из файла (<dimension>) может быть подделан — A1:XFD1048576
        it = ws.iter_rows(min_row=1, max_row=MAX_ROWS + 1, max_col=MAX_COLS, values_only=True)
        header = next(it, None)
        if not header:
            return []
        keys = [str(h).strip()[:100] if h is not None else "" for h in header]
        rows = []
        for values in it:
            row = {k: v for k, v in zip(keys, values) if k}
            if any(v not in (None, "") for v in row.values()):
                rows.append(row)
        return rows
    except ApiError:
        raise
    except Exception:
        raise ApiError(422, "invalid_file", "Не удалось прочитать XLSX") from None
    finally:
        wb.close()


class RowsSource:
    """Строки файла/источника → RawItem. mapping: поле → колонка (для источника цен); иначе — по заголовкам."""

    def __init__(self, rows: list[dict[str, Any]], known: dict[str, CatalogItem], *, code: str, label: str,
                 mapping: dict[str, str] | None = None):
        self.rows, self.known, self.code, self.price_source = rows, known, code, label
        self.mapping = {v: k for k, v in (mapping or {}).items() if v}

    def records(self) -> Iterable[RawItem]:
        if not self.rows:
            raise ValueError("В файле нет строк")
        for row in self.rows:
            fields: dict[str, Any] = {}
            for col, value in row.items():
                field = self.mapping.get(col) or CSV_ALIASES.get(str(col).strip().lower())
                if field and field not in fields:
                    fields[field] = value
            if "price" not in fields and "sku" not in fields:
                raise ValueError("Нужны колонки sku и price (артикул и цена)")
            sku = str(fields.get("sku") or "").strip()
            item = self.known.get(sku)
            if item is not None and not str(fields.get("name") or "").strip():
                fields["name"] = item.name  # известный артикул: наименование можно не указывать
            if item is not None and not fields.get("type"):
                fields["type"] = item.type
            if item is not None and not fields.get("unit"):
                fields["unit"] = item.unit
            yield item_from_fields({str(k): v for k, v in row.items()}, fields)


def _known(db: Session, supplier: Supplier) -> dict[str, CatalogItem]:
    return {i.sku: i for i in db.scalars(select(CatalogItem).where(CatalogItem.supplier_id == supplier.id))}


def create_import(db: Session, supplier: Supplier, data: bytes, file_name: str, actor_id: str, *,
                  hide_missing: bool = False, source_code: str = "vendor_file",
                  mapping: dict[str, str] | None = None, fmt: str | None = None) -> ParserRun:
    fmt = fmt or detect_format(file_name, data)
    rows = read_rows(data, fmt)
    src = RowsSource(rows, _known(db, supplier), code=source_code, label=f"file:{file_name}"[:120], mapping=mapping)
    run = pipeline.create_run(db, supplier, src, created_by=actor_id, file_name=file_name[:300],
                              full_snapshot=hide_missing)
    if run.status != "failed" and not hide_missing:  # «пропали» показываем всегда, скрываем — только по флагу
        seen = {r.matched_item_id for r in pipeline.records_of(db, run) if r.matched_item_id}
        missing = [i for i in db.scalars(select(CatalogItem).where(CatalogItem.supplier_id == supplier.id,
                                                                   CatalogItem.available.is_(True)))
                   if i.id not in seen]
        run.stats = {**(run.stats or {}), "missing_report": [str(i.id) for i in missing]}
    return run


def _rec(rec: RawPriceRecord, item: CatalogItem | None = None) -> dict[str, Any]:
    return {"record_id": str(rec.id), "sku": rec.sku, "name": rec.name, "price": rec.price,
            "old_price": rec.old_price, "change_pct": rec.change_pct,
            "available": (rec.parsed or {}).get("available", True),
            "old_available": item.available if item is not None else None,
            "item_id": str(rec.matched_item_id) if rec.matched_item_id else None,
            "review_status": rec.review_status, "error": rec.error}


def preview_out(db: Session, run: ParserRun) -> dict[str, Any]:
    recs = pipeline.records_of(db, run)
    items = {i.id: i for i in db.scalars(select(CatalogItem).where(
        CatalogItem.id.in_([r.matched_item_id for r in recs if r.matched_item_id])))}
    stats = run.stats or {}
    missing_ids = stats.get("missing_ids") or stats.get("missing_report") or []
    missing = [{"item_id": str(i.id), "sku": i.sku, "name": i.name, "price": i.price}
               for i in db.scalars(select(CatalogItem).where(CatalogItem.id.in_([_uuid(x) for x in missing_ids])))]
    changed = [_rec(r, items.get(r.matched_item_id)) for r in recs if r.match_status == "changed"]
    return {
        "preview_id": str(run.id), "status": run.status, "file_name": run.file_name, "error": run.error,
        "created": [_rec(r) for r in recs if r.match_status == "new"],
        "changed": changed,
        "big_changes": [c for c in changed if c["change_pct"] is None
                        or abs(c["change_pct"]) > pipeline.REVIEW_THRESHOLD_PCT],
        "missing": missing,
        "errors": [{"record_id": str(r.id), "sku": r.sku, "name": r.name, "error": r.error}
                   for r in recs if r.match_status == "invalid"],
        "unchanged": sum(r.match_status == "unchanged" for r in recs),
        "hide_missing": run.full_snapshot,
        "expires_at": (run.started_at + PREVIEW_TTL).isoformat(),
        "published_at": run.published_at.isoformat() if run.published_at else None,
    }


def _uuid(x: str):
    import uuid

    return uuid.UUID(x)


def approve_pending(db: Session, run: ParserRun, actor_id: str) -> int:
    n = 0
    for rec in pipeline.records_of(db, run):
        if rec.review_status == "pending" and rec.published_at is None:
            pipeline.review(db, rec, True, actor_id, actor_type="staff")
            n += 1
    return n


def confirm_import(db: Session, run: ParserRun, actor_id: str) -> dict[str, Any]:
    if run.published_at is not None:
        raise ApiError(409, "preview_applied", "Этот файл уже применён")
    if run.status == "failed":
        raise ApiError(409, "run_failed", "Файл не разобран — загрузите исправленный")
    if run.started_at + PREVIEW_TTL < utcnow():
        raise ApiError(410, "preview_expired", "Предпросмотр устарел — загрузите файл заново")
    approve_pending(db, run, actor_id)
    out = pipeline.publish(db, run, actor_id, actor_type="staff")
    if out.get("updated") or out.get("hidden"):
        from . import events

        events.prices_published(db)
    return out


# --- Источник цен по ссылке / API ---


# Не публичные, хотя ipaddress считает их global: служебные адреса облаков и «обёртки» над IPv4
_BLOCKED_NETS = [ipaddress.ip_network(n) for n in (
    "168.63.129.16/32",  # Azure WireServer
    "100.100.100.200/32",  # Alibaba metadata
    "::/96",  # IPv4-compatible IPv6 (::127.0.0.1)
    "::ffff:0:0/96",  # IPv4-mapped (проверяем и сам IPv4 ниже)
    "64:ff9b::/96", "64:ff9b:1::/48",  # NAT64
    "2001::/32",  # Teredo
    "2002::/16",  # 6to4
)]


def forbidden_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.version == 6:
        if ip.ipv4_mapped is not None and forbidden_ip(ip.ipv4_mapped):
            return True
        if ip.scope_id:
            return True
    if not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_link_local or ip.is_loopback:
        return True
    return any(ip in n for n in _BLOCKED_NETS if n.version == ip.version)


def resolve_public_https(url: str) -> tuple[str, int, list[str]]:
    """Только https и только публичные адреса (все IP, в которые разрешается имя) → (хост, порт, IP)."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise ApiError(422, "invalid_source_url", "Нужна ссылка https://…")
    if parts.username or parts.password:
        raise ApiError(422, "invalid_source_url", "Ссылка без логина и пароля в адресе (ключ — отдельным полем)")
    try:
        port = parts.port or 443
    except ValueError:
        raise ApiError(422, "invalid_source_url", "Неверный порт в ссылке") from None
    try:
        infos = socket.getaddrinfo(parts.hostname, port, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        raise ApiError(422, "source_unreachable", "Адрес источника не найден") from None
    ips: list[str] = []
    for info in infos:
        try:
            ip = ipaddress.ip_address(str(info[4][0]).split("%", 1)[0])
        except ValueError:
            raise ApiError(422, "source_forbidden", "Адрес источника не публичный") from None
        if forbidden_ip(ip):
            raise ApiError(422, "source_forbidden", "Адрес источника не публичный")
        if str(ip) not in ips:
            ips.append(str(ip))
    if not ips:
        raise ApiError(422, "source_unreachable", "Адрес источника не найден")
    return parts.hostname, port, ips


def check_public_https(url: str) -> tuple[str, int]:
    host, port, _ = resolve_public_https(url)
    return host, port


def _pinned_url(url: str, ip: str, port: int) -> str:
    parts = urlsplit(url)
    host = f"[{ip}]" if ":" in ip else ip
    return parts._replace(netloc=f"{host}:{port}").geturl()


def fetch(url: str, *, secret: str | None, max_bytes: int, timeout: float, transport=None) -> bytes:
    """GET источника. Соединение — с IP, проверенным resolve_public_https (не даём DNS подменить адрес между
    проверкой и запросом); имя — в Host и SNI, сертификат проверяется по имени. `timeout` — общий срок
    на всё (соединение, заголовки, тело), `max_bytes` — по заголовку Content-Length и по мере чтения."""
    import httpx

    deadline = time.monotonic() + timeout
    host, port, ips = resolve_public_https(url)
    headers = {"User-Agent": "EskizAI-price-source/1.0", "Accept": "*/*", "Accept-Encoding": "identity",
               "Host": host if port == 443 else f"{host}:{port}"}
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    slow = ApiError(504, "source_timeout", f"Источник не ответил за {timeout:g} с")
    too_large = ApiError(413, "source_too_large", "Файл источника слишком большой")
    try:
        with httpx.Client(timeout=httpx.Timeout(timeout), follow_redirects=False, transport=transport,
                          trust_env=False) as c:
            with c.stream("GET", _pinned_url(url, ips[0], port), headers=headers,
                          extensions={"sni_hostname": host}) as r:
                if r.status_code != 200:
                    raise ApiError(502, "source_http_error", f"Источник ответил {r.status_code}")
                try:
                    declared = int(r.headers.get("content-length") or 0)
                except ValueError:
                    declared = 0
                if declared > max_bytes:
                    raise too_large
                buf = bytearray()
                for chunk in r.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        raise too_large
                    if time.monotonic() > deadline:
                        raise slow
                return bytes(buf)
    except httpx.TimeoutException:
        raise slow from None
    except httpx.HTTPError as e:
        raise ApiError(502, "source_unreachable", f"Источник недоступен: {type(e).__name__}") from None


def source_out(src: SupplierPriceSource | None) -> dict[str, Any] | None:
    if src is None:
        return None
    return {"id": str(src.id), "kind": src.kind, "url": src.url, "format": src.format, "mapping": src.mapping or {},
            "secret_set": bool(src.secret), "schedule": src.schedule, "active": src.active,
            "last_run_at": src.last_run_at, "last_status": src.last_status, "last_error": src.last_error,
            "updated_at": src.updated_at}


def start_source_run(db: Session, src: SupplierPriceSource, actor_id: str) -> ParserRun:
    """«Обновить сейчас»: запуск в статусе `running` (его id — сразу в ответе), работа — фоновой задачей
    `price_source_run`. Второй запуск, пока идёт первый, — 409 run_in_progress."""
    busy = db.scalar(select(ParserRun.id).where(
        ParserRun.supplier_id == src.supplier_id, ParserRun.source == "price_source", ParserRun.status == "running",
        ParserRun.started_at > utcnow() - RUNNING_STALE).limit(1))
    if busy is not None:
        raise ApiError(409, "run_in_progress", "Обновление уже идёт — дождитесь результата", {"run_id": str(busy)})
    run = ParserRun(supplier_id=src.supplier_id, source="price_source", file_name=urlsplit(src.url).hostname,
                    full_snapshot=False, created_by=actor_id, status="running")
    db.add(run)
    db.flush()
    return run


def run_source(db: Session, src: SupplierPriceSource, settings, actor_id: str, *, transport=None,
               run: ParserRun | None = None) -> ParserRun:
    """Загрузить и применить: ≤ 15% — сразу, > 15% — ждут подтверждения владельца. `run` — заготовка
    из start_source_run (иначе запуск создаётся здесь)."""
    supplier = db.get(Supplier, src.supplier_id)
    now = utcnow()
    src.last_run_at = now
    host = urlsplit(src.url).hostname
    try:
        data = fetch(src.url, secret=src.secret, max_bytes=settings.price_source_max_bytes,
                     timeout=settings.price_source_timeout_seconds, transport=transport)
        fmt = src.format if src.format in FORMATS else detect_format(src.url, data)
        rows = read_rows(data, "json" if src.kind == "api" else fmt)
    except ApiError as e:
        if run is None:
            run = ParserRun(supplier_id=supplier.id, source="price_source", file_name=host, full_snapshot=False,
                            created_by=actor_id)
            db.add(run)
        run.status, run.error, run.finished_at = "failed", e.message, utcnow()
        src.last_status, src.last_error = "failed", e.message[:1000]
        db.flush()
        return run
    known = _known(db, supplier)
    rs = RowsSource(rows, known, code="price_source", label=f"source:{host}"[:120], mapping=src.mapping)
    run = pipeline.create_run(db, supplier, rs, created_by=actor_id, file_name=host, full_snapshot=False, run=run)
    if run.status == "failed":
        src.last_status, src.last_error = "failed", (run.error or "")[:1000]
        return run
    try:
        out = pipeline.publish(db, run, actor_id, skip_pending=True, actor_type="staff")
        if out.get("updated"):
            from . import events

            events.prices_published(db)
    except ApiError as e:
        if e.code != "nothing_to_publish":
            raise
        out = {"created": 0, "updated": 0, "confirmed": 0, "hidden": 0}
    pending = sum(1 for r in pipeline.records_of(db, run) if r.review_status == "pending" and r.published_at is None)
    if pending:
        run.status = "review"
    src.last_status, src.last_error = ("review" if pending else "ok"), None
    db.flush()
    return run


def run_source_task(database, settings, payload: dict[str, Any]) -> dict[str, Any]:
    """Фоновая задача `price_source_run` (регистрируется в main.py): payload {run_id, source_id, actor_id}."""
    import uuid

    with database.sessionmaker() as db:
        run = db.get(ParserRun, uuid.UUID(payload["run_id"]))
        src = db.get(SupplierPriceSource, uuid.UUID(payload["source_id"]))
        if run is None or src is None:
            return {"run_id": payload["run_id"], "status": "missing"}
        try:
            run_source(db, src, settings, payload.get("actor_id") or "vendor", run=run)
            db.commit()
        except Exception:
            db.rollback()
            run = db.get(ParserRun, uuid.UUID(payload["run_id"]))
            if run is not None:
                run.status, run.error, run.finished_at = "failed", "Внутренняя ошибка обработки прайса", utcnow()
                db.commit()
            raise
        return {"run_id": str(run.id), "status": run.status}


def due_sources(db: Session) -> list[SupplierPriceSource]:
    now = utcnow()
    out = []
    for s in db.scalars(select(SupplierPriceSource).where(SupplierPriceSource.active.is_(True),
                                                          SupplierPriceSource.schedule != "off")):
        every = timedelta(hours=1) if s.schedule == "hourly" else timedelta(days=1)
        if s.last_run_at is None or s.last_run_at + every <= now:
            out.append(s)
    return out


def run_due(database, settings) -> int:
    """Для расписания: scripts/run_price_sources.py (cron) или фоновый поток (PRICE_SOURCE_SCHEDULER=true)."""
    n = 0
    with database.sessionmaker() as db:
        for src in due_sources(db):
            try:
                run_source(db, src, settings, "scheduler")
                db.commit()
                n += 1
            except Exception:
                db.rollback()
    return n


def start_scheduler(database, settings, interval_seconds: int = 300) -> None:
    import logging
    import threading

    log = logging.getLogger(__name__)

    def loop() -> None:
        import time

        while True:
            try:
                run_due(database, settings)
            except Exception as e:  # не роняем поток
                log.warning("price source scheduler: %s", e)
            time.sleep(interval_seconds)

    threading.Thread(target=loop, name="price-sources", daemon=True).start()
