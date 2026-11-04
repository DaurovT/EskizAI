"""Заказ поставщику из проекта в статусе «Договор» (раздел 16 PRD, SCR-14/15/16/31).

Состав и сумма — mebel_core.supplier_order() по замороженной версии: листы, распил, кромкование,
фурнитура по себестоимости; позиции «под запрос» (и оценённые, но ещё не принятые мастером) в заказ не входят;
доставка — по правилам EMAN (distance_km не задан — самовывоз). Передачу в EMAN, ссылку на оплату и отметку
оплаты в MVP делает менеджер (ADM-08): оплата идёт на мерчант EMAN, платформа видит только статус.
"""

import json
import uuid
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import Response
from mebel_core import build, estimate, nest, parse_tree, supplier_order
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..db import utcnow
from ..deps import CurrentDep, CurrentUser, DbDep, SettingsDep, StorageDep
from ..domain import ORDER_STATUS_LABELS, OrderStatus, ProjectStatus as S
from ..errors import ERROR_RESPONSES, ApiError, forbidden, not_found
from ..models import (
    ModelVersion,
    Order,
    OrderCorrection,
    OrderDispute,
    OrderEvent,
    OrderMessage,
    OrderReturn,
    Project,
    StaffUser,
    Supplier,
)
from ..services import lifecycle, order_flow as flow
from ..services.action_log import log_action
from .projects import get_project

router = APIRouter(tags=["orders"], responses=ERROR_RESPONSES)

ORDER_STEPS = [OrderStatus.created, OrderStatus.paid, OrderStatus.accepted, OrderStatus.cutting, OrderStatus.ready,
               OrderStatus.issued]
FIRST_ORDER_NUMBER = 1001


def order_version(db, p: Project) -> ModelVersion | None:
    return db.get(ModelVersion, p.frozen_version_id) if p.frozen_version_id else lifecycle.current_version(db, p)


def compose(version: ModelVersion, distance_km: float | None, db=None, project: Project | None = None) -> dict[str, Any]:
    """Снимок состава заказа поставщику (суммы — себестоимость, сумы)."""
    result = build(parse_tree(version.tree))
    nesting = nest(result)
    from ..services.prices import price_book_for

    prices = price_book_for(version)  # сессию берём из версии модели
    so = supplier_order(result, estimate(result, nesting=nesting, prices=prices), nesting, distance_km=distance_km)
    out = so.model_dump(mode="json")
    if db is not None and project is not None:
        from ..services.price_requests import apply_to_order

        out = apply_to_order(db, project, out)
    return out


def next_number(db) -> int:
    return max(FIRST_ORDER_NUMBER - 1, db.scalar(select(func.max(Order.number))) or 0) + 1


def payment_out(o: Order) -> dict[str, Any]:
    """SCR-31: ждёт / не прошла / оплачено; способ — click, payme или счёт EMAN; ссылка от EMAN (до интеграции)."""
    if o.paid_at is not None:
        status = "paid"
    elif o.payment_failed_at is not None:
        status = "failed"
    else:
        status = "waiting"
    return {"status": status, "method": o.payment_provider, "url": o.payment_url, "paid_at": o.paid_at,
            "reference": o.payment_reference}


NEW_STEPS = [OrderStatus.created, OrderStatus.accepted, OrderStatus.paid, OrderStatus.cutting, OrderStatus.ready,
             OrderStatus.issued]


def steps_out(o: Order) -> list[dict[str, Any]]:
    """Старый порядок (оплата до проверки поставщиком) — created → paid → accepted; новый — created → accepted → paid
    (docs/staff_vendor_contract.md §5.3). Побочные статусы показываются на шаге «Создан»."""
    old_flow = o.paid_at is not None and (o.accepted_at is None or o.paid_at <= o.accepted_at)
    steps = ORDER_STEPS if old_flow else NEW_STEPS
    if o.status in (OrderStatus.cancelled, OrderStatus.rejected):
        reached = -1
    elif o.status in (OrderStatus.returned, OrderStatus.awaiting_approval):
        reached = 0
    else:
        reached = steps.index(OrderStatus(o.status))
    out = []
    for i, st in enumerate(steps):
        at = None
        if st == OrderStatus.created:
            at = o.created_at
        elif st == OrderStatus.paid:
            at = o.paid_at
        elif st == OrderStatus.accepted and o.accepted_at is not None:
            at = o.accepted_at
        elif i == reached:
            at = o.status_changed_at
        out.append({"status": st.value, "label": ORDER_STATUS_LABELS[st.value], "done": i <= reached,
                    "current": i == reached, "at": at})
    return out


