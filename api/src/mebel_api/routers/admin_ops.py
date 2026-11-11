"""Рабочие экраны суперадмина (docs/staff_vendor_contract.md §4a, §8 «Админка: рабочие экраны»).

- Цеха: список с поиском, фильтрами, сортировкой по любому показателю и выгрузкой CSV; вкладки карточки
  (сводка и сотрудники цеха, платежи, расход ИИ по дням и проектам, журнал), сброс лимита месяца с причиной.
- Заказы: фильтры по поставщику, цеху, статусу, периоду и просрочке; SLA — сколько заказ в текущем статусе,
  кто должен действовать, просрочен ли; комиссия заказа (начислена / сторно / ожидается).
- Поставщики: показатели за период (очередь, медиана принятия, просрочки, возвраты, оборот, комиссия, долг).
- Деньги: сводный отчёт за период CSV.
- Сотрудники платформы и поставщиков: роль, последний вход, 2FA, активные сессии, закрытый вход.

Маршруты регистрируются раньше admin_panel / admin_platform (см. main.py): `GET /admin/workshops` и
`GET /admin/orders` здесь — расширенные версии прежних (ответ — надмножество прежнего).
"""

import csv
import io
import statistics
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from mebel_core.exports.csv_safe import SafeWriter
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, or_, select, type_coerce
from sqlalchemy.sql.elements import ColumnElement

from ..db import UTCDateTime, utcnow
from ..deps import (
    DbDep,
    FinanceDep,
    OrdersDep,
    SettingsDep,
    StaffActor,
    SuppliersReadDep,
    WorkshopsGrantDep,
    WorkshopsViewDep,
    require_reason,
    require_staff,
)
from ..domain import ChargeSource, OrderStatus, ProjectStatus
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import (
    ActionLog,
    AiRequest,
    ExtraCharge,
    Order,
    OrderReturn,
    Payment,
    Project,
    StaffSession,
    StaffUser,
    Supplier,
    User,
    Workshop,
)
from ..services import finance
from ..services.action_log import log_action, staff_names
from ..services.app_settings import all_settings
from ..services.limits import limit_state, period_of

router = APIRouter(prefix="/admin", tags=["admin"], responses=ERROR_RESPONSES)

TZ = ZoneInfo("Asia/Tashkent")
StaffAdminDep = Annotated[StaffActor, Depends(require_staff("staff.manage", legacy="no"))]


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _usd(micro: int | None) -> float:
    return round((micro or 0) / 1_000_000, 4)


def _workshop(db, workshop_id: uuid.UUID) -> Workshop:
    w = db.get(Workshop, workshop_id)
    if w is None:
        raise not_found("Цех")
    return w


def _overdue_hours(db, settings) -> int:
    return int(all_settings(db, settings).get("vendor_overdue_hours") or 24)


def _later(a: ColumnElement, b: ColumnElement) -> ColumnElement:
    """Большее из двух времён, NULL не мешает (GREATEST есть не во всех базах)."""
    return case((a.is_(None), b), (b.is_(None), a), (a > b, a), else_=b)


# --- Цеха: список ---

WorkshopSort = Literal["created_at", "last_activity", "projects", "orders", "turnover", "ai_spend", "plan", "name"]


def _paid_amount() -> ColumnElement:
    return case((and_(Order.paid_at.is_not(None), Order.status != OrderStatus.cancelled),
                 func.coalesce(Order.invoice_total, Order.estimate_total, 0)), else_=0)


