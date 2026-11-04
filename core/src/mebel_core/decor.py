"""Декор фасадов: фрезеровка, накладной декор, металлические вставки, покраска, скругление углов,
ручки Gola (docs/decor_contract.md).

Пути строятся в «рисунке фасада» (u — вправо, v — вверх, как видит клиент) и переводятся в систему
детали: у двери длина идёт вверх (x = v, y = u), у фасада ящика — вправо (x = u, y = v).
Путь — осевая линия фрезы/профиля; inset — от края фасада до осевой.
"""

from __future__ import annotations

import math
import re

from .assembler import BuildContext
from .catalog import MATERIALS, material
from .geometry import ArcSeg, Contour, LineSeg
from .operations import rounded_rect
from .parts import DecorPath, Fix, Issue, Part, PartDecor, PatchOp
from .schema import FrontStyle
from .units import mm, to_mm

DECOR_VERSION = "0.1.0"
PAINT_MDF_ID = "mdf_19_paint"  # МДФ под покраску (каталог); нет в каталоге — исправление не предлагается

MIN_INSET = mm(40)  # от края фасада до фрезеровки
MIN_REST = mm(6)  # остаток толщины под фрезеровкой
MIN_PANEL = mm(60)  # меньше места внутри рисунка — фасад оставляем гладким
CUP_REST = mm(3)  # между чашкой петли и фрезеровкой с лица
INLAY_DEPTH = mm(4)  # паз под Т-профиль вставки
OVERLAY_PROFILES = {"flat_20": (mm(20), mm(6), "flat"), "round_25": (mm(25), mm(10), "round")}
GOLA_NOTCH = (mm(58), mm(27))  # вырез в боковине под профиль Gola: высота × глубина
GOLA_DROP = mm(30)  # фасад ниже на столько — щель для пальцев
FRONT_ROLES = ("door", "drawer_front")

MILLING_NAMES = {"shaker": "Шейкер", "classic": "Классика", "arcs": "Арка", "rhombus": "Ромб",
                 "grooves_v": "Рифление вертикальное", "grooves_h": "Рифление горизонтальное", "waves": "Волны"}
OVERLAY_NAMES = {"frame": "Рамка", "arch": "Арка", "rhombus": "Ромб", "moulding": "Двойной молдинг"}
INLAY_NAMES = {"frame": "рамка", "line_h": "полоса поперёк", "line_v": "полоса вдоль", "edge": "кант по краю"}
FINISH_NAMES = {"brass": "латунь", "gold": "золото", "black": "чёрный", "chrome": "хром"}
GLOSS_NAMES = {"matte": "матовая", "satin": "полуматовая", "gloss": "глянцевая"}


# ---------- Пути в рисунке фасада ----------


