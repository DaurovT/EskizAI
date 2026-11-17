"""Наполнение секции: зоны по высоте, полки, штанга, ящики.

Зоны идут снизу вверх; между соседними зонами ставится неподвижная полка
(на конфирматах). Высота зоны — в свету; незаданные делятся поровну.
"""

from ..assembler import BuildContext, BuildError, Box, Slot, Zone, at
from ..catalog import material
from ..drilling import drill_free
from ..geometry import Placement
from ..parts import Hole
from ..schema import DrawersFill, RodFill, Section, ShelvesFill
from ..units import mm, to_mm
from . import module
from .body import FRONTAL, HORIZONTAL

DRAWER_SIDE = dict(u="+Y", v="+Z", n="+X")  # боковина ящика: длина — в глубину


@module("zones", "0.1.0", "Зоны секции")
def build_zones(ctx: BuildContext, slot: Slot, section: Section) -> list[Zone]:
    t = ctx.t
    box = slot.box
    fills = section.fill
    if not fills:
        return [Zone(z0=box.z0, z1=box.z1, kind="empty", path=slot.path)]

    n = len(fills)
    available = box.height - (n - 1) * t
    given = [mm(f.height) if f.height is not None else None for f in fills]
    free = [i for i, h in enumerate(given) if h is None]
    taken = sum(h for h in given if h is not None)
    if free:
        rest = available - taken
        if rest <= mm(100) * len(free):
            raise BuildError(
                "zones_too_high",
                f"Заданные зоны ({to_mm(taken)} мм) почти не оставляют места остальным: "
                f"в свету {to_mm(available)} мм",
                slot.path,
            )
        each, remainder = divmod(rest, len(free))
        for i in free:
            given[i] = each
        given[free[-1]] += remainder
    elif taken != available and abs(available - taken) <= ctx.rules.max_auto_fit \
            and given[-1] + (available - taken) >= mm(100):
        # Небольшая невязка (часто ИИ забывает толщину полок между зонами) — забирает последняя зона
        diff = available - taken
        given[-1] += diff
        ctx.warn("zones_auto_fit", f"Сумма высот зон не сходилась на {to_mm(abs(diff)):g} мм — "
                                   f"верхняя зона стала {to_mm(given[-1]):g} мм", slot.path)
    elif taken != available:
        raise BuildError(
            "zones_mismatch",
            f"Сумма высот зон {to_mm(taken)} мм не совпадает с высотой секции в свету {to_mm(available)} мм "
            f"(между зонами — полки по {to_mm(t)} мм)",
            slot.path,
        )

    zones: list[Zone] = []
    z = box.z0
    for j, (fill, h) in enumerate(zip(fills, given)):
        path = f"{slot.path}.fill[{j}]"
        zone_box = Box(x0=box.x0, x1=box.x1, y0=box.y0, y1=box.y1, z0=z, z1=z + h)
        zone = Zone(z0=z, z1=z + h, kind=fill.kind, path=path, doors=getattr(fill, "doors", None))
        if isinstance(fill, ShelvesFill):
            ctx.run("shelf", slot, zone_box, fill, path)
        elif isinstance(fill, RodFill):
            ctx.run("rod", zone_box, path)
        elif isinstance(fill, DrawersFill):
            ctx.run("drawer", slot, zone_box, fill, path, section.doors)
            if fill.external:
                zone.external_drawers = fill.count
        zones.append(zone)
        z += h
        if j < n - 1:
            _zone_divider(ctx, slot, z, f"{slot.path}.divider[{j}]")
            z += t
    return zones


def _zone_divider(ctx: BuildContext, slot: Slot, z: int, path: str) -> None:
    box = slot.box
    r = ctx.rules
    shelf = ctx.add_part(
        key=path,
        name="Полка",
        role="shelf",
        module=path,
        material_id=ctx.product.body.material,
        length=box.width,
        width=box.depth - r.shelf_front_setback,
        placement=Placement(origin=at(box.x0, box.y0 + r.shelf_front_setback, z), **HORIZONTAL),
        edges={"y0": r.edge_front},
    )
    ctx.join(slot.left, shelf, path)
    ctx.join(slot.right, shelf, path)