def _workshops_stmt(*, q: str | None, city: str | None, plan: str | None, active_days: int | None,
                    inactive_days: int | None, blocked: bool | None, has_orders: bool | None):
    proj = (select(Project.workshop_id.label("wid"), func.count(Project.id).label("n"),
                   func.max(Project.updated_at).label("last"))
            .where(Project.deleted_at.is_(None)).group_by(Project.workshop_id).subquery())
    ords = (select(Project.workshop_id.label("wid"), func.count(Order.id).label("n"),
                   func.sum(_paid_amount()).label("turnover"))
            .join(Project, Order.project_id == Project.id).group_by(Project.workshop_id).subquery())
    ai = (select(AiRequest.workshop_id.label("wid"), func.sum(AiRequest.cost_microusd).label("cost"),
                 func.max(AiRequest.created_at).label("last"))
          .where(AiRequest.workshop_id.is_not(None)).group_by(AiRequest.workshop_id).subquery())
    usr = (select(User.workshop_id.label("wid"), func.max(User.last_login_at).label("last"),
                  func.count(User.id).label("n"))
           .group_by(User.workshop_id).subquery())
    last = type_coerce(_later(_later(proj.c.last, usr.c.last), ai.c.last), UTCDateTime)
    cols = {
        "projects": func.coalesce(proj.c.n, 0), "orders": func.coalesce(ords.c.n, 0),
        "turnover": func.coalesce(ords.c.turnover, 0), "ai_spend": func.coalesce(ai.c.cost, 0),
        "last_activity": last, "members": func.coalesce(usr.c.n, 0),
    }
    stmt = (select(Workshop, *[c.label(k) for k, c in cols.items()])
            .outerjoin(proj, proj.c.wid == Workshop.id).outerjoin(ords, ords.c.wid == Workshop.id)
            .outerjoin(ai, ai.c.wid == Workshop.id).outerjoin(usr, usr.c.wid == Workshop.id))
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        conds = [func.lower(Workshop.name).like(like), func.lower(Workshop.city).like(like),
                 Workshop.id.in_(select(User.workshop_id).where(func.lower(User.name).like(like)))]
        digits = "".join(ch for ch in q if ch.isdigit())
        if len(digits) >= 3:
            conds += [Workshop.phone.like(f"%{digits}%"),
                      Workshop.id.in_(select(User.workshop_id).where(User.phone.like(f"%{digits}%")))]
        stmt = stmt.where(or_(*conds))
    if city:
        stmt = stmt.where(func.lower(Workshop.city) == city.strip().lower())
    if plan:
        stmt = stmt.where(Workshop.plan == plan)
    now = utcnow()
    if active_days:
        stmt = stmt.where(last >= now - timedelta(days=active_days))
    if inactive_days:
        stmt = stmt.where(or_(last.is_(None), last < now - timedelta(days=inactive_days)))
    if blocked is not None:
        stmt = stmt.where(Workshop.blocked.is_(blocked))
    if has_orders is not None:
        stmt = stmt.where(cols["orders"] > 0 if has_orders else cols["orders"] == 0)
    return stmt, cols


def _workshop_row(db, settings, row, owners: dict) -> dict:
    w: Workshop = row[0]
    st = limit_state(db, settings, w)
    owner = owners.get(w.id)
    return {
        "id": str(w.id), "name": w.name, "city": w.city, "phone": w.phone or (owner.phone if owner else None),
        "owner_name": owner.name if owner else None, "owner_phone": owner.phone if owner else None,
        "plan": w.plan, "pro_until": _iso(w.pro_until), "pro_active": st.unlimited,
        "blocked": w.blocked, "deleted": w.deleted_at is not None,
        "free_left": st.free_left, "free_limit": st.free_limit, "pack_left": st.pack_left, "unlimited": st.unlimited,
        "projects": int(row.projects), "orders": int(row.orders), "turnover": int(row.turnover or 0),
        "ai_spend_usd": _usd(int(row.ai_spend or 0)), "members": int(row.members),
        "last_activity": _iso(row.last_activity), "created_at": _iso(w.created_at),
    }


def _owners(db, ids) -> dict:
    if not ids:
        return {}
    return {u.workshop_id: u for u in db.scalars(select(User).where(User.workshop_id.in_(ids), User.role == "owner")
                                                  .order_by(User.created_at.desc()))}


@router.get("/workshops", summary="Цеха: поиск, фильтры, сортировка, показатели")
def list_workshops(
    admin: WorkshopsViewDep, db: DbDep, settings: SettingsDep,
    q: Annotated[str | None, Query(description="Название, город, имя или телефон (от 3 цифр)")] = None,
    city: str | None = None, plan: Literal["free", "pack", "pro"] | None = None,
    active_days: Annotated[int | None, Query(ge=1, le=365, description="Была активность за N дней")] = None,
    inactive_days: Annotated[int | None, Query(ge=1, le=365, description="Нет активности дольше N дней")] = None,
    blocked: bool | None = None, has_orders: bool | None = None,
    sort: WorkshopSort = "created_at", order: Literal["asc", "desc"] = "desc",
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
) -> dict:
    """Последняя активность — самое позднее из: вход мастера, изменение проекта, запрос к ИИ."""
    stmt, cols = _workshops_stmt(q=q, city=city, plan=plan, active_days=active_days, inactive_days=inactive_days,
                                 blocked=blocked, has_orders=has_orders)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    key = {"created_at": Workshop.created_at, "plan": Workshop.plan, "name": func.lower(Workshop.name)}.get(sort)
    if key is None:
        key = cols[sort]
    direction = key.asc() if order == "asc" else key.desc()
    rows = db.execute(stmt.order_by(direction.nulls_last(), Workshop.created_at.desc(), Workshop.id)
                      .limit(limit).offset(offset)).all()
    owners = _owners(db, [r[0].id for r in rows])
    cities = [c for (c,) in db.execute(select(Workshop.city).where(Workshop.city.is_not(None)).distinct()
                                       .order_by(Workshop.city)).all() if c]
    return {"items": [_workshop_row(db, settings, r, owners) for r in rows], "total": total, "limit": limit,
            "offset": offset, "cities": cities, "sort": sort, "order": order}


@router.get("/workshops.csv", summary="Цеха CSV (те же фильтры и сортировка)",
            responses={200: {"content": {"text/csv": {}}}})
