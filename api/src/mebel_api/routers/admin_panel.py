"""Админка (раздел 17 PRD, неделя 16 плана): дашборд, цеха, проекты, заказы, ИИ-журнал, настройки.

Доступ — заголовок X-Admin-Token (временно, вместо ролей админки). Все изменения цен, настроек,
тарифов, начислений и статусов заказов пишутся в журнал действий.
"""

import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from ..db import utcnow
from ..deps import (
    AiLogDep,
    DbDep,
    OrdersDep,
    PlatformDep,
    ProjectsViewDep,
    SettingsAdminDep,
    SettingsDep,
    WorkshopsGrantDep,
    WorkshopsViewDep,
    require_reason,
)
from ..domain import ORDER_STATUS_LABELS, STATUS_LABELS, OrderStatus, ProjectStatus as S
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import (
    ActionLog,
    AiRequest,
    ChatMessage,
    Client,
    ExtraCharge,
    FileAccess,
    ModelVersion,
    Order,
    Payment,
    Project,
    ShareLink,
    Supplier,
    User,
    Workshop,
)
from ..services import lifecycle
from ..services.action_log import log_action, staff_names
from ..services.ai import budget_state, chat_messages
from ..services.app_settings import KNOWN, all_settings, coerce, set_setting
from ..services.estimate import compute_range, is_measured, master_estimate
from ..services.files import production_access
from ..services.limits import limit_state

router = APIRouter(prefix="/admin", tags=["admin"], responses=ERROR_RESPONSES)


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _usd(micro: int | None) -> float:
    return round((micro or 0) / 1_000_000, 4)


def _periods(settings) -> dict[str, datetime]:
    tz = ZoneInfo(settings.limit_timezone)
    now = utcnow().astimezone(tz)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return {"today": day, "week": day - timedelta(days=6), "month": day.replace(day=1)}


# --- Дашборд (ADM-01) ---


@router.get("/dashboard", summary="Дашборд: цеха, проекты, заказы, расходы на ИИ")
def dashboard(admin: PlatformDep, db: DbDep, settings: SettingsDep,
              from_: Annotated[str | None, Query(alias="from")] = None, to: str | None = None) -> dict:
    out = _dashboard_base(db, settings)
    if admin.can("finance"):  # расширенная сводка суперадмина (§4a): период, поставщики, деньги, споры
        out["period"] = _dashboard_period(db, settings, from_, to)
    return out


def _dashboard_period(db, settings, from_: str | None, to: str | None) -> dict:
    from ..models import AuthCode, OrderDispute, OrderReturn
    from ..services import finance

    start, end = finance.period(from_, to)
    in_period = lambda col: (col >= start) & (col < end)  # noqa: E731
    by_supplier = [{"supplier_id": str(sid) if sid else None, "supplier_name": name, "status": st, "count": n}
                   for sid, name, st, n in db.execute(
                       select(Order.supplier_id, Supplier.name, Order.status, func.count(Order.id))
                       .outerjoin(Supplier, Order.supplier_id == Supplier.id).where(in_period(Order.created_at))
                       .group_by(Order.supplier_id, Supplier.name, Order.status)).all()]
    paid = list(db.scalars(select(Order).where(Order.paid_at.is_not(None), in_period(Order.paid_at))))
    turnover = sum(o.invoice_total if o.invoice_total is not None else (o.estimate_total or 0) for o in paid)
    accrued = sum(o.commission_amount or 0 for o in paid)
    reversed_ = sum(o.commission_reversed or 0 for o in paid)
    from ..models import SupplierSettlement

    received = db.scalar(select(func.coalesce(func.sum(SupplierSettlement.amount), 0))
                         .where(in_period(SupplierSettlement.paid_at))) or 0
    pays = db.execute(select(Payment.kind, Payment.status, func.coalesce(func.sum(Payment.amount), 0))
                      .where(in_period(Payment.paid_at)).group_by(Payment.kind, Payment.status)).all()
    revenue = {"pack": 0, "pro": 0, "files": 0, "refunds": 0}
    for kind, st, amount in pays:
        if st == "refunded":
            revenue["refunds"] += amount
        revenue[kind] = revenue.get(kind, 0) + amount
    overdue_h = int(all_settings(db, settings).get("vendor_overdue_hours") or 24)
    ai = db.execute(select(func.count(AiRequest.id), func.coalesce(func.sum(AiRequest.cost_microusd), 0))
                    .where(in_period(AiRequest.created_at))).one()
    return {
        "from": start.isoformat(), "to": end.isoformat(),
        "workshops_new": db.scalar(select(func.count(Workshop.id)).where(in_period(Workshop.created_at))) or 0,
        "masters_active": db.scalar(select(func.count(User.id)).where(in_period(User.last_login_at))) or 0,
        "workshops_active": db.scalar(select(func.count(func.distinct(Project.workshop_id)))
                                      .where(in_period(Project.updated_at))) or 0,
        "projects_new": db.scalar(select(func.count(Project.id)).where(in_period(Project.created_at))) or 0,
        "orders_by_supplier": by_supplier,
        "turnover": turnover, "paid_orders": len(paid),
        "commission": {"accrued": accrued, "reversed": reversed_, "received": received},
        "platform_revenue": revenue,
        "ai": {"requests": ai[0], "cost_usd": _usd(ai[1]),
               "errors": db.scalar(select(func.count(AiRequest.id)).where(
                   in_period(AiRequest.created_at), AiRequest.validation_result.not_in(["ok", "retried"]))) or 0},
        "sms": {"codes_sent": db.scalar(select(func.count(AuthCode.id)).where(in_period(AuthCode.created_at))) or 0},
        "overdue_orders": db.scalar(select(func.count(Order.id)).where(
            Order.status == OrderStatus.created, Order.created_at < utcnow() - timedelta(hours=overdue_h))) or 0,
        "overdue_hours": overdue_h,
        "open_disputes": db.scalar(select(func.count(OrderDispute.id)).where(OrderDispute.status == "open")) or 0,
        "open_returns": db.scalar(select(func.count(OrderReturn.id)).where(OrderReturn.status != "resolved")) or 0,
    }


