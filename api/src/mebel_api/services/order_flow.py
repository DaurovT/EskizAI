"""Жизненный цикл заказа у поставщика (docs/staff_vendor_contract.md §5.3–5.4).

created (в очереди поставщика) → accepted (проверен, счёт) → paid → cutting → ready → issued.
Побочные: returned (на правку мастеру → resubmit → created), awaiting_approval (исправление ждёт мастера →
accepted), rejected (финал), cancelled (мастер до оплаты; платформа — с причиной).
Совместимость: created → paid → accepted (оплата до проверки, как в админке) остаётся допустимым.

Каждый переход — в order_events (история заказа) и action_log; мастеру — push (services/events.py).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..domain import ORDER_STATUS_LABELS, OrderStatus as O, ProjectStatus as S
from ..errors import ApiError
from ..models import (
    Order,
    OrderDispute,
    OrderEvent,
    OrderMessage,
    OrderReturn,
    Project,
    StaffUser,
    Supplier,
    Workshop,
)
from .action_log import log_action

INACTIVE = {O.cancelled.value, O.rejected.value}  # заказ закрыт — по проекту можно оформить новый
UNPAID_OPEN = {O.created.value, O.accepted.value, O.returned.value, O.awaiting_approval.value}
PRODUCTION_NEXT = {O.paid.value: O.cutting.value, O.cutting.value: O.ready.value, O.ready.value: O.issued.value}
RETURN_KINDS = ("defect", "cut_error", "shortage", "cancel_after_pay", "other")
REJECT_REASONS = {  # коды — docs/staff_vendor_contract.md §9
    "no_material": "Нет материала / декора", "wrong_measurements": "Ошибка в замерах",
    "cannot_produce": "Невозможно изготовить", "duplicate": "Дубль заказа", "other": "Другое",
}
DISPUTE_REASONS = ("decision_unfair", "amount_wrong", "defect_not_accepted", "can_be_done", "other")
# Типы событий, которые видит мастер (OrderEvent.type, §9)
MASTER_EVENT_TYPES = {"status_changed", "correction_created", "correction_approved", "correction_declined",
                      "resubmitted", "return_opened", "return_decided", "dispute_opened", "dispute_resolved"}
ACTOR_TYPES = ("master", "vendor", "platform", "system")


def label(status: str) -> str:
    return ORDER_STATUS_LABELS.get(status, status)


def order_total(o: Order) -> int:
    return int(o.invoice_total if o.invoice_total is not None else (o.estimate_total or 0))


def event(db: Session, o: Order, kind: str, *, actor_type: str, actor_id: str | None, actor_name: str | None = None,
          from_status: str | None = None, to_status: str | None = None, comment: str | None = None,
          data: dict[str, Any] | None = None) -> OrderEvent:
    e = OrderEvent(order_id=o.id, kind=kind, actor_type=actor_type, actor_id=actor_id, actor_name=actor_name,
                   from_status=from_status, to_status=to_status, comment=comment, data=data)
    db.add(e)
    return e


def log_actor_type(actor_type: str) -> str:
    """Тип автора в истории заказа (master | vendor | platform | system) → actor_type в action_log."""
    return {"master": "user", "vendor": "staff", "platform": "staff"}.get(actor_type, actor_type)


def event_out(e: OrderEvent) -> dict[str, Any]:
    """OrderEvent = {id, type, status?, actor_type, actor_name?, comment?, data?, created_at} (§9)."""
    return {"id": str(e.id), "type": e.kind, "status": e.to_status, "from_status": e.from_status,
            "actor_type": e.actor_type, "actor_name": e.actor_name, "comment": e.comment, "data": e.data,
            "created_at": e.created_at}


def _workshop_id(db: Session, o: Order) -> uuid.UUID | None:
    p = db.get(Project, o.project_id)
    return p.workshop_id if p else None


def set_status(db: Session, o: Order, to: str, *, actor_type: str, actor_id: str | None, actor_name: str | None,
               comment: str | None = None, data: dict[str, Any] | None = None, push: bool = True,
               log: bool = True) -> None:
    """Переход без проверки (проверяют вызывающие): история, журнал, push мастеру."""
    before = o.status
    now = utcnow()
    o.status = to
    o.status_changed_at = now
    if to == O.cancelled:
        o.cancelled_at = now
    if to == O.accepted and o.accepted_at is None:
        o.accepted_at = now
    event(db, o, "status_changed", actor_type=actor_type, actor_id=actor_id, actor_name=actor_name,
          from_status=before, to_status=to, comment=comment, data=data)
    if log:
        log_action(db, actor_type=log_actor_type(actor_type), actor_id=actor_id,
                   workshop_id=_workshop_id(db, o), entity="order", entity_id=o.id, action="status",
                   before={"status": before}, after={"status": to, "comment": comment, **(data or {})})
    if push:
        from . import events

        events.order_status(db, o)


def ensure(o: Order, allowed: set[str] | tuple[str, ...], what: str) -> None:
    if o.status not in allowed:
        raise ApiError(409, "illegal_order_transition",
                       f"Нельзя {what}: заказ в статусе «{label(o.status)}»",
                       {"status": o.status, "allowed_from": sorted(allowed)})


# --- Оплата и комиссия ---


def accrue_commission(db: Session, o: Order) -> None:
    from .supplier_routes import order_commission

    supplier = db.get(Supplier, o.supplier_id) if o.supplier_id else None
    o.commission_amount = order_commission(db, supplier, o.composition, order_total(o), o.created_at or utcnow())
    o.commission_status = "accrued"


def reverse_commission(db: Session, o: Order, refund: int | None = None) -> int:
    """Сторно комиссии: на сумму возврата (по средней ставке заказа) или целиком (refund=None)."""
    accrued = o.commission_amount or 0
    if not accrued:
        return 0
    left = accrued - (o.commission_reversed or 0)
    if refund is None:
        amount = left
    else:
        total = order_total(o)
        amount = min(left, round(refund * accrued / total)) if total else 0
    o.commission_reversed = (o.commission_reversed or 0) + amount
    if o.commission_reversed >= accrued:
        o.commission_status = "reversed"
    return amount


def mark_paid(db: Session, o: Order, *, actor_type: str, actor_id: str | None, actor_name: str | None,
              project_actor: str = "admin", comment: str | None = None, log: bool = True) -> bool:
    """Отметка оплаты (менеджер, владелец/конструктор поставщика). Проект «Договор» → «В работе», лимит —
    обратно. Возвращает, вернулся ли проект в лимит."""
    from . import lifecycle
    from .limits import return_to_limit

    p = db.get(Project, o.project_id)
    returned = False
    if p is not None and S(p.status) == S.contract:
        workshop = db.get(Workshop, p.workshop_id)
        returned = return_to_limit(db, workshop, p)
        lifecycle.set_status(db, p, S.in_work, actor_user_id=None, actor=project_actor,
                             note="Заказ поставщику оплачен")
    elif p is not None and S(p.status) not in (S.in_work, S.delivered):
        lifecycle.ensure_transition(p, S.in_work)  # 409 illegal_transition
    now = utcnow()
    o.paid_at, o.payment_failed_at = now, None
    accrue_commission(db, o)
    set_status(db, o, O.paid, actor_type=actor_type, actor_id=actor_id, actor_name=actor_name, comment=comment,
               data={"commission": o.commission_amount, "returned_to_limit": returned}, log=log)
    return returned


def refunds_committed(db: Session, o: Order, *, exclude_return_id: uuid.UUID | None = None,
                      exclude_dispute_id: uuid.UUID | None = None) -> int:
    """Сколько по заказу уже обещано вернуть: возвраты «вернуть деньги» (ждут владельца или подтверждены)
    и решённые споры с суммой."""
    rq = select(func.coalesce(func.sum(OrderReturn.refund_amount), 0)).where(
        OrderReturn.order_id == o.id, OrderReturn.decision == "refund",
        OrderReturn.status.in_(["awaiting_owner", "resolved"]), OrderReturn.refund_amount.is_not(None))
    if exclude_return_id is not None:
        rq = rq.where(OrderReturn.id != exclude_return_id)
    dq = select(func.coalesce(func.sum(OrderDispute.refund_amount), 0)).where(
        OrderDispute.order_id == o.id, OrderDispute.status == "resolved", OrderDispute.refund_amount.is_not(None))
    if exclude_dispute_id is not None:
        dq = dq.where(OrderDispute.id != exclude_dispute_id)
    return int(db.scalar(rq) or 0) + int(db.scalar(dq) or 0)


def ensure_refund_fits(db: Session, o: Order, amount: int, *, exclude_return_id: uuid.UUID | None = None,
                       exclude_dispute_id: uuid.UUID | None = None) -> None:
    """Сумма всех возвратов денег и решений споров по заказу — не больше суммы заказа (счёт, иначе смета)."""
    total = order_total(o)
    room = max(total - refunds_committed(db, o, exclude_return_id=exclude_return_id,
                                         exclude_dispute_id=exclude_dispute_id), 0)
    if amount > room:
        raise ApiError(422, "invalid_refund",
                       f"Вместе с прежними возвратами сумма больше суммы заказа: можно вернуть не больше {room}",
                       {"max_refund": room, "order_total": total})


# --- Сообщения, непрочитанные ---


def unread_for_master(db: Session, o: Order) -> int:
    return db.scalar(select(func.count(OrderMessage.id)).where(
        OrderMessage.order_id == o.id, OrderMessage.author_type != "master",
        OrderMessage.read_by_master_at.is_(None))) or 0


def unread_for_vendor(db: Session, order_ids) -> int:
    return db.scalar(select(func.count(OrderMessage.id)).where(
        OrderMessage.order_id.in_(order_ids), OrderMessage.author_type == "master",
        OrderMessage.read_by_vendor_at.is_(None))) or 0


def message_out(m: OrderMessage, settings) -> dict[str, Any]:
    from .signed_files import attachment_out

    return {"id": str(m.id), "order_id": str(m.order_id), "author_type": m.author_type, "author_id": m.author_id,
            "author_name": m.author_name, "text": m.text,
            "attachments": [attachment_out(settings, a) for a in m.attachments or []],
            "created_at": m.created_at, "read_by_master_at": m.read_by_master_at,
            "read_by_vendor_at": m.read_by_vendor_at}


MAX_ATTACHMENT = 25 * 1024 * 1024
MAX_ATTACHMENTS = 10


async def store_files(storage, files, key_prefix: str, *, max_bytes: int = MAX_ATTACHMENT) -> list[dict[str, Any]]:
    """Вложения → закрытая зона хранилища (`private/…`, только по подписанной ссылке). Тип — по содержимому
    (services/uploads.py): заявленный клиентом `image/*` без картинки внутри или HTML/SVG — octet-stream."""
    from .uploads import display_name, key_name, safe_content_type

    out = []
    for f in (files or [])[:MAX_ATTACHMENTS]:
        data = await f.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ApiError(413, "file_too_large", f"Файл больше {max_bytes // (1024 * 1024)} МБ")
        if not data:
            continue
        fid = uuid.uuid4().hex
        name = display_name(f.filename)
        ct = safe_content_type(data, f.content_type)
        stored = storage.save(f"{key_prefix}/{fid}_{key_name(name)}", data, ct, private=True)
        out.append({"id": fid, "name": name, "key": stored.key, "content_type": ct, "size": len(data),
                    "uploaded_at": utcnow().isoformat()})
    return out


def post_message(db: Session, o: Order, *, author_type: str, author_id: str | None, author_name: str | None,
                 text: str, attachments: list[dict[str, Any]]) -> OrderMessage:
    text = (text or "").strip()
    if not text and not attachments:
        raise ApiError(422, "empty_message", "Напишите сообщение или приложите файл")
    now = utcnow()
    m = OrderMessage(order_id=o.id, author_type=author_type, author_id=author_id, author_name=author_name,
                     text=text[:5000], attachments=attachments,
                     read_by_master_at=now if author_type == "master" else None,
                     read_by_vendor_at=now if author_type == "vendor" else None)
    db.add(m)
    db.flush()
    if author_type != "master":
        from . import events

        events.order_message(db, o, m)
    return m


def mark_read(db: Session, o: Order, side: str) -> int:
    now = utcnow()
    col = OrderMessage.read_by_master_at if side == "master" else OrderMessage.read_by_vendor_at
    rows = list(db.scalars(select(OrderMessage).where(OrderMessage.order_id == o.id, col.is_(None),
                                                      OrderMessage.author_type != side)))
    for m in rows:
        if side == "master":
            m.read_by_master_at = now
        else:
            m.read_by_vendor_at = now
    return len(rows)


# --- Возвраты ---


def return_out(r: OrderReturn, settings, number: int | None = None) -> dict[str, Any]:
    """OrderReturn (§9): {id, order_id, number?, type, description, lines, amount?, photos, status, decision,
    decision_comment?, refund_amount?, created_by?, created_at, decided_at?}."""
    from .signed_files import attachment_out

    return {"id": str(r.id), "order_id": str(r.order_id), "number": number, "type": r.kind,
            "description": r.description, "lines": r.lines or [], "amount": r.amount,
            "photos": [attachment_out(settings, p) for p in r.photos or []],
            "status": r.status, "decision": r.decision, "decision_comment": r.decision_comment,
            "refund_amount": r.refund_amount, "created_by": r.opened_by_type, "created_at": r.created_at,
            "decided_at": r.decided_at, "resolved_at": r.resolved_at, "updated_at": r.updated_at}


def returns_of(db: Session, o: Order, settings) -> list[dict[str, Any]]:
    rows = list(db.scalars(select(OrderReturn).where(OrderReturn.order_id == o.id).order_by(OrderReturn.created_at)))
    return [return_out(r, settings, i + 1) for i, r in enumerate(rows)]


def dispute_out(d, settings) -> dict[str, Any]:
    """OrderDispute (§9): {id, order_id, subject, return_id?, reason, comment, photos, status, decision?,
    decision_comment?, amount?, created_at, resolved_at?}; amount — решённая сумма, до решения — запрошенная."""
    from .signed_files import attachment_out

    return {"id": str(d.id), "order_id": str(d.order_id), "subject": d.subject,
            "return_id": str(d.return_id) if d.return_id else None, "reason": d.reason, "comment": d.comment,
            "photos": [attachment_out(settings, p) for p in d.photos or []], "status": d.status,
            "decision": d.resolution, "decision_comment": d.decision_comment,
            "amount": d.refund_amount if d.resolution else d.amount, "requested_amount": d.amount,
            "created_at": d.created_at, "resolved_at": d.resolved_at}


def open_return(db: Session, o: Order, *, opened_by_type: str, opened_by: str | None, actor_name: str | None,
                kind: str, description: str, lines: list | None, amount: int | None,
                photos: list[dict[str, Any]]) -> OrderReturn:
    if o.paid_at is None or o.status in (O.cancelled, O.rejected):
        raise ApiError(409, "order_not_paid", "Возврат оформляется по оплаченному заказу")
    if kind not in RETURN_KINDS:
        raise ApiError(422, "validation_error", f"Тип возврата: {', '.join(RETURN_KINDS)}")
    if amount is not None and amount > order_total(o):
        raise ApiError(422, "validation_error", "Сумма больше суммы заказа")
    r = OrderReturn(order_id=o.id, opened_by_type=opened_by_type, opened_by=opened_by, kind=kind,
                    description=description.strip(), lines=lines or [], amount=amount, photos=photos, status="open")
    db.add(r)
    db.flush()
    event(db, o, "return_opened", actor_type=opened_by_type,
          actor_id=opened_by, actor_name=actor_name, comment=description[:500],
          data={"return_id": str(r.id), "kind": kind, "amount": amount})
    return r


def staff_name(db: Session, staff_id: uuid.UUID | str | None) -> str | None:
    if not staff_id:
        return None
    try:
        s = db.get(StaffUser, uuid.UUID(str(staff_id)))
    except ValueError:
        return None
    return s.name if s else None


def parse_due_date(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        raise ApiError(422, "validation_error", "Укажите часовой пояс срока, например 2026-11-10T18:00:00+05:00")
    return value
