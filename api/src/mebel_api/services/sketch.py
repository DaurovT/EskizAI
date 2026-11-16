"""Эскиз изделия для миниатюры в списке проектов (Projects.dc.html, .pi): компактное описание формы.

Сервер не рисует — отдаёт размеры и раскладку фасадов, приложение строит по ним изометрию (app/src/lib/sketch.ts).
Считается из дерева модулей при сохранении версии (кладётся в `summary.sketch`), для старых версий — из
сохранённого дерева при выдаче списка (обход словаря, без сборки модели).

Шкаф: {"kind": "wardrobe", "w", "h", "d", "plinth", "mezz", "sliding", "cols": [{"w", "doors", "hinge", "zones": [
    {"t": "shelves" | "drawers" | "rod" | "empty", "n", "h", "ext", "doors"}]}]}
Кухня: {"kind": "kitchen", "w", "h", "d", "legs", "base_h", "base_d", "top_d", "top_t", "wall_z", "wall_h", "wall_d",
    "layout", "corner_side", "base": [{"t", "w", "n", "h"}], "wall": [...], "base2": [...], "wall2": [...]}
Размеры — мм, округлены. Ширины колонок/модулей — относительные (приложение нормирует на общую ширину).
"""

from typing import Any

BOARD = 16  # толщина корпуса по умолчанию, мм — только чтобы поделить ширину секций

_ZONES = {"shelves", "drawers", "rod", "empty"}
_BASE = {"doors", "drawers", "sink", "appliance", "corner", "fridge", "cargo"}
_WALL = {"doors", "open", "hood", "gap", "appliance"}


def _num(v: Any, default: float = 0.0) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _r(v: float) -> int:
    return int(round(v))


