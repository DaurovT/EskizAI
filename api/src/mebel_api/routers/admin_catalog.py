"""Админка: каталог и парсер прайса (ADM-04, ADM-05).

Поставщики, позиции, ручная правка цены (в историю цен и журнал действий), запуски парсера
(файл CSV или сохранённая страница eman.uz), сопоставление, очередь проверки изменений > 15%,
публикация.
"""

import uuid
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from ..db import utcnow
from ..deps import CatalogDep, SuppliersDep, SuppliersReadDep, DbDep
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import CatalogItem, ParserRun, PriceHistory, RawPriceRecord, Supplier
from ..services.action_log import log_action
from ..services.catalog import pipeline
from ..services.catalog.sources import ITEM_TYPES, CsvFileSource, EmanHtmlSource

router = APIRouter(prefix="/admin", tags=["admin"], responses=ERROR_RESPONSES)

MAX_PRICE_FILE = 10 * 1024 * 1024


def _iso(d):
    return d.isoformat() if d else None


# --- Поставщики ---


def supplier_out(s: Supplier) -> dict:
    return {"id": str(s.id), "code": s.code, "name": s.name, "order_method": s.order_method,
            "commission_percent": s.commission_bp / 100, "contacts": s.contacts, "site_url": s.site_url,
            "active": s.active, "settings": s.settings or {}, "blocked_reason": s.blocked_reason}


class OwnerIn(BaseModel):
    email: str = Field(max_length=254)
    name: str = Field(min_length=1, max_length=200)


class SupplierIn(BaseModel):
    owner: OwnerIn | None = Field(None, description="Первый владелец поставщика (vendor_owner) — временный пароль")
    settings: dict = Field(default_factory=dict, description="Реквизиты, договор, склад…")
    code: str = Field(min_length=2, max_length=40, pattern=r"^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=200)
    order_method: str = "manual_csv"
    commission_percent: float = Field(0, ge=0, le=100)
    contacts: dict = Field(default_factory=dict)
    site_url: str | None = None


class SupplierPatch(BaseModel):
    reason: str | None = Field(None, max_length=500, description="Обязательна при смене комиссии (§4a)")
    settings: dict | None = None
    name: str | None = None
    order_method: str | None = None
    commission_percent: float | None = Field(None, ge=0, le=100)
    contacts: dict | None = None
    site_url: str | None = None
    active: bool | None = None


@router.get("/suppliers", summary="Поставщики")
def suppliers(admin: SuppliersReadDep, db: DbDep) -> list[dict]:
    pipeline.ensure_supplier(db, "eman")
    db.commit()
    return [supplier_out(s) for s in db.scalars(select(Supplier).order_by(Supplier.created_at))]


@router.post("/suppliers", status_code=201, summary="Добавить поставщика")
def create_supplier(body: SupplierIn, admin: SuppliersDep, db: DbDep) -> dict:
    if db.scalar(select(Supplier).where(Supplier.code == body.code)):
        raise ApiError(409, "supplier_exists", "Поставщик с таким кодом уже есть")
    s = Supplier(code=body.code, name=body.name, order_method=body.order_method, settings=body.settings,
                 commission_bp=round(body.commission_percent * 100), contacts=body.contacts, site_url=body.site_url)
    db.add(s)
    db.flush()
    log_action(db, actor_type=admin.type, actor_id=admin.id, entity="supplier", entity_id=s.id, action="create",
               after=supplier_out(s))
    out = supplier_out(s)
    if body.owner is not None:
        from .staff import create_staff, user_out

        u, password = create_staff(db, admin.id, email=body.owner.email, name=body.owner.name, role="vendor_owner",
                                   supplier_id=s.id)
        out["owner"] = {"user": user_out(db, u), "temp_password": password}
    db.commit()
    return out


@router.patch("/suppliers/{supplier_id}", summary="Изменить поставщика (комиссия — в журнал)")
def patch_supplier(supplier_id: uuid.UUID, body: SupplierPatch, admin: SuppliersDep, db: DbDep) -> dict:
    s = db.get(Supplier, supplier_id)
    if s is None:
        raise not_found("Поставщик")
    before = supplier_out(s)
    data = body.model_dump(exclude_unset=True, exclude={"reason"})
    reason = None
    if "commission_percent" in data and round(data["commission_percent"] * 100) != s.commission_bp:
        from ..deps import require_reason

        reason = require_reason(admin, body.reason)
    if "settings" in data:
        s.settings = {**(s.settings or {}), **(data.pop("settings") or {})}
    if "commission_percent" in data:
        bp = round(data.pop("commission_percent") * 100)
        if bp != s.commission_bp:
            # История ставок главнее commission_bp (supplier_routes.commission_rate_bp): общая ставка с сегодня
            from ..models import SupplierCommission

            db.add(SupplierCommission(supplier_id=s.id, category=None, rate_bp=bp, effective_from=utcnow(),
                                      reason=reason, created_by=admin.id))
        s.commission_bp = bp
    for k, v in data.items():
        setattr(s, k, v)
    log_action(db, actor_type=admin.type, actor_id=admin.id, entity="supplier", entity_id=s.id, action="update",
               before=before, after={**supplier_out(s), **({"reason": reason} if reason else {})})
    db.commit()
    return supplier_out(s)


# --- Позиции каталога ---


def item_out(i: CatalogItem) -> dict:
    return {
        "id": str(i.id), "supplier_id": str(i.supplier_id), "sku": i.sku, "type": i.type, "name": i.name,
        "core_key": i.core_key, "length_mm": i.length_mm, "width_mm": i.width_mm, "thickness_mm": i.thickness_mm,
        "decor": i.decor, "has_grain": i.has_grain, "price": i.price, "unit": i.unit,
        "price_date": _iso(i.price_date), "price_source": i.price_source, "price_stale": pipeline.is_stale(i),
        "available": i.available, "last_seen_at": _iso(i.last_seen_at), "updated_at": _iso(i.updated_at),
    }


@router.get("/catalog/items", summary="Позиции каталога")
def items(
    admin: CatalogDep, db: DbDep, q: str | None = None, type: str | None = None, supplier_id: uuid.UUID | None = None,
    available: bool | None = None, stale: bool | None = None,
    limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
) -> dict:
    stmt = select(CatalogItem)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(CatalogItem.name).like(like), func.lower(CatalogItem.sku).like(like),
                              func.lower(CatalogItem.decor).like(like)))
    if type:
        stmt = stmt.where(CatalogItem.type == type)
    if supplier_id:
        stmt = stmt.where(CatalogItem.supplier_id == supplier_id)
    if available is not None:
        stmt = stmt.where(CatalogItem.available.is_(available))
    if stale is not None:
        border = utcnow() - timedelta(days=pipeline.STALE_DAYS)
        stmt = stmt.where(CatalogItem.price_date < border if stale else CatalogItem.price_date >= border)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(CatalogItem.type, CatalogItem.name).limit(limit).offset(offset))
    return {"items": [item_out(i) for i in rows], "total": total, "limit": limit, "offset": offset}


