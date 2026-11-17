"""Производство цеха (SCR-56): настройки присадки → правила ядра (mebel_core.production_rules).

Правила цеха действуют везде, где сервер собирает модель этого цеха: новая версия (просмотр, детали в 3D),
файлы (чертежи, комплект, DXF, CSV, Excel), смета (число конфирматов / шкантов), заказ поставщику.
Уже сохранённые версии хранят присадку на момент сборки (viewer); файлы строятся заново по текущим настройкам.
"""

from typing import Any

from mebel_core import HINGE_BRANDS, DEFAULT_RULES, RuleSet, normalize_production, production_rules
from mebel_core.rules import PRODUCTION_DEFAULTS
from mebel_core.units import to_mm
from sqlalchemy.orm import Session

from ..models import Project, Workshop


def settings_of(workshop: Workshop | None) -> dict[str, Any] | None:
    """Сохранённые настройки цеха (уже проверенные при записи); битые — как будто не сохранял."""
    raw = workshop.production if workshop is not None else None
    if not raw:
        return None
    try:
        return normalize_production(raw)
    except (ValueError, TypeError):
        return None


def rules_for(workshop: Workshop | None) -> RuleSet:
    """Правила сборки для цеха (кэшируются в ядре по значениям настроек)."""
    s = settings_of(workshop)
    return production_rules(s) if s else DEFAULT_RULES


def rules_for_project(db: Session, project: Project) -> RuleSet:
    return rules_for(db.get(Workshop, project.workshop_id))


def rules_key(workshop: Workshop | None) -> str:
    """Метка правил — для кэша производных файлов (оглавление комплекта)."""
    return rules_for(workshop).version


def hinge_brands() -> list[dict[str, Any]]:
    out = []
    for key, b in HINGE_BRANDS.items():
        r = DEFAULT_RULES.model_copy(update={k: v for k, v in b.items() if k != "name"})
        out.append({
            "id": key, "name": b["name"], "plate_pattern": r.hinge_plate_pattern,
            "plate_spacing_mm": to_mm(r.hinge_plate_spacing), "plate_line_mm": to_mm(r.system32_front),
            "cup_diameter_mm": to_mm(r.hinge_cup_diameter), "cup_depth_mm": to_mm(r.hinge_cup_depth),
            "cup_from_edge_mm": to_mm(r.hinge_cup_from_edge),
        })
    return out


def production_out(workshop: Workshop) -> dict[str, Any]:
    s = settings_of(workshop)
    return {**(s or PRODUCTION_DEFAULTS), "saved": s is not None, "hinge_brands": hinge_brands()}


def update(workshop: Workshop, patch: dict[str, Any]) -> dict[str, Any]:
    """Новые настройки поверх текущих; ValueError — недопустимое значение."""
    merged = normalize_production({**(settings_of(workshop) or PRODUCTION_DEFAULTS), **patch})
    workshop.production = merged
    return merged
