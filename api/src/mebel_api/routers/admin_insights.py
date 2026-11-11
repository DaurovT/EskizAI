"""Рабочий стол суперадмина (docs/staff_vendor_contract.md §4a): сводка за период со сравнением, «требует внимания»,
поиск по всей платформе и журнал действий с фильтрами и выгрузкой.

Права: сводка и тревоги — любой сотрудник платформы, но каждый блок — только при своём праве (деньги — `finance`,
ИИ — `ai.log`/`finance`, поставщики — `suppliers.manage`/`orders.manage`/`finance`); поиск — только по разделам,
к которым есть доступ; журнал — `audit.view`. Все ручки только читают (кроме записи о выгрузке журнала).
"""

import csv
import io
import json
import statistics
import uuid
from datetime import date, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.responses import Response
from mebel_core.exports.csv_safe import SafeWriter
from sqlalchemy import String, cast, func, or_, select

from ..db import utcnow
from ..deps import AuditDep, DbDep, PlatformDep, SettingsDep, StaffActor
from ..domain import ORDER_STATUS_LABELS, STATUS_LABELS, ProjectStatus
from ..errors import ERROR_RESPONSES, ApiError
from ..models import (
    ActionLog,
    AiRequest,
    AuthCode,
    Order,
    OrderDispute,
    OrderReturn,
    ParserRun,
    Payment,
    Project,
    RawPriceRecord,
    StaffUser,
    Supplier,
    SupplierSettlement,
    User,
    Workshop,
)
from ..services import finance
from ..services.action_log import log_action
from ..services.app_settings import all_settings
from ..services.app_status import maintenance_state
from ..services.staff_auth import ROLES

router = APIRouter(prefix="/admin/insights", tags=["admin"], responses=ERROR_RESPONSES)

TZ = finance.TZ
MAX_DAYS = 366
AI_ANOMALY_FLOOR_USD = 0.2  # цех без истории расходов: тревога, только если за день потрачено > N × $0.20
FAILED_LOGIN_SPIKE = 10  # неудачных входов сотрудников за час — «всплеск»


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _usd(micro: int | None) -> float:
    return round((micro or 0) / 1_000_000, 4)


def _day(d: datetime) -> str:
    return d.astimezone(TZ).date().isoformat()


def _total(o: Order) -> int:
    return o.invoice_total if o.invoice_total is not None else (o.estimate_total or 0)


def _between(col, a: datetime, b: datetime):
    return (col >= a) & (col < b)


def _like(q: str) -> str:
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc.lower()}%"


def _sections(actor: StaffActor) -> dict[str, bool]:
    return {
        "money": actor.can("finance"),
        "ai": actor.can("ai.log", "finance"),
        "suppliers": actor.can("suppliers.manage", "orders.manage", "finance"),
    }


# --- Сводка ---


def _window(from_: str | None, to: str | None) -> tuple[datetime, datetime, datetime, datetime]:
    """Период и предыдущий период той же длины. Если период ещё идёт (сегодня), сравниваем с тем же отрезком
    предыдущего: сегодня до 14:00 — со вчера до 14:00, а не со всем вчерашним днём."""
    if not from_:
        from_ = (utcnow().astimezone(TZ).date() - timedelta(days=6)).isoformat()
    start, end = finance.period(from_, to)
    if end - start > timedelta(days=MAX_DAYS):
        raise ApiError(422, "invalid_period", f"Период — не больше {MAX_DAYS} дней")
    length = end - start
    elapsed = min(end, max(utcnow(), start)) - start
    prev_start = start - length
    return start, end, prev_start, prev_start + elapsed


def _days(start: datetime, end: datetime) -> list[str]:
    d0 = start.astimezone(TZ).date()
    d1 = (end - timedelta(microseconds=1)).astimezone(TZ).date()
    out, d = [], d0
    while d <= d1:
        out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def _counts(db, a: datetime, b: datetime, sections: dict[str, bool]) -> dict[str, Any]:
    """Показатели за окно [a, b)."""
    active = set(db.scalars(select(Project.workshop_id).where(_between(Project.updated_at, a, b)).distinct()))
    active |= set(db.scalars(select(AiRequest.workshop_id).where(_between(AiRequest.created_at, a, b),
                                                                 AiRequest.workshop_id.is_not(None)).distinct()))
    out: dict[str, Any] = {
        "workshops_active": len(active),
        "registrations": db.scalar(select(func.count(Workshop.id)).where(_between(Workshop.created_at, a, b))) or 0,
        "projects_created": db.scalar(select(func.count(Project.id)).where(
            _between(Project.created_at, a, b), Project.is_example.is_(False))) or 0,
        "orders": db.scalar(select(func.count(Order.id)).where(_between(Order.created_at, a, b))) or 0,
        "sms_sent": db.scalar(select(func.count(AuthCode.id)).where(_between(AuthCode.created_at, a, b))) or 0,
    }
    if sections["money"]:
        paid = list(db.scalars(select(Order).where(_between(Order.paid_at, a, b), Order.status != "cancelled")))
        out["turnover"] = sum(_total(o) for o in paid)
        out["orders_paid"] = len(paid)
        paid_all = list(db.execute(select(Order.commission_amount, Order.commission_reversed)
                                   .where(_between(Order.paid_at, a, b))).all())
        out["commission_accrued"] = sum(x or 0 for x, _ in paid_all)
        out["commission_reversed"] = sum(y or 0 for _, y in paid_all)
        out["commission_received"] = db.scalar(select(func.coalesce(func.sum(SupplierSettlement.amount), 0)).where(
            _between(SupplierSettlement.paid_at, a, b))) or 0
        gross = dict(db.execute(select(Payment.kind, func.coalesce(func.sum(Payment.amount), 0))
                                .where(_between(Payment.paid_at, a, b)).group_by(Payment.kind)).all())
        refunds = db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(
            Payment.status == "refunded",
            _between(func.coalesce(Payment.refunded_at, Payment.paid_at), a, b))) or 0
        for k in ("pack", "pro", "files"):
            out[f"revenue_{k}"] = gross.get(k, 0)
        out["revenue_refunds"] = refunds
        out["revenue_net"] = sum(gross.values()) - refunds
    if sections["ai"]:
        n, cost = db.execute(select(func.count(AiRequest.id), func.coalesce(func.sum(AiRequest.cost_microusd), 0))
                             .where(_between(AiRequest.created_at, a, b))).one()
        out["ai_requests"] = n
        out["ai_usd"] = _usd(cost)
    return out


