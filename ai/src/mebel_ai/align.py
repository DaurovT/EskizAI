"""Выравнивание кухни после распознавания фото (до сборки): мелкие расхождения «на глаз» → ровные линии.

Только для дерева, которое вернул ИИ (сохранённые проекты и правки мастера не трогаем):

1. Границы верхних колонок — по границам нижних модулей. Если верхний ряд кончается там же, где нижний
   (±SNAP мм), и КАЖДАЯ граница между верхними колонками ближе SNAP мм к своей границе нижнего ряда, ширины
   верхних берутся из этих границ (900/550/800 над 600+150+450/450/600 не трогаем — слишком далеко,
   а 1180/470/600 → 1200/450/600). Только первый ряд (у второго ряда угловой кухни свой отступ от угла).
2. Ниши соседних верхних колонок на одной линии: открытая ниша (open_bottom) и ниша техники (niche_height,
   по умолчанию 380/600) или две открытые ниши соседей, у которых низ модуля на одной высоте, отличаются
   меньше NICHE_SNAP мм → обе по большей (ниша техники от этого не становится меньше нужной).

Детерминированно; возвращает новое дерево и список того, что поправлено (для журнала).
"""

import copy

SNAP = 60  # мм: граница верхней колонки — к границе нижнего ряда
NICHE_SNAP = 80  # мм: ниши соседних колонок — на одну линию
WIDTH = (150, 1200)  # пределы ширины верхнего модуля (schema.WallCabinet)
NICHE_DEFAULT = {"microwave": 380, "oven": 600}
NICHE_LIMITS = {"open_bottom": (150, 900), "niche_height": (300, 700)}  # schema.WallCabinet


def _cum(widths: list[float]) -> list[float]:
    out, x = [], 0.0
    for w in widths:
        x += w
        out.append(x)
    return out


def _snap_wall_widths(base: list[dict], wall: list[dict]) -> list[float] | None:
    """Новые ширины верхних колонок или None (выравнивать нечего или нельзя)."""
    if len(wall) < 2 or not base:
        return None
    try:
        bw = [float(c["width"]) for c in base]
        ww = [float(c["width"]) for c in wall]
    except (KeyError, TypeError, ValueError):
        return None
    bounds = _cum(bw)  # правые границы нижних модулей (последняя — конец ряда)
    wb = _cum(ww)
    if abs(wb[-1] - bounds[-1]) > SNAP:
        return None
    snapped, prev = [], 0.0
    for x in wb[:-1]:
        best = min(bounds[:-1], key=lambda b: abs(b - x), default=None)
        if best is None or abs(best - x) > SNAP or best <= prev:
            return None
        snapped.append(best)
        prev = best
    snapped.append(bounds[-1])
    widths = [round(b - a, 1) for a, b in zip([0.0] + snapped[:-1], snapped)]
    if any(not WIDTH[0] <= w <= WIDTH[1] for w in widths):
        return None
    return None if widths == ww else widths


def _niche(c: dict) -> tuple[str, float] | None:
    """Поле и высота ниши внизу верхнего модуля (только если над нишей есть фасады или полка)."""
    if c.get("kind") == "doors" and isinstance(c.get("open_bottom"), (int, float)):
        return "open_bottom", float(c["open_bottom"])
    if c.get("kind") == "appliance" and (c.get("above") or "door") != "none":
        h = c.get("niche_height")
        return "niche_height", float(h) if isinstance(h, (int, float)) else NICHE_DEFAULT.get(
            c.get("appliance") or "microwave", 380)
    return None


def align_kitchen(tree: dict) -> tuple[dict, list[str]]:
    if tree.get("type") != "kitchen":
        return tree, []
    out = copy.deepcopy(tree)
    notes: list[str] = []
    base, wall = out.get("base") or [], out.get("wall") or []
    widths = _snap_wall_widths(base, wall)
    if widths:
        before = [c.get("width") for c in wall]
        for c, w in zip(wall, widths):
            c["width"] = int(w) if w == int(w) else w
        notes.append(f"верхние колонки по границам нижних: {before} → {[c['width'] for c in wall]}")
    for i in range(len(wall) - 1):
        a, b = wall[i], wall[i + 1]
        na, nb = _niche(a), _niche(b)
        if not na or not nb or a.get("height") != b.get("height") or na[1] == nb[1]:
            continue
        if abs(na[1] - nb[1]) >= NICHE_SNAP:
            continue
        h = max(na[1], nb[1])
        h = int(h) if h == int(h) else h
        if any(not NICHE_LIMITS[f][0] <= h <= NICHE_LIMITS[f][1] for f, _ in (na, nb)):
            continue
        for c, (field, v) in ((a, na), (b, nb)):
            if v != h:
                c[field] = h
        notes.append(f"ниши верхних {i + 1} и {i + 2} на одной линии: {h:g} мм")
    return (out, notes) if notes else (tree, [])
