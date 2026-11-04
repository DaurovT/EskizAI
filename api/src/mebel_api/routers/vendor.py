"""Кабинет поставщика `/vendor/*` (docs/staff_vendor_contract.md §5).

Только сотрудники поставщика и только данные своего поставщика — проверка в каждом запросе:
чужой заказ, заявка, позиция, запуск или возврат — 404 (не выдаём, что объект существует).
Конструктор видит очередь (новые заказы без конструктора) и свои заказы; владелец — все.
"""

import json
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from ..db import utcnow
from ..deps import DbDep, SettingsDep, StaffActor, StorageDep, TasksDep, vendor_dep
from ..domain import ORDER_STATUS_LABELS, OrderStatus as O
from ..errors import ERROR_RESPONSES, ApiError, forbidden, not_found
from ..models import (
    CatalogItem,
    Measurement,
    ModelVersion,
    NonstandardRequest,
    Order,
    OrderCorrection,
    OrderEvent,
    OrderMessage,
    OrderReturn,
    ParserRun,
    PriceHistory,
    PriceRequest,
    Project,
    ProjectPhoto,
    StaffUser,
    Supplier,
    SupplierPriceSource,
    User,
    Workshop,
)
from ..services import finance, order_flow as flow, price_import, uploads
from ..services.action_log import log_action
from ..services.catalog import pipeline

router = APIRouter(prefix="/vendor", tags=["vendor"], responses=ERROR_RESPONSES)

AnyVendor = vendor_dep()
OrdersWork = vendor_dep("vendor.orders.work")
OrdersAll = vendor_dep("vendor.orders.all")
Chat = vendor_dep("vendor.chat")
Corrections = vendor_dep("vendor.corrections")
Returns = vendor_dep("vendor.returns")
RefundsApprove = vendor_dep("vendor.refunds.approve")
NonstandardV = vendor_dep("vendor.nonstandard")
Quotes = vendor_dep("vendor.quotes")
Prices = vendor_dep("vendor.prices")
FinanceV = vendor_dep("vendor.finance")
Analytics = vendor_dep("vendor.analytics")
SettingsV = vendor_dep("vendor.settings")

PAGE_SIZE = 50
MAX_FILE = 50 * 1024 * 1024
ORDER_FILES = {"csv": ("CSV для онлайн-кроя", "csv", "text/csv; charset=utf-8"),
               "cutmaps_pdf": ("Карты раскроя (PDF)", "pdf", "application/pdf"),
               "spec_pdf": ("Спецификация деталей (PDF)", "pdf", "application/pdf"),
               "dxf_zip": ("DXF деталей для станка (архив)", "zip", "application/zip"),
               "drawings_pdf": ("Чертежи деталей с присадкой (PDF)", "pdf", "application/pdf"),
               "invoice": ("Счёт по заказу (PDF)", "pdf", "application/pdf")}


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _log(db, actor: StaffActor, entity: str, entity_id, action: str, *, before=None, after=None, workshop_id=None):
    log_action(db, actor_type=actor.type, actor_id=actor.id, workshop_id=workshop_id, entity=entity,
               entity_id=entity_id, action=action, before=before, after=after)


def _page(page: int, page_size: int) -> tuple[int, int]:
    return page_size, (page - 1) * page_size


def _file_response(data: bytes, name: str, content_type: str) -> Response:
    """Файл, собранный сервером (PDF, CSV, DXF, счёт)."""
    return uploads.download_response(data, name, content_type)


def _stored(storage, f: dict) -> Response:
    """Загруженный файл: тип по содержимому, inline — только PNG/JPEG/WebP (services/uploads.py)."""
    try:
        data = storage.read(f["key"])
    except (OSError, ValueError):
        raise not_found("Файл") from None
    return uploads.file_response(data, f.get("name") or "file", f.get("content_type"))


# --- Заказы: доступ ---


def _order(db, actor: StaffActor, order_id: uuid.UUID) -> tuple[Order, Project]:
    o = db.get(Order, order_id)
    if o is None or o.supplier_id != actor.supplier_id:
        raise not_found("Заказ")
    if not actor.can("vendor.orders.all") and o.assignee_id != actor.staff_uuid \
            and not (o.assignee_id is None and o.status == O.created):
        raise not_found("Заказ")  # конструктор: свои заказы и очередь (новые без конструктора); прочее — владелец
    p = db.get(Project, o.project_id)
    if p is None:
        raise not_found("Заказ")
    return o, p


def _ensure_mine(o: Order, actor: StaffActor) -> None:
    """Решения по заказу — назначенный конструктор (свободный заказ берётся на себя) или владелец."""
    if o.assignee_id is None:
        o.assignee_id = actor.staff_uuid
    elif o.assignee_id != actor.staff_uuid and not actor.can("vendor.orders.all"):
        raise forbidden("Заказ ведёт другой конструктор")


def _brief(db, o: Order, p: Project, w: Workshop | None = None) -> dict[str, Any]:
    w = w or db.get(Workshop, p.workshop_id)
    assignee = db.get(StaffUser, o.assignee_id) if o.assignee_id else None
    unread = db.scalar(select(func.count(OrderMessage.id)).where(
        OrderMessage.order_id == o.id, OrderMessage.author_type == "master",
        OrderMessage.read_by_vendor_at.is_(None))) or 0
    return {
        "id": str(o.id), "number": o.number, "status": o.status, "status_label": ORDER_STATUS_LABELS.get(o.status),
        "project_id": str(p.id), "project_title": p.title, "workshop_id": str(w.id) if w else None,
        "workshop_name": w.name if w else None, "group_id": str(o.group_id) if o.group_id else None,
        "assignee": {"id": str(assignee.id), "name": assignee.name} if assignee else None,
        "estimate_total": o.estimate_total, "invoice_total": o.invoice_total, "total": flow.order_total(o),
        "due_date": _iso(o.due_date), "created_at": _iso(o.created_at), "accepted_at": _iso(o.accepted_at),
        "paid_at": _iso(o.paid_at), "status_changed_at": _iso(o.status_changed_at),
        "waiting_hours": round((utcnow() - o.created_at).total_seconds() / 3600, 1)
        if o.status == O.created else None,
        "unread_messages": unread, "payment_url": o.payment_url,
    }


def _allowed(o: Order) -> list[str]:
    out = []
    if o.status == O.created:
        out += [O.accepted, O.returned, O.rejected]
    elif o.status == O.paid and o.accepted_at is None:  # старый порядок: оплачен до проверки
        out += [O.accepted, O.cutting]
    elif o.status == O.accepted and o.paid_at is None:
        out += [O.paid, O.returned, O.rejected]
    elif o.status == O.accepted:
        out += [O.cutting]
    elif o.status in flow.PRODUCTION_NEXT:
        out += [flow.PRODUCTION_NEXT[o.status]]
    return [str(x) for x in out]


@router.get("/orders", summary="Заказы: очередь, мои, все (владелец)")
def list_orders(actor: OrdersWork, db: DbDep, scope: Literal["queue", "mine", "all"] = "queue",
                status: Annotated[list[str] | None, Query()] = None, q: str | None = None,
                page: int = Query(1, ge=1), page_size: int = Query(PAGE_SIZE, ge=1, le=200)) -> dict:
    stmt = select(Order, Project, Workshop).join(Project, Order.project_id == Project.id) \
        .join(Workshop, Project.workshop_id == Workshop.id).where(Order.supplier_id == actor.supplier_id)
    if scope == "queue":
        stmt = stmt.where(Order.assignee_id.is_(None), Order.status == O.created)
    elif scope == "mine":
        stmt = stmt.where(Order.assignee_id == actor.staff_uuid)
    elif not actor.can("vendor.orders.all"):
        raise forbidden("Все заказы видит владелец")
    if status:
        stmt = stmt.where(Order.status.in_(status))
    if q:
        like = f"%{q.strip().lower()}%"
        conds = [func.lower(Project.title).like(like), func.lower(Workshop.name).like(like)]
        if q.strip().isdigit():
            conds.append(Order.number == int(q.strip()))
        stmt = stmt.where(or_(*conds))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    limit, offset = _page(page, page_size)
    order_by = Order.created_at.asc() if scope == "queue" else Order.created_at.desc()
    rows = db.execute(stmt.order_by(order_by).limit(limit).offset(offset)).all()
    return {"items": [_brief(db, o, p, w) for o, p, w in rows], "total": total, "page": page,
            "page_size": page_size}


