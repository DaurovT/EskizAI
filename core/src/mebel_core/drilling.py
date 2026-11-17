"""Присадка корпуса — как в «Базис-Мебельщике»: соединения, полкодержатели, направляющие, планки петель,
механизмы, ножки, навесы; и проверки отверстий.

Отверстия — Part.holes в чистовой системе детали (x — вдоль длины, y — вдоль ширины):
- в пласти (face A/B): A — пласть при локальной z = толщина, B — при z = 0; depth 0 — сквозное
  (face — сторона, с которой сверлят);
- в торце (face x0/x1/y0/y1): точка на кромке, ось — внутрь детали по середине толщины, depth — глубина.

Где что ставится:
- конфирмат «торец в пласть» (confirmat_joint) — явно из модулей (ctx.join) и общим проходом auto_joints:
  он находит оставшиеся стыки торец-в-пласть между корпусными деталями по геометрии (стенки ящика к
  боковинам). Фурнитура считается здесь же — число конфирматов = число просверленных пар;
- если пласть со стороны головки уже закрыта другой деталью (полки на одной высоте по обе стороны
  перегородки) — соединение на шкантах; занятое место — сдвиг вдоль соединения на шаг 32 мм;
- полкодержатели и направляющие — fill.py через drill_free (встречные отверстия в перегородке
  расходятся по глубине); планки петель — hinge_plate (fronts.py, kitchen_wall.py);
- газлифт / складной подъёмник — lift_brackets (≈); ножки и навесы — по позициям фурнитуры
  в apply_drilling (≈);
- ХДФ на гвоздях — без присадки.
Проверки (check_drilling, предупреждения): пересечение отверстий, вырыв у края, отверстие вне контура
или под примыкающей деталью.
"""

import math
from dataclasses import dataclass

from .catalog import material
from .geometry import Vec3, axis_value, to_local
from .parts import Hole, Part
from .units import mm, to_mm

# Корпусные детали, которые соединяются «торец в пласть» на конфирматах
STRUCTURAL = {"side", "top", "bottom", "partition", "shelf", "divider", "plinth", "rail", "end_rear",
              "end_shelf", "drawer_side", "drawer_wall"}
# Касаются, но не соединяются: дно стоит на планке цоколя (цоколь — к боковинам)
NOT_JOINED = {("bottom", "plinth")}
JOINT_PURPOSES = {"конфирмат", "шкант"}
# Пласти, где отверстие может оказаться под торцом другой детали (у фасада чашка над торцом боковины — так и надо)
STRUCTURAL_FACES = STRUCTURAL | {"spacer", "false_panel"}


# ---------- Геометрия отверстий ----------


def _depth(part: Part, h: Hole) -> int:
    return part.thickness if h.depth == 0 or h.depth >= part.thickness else h.depth


def _z_range(part: Part, h: Hole) -> tuple[float, float]:
    """Занятый отверстием слой по толщине (локальная z)."""
    t = part.thickness
    if h.face in ("A", "B"):
        d = _depth(part, h)
        return (t - d, t) if h.face == "A" else (0, d)
    r = h.diameter / 2
    return t / 2 - r, t / 2 + r


def _footprint(part: Part, h: Hole) -> tuple[str, tuple]:
    """Проекция на пласть: ("circle", (x, y, r)) или ("rect", (x0, x1, y0, y1)) для торцевого."""
    r = h.diameter / 2
    if h.face in ("A", "B"):
        return "circle", (h.x, h.y, r)
    d = h.depth
    if h.face == "x0":
        return "rect", (0, d, h.y - r, h.y + r)
    if h.face == "x1":
        return "rect", (part.length - d, part.length, h.y - r, h.y + r)
    if h.face == "y0":
        return "rect", (h.x - r, h.x + r, 0, d)
    return "rect", (h.x - r, h.x + r, part.width - d, part.width)


def _circle_rect(cx: float, cy: float, r: float, rect: tuple, gap: float) -> bool:
    x0, x1, y0, y1 = rect
    dx = max(x0 - cx, 0, cx - x1)
    dy = max(y0 - cy, 0, cy - y1)
    return dx * dx + dy * dy < (r + gap) ** 2