# Суммы в событиях, возвратах и спорах: сотрудник без права «видит себестоимость» их не получает.
# Комиссия платформы мастеру не показывается никогда (внутренние данные платформы и поставщика).
MONEY_KEYS = frozenset({"total", "amount", "refund_amount", "requested_amount", "invoice_total", "total_before",
                        "total_after", "delta", "commission"})
PLATFORM_KEYS = frozenset({"commission"})


def without(d: dict | None, keys: frozenset) -> dict | None:
    return {k: v for k, v in d.items() if k not in keys} if isinstance(d, dict) else d


def _event_for_master(e: OrderEvent, with_money: bool) -> dict[str, Any]:
    out = flow.event_out(e)
    out["data"] = without(out.get("data"), PLATFORM_KEYS if with_money else MONEY_KEYS)
    return out


def _order_counts(db, o: Order, with_money: bool = True) -> dict[str, Any]:
    if db is None:
        return {"unread_count": 0, "returns_count": 0, "disputes_count": 0, "events": []}
    events = db.scalars(select(OrderEvent).where(OrderEvent.order_id == o.id,
                                                 OrderEvent.kind.in_(flow.MASTER_EVENT_TYPES))
                        .order_by(OrderEvent.created_at))
    return {
        "unread_count": flow.unread_for_master(db, o),
        "returns_count": db.scalar(select(func.count(OrderReturn.id)).where(OrderReturn.order_id == o.id)) or 0,
        "disputes_count": db.scalar(select(func.count(OrderDispute.id)).where(OrderDispute.order_id == o.id)) or 0,
        "events": [_event_for_master(e, with_money) for e in events],
    }


def order_out(o: Order, with_money: bool = True, project: Project | None = None, db=None) -> dict:
    from sqlalchemy.orm import object_session

    db = db or object_session(o)
    supplier = db.get(Supplier, o.supplier_id) if db is not None and o.supplier_id else None
    assignee = db.get(StaffUser, o.assignee_id) if db is not None and o.assignee_id else None
    pending = db.scalar(select(OrderCorrection).where(OrderCorrection.order_id == o.id,
                                                      OrderCorrection.status == "pending").limit(1)) \
        if db is not None and o.status == OrderStatus.awaiting_approval else None
    comp = o.composition or {}
    lines = comp.get("lines") or []
    items = [{"key": l.get("key"), "name": l.get("name"), "qty": l.get("qty"), "unit": l.get("unit"),
              "price": l.get("price"), "amount": l.get("total"), "excluded": False} for l in lines]
    items += [{"key": None, "name": name, "qty": None, "unit": None, "price": None, "amount": None, "excluded": True}
              for name in comp.get("excluded") or []]
    out = {
        "id": str(o.id), "number": str(o.number) if o.number else str(o.id)[:8].upper(),
        "project_id": str(o.project_id), "project_title": project.title if project else None,
        "version_id": str(o.version_id) if o.version_id else None,
        "supplier": o.supplier, "status": o.status, "status_label": ORDER_STATUS_LABELS.get(o.status, o.status),
        "estimate_total": o.estimate_total, "invoice_total": o.invoice_total,
        "total": o.invoice_total if o.invoice_total is not None else o.estimate_total,
        "goods_total": comp.get("goods_total"), "delivery": comp.get("delivery"), "pickup": o.distance_km is None,
        "distance_km": o.distance_km, "weight_kg": comp.get("weight_kg"),
        "composition": o.composition, "items": items, "excluded": comp.get("excluded") or [],
        "payment": payment_out(o), "steps": steps_out(o),
        "cancellable": o.status in flow.UNPAID_OPEN and o.paid_at is None,
        "ready_date": o.due_date,
        # Счёт по составу заказа (PDF) — только тем, кто видит закупочные цены
        "documents": [{"kind": "invoice", "title": "Счёт EMAN", "format": "pdf",
                       "url": f"/orders/{o.id}/invoice"}] if with_money and o.composition else [],
        "paid_at": o.paid_at, "handed_over_at": o.handed_over_at, "created_at": o.created_at,
        # Поставщики и кабинет поставщика (docs/staff_vendor_contract.md §4, §5.6, форматы — §9) — только новые поля
        "group_id": str(o.group_id) if o.group_id else None,
        "supplier_id": str(o.supplier_id) if o.supplier_id else None,
        "supplier_name": supplier.name if supplier is not None else (o.supplier or "").upper() or None,
        "assignee": {"id": str(assignee.id), "name": assignee.name} if assignee is not None else None,
        "due_date": o.due_date, "accepted_at": o.accepted_at,
        "vendor_status_note": o.vendor_status_note, "reject_reason": o.reject_reason,
        "can_resubmit": o.status == OrderStatus.returned,
        "pending_correction_id": str(pending.id) if pending is not None else None,
        **_order_counts(db, o, with_money),
    }
    if not with_money:  # сотрудник не видит закупочные цены
        for k in ("estimate_total", "invoice_total", "composition", "total", "goods_total", "delivery"):
            out.pop(k)
        out["items"] = [{k: v for k, v in i.items() if k not in ("price", "amount")} for i in items]
        out["payment"] = {"status": out["payment"]["status"]}
    return out