def _history(db, o: Order) -> list[dict]:
    return [flow.event_out(e) for e in db.scalars(select(OrderEvent).where(OrderEvent.order_id == o.id)
                                                  .order_by(OrderEvent.created_at))]


def _correction_out(db, c: OrderCorrection, settings) -> dict:
    from .orders import correction_out

    return correction_out(db, c, settings)


@router.get("/orders/{order_id}", summary="Карточка заказа: состав, суммы, история, цех, проект, файлы")
def get_order(order_id: uuid.UUID, actor: OrdersWork, db: DbDep, settings: SettingsDep) -> dict:
    o, p = _order(db, actor, order_id)
    w = db.get(Workshop, p.workshop_id)
    master = db.get(User, o.created_by) if o.created_by else None
    v = db.get(ModelVersion, o.version_id) if o.version_id else None
    comp = o.composition or {}
    measurements = [{"id": str(m.id), "width": m.width, "height": m.height, "depth": m.depth, "data": m.data,
                     "notes": m.notes, "created_at": _iso(m.created_at)}
                    for m in db.scalars(select(Measurement).where(Measurement.project_id == p.id)
                                        .order_by(Measurement.created_at.desc()))]
    photos = [{"id": str(ph.id), "kind": ph.kind, "url": ph.url}
              for ph in db.scalars(select(ProjectPhoto).where(ProjectPhoto.project_id == p.id)
                                   .order_by(ProjectPhoto.created_at))]
    corrections = db.scalars(select(OrderCorrection).where(OrderCorrection.order_id == o.id)
                             .order_by(OrderCorrection.created_at.desc()))
    from ..models import OrderDispute

    disputes = db.scalars(select(OrderDispute).where(OrderDispute.order_id == o.id))
    return {
        **_brief(db, o, p, w),
        "composition": comp, "lines": comp.get("lines") or [], "excluded": comp.get("excluded") or [],
        "delivery": comp.get("delivery"), "goods_total": comp.get("goods_total"), "distance_km": o.distance_km,
        "pickup": o.distance_km is None, "notes": o.notes, "vendor_status_note": o.vendor_status_note,
        "return_comment": o.return_comment, "reject_reason": o.reject_reason,
        "allowed_statuses": _allowed(o),
        "workshop": {"id": str(w.id), "name": w.name, "phone": w.phone or (master.phone if master else None),
                     "city": w.city} if w else None,
        "master": {"id": str(master.id), "name": master.name, "phone": master.phone} if master else None,
        "project": {"id": str(p.id), "title": p.title, "product_type": p.product_type, "status": p.status,
                    "measurements": measurements, "photos": photos,
                    "version": {"id": str(v.id), "number": v.number, "summary": v.summary,
                                "viewer_url": f"/vendor/orders/{o.id}/model"} if v else None},
        "files": [{"kind": k, "title": t, "url": f"/vendor/orders/{o.id}/files/{k}"} for k, (t, _, _) in
                  ORDER_FILES.items()] + [{"kind": "csv_short", "title": "CSV", "url": f"/vendor/orders/{o.id}/csv"}],
        "history": _history(db, o),
        "corrections": [_correction_out(db, c, settings) for c in corrections],
        "returns": flow.returns_of(db, o, settings),
        "disputes": [flow.dispute_out(d, settings) for d in disputes],
    }


@router.get("/orders/{order_id}/model", summary="3D-модель версии заказа (для просмотра)")
def order_model(order_id: uuid.UUID, actor: OrdersWork, db: DbDep) -> dict:
    o, p = _order(db, actor, order_id)
    v = db.get(ModelVersion, o.version_id) if o.version_id else None
    if v is None:
        raise ApiError(409, "model_missing", "У заказа нет версии модели")
    return {"id": str(v.id), "number": v.number, "viewer": v.viewer, "issues": v.issues, "summary": v.summary}


def _sheet_materials(comp: dict | None) -> set[str]:
    keys = [str(l.get("key") or "") for l in (comp or {}).get("lines") or [] if isinstance(l, dict)]
    return {k.split(":", 1)[1] for k in keys if k.startswith("sheet:")}


def _part_filter(db, o: Order):
    """Заказ — часть деления между поставщиками → фильтр деталей по материалам листов (None — весь проект).
    Второй поставщик получает детали только из листов своих строк; основной (поставщик по умолчанию,
    у него и позиции «под запрос») — все, кроме листов, ушедших другим поставщикам."""
    if o.group_id is None:
        return None
    siblings = list(db.scalars(select(Order).where(Order.group_id == o.group_id, Order.id != o.id)))
    if not any(x.supplier_id != o.supplier_id for x in siblings):
        return None
    from ..services.supplier_routes import default_supplier

    if o.supplier_id is not None and o.supplier_id == default_supplier(db).id:
        others = set().union(*(_sheet_materials(x.composition) for x in siblings)) - _sheet_materials(o.composition)
        return lambda material: material not in others
    own = _sheet_materials(o.composition)
    return lambda material: material in own


def _builder(db, o: Order, p: Project):
    from ..services.files import Builder

    v = db.get(ModelVersion, o.version_id or p.frozen_version_id or p.current_version_id)
    if v is None:
        raise ApiError(409, "model_missing", "У проекта нет модели")
    b = Builder(db, p, db.get(Workshop, p.workshop_id), v, with_cost=False, language="ru")
    keep = _part_filter(db, o)
    if keep is not None:  # заказ поделён между поставщиками: раскрой, CSV, DXF, PDF — только по своим листам
        parts = [pt for pt in b.result.parts if keep(pt.material)]
        if not parts:
            raise ApiError(409, "no_parts", "В этом заказе нет деталей для раскроя — только позиции из состава")
        b._result = b.result.model_copy(update={"parts": parts})
    return b, v


@router.get("/orders/{order_id}/csv", summary="CSV онлайн-кроя")
def order_csv(order_id: uuid.UUID, actor: OrdersWork, db: DbDep) -> Response:
    o, p = _order(db, actor, order_id)
    b, v = _builder(db, o, p)
    return _file_response(b.make("csv"), f"order_{o.number or str(o.id)[:8]}_v{v.number}.csv",
                          "text/csv; charset=utf-8")


@router.get("/orders/{order_id}/files/{kind}", summary="Файлы заказа: раскрой, DXF для станка, чертежи, счёт",
            responses={200: {"content": {"application/octet-stream": {}}}})
def order_file(order_id: uuid.UUID, kind: str, actor: OrdersWork, db: DbDep) -> Response:
    o, p = _order(db, actor, order_id)
    if kind not in ORDER_FILES:
        raise not_found("Файл")
    title, ext, ctype = ORDER_FILES[kind]
    number = o.number or str(o.id)[:8].upper()
    if kind == "invoice":
        from ..services.invoice import invoice_pdf

        if not o.composition:
            raise ApiError(409, "invoice_missing", "По заказу нет состава — счёт не собрать")
        s = db.get(Supplier, o.supplier_id)
        data = invoice_pdf(o, p, db.get(Workshop, p.workshop_id), "ru", s.name if s else o.supplier.upper())
        return _file_response(data, f"invoice_{number}.pdf", ctype)
    b, v = _builder(db, o, p)
    return _file_response(b.make(kind), f"order_{number}_v{v.number}_{kind}.{ext}", ctype)


