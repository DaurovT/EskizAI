"""Встроенная мебель: доборы к стенам и потолку, фальш-панели, цоколь на ножках, крепление к стене.

Кухня: ниша холодильника с панелью над ним, фасад посудомойки, фальш-панели на торцах рядов,
цоколь с боковыми планками и решётками, добор до потолка над верхними модулями.

Доборы и фальш-панели — обычные детали (раскрой, кромка, смета, 3D), неподвижные. У добора кромится
только видимая кромка (к фасадам); кромка к стене — без кромки, её подрезают по стене на месте.
"""

import math

from ..assembler import BuildContext, BuildError, at
from ..catalog import material
from ..geometry import Contour, LineSeg, Placement
from ..niche import NicheLayout, fit_patch, niche_layout
from ..parts import Fix, Issue, MovingNode, PartDecor, PatchOp
from ..units import mm, to_mm
from . import module
from .body import FRONTAL, HORIZONTAL, VERTICAL, plinth_height

DOOR = dict(u="+Z", v="+X", n="+Y")  # стоит лицом к нам, длина — по высоте
FAR = 10 ** 9
SIDE_NAMES = {"left": "левый", "right": "правый", "top": "верхний"}
WALL_ANCHOR = "Дюбель-саморез 8×80 + уголок (крепление к стене)"


def _front_plane(ctx: BuildContext) -> int:
    """y лицевой плоскости фасадов шкафа; у купе двери внутри корпуса — плоскость корпуса."""
    if ctx.product.sliding_doors:
        return 0
    from .fronts import _front_thickness

    return -_front_thickness(ctx)