def _rect(x0: int, y0: int, x1: int, y1: int, r: int = 0) -> Contour:
    r = max(0, min(r, (x1 - x0) // 2, (y1 - y0) // 2))
    c = rounded_rect(x1 - x0, y1 - y0, {k: r for k in ("x0y0", "x1y0", "x1y1", "x0y1")})
    return _shift(c, x0, y0)


def _shift(c: Contour, dx: int, dy: int) -> Contour:
    segs = []
    for s in c.segments:
        if isinstance(s, ArcSeg):
            segs.append(ArcSeg(x=s.x + dx, y=s.y + dy, cx=s.cx + dx, cy=s.cy + dy, clockwise=s.clockwise))
        else:
            segs.append(LineSeg(x=s.x + dx, y=s.y + dy))
    return Contour(start_x=c.start_x + dx, start_y=c.start_y + dy, segments=segs)


def _poly(points: list[tuple[int, int]], closed: bool) -> Contour:
    pts = list(points) + ([points[0]] if closed else [])
    return Contour(start_x=round(pts[0][0]), start_y=round(pts[0][1]),
                   segments=[LineSeg(x=round(x), y=round(y)) for x, y in pts[1:]])


def _arch(w: int, h: int, i: int) -> Contour | None:
    """Рамка с аркой сверху; стрела арки — от ширины (четверть хорды), не выше трети высоты."""
    c = w - 2 * i
    s = round(min(c * 0.25, (h - 2 * i) * 0.33))
    if c <= 0 or s <= 0:
        return None
    R = (c * c / 4 + s * s) / (2 * s)
    top = h - i
    return Contour(start_x=i, start_y=i, segments=[
        LineSeg(x=w - i, y=i), LineSeg(x=w - i, y=top - s),
        ArcSeg(x=i, y=top - s, cx=w // 2, cy=round(top - R), clockwise=False),
        LineSeg(x=i, y=i),
    ])


def _diamonds(x0: int, y0: int, x1: int, y1: int) -> list[Contour]:
    """Ромб; на вытянутой области — решётка из ромбов вдоль длинной стороны."""
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return []
    out = []
    if h >= w:
        n = max(1, round(h / (w * 1.4)))
        step = h / n
        for k in range(n):
            a, b = y0 + k * step, y0 + (k + 1) * step
            out.append(_poly([((x0 + x1) / 2, a), (x1, (a + b) / 2), ((x0 + x1) / 2, b), (x0, (a + b) / 2)], True))
    else:
        n = max(1, round(w / (h * 1.4)))
        step = w / n
        for k in range(n):
            a, b = x0 + k * step, x0 + (k + 1) * step
            out.append(_poly([((a + b) / 2, y0), (b, (y0 + y1) / 2), ((a + b) / 2, y1), (a, (y0 + y1) / 2)], True))
    return out


def _parallel(w: int, h: int, i: int, pitch: int, vertical: bool) -> list[Contour]:
    span = (w if vertical else h) - 2 * i
    if span < 0:
        return []
    n = span // pitch + 1
    first = ((w if vertical else h) - (n - 1) * pitch) // 2
    out = []
    for k in range(n):
        c = first + k * pitch
        out.append(_poly([(c, i), (c, h - i)] if vertical else [(i, c), (w - i, c)], False))
    return out


def _waves(w: int, h: int, i: int, pitch: int) -> list[Contour]:
    amp = max(mm(4), round(pitch * 0.3))
    span = w - 2 * i
    k = max(2, round(span / mm(90)))
    chord = span / k
    R = (chord * chord / 4 + amp * amp) / (2 * amp)
    rows = max(1, (h - 2 * i - 2 * amp) // pitch + 1)
    first = (h - (rows - 1) * pitch) // 2
    out = []
    for r in range(rows):
        y = first + r * pitch
        segs = []
        for j in range(k):
            a, b = i + j * chord, i + (j + 1) * chord
            up = j % 2 == 0
            cy = y - (R - amp) if up else y + (R - amp)
            segs.append(ArcSeg(x=round(b), y=y, cx=round((a + b) / 2), cy=round(cy), clockwise=up))
        out.append(Contour(start_x=i, start_y=y, segments=segs))
    return out


def milling_paths(pattern: str, w: int, h: int, i: int, width: int, radius: int, pitch: int) -> list[tuple[Contour, bool]]:
    """Пути фрезы для рисунка фасада w × h (dmm): [(путь, замкнут)]."""
    if pattern == "shaker":
        return [(_rect(i, i, w - i, h - i, radius), True)]
    if pattern == "classic":
        out = [(_rect(i, i, w - i, h - i, max(radius, mm(15))), True)]
        j = i + max(mm(25), 3 * width)
        if min(w, h) - 2 * j >= MIN_PANEL:
            out.append((_rect(j, j, w - j, h - j, max(radius, mm(15))), True))
        return out
    if pattern == "arcs":
        a = _arch(w, h, i)
        return [(a, True)] if a else []
    if pattern == "rhombus":
        g = i + max(mm(20), 2 * width)
        return [(_rect(i, i, w - i, h - i, radius), True)] + [(d, True) for d in _diamonds(g, g, w - g, h - g)]
    if pattern in ("grooves_v", "grooves_h"):
        return [(c, False) for c in _parallel(w, h, i, pitch, pattern == "grooves_v")]
    if pattern == "waves":
        return [(c, False) for c in _waves(w, h, i, pitch)]
    return []


def overlay_paths(pattern: str, w: int, h: int, i: int, pw: int) -> list[tuple[Contour, bool]]:
    if pattern == "frame":
        return [(_rect(i, i, w - i, h - i), True)]
    if pattern == "arch":
        a = _arch(w, h, i)
        return [(a, True)] if a else []
    if pattern == "rhombus":
        g = i + 2 * pw
        return [(_rect(i, i, w - i, h - i), True)] + [(d, True) for d in _diamonds(g, g, w - g, h - g)]
    if pattern == "moulding":
        j = i + round(pw * 2.5)
        out = [(_rect(i, i, w - i, h - i), True)]
        if min(w, h) - 2 * j >= MIN_PANEL:
            out.append((_rect(j, j, w - j, h - j), True))
        return out
    return []


def inlay_paths(kind: str, w: int, h: int, i: int, width: int, handle_right: bool) -> list[tuple[Contour, bool]]:
    """line_h / line_v идут через весь фасад (паз выходит на торцы); edge — кант по периметру."""
    if kind == "frame":
        return [(_rect(i, i, w - i, h - i), True)]
    if kind == "line_h":
        y = h - i if h - 2 * i >= MIN_PANEL else h // 2
        return [(_poly([(0, y), (w, y)], False), False)]
    if kind == "line_v":
        x = (w - i if handle_right else i) if w - 2 * i >= MIN_PANEL else w // 2
        return [(_poly([(x, 0), (x, h)], False), False)]
    if kind == "edge":
        e = width // 2
        return [(_rect(e, e, w - e, h - e), True)]
    return []


# ---------- Перевод в систему детали ----------


def _swap(c: Contour) -> Contour:
    """(u, v) → (x = v, y = u): зеркалит обход, поэтому дуги меняют направление."""
    segs = []
    for s in c.segments:
        if isinstance(s, ArcSeg):
            segs.append(ArcSeg(x=s.y, y=s.x, cx=s.cy, cy=s.cx, clockwise=not s.clockwise))
        else:
            segs.append(LineSeg(x=s.y, y=s.x))
    return Contour(start_x=c.start_y, start_y=c.start_x, segments=segs)


def _upright(p: Part) -> bool:
    """Длина детали идёт вверх (дверь)."""
    return p.placement.u[1] == "Z"


def front_frame(p: Part) -> tuple[int, int]:
    """Ширина и высота фасада как его видит клиент."""
    return (p.width, p.length) if _upright(p) else (p.length, p.width)


def to_part(p: Part, c: Contour) -> Contour:
    return _swap(c) if _upright(p) else c


def path_points(c: Contour, step_deg: float = 10) -> list[tuple[float, float]]:
    """Путь → ломаная (дуги — отрезками по ~10°)."""
    pts = [(float(c.start_x), float(c.start_y))]
    for s in c.segments:
        if isinstance(s, ArcSeg):
            (px, py), cx, cy = pts[-1], s.cx, s.cy
            a1, a2 = math.atan2(py - cy, px - cx), math.atan2(s.y - cy, s.x - cx)
            sweep = -((a1 - a2) % (2 * math.pi)) if s.clockwise else (a2 - a1) % (2 * math.pi)
            r = math.hypot(px - cx, py - cy)
            n = max(2, int(abs(math.degrees(sweep)) / step_deg))
            for k in range(1, n):
                a = a1 + sweep * k / n
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        pts.append((float(s.x), float(s.y)))
    return pts


def path_length(c: Contour) -> int:
    pts = path_points(c, 3)
    return round(sum(math.dist(a, b) for a, b in zip(pts, pts[1:])))


def _seg_dist(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _conflicts(p: Part, paths: list[Contour], half: int, depth: int) -> list[str]:
    """Отверстия, которые задевает полоса пути: сквозные — всегда, чашки петель с обратной стороны —
    если вместе с фрезеровкой остаётся меньше CUP_REST."""
    out = []
    for hole in p.holes:
        if hole.face not in ("A", "B"):
            continue
        through = hole.depth == 0
        if not through and hole.depth + depth <= p.thickness - CUP_REST:
            continue
        for c in paths:
            pts = path_points(c)
            d = min(_seg_dist(hole.x, hole.y, *a, *b) for a, b in zip(pts, pts[1:]))
            if d < hole.diameter / 2 + half + mm(1):
                out.append(hole.purpose)
                break
    return out


# ---------- Стиль фасада: изделие + переопределение ----------

_RE = [
    (re.compile(r"^sections\[(\d+)\]\.fill\[(\d+)\]\.doors"), lambda m, t: (
        t.sections[int(m[1])].fill[int(m[2])].doors, f"/sections/{m[1]}/fill/{m[2]}/doors/style")),
    (re.compile(r"^sections\[(\d+)\]\.fill\[(\d+)\]\.drawer"), lambda m, t: (
        t.sections[int(m[1])].fill[int(m[2])], f"/sections/{m[1]}/fill/{m[2]}/style")),
    (re.compile(r"^sections\[(\d+)\]\.doors"), lambda m, t: (
        t.sections[int(m[1])].doors, f"/sections/{m[1]}/doors/style")),
]
_ROW = re.compile(r"^(base2?|wall2?)(?:\[(\d+)\]|\.corner)")


def _override(ctx: BuildContext, key: str) -> tuple[FrontStyle | None, str | None]:
    t = ctx.product
    try:
        if getattr(t, "type", "") == "kitchen":
            m = _ROW.match(key)
            if not m:
                return None, None
            row = m[1]
            if m[2] is None:  # крыло Г-образного углового модуля — стиль углового модуля первого ряда
                idx = next((i for i, c in enumerate(t.base) if c.kind == "corner"), None)
                row = "base"
            else:
                idx = int(m[2])
                cabs = getattr(t, row)
                if row.endswith("2") and t.corner_side == "left":  # второй ряд слева строится в обратном порядке
                    idx = len(cabs) - 1 - idx
            if idx is None:
                return None, None
            return getattr(t, row)[idx].style, f"/{row}/{idx}/style"
        for rx, get in _RE:
            m = rx.match(key)
            if m:
                owner, ptr = get(m, t)
                return (owner.style if owner is not None else None), ptr
    except (IndexError, AttributeError):
        pass
    return None, None


def resolve_style(ctx: BuildContext, key: str) -> dict[str, tuple[object, str]]:
    """Поле стиля → (значение, JSON Pointer источника)."""
    base = ctx.product.fronts.style
    own, ptr = _override(ctx, key)
    out = {}
    for f in ("milling", "overlay", "inlay", "paint", "corners"):
        if own is not None and getattr(own, f) is not None:
            out[f] = (getattr(own, f), f"{ptr}/{f}")
        else:
            out[f] = (getattr(base, f), f"/fronts/style/{f}")
    return out


def has_decor(product) -> bool:
    def used(s: FrontStyle | None) -> bool:
        return s is not None and any(getattr(s, f) is not None for f in ("milling", "overlay", "inlay", "paint", "corners"))

    if used(product.fronts.style):
        return True
    if getattr(product, "type", "") == "kitchen":
        return any(used(c.style) for row in ("base", "wall", "base2", "wall2") for c in getattr(product, row))
    for s in product.sections:
        if s.doors is not None and used(s.doors.style):
            return True
        for z in s.fill:
            if used(getattr(z, "style", None)) or (getattr(z, "doors", None) is not None and used(z.doors.style)):
                return True
    return False


# ---------- Проход по фасадам ----------


def apply_decor(ctx: BuildContext) -> None:
    p = ctx.product
    gola = p.fronts.handles.kind == "gola"
    if not has_decor(p) and not gola and not p.lighting:
        return
    ctx.module_versions["decor"] = DECOR_VERSION
    reported: set[str] = set()
    skipped: dict[str, int] = {}
    shifted: dict[str, int] = {}
    conflict: dict[str, set] = {}
    need_mdf: set[str] = set()
    if gola:
        _gola(ctx)

    for part in ctx.parts:
        if part.role not in FRONT_ROLES:
            continue
        style = resolve_style(ctx, part.key)
        mat = material(part.material)
        T = part.thickness
        w, h = front_frame(part)
        decor = PartDecor()
        milling, mptr = style["milling"]
        overlay, _ = style["overlay"]
        inlay, iptr = style["inlay"]
        paint, pptr = style["paint"]
        corners, cptr = style["corners"]

        # Покраска
        if paint is not None:
            if mat.kind != "mdf":
                need_mdf.add("покраска")
            decor.paint = {"color": paint.color, "code": paint.code, "system": paint.system, "gloss": paint.gloss,
                           "both_sides": paint.both_sides}
            part.edges = {}  # крашеный МДФ не кромится — торцы красятся

        mill_inset = 0
        # Фрезеровка
        if milling is not None and milling.pattern != "none":
            if mat.kind != "mdf":
                need_mdf.add("фрезеровка")
            depth, mw = mm(milling.depth), mm(milling.width)
            if depth > T - MIN_REST and mptr not in reported:
                reported.add(mptr)
                limit = to_mm(T - MIN_REST)
                ctx.issues.append(Issue(
                    level="error", code="milling_too_deep",
                    message=f"Фрезеровка {milling.depth:g} мм глубже допустимого: при толщине фасада {to_mm(T):g} мм "
                            f"— не больше {limit:g} мм (под фрезой должно остаться 6 мм)",
                    path=mptr.lstrip("/").replace("/", "."),
                    fixes=[Fix(description=f"Глубина {limit:g} мм",
                               patch=[PatchOp(op="replace", path=f"{mptr}/depth", value=limit)])]))
            if mm(milling.inset) < MIN_INSET and mptr + "i" not in reported:
                reported.add(mptr + "i")
                ctx.issues.append(Issue(
                    level="error", code="milling_inset_small",
                    message=f"Фрезеровка в {milling.inset:g} мм от края — ближе 40 мм фасад может треснуть по краю",
                    path=mptr.lstrip("/").replace("/", "."),
                    fixes=[Fix(description="Отступ 40 мм",
                               patch=[PatchOp(op="replace", path=f"{mptr}/inset", value=40)])]))
            inset = min(mm(milling.inset), max(MIN_INSET, (min(w, h) - MIN_PANEL) // 2))
            if part.role == "drawer_front" and milling.pattern in ("shaker", "classic", "arcs", "rhombus"):
                for hh in part.holes:  # ручка ящика — в центр филёнки, а не на линию фрезы
                    if hh.purpose == "ручка" and not _upright(part):
                        hh.y = part.width // 2
            if min(w, h) - 2 * inset < MIN_PANEL and milling.pattern not in ("grooves_v", "grooves_h"):
                skipped[MILLING_NAMES[milling.pattern]] = skipped.get(MILLING_NAMES[milling.pattern], 0) + 1
            else:
                paths, moved = _fit(part, lambda i: milling_paths(milling.pattern, w, h, i, mw, mm(milling.radius),
                                                                   mm(milling.pitch)), inset, mw // 2, depth, conflict)
                if moved:
                    shifted[MILLING_NAMES[milling.pattern]] = shifted.get(MILLING_NAMES[milling.pattern], 0) + 1
                decor.milling_pattern = milling.pattern
                mill_inset = inset + mw // 2 if milling.pattern in ("shaker", "classic", "arcs", "rhombus") else 0
                decor.milling = [DecorPath(path=to_part(part, c), closed=cl, width=mw, depth=depth) for c, cl in paths]

        # Накладной декор
        if overlay is not None and overlay.pattern != "none":
            pw, ph, prof = OVERLAY_PROFILES[overlay.profile]
            inset = min(mm(overlay.inset), max(pw, (min(w, h) - MIN_PANEL) // 2))
            if min(w, h) - 2 * inset >= MIN_PANEL // 2:
                paths = overlay_paths(overlay.pattern, w, h, inset, pw)
                decor.overlay_pattern, decor.overlay_profile = overlay.pattern, overlay.profile
                decor.overlay = [DecorPath(path=to_part(part, c), closed=cl, width=pw, height=ph, profile=prof)
                                 for c, cl in paths]

        # Металлические вставки и канты
        if inlay is not None and inlay.kind != "none":
            iw = mm(inlay.width)
            grooved = inlay.kind != "edge"
            if grooved and mat.kind != "mdf":
                need_mdf.add("латунная вставка")
            handle_right = not any(hh.purpose == "чашка петли" and hh.y > part.width / 2 for hh in part.holes)
            inset = min(mm(inlay.inset), max(MIN_INSET, (min(w, h) - MIN_PANEL) // 2))
            if inlay.kind == "frame" and mill_inset:  # рамка-вставка — внутри фрезерованной рамки
                inset = max(inset, mill_inset + iw // 2 + mm(15))
            if inlay.kind == "frame" and min(w, h) - 2 * inset < mm(30):
                skipped["вставка-рамка"] = skipped.get("вставка-рамка", 0) + 1
                inlay = None
        if inlay is not None and inlay.kind != "none":
            gen = lambda i: inlay_paths(inlay.kind, w, h, i, iw, handle_right)  # noqa: E731
            if inlay.kind == "frame":
                paths, _ = _fit(part, gen, inset, iw // 2, INLAY_DEPTH, conflict)
            else:
                paths = gen(inset)
            decor.inlay_kind, decor.inlay_finish = inlay.kind, inlay.finish
            decor.inlay = [DecorPath(path=to_part(part, c), closed=cl, width=iw, depth=INLAY_DEPTH if grooved else 0,
                                     finish=inlay.finish) for c, cl in paths]

        # Скругление углов фасада
        if corners is not None and corners.radius > 0:
            rad = mm(corners.radius)
            if rad * 2 > min(part.length, part.width):
                rad = min(part.length, part.width) // 2
            edge = next(iter(part.edges.values()), None)
            need = ctx.rules.min_edge_radius.get(edge, 0) if edge else 0
            if rad < need and cptr not in reported:
                reported.add(cptr)
                ctx.issues.append(Issue(
                    level="error", code="front_radius_edge",
                    message=f"Кромку фасада не приклеить на радиус {corners.radius:g} мм — минимум "
                            f"{to_mm(need):g} мм (или крашеный МДФ без кромки)",
                    path=cptr.lstrip("/").replace("/", "."),
                    fixes=[Fix(description=f"Радиус {to_mm(need):g} мм",
                               patch=[PatchOp(op="replace", path=f"{cptr}/radius", value=to_mm(need))])]))
            part.contour = rounded_rect(part.length, part.width, {k: rad for k in ("x0y0", "x1y0", "x1y1", "x0y1")})
            decor.radius = rad

        if decor.paint or decor.milling or decor.overlay or decor.inlay or decor.radius:
            part.decor = decor

    if need_mdf:
        _mdf_error(ctx, need_mdf)
    for name, n in skipped.items():
        ctx.warn("decor_front_small", f"Декор «{name}»: {n} фас. слишком узкие для рисунка — оставлены без него",
                 "fronts.style")
    for name, n in shifted.items():
        ctx.warn("decor_shifted", f"Фрезеровка «{name}»: на {n} фас. рисунок отодвинут от края, чтобы не задеть "
                                  "петли и ручки", "fronts.style")
    for name, purposes in conflict.items():
        ctx.warn("decor_hole_conflict", f"{name}: путь проходит через отверстия ({', '.join(sorted(purposes))}) — "
                                        "увеличьте отступ или перенесите ручку", "fronts.style")


def _fit(part: Part, gen, inset: int, half: int, depth: int, conflict: dict) -> tuple[list, bool]:
    """Сдвигает рисунок внутрь (шаг 5 мм, до +40 мм), пока он задевает отверстия."""
    paths = gen(inset)
    for step in range(0, mm(45), mm(5)):
        paths = gen(inset + step)
        if not _conflicts(part, [to_part(part, c) for c, _ in paths], half, depth):
            return paths, step > 0
    paths = gen(inset)
    hits = _conflicts(part, [to_part(part, c) for c, _ in paths], half, depth)
    conflict.setdefault("Декор фасада", set()).update(hits)
    return paths, False


def _mdf_error(ctx: BuildContext, what: set[str]) -> None:
    mat_id = ctx.fronts_material
    fixes = []
    if PAINT_MDF_ID in MATERIALS:
        fixes.append(Fix(description=f"Фасады — {MATERIALS[PAINT_MDF_ID].name}",
                         patch=[PatchOp(op="replace", path="/fronts/material", value=PAINT_MDF_ID)]))
    ctx.issues.append(Issue(
        level="error", code="decor_needs_mdf",
        message=f"{', '.join(sorted(what)).capitalize()} — только по МДФ, а фасады из «{material(mat_id).name}»: "
                "ЛДСП при фрезеровке скалывается, плёнку не покрасить",
        path="fronts.material", fixes=fixes))


# ---------- Gola ----------

_KITCHEN_BASE = re.compile(r"^base2?(\[\d+\]|\.corner)")
_KITCHEN_WALL = re.compile(r"^wall2?\[\d+\]")


def _gola(ctx: BuildContext) -> None:
    """Gola: фасады без ручек; у нижних модулей кухни — вырез в боковинах под профиль и фасады ниже на щель;
    у верхних — профиль под дном; у шкафа — вертикальный профиль у края открывания."""
    nh, nd = GOLA_NOTCH
    fronts = [p for p in ctx.parts if p.role in FRONT_ROLES]
    modules: dict[str, list[Part]] = {}
    for f in fronts:
        m = _KITCHEN_BASE.match(f.key) or _KITCHEN_WALL.match(f.key)
        modules.setdefault(m[0] if m else f.key, []).append(f)
    for mod, fs in modules.items():
        if _KITCHEN_BASE.match(mod):
            # Профиль вдоль верха фасадов (L) и между рядами ящиков (C)
            tops = sorted({_top_z(f) for f in fs})
            for f in fs:
                _drop_top(f, GOLA_DROP)
            sides = [p for p in ctx.parts if p.role == "side" and p.module == mod]
            for s in sides:
                _notch_side(s, tops, nh, nd)
            width = max(_span_x(fs))
            ctx.add_hardware("gola_profile", "Профиль Gola", len(tops), mod, length=width)
        elif _KITCHEN_WALL.match(mod):
            ctx.add_hardware("gola_profile", "Профиль Gola", 1, mod, length=max(_span_x(fs)))
        else:
            for f in fs:
                length = f.length if _upright(f) else f.width
                ctx.add_hardware("gola_profile", "Профиль Gola", 1, f.module, length=length)
        ctx.add_hardware("gola_fittings", "Заглушки и крепёж Gola", len(fs), mod)


def _top_z(f: Part) -> int:
    return f.aabb().max.z


def _span_x(fs: list[Part]) -> list[int]:
    boxes = [f.aabb() for f in fs]
    dx = max(b.max.x for b in boxes) - min(b.min.x for b in boxes)
    dy = max(b.max.y for b in boxes) - min(b.min.y for b in boxes)
    return [dx, dy]


def _drop_top(f: Part, drop: int) -> None:
    """Верх фасада ниже на drop (щель под профиль); низ и отверстия петель не двигаются."""
    if _upright(f):
        f.length -= drop
    elif f.placement.v == "+Z":
        f.width -= drop


def _notch_side(s: Part, tops: list[int], nh: int, nd: int) -> None:
    """Вырезы у переднего края боковины (локальная y = 0) под профиль: верх выреза — на уровне верха
    фасада (до опускания), у верхнего фасада — до верха боковины."""
    if s.placement.u != "+Z":
        return
    z0 = s.placement.origin.z
    cuts = []
    for top in tops:
        x1 = top - z0 + mm(2)
        x1 = s.length if s.length - x1 < mm(20) else x1
        x0 = max(0, x1 - nh)
        if x1 - x0 > 0:
            cuts.append((x0, x1))
    cuts.sort()
    pts = [(0, 0)]
    for x0, x1 in cuts:
        pts += [(x0, 0), (x0, nd), (x1, nd), (x1, 0)]
    pts += [(s.length, 0), (s.length, s.width), (0, s.width)]
    # Убираем повторы (вырез у самого верха)
    clean = [pts[0]]
    for q in pts[1:]:
        if q != clean[-1]:
            clean.append(q)
    s.contour = Contour(start_x=0, start_y=0, segments=[LineSeg(x=x, y=y) for x, y in clean[1:] + [(0, 0)]])


def part_ops(p: Part) -> str:
    """Обработки детали словами — для спецификации и CSV поставщика."""
    ops = []
    d = p.decor
    if d is not None:
        if d.milling:
            m = d.milling[0]
            ops.append(f"фрезеровка «{MILLING_NAMES.get(d.milling_pattern, d.milling_pattern)}» "
                       f"фреза {to_mm(m.width):g} глуб. {to_mm(m.depth):g}")
        if d.inlay:
            fin = FINISH_NAMES.get(d.inlay_finish, d.inlay_finish)
            name = INLAY_NAMES.get(d.inlay_kind, d.inlay_kind)
            groove = f", паз {to_mm(d.inlay[0].width):g}×{to_mm(d.inlay[0].depth):g}" if d.inlay[0].depth else ""
            ops.append(f"вставка {fin}: {name}{groove}")
        if d.overlay:
            ops.append(f"молдинг «{OVERLAY_NAMES.get(d.overlay_pattern, d.overlay_pattern)}» {d.overlay_profile}")
        if d.radius:
            ops.append(f"углы R{to_mm(d.radius):g}")
        if d.paint:
            code = d.paint.get("code") or d.paint.get("color")
            sides = ", 2 стороны" if d.paint.get("both_sides") else ""
            ops.append(f"покраска {code} {GLOSS_NAMES.get(d.paint.get('gloss'), '')}{sides}")
    for g in p.grooves:
        if g.purpose == "паз под LED-профиль":
            ops.append(f"паз LED {to_mm(g.width):g}×{to_mm(g.depth):g}")
    if p.role == "side" and p.contour is not None and len(p.contour.segments) > 4 and p.module.startswith("base"):
        ops.append("вырезы под Gola")
    return "; ".join(ops)
