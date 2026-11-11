"""Суперадмин платформы (docs/staff_vendor_contract.md §4, §4a): маршруты и показатели поставщиков, комиссия,
блокировка, взаиморасчёты и выплаты, споры, вмешательство в заказ и переписка от имени платформы,
просмотр «глазами мастера», лимиты и режим обслуживания, рассылки, журнал действий (только чтение).

Опасные действия требуют `reason` (без него — 422; старый X-Admin-Token — переходный период, без проверки).
"""

import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

import jwt
from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from ..db import utcnow
from ..deps import (
    AuditDep,
    BroadcastsDep,
    DbDep,
    DisputesDep,
    FinanceDep,
    ImpersonateDep,
    OrdersDep,
    SettingsAdminDep,
    SettingsDep,
    StaffActor,
    StorageDep,
    SuppliersDep,
    SuppliersReadDep,
    TariffsDep,
    require_reason,
)
from ..domain import OrderStatus as O
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import (
    ActionLog,
    Order,
    OrderCorrection,
    OrderDispute,
    OrderEvent,
    OrderMessage,
    OrderReturn,
    Payment,
    Project,
    StaffUser,
    Supplier,
    SupplierCommission,
    SupplierRoute,
    SupplierSettlement,
    User,
    Workshop,
)
from ..services import finance, order_flow as flow
from ..services.action_log import log_action, staff_names
from ..services.app_settings import KNOWN, LIMIT_KEYS, SWITCH_KEYS, all_settings, coerce, set_setting
from ..services.supplier_routes import CATEGORIES, default_supplier

router = APIRouter(prefix="/admin", tags=["admin"], responses=ERROR_RESPONSES)


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _supplier(db, supplier_id: uuid.UUID) -> Supplier:
    s = db.get(Supplier, supplier_id)
    if s is None:
        raise not_found("Поставщик")
    return s


def _log(db, actor: StaffActor, entity: str, entity_id, action: str, *, before=None, after=None, workshop_id=None):
    log_action(db, actor_type=actor.type, actor_id=actor.id, workshop_id=workshop_id, entity=entity,
               entity_id=entity_id, action=action, before=before, after=after)


# --- Маршруты категорий (§4) ---


def _routes_out(db) -> dict:
    d = default_supplier(db)
    rows = db.execute(select(SupplierRoute, Supplier).join(Supplier, SupplierRoute.supplier_id == Supplier.id)
                      .order_by(SupplierRoute.category)).all()
    return {"routes": [{"category": r.category, "supplier_id": str(s.id), "supplier_code": s.code,
                        "supplier_name": s.name, "supplier_active": s.active, "active": r.active} for r, s in rows],
            "categories": CATEGORIES,
            "default_supplier": {"id": str(d.id), "code": d.code, "name": d.name, "active": d.active}}


@router.get("/supplier-routes", summary="Маршруты: категория строки заказа → поставщик")
def get_routes(admin: SuppliersReadDep, db: DbDep) -> dict:
    out = _routes_out(db)
    db.commit()  # поставщик по умолчанию мог быть создан
    return out


class RouteIn(BaseModel):
    category: str = Field(min_length=2, max_length=40, pattern=r"^[a-z_]+$")
    supplier_id: uuid.UUID
    active: bool = True


class RoutesIn(BaseModel):
    routes: list[RouteIn] = Field(max_length=100)


@router.put("/supplier-routes", summary="Заменить маршруты целиком (нет маршрута — поставщик по умолчанию)")
def put_routes(body: RoutesIn, admin: SuppliersDep, db: DbDep) -> dict:
    cats = [r.category for r in body.routes]
    if len(cats) != len(set(cats)):
        raise ApiError(422, "duplicate_category", "Категория указана дважды")
    for r in body.routes:
        _supplier(db, r.supplier_id)
    before = {r.category: str(r.supplier_id) for r in db.scalars(select(SupplierRoute))}
    for r in list(db.scalars(select(SupplierRoute))):
        db.delete(r)
    db.flush()
    for r in body.routes:
        db.add(SupplierRoute(category=r.category, supplier_id=r.supplier_id, active=r.active))
    _log(db, admin, "supplier_routes", None, "update", before={"routes": before},
         after={"routes": {r.category: str(r.supplier_id) for r in body.routes}})
    db.commit()
    return _routes_out(db)