def _pieces(a: int, b: int, max_len: int) -> list[tuple[int, int]]:
    """Длинная деталь — на равные части не длиннее листа."""
    n = max(1, -(-(b - a) // max_len))
    step = (b - a) / n
    return [(a + round(k * step), a + round((k + 1) * step)) for k in range(n)]


def _usable(ctx: BuildContext) -> int:
    return ctx.rules.sheet_length - 2 * ctx.rules.sheet_trim


def _fixings(ctx: BuildContext, length: int, mount: str, path: str, what: str) -> None:
    n = -(-length // ctx.rules.filler_fix_step) + 1
    if mount == "strip":
        ctx.add_hardware("screw", f"Саморез 4×30 ({what})", 2 * n, path)
    else:
        ctx.add_hardware("bracket", f"Уголок мебельный ({what})", n, path)
        ctx.add_hardware("screw", "Саморез 4×16 (уголки)", 4 * n, path)


# ---------- Шкаф: ниша и доборы ----------


def prepare_builtin(ctx: BuildContext) -> None:
    """До фасадов: щели по замеру ниши. Дверь у стены не бьёт в стену, если до стены ≥ 30 мм."""
    p, r = ctx.product, ctx.rules
    lay = niche_layout(p, r)
    ctx.niche = lay
    W = mm(p.width)
    left_clear = lay.panel_left + lay.left.min
    right_clear = lay.panel_right + lay.right.min
    ctx.walls = (0 if left_clear < r.filler_door_clearance else -FAR,
                 W if right_clear < r.filler_door_clearance else FAR)


def _wedge_fix(b, sides: list[str]) -> list[Fix]:
    """Исправление «Добор клином» для доборов у заваленных стен."""
    if not sides:
        return []
    wedge = [s for s in ("left", "right", "top") if s in b.wedge or s in sides]
    return [Fix(description="Добор клином", patch=[PatchOp(op="replace", path="/builtin/wedge", value=wedge)])]


def _wedge_points(profile: list[tuple[float, int]], length: int, scribe: int) -> list[tuple[int, int]]:
    """Точки кромки к стене (вдоль детали, ширина с припуском) — от x = 0 до x = length."""
    pts = [(round(f * length), w + scribe) for f, w in sorted(profile)]
    if pts[0][0] > 0:
        pts.insert(0, (0, pts[0][1]))
    if pts[-1][0] < length:
        pts.append((length, pts[-1][1]))
    return pts


def _polygon(points: list[tuple[int, int]]) -> Contour:
    clean = [pt for i, pt in enumerate(points) if i == 0 or pt != points[i - 1]]
    return Contour(start_x=clean[0][0], start_y=clean[0][1],
                   segments=[LineSeg(x=x, y=y) for x, y in clean[1:] + [clean[0]]])


def _wedge_name(base: str, g) -> str:
    return f"{base} клином {to_mm(g.min):g}→{to_mm(g.max):g} мм"


def _fit_fix(p, description: str = "Подогнать корпус под нишу") -> list[Fix]:
    patch = fit_patch(p)
    return [Fix(description=description, patch=patch)] if patch else []


def _check_niche(ctx: BuildContext, lay: NicheLayout) -> None:
    """Правила ниши: узкая ниша, корпус шире ниши, доборы шире 150 / уже 20 мм, щель без добора,
    стены не параллельны, корпус глубже ниши, корпус не поднять в нишу."""
    p, r = ctx.product, ctx.rules
    b = p.builtin
    D = mm(p.depth)
    t = ctx.t

    def issue(level: str, code: str, message: str, fixes: list[Fix] | None = None) -> None:
        ctx.issues.append(Issue(level=level, code=code, message=message, path="builtin", fixes=fixes or []))

    if lay.widths:
        wmin, wmax = min(lay.widths), max(lay.widths)
        need = (lay.panel_left + lay.panel_right + 2 * t + r.niche_min_section
                + sum(mm(b.filler_width) if s in b.fillers else mm(b.allowance_side) for s in ("left", "right")))
        if mm(wmin) < need:
            issue("error", "niche_too_narrow",
                  f"Ниша {wmin:g} мм слишком узкая: корпусу с доборами нужно не меньше {to_mm(need):g} мм")
            return
        if wmax - wmin > to_mm(r.plumb_tolerance):
            n = b.niche
            marks = [f"{name} {v:g}" for name, v in (("вверху", n.width_top), ("посередине", n.width_middle),
                                                    ("внизу", n.width_bottom)) if v is not None]
            sides = [g for g in (lay.left, lay.right) if g.filler and g.lean > 0 and len(g.profile) > 1]
            done = sides and all(g.wedge for g in sides)
            head = f"Стены ниши не параллельны: ширина {', '.join(marks) or f'{wmin:g}–{wmax:g}'} мм"
            if n.lean:
                where = "внизу" if (n.width_bottom or 0) > (n.width_top or 0) else "вверху"
                head = f"Стена {'справа' if n.lean == 'right' else 'слева'} завалена на {wmax - wmin:g} мм, щель {where}"
            tail = ("доборы клином — кромка к стене режется по замеру" if done else
                    "доборы выкроены по самому широкому месту с припуском — подрежьте их по стене на месте "
                    "или сделайте добор клином")
            issue("warning", "niche_out_of_plumb",
                  f"{head} — разница {wmax - wmin:g} мм (больше {to_mm(r.plumb_tolerance):g}). "
                  f"Корпус сделан по самому узкому месту, {tail}",
                  _wedge_fix(b, [g.side for g in sides if not g.wedge]))
    if len(lay.heights) > 1:
        hmin, hmax = min(lay.heights), max(lay.heights)
        if hmax - hmin > to_mm(r.plumb_tolerance):
            g = lay.top
            top = ["top"] if g.filler and len(g.profile) > 1 and not g.wedge else []
            issue("warning", "niche_floor_slope",
                  f"Пол или потолок ниши с перекосом: высота от {hmin:g} до {hmax:g} мм — разница {hmax - hmin:g} мм. "
                  "Корпус выставьте по уровню на ножках/подкладках, верхний добор "
                  + ("клином — по замеру" if g.wedge else "подрежьте по потолку или сделайте клином"),
                  _wedge_fix(b, top))

    # Корпус не входит: с добором щель < 0, без добора — меньше половины монтажного зазора
    for gaps, measured, allowance, what in (((lay.left, lay.right), lay.widths, mm(b.allowance_side), "шире"),
                                            ((lay.top,), lay.heights, mm(b.allowance_top), "выше")):
        short = [g for g in gaps if measured and g.min < (0 if g.filler else allowance // 2)]
        if short:
            where = {"left": "слева", "right": "справа", "top": "сверху"}
            issue("error", "builtin_too_big",
                  f"Корпус {what} ниши: {', '.join(f'{where[g.side]} {to_mm(g.min):g} мм' for g in short)} до стены "
                  "— в нишу не войдёт", _fit_fix(p))
            return

    sides = [lay.left, lay.right] + ([lay.top] if lay.heights or "top" in b.fillers else [])
    for g in sides:
        name = SIDE_NAMES[g.side]
        if g.filler:
            if g.min > r.filler_max:
                fixes = _fit_fix(p, "Корпус шире — добор 50 мм" if g.side != "top" else "Корпус выше — добор 50 мм")
                extra = (lay.left.min + lay.right.min - 2 * mm(b.filler_width)) if g.side != "top" else 0
                if g.side != "top" and extra >= r.min_section_width + t and fixes:
                    sec: dict = {"fill": [{"kind": "shelves", "count": 4}]}
                    if any(s.doors for s in p.sections):
                        sec["doors"] = {"count": 1}
                    fixes.append(Fix(description="Добавить секцию на лишнюю ширину",
                                     patch=fixes[0].patch + [PatchOp(op="add", path="/sections/-", value=sec)]))
                issue("warning", "filler_too_wide",
                      f"Добор {name} {to_mm(g.min):g} мм — шире {to_mm(r.filler_max):g} мм: широкая планка выглядит "
                      "как недоделка. Сделайте корпус " + ("шире или добавьте секцию" if g.side != "top" else "выше"),
                      fixes)
            elif g.min < r.filler_min:
                fixes = _fit_fix(p, "Корпус меньше — добор 50 мм")
                fixes.append(Fix(description=f"Без добора {name} — монтажный зазор",
                                 patch=[PatchOp(op="replace", path="/builtin/fillers",
                                                value=[s for s in b.fillers if s != g.side])]))
                issue("warning", "filler_too_narrow",
                      f"Добор {name} {to_mm(g.min):g} мм — уже {to_mm(r.filler_min):g} мм, его не закрепить. "
                      "Сделайте корпус меньше (добор 50 мм) или уберите добор и оставьте монтажный зазор "
                      f"(закройте герметиком). Добор не вырезан", fixes)
        elif g.side != "top" and lay.widths and g.min > r.side_gap_open_max:
            issue("warning", "niche_gap_open",
                  f"{'Слева' if g.side == 'left' else 'Справа'} между корпусом и стеной {to_mm(g.min):g} мм без добора — "
                  "щель будет видна",
                  [Fix(description=f"Добор {name}", patch=[PatchOp(op="replace", path="/builtin/fillers",
                                                                   value=[*b.fillers, g.side])])])

    nd = b.niche.depth
    if nd is not None and D > mm(nd):
        issue("warning", "niche_too_shallow",
              f"Корпус глубиной {p.depth:g} мм глубже ниши {nd:g} мм — выступит из ниши на {p.depth - nd:g} мм",
              [Fix(description=f"Глубина корпуса {nd:g} мм", patch=[PatchOp(op="replace", path="/depth", value=nd)])])
    if lay.heights:
        side, top = ctx.part("body.side.left").aabb(), ctx.part("body.top").aabb()
        diag = math.hypot(top.max.z - side.min.z, D)  # корпус без ножек
        if diag > mm(min(lay.heights)):
            issue("warning", "builtin_tilt",
                  f"Собранный корпус не поднять в нишу: при подъёме диагональ боковины {to_mm(round(diag)):g} мм "
                  f"больше высоты ниши {min(lay.heights):g} мм — собирайте корпус на месте, в нише")
    if p.sliding_doors:
        issue("warning", "sliding_niche_rails",
              "Купе в нише: верхний и нижний рельсы крепятся к крыше и дну корпуса — выставьте корпус по уровню и "
              "закрепите к стенам ниши до установки рельсов, иначе двери будут откатываться")


@module("builtin", "0.1.0", "Встроенный шкаф: доборы")
def build_builtin(ctx: BuildContext) -> None:
    p, r = ctx.product, ctx.rules
    b = p.builtin
    lay: NicheLayout = ctx.niche
    _check_niche(ctx, lay)
    if any(i.code in ("niche_too_narrow", "builtin_too_big") for i in ctx.issues):
        return
    mat = b.filler_material or ctx.fronts_material
    tm = material(mat).thickness
    y0 = _front_plane(ctx) + (mm(b.filler_setback) if b.filler_position == "setback" else 0)
    W, H = mm(p.width), mm(p.height)
    ts, sw, e = ctx.t, r.filler_strip_width, r.edge_front
    strip_ok = b.filler_mount == "strip"

    for g, pt in ((lay.left, lay.panel_left), (lay.right, lay.panel_right)):
        if not g.filler or g.min < r.filler_min:
            continue
        left = g.side == "left"
        x0 = -pt - g.blank if left else W + pt
        name = f"Добор {SIDE_NAMES[g.side]}"
        filler = ctx.add_part(
            key=f"builtin.filler.{g.side}", name=_wedge_name(name, g) if g.wedge else name, role="niche_filler",
            module="builtin", material_id=mat, length=H, width=g.blank,
            placement=Placement(origin=at(x0, y0, 0), **DOOR),
            edges={"y1": e} if left else {"y0": e},  # кромка — только к фасадам, к стене — подрезка
        )
        if g.wedge:  # клин: кромка к стене по замеру (внизу/посередине/вверху), к фасадам — прямая
            pts = _wedge_points(g.profile, H, mm(b.scribe))
            if left:  # прямая кромка — y = ширина заготовки
                filler.contour = _polygon([(x, g.blank - w) for x, w in pts] + [(H, g.blank), (0, g.blank)])
            else:
                filler.contour = _polygon([(0, 0), (H, 0)] + [(x, w) for x, w in reversed(pts)])
        if strip_ok and g.min >= ts:
            sx = -pt - ts if left else W + pt
            ctx.add_part(
                key=f"builtin.strip.{g.side}", name="Планка крепления добора", role="filler_strip", module="builtin",
                material_id=p.body.material, length=H, width=sw,
                placement=Placement(origin=at(sx, y0 + tm, 0), **VERTICAL),
            )
            _fixings(ctx, H, "strip", "builtin", "планка добора")
        else:
            _fixings(ctx, H, "screws", "builtin", "крепление добора")

    g = lay.top
    if g.filler and g.min >= r.filler_min:
        xl = -lay.panel_left - lay.left.max
        xr = W + lay.panel_right + lay.right.max
        parts = _pieces(xl, xr, _usable(ctx))
        for k, (a, c) in enumerate(parts, start=1):
            single = len(parts) == 1
            name = "Добор верхний" if single else f"Добор верхний {k}"
            top = ctx.add_part(
                key="builtin.filler.top" if single else f"builtin.filler.top[{k}]",
                name=_wedge_name(name, g) if g.wedge else name, role="niche_filler", module="builtin",
                material_id=mat, length=c - a, width=g.blank, placement=Placement(origin=at(a, y0, H), **FRONTAL),
                edges={"y0": e},
            )
            if g.wedge:  # высота по потолку: слева → справа, линейно между точками замера
                (f0, h0), (f1, h1) = sorted(g.profile)[0], sorted(g.profile)[-1]

                def height(x: int) -> int:
                    f = (x - xl) / (xr - xl)
                    return round(h0 + (h1 - h0) * (f - f0) / (f1 - f0)) + mm(b.scribe)

                top.contour = _polygon([(0, 0), (c - a, 0), (c - a, height(c)), (0, height(a))])
        if strip_ok and g.min >= ts and not p.body.cornice:
            for k, (a, c) in enumerate(_pieces(0, W, _usable(ctx)), start=1):
                ctx.add_part(
                    key="builtin.strip.top" if W <= _usable(ctx) else f"builtin.strip.top[{k}]",
                    name="Планка крепления добора", role="filler_strip", module="builtin",
                    material_id=p.body.material, length=c - a, width=sw,
                    placement=Placement(origin=at(a, y0 + tm, H), **HORIZONTAL),
                )
            _fixings(ctx, W, "strip", "builtin", "планка добора")
        else:
            _fixings(ctx, xr - xl, "screws", "builtin", "крепление добора")
    ctx.add_hardware("wall_anchor", WALL_ANCHOR, 4, "builtin")


# ---------- Шкаф: фальш-панели, цоколь на ножках, без задней стенки ----------


@module("side_panels", "0.1.0", "Фальш-панели")
def build_side_panels(ctx: BuildContext) -> None:
    """Фальш-панель снаружи боковины: от пола (или от цоколя) до верха, глубина — корпус с фасадами."""
    p, r = ctx.product, ctx.rules
    W, H, D = mm(p.width), mm(p.height), mm(p.depth)
    y0 = _front_plane(ctx)
    seen: set[str] = set()
    for i, sp in enumerate(p.side_panels):
        path = f"side_panels[{i}]"
        if sp.side in seen:
            raise BuildError("side_panel_duplicate", "Две фальш-панели с одной стороны", path)
        seen.add(sp.side)
        if any(u.side == sp.side for u in p.end_units):
            raise BuildError("side_panel_end_unit", "С этой стороны торцевая секция — фальш-панель на неё не "
                                                    "поставить", path)
        mat = sp.material or ctx.fronts_material
        pt = material(mat).thickness
        z0 = 0 if sp.to_floor else plinth_height(ctx)
        left = sp.side == "left"
        ctx.add_part(
            key=f"side_panel.{sp.side}", name=f"Фальш-панель {'левая' if left else 'правая'}", role="false_panel",
            module=path, material_id=mat, length=H - z0, width=D - y0,
            placement=Placement(origin=at(-pt if left else W, y0, z0), **VERTICAL),
            edges={"y0": r.edge_front, "x1": r.edge_front},
        )
        ctx.add_hardware("screw", "Саморез 4×30 (фальш-панель)", max(4, 2 * -(-(H - z0) // mm(600))), path)


@module("plinth_legs", "0.1.0", "Цоколь на ножках")
def build_plinth_legs(ctx: BuildContext, *, W: int, t: int, d: int, plinth_h: int) -> None:
    """Корпус на регулируемых ножках: планка цоколя на клипсах спереди и с открытых боков,
    с зазором до пола на неровность."""
    p, r = ctx.product, ctx.rules
    pl = p.body.plinth
    allow = max(0, min(mm(pl.floor_allowance), plinth_h - mm(30)))
    h = plinth_h - allow
    setback = mm(pl.setback)
    mat = p.body.material
    ctx.add_part(key="body.plinth.front", name="Цоколь передний", role="plinth", module="body.plinth",
                 material_id=mat, length=W, width=h, placement=Placement(origin=at(0, setback, allow), **FRONTAL),
                 edges={"x0": r.edge_visible, "x1": r.edge_visible})
    covered = {sp.side for sp in p.side_panels if sp.to_floor}
    closed = p.installation == "niche" or p.builtin is not None
    sides = 0
    for side, x in (("left", 0), ("right", W - t)):
        if closed or side in covered or d - setback - t < mm(50):
            continue
        sides += 1
        ctx.add_part(key=f"body.plinth.{side}", name=f"Цоколь {'левый' if side == 'left' else 'правый'}",
                     role="plinth_side", module="body.plinth", material_id=mat, length=h, width=d - setback - t,
                     placement=Placement(origin=at(x, setback + t, allow), **VERTICAL), edges={"y0": r.edge_visible})
    n_x = max(2, -(-W // r.wardrobe_leg_step) + 1)
    ctx.add_hardware("leg", "Ножка мебельная регулируемая", 2 * n_x, "body.plinth")
    ctx.add_hardware("plinth_clip", "Клипса цоколя", 2 * n_x + 2 * sides, "body.plinth")


@module("wall_fixing", "0.1.0", "Крепление к стене")
def build_wall_fixing(ctx: BuildContext, *, count: int, path: str) -> None:
    """Без задней стенки корпус держит форму только креплением к стене."""
    ctx.add_hardware("wall_anchor", WALL_ANCHOR, count, path)
    ctx.issues.append(Issue(
        level="warning", code="back_none_wall",
        message="Без задней стенки корпус держит геометрию только креплением к стене: ставьте к ровной чистовой "
                f"стене и крепите уголками с дюбелями ({count} шт. в смете). Кривую стену будет видно",
        path="body.back",
        fixes=[Fix(description="Задняя стенка ХДФ",
                   patch=[PatchOp(op="replace", path="/body/back/kind", value="nailed")])],
    ))


def paint_panels(ctx: BuildContext) -> None:
    """Доборы и фальш-панели из МДФ — в цвет фасадов (покраска без фрезеровки)."""
    paint = ctx.product.fronts.style.paint
    if paint is None:
        return
    for part in ctx.parts:
        if part.role in ("niche_filler", "false_panel") and material(part.material).kind == "mdf":
            part.decor = PartDecor(paint={"color": paint.color, "code": paint.code, "system": paint.system,
                                          "gloss": paint.gloss, "both_sides": paint.both_sides})
            part.edges = {}


# ---------- Кухня ----------


@module("kitchen_fridge", "0.1.0", "Ниша холодильника")
def build_fridge(ctx: BuildContext, cab, *, path: str, x: int, w: int, top: int, tf: int, depth: int) -> None:
    """Боковины ниши от пола до верха верхних, полка и фальш-панель над холодильником."""
    r, t = ctx.rules, ctx.t
    mat = ctx.fronts_material
    pt = material(mat).thickness
    e = r.edge_front
    sides = []
    for key, sx in (("left", x), ("right", x + w - pt)):
        sides.append(ctx.add_part(
            key=f"{path}.panel.{key}", name="Боковина ниши холодильника", role="false_panel", module=path,
            material_id=mat, length=top, width=depth + tf, placement=Placement(origin=at(sx, -tf, 0), **VERTICAL),
            edges={"y0": e, "x1": e},
        ))
    inner = w - 2 * pt
    ctx.warn("fridge_niche", f"Ниша холодильника в свету {to_mm(inner):g} мм, высота {cab.fridge_height:g} мм — "
                             "сверьте с холодильником клиента (+10 мм по бокам на вентиляцию)", path)
    ctx.add_hardware("wall_anchor", WALL_ANCHOR, 2, path)
    if not cab.top_panel:
        return
    z_shelf = mm(cab.fridge_height) + r.fridge_top_gap
    if z_shelf + 2 * t + mm(100) > top:
        ctx.warn("fridge_no_top", "Над холодильником меньше 100 мм — полку и панель не ставлю", path)
        return
    body = ctx.product.body.material
    for key, z, name in (("shelf", z_shelf, "Полка над холодильником"), ("roof", top - t, "Крыша ниши холодильника")):
        shelf = ctx.add_part(
            key=f"{path}.{key}", name=name, role="divider", module=path, material_id=body,
            length=inner, width=depth, placement=Placement(origin=at(x + pt, 0, z), **HORIZONTAL),
            edges={"y0": r.edge_front} if key == "shelf" else {},
        )
        for s in sides:
            ctx.join(s, shelf, path)
    ctx.add_part(
        key=f"{path}.top_panel", name="Панель над холодильником", role="false_panel", module=path, material_id=mat,
        length=inner, width=top - z_shelf, placement=Placement(origin=at(x + pt, -tf, z_shelf), **FRONTAL),
        edges={"x0": e, "x1": e, "y0": e, "y1": e},
    )
    ctx.add_hardware("screw", "Саморез 4×30 (панель над холодильником)", 4, path)


@module("kitchen_dw_front", "0.1.0", "Фасад посудомойки")
def build_dw_front(ctx: BuildContext, *, path: str, x: int, w: int, z0: int, z1: int) -> None:
    """Фасад на дверь встраиваемой посудомойки: открывается вниз вместе с дверью машины."""
    from ..parts import Hole
    from .fronts import _front_part, handle_name

    r = ctx.rules
    g = r.front_gap
    if w not in (mm(450), mm(600)):
        ctx.warn("dw_width", f"Посудомойка встраиваемая — 450 или 600 мм, а ниша {to_mm(w):g} мм", path)
    node = f"{path}.dw_front"
    a, b, lo, hi = x + g // 2, x + w - g // 2, z0 + g // 2, z1 - g // 2
    front = _front_part(ctx, node, "Фасад посудомойки", "drawer_front", a, b, lo, hi, node, door=False)
    hk = ctx.product.fronts.handles
    cx, cz = (b - a) // 2, max((hi - lo) // 2, (hi - lo) - r.drawer_handle_from_top)
    if hk.kind == "bar":
        s = mm(hk.spacing)
        for dx in (-s // 2, s // 2):
            front.holes.append(Hole(x=cx + dx, y=cz, diameter=mm(5), depth=0, face="B", purpose="ручка"))
        ctx.add_hardware("handle", handle_name(hk), 1, path, finish=hk.finish)
    elif hk.kind == "knob":
        front.holes.append(Hole(x=cx, y=cz, diameter=mm(5), depth=0, face="B", purpose="ручка"))
        ctx.add_hardware("knob", handle_name(hk), 1, path, finish=hk.finish)
    ctx.add_hardware("dw_front_kit", "Крепёж фасада посудомойки (комплект)", 1, path)
    # Открывается к нам, вниз: поворот вокруг +X у нижней кромки
    ctx.nodes.append(MovingNode(id=node, kind="rotate", module=path, origin=(a, ctx.front_y, lo), axis="+X",
                                range=80))


def kitchen_panel_ends(k, run: str, corner_at) -> dict[str, list]:
    """Фальш-панели ряда: торец → панели. Ряд 2 — свободный торец (от угла)."""
    out: dict[str, list] = {"left": [], "right": []}
    for i, sp in enumerate(k.side_panels):
        if (sp.run == 2) != (run == "2"):
            continue
        if run == "2":
            end = "right" if corner_at == "left" else "left"
        else:
            end = sp.side
            if corner_at == end:
                raise BuildError("side_panel_corner", f"Фальш-панель {'слева' if end == 'left' else 'справа'} — "
                                                      "на угловом торце ряда; поставьте её с другой стороны",
                                 f"side_panels[{i}]")
        out[end].append(sp)
    return out


@module("kitchen_side_panel", "0.1.0", "Фальш-панель кухни")
def build_kitchen_side_panel(ctx: BuildContext, sp, *, run: str, end: str, x_base: tuple[int, int],
                             x_wall: tuple[int, int], base_top: int, wall_z: tuple[int, int], wall_y: int,
                             depth: int, tf: int) -> int:
    """Нижняя — от пола под столешницу, глубина корпуса с фасадом; верхняя — на торце верхних модулей.
    Возвращает толщину нижней панели (на неё удлиняется столешница), 0 — нижней нет."""
    r = ctx.rules
    mat = sp.material or ctx.fronts_material
    pt = material(mat).thickness
    e = r.edge_front
    left = end == "left"
    word = "левая" if left else "правая"
    out = 0
    if sp.row in ("base", "both"):
        z0 = 0 if sp.to_floor else mm(ctx.product.legs_height)
        ctx.add_part(
            key=f"base{run}.side_panel.{end}", name=f"Фальш-панель нижняя {word}", role="false_panel",
            module=f"base{run}.side_panel.{end}", material_id=mat, length=base_top - z0, width=depth + tf,
            placement=Placement(origin=at(x_base[0] - pt if left else x_base[1], -tf, z0), **VERTICAL),
            edges={"y0": e, "x1": e},
        )
        ctx.add_hardware("screw", "Саморез 4×30 (фальш-панель)", 6, f"base{run}.side_panel.{end}")
        out = pt
    if sp.row in ("wall", "both") and x_wall[1] > x_wall[0]:
        z0, z1 = wall_z
        ctx.add_part(
            key=f"wall{run}.side_panel.{end}", name=f"Фальш-панель верхняя {word}", role="false_panel",
            module=f"wall{run}.side_panel.{end}", material_id=mat, length=z1 - z0, width=depth - wall_y + tf,
            placement=Placement(origin=at(x_wall[0] - pt if left else x_wall[1], wall_y - tf, z0), **VERTICAL),
            edges={"y0": e, "x1": e, "x0": e},
        )
        ctx.add_hardware("screw", "Саморез 4×30 (фальш-панель)", 4, f"wall{run}.side_panel.{end}")
    return out


@module("kitchen_plinth", "0.1.0", "Цоколь кухни: боковые планки и решётки")
def build_kitchen_plinth_extras(ctx: BuildContext, *, run: str, pieces: list, ends: dict, legs: int, allow: int,
                                setback: int, depth: int, grilles: list[tuple[int, int, str]]) -> None:
    """pieces — детали цоколя ряда; ends — открытые торцы: торец → x; grilles — (x0, x1, путь модуля)."""
    r, t = ctx.rules, ctx.t
    h = legs - allow
    mat = ctx.product.body.material
    for end, x in ends.items():
        ctx.add_part(key=f"kitchen.plinth{run}.{end}", name=f"Цоколь боковой {'левый' if end == 'left' else 'правый'}",
                     role="plinth_side", module="kitchen", material_id=mat, length=h, width=depth - setback - t,
                     placement=Placement(origin=at(x if end == "left" else x - t, setback + t, allow), **VERTICAL),
                     edges={"y0": r.edge_visible})
        ctx.add_hardware("plinth_clip", "Клипса цоколя", 2, "kitchen")
    for xa, xb, path in grilles:
        cw = min(r.grille_max_length, xb - xa - mm(100))
        ch = h - 2 * r.grille_margin
        piece = next((p for p in pieces if p.placement.origin.x <= xa and xb <= p.placement.origin.x + p.length), None)
        if piece is None or cw < mm(150) or ch < mm(30):
            ctx.warn("grille_no_place", "Решётку в цоколе под этим модулем не поставить — мало места", path)
            continue
        cx = (xa + xb - cw) // 2 - piece.placement.origin.x
        cy = (h - ch) // 2
        piece.cutouts.append(Contour(start_x=cx, start_y=cy, segments=[
            LineSeg(x=cx + cw, y=cy), LineSeg(x=cx + cw, y=cy + ch), LineSeg(x=cx, y=cy + ch), LineSeg(x=cx, y=cy)]))
        ctx.add_hardware("vent_grille", f"Решётка вентиляционная цокольная {to_mm(cw):g}×{to_mm(ch):g} мм", 1, path,
                         width=cw, height=ch)


def _ceiling(k) -> float | None:
    if k.top_filler and k.top_filler.ceiling:
        return k.top_filler.ceiling
    return k.site.ceiling if k.site and k.site.ceiling else None


@module("kitchen_top_filler", "0.1.0", "Добор до потолка")
def build_kitchen_top_filler(ctx: BuildContext, *, run: str, segments: list[tuple]) -> int:
    """Добор от верха верхних модулей (и ниши холодильника) до потолка, заподлицо с фасадами.
    segments — (x0, x1, y лица, ряд base/wall, низ добора). Возвращает верх добора."""
    k, r = ctx.product, ctx.rules
    top = min(seg[4] for seg in segments)
    tfill = k.top_filler
    ceiling = _ceiling(k)
    issue_path = "top_filler"
    if ceiling is None:
        if run == "":
            ctx.warn("top_filler_no_ceiling", "Добор до потолка: нет высоты потолка — внесите замер кухни "
                                              "(пока добор 50 мм)", issue_path)
        gap = mm(50)
    else:
        gap = mm(ceiling) - top
    if gap <= 0:
        if run == "":
            ctx.warn("top_filler_not_needed", f"Верхние модули ({to_mm(top):g} мм) упираются в потолок "
                                              f"{ceiling:g} мм — добор не нужен", issue_path)
        return top
    if gap < r.filler_min:
        if run == "":
            ctx.issues.append(Issue(
                level="warning", code="filler_too_narrow",
                message=f"До потолка {to_mm(gap):g} мм — добор уже {to_mm(r.filler_min):g} мм не закрепить: "
                        "закройте щель герметиком/плинтусом или опустите верхние модули",
                path=issue_path, fixes=[Fix(description="Без добора до потолка",
                                            patch=[PatchOp(op="remove", path="/top_filler")])]))
        return top
    if gap > r.top_panel_max and run == "":
        ctx.issues.append(Issue(
            level="warning", code="top_filler_tall",
            message=f"До потолка {to_mm(gap):g} мм — высокая фальш-панель. Лучше верхние модули до потолка "
                    "(больше места для хранения)", path=issue_path,
            fixes=[Fix(description="Верхние модули до потолка",
                       patch=[PatchOp(op="replace", path="/wall_to_ceiling", value=True),
                              PatchOp(op="remove", path="/top_filler")])]))
    mat = tfill.material or ctx.fronts_material
    tm = material(mat).thickness
    e = r.edge_front
    n = 0
    for a, b, y_face, row, z in segments:
        seg_gap = gap - (z - top)
        if seg_gap < r.filler_min:
            continue
        blank = seg_gap + mm(tfill.scribe)
        for xa, xb in _pieces(a, b, _usable(ctx)):
            n += 1
            mod = f"{row}{run}.top_filler"
            ctx.add_part(key=f"{mod}[{n}]", name="Добор до потолка", role="niche_filler", module=mod,
                         material_id=mat, length=xb - xa, width=blank,
                         placement=Placement(origin=at(xa, y_face, z), **FRONTAL), edges={"y0": e})
            if seg_gap >= ctx.t:
                ctx.add_part(key=f"{mod}.strip[{n}]", name="Планка крепления добора", role="filler_strip",
                             module=mod, material_id=k.body.material, length=xb - xa, width=r.filler_strip_width,
                             placement=Placement(origin=at(xa, y_face + tm, z), **HORIZONTAL))
            _fixings(ctx, xb - xa, "strip" if seg_gap >= ctx.t else "screws", mod, "добор до потолка")
    return top + gap + mm(tfill.scribe)


def check_kitchen_back(ctx: BuildContext) -> None:
    k = ctx.product
    if k.body.back.kind == "none":
        n = sum(1 for row in ("base", "base2") for c in getattr(k, row) if c.kind not in ("appliance", "fridge"))
        ctx.run("wall_fixing", count=2 * max(1, n), path="body.back")