def _overlap_2d(a: tuple, b: tuple, gap: float) -> bool:
    (ka, ga), (kb, gb) = a, b
    if ka == "circle" and kb == "circle":
        return math.hypot(ga[0] - gb[0], ga[1] - gb[1]) < ga[2] + gb[2] + gap
    if ka == "circle":
        return _circle_rect(ga[0], ga[1], ga[2], gb, gap)
    if kb == "circle":
        return _circle_rect(gb[0], gb[1], gb[2], ga, gap)
    return (min(ga[1], gb[1]) - max(ga[0], gb[0]) > -gap) and (min(ga[3], gb[3]) - max(ga[2], gb[2]) > -gap)


def holes_clash(part: Part, a: Hole, b: Hole, rules) -> bool:
    """Отверстия мешают друг другу: пересекаются в проекции и по толщине (с остатком drill_min_rest)."""
    if not _overlap_2d(_footprint(part, a), _footprint(part, b), rules.drill_min_gap):
        return False
    (a0, a1), (b0, b1) = _z_range(part, a), _z_range(part, b)
    return min(a1, b1) - max(a0, b0) > -rules.drill_min_rest


def is_free(part: Part, hole: Hole, rules) -> bool:
    """Место под отверстие: внутри детали с запасом до края и не мешает другим отверстиям."""
    if hole.face in ("A", "B"):
        m = hole.diameter / 2 + rules.drill_edge_min
        if not (m <= hole.x <= part.length - m and m <= hole.y <= part.width - m):
            return False
        if part.contour is not None or part.cutouts:
            pts = _contour_points(part.contour) if part.contour is not None else None
            if pts is not None and (not _inside(pts, hole.x, hole.y)
                                    or _dist_to_polygon(pts, hole.x, hole.y) < m):
                return False
            for cut in part.cutouts:
                cp = _contour_points(cut)
                if cp and (_inside(cp, hole.x, hole.y) or _dist_to_polygon(cp, hole.x, hole.y) < m):
                    return False
    return not any(holes_clash(part, hole, h, rules) for h in part.holes)


# ---------- Сверление ----------


def _local_hole(part: Part, point: Vec3, diameter: int, depth: int, purpose: str) -> Hole:
    lx, ly, lz = to_local(part.placement, point)
    face = "A" if lz >= part.thickness else "B"
    return Hole(x=lx, y=ly, diameter=diameter, depth=depth, face=face, purpose=purpose)


def drill_free(ctx, part: Part, point: Vec3, diameter: int, depth: int, purpose: str,
               shifts: list[tuple[str, int]] = ()) -> Hole:
    """Отверстие в пласти по точке изделия; если место занято (в том числе встречным отверстием с другой
    пласти) — пробует сдвиги (ось изделия, dmm) по порядку. Не нашлось — ставит как есть (проверка скажет)."""
    for axis, delta in [("X", 0), *shifts]:
        p = Vec3(x=point.x + (delta if axis == "X" else 0), y=point.y + (delta if axis == "Y" else 0),
                 z=point.z + (delta if axis == "Z" else 0))
        hole = _local_hole(part, p, diameter, depth, purpose)
        if is_free(part, hole, ctx.rules):
            part.holes.append(hole)
            return hole
    hole = _local_hole(part, point, diameter, depth, purpose)
    part.holes.append(hole)
    return hole


def hinge_plate(ctx, panel: Part, point: Vec3, along: str) -> None:
    """Монтажная планка петли: point — центр планки на пласти панели на линии system32_front;
    along — ось изделия вдоль кромки фасада с петлями (Z у распашной двери, X у подъёмного).
    along-схема: 2 отверстия ±16 мм вдоль кромки; across — на 37 и 69 мм от переднего края."""
    panel.holes.extend(_plate_holes(ctx, panel, point, along))


def _plate_holes(ctx, panel: Part, point: Vec3, along: str) -> list[Hole]:
    r = ctx.rules
    half = r.hinge_plate_spacing // 2
    offsets = [(along, -half), (along, half)] if r.hinge_plate_pattern == "along" else \
        [("Y", 0), ("Y", r.hinge_plate_spacing)]
    out = []
    for axis, d in offsets:
        p = Vec3(x=point.x + (d if axis == "X" else 0), y=point.y + (d if axis == "Y" else 0),
                 z=point.z + (d if axis == "Z" else 0))
        out.append(_local_hole(panel, p, r.hinge_plate_hole_diameter, r.hinge_plate_hole_depth, "планка петли"))
    return out


