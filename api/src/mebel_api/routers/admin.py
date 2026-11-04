"""Минимум админки, нужный уже сейчас: оплата заказа менеджером, тариф цеха, журналы.

Доступ — по заголовку X-Admin-Token (временно, до ролей админки из раздела 17 PRD).
"""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import utcnow
from ..deps import AiLogDep, AuditDep, DbDep, FinanceDep, OrdersDep, WorkshopsGrantDep, require_reason
from ..domain import OrderStatus, Plan, ProjectStatus as S
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import ActionLog, AiRequest, Order, Payment, Project, Workshop
from ..schemas.common import Out
from ..schemas.workshops import ActionLogOut
from ..services import lifecycle
from ..services.action_log import log_action

router = APIRouter(prefix="/admin", tags=["admin"], responses=ERROR_RESPONSES)


class OrderPaidIn(BaseModel):
    estimate_total: int | None = Field(None, ge=0, description="Сумма по смете, сумы")
    invoice_total: int | None = Field(None, ge=0, description="Сумма по счёту EMAN, сумы")
    payment_provider: str | None = Field(None, max_length=20, description="click, payme, invoice")
    payment_reference: str | None = Field(None, max_length=200, description="Номер транзакции или счёта EMAN")


class OrderOut(Out):
    id: uuid.UUID
    project_id: uuid.UUID
    version_id: uuid.UUID | None
    supplier: str
    status: OrderStatus
    estimate_total: int | None
    invoice_total: int | None
    payment_provider: str | None
    payment_reference: str | None
    paid_at: datetime | None
    created_at: datetime


class PlanIn(BaseModel):
    reason: str | None = Field(None, max_length=500, description="Причина (обязательна для сотрудника, §4a)")
    plan: Plan | None = None
    add_pack_projects: int = Field(0, ge=-1000, le=1000, description="Ручное начисление проектов в пакет")
    pro_until: datetime | None = None


class AiRequestOut(Out):
    id: uuid.UUID
    workshop_id: uuid.UUID | None
    project_id: uuid.UUID | None
    purpose: str
    model: str
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cost_microusd: int
    validation_result: str
    validation_errors: list | None
    duration_ms: int | None
    cache_write_tokens: int = 0
    stop_reason: str | None = None
    served_by: str | None = None
    created_at: datetime


@router.post(
    "/projects/{project_id}/order-paid",
    response_model=OrderOut,
    summary="Заказ оплачен (Договор → В работе)",
)
def order_paid(project_id: uuid.UUID, body: OrderPaidIn, admin: OrdersDep, db: DbDep) -> Order:
    """Менеджер отмечает оплату заказа на мерчант EMAN (ADM-08). Проект возвращается в бесплатный лимит."""
    from ..services import order_flow as flow
    from ..services.supplier_routes import default_supplier

    p = db.get(Project, project_id)
    if p is None or p.deleted_at is not None:
        raise not_found("Проект")
    lifecycle.ensure_transition(p, S.in_work)
    workshop = db.get(Workshop, p.workshop_id)
    # Заказ, который мастер уже оформил (создан или принят поставщиком, не оплачен), — отмечаем оплаченным
    order = db.scalar(select(Order).where(Order.project_id == p.id,
                                          Order.status.in_([OrderStatus.created, OrderStatus.accepted]),
                                          Order.paid_at.is_(None)).order_by(Order.created_at).limit(1))
    if order is None:
        from .orders import next_number

        supplier = default_supplier(db)
        order = Order(project_id=p.id, version_id=p.frozen_version_id, number=next_number(db), supplier=supplier.code,
                      supplier_id=supplier.id, **body.model_dump())
        db.add(order)
        db.flush()
        order.group_id = order.id
    else:
        for k, v in body.model_dump().items():
            if v is not None:
                setattr(order, k, v)
    returned = flow.mark_paid(db, order, actor_type="platform", actor_id=admin.id, actor_name=admin.name,
                              project_actor="admin", comment="Оплата отмечена менеджером", log=False)
    log_action(
        db, actor_type=admin.type, actor_id=admin.id, workshop_id=workshop.id, entity="order", entity_id=order.id,
        action="mark_paid", after={**body.model_dump(), "project_id": str(p.id), "returned_to_limit": returned},
    )
    db.commit()
    return order


@router.post("/workshops/{workshop_id}/plan", summary="Тариф и ручное начисление проектов")
def set_plan(workshop_id: uuid.UUID, body: PlanIn, admin: WorkshopsGrantDep, db: DbDep) -> dict:
    reason = require_reason(admin, body.reason)
    w = db.get(Workshop, workshop_id)
    if w is None:
        raise not_found("Цех")
    before = {"plan": w.plan, "pack_projects_left": w.pack_projects_left, "pro_until": _iso(w.pro_until)}
    if body.plan is not None:
        w.plan = body.plan
    if body.pro_until is not None:
        w.pro_until = body.pro_until
    if w.pack_projects_left + body.add_pack_projects < 0:
        raise ApiError(409, "pack_negative", "Остаток пакета не может стать отрицательным")
    w.pack_projects_left += body.add_pack_projects
    after = {"plan": w.plan, "pack_projects_left": w.pack_projects_left, "pro_until": _iso(w.pro_until)}
    log_action(
        db, actor_type=admin.type, actor_id=admin.id, workshop_id=w.id, entity="workshop_plan", entity_id=w.id,
        action="update", before={**before, "reason": None}, after={**after, "reason": reason},
    )
    db.commit()
    return after


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


