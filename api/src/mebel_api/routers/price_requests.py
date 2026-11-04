"""Цены «под запрос»: мастер (SCR-30) и очередь менеджера каталога (ADM-07)."""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..deps import PriceRequestsDep, CurrentDep, DbDep
from ..errors import ERROR_RESPONSES, ApiError, forbidden, not_found
from ..models import PriceRequest, Project, Workshop
from ..services import lifecycle, price_requests as prs
from ..services.estimate import compute_range, is_measured, remember
from .projects import get_project

router = APIRouter(tags=["estimates"], responses=ERROR_RESPONSES)


def _get(db, p: Project, request_id: uuid.UUID) -> PriceRequest:
    r = db.get(PriceRequest, request_id)
    if r is None or r.project_id != p.id:
        raise not_found("Позиция")
    return r


@router.get("/projects/{project_id}/price-requests", summary="Позиции «под запрос»: цена, срок, разница (SCR-30)")
def list_requests(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> list[dict]:
    """Очередь заполняется при расчёте сметы. `delta` — разница со сметой (сумы, по себестоимости)."""
    if not current.sees_cost:
        raise forbidden("Цены поставщика видит владелец цеха")
    p = get_project(db, current, project_id)
    if not db.scalar(select(func.count(PriceRequest.id)).where(PriceRequest.project_id == p.id)):
        version = lifecycle.current_version(db, p)  # сметы ещё не считали — посчитаем, чтобы очередь появилась
        remember(db, p, version, compute_range(version, current.workshop, measured=is_measured(p)))
    rows = db.scalars(select(PriceRequest).where(PriceRequest.project_id == p.id).order_by(PriceRequest.created_at))
    return [prs.out(r) for r in rows]


def _decide(project_id: uuid.UUID, request_id: uuid.UUID, current, db, accept: bool) -> dict:
    if not current.is_owner:
        raise forbidden("Решение по цене принимает владелец цеха")
    p = get_project(db, current, project_id)
    r = prs.decide(db, _get(db, p, request_id), accept, current.user.id)
    db.commit()
    return prs.out(r)


@router.post("/projects/{project_id}/price-requests/{request_id}/accept", summary="Принять цену: позиция идёт в заказ")
def accept(project_id: uuid.UUID, request_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    return _decide(project_id, request_id, current, db, True)


@router.post("/projects/{project_id}/price-requests/{request_id}/decline",
             summary="Отказаться: позиция не идёт в заказ (замену — словами в чате или SCR-26)")
def decline(project_id: uuid.UUID, request_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    return _decide(project_id, request_id, current, db, False)


# --- Админка (ADM-07) ---

admin_router = APIRouter(prefix="/admin/price-requests", tags=["admin"], responses=ERROR_RESPONSES)


@admin_router.get("", summary="Очередь позиций «под запрос» (ADM-07)")
def admin_list(admin: PriceRequestsDep, db: DbDep,
               status: Annotated[list[str] | None, Query(description="pending, priced, accepted, declined")] = None,
               limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)) -> dict:
    stmt = select(PriceRequest, Project, Workshop).join(Project, PriceRequest.project_id == Project.id) \
        .join(Workshop, PriceRequest.workshop_id == Workshop.id).where(Project.deleted_at.is_(None))
    if status:
        stmt = stmt.where(PriceRequest.status.in_(status))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(stmt.order_by(PriceRequest.created_at).limit(limit).offset(offset)).all()
    return {"items": [{**prs.out(r, p), "workshop_name": w.name, "catalog_target": prs.catalog_target(r.line_key)}
                      for r, p, w in rows], "total": total, "limit": limit, "offset": offset}


class PriceIn(BaseModel):
    price: int = Field(gt=0, description="Цена за единицу, сумы")
    lead_days: int | None = Field(None, ge=0, le=365, description="Срок поставки, дней")
    supplier_name: str | None = Field(None, max_length=200, description="EMAN или партнёр")
    note: str | None = Field(None, max_length=500)
    save_to_catalog: bool = Field(True, description="Сохранить в справочник — следующие сметы возьмут эту цену")
    valid_until: datetime | None = Field(None, description="Цена действует до; нет — 7 дней от сегодня")


@admin_router.post("/{request_id}/price", summary="Ввести цену и срок; сохранить в каталог; push мастеру")
def admin_price(request_id: uuid.UUID, body: PriceIn, admin: PriceRequestsDep, db: DbDep) -> dict:
    r = db.get(PriceRequest, request_id)
    if r is None:
        raise not_found("Позиция")
    if body.valid_until is not None and body.valid_until.tzinfo is None:
        raise ApiError(422, "validation_error", "Укажите часовой пояс, например 2026-11-10T18:00:00+05:00")
    applied = prs.set_price(db, r, price=body.price, lead_days=body.lead_days, supplier_name=body.supplier_name,
                            note=body.note, save_to_catalog=body.save_to_catalog, actor=admin.id,
                            valid_until=body.valid_until)
    db.commit()
    return {**prs.out(r, db.get(Project, r.project_id)), "applied_to": [str(x.id) for x in applied]}