def _series(db, start: datetime, end: datetime, sections: dict[str, bool]) -> list[dict]:
    days = _days(start, end)
    rows: dict[str, dict[str, Any]] = {d: {"date": d, "orders": 0, "registrations": 0, "projects": 0} for d in days}
    if sections["money"]:
        for r in rows.values():
            r["turnover"] = 0
    if sections["ai"]:
        for r in rows.values():
            r["ai_usd"] = 0.0

    def bump(when: datetime | None, key: str, v: float = 1) -> None:
        if when is not None and (r := rows.get(_day(when))) is not None:
            r[key] += v

    for (t,) in db.execute(select(Order.created_at).where(_between(Order.created_at, start, end))):
        bump(t, "orders")
    for (t,) in db.execute(select(Workshop.created_at).where(_between(Workshop.created_at, start, end))):
        bump(t, "registrations")
    for (t,) in db.execute(select(Project.created_at).where(_between(Project.created_at, start, end),
                                                            Project.is_example.is_(False))):
        bump(t, "projects")
    if sections["money"]:
        for t, inv, est in db.execute(select(Order.paid_at, Order.invoice_total, Order.estimate_total).where(
                _between(Order.paid_at, start, end), Order.status != "cancelled")):
            bump(t, "turnover", inv if inv is not None else (est or 0))
    if sections["ai"]:
        for t, c in db.execute(select(AiRequest.created_at, AiRequest.cost_microusd)
                               .where(_between(AiRequest.created_at, start, end))):
            bump(t, "ai_usd", (c or 0) / 1_000_000)
        for r in rows.values():
            r["ai_usd"] = round(r["ai_usd"], 4)
    return list(rows.values())


def _top_turnover(db, start: datetime, end: datetime) -> list[dict]:
    amount = func.sum(func.coalesce(Order.invoice_total, Order.estimate_total, 0))
    rows = db.execute(select(Workshop.id, Workshop.name, Workshop.city, amount, func.count(Order.id))
                      .join(Project, Order.project_id == Project.id).join(Workshop, Project.workshop_id == Workshop.id)
                      .where(_between(Order.paid_at, start, end), Order.status != "cancelled")
                      .group_by(Workshop.id, Workshop.name, Workshop.city).order_by(amount.desc()).limit(5)).all()
    return [{"workshop_id": str(i), "name": n, "city": c, "turnover": int(t or 0), "orders": k}
            for i, n, c, t, k in rows]


def _top_ai(db, start: datetime, end: datetime) -> list[dict]:
    cost = func.sum(AiRequest.cost_microusd)
    rows = db.execute(select(Workshop.id, Workshop.name, Workshop.city, cost, func.count(AiRequest.id))
                      .join(Workshop, AiRequest.workshop_id == Workshop.id)
                      .where(_between(AiRequest.created_at, start, end))
                      .group_by(Workshop.id, Workshop.name, Workshop.city).order_by(cost.desc()).limit(5)).all()
    return [{"workshop_id": str(i), "name": n, "city": c, "cost_usd": _usd(x), "requests": k}
            for i, n, c, x, k in rows]