@router.get("/ai-requests", response_model=list[AiRequestOut], summary="ИИ-журнал")
def ai_requests(
    admin: AiLogDep, db: DbDep, project_id: uuid.UUID | None = None, workshop_id: uuid.UUID | None = None,
    purpose: str | None = None, validation: str | None = None,
    limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
) -> list[AiRequest]:
    stmt = select(AiRequest).order_by(AiRequest.created_at.desc()).limit(limit).offset(offset)
    if project_id:
        stmt = stmt.where(AiRequest.project_id == project_id)
    if workshop_id:
        stmt = stmt.where(AiRequest.workshop_id == workshop_id)
    if purpose:
        stmt = stmt.where(AiRequest.purpose == purpose)
    if validation:
        stmt = stmt.where(AiRequest.validation_result == validation)
    return list(db.scalars(stmt))


@router.get("/action-log", response_model=list[ActionLogOut], summary="Журнал действий")
def admin_action_log(
    admin: AuditDep, db: DbDep, workshop_id: uuid.UUID | None = None, limit: int = Query(100, ge=1, le=500)
) -> list[ActionLog]:
    stmt = select(ActionLog).order_by(ActionLog.created_at.desc()).limit(limit)
    if workshop_id:
        stmt = stmt.where(ActionLog.workshop_id == workshop_id)
    return list(db.scalars(stmt))


# --- Платежи платформе (SCR-42): до вебхуков App Store / Google Play / Click / Payme — вручную ---


class PaymentIn(BaseModel):
    kind: Literal["pack", "pro", "files"]
    amount: int = Field(ge=0, description="Сумма, сумы")
    method: Literal["app_store", "google_play", "click", "payme", "manual"] = "manual"
    title: str | None = Field(None, max_length=200, description="Нет — «Пакет 10 проектов», «Pro · октябрь»…")
    project_id: uuid.UUID | None = Field(None, description="Для оплаты файлов проекта")
    receipt_url: str | None = Field(None, max_length=1000)
    reference: str | None = Field(None, max_length=200, description="Номер транзакции")
    paid_at: datetime | None = None


def _payment_dict(p: Payment) -> dict:
    return {"id": str(p.id), "kind": p.kind, "amount": p.amount, "method": p.method, "status": p.status,
            "title": p.title, "project_id": str(p.project_id) if p.project_id else None,
            "receipt_url": p.receipt_url, "paid_at": _iso(p.paid_at), "refunded_at": _iso(p.refunded_at)}


@router.post("/workshops/{workshop_id}/payments", status_code=201, summary="Записать платёж цеха (пакет, Pro, файлы)")
def add_payment(workshop_id: uuid.UUID, body: PaymentIn, admin: FinanceDep, db: DbDep) -> dict:
    """Только запись в историю платежей мастера. Начисление (пакет, Pro, доступ к файлам) — отдельно:
    `/admin/workshops/{id}/plan`, `/admin/projects/{id}/file-access`."""
    w = db.get(Workshop, workshop_id)
    if w is None:
        raise not_found("Цех")
    if body.project_id is not None:
        p = db.get(Project, body.project_id)
        if p is None or p.workshop_id != w.id:
            raise not_found("Проект")
    if body.paid_at is not None and body.paid_at.tzinfo is None:
        raise ApiError(422, "validation_error", "Укажите часовой пояс времени оплаты")
    row = Payment(workshop_id=w.id, created_by=admin.id, **body.model_dump(exclude={"paid_at"}),
                  paid_at=body.paid_at or utcnow())
    db.add(row)
    db.flush()
    log_action(db, actor_type=admin.type, actor_id=admin.id, workshop_id=w.id, entity="payment", entity_id=row.id,
               action="create", after=_payment_dict(row))
    db.commit()
    return _payment_dict(row)


@router.post("/payments/{payment_id}/refund", summary="Отметить возврат платежа")
def refund_payment(payment_id: uuid.UUID, admin: FinanceDep, db: DbDep) -> dict:
    row = db.get(Payment, payment_id)
    if row is None:
        raise not_found("Платёж")
    if row.status == "refunded":
        raise ApiError(409, "already_refunded", "Возврат уже отмечен")
    row.status, row.refunded_at = "refunded", utcnow()
    log_action(db, actor_type=admin.type, actor_id=admin.id, workshop_id=row.workshop_id, entity="payment",
               entity_id=row.id, action="refund", after=_payment_dict(row))
    db.commit()
    return _payment_dict(row)
