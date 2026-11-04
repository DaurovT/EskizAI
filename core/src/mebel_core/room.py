"""Помещение вокруг встроенной мебели — только для картинки в 3D (viewer model, блок `room`).

Не детали: нет в смете, раскрое, DXF и в GLB для AR. Стены — параллелепипеды в осях изделия (мм),
толщина 100 мм, пол и потолок выходят за нишу на 300 мм. Размеры — по замеру ниши (у шкафа)
или по замеру кухни (стены, потолок, окно, выводы). Заваленная стена: грань бокса — по самому узкому
месту, `lean` — на сколько грань уходит от ниши в точках замера (мм).
"""

from .assembler import BuildResult
from .units import mm, to_mm

# Пресеты пола для 3D-комнаты: название, основной цвет, подсказка текстуры (полосы/плитка, шаг в мм)
FLOOR_MATERIALS: dict[str, dict] = {
    "oak_light": {"name": "Дуб светлый", "name_uz": "Och eman", "color": "#D9BF94", "seam": "#CFB386",
                  "texture": "planks", "step_mm": 180},
    "walnut": {"name": "Орех", "name_uz": "Yong‘oq", "color": "#7C5A3F", "seam": "#6D4E36", "texture": "planks",
               "step_mm": 180},
    "tile": {"name": "Плитка", "name_uz": "Kafel", "color": "#C9C7C2", "seam": "#B8B6B1", "texture": "tiles",
             "step_mm": 600},
    "concrete": {"name": "Бетон", "name_uz": "Beton", "color": "#A8A6A1", "seam": "#94928D", "texture": "speckle",
                 "step_mm": 0},
    "carpet": {"name": "Ковролин", "name_uz": "Gilam", "color": "#B9AE9E", "seam": "#A89D8D", "texture": "plain",
               "step_mm": 0},
}

T = mm(100)  # толщина стены
E = mm(300)  # на сколько пол/потолок выходят за нишу


def _box(wid: str, kind: str, x0, y0, z0, x1, y1, z1, **extra) -> dict:
    out = {"id": wid, "kind": kind, "x0": to_mm(x0), "y0": to_mm(y0), "z0": to_mm(z0),
           "x1": to_mm(x1), "y1": to_mm(y1), "z1": to_mm(z1)}
    out.update(extra)
    return out


def room_model(result: BuildResult) -> dict | None:
    p = result.product
    if getattr(p, "type", "") == "kitchen":
        room = _kitchen_room(result) if p.site is not None else None
    elif p.builtin is None and p.installation != "niche":
        room = None
    else:
        room = _wardrobe_room(result)
    if room is not None:
        room["colors"] = room_colors(p.room_colors)
    return room


def room_colors(rc) -> dict:
    """Цвета комнаты для 3D. Всегда «только для вида» (view_only): на модель, смету и файлы не влияют."""
    out: dict = {"view_only": True, "walls_visible": True}
    if rc is None:
        return out
    out.update(rc.model_dump(exclude_none=True))
    preset = FLOOR_MATERIALS.get(rc.floor_material or "")
    if preset:
        out.setdefault("floor", preset["color"])
        out["floor_texture"] = {k: preset[k] for k in ("texture", "seam", "step_mm")}
    return out


def _wardrobe_room(result: BuildResult) -> dict | None:
    from .catalog import material
    from .niche import niche_layout, panel_thickness

    p = result.product
    by_key = {q.key: q for q in result.parts}
    side = by_key.get("body.side.left")
    if side is None:
        return None
    xc = side.aabb().min.x
    W, H, D = mm(p.width), mm(p.height), mm(p.depth)
    tf = 0 if p.sliding_doors else material(p.fronts.material or p.body.material).thickness
    if p.builtin is not None:
        lay = niche_layout(p)
        b = p.builtin
        widths, heights, nd = lay.widths, lay.heights, b.niche.depth
        gl, gr, gt = lay.left.min, lay.right.min, lay.top.min
        pl, pr = lay.panel_left, lay.panel_right
    else:  # старая «ниша» без замера: стены вплотную к корпусу
        widths, heights, nd = [], [], None
        gl = gr = gt = 0
        pl, pr = panel_thickness(p, "left"), panel_thickness(p, "right")
    xl, xr = xc - pl - gl, xc + W + pr + gr
    zc = H + gt
    y_front = D - mm(nd) if nd else -tf
    wmin = min(widths) if widths else to_mm(xr - xl)
    names = {0.0: "bottom", 0.5: "middle", 1.0: "top"}
    lean_l: dict[str, float] = {}
    lean_r: dict[str, float] = {}
    if p.builtin is not None:  # грань стены — по узкому месту, lean — насколько дальше в точках замера
        for g, out in ((lay.left, lean_l), (lay.right, lean_r)):
            for f, gap in g.profile:
                out[names[f]] = to_mm(gap - g.min)
    lean_h = {}
    if p.builtin is not None:
        hmin = min(heights) if heights else to_mm(zc)
        for name, v in (("left", p.builtin.niche.height_left), ("right", p.builtin.niche.height_right)):
            if v is not None:
                lean_h[name] = v - hmin
    z_top = zc + mm(max(lean_h.values(), default=0))
    walls = [
        _box("wall_left", "wall_left", xl - T, y_front, 0, xl, D + T, z_top, lean=lean_l),
        _box("wall_right", "wall_right", xr, y_front, 0, xr + T, D + T, z_top, lean=lean_r),
        _box("wall_back", "wall_back", xl - T, D, 0, xr + T, D + T, z_top),
        _box("floor", "floor", xl - T - E, y_front - E, -T, xr + T + E, D + T, 0),
        _box("ceiling", "ceiling", xl - T - E, y_front - E, zc, xr + T + E, D + T, zc + T, lean=lean_h),
    ]
    if nd:  # стена комнаты по бокам от проёма ниши
        walls += [_box("wall_front_left", "wall_front", xl - T - E, y_front - T, 0, xl - T, y_front, zc),
                  _box("wall_front_right", "wall_front", xr + T, y_front - T, 0, xr + T + E, y_front, zc)]
    return {
        "walls": walls,
        "niche": {"width": wmin, "width_max": max(widths) if widths else wmin,
                  "height": min(heights) if heights else to_mm(zc),
                  "height_max": max(heights) if heights else to_mm(zc),
                  "depth": nd if nd else to_mm(D - y_front)},
        "measured": bool(widths or heights),
    }


