"""Лимит проектов (раздел 9 PRD).

- Бесплатно: FREE_PROJECTS_PER_MONTH проектов в календарный месяц (время Ташкента).
- Проект списывается при переходе «Черновик → Эскиз», один раз.
- Примеры («Попробовать на примере») не списываются никогда.
- Когда заказ в EMAN по проекту оплачен, проект возвращается в лимит того
  месяца, в котором был списан (пакет — возвращается в остаток пакета).
- Сверх бесплатного лимита списывается пакет; Pro — без лимита.
- Удалённые и отменённые проекты лимит не возвращают.
- Перерасход бюджета ИИ в проекте списывает ещё один проект (ExtraCharge) по тем же
  правилам: Pro → бесплатный лимит месяца → пакет. Такие списания в лимит не возвращаются.
"""

from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..db import utcnow
from ..domain import ChargeSource, Plan
from ..errors import ApiError
from ..models import ExtraCharge, Project, Workshop


def period_of(settings: Settings, moment: datetime) -> str:
    return moment.astimezone(ZoneInfo(settings.limit_timezone)).strftime("%Y-%m")


@dataclass
class LimitState:
    plan: Plan
    period: str
    free_limit: int
    free_used: int
    free_left: int
    pack_left: int
    unlimited: bool

    @property
    def can_charge(self) -> bool:
        return self.unlimited or self.free_left > 0 or self.pack_left > 0


def _is_pro(workshop: Workshop, now: datetime) -> bool:
    return workshop.plan == Plan.pro and (workshop.pro_until is None or workshop.pro_until > now)


def limit_state(db: Session, settings: Settings, workshop: Workshop, now: datetime | None = None) -> LimitState:
    now = now or utcnow()
    period = period_of(settings, now)
    used = db.scalar(
        select(func.count(Project.id)).where(
            Project.workshop_id == workshop.id,
            Project.charge_period == period,
            Project.charge_source == ChargeSource.free,
            Project.returned_to_limit_at.is_(None),
        )
    ) or 0
    used += db.scalar(
        select(func.count(ExtraCharge.id)).where(
            ExtraCharge.workshop_id == workshop.id,
            ExtraCharge.period == period,
            ExtraCharge.source == ChargeSource.free,
        )
    ) or 0
    limit = settings.free_projects_per_month
    return LimitState(
        plan=Plan(workshop.plan),
        period=period,
        free_limit=limit,
        free_used=used,
        free_left=max(0, limit - used),
        pack_left=workshop.pack_projects_left,
        unlimited=_is_pro(workshop, now),
    )


def limit_exhausted_error(state: LimitState) -> ApiError:
    return ApiError(
        402,
        "limit_exhausted",
        f"Бесплатные проекты в этом месяце закончились ({state.free_used} из {state.free_limit}). "
        "Закажите материалы по проекту в EMAN — проект вернётся в лимит, или купите пакет проектов",
        {"period": state.period, "free_limit": state.free_limit, "free_used": state.free_used},
    )


def ensure_can_charge(db: Session, settings: Settings, workshop: Workshop, needed: int) -> LimitState:
    """Хватит ли лимита на `needed` проектов сразу (несколько предметов на фото). Нет — 402 limit_exhausted."""
    state = limit_state(db, settings, workshop)
    left = state.free_left + state.pack_left
    if needed <= 0 or state.unlimited or left >= needed:
        return state
    base = limit_exhausted_error(state)
    raise ApiError(
        402,
        base.code,
        f"Не хватает лимита: нужно проектов — {needed}, осталось — {left}. Выберите меньше предметов, "
        "закажите материалы в EMAN — проект вернётся в лимит, или купите пакет проектов",
        {**base.details, "needed": needed, "left": left, "pack_left": state.pack_left},
    )


def _pick_source(db: Session, settings: Settings, workshop: Workshop, now: datetime) -> ChargeSource:
    # Блокируем строку цеха, чтобы два параллельных списания не обошли лимит (Postgres)
    db.execute(select(Workshop.id).where(Workshop.id == workshop.id).with_for_update())
    state = limit_state(db, settings, workshop, now)
    if state.unlimited:
        return ChargeSource.pro
    if state.free_left > 0:
        return ChargeSource.free
    if state.pack_left > 0:
        workshop.pack_projects_left -= 1
        return ChargeSource.pack
    raise limit_exhausted_error(state)


def charge_extra(
    db: Session, settings: Settings, workshop: Workshop, project: Project, *, reason: str = "ai_budget",
    user_id=None,
) -> ExtraCharge:
    """Ещё один проект из лимита — за перерасход бюджета ИИ в проекте."""
    now = utcnow()
    source = _pick_source(db, settings, workshop, now)
    row = ExtraCharge(workshop_id=workshop.id, project_id=project.id, reason=reason,
                      period=period_of(settings, now), source=source, user_id=user_id)
    db.add(row)
    db.flush()
    return row


def charge_project(db: Session, settings: Settings, workshop: Workshop, project: Project) -> ChargeSource | None:
    """Списывает проект из лимита. Повторно и для примеров — ничего не делает."""
    if project.is_example or project.charged_at is not None:
        return None
    # Блокируем строку цеха, чтобы два параллельных перехода не обошли лимит (Postgres)
    db.execute(select(Workshop.id).where(Workshop.id == workshop.id).with_for_update())
    now = utcnow()
    state = limit_state(db, settings, workshop, now)
    if state.unlimited:
        source = ChargeSource.pro
    elif state.free_left > 0:
        source = ChargeSource.free
    elif state.pack_left > 0:
        source = ChargeSource.pack
        workshop.pack_projects_left -= 1
    else:
        raise limit_exhausted_error(state)
    project.charged_at = now
    project.charge_period = period_of(settings, now)
    project.charge_source = source
    return source


def return_to_limit(db: Session, workshop: Workshop, project: Project) -> bool:
    """Возвращает проект в лимит после оплаты заказа в EMAN."""
    if project.charged_at is None or project.returned_to_limit_at is not None:
        return False
    project.returned_to_limit_at = utcnow()
    if project.charge_source == ChargeSource.pack:
        workshop.pack_projects_left += 1
    return True