def plate_shift(ctx, panel: Part, point: Vec3, along: str, lo: int, hi: int) -> int:
    """Сдвиг петли вдоль кромки (кратно 32 мм, в пределах [lo, hi]), при котором отверстия планки свободны."""
    step = ctx.rules.system32_step
    for k in (0, 1, -1, 2, -2, 3, -3):
        d = k * step
        if not lo <= d <= hi:
            continue
        p = Vec3(x=point.x + (d if along == "X" else 0), y=point.y, z=point.z + (d if along == "Z" else 0))
        if all(is_free(panel, h, ctx.rules) for h in _plate_holes(ctx, panel, p, along)):
            return d
    return 0


# ---------- Соединения «торец в пласть» ----------


_AX = {"X": 0, "Y": 1, "Z": 2}


def bounds(part: Part) -> tuple[int, int, int, int, int, int]:
    """Габарит детали (min x, y, z, max x, y, z) — без pydantic, для частых проверок."""
    o = part.placement.origin
    lo, hi = [o.x, o.y, o.z], [o.x, o.y, o.z]
    for ax, ext in ((part.placement.u, part.length), (part.placement.v, part.width), (part.placement.n, part.thickness)):
        i = _AX[ax[1]]
        if ax[0] == "+":
            hi[i] += ext
        else:
            lo[i] -= ext
    return lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]


@dataclass
class Contact:
    """Торец edge упирается в пласть face (плоскость plane по нормали face, оси — изделия)."""

    face: Part
    edge: Part
    n: str  # ось нормали пласти face
    plane: int
    ranges: dict[str, tuple[int, int]]  # перекрытие по двум другим осям

    @property
    def touched_face(self) -> str:
        """Пласть face, к которой примыкает торец (A/B)."""
        o = self.face.placement
        lz = self.plane - axis_value(o.origin, self.n)
        lz = lz if o.n[0] == "+" else -lz
        return "A" if lz >= self.face.thickness else "B"

    def local_rect(self) -> tuple[float, float, float, float]:
        """Пятно стыка на пласти face — в локальных x, y детали face."""
        pts = []
        for corner in (0, 1):
            coords = {self.n: self.plane}
            for a, (lo, hi) in self.ranges.items():
                coords[a] = hi if corner else lo
            lx, ly, _ = to_local(self.face.placement, Vec3(x=coords["X"], y=coords["Y"], z=coords["Z"]))
            pts.append((lx, ly))
        (x1, y1), (x2, y2) = pts
        return min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)


def find_contact(face: Part, edge: Part, fb: tuple | None = None, eb: tuple | None = None) -> Contact | None:
    n = face.placement.n[1]
    if edge.placement.n[1] == n:
        return None  # параллельные: пласть к пласти
    fb, eb = fb or bounds(face), eb or bounds(edge)
    i = _AX[n]
    if eb[i] == fb[i + 3]:
        plane = fb[i + 3]
    elif eb[i + 3] == fb[i]:
        plane = fb[i]
    else:
        return None
    ranges = {}
    for a in "XYZ":
        if a == n:
            continue
        j = _AX[a]
        lo, hi = max(fb[j], eb[j]), min(fb[j + 3], eb[j + 3])
        if hi <= lo:
            return None
        ranges[a] = (lo, hi)
    return Contact(face=face, edge=edge, n=n, plane=plane, ranges=ranges)


def _edge_side(part: Part, ex: int, ey: int) -> str:
    return "x0" if ex == 0 else "x1" if ex == part.length else "y0" if ey == 0 else "y1"