# --- Заказы: действия ---


def _actor_kw(actor: StaffActor) -> dict:
    return {"actor_type": "vendor", "actor_id": actor.id, "actor_name": actor.name}


@router.post("/orders/{order_id}/take", summary="Взять заказ из очереди в работу")
def take(order_id: uuid.UUID, actor: OrdersWork, db: DbDep) -> dict:
    o, p = _order(db, actor, order_id)
    if o.assignee_id is not None and o.assignee_id != actor.staff_uuid:
        raise ApiError(409, "order_taken", "Заказ уже взял другой конструктор")
    if o.status in flow.INACTIVE or o.status == O.issued:
        raise ApiError(409, "order_closed", "Заказ закрыт")
    o.assignee_id = actor.staff_uuid
    flow.event(db, o, "take", **_actor_kw(actor))
    _log(db, actor, "order", o.id, "take", workshop_id=p.workshop_id, after={"assignee_id": actor.id})
    db.commit()
    return _brief(db, o, p)


class AssignIn(BaseModel):
    assignee_id: uuid.UUID | None = Field(description="Конструктор поставщика; null — вернуть в очередь")


@router.post("/orders/{order_id}/assign", summary="Назначить или переназначить конструктора (владелец)")
def assign(order_id: uuid.UUID, body: AssignIn, actor: OrdersAll, db: DbDep) -> dict:
    o, p = _order(db, actor, order_id)
    name = None
    if body.assignee_id is not None:
        s = db.get(StaffUser, body.assignee_id)
        if s is None or s.supplier_id != actor.supplier_id or not s.is_active:
            raise not_found("Сотрудник")
        name = s.name
    before = {"assignee_id": str(o.assignee_id) if o.assignee_id else None}
    o.assignee_id = body.assignee_id
    flow.event(db, o, "assign", **_actor_kw(actor), data={"assignee_id": str(body.assignee_id)
                                                          if body.assignee_id else None, "assignee_name": name})
    _log(db, actor, "order", o.id, "assign", workshop_id=p.workshop_id, before=before,
         after={"assignee_id": str(body.assignee_id) if body.assignee_id else None})
    db.commit()
    return _brief(db, o, p)


class AcceptIn(BaseModel):
    invoice_total: int | None = Field(None, ge=0, description="Сумма счёта; нет — по смете")
    due_date: datetime | None = Field(None, description="Срок готовности")
    comment: str | None = Field(None, max_length=2000)
    payment_url: str | None = Field(None, max_length=1000, description="Ссылка на оплату для мастера")


@router.post("/orders/{order_id}/accept", summary="Принять: заказ проверен, счёт и срок → мастеру")
def accept(order_id: uuid.UUID, body: AcceptIn, actor: OrdersWork, db: DbDep) -> dict:
    o, p = _order(db, actor, order_id)
    old_flow_paid = o.status == O.paid and o.accepted_at is None
    if o.status != O.created and not old_flow_paid:
        flow.ensure(o, {O.created.value}, "принять")
    _ensure_mine(o, actor)
    if not old_flow_paid:
        o.invoice_total = body.invoice_total if body.invoice_total is not None else o.estimate_total
    elif body.invoice_total is not None:
        o.invoice_total = body.invoice_total
    o.due_date = flow.parse_due_date(body.due_date)
    if body.payment_url is not None:
        o.payment_url = body.payment_url or None
    elif not o.payment_url:
        s = db.get(Supplier, o.supplier_id)
        o.payment_url = ((s.settings or {}).get("payment_url") or None) if s else None
    if body.comment:
        o.vendor_status_note = body.comment
    if old_flow_paid:
        o.accepted_at = utcnow()
    flow.set_status(db, o, O.accepted, **_actor_kw(actor), comment=body.comment,
                    data={"invoice_total": o.invoice_total, "due_date": _iso(o.due_date)})
    db.commit()
    return _brief(db, o, p)


class CommentIn(BaseModel):
    comment: str = Field(min_length=3, max_length=2000)


@router.post("/orders/{order_id}/return", summary="Вернуть мастеру на правку (обязательный комментарий)")
def return_to_master(order_id: uuid.UUID, body: CommentIn, actor: OrdersWork, db: DbDep) -> dict:
    o, p = _order(db, actor, order_id)
    if o.paid_at is not None:
        raise ApiError(409, "order_paid", "Оплаченный заказ на правку не возвращается — оформите исправление или возврат")
    flow.ensure(o, {O.created.value, O.accepted.value}, "вернуть мастеру")
    _ensure_mine(o, actor)
    o.return_comment = o.vendor_status_note = body.comment.strip()
    flow.set_status(db, o, O.returned, **_actor_kw(actor), comment=o.return_comment)
    flow.post_message(db, o, author_type="vendor", author_id=actor.id, author_name=actor.name,
                      text=f"Заказ возвращён на правку: {o.return_comment}", attachments=[])
    db.commit()
    return _brief(db, o, p)


class RejectIn(BaseModel):
    reason: str = Field(description=", ".join(flow.REJECT_REASONS))
    comment: str = Field(min_length=3, max_length=2000)


@router.post("/orders/{order_id}/reject", summary="Отклонить (причина из списка + текст); заказ закрыт")
def reject(order_id: uuid.UUID, body: RejectIn, actor: OrdersWork, db: DbDep) -> dict:
    o, p = _order(db, actor, order_id)
    if body.reason not in flow.REJECT_REASONS:
        raise ApiError(422, "validation_error", f"Причина: {', '.join(flow.REJECT_REASONS)}")
    if o.paid_at is not None:
        raise ApiError(409, "order_paid", "Оплаченный заказ не отклоняется — оформите возврат")
    flow.ensure(o, {O.created.value, O.accepted.value}, "отклонить")
    _ensure_mine(o, actor)
    o.reject_reason, o.vendor_status_note = body.reason, body.comment.strip()
    flow.set_status(db, o, O.rejected, **_actor_kw(actor), comment=o.vendor_status_note,
                    data={"reason": body.reason, "reason_label": flow.REJECT_REASONS[body.reason]})
    db.commit()
    return _brief(db, o, p)


class StatusIn(BaseModel):
    status: O
    comment: str | None = Field(None, max_length=2000)


@router.post("/orders/{order_id}/status", summary="Оплата получена, производство: в раскрое → готов → выдан")
def set_status(order_id: uuid.UUID, body: StatusIn, actor: OrdersWork, db: DbDep) -> dict:
    o, p = _order(db, actor, order_id)
    allowed = _allowed(o)
    target = body.status.value
    if target in (O.accepted, O.returned, O.rejected):
        raise ApiError(422, "use_action", "Для этого есть отдельные действия: accept, return, reject")
    if target not in allowed:
        raise ApiError(409, "illegal_order_transition", f"Из «{flow.label(o.status)}» нельзя перейти в "
                                                       f"«{flow.label(target)}»", {"allowed": allowed})
    _ensure_mine(o, actor)
    if body.comment:
        o.vendor_status_note = body.comment
    if target == O.paid:
        flow.mark_paid(db, o, **_actor_kw(actor), project_actor="vendor", comment=body.comment)
    else:
        flow.set_status(db, o, target, **_actor_kw(actor), comment=body.comment)
    db.commit()
    return _brief(db, o, p)


class OrderPatch(BaseModel):
    invoice_total: int | None = Field(None, ge=0)
    payment_url: str | None = Field(None, max_length=1000)
    notes: str | None = Field(None, max_length=2000)
    due_date: datetime | None = None