def _dashboard_base(db, settings) -> dict:
    periods = _periods(settings)
    active_since = utcnow() - timedelta(days=30)
    by_status = dict(db.execute(select(Project.status, func.count(Project.id)).where(Project.deleted_at.is_(None))
                                .group_by(Project.status)).all())
    orders_by_status = dict(db.execute(select(Order.status, func.count(Order.id)).group_by(Order.status)).all())
    ai = {}
    for name, since in periods.items():
        row = db.execute(select(func.count(AiRequest.id), func.coalesce(func.sum(AiRequest.cost_microusd), 0))
                         .where(AiRequest.created_at >= since)).one()
        ai[name] = {"requests": row[0], "cost_usd": _usd(row[1])}
    turnover = {}
    for name, since in periods.items():
        total = db.scalar(select(func.coalesce(func.sum(func.coalesce(Order.invoice_total, Order.estimate_total)), 0))
                          .where(Order.paid_at >= since, Order.status != OrderStatus.cancelled)) or 0
        turnover[name] = total
    eman = db.scalar(select(Supplier).where(Supplier.code == "eman"))
    commission_bp = eman.commission_bp if eman else 0
    return {
        "workshops": {
            "total": db.scalar(select(func.count(Workshop.id))) or 0,
            "active_30d": db.scalar(select(func.count(func.distinct(Project.workshop_id)))
                                    .where(Project.updated_at >= active_since)) or 0,
            "blocked": db.scalar(select(func.count(Workshop.id)).where(Workshop.blocked.is_(True))) or 0,
        },
        "projects": {
            "total": sum(by_status.values()),
            "by_status": [{"status": s.value, "label": STATUS_LABELS[s], "count": by_status.get(s.value, 0)}
                          for s in S],
            "created_today": db.scalar(select(func.count(Project.id))
                                       .where(Project.created_at >= periods["today"])) or 0,
        },
        "orders": {
            "total": sum(orders_by_status.values()),
            "by_status": [{"status": s.value, "label": ORDER_STATUS_LABELS[s.value],
                           "count": orders_by_status.get(s.value, 0)} for s in OrderStatus],
            "awaiting_hand_over": db.scalar(select(func.count(Order.id)).where(
                Order.handed_over_at.is_(None), Order.status.in_([OrderStatus.created, OrderStatus.paid]))) or 0,
            "turnover": turnover,
            "commission_percent": commission_bp / 100,
            "commission": {k: round(v * commission_bp / 10_000) for k, v in turnover.items()},
        },
        "ai": ai,
    }


# --- Цеха (ADM-02) ---


def _owner(db, w: Workshop) -> User | None:
    return db.scalar(select(User).where(User.workshop_id == w.id, User.role == "owner").limit(1))