def _suppliers(db, start: datetime, end: datetime, overdue_h: int) -> list[dict]:
    """Снимок по поставщикам: очередь и просрочки — сейчас; скорость принятия и возвраты — за период."""
    now = utcnow()
    border = now - timedelta(hours=overdue_h)
    suppliers = {s.id: s for s in db.scalars(select(Supplier))}
    stats: dict[uuid.UUID | None, dict[str, Any]] = {}

    def row(sid: uuid.UUID | None) -> dict[str, Any]:
        if sid not in stats:
            s = suppliers.get(sid) if sid else None
            stats[sid] = {"supplier_id": str(sid) if sid else None,
                          "name": s.name if s else "Очередь платформы (без поставщика)",
                          "active": s.active if s else True, "queue": 0, "overdue": 0, "oldest_hours": None,
                          "orders": 0, "rejected": 0, "paid": 0, "returns": 0, "_accept": []}
        return stats[sid]

    for sid, created in db.execute(select(Order.supplier_id, Order.created_at).where(Order.status == "created")):
        r = row(sid)
        r["queue"] += 1
        if created < border:
            r["overdue"] += 1
        hours = round((now - created).total_seconds() / 3600, 1)
        r["oldest_hours"] = max(r["oldest_hours"] or 0, hours)
    for sid, st, created, accepted, paid_at in db.execute(
            select(Order.supplier_id, Order.status, Order.created_at, Order.accepted_at, Order.paid_at).where(
                or_(_between(Order.created_at, start, end), _between(Order.accepted_at, start, end),
                    _between(Order.paid_at, start, end)))):
        r = row(sid)
        if start <= created < end:
            r["orders"] += 1
            r["rejected"] += st == "rejected"
        if accepted is not None and start <= accepted < end:
            r["_accept"].append((accepted - created).total_seconds() / 3600)
        if paid_at is not None and start <= paid_at < end:
            r["paid"] += 1
    returned = db.execute(select(Order.supplier_id, func.count(func.distinct(OrderReturn.order_id)))
                          .join(Order, OrderReturn.order_id == Order.id)
                          .where(_between(Order.paid_at, start, end)).group_by(Order.supplier_id)).all()
    for sid, n in returned:
        row(sid)["returns"] = n
    for s in suppliers.values():  # активные поставщики видны и без заказов
        if s.active:
            row(s.id)
    out = []
    for r in stats.values():
        acc = r.pop("_accept")
        r["median_accept_hours"] = round(statistics.median(acc), 1) if acc else None
        r["return_rate"] = round(r["returns"] / r["paid"], 3) if r["paid"] else None
        out.append(r)
    out.sort(key=lambda r: (-r["overdue"], -r["queue"], -r["orders"], r["name"]))
    return out


@router.get("/dashboard", summary="Сводка за период: показатели со сравнением, графики по дням, лидеры, поставщики")
def dashboard(admin: PlatformDep, db: DbDep, settings: SettingsDep,
              from_: Annotated[str | None, Query(alias="from", description="YYYY-MM-DD (Ташкент)")] = None,
              to: Annotated[str | None, Query(description="YYYY-MM-DD включительно")] = None) -> dict:
    """`kpis` — {ключ: {value, prev}} за период и за предыдущий период той же длины (`prev_from`…`prev_to`).
    Денежные показатели (оборот, комиссия, выручка от мастеров, лидеры по обороту) — только с правом `finance`,
    расходы на ИИ — с `ai.log` или `finance`, поставщики — с `suppliers.manage`, `orders.manage` или `finance`;
    без права ключей нет, а `sections` подсказывает, какие блоки показывать."""
    sections = _sections(admin)
    start, end, prev_start, prev_end = _window(from_, to)
    cur = _counts(db, start, end, sections)
    prev = _counts(db, prev_start, prev_end, sections)
    out: dict[str, Any] = {
        "from": start.isoformat(), "to": end.isoformat(),
        "prev_from": prev_start.isoformat(), "prev_to": prev_end.isoformat(),
        "days": len(_days(start, end)), "sections": sections,
        "kpis": {k: {"value": v, "prev": prev.get(k)} for k, v in cur.items()},
        "series": _series(db, start, end, sections),
    }
    if sections["money"]:
        out["top_turnover"] = _top_turnover(db, start, end)
    if sections["ai"]:
        out["top_ai"] = _top_ai(db, start, end)
    if sections["suppliers"]:
        overdue_h = int(all_settings(db, settings).get("vendor_overdue_hours") or 24)
        out["suppliers"] = _suppliers(db, start, end, overdue_h)
        out["overdue_hours"] = overdue_h
    return out


# --- Требует внимания ---


def _hours(since: datetime, now: datetime) -> float:
    return round((now - since).total_seconds() / 3600, 1)


def _ago(since: datetime, now: datetime) -> str:
    h = (now - since).total_seconds() / 3600
    return f"{int(h)} ч" if h < 48 else f"{int(h // 24)} дн"


def _order_label(o: Order, w: Workshop | None, s: Supplier | None) -> str:
    who = " · ".join(x for x in (w.name if w else None, s.name if s else "без поставщика") if x)
    return f"Заказ №{o.number or str(o.id)[:8]} · {who}"


def _cap_label(cap: str, names: dict[str, str]) -> str:
    kind, _, rest = cap.partition(":")
    labels = {"ai_daily_global": "Общий дневной лимит ИИ", "ai_daily_workshop": "Дневной лимит ИИ цеха",
              "ai_hourly_workshop": "Часовой лимит ИИ цеха", "sms_per_hour": "Лимит SMS в час",
              "sms_per_day": "Лимит SMS в сутки"}
    base = labels.get(kind, kind)
    if kind.endswith("_workshop"):
        return f"{base} «{names.get(rest, rest[:8])}»"
    if kind.startswith("sms_"):
        return f"{base} ({'новые номера' if rest == 'new' else 'все'})"
    if kind == "ai_daily_global" and rest:
        return f"{base} ({'платящие' if rest == 'paying' else rest})"
    return base


