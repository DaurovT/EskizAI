"""Фасады: распашные двери, фасады ящиков, ручки, петли.

Фасады накладные. Сетка фасадов: по горизонтали — наружные края корпуса
и середины перегородок; по вертикали — низ дна (или полки антресоли)
и верх корпуса, плюс середины полок между зонами. От линий сетки фасад
отступает на половину зазора.
"""

from ..assembler import BuildContext, BuildError, Slot, at
from ..catalog import material
from ..fixes import split_section_fix
from ..geometry import Placement
from ..parts import Fix, Issue, MovingNode, Part, PatchOp
from ..units import mm, to_mm
from . import module

HARDWARE_CLASS_NAMES = {"econom": "эконом", "standard": "стандарт", "premium": "премиум"}
FINISH_NAMES = {"steel": "сталь", "black": "чёрный", "chrome": "хром", "brass": "латунь", "gold": "золото"}


def handle_name(h) -> str:
    """Название ручки для сметы и спецификации."""
    fin = FINISH_NAMES.get(h.finish, h.finish)
    if h.kind == "knob":
        return f"Ручка-кнопка ({fin})"
    suffix = "" if h.finish == "steel" else f" ({fin})"
    return f"Ручка-скоба {h.spacing} мм{suffix}"

DOOR = dict(u="+Z", v="+X", n="+Y")  # дверь: длина — по высоте (текстура вертикально)
DRAWER_FRONT = dict(u="+X", v="+Z", n="+Y")  # фасад ящика: длина — по ширине


