"""Миграция деревьев модулей со старых версий схемы и применение замера."""

import copy

CURRENT = "0.2"


def migrate_tree(tree: dict) -> dict:
    """Приводит дерево любой известной версии к текущей.

    0.1 → 0.2: поля не менялись, добавились необязательные (двери, ящики, купе…).
    Декор и подсветка (fronts.style, handles.finish, lighting, style у дверей/ящиков/модулей) — тоже
    необязательные поля 0.2 со значениями «нет»: старые деревья читаются без миграции.
    Встроенная мебель (builtin, side_panels, plinth.legs; у кухни plinth, side_panels, top_filler, fridge, dw) —
    тоже необязательные поля: без них дерево собирается как раньше.
    """
    t = copy.deepcopy(tree)
    version = t.get("schema_version", "0.1")
    if version == "0.1":
        version = "0.2"
    if version != CURRENT:
        raise ValueError(f"Неизвестная версия схемы: {version}")
    t["schema_version"] = CURRENT
    return t


def apply_measurements(tree: dict, *, width: float | None = None, height: float | None = None,
                       depth: float | None = None, kitchen: dict | None = None, niche: dict | None = None) -> dict:
    """Фактические размеры с замера (SCR-13) → дерево модулей шкафа.

    Заданные ширины секций сохраняются, кроме последней: она забирает разницу,
    чтобы сумма снова сошлась с новой шириной. kitchen — замер помещения кухни
    (стены, окно, коммуникации; SCR-13b), см. kitchen_site.fit_kitchen.
    niche — замер ниши в трёх точках (schema.Niche): шкаф становится встроенным, корпус — по самому
    узкому месту минус доборы (niche.fit_to_niche); width/height/depth тогда не нужны.
    """
    t = copy.deepcopy(tree)
    if t.get("type") == "kitchen":
        if kitchen:
            from .kitchen_site import fit_kitchen

            return fit_kitchen(t, kitchen)[0]
        return _apply_kitchen(t, width)
    if niche:
        from .niche import fit_to_niche

        return fit_to_niche(t, niche)
    if width is not None:
        t["width"] = width
        sections = t.get("sections", [])
        if sections and all(s.get("width") is not None for s in sections):
            sections[-1]["width"] = None
    if height is not None:
        t["height"] = height
        for s in t.get("sections", []):
            zones = s.get("fill", [])
            if zones and all(z.get("height") is not None for z in zones):
                zones[-1]["height"] = None
    if depth is not None:
        t["depth"] = depth
    return t


# Модули кухни, ширину которых можно подогнать под замер (мойка, техника и угол — стандартные)
_ADJUSTABLE = ("doors", "drawers")


def _fit_row(row: list[dict], target: float, what: str) -> None:
    """Подгоняет сумму ширин ряда под target: разницу забирают регулируемые модули с конца ряда."""
    diff = target - sum(c["width"] for c in row)
    for cab in reversed(row):
        if abs(diff) < 0.05:
            break
        if cab.get("kind") not in _ADJUSTABLE:
            continue
        new = min(1200.0, max(150.0, cab["width"] + diff))
        diff -= new - cab["width"]
        cab["width"] = round(new, 1)
    if abs(diff) >= 0.05:
        raise ValueError(f"{what}: модули не подогнать под замер {target:g} мм — измените состав вручную")


def _apply_kitchen(t: dict, width: float | None) -> dict:
    """Замер кухни: width — длина стены под первый ряд. Нижние модули подгоняются точно;
    верхние — только если стали длиннее стены."""
    if width is None:
        return t
    _fit_row(t.get("base", []), width, "Нижние модули")
    wall = t.get("wall", [])
    if wall and sum(c["width"] for c in wall) > width:
        _fit_row(wall, width, "Верхние модули")
    return t
