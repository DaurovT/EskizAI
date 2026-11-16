"""Входящие чертежи из Eskiz DWG (docs/dwg_contract.md).

Пакет `.eskiz` (формат 1, eskiz-dwg/docs/package_format.md) — zip: `manifest.json`, `data.json`,
`previews/s1.webp`… (или `previews/model.webp`), `source.dwg` / `source.dxf`.
Чертёж видит только загрузивший пользователь — ни цех, ни другие аккаунты.

Хранение: закрытая зона, ключ — по sha256 содержимого (`private/inbox/<aa>/<sha256>/package.eskiz` и
`…/preview.webp` — одно превью: первого отмеченного листа). Одинаковые байты у разных пользователей — один файл (кэш хранилища), но строки, квота
и видимость — свои у каждого. Файл удаляется, когда на него не осталось живых строк (`release_blob`);
загрузка и удаление одного sha256 на Postgres идут под advisory-блокировкой, чтобы чистка не удалила файл,
который как раз переиспользует параллельная загрузка.

Живая строка: `deleted_at IS NULL AND (expires_at > now OR project_id IS NOT NULL)`. Срок — `inbox_retention_days`
с создания или последнего открытия (GET /inbox/drawings/{id}); по чертежу создан проект
(POST /inbox/drawings/{id}/project) — не истекает, пока проект не удалят.
"""

import hashlib
import io
import json
import logging
import uuid
import zipfile
from datetime import datetime, timedelta
from typing import Any

from fastapi import UploadFile
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.orm import Session

from ..config import Settings
from ..db import utcnow
from ..errors import ApiError
from ..models import InboxDrawing
from .storage import PRIVATE_PREFIX, Storage

log = logging.getLogger("mebel_api.inbox")

MANIFEST_NAME = "manifest.json"
MAX_MANIFEST_BYTES = 256 * 1024
MAX_PREVIEW_BYTES = 5 * 1024 * 1024
MAX_TITLE = 200
PREVIEW_TTL = timedelta(hours=1)
DOWNLOAD_TTL = timedelta(minutes=30)
CHUNK = 1024 * 1024
# Удалённые строки остаются до суток — по ним считается лимит загрузок в день (удаление его не сбрасывает)
KEEP_DELETED_ROWS = timedelta(days=1)


def _mb(n: int) -> str:
    return f"{n // (1024 * 1024)} МБ"


def bad_package(reason: str, message: str) -> ApiError:
    return ApiError(422, "bad_package", message, {"reason": reason})


# --- приём файла ---


async def read_upload(file: UploadFile, limit: int) -> tuple[bytes, str]:
    """Читает файл кусками с подсчётом: больше `limit` — 413 сразу (основной отсев — BodySizeLimit по
    Content-Length и по мере приёма тела). Возвращает (байты, sha256)."""
    h = hashlib.sha256()
    buf = bytearray()
    while chunk := await file.read(CHUNK):
        buf += chunk
        if len(buf) > limit:
            raise ApiError(413, "file_too_large", f"Файл больше {_mb(limit)}")
        h.update(chunk)
    return bytes(buf), h.hexdigest()


def _reject_constant(name: str) -> Any:
    raise ValueError(f"недопустимое число {name}")  # NaN/Infinity — не JSON (Postgres такое не сохранит)


SUPPORTED_FORMAT_VERSIONS = (1,)
_HEX = frozenset("0123456789abcdef")


