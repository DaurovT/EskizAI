"""Кухня: верхние модули с подъёмными фасадами, ниши под технику, антресольные ярусы и полки на столешнице.

Обычные верхние модули (распашные двери, открытые полки, вытяжка без яруса) строит kitchen.py как раньше —
эти модули подключаются только когда в дереве есть новые поля, поэтому старые проекты собираются так же.

Подъёмный фасад (opening=lift): петли по верхней кромке (планки — на крыше или неподвижной полке над
фасадом), газлифт на каждый фасад (шире 600 мм — два), ручка у нижней кромки; узел «lift» — поворот
вокруг горизонтальной оси у верхней кромки, фасад уходит вверх к нам. Два фасада (flaps=2) — один над
другим, между ними неподвижная полка.

Ниша под технику (kind=appliance): открытая ниша внизу модуля, над ней — неподвижная полка и отделение
с фасадом (above). Технику покупает клиент — в смете только корпус и полки.

Ярус (top): отдельный короб со своими фасадами на крыше модуля; высота яруса входит в высоту модуля
(низ модулей ряда — на одной линии). Без высоты и с известным потолком ярус встаёт над верхом ряда
до потолка (минус зазор под навес).

Полка на столешнице (Kitchen.mid): открытый короб на столешнице под верхними модулями.
"""

from ..assembler import BuildContext, BuildError, Box, Slot, at
from ..geometry import Placement
from ..parts import Fix, Hole, Issue, MovingNode, PatchOp
from ..schema import ShelvesFill
from ..units import mm, to_mm
from . import module
from .body import HORIZONTAL
from .fronts import _cup, _doors, _front_part, handle_name, HARDWARE_CLASS_NAMES
from .kitchen import _carcass, _door_count

LIFT_ANGLE = 100  # подъёмный фасад открывается на ~100°
LIFT_MIN, LIFT_MAX = mm(250), mm(600)  # высота одного подъёмного фасада
LIFT_MAX_WIDTH = mm(1200)
NICHE = {"microwave": (mm(380), mm(360), "микроволновку", "Микроволновка"),
         "oven": (mm(600), mm(585), "духовку", "Духовка")}  # по умолчанию, минимум в свету, кого, название
TIER_DEFAULT = mm(350)


def extended(cab) -> bool:
    """Нужен ли этот модуль: поля, которых нет у обычного верхнего модуля."""
    return cab.kind == "appliance" or cab.opening == "lift" or cab.top is not None


def wall_ceiling(k) -> int | None:
    from .builtin import _ceiling

    c = _ceiling(k)
    return mm(c) if c else None


def tier_height(ctx: BuildContext, cab, row_top: int) -> tuple[int, bool]:
    """Высота яруса и стоит ли он над верхом ряда (до потолка)."""
    if cab.top is None:
        return 0, False
    if cab.top.height:
        return mm(cab.top.height), False
    ceiling = wall_ceiling(ctx.product)
    if ceiling is not None:
        free = ceiling - ctx.rules.wall_ceiling_gap - row_top
        if free >= mm(250):
            return min(free, mm(600)), True
    return TIER_DEFAULT, False