class OrderIn(BaseModel):
    distance_km: float | None = Field(None, ge=0, le=500, description="Расстояние доставки; не задано — самовывоз")


def _ready_for_order(db, current, project_id: uuid.UUID) -> tuple[Project, ModelVersion]:
    if not current.can_order:
        raise forbidden("Заказ в EMAN оформляет владелец цеха или сотрудник с правом заказа")
    p = get_project(db, current, project_id)
    lifecycle.ensure_active(p)
    if S(p.status) != S.contract:
        raise ApiError(409, "illegal_transition", "Заказ оформляется из проекта в статусе «Договор»")
    v = order_version(db, p)
    if v is None or not v.ok:
        raise ApiError(409, "model_invalid", "Нужна модель без ошибок")
    return p, v


@router.get("/projects/{project_id}/orders/preview", summary="Состав и сумма заказа до оформления (SCR-14)")
def preview(project_id: uuid.UUID, current: CurrentDep, db: DbDep,
            distance_km: Annotated[float | None, Query(ge=0, le=500)] = None) -> dict:
    """`lines` — листы, распил, кромкование, фурнитура; `excluded` — позиции «под запрос» (не в заказе);
    `delivery` — доставка EMAN по весу и расстоянию (нет `distance_km` — самовывоз, `delivery: null`)."""
    p, v = _ready_for_order(db, current, project_id)
    return compose(v, distance_km, db, p)


@router.post("/projects/{project_id}/orders", status_code=201, summary="Оформить заказ в EMAN (из «Договора»)")
def create_order(project_id: uuid.UUID, current: CurrentDep, db: DbDep, body: OrderIn | None = None) -> dict:
    """Строки состава делятся по поставщикам (supplier_routes): по одному заказу на поставщика с общим `group_id`.
    Ответ — основной заказ (поставщик по умолчанию) в прежнем виде; все заказы группы — в `group_orders`."""
    from ..services.supplier_routes import split_composition

    p, v = _ready_for_order(db, current, project_id)
    active = db.scalar(select(Order).where(Order.project_id == p.id, Order.status.not_in(flow.INACTIVE)).limit(1))
    if active is not None:
        raise ApiError(409, "order_exists", "По проекту уже есть заказ")
    distance = body.distance_km if body else None
    composition = compose(v, distance, db, p)
    group_id = uuid.uuid4()
    orders = []
    for supplier, part in split_composition(db, composition):
        o = Order(project_id=p.id, version_id=v.id, number=next_number(db), status=OrderStatus.created,
                  estimate_total=part["total"], distance_km=distance, composition=part, created_by=current.user.id,
                  supplier=supplier.code if supplier else "platform", supplier_id=supplier.id if supplier else None,
                  group_id=group_id)
        db.add(o)
        db.flush()
        flow.event(db, o, "status_changed", actor_type="master", actor_id=str(current.user.id),
                   actor_name=current.user.name, to_status=OrderStatus.created)
        log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="order",
                   entity_id=o.id, action="create",
                   after={"number": o.number, "total": o.estimate_total, "supplier": o.supplier,
                          "group_id": str(group_id)})
        orders.append(o)
    db.commit()
    out = order_out(orders[0], project=p, db=db)
    out["group_orders"] = [{"id": str(o.id), "number": str(o.number), "supplier_id": str(o.supplier_id)
                            if o.supplier_id else None, "supplier": o.supplier, "status": o.status,
                            "total": o.estimate_total} for o in orders]
    return out


