"""Кухня: прямая и угловая (Г). Нижние и верхние модули, столешница, цоколь.

Угловой модуль: long — длинный глухой вдоль первого ряда; square — Г-образный w×w на обе стены
(основная часть в первом ряду, крыло — в начале второго). Наполнение угла: полка, карусель, поворотная полка.

Каждый модуль — свой корпус. Нижние стоят на ножках, сверху у них
царги вместо крыши (сверху столешница). Верхние висят на навесах на
монтажной шине и выровнены по верху.
"""

from ..assembler import BuildContext, BuildError, Box, Slot, Zone, at
from ..catalog import material
from ..geometry import Contour, LineSeg, Placement
from ..schema import DrawersFill, Kitchen, ShelvesFill
from ..units import mm, to_mm
from . import module
from .body import FRONTAL, HORIZONTAL, VERTICAL
from .fronts import _doors, _drawer_fronts


def _door_count(ctx: BuildContext, width: int, requested) -> int:
    if requested:
        return requested
    return 1 if width - ctx.rules.front_gap <= ctx.rules.door_max_width else 2


def _carcass(ctx: BuildContext, *, path: str, x: int, w: int, z: int, h: int, d: int, kind: str,
             back: bool, y0: int = 0) -> Slot:
    """Корпус модуля. kind: base — дно и царги, wall — дно и крыша."""
    r, t = ctx.rules, ctx.t
    mat = ctx.product.body.material
    front, visible = r.edge_front, r.edge_visible
    side_edges = {"y0": front} if kind == "base" else {"y0": front, "x0": visible, "x1": visible}
    sides = []
    for key, sx, name in (("left", x, "Боковина левая"), ("right", x + w - t, "Боковина правая")):
        sides.append(ctx.add_part(
            key=f"{path}.side.{key}", name=name, role="side", module=path, material_id=mat,
            length=h, width=d, placement=Placement(origin=at(sx, y0, z), **VERTICAL), edges=dict(side_edges),
        ))
    bottom = ctx.add_part(
        key=f"{path}.bottom", name="Дно", role="bottom", module=path, material_id=mat,
        length=w - 2 * t, width=d, placement=Placement(origin=at(x + t, y0, z), **HORIZONTAL), edges={"y0": front},
    )
    for s in sides:
        ctx.join(s, bottom, path)

    if kind == "base":
        rail_w = r.kitchen_rail_width
        top = None
        for key, y, name in (("front", 0, "Царга передняя"), ("back", d - rail_w, "Царга задняя")):
            rail = ctx.add_part(
                key=f"{path}.rail.{key}", name=name, role="rail", module=path, material_id=mat,
                length=w - 2 * t, width=rail_w, placement=Placement(origin=at(x + t, y0 + y, z + h - t), **HORIZONTAL),
                edges={"y0": visible} if key == "front" else {},
            )
            for s in sides:
                ctx.join(s, rail, path)
            top = top or rail
    else:
        top = ctx.add_part(
            key=f"{path}.top", name="Крыша", role="top", module=path, material_id=mat,
            length=w - 2 * t, width=d, placement=Placement(origin=at(x + t, y0, z + h - t), **HORIZONTAL),
            edges={"y0": front},
        )
        for s in sides:
            ctx.join(s, top, path)

    if back and ctx.product.body.back.kind == "nailed":
        bm = ctx.product.body.back
        inset = r.back_inset
        bl, bw = w - 2 * inset, h - 2 * inset
        ctx.add_part(
            key=f"{path}.back", name="Задняя стенка", role="back", module=path, material_id=bm.material,
            length=bl, width=bw, placement=Placement(origin=at(x + inset, y0 + d, z + inset), **FRONTAL), grain="none",
        )
        ctx.add_hardware("nail", "Гвоздь для ХДФ 1,6×25", -(-2 * (bl + bw) // mm(150)), path)

    box = Box(x0=x + t, x1=x + w - t, y0=y0, y1=y0 + d, z0=z + t, z1=z + h - t)
    return Slot(index=0, path=path, box=box, left=sides[0], right=sides[1], bottom=bottom, top=top)


def _split_run(bounds: list[int], max_len: int) -> list[tuple[int, int]]:
    """Делит длину ряда на куски не длиннее max_len по стыкам модулей (жадно)."""
    pieces, start = [], 0
    while start < len(bounds) - 1:
        end = start + 1
        while end + 1 < len(bounds) and bounds[end + 1] - bounds[start] <= max_len:
            end += 1
        pieces.append((bounds[start], bounds[end]))
        start = end
    return pieces


@module("kitchen", "0.3.0", "Кухня: прямая и угловая")
def build_kitchen(ctx: BuildContext) -> tuple[int, int, int]:
    k: Kitchen = ctx.product
    r = ctx.rules
    corner = k.layout == "corner"
    if corner and not k.base2:
        raise BuildError("corner_without_run2", "Для угловой кухни нужен второй ряд нижних модулей", "base2")
    if not corner and (k.base2 or k.wall2):
        raise BuildError("run2_without_corner", "Второй ряд бывает только у угловой кухни (layout=corner)", "base2")

    if any(c.kind == "corner" and c.corner_shape == "square" for c in k.base2):
        raise BuildError("corner_square_run2", "Г-образный угловой модуль ставится в первый ряд (base), у угла",
                         "base2")
    # Г-образный угловой модуль: его вторая часть («крыло») строится в начале второго ряда
    square = next((c for c in k.base if c.kind == "corner" and c.corner_shape == "square"), None) if corner else None
    leg = mm(square.width) - mm(k.base_depth) if square else 0

    # Ряд 1 — вдоль X, угол справа (x = L1) или слева (x = 0)
    from .builtin import check_kitchen_back

    check_kitchen_back(ctx)
    run1 = _build_run(ctx, k, k.base, k.wall, run="", corner_at=(k.corner_side if corner else None))
    if not corner:
        if any(sp.run == 2 for sp in k.side_panels):
            raise BuildError("run2_without_corner", "Фальш-панель второго ряда — только у угловой кухни",
                             "side_panels")
        width = max(run1.base_len, run1.wall_len) + _shift_left(ctx)
        width = max([width] + [p.aabb().max.x for p in ctx.parts if p.role in ("false_panel", "niche_filler")])
        return width, run1.height, mm(k.base_depth)

    # Ряд 2 строится как прямой ряд в своих координатах, потом поворачивается к соседней стене.
    # Слева порядок модулей разворачиваем, чтобы угловой край ряда оказался у угла (поворот без зеркала).
    first = len(ctx.parts)
    first_node = len(ctx.nodes)
    left = k.corner_side == "left"
    base2 = list(reversed(k.base2)) if left else list(k.base2)
    wall2 = list(reversed(k.wall2)) if left else list(k.wall2)
    run2 = _build_run(ctx, k, base2, wall2, run="2", corner_at=("right" if left else "left"), leg=leg)
    # Доходят ли верхние первого ряда до угла: тогда верхние второго ряда встают перед их фасадами
    wd_total = mm(k.wall_depth)
    reaches = bool(k.wall) and (left or run1.wall_len > run1.base_len - wd_total)
    _rotate_run(ctx, first, first_node, k, run1.base_len, run2.base_len, run2.wall_len, left, reaches,
                square=bool(square))
    if reaches and k.wall2:
        ctx.warn("corner_wall", "Верхний модуль первого ряда у угла частично перекрыт вторым рядом — "
                                "проверьте, что дверь открывается", "wall")
    ctx.add_hardware("countertop_joint", "Планка соединения столешницы (угол)", 1, "countertop")

    # Сдвигаем изделие так, чтобы второй ряд не уходил в отрицательные y (ось X — как у прямой кухни)
    min_y = min(p.aabb().min.y for p in ctx.parts)
    y_ct = mm(k.base_depth) - mm(k.countertop.depth)
    dy = y_ct - min_y
    if dy:
        for p in ctx.parts:
            p.placement.origin.y += dy
        for n in ctx.nodes:
            n.origin = (n.origin[0], n.origin[1] + dy, n.origin[2])
    _shift_left(ctx)
    width = max(p.aabb().max.x for p in ctx.parts)
    depth = max(p.aabb().max.y for p in ctx.parts)
    return width, max(run1.height, run2.height), depth


def _shift_left(ctx: BuildContext) -> int:
    """Левая фальш-панель строилась при x < 0 — сдвигаем кухню вправо."""
    dx = max(0, -min((p.aabb().min.x for p in ctx.parts), default=0))
    if dx:
        for p in ctx.parts:
            p.placement.origin.x += dx
        for n in ctx.nodes:
            n.origin = (n.origin[0] + dx, n.origin[1], n.origin[2])
    return dx


class _Run:
    def __init__(self, base_len: int, wall_len: int, height: int):
        self.base_len, self.wall_len, self.height = base_len, wall_len, height


def _build_run(ctx: BuildContext, k: Kitchen, base: list, wall: list, *, run: str, corner_at, leg: int = 0) -> _Run:
    """Один прямой ряд: нижние модули, цоколь, столешница, верхние. corner_at — с какого края угол
    (там нет стены ниши; у глухого углового модуля перекрыта часть фасада). leg — ширина крыла
    Г-образного углового модуля в начале второго ряда (у угла)."""
    r = ctx.rules
    back = k.body.back
    back_t = material(back.material).thickness if back.kind == "nailed" else 0
    legs, bh = mm(k.legs_height), mm(k.base_height)
    bd = mm(k.base_depth) - back_t
    from .fronts import _front_part, _front_thickness

    tf = _front_thickness(ctx)
    base_len = sum(mm(c.width) for c in base) + leg
    far = 10 ** 9  # «стены нет»
    ctx.walls = (far if corner_at == "left" else 0, far if corner_at == "right" else base_len)
    wall_top = mm(k.wall_bottom) + mm(k.wall_height)
    fridges = _check_fridges(ctx, k, base, wall, run, corner_at, leg)
    fridge_top = max([wall_top] + [mm(c.fridge_height) + r.fridge_top_gap + ctx.t + mm(100)
                                   for c in base if c.kind == "fridge"])

    x = 0
    bounds = [0]
    sinks: list[tuple[int, int]] = []
    leg_first = leg and corner_at == "left"  # крыло у угла: в начале ряда (угол справа) или в конце (слева)
    if leg_first:
        _corner_leg(ctx, k, path=f"base{run}.corner", x=0, w=leg, legs=legs, bh=bh, d=bd, open_at="left")
        x = leg
        bounds.append(x)
    for i, cab in enumerate(base):
        w, path = mm(cab.width), f"base{run}[{i}]"
        if cab.kind == "sink":
            sinks.append((x, x + w))
        if cab.kind == "appliance":
            ctx.warn("appliance_niche", f"Модуль {i + 1}: ниша {cab.width:g} мм под технику — проверьте размеры "
                                        "по инструкции техники", path)
            if cab.dw:
                ctx.run("kitchen_dw_front", path=path, x=x, w=w, z0=legs, z1=legs + bh)
        elif cab.kind == "fridge":
            ctx.run("kitchen_fridge", cab, path=path, x=x, w=w, top=fridge_top, tf=tf, depth=mm(k.base_depth))
        else:
            slot = _carcass(ctx, path=path, x=x, w=w, z=legs, h=bh, d=bd, kind="base", back=cab.kind != "sink")
            xs = [x, x + w]
            if cab.kind == "corner":
                at_end = (corner_at == "right" and i == len(base) - 1) or (corner_at == "left" and i == 0)
                if not at_end:
                    raise BuildError("corner_cabinet_position", "Угловой модуль должен стоять в углу ряда", path)
                if cab.corner_shape == "square":
                    _corner_square(ctx, k, cab, slot, path=path, x=x, w=w, legs=legs, bh=bh, tf=tf,
                                   corner_at=corner_at)
                    ctx.add_hardware("leg", "Ножка кухонная регулируемая", 4, path)
                    x += w
                    bounds.append(x)
                    continue
                if cab.corner_fill == "carousel":
                    raise BuildError("carousel_needs_square",
                                     "Карусель ставится только в Г-образный угловой модуль 900×900 или 1000×1000 — "
                                     "выберите поворотную полку или глухой угол", path)
                # Часть фасада перекрыта вторым рядом: глубина ряда + фасад + зазор под ручку
                blocked = mm(k.base_depth) + tf + mm(50)
                free = w - blocked
                if free < mm(300):
                    raise BuildError("corner_cabinet_narrow",
                                     f"Угловой модуль {cab.width:g} мм: под дверь остаётся {to_mm(free)} мм", path)
                if cab.corner_fill == "swing" and free < r.corner_swing_min_opening:
                    raise BuildError("corner_opening_narrow",
                                     f"Поворотной полке нужен проём от {to_mm(r.corner_swing_min_opening)} мм, "
                                     f"а у углового модуля {cab.width:g} мм — {to_mm(free)} мм", path)
                if corner_at == "right":
                    door_xs, filler = [x, x + free], (x + free, x + free + tf + mm(50))
                    hinge = "left"
                else:
                    door_xs, filler = [x + blocked, x + w], (x + w - free - tf - mm(50), x + w - free)
                    hinge = "right"
                if cab.corner_fill == "swing":
                    ctx.add_hardware("corner_swing", "Поворотная полка для углового модуля (2 уровня)", 1, path)
                elif cab.shelf:
                    ctx.run("shelf", slot, slot.box, ShelvesFill(count=1), f"{path}.fill[0]")
                _doors(ctx, slot, door_xs, legs, legs + bh, 1, hinge, f"{path}.doors", tall=False)
                g = r.front_gap // 2
                _front_part(ctx, f"{path}.filler", "Фальш-панель угловая", "filler", filler[0] + g, filler[1] - g,
                            legs + g, legs + bh - g, None, door=True)
            elif cab.kind in ("doors", "sink"):
                if cab.kind == "doors" and cab.shelf:
                    ctx.run("shelf", slot, slot.box, ShelvesFill(count=1), f"{path}.fill[0]")
                _doors(ctx, slot, xs, legs, legs + bh, _door_count(ctx, w, cab.doors), cab.hinge,
                       f"{path}.doors", tall=False)
            elif cab.kind == "drawers":
                fill = DrawersFill(count=cab.drawers, external=True)
                fpath = f"{path}.fill[0]"
                ctx.run("drawer", slot, slot.box, fill, fpath, None)
                zone = Zone(z0=slot.box.z0, z1=slot.box.z1, kind="drawers", external_drawers=cab.drawers, path=fpath)
                _drawer_fronts(ctx, slot, xs, legs, legs + bh, zone)
            ctx.add_hardware("leg", "Ножка кухонная регулируемая", 4, path)
        x += w
        bounds.append(x)
    if leg and not leg_first:
        _corner_leg(ctx, k, path=f"base{run}.corner", x=x, w=leg, legs=legs, bh=bh, d=bd, open_at="right")
        x += leg
        bounds.append(x)

    # Холодильник с края ряда — без цоколя и столешницы
    lo_f = max([b for a, b, end in fridges if end == "left"], default=None)
    hi_f = min([a for a, b, end in fridges if end == "right"], default=None)
    if lo_f is not None or hi_f is not None:
        bounds = [b for b in bounds if (lo_f is None or b >= lo_f) and (hi_f is None or b <= hi_f)]
    # Фальш-панели на торцах ряда
    from .builtin import kitchen_panel_ends

    panel_ends = kitchen_panel_ends(k, run, corner_at)
    wall_len = sum(mm(c.width) for c in wall)
    wall_y = mm(k.base_depth) - mm(k.wall_depth)
    wall_z0 = min([wall_top - (mm(c.height) if c.height else (r.hood_height if c.kind == "hood" else
                                                             mm(k.wall_height))) for c in wall if c.kind != "gap"],
                  default=mm(k.wall_bottom))
    ct_ext = {"left": 0, "right": 0}
    for end, panels in panel_ends.items():
        for sp in panels:
            pt = ctx.run("kitchen_side_panel", sp, run=run, end=end, x_base=(0, base_len), x_wall=(0, wall_len),
                         base_top=legs + bh, wall_z=(wall_z0, wall_top), wall_y=wall_y, depth=mm(k.base_depth),
                         tf=tf)
            fridge_end = any(e == end for _, _, e in fridges)
            if pt and not fridge_end:
                ct_ext[end] = pt

    # Цоколь на клипсах по всей длине; длиннее листа — частями по стыкам модулей
    kp = k.plinth
    setback = mm(kp.setback) if kp else r.kitchen_plinth_setback
    allow = max(0, min(mm(kp.floor_allowance), legs - mm(30))) if kp else 0
    usable = r.sheet_length - 2 * r.sheet_trim
    plinth_pieces = _split_run(bounds, usable)
    plinth_parts = []
    for n, (a, b) in enumerate(plinth_pieces, start=1):
        single = len(plinth_pieces) == 1
        plinth_parts.append(ctx.add_part(
            key=f"kitchen.plinth{run}" if single else f"kitchen.plinth{run}[{n}]",
            name="Цоколь кухни" if single else f"Цоколь кухни {n}", role="plinth", module="kitchen",
            material_id=k.body.material, length=b - a, width=legs - allow,
            placement=Placement(origin=at(a, setback, allow), **FRONTAL),
        ))
    ctx.add_hardware("plinth_clip", "Клипса цоколя", max(2, -(-base_len // mm(600)) * 2), "kitchen")
    if kp and plinth_parts:
        covered = {e for e, ps in panel_ends.items() if any(sp.to_floor and sp.row != "wall" for sp in ps)}
        covered |= {e for _, _, e in fridges}
        ends = {}
        if kp.sides == "auto" and k.installation == "freestanding":
            ends = {e: x for e, x in (("left", bounds[0]), ("right", bounds[-1]))
                    if e != corner_at and e not in covered}
        grilles = []
        for i, cab in enumerate(base):
            kind = "sink" if cab.kind == "sink" else ("oven" if cab.kind == "appliance" and not cab.dw else None)
            if kind in kp.grilles:
                xa = leg + sum(mm(c.width) for c in base[:i]) if leg_first else sum(mm(c.width) for c in base[:i])
                grilles.append((xa, xa + mm(cab.width), f"base{run}[{i}]"))
        if kp.grilles and not grilles and run == "":
            ctx.warn("grille_no_module", "Решётки в цоколе: нет модуля мойки или духовки", "plinth")
        ctx.run("kitchen_plinth", run=run, pieces=plinth_parts, ends=ends, legs=legs, allow=allow, setback=setback,
                depth=bd, grilles=grilles)

    # Столешница: если длиннее плиты — делим по стыку модулей ближе к середине.
    # У Г-образного угла столешница второго ряда начинается от передней кромки первой (стык под 90°).
    ct = k.countertop
    ct_t = material(ct.material).thickness
    ct_d = mm(ct.depth)
    y0 = mm(k.base_depth) - ct_d
    off = ct_d - mm(k.base_depth) if leg else 0
    lo, hi = (off, base_len) if leg_first else (0, base_len - off)
    lo = lo - ct_ext["left"] if lo_f is None else max(lo, lo_f)  # над фальш-панелью — столешница, над холодильником — нет
    hi = hi + ct_ext["right"] if hi_f is None else min(hi, hi_f)
    length = hi - lo
    pieces = [(lo, hi)]
    if length > r.countertop_max_length:
        inner = [b for b in bounds[1:-1]
                 if lo < b < hi and b - lo <= r.countertop_max_length and hi - b <= r.countertop_max_length]
        if not inner:
            raise BuildError("countertop_too_long", f"Столешницу {to_mm(length)} мм не разделить по стыку модулей",
                             "countertop")
        cut = min(inner, key=lambda b: abs(b - (lo + hi) / 2))
        pieces = [(lo, cut), (cut, hi)]
        ctx.add_hardware("countertop_joint", "Планка соединения столешницы", 1, "countertop")
        ctx.warn("countertop_joint", f"Столешница {to_mm(length)} мм длиннее плиты {to_mm(r.countertop_max_length)} мм "
                                     f"— будет стык на {to_mm(cut - lo)} мм с планкой. Цельным листом — только до "
                                     f"{to_mm(r.countertop_max_length)} мм", f"countertop{run}")
    cut_w, cut_d = r.sink_cutout_max
    cut_d = min(cut_d, ct_d - mm(120))
    for n, (a, b) in enumerate(pieces, start=1):
        top = ctx.add_part(
            key=f"countertop{run}" if len(pieces) == 1 else f"countertop{run}[{n}]",
            name="Столешница" if len(pieces) == 1 else f"Столешница {n}",
            role="countertop", module="countertop", material_id=ct.material, length=b - a, width=ct_d,
            placement=Placement(origin=at(a, y0, legs + bh), **HORIZONTAL),
        )
        # Вырез под мойку — по центру модуля мойки (размер уточняется по мойке клиента)
        for sa, sb in sinks:
            if a <= sa and sb <= b:
                cw = min(cut_w, sb - sa - 2 * ctx.t - mm(40))
                cx, cy = (sa + sb - cw) // 2 - a, (ct_d - cut_d) // 2
                if cw > mm(200):
                    top.cutouts.append(_rect(cx, cy, cw, cut_d))

    # Верхние модули — на стене, выровнены по верху
    ctx.walls = (far if corner_at == "left" else 0, far if corner_at == "right" else wall_len)
    wx = 0
    wd = mm(k.wall_depth) - back_t
    wall_y = mm(k.base_depth) - mm(k.wall_depth)  # задняя стенка у стены
    ctx.front_y = wall_y
    segments: list[tuple] = []  # куски ряда верхних без разрывов — под добор до потолка: x0, x1, y лица, ряд, низ
    if wall and mm(k.wall_bottom) - (legs + bh + ct_t) < mm(450):
        ctx.warn("wall_too_low", "Между столешницей и верхними модулями меньше 450 мм — неудобно работать", "wall")
    rail = 0
    for j, cab in enumerate(wall):
        w, path = mm(cab.width), f"wall{run}[{j}]"
        if cab.kind == "gap":  # пустое место (окно, вентканал) — без корпуса
            wx += w
            continue
        if segments and segments[-1][1] == wx:
            segments[-1] = (segments[-1][0], wx + w, wall_y - tf, "wall", wall_top)
        else:
            segments.append((wx, wx + w, wall_y - tf, "wall", wall_top))
        rail += w
        h = mm(cab.height) if cab.height else (r.hood_height if cab.kind == "hood" else mm(k.wall_height))
        z0 = wall_top - h
        slot = _carcass(ctx, path=path, x=wx, w=w, z=z0, h=h, d=wd, kind="wall", back=True, y0=wall_y)
        if cab.shelves and cab.kind != "hood":
            ctx.run("shelf", slot, slot.box, ShelvesFill(count=cab.shelves), f"{path}.fill[0]")
        if cab.kind != "open":
            last = j == len(wall) - 1
            hinge = cab.hinge if cab.doors or not last else "right"
            _doors(ctx, slot, [wx, wx + w], z0, wall_top, _door_count(ctx, w, cab.doors), hinge, f"{path}.doors",
                   tall=False)
        ctx.add_hardware("hanger", "Навес мебельный регулируемый", 2, path)
        wx += w
    ctx.front_y = 0
    if rail:
        ctx.add_hardware("mount_rail", f"Шина монтажная {round(to_mm(rail))} мм", 1, f"wall{run}", length=rail)
    height = wall_top if rail else legs + bh + ct_t
    if fridges:
        height = max(height, fridge_top)
    if k.top_filler:
        segments += [(a, b, -tf, "base", fridge_top) for a, b, _ in fridges]
        if segments:
            height = max(height, ctx.run("kitchen_top_filler", run=run, segments=segments))
    return _Run(base_len, wall_len, height)


def _check_fridges(ctx: BuildContext, k: Kitchen, base: list, wall: list, run: str, corner_at, leg: int) -> list:
    """Холодильник — с края ряда (не в углу) и без верхних модулей над ним. → [(x0, x1, торец)]."""
    out = []
    x = leg if leg and corner_at == "left" else 0
    for i, cab in enumerate(base):
        w = mm(cab.width)
        if cab.kind == "fridge":
            path = f"base{run}[{i}]"
            end = "left" if i == 0 else ("right" if i == len(base) - 1 else None)
            if end is None or end == corner_at:
                raise BuildError("fridge_position", "Холодильник ставится с края ряда (первым или последним "
                                                    "модулем), не в углу", path)
            wx = 0
            for j, wc in enumerate(wall):
                ww = mm(wc.width)
                if wc.kind != "gap" and wx < x + w and wx + ww > x:
                    raise BuildError("fridge_wall_overlap",
                                     f"Над холодильником (модуль {i + 1}) висит верхний модуль {j + 1} — поставьте в "
                                     f"верхний ряд на это место пустое место (kind gap) шириной {cab.width:g} мм",
                                     f"wall{run}[{j}]")
                wx += ww
            out.append((x, x + w, end))
        x += w
    return out


# Поворот ряда 2 на 90° (без зеркала): правый угол — локальная +X → −Y, +Y → +X; левый — +X → +Y, +Y → −X
_ROT = {
    False: {"+X": "-Y", "-X": "+Y", "+Y": "+X", "-Y": "-X", "+Z": "+Z", "-Z": "-Z"},
    True: {"+X": "+Y", "-X": "-Y", "+Y": "-X", "-Y": "+X", "+Z": "+Z", "-Z": "-Z"},
}


def _rotate_run(ctx: BuildContext, first: int, first_node: int, k: Kitchen, len1: int, len2: int, wall_len2: int,
                left: bool, wall_reaches_corner: bool, square: bool = False) -> None:
    """Нижний ряд 2 начинается от передней кромки столешницы ряда 1 (у Г-образного угла — от передней
    плоскости корпусов ряда 1, с крылом углового модуля). Верхний ряд 2 — от самого угла,
    а если верхние ряда 1 доходят до угла — вплотную к их фасадам."""
    from .fronts import _front_thickness

    bd = mm(k.base_depth)
    y_ct = 0 if square else bd - mm(k.countertop.depth)
    y_wall = (bd - mm(k.wall_depth) - _front_thickness(ctx) - ctx.rules.front_gap) if wall_reaches_corner else bd

    def move(x: int, y: int, wall: bool) -> tuple[int, int]:
        start, run_len = (y_wall, wall_len2) if wall else (y_ct, len2)
        if left:  # угол при x = 0; ряд 2 вдоль левой стены, его конец x' = длина ряда — у угла
            return bd - y, start - run_len + x
        return len1 - bd + y, start - x  # угол при x = len1

    rot = _ROT[left]
    for p in ctx.parts[first:]:
        o = p.placement.origin
        nx, ny = move(o.x, o.y, p.module.startswith("wall2"))
        p.placement.origin.x, p.placement.origin.y = nx, ny
        p.placement.u, p.placement.v, p.placement.n = rot[p.placement.u], rot[p.placement.v], rot[p.placement.n]
    for n in ctx.nodes[first_node:]:
        nx, ny = move(n.origin[0], n.origin[1], n.module.startswith("wall2"))
        n.origin = (nx, ny, n.origin[2])
        n.axis = rot[n.axis]


def _rect(x: int, y: int, w: int, h: int) -> Contour:
    """Прямоугольный вырез (против часовой стрелки)."""
    return Contour(start_x=x, start_y=y, segments=[LineSeg(x=x + w, y=y), LineSeg(x=x + w, y=y + h),
                                                   LineSeg(x=x, y=y + h), LineSeg(x=x, y=y)])


def _corner_square(ctx: BuildContext, k: Kitchen, cab, slot: Slot, *, path: str, x: int, w: int, legs: int, bh: int,
                   tf: int, corner_at: str) -> None:
    """Г-образный угловой модуль w×w: здесь — основная часть вдоль ряда 1 (корпус уже собран),
    дверь до плоскости фасада крыла и наполнение; крыло строится во втором ряду (_corner_leg)."""
    r = ctx.rules
    bd_total = mm(k.base_depth)
    if w not in r.corner_square_sizes:
        sizes = " или ".join(f"{to_mm(v):g}×{to_mm(v):g}" for v in r.corner_square_sizes)
        raise BuildError("corner_square_size", f"Г-образный угловой модуль — {sizes} мм, а не {cab.width:g}", path)
    opening = w - bd_total
    if opening < r.corner_min_opening:
        raise BuildError("corner_opening_narrow",
                         f"У углового модуля {cab.width:g}×{cab.width:g} при глубине {k.base_depth:g} мм проём "
                         f"{to_mm(opening)} мм — меньше {to_mm(r.corner_min_opening)} мм, дверь не открыть", path)
    if cab.corner_fill == "carousel":
        dia = r.carousel_diameter.get(w, w - mm(140))
        if bd_total < r.carousel_min_depth:
            raise BuildError("carousel_shallow", f"Карусели нужна глубина корпуса от {to_mm(r.carousel_min_depth)} мм",
                             path)
        if dia > w - 2 * ctx.t - mm(30):
            raise BuildError("carousel_too_big", f"Карусель Ø{to_mm(dia):g} мм не входит в модуль {cab.width:g} мм",
                             path)
        ctx.add_hardware("corner_carousel", f"Карусель 3/4 Ø{to_mm(dia):g} мм (2 уровня)", 1, path)
    elif cab.corner_fill == "swing":
        ctx.add_hardware("corner_swing", "Поворотная полка для углового модуля (2 уровня)", 1, path)
    elif cab.shelf:
        ctx.run("shelf", slot, slot.box, ShelvesFill(count=1), f"{path}.fill[0]")
    # Дверь основной части — до плоскости фасада крыла (крыло стоит перпендикулярно)
    if corner_at == "right":
        xs, hinge = [x, x + w - bd_total - tf], "left"
    else:
        xs, hinge = [x + bd_total + tf, x + w], "right"
    _doors(ctx, slot, xs, legs, legs + bh, 1, hinge, f"{path}.doors", tall=False)
    ctx.add_hardware("corner_bracket", "Стяжка частей углового модуля", 4, path)


def _corner_leg(ctx: BuildContext, k: Kitchen, *, path: str, x: int, w: int, legs: int, bh: int, d: int,
                open_at: str) -> None:
    """Крыло Г-образного углового модуля во втором ряду: без боковины со стороны угла (там основная часть),
    дно, царги, задняя стенка, боковина и дверь с дальней стороны."""
    r, t = ctx.rules, ctx.t
    mat = ctx.product.body.material
    front, visible = r.edge_front, r.edge_visible
    z = legs
    sx = x + w - t if open_at == "left" else x
    side = ctx.add_part(key=f"{path}.side", name="Боковина крыла", role="side", module=path, material_id=mat,
                        length=bh, width=d, placement=Placement(origin=at(sx, 0, z), **VERTICAL),
                        edges={"y0": front})
    bx = x if open_at == "left" else x + t
    bottom = ctx.add_part(key=f"{path}.bottom", name="Дно крыла", role="bottom", module=path, material_id=mat,
                          length=w - t, width=d, placement=Placement(origin=at(bx, 0, z), **HORIZONTAL),
                          edges={"y0": front})
    ctx.join(side, bottom, path)
    top = None
    rails = (("front", 0, "Царга крыла передняя"), ("back", d - r.kitchen_rail_width, "Царга крыла задняя"))
    for key, y, name in rails:
        rail = ctx.add_part(key=f"{path}.rail.{key}", name=name, role="rail", module=path, material_id=mat,
                            length=w - t, width=r.kitchen_rail_width,
                            placement=Placement(origin=at(bx, y, z + bh - t), **HORIZONTAL),
                            edges={"y0": visible} if key == "front" else {})
        ctx.join(side, rail, path)
        top = top or rail
    bm = ctx.product.body.back
    if bm.kind == "nailed":
        inset = r.back_inset
        bl, bw = w - inset, bh - 2 * inset
        ctx.add_part(key=f"{path}.back", name="Задняя стенка крыла", role="back", module=path,
                     material_id=bm.material, length=bl, width=bw,
                     placement=Placement(origin=at(x if open_at == "left" else x + inset, d, z + inset), **FRONTAL),
                     grain="none")
        ctx.add_hardware("nail", "Гвоздь для ХДФ 1,6×25", -(-2 * (bl + bw) // mm(150)), path)
    box = Box(x0=bx, x1=bx + w - t, y0=0, y1=d, z0=z + t, z1=z + bh - t)
    slot = Slot(index=0, path=path, box=box, left=side, right=side, bottom=bottom, top=top)
    hinge = "right" if open_at == "left" else "left"
    _doors(ctx, slot, [x, x + w], legs, legs + bh, 1, hinge, f"{path}.doors", tall=False)
    ctx.add_hardware("leg", "Ножка кухонная регулируемая", 2, path)