@module("kitchen_wall_ext", "0.1.0", "Верхний модуль кухни: подъёмные фасады, ниша под технику, ярус")
def build_wall_ext(ctx: BuildContext, cab, *, path: str, ptr: str, x: int, w: int, z0: int, z1: int, d: int,
                   y0: int, last: bool) -> tuple[int, int]:
    """Модуль в колонке [z0, z1] (z1 — верх ряда). Возвращает (низ модуля, верх колонки с ярусом)."""
    t = ctx.t
    tier_h, above_row = tier_height(ctx, cab, z1)
    main_top = z1 if above_row else z1 - tier_h
    kind = cab.kind
    if kind == "appliance":
        app = cab.appliance or "microwave"
        niche = mm(cab.niche_height) if cab.niche_height else NICHE[app][0]
        if (cab.above or "door") == "none" and not cab.height:
            z0 = main_top - niche - 2 * t  # модуль высотой с нишу, висит от верха ряда
    if main_top - z0 < mm(200):
        raise BuildError("wall_tier_tall", f"Ярус {to_mm(tier_h):g} мм не оставляет места модулю высотой "
                                           f"{to_mm(z1 - z0):g} мм — уменьшите ярус или поднимите модуль", path)
    slot = _carcass(ctx, path=path, x=x, w=w, z=z0, h=main_top - z0, d=d, kind="wall", back=True, y0=y0)
    if kind == "appliance":
        _appliance(ctx, cab, slot, path=path, ptr=ptr, x=x, w=w, z0=z0, z1=main_top, last=last)
    elif kind == "open":
        if cab.shelves:
            ctx.run("shelf", slot, slot.box, ShelvesFill(count=cab.shelves), f"{path}.fill[0]")
    elif cab.opening == "lift":
        flaps = auto_flaps(cab.flaps, main_top - z0)
        boxes = lift_flaps(ctx, slot, x, x + w, z0, main_top, flaps, path, ptr=ptr, has_flaps=True,
                           fix_field="opening=hinged")
        if kind != "hood":
            _shelves_split(ctx, slot, boxes, cab.shelves - (flaps - 1), path)
    else:  # распашные двери, как в kitchen.py (сюда попадает только модуль с ярусом)
        if cab.shelves and kind != "hood":
            ctx.run("shelf", slot, slot.box, ShelvesFill(count=cab.shelves), f"{path}.fill[0]")
        hinge = cab.hinge if cab.doors or not last else "right"
        _doors(ctx, slot, [x, x + w], z0, main_top, _door_count(ctx, w, cab.doors), hinge, f"{path}.doors",
               tall=False)
    if tier_h:
        _tier(ctx, cab, path=path, ptr=ptr, x=x, w=w, z=main_top, h=tier_h, d=d, y0=y0, last=last)
    return z0, main_top + tier_h


def _shelves_split(ctx: BuildContext, slot: Slot, boxes: list[Box], count: int, path: str) -> None:
    """Полки по отделениям между неподвижными полками (снизу вверх), поровну, остаток — нижним."""
    count = max(0, count)
    n = len(boxes)
    for i, box in enumerate(boxes):
        c = count // n + (1 if i < count % n else 0)
        if c:
            ctx.run("shelf", slot, box, ShelvesFill(count=c), f"{path}.fill[{i}]")


def _fixed_shelf(ctx: BuildContext, slot: Slot, z: int, key: str, name: str, module_path: str):
    """Неподвижная полка во всю глубину корпуса на конфирматах (низ полки — z)."""
    box = slot.box
    shelf = ctx.add_part(
        key=key, name=name, role="shelf", module=module_path, material_id=ctx.product.body.material,
        length=box.width, width=box.depth, placement=Placement(origin=at(box.x0, box.y0, z), **HORIZONTAL),
        edges={"y0": ctx.rules.edge_front},
    )
    for side in (slot.left, slot.right):
        ctx.join(side, shelf, module_path)
    return shelf


def auto_flaps(flaps: int | None, opening_h: int) -> int:
    """Число подъёмных фасадов: заданное, иначе по высоте проёма (выше одного газлифта — два)."""
    if flaps:
        return flaps
    return 2 if opening_h > LIFT_MAX + mm(10) else 1