@router.patch("/orders/{order_id}", summary="Счёт, ссылка на оплату, заметка, срок")
def patch_order(order_id: uuid.UUID, body: OrderPatch, actor: OrdersWork, db: DbDep) -> dict:
    o, p = _order(db, actor, order_id)
    if o.status in flow.INACTIVE:
        raise ApiError(409, "order_closed", "Заказ закрыт")
    _ensure_mine(o, actor)
    data = body.model_dump(exclude_unset=True)
    if "invoice_total" in data and o.paid_at is not None:
        raise ApiError(409, "order_paid", "Сумма оплаченного заказа меняется через возврат")
    if "due_date" in data:
        data["due_date"] = flow.parse_due_date(data["due_date"])
    before = {k: _iso(v) if isinstance(v, datetime) else v for k, v in ((k, getattr(o, k)) for k in data)}
    for k, v in data.items():
        setattr(o, k, v)
    after = {k: _iso(v) if isinstance(v, datetime) else v for k, v in data.items()}
    _log(db, actor, "order", o.id, "vendor_update", workshop_id=p.workshop_id, before=before, after=after)
    flow.event(db, o, "update", **_actor_kw(actor), data=after)
    db.commit()
    return _brief(db, o, p)


# --- Переписка ---


@router.get("/orders/{order_id}/messages", summary="Переписка с мастером")
def messages(order_id: uuid.UUID, actor: Chat, db: DbDep, settings: SettingsDep) -> dict:
    o, _ = _order(db, actor, order_id)
    rows = db.scalars(select(OrderMessage).where(OrderMessage.order_id == o.id).order_by(OrderMessage.created_at))
    unread = db.scalar(select(func.count(OrderMessage.id)).where(
        OrderMessage.order_id == o.id, OrderMessage.author_type == "master",
        OrderMessage.read_by_vendor_at.is_(None))) or 0
    return {"items": [flow.message_out(m, settings) for m in rows], "unread_count": unread}


@router.post("/orders/{order_id}/messages", status_code=201, summary="Написать мастеру (текст и файлы) → push")
async def post_message(order_id: uuid.UUID, actor: Chat, db: DbDep, storage: StorageDep, settings: SettingsDep,
                       text: Annotated[str, Form(max_length=5000)] = "",
                       files: Annotated[list[UploadFile] | None, File()] = None) -> dict:
    o, p = _order(db, actor, order_id)
    attachments = await flow.store_files(storage, files, f"suppliers/{actor.supplier_id}/orders/{o.id}/messages")
    m = flow.post_message(db, o, author_type="vendor", author_id=actor.id, author_name=actor.name, text=text,
                          attachments=attachments)
    db.commit()
    return flow.message_out(m, settings)


@router.post("/orders/{order_id}/messages/read", summary="Отметить сообщения мастера прочитанными")
def read_messages(order_id: uuid.UUID, actor: Chat, db: DbDep) -> dict:
    o, _ = _order(db, actor, order_id)
    n = flow.mark_read(db, o, "vendor")
    db.commit()
    return {"ok": True, "marked": n}


# --- Исправления ---


def _norm_lines(raw: str) -> list[dict[str, Any]]:
    try:
        lines = json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(422, "invalid_lines", "lines_after — JSON-список строк") from None
    if not isinstance(lines, list) or not lines or len(lines) > 500:
        raise ApiError(422, "invalid_lines", "lines_after — непустой список строк")
    out = []
    for i, l in enumerate(lines):
        if not isinstance(l, dict):
            raise ApiError(422, "invalid_lines", f"Строка {i + 1}: нужен объект")
        try:
            qty, price = float(l.get("qty")), int(l.get("price"))
        except (TypeError, ValueError):
            raise ApiError(422, "invalid_lines", f"Строка {i + 1}: нужны qty и price") from None
        name = str(l.get("name") or "").strip()
        if not name or qty < 0 or price < 0:
            raise ApiError(422, "invalid_lines", f"Строка {i + 1}: название, qty ≥ 0, price ≥ 0")
        out.append({"key": str(l.get("key") or f"custom:{i}")[:120], "name": name[:300],
                    "unit": str(l.get("unit") or "шт")[:20], "qty": qty, "price": price, "total": round(qty * price)})
    return out


@router.get("/orders/{order_id}/corrections", summary="Исправления заказа")
def corrections(order_id: uuid.UUID, actor: Corrections, db: DbDep, settings: SettingsDep) -> dict:
    o, _ = _order(db, actor, order_id)
    return {"items": [_correction_out(db, c, settings) for c in db.scalars(
        select(OrderCorrection).where(OrderCorrection.order_id == o.id).order_by(OrderCorrection.created_at.desc()))]}


@router.post("/orders/{order_id}/corrections", status_code=201,
             summary="Исправить заказ: строки, файлы, комментарий (изменилась сумма или состав — ждёт мастера)")
async def create_correction(order_id: uuid.UUID, actor: Corrections, db: DbDep, storage: StorageDep,
                            settings: SettingsDep,
                            lines_after: Annotated[str, Form(description="JSON: [{key?, name, qty, unit, price}]")],
                            comment: Annotated[str, Form(min_length=3, max_length=5000)],
                            files: Annotated[list[UploadFile] | None, File()] = None) -> dict:
    o, p = _order(db, actor, order_id)
    if o.paid_at is not None or o.status not in (O.created, O.accepted):
        raise ApiError(409, "illegal_order_transition", "Исправление — до оплаты, пока заказ создан или принят")
    _ensure_mine(o, actor)
    after = _norm_lines(lines_after)
    comp = o.composition or {}
    before = comp.get("lines") or []
    delivery = int((comp.get("delivery") or {}).get("cost") or 0)
    total_before = flow.order_total(o)
    total_after = sum(l["total"] for l in after) + delivery
    stored = await flow.store_files(storage, files, f"suppliers/{actor.supplier_id}/orders/{o.id}/corrections",
                                    max_bytes=MAX_FILE)
    norm = lambda ls: [(l.get("key"), l.get("name"), float(l.get("qty") or 0), int(l.get("price") or 0)) for l in ls]
    changed = norm(before) != norm(after) or total_after != total_before
    c = OrderCorrection(order_id=o.id, author_id=actor.staff_uuid, comment=comment.strip(), lines_before=before,
                        lines_after=after, total_before=total_before, total_after=total_after, files=stored,
                        prev_status=o.status, status="pending" if changed else "applied")
    db.add(c)
    db.flush()
    data = {"correction_id": str(c.id), "total_before": total_before, "total_after": total_after,
            "needs_approval": changed}
    flow.event(db, o, "correction_created", **_actor_kw(actor), comment=comment[:500], data=data)
    if changed:
        flow.set_status(db, o, O.awaiting_approval, **_actor_kw(actor), comment=comment[:500], data=data,
                        push=False)
        from ..services import events

        events.order_correction(db, o, c)
    else:
        _log(db, actor, "order", o.id, "correction", workshop_id=p.workshop_id, after=data)
    db.commit()
    return _correction_out(db, c, settings)


# --- Возвраты и рекламации ---


def _return(db, actor: StaffActor, return_id: uuid.UUID) -> tuple[OrderReturn, Order, Project]:
    r = db.get(OrderReturn, return_id)
    if r is None:
        raise not_found("Возврат")
    o, p = _order(db, actor, r.order_id)
    return r, o, p


@router.get("/returns", summary="Возвраты поставщика (владелец — все, конструктор — по своим заказам)")
def list_returns(actor: Returns, db: DbDep, settings: SettingsDep,
                 status: Annotated[list[str] | None, Query()] = None) -> dict:
    stmt = select(OrderReturn, Order).join(Order, OrderReturn.order_id == Order.id) \
        .where(Order.supplier_id == actor.supplier_id)
    if not actor.can("vendor.orders.all"):
        stmt = stmt.where(Order.assignee_id == actor.staff_uuid)
    if status:
        stmt = stmt.where(OrderReturn.status.in_(status))
    return {"items": [{**flow.return_out(r, settings), "order_number": o.number}
                      for r, o in db.execute(stmt.order_by(OrderReturn.created_at.desc()).limit(500))]}