def _alerts(db, settings, admin: StaffActor) -> list[dict]:
    now = utcnow()
    values = all_settings(db, settings)
    items: list[dict] = []

    def add(key: str, severity: str, title: str, count: int, href: str, detail: str = "",
            rows: list[dict] | None = None) -> None:
        items.append({"key": key, "severity": severity, "title": title, "count": count, "detail": detail,
                      "href": href, "items": rows or []})

    m = maintenance_state(values)
    if m["on"]:
        add("maintenance", "critical", "Включён режим обслуживания", 1, "/admin/settings",
            "Мастера не могут создавать и менять проекты" + (f" · до {m['until']}" if m["until"] else ""))
    if not values.get("ai_enabled", True):
        add("ai_off", "critical", "ИИ выключен аварийным выключателем", 1, "/admin/limits",
            "Распознавание и правки словами недоступны мастерам")
    if not values.get("registration_enabled", True):
        add("registration_off", "warning", "Регистрация новых цехов закрыта", 1, "/admin/limits")

    if admin.can("orders.manage", "suppliers.manage"):
        overdue_h = int(values.get("vendor_overdue_hours") or 24)
        border = now - timedelta(hours=overdue_h)
        q = (select(Order, Project, Workshop, Supplier).join(Project, Order.project_id == Project.id)
             .join(Workshop, Project.workshop_id == Workshop.id).outerjoin(Supplier, Order.supplier_id == Supplier.id)
             .where(Order.status == "created", Order.created_at < border))
        n = db.scalar(select(func.count()).select_from(q.subquery())) or 0
        if n:
            rows = db.execute(q.order_by(Order.created_at).limit(5)).all()
            oldest = rows[0][0].created_at
            add("overdue_orders", "critical" if oldest < now - timedelta(hours=overdue_h * 2) else "warning",
                f"Заказы ждут поставщика дольше {overdue_h} ч", n, "/admin/orders?status=created&overdue=1",
                f"Самый старый — {_ago(oldest, now)}",
                [{"label": _order_label(o, w, s), "sub": f"{_ago(o.created_at, now)} без ответа",
                  "href": f"/admin/orders/{o.id}"} for o, _, w, s in rows])

    if admin.can("disputes"):
        q = select(OrderDispute, Order).join(Order, OrderDispute.order_id == Order.id).where(
            OrderDispute.status == "open")
        n = db.scalar(select(func.count()).select_from(q.subquery())) or 0
        if n:
            rows = db.execute(q.order_by(OrderDispute.created_at).limit(5)).all()
            oldest = rows[0][0].created_at
            add("open_disputes", "critical" if oldest < now - timedelta(hours=48) else "warning",
                "Открытые споры", n, "/admin/disputes", f"Самый старый — {_ago(oldest, now)}",
                [{"label": f"Заказ №{o.number or str(o.id)[:8]} · "
                           f"{'возврат' if d.subject == 'return' else 'отклонение'}",
                  "sub": f"открыт {_ago(d.created_at, now)} назад", "href": "/admin/disputes"} for d, o in rows])

    if admin.can("disputes", "orders.manage", "finance"):
        q = select(OrderReturn, Order).join(Order, OrderReturn.order_id == Order.id).where(
            OrderReturn.status != "resolved")
        n = db.scalar(select(func.count()).select_from(q.subquery())) or 0
        if n:
            rows = db.execute(q.order_by(OrderReturn.created_at).limit(5)).all()
            owner = db.scalar(select(func.count(OrderReturn.id)).where(OrderReturn.status == "awaiting_owner")) or 0
            add("returns", "warning", "Возвраты ждут решения", n, "/admin/orders",
                f"Из них ждут владельца поставщика: {owner}" if owner else "",
                [{"label": f"Заказ №{o.number or str(o.id)[:8]}"
                           + (f" · {r.amount:,} сум".replace(",", " ") if r.amount else ""),
                  "sub": ("ждёт владельца поставщика" if r.status == "awaiting_owner" else "ждёт конструктора")
                         + f" · {_ago(r.created_at, now)}", "href": f"/admin/orders/{o.id}"} for r, o in rows])

    if admin.can("catalog.manage"):
        base = (select(func.count(RawPriceRecord.id))
                .where(RawPriceRecord.review_status == "pending", RawPriceRecord.published_at.is_(None)))
        n = db.scalar(base) or 0
        if n:
            escalated = db.scalar(base.where(RawPriceRecord.created_at < now - timedelta(hours=24))) or 0
            per_supplier = db.execute(select(Supplier.name, func.count(RawPriceRecord.id))
                                      .join(ParserRun, RawPriceRecord.run_id == ParserRun.id)
                                      .join(Supplier, ParserRun.supplier_id == Supplier.id)
                                      .where(RawPriceRecord.review_status == "pending",
                                             RawPriceRecord.published_at.is_(None))
                                      .group_by(Supplier.name)).all()
            add("price_review", "critical" if escalated else "warning", "Изменения цен > 15% ждут подтверждения", n,
                "/admin/catalog/review",
                f"Поставщик не подтвердил за сутки: {escalated}" if escalated else "",
                [{"label": name, "sub": f"позиций: {k}", "href": "/admin/catalog/review"} for name, k in per_supplier])

    if admin.can("tariffs", "settings", "ai.log", "audit.view"):
        caps = list(db.scalars(select(ActionLog).where(ActionLog.entity == "limits", ActionLog.action == "cap_hit",
                                                       ActionLog.created_at >= now - timedelta(hours=24))
                               .order_by(ActionLog.created_at.desc())))
        if caps:
            ws_ids = set()
            for e in caps:
                rest = (e.entity_id or "").partition(":")[2]
                try:
                    ws_ids.add(uuid.UUID(rest))
                except ValueError:
                    pass
            names = {str(i): n for i, n in db.execute(select(Workshop.id, Workshop.name)
                                                      .where(Workshop.id.in_(ws_ids)))} if ws_ids else {}
            href = "/admin/limits" if admin.can("tariffs") else "/admin/audit?entity=limits&action=cap_hit"
            add("caps_hit", "warning", "Сработали лимиты расходов за сутки", len(caps), href,
                "Мастера получили отказ — проверьте лимиты",
                [{"label": _cap_label(e.entity_id or "", names), "sub": f"{_ago(e.created_at, now)} назад",
                  "href": "/admin/audit?entity=limits&action=cap_hit" if admin.can("audit.view") else href}
                 for e in caps[:5]])

    if admin.can("ai.log"):
        factor = float(values.get("ai_anomaly_factor") or 5)
        # «Сегодня» — последние 24 часа (а не с полуночи: иначе после 00:00 всплеск пропадает из тревог)
        today = now - timedelta(hours=24)
        since = today - timedelta(days=14)
        spend: dict[uuid.UUID, list[int]] = {}
        for wid, created, cost in db.execute(select(AiRequest.workshop_id, AiRequest.created_at,
                                                    AiRequest.cost_microusd)
                                             .where(AiRequest.created_at >= since, AiRequest.workshop_id.is_not(None))):
            b = spend.setdefault(wid, [0, 0])
            b[0 if created >= today else 1] += cost or 0
        flagged = []
        for wid, (t, before) in spend.items():
            avg = before / 14 / 1_000_000
            if t and t / 1_000_000 > factor * max(avg, AI_ANOMALY_FLOOR_USD):
                flagged.append((wid, t / 1_000_000, avg))
        if flagged:
            flagged.sort(key=lambda x: -x[1])
            names = {i: n for i, n in db.execute(select(Workshop.id, Workshop.name)
                                                 .where(Workshop.id.in_([f[0] for f in flagged])))}
            add("ai_anomaly", "warning", f"Необычный расход ИИ (больше среднего в {factor:g} раз)", len(flagged),
                "/admin/ai", "За последние 24 часа против среднего за 14 дней до них",
                [{"label": names.get(wid, str(wid)[:8]), "sub": f"за сутки ${t:.2f} · обычно ${avg:.2f}/день",
                  "href": f"/admin/workshops/{wid}"} for wid, t, avg in flagged[:5]])

    if admin.can("security", "audit.view"):
        failed_actions = ("login_failed", "mfa_failed", "login_locked", "login_while_locked", "mfa_while_locked")
        n = db.scalar(select(func.count(ActionLog.id)).where(
            ActionLog.entity == "staff_auth", ActionLog.action.in_(failed_actions),
            ActionLog.created_at >= now - timedelta(hours=1))) or 0
        week = db.scalar(select(func.count(ActionLog.id)).where(
            ActionLog.entity == "staff_auth", ActionLog.action.in_(failed_actions),
            ActionLog.created_at >= now - timedelta(days=7))) or 0
        hourly = week / (7 * 24)
        if n >= FAILED_LOGIN_SPIKE or (n >= 5 and n > 5 * hourly):
            locked = db.scalar(select(func.count(ActionLog.id)).where(
                ActionLog.entity == "staff_auth", ActionLog.action == "login_locked",
                ActionLog.created_at >= now - timedelta(hours=1))) or 0
            ips = db.execute(select(ActionLog.ip, func.count(ActionLog.id)).where(
                ActionLog.entity == "staff_auth", ActionLog.action.in_(failed_actions),
                ActionLog.created_at >= now - timedelta(hours=1), ActionLog.ip.is_not(None))
                .group_by(ActionLog.ip).order_by(func.count(ActionLog.id).desc()).limit(5)).all()
            add("failed_logins", "critical" if locked or n >= 3 * FAILED_LOGIN_SPIKE else "warning",
                "Всплеск неудачных входов сотрудников", n, "/admin/audit?entity=staff_auth&action=login_failed",
                f"За последний час · обычно {hourly:.1f} в час" + (f" · заблокировано входов: {locked}" if locked else ""),
                [{"label": f"IP {ip}", "sub": f"попыток: {k}", "href": f"/admin/audit?ip={ip}"} for ip, k in ips])

    order = {"critical": 0, "warning": 1, "info": 2}
    items.sort(key=lambda a: order.get(a["severity"], 3))
    return items


