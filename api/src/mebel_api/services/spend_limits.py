"""Лимиты расходов и аварийные выключатели из админки (§4a, ADM-12): ИИ (общий и на цех в день),
SMS с кодами входа (в час и в сутки), регистрация новых цехов. Значения — app_settings (0 — без лимита).

Защита от выедания общих лимитов (docs/staff_vendor_contract.md §8):
- SMS: номера без аккаунта тратят не больше `sms_new_numbers_share` общего лимита — остаток всегда остаётся
  на вход существующих мастеров; плюс лимиты на IP и на блок номеров (services/auth_codes.py).
- ИИ: дневной лимит цеха — не больше доли общего, у новых (неплатящих) цехов — меньше; общий лимит сначала
  закрывается новым цехам, платящие сохраняют запас. Плюс часовой лимит цеха и резерв на задачи в очереди.
- Сработавший лимит — в лог (ERROR) и в журнал действий (`entity = limits`, `action = cap_hit`), не чаще раза в час.
"""

import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from ..config import Settings
from ..db import utcnow
from ..errors import ApiError
from ..models import ActionLog, AiRequest, AuthCode, Order, Payment, Project, Workshop
from .app_settings import get_setting

TZ = ZoneInfo("Asia/Tashkent")
log = logging.getLogger("mebel_api.limits")
ALERT_EVERY = timedelta(hours=1)


def day_start(now: datetime | None = None) -> datetime:
    local = (now or utcnow()).astimezone(TZ)
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def cap_hit(db: Session, cap: str, details: dict | None = None) -> None:
    """Тревога: лимит сработал. Лог — всегда; запись в журнал — не чаще раза в час на лимит.
    Пишется отдельной сессией: запрос дальше падает с ошибкой, его транзакция откатывается."""
    log.error("Лимит сработал: %s %s", cap, details or {})
    try:
        with sessionmaker(bind=db.get_bind(), expire_on_commit=False)() as s:
            recent = s.scalar(select(ActionLog.id).where(
                ActionLog.entity == "limits", ActionLog.entity_id == cap, ActionLog.action == "cap_hit",
                ActionLog.created_at > utcnow() - ALERT_EVERY).limit(1))
            if recent is None:
                s.add(ActionLog(actor_type="system", entity="limits", entity_id=cap, action="cap_hit",
                                after=details or {}))
                s.commit()
    except Exception:  # тревога не должна ронять запрос
        log.exception("cap_hit: не удалось записать в журнал")


# --- ИИ ---


def ai_spent(db: Session, since: datetime, workshop_id=None) -> float:
    stmt = select(func.coalesce(func.sum(AiRequest.cost_microusd), 0)).where(AiRequest.created_at >= since)
    if workshop_id is not None:
        stmt = stmt.where(AiRequest.workshop_id == workshop_id)
    return (db.scalar(stmt) or 0) / 1_000_000


def ai_spent_today(db: Session, workshop_id=None) -> float:
    return ai_spent(db, day_start(), workshop_id)


def is_paying(db: Session, workshop: Workshop) -> bool:
    """Платящий цех: Pro, оплата платформе (пакет, Pro, файлы) или оплаченный заказ поставщику."""
    now = utcnow()
    if workshop.plan == "pro" and (workshop.pro_until is None or workshop.pro_until > now):
        return True
    if db.scalar(select(Payment.id).where(Payment.workshop_id == workshop.id, Payment.status == "paid").limit(1)):
        return True
    return db.scalar(select(Order.id).join(Project, Order.project_id == Project.id)
                     .where(Project.workshop_id == workshop.id, Order.paid_at.is_not(None)).limit(1)) is not None