@router.post("/orders/{order_id}/returns", status_code=201, summary="Оформить возврат / рекламацию по оплаченному заказу")
async def open_return(order_id: uuid.UUID, actor: Returns, db: DbDep, storage: StorageDep, settings: SettingsDep,
                      type: Annotated[str, Form(description="defect | cut_error | shortage | cancel_after_pay | other")],
                      description: Annotated[str, Form(min_length=3, max_length=5000)],
                      amount: Annotated[int | None, Form(ge=0)] = None,
                      lines: Annotated[str | None, Form(description="JSON-список строк (необязательно)")] = None,
                      files: Annotated[list[UploadFile] | None, File()] = None) -> dict:
    o, p = _order(db, actor, order_id)
    from .orders import parse_lines

    parsed = parse_lines(lines)
    photos = await flow.store_files(storage, files, f"suppliers/{actor.supplier_id}/orders/{o.id}/returns")
    r = flow.open_return(db, o, opened_by_type="vendor", opened_by=actor.id, actor_name=actor.name, kind=type,
                         description=description, lines=parsed, amount=amount, photos=photos)
    _log(db, actor, "order_return", r.id, "create", workshop_id=p.workshop_id,
         after={"order_id": str(o.id), "type": type, "amount": amount})
    from ..services import events

    events.order_return(db, o, r)
    db.commit()
    return flow.return_out(r, settings)


class ReturnDecisionIn(BaseModel):
    decision: Literal["redo", "refund", "declined"]
    comment: str = Field(min_length=3, max_length=2000)
    refund_amount: int | None = Field(None, ge=0, description="Для refund — сумма к возврату (подтверждает владелец)")


@router.patch("/returns/{return_id}", summary="Решение по возврату: переделать, вернуть деньги, отказать")
def decide_return(return_id: uuid.UUID, body: ReturnDecisionIn, actor: Returns, db: DbDep,
                  settings: SettingsDep) -> dict:
    r, o, p = _return(db, actor, return_id)
    if r.status != "open":
        raise ApiError(409, "return_closed", "Решение по возврату уже принято")
    if body.decision == "refund":
        amount = body.refund_amount if body.refund_amount is not None else r.amount
        if not amount or amount > flow.order_total(o):
            raise ApiError(422, "invalid_refund", "Укажите сумму возврата (не больше суммы заказа)")
        flow.ensure_refund_fits(db, o, amount, exclude_return_id=r.id)
        r.refund_amount, r.status = amount, "awaiting_owner"
    else:
        r.status, r.resolved_at = "resolved", utcnow()
    r.decision, r.decision_comment, r.decided_by, r.decided_at = body.decision, body.comment.strip(), actor.id, utcnow()
    flow.event(db, o, "return_decided", **_actor_kw(actor), comment=body.comment[:500],
               data={"return_id": str(r.id), "decision": body.decision, "refund_amount": r.refund_amount})
    _log(db, actor, "order_return", r.id, "decide", workshop_id=p.workshop_id,
         after={"decision": body.decision, "refund_amount": r.refund_amount, "status": r.status})
    from ..services import events

    events.order_return(db, o, r)
    db.commit()
    return flow.return_out(r, settings)


class ApproveRefundIn(BaseModel):
    amount: int | None = Field(None, ge=0, description="Подтверждённая сумма; нет — как у конструктора")


@router.post("/returns/{return_id}/approve-refund", summary="Подтвердить сумму возврата (владелец) → сторно комиссии")
def approve_refund(return_id: uuid.UUID, actor: RefundsApprove, db: DbDep, settings: SettingsDep,
                   body: ApproveRefundIn | None = None) -> dict:
    r, o, p = _return(db, actor, return_id)
    if r.status != "awaiting_owner":
        raise ApiError(409, "return_not_awaiting", "Возврат не ждёт подтверждения")
    amount = body.amount if body and body.amount is not None else r.refund_amount
    if not amount or amount > flow.order_total(o):
        raise ApiError(422, "invalid_refund", "Сумма возврата — больше нуля и не больше суммы заказа")
    flow.ensure_refund_fits(db, o, amount, exclude_return_id=r.id)
    r.refund_amount, r.status, r.approved_by, r.resolved_at = amount, "resolved", actor.id, utcnow()
    reversed_ = flow.reverse_commission(db, o, amount)
    flow.event(db, o, "return_decided", **_actor_kw(actor), comment="Возврат денег подтверждён",
               data={"return_id": str(r.id), "decision": "refund", "refund_amount": amount, "stage": "refund_approved",
                     "commission_reversed": reversed_})
    _log(db, actor, "order_return", r.id, "approve_refund", workshop_id=p.workshop_id,
         after={"amount": amount, "commission_reversed": reversed_})
    from ..services import events

    events.order_return(db, o, r)
    db.commit()
    return flow.return_out(r, settings)


# --- Сводка ---


@router.get("/dashboard", summary="Счётчики: очередь, мои заказы, сообщения, возвраты, нестандарт, позиции без цены")
def dashboard(actor: AnyVendor, db: DbDep) -> dict:
    sid = actor.supplier_id
    out: dict[str, Any] = {"supplier_id": str(sid)}
    if actor.can("vendor.orders.work"):
        queue = db.execute(select(func.count(Order.id), func.min(Order.created_at)).where(
            Order.supplier_id == sid, Order.status == O.created, Order.assignee_id.is_(None))).one()
        visible = select(Order.id).where(Order.supplier_id == sid)
        if not actor.can("vendor.orders.all"):
            visible = visible.where(or_(Order.assignee_id == actor.staff_uuid,
                                        (Order.assignee_id.is_(None)) & (Order.status == O.created)))
        out.update(
            queue=queue[0], queue_oldest_hours=round((utcnow() - queue[1]).total_seconds() / 3600, 1)
            if queue[1] else None,
            mine=db.scalar(select(func.count(Order.id)).where(
                Order.supplier_id == sid, Order.assignee_id == actor.staff_uuid,
                Order.status.not_in([O.issued, O.cancelled, O.rejected]))) or 0,
            awaiting_payment=db.scalar(select(func.count(Order.id)).where(
                Order.supplier_id == sid, Order.status == O.accepted, Order.paid_at.is_(None))) or 0,
            in_production=db.scalar(select(func.count(Order.id)).where(
                Order.supplier_id == sid, Order.status.in_([O.paid, O.cutting, O.ready]))) or 0,
            unread_messages=flow.unread_for_vendor(db, visible),
        )
    if actor.can("vendor.returns"):
        out["returns_open"] = db.scalar(select(func.count(OrderReturn.id)).join(Order, OrderReturn.order_id == Order.id)
                                        .where(Order.supplier_id == sid, OrderReturn.status == "open")) or 0
    if actor.can("vendor.refunds.approve"):
        out["refunds_awaiting"] = db.scalar(select(func.count(OrderReturn.id)).join(
            Order, OrderReturn.order_id == Order.id).where(Order.supplier_id == sid,
                                                           OrderReturn.status == "awaiting_owner")) or 0
    if actor.can("vendor.nonstandard"):
        out["nonstandard"] = db.scalar(select(func.count(NonstandardRequest.id)).where(
            NonstandardRequest.supplier_id == sid, NonstandardRequest.status.in_(["sent", "in_work"]))) or 0
    if actor.can("vendor.quotes"):
        out["price_requests"] = db.scalar(select(func.count(PriceRequest.id)).join(
            Project, PriceRequest.project_id == Project.id).where(
            PriceRequest.supplier_id == sid, PriceRequest.status == "pending", Project.deleted_at.is_(None))) or 0
    if actor.can("vendor.prices"):
        out["price_review"] = db.scalar(select(func.count(ParserRun.id)).where(
            ParserRun.supplier_id == sid, ParserRun.status == "review")) or 0
    return out


# --- Нестандарт ---