@router.get("/alerts", summary="Требует внимания: просрочки, споры, возвраты, цены, лимиты, ИИ, входы, техработы")
def alerts(admin: PlatformDep, db: DbDep, settings: SettingsDep) -> dict:
    """Каждая тревога — `{key, severity: critical|warning|info, title, count, detail, href, items[]}`;
    только по разделам, на которые у сотрудника есть права. `count` в ответе — для значка в меню."""
    items = _alerts(db, settings, admin)
    m = maintenance_state(all_settings(db, settings))
    return {"items": items, "count": sum(1 for a in items if a["severity"] in ("critical", "warning")),
            "maintenance": m, "generated_at": _iso(utcnow())}


# --- Поиск ---


@router.get("/search", summary="Поиск: телефон, цех, мастер, номер заказа, проект, сотрудник, поставщик")
def search(admin: PlatformDep, db: DbDep, q: Annotated[str, Query(min_length=1, max_length=100)],
           limit: int = Query(6, ge=1, le=20)) -> dict:
    """Группы результатов — только по разделам, к которым у сотрудника есть доступ.
    Цифры (от 3) ищутся в телефонах и номерах заказов, текст (от 2 букв) — в названиях и именах."""
    q = q.strip()
    digits = "".join(ch for ch in q if ch.isdigit())
    text = q if len(q) >= 2 else ""
    like = _like(text) if text else None
    phone = f"%{digits}%" if len(digits) >= 3 else None
    groups: list[dict] = []

    def group(key: str, title: str, items: list[dict]) -> None:
        if items:
            groups.append({"key": key, "title": title, "items": items[:limit]})

    if admin.can("workshops.view", "workshops.grant") and (like or phone):
        conds = []
        if like:
            conds.append(func.lower(Workshop.name).like(like, escape="\\"))
        if phone:
            conds += [Workshop.phone.like(phone), Workshop.id.in_(select(User.workshop_id).where(User.phone.like(phone)))]
        rows = list(db.scalars(select(Workshop).where(or_(*conds)).order_by(Workshop.created_at.desc()).limit(limit)))
        group("workshops", "Цеха", [{
            "id": str(w.id), "title": w.name, "href": f"/admin/workshops/{w.id}",
            "sub": " · ".join(x for x in (w.city, w.phone, "Pro" if w.plan == "pro" else None,
                                          "заблокирован" if w.blocked else None) if x)} for w in rows])
        uconds = []
        if like:
            uconds.append(func.lower(User.name).like(like, escape="\\"))
        if phone:
            uconds.append(User.phone.like(phone))
        rows = db.execute(select(User, Workshop).join(Workshop, User.workshop_id == Workshop.id)
                          .where(or_(*uconds), User.deleted_at.is_(None)).order_by(User.created_at.desc())
                          .limit(limit)).all()
        group("masters", "Мастера", [{
            "id": str(u.id), "title": u.name or u.phone, "href": f"/admin/workshops/{w.id}",
            "sub": " · ".join(x for x in (u.phone if u.name else None, w.name,
                                          "владелец" if u.role == "owner" else "сотрудник") if x)}
            for u, w in rows])

    if admin.can("orders.manage") and (digits or like):
        conds = []
        if digits and len(digits) <= 9:
            conds.append(cast(Order.number, String).like(f"{digits}%"))
        if like:
            conds.append(func.lower(Project.title).like(like, escape="\\"))
        if conds:
            rows = db.execute(select(Order, Project, Workshop).join(Project, Order.project_id == Project.id)
                              .join(Workshop, Project.workshop_id == Workshop.id).where(or_(*conds))
                              .order_by(Order.created_at.desc()).limit(limit)).all()
            group("orders", "Заказы", [{
                "id": str(o.id), "title": f"Заказ №{o.number or str(o.id)[:8]}", "href": f"/admin/orders/{o.id}",
                "sub": " · ".join(x for x in (ORDER_STATUS_LABELS.get(o.status, o.status), w.name, p.title) if x)}
                for o, p, w in rows])

    if admin.can("projects.view") and like:
        rows = db.execute(select(Project, Workshop).join(Workshop, Project.workshop_id == Workshop.id)
                          .where(func.lower(Project.title).like(like, escape="\\"), Project.deleted_at.is_(None))
                          .order_by(Project.updated_at.desc()).limit(limit)).all()
        group("projects", "Проекты", [{
            "id": str(p.id), "title": p.title, "href": f"/admin/projects/{p.id}",
            "sub": f"{STATUS_LABELS.get(ProjectStatus(p.status), p.status)} · {w.name}"} for p, w in rows])

    if admin.can("staff.manage") and like:
        rows = list(db.scalars(select(StaffUser).where(or_(func.lower(StaffUser.email).like(like, escape="\\"),
                                                           func.lower(StaffUser.name).like(like, escape="\\")))
                               .order_by(StaffUser.created_at.desc()).limit(limit)))
        group("staff", "Сотрудники", [{
            "id": str(s.id), "title": s.name, "href": f"/admin/staff?q={s.email}",
            "sub": " · ".join(x for x in (s.email, ROLES.get(s.role, {}).get("title", s.role),
                                          None if s.is_active else "отключён") if x)} for s in rows])

    if admin.can("suppliers.manage", "catalog.manage", "orders.manage") and like:
        rows = list(db.scalars(select(Supplier).where(or_(func.lower(Supplier.name).like(like, escape="\\"),
                                                          func.lower(Supplier.code).like(like, escape="\\")))
                               .order_by(Supplier.name).limit(limit)))
        can_open = admin.can("suppliers.manage")
        group("suppliers", "Поставщики", [{
            "id": str(s.id), "title": s.name,
            "href": f"/admin/suppliers/{s.id}" if can_open else f"/admin/orders?supplier_id={s.id}",
            "sub": " · ".join(x for x in (s.code, None if s.active else "заблокирован") if x)} for s in rows])

    return {"q": q, "groups": groups, "total": sum(len(g["items"]) for g in groups)}