def parse_manifest(raw: bytes) -> dict[str, Any]:
    """Проверка manifest.json — единственное место, где проверяется его содержимое
    (формат 1: eskiz-dwg/docs/package_format.md).

    Обязательно: `format == "eskiz"`, `format_version` из SUPPORTED_FORMAT_VERSIONS (иначе
    `422 unsupported_package`), `source.sha256` (64 hex, нижний регистр), `source.kind`, `title`
    (строка), `files` (объект). Неизвестные поля не проверяются и хранятся как есть (новые поля пакета
    не ломают API). Возвращает manifest."""
    if len(raw) > MAX_MANIFEST_BYTES:
        raise bad_package("manifest_too_large", f"manifest.json больше {MAX_MANIFEST_BYTES // 1024} КБ")
    try:
        m = json.loads(raw.decode("utf-8-sig"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise bad_package("manifest_invalid", "manifest.json — не JSON") from None
    if not isinstance(m, dict):
        raise bad_package("manifest_invalid", "manifest.json должен быть JSON-объектом")
    if m.get("format") != "eskiz":
        raise bad_package("format", "Это не пакет Eskiz DWG: в manifest.json нет format = \"eskiz\"")
    version = m.get("format_version")
    if not isinstance(version, int) or isinstance(version, bool):
        raise bad_package("format_version", "В manifest.json нет format_version (целое число)")
    if version not in SUPPORTED_FORMAT_VERSIONS:
        raise ApiError(422, "unsupported_package",
                       "Пакет из более новой версии Eskiz DWG — сервер его пока не понимает. Обновление скоро будет",
                       {"format_version": version, "supported": list(SUPPORTED_FORMAT_VERSIONS)})
    src = m.get("source")
    sha = src.get("sha256") if isinstance(src, dict) else None
    if not (isinstance(sha, str) and len(sha) == 64 and set(sha) <= _HEX):
        raise bad_package("source", "В manifest.json нет source.sha256 (64 hex-символа, нижний регистр)")
    if not (isinstance(src.get("kind"), str) and src["kind"].strip()):
        raise bad_package("source", "В manifest.json нет source.kind")
    if not isinstance(m.get("title"), str):
        raise bad_package("title", "В manifest.json нет title (строка)")
    if not isinstance(m.get("files"), dict):
        raise bad_package("files", "В manifest.json нет files (объект)")
    return m


# --- чтение полей проверенного manifest (терпимо к отсутствующим и лишним полям) ---


def _dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _str(v: Any, limit: int = 500) -> str | None:
    return (v.strip()[:limit] or None) if isinstance(v, str) else None


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _is_preview_path(v: Any) -> bool:
    return isinstance(v, str) and v.startswith("previews/") and v.lower().endswith(".webp") and len(v) <= 200


def sheets_of(m: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Листы для ответа: number / name / selected / preview (путь в пакете). Отмеченные — `sheets[].selected`,
    иначе `selected_sheets` (id); нет ни того ни другого — отмечены все (формат 1)."""
    m = m or {}
    raw = [s for s in m.get("sheets") or [] if isinstance(s, dict)] if isinstance(m.get("sheets"), list) else []
    sel_ids = m.get("selected_sheets")
    has_flags = any(isinstance(s.get("selected"), bool) for s in raw)
    out = []
    for s in raw:
        if has_flags:
            selected = s.get("selected") is True
        elif isinstance(sel_ids, list):
            selected = s.get("id") in sel_ids
        else:
            selected = True
        out.append({"id": _str(s.get("id"), 50), "number": _str(s.get("number"), 50) if not isinstance(
            s.get("number"), int) else str(s["number"]), "name": _str(s.get("name")), "selected": selected,
            "preview": s.get("preview") if _is_preview_path(s.get("preview")) else None})
    return out


def preview_path(m: dict[str, Any] | None) -> str | None:
    """Какое превью хранить и показывать: первый отмеченный лист с превью, иначе первый лист с превью
    (обычно s1), иначе превью модели (`model_preview` или previews/model.webp)."""
    sheets = sheets_of(m)
    for s in sheets:
        if s["selected"] and s["preview"]:
            return s["preview"]
    for s in sheets:
        if s["preview"]:
            return s["preview"]
    mp = (m or {}).get("model_preview")
    return mp if _is_preview_path(mp) else "previews/model.webp"


def source_kind(m: dict[str, Any] | None) -> str | None:
    """`dwg` / `dxf` — вид исходника (manifest.source.kind)."""
    return _str(_dict(_dict(m).get("source")).get("kind"), 10)


def unlink_project(db: Session, settings: Settings, project_id: uuid.UUID) -> None:
    """Проект удалён: чертежи по нему снова живут обычный срок (с этого момента). Коммит — у вызывающего."""
    exp = utcnow() + timedelta(days=settings.inbox_retention_days)
    for d in db.scalars(select(InboxDrawing).where(InboxDrawing.project_id == project_id)):
        d.project_id = None
        d.expires_at = max(d.expires_at, exp)


def summary(m: dict[str, Any] | None) -> dict[str, Any]:
    """Поля списка «Входящих» из manifest."""
    m = m or {}
    units = _dict(m.get("units"))
    sheets = _int(_dict(m.get("stats")).get("sheets"))
    if sheets is None and isinstance(m.get("sheets"), list):
        sheets = len(m["sheets"])
    return {"sheet_count": sheets, "units_guessed": units.get("source") == "guessed",
            "units_note": _str(units.get("note")), "package_created_at": _str(m.get("created_at"), 64)}


def _read_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes | None:
    """Распаковка с потолком (заявленный размер в zip может врать — читаем не больше limit + 1)."""
    if info.file_size > limit:
        return None
    with zf.open(info) as f:
        data = f.read(limit + 1)
    return data if len(data) <= limit else None


_ZIP_ERRORS = (zipfile.BadZipFile, RuntimeError, ValueError, OSError, NotImplementedError, EOFError)


def is_webp(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def inspect_package(data: bytes) -> tuple[dict[str, Any], str | None, bytes | None]:
    """Пакет .eskiz → (manifest, title, превью WebP или None). Ничего не распаковывается на диск:
    читаются только manifest.json и одна картинка, обе с потолком размера (защита от zip-бомб).
    source.dwg / data.json не распаковываются и не проверяются."""
    if not data:
        raise bad_package("empty", "Файл пустой")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError, OSError):
        raise bad_package("not_zip", "Это не пакет Eskiz DWG (.eskiz): файл не zip") from None
    with zf:
        try:
            info = zf.getinfo(MANIFEST_NAME)
        except KeyError:
            raise bad_package("no_manifest", "В пакете нет manifest.json") from None
        try:
            raw = _read_member(zf, info, MAX_MANIFEST_BYTES)
        except _ZIP_ERRORS:
            raise bad_package("manifest_invalid", "manifest.json не читается (повреждён или зашифрован)") from None
        if raw is None:
            raise bad_package("manifest_too_large", f"manifest.json больше {MAX_MANIFEST_BYTES // 1024} КБ")
        manifest = parse_manifest(raw)
        title = _str(manifest.get("title"), MAX_TITLE)
        preview = None
        path = preview_path(manifest)
        try:  # нет файла, битый, огромный, не WebP — просто без превью
            img = _read_member(zf, zf.getinfo(path), MAX_PREVIEW_BYTES) if path else None
        except (KeyError, *_ZIP_ERRORS):
            img = None
        if img is not None and is_webp(img):
            preview = img
    return manifest, title, preview


# --- хранилище ---


def blob_keys(sha256: str) -> tuple[str, str]:
    """Ключи пакета и превью в закрытой зоне (по содержимому)."""
    base = f"{PRIVATE_PREFIX}inbox/{sha256[:2]}/{sha256}"
    return f"{base}/package.eskiz", f"{base}/preview.webp"


def lock_blob(db: Session, sha256: str) -> None:
    """Блокировка на sha256 до конца транзакции (Postgres). SQLite (тесты, dev) — один процесс, без блокировки."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:k)"),
                   {"k": int.from_bytes(bytes.fromhex(sha256[:16]), "big", signed=True)})


def live_clause(now: datetime):
    return and_(InboxDrawing.deleted_at.is_(None),
                or_(InboxDrawing.expires_at > now, InboxDrawing.project_id.is_not(None)))


def is_expired(d: InboxDrawing, now: datetime) -> bool:
    """Истёк: срок прошёл и по чертежу нет проекта."""
    return d.project_id is None and d.expires_at <= now


def _has_live_ref(db: Session, column, key: str, now: datetime) -> bool:
    return db.scalar(select(InboxDrawing.id).where(column == key, live_clause(now)).limit(1)) is not None


def _exists(storage: Storage, key: str) -> bool:
    exists = getattr(storage, "exists", None)
    return bool(exists(key)) if exists is not None else False


def _delete_file(storage: Storage, key: str | None) -> None:
    if not key:
        return
    try:
        storage.delete(key)
    except Exception:  # noqa: BLE001 — файла уже нет; строку всё равно чистим
        log.warning("Не удалось удалить файл %s", key)


def release_blob(db: Session, storage: Storage, sha256: str, storage_key: str | None,
                 preview_key: str | None, now: datetime | None = None) -> bool:
    """Удаляет файлы пакета, если на них не осталось живых строк (ни у кого). Коммитит (снимает блокировку).
    Изменения вызывающего (удаление строки) должны быть закоммичены раньше. Возвращает: удалены ли файлы."""
    now = now or utcnow()
    lock_blob(db, sha256)
    removed = False
    if storage_key and not _has_live_ref(db, InboxDrawing.storage_key, storage_key, now):
        _delete_file(storage, storage_key)
        removed = True
    if preview_key and not _has_live_ref(db, InboxDrawing.preview_key, preview_key, now):
        _delete_file(storage, preview_key)
    db.commit()
    return removed


# --- операции ---


def live_query(user_id: uuid.UUID, now: datetime):
    return select(InboxDrawing).where(InboxDrawing.user_id == user_id, live_clause(now))


def get_own(db: Session, user_id: uuid.UUID, drawing_id: uuid.UUID, now: datetime | None = None) -> InboxDrawing:
    """Только свой живой чертёж; чужой, удалённый, истёкший — одинаково 404."""
    d = db.get(InboxDrawing, drawing_id)
    now = now or utcnow()
    if d is None or d.user_id != user_id or d.deleted_at is not None or is_expired(d, now):
        raise ApiError(404, "not_found", "Чертёж не найден")
    return d


def _ensure_limits(db: Session, settings: Settings, user_id: uuid.UUID, size: int, now: datetime) -> None:
    per_day = settings.inbox_uploads_per_day
    if per_day:
        # считаются и удалённые сегодня — удаление лимит не сбрасывает
        today = db.scalar(select(func.count(InboxDrawing.id)).where(
            InboxDrawing.user_id == user_id, InboxDrawing.created_at > now - timedelta(days=1))) or 0
        if today >= per_day:
            raise ApiError(429, "upload_limit", f"Не больше {per_day} чертежей в сутки. Попробуйте завтра",
                           {"limit": per_day})
    quota = settings.inbox_quota_bytes
    if quota:
        used = int(db.scalar(select(func.coalesce(func.sum(InboxDrawing.size), 0)).where(
            InboxDrawing.user_id == user_id, live_clause(now))) or 0)
        if used + size > quota:
            raise ApiError(409, "inbox_quota_exceeded",
                           f"Во входящих нет места: занято {_mb(used)} из {_mb(quota)}. Удалите старые чертежи",
                           {"used": used, "limit": quota, "size": size})


def store_drawing(db: Session, settings: Settings, storage: Storage, user_id: uuid.UUID, filename: str,
                  data: bytes, sha256: str) -> tuple[InboxDrawing, bool]:
    """Проверяет пакет и сохраняет. Тот же пакет (sha256), уже лежащий во входящих этого пользователя, —
    возвращается он же (повтор загрузки после обрыва связи), без нового места в квоте. → (чертёж, создан ли)."""
    from .uploads import display_name

    manifest, title, preview = inspect_package(data)
    now = utcnow()
    expires = now + timedelta(days=settings.inbox_retention_days)
    same = db.scalar(live_query(user_id, now).where(InboxDrawing.sha256 == sha256)
                     .order_by(InboxDrawing.created_at.desc()).limit(1))
    if same is not None:
        same.expires_at = max(same.expires_at, expires)
        db.commit()
        return same, False
    _ensure_limits(db, settings, user_id, len(data), now)

    key, preview_key = blob_keys(sha256)
    lock_blob(db, sha256)
    # Файл с теми же байтами уже лежит под живой строкой (своей или чужой) — не переписываем
    if not (_has_live_ref(db, InboxDrawing.storage_key, key, now) and _exists(storage, key)):
        storage.save(key, data, "application/zip", private=True)
    if preview is None:
        preview_key = None
    elif not (_has_live_ref(db, InboxDrawing.preview_key, preview_key, now) and _exists(storage, preview_key)):
        storage.save(preview_key, preview, "image/webp", private=True)
    d = InboxDrawing(user_id=user_id, filename=display_name(filename or "drawing.eskiz"), size=len(data),
                     sha256=sha256, storage_key=key, preview_key=preview_key, title=title, manifest=manifest,
                     created_at=now, expires_at=expires)
    db.add(d)
    db.commit()  # снимает блокировку sha256
    return d, True


def touch(db: Session, settings: Settings, d: InboxDrawing) -> None:
    now = utcnow()
    d.last_opened_at = now
    d.expires_at = now + timedelta(days=settings.inbox_retention_days)
    db.commit()


def soft_delete(db: Session, storage: Storage, d: InboxDrawing) -> None:
    now = utcnow()
    d.deleted_at = now
    db.commit()
    release_blob(db, storage, d.sha256, d.storage_key, d.preview_key, now)


def purge_user(db: Session, storage: Storage, user_id: uuid.UUID) -> int:
    """Удаление аккаунта: строки пользователя — сразу из базы, файлы — если они больше ни у кого не живые.
    Коммит — у вызывающего (вместе с остальным удалением аккаунта)."""
    rows = list(db.scalars(select(InboxDrawing).where(InboxDrawing.user_id == user_id)))
    if not rows:
        return 0
    now = utcnow()
    blobs = {(d.sha256, d.storage_key, d.preview_key) for d in rows}
    for d in rows:
        db.delete(d)
    db.flush()
    for sha, key, pkey in blobs:
        lock_blob(db, sha)
        if key and not _has_live_ref(db, InboxDrawing.storage_key, key, now):
            _delete_file(storage, key)
        if pkey and not _has_live_ref(db, InboxDrawing.preview_key, pkey, now):
            _delete_file(storage, pkey)
    return len(rows)


def prune(db: Session, storage: Storage, now: datetime | None = None) -> dict[str, int]:
    """Чистка (scripts/prune_inbox.py, cron раз в сутки): файлы удалённых и истёкших чертежей — если на них
    не осталось живых строк; сами строки — истёкшие сразу, удалённые — через сутки после создания
    (по ним считается дневной лимит загрузок)."""
    now = now or utcnow()
    stats = {"rows_deleted": 0, "blobs_released": 0, "blobs_kept_shared": 0}
    dead = list(db.scalars(select(InboxDrawing).where(or_(
        InboxDrawing.deleted_at.is_not(None),
        and_(InboxDrawing.expires_at <= now, InboxDrawing.project_id.is_(None))))
                           .order_by(InboxDrawing.created_at)))
    done: set[str] = set()
    for d in dead:
        sha, key, pkey = d.sha256, d.storage_key, d.preview_key
        if is_expired(d, now) or d.created_at <= now - KEEP_DELETED_ROWS:
            db.delete(d)
            stats["rows_deleted"] += 1
        db.commit()
        if key in done:
            continue
        done.add(key)
        if release_blob(db, storage, sha, key, pkey, now):
            stats["blobs_released"] += 1
        else:
            stats["blobs_kept_shared"] += 1
    return stats


# --- ответы ---


def _signed(settings: Settings, key: str, name: str, content_type: str, ttl: timedelta) -> str:
    from .signed_files import signed_url

    return signed_url(settings, {"key": key, "name": name, "content_type": content_type}, ttl)


def drawing_out(settings: Settings, d: InboxDrawing, *, detail: bool = False) -> dict[str, Any]:
    """Элемент списка; detail — ещё manifest целиком, sheets[] и ссылка на пакет.
    sha256 — хэш загруженного пакета (не source.sha256 из manifest)."""
    preview_url = (_signed(settings, d.preview_key, "preview.webp", "image/webp", PREVIEW_TTL)
                   if d.preview_key else None)
    out = {
        "id": d.id, "title": d.title, "filename": d.filename, "size": d.size, "sha256": d.sha256,
        "created_at": d.created_at, "last_opened_at": d.last_opened_at, "expires_at": d.expires_at,
        "preview_url": preview_url, "project_id": d.project_id, "source_kind": source_kind(d.manifest),
        **summary(d.manifest),
    }
    if detail:
        stored = preview_path(d.manifest) if d.preview_key else None
        # Сохранено одно превью (первого отмеченного листа) — ссылка только у этого листа, у остальных null
        out["sheets"] = [{"id": sh["id"], "number": sh["number"], "name": sh["name"], "selected": sh["selected"],
                          "preview_url": preview_url if stored and sh["preview"] == stored else None}
                         for sh in sheets_of(d.manifest)]
        out["manifest"] = d.manifest
        out["download_url"] = package_url(settings, d)
    return out


def package_url(settings: Settings, d: InboxDrawing) -> str:
    """Подписанная ссылка на пакет .eskiz (30 минут), путь от адреса API."""
    return _signed(settings, d.storage_key, d.filename, "application/zip", DOWNLOAD_TTL)