def _ns(db, actor: StaffActor, request_id: uuid.UUID) -> tuple[NonstandardRequest, Project]:
    r = db.get(NonstandardRequest, request_id)
    if r is None or r.supplier_id != actor.supplier_id:
        raise not_found("Заявка")
    return r, db.get(Project, r.project_id)


def _ns_out(db, r: NonstandardRequest, p: Project | None) -> dict:
    from .nonstandard import out

    o = out(r, p)
    w = db.get(Workshop, r.workshop_id)
    o["files"] = [{**{k: f.get(k) for k in ("id", "name", "content_type", "size", "uploaded_at")},
                   "url": f"/vendor/nonstandard/{r.id}/files/{f['id']}"} for f in r.files or []]
    o["workshop_name"] = w.name if w else None
    o["assignee_id"] = str(r.assignee_staff_id) if r.assignee_staff_id else None
    return o


@router.get("/nonstandard", summary="Заявки «нестандарт» поставщика")
def nonstandard_list(actor: NonstandardV, db: DbDep, status: Annotated[list[str] | None, Query()] = None,
                     page: int = Query(1, ge=1), page_size: int = Query(PAGE_SIZE, ge=1, le=200)) -> dict:
    stmt = select(NonstandardRequest).where(NonstandardRequest.supplier_id == actor.supplier_id)
    if status:
        stmt = stmt.where(NonstandardRequest.status.in_(status))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    limit, offset = _page(page, page_size)
    rows = db.scalars(stmt.order_by(NonstandardRequest.created_at.desc()).limit(limit).offset(offset))
    return {"items": [_ns_out(db, r, db.get(Project, r.project_id)) for r in rows], "total": total, "page": page,
            "page_size": page_size}


@router.get("/nonstandard/{request_id}", summary="Заявка «нестандарт»: описание, фото, отличия, файлы")
def nonstandard_get(request_id: uuid.UUID, actor: NonstandardV, db: DbDep) -> dict:
    r, p = _ns(db, actor, request_id)
    photos = []
    if r.photo_ids:
        photos = [{"id": str(ph.id), "url": ph.url} for ph in db.scalars(
            select(ProjectPhoto).where(ProjectPhoto.id.in_([uuid.UUID(i) for i in r.photo_ids])))]
    return {**_ns_out(db, r, p), "photos": photos}


class NsPatch(BaseModel):
    price: int | None = Field(None, ge=0)
    term_days: int | None = Field(None, ge=0, le=365)
    status: Literal["sent", "estimated", "in_work", "done", "cancelled"] | None = None
    assignee_id: uuid.UUID | None = None
    comment: str | None = Field(None, max_length=2000, description="Комментарий конструктора мастеру")


@router.patch("/nonstandard/{request_id}", summary="Оценка (цена, срок), конструктор, статус, комментарий")
def nonstandard_patch(request_id: uuid.UUID, body: NsPatch, actor: NonstandardV, db: DbDep) -> dict:
    from .nonstandard import apply_patch

    r, p = _ns(db, actor, request_id)
    data = body.model_dump(exclude_unset=True)
    fields: dict[str, Any] = {}
    if "price" in data:
        fields["price"] = data["price"]
    if "term_days" in data:
        fields["lead_days"] = data["term_days"]
    if "comment" in data:
        fields["designer_comment"] = data["comment"]
    if "assignee_id" in data:
        sid = data["assignee_id"]
        if sid is None:
            r.assignee_staff_id, fields["assignee"] = None, None
        else:
            s = db.get(StaffUser, sid)
            if s is None or s.supplier_id != actor.supplier_id:
                raise not_found("Сотрудник")
            r.assignee_staff_id, fields["assignee"] = s.id, s.name
    apply_patch(db, r, fields, body.status, actor)
    db.commit()
    return _ns_out(db, r, p)


@router.post("/nonstandard/{request_id}/files", status_code=201, summary="Загрузить доработанный файл")
async def nonstandard_upload(request_id: uuid.UUID, actor: NonstandardV, db: DbDep, storage: StorageDep,
                             file: UploadFile = File(description="PDF, DXF, архив, до 50 МБ")) -> dict:
    from .nonstandard import store_file

    r, p = _ns(db, actor, request_id)
    await store_file(db, r, file, storage, actor)
    db.commit()
    return _ns_out(db, r, p)


@router.get("/nonstandard/{request_id}/files/{file_id}", summary="Скачать файл заявки",
            responses={200: {"content": {"application/octet-stream": {}}}})
def nonstandard_file(request_id: uuid.UUID, file_id: str, actor: NonstandardV, db: DbDep,
                     storage: StorageDep) -> Response:
    r, _ = _ns(db, actor, request_id)
    f = next((f for f in r.files or [] if f["id"] == file_id), None)
    if f is None:
        raise not_found("Файл")
    return _stored(storage, f)


# --- Позиции без цены (разовая цена) ---


@router.get("/price-requests", summary="Позиции без цены у поставщика")
def price_requests(actor: Quotes, db: DbDep, status: Annotated[list[str] | None, Query()] = None,
                   page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=500)) -> dict:
    from ..services import price_requests as prs

    stmt = select(PriceRequest, Project, Workshop).join(Project, PriceRequest.project_id == Project.id) \
        .join(Workshop, PriceRequest.workshop_id == Workshop.id) \
        .where(PriceRequest.supplier_id == actor.supplier_id, Project.deleted_at.is_(None))
    if status:
        stmt = stmt.where(PriceRequest.status.in_(status))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    limit, offset = _page(page, page_size)
    rows = db.execute(stmt.order_by(PriceRequest.created_at).limit(limit).offset(offset)).all()
    return {"items": [{**prs.out(r, p), "workshop_name": w.name} for r, p, w in rows], "total": total,
            "page": page, "page_size": page_size}


class QuoteIn(BaseModel):
    price: int = Field(gt=0, description="Цена за единицу, сумы")
    lead_days: int | None = Field(None, ge=0, le=365)
    note: str | None = Field(None, max_length=500)
    valid_until: datetime | None = None


@router.post("/price-requests/{request_id}/price", summary="Разовая цена для сметы (в каталог не пишется)")
def quote_price(request_id: uuid.UUID, body: QuoteIn, actor: Quotes, db: DbDep) -> dict:
    from ..services import price_requests as prs

    r = db.get(PriceRequest, request_id)
    if r is None or r.supplier_id != actor.supplier_id:
        raise not_found("Позиция")
    if body.valid_until is not None and body.valid_until.tzinfo is None:
        raise ApiError(422, "validation_error", "Укажите часовой пояс, например 2026-11-10T18:00:00+05:00")
    supplier = db.get(Supplier, actor.supplier_id)
    prs.set_price(db, r, price=body.price, lead_days=body.lead_days, supplier_name=supplier.name, note=body.note,
                  save_to_catalog=False, actor=actor.id, valid_until=body.valid_until, actor_type=actor.type)
    db.commit()
    return prs.out(r, db.get(Project, r.project_id))


# --- Каталог и прайс ---


def _item(db, actor: StaffActor, item_id: uuid.UUID) -> CatalogItem:
    i = db.get(CatalogItem, item_id)
    if i is None or i.supplier_id != actor.supplier_id:
        raise not_found("Позиция каталога")
    return i


@router.get("/catalog", summary="Каталог поставщика")
def catalog(actor: Prices, db: DbDep, q: str | None = None, type: str | None = None,
            available: bool | None = None, page: int = Query(1, ge=1),
            page_size: int = Query(100, ge=1, le=500)) -> dict:
    from .admin_catalog import item_out

    stmt = select(CatalogItem).where(CatalogItem.supplier_id == actor.supplier_id)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(CatalogItem.name).like(like), func.lower(CatalogItem.sku).like(like)))
    if type:
        stmt = stmt.where(CatalogItem.type == type)
    if available is not None:
        stmt = stmt.where(CatalogItem.available.is_(available))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    limit, offset = _page(page, page_size)
    rows = db.scalars(stmt.order_by(CatalogItem.type, CatalogItem.name).limit(limit).offset(offset))
    return {"items": [item_out(i) for i in rows], "total": total, "page": page, "page_size": page_size}