# --- Журнал действий ---


def _reason(e: ActionLog) -> str | None:
    for src in (e.after, e.before):
        if isinstance(src, dict) and isinstance(src.get("reason"), str) and src["reason"].strip():
            return src["reason"].strip()
    return None


def _ip(e: ActionLog) -> str | None:
    if e.ip:
        return e.ip
    if isinstance(e.after, dict) and isinstance(e.after.get("ip"), str):
        return e.after["ip"]  # до 0012 IP входа писался в after
    return None


_LINKS = {"order": "/admin/orders/{}", "workshop": "/admin/workshops/{}", "supplier": "/admin/suppliers/{}",
          "project": "/admin/projects/{}", "impersonation": "/admin/workshops/{}"}


def _link(e: ActionLog) -> str | None:
    if e.entity in _LINKS and e.entity_id:
        try:
            return _LINKS[e.entity].format(uuid.UUID(e.entity_id))
        except ValueError:
            return None
    if e.workshop_id:
        return f"/admin/workshops/{e.workshop_id}"
    return None


def _audit_stmt(db, actor: str | None, actor_type: str | None, entity: str | None, action: str | None,
                from_: str | None, to: str | None, q: str | None, ip: str | None, workshop_id: uuid.UUID | None):
    stmt = select(ActionLog)
    if actor:
        stmt = stmt.where(ActionLog.actor_id == actor.strip())
    if actor_type:
        stmt = stmt.where(ActionLog.actor_type == actor_type)
    if entity:
        stmt = stmt.where(ActionLog.entity == entity)
    if action:
        stmt = stmt.where(ActionLog.action == action)
    if workshop_id:
        stmt = stmt.where(ActionLog.workshop_id == workshop_id)
    if ip:
        stmt = stmt.where(or_(ActionLog.ip == ip.strip(), cast(ActionLog.after, String).like(f'%"ip": "{ip.strip()}"%')))
    if from_ or to:
        start, end = finance.period(from_, to)
        stmt = stmt.where(ActionLog.created_at >= start, ActionLog.created_at < end)
    if q and q.strip():
        q = q.strip()
        conds = []
        # JSON хранится с \uXXXX вместо кириллицы — ищем и так, и так
        variants = {q, q.lower(), q[:1].upper() + q[1:]}
        for v in variants:
            for form in {v, json.dumps(v)[1:-1]}:
                pat = "%" + form.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                conds += [cast(ActionLog.after, String).like(pat, escape="\\"),
                          cast(ActionLog.before, String).like(pat, escape="\\")]
        like = _like(q)
        conds += [func.lower(ActionLog.entity_id).like(like, escape="\\"),
                  func.lower(ActionLog.actor_id).like(like, escape="\\"),
                  func.lower(ActionLog.action).like(like, escape="\\"),
                  func.lower(ActionLog.entity).like(like, escape="\\"),
                  ActionLog.ip.like(like, escape="\\")]
        staff_ids = [str(i) for i in db.scalars(select(StaffUser.id).where(or_(
            func.lower(StaffUser.name).like(like, escape="\\"), func.lower(StaffUser.email).like(like, escape="\\"))))]
        if staff_ids:  # «кто»: по имени или почте сотрудника
            conds.append(ActionLog.actor_id.in_(staff_ids))
        stmt = stmt.where(or_(*conds))
    return stmt