@router.get("/workshops", summary="Цеха: список")
def workshops(admin: WorkshopsViewDep, db: DbDep, settings: SettingsDep, q: str | None = None,
              limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict:
    stmt = select(Workshop)
    if q:
        like = f"%{q.strip().lower()}%"
        digits = "".join(ch for ch in q if ch.isdigit())
        conds = [func.lower(Workshop.name).like(like)]
        if digits:
            ids = select(User.workshop_id).where(User.phone.like(f"%{digits}%"))
            conds += [Workshop.phone.like(f"%{digits}%"), Workshop.id.in_(ids)]
        stmt = stmt.where(or_(*conds))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    items = []
    for w in db.scalars(stmt.order_by(Workshop.created_at.desc()).limit(limit).offset(offset)):
        st = limit_state(db, settings, w)
        owner = _owner(db, w)
        items.append({
            "id": str(w.id), "name": w.name, "city": w.city, "phone": w.phone or (owner.phone if owner else None),
            "owner_name": owner.name if owner else None, "plan": w.plan, "blocked": w.blocked,
            "free_left": st.free_left, "free_limit": st.free_limit, "pack_left": st.pack_left,
            "unlimited": st.unlimited,
            "projects": db.scalar(select(func.count(Project.id)).where(Project.workshop_id == w.id,
                                                                       Project.deleted_at.is_(None))) or 0,
            "orders": db.scalar(select(func.count(Order.id)).join(Project, Order.project_id == Project.id)
                                .where(Project.workshop_id == w.id)) or 0,
            "created_at": _iso(w.created_at),
        })
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/workshops/{workshop_id}", summary="Карточка цеха")
def workshop_card(workshop_id: uuid.UUID, admin: WorkshopsViewDep, db: DbDep, settings: SettingsDep) -> dict:
    w = db.get(Workshop, workshop_id)
    if w is None:
        raise not_found("Цех")
    st = limit_state(db, settings, w)
    projects = list(db.scalars(select(Project).where(Project.workshop_id == w.id, Project.deleted_at.is_(None))
                               .order_by(Project.updated_at.desc()).limit(100)))
    orders = list(db.scalars(select(Order).join(Project, Order.project_id == Project.id)
                             .where(Project.workshop_id == w.id).order_by(Order.created_at.desc()).limit(100)))
    ai_cost = db.scalar(select(func.coalesce(func.sum(AiRequest.cost_microusd), 0))
                        .where(AiRequest.workshop_id == w.id)) or 0
    log = list(db.scalars(select(ActionLog).where(ActionLog.workshop_id == w.id)
                          .order_by(ActionLog.created_at.desc()).limit(50)))
    names = staff_names(db, log)
    return {
        "id": str(w.id), "name": w.name, "city": w.city, "phone": w.phone, "plan": w.plan,
        "pro_until": _iso(w.pro_until), "blocked": w.blocked, "created_at": _iso(w.created_at),
        "pricing": {"labor_mode": w.labor_mode, "labor_percent": w.labor_percent, "labor_fixed": w.labor_fixed,
                    "markup": {"body": w.markup_body, "fronts": w.markup_fronts, "hardware": w.markup_hardware,
                               "services": w.markup_services}},
        "limits": {"period": st.period, "free_limit": st.free_limit, "free_used": st.free_used,
                   "free_left": st.free_left, "pack_left": st.pack_left, "unlimited": st.unlimited},
        "extra_charges": db.scalar(select(func.count(ExtraCharge.id)).where(ExtraCharge.workshop_id == w.id)) or 0,
        "users": [{"id": str(u.id), "phone": u.phone, "name": u.name, "role": u.role, "is_active": u.is_active,
                   "last_login_at": _iso(u.last_login_at)}
                  for u in db.scalars(select(User).where(User.workshop_id == w.id).order_by(User.created_at))],
        "projects": [_project_brief(p) for p in projects],
        "orders": [_order_brief(db, o) for o in orders],
        "ai_cost_usd": _usd(ai_cost),
        "action_log": [_log_out(e, names) for e in log],
    }


class BlockIn(BaseModel):
    blocked: bool
    reason: str | None = Field(None, max_length=500)


@router.post("/workshops/{workshop_id}/block", summary="Заблокировать / разблокировать цех")
def block_workshop(workshop_id: uuid.UUID, body: BlockIn, admin: WorkshopsGrantDep, db: DbDep) -> dict:
    require_reason(admin, body.reason)
    w = db.get(Workshop, workshop_id)
    if w is None:
        raise not_found("Цех")
    before = {"blocked": w.blocked}
    w.blocked = body.blocked
    log_action(db, actor_type=admin.type, actor_id=admin.id, workshop_id=w.id, entity="workshop", entity_id=w.id,
               action="block" if body.blocked else "unblock", before=before,
               after={"blocked": w.blocked, "reason": body.reason})
    db.commit()
    return {"blocked": w.blocked}


# --- Проекты (ADM-03) ---


def _project_brief(p: Project, workshop: Workshop | None = None, client: Client | None = None) -> dict:
    out = {
        "id": str(p.id), "title": p.title, "status": p.status, "status_label": STATUS_LABELS[S(p.status)],
        "product_type": p.product_type, "is_example": p.is_example, "workshop_id": str(p.workshop_id),
        "charged": p.charged_at is not None, "archived": p.archived_at is not None,
        "created_at": _iso(p.created_at), "updated_at": _iso(p.updated_at),
    }
    if workshop is not None:
        out["workshop_name"] = workshop.name
    if client is not None:
        out["client_name"] = client.name
    return out


@router.get("/projects", summary="Проекты: поиск по цеху, клиенту, типу изделия")
def projects(
    admin: ProjectsViewDep, db: DbDep, q: str | None = None, workshop_id: uuid.UUID | None = None,
    status: Annotated[list[S] | None, Query()] = None, product_type: str | None = None,
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
) -> dict:
    stmt = (select(Project, Workshop, Client).join(Workshop, Project.workshop_id == Workshop.id)
            .outerjoin(Client, Project.client_id == Client.id).where(Project.deleted_at.is_(None)))
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(Project.title).like(like), func.lower(Client.name).like(like),
                              func.lower(Workshop.name).like(like)))
    if workshop_id:
        stmt = stmt.where(Project.workshop_id == workshop_id)
    if status:
        stmt = stmt.where(Project.status.in_([s.value for s in status]))
    if product_type:
        stmt = stmt.where(Project.product_type == product_type)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(stmt.order_by(Project.updated_at.desc()).limit(limit).offset(offset)).all()
    return {"items": [_project_brief(p, w, c) for p, w, c in rows], "total": total, "limit": limit, "offset": offset}