def _dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _list(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _doors(v: Any) -> int:
    d = _dict(v)
    return int(_num(d.get("count"), 1)) if d else 0


def _widths(total: float, given: list[float | None]) -> list[float]:
    """Ширины секций в свету: заданные как есть, остальные — поровну из остатка."""
    inner = total - BOARD * (len(given) + 1)
    fixed = sum(w for w in given if w)
    auto = [w for w in given if not w]
    rest = max(inner - fixed, 0) / len(auto) if auto else 0
    return [w if w else rest for w in given]


def _wardrobe(t: dict[str, Any]) -> dict[str, Any] | None:
    w, h, d = _num(t.get("width")), _num(t.get("height")), _num(t.get("depth"))
    if w <= 0 or h <= 0 or d <= 0:
        return None
    body = _dict(t.get("body"))
    # нет ключа — цоколь по умолчанию (70), null — без цоколя
    plinth = _dict(body.get("plinth")) if "plinth" in body else {"height": 70}
    sections = [_dict(s) for s in _list(t.get("sections"))]
    cols = []
    for s, sw in zip(sections, _widths(w, [_num(s.get("width")) or None for s in sections])):
        zones = []
        for z in (_dict(z) for z in _list(s.get("fill"))):
            kind = z.get("kind")
            if kind not in _ZONES:
                continue
            zone: dict[str, Any] = {"t": kind}
            if kind in ("shelves", "drawers"):
                zone["n"] = int(_num(z.get("count"), 1))
            if _num(z.get("height")) > 0:
                zone["h"] = _r(_num(z.get("height")))
            if kind == "drawers" and z.get("external"):
                zone["ext"] = True
            if _doors(z.get("doors")):
                zone["doors"] = _doors(z.get("doors"))
            zones.append(zone)
        col: dict[str, Any] = {"w": _r(sw), "doors": _doors(s.get("doors")), "zones": zones}
        if col["doors"] == 1:
            col["hinge"] = "right" if _dict(s.get("doors")).get("hinge") == "right" else "left"
        cols.append(col)
    # торцевые открытые секции прибавляются к ширине корпуса
    for e in (_dict(e) for e in _list(t.get("end_units"))):
        ew = _num(e.get("width"), 300)
        col = {"w": _r(ew), "doors": 0, "zones": [{"t": "shelves", "n": int(_num(e.get("shelves"), 3))}]}
        if e.get("side") == "left":
            cols.insert(0, col)
        else:
            cols.append(col)
        w += ew
    sliding = _dict(t.get("sliding_doors"))
    return {
        "kind": "wardrobe", "w": _r(w), "h": _r(h), "d": _r(d),
        "plinth": _r(_num(plinth.get("height"), 70)) if plinth else 0,
        "mezz": _r(_num(_dict(t.get("mezzanine")).get("height"))),
        "sliding": int(_num(sliding.get("count"))) if sliding else 0,
        "cols": cols,
    }


def _base(m: dict[str, Any]) -> dict[str, Any]:
    kind = m.get("kind") if m.get("kind") in _BASE else "doors"
    out: dict[str, Any] = {"t": kind, "w": _r(_num(m.get("width"), 600))}
    if kind == "drawers":
        out["n"] = int(_num(m.get("drawers"), 3))
    elif _num(m.get("doors")):
        out["n"] = int(_num(m.get("doors")))
    if kind == "fridge":
        out["h"] = _r(_num(m.get("fridge_height"), 1850))
    if kind == "corner":
        out["shape"] = "square" if m.get("corner_shape") == "square" else "long"
    return out


def _wall(m: dict[str, Any]) -> dict[str, Any]:
    kind = m.get("kind") if m.get("kind") in _WALL else "doors"
    out: dict[str, Any] = {"t": kind, "w": _r(_num(m.get("width"), 600))}
    if kind == "open":
        out["n"] = int(_num(m.get("shelves"), 1))
    elif _num(m.get("doors")):
        out["n"] = int(_num(m.get("doors")))
    if _num(m.get("height")) > 0:
        out["h"] = _r(_num(m.get("height")))
    if m.get("rows") == 2:
        out["rows"] = 2
    if m.get("opening") == "lift":
        out["lift"] = True
    return out


def _kitchen(t: dict[str, Any]) -> dict[str, Any] | None:
    base = [_base(_dict(m)) for m in _list(t.get("base"))]
    if not base:
        return None
    wall = [_wall(_dict(m)) for m in _list(t.get("wall"))]
    legs, base_h = _num(t.get("legs_height"), 100), _num(t.get("base_height"), 720)
    wall_z, wall_h = _num(t.get("wall_bottom"), 1400), _num(t.get("wall_height"), 720)
    top = _dict(t.get("countertop"))
    material = str(top.get("material") or "")
    thick = next((int(p) for p in material.split("_") if p.isdigit()), 38)
    w1 = sum(m["w"] for m in base)
    w2 = sum(m["w"] for m in wall if m["t"] != "gap")
    fridge = max((m.get("h", 0) for m in base if m["t"] == "fridge"), default=0)
    out: dict[str, Any] = {
        "kind": "kitchen", "w": _r(max(w1, w2)), "h": _r(max(wall_z + wall_h if wall else legs + base_h + thick, fridge)),
        "d": _r(_num(top.get("depth"), 600)),
        "legs": _r(legs), "base_h": _r(base_h), "base_d": _r(_num(t.get("base_depth"), 560)),
        "top_d": _r(_num(top.get("depth"), 600)), "top_t": thick,
        "wall_z": _r(wall_z), "wall_h": _r(wall_h), "wall_d": _r(_num(t.get("wall_depth"), 300)),
        "layout": "corner" if t.get("layout") == "corner" else "straight",
        "base": base, "wall": wall,
    }
    if out["layout"] == "corner":
        out["corner_side"] = "left" if t.get("corner_side") == "left" else "right"
        out["base2"] = [_base(_dict(m)) for m in _list(t.get("base2"))]
        out["wall2"] = [_wall(_dict(m)) for m in _list(t.get("wall2"))]
    return out


def sketch_from_tree(tree: dict[str, Any] | None) -> dict[str, Any] | None:
    """Эскиз по дереву модулей (нормализованному или исходному). Непонятное дерево — None (приложение рисует заглушку)."""
    if not isinstance(tree, dict) or not tree:
        return None
    try:
        return _kitchen(tree) if tree.get("type") == "kitchen" else _wardrobe(tree)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