class ItemPatch(BaseModel):
    price: int | None = Field(None, gt=0)
    available: bool | None = None


@router.patch("/catalog/{item_id}", summary="Цена и наличие позиции (в историю цен и журнал)")
def patch_item(item_id: uuid.UUID, body: ItemPatch, actor: Prices, db: DbDep) -> dict:
    from .admin_catalog import item_out

    i = _item(db, actor, item_id)
    before = {"price": i.price, "available": i.available}
    now = utcnow()
    if body.price is not None and body.price != i.price:
        db.add(PriceHistory(item_id=i.id, old_price=i.price, new_price=body.price, source="vendor",
                            changed_by=actor.id))
        i.price, i.price_date, i.price_source = body.price, now, "vendor"
    if body.available is not None:
        i.available = body.available
    _log(db, actor, "catalog_item", i.id, "update", before=before, after={"price": i.price, "available": i.available})
    db.commit()
    return item_out(i)


@router.get("/catalog/{item_id}/history", summary="История цен позиции")
def item_history(item_id: uuid.UUID, actor: Prices, db: DbDep) -> list[dict]:
    i = _item(db, actor, item_id)
    return [{"id": str(h.id), "old_price": h.old_price, "new_price": h.new_price, "source": h.source,
             "changed_by": h.changed_by, "created_at": _iso(h.created_at)}
            for h in db.scalars(select(PriceHistory).where(PriceHistory.item_id == i.id)
                                .order_by(PriceHistory.created_at.desc()))]


@router.post("/catalog/import", status_code=201, summary="Загрузить прайс (CSV/XLSX: sku;name;price;available) → предпросмотр")
async def catalog_import(actor: Prices, db: DbDep,
                         file: UploadFile = File(description="CSV (; или ,), XLSX или JSON, до 10 МБ"),
                         hide_missing: bool = Form(False, description="Позиции, которых нет в файле, — «нет в наличии»")
                         ) -> dict:
    data = await file.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise ApiError(413, "file_too_large", "Файл больше 10 МБ")
    if not data:
        raise ApiError(422, "empty_file", "Файл пустой")
    supplier = db.get(Supplier, actor.supplier_id)
    run = price_import.create_import(db, supplier, data, file.filename or "prices.csv", actor.id,
                                     hide_missing=hide_missing)
    _log(db, actor, "parser_run", run.id, "vendor_import", after={"file": run.file_name, "status": run.status})
    db.commit()
    return price_import.preview_out(db, run)


def _run(db, actor: StaffActor, run_id: uuid.UUID) -> ParserRun:
    run = db.get(ParserRun, run_id)
    if run is None or run.supplier_id != actor.supplier_id:
        raise not_found("Загрузка")
    return run


@router.get("/catalog/import/{preview_id}", summary="Предпросмотр загрузки")
def catalog_import_preview(preview_id: uuid.UUID, actor: Prices, db: DbDep) -> dict:
    return price_import.preview_out(db, _run(db, actor, preview_id))


@router.post("/catalog/import/{preview_id}/confirm", summary="Применить загрузку: цены → каталог и история цен")
def catalog_import_confirm(preview_id: uuid.UUID, actor: Prices, db: DbDep) -> dict:
    run = _run(db, actor, preview_id)
    if run.source != "vendor_file":
        raise not_found("Загрузка")
    out = price_import.confirm_import(db, run, actor.id)
    db.commit()
    return {**price_import.preview_out(db, run), "published": out}


# --- Источник цен ---


@router.get("/price-source", summary="Источник цен: ссылка на файл или API (ключ не отдаётся)")
def price_source(actor: Prices, db: DbDep) -> dict:
    src = db.scalar(select(SupplierPriceSource).where(SupplierPriceSource.supplier_id == actor.supplier_id))
    return {"source": price_import.source_out(src)}


class PriceSourceIn(BaseModel):
    kind: Literal["file_url", "api"] = "file_url"
    url: str = Field(min_length=10, max_length=1000)
    format: Literal["csv", "xlsx", "json"] = "csv"
    mapping: dict[str, str] = Field(default_factory=dict, description="поле (sku, name, price, available…) → колонка")
    secret: str | None = Field(None, max_length=500, description="Ключ API; пусто — не менять; \"\" — удалить")
    schedule: Literal["off", "hourly", "daily"] = "daily"
    active: bool = True


@router.put("/price-source", summary="Подключить или изменить источник цен")
def put_price_source(body: PriceSourceIn, actor: Prices, db: DbDep) -> dict:
    price_import.check_public_https(body.url)
    allowed = {"sku", "name", "price", "available", "type", "unit"}
    if set(body.mapping) - allowed:
        raise ApiError(422, "invalid_mapping", f"Поля сопоставления: {', '.join(sorted(allowed))}")
    src = db.scalar(select(SupplierPriceSource).where(SupplierPriceSource.supplier_id == actor.supplier_id))
    if src is None:
        src = SupplierPriceSource(supplier_id=actor.supplier_id, url=body.url)
        db.add(src)
    src.kind, src.url, src.format, src.mapping = body.kind, body.url, body.format, body.mapping
    src.schedule, src.active = body.schedule, body.active
    if body.secret is not None:
        src.secret = body.secret or None
    db.flush()
    _log(db, actor, "price_source", src.id, "update",
         after={"kind": src.kind, "url": src.url, "schedule": src.schedule, "active": src.active,
                "secret_set": bool(src.secret)})
    db.commit()
    return {"source": price_import.source_out(src)}


def _source(db, actor) -> SupplierPriceSource:
    src = db.scalar(select(SupplierPriceSource).where(SupplierPriceSource.supplier_id == actor.supplier_id))
    if src is None:
        raise not_found("Источник цен")
    return src


def _run_out(db, run: ParserRun) -> dict:
    pending = [r for r in pipeline.records_of(db, run) if r.review_status == "pending" and r.published_at is None]
    stats = {k: v for k, v in (run.stats or {}).items() if k not in ("missing_ids", "missing_report")}
    return {"id": str(run.id), "source": run.source, "status": run.status, "file_name": run.file_name,
            "stats": stats, "error": run.error, "started_at": _iso(run.started_at),
            "published_at": _iso(run.published_at), "pending_review": len(pending),
            "big_changes": [{"record_id": str(r.id), "sku": r.sku, "name": r.name, "price": r.price,
                             "old_price": r.old_price, "change_pct": r.change_pct} for r in pending]}


@router.post("/price-source/run", status_code=201, summary="Обновить сейчас (в фоне; статус — в журнале запусков)")
def run_price_source(actor: Prices, db: DbDep, tasks: TasksDep) -> dict:
    """Загрузка идёт фоновой задачей: ответ — запуск в статусе `running`; итог (`review`, `published`, `failed`…) —
    в `GET /vendor/price-source/runs`. Пока идёт запуск, второй — `409 run_in_progress`."""
    src = _source(db, actor)
    run = price_import.start_source_run(db, src, actor.id)
    _log(db, actor, "price_source", src.id, "run", after={"run_id": str(run.id), "status": run.status})
    db.commit()
    tasks.enqueue("price_source_run", {"run_id": str(run.id), "source_id": str(src.id), "actor_id": actor.id})
    db.expire_all()  # очередь inline (тесты) уже всё сделала в своей сессии
    return _run_out(db, db.get(ParserRun, run.id))