# --- Поставщик: карточка, блокировка, комиссия, выплаты, первый владелец ---


def _commission_out(c: SupplierCommission) -> dict:
    return {"id": str(c.id), "category": c.category, "rate_percent": c.rate_bp / 100, "rate_bp": c.rate_bp,
            "effective_from": _iso(c.effective_from), "reason": c.reason, "created_at": _iso(c.created_at)}


@router.get("/suppliers/{supplier_id}", summary="Поставщик: реквизиты, комиссия, маршруты, сотрудники, показатели")
def supplier_card(supplier_id: uuid.UUID, admin: SuppliersReadDep, db: DbDep, settings: SettingsDep) -> dict:
    from .admin_catalog import supplier_out

    s = _supplier(db, supplier_id)
    overdue = int(all_settings(db, settings).get("vendor_overdue_hours") or 24)
    return {
        **supplier_out(s), "settings": s.settings or {}, "blocked_reason": s.blocked_reason,
        "commissions": [_commission_out(c) for c in db.scalars(
            select(SupplierCommission).where(SupplierCommission.supplier_id == s.id)
            .order_by(SupplierCommission.effective_from.desc()))],
        "routes": [r.category for r in db.scalars(select(SupplierRoute).where(SupplierRoute.supplier_id == s.id))],
        "staff": [{"id": str(u.id), "name": u.name, "email": u.email, "role": u.role, "is_active": u.is_active}
                  for u in db.scalars(select(StaffUser).where(StaffUser.supplier_id == s.id)
                                      .order_by(StaffUser.created_at))],
        "metrics": finance.supplier_metrics(db, s, overdue),
    }


class BlockIn(BaseModel):
    blocked: bool
    reason: str | None = Field(None, max_length=500)


@router.post("/suppliers/{supplier_id}/block", summary="Заблокировать / разблокировать поставщика (с причиной)")
def block_supplier(supplier_id: uuid.UUID, body: BlockIn, admin: SuppliersDep, db: DbDep) -> dict:
    """Заблокированному поставщику новые заказы не уходят: маршрут → поставщик по умолчанию, иначе — очередь
    платформы (supplier_id = null). Его сотрудники не входят в кабинет."""
    reason = require_reason(admin, body.reason)
    s = _supplier(db, supplier_id)
    before = {"active": s.active}
    s.active = not body.blocked
    s.blocked_reason = reason if body.blocked else None
    _log(db, admin, "supplier", s.id, "block" if body.blocked else "unblock", before=before,
         after={"active": s.active, "reason": reason})
    db.commit()
    return {"id": str(s.id), "active": s.active, "blocked_reason": s.blocked_reason}


class CommissionIn(BaseModel):
    rate_percent: float = Field(ge=0, le=100)
    category: str | None = Field(None, max_length=40, description="Нет — общая ставка")
    effective_from: datetime | None = Field(None, description="С какого момента; нет — сейчас")
    reason: str | None = Field(None, max_length=500)


@router.get("/suppliers/{supplier_id}/commission", summary="Ставки комиссии (история)")
def get_commission(supplier_id: uuid.UUID, admin: SuppliersReadDep, db: DbDep) -> dict:
    s = _supplier(db, supplier_id)
    return {"default_percent": s.commission_bp / 100, "items": [_commission_out(c) for c in db.scalars(
        select(SupplierCommission).where(SupplierCommission.supplier_id == s.id)
        .order_by(SupplierCommission.effective_from.desc()))]}


@router.post("/suppliers/{supplier_id}/commission", status_code=201,
             summary="Новая ставка комиссии с даты (старые заказы — по старой ставке)")
def add_commission(supplier_id: uuid.UUID, body: CommissionIn, admin: SuppliersDep, db: DbDep) -> dict:
    reason = require_reason(admin, body.reason)
    s = _supplier(db, supplier_id)
    if body.effective_from is not None and body.effective_from.tzinfo is None:
        raise ApiError(422, "validation_error", "Укажите часовой пояс даты начала")
    c = SupplierCommission(supplier_id=s.id, category=body.category, rate_bp=round(body.rate_percent * 100),
                           effective_from=body.effective_from or utcnow(), reason=reason, created_by=admin.id)
    db.add(c)
    if body.category is None and c.effective_from <= utcnow():  # общая ставка уже действует — она и есть ставка
        s.commission_bp = c.rate_bp                             # по умолчанию (список, карточка, кабинет)
    db.flush()
    _log(db, admin, "supplier_commission", c.id, "create", after={**_commission_out(c), "supplier_id": str(s.id)})
    db.commit()
    return _commission_out(c)