class ItemIn(BaseModel):
    supplier_code: str = "eman"
    sku: str = Field(min_length=1, max_length=80)
    type: str = "other"
    name: str = Field(min_length=1, max_length=300)
    core_key: str | None = None
    length_mm: float | None = None
    width_mm: float | None = None
    thickness_mm: float | None = None
    decor: str | None = None
    has_grain: bool = False
    price: int = Field(gt=0)
    unit: str = "шт"
    available: bool = True


class ItemPatch(BaseModel):
    name: str | None = None
    type: str | None = None
    core_key: str | None = None
    decor: str | None = None
    thickness_mm: float | None = None
    length_mm: float | None = None
    width_mm: float | None = None
    has_grain: bool | None = None
    price: int | None = Field(None, gt=0)
    unit: str | None = None
    available: bool | None = None


@router.post("/catalog/items", status_code=201, summary="Добавить позицию вручную")
def create_item(body: ItemIn, admin: CatalogDep, db: DbDep) -> dict:
    if body.type not in ITEM_TYPES:
        raise ApiError(422, "invalid_type", f"Тип позиции: {', '.join(sorted(ITEM_TYPES))}")
    s = pipeline.ensure_supplier(db, body.supplier_code)
    if db.scalar(select(CatalogItem).where(CatalogItem.supplier_id == s.id, CatalogItem.sku == body.sku)):
        raise ApiError(409, "item_exists", "Позиция с таким артикулом уже есть")
    now = utcnow()
    i = CatalogItem(supplier_id=s.id, **body.model_dump(exclude={"supplier_code"}), price_date=now,
                    price_source="manual", last_seen_at=now)
    db.add(i)
    db.flush()
    db.add(PriceHistory(item_id=i.id, old_price=None, new_price=i.price, source="manual", changed_by=admin.id))
    log_action(db, actor_type=admin.type, actor_id=admin.id, entity="catalog_item", entity_id=i.id, action="create",
               after={"sku": i.sku, "name": i.name, "price": i.price})
    db.commit()
    return item_out(i)