@module("shelf", "0.3.0", "Полка")
def build_shelves(ctx: BuildContext, slot: Slot, box: Box, fill: ShelvesFill, path: str) -> None:
    r, t = ctx.rules, ctx.t
    n = fill.count
    gap = (box.height - n * t) / (n + 1)  # равные просветы между полками
    if gap < mm(150):
        ctx.warn("shelves_too_dense", f"Между полками получается {to_mm(round(gap))} мм — меньше 150 мм", path)

    pins = fill.mount == "pins"
    side_gap = r.shelf_pin_side_gap if pins else 0
    length = box.width - 2 * side_gap
    y0 = box.y0 + r.shelf_front_setback
    depth = box.depth - r.shelf_front_setback
    zs = [box.z0 + round(k * gap + (k - 1) * t) for k in range(1, n + 1)]
    row: list[int] = []
    if pins and r.shelf_pin_rows == "system32":
        # Ряд через 32 мм на всю зону; полки встают на ближайшее отверстие ряда
        step, first = r.system32_step, box.z0 + r.shelf_pin_row_margin
        row = [first + j * step for j in range(max(0, (box.z1 - r.shelf_pin_row_margin - first) // step) + 1)]
        snapped: list[int] = []
        for z in zs:
            options = [h for h in row if (not snapped or h > snapped[-1] - r.shelf_pin_hole_below + t)
                       and h + r.shelf_pin_hole_below + t <= box.z1]
            if options:
                hz = min(options, key=lambda h: abs(h + r.shelf_pin_hole_below - z))
                z = hz + r.shelf_pin_hole_below
            snapped.append(z)
        zs = snapped

    for k, z in enumerate(zs, start=1):
        shelf = ctx.add_part(
            key=f"{path}.shelf[{k}]",
            name="Полка",
            role="shelf",
            module=path,
            material_id=ctx.product.body.material,
            length=length,
            width=depth,
            placement=Placement(origin=at(box.x0 + side_gap, y0, z), **HORIZONTAL),
            edges={"y0": r.edge_front},
        )
        if pins and not row:
            _pin_holes(ctx, slot, box, y0, z - r.shelf_pin_hole_below)
        elif not pins:
            ctx.join(slot.left, shelf, path)
            ctx.join(slot.right, shelf, path)
    for hz in row:
        _pin_holes(ctx, slot, box, y0, hz)

    if pins:
        ctx.add_hardware("shelf_pin", "Полкодержатель", n * r.shelf_pins_per_shelf, path)


def _pin_holes(ctx: BuildContext, slot: Slot, box: Box, y0: int, hz: int) -> None:
    """Отверстия полкодержателей в обеих боковинах секции: линии system32_front от передней кромки полки
    и от задней стенки. Встречное отверстие с другой стороны перегородки — линия сдвигается вглубь на 32 мм."""
    r = ctx.rules
    step = r.system32_step
    lines = ((y0 + r.system32_front, step), (box.y1 - r.system32_front, -step))
    for y, inward in lines:
        for panel, x in ((slot.left, box.x0), (slot.right, box.x1)):
            drill_free(ctx, panel, at(x, y, hz), r.shelf_pin_diameter, r.shelf_pin_depth, "полкодержатель",
                       shifts=[("Y", inward), ("Y", 2 * inward)])


@module("rod", "0.1.0", "Штанга")
def build_rod(ctx: BuildContext, box: Box, path: str) -> None:
    r = ctx.rules
    rod_w = mm(30)  # овальная штанга 30×15
    length = box.width - mm(4)
    z = box.z1 - r.rod_below_top
    ctx.add_part(
        key=f"{path}.rod",
        name="Штанга",
        role="rod",
        module=path,
        material_id="rod_oval_chrome",
        length=length,
        width=rod_w,
        placement=Placement(origin=at(box.x0 + mm(2), (box.y0 + box.y1) // 2 - rod_w // 2, z), **HORIZONTAL),
        grain="none",
    )
    ctx.add_hardware("rod", f"Штанга овальная {round(to_mm(length))} мм", 1, path, length=length)
    ctx.add_hardware("rod_holder", "Штангодержатель", 2, path)
    if box.height < mm(800):
        ctx.warn("rod_zone_low", f"Зона для штанги {to_mm(box.height)} мм — одежда не поместится", path)


@module("drawer", "0.4.0", "Ящик")
def build_drawers(ctx: BuildContext, slot: Slot, box: Box, fill: DrawersFill, path: str, doors=None,
                  ratios: list[float] | None = None) -> None:
    """ratios — доли высоты места под ящики снизу вверх (кухня 1+2); None — поровну."""
    r, t = ctx.rules, ctx.t
    # Внутренний ящик за распашной дверью задевает петли — направляющие ставим на проставку
    spacer_sides: set[str] = set()
    if doors and not fill.external:
        spacer_sides = {"left", "right"} if doors.count == 2 else {doors.hinge}
    st = r.spacer_thickness
    body_mat = ctx.product.body.material
    hdf = "hdf_3_white"
    hdf_t = material(hdf).thickness

    y0 = box.y0 if fill.external else box.y0 + r.internal_drawer_setback
    slide = r.slide_length_for(box.y1 - y0 - mm(10))
    if slide is None:
        raise BuildError("drawer_too_shallow", "Секция слишком мелкая для ящика (меньше 250 мм)", path)
    inner_x0 = box.x0 + (st if "left" in spacer_sides else 0)
    inner_x1 = box.x1 - (st if "right" in spacer_sides else 0)
    hw = ctx.product.hardware
    gap = r.slide_side_gap if hw.slides == "ball" else r.hidden_slide_side_gap
    width = inner_x1 - inner_x0 - 2 * gap
    x0 = inner_x0 + gap
    places = [box.height * f for f in ratios] if ratios else [box.height / fill.count] * fill.count
    if min(places) - r.drawer_box_clearance < r.drawer_box_min_height:
        ctx.warn("drawers_too_dense", f"На ящик приходится {to_mm(round(min(places)))} мм — мало", path)

    for i in range(fill.count):
        node = f"{path}.drawer[{i + 1}]"
        place_h = places[i]
        box_h = int(min(max(place_h - r.drawer_box_clearance, r.drawer_box_min_height), r.drawer_box_max_height))
        bz = round(box.z0 + (sum(places[:i]) if ratios else i * place_h)) + mm(5)
        sz = bz + hdf_t  # стенки стоят на дне
        common = dict(module=path, material_id=body_mat, node=node)
        for side, sx in (("left", x0), ("right", x0 + width - t)):
            ctx.add_part(
                key=f"{node}.side.{side}", name="Боковина ящика", role="drawer_side",
                length=slide, width=box_h, placement=Placement(origin=at(sx, y0, sz), **DRAWER_SIDE),
                edges={"y1": r.edge_visible}, **common,
            )
        for wall, wy in (("front", y0), ("back", y0 + slide - t)):
            ctx.add_part(
                key=f"{node}.wall.{wall}", name="Стенка ящика", role="drawer_wall",
                length=width - 2 * t, width=box_h, placement=Placement(origin=at(x0 + t, wy, sz), **FRONTAL),
                edges={"y1": r.edge_visible}, **common,
            )
        ctx.add_part(
            key=f"{node}.bottom", name="Дно ящика", role="drawer_bottom", module=path, material_id=hdf,
            length=width, width=slide, placement=Placement(origin=at(x0, y0, bz), **HORIZONTAL),
            grain="none", node=node,
        )
        # Стенки к боковинам ящика — конфирматы общим проходом присадки (drilling.auto_joints)
        slide_name = {"ball": "шариковые", "hidden_full": "скрытые полного выдвижения",
                      "hidden_soft": "скрытые с доводчиком"}[hw.slides]
        cls = {"econom": "эконом", "standard": "стандарт", "premium": "премиум"}[hw.slides_class]
        ctx.add_hardware("slide", f"Направляющие {slide_name} {round(to_mm(slide))} мм (пара, {cls})", 1, path,
                         length=slide, type=hw.slides, hclass=hw.slides_class)
        # Направляющие крепятся к боковинам секции (или к проставкам): шариковые — по середине высоты ящика,
        # скрытые — у низа ящика (rules.hidden_slide_hole_z); отверстия — по таблице rules.slide_holes
        ball = hw.slides == "ball"
        hz = sz + box_h // 2 if ball else bz + r.hidden_slide_hole_z
        holes_y = r.slide_hole_positions(hw.slides, slide)
        mounts = {"left": (slot.left, box.x0), "right": (slot.right, box.x1)}
        for side in ("left", "right"):
            panel, face_x = mounts[side]
            if side in spacer_sides:
                sx = box.x0 if side == "left" else box.x1 - st
                panel = ctx.add_part(
                    key=f"{node}.spacer.{side}", name="Проставка", role="spacer", module=path,
                    material_id=body_mat, length=slide, width=r.spacer_height,
                    placement=Placement(origin=at(sx, y0, max(hz - r.spacer_height // 2, box.z0)), **DRAWER_SIDE),
                )
                face_x = inner_x0 if side == "left" else inner_x1
                ctx.add_hardware("screw", "Саморез 4×30 (проставка)", 3, path)
            step = r.system32_step
            for y in holes_y:
                drill_free(ctx, panel, at(face_x, y0 + y, hz), r.slide_hole_diameter, r.slide_hole_depth,
                           "направляющая", shifts=[("Y", step), ("Y", -step)])
        # Ответная часть на ящике: шариковые — на боковинах ящика снаружи, скрытые — крючки в задней стенке
        if ball:
            for side, sx in (("left", x0), ("right", x0 + width)):
                dside = ctx.part(f"{node}.side.{side}")
                for y in holes_y:
                    drill_free(ctx, dside, at(sx, y0 + y, hz), r.slide_drawer_hole_diameter,
                               r.slide_drawer_hole_depth, "направляющая ящика", shifts=[("Y", step), ("Y", -step)])
        else:
            back = ctx.part(f"{node}.wall.back")
            d, depth_h = r.hidden_slide_rear_hole
            for lx in (r.hidden_slide_rear_from_side, back.length - r.hidden_slide_rear_from_side):
                back.holes.append(Hole(x=lx, y=r.hidden_slide_rear_from_bottom, diameter=d, depth=depth_h, face="A",
                                       purpose="крючок направляющей"))

        from ..parts import MovingNode

        ctx.nodes.append(
            MovingNode(id=node, kind="slide", module=path, origin=(x0, y0, bz), axis="-Y", range=slide)
        )