class SettlementIn(BaseModel):
    amount: int = Field(gt=0, description="Сумма выплаты поставщика платформе, сумы")
    paid_at: datetime | None = None
    period_from: datetime | None = None
    period_to: datetime | None = None
    comment: str | None = Field(None, max_length=1000)


@router.get("/suppliers/{supplier_id}/settlements", summary="Выплаты поставщика платформе")
def settlements(supplier_id: uuid.UUID, admin: FinanceDep, db: DbDep) -> list[dict]:
    s = _supplier(db, supplier_id)
    return [finance.settlement_out(x) for x in db.scalars(
        select(SupplierSettlement).where(SupplierSettlement.supplier_id == s.id)
        .order_by(SupplierSettlement.paid_at.desc()))]


@router.post("/suppliers/{supplier_id}/settlements", status_code=201, summary="Внести выплату поставщика")
def add_settlement(supplier_id: uuid.UUID, body: SettlementIn, admin: FinanceDep, db: DbDep) -> dict:
    s = _supplier(db, supplier_id)
    for v in (body.paid_at, body.period_from, body.period_to):
        if v is not None and v.tzinfo is None:
            raise ApiError(422, "validation_error", "Укажите часовой пояс дат")
    x = SupplierSettlement(supplier_id=s.id, amount=body.amount, paid_at=body.paid_at or utcnow(),
                           period_from=body.period_from, period_to=body.period_to, comment=body.comment,
                           created_by=admin.id)
    db.add(x)
    db.flush()
    _log(db, admin, "supplier_settlement", x.id, "create", after={"supplier_id": str(s.id), "amount": x.amount})
    db.commit()
    return finance.settlement_out(x)


class OwnerIn(BaseModel):
    email: str = Field(max_length=254)
    name: str = Field(min_length=1, max_length=200)


@router.post("/suppliers/{supplier_id}/owner", status_code=201,
             summary="Создать владельца поставщика (vendor_owner) → временный пароль")
def add_owner(supplier_id: uuid.UUID, body: OwnerIn, admin: SuppliersDep, db: DbDep) -> dict:
    from .staff import create_staff, user_out

    s = _supplier(db, supplier_id)
    u, password = create_staff(db, admin.id, email=body.email, name=body.name, role="vendor_owner",
                               supplier_id=s.id)
    db.commit()
    return {"user": user_out(db, u), "temp_password": password}


# --- Взаиморасчёты (ADM-10) ---


@router.get("/finance", summary="Взаиморасчёты: по каждому поставщику и платежи мастеров платформе")
def admin_finance(admin: FinanceDep, db: DbDep, from_: Annotated[str | None, Query(alias="from")] = None,
                  to: str | None = None, supplier_id: uuid.UUID | None = None) -> dict:
    start, end = finance.period(from_, to)
    stmt = select(Supplier).order_by(Supplier.created_at)
    if supplier_id:
        stmt = stmt.where(Supplier.id == supplier_id)
    rows = [finance.supplier_finance(db, s, start, end) for s in db.scalars(stmt)]
    pay = db.execute(select(Payment.kind, Payment.status, func.count(Payment.id), func.coalesce(func.sum(Payment.amount), 0))
                     .where(Payment.paid_at >= start, Payment.paid_at < end)
                     .group_by(Payment.kind, Payment.status)).all()
    by_kind: dict[str, dict] = {}
    for kind, status, n, amount in pay:
        k = by_kind.setdefault(kind, {"count": 0, "amount": 0, "refunded": 0})
        k["count"] += n
        k["amount"] += amount
        if status == "refunded":
            k["refunded"] += amount
    return {
        "from": start.isoformat(), "to": end.isoformat(), "suppliers": rows,
        "totals": {"turnover": sum(r["turnover"] for r in rows),
                   "commission_accrued": sum(r["commission"]["accrued"] for r in rows),
                   "commission_reversed": sum(r["commission"]["reversed"] for r in rows),
                   "settled": sum(r["settled"] for r in rows), "debt": sum(r["debt"] for r in rows)},
        "platform_payments": {"by_kind": by_kind,
                              "total": sum(v["amount"] - v["refunded"] for v in by_kind.values())},
    }