@router.patch("/catalog/items/{item_id}", summary="Ручная правка позиции и цены")
def patch_item(item_id: uuid.UUID, body: ItemPatch, admin: CatalogDep, db: DbDep) -> dict:
    i = db.get(CatalogItem, item_id)
    if i is None:
        raise not_found("Позиция каталога")
    data = body.model_dump(exclude_unset=True)
    if data.get("type") and data["type"] not in ITEM_TYPES:
        raise ApiError(422, "invalid_type", f"Тип позиции: {', '.join(sorted(ITEM_TYPES))}")
    before = {k: getattr(i, k) for k in data}
    if "price" in data and data["price"] is not None and data["price"] != i.price:
        db.add(PriceHistory(item_id=i.id, old_price=i.price, new_price=data["price"], source="manual",
                            changed_by=admin.id))
        i.price_date = utcnow()
        i.price_source = "manual"
    for k, v in data.items():
        if v is not None or k in ("core_key", "decor"):
            setattr(i, k, v)
    log_action(db, actor_type=admin.type, actor_id=admin.id, entity="catalog_item", entity_id=i.id, action="update",
               before=before, after={k: getattr(i, k) for k in data})
    db.commit()
    return item_out(i)


@router.get("/catalog/items/{item_id}/history", summary="История цен позиции")
def item_history(item_id: uuid.UUID, admin: CatalogDep, db: DbDep) -> list[dict]:
    if db.get(CatalogItem, item_id) is None:
        raise not_found("Позиция каталога")
    rows = db.scalars(select(PriceHistory).where(PriceHistory.item_id == item_id)
                      .order_by(PriceHistory.created_at.desc()))
    return [{"id": str(h.id), "old_price": h.old_price, "new_price": h.new_price, "source": h.source,
             "run_id": str(h.run_id) if h.run_id else None, "changed_by": h.changed_by,
             "created_at": _iso(h.created_at)} for h in rows]


# --- Парсер прайса ---


def run_out(r: ParserRun, supplier: Supplier | None = None) -> dict:
    stats = {k: v for k, v in (r.stats or {}).items() if k != "missing_ids"}
    return {"id": str(r.id), "supplier_id": str(r.supplier_id), "supplier": supplier.name if supplier else None,
            "source": r.source, "file_name": r.file_name, "full_snapshot": r.full_snapshot, "status": r.status,
            "stats": stats, "error": r.error, "created_by": r.created_by, "started_at": _iso(r.started_at),
            "finished_at": _iso(r.finished_at), "published_at": _iso(r.published_at)}


def record_out(rec: RawPriceRecord, item: CatalogItem | None = None) -> dict:
    return {"id": str(rec.id), "run_id": str(rec.run_id), "sku": rec.sku, "name": rec.name, "price": rec.price,
            "parsed": rec.parsed, "data": rec.data,
            "matched_item_id": str(rec.matched_item_id) if rec.matched_item_id else None,
            "matched_item_name": item.name if item else None, "match_status": rec.match_status,
            "old_price": rec.old_price, "change_pct": rec.change_pct, "review_status": rec.review_status,
            "reviewed_by": rec.reviewed_by, "published_at": _iso(rec.published_at), "error": rec.error}


@router.get("/catalog/parser-runs", summary="Журнал запусков парсера")
def runs(admin: CatalogDep, db: DbDep, limit: int = Query(50, ge=1, le=200)) -> list[dict]:
    suppliers = {s.id: s for s in db.scalars(select(Supplier))}
    rows = db.scalars(select(ParserRun).order_by(ParserRun.started_at.desc()).limit(limit))
    return [run_out(r, suppliers.get(r.supplier_id)) for r in rows]


@router.post("/catalog/parser-runs", status_code=201, summary="Запустить разбор прайса из файла")
async def create_run(
    admin: CatalogDep, db: DbDep,
    file: UploadFile = File(description="CSV прайса или сохранённая HTML-страница каталога eman.uz"),
    source: Literal["csv", "eman_html"] = Form("csv"),
    supplier_code: str = Form("eman"),
    full_snapshot: bool = Form(True, description="Полный прайс: позиции, которых в нём нет, — «исчезли»"),
) -> dict:
    """Разбор → сырые записи → сопоставление. Публикация — отдельным шагом после проверки.
    Загрузка страниц с сайта eman.uz не выполняется (скелет; см. services/catalog/sources.py)."""
    data = await file.read(MAX_PRICE_FILE + 1)
    if len(data) > MAX_PRICE_FILE:
        raise ApiError(413, "file_too_large", "Файл больше 10 МБ")
    if not data:
        raise ApiError(422, "empty_file", "Файл пустой")
    supplier = pipeline.ensure_supplier(db, supplier_code)
    name = file.filename or ("prices.csv" if source == "csv" else "page.html")
    src = CsvFileSource(data, name) if source == "csv" else EmanHtmlSource([data.decode("utf-8", "replace")])
    run = pipeline.create_run(db, supplier, src, created_by=admin.id, file_name=name, full_snapshot=full_snapshot)
    log_action(db, actor_type=admin.type, actor_id=admin.id, entity="parser_run", entity_id=run.id, action="create",
               after={"source": source, "file": name, "status": run.status})
    db.commit()
    return run_out(run, supplier)