def _version_brief(v: ModelVersion, p: Project) -> dict:
    return {"id": str(v.id), "number": v.number, "source": v.source, "label": v.label, "ok": v.ok,
            "frozen": v.frozen, "is_current": v.id == p.current_version_id, "summary": v.summary,
            "created_at": _iso(v.created_at)}


def _ai_out(r: AiRequest) -> dict:
    return {"id": str(r.id), "workshop_id": str(r.workshop_id) if r.workshop_id else None,
            "project_id": str(r.project_id) if r.project_id else None, "purpose": r.purpose, "model": r.model,
            "served_by": r.served_by, "tokens_in": r.tokens_in, "tokens_out": r.tokens_out,
            "cache_read_tokens": r.cache_read_tokens, "cache_write_tokens": r.cache_write_tokens,
            "cost_usd": _usd(r.cost_microusd), "cost_microusd": r.cost_microusd,
            "validation_result": r.validation_result, "validation_errors": r.validation_errors,
            "stop_reason": r.stop_reason, "duration_ms": r.duration_ms, "created_at": _iso(r.created_at)}


@router.get("/projects/{project_id}", summary="Карточка проекта: 3D, версии, смета, ИИ-журнал, чат, заказы")
def project_card(project_id: uuid.UUID, admin: ProjectsViewDep, db: DbDep, settings: SettingsDep) -> dict:
    p = db.get(Project, project_id)
    if p is None:
        raise not_found("Проект")
    w = db.get(Workshop, p.workshop_id)
    client = db.get(Client, p.client_id) if p.client_id else None
    current = lifecycle.current_version(db, p)
    er = compute_range(current, w, measured=is_measured(p))
    versions = db.scalars(select(ModelVersion).where(ModelVersion.project_id == p.id)
                          .order_by(ModelVersion.number.desc()))
    ai_rows = db.scalars(select(AiRequest).where(AiRequest.project_id == p.id).order_by(AiRequest.created_at.desc()))
    orders = db.scalars(select(Order).where(Order.project_id == p.id).order_by(Order.created_at.desc()))
    access = production_access(db, p, w)
    return {
        **_project_brief(p, w, client),
        "source_text": p.source_text, "deleted": p.deleted_at is not None,
        "client": {"name": client.name, "phone": client.phone, "address": client.address} if client else None,
        "frozen_version_id": str(p.frozen_version_id) if p.frozen_version_id else None,
        "current_version": {**_version_brief(current, p), "viewer": current.viewer, "issues": current.issues,
                            "tree": current.tree} if current else None,
        "versions": [_version_brief(v, p) for v in versions],
        "estimate": master_estimate(er, w).model_dump(mode="json", by_alias=True) if er else None,
        "ai_requests": [_ai_out(r) for r in ai_rows],
        "ai_budget": budget_state(db, settings, p).model_dump(),
        "chat": [m.model_dump(mode="json", by_alias=True) for m in chat_messages(db, p)],
        "orders": [_order_brief(db, o) for o in orders],
        "share_links": db.scalar(select(func.count(ShareLink.id)).where(ShareLink.project_id == p.id)) or 0,
        "files_access": {"production": access.granted, "basis": access.basis},
    }


@router.get("/projects/{project_id}/versions/{version_id}", summary="Версия модели проекта (3D)")
def project_version(project_id: uuid.UUID, version_id: uuid.UUID, admin: ProjectsViewDep, db: DbDep) -> dict:
    p = db.get(Project, project_id)
    v = db.get(ModelVersion, version_id)
    if p is None or v is None or v.project_id != p.id:
        raise not_found("Версия модели")
    return {**_version_brief(v, p), "viewer": v.viewer, "issues": v.issues, "tree": v.tree}