def _kitchen_room(result: BuildResult) -> dict:
    k = result.product
    site = k.site
    width, height, _ = result.size
    run1 = [q.aabb() for q in result.parts if q.module.startswith("base[")]
    y_back = max((a.max.y for a in run1), default=mm(k.base_depth))
    corner = k.layout == "corner"
    wall_a, wall_b = mm(site.wall_a), mm(site.wall_b) if site.wall_b else 0
    zc = mm(site.ceiling) if site.ceiling else max(height, mm(2700))
    right = corner and k.corner_side == "right"
    xa0 = width - wall_a if right else 0  # начало стены A (у прямой — левый край)

    def on_a(pos: float, length: float = 0) -> tuple[int, int]:
        """Позиция по стене A от угла (у прямой — от левого края) → x0, x1."""
        d, ln = mm(pos), mm(length)
        return (width - d - ln, width - d) if right else (d, d + ln)

    def on_b(pos: float, length: float = 0) -> tuple[int, int]:
        d, ln = mm(pos), mm(length)
        return y_back - d - ln, y_back - d

    walls = [_box("wall_a", "wall_back", xa0 - (T if not right else 0), y_back, 0,
                  xa0 + wall_a + (T if right else 0), y_back + T, zc)]
    x_lo, x_hi, y_lo = xa0 - T, xa0 + wall_a + T, y_back - mm(1500)
    if corner and wall_b:
        bx0, bx1 = (width, width + T) if right else (-T, 0)
        walls.append(_box("wall_b", "wall_right" if right else "wall_left", bx0, y_back - wall_b, 0, bx1, y_back, zc))
        y_lo = min(y_lo, y_back - wall_b)
    elif k.installation == "niche":
        walls += [_box("wall_left", "wall_left", xa0 - T, y_lo, 0, xa0, y_back, zc),
                  _box("wall_right", "wall_right", xa0 + wall_a, y_lo, 0, xa0 + wall_a + T, y_back, zc)]
    walls.append(_box("floor", "floor", x_lo - E, y_lo - E, -T, x_hi + E, y_back + T, 0))
    if site.ceiling:
        walls.append(_box("ceiling", "ceiling", x_lo - E, y_lo - E, zc, x_hi + E, y_back + T, zc + T))
    openings = []
    w = site.window
    if w is not None and (w.wall == "a" or corner):
        z0, z1 = mm(w.sill), min(zc - mm(200), mm(w.sill) + mm(1400))
        if w.wall == "a":
            x0, x1 = on_a(w.from_corner, w.width)
            openings.append(_box("window", "window", x0, y_back, z0, x1, y_back + T, z1))
        else:
            y0, y1 = on_b(w.from_corner, w.width)
            bx0 = width if right else -T
            openings.append(_box("window", "window", bx0, y0, z0, bx0 + T, y1, z1))
    outlets = []
    for i, u in enumerate(site.utilities):
        if u.wall == "b" and not corner:
            continue
        z = mm(u.height) if u.height is not None else mm(500)
        if u.wall == "a":
            x, y = on_a(u.from_corner)[0], y_back
        else:
            x, y = (width if right else 0), on_b(u.from_corner)[1]
        outlets.append({"id": f"outlet{i + 1}", "kind": u.kind, "x": to_mm(x), "y": to_mm(y), "z": to_mm(z)})
    return {"walls": walls, "niche": {"width": site.wall_a, "height": to_mm(zc), "depth": to_mm(y_back)},
            "measured": True, "openings": openings, "outlets": outlets}
