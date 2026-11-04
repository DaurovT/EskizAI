"""Корпус: боковины, крыша, дно, цоколь, антресоль, задняя стенка."""

from ..assembler import BuildContext, BuildError, Box, at
from ..catalog import material
from ..geometry import Placement
from ..units import mm, to_mm
from . import module

# Размещения: боковина и перегородка стоят вертикально (длина — по высоте,
# ширина — по глубине); горизонтальные детали лежат (длина — по ширине изделия);
# фронтальные стоят лицом к нам (длина — по ширине, ширина — по высоте).
VERTICAL = dict(u="+Z", v="+Y", n="+X")
HORIZONTAL = dict(u="+X", v="+Y", n="+Z")
FRONTAL = dict(u="+X", v="+Z", n="+Y")


def body_depth(ctx: BuildContext) -> int:
    """Глубина корпусных деталей: общая глубина минус ХДФ сзади."""
    back = ctx.product.body.back
    back_t = material(back.material).thickness if back.kind == "nailed" else 0
    return mm(ctx.product.depth) - back_t


def body_height(ctx: BuildContext) -> int:
    """Высота корпуса: общая высота минус карниз."""
    c = ctx.product.body.cornice
    return mm(ctx.product.height) - (mm(c.height) if c else 0)


def plinth_height(ctx: BuildContext) -> int:
    plinth = ctx.product.body.plinth
    return mm(plinth.height) if plinth else 0


@module("body", "0.2.0", "Корпус")
def build_body(ctx: BuildContext) -> Box:
    p, r = ctx.product, ctx.rules
    body = p.body
    t = ctx.t
    W, H = mm(p.width), body_height(ctx)
    d = body_depth(ctx)
    plinth_h = plinth_height(ctx)

    if W < 2 * t + r.min_section_width:
        raise BuildError("too_narrow", f"Ширина {to_mm(W)} мм слишком мала для корпуса", "body")
    if H < plinth_h + 2 * t + mm(100):
        raise BuildError("too_low", f"Высота {to_mm(H)} мм слишком мала для корпуса", "body")
    if d < mm(100):
        raise BuildError("too_shallow", f"Глубина {to_mm(p.depth)} мм слишком мала для корпуса", "body")

    ctx.walls = (0, W)
    front, visible = r.edge_front, r.edge_visible
    top_over = body.top == "over"
    legs = plinth_h > 0 and body.plinth.legs  # на ножках: боковины над цоколем
    z_side = plinth_h if legs else 0
    side_len = (H - t if top_over else H) - z_side

    side_edges = {"y0": front}
    if not top_over:
        side_edges["x1"] = visible  # торец боковины сверху виден
    sides = []
    for key, x, name in (("left", 0, "Боковина левая"), ("right", W - t, "Боковина правая")):
        sides.append(
            ctx.add_part(
                key=f"body.side.{key}",
                name=name,
                role="side",
                module="body",
                material_id=body.material,
                length=side_len,
                width=d,
                placement=Placement(origin=at(x, 0, z_side), **VERTICAL),
                edges=dict(side_edges),
            )
        )

    if top_over:
        top_x, top_len, top_edges = 0, W, {"y0": front, "x0": visible, "x1": visible}
    else:
        top_x, top_len, top_edges = t, W - 2 * t, {"y0": front}
    top = ctx.add_part(
        key="body.top",
        name="Крыша",
        role="top",
        module="body",
        material_id=body.material,
        length=top_len,
        width=d,
        placement=Placement(origin=at(top_x, 0, H - t), **HORIZONTAL),
        edges=top_edges,
    )
    if top_over:
        # Крыша лежит на торцах боковин — конфирматы сверху в торцы
        for side in sides:
            ctx.join(top, side, "body")
    else:
        for side in sides:
            ctx.join(side, top, "body")

    bottom = ctx.add_part(
        key="body.bottom",
        name="Дно",
        role="bottom",
        module="body",
        material_id=body.material,
        length=W - 2 * t,
        width=d,
        placement=Placement(origin=at(t, 0, plinth_h), **HORIZONTAL),
        edges={"y0": front},
    )
    for side in sides:
        ctx.join(side, bottom, "body")

    if plinth_h > 0:
        ctx.run("plinth_legs" if legs else "plinth", W=W, t=t, d=d, plinth_h=plinth_h)

    return Box(x0=t, x1=W - t, y0=0, y1=d, z0=plinth_h + t, z1=H - t)