@router.get("/projects/{project_id}/orders", summary="Заказы проекта")
def list_project_orders(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> list[dict]:
    p = get_project(db, current, project_id)
    rows = db.scalars(select(Order).where(Order.project_id == p.id).order_by(Order.created_at.desc()))
    return [order_out(o, current.sees_cost, p, db) for o in rows]


def _get_order(db, current: CurrentUser, order_id: uuid.UUID) -> tuple[Order, Project]:
    o = db.get(Order, order_id)
    p = db.get(Project, o.project_id) if o else None
    if o is None or p is None or p.workshop_id != current.workshop.id:
        raise not_found("Заказ")
    return o, p


@router.get("/orders", summary="Заказы цеха (SCR-15)")
def list_orders(current: CurrentDep, db: DbDep,
                status: Annotated[list[OrderStatus] | None, Query(description="Фильтр по статусу")] = None,
                limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict:
    stmt = (select(Order, Project).join(Project, Order.project_id == Project.id)
            .where(Project.workshop_id == current.workshop.id))
    if status:
        stmt = stmt.where(Order.status.in_([s.value for s in status]))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(stmt.order_by(Order.created_at.desc()).limit(limit).offset(offset)).all()
    return {"items": [order_out(o, current.sees_cost, p, db) for o, p in rows], "total": total, "limit": limit,
            "offset": offset}


@router.get("/orders/{order_id}", summary="Карточка заказа: позиции, шаги, оплата (SCR-16, SCR-31)")
def get_order(order_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    o, p = _get_order(db, current, order_id)
    return order_out(o, current.sees_cost, p, db)


@router.get("/orders/{order_id}/invoice", summary="Счёт EMAN по заказу (PDF)",
            responses={200: {"content": {"application/pdf": {}}}})
def order_invoice(order_id: uuid.UUID, current: CurrentDep, db: DbDep) -> Response:
    """Собирается из состава заказа (документа от EMAN в системе пока нет). Сотрудник без права видеть
    себестоимость счёт не получает (закупочные цены)."""
    if not current.sees_cost:
        raise forbidden("Счёт с закупочными ценами видит владелец цеха")
    o, p = _get_order(db, current, order_id)
    if not o.composition:
        raise ApiError(409, "invoice_missing", "По заказу нет состава — счёт не собрать")
    from ..models import Supplier
    from ..services.invoice import invoice_pdf

    supplier = db.scalar(select(Supplier).where(Supplier.code == o.supplier))
    lang = current.user.language
    data = invoice_pdf(o, p, current.workshop, lang, supplier.name if supplier else o.supplier.upper())
    number = o.number or str(o.id)[:8].upper()
    name = f"{'EMAN_hisob' if lang == 'uz' else 'Счёт_EMAN'}_{number}.pdf"
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename=\"EMAN_invoice_{number}.pdf\"; "
                                                    f"filename*=UTF-8''{quote(name)}"})


class CancelOrderIn(BaseModel):
    reason: str | None = Field(None, max_length=500)


@router.post("/orders/{order_id}/cancel", summary="Отменить заказ до оплаты (SCR-40)")
def cancel_order(order_id: uuid.UUID, body: CancelOrderIn, current: CurrentDep, db: DbDep) -> dict:
    """Мастер отменяет сам только неоплаченный заказ. Оплаченный — через менеджера EMAN (возврат по их правилам)."""
    if not current.can_order:
        raise forbidden("Заказ отменяет владелец цеха или сотрудник с правом заказа")
    o, p = _get_order(db, current, order_id)
    if o.status not in flow.UNPAID_OPEN or o.paid_at is not None:
        raise ApiError(409, "order_not_cancellable",
                       "Оплаченный заказ отменяет менеджер EMAN (до распила, с возвратом по их правилам). Напишите менеджеру")
    o.notes = body.reason or o.notes
    flow.set_status(db, o, OrderStatus.cancelled, actor_type="master", actor_id=str(current.user.id),
                    actor_name=current.user.name, comment=body.reason, push=False)
    log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="order",
               entity_id=o.id, action="cancel", after={"reason": body.reason})
    db.commit()
    return order_out(o, True, p, db)