def ai_caps(db: Session, settings: Settings, workshop: Workshop) -> dict:
    """Действующие лимиты ИИ для цеха, $ (0 — без лимита)."""
    paying = is_paying(db, workshop)
    total = float(get_setting(db, settings, "ai_daily_usd_global") or 0)
    per = float(get_setting(db, settings, "ai_daily_usd_per_workshop") or 0)
    if not paying and settings.ai_new_workshop_daily_usd > 0:
        per = min(per, settings.ai_new_workshop_daily_usd) if per else settings.ai_new_workshop_daily_usd
    if total and settings.ai_workshop_max_share > 0:  # цех не может выесть общий лимит в одиночку
        ceiling = total * settings.ai_workshop_max_share
        per = min(per, ceiling) if per else ceiling
    hourly = settings.ai_workshop_hourly_usd if paying else settings.ai_new_workshop_hourly_usd
    global_cap = total if paying else total * (1 - min(max(settings.ai_paying_reserve_share, 0.0), 1.0))
    return {"paying": paying, "global": global_cap, "daily": per, "hourly": max(hourly, 0.0)}


def _over(spent: float, reserve: float, cap: float) -> bool:
    return spent >= cap or spent + reserve > cap


def ensure_ai_allowed(db: Session, settings: Settings, workshop: Workshop, *, reserved_global: float = 0.0,
                      reserved_workshop: float = 0.0, reserve: float = 0.0) -> None:
    """reserved_* — оценка стоимости задач, уже стоящих в очереди (ещё не записаны в журнал ИИ);
    reserve — оценка новой задачи: лимит должен вместить и её."""
    if not get_setting(db, settings, "ai_enabled"):
        raise ApiError(503, "ai_disabled", "ИИ временно выключен. Правка полями и тапом работает")
    caps = ai_caps(db, settings, workshop)
    tier = "paying" if caps["paying"] else "new"
    if caps["global"]:
        spent = ai_spent_today(db) + reserved_global
        if _over(spent, reserve, caps["global"]):
            cap_hit(db, f"ai_daily_global:{tier}", {"spent_usd": round(spent, 4), "cap_usd": caps["global"]})
            raise ApiError(503, "ai_daily_limit", "ИИ на сегодня перегружен. Попробуйте завтра или правьте полями")
    if caps["daily"]:
        spent = ai_spent_today(db, workshop.id) + reserved_workshop
        if _over(spent, reserve, caps["daily"]):
            cap_hit(db, f"ai_daily_workshop:{workshop.id}", {"spent_usd": round(spent, 4), "cap_usd": caps["daily"],
                                                              "tier": tier})
            raise ApiError(429, "ai_workshop_daily_limit",
                           "Дневной лимит ИИ для цеха исчерпан. Завтра снова доступно; правка полями работает")
    if caps["hourly"]:
        spent = ai_spent(db, utcnow() - timedelta(hours=1), workshop.id) + reserved_workshop
        if _over(spent, reserve, caps["hourly"]):
            cap_hit(db, f"ai_hourly_workshop:{workshop.id}", {"spent_usd": round(spent, 4),
                                                               "cap_usd": caps["hourly"], "tier": tier})
            raise ApiError(429, "ai_workshop_hourly_limit",
                           "Слишком много ИИ-запросов за час. Попробуйте позже; правка полями работает")


# --- SMS ---


def ensure_sms_allowed(db: Session, settings: Settings, *, existing: bool = True) -> None:
    """Общий лимит SMS в час и в сутки. existing=False (номер без аккаунта) — только доля
    `sms_new_numbers_share`: при атаке новыми номерами существующие мастера всё равно входят."""
    now = utcnow()
    share = 1.0 if existing else min(max(settings.sms_new_numbers_share, 0.0), 1.0)
    for key, window, message in (
        ("sms_per_hour", timedelta(hours=1), "Сервис входа перегружен. Попробуйте через несколько минут"),
        ("sms_per_day", timedelta(days=1), "Сервис входа перегружен. Попробуйте позже"),
    ):
        cap = int(get_setting(db, settings, key) or 0)
        if not cap:
            continue
        used = db.scalar(select(func.count(AuthCode.id)).where(AuthCode.created_at > now - window)) or 0
        limit = cap if existing else int(cap * share)
        if used >= limit:
            cap_hit(db, f"{key}:{'existing' if existing else 'new'}", {"used": used, "cap": limit})
            raise ApiError(429, "sms_limit", message)


def registration_open(db: Session, settings: Settings) -> bool:
    return bool(get_setting(db, settings, "registration_enabled"))