@module("plinth", "0.2.0", "Цоколь")
def build_plinth(ctx: BuildContext, *, W: int, t: int, d: int, plinth_h: int) -> None:
    body = ctx.product.body
    setback = mm(body.plinth.setback)
    sides = [ctx.part("body.side.left"), ctx.part("body.side.right")]
    for key, y, name in (("front", setback, "Цоколь передний"), ("back", d - t, "Цоколь задний")):
        strip = ctx.add_part(
            key=f"body.plinth.{key}",
            name=name,
            role="plinth",
            module="body.plinth",
            material_id=body.material,
            length=W - 2 * t,
            width=plinth_h,
            placement=Placement(origin=at(t, y, 0), **FRONTAL),
        )
        for side in sides:
            ctx.join(side, strip, "body.plinth")


@module("mezzanine", "0.1.0", "Антресоль")
def build_mezzanine(ctx: BuildContext, inner: Box) -> tuple[Box, Box]:
    """Полка антресоли на всю ширину; делит корпус на нижнюю часть и антресоль."""
    t = ctx.t
    height = mm(ctx.product.mezzanine.height)
    z_div = inner.z1 - height - t  # низ полки антресоли
    if z_div - inner.z0 < mm(300):
        raise BuildError("mezzanine_too_high", "Антресоль занимает почти всю высоту шкафа", "mezzanine")
    divider = ctx.add_part(
        key="mezzanine.shelf",
        name="Полка антресоли",
        role="divider",
        module="mezzanine",
        material_id=ctx.product.body.material,
        length=inner.width,
        width=inner.depth,
        placement=Placement(origin=at(inner.x0, inner.y0, z_div), **HORIZONTAL),
        edges={"y0": ctx.rules.edge_front},
    )
    for side in (ctx.part("body.side.left"), ctx.part("body.side.right")):
        ctx.join(side, divider, "mezzanine")
    lower = Box(x0=inner.x0, x1=inner.x1, y0=inner.y0, y1=inner.y1, z0=inner.z0, z1=z_div)
    upper = Box(x0=inner.x0, x1=inner.x1, y0=inner.y0, y1=inner.y1, z0=z_div + t, z1=inner.z1)
    return lower, upper