@router.get("/finance/act.csv", summary="Акт сверки поставщика (CSV)", responses={200: {"content": {"text/csv": {}}}})
def admin_act(admin: FinanceDep, db: DbDep, supplier_id: uuid.UUID,
              from_: Annotated[str | None, Query(alias="from")] = None, to: str | None = None) -> Response:
    s = _supplier(db, supplier_id)
    start, end = finance.period(from_, to)
    return Response(content=finance.act_csv(db, s, start, end), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="act_{s.code}_{start.date().isoformat()}.csv"'})


# --- Споры ---


def _dispute_full(db, d: OrderDispute, settings) -> dict:
    o = db.get(Order, d.order_id)
    p = db.get(Project, o.project_id) if o else None
    w = db.get(Workshop, p.workshop_id) if p else None
    s = db.get(Supplier, o.supplier_id) if o and o.supplier_id else None
    ret = db.get(OrderReturn, d.return_id) if d.return_id else None
    return {**flow.dispute_out(d, settings), "order_number": o.number if o else None, "order_status": o.status if o else None,
            "order_total": flow.order_total(o) if o else None, "reject_reason": o.reject_reason if o else None,
            "workshop_name": w.name if w else None, "supplier_name": s.name if s else None,
            "return": flow.return_out(ret, settings) if ret and o else None}


@router.get("/disputes", summary="Очередь споров (open — старые сверху; resolved/all — новые сверху)")
def disputes(admin: DisputesDep, db: DbDep, settings: SettingsDep,
             status: Literal["open", "resolved", "all"] | None = "open",
             supplier_id: uuid.UUID | None = None, subject: Literal["return", "rejection"] | None = None,
             workshop_id: uuid.UUID | None = None, q: str | None = None) -> dict:
    stmt = select(OrderDispute).join(Order, OrderDispute.order_id == Order.id).join(
        Project, Order.project_id == Project.id).join(Workshop, Project.workshop_id == Workshop.id)
    if status and status != "all":
        stmt = stmt.where(OrderDispute.status == status)
    if supplier_id:
        stmt = stmt.where(Order.supplier_id == supplier_id)
    if subject:
        stmt = stmt.where(OrderDispute.subject == subject)
    if workshop_id:
        stmt = stmt.where(Project.workshop_id == workshop_id)
    if q and q.strip():
        digits = "".join(ch for ch in q if ch.isdigit())
        conds = [func.lower(Workshop.name).like(f"%{q.strip().lower()}%")]
        if digits and len(digits) <= 9:
            conds.append(Order.number == int(digits))
        stmt = stmt.where(or_(*conds))
    order = OrderDispute.created_at.asc() if status == "open" else OrderDispute.created_at.desc()
    counts = dict(db.execute(select(OrderDispute.status, func.count(OrderDispute.id))
                             .group_by(OrderDispute.status)).all())
    return {"items": [_dispute_full(db, d, settings) for d in db.scalars(stmt.order_by(order).limit(500))],
            "counts": {"open": counts.get("open", 0), "resolved": counts.get("resolved", 0),
                       "all": sum(counts.values())}}


@router.get("/disputes/{dispute_id}", summary="Спор: заказ, возврат, переписка, предел возврата")
def dispute(dispute_id: uuid.UUID, admin: DisputesDep, db: DbDep, settings: SettingsDep) -> dict:
    d = db.get(OrderDispute, dispute_id)
    if d is None:
        raise not_found("Спор")
    msgs = db.scalars(select(OrderMessage).where(OrderMessage.order_id == d.order_id).order_by(OrderMessage.created_at))
    o = db.get(Order, d.order_id)
    committed = flow.refunds_committed(db, o, exclude_dispute_id=d.id) if o else 0
    total = flow.order_total(o) if o else 0
    return {**_dispute_full(db, d, settings), "messages": [flow.message_out(m, settings) for m in msgs],
            # Решение с возвратом — не больше max_refund (сумма заказа минус уже обещанные возвраты), иначе 422
            "refunds_committed": committed, "max_refund": max(total - committed, 0),
            "order_paid_at": _iso(o.paid_at) if o else None,
            "commission": {"accrued": o.commission_amount, "reversed": o.commission_reversed or 0} if o else None}


class ResolveIn(BaseModel):
    resolution: Literal["master", "supplier", "partial"]
    refund_amount: int | None = Field(None, ge=0, description="Возврат мастеру за счёт поставщика (master/partial)")
    comment: str = Field(min_length=3, max_length=2000, description="Решение — видят обе стороны")
    reason: str | None = Field(None, max_length=500, description="Причина для журнала — обязательна (отдельно от comment)")


@router.post("/disputes/{dispute_id}/resolve", summary="Решить спор (с причиной) → комиссия пересчитывается")
def resolve_dispute(dispute_id: uuid.UUID, body: ResolveIn, admin: DisputesDep, db: DbDep,
                    settings: SettingsDep) -> dict:
    reason = require_reason(admin, body.reason)  # comment — решение для сторон, причиной не считается
    d = db.get(OrderDispute, dispute_id)
    if d is None:
        raise not_found("Спор")
    if d.status != "open":
        raise ApiError(409, "dispute_closed", "Спор уже решён")
    o = db.get(Order, d.order_id)
    refund = body.refund_amount if body.resolution != "supplier" else None
    if refund is not None and refund > flow.order_total(o):
        raise ApiError(422, "invalid_refund", "Сумма больше суммы заказа")
    if refund:
        flow.ensure_refund_fits(db, o, refund, exclude_dispute_id=d.id)
    d.status, d.resolution, d.refund_amount = "resolved", body.resolution, refund
    d.decision_comment = body.comment.strip()
    d.resolved_by, d.resolved_at = admin.id, utcnow()
    reversed_ = flow.reverse_commission(db, o, refund) if refund else 0
    flow.event(db, o, "dispute_resolved", actor_type="platform", actor_id=admin.id, actor_name="Платформа",
               comment=body.comment[:500], data={"dispute_id": str(d.id), "resolution": body.resolution,
                                                 "refund_amount": refund, "commission_reversed": reversed_})
    p = db.get(Project, o.project_id)
    _log(db, admin, "order_dispute", d.id, "resolve", workshop_id=p.workshop_id if p else None,
         after={"resolution": body.resolution, "refund_amount": refund, "reason": reason,
                "commission_reversed": reversed_})
    from ..services import events

    events.order_dispute(db, o, d)
    db.commit()
    return _dispute_full(db, d, settings)


# --- Заказы: переписка от имени платформы, вмешательство, лента ---


def _order(db, order_id: uuid.UUID) -> Order:
    o = db.get(Order, order_id)
    if o is None:
        raise not_found("Заказ")
    return o


@router.get("/orders/{order_id}/messages", summary="Переписка мастера и поставщика по заказу")
def order_messages(order_id: uuid.UUID, admin: OrdersDep, db: DbDep, settings: SettingsDep) -> dict:
    o = _order(db, order_id)
    rows = db.scalars(select(OrderMessage).where(OrderMessage.order_id == o.id).order_by(OrderMessage.created_at))
    return {"items": [flow.message_out(m, settings) for m in rows]}


@router.post("/orders/{order_id}/messages", status_code=201, summary="Сообщение от имени платформы (видят оба)")
async def post_order_message(order_id: uuid.UUID, admin: OrdersDep, db: DbDep, storage: StorageDep,
                             settings: SettingsDep,
                             text: Annotated[str, Form(max_length=5000)] = "",
                             files: Annotated[list[UploadFile] | None, File()] = None) -> dict:
    o = _order(db, order_id)
    attachments = await flow.store_files(storage, files, f"platform/orders/{o.id}/messages")
    m = flow.post_message(db, o, author_type="platform", author_id=admin.id, author_name="Платформа Eskiz AI",
                          text=text, attachments=attachments)
    _log(db, admin, "order", o.id, "platform_message", after={"message_id": str(m.id)})
    db.commit()
    return flow.message_out(m, settings)


@router.get("/orders/{order_id}/timeline", summary="История заказа, исправления, возвраты, споры")
def order_timeline(order_id: uuid.UUID, admin: OrdersDep, db: DbDep, settings: SettingsDep) -> dict:
    from .orders import correction_out

    o = _order(db, order_id)
    return {
        "events": [flow.event_out(e) for e in db.scalars(select(OrderEvent).where(OrderEvent.order_id == o.id)
                                                         .order_by(OrderEvent.created_at))],
        "corrections": [correction_out(db, c, settings) for c in db.scalars(
            select(OrderCorrection).where(OrderCorrection.order_id == o.id))],
        "returns": flow.returns_of(db, o, settings),
        "disputes": [flow.dispute_out(d, settings) for d in db.scalars(
            select(OrderDispute).where(OrderDispute.order_id == o.id))],
    }


class InterveneIn(BaseModel):
    action: Literal["change_supplier", "set_status", "cancel"]
    reason: str | None = Field(None, max_length=500)
    supplier_id: uuid.UUID | None = None
    status: O | None = None
    comment: str | None = Field(None, max_length=2000)


@router.post("/orders/{order_id}/intervene", summary="Вмешательство платформы: сменить поставщика, статус, отменить")
def intervene(order_id: uuid.UUID, body: InterveneIn, admin: OrdersDep, db: DbDep) -> dict:
    from .admin_panel import _order_brief

    reason = require_reason(admin, body.reason)
    o = _order(db, order_id)
    kw = {"actor_type": "platform", "actor_id": admin.id, "actor_name": "Платформа"}
    if body.action == "change_supplier":
        if body.supplier_id is None:
            raise ApiError(422, "supplier_required", "Укажите supplier_id")
        s = _supplier(db, body.supplier_id)
        if not s.active:
            raise ApiError(409, "supplier_blocked", "Поставщик заблокирован")
        if o.paid_at is not None:
            raise ApiError(409, "order_paid", "Оплаченный заказ к другому поставщику не переносится")
        before = str(o.supplier_id) if o.supplier_id else None
        o.supplier_id, o.supplier, o.assignee_id = s.id, s.code, None
        flow.event(db, o, "change_supplier", **kw, comment=reason, data={"from": before, "to": str(s.id)})
        _log(db, admin, "order", o.id, "change_supplier", before={"supplier_id": before},
             after={"supplier_id": str(s.id), "reason": reason})
    elif body.action == "set_status":
        if body.status is None:
            raise ApiError(422, "status_required", "Укажите status")
        if body.status == O.paid and o.paid_at is None:
            flow.mark_paid(db, o, **kw, comment=reason)
        else:
            if body.status == O.cancelled and o.paid_at is not None:
                flow.reverse_commission(db, o)
            flow.set_status(db, o, body.status, **kw, comment=reason)
    else:
        if o.status in (O.cancelled, O.issued):
            raise ApiError(409, "order_closed", "Заказ уже закрыт")
        if o.paid_at is not None:
            flow.reverse_commission(db, o)
        flow.set_status(db, o, O.cancelled, **kw, comment=reason)
    if body.comment:
        flow.post_message(db, o, author_type="platform", author_id=admin.id, author_name="Платформа Eskiz AI",
                          text=body.comment, attachments=[])
    db.commit()
    return _order_brief(db, o)


# --- «Глазами мастера» (только чтение) ---


class ImpersonateIn(BaseModel):
    reason: str | None = Field(None, max_length=500)
    user_id: uuid.UUID | None = Field(None, description="Сотрудник цеха; нет — владелец")


@router.post("/workshops/{workshop_id}/impersonate", summary="Просмотр «глазами мастера»: короткий токен только на чтение")
def impersonate(workshop_id: uuid.UUID, body: ImpersonateIn, admin: ImpersonateDep, db: DbDep,
                settings: SettingsDep) -> dict:
    reason = require_reason(admin, body.reason)
    w = db.get(Workshop, workshop_id)
    if w is None:
        raise not_found("Цех")
    stmt = select(User).where(User.workshop_id == w.id, User.is_active.is_(True))
    stmt = stmt.where(User.id == body.user_id) if body.user_id else stmt.where(User.role == "owner")
    u = db.scalar(stmt.limit(1))
    if u is None:
        raise not_found("Мастер")
    now = utcnow()
    ttl = settings.impersonation_ttl_minutes
    token = jwt.encode({"sub": str(u.id), "wid": str(w.id), "role": u.role, "typ": "access", "imp": admin.id,
                        "ro": True, "iat": int(now.timestamp()), "exp": int((now + timedelta(minutes=ttl)).timestamp())},
                       settings.jwt_secret, algorithm=settings.jwt_algorithm)
    _log(db, admin, "impersonation", w.id, "start", workshop_id=w.id, after={"user_id": str(u.id), "reason": reason})
    db.commit()
    return {"access_token": token, "token_type": "bearer", "expires_in": ttl * 60, "read_only": True,
            "user_id": str(u.id), "workshop_id": str(w.id),
            "expires_at": (now + timedelta(minutes=ttl)).isoformat(), "user_name": u.name, "user_phone": u.phone,
            "user_role": u.role, "workshop_name": w.name}


# --- Лимиты и режим обслуживания (ADM-12) ---


def _values(db, settings, keys) -> dict:
    v = all_settings(db, settings)
    return {k: v.get(k) for k in keys}


@router.get("/limits", summary="Лимиты расходов: ИИ (общий и на цех в день), SMS (час, сутки)")
def get_limits(admin: TariffsDep, db: DbDep, settings: SettingsDep) -> dict:
    from ..services.spend_limits import ai_spent_today

    return {"values": _values(db, settings, LIMIT_KEYS), "descriptions": {k: KNOWN[k][1] for k in LIMIT_KEYS},
            "today": {"ai_usd": round(ai_spent_today(db), 4)}}


def _put(db, settings, admin, body: dict, keys, entity: str) -> dict:
    before = _values(db, settings, keys)
    for k, v in body.items():
        if k not in keys:
            raise ApiError(422, "unknown_setting", f"Неизвестная настройка: {k}")
        try:
            set_setting(db, k, coerce(k, v))
        except ValueError as e:
            raise ApiError(422, "invalid_setting", str(e))
    db.flush()
    _log(db, admin, entity, None, "update", before={k: before[k] for k in body},
         after={k: coerce(k, v) for k, v in body.items()})
    db.commit()
    return _values(db, settings, keys)


@router.put("/limits", summary="Изменить лимиты (в журнал)")
def put_limits(body: dict[str, Any], admin: TariffsDep, db: DbDep, settings: SettingsDep) -> dict:
    return {"values": _put(db, settings, admin, body, LIMIT_KEYS, "limits")}


MAINTENANCE_KEYS = ("maintenance_on", "maintenance_until", "maintenance_message_ru", "maintenance_message_uz",
                    *SWITCH_KEYS)


@router.get("/maintenance", summary="Режим обслуживания и аварийные выключатели (ИИ, регистрация)")
def get_maintenance(admin: SettingsAdminDep, db: DbDep, settings: SettingsDep) -> dict:
    return {"values": _values(db, settings, MAINTENANCE_KEYS)}


@router.put("/maintenance", summary="Включить/выключить обслуживание, ИИ, регистрацию (с причиной)")
def put_maintenance(body: dict[str, Any], admin: SettingsAdminDep, db: DbDep, settings: SettingsDep) -> dict:
    body = dict(body)
    reason = require_reason(admin, body.pop("reason", None))
    out = _put(db, settings, admin, body, MAINTENANCE_KEYS, "maintenance")
    if reason:
        _log(db, admin, "maintenance", None, "reason", after={"reason": reason})
        db.commit()
    return {"values": out}


# --- Рассылки (ADM-13) ---


class Segment(BaseModel):
    city: str | None = Field(None, max_length=100)
    plan: Literal["free", "pack", "pro"] | None = None
    active_days: int | None = Field(None, ge=1, le=365, description="Заходили в приложение за N дней")
    roles: list[Literal["owner", "employee"]] = Field(default_factory=lambda: ["owner"])


class BroadcastIn(BaseModel):
    title_ru: str = Field(min_length=1, max_length=100)
    body_ru: str = Field(min_length=1, max_length=400)
    title_uz: str | None = Field(None, max_length=100)
    body_uz: str | None = Field(None, max_length=400)
    segment: Segment = Field(default_factory=Segment)
    dry_run: bool = Field(False, description="Только посчитать получателей")


def _recipients(db, seg: Segment) -> list[User]:
    stmt = select(User).join(Workshop, User.workshop_id == Workshop.id).where(
        User.is_active.is_(True), User.deleted_at.is_(None), User.role.in_(seg.roles), Workshop.blocked.is_(False))
    if seg.city:
        stmt = stmt.where(func.lower(Workshop.city) == seg.city.strip().lower())
    if seg.plan:
        stmt = stmt.where(Workshop.plan == seg.plan)
    if seg.active_days:
        stmt = stmt.where(User.last_login_at >= utcnow() - timedelta(days=seg.active_days))
    return list(db.scalars(stmt))


@router.post("/broadcasts", status_code=201, summary="Рассылка мастерам: push и уведомление в приложении (ru/uz)")
def broadcast(body: BroadcastIn, admin: BroadcastsDep, db: DbDep) -> dict:
    from ..services.notify import notify

    users = _recipients(db, body.segment)
    if body.dry_run:
        return {"recipients": len(users), "sent": 0, "dry_run": True}
    bid = uuid.uuid4()
    params = {"head_ru": body.title_ru, "text_ru": body.body_ru, "head_uz": body.title_uz or body.title_ru,
              "text_uz": body.body_uz or body.body_ru}
    sent = notify(db, users, "broadcast", params, data={"broadcast_id": str(bid), "screen": "notifications"},
                  dedupe_key=f"broadcast:{bid}")
    _log(db, admin, "broadcast", bid, "send", after={**params, "segment": body.segment.model_dump(),
                                                    "recipients": len(users)})
    db.commit()
    return {"id": str(bid), "recipients": len(users), "sent": len(sent), "dry_run": False}


@router.get("/broadcasts", summary="Отправленные рассылки")
def broadcasts(admin: BroadcastsDep, db: DbDep, limit: int = Query(50, ge=1, le=200)) -> list[dict]:
    rows = list(db.scalars(select(ActionLog).where(ActionLog.entity == "broadcast")
                           .order_by(ActionLog.created_at.desc()).limit(limit)))
    names = staff_names(db, rows)
    return [{"id": e.entity_id, **(e.after or {}), "actor_name": names.get(e.actor_id or ""),
             "created_at": _iso(e.created_at)} for e in rows]


# --- Журнал действий (только чтение) ---


@router.get("/audit", summary="Журнал действий (только чтение)")
def audit(admin: AuditDep, db: DbDep, actor: str | None = None, entity: str | None = None,
          action: str | None = None, from_: Annotated[str | None, Query(alias="from")] = None, to: str | None = None,
          workshop_id: uuid.UUID | None = None, page: int = Query(1, ge=1),
          page_size: int = Query(100, ge=1, le=500)) -> dict:
    stmt = select(ActionLog)
    if actor:
        stmt = stmt.where(or_(ActionLog.actor_id == actor, ActionLog.actor_type == actor))
    if entity:
        stmt = stmt.where(ActionLog.entity == entity)
    if action:
        stmt = stmt.where(ActionLog.action == action)
    if workshop_id:
        stmt = stmt.where(ActionLog.workshop_id == workshop_id)
    if from_ or to:
        start, end = finance.period(from_, to)
        stmt = stmt.where(ActionLog.created_at >= start, ActionLog.created_at < end)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = list(db.scalars(stmt.order_by(ActionLog.created_at.desc()).limit(page_size)
                           .offset((page - 1) * page_size)))
    names = staff_names(db, rows)
    return {"items": [{"id": str(e.id), "actor_type": e.actor_type, "actor_id": e.actor_id,
                       "actor_name": names.get(e.actor_id or "") if e.actor_type == "staff" else None,
                       "workshop_id": str(e.workshop_id) if e.workshop_id else None, "entity": e.entity,
                       "entity_id": e.entity_id, "action": e.action, "before": e.before, "after": e.after,
                       "created_at": _iso(e.created_at)} for e in rows],
            "total": total, "page": page, "page_size": page_size}