def _actors(db, rows: list[ActionLog]) -> dict[str, dict]:
    staff_ids, user_ids = set(), set()
    for e in rows:
        if not e.actor_id:
            continue
        try:
            (staff_ids if e.actor_type == "staff" else user_ids).add(uuid.UUID(e.actor_id))
        except ValueError:
            pass
    out: dict[str, dict] = {"admin-token": {"name": "Общий токен админки", "email": None, "role": "superadmin"}}
    if staff_ids:
        for s in db.scalars(select(StaffUser).where(StaffUser.id.in_(staff_ids))):
            out[str(s.id)] = {"name": s.name, "email": s.email, "role": s.role}
    if user_ids:
        for u in db.scalars(select(User).where(User.id.in_(user_ids))):
            out[str(u.id)] = {"name": u.name or u.phone, "email": None, "role": "master"}
    return out


def _entry(e: ActionLog, actors: dict[str, dict], workshops: dict[uuid.UUID, str]) -> dict:
    a = actors.get(e.actor_id or "") or {}
    return {
        "id": str(e.id), "created_at": _iso(e.created_at), "actor_type": e.actor_type, "actor_id": e.actor_id,
        "actor_name": a.get("name"), "actor_email": a.get("email"),
        "actor_role": ROLES.get(a.get("role") or "", {}).get("title") if a.get("role") != "master" else "мастер",
        "ip": _ip(e), "entity": e.entity, "entity_id": e.entity_id, "action": e.action, "reason": _reason(e),
        "workshop_id": str(e.workshop_id) if e.workshop_id else None,
        "workshop_name": workshops.get(e.workshop_id) if e.workshop_id else None,
        "before": e.before, "after": e.after, "href": _link(e),
    }


