"""Фурнитура для 3D: ручки, петли, штангодержатели, ножки, направляющие, профили купе, угловые механизмы.

Только картинка: детали, раскрой и смета не меняются (фурнитура уже посчитана в смете).
Всё выводится из готовой модели деталей — из отверстий и габаритов деталей, — поэтому
ручки и петли в 3D стоят ровно там, где их присадка, и сдвиги/повороты рядов кухни
учитываются сами.

Элемент: id, kind, name (как в смете), node (узел — двигается с дверью/ящиком),
part (ключ детали-«родителя»: с ней разлетается при «взрыве»), finish и простые формы
в осях ядра (dmm): box — параллелепипед по осям, cylinder — цилиндр вдоль оси X/Y/Z
(start/sweep — сектор в градусах, для оси Z угол от +X к +Y; inner — внутренний радиус кольца).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from .assembler import BuildResult
from .geometry import axis_value
from .parts import Part
from .rules import DEFAULT_RULES
from .units import mm, to_mm

# Отделки фурнитуры: цвет и металл/пластик (общие для 3D и GLB). Петли и направляющие — тоже steel:
# у двери/ящика вся фурнитура сливается в один меш (меньше вызовов отрисовки)
FINISHES: dict[str, dict] = {
    "steel": {"name": "Сталь шлифованная", "color": "#b8bcc0", "metal": True, "roughness": 0.38},
    "chrome": {"name": "Хром", "color": "#d9dcdf", "metal": True, "roughness": 0.16},
    "nickel": {"name": "Никель", "color": "#c4c7ca", "metal": True, "roughness": 0.3},
    "zinc": {"name": "Оцинковка", "color": "#a9adb1", "metal": True, "roughness": 0.45},
    "alu": {"name": "Алюминий", "color": "#c6c9cc", "metal": True, "roughness": 0.34},
    "plastic_black": {"name": "Пластик чёрный", "color": "#2b2b2b", "metal": False, "roughness": 0.6},
    "plastic_light": {"name": "Пластик светлый", "color": "#deddd8", "metal": False, "roughness": 0.55},
    # Ручки и вставки декора (docs/decor_contract.md)
    "brass": {"name": "Латунь", "color": "#c9a45c", "metal": True, "roughness": 0.3},
    "gold": {"name": "Золото", "color": "#d4af37", "metal": True, "roughness": 0.22},
    "black": {"name": "Чёрный матовый", "color": "#1f1f1f", "metal": True, "roughness": 0.55},
}

_IDX = {"X": 0, "Y": 1, "Z": 2}


@dataclass
class HwItem:
    id: str
    kind: str
    name: str
    part: str
    finish: str
    node: str | None = None
    shapes: list[dict] = field(default_factory=list)

    def box(self, lo, hi) -> "HwItem":
        self.shapes.append({"type": "box", "min": [min(a, b) for a, b in zip(lo, hi)],
                            "max": [max(a, b) for a, b in zip(lo, hi)]})
        return self

    def cyl(self, axis: str, center, radius: float, length: float, start: float | None = None,
            sweep: float | None = None, inner: float | None = None) -> "HwItem":
        s = {"type": "cylinder", "axis": axis, "center": list(center), "radius": radius, "length": length}
        if sweep is not None:
            s.update(start=start or 0.0, sweep=sweep)
        if inner:
            s["inner"] = inner
        self.shapes.append(s)
        return self


# ---------- Локальная система детали → изделие ----------


def _vec(axis: str) -> tuple[int, int, int]:
    v = [0, 0, 0]
    v[_IDX[axis[1]]] = -1 if axis[0] == "-" else 1
    return v[0], v[1], v[2]


def _l2w(p: Part, x: float, y: float, z: float) -> tuple[float, float, float]:
    o = p.placement.origin
    u, v, n = _vec(p.placement.u), _vec(p.placement.v), _vec(p.placement.n)
    return tuple(c + x * a + y * b + z * d for c, a, b, d in zip((o.x, o.y, o.z), u, v, n))


def _lbox(item: HwItem, p: Part, x0, x1, y0, y1, z0, z1) -> None:
    item.box(_l2w(p, x0, y0, z0), _l2w(p, x1, y1, z1))


def _lcyl(item: HwItem, p: Part, axis: str, cx, cy, cz, radius, length) -> None:
    world_axis = {"x": p.placement.u, "y": p.placement.v, "z": p.placement.n}[axis][1]
    item.cyl(world_axis, _l2w(p, cx, cy, cz), radius, length)


def _center(p: Part) -> tuple[float, float, float]:
    b = p.aabb()
    return (b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2


# ---------- Названия — как в смете ----------


def _hw_name(result: BuildResult, kind: str, key: str, default: str) -> str:
    best = None
    for h in result.hardware:
        if h.kind == kind and (key == h.module or key.startswith(h.module + ".") or key.startswith(h.module + "[")):
            if best is None or len(h.module) > len(best.module):
                best = h
    return best.name if best else default


# ---------- Ручки и петли ----------


def _handle_finish(result: BuildResult) -> str:
    h = getattr(result.product.fronts, "handles", None)
    return h.finish if h is not None and h.finish in FINISHES else "steel"


def _handles(result: BuildResult, p: Part, out: list[HwItem]) -> None:
    holes = [h for h in p.holes if h.purpose == "ручка"]
    finish = _handle_finish(result)
    if result.product.fronts.handles.kind == "knob":
        for k, h in enumerate(holes, start=1):
            # Кнопка-грибок снаружи фасада: ножка и шляпка
            item = HwItem(id=f"{p.key}.knob[{k}]", kind="knob", part=p.key, node=p.node, finish=finish,
                          name=_hw_name(result, "knob", p.key, "Ручка-кнопка"))
            _lcyl(item, p, "z", h.x, h.y, -mm(10), mm(6), mm(20))
            _lcyl(item, p, "z", h.x, h.y, -mm(24), mm(15), mm(10))
            out.append(item)
        return
    for k in range(0, len(holes) - 1, 2):
        a, b = holes[k], holes[k + 1]
        # Скоба снаружи фасада (локальная z < 0): две стойки и ручка между ними
        item = HwItem(id=f"{p.key}.handle[{k // 2 + 1}]", kind="handle", part=p.key, node=p.node, finish=finish,
                      name=_hw_name(result, "handle", p.key, "Ручка-скоба"))
        stand, r_post, r_grip, over = mm(30), mm(4), mm(6), mm(18)
        for h in (a, b):
            _lcyl(item, p, "z", h.x, h.y, -stand / 2, r_post, stand)
        along = "x" if abs(b.x - a.x) >= abs(b.y - a.y) else "y"
        span = abs(b.x - a.x) + abs(b.y - a.y)
        _lcyl(item, p, along, (a.x + b.x) / 2, (a.y + b.y) / 2, -stand - r_grip + mm(2), r_grip, span + 2 * over)
        out.append(item)


def _hinges(result: BuildResult, p: Part, out: list[HwItem]) -> None:
    cups = [h for h in p.holes if h.purpose == "чашка петли"]
    if not cups:
        return
    T, W = p.thickness, p.width
    name = _hw_name(result, "hinge", p.key, "Петля мебельная")
    r = DEFAULT_RULES
    for k, c in enumerate(cups, start=1):
        e = -1 if c.y < W / 2 else 1  # к краю двери со стороны петель
        # Чашка с накладкой — на двери (двигается с ней)
        cup = HwItem(id=f"{p.key}.hinge[{k}]", kind="hinge", part=p.key, node=p.node, finish="steel", name=name)
        _lcyl(cup, p, "z", c.x, c.y, T + mm(1), r.hinge_cup_diameter / 2, mm(2))
        _lbox(cup, p, c.x - mm(8), c.x + mm(8), c.y - mm(7), c.y + mm(7), T, T + mm(9))
        out.append(cup)
        # Плечо и монтажная планка — на корпусе (остаются на месте)
        arm = HwItem(id=f"{p.key}.hinge[{k}].arm", kind="hinge", part=p.key, node=None, finish="steel", name=name)
        _lbox(arm, p, c.x - mm(7), c.x + mm(7), c.y - mm(6), c.y + mm(6), T + mm(9), T + mm(46))
        _lbox(arm, p, c.x - mm(20), c.x + mm(20), c.y + e * mm(6), c.y + e * mm(7.5), T + mm(20), T + mm(62))
        out.append(arm)


def _gola(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    """Профиль Gola: у нижних модулей кухни — над каждым фасадом в щели (за лицом фасада), у верхних — под дном,
    у шкафа — вертикально у края открывания. Профиль на корпусе — не двигается с фасадом."""
    if result.product.fronts.handles.kind != "gola":
        return
    finish = _handle_finish(result)
    finish = finish if finish != "steel" else "alu"
    for p in parts:
        if p.role not in ("door", "drawer_front"):
            continue
        T = p.thickness
        name = _hw_name(result, "gola_profile", p.key, "Профиль Gola")
        item = HwItem(id=f"{p.key}.gola", kind="gola", part=p.key, node=None, finish=finish, name=name)
        upright = p.placement.u[1] == "Z"
        h_len, w_len = (p.length, p.width) if upright else (p.width, p.length)
        if re.match(r"^base2?(\[|\.corner)", p.key):
            # Над верхним краем фасада, в щели 30 мм, за лицом фасада
            lo, hi = h_len + mm(2), h_len + mm(28)
            if upright:
                _lbox(item, p, lo, hi, 0, w_len, T * 0.4, T + mm(27))
            else:
                _lbox(item, p, 0, w_len, lo, hi, T * 0.4, T + mm(27))
        elif re.match(r"^wall2?\[", p.key):
            _lbox(item, p, -mm(2), mm(20), 0, w_len, T + mm(1), T + mm(25))
        else:
            hinge_left = any(h.purpose == "чашка петли" and h.y < p.width / 2 for h in p.holes)
            y0 = p.width - mm(20) if hinge_left else 0
            _lbox(item, p, 0, p.length, y0, y0 + mm(20), T + mm(1), T + mm(22))
        out.append(item)


# ---------- Штанга ----------


def _rod_holders(result: BuildResult, p: Part, out: list[HwItem]) -> None:
    L, W, T = p.length, p.width, p.thickness
    name = _hw_name(result, "rod_holder", p.key, "Штангодержатель")
    for end, x in (("left", 0), ("right", L)):
        s = -1 if end == "left" else 1
        item = HwItem(id=f"{p.key}.holder.{end}", kind="rod_holder", part=p.key, finish="chrome", name=name)
        wall = x + s * mm(2)  # штанга короче проёма на 2 мм с каждой стороны
        _lcyl(item, p, "x", wall - s * mm(1.5), W / 2, T / 2, mm(19), mm(3))  # фланец на боковине
        _lbox(item, p, wall, x - s * mm(12), -mm(3), W + mm(3), -mm(3), T + mm(3))  # чашка вокруг штанги
        out.append(item)


# ---------- Направляющие ящиков ----------


def _slides(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    hw = result.product.hardware
    ball = hw.slides == "ball"
    gap = DEFAULT_RULES.slide_side_gap if ball else DEFAULT_RULES.hidden_slide_side_gap
    name_default = "Направляющие ящика"
    by_node: dict[str, list[Part]] = {}
    for p in parts:
        if p.role == "drawer_side" and p.node:
            by_node.setdefault(p.node, []).append(p)
    for node, sides in by_node.items():
        if len(sides) != 2:
            continue
        name = _hw_name(result, "slide", node, name_default)
        for p, other in ((sides[0], sides[1]), (sides[1], sides[0])):
            # Наружная пласть боковины — от второй боковины
            n_axis = p.placement.n[1]
            outward = 1 if _center(p)[_IDX[n_axis]] > _center(other)[_IDX[n_axis]] else -1
            sign_n = 1 if p.placement.n[0] == "+" else -1
            T, L, H = p.thickness, p.length, p.width
            face = T if outward * sign_n > 0 else 0
            d = outward * sign_n  # наружу в локальной z
            if ball:
                # Внутренняя шина — на ящике, наружная — на корпусе
                inner = HwItem(id=f"{p.key}.slide", kind="slide", part=p.key, node=node, finish="steel", name=name)
                _lbox(inner, p, mm(5), L - mm(15), H / 2 - mm(17), H / 2 + mm(17), face, face + d * mm(5))
                out.append(inner)
                outer = HwItem(id=f"{p.key}.slide.body", kind="slide", part=p.key, node=None, finish="steel", name=name)
                _lbox(outer, p, 0, L, H / 2 - mm(22.5), H / 2 + mm(22.5), face + d * mm(5.5), face + d * (gap - mm(0.5)))
                out.append(outer)
            else:
                # Скрытые: шина под ящиком у нижнего края боковины
                rail = HwItem(id=f"{p.key}.slide", kind="slide", part=p.key, node=node, finish="steel", name=name)
                _lbox(rail, p, mm(10), L - mm(10), -mm(14), mm(4), face - d * mm(8), face + d * (gap - mm(0.5)))
                out.append(rail)


# ---------- Ножки кухни ----------

_BASE_BOTTOM = re.compile(r"^base2?(\[\d+\]|\.corner)$")


def _legs(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    by_key = {p.key: p for p in parts}
    for p in parts:
        if p.role != "bottom" or not _BASE_BOTTOM.match(p.module):
            continue
        b = p.aabb()
        zb = b.min.z
        if zb < mm(40):
            continue
        inset = mm(100)
        xs = (b.min.x + inset, b.max.x - inset) if b.max.x - b.min.x > 2 * inset else ((b.min.x + b.max.x) / 2,)
        ys = (b.min.y + inset, b.max.y - inset) if b.max.y - b.min.y > 2 * inset else ((b.min.y + b.max.y) / 2,)
        spots = [(x, y) for x in xs for y in ys]
        if p.module.endswith(".corner"):
            # Крыло углового модуля — две ножки у его боковины (как в смете)
            side = by_key.get(f"{p.module}.side")
            if side:
                sc = _center(side)
                spots.sort(key=lambda s: (s[0] - sc[0]) ** 2 + (s[1] - sc[1]) ** 2)
                spots = spots[:2]
        name = _hw_name(result, "leg", p.module, "Ножка кухонная регулируемая")
        for i, (x, y) in enumerate(spots, start=1):
            item = HwItem(id=f"{p.module}.leg[{i}]", kind="leg", part=p.key, finish="plastic_black", name=name)
            item.cyl("Z", (x, y, mm(5)), mm(24), mm(10))  # пята
            item.cyl("Z", (x, y, (mm(10) + zb - mm(8)) / 2), mm(14), zb - mm(18))  # стойка
            item.cyl("Z", (x, y, zb - mm(4)), mm(30), mm(8))  # площадка под дном
            out.append(item)


def _wardrobe_legs(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    """Шкаф на ножках (body.plinth.legs): ножки под дном за планкой цоколя, по ширине — с шагом из правил."""
    plinth = getattr(result.product.body, "plinth", None)
    bottom = next((p for p in parts if p.key == "body.bottom"), None)
    if not plinth or not plinth.legs or bottom is None:
        return
    b = bottom.aabb()
    zb = b.min.z
    if zb < mm(40):
        return
    x0, x1 = b.min.x - bottom.thickness + mm(60), b.max.x + bottom.thickness - mm(60)  # от наружных краёв боковин
    n_x = max(2, -(-(x1 - x0 + mm(120)) // DEFAULT_RULES.wardrobe_leg_step) + 1)
    xs = [x0 + (x1 - x0) * k / (n_x - 1) for k in range(n_x)]
    ys = (mm(plinth.setback) + mm(60), b.max.y - mm(60))
    name = _hw_name(result, "leg", "body.plinth", "Ножка мебельная регулируемая")
    for i, (x, y) in enumerate(((x, y) for y in ys for x in xs), start=1):
        item = HwItem(id=f"body.plinth.leg[{i}]", kind="leg", part=bottom.key, finish="plastic_black", name=name)
        item.cyl("Z", (x, y, mm(5)), mm(24), mm(10))
        item.cyl("Z", (x, y, (mm(10) + zb - mm(8)) / 2), mm(14), zb - mm(18))
        item.cyl("Z", (x, y, zb - mm(4)), mm(30), mm(8))
        out.append(item)


# ---------- Двери-купе: профили и рельсы ----------


def _sliding(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    fills = [p for p in parts if p.role == "sliding_fill" and p.node]
    if not fills:
        return
    r = DEFAULT_RULES
    dw, dh = r.sliding_fill_width_deduction // 2, r.sliding_fill_height_deduction // 2
    prof_w = r.sliding_overlap
    for p in fills:
        b = p.aabb()
        x0, x1, z0, z1 = b.min.x - dw, b.max.x + dw, b.min.z - dh, b.max.z + dh
        y0, y1 = b.min.y - mm(10), b.max.y + mm(12)
        item = HwItem(id=f"{p.key}.profile", kind="profile", part=p.key, node=p.node, finish="alu",
                      name=_hw_name(result, "profile", p.key, "Профиль двери-купе"))
        item.box((x0, y0, z0), (x0 + prof_w, y1, z1))  # вертикальные — они же ручки
        item.box((x1 - prof_w, y0, z0), (x1, y1, z1))
        item.box((x0 + prof_w, y0 + mm(4), z1 - dh - mm(4)), (x1 - prof_w, y1 - mm(4), z1))  # горизонтальные
        item.box((x0 + prof_w, y0 + mm(4), z0), (x1 - prof_w, y1 - mm(4), z0 + dh + mm(4)))
        out.append(item)
    by_key = {p.key: p for p in parts}
    try:
        left, right = by_key["body.side.left"].aabb(), by_key["body.side.right"].aabb()
        bottom, top = by_key["body.bottom"].aabb(), by_key["body.top"].aabb()
    except KeyError:
        return
    ys = [p.aabb() for p in fills]
    y0, y1 = min(a.min.y for a in ys) - mm(14), max(a.max.y for a in ys) + mm(16)
    name = _hw_name(result, "rail", "sliding_doors", "Рельс двери-купе")
    rails = HwItem(id="sliding_doors.rails", kind="rail", part="body.bottom", finish="alu", name=name)
    rails.box((left.max.x, y0, bottom.max.z), (right.min.x, y1, bottom.max.z + mm(7)))
    door_top = max(a.max.z for a in ys) + dh
    rails.box((left.max.x, y0, min(door_top + mm(2), top.min.z - mm(10))), (right.min.x, y1, top.min.z))
    out.append(rails)


# ---------- Угловые механизмы кухни ----------


def _corner_mechanisms(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    k = result.product
    if getattr(k, "type", None) != "kitchen":
        return
    by_module: dict[str, list[Part]] = {}
    for p in parts:
        by_module.setdefault(p.module, []).append(p)
    for row in ("base", "base2"):
        for i, cab in enumerate(getattr(k, row)):
            if cab.kind != "corner" or cab.corner_fill == "blind":
                continue
            path = f"{row}[{i}]"
            own = [p for p in parts if p.key.startswith(path + ".")]
            bottom = next((p for p in own if p.role == "bottom" and p.module == path), None)
            if bottom is None:
                continue
            rail = next((p for p in own if p.role == "rail"), None)
            zb = bottom.aabb().max.z
            zt = rail.aabb().min.z if rail else zb + mm(k.base_height) - 2 * bottom.thickness
            doors = [p for p in parts if p.role == "door" and p.key.startswith(path + ".")]
            if cab.corner_fill == "carousel":
                # Крыло Г-образного модуля строится во втором ряду
                wing = by_module.get("base2.corner", []) if cab.corner_shape == "square" else []
                doors += [p for p in parts if p.role == "door" and p.key.startswith("base2.corner.")]
                boxes = [bottom.aabb()] + [p.aabb() for p in wing if p.role == "bottom"]
                lo_x, hi_x = min(b.min.x for b in boxes), max(b.max.x for b in boxes)
                lo_y, hi_y = min(b.min.y for b in boxes), max(b.max.y for b in boxes)
                cx, cy = (lo_x + hi_x) / 2, (lo_y + hi_y) / 2
                dia = DEFAULT_RULES.carousel_diameter.get(mm(cab.width), mm(cab.width) - mm(140))
                # Вырез 3/4 — к дверям (к внутреннему углу)
                if doors:
                    dx = sum(_center(d)[0] for d in doors) / len(doors) - cx
                    dy = sum(_center(d)[1] for d in doors) / len(doors) - cy
                    theta = math.degrees(math.atan2(dy, dx))
                else:
                    theta = -135.0
                name = _hw_name(result, "corner_carousel", path, "Карусель 3/4")
                item = HwItem(id=f"{path}.carousel", kind="carousel", part=bottom.key, finish="plastic_light",
                              name=name)
                for z in (zb + mm(60), zb + (zt - zb) * 0.55):
                    item.cyl("Z", (cx, cy, z), dia / 2, mm(6), start=theta + 45, sweep=270)  # полка
                    item.cyl("Z", (cx, cy, z + mm(18)), dia / 2, mm(30), start=theta + 45, sweep=270,
                             inner=dia / 2 - mm(6))  # бортик
                pole = HwItem(id=f"{path}.carousel.pole", kind="carousel", part=bottom.key, finish="chrome",
                              name=name)
                pole.cyl("Z", (cx, cy, (zb + zt) / 2), mm(12), zt - zb)
                out += [item, pole]
            elif cab.corner_fill == "swing" and doors:
                d = doors[0]
                T, W = d.thickness, d.width
                depth = min(mm(k.base_depth) * 0.72, mm(420))
                item = HwItem(id=f"{path}.swing", kind="swing_shelf", part=bottom.key, finish="chrome",
                              name=_hw_name(result, "corner_swing", path, "Поворотная полка"))
                z_lo = zb - axis_value(d.placement.origin, "Z")  # высота дна в локальной x двери
                levels = (z_lo + mm(60), z_lo + (zt - zb) * 0.55)
                for lx in levels:
                    _lbox(item, d, lx, lx + mm(4), mm(30), W - mm(30), T + mm(40), T + mm(40) + depth)
                    for (y0, y1, z0, z1) in ((mm(30), W - mm(30), T + mm(40), T + mm(44)),
                                             (mm(30), W - mm(30), T + mm(36) + depth, T + mm(40) + depth),
                                             (mm(30), mm(34), T + mm(40), T + mm(40) + depth),
                                             (W - mm(34), W - mm(30), T + mm(40), T + mm(40) + depth)):
                        _lbox(item, d, lx, lx + mm(50), y0, y1, z0, z1)
                # Стойка механизма у петель
                hinge_left = any(h.purpose == "чашка петли" and h.y < W / 2 for h in d.holes)
                py = mm(45) if hinge_left else W - mm(45)
                post = HwItem(id=f"{path}.swing.post", kind="swing_shelf", part=bottom.key, finish="chrome",
                              name=item.name)
                _lcyl(post, d, "x", z_lo + (zt - zb) / 2, py, T + mm(60), mm(12), zt - zb)
                out += [item, post]


# ---------- Кухня: газлифты подъёмных фасадов и техника в нишах верхнего ряда ----------

_FLAP = re.compile(r"^(.*)\.flap\[\d+\]$")


def _gas_lifts(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    """Газлифт — цилиндр на внутренней стороне боковины за подъёмным фасадом (на корпусе, не двигается)."""
    by_key = {p.key: p for p in parts}
    for p in parts:
        m = _FLAP.match(p.key)
        if p.role != "door" or not m:
            continue
        cab = m.group(1)
        b = p.aabb()
        y = b.max.y + mm(60)
        z0, z1 = b.min.z + (b.max.z - b.min.z) * 0.35, b.max.z - mm(30)
        name = _hw_name(result, "gas_lift", cab, "Подъёмный механизм (газлифт)")
        sides = [("left", 1)] + ([("right", -1)] if b.max.x - b.min.x > mm(600) else [])
        for side, s in sides:
            panel = by_key.get(f"{cab}.side.{side}")
            if panel is None:
                continue
            pb = panel.aabb()
            x = (pb.max.x if s > 0 else pb.min.x) + s * mm(12)
            item = HwItem(id=f"{p.key}.gas_lift.{side}", kind="gas_lift", part=panel.key, finish="steel", name=name)
            item.cyl("Z", (x, y, (z0 + z1) / 2), mm(9), z1 - z0)  # корпус газлифта
            item.cyl("Z", (x, y, z1 - (z1 - z0) * 0.2), mm(4), (z1 - z0) * 0.4)  # шток
            item.box((x - s * mm(10), y - mm(15), z0 - mm(20)), (x + s * mm(2), y + mm(15), z0))  # кронштейн
            out.append(item)


_FOLD = re.compile(r"^(.*)\.fold\[1\]$")


def _fold_lifts(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    """Складной подъёмник: корпуса механизма на боковинах (на корпусе, рычаги не рисуем — они в открытом
    положении идут от корпуса к фасаду и одним телом с фасадом не двигаются), соединительные петли — чашка в верхнем фасаде, плечо на нижнем (каждая часть двигается со своим фасадом).
    Всё — в локальных координатах верхнего фасада (локальная z > T — внутрь корпуса), поэтому ряд 2 угловой
    кухни тоже верно."""
    by_key = {p.key: p for p in parts}
    r = DEFAULT_RULES
    for up in parts:
        m = _FOLD.match(up.key)
        if not m:
            continue
        cab = m.group(1)
        low = by_key.get(f"{cab}.fold[2]")
        side = by_key.get(f"{cab}.side.left")
        if low is None or side is None:
            continue
        L, W, T = up.length, up.width, up.thickness
        t = side.thickness
        name = _hw_name(result, "fold_lift", cab, "Подъёмник складной (2 фасада)")
        for k, (y0, y1) in enumerate(((t + mm(1), t + mm(19)), (W - t - mm(19), W - t - mm(1)))):
            box = HwItem(id=f"{up.key}.fold_lift[{k + 1}]", kind="fold_lift", part=side.key, finish="plastic_light",
                         name=name)
            _lbox(box, up, L - mm(260), L - mm(30), y0, y1, T + mm(25), T + mm(145))
            out.append(box)
        hname = _hw_name(result, "hinge", cab, "Петля соединительная")
        for h in result.hardware:
            if h.kind == "hinge" and h.module == cab and h.name.startswith("Петля соединительная"):
                hname = h.name
        cups = [h for h in up.holes if h.purpose == "чашка петли соединительной"]
        for k, c in enumerate(cups, start=1):
            cup = HwItem(id=f"{up.key}.joint[{k}]", kind="hinge", part=up.key, node=up.node, finish="steel",
                         name=hname)
            _lcyl(cup, up, "z", c.x, c.y, T + mm(1), r.hinge_cup_diameter / 2, mm(2))
            _lbox(cup, up, c.x - mm(8), c.x + mm(8), c.y - mm(7), c.y + mm(7), T, T + mm(9))
            out.append(cup)
            arm = HwItem(id=f"{up.key}.joint[{k}].arm", kind="hinge", part=low.key, node=low.node, finish="steel",
                         name=hname)
            _lbox(arm, low, low.length - mm(52), low.length - mm(2), c.y - mm(7), c.y + mm(7), T, T + mm(9))
            out.append(arm)


_APPLIANCE_BOX = {"microwave": (mm(500), mm(290), mm(360)), "oven": (mm(595), mm(595), mm(560))}  # ширина, высота, глубина


def _wall_appliances(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    """Техника клиента в нише верхнего модуля — для наглядности (в смете её нет)."""
    k = result.product
    if getattr(k, "type", None) != "kitchen":
        return
    by_key = {p.key: p for p in parts}
    for row in ("wall", "wall2"):
        cabs = getattr(k, row)
        for i, cab in enumerate(cabs):
            if cab.kind != "appliance":
                continue
            built = len(cabs) - 1 - i if row == "wall2" and k.corner_side == "left" else i
            path = f"{row}[{built}]"
            bottom = by_key.get(f"{path}.bottom")
            ceiling = by_key.get(f"{path}.niche_shelf") or by_key.get(f"{path}.top")
            if bottom is None or ceiling is None:
                continue
            b, c = bottom.aabb(), ceiling.aabb()
            app = cab.appliance or "microwave"
            w, h, d = _APPLIANCE_BOX[app]
            w, h = min(w, b.max.x - b.min.x - mm(20)), min(h, c.min.z - b.max.z - mm(10))
            cx, z = (b.min.x + b.max.x) / 2, b.max.z
            # Передняя панель техники — заподлицо с фасадами (−толщина фасада), в рамке — за рамкой (по корпусу);
            # глубже корпуса — к стене
            framed = f"{path}.niche_frame" in by_key
            y0 = b.min.y + (mm(2) if framed else -mm(18))
            name = "Микроволновка (клиента)" if app == "microwave" else "Духовка (клиента)"
            # Одна позиция на нишу: корпус и стекло дверцы — формы одного элемента
            body = HwItem(id=f"{path}.appliance", kind="appliance", part=bottom.key, finish="plastic_black", name=name)
            body.box((cx - w / 2, y0, z), (cx + w / 2, y0 + min(d, b.max.y - y0 - mm(5)), z + h))
            body.box((cx - w / 2 + mm(15), y0 - mm(2), z + mm(15)), (cx + w / 2 - mm(110), y0, z + h - mm(15)))
            out.append(body)


# ---------- Кухня: бутылочница (карго) ----------

_CARGO = re.compile(r"^(base2?\[\d+\])\.cargo\.front$")


def _cargo(result: BuildResult, parts: list[Part], out: list[HwItem]) -> None:
    """Корзина бутылочницы: рама за фасадом и 2 уровня корзин с бортиками — едут вместе с фасадом."""
    by_key = {p.key: p for p in parts}
    for p in parts:
        m = _CARGO.match(p.key)
        if not m:
            continue
        cab = m.group(1)
        bottom, left, right = (by_key.get(f"{cab}.{k}") for k in ("bottom", "side.left", "side.right"))
        if bottom is None or left is None or right is None:
            continue
        bb, lb, rb = bottom.aabb(), left.aabb(), right.aabb()
        x0, x1 = lb.max.x + mm(8), rb.min.x - mm(8)
        y0, y1 = bb.min.y + mm(20), bb.max.y - mm(20)
        z_lo, z_hi = bb.max.z, lb.max.z - mm(40)
        name = _hw_name(result, "cargo", cab, "Бутылочница (карго)")
        item = HwItem(id=f"{cab}.cargo.basket", kind="cargo", part=bottom.key, node=p.node, finish="chrome",
                      name=name)
        item.box((x0, y0, z_lo + mm(20)), (x0 + mm(10), y0 + mm(12), z_hi))  # стойка рамы у фасада
        item.box((x0, y1 - mm(12), z_lo + mm(20)), (x0 + mm(10), y1, z_hi))  # задняя стойка
        for z in (z_lo + mm(60), z_lo + (z_hi - z_lo) * 0.55):
            item.box((x0, y0, z), (x1, y1, z + mm(4)))  # дно корзины
            for (a, b_) in (((x0, y0), (x1, y0 + mm(3))), ((x0, y1 - mm(3)), (x1, y1)),
                            ((x0, y0), (x0 + mm(3), y1)), ((x1 - mm(3), y0), (x1, y1))):
                item.box((a[0], a[1], z + mm(60)), (b_[0], b_[1], z + mm(64)))  # бортик
        out.append(item)


# ---------- Сборка списка ----------


def hardware_visuals(result: BuildResult) -> list[HwItem]:
    """Фурнитура для 3D в осях ядра, dmm."""
    out: list[HwItem] = []
    parts = result.parts
    for p in parts:
        if p.role in ("door", "drawer_front"):
            _handles(result, p, out)
        if p.role == "door":
            _hinges(result, p, out)
        if p.role == "rod":
            _rod_holders(result, p, out)
    _gola(result, parts, out)
    _slides(result, parts, out)
    if getattr(result.product, "type", None) == "kitchen":
        _legs(result, parts, out)
    else:
        _wardrobe_legs(result, parts, out)
    _sliding(result, parts, out)
    _corner_mechanisms(result, parts, out)
    _gas_lifts(result, parts, out)
    _fold_lifts(result, parts, out)
    _wall_appliances(result, parts, out)
    if getattr(result.product, "type", None) == "kitchen":
        _cargo(result, parts, out)
    return out


def _shape_mm(s: dict) -> dict:
    out = dict(s)
    for key in ("min", "max", "center"):
        if key in out:
            out[key] = [round(to_mm(v), 2) for v in out[key]]
    for key in ("radius", "length", "inner"):
        if key in out:
            out[key] = round(to_mm(out[key]), 2)
    for key in ("start", "sweep"):
        if key in out:
            out[key] = round(out[key], 2)
    return out


def hardware_visuals_mm(result: BuildResult) -> list[dict]:
    """Для viewer model: размеры в мм."""
    return [
        {"id": h.id, "kind": h.kind, "name": h.name, "node": h.node, "part": h.part, "finish": h.finish,
         "shapes": [_shape_mm(s) for s in h.shapes]}
        for h in hardware_visuals(result)
    ]
