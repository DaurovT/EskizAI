from fastapi import APIRouter

from ..deps import CurrentDep, DbDep, OwnerDep, SettingsDep
from ..errors import ERROR_RESPONSES
from ..schemas.workshops import LimitsOut
from ..services.limits import limit_state
from ..services.payments import history

router = APIRouter(prefix="/billing", tags=["billing"], responses=ERROR_RESPONSES)


@router.get("/limits", response_model=LimitsOut, summary="Лимит проектов цеха")
def limits(current: CurrentDep, db: DbDep, settings: SettingsDep) -> LimitsOut:
    """Бесплатно — 3 проекта в месяц; проект с оплаченным заказом в EMAN возвращается в лимит."""
    s = limit_state(db, settings, current.workshop)
    return LimitsOut(
        plan=s.plan, period=s.period, free_limit=s.free_limit, free_used=s.free_used, free_left=s.free_left,
        pack_left=s.pack_left, unlimited=s.unlimited, can_create_sketch=s.can_charge,
    )


@router.get("/payments", summary="Платежи платформе: пакеты, Pro, файлы, возвраты (SCR-42, владелец)")
def payments(current: OwnerDep, db: DbDep) -> dict:
    """Новые сверху. `status`: paid | refunded (`refunded_at`); `amount` — сумы (null — сумма не записана);
    `method`: app_store, google_play, click, payme, manual; `receipt_url` — чек, если есть.
    Оплаты материалов сюда не входят — они в карточке заказа EMAN."""
    items = history(db, current.workshop.id, current.user.language)
    return {"items": items, "total": len(items)}