def workshops_csv(
    admin: WorkshopsViewDep, db: DbDep, settings: SettingsDep, q: str | None = None, city: str | None = None,
    plan: Literal["free", "pack", "pro"] | None = None,
    active_days: Annotated[int | None, Query(ge=1, le=365)] = None,
    inactive_days: Annotated[int | None, Query(ge=1, le=365)] = None,
    blocked: bool | None = None, has_orders: bool | None = None,
    sort: WorkshopSort = "created_at", order: Literal["asc", "desc"] = "desc",
) -> Response:
    data = list_workshops(admin, db, settings, q=q, city=city, plan=plan, active_days=active_days,
                          inactive_days=inactive_days, blocked=blocked, has_orders=has_orders, sort=sort, order=order,
                          limit=200, offset=0)
    items = list(data["items"])
    offset = 200
    while offset < min(data["total"], 10_000):  # выгрузка — до 10 000 цехов
        items += list_workshops(admin, db, settings, q=q, city=city, plan=plan, active_days=active_days,
                                inactive_days=inactive_days, blocked=blocked, has_orders=has_orders, sort=sort,
                                order=order, limit=200, offset=offset)["items"]
        offset += 200
    out = io.StringIO()
    w = SafeWriter(csv.writer(out, delimiter=";"))  # название цеха и имя — текстом, не формулой
    w.writerow(["Цех", "Город", "Телефон", "Владелец", "Тариф", "Pro до", "Заблокирован", "Сотрудников",
                "Проектов", "Заказов", "Оборот заказов, сум", "ИИ, $", "Последняя активность", "Регистрация", "id"])

    def day(v: str | None) -> str:
        return datetime.fromisoformat(v).astimezone(TZ).strftime("%d.%m.%Y %H:%M") if v else ""

    for r in items:
        w.writerow([r["name"], r["city"] or "", r["phone"] or "", r["owner_name"] or "", r["plan"],
                    day(r["pro_until"]), "да" if r["blocked"] else "нет", r["members"], r["projects"], r["orders"],
                    r["turnover"], str(r["ai_spend_usd"]).replace(".", ","), day(r["last_activity"]),
                    day(r["created_at"]), r["id"]])
    stamp = utcnow().astimezone(TZ).strftime("%Y-%m-%d")
    return Response(content=("﻿" + out.getvalue()).encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="workshops_{stamp}.csv"'})


# --- Цех: вкладки карточки ---


@router.get("/workshops/{workshop_id}/summary", summary="Карточка цеха: шапка с цифрами, тариф, лимиты, сотрудники")
def workshop_summary(workshop_id: uuid.UUID, admin: WorkshopsViewDep, db: DbDep, settings: SettingsDep) -> dict:
    w = _workshop(db, workshop_id)
    st = limit_state(db, settings, w)
    now = utcnow()
    members = list(db.scalars(select(User).where(User.workshop_id == w.id).order_by(User.created_at)))
    owner = next((u for u in members if u.role == "owner"), None)
    projects = dict(db.execute(select(Project.status, func.count(Project.id)).where(
        Project.workshop_id == w.id, Project.deleted_at.is_(None)).group_by(Project.status)).all())
    order_rows = db.execute(select(Order.status, func.count(Order.id), func.sum(_paid_amount()))
                            .join(Project, Order.project_id == Project.id).where(Project.workshop_id == w.id)
                            .group_by(Order.status)).all()
    closed = {OrderStatus.issued, OrderStatus.cancelled, OrderStatus.rejected}
    ai_total = db.scalar(select(func.coalesce(func.sum(AiRequest.cost_microusd), 0))
                         .where(AiRequest.workshop_id == w.id)) or 0
    ai_30 = db.scalar(select(func.coalesce(func.sum(AiRequest.cost_microusd), 0))
                      .where(AiRequest.workshop_id == w.id, AiRequest.created_at >= now - timedelta(days=30))) or 0
    pays = db.execute(select(Payment.status, func.coalesce(func.sum(Payment.amount), 0))
                      .where(Payment.workshop_id == w.id).group_by(Payment.status)).all()
    paid_total = sum(a for _, a in pays)
    refunded = sum(a for s, a in pays if s == "refunded")
    lasts = [d for d in (
        db.scalar(select(func.max(User.last_login_at)).where(User.workshop_id == w.id)),
        db.scalar(select(func.max(Project.updated_at)).where(Project.workshop_id == w.id)),
        db.scalar(select(func.max(AiRequest.created_at)).where(AiRequest.workshop_id == w.id)),
    ) if d is not None]
    block = db.scalar(select(ActionLog).where(ActionLog.workshop_id == w.id, ActionLog.entity == "workshop",
                                              ActionLog.action.in_(["block", "unblock"]))
                      .order_by(ActionLog.created_at.desc()).limit(1))
    block_names = staff_names(db, [block] if block else [])
    return {
        "id": str(w.id), "name": w.name, "city": w.city, "phone": w.phone or (owner.phone if owner else None),
        "logo_url": w.logo_url, "created_at": _iso(w.created_at), "deleted": w.deleted_at is not None,
        "owner": {"id": str(owner.id), "name": owner.name, "phone": owner.phone} if owner else None,
        "plan": w.plan, "pro_until": _iso(w.pro_until), "pro_active": st.unlimited,
        "blocked": w.blocked,
        "block": {"action": block.action, "reason": (block.after or {}).get("reason"), "at": _iso(block.created_at),
                  "by": block_names.get(block.actor_id or "")} if block else None,
        "limits": {"period": st.period, "free_limit": st.free_limit, "free_used": st.free_used,
                   "free_left": st.free_left, "pack_left": st.pack_left, "unlimited": st.unlimited},
        "pricing": {"labor_mode": w.labor_mode, "labor_percent": w.labor_percent, "labor_fixed": w.labor_fixed,
                    "markup": {"body": w.markup_body, "fronts": w.markup_fronts, "hardware": w.markup_hardware,
                               "services": w.markup_services}},
        "stats": {
            "projects": sum(projects.values()),
            "projects_active": sum(n for s, n in projects.items()
                                   if s not in (ProjectStatus.delivered, ProjectStatus.cancelled)),
            "orders": sum(n for _, n, _ in order_rows),
            "orders_open": sum(n for s, n, _ in order_rows if s not in closed),
            "turnover": int(sum(t or 0 for _, _, t in order_rows)),
            "ai_spend_usd": _usd(ai_total), "ai_spend_30d_usd": _usd(ai_30),
            "payments_total": int(paid_total - refunded), "payments_refunded": int(refunded),
            "last_activity": _iso(max(lasts)) if lasts else None,
        },
        "members": [{"id": str(u.id), "name": u.name, "phone": u.phone, "role": u.role, "title": u.title,
                     "is_active": u.is_active, "deleted": u.deleted_at is not None,
                     "can_order": u.role == "owner" or bool(u.can_order),
                     "can_see_cost": u.role == "owner" or bool(u.can_see_cost),
                     "last_login_at": _iso(u.last_login_at), "created_at": _iso(u.created_at)} for u in members],
    }


def _payment_out(p: Payment, titles: dict) -> dict:
    return {"id": str(p.id), "kind": p.kind, "title": p.title, "amount": p.amount, "method": p.method,
            "status": p.status, "reference": p.reference, "receipt_url": p.receipt_url,
            "project_id": str(p.project_id) if p.project_id else None, "project_title": titles.get(p.project_id),
            "created_by": p.created_by, "paid_at": _iso(p.paid_at), "refunded_at": _iso(p.refunded_at)}


@router.get("/workshops/{workshop_id}/payments", summary="Платежи цеха платформе и возвраты")
def workshop_payments(workshop_id: uuid.UUID, admin: WorkshopsViewDep, db: DbDep) -> dict:
    w = _workshop(db, workshop_id)
    rows = list(db.scalars(select(Payment).where(Payment.workshop_id == w.id).order_by(Payment.paid_at.desc())))
    pids = {p.project_id for p in rows if p.project_id}
    titles = dict(db.execute(select(Project.id, Project.title).where(Project.id.in_(pids))).all()) if pids else {}
    paid = sum(p.amount for p in rows)
    refunded = sum(p.amount for p in rows if p.status == "refunded")
    return {"items": [_payment_out(p, titles) for p in rows],
            "totals": {"paid": paid, "refunded": refunded, "net": paid - refunded, "count": len(rows)}}


@router.get("/workshops/{workshop_id}/ai-usage", summary="Расход ИИ цеха: по дням, проектам, назначению")
def workshop_ai_usage(workshop_id: uuid.UUID, admin: WorkshopsViewDep, db: DbDep,
                      days: int = Query(30, ge=1, le=365)) -> dict:
    w = _workshop(db, workshop_id)
    today = utcnow().astimezone(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    since = today - timedelta(days=days - 1)
    rows = db.execute(select(AiRequest.created_at, AiRequest.project_id, AiRequest.purpose, AiRequest.cost_microusd,
                             AiRequest.validation_result)
                      .where(AiRequest.workshop_id == w.id, AiRequest.created_at >= since)).all()
    by_day: dict[str, list[int]] = {(since + timedelta(days=i)).date().isoformat(): [0, 0] for i in range(days)}
    by_project: dict[Any, dict] = {}
    by_purpose: dict[str, list[int]] = {}
    errors = 0
    for created, pid, purpose, cost, result in rows:
        d = by_day.setdefault(created.astimezone(TZ).date().isoformat(), [0, 0])
        d[0] += 1
        d[1] += cost or 0
        p = by_project.setdefault(pid, {"requests": 0, "cost": 0, "last": created})
        p["requests"] += 1
        p["cost"] += cost or 0
        p["last"] = max(p["last"], created)
        u = by_purpose.setdefault(purpose, [0, 0])
        u[0] += 1
        u[1] += cost or 0
        errors += result not in ("ok", "retried")
    pids = [k for k in by_project if k is not None]
    titles = dict(db.execute(select(Project.id, Project.title).where(Project.id.in_(pids))).all()) if pids else {}
    all_time = db.execute(select(func.count(AiRequest.id), func.coalesce(func.sum(AiRequest.cost_microusd), 0))
                          .where(AiRequest.workshop_id == w.id)).one()
    return {
        "days": days, "from": since.isoformat(),
        "by_day": [{"date": k, "requests": v[0], "cost_usd": _usd(v[1])} for k, v in sorted(by_day.items())],
        "by_project": sorted(({"project_id": str(k) if k else None, "title": titles.get(k) if k else "Без проекта",
                               "requests": v["requests"], "cost_usd": _usd(v["cost"]), "last_at": _iso(v["last"])}
                              for k, v in by_project.items()), key=lambda x: -x["cost_usd"]),
        "by_purpose": sorted(({"purpose": k, "requests": v[0], "cost_usd": _usd(v[1])} for k, v in by_purpose.items()),
                             key=lambda x: -x["cost_usd"]),
        "period": {"requests": len(rows), "cost_usd": _usd(sum(r[3] or 0 for r in rows)), "errors": errors},
        "all_time": {"requests": all_time[0], "cost_usd": _usd(all_time[1])},
    }


@router.get("/workshops/{workshop_id}/activity", summary="Журнал цеха: мастера, сотрудники платформы, система")
def workshop_activity(workshop_id: uuid.UUID, admin: WorkshopsViewDep, db: DbDep,
                      actor: Literal["all", "staff", "user", "system"] = "all",
                      hide_requests: Annotated[bool, Query(description="Скрыть запросы «глазами мастера»")] = True,
                      page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200)) -> dict:
    w = _workshop(db, workshop_id)
    stmt = select(ActionLog).where(ActionLog.workshop_id == w.id)
    if actor != "all":
        stmt = stmt.where(ActionLog.actor_type == actor)
    if hide_requests:
        stmt = stmt.where(~and_(ActionLog.entity == "impersonation", ActionLog.action == "request"))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = list(db.scalars(stmt.order_by(ActionLog.created_at.desc()).limit(page_size).offset((page - 1) * page_size)))
    names = staff_names(db, rows)
    uids = set()
    for e in rows:
        if e.actor_type == "user" and e.actor_id:
            try:
                uids.add(uuid.UUID(e.actor_id))
            except ValueError:
                pass
    if uids:
        names |= {str(i): (n or p) for i, n, p in db.execute(select(User.id, User.name, User.phone)
                                                             .where(User.id.in_(uids)))}
    return {"items": [{"id": str(e.id), "actor_type": e.actor_type, "actor_id": e.actor_id,
                       "actor_name": names.get(e.actor_id or ""), "entity": e.entity, "entity_id": e.entity_id,
                       "action": e.action, "before": e.before, "after": e.after, "created_at": _iso(e.created_at)}
                      for e in rows], "total": total, "page": page, "page_size": page_size}


class ReasonIn(BaseModel):
    reason: str | None = Field(None, max_length=500)


@router.post("/workshops/{workshop_id}/reset-limits", summary="Сбросить лимит месяца: бесплатные проекты снова доступны")
def reset_limits(workshop_id: uuid.UUID, body: ReasonIn, admin: WorkshopsGrantDep, db: DbDep,
                 settings: SettingsDep) -> dict:
    """Проекты, списанные из бесплатного лимита в этом месяце, возвращаются в лимит (как после оплаты заказа),
    доп. списания за перерасход ИИ этого месяца перестают считаться (`source = reset`). Пакет и Pro не меняются."""
    reason = require_reason(admin, body.reason)
    w = _workshop(db, workshop_id)
    now = utcnow()
    period = period_of(settings, now)
    before = limit_state(db, settings, w, now)
    projects = list(db.scalars(select(Project).where(
        Project.workshop_id == w.id, Project.charge_period == period, Project.charge_source == ChargeSource.free,
        Project.returned_to_limit_at.is_(None))))
    for p in projects:
        p.returned_to_limit_at = now
    extras = list(db.scalars(select(ExtraCharge).where(
        ExtraCharge.workshop_id == w.id, ExtraCharge.period == period, ExtraCharge.source == ChargeSource.free)))
    for x in extras:
        x.source = "reset"
    db.flush()
    after = limit_state(db, settings, w, now)
    log_action(db, actor_type=admin.type, actor_id=admin.id, workshop_id=w.id, entity="workshop_limits",
               entity_id=w.id, action="reset", before={"period": period, "free_used": before.free_used},
               after={"period": period, "free_used": after.free_used, "reason": reason,
                      "projects": [str(p.id) for p in projects], "extra_charges": len(extras)})
    db.commit()
    return {"period": after.period, "free_limit": after.free_limit, "free_used": after.free_used,
            "free_left": after.free_left, "pack_left": after.pack_left, "unlimited": after.unlimited,
            "returned_projects": len(projects), "reset_extra_charges": len(extras)}


# --- Заказы: список с SLA ---

# Кто должен сделать следующий шаг в каждом статусе
WAITING_ON = {
    OrderStatus.created: "supplier", OrderStatus.accepted: "master", OrderStatus.paid: "supplier",
    OrderStatus.cutting: "supplier", OrderStatus.ready: "master", OrderStatus.returned: "master",
    OrderStatus.awaiting_approval: "master",
}
LATE_STATUSES = {OrderStatus.accepted, OrderStatus.paid, OrderStatus.cutting}


def sla_out(o: Order, now: datetime, overdue_hours: int) -> dict:
    since = o.status_changed_at or o.created_at
    hours = round((now - since).total_seconds() / 3600, 1) if since else None
    overdue = (o.status == OrderStatus.created and o.supplier_id is not None and hours is not None
               and hours >= overdue_hours)
    late = bool(o.due_date and o.due_date < now and o.status in LATE_STATUSES)
    return {"since": _iso(since), "hours_in_status": hours, "waiting_on": WAITING_ON.get(OrderStatus(o.status)),
            "overdue": overdue, "late": late, "no_supplier": o.supplier_id is None and o.status == OrderStatus.created}


@router.get("/orders", summary="Заказы всех поставщиков: фильтры, SLA (время в статусе, просрочка)")
def list_orders(
    admin: OrdersDep, db: DbDep, settings: SettingsDep,
    status: Annotated[list[OrderStatus] | None, Query()] = None,
    q: Annotated[str | None, Query(description="Номер заказа, проект или цех")] = None,
    supplier_id: Annotated[str | None, Query(description="id поставщика или none — очередь платформы")] = None,
    workshop_id: uuid.UUID | None = None,
    overdue: Annotated[bool, Query(description="Только просроченные: в «Создан» дольше N часов")] = False,
    overdue_hours: Annotated[int | None, Query(ge=1, le=24 * 30, description="N; нет — настройка платформы")] = None,
    late: Annotated[bool, Query(description="Только с прошедшим сроком готовности")] = False,
    from_: Annotated[str | None, Query(alias="from", description="Создан с (YYYY-MM-DD)")] = None,
    to: Annotated[str | None, Query(description="Создан по (YYYY-MM-DD, включительно)")] = None,
    sort: Literal["created_at", "status_age", "total"] = "created_at", order: Literal["asc", "desc"] = "desc",
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
) -> dict:
    from .admin_panel import _order_brief

    now = utcnow()
    hours = overdue_hours or _overdue_hours(db, settings)
    border = now - timedelta(hours=hours)
    since = func.coalesce(Order.status_changed_at, Order.created_at)
    stmt = select(Order).join(Project, Order.project_id == Project.id).join(Workshop, Project.workshop_id == Workshop.id)
    if supplier_id == "none":
        stmt = stmt.where(Order.supplier_id.is_(None))
    elif supplier_id:
        try:
            stmt = stmt.where(Order.supplier_id == uuid.UUID(supplier_id))
        except ValueError:
            raise ApiError(422, "validation_error", "supplier_id — id поставщика или none")
    if workshop_id:
        stmt = stmt.where(Project.workshop_id == workshop_id)
    if status:
        stmt = stmt.where(Order.status.in_([s.value for s in status]))
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        conds = [func.lower(Project.title).like(like), func.lower(Workshop.name).like(like)]
        digits = "".join(ch for ch in q if ch.isdigit())
        if digits and len(digits) <= 9:
            conds.append(Order.number == int(digits))
        stmt = stmt.where(or_(*conds))
    if overdue:
        stmt = stmt.where(Order.status == OrderStatus.created, Order.supplier_id.is_not(None), since < border)
    if late:
        stmt = stmt.where(Order.due_date < now, Order.status.in_([s.value for s in LATE_STATUSES]))
    if from_ or to:
        start, end = finance.period(from_, to)
        stmt = stmt.where(Order.created_at >= start, Order.created_at < end)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    key = {"created_at": Order.created_at, "status_age": since,
           "total": func.coalesce(Order.invoice_total, Order.estimate_total, 0)}[sort]
    # «Дольше всех в статусе» — самое раннее время смены статуса
    direction = (key.desc() if order == "asc" else key.asc()) if sort == "status_age" else \
        (key.asc() if order == "asc" else key.desc())
    rows = list(db.scalars(stmt.order_by(direction, Order.id).limit(limit).offset(offset)))
    names = {}
    aids = {o.assignee_id for o in rows if o.assignee_id}
    if aids:
        names = dict(db.execute(select(StaffUser.id, StaffUser.name).where(StaffUser.id.in_(aids))).all())
    overdue_total = db.scalar(select(func.count(Order.id)).where(
        Order.status == OrderStatus.created, Order.supplier_id.is_not(None), since < border)) or 0
    late_total = db.scalar(select(func.count(Order.id)).where(
        Order.due_date < now, Order.status.in_([s.value for s in LATE_STATUSES]))) or 0
    queue_total = db.scalar(select(func.count(Order.id)).where(
        Order.status == OrderStatus.created, Order.supplier_id.is_(None))) or 0
    return {
        "items": [{**_order_brief(db, o), "assignee_name": names.get(o.assignee_id),
                   "total": o.invoice_total if o.invoice_total is not None else o.estimate_total,
                   "sla": sla_out(o, now, hours)} for o in rows],
        "total": total, "limit": limit, "offset": offset, "overdue_hours": hours,
        "counters": {"overdue": overdue_total, "late": late_total, "platform_queue": queue_total},
    }


@router.get("/orders/{order_id}/commission", summary="Комиссия платформы по заказу: начислено, сторно, ожидается")
def order_commission_info(order_id: uuid.UUID, admin: OrdersDep, db: DbDep) -> dict:
    from ..services.order_flow import order_total
    from ..services.supplier_routes import commission_rate_bp, order_commission

    o = db.get(Order, order_id)
    if o is None:
        raise not_found("Заказ")
    s = db.get(Supplier, o.supplier_id) if o.supplier_id else None
    total = order_total(o)
    accrued = o.commission_amount
    reversed_ = o.commission_reversed or 0
    expected = None
    if accrued is None and s is not None and o.status not in (OrderStatus.cancelled, OrderStatus.rejected):
        expected = order_commission(db, s, o.composition, total, o.created_at or utcnow())
    base = accrued if accrued is not None else expected
    return {
        "status": o.commission_status or ("expected" if expected is not None else None),
        "order_total": total, "accrued": accrued, "reversed": reversed_,
        "net": (accrued - reversed_) if accrued is not None else None, "expected": expected,
        "rate_percent": round(base * 100 / total, 2) if base is not None and total else None,
        "supplier_rate_percent": commission_rate_bp(db, s, None, utcnow()) / 100 if s is not None else None,
        "supplier_name": s.name if s else None, "paid_at": _iso(o.paid_at),
    }


# --- Поставщики: показатели ---


def _median_hours(deltas: list[timedelta]) -> float | None:
    return round(statistics.median(d.total_seconds() for d in deltas) / 3600, 1) if deltas else None


@router.get("/suppliers/performance", summary="Поставщики: очередь, медиана принятия, просрочки, возвраты, деньги")
def suppliers_performance(admin: SuppliersReadDep, db: DbDep, settings: SettingsDep,
                          from_: Annotated[str | None, Query(alias="from")] = None, to: str | None = None) -> dict:
    """Очередь, просрочки и долг — на сейчас; медиана принятия, возвраты, отклонения, оборот, комиссия — за период
    (заказы, созданные или оплаченные в периоде). По умолчанию — текущий месяц."""
    from ..services.catalog import pipeline
    from ..services.supplier_routes import commission_rate_bp

    from .admin_catalog import supplier_out

    pipeline.ensure_supplier(db, "eman")
    start, end = finance.period(from_, to)
    now = utcnow()
    hours = _overdue_hours(db, settings)
    border = now - timedelta(hours=hours)
    items = []
    for s in db.scalars(select(Supplier).order_by(Supplier.created_at)):
        orders = list(db.scalars(select(Order).where(Order.supplier_id == s.id)))
        created = [o for o in orders if start <= o.created_at < end]
        queue = [o for o in orders if o.status == OrderStatus.created]
        accept = [o.accepted_at - o.created_at for o in created if o.accepted_at]
        paid_ids = [o.id for o in orders if o.paid_at and start <= o.paid_at < end]
        returned = db.scalar(select(func.count(func.distinct(OrderReturn.order_id)))
                             .where(OrderReturn.order_id.in_(paid_ids))) or 0 if paid_ids else 0
        fin = finance.supplier_finance(db, s, start, end)
        staff = list(db.scalars(select(StaffUser).where(StaffUser.supplier_id == s.id)))
        items.append({
            **supplier_out(s),
            "current_rate_percent": commission_rate_bp(db, s, None, now) / 100,
            "queue": len(queue),
            "queue_oldest_hours": round(max((now - (o.status_changed_at or o.created_at)).total_seconds()
                                            for o in queue) / 3600, 1) if queue else None,
            "overdue": sum(1 for o in queue if (o.status_changed_at or o.created_at) < border),
            "in_work": sum(1 for o in orders if o.status in (OrderStatus.accepted, OrderStatus.paid,
                                                              OrderStatus.cutting, OrderStatus.ready)),
            "orders_period": len(created), "paid_period": len(paid_ids),
            "median_accept_hours": _median_hours(accept),
            "return_rate": round(returned / len(paid_ids), 3) if paid_ids else None,
            "reject_rate": round(sum(o.status == OrderStatus.rejected for o in created) / len(created), 3)
            if created else None,
            "turnover": fin["turnover"], "commission": fin["commission"], "settled": fin["settled"],
            "debt": fin["balance"]["debt"],
            "staff": {"total": len(staff), "active": sum(u.is_active for u in staff),
                      "owners": sum(u.role == "vendor_owner" and u.is_active for u in staff)},
        })
    return {"items": items, "from": start.isoformat(), "to": end.isoformat(), "overdue_hours": hours}


# --- Деньги: сводный отчёт CSV ---


@router.get("/finance/report.csv", summary="Взаиморасчёты за период по всем поставщикам и платежи мастеров (CSV)",
            responses={200: {"content": {"text/csv": {}}}})
def finance_report_csv(admin: FinanceDep, db: DbDep, from_: Annotated[str | None, Query(alias="from")] = None,
                       to: str | None = None) -> Response:
    start, end = finance.period(from_, to)
    out = io.StringIO()
    w = SafeWriter(csv.writer(out, delimiter=";"))
    last = (end - timedelta(seconds=1)).astimezone(TZ).date().isoformat()
    w.writerow(["Взаиморасчёты платформы", start.astimezone(TZ).date().isoformat(), last])
    w.writerow([])
    w.writerow(["Поставщик", "Код", "Заказов", "Оборот", "Комиссия начислена", "Сторно", "К оплате", "Выплачено",
                "Долг за период", "Долг на сегодня"])
    for s in db.scalars(select(Supplier).order_by(Supplier.created_at)):
        f = finance.supplier_finance(db, s, start, end)
        w.writerow([s.name, s.code, f["orders"], f["turnover"], f["commission"]["accrued"],
                    f["commission"]["reversed"], f["commission"]["due"], f["settled"], f["debt"],
                    f["balance"]["debt"]])
    w.writerow([])
    w.writerow(["Платежи мастеров платформе", "Платежей", "Сумма", "Возвраты", "Итого"])
    kinds = {"pack": "Пакеты проектов", "pro": "Pro", "files": "Файлы для станка"}
    for kind, n, amount, refunded in db.execute(
            select(Payment.kind, func.count(Payment.id), func.coalesce(func.sum(Payment.amount), 0),
                   func.coalesce(func.sum(case((Payment.status == "refunded", Payment.amount), else_=0)), 0))
            .where(Payment.paid_at >= start, Payment.paid_at < end).group_by(Payment.kind)).all():
        w.writerow([kinds.get(kind, kind), n, amount, refunded, amount - refunded])
    return Response(content=("﻿" + out.getvalue()).encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition":
                             f'attachment; filename="finance_{start.astimezone(TZ).date().isoformat()}_{last}.csv"'})