@module("fronts", "0.5.0", "Фасады")
def build_fronts(ctx: BuildContext) -> None:
    p = ctx.product
    _check_push_handles(ctx)
    t = ctx.t
    from .body import body_height

    W, H = mm(p.width), body_height(ctx)
    top_line = H if p.body.top == "between" else H - t
    xs = _vertical_lines(ctx, W)
    if p.sliding_doors:
        ctx.run("sliding_doors")
        return

    bottom_line = ctx.part("body.bottom").aabb().min.z
    lower_top = top_line
    if p.mezzanine:
        div = ctx.part("mezzanine.shelf").aabb()
        lower_top = (div.min.z + div.max.z) // 2
        if p.mezzanine.doors:
            for slot in ctx.mezzanine_slots:
                width = xs[slot.index + 1] - xs[slot.index]
                count = 1 if width - ctx.rules.front_gap <= ctx.rules.door_max_width else 2
                _doors(ctx, slot, xs, lower_top, top_line, count, "left" if slot.index % 2 == 0 else "right",
                       f"{slot.path}.doors", tall=False)

    for slot, section in zip(ctx.slots, p.sections):
        # Вертикальные отрезки: подряд идущие обычные зоны — под дверь, ящики с фасадами — отдельно
        lines = [bottom_line]
        for a, b in zip(slot.zones, slot.zones[1:]):
            lines.append((a.z1 + b.z0) // 2)
        lines.append(lower_top)

        run_start = None
        for j, zone in enumerate(slot.zones):
            z_lo, z_hi = lines[j], lines[j + 1]
            if zone.doors is not None:
                # Свои двери у зоны (тумба под открытыми полками): закрываем текущий отрезок, ставим двери на зону
                if run_start is not None and section.doors:
                    _doors(ctx, slot, xs, run_start, z_lo, section.doors.count, section.doors.hinge,
                           f"{slot.path}.doors", tall=True)
                run_start = None
                j_path = zone.path
                _doors(ctx, slot, xs, z_lo, z_hi, zone.doors.count, zone.doors.hinge, f"{j_path}.doors",
                       tall=False, doors_ptr="/" + j_path.replace("[", "/").replace("].", "/").replace("]", "")
                       .replace(".", "/") + "/doors")
            elif zone.external_drawers:
                if run_start is not None and section.doors:
                    _doors(ctx, slot, xs, run_start, z_lo, section.doors.count, section.doors.hinge,
                           f"{slot.path}.doors", tall=True)
                run_start = None
                _drawer_fronts(ctx, slot, xs, z_lo, z_hi, zone)
            elif run_start is None:
                run_start = z_lo
        if run_start is not None and section.doors:
            _doors(ctx, slot, xs, run_start, lines[-1], section.doors.count, section.doors.hinge,
                   f"{slot.path}.doors", tall=True)


def _check_push_handles(ctx: BuildContext) -> None:
    p = ctx.product
    if p.hardware.hinge == "push" and p.fronts.handles.kind in ("bar", "knob"):
        ctx.issues.append(Issue(
            level="warning", code="push_with_handles",
            message="Петли push-to-open открываются нажатием — ручки-скобы им не нужны",
            path="hardware",
            fixes=[Fix(description="Убрать ручки",
                       patch=[PatchOp(op="replace", path="/fronts/handles/kind", value="none")])],
        ))


def _vertical_lines(ctx: BuildContext, W: int) -> list[int]:
    xs = [0]
    for a, b in zip(ctx.slots, ctx.slots[1:]):
        xs.append((a.box.x1 + b.box.x0) // 2)
    xs.append(W)
    return xs


def _front_part(ctx: BuildContext, key: str, name: str, role: str, x0: int, x1: int, z0: int, z1: int,
                node: str, door: bool) -> Part:
    tf = _front_thickness(ctx)
    if door:
        length, width, placement = z1 - z0, x1 - x0, Placement(origin=at(x0, ctx.front_y - tf, z0), **DOOR)
    else:
        length, width, placement = x1 - x0, z1 - z0, Placement(origin=at(x0, ctx.front_y - tf, z0), **DRAWER_FRONT)
    e = ctx.rules.edge_front
    return ctx.add_part(
        key=key, name=name, role=role, module=key, material_id=ctx.fronts_material,
        length=length, width=width, placement=placement,
        edges={"x0": e, "x1": e, "y0": e, "y1": e}, node=node,
    )


def _front_thickness(ctx: BuildContext) -> int:
    from ..catalog import material

    return material(ctx.fronts_material).thickness


def _doors(ctx: BuildContext, slot: Slot, xs: list[int], z_lo: int, z_hi: int, count: int, hinge: str,
           path: str, tall: bool, doors_ptr: str | None = None) -> None:
    """doors_ptr — JSON Pointer дверей в дереве (для готовых исправлений); по умолчанию — двери секции."""
    doors_ptr = doors_ptr or f"/sections/{slot.index}/doors"
    r = ctx.rules
    g = r.front_gap
    x0, x1 = xs[slot.index] + g // 2, xs[slot.index + 1] - g // 2
    z0, z1 = z_lo + g // 2, z_hi - g // 2
    if count == 1:
        leaves = [(x0, x1, hinge)]
    else:
        mid = (x0 + x1) // 2
        leaves = [(x0, mid - g // 2, "left"), (mid + g // 2, x1, "right")]

    # Если в секции несколько групп дверей по высоте — нумеруем группы снизу вверх
    group = sum(1 for n in ctx.nodes if n.module == path and n.id.endswith(".door[1]")) + 1
    base = path if group == 1 else f"{path}[{group}]"
    main = path.startswith("sections")  # исправления с путями дерева — только для секций шкафа
    for k, (a, b, side) in enumerate(leaves, start=1):
        width = b - a
        if width > r.door_max_width and k == 1:
            fixes = []
            if main and count == 1:
                fixes.append(Fix(description="Две двери вместо одной",
                                 patch=[PatchOp(op="replace", path=f"{doors_ptr}/count", value=2)]))
            elif main:
                fixes.append(split_section_fix(ctx.product, slot.index))
            ctx.issues.append(Issue(
                level="warning", code="door_too_wide",
                message=f"Дверь шириной {to_mm(width)} мм — больше {to_mm(r.door_max_width)} мм, провиснет",
                path=path, fixes=fixes,
            ))
        _check_niche_swing(ctx, slot, side, count, path, main, doors_ptr)
        node = f"{base}.door[{k}]"
        door = _front_part(ctx, node, "Дверь", "door", a, b, z0, z1, node, door=True)
        _hinges(ctx, slot, door, side, a, b, z0, z1, path)
        _handle_door(ctx, door, side, z0, z1, path, tall)
        hinge_x = a if side == "left" else b
        ctx.nodes.append(
            MovingNode(
                id=node, kind="rotate", module=path, origin=(hinge_x, ctx.front_y, z0),
                # Поворот на +range° по правилу правой руки: дверь открывается к нам (−Y)
                axis="-Z" if side == "left" else "+Z", range=r.hinge_angle,
            )
        )


def _check_niche_swing(ctx: BuildContext, slot: Slot, side: str, count: int, path: str, main: bool,
                       doors_ptr: str = "") -> None:
    """В нише дверь на петлях у наружной боковины при открывании > 90° бьёт в стену ниши."""
    r = ctx.rules
    builtin = getattr(ctx.product, "builtin", None) is not None  # у встроенного стены — по замеру (ctx.walls)
    if (ctx.product.installation != "niche" and not builtin) or r.hinge_angle <= 90:
        return
    panel = slot.left if side == "left" else slot.right
    box = panel.aabb()
    at_wall = box.min.x == ctx.walls[0] if side == "left" else box.max.x == ctx.walls[1]
    if panel.role != "side" or not at_wall:
        return
    fixes = []
    other = slot.right if side == "left" else slot.left
    if main and count == 1 and other.role == "partition":
        new_side = "right" if side == "left" else "left"
        fixes.append(Fix(description="Петли с другой стороны — на перегородке",
                         patch=[PatchOp(op="replace", path=f"{doors_ptr or f'/sections/{slot.index}/doors'}/hinge", value=new_side)]))
    ctx.issues.append(Issue(
        level="warning", code="door_hits_niche_wall",
        message="Дверь у стены ниши при открывании на "
                f"{r.hinge_angle}° заденет стену; нужна фальш-планка 30–50 мм или петли с другой стороны",
        path=path, fixes=fixes,
    ))


def _hinges(ctx: BuildContext, slot: Slot, door: Part, side: str, a: int, b: int, z0: int, z1: int,
            path: str) -> None:
    r = ctx.rules
    height = z1 - z0
    count = r.hinges_for_height(height)
    off = r.hinge_end_offset
    step = (height - 2 * off) / (count - 1)
    panel = slot.left if side == "left" else slot.right
    overlay = "накладная" if panel.role == "side" else "полунакладная"
    face_x = panel.aabb().max.x if side == "left" else panel.aabb().min.x
    cup_y_local = r.hinge_cup_from_edge if side == "left" else (b - a) - r.hinge_cup_from_edge
    for k in range(count):
        local_z = round(off + k * step)  # вдоль двери снизу
        door.holes.append(_cup(local_z, cup_y_local, r))
        for y in (ctx.front_y + r.system32_front, ctx.front_y + r.system32_front + mm(32)):
            ctx.drill(panel, at(face_x, y, z0 + local_z), mm(5), mm(12), "планка петли")
    hw = ctx.product.hardware
    kind_name = {"standard": "", "soft_close": " с доводчиком", "push": " push-to-open"}[hw.hinge]
    cls = HARDWARE_CLASS_NAMES[hw.hinge_class]
    ctx.add_hardware("hinge", f"Петля {overlay} {r.hinge_angle}°{kind_name} ({cls})", count, path,
                     type=hw.hinge, hclass=hw.hinge_class)


def _cup(local_z: int, local_y: int, r):
    from ..parts import Hole

    return Hole(x=local_z, y=local_y, diameter=r.hinge_cup_diameter, depth=r.hinge_cup_depth, face="A",
                purpose="чашка петли")


def _handle_door(ctx: BuildContext, door: Part, side: str, z0: int, z1: int, path: str, tall: bool) -> None:
    h = ctx.product.fronts.handles
    if h.kind in ("none", "gola"):  # Gola — профиль в корпусе (decor.py), отверстий в фасаде нет
        return
    r = ctx.rules
    s = mm(h.spacing)
    y = door.width - r.handle_edge_offset if side == "left" else r.handle_edge_offset
    from ..parts import Hole

    if h.kind == "knob":  # кнопка — одно отверстие там, где был бы центр скобы
        center = _door_handle_center(r, 0, z0, z1)
        door.holes.append(Hole(x=center, y=y, diameter=mm(5), depth=0, face="B", purpose="ручка"))
        ctx.add_hardware("knob", handle_name(h), 1, path, finish=h.finish)
        return
    center = _door_handle_center(r, s, z0, z1)
    for dz in (-s // 2, s // 2):
        door.holes.append(Hole(x=center + dz, y=y, diameter=mm(5), depth=0, face="B", purpose="ручка"))
    ctx.add_hardware("handle", handle_name(h), 1, path, finish=h.finish)


def _door_handle_center(r, s: int, z0: int, z1: int) -> int:
    """Центр вертикальной скобы от низа двери. Как ставит мебельщик: низкий фасад (нижние модули кухни,
    тумба) — у верхнего края; высоко висящий (верхние модули, антресоль) — у нижнего; высокая дверь —
    на высоте руки (~1 м от пола)."""
    height = z1 - z0
    edge = r.handle_edge_offset + s // 2
    if z1 <= r.handle_height + mm(200):
        center = height - edge
    elif z0 >= r.handle_height + mm(300):
        center = edge
    else:
        center = r.handle_height - z0
    lo, hi = s // 2 + mm(30), height - s // 2 - mm(30)
    return height // 2 if lo > hi else max(lo, min(center, hi))


def _drawer_fronts(ctx: BuildContext, slot: Slot, xs: list[int], z_lo: int, z_hi: int, zone) -> None:
    r = ctx.rules
    g = r.front_gap
    n = zone.external_drawers
    x0, x1 = xs[slot.index] + g // 2, xs[slot.index + 1] - g // 2
    h = (z_hi - z_lo - n * g) / n
    hk = ctx.product.fronts.handles
    from ..parts import Hole

    for i in range(n):
        z0 = round(z_lo + g / 2 + i * (h + g))
        z1 = round(z0 + h)
        node = f"{zone.path}.drawer[{i + 1}]"
        front = _front_part(ctx, f"{node}.front", "Фасад ящика", "drawer_front", x0, x1, z0, z1, node, door=False)
        # Горизонтально по центру, ближе к верхнему краю (на низком фасаде — посередине)
        cx, cz = (x1 - x0) // 2, max((z1 - z0) // 2, (z1 - z0) - r.drawer_handle_from_top)
        if hk.kind == "bar":
            s = mm(hk.spacing)
            for dx in (-s // 2, s // 2):
                front.holes.append(Hole(x=cx + dx, y=cz, diameter=mm(5), depth=0, face="B", purpose="ручка"))
            ctx.add_hardware("handle", handle_name(hk), 1, zone.path, finish=hk.finish)
        elif hk.kind == "knob":
            front.holes.append(Hole(x=cx, y=cz, diameter=mm(5), depth=0, face="B", purpose="ручка"))
            ctx.add_hardware("knob", handle_name(hk), 1, zone.path, finish=hk.finish)
        ctx.add_hardware("screw", "Саморез 4×16 (крепление фасада)", 4, zone.path)


SLIDING_DOOR = dict(u="+Z", v="+X", n="+Y")


@module("sliding_doors", "0.1.0", "Двери-купе")
def build_sliding_doors(ctx: BuildContext) -> None:
    """Двери-купе на весь проём между боковинами, от дна до крыши.

    Ширина двери = (проём + (n − 1) × перекрытие) / n; соседние двери на разных рельсах.
    В модели деталей дверь — заполнение (ЛДСП или зеркало); профиль и рельсы — в фурнитуре.
    """
    p, r = ctx.product, ctx.rules
    sd = p.sliding_doors
    n = sd.count
    left, right = ctx.part("body.side.left").aabb(), ctx.part("body.side.right").aabb()
    bottom, top = ctx.part("body.bottom").aabb(), ctx.part("body.top").aabb()
    x_open0, x_open1 = left.max.x, right.min.x
    z_open0, z_open1 = bottom.max.z, top.min.z
    opening_w, opening_h = x_open1 - x_open0, z_open1 - z_open0

    door_w = (opening_w + (n - 1) * r.sliding_overlap) // n
    door_h = opening_h - r.sliding_height_deduction
    if not r.sliding_door_min_width <= door_w <= r.sliding_door_max_width:
        better = max(2, min(6, round(opening_w / mm(800))))
        fixes = [] if better == n else [Fix(
            description=f"{better} двери вместо {n}",
            patch=[PatchOp(op="replace", path="/sliding_doors/count", value=better)],
        )]
        ctx.issues.append(Issue(
            level="warning", code="sliding_door_width",
            message=f"Дверь-купе шириной {to_mm(door_w)} мм — вне диапазона "
                    f"{to_mm(r.sliding_door_min_width)}–{to_mm(r.sliding_door_max_width)} мм",
            path="sliding_doors", fixes=fixes,
        ))
    if len(sd.fills) not in (0, n):
        raise BuildError("sliding_fills_count", f"Заполнений {len(sd.fills)}, а дверей {n}", "sliding_doors")
    fills = sd.fills or ["panel"] * n

    fill_w = door_w - r.sliding_fill_width_deduction
    fill_h = door_h - r.sliding_fill_height_deduction
    z0 = z_open0 + r.sliding_height_deduction // 2
    for i in range(n):
        x0 = x_open0 + i * (door_w - r.sliding_overlap)
        rail_y = r.sliding_rail_front_y if i % 2 == 0 else r.sliding_rail_back_y
        node = f"sliding_doors.door[{i + 1}]"
        is_mirror = fills[i] == "mirror"
        mat = "mirror_4_silver" if is_mirror else sd.panel_material
        # Заполнение по центру двери
        fx0 = x0 + (door_w - fill_w) // 2
        fz0 = z0 + (door_h - fill_h) // 2
        ctx.add_part(
            key=node, name="Зеркало двери-купе" if is_mirror else "Заполнение двери-купе", role="sliding_fill",
            module="sliding_doors", material_id=mat, length=fill_h, width=fill_w,
            placement=Placement(origin=at(fx0, rail_y, fz0), **SLIDING_DOOR), node=node,
        )
        if is_mirror:
            ctx.add_hardware("glass", f"Зеркало 4 мм {round(to_mm(fill_w))}×{round(to_mm(fill_h))} мм", 1,
                             "sliding_doors", width=fill_w, height=fill_h)
        last = i == n - 1
        ctx.nodes.append(MovingNode(
            id=node, kind="sliding_door", module="sliding_doors", origin=(x0, rail_y, z0),
            axis="-X" if last else "+X", range=door_w - r.sliding_overlap,
        ))

    ctx.add_hardware("profile", f"Профиль вертикальный {round(to_mm(door_h))} мм", 2 * n, "sliding_doors",
                     length=door_h)
    ctx.add_hardware("profile", f"Профиль горизонтальный {round(to_mm(door_w - 2 * r.sliding_overlap))} мм",
                     2 * n, "sliding_doors", length=door_w - 2 * r.sliding_overlap)
    ctx.add_hardware("rail", f"Рельс верхний {round(to_mm(opening_w))} мм", 1, "sliding_doors", length=opening_w)
    ctx.add_hardware("rail", f"Рельс нижний {round(to_mm(opening_w))} мм", 1, "sliding_doors", length=opening_w)
    ctx.add_hardware("rollers", "Ролики двери-купе (комплект на дверь)", n, "sliding_doors")