def lift_flaps(ctx: BuildContext, slot: Slot, x0: int, x1: int, z_lo: int, z_hi: int, flaps: int, path: str, *,
               ptr: str, has_flaps: bool, mount=None, fix_field: str = "") -> list[Box]:
    """Подъёмные фасады на проём [z_lo, z_hi] по сетке фасадов. mount — деталь над верхним фасадом под планки
    петель (по умолчанию крыша корпуса). Возвращает отделения корпуса снизу вверх (между неподвижными полками)."""
    r, t = ctx.rules, ctx.t
    g = r.front_gap
    xa, xb = x0 + g // 2, x1 - g // 2
    za, zb = z_lo + g // 2, z_hi - g // 2
    box = slot.box
    boxes = [box]
    mounts = [mount or slot.top]
    if flaps == 1:
        spans = [(za, zb)]
    else:
        mid = (za + zb) // 2
        spans = [(za, mid - g // 2), (mid + g // 2, zb)]  # снизу вверх
        # Неподвижная полка за стыком фасадов — на неё петли нижнего фасада
        zs = mid - t // 2
        divider = _fixed_shelf(ctx, slot, zs, f"{path}.lift_shelf", "Полка неподвижная (под петли)", path)
        boxes = [Box(x0=box.x0, x1=box.x1, y0=box.y0, y1=box.y1, z0=box.z0, z1=zs),
                 Box(x0=box.x0, x1=box.x1, y0=box.y0, y1=box.y1, z0=zs + t, z1=box.z1)]
        mounts = [divider, mounts[0]]
    width = xb - xa
    _check_flap(ctx, width, [b - a for a, b in spans], flaps, path, ptr, has_flaps, fix_field)
    hw = ctx.product.hardware
    kind_name = {"standard": "", "soft_close": " с доводчиком", "push": " push-to-open"}[hw.hinge]
    cls = HARDWARE_CLASS_NAMES[hw.hinge_class]
    for k, ((fa, fb), panel) in enumerate(zip(reversed(spans), reversed(mounts)), start=1):  # 1 — верхний
        node = f"{path}.flap[{k}]"
        flap = _front_part(ctx, node, "Фасад подъёмный", "door", xa, xb, fa, fb, node, door=True)
        # Петли по верхней кромке: чашки в фасаде, планки — снизу на детали над фасадом
        n = 2 if width <= mm(900) else 3
        ys = [r.hinge_end_offset, width - r.hinge_end_offset] + ([width // 2] if n == 3 else [])
        pz = panel.aabb().min.z
        for ly in ys:
            flap.holes.append(_cup(fb - fa - r.hinge_cup_from_edge, ly, r))
            for dy in (0, mm(32)):
                ctx.drill(panel, at(xa + ly, ctx.front_y + r.system32_front + dy, pz), mm(5), mm(12), "планка петли")
        ctx.add_hardware("hinge", f"Петля накладная {r.hinge_angle}°{kind_name} ({cls})", n, path,
                         type=hw.hinge, hclass=hw.hinge_class)
        ctx.add_hardware("gas_lift", "Подъёмный механизм (газлифт)", 1 if width <= mm(600) else 2, path)
        _flap_handle(ctx, flap, path)
        # Поворот на +range° вокруг −X у верхней кромки: низ фасада уходит к нам (−Y) и вверх
        ctx.nodes.append(MovingNode(id=node, kind="lift", module=path, origin=(xa, ctx.front_y, fb), axis="-X",
                                    range=LIFT_ANGLE))
    return boxes


def _check_flap(ctx: BuildContext, width: int, heights: list[int], flaps: int, path: str, ptr: str,
                has_flaps: bool, fix_field: str) -> None:
    for h in heights:
        if LIFT_MIN <= h <= LIFT_MAX:
            continue
        fixes = []
        if has_flaps and h > LIFT_MAX and flaps == 1:
            fixes.append(Fix(description="Два подъёмных фасада друг над другом",
                             patch=[PatchOp(op="replace", path=f"{ptr}/flaps", value=2)]))
        elif has_flaps and h < LIFT_MIN and flaps == 2:
            fixes.append(Fix(description="Один подъёмный фасад",
                             patch=[PatchOp(op="replace", path=f"{ptr}/flaps", value=1)]))
        if fix_field:
            field, value = fix_field.split("=")
            fixes.append(Fix(description="Распашная дверь вместо подъёмной",
                             patch=[PatchOp(op="replace", path=f"{ptr}/{field}", value=value)]))
        ctx.issues.append(Issue(
            level="error", code="lift_flap_height",
            message=f"Подъёмный фасад высотой {to_mm(h):g} мм — газлифт рассчитан на "
                    f"{to_mm(LIFT_MIN):g}–{to_mm(LIFT_MAX):g} мм", path=path, fixes=fixes))
        break
    if width > LIFT_MAX_WIDTH:
        ctx.issues.append(Issue(level="error", code="lift_flap_width",
                                message=f"Подъёмный фасад шириной {to_mm(width):g} мм — больше "
                                        f"{to_mm(LIFT_MAX_WIDTH):g} мм", path=path))


def _flap_handle(ctx: BuildContext, flap, path: str) -> None:
    """Ручка подъёмного фасада — горизонтально у нижней кромки, по центру."""
    h = ctx.product.fronts.handles
    if h.kind in ("none", "gola"):
        return
    r = ctx.rules
    x, cy = r.handle_edge_offset, flap.width // 2  # локальная x — от нижней кромки, y — поперёк
    if h.kind == "knob":
        flap.holes.append(Hole(x=x, y=cy, diameter=mm(5), depth=0, face="B", purpose="ручка"))
        ctx.add_hardware("knob", handle_name(h), 1, path, finish=h.finish)
        return
    s = mm(h.spacing)
    for dy in (-s // 2, s // 2):
        flap.holes.append(Hole(x=x, y=cy + dy, diameter=mm(5), depth=0, face="B", purpose="ручка"))
    ctx.add_hardware("handle", handle_name(h), 1, path, finish=h.finish)


def _appliance(ctx: BuildContext, cab, slot: Slot, *, path: str, ptr: str, x: int, w: int, z0: int, z1: int,
               last: bool) -> None:
    """Открытая ниша внизу модуля, над ней неподвижная полка и отделение с фасадом."""
    t = ctx.t
    k = ctx.product
    app = cab.appliance or "microwave"
    default, least, whom, title = NICHE[app]
    niche = mm(cab.niche_height) if cab.niche_height else default
    above = cab.above or "door"
    box = slot.box
    if niche < least:
        ctx.issues.append(Issue(
            level="error", code="appliance_niche_low",
            message=f"Ниша {to_mm(niche):g} мм — под {whom} нужно от {to_mm(least):g} мм в свету", path=path,
            fixes=[Fix(description=f"Ниша {to_mm(default):g} мм",
                       patch=[PatchOp(op="replace", path=f"{ptr}/niche_height", value=to_mm(default))])]))
    if box.width < (mm(460) if app == "microwave" else mm(560)):
        ctx.warn("appliance_niche_narrow", f"Ниша {to_mm(box.width):g} мм в ширину — узко под {whom}, проверьте "
                                           "размеры техники", path)
    depth = mm(k.wall_depth)
    if app == "oven" and depth < mm(550):
        ctx.warn("appliance_niche_shallow", f"Духовке нужна глубина от 550 мм, а у верхних {to_mm(depth):g} мм — "
                                            "духовку обычно ставят в пенал", path)
    ctx.warn("appliance_niche", f"{title} в верхнем ряду: ниша {to_mm(niche):g} мм в свету — проверьте размеры и "
                                "вентиляцию по инструкции техники (технику покупает клиент)", path)
    if above == "none":
        if box.height != niche:
            ctx.warn("appliance_niche_size", f"Модуль задан высотой — ниша {to_mm(box.height):g} мм в свету", path)
        return
    rest = box.height - niche - t
    if rest < mm(150):
        raise BuildError("appliance_cabinet_low",
                         f"Модуль {to_mm(z1 - z0):g} мм: над нишей {to_mm(niche):g} мм остаётся {to_mm(max(rest, 0)):g} мм "
                         "— увеличьте высоту модуля или выберите «ничего над нишей»", path)
    zs = box.z0 + niche
    _fixed_shelf(ctx, slot, zs, f"{path}.niche_shelf", "Полка над нишей", path)
    upper = Box(x0=box.x0, x1=box.x1, y0=box.y0, y1=box.y1, z0=zs + t, z1=box.z1)
    line = zs + t // 2  # линия фасадов — по середине полки
    if above == "lift":
        boxes = lift_flaps(ctx, slot, x, x + w, line, z1, auto_flaps(cab.flaps, z1 - line), path, ptr=ptr, has_flaps=True,
                           fix_field="above=door")
        if boxes != [slot.box]:
            boxes = [Box(x0=b.x0, x1=b.x1, y0=b.y0, y1=b.y1, z0=max(b.z0, upper.z0), z1=b.z1) for b in boxes]
        else:
            boxes = [upper]
    else:
        boxes = [upper]
        if above == "door":
            hinge = cab.hinge if cab.doors or not last else "right"
            _doors(ctx, slot, [x, x + w], line, z1, _door_count(ctx, w, cab.doors), hinge, f"{path}.doors",
                   tall=False)
    if all(b.height >= mm(300) for b in boxes):
        _shelves_split(ctx, slot, boxes, cab.shelves - (len(boxes) - 1), path)


def _tier(ctx: BuildContext, cab, *, path: str, ptr: str, x: int, w: int, z: int, h: int, d: int, y0: int,
          last: bool) -> None:
    """Ярус на крыше модуля: свой короб, фасады распашные или подъёмный."""
    tp = cab.top
    tpath = f"{path}.tier"
    slot = _carcass(ctx, path=tpath, x=x, w=w, z=z, h=h, d=d, kind="wall", back=True, y0=y0)
    if tp.opening == "lift":
        lift_flaps(ctx, slot, x, x + w, z, z + h, 1, tpath, ptr=f"{ptr}/top", has_flaps=False,
                   fix_field="opening=hinged")
    else:
        hinge = cab.hinge if tp.doors or not last else "right"
        _doors(ctx, slot, [x, x + w], z, z + h, _door_count(ctx, w, tp.doors), hinge, f"{tpath}.doors", tall=False)
    ctx.add_hardware("screw", "Саморез 4×30 (стяжка яруса с модулем)", 4, tpath)


@module("kitchen_mid", "0.1.0", "Полка на столешнице")
def build_mid(ctx: BuildContext, *, base_len: int, ct_top: int, bottoms: list[tuple[int, int, int]],
              back_t: int) -> None:
    """Открытые короба на столешнице под верхними модулями. bottoms — (x0, x1, низ верхнего модуля)."""
    k = ctx.product
    taken: list[tuple[int, int, int]] = []
    hobs, x = [], 0
    for c in k.base:
        if c.hob:
            hobs.append((x, x + mm(c.width)))
        x += mm(c.width)
    for i, u in enumerate(k.mid):
        path, ptr = f"mid[{i}]", f"/mid/{i}"
        x0, w = mm(u.x), mm(u.width)
        if x0 + w > base_len:
            ctx.issues.append(Issue(
                level="error", code="mid_outside_run",
                message=f"Полка на столешнице {u.x:g}+{u.width:g} мм выходит за ряд ({to_mm(base_len):g} мм)",
                path=path, fixes=[Fix(description="Сдвинуть к краю ряда",
                                      patch=[PatchOp(op="replace", path=f"{ptr}/x",
                                                     value=max(0, to_mm(base_len - w)))])]))
            continue
        clash = next((j for a, b, j in taken if a < x0 + w and x0 < b), None)
        if clash is not None:
            ctx.error("mid_overlap", f"Полки на столешнице {clash + 1} и {i + 1} наложились", path)
            continue
        over = [z for a, b, z in bottoms if a < x0 + w and x0 < b]
        top = min(over) if over else mm(k.wall_bottom)
        room = top - ct_top
        h = mm(u.height) if u.height else room
        if h > room:
            ctx.issues.append(Issue(
                level="error", code="mid_too_tall",
                message=f"Полка на столешнице {u.height:g} мм не входит: до верхних модулей {to_mm(room):g} мм",
                path=path, fixes=[Fix(description="До низа верхних модулей",
                                      patch=[PatchOp(op="replace", path=f"{ptr}/height", value=None)])]))
            continue
        if h < mm(150):
            ctx.error("mid_no_room", f"Между столешницей и верхними модулями {to_mm(room):g} мм — полку не поставить",
                      path)
            continue
        if any(a < x0 + w and x0 < b for a, b in hobs):
            ctx.warn("mid_over_hob", "Полка на столешнице над варкой — нагреется и загорится; сдвиньте её", path)
        depth = mm(u.depth) if u.depth else mm(k.wall_depth)
        if depth > mm(k.countertop.depth) - mm(150):
            ctx.warn("mid_deep", f"Полка {to_mm(depth):g} мм в глубину — на столешнице почти не остаётся места", path)
        slot = _carcass(ctx, path=path, x=x0, w=w, z=ct_top, h=h, d=depth - back_t, kind="wall", back=True,
                        y0=mm(k.base_depth) - depth)
        if u.shelves:
            ctx.run("shelf", slot, slot.box, ShelvesFill(count=u.shelves), f"{path}.fill[0]")
        ctx.add_hardware("bracket", "Уголок мебельный", 2, path)
        taken.append((x0, x0 + w, i))