def _enrich(db, rows: list[ActionLog]) -> list[dict]:
    actors = _actors(db, rows)
    wids = {e.workshop_id for e in rows if e.workshop_id}
    workshops = dict(db.execute(select(Workshop.id, Workshop.name).where(Workshop.id.in_(wids))).all()) if wids else {}
    return [_entry(e, actors, workshops) for e in rows]


@router.get("/audit", summary="Журнал действий: фильтры, IP, причина, кто сделал (только чтение)")
def audit(admin: AuditDep, db: DbDep, actor: str | None = None, actor_type: str | None = None,
          entity: str | None = None, action: str | None = None,
          from_: Annotated[str | None, Query(alias="from")] = None, to: str | None = None,
          q: Annotated[str | None, Query(max_length=200, description="Текст: причина, id, IP, имя сотрудника")] = None,
          ip: Annotated[str | None, Query(max_length=64)] = None, workshop_id: uuid.UUID | None = None,
          page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200)) -> dict:
    stmt = _audit_stmt(db, actor, actor_type, entity, action, from_, to, q, ip, workshop_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = list(db.scalars(stmt.order_by(ActionLog.created_at.desc(), ActionLog.id)
                           .limit(page_size).offset((page - 1) * page_size)))
    return {"items": _enrich(db, rows), "total": total, "page": page, "page_size": page_size}


@router.get("/audit/facets", summary="Журнал: значения для фильтров (объекты, действия, сотрудники)")
def audit_facets(admin: AuditDep, db: DbDep) -> dict:
    pairs = db.execute(select(ActionLog.entity, ActionLog.action, func.count(ActionLog.id))
                       .group_by(ActionLog.entity, ActionLog.action)).all()
    entities: dict[str, int] = {}
    actions: dict[str, dict[str, int]] = {}
    for ent, act, n in pairs:
        entities[ent] = entities.get(ent, 0) + n
        actions.setdefault(ent, {})[act] = n
    staff = [{"id": str(s.id), "name": s.name, "email": s.email,
              "role": ROLES.get(s.role, {}).get("title", s.role), "is_active": s.is_active,
              "supplier": s.supplier_id is not None}
             for s in db.scalars(select(StaffUser).order_by(StaffUser.name))]
    return {"entities": [{"value": k, "count": v} for k, v in sorted(entities.items())],
            "actions": {k: sorted(v) for k, v in actions.items()},
            "actor_types": sorted({t for (t,) in db.execute(select(ActionLog.actor_type).distinct())}),
            "staff": [{"id": "admin-token", "name": "Общий токен админки", "email": None, "role": "Суперадмин",
                       "is_active": True, "supplier": False}, *staff]}


EXPORT_MAX = 20_000


@router.get("/audit/export.csv", summary="Журнал действий — CSV (те же фильтры, до 20 000 строк)",
            responses={200: {"content": {"text/csv": {}}}})
def audit_csv(admin: AuditDep, db: DbDep, actor: str | None = None, actor_type: str | None = None,
              entity: str | None = None, action: str | None = None,
              from_: Annotated[str | None, Query(alias="from")] = None, to: str | None = None,
              q: Annotated[str | None, Query(max_length=200)] = None, ip: Annotated[str | None, Query(max_length=64)] = None,
              workshop_id: uuid.UUID | None = None) -> Response:
    stmt = _audit_stmt(db, actor, actor_type, entity, action, from_, to, q, ip, workshop_id)
    rows = list(db.scalars(stmt.order_by(ActionLog.created_at.desc(), ActionLog.id).limit(EXPORT_MAX)))
    out = io.StringIO()
    w = SafeWriter(csv.writer(out, delimiter=";"))  # причины и имена — текстом, не формулой
    w.writerow(["Время (Ташкент)", "Кто", "Почта", "Роль", "Тип", "IP", "Объект", "ID объекта", "Действие",
                "Причина", "Цех", "Было", "Стало"])
    dump = lambda v: json.dumps(v, ensure_ascii=False, sort_keys=True) if v is not None else ""  # noqa: E731
    for e in _enrich(db, rows):
        when = datetime.fromisoformat(e["created_at"]).astimezone(TZ).strftime("%d.%m.%Y %H:%M:%S")
        w.writerow([when, e["actor_name"] or e["actor_id"] or "", e["actor_email"] or "", e["actor_role"] or "",
                    e["actor_type"], e["ip"] or "", e["entity"], e["entity_id"] or "", e["action"], e["reason"] or "",
                    e["workshop_name"] or "", dump(e["before"]), dump(e["after"])])
    filters = {k: v for k, v in {"actor": actor, "actor_type": actor_type, "entity": entity, "action": action,
                                 "from": from_, "to": to, "q": q, "ip": ip,
                                 "workshop_id": str(workshop_id) if workshop_id else None}.items() if v}
    log_action(db, actor_type=admin.type, actor_id=admin.id, entity="audit", entity_id=None, action="export",
               after={"filters": filters, "rows": len(rows)})
    db.commit()
    stamp = date.today().isoformat()
    return Response(content=("﻿" + out.getvalue()).encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="audit_{stamp}.csv"'})