class FileAccessIn(BaseModel):
    basis: Literal["payment", "admin"] = "admin"
    note: str | None = Field(None, max_length=500)
    # Оплата файлов: сумма и способ — в историю платежей мастера (SCR-42)
    amount: int | None = Field(None, ge=0, description="Сумма оплаты файлов, сумы (basis=payment)")
    method: Literal["app_store", "google_play", "click", "payme", "manual"] = "manual"
    receipt_url: str | None = Field(None, max_length=1000)


@router.post("/projects/{project_id}/file-access", summary="Открыть производственные файлы (оплата файлов вручную)")
def grant_file_access(project_id: uuid.UUID, body: FileAccessIn, admin: WorkshopsGrantDep, db: DbDep) -> dict:
    p = db.get(Project, project_id)
    if p is None:
        raise not_found("Проект")
    row = FileAccess(project_id=p.id, basis=body.basis, note=body.note, granted_by=admin.id)
    db.add(row)
    if body.basis == "payment" and body.amount is not None:
        db.add(Payment(workshop_id=p.workshop_id, project_id=p.id, kind="files", amount=body.amount,
                       method=body.method, receipt_url=body.receipt_url, created_by=admin.id))
    db.flush()
    log_action(db, actor_type=admin.type, actor_id=admin.id, workshop_id=p.workshop_id, entity="file_access",
               entity_id=row.id, action="grant", after={"project_id": str(p.id), "basis": body.basis,
                                                         "note": body.note})
    db.commit()
    return {"id": str(row.id), "basis": row.basis}


# --- Заказы (ADM-08) ---

ORDER_FLOW = [OrderStatus.paid, OrderStatus.accepted, OrderStatus.cutting, OrderStatus.ready, OrderStatus.issued]
CANCELLABLE = {OrderStatus.created, OrderStatus.paid, OrderStatus.accepted, OrderStatus.returned,
               OrderStatus.awaiting_approval}


def _order_brief(db, o: Order) -> dict:
    p = db.get(Project, o.project_id)
    w = db.get(Workshop, p.workshop_id) if p else None
    return {
        "id": str(o.id), "project_id": str(o.project_id), "project_title": p.title if p else None,
        "workshop_id": str(w.id) if w else None, "workshop_name": w.name if w else None,
        "version_id": str(o.version_id) if o.version_id else None, "supplier": o.supplier, "status": o.status,
        "status_label": ORDER_STATUS_LABELS.get(o.status, o.status), "estimate_total": o.estimate_total,
        "invoice_total": o.invoice_total, "payment_provider": o.payment_provider,
        "payment_reference": o.payment_reference, "paid_at": _iso(o.paid_at),
        "handed_over_at": _iso(o.handed_over_at), "handed_over_by": o.handed_over_by,
        "commission_status": o.commission_status, "notes": o.notes, "created_at": _iso(o.created_at),
        "distance_km": o.distance_km,
        "status_changed_at": _iso(o.status_changed_at),
        "number": o.number, "payment_url": o.payment_url, "payment_failed_at": _iso(o.payment_failed_at),
        # Поставщики (docs/staff_vendor_contract.md §4–5)
        "supplier_id": str(o.supplier_id) if o.supplier_id else None,
        "supplier_name": s.name if (s := db.get(Supplier, o.supplier_id) if o.supplier_id else None) else None,
        "group_id": str(o.group_id) if o.group_id else None,
        "assignee_id": str(o.assignee_id) if o.assignee_id else None,
        "due_date": _iso(o.due_date), "accepted_at": _iso(o.accepted_at), "reject_reason": o.reject_reason,
        "vendor_status_note": o.vendor_status_note, "commission_amount": o.commission_amount,
        "commission_reversed": o.commission_reversed,
    }


def _get_order(db, order_id: uuid.UUID) -> Order:
    o = db.get(Order, order_id)
    if o is None:
        raise not_found("Заказ")
    return o


