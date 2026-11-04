"""Операции формы над деталями (раздел 5 PRD, FR-45).

Применяются после сборки, по ключу детали. Координаты — чистовые, мм,
в системе детали (x — длина, y — ширина).
"""

from .assembler import BuildContext
from .geometry import ArcSeg, Contour, LineSeg
from .parts import Groove, Issue, Pocket
from .schema import Cutout, GrooveOp, Pocket as PocketOp, RoundCorner
from .units import mm, to_mm

# Какие стороны примыкают к углу
CORNER_SIDES = {"x0y0": ("x0", "y0"), "x1y0": ("x1", "y0"), "x0y1": ("x0", "y1"), "x1y1": ("x1", "y1")}


def rounded_rect(length: int, width: int, radii: dict[str, int]) -> Contour:
    """Прямоугольник со скруглёнными углами; обход против часовой стрелки от (r00, 0)."""
    r00, r10, r11, r01 = (radii.get(c, 0) for c in ("x0y0", "x1y0", "x1y1", "x0y1"))
    segs = [LineSeg(x=length - r10, y=0)]
    if r10:
        segs.append(ArcSeg(x=length, y=r10, cx=length - r10, cy=r10))
    segs.append(LineSeg(x=length, y=width - r11))
    if r11:
        segs.append(ArcSeg(x=length - r11, y=width, cx=length - r11, cy=width - r11))
    segs.append(LineSeg(x=r01, y=width))
    if r01:
        segs.append(ArcSeg(x=0, y=width - r01, cx=r01, cy=width - r01))
    segs.append(LineSeg(x=0, y=r00))
    if r00:
        segs.append(ArcSeg(x=r00, y=0, cx=r00, cy=r00))
    return Contour(start_x=r00, start_y=0, segments=segs)


def apply_operations(ctx: BuildContext) -> None:
    r = ctx.rules
    radii: dict[str, dict[str, int]] = {}
    for i, op in enumerate(ctx.product.operations):
        path = f"operations[{i}]"
        try:
            part = ctx.part(op.part)
        except KeyError:
            ctx.error("op_unknown_part", f"Операция: деталь «{op.part}» не найдена", path)
            continue
        t, L, W = part.thickness, part.length, part.width

        if isinstance(op, RoundCorner):
            rad = mm(op.radius)
            if rad * 2 > min(L, W):
                ctx.error("radius_too_big", f"Радиус {op.radius} мм больше половины детали «{part.name}»", path)
                continue
            for side in CORNER_SIDES[op.corner]:
                edge = part.edges.get(side)
                if edge and rad < r.min_edge_radius.get(edge, 0):
                    ctx.issues.append(Issue(
                        level="error", code="edge_radius",
                        message=f"«{part.name}»: кромку не приклеить на радиус {op.radius} мм — "
                                f"минимум {to_mm(r.min_edge_radius[edge])} мм",
                        path=path,
                    ))
            radii.setdefault(part.key, {})[op.corner] = rad
            part.contour = rounded_rect(L, W, radii[part.key])

        elif isinstance(op, Cutout):
            x, y, w, h, rad = mm(op.x), mm(op.y), mm(op.width), mm(op.height), mm(op.radius)
            m = r.cutout_min_margin
            if x < m or y < m or x + w > L - m or y + h > W - m:
                ctx.error("cutout_margin", f"«{part.name}»: вырез ближе {to_mm(m)} мм к краю — деталь сломается",
                          path)
                continue
            if 0 < rad < r.cutter_radius or (rad == 0 and r.cutter_radius > 0):
                rad = max(rad, r.cutter_radius)  # внутренние углы всё равно скругляет фреза
            for hole in part.holes:
                if x - m < hole.x < x + w + m and y - m < hole.y < y + h + m and hole.face in ("A", "B"):
                    ctx.warn("cutout_near_hole", f"«{part.name}»: вырез рядом с отверстием ({hole.purpose})", path)
                    break
            c = rounded_rect(w, h, {k: rad for k in CORNER_SIDES})
            c.start_x += x
            c.start_y += y
            for seg in c.segments:
                seg.x += x
                seg.y += y
                if isinstance(seg, ArcSeg):
                    seg.cx += x
                    seg.cy += y
            part.cutouts.append(c)

        elif isinstance(op, GrooveOp):
            off, gw, gd = mm(op.offset), mm(op.width), mm(op.depth)
            if gd * 2 > t:
                ctx.error("groove_too_deep", f"«{part.name}»: паз глубже половины толщины", path)
                continue
            if op.along == "length":
                g = Groove(x0=0, y0=off, x1=L, y1=off + gw, width=gw, depth=gd, face=op.face, purpose="паз")
            else:
                g = Groove(x0=off, y0=0, x1=off + gw, y1=W, width=gw, depth=gd, face=op.face, purpose="паз")
            part.grooves.append(g)

        elif isinstance(op, PocketOp):
            x, y, w, h, d = mm(op.x), mm(op.y), mm(op.width), mm(op.height), mm(op.depth)
            if t - d < r.pocket_min_rest:
                ctx.error("pocket_too_deep", f"«{part.name}»: под выборкой остаётся меньше "
                                             f"{to_mm(r.pocket_min_rest)} мм", path)
                continue
            if x < 0 or y < 0 or x + w > L or y + h > W:
                ctx.error("pocket_outside", f"«{part.name}»: выборка выходит за деталь", path)
                continue
            part.pockets.append(Pocket(x=x, y=y, width=w, height=h, depth=d, face=op.face, purpose="выборка"))