# --- Сотрудники ---


@router.get("/staff", summary="Сотрудники платформы и поставщиков: роль, вход, 2FA, активные сессии, блокировка")
def staff_overview(admin: StaffAdminDep, db: DbDep, settings: SettingsDep, q: str | None = None,
                   scope: Literal["all", "platform", "suppliers"] = "all", supplier_id: uuid.UUID | None = None,
                   role: str | None = None, state: Literal["all", "active", "inactive", "locked"] = "all") -> dict:
    from .staff import user_out

    stmt = select(StaffUser)
    if supplier_id:
        stmt = stmt.where(StaffUser.supplier_id == supplier_id)
    elif scope == "platform":
        stmt = stmt.where(StaffUser.supplier_id.is_(None))
    elif scope == "suppliers":
        stmt = stmt.where(StaffUser.supplier_id.is_not(None))
    if role:
        stmt = stmt.where(StaffUser.role == role)
    if state == "active":
        stmt = stmt.where(StaffUser.is_active.is_(True))
    elif state == "inactive":
        stmt = stmt.where(StaffUser.is_active.is_(False))
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(StaffUser.name).like(like), StaffUser.email.like(like)))
    users = list(db.scalars(stmt.order_by(StaffUser.supplier_id.is_not(None), StaffUser.created_at)))
    alive = utcnow() - timedelta(days=settings.staff_refresh_ttl_days)
    sess = {sid: (n, last) for sid, n, last in db.execute(
        select(StaffSession.staff_id, func.count(StaffSession.id), func.max(StaffSession.last_seen_at))
        .where(StaffSession.revoked_at.is_(None), StaffSession.last_seen_at >= alive)
        .group_by(StaffSession.staff_id)).all()}
    items = []
    for u in users:
        row = user_out(db, u)
        if state == "locked" and not row["locked"]:
            continue
        n, last = sess.get(u.id, (0, None))
        row.update(active_sessions=n, last_seen_at=_iso(last), last_login_at=_iso(u.last_login_at),
                   created_at=_iso(u.created_at), supplier_id=str(u.supplier_id) if u.supplier_id else None,
                   supplier_name=(row.get("org") or {}).get("supplier_name"), self=admin.staff_uuid == u.id)
        items.append(row)
    return {"items": items, "total": len(items),
            "counters": {"total": len(users), "active_sessions": sum(r["active_sessions"] for r in items),
                         "locked": sum(1 for r in items if r["locked"]),
                         "without_mfa": sum(1 for r in items if r["is_active"] and not r["mfa_enabled"])}}
