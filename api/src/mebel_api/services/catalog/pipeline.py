"""Запуск парсера → сырые записи → сопоставление → проверка → публикация (ADM-05).

- Сопоставление: по артикулу поставщика, иначе по нормализованному наименованию.
- Изменение цены больше чем на 15% — на подтверждение менеджеру перед публикацией.
- Полный прайс (`full_snapshot`): позиции каталога, которых нет в прайсе, — «исчезли»;
  при публикации они помечаются «нет в наличии» (смета покажет «аналог» / «под запрос»).
- Неизменённая цена при публикации обновляет дату цены: цена старше 14 дней — «устарела».
- Каждое изменение цены — в историю цен и журнал действий.
"""

import re
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import utcnow
from ...errors import ApiError, not_found
from ...models import CatalogItem, ParserRun, PriceHistory, RawPriceRecord, Supplier
from ..action_log import log_action
from .sources import PriceSource

REVIEW_THRESHOLD_PCT = 15.0
STALE_DAYS = 14

DEFAULT_SUPPLIERS = {
    "eman": {"name": "EMAN Materials", "site_url": "https://eman.uz", "order_method": "manual_csv"},
}


def ensure_supplier(db: Session, code: str) -> Supplier:
    s = db.scalar(select(Supplier).where(Supplier.code == code))
    if s is None:
        if code not in DEFAULT_SUPPLIERS:
            raise not_found("Поставщик")
        s = Supplier(code=code, **DEFAULT_SUPPLIERS[code])
        db.add(s)
        db.flush()
    return s


def is_stale(item: CatalogItem) -> bool:
    return item.price_date < utcnow() - timedelta(days=STALE_DAYS)


def _norm(name: str) -> str:
    return re.sub(r"[^\w]+", " ", name.lower().replace("ё", "е")).strip()


def create_run(db: Session, supplier: Supplier, source: PriceSource, *, created_by: str, file_name: str | None,
               full_snapshot: bool = True, run: ParserRun | None = None) -> ParserRun:
    """`run` — уже созданный запуск (фоновое «обновить сейчас»: запрос отдал его id сразу) — заполняется он."""
    if run is None:
        run = ParserRun(supplier_id=supplier.id, source=source.code, file_name=file_name,
                        full_snapshot=full_snapshot, created_by=created_by, status="parsed")
        db.add(run)
    else:
        run.source, run.file_name, run.full_snapshot, run.status = source.code, file_name, full_snapshot, "parsed"
    db.flush()
    try:
        for item in source.records():
            db.add(RawPriceRecord(run_id=run.id, data=_jsonable(item.raw), sku=item.sku, name=item.name[:300],
                                  parsed=item.parsed(), price=item.price, error=item.error,
                                  match_status="invalid" if item.error else "pending"))
    except ValueError as e:
        run.status, run.error, run.finished_at = "failed", str(e), utcnow()
        db.flush()
        return run
    db.flush()
    match_run(db, run)
    run.finished_at = utcnow()
    return run


def _jsonable(raw: dict[str, Any]) -> dict[str, Any]:
    return {str(k): (v if isinstance(v, (str, int, float, bool)) or v is None else str(v)) for k, v in raw.items()}


def records_of(db: Session, run: ParserRun) -> list[RawPriceRecord]:
    return list(db.scalars(select(RawPriceRecord).where(RawPriceRecord.run_id == run.id)
                           .order_by(RawPriceRecord.created_at, RawPriceRecord.id)))


def match_run(db: Session, run: ParserRun) -> dict[str, Any]:
    """Шаг сопоставления. Можно запускать повторно — решения менеджера (approved/rejected) сохраняются."""
    items = list(db.scalars(select(CatalogItem).where(CatalogItem.supplier_id == run.supplier_id)))
    by_sku = {i.sku: i for i in items}
    by_name = {_norm(i.name): i for i in items}
    stats = {"total": 0, "new": 0, "changed": 0, "unchanged": 0, "invalid": 0, "review": 0, "missing": 0}
    seen: set[uuid.UUID] = set()
    for rec in records_of(db, run):
        stats["total"] += 1
        if rec.error:
            rec.match_status = "invalid"
            stats["invalid"] += 1
            continue
        item = by_sku.get(rec.sku or "") or by_name.get(_norm(rec.name))
        if item is None:
            rec.matched_item_id, rec.match_status, rec.old_price, rec.change_pct = None, "new", None, None
            stats["new"] += 1
            continue
        seen.add(item.id)
        rec.matched_item_id, rec.old_price = item.id, item.price
        available = bool(rec.parsed.get("available", True))
        if rec.price == item.price and available == item.available:
            rec.match_status, rec.change_pct = "unchanged", 0.0
            stats["unchanged"] += 1
            continue
        rec.match_status = "changed"
        rec.change_pct = round(100 * (rec.price - item.price) / item.price, 1) if item.price else None
        stats["changed"] += 1
        big = rec.change_pct is None or abs(rec.change_pct) > REVIEW_THRESHOLD_PCT
        if big and rec.review_status in ("auto", "pending"):
            rec.review_status = "pending"
        if rec.review_status == "pending":
            stats["review"] += 1
    missing = [i for i in items if i.available and i.id not in seen] if run.full_snapshot else []
    stats["missing"] = len(missing)
    stats["missing_ids"] = [str(i.id) for i in missing]
    run.stats = stats
    run.status = "review" if stats["review"] else "matched"
    db.flush()
    return stats