def _joint_positions(lo: int, hi: int, count: int, offset: int) -> list[int]:
    if count == 1:
        return [(lo + hi) // 2]
    step = (hi - lo - 2 * offset) / (count - 1)
    return [round(lo + offset + k * step) for k in range(count)]


def _cover_rects(ctx, part: Part, face: str, exclude: Part) -> list[tuple]:
    """Пятна на пласти part (сторона face), закрытые торцами других деталей — в локальных x, y."""
    if getattr(ctx, "contacts_cache", None) is not None:  # общий проход: стыки уже найдены
        by_face = ctx.contacts_by_face
        return [c.local_rect() for c in by_face.get(id(part), ()) if c.edge is not exclude and c.touched_face == face]
    pb = bounds(part)
    out = []
    for other in ctx.parts:
        if other is part or other is exclude or not material(other.material).is_sheet:
            continue
        c = find_contact(part, other, pb)
        if c is not None and c.touched_face == face:
            out.append(c.local_rect())
    return out


def _is_covered(h: Hole, rects: list[tuple]) -> bool:
    return any(_circle_rect(h.x, h.y, h.diameter / 2, rect, 0) for rect in rects)


def confirmat_joint(ctx, face_part: Part, edge_part: Part, module: str) -> int:
    """Соединение «торец в пласть»: торец edge_part упирается в пласть face_part.

    Конфирмат: в пласти — сквозное Ø7 со стороны, противоположной соединению (там головка), в торце —
    Ø5 глубиной 50 (rules.confirmat_*). Число — по длине соединения, первый — на confirmat_end_offset от
    края, остальные поровну; место занято другим отверстием — сдвиг на joint_shift_step. Если пласть
    со стороны головки закрыта торцом другой детали (полки на одной высоте по обе стороны перегородки) —
    шкант Ø8: глухое в пласти со стороны соединения и в торце. Возвращает число соединителей."""
    r = ctx.rules
    c = find_contact(face_part, edge_part)
    if c is None:
        ctx.warn("join_no_contact", f"«{edge_part.name}» не касается «{face_part.name}»", module)
        return 0
    ctx.joined.add((face_part.key, edge_part.key))
    a1, a2 = list(c.ranges)
    long_axis = max((a1, a2), key=lambda a: c.ranges[a][1] - c.ranges[a][0])
    thin_axis = a2 if long_axis == a1 else a1
    lo, hi = c.ranges[long_axis]
    mid_thin = sum(c.ranges[thin_axis]) // 2
    count = r.confirmats_for_depth(hi - lo)
    offset = min(r.confirmat_end_offset, (hi - lo) // 4)

    touched = c.touched_face
    entry = "B" if touched == "A" else "A"  # головка конфирмата — с другой стороны пласти
    cover = _cover_rects(ctx, face_part, entry, edge_part)
    kinds = {
        "конфирмат": (r.confirmat_face_diameter, r.confirmat_face_depth, entry, r.confirmat_edge_diameter,
                      r.confirmat_edge_depth),
        "шкант": (r.dowel_diameter, r.dowel_face_depth, touched, r.dowel_diameter, r.dowel_edge_depth),
    }
    step = r.joint_shift_step
    placed: list[int] = []
    used = {"конфирмат": 0, "шкант": 0}

    def pair(purpose: str, pos: int) -> tuple[Hole, Hole]:
        fd, fdepth, side, ed, edepth = kinds[purpose]
        return _pair(face_part, edge_part, c, long_axis, thin_axis, pos, mid_thin, fd, fdepth, side, ed, edepth,
                     purpose)

    for nominal in _joint_positions(lo, hi, count, offset):
        chosen = None
        all_covered = True
        for purpose in ("конфирмат", "шкант"):
            fd = kinds[purpose][0]
            margin = fd // 2 + r.drill_edge_min
            for k in (0, 1, -1, 2, -2):
                pos = nominal + k * step
                if not (lo + margin <= pos <= hi - margin) or any(abs(pos - q) < fd + r.drill_min_gap for q in placed):
                    continue
                fh, eh = pair(purpose, pos)
                if purpose == "конфирмат" and _is_covered(fh, cover):
                    continue
                all_covered = False
                if is_free(face_part, fh, r) and is_free(edge_part, eh, r):
                    chosen = (purpose, pos, fh, eh)
                    break
            if chosen:
                break
        if chosen is None:  # места нет — как по правилу (проверка присадки предупредит)
            purpose = "шкант" if all_covered else "конфирмат"
            chosen = (purpose, nominal, *pair(purpose, nominal))
        purpose, pos, fh, eh = chosen
        placed.append(pos)
        used[purpose] += 1
        face_part.holes.append(fh)
        edge_part.holes.append(eh)
    ctx.add_hardware("confirmat", "Конфирмат 7×50", used["конфирмат"], module)
    ctx.add_hardware("dowel", "Шкант 8×40", used["шкант"], module)
    return count


def _pair(face_part, edge_part, c: Contact, long_axis, thin_axis, pos, mid_thin, fd, fdepth, face_side, ed, edepth,
          purpose) -> tuple[Hole, Hole]:
    coords = {c.n: c.plane, long_axis: pos, thin_axis: mid_thin}
    point = Vec3(x=coords["X"], y=coords["Y"], z=coords["Z"])
    lx, ly, _ = to_local(face_part.placement, point)
    ex, ey, _ = to_local(edge_part.placement, point)
    return (Hole(x=lx, y=ly, diameter=fd, depth=fdepth, face=face_side, purpose=purpose),
            Hole(x=ex, y=ey, diameter=ed, depth=edepth, face=_edge_side(edge_part, ex, ey), purpose=purpose))


def contacts(ctx) -> list[Contact]:
    """Все стыки «торец в пласть» между листовыми деталями. Кэш — на один проход (apply/check):
    детали между ними двигаются (сдвиг изделия, поворот ряда кухни)."""
    if getattr(ctx, "contacts_cache", None) is not None:
        return ctx.contacts_cache
    parts = [p for p in ctx.parts if material(p.material).is_sheet]
    boxes = {id(p): bounds(p) for p in parts}
    # Индекс пластей: (ось нормали, координата плоскости) → детали
    planes: dict[tuple[str, int], list[Part]] = {}
    for p in parts:
        n, b = p.placement.n[1], boxes[id(p)]
        planes.setdefault((n, b[_AX[n]]), []).append(p)
        planes.setdefault((n, b[_AX[n] + 3]), []).append(p)
    out = []
    for e in parts:
        eb = boxes[id(e)]
        for ax in "XYZ":
            if ax == e.placement.n[1]:
                continue
            i = _AX[ax]
            j, k = [_AX[a] for a in "XYZ" if a != ax]
            for coord in {eb[i], eb[i + 3]}:
                for f in planes.get((ax, coord), ()):
                    fb = boxes[id(f)]
                    if f is e or min(fb[j + 3], eb[j + 3]) <= max(fb[j], eb[j]) \
                            or min(fb[k + 3], eb[k + 3]) <= max(fb[k], eb[k]):
                        continue
                    c = find_contact(f, e, fb, eb)
                    if c is not None:
                        out.append(c)
    ctx.contacts_cache = out
    ctx.contacts_by_face = {}
    for c in out:
        ctx.contacts_by_face.setdefault(id(c.face), []).append(c)
    return out


def _root(module: str) -> str:
    return module.split(".")[0]


def auto_joints(ctx) -> None:
    """Стыки корпусных деталей без соединения — на конфирматы (ящик: стенки к боковинам и т. п.)."""
    kitchen = getattr(ctx.product, "type", "") == "kitchen"
    for c in list(contacts(ctx)):
        f, e = c.face, c.edge
        if f.role not in STRUCTURAL or e.role not in STRUCTURAL or (f.role, e.role) in NOT_JOINED:
            continue
        if f.node != e.node:
            continue  # ящик к корпусу не крепится
        if kitchen and _root(f.module) != _root(e.module):
            continue  # модули кухни — отдельные корпуса
        if (f.key, e.key) in ctx.joined or (e.key, f.key) in ctx.joined:
            continue
        confirmat_joint(ctx, f, e, e.module)


# ---------- Механизмы, ножки, навесы ----------


def lift_brackets(ctx, slot, z_top: int, sides: list[str], holes: list[tuple[int, int]], purpose: str) -> None:
    """Кронштейны механизма на боковинах изнутри: (от переднего края корпуса, ниже z_top)."""
    r = ctx.rules
    for side in sides:
        panel = slot.left if side == "left" else slot.right
        b = panel.aabb()
        face_x = b.max.x if side == "left" else b.min.x
        for dy, dz in holes:
            drill_free(ctx, panel, Vec3(x=face_x, y=ctx.front_y + dy, z=z_top - dz), r.hinge_plate_hole_diameter,
                       r.hinge_plate_hole_depth, purpose, shifts=[("Z", -r.system32_step), ("Z", r.system32_step)])


def drill_local(ctx, part: Part, hole: Hole, shifts: list[tuple[int, int]] = ()) -> Hole:
    """Отверстие в локальных координатах; занято — сдвиги (dx, dy) по порядку, не нашлось — как есть."""
    for dx, dy in [(0, 0), *shifts]:
        h = hole.model_copy(update={"x": hole.x + dx, "y": hole.y + dy})
        if is_free(part, h, ctx.rules):
            part.holes.append(h)
            return h
    part.holes.append(hole)
    return hole


def _leg_holes(ctx) -> None:
    """Ножки — на дне снизу (пласть B), ряд за планкой цоколя и ряд у задней кромки (локальная y = 0 —
    передняя кромка дна и у повёрнутого ряда кухни)."""
    r = ctx.rules
    by_key = {p.key: p for p in ctx.parts}
    product = ctx.product
    for item in ctx.hardware:
        if item.kind != "leg":
            continue
        wardrobe = item.module == "body.plinth"
        bottom = by_key.get("body.bottom" if wardrobe else f"{item.module}.bottom")
        if bottom is None or bottom.placement.u[1] == "Z" or bottom.placement.v[1] == "Z":
            continue
        plinth = product.body.plinth if wardrobe else getattr(product, "plinth", None)
        setback = mm(plinth.setback) if plinth is not None else r.kitchen_plinth_setback
        ys = [setback + ctx.t + r.leg_behind_plinth, bottom.width - r.leg_back_inset]
        step = r.system32_step
        for x in _leg_columns(ctx, bottom, max(1, item.qty // 2)):
            for y in ys:
                # Место занято (сквозной конфирмат перегородки) — вся ножка сдвигается вдоль дна
                shift = next((d for d in (0, step, -step, 2 * step, -2 * step)
                              if all(is_free(bottom, _leg_hole(r, x + d + dx, y + dy), r)
                                     for dx, dy in r.leg_hole_offsets)), 0)
                for dx, dy in r.leg_hole_offsets:
                    bottom.holes.append(_leg_hole(r, x + shift + dx, y + dy))


def _leg_hole(r, x: int, y: int) -> Hole:
    return Hole(x=x, y=y, diameter=r.leg_hole_diameter, depth=r.leg_hole_depth, face="B", purpose="ножка")


def _leg_columns(ctx, bottom: Part, cols: int) -> list[int]:
    r = ctx.rules
    a, b = r.leg_side_inset, bottom.length - r.leg_side_inset
    if b <= a:
        return [bottom.length // 2]
    if cols == 1:
        # Одна пара (крыло углового модуля) — у торца с боковиной
        joined_ends = {h.face for h in bottom.holes if h.purpose in JOINT_PURPOSES and h.face in ("x0", "x1")}
        return [b if joined_ends == {"x1"} else a]
    return [round(a + k * (b - a) / (cols - 1)) for k in range(cols)]


def _hanger_holes(ctx) -> None:
    """Навесы верхних модулей — в верхнем заднем углу боковин изнутри. Локальные оси боковины: x — высота
    от низа, y — глубина от передней кромки (так и у повёрнутого ряда); внутренняя пласть левой — A, правой — B."""
    r = ctx.rules
    by_key = {p.key: p for p in ctx.parts}
    for item in ctx.hardware:
        if item.kind != "hanger":
            continue
        top = by_key.get(f"{item.module}.top")
        if top is None:
            continue
        for key, face in (("left", "A"), ("right", "B")):
            side = by_key.get(f"{item.module}.side.{key}")
            if side is None or side.placement.u != "+Z":
                continue
            top_x = bounds(top)[2] - bounds(side)[2]  # низ крыши — в локальной x боковины
            for d_back, d_down in r.hanger_holes:
                drill_local(ctx, side, Hole(x=top_x - d_down, y=side.width - d_back, diameter=r.hanger_hole_diameter,
                                            depth=r.hanger_hole_depth, face=face, purpose="навес"),
                            shifts=[(-r.system32_step, 0)])


def _world_pt(part: Part, x: float, y: float, z: float) -> tuple[float, float, float]:
    o = part.placement.origin
    w = {"X": o.x, "Y": o.y, "Z": o.z}
    for ax, val in ((part.placement.u, x), (part.placement.v, y), (part.placement.n, z)):
        w[ax[1]] += val if ax[0] == "+" else -val
    return w["X"], w["Y"], w["Z"]


def _to_local_f(part: Part, w: tuple[float, float, float]) -> tuple[float, float, float]:
    o = part.placement.origin
    ow = {"X": o.x, "Y": o.y, "Z": o.z}
    pw = {"X": w[0], "Y": w[1], "Z": w[2]}
    return tuple((pw[a[1]] - ow[a[1]]) * (1 if a[0] == "+" else -1)
                 for a in (part.placement.u, part.placement.v, part.placement.n))


def settle_joints(ctx) -> None:
    """После операций формы (вырезы Gola, скругления): соединение, попавшее в вырез или к краю, сдвигается
    вдоль стыка на шаг (обе детали вместе)."""
    r = ctx.rules
    shaped = [p for p in ctx.parts if (p.contour is not None or p.cutouts) and
              any(h.purpose in JOINT_PURPOSES and h.face in ("A", "B") for h in p.holes)]
    if not shaped:
        return
    edge_holes: dict[tuple[int, int, int], tuple[Part, Hole]] = {}
    for e in ctx.parts:
        for h in e.holes:
            if h.purpose in JOINT_PURPOSES and h.face not in ("A", "B"):
                w = _world_pt(e, h.x, h.y, e.thickness / 2)
                edge_holes[tuple(round(v) for v in w)] = (e, h)
    for f in shaped:
        for h in list(f.holes):
            if h.purpose not in JOINT_PURPOSES or h.face not in ("A", "B"):
                continue
            f.holes.remove(h)
            ok = is_free(f, h, r)
            f.holes.append(h)
            if ok:
                continue
            touched = h.face if h.purpose == "шкант" else ("B" if h.face == "A" else "A")
            w = _world_pt(f, h.x, h.y, f.thickness if touched == "A" else 0)
            found = edge_holes.get(tuple(round(v) for v in w))
            if found is None:
                continue
            e, eh = found
            along = (0, 1) if eh.face in ("x0", "x1") else (1, 0)
            for k in (1, -1, 2, -2, 3, -3):
                d = k * r.joint_shift_step
                ne = eh.model_copy(update={"x": eh.x + along[0] * d, "y": eh.y + along[1] * d})
                nw = _world_pt(e, ne.x, ne.y, e.thickness / 2)
                lx, ly, _ = _to_local_f(f, nw)
                nf = h.model_copy(update={"x": round(lx), "y": round(ly)})
                f.holes.remove(h)
                e.holes.remove(eh)
                free = is_free(f, nf, r) and is_free(e, ne, r) and _edge_ok(e, ne, r)
                f.holes.append(nf if free else h)
                e.holes.append(ne if free else eh)
                if free:
                    break


def _edge_ok(part: Part, h: Hole, r) -> bool:
    along = h.y if h.face in ("x0", "x1") else h.x
    span = part.width if h.face in ("x0", "x1") else part.length
    return min(along, span - along) - h.diameter / 2 >= r.drill_edge_min


def apply_drilling(ctx) -> None:
    """Общий проход после сборки модулей: недостающие соединения, ножки, навесы."""
    if not ctx.parts:
        return
    ctx.contacts_cache = None
    auto_joints(ctx)
    ctx.contacts_cache = None  # дальше детали ещё двигаются (сдвиг изделия, операции формы)
    if ctx.rules.drill_legs:
        _leg_holes(ctx)
    _hanger_holes(ctx)


# ---------- Проверки ----------


def _contour_points(contour) -> list[tuple[float, float]] | None:
    """Контур (линии и дуги) → многоугольник; дуги — по 8 отрезков."""
    if contour is None:
        return None
    pts = [(contour.start_x, contour.start_y)]
    for seg in contour.segments:
        if seg.kind == "arc":
            px, py = pts[-1]
            a1, a2 = math.atan2(py - seg.cy, px - seg.cx), math.atan2(seg.y - seg.cy, seg.x - seg.cx)
            sweep = -((a1 - a2) % (2 * math.pi)) if seg.clockwise else (a2 - a1) % (2 * math.pi)
            rad = math.hypot(px - seg.cx, py - seg.cy)
            for k in range(1, 8):
                a = a1 + sweep * k / 8
                pts.append((seg.cx + rad * math.cos(a), seg.cy + rad * math.sin(a)))
        pts.append((seg.x, seg.y))
    if len(pts) > 1 and pts[-1] == pts[0]:
        pts.pop()
    return pts


def _inside(pts: list[tuple[float, float]], x: float, y: float) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def _dist_to_polygon(pts: list[tuple[float, float]], x: float, y: float) -> float:
    best = math.inf
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0 if L2 == 0 else max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / L2))
        best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    return best


def _x_extent(part: Part, h: Hole) -> tuple[float, float]:
    kind, g = _footprint(part, h)
    return (g[0] - g[2], g[0] + g[2]) if kind == "circle" else (g[0], g[1])


TITLES = {
    "drill_collision": "отверстия пересекаются",
    "drill_edge": "отверстие близко к краю — вырыв",
    "drill_outside": "отверстие вне детали",
    "drill_covered": "отверстие под примыкающей деталью",
}


def drilling_problems(ctx) -> dict[tuple[str, str], list[str]]:
    """(код, ключ детали) → описания проблем присадки."""
    r = ctx.rules
    found: dict[tuple[str, str], list[str]] = {}

    def note(code: str, part: Part, text: str) -> None:
        found.setdefault((code, part.key), []).append(text)

    def pos(h: Hole) -> str:
        return f"{h.purpose} Ø{to_mm(h.diameter):g} ({h.face}: {to_mm(h.x):g}; {to_mm(h.y):g})"

    for p in ctx.parts:
        if not p.holes or not material(p.material).is_sheet:
            continue
        # Пересечения: развёртка по x
        items = sorted(((_x_extent(p, h), h) for h in p.holes), key=lambda it: it[0][0])
        for i, ((_, ax1), a) in enumerate(items):
            for (bx0, _), b in items[i + 1:]:
                if bx0 > ax1 + r.drill_min_gap:
                    break
                if holes_clash(p, a, b, r):
                    note("drill_collision", p, f"{pos(a)} и {pos(b)}")
        pts = _contour_points(p.contour) if p.contour is not None else \
            [(0, 0), (p.length, 0), (p.length, p.width), (0, p.width)]
        cuts = [_contour_points(c) for c in p.cutouts]
        t = p.thickness
        for a in p.holes:
            ra = a.diameter / 2
            if a.face in ("A", "B"):
                if not _inside(pts, a.x, a.y):
                    note("drill_outside", p, pos(a))
                    continue
                if _dist_to_polygon(pts, a.x, a.y) - ra < r.drill_edge_min:
                    note("drill_edge", p, pos(a))
                for cp in cuts:
                    if cp and (_inside(cp, a.x, a.y) or _dist_to_polygon(cp, a.x, a.y) - ra < r.drill_edge_min):
                        note("drill_edge", p, f"{pos(a)} у выреза")
            else:
                along = a.y if a.face in ("x0", "x1") else a.x
                span = p.width if a.face in ("x0", "x1") else p.length
                into = p.length if a.face in ("x0", "x1") else p.width
                if not 0 <= along <= span:
                    note("drill_outside", p, pos(a))
                elif min(along, span - along) - ra < r.drill_edge_min:
                    note("drill_edge", p, f"{pos(a)} — у угла")
                if a.depth >= into:
                    note("drill_edge", p, f"{pos(a)} — глубже детали")
                if (t - a.diameter) / 2 < r.drill_edge_min:
                    note("drill_edge", p, f"{pos(a)} — в торце толщиной {to_mm(t):g} мм")

    # Отверстие (не соединительное) закрыто торцом примыкающей детали
    for c in contacts(ctx):
        f = c.face
        if not f.holes or f.role not in STRUCTURAL_FACES:
            continue
        touched = c.touched_face
        box = c.local_rect()
        for h in f.holes:
            if h.face == touched and h.purpose not in JOINT_PURPOSES and _circle_rect(h.x, h.y, h.diameter / 2, box, 0):
                note("drill_covered", f, f"{pos(h)} — под «{c.edge.name}»")
    return found


def check_drilling(ctx) -> None:
    """Предупреждения по присадке: пересечения, вырыв у края, вне детали, под примыкающей деталью."""
    settle_joints(ctx)
    ctx.contacts_cache = None
    by_key = {p.key: p for p in ctx.parts}
    for (code, key), texts in drilling_problems(ctx).items():
        p = by_key[key]
        more = f" и ещё {len(texts) - 3}" if len(texts) > 3 else ""
        ctx.warn(code, f"Присадка «{p.name}» ({p.key}): {TITLES[code]} — {'; '.join(texts[:3])}{more}", p.module)
    ctx.contacts_cache = None