@router.get("/orders", summary="Заказы поставщикам")
def orders(admin: OrdersDep, db: DbDep, status: Annotated[list[OrderStatus] | None, Query()] = None,
           q: str | None = None, supplier_id: uuid.UUID | None = None,
           limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict:
    stmt = select(Order).join(Project, Order.project_id == Project.id).join(Workshop, Project.workshop_id == Workshop.id)
    if supplier_id:
        stmt = stmt.where(Order.supplier_id == supplier_id)
    if status:
        stmt = stmt.where(Order.status.in_([s.value for s in status]))
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(Project.title).like(like), func.lower(Workshop.name).like(like)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(Order.created_at.desc()).limit(limit).offset(offset))
    return {"items": [_order_brief(db, o) for o in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/orders/{order_id}", summary="Карточка заказа: состав, раскрой, CSV")
def order_card(order_id: uuid.UUID, admin: OrdersDep, db: DbDep) -> dict:
    o = _get_order(db, order_id)
    p = db.get(Project, o.project_id)
    w = db.get(Workshop, p.workshop_id)
    v = db.get(ModelVersion, o.version_id or p.frozen_version_id or p.current_version_id)
    composition = o.composition
    if composition is None and v is not None and v.ok:  # заказ создан до снимка состава — считаем сейчас
        from .orders import compose

        composition = compose(v, o.distance_km)
    owner = _owner(db, w)
    history = list(db.scalars(select(ActionLog).where(ActionLog.entity == "order", ActionLog.entity_id == str(o.id))
                              .order_by(ActionLog.created_at)))
    names = staff_names(db, history)
    return {
        **_order_brief(db, o),
        "workshop_phone": w.phone or (owner.phone if owner else None),
        "version_number": v.number if v else None,
        "supplier_order": composition,  # mebel_core.supplier_order(): lines, excluded, delivery, total
        "lines": (composition or {}).get("lines", []),
        "cost_total": (composition or {}).get("total"),
        "allowed_statuses": _allowed(o),
        "history": [_log_out(e, names) for e in history],
        "csv_url": f"/admin/orders/{o.id}/csv",
    }


def _allowed(o: Order) -> list[str]:
    st = OrderStatus(o.status)
    out = []
    # Принят поставщиком до оплаты (новый порядок §5.3) — «Оплачен» ставится через order-paid
    unpaid_accepted = st == OrderStatus.accepted and o.paid_at is None
    if st in ORDER_FLOW and st != OrderStatus.issued and not unpaid_accepted:
        out.append(ORDER_FLOW[ORDER_FLOW.index(st) + 1].value)
    if st in CANCELLABLE:
        out.append(OrderStatus.cancelled.value)
    return out


@router.get("/orders/{order_id}/csv", summary="CSV онлайн-кроя для ручной передачи в EMAN")
def order_csv(order_id: uuid.UUID, admin: OrdersDep, db: DbDep) -> Response:
    from mebel_core import build, export_csv, parse_tree

    o = _get_order(db, order_id)
    p = db.get(Project, o.project_id)
    v = db.get(ModelVersion, o.version_id or p.frozen_version_id or p.current_version_id)
    if v is None:
        raise ApiError(409, "model_missing", "У проекта нет модели")
    data = export_csv(build(parse_tree(v.tree)))
    return Response(content=data, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="order_{str(o.id)[:8]}_v{v.number}.csv"'})


class HandOverIn(BaseModel):
    note: str | None = Field(None, max_length=1000)


@router.post("/orders/{order_id}/hand-over", summary="Отметить ручную передачу заказа в EMAN")
def hand_over(order_id: uuid.UUID, body: HandOverIn, admin: OrdersDep, db: DbDep) -> dict:
    o = _get_order(db, order_id)
    if o.status == OrderStatus.cancelled:
        raise ApiError(409, "order_cancelled", "Заказ отменён")
    o.handed_over_at = utcnow()
    o.handed_over_by = admin.id
    if body.note:
        o.notes = body.note
    p = db.get(Project, o.project_id)
    log_action(db, actor_type=admin.type, actor_id=admin.id, workshop_id=p.workshop_id, entity="order", entity_id=o.id,
               action="hand_over", after={"note": body.note})
    db.commit()
    return _order_brief(db, o)


class OrderStatusIn(BaseModel):
    status: OrderStatus
    invoice_total: int | None = Field(None, ge=0)
    note: str | None = Field(None, max_length=1000)
    reason: str | None = Field(None, max_length=500, description="Обязательна для отмены оплаченного заказа (§4a)")


@router.post("/orders/{order_id}/status", summary="Сменить статус заказа (менеджер)")
def order_status(order_id: uuid.UUID, body: OrderStatusIn, admin: OrdersDep, db: DbDep) -> dict:
    """Принят EMAN → В распиле → Готов → Выдан; отмена — до «В распиле» (раздел 16).
    «Оплачен» ставится через POST /admin/projects/{id}/order-paid."""
    o = _get_order(db, order_id)
    if body.status.value not in _allowed(o):
        raise ApiError(409, "illegal_order_transition",
                       f"Из «{ORDER_STATUS_LABELS[o.status]}» нельзя перейти в «{ORDER_STATUS_LABELS[body.status.value]}»",
                       {"allowed": _allowed(o)})
    from ..services import order_flow as flow

    reason = None
    if body.status == OrderStatus.cancelled and o.paid_at is not None:
        reason = require_reason(admin, body.reason or body.note)
    before = {"status": o.status, "commission_status": o.commission_status, "invoice_total": o.invoice_total}
    now = utcnow()
    from_status = o.status
    o.status = body.status
    o.status_changed_at = now
    if body.status == OrderStatus.accepted and o.accepted_at is None:
        o.accepted_at = now
    if body.invoice_total is not None:
        o.invoice_total = body.invoice_total
    if body.note:
        o.notes = body.note
    if body.status == OrderStatus.cancelled:
        o.cancelled_at = now
        if o.commission_status == "accrued":
            flow.reverse_commission(db, o)
            o.commission_status = "reversed"  # сторно комиссии при отмене с возвратом
    p = db.get(Project, o.project_id)
    from ..services import events

    flow.event(db, o, "status_changed", actor_type="platform", actor_id=admin.id, actor_name=admin.name,
               from_status=from_status, to_status=body.status, comment=reason or body.note)
    events.order_status(db, o)  # push владельцу и автору: «Заказ №… готов к выдаче» (раздел 19)
    log_action(db, actor_type=admin.type, actor_id=admin.id, workshop_id=p.workshop_id, entity="order", entity_id=o.id,
               action="status", before=before,
               after={"status": o.status, "commission_status": o.commission_status, "invoice_total": o.invoice_total})
    db.commit()
    return _order_brief(db, o)


class PaymentIn(BaseModel):
    url: str | None = Field(None, max_length=1000, description="Ссылка на оплату от EMAN (Click / Payme на мерчант EMAN)")
    method: Literal["click", "payme", "invoice"] | None = None
    failed: bool | None = Field(None, description="true — оплата не прошла; false — снять отметку")


@router.post("/orders/{order_id}/payment", summary="Ссылка на оплату EMAN и способ; отметка «оплата не прошла»")
def order_payment(order_id: uuid.UUID, body: PaymentIn, admin: OrdersDep, db: DbDep) -> dict:
    """До интеграции с мерчантом EMAN: менеджер вставляет ссылку от EMAN, мастер видит её в SCR-31.
    «Оплачено» — POST /admin/projects/{id}/order-paid."""
    o = _get_order(db, order_id)
    if o.status == OrderStatus.cancelled:
        raise ApiError(409, "order_cancelled", "Заказ отменён")
    if o.paid_at is not None and body.failed:
        raise ApiError(409, "order_paid", "Заказ уже оплачен")
    before = {"payment_url": o.payment_url, "payment_provider": o.payment_provider,
              "payment_failed_at": _iso(o.payment_failed_at)}
    data = body.model_dump(exclude_unset=True)
    if "url" in data:
        o.payment_url = body.url
    if "method" in data:
        o.payment_provider = body.method
    if body.failed is not None:
        o.payment_failed_at = utcnow() if body.failed else None
    p = db.get(Project, o.project_id)
    log_action(db, actor_type=admin.type, actor_id=admin.id, workshop_id=p.workshop_id, entity="order", entity_id=o.id,
               action="payment", before=before,
               after={"payment_url": o.payment_url, "payment_provider": o.payment_provider,
                      "payment_failed_at": _iso(o.payment_failed_at)})
    db.commit()
    return _order_brief(db, o)


# --- ИИ-журнал (ADM-11) ---


@router.get("/ai-stats", summary="ИИ: расход, проверки, точность распознавания")
def ai_stats(admin: AiLogDep, db: DbDep, settings: SettingsDep) -> dict:
    periods = _periods(settings)
    totals = {}
    for name, since in periods.items():
        row = db.execute(select(func.count(AiRequest.id), func.coalesce(func.sum(AiRequest.cost_microusd), 0),
                                func.coalesce(func.sum(AiRequest.tokens_in + AiRequest.tokens_out
                                                       + AiRequest.cache_read_tokens + AiRequest.cache_write_tokens), 0))
                         .where(AiRequest.created_at >= since)).one()
        totals[name] = {"requests": row[0], "cost_usd": _usd(row[1]), "tokens": row[2]}
    by_purpose = [{"purpose": r[0], "requests": r[1], "cost_usd": _usd(r[2])} for r in db.execute(
        select(AiRequest.purpose, func.count(AiRequest.id), func.sum(AiRequest.cost_microusd))
        .group_by(AiRequest.purpose)).all()]
    by_validation = dict(db.execute(select(AiRequest.validation_result, func.count(AiRequest.id))
                                    .group_by(AiRequest.validation_result)).all())
    by_workshop = [{"workshop_id": str(r[0]) if r[0] else None, "workshop_name": r[1], "requests": r[2],
                    "cost_usd": _usd(r[3])} for r in db.execute(
        select(AiRequest.workshop_id, Workshop.name, func.count(AiRequest.id), func.sum(AiRequest.cost_microusd))
        .outerjoin(Workshop, AiRequest.workshop_id == Workshop.id).group_by(AiRequest.workshop_id, Workshop.name)
        .order_by(func.sum(AiRequest.cost_microusd).desc()).limit(20)).all()]
    design_rows = db.execute(select(AiRequest.validation_result, func.count(AiRequest.id))
                             .where(AiRequest.purpose == "design").group_by(AiRequest.validation_result)).all()
    design_total = sum(c for _, c in design_rows)
    design_ok = sum(c for v, c in design_rows if v == "ok")
    # Точность: сколько раз мастер исправил дерево после ИИ (ручная версия поверх ИИ-версии)
    ai_projects = set(db.scalars(select(ModelVersion.project_id).where(ModelVersion.source == "ai").distinct()))
    corrected = 0
    for pid in ai_projects:
        first_ai = db.scalar(select(func.min(ModelVersion.number)).where(ModelVersion.project_id == pid,
                                                                         ModelVersion.source == "ai"))
        later_manual = db.scalar(select(ModelVersion.id).where(
            ModelVersion.project_id == pid, ModelVersion.number > first_ai,
            ModelVersion.source.in_(["manual", "fix"])).limit(1))
        corrected += later_manual is not None
    per_project = db.execute(select(AiRequest.project_id, func.sum(AiRequest.cost_microusd))
                             .where(AiRequest.project_id.is_not(None)).group_by(AiRequest.project_id)).all()
    avg_project = (sum(c for _, c in per_project) / len(per_project)) if per_project else 0
    # Расход по дням (30 дней) и подозрительная активность: цех за сегодня больше своего среднего в N раз
    since = periods["today"] - timedelta(days=29)
    daily: dict[str, float] = {}
    per_ws: dict[Any, list[int]] = {}
    for created, wid, cost in db.execute(select(AiRequest.created_at, AiRequest.workshop_id, AiRequest.cost_microusd)
                                         .where(AiRequest.created_at >= since)).all():
        day = created.astimezone(ZoneInfo(settings.limit_timezone)).date().isoformat()
        daily[day] = daily.get(day, 0) + (cost or 0)
        if wid is not None:
            bucket = per_ws.setdefault(wid, [0, 0])  # [сегодня, раньше]
            bucket[0 if created >= periods["today"] else 1] += cost or 0
    factor = float(all_settings(db, settings).get("ai_anomaly_factor") or 5)
    suspicious = []
    for wid, (today, before) in per_ws.items():
        avg = before / 29
        if today and today > factor * max(avg, 1):
            w = db.get(Workshop, wid)
            suspicious.append({"workshop_id": str(wid), "workshop_name": w.name if w else None,
                               "today_usd": _usd(today), "avg_day_usd": _usd(round(avg))})
    return {
        "by_day": [{"date": d, "cost_usd": _usd(c)} for d, c in sorted(daily.items())],
        "suspicious": suspicious, "anomaly_factor": factor,
        "totals": totals, "by_purpose": by_purpose, "by_validation": by_validation, "by_workshop": by_workshop,
        "accuracy": {
            "design_requests": design_total,
            "design_valid_first_try_share": round(design_ok / design_total, 3) if design_total else None,
            "ai_projects": len(ai_projects), "corrected_by_master": corrected,
            "corrected_share": round(corrected / len(ai_projects), 3) if ai_projects else None,
        },
        "avg_cost_per_project_usd": _usd(round(avg_project)),
        "chat_messages": db.scalar(select(func.count(ChatMessage.id))) or 0,
    }


# --- Настройки (ADM-12, часть) ---


@router.get("/settings", summary="Настройки: бюджет ИИ и т. п.")
def get_settings_admin(admin: SettingsAdminDep, db: DbDep, settings: SettingsDep) -> dict:
    values = all_settings(db, settings)
    return {"values": values, "descriptions": {k: d for k, (_, d) in KNOWN.items()}}


@router.patch("/settings", summary="Изменить настройки (пишется в журнал действий)")
def patch_settings(body: dict[str, Any], admin: SettingsAdminDep, db: DbDep, settings: SettingsDep) -> dict:
    before_all = all_settings(db, settings)
    for key, value in body.items():
        if key not in KNOWN:
            raise ApiError(422, "unknown_setting", f"Неизвестная настройка: {key}")
        try:
            value = coerce(key, value)
        except ValueError as e:
            raise ApiError(422, "invalid_setting", str(e))
        set_setting(db, key, value)
    after_all = all_settings(db, settings) | {k: coerce(k, v) for k, v in body.items()}
    log_action(db, actor_type=admin.type, actor_id=admin.id, entity="settings", entity_id=None, action="update",
               before={k: before_all.get(k) for k in body}, after={k: after_all.get(k) for k in body})
    db.commit()
    return {"values": all_settings(db, settings)}


def _log_out(e: ActionLog, names: dict[str, str] | None = None) -> dict:
    return {"id": str(e.id), "actor_type": e.actor_type, "actor_id": e.actor_id,
            "actor_name": (names or {}).get(e.actor_id or "") if e.actor_type == "staff" else None, "entity": e.entity,
            "entity_id": e.entity_id, "action": e.action, "before": e.before, "after": e.after,
            "created_at": _iso(e.created_at)}