def review(db: Session, rec: RawPriceRecord, approve: bool, actor: str, *, actor_type: str = "admin") -> None:
    if rec.review_status not in ("pending", "approved", "rejected"):
        raise ApiError(409, "review_not_needed", "Эта запись не требует проверки")
    if rec.published_at is not None:
        raise ApiError(409, "already_published", "Запись уже опубликована")
    before = rec.review_status
    rec.review_status = "approved" if approve else "rejected"
    rec.reviewed_by = actor
    log_action(db, actor_type=actor_type, actor_id=actor, entity="raw_price_record", entity_id=rec.id,
               action="review", before={"review_status": before, "price": rec.old_price},
               after={"review_status": rec.review_status, "price": rec.price, "change_pct": rec.change_pct})
    run = db.get(ParserRun, rec.run_id)
    pending = db.scalar(select(RawPriceRecord.id).where(RawPriceRecord.run_id == run.id,
                                                        RawPriceRecord.review_status == "pending").limit(1))
    if pending is None and run.status == "review":
        run.status = "matched"


def _source_label(run: ParserRun) -> str:
    if run.source in ("csv", "xlsx", "vendor_file") and run.file_name:
        return f"file:{run.file_name}"[:120]
    if run.source == "price_source":
        return f"source:{run.file_name or 'url'}"[:120]
    return "eman.uz" if run.source == "eman_html" else run.source


def publish(db: Session, run: ParserRun, actor: str, *, skip_pending: bool = False,
            actor_type: str = "admin") -> dict[str, Any]:
    if run.status == "failed":
        raise ApiError(409, "run_failed", "Запуск завершился ошибкой — публиковать нечего")
    records = records_of(db, run)
    pending = [r for r in records if r.review_status == "pending" and r.published_at is None]
    if pending and not skip_pending:
        raise ApiError(409, "price_review_pending",
                       f"{len(pending)} поз. с изменением цены больше 15% ждут подтверждения. "
                       "Подтвердите или отклоните их, либо опубликуйте остальное без них",
                       {"pending": [str(r.id) for r in pending]})
    eligible = [r for r in records if r.published_at is None and r.match_status in ("new", "changed", "unchanged")
                and r.review_status in ("auto", "approved")]
    missing_ids = (run.stats or {}).get("missing_ids", []) if run.published_at is None else []
    if not eligible and not missing_ids:
        raise ApiError(409, "nothing_to_publish", "Нечего публиковать")
    now = utcnow()
    label = _source_label(run)
    out = {"created": 0, "updated": 0, "confirmed": 0, "hidden": 0, "skipped_pending": len(pending)}
    for rec in eligible:
        p = rec.parsed
        if rec.match_status == "new":
            item = CatalogItem(
                supplier_id=run.supplier_id, sku=rec.sku, type=p.get("type") or "other", name=rec.name,
                core_key=p.get("core_key"), length_mm=p.get("length_mm"), width_mm=p.get("width_mm"),
                thickness_mm=p.get("thickness_mm"), decor=p.get("decor"), has_grain=bool(p.get("has_grain")),
                price=rec.price, unit=p.get("unit") or "шт", price_date=now, price_source=label,
                available=bool(p.get("available", True)), last_seen_at=now,
            )
            db.add(item)
            db.flush()
            db.add(PriceHistory(item_id=item.id, old_price=None, new_price=rec.price, source=label, run_id=run.id,
                                changed_by=actor))
            rec.matched_item_id = item.id
            out["created"] += 1
        else:
            item = db.get(CatalogItem, rec.matched_item_id)
            if item is None:
                continue
            if rec.match_status == "changed":
                before = {"price": item.price, "available": item.available}
                if rec.price != item.price:
                    db.add(PriceHistory(item_id=item.id, old_price=item.price, new_price=rec.price, source=label,
                                        run_id=run.id, changed_by=actor))
                item.price = rec.price
                item.available = bool(p.get("available", True))
                log_action(db, actor_type=actor_type, actor_id=actor, entity="catalog_item", entity_id=item.id,
                           action="price_publish", before=before,
                           after={"price": item.price, "available": item.available})
                out["updated"] += 1
            else:
                out["confirmed"] += 1
            item.price_date, item.price_source, item.last_seen_at = now, label, now
        rec.published_at = now
    for iid in missing_ids:
        item = db.get(CatalogItem, uuid.UUID(iid))
        if item is not None and item.available:
            item.available = False
            log_action(db, actor_type=actor_type, actor_id=actor, entity="catalog_item", entity_id=item.id,
                       action="missing_in_price", before={"available": True}, after={"available": False})
            out["hidden"] += 1
    run.status = "published"
    run.published_at = run.published_at or now
    run.stats = {**(run.stats or {}), "published": out}
    log_action(db, actor_type=actor_type, actor_id=actor, entity="parser_run", entity_id=run.id, action="publish",
               after=out)
    db.flush()
    return out
