"""Группы позиций каталога и строк BOM (shapes_contract.md §9.7): поставщики по категории и наценка по группам.

Категории поставщика: profile | glass | fittings | other (у работ поставщика нет).
Группы наценки:       profile | glass | fittings | works | other.
Группа строки BOM берётся по роли (code) и виду строки (kind) — bom.py группу не хранит.
"""
from __future__ import annotations

SUPPLIER_CATEGORIES = ("profile", "glass", "fittings", "other")
MARKUP_GROUPS = ("profile", "glass", "fittings", "works", "other")
GROUP_NAMES = {"profile": "Профиль", "glass": "Стекло", "fittings": "Фурнитура", "works": "Работы", "other": "Прочее"}

# профильная система: профили, штапики, армирование, уплотнитель, ламбри, цвет и ламинация профиля
PROFILE_ROLES = {"frame", "sash", "mullion", "door_frame", "door_sash", "door_mullion", "shtulp", "threshold",
                 "bead_single", "bead_igu", "bead_triple", "lambri", "reinforcement", "thermo_insert", "seal",
                 "joint_profile", "coupling_profile", "profile_color", "lamination", "threshold_alu", "threshold_hs",
                 # §11: раздвижные, гильотинное окно, гильотина
                 "sl_frame", "sl_rail", "sl_sash", "sl_interlock", "sl_brush", "sl_threshold_low",
                 "vs_frame", "vs_sash", "vs_brush", "gl_post", "gl_rail", "gl_panel", "gl_seal"}
FITTING_ROLES = {"sl_roller", "sl_lock", "vs_balance", "vs_lock", "vs_tilt", "gl_motor", "gl_remote", "gl_belt"}
GLASS_ROLES = {"glass_decor", "muntin_inner", "muntin_cross", "muntin_decor"}
LINE_KIND = {"profile": "profile", "reinforcement": "profile", "bead": "profile", "seal": "profile", "panel": "profile",
             "glass": "glass", "fitting": "fittings", "work": "works"}


def role_group(role: str | None) -> str:
    """Группа позиции каталога по роли."""
    r = role or ""
    if r in PROFILE_ROLES:
        return "profile"
    if r in GLASS_ROLES or r.startswith("glass"):
        return "glass"
    if r.startswith("fit_") or r in FITTING_ROLES:
        return "fittings"
    if r.startswith("work_"):
        return "works"
    return "other"


def supplier_category(role: str | None) -> str:
    """Категория поставщика для позиции каталога (работы поставщиков не имеют → other)."""
    g = role_group(role)
    return g if g in SUPPLIER_CATEGORIES else "other"


def line_group(kind: str | None, code: str | None = "") -> str:
    """Группа строки BOM: сначала по роли (fit_* → фурнитура, work_* → работы), потом по виду строки."""
    code = code or ""
    if code.startswith("fit_") or code in FITTING_ROLES:
        return "fittings"
    if kind == "work" or code.startswith("work_"):
        return "works"
    if kind in LINE_KIND:
        return LINE_KIND[kind]
    return role_group(code)