@router.get("/price-source/runs", summary="Журнал запусков источника и загрузок файлом")
def price_source_runs(actor: Prices, db: DbDep, limit: int = Query(50, ge=1, le=200)) -> list[dict]:
    rows = db.scalars(select(ParserRun).where(ParserRun.supplier_id == actor.supplier_id,
                                              ParserRun.source.in_(["price_source", "vendor_file"]))
                      .order_by(ParserRun.started_at.desc()).limit(limit))
    return [_run_out(db, r) for r in rows]


@router.post("/price-source/runs/{run_id}/confirm", summary="Подтвердить изменения > 15% (владелец)")
def confirm_price_source_run(run_id: uuid.UUID, actor: Prices, db: DbDep) -> dict:
    run = _run(db, actor, run_id)
    if run.source != "price_source":
        raise not_found("Запуск")
    if not price_import.approve_pending(db, run, actor.id):
        raise ApiError(409, "nothing_to_confirm", "Нет изменений, ждущих подтверждения")
    out = pipeline.publish(db, run, actor.id, actor_type=actor.type)
    if out.get("updated"):
        from ..services import events

        events.prices_published(db)
    db.commit()
    return {**_run_out(db, run), "published": out}


# --- Деньги и сводка ---


@router.get("/finance", summary="Взаиморасчёты с платформой за период")
def vendor_finance(actor: FinanceV, db: DbDep, from_: Annotated[str | None, Query(alias="from")] = None,
                   to: str | None = None) -> dict:
    start, end = finance.period(from_, to)
    from ..models import SupplierSettlement

    supplier = db.get(Supplier, actor.supplier_id)
    out = finance.supplier_finance(db, supplier, start, end)
    out["settlements"] = [finance.settlement_out(x) for x in db.scalars(
        select(SupplierSettlement).where(SupplierSettlement.supplier_id == supplier.id)
        .order_by(SupplierSettlement.paid_at.desc()).limit(100))]
    return out


@router.get("/finance/act.csv", summary="Акт сверки (CSV)", responses={200: {"content": {"text/csv": {}}}})
def vendor_act(actor: FinanceV, db: DbDep, from_: Annotated[str | None, Query(alias="from")] = None,
               to: str | None = None) -> Response:
    start, end = finance.period(from_, to)
    supplier = db.get(Supplier, actor.supplier_id)
    return Response(content=finance.act_csv(db, supplier, start, end), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="act_{supplier.code}_'
                                                    f'{start.date().isoformat()}.csv"'})


@router.get("/analytics", summary="Сводка владельца: заказы, оборот, цеха, очередь, работа конструкторов")
def analytics(actor: Analytics, db: DbDep, from_: Annotated[str | None, Query(alias="from")] = None,
              to: str | None = None) -> dict:
    start, end = finance.period(from_, to)
    sid = actor.supplier_id
    orders = list(db.scalars(select(Order).where(Order.supplier_id == sid, Order.created_at >= start,
                                                 Order.created_at < end)))
    by_status: dict[str, int] = {}
    by_day: dict[str, int] = {}
    for o in orders:
        by_status[o.status] = by_status.get(o.status, 0) + 1
        day = o.created_at.astimezone(finance.TZ).date().isoformat()
        by_day[day] = by_day.get(day, 0) + 1
    paid = list(db.execute(select(Order, Workshop).join(Project, Order.project_id == Project.id)
                           .join(Workshop, Project.workshop_id == Workshop.id)
                           .where(Order.supplier_id == sid, Order.paid_at >= start, Order.paid_at < end)).all())
    top: dict[uuid.UUID, dict] = {}
    for o, w in paid:
        t = top.setdefault(w.id, {"workshop_id": str(w.id), "name": w.name, "orders": 0, "turnover": 0})
        t["orders"] += 1
        t["turnover"] += flow.order_total(o)
    queue = list(db.scalars(select(Order).where(Order.supplier_id == sid, Order.status == O.created,
                                                Order.assignee_id.is_(None))))
    now = utcnow()
    designers = []
    for s in db.scalars(select(StaffUser).where(StaffUser.supplier_id == sid).order_by(StaffUser.name)):
        mine = [o for o in orders if o.assignee_id == s.id]
        events_ = list(db.scalars(select(OrderEvent).where(OrderEvent.actor_id == str(s.id), OrderEvent.kind == "status_changed",
                                                           OrderEvent.created_at >= start, OrderEvent.created_at < end)))
        to_accept = [o.accepted_at - o.created_at for o in mine if o.accepted_at]
        ready_at = {e.order_id: e.created_at for e in events_ if e.to_status == O.ready}
        to_ready = [ready_at[o.id] - o.created_at for o in mine if o.id in ready_at]
        designers.append({
            "id": str(s.id), "name": s.name, "role": s.role, "is_active": s.is_active,
            "accepted": sum(e.to_status == O.accepted for e in events_),
            "returned": sum(e.to_status == O.returned for e in events_),
            "rejected": sum(e.to_status == O.rejected for e in events_),
            "avg_hours_to_accept": finance._avg_hours(to_accept), "avg_hours_to_ready": finance._avg_hours(to_ready),
            "open_orders": db.scalar(select(func.count(Order.id)).where(
                Order.supplier_id == sid, Order.assignee_id == s.id,
                Order.status.not_in([O.issued, O.cancelled, O.rejected]))) or 0,
        })
    return {
        "from": start.isoformat(), "to": end.isoformat(),
        "orders": {"total": len(orders), "by_status": by_status,
                   "by_day": [{"date": d, "count": c} for d, c in sorted(by_day.items())]},
        "turnover": sum(flow.order_total(o) for o, _ in paid), "paid_orders": len(paid),
        "top_workshops": sorted(top.values(), key=lambda x: -x["turnover"])[:10],
        "queue": {"count": len(queue), "oldest_hours": round(max((now - o.created_at).total_seconds()
                                                                 for o in queue) / 3600, 1) if queue else None},
        "designers": designers,
    }


SETTINGS_KEYS = {"legal_name", "inn", "bank", "account", "mfo", "contract_number", "contract_date", "contacts",
                 "phone", "email", "warehouse_address", "pickup_address", "default_lead_days", "payment_url",
                 "payment_text"}


@router.get("/settings", summary="Настройки организации: реквизиты, склад, срок производства, оплата")
def get_settings(actor: SettingsV, db: DbDep) -> dict:
    s = db.get(Supplier, actor.supplier_id)
    return {"id": str(s.id), "code": s.code, "name": s.name, "site_url": s.site_url, "settings": s.settings or {},
            "commission_percent": s.commission_bp / 100}


class VendorSettingsIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    site_url: str | None = Field(None, max_length=300)
    settings: dict[str, Any] | None = None


@router.patch("/settings", summary="Изменить настройки организации")
def patch_settings(body: VendorSettingsIn, actor: SettingsV, db: DbDep) -> dict:
    s = db.get(Supplier, actor.supplier_id)
    before = {"name": s.name, "site_url": s.site_url, "settings": s.settings or {}}
    if body.settings is not None:
        unknown = set(body.settings) - SETTINGS_KEYS
        if unknown:
            raise ApiError(422, "unknown_setting", f"Неизвестные поля: {', '.join(sorted(unknown))}")
        if "default_lead_days" in body.settings:
            v = body.settings["default_lead_days"]
            if v is not None and (not isinstance(v, int) or not 0 <= v <= 365):
                raise ApiError(422, "invalid_setting", "Срок производства — целое число дней 0–365")
        for k, v in body.settings.items():
            if isinstance(v, str) and len(v) > 1000:
                raise ApiError(422, "invalid_setting", f"Слишком длинное значение: {k}")
        s.settings = {**(s.settings or {}), **body.settings}
    if body.name is not None:
        s.name = body.name.strip()
    if body.site_url is not None:
        s.site_url = body.site_url or None
    _log(db, actor, "supplier", s.id, "vendor_settings", before=before,
         after={"name": s.name, "site_url": s.site_url, "settings": s.settings})
    db.commit()
    return get_settings(actor, db)