@module("back", "0.2.0", "Задняя стенка")
def build_back(ctx: BuildContext, seams: list[int]) -> None:
    """ХДФ на гвоздях сзади. Если не помещается на лист — делится на части
    со стыком по середине перегородки (seams — x середин перегородок)."""
    p, r = ctx.product, ctx.rules
    back = p.body.back
    inset = r.back_inset
    W, H = mm(p.width), body_height(ctx)
    d = body_depth(ctx)
    plinth_h = plinth_height(ctx)
    height = H - plinth_h - 2 * inset
    usable_l = r.sheet_length - 2 * r.sheet_trim
    usable_w = r.sheet_width - 2 * r.sheet_trim

    def fits(w: int) -> bool:  # у ХДФ нет текстуры — можно повернуть
        return (w <= usable_l and height <= usable_w) or (height <= usable_l and w <= usable_w)

    # Жадно: каждая часть — как можно шире, но помещается на лист
    bounds = [inset, *seams, W - inset]
    pieces: list[tuple[int, int]] = []
    start = 0
    while start < len(bounds) - 1:
        end = start + 1
        while end + 1 < len(bounds) and fits(bounds[end + 1] - bounds[start]):
            end += 1
        pieces.append((bounds[start], bounds[end]))
        start = end

    for i, (x0, x1) in enumerate(pieces, start=1):
        suffix = f" {i}" if len(pieces) > 1 else ""
        ctx.add_part(
            key=f"body.back[{i}]",
            name=f"Задняя стенка{suffix}",
            role="back",
            module="body.back",
            material_id=back.material,
            length=x1 - x0,
            width=height,
            placement=Placement(origin=at(x0, d, plinth_h + inset), **FRONTAL),
            grain="none",
        )
        perimeter = 2 * ((x1 - x0) + height)
        ctx.add_hardware("nail", "Гвоздь для ХДФ 1,6×25", -(-perimeter // mm(150)), "body.back")


@module("cornice", "0.1.0", "Карниз")
def build_cornice(ctx: BuildContext) -> None:
    """Планка карниза над корпусом в плоскости фасадов, по всей ширине."""
    p = ctx.product
    from .fronts import _front_thickness

    tf = _front_thickness(ctx)
    W, Hb = mm(p.width), body_height(ctx)
    h = mm(p.body.cornice.height)
    e = ctx.rules.edge_front
    ctx.add_part(
        key="body.cornice", name="Карниз", role="cornice", module="body.cornice", material_id=ctx.fronts_material,
        length=W, width=h, placement=Placement(origin=at(0, -tf, Hb), **FRONTAL),
        edges={"y0": e, "y1": e, "x0": e, "x1": e},
    )
    ctx.add_hardware("bracket", "Уголок мебельный (крепление карниза)", max(2, W // mm(600) + 1), "body.cornice")


@module("end_unit", "0.1.0", "Торцевая радиусная секция")
def build_end_unit(ctx: BuildContext, unit, index: int) -> None:
    """Открытые скруглённые полки у наружной боковины. Строится в координатах корпуса:
    левая секция — при x < 0 (потом всё изделие сдвигается вправо)."""
    from ..operations import rounded_rect

    p, r, t = ctx.product, ctx.rules, ctx.t
    W, Hb = mm(p.width), body_height(ctx)
    d = body_depth(ctx)
    plinth_h = plinth_height(ctx)
    w = mm(unit.width)
    left = unit.side == "left"
    x0 = -w if left else W
    side = ctx.part("body.side.left" if left else "body.side.right")
    path = f"end_units[{index}]"
    mat = p.body.material
    outer = "x0" if left else "x1"

    # Задняя стенка секции — ЛДСП во всю высоту корпуса, у стены
    rear = ctx.add_part(
        key=f"end_unit.{unit.side}.rear", name="Стенка торцевой секции", role="end_rear", module=path,
        material_id=mat, length=w, width=Hb, placement=Placement(origin=at(x0, d - t, 0), **FRONTAL),
        edges={"y1": r.edge_visible, outer: r.edge_front},
    )
    ctx.join(side, rear, path)

    depth = d - t
    radius = min(w, depth) - mm(5)
    corner = "x0y0" if left else "x1y0"  # скругляется наружный передний угол
    n = unit.shelves
    z_bottom, z_top = plinth_h, Hb - t
    gap = (z_top - z_bottom - t * (n + 1)) / (n + 1)  # просветы между дном, полками и крышей
    levels = [("bottom", "Дно торцевой секции", z_bottom)]
    for k in range(1, n + 1):
        levels.append((f"shelf[{k}]", "Полка торцевая", round(z_bottom + t + k * gap + (k - 1) * t)))
    levels.append(("top", "Крыша торцевой секции", z_top))
    for key, name, z in levels:
        shelf = ctx.add_part(
            key=f"end_unit.{unit.side}.{key}", name=name, role="end_shelf", module=path, material_id=mat,
            length=w, width=depth, placement=Placement(origin=at(x0, 0, z), **HORIZONTAL),
            edges={"y0": r.edge_front, outer: r.edge_front},
        )
        shelf.contour = rounded_rect(w, depth, {corner: radius})
        ctx.join(side, shelf, path)
        ctx.join(rear, shelf, path)
