"""Заказ поставщику из проекта в статусе «Договор» (раздел 16 PRD, SCR-14/15/16/31).

Состав и сумма — mebel_core.supplier_order() по замороженной версии: листы, распил, кромкование,
фурнитура по себестоимости; позиции «под запрос» (и оценённые, но ещё не принятые мастером) в заказ не входят;
доставка — по правилам EMAN (distance_km не задан — самовывоз). Передачу в EMAN, ссылку на оплату и отметку
оплаты в MVP делает менеджер (ADM-08): оплата идёт на мерчант EMAN, платформа видит только статус.
"""

import uuid
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.responses import Response
from mebel_core import build, estimate, nest, parse_tree, supplier_order
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..db import utcnow
from ..deps import CurrentDep, CurrentUser, DbDep
from ..domain import ORDER_STATUS_LABELS, OrderStatus, ProjectStatus as S
from ..errors import ERROR_RESPONSES, ApiError, forbidden, not_found
from ..models import ModelVersion, Order, Project
from ..services import lifecycle
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


def steps_out(o: Order) -> list[dict[str, Any]]:
    if o.status == OrderStatus.cancelled:
        reached = -1
    else:
        reached = ORDER_STEPS.index(OrderStatus(o.status))
    out = []
    for i, st in enumerate(ORDER_STEPS):
        at = None
        if st == OrderStatus.created:
            at = o.created_at
        elif st == OrderStatus.paid:
            at = o.paid_at
        elif i == reached:
            at = o.status_changed_at
        out.append({"status": st.value, "label": ORDER_STATUS_LABELS[st.value], "done": i <= reached,
                    "current": i == reached, "at": at})
    return out


def order_out(o: Order, with_money: bool = True, project: Project | None = None) -> dict:
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
        "cancellable": o.status == OrderStatus.created,
        "ready_date": None,
        # Счёт по составу заказа (PDF) — только тем, кто видит закупочные цены
        "documents": [{"kind": "invoice", "title": "Счёт EMAN", "format": "pdf",
                       "url": f"/orders/{o.id}/invoice"}] if with_money and o.composition else [],
        "paid_at": o.paid_at, "handed_over_at": o.handed_over_at, "created_at": o.created_at,
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
    p, v = _ready_for_order(db, current, project_id)
    active = db.scalar(select(Order).where(Order.project_id == p.id, Order.status != OrderStatus.cancelled).limit(1))
    if active is not None:
        raise ApiError(409, "order_exists", "По проекту уже есть заказ")
    distance = body.distance_km if body else None
    composition = compose(v, distance, db, p)
    o = Order(project_id=p.id, version_id=v.id, number=next_number(db), status=OrderStatus.created,
              estimate_total=composition["total"], distance_km=distance, composition=composition,
              created_by=current.user.id)
    db.add(o)
    db.flush()
    log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="order",
               entity_id=o.id, action="create", after={"number": o.number, "total": o.estimate_total})
    db.commit()
    return order_out(o, project=p)


@router.get("/projects/{project_id}/orders", summary="Заказы проекта")
def list_project_orders(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> list[dict]:
    p = get_project(db, current, project_id)
    rows = db.scalars(select(Order).where(Order.project_id == p.id).order_by(Order.created_at.desc()))
    return [order_out(o, current.sees_cost, p) for o in rows]


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
    return {"items": [order_out(o, current.sees_cost, p) for o, p in rows], "total": total, "limit": limit,
            "offset": offset}


@router.get("/orders/{order_id}", summary="Карточка заказа: позиции, шаги, оплата (SCR-16, SCR-31)")
def get_order(order_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    o, p = _get_order(db, current, order_id)
    return order_out(o, current.sees_cost, p)


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
    if o.status != OrderStatus.created:
        raise ApiError(409, "order_not_cancellable",
                       "Оплаченный заказ отменяет менеджер EMAN (до распила, с возвратом по их правилам). Напишите менеджеру")
    o.status, o.cancelled_at, o.status_changed_at = OrderStatus.cancelled, utcnow(), utcnow()
    o.notes = body.reason or o.notes
    log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="order",
               entity_id=o.id, action="cancel", after={"reason": body.reason})
    db.commit()
    return order_out(o, True, p)
