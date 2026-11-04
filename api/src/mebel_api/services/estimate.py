"""Смета через ядро: цены цеха → PricingSettings → estimate_range / client_view.

Смета считается на лету (≈ 50–160 мс с раскроем) по текущим ценам каталога и
наценкам цеха. Для ссылки клиента сохраняется снимок (раздел 19 PRD: после
изменения цен клиент видит старую цену с датой).
"""

import logging
from typing import Any

from mebel_core.estimate import EstimateRange, PricingSettings, client_view, estimate_range

from ..db import utcnow
from ..domain import LaborMode, ProjectStatus as S
from ..models import ModelVersion, Project, Workshop
from ..schemas.estimate import MasterEstimate, MasterEstimateLine, PriceRange, StaffEstimate
from .visibility import for_client

log = logging.getLogger(__name__)

# После замера размеры подтверждены — цена точная
MEASURED_STATUSES = {S.measured, S.contract, S.in_work, S.delivered}


def pricing_settings(w: Workshop) -> PricingSettings:
    return PricingSettings(
        work_percent=w.labor_percent,
        work_fixed=w.labor_fixed if w.labor_mode == LaborMode.fixed else None,
        markup={"body": w.markup_body, "fronts": w.markup_fronts, "hardware": w.markup_hardware,
                "services": w.markup_services},
    )


def is_measured(project: Project) -> bool:
    return S(project.status) in MEASURED_STATUSES


def compute_range(version: ModelVersion | None, workshop: Workshop, measured: bool) -> EstimateRange | None:
    """None — если модели нет, в ней ошибки или ядро не смогло посчитать смету."""
    if version is None or not version.ok:
        return None
    try:
        from .prices import price_book_for

        # estimated — пометки «оценка» версии (размеры по фото, материал на глаз): от них ширина полосы
        return estimate_range(version.tree, pricing_settings(workshop), measured=measured,
                              prices=price_book_for(workshop), estimated=list(version.estimated or []))
    except Exception:  # смета не должна ронять карточку проекта
        log.exception("estimate failed for version %s", version.id)
        return None


def _pr(low: int, high: int) -> PriceRange:
    return PriceRange(**{"from": low, "to": high})


def staff_estimate(er: EstimateRange) -> StaffEstimate:
    return StaffEstimate(
        exact=er.exact,
        total=_pr(er.total.low, er.total.high),
        expected=er.expected,
        band_percent=round(er.band * 100, 1),
        uncertainty=[u.model_dump() for u in er.uncertainty],
        uncertainty_text=er.uncertainty_text,
        uncertainty_text_uz=er.uncertainty_text_uz,
        materials_client=_pr(er.materials.low, er.materials.high),
        work=_pr(er.work.low, er.work.high),
        has_requests=er.low.has_requests,
        sheets=er.low.sheets,
        priced_at=utcnow(),
    )


def master_estimate(er: EstimateRange, workshop: Workshop) -> MasterEstimate:
    cost = er.band_range(er.low.cost_total)
    return MasterEstimate(
        **staff_estimate(er).model_dump(by_alias=True),
        cost_materials=_pr(cost.low, cost.high),
        cost_by_category=er.low.cost_by_category,
        markup_percent=pricing_settings(workshop).markup,
        lines=[MasterEstimateLine.model_validate(line.model_dump()) for line in er.low.lines],
    )


def client_estimate(er: EstimateRange, view: str, workshop: Workshop) -> dict[str, Any]:
    # client_view ядра уже без себестоимости; for_client — вторая линия защиты
    return for_client(client_view(er, view, pricing_settings(workshop)))


def price_of(er: EstimateRange) -> dict[str, Any]:
    return {"from": er.total.low, "to": er.total.high, "exact": er.exact, "at": utcnow().isoformat()}


def remember(db, project: Project, version: ModelVersion | None, er: EstimateRange | None, *,
             commit: bool = True) -> None:
    """Смета посчитана: цена — в кэш версии (для списка проектов), позиции «под запрос» — в очередь ADM-07,
    устаревшие цены — push мастеру. Ошибки здесь не должны ломать ответ со сметой."""
    if version is None or er is None:
        return
    try:
        cache = price_of(er)
        old = version.price_cache or {}
        if (old.get("from"), old.get("to"), old.get("exact")) != (cache["from"], cache["to"], cache["exact"]):
            version.price_cache = cache
        if not project.is_example:
            from . import events, price_requests

            price_requests.sync(db, project, version, er)
            if er.low.has_stale:
                events.prices_stale(db, project)
        if commit:
            db.commit()
    except Exception:
        log.exception("remember estimate failed for project %s", project.id)
        db.rollback()