def _run(db, run_id: uuid.UUID) -> ParserRun:
    r = db.get(ParserRun, run_id)
    if r is None:
        raise not_found("Запуск парсера")
    return r


@router.get("/catalog/parser-runs/{run_id}", summary="Запуск парсера: сырые записи и сопоставление")
def run_card(run_id: uuid.UUID, admin: CatalogDep, db: DbDep,
             match_status: Annotated[str | None, Query(description="new, changed, unchanged, invalid")] = None) -> dict:
    r = _run(db, run_id)
    recs = pipeline.records_of(db, r)
    if match_status:
        recs = [x for x in recs if x.match_status == match_status]
    items = {i.id: i for i in db.scalars(select(CatalogItem).where(
        CatalogItem.id.in_([x.matched_item_id for x in recs if x.matched_item_id])))}
    missing = [item_out(i) for i in db.scalars(select(CatalogItem).where(
        CatalogItem.id.in_([uuid.UUID(x) for x in (r.stats or {}).get("missing_ids", [])])))]
    return {**run_out(r, db.get(Supplier, r.supplier_id)),
            "records": [record_out(x, items.get(x.matched_item_id)) for x in recs], "missing": missing}


@router.post("/catalog/parser-runs/{run_id}/match", summary="Повторить сопоставление")
def rematch(run_id: uuid.UUID, admin: CatalogDep, db: DbDep) -> dict:
    r = _run(db, run_id)
    if r.status in ("published", "failed"):
        raise ApiError(409, "run_closed", "Запуск уже опубликован или завершился ошибкой")
    pipeline.match_run(db, r)
    db.commit()
    return run_out(r)


class PublishIn(BaseModel):
    skip_pending: bool = Field(False, description="Опубликовать без позиций, ждущих подтверждения")


@router.post("/catalog/parser-runs/{run_id}/publish", summary="Опубликовать цены")
def publish(run_id: uuid.UUID, body: PublishIn, admin: CatalogDep, db: DbDep) -> dict:
    r = _run(db, run_id)
    out = pipeline.publish(db, r, admin.id, actor_type=admin.type, skip_pending=body.skip_pending)
    notified = 0
    if out.get("updated") or out.get("hidden"):
        from ..services import events

        notified = events.prices_published(db)  # «Цены EMAN изменились» (раздел 19)
    db.commit()
    return {**run_out(r), "published": out, "notified_projects": notified}


@router.get("/catalog/review-queue", summary="Очередь проверки: изменения цены > 15%")
def review_queue(admin: CatalogDep, db: DbDep) -> list[dict]:
    recs = list(db.scalars(select(RawPriceRecord).where(RawPriceRecord.review_status == "pending",
                                                        RawPriceRecord.published_at.is_(None))
                           .order_by(RawPriceRecord.created_at)))
    items = {i.id: i for i in db.scalars(select(CatalogItem).where(
        CatalogItem.id.in_([x.matched_item_id for x in recs if x.matched_item_id])))}
    border = utcnow() - timedelta(hours=24)  # поставщик не подтвердил за сутки — эскалация суперадмину (§4a)
    runs = {r.id: r for r in db.scalars(select(ParserRun).where(ParserRun.id.in_({x.run_id for x in recs})))}
    return [{**record_out(x, items.get(x.matched_item_id)),
             "supplier_id": str(runs[x.run_id].supplier_id) if x.run_id in runs else None,
             "escalated": x.created_at < border} for x in recs]


class ReviewIn(BaseModel):
    action: Literal["approve", "reject"]


@router.post("/catalog/raw-records/{record_id}/review", summary="Подтвердить или отклонить изменение цены")
def review(record_id: uuid.UUID, body: ReviewIn, admin: CatalogDep, db: DbDep) -> dict:
    rec = db.get(RawPriceRecord, record_id)
    if rec is None:
        raise not_found("Запись прайса")
    pipeline.review(db, rec, body.action == "approve", admin.id, actor_type=admin.type)
    db.commit()
    return record_out(rec)