# --- Заказ у поставщика: переписка, исправления, повторная отправка, возвраты, споры (§5.6, форматы — §9) ---


def _can_act(current: CurrentUser) -> None:
    if not current.can_order:
        raise forbidden("Это делает владелец цеха или сотрудник с правом заказа")


def _card(db, current: CurrentUser, o: Order, p: Project) -> dict:
    return order_out(o, current.sees_cost, p, db)


@router.get("/orders/{order_id}/messages", summary="Переписка с поставщиком по заказу")
def master_messages(order_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> dict:
    """Переписка, возвраты, споры и исправления — владелец или сотрудник с правом заказа (иначе 403)."""
    _can_act(current)
    o, _ = _get_order(db, current, order_id)
    rows = db.scalars(select(OrderMessage).where(OrderMessage.order_id == o.id).order_by(OrderMessage.created_at))
    return {"items": [flow.message_out(m, settings) for m in rows], "unread_count": flow.unread_for_master(db, o)}


@router.post("/orders/{order_id}/messages", status_code=201, summary="Написать поставщику (text + повторяющееся files)")
async def master_post_message(order_id: uuid.UUID, current: CurrentDep, db: DbDep, storage: StorageDep,
                              settings: SettingsDep, text: Annotated[str, Form(max_length=5000)] = "",
                              files: Annotated[list[UploadFile] | None, File(description="Фото и файлы")] = None
                              ) -> dict:
    _can_act(current)
    o, p = _get_order(db, current, order_id)
    attachments = await flow.store_files(storage, files, f"workshops/{p.workshop_id}/orders/{o.id}/messages")
    m = flow.post_message(db, o, author_type="master", author_id=str(current.user.id),
                          author_name=current.user.name or "Мастер", text=text, attachments=attachments)
    db.commit()
    return flow.message_out(m, settings)


@router.post("/orders/{order_id}/messages/read", summary="Отметить сообщения поставщика прочитанными (тело {})")
def master_read_messages(order_id: uuid.UUID, current: CurrentDep, db: DbDep, body: dict | None = None) -> dict:
    _can_act(current)
    o, _ = _get_order(db, current, order_id)
    n = flow.mark_read(db, o, "master")
    db.commit()
    return {"ok": True, "marked": n}


LINE_MONEY_KEYS = frozenset({"price", "total", "amount"})


def correction_out(db, c: OrderCorrection, settings, with_money: bool = True) -> dict:
    """OrderCorrection (§9). Без права «видит себестоимость» — без сумм и цен строк."""
    from ..services.signed_files import attachment_out

    author = db.get(StaffUser, c.author_id) if c.author_id else None
    out = {"id": str(c.id), "order_id": str(c.order_id), "author_name": author.name if author else None,
           "comment": c.comment, "lines_before": c.lines_before, "lines_after": c.lines_after,
           "total_before": c.total_before, "total_after": c.total_after, "delta": c.total_after - c.total_before,
           "files": [attachment_out(settings, f) for f in c.files or []], "status": c.status,
           "master_comment": c.decision_comment, "decided_at": c.decided_at, "created_at": c.created_at}
    if not with_money:
        out = without(out, MONEY_KEYS)
        for k in ("lines_before", "lines_after"):
            out[k] = [without(line, LINE_MONEY_KEYS) for line in out[k] or []]
    return out


@router.get("/orders/{order_id}/corrections", summary="Исправления заказа от поставщика")
def master_corrections(order_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> dict:
    """Владелец или сотрудник с правом заказа; суммы и цены — только с правом «видит себестоимость»."""
    _can_act(current)
    o, _ = _get_order(db, current, order_id)
    rows = db.scalars(select(OrderCorrection).where(OrderCorrection.order_id == o.id)
                      .order_by(OrderCorrection.created_at.desc()))
    return {"items": [correction_out(db, c, settings, current.sees_cost) for c in rows]}


def _pending_correction(db, o: Order, correction_id: uuid.UUID) -> OrderCorrection:
    c = db.get(OrderCorrection, correction_id)
    if c is None or c.order_id != o.id:
        raise not_found("Исправление")
    if c.status != "pending" or o.status != OrderStatus.awaiting_approval:
        raise ApiError(409, "correction_decided", "Исправление уже рассмотрено")
    return c


def apply_correction(o: Order, c: OrderCorrection) -> None:
    comp = dict(o.composition or {})
    delivery = comp.get("delivery")
    goods = sum(int(l.get("total") or 0) for l in c.lines_after)
    comp.update(lines=c.lines_after, goods_total=goods, total=goods + (int(delivery["cost"]) if delivery else 0))
    o.composition = comp
    o.invoice_total = c.total_after


@router.post("/orders/{order_id}/corrections/{correction_id}/approve",
             summary="Подтвердить исправление поставщика → OrderOut")
def master_approve_correction(order_id: uuid.UUID, correction_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    """Подтвердить новую сумму может только тот, кто её видит: право заказа и право «видит себестоимость»."""
    _can_act(current)
    if not current.sees_cost:
        raise forbidden("Исправление с новой суммой подтверждает владелец цеха или сотрудник, который видит цены")
    o, p = _get_order(db, current, order_id)
    c = _pending_correction(db, o, correction_id)
    apply_correction(o, c)
    c.status, c.decided_by, c.decided_at = "approved", current.user.id, utcnow()
    kw = {"actor_type": "master", "actor_id": str(current.user.id), "actor_name": current.user.name}
    flow.event(db, o, "correction_approved", **kw, data={"correction_id": str(c.id), "total": c.total_after})
    flow.set_status(db, o, OrderStatus.accepted, **kw, comment="Исправление подтверждено",
                    data={"correction_id": str(c.id), "total": c.total_after}, push=False)
    db.commit()
    return _card(db, current, o, p)


class DeclineIn(BaseModel):
    comment: str | None = Field(None, max_length=2000)


@router.post("/orders/{order_id}/corrections/{correction_id}/decline",
             summary="Отказаться от исправления {comment} → OrderOut")
def master_decline_correction(order_id: uuid.UUID, correction_id: uuid.UUID, current: CurrentDep, db: DbDep,
                              body: DeclineIn | None = None) -> dict:
    """Заказ возвращается в прежний статус, обсуждение — в переписке (комментарий уходит сообщением)."""
    _can_act(current)
    o, p = _get_order(db, current, order_id)
    c = _pending_correction(db, o, correction_id)
    comment = (body.comment or "").strip() or None if body else None
    c.status, c.decided_by, c.decided_at, c.decision_comment = "declined", current.user.id, utcnow(), comment
    kw = {"actor_type": "master", "actor_id": str(current.user.id), "actor_name": current.user.name}
    flow.event(db, o, "correction_declined", **kw, comment=comment, data={"correction_id": str(c.id)})
    flow.set_status(db, o, c.prev_status or OrderStatus.created, **kw, comment=comment or "Исправление отклонено",
                    data={"correction_id": str(c.id)}, push=False)
    if comment:
        flow.post_message(db, o, author_type="master", author_id=str(current.user.id),
                          author_name=current.user.name or "Мастер", text=f"Не согласен с исправлением: {comment}",
                          attachments=[])
    db.commit()
    return _card(db, current, o, p)


@router.post("/orders/{order_id}/resubmit", summary="Отправить заказ заново после «Вернуть мастеру» → OrderOut")
def master_resubmit(order_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    """Берёт текущую версию проекта (правки после возврата) и делает её договорной: состав пересчитывается,
    строки — те, что идут этому поставщику."""
    from ..services.supplier_routes import split_composition

    _can_act(current)
    o, p = _get_order(db, current, order_id)
    if o.status != OrderStatus.returned:
        raise ApiError(409, "illegal_transition", "Повторно отправить можно заказ, возвращённый на правку",
                       {"status": o.status})
    p, _ = _ready_for_order(db, current, p.id)
    # Мастер исправил проект новой версией (договорная заморожена) — заново уходит текущая версия,
    # она же становится договорной: файлы и смета проекта совпадают с заказом.
    v = lifecycle.current_version(db, p)
    if v is None or not v.ok:
        raise ApiError(409, "model_invalid", "Нужна модель без ошибок")
    if p.frozen_version_id != v.id:
        v.frozen_at = v.frozen_at or utcnow()
        p.frozen_version_id = v.id
    composition = compose(v, o.distance_km, db, p)
    parts = split_composition(db, composition)
    part = next((c for s, c in parts if (s.id if s else None) == o.supplier_id), None)
    if part is None:
        if len(parts) != 1:
            raise ApiError(409, "illegal_transition", "В новой версии нет позиций для этого поставщика")
        part = parts[0][1]
    before = o.status
    o.version_id, o.composition, o.estimate_total, o.invoice_total = v.id, part, part["total"], None
    o.status, o.status_changed_at = OrderStatus.created, utcnow()
    flow.event(db, o, "resubmitted", actor_type="master", actor_id=str(current.user.id), actor_name=current.user.name,
               from_status=before, to_status=OrderStatus.created,
               data={"version_id": str(v.id), "version_number": v.number, "total": part["total"]})
    log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="order",
               entity_id=o.id, action="resubmit", after={"version_id": str(v.id), "total": part["total"]})
    db.commit()
    return _card(db, current, o, p)


@router.get("/orders/{order_id}/returns", summary="Возвраты и рекламации по заказу")
def master_returns(order_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> dict:
    _can_act(current)
    o, _ = _get_order(db, current, order_id)
    return {"items": [_money(r, current) for r in flow.returns_of(db, o, settings)]}


def _money(item: dict, current: CurrentUser) -> dict:
    """Возврат/спор: суммы — только тем, кто видит себестоимость."""
    return item if current.sees_cost else without(item, MONEY_KEYS)


def parse_lines(raw: str | None) -> list[dict]:
    if not raw:
        return []
    try:
        lines = json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(422, "validation_error", "lines — JSON-строка со списком позиций") from None
    if not isinstance(lines, list) or len(lines) > 200 or not all(isinstance(x, dict) for x in lines):
        raise ApiError(422, "validation_error", "lines — список позиций [{key?, name, unit?, qty}]")
    out = []
    for l in lines:
        try:
            qty = float(l.get("qty") or 0)
        except (TypeError, ValueError):
            raise ApiError(422, "validation_error", "qty — число") from None
        out.append({"key": str(l["key"])[:120] if l.get("key") else None, "name": str(l.get("name") or "")[:300],
                    "unit": str(l["unit"])[:20] if l.get("unit") else None, "qty": qty})
    return out


@router.post("/orders/{order_id}/returns", status_code=201,
             summary="Открыть рекламацию: type, description, lines (JSON), повторяющееся files")
async def master_open_return(
    order_id: uuid.UUID, current: CurrentDep, db: DbDep, storage: StorageDep, settings: SettingsDep,
    type: Annotated[str, Form(description="defect | cut_error | shortage | cancel_after_pay | other")],
    description: Annotated[str, Form(min_length=3, max_length=5000)],
    lines: Annotated[str | None, Form(description="JSON: [{key?, name, unit?, qty}]")] = None,
    amount: Annotated[int | None, Form(ge=0)] = None,
    files: Annotated[list[UploadFile] | None, File(description="Фото")] = None,
) -> dict:
    _can_act(current)
    o, p = _get_order(db, current, order_id)
    parsed = parse_lines(lines)
    if not current.sees_cost:  # сотрудник не видит суммы заказа — сумму возврата не задаёт
        amount = None
    if o.paid_at is None or o.status in flow.INACTIVE:
        raise ApiError(409, "order_not_paid", "Возврат оформляется по оплаченному заказу")
    photos = await flow.store_files(storage, files, f"workshops/{p.workshop_id}/orders/{o.id}/returns")
    r = flow.open_return(db, o, opened_by_type="master", opened_by=str(current.user.id),
                         actor_name=current.user.name, kind=type, description=description, lines=parsed,
                         amount=amount, photos=photos)
    log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="order_return",
               entity_id=r.id, action="create", after={"order_id": str(o.id), "type": type, "amount": amount})
    db.commit()
    number = db.scalar(select(func.count(OrderReturn.id)).where(OrderReturn.order_id == o.id))
    return _money(flow.return_out(r, settings, number), current)


@router.get("/orders/{order_id}/disputes", summary="Споры по заказу")
def master_disputes(order_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> dict:
    _can_act(current)
    o, _ = _get_order(db, current, order_id)
    rows = db.scalars(select(OrderDispute).where(OrderDispute.order_id == o.id).order_by(OrderDispute.created_at))
    return {"items": [_money(flow.dispute_out(d, settings), current) for d in rows]}


@router.post("/orders/{order_id}/disputes", status_code=201,
             summary="Открыть спор: subject, return_id, reason, comment, повторяющееся files")
async def master_open_dispute(
    order_id: uuid.UUID, current: CurrentDep, db: DbDep, storage: StorageDep, settings: SettingsDep,
    subject: Annotated[str, Form(description="return | rejection")],
    reason: Annotated[str, Form(description=", ".join(flow.DISPUTE_REASONS))],
    comment: Annotated[str, Form(max_length=5000)] = "",
    return_id: Annotated[uuid.UUID | None, Form()] = None,
    amount: Annotated[int | None, Form(ge=0)] = None,
    files: Annotated[list[UploadFile] | None, File(description="Фото")] = None,
) -> dict:
    """Не согласен с отклонением заказа или решением по возврату → очередь споров суперадмина.
    Один спор на отклонение и один на каждый решённый возврат."""
    _can_act(current)
    o, p = _get_order(db, current, order_id)
    if not current.sees_cost:
        amount = None
    if subject not in ("return", "rejection"):
        raise ApiError(422, "validation_error", "subject: return | rejection")
    if reason not in flow.DISPUTE_REASONS:
        raise ApiError(422, "validation_error", f"reason: {', '.join(flow.DISPUTE_REASONS)}")
    ret = None
    if subject == "return":
        if return_id is None:
            raise ApiError(422, "validation_error", "Для спора по возврату нужен return_id")
        ret = db.get(OrderReturn, return_id)
        if ret is None or ret.order_id != o.id:
            raise not_found("Возврат")
        if ret.decision is None:
            raise ApiError(409, "return_not_decided", "Спор открывается после решения поставщика по возврату")
        dup = select(OrderDispute.id).where(OrderDispute.return_id == ret.id)
    else:
        if o.status != OrderStatus.rejected:
            raise ApiError(409, "illegal_transition", "Спор об отклонении — по отклонённому заказу",
                           {"status": o.status})
        dup = select(OrderDispute.id).where(OrderDispute.order_id == o.id, OrderDispute.subject == "rejection")
    if db.scalar(dup.limit(1)) is not None:
        raise ApiError(409, "dispute_exists", "Спор по этому решению уже открыт")
    photos = await flow.store_files(storage, files, f"workshops/{p.workshop_id}/orders/{o.id}/disputes")
    d = OrderDispute(order_id=o.id, return_id=ret.id if ret else None, opened_by=current.user.id, subject=subject,
                     reason=reason, comment=comment.strip(), photos=photos, amount=amount, status="open")
    db.add(d)
    db.flush()
    flow.event(db, o, "dispute_opened", actor_type="master", actor_id=str(current.user.id),
               actor_name=current.user.name, comment=comment[:500] or None,
               data={"dispute_id": str(d.id), "subject": subject, "reason": reason,
                     "return_id": str(ret.id) if ret else None})
    log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="order_dispute",
               entity_id=d.id, action="create", after={"order_id": str(o.id), "subject": subject, "reason": reason})
    db.commit()
    return _money(flow.dispute_out(d, settings), current)
