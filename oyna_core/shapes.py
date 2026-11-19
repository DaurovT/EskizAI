"""Формы рамы (docs/shapes_contract.md, §1) и раскладка (§2): контур, обрезка, длины, площади. Только stdlib.

Координаты — мм от левого верхнего угла габарита рамы, y вниз. Все контуры выпуклые, поэтому
«прямоугольник ∩ контур, отступленный внутрь на d» = отсечение прямоугольника полуплоскостями рёбер контура.
У каждого ребра многоугольника есть метка: "r" — сторона прямоугольника, целое число — участок контура
(дуга — один участок из многих хорд, чтобы длину гнутого профиля считать одним куском).
"""
from __future__ import annotations

import math

SHAPES = ("rect", "arch", "circle", "trapezoid", "bevel", "triangle")
ARC_STEP_DEG = 10.0            # дуга — ломаная с шагом не больше 10°
TOL = 2.0                      # допуск круга w = h, мм


# ---------------- ограничения формы ----------------
def shape_problems(shape: str | None, params: dict | None, w: float, h: float) -> list[str]:
    """Пустой список — форма допустима для габарита w × h (таблица §1, «ограничения»)."""
    shape = shape or "rect"
    p = params or {}
    num = lambda k: p.get(k) if isinstance(p.get(k), (int, float)) and not isinstance(p.get(k), bool) else None
    if shape not in SHAPES:
        return [f"неизвестная форма «{shape}»"]
    out = []
    if shape == "arch":
        rise = num("rise")
        if rise is None:
            out.append("арка: нужен подъём rise, мм")
        elif not 50 <= rise <= min(w / 2, h):
            out.append(f"подъём арки {rise:g} мм вне 50–{min(w / 2, h):g} мм")
    elif shape == "circle":
        if abs(w - h) > TOL:
            out.append(f"круглое окно: ширина {w:g} ≠ высоте {h:g}")
    elif shape == "trapezoid":
        hl, hr = num("h_left"), num("h_right")
        if hl is None or hr is None:
            out.append("трапеция: нужны h_left и h_right, мм")
        elif abs(max(hl, hr) - h) > 0.5:
            out.append(f"трапеция: большая сторона ({max(hl, hr):g}) должна быть равна высоте рамы {h:g}")
        elif min(hl, hr) < 300:
            out.append(f"трапеция: низкая сторона {min(hl, hr):g} мм меньше 300 мм")
        elif min(hl, hr) <= 0:
            out.append("трапеция: стороны больше нуля")
    elif shape == "bevel":
        corner, dx, dy = p.get("corner"), num("dx"), num("dy")
        if corner not in ("tl", "tr", "both"):
            out.append("скос: corner = tl | tr | both")
        elif dx is None or dy is None or dx <= 0 or dy <= 0:
            out.append("скос: нужны катеты dx, dy > 0, мм")
        else:
            if corner == "both" and (dx >= w / 2 or dy >= h / 2):
                out.append(f"скос двух углов: dx {dx:g} должен быть меньше {w / 2:g}, dy {dy:g} — меньше {h / 2:g}")
            if dx > w - 300:
                out.append(f"скос: dx {dx:g} мм больше {w - 300:g} (ширина − 300)")
            if dy >= h:
                out.append(f"скос: dy {dy:g} мм не меньше высоты рамы")
    elif shape == "triangle":
        apex = num("apex")
        if apex is None or not 0 <= apex <= w:
            out.append(f"треугольник: вершина apex 0–{w:g} мм")
        if h < 300:
            out.append(f"треугольник: высота {h:g} мм меньше 300 мм")
    return out


# ---------------- контур ----------------
def _arc(cx, cy, r, a0, a1, step=ARC_STEP_DEG):
    """Точки дуги от угла a0 до a1 (градусы, против часовой в обычных осях; y вниз → y = cy − r·sin)."""
    n = max(2, math.ceil(abs(a1 - a0) / step))
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy - r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def contour(shape: str | None, params: dict | None, w: float, h: float):
    """Наружный контур рамы: (точки, метки рёбер, участки).

    Участок — {"kind": "line" | "arc", "bent": bool}. Ребро i идёт от точки i к точке i+1 (замкнуто).
    Точки — по часовой (на экране) от левого нижнего угла.
    """
    shape = shape or "rect"
    p = params or {}
    pts, tags, segs = [], [], []

    def seg(kind, bent=False):
        segs.append({"kind": kind, "bent": bent})
        return len(segs) - 1

    def poly(points, kinds):
        for pt, k in zip(points, kinds):
            pts.append(pt)
            tags.append(k)

    if shape == "rect":
        poly([(0, h), (0, 0), (w, 0), (w, h)], [seg("line"), seg("line"), seg("line"), seg("line")])
    elif shape == "arch":
        rise = float(p["rise"])
        c = w / 2
        R = (c * c + rise * rise) / (2 * rise)
        cy = R                                   # центр окружности под вершиной (w/2, 0)
        phi = math.degrees(math.asin(min(1.0, c / R)))
        if rise > c - 1e-9:                      # больше полуокружности не бывает (rise ≤ w/2)
            phi = 90.0
        a0, a1 = 90 + phi, 90 - phi              # от левой пяты к правой
        arc = _arc(w / 2, cy, R, a0, a1)
        arc[0], arc[-1] = (0.0, rise), (float(w), rise)
        left, a, right, bottom = seg("line"), seg("arc", True), seg("line"), seg("line")
        if h - rise > 0.5:
            poly([(0, h)], [left])
        poly(arc[:-1], [a] * (len(arc) - 1))
        if h - rise > 0.5:
            poly([(w, rise), (w, h)], [right, bottom])
        else:                                    # полукруг: пяты на низу рамы
            poly([(w, rise)], [bottom])
    elif shape == "circle":
        r = w / 2
        a = seg("arc", True)
        n = max(36, math.ceil(360 / ARC_STEP_DEG))
        for i in range(n):
            ang = math.radians(270 - 360 * i / n)            # от низа по часовой на экране
            pts.append((r + r * math.cos(ang), r - r * math.sin(ang)))
            tags.append(a)
    elif shape == "trapezoid":
        hl, hr = float(p["h_left"]), float(p["h_right"])
        poly([(0, h), (0, h - hl), (w, h - hr), (w, h)], [seg("line"), seg("line"), seg("line"), seg("line")])
    elif shape == "bevel":
        dx, dy, corner = float(p["dx"]), float(p["dy"]), p["corner"]
        if corner == "tl":
            poly([(0, h), (0, dy), (dx, 0), (w, 0), (w, h)], [seg("line") for _ in range(5)])
        elif corner == "tr":
            poly([(0, h), (0, 0), (w - dx, 0), (w, dy), (w, h)], [seg("line") for _ in range(5)])
        else:
            poly([(0, h), (0, dy), (dx, 0), (w - dx, 0), (w, dy), (w, h)], [seg("line") for _ in range(6)])
    elif shape == "triangle":
        apex = float(p["apex"])
        pts_ = [(0, h), (apex, 0), (w, h)]
        if apex <= 0.5:
            pts_ = [(0, h), (0, 0), (w, h)]
        elif apex >= w - 0.5:
            pts_ = [(0, h), (w, 0), (w, h)]
        poly(pts_, [seg("line") for _ in pts_])
    else:
        raise ValueError(f"форма {shape}")
    return pts, tags, segs


# ---------------- многоугольники ----------------
def area(pts) -> float:
    n = len(pts)
    return abs(sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))) / 2 if n > 2 else 0.0


def _signed(pts) -> float:
    n = len(pts)
    return sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n)) / 2


def perimeter(pts) -> float:
    n = len(pts)
    return sum(math.dist(pts[i], pts[(i + 1) % n]) for i in range(n)) if n > 1 else 0.0


def bbox(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def rect_poly(x0, y0, x1, y1):
    return [(x0, y1), (x0, y0), (x1, y0), (x1, y1)], ["r", "r", "r", "r"]


def _halfplanes(cont, offset):
    """Полуплоскости рёбер контура, сдвинутые внутрь на offset: (a, b, c, tag): внутри, если a·x + b·y ≥ c."""
    pts, tags, _ = cont
    s = 1.0 if _signed(pts) > 0 else -1.0
    out = []
    n = len(pts)
    for i in range(n):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % n]
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 1e-9:
            continue
        # cross(B−A, P−A) · s ≥ offset · L   →  a·x + b·y ≥ c
        a, b = -(y1 - y0) * s / L, (x1 - x0) * s / L
        c = a * x0 + b * y0 + offset
        out.append((a, b, c, tags[i]))
    return out


def clip(poly, cont, offset):
    """Многоугольник (точки, метки) ∩ контур, отступленный внутрь на offset. → (точки, метки)."""
    pts, tags = list(poly[0]), list(poly[1])
    for a, b, c, t in _halfplanes(cont, offset):
        if not pts:
            break
        out_p, out_t = [], []
        n = len(pts)
        for i in range(n):
            S, E, tg = pts[i], pts[(i + 1) % n], tags[i]
            ds, de = a * S[0] + b * S[1] - c, a * E[0] + b * E[1] - c
            sin, ein = ds >= -1e-9, de >= -1e-9
            if sin:
                out_p.append(S)
                out_t.append(tg)
                if not ein:
                    k = ds / (ds - de)
                    out_p.append((S[0] + (E[0] - S[0]) * k, S[1] + (E[1] - S[1]) * k))
                    out_t.append(t)
            elif ein:
                k = ds / (ds - de)
                out_p.append((S[0] + (E[0] - S[0]) * k, S[1] + (E[1] - S[1]) * k))
                out_t.append(tg)
        # убрать совпадающие точки
        cp, ct = [], []
        for p_, t_ in zip(out_p, out_t):
            if cp and math.dist(cp[-1], p_) < 1e-6:
                ct[-1] = t_
                continue
            cp.append(p_)
            ct.append(t_)
        if len(cp) > 1 and math.dist(cp[0], cp[-1]) < 1e-6:
            cp.pop()
            ct.pop()
        pts, tags = (cp, ct) if len(cp) >= 3 else ([], [])
    return pts, tags


def chains(pts, tags, segs=None):
    """Длины кусков профиля по многоугольнику: подряд идущие рёбра одного участка контура — один кусок.

    → [(длина, гнутый)]. Стороны прямоугольника ("r") — каждая своим куском.
    """
    n = len(pts)
    if n < 3:
        return []
    edges = [(math.dist(pts[i], pts[(i + 1) % n]), tags[i]) for i in range(n)]
    # начать с границы участков, чтобы дуга не разрезалась на два куска
    start = next((i for i in range(n) if edges[i][1] == "r" or edges[i][1] != edges[i - 1][1]), 0)
    edges = edges[start:] + edges[:start]
    out = []
    for L, t in edges:
        if L < 0.5:
            continue
        bent = t != "r" and segs is not None and segs[t]["bent"]
        if out and t != "r" and out[-1][2] == t:
            out[-1][0] += L
        else:
            out.append([L, bent, t])
    return [(round(L, 1), b) for L, b, _ in out]


def inside(pts, pt, eps=1e-6) -> bool:
    """Точка внутри выпуклого многоугольника."""
    n = len(pts)
    s = 1.0 if _signed(pts) > 0 else -1.0
    for i in range(n):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % n]
        if ((x1 - x0) * (pt[1] - y0) - (y1 - y0) * (pt[0] - x0)) * s < -eps:
            return False
    return True


def clip_segment(p0, p1, cont, offset):
    """Отрезок ∩ контур, отступленный на offset (для импостов под дугой). → (p0', p1') или None."""
    t0, t1 = 0.0, 1.0
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    for a, b, c, _ in _halfplanes(cont, offset):
        f0 = a * p0[0] + b * p0[1] - c
        df = a * dx + b * dy
        if abs(df) < 1e-12:
            if f0 < -1e-9:
                return None
            continue
        t = -f0 / df
        if df > 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return None
    return (p0[0] + dx * t0, p0[1] + dy * t0), (p0[0] + dx * t1, p0[1] + dy * t1)


def _chord(pts, p0, p1):
    """Отрезок p0→p1 ∩ выпуклый многоугольник pts."""
    cont = (pts, list(range(len(pts))), [{"kind": "line", "bent": False}] * len(pts))
    return clip_segment(p0, p1, cont, 0.0)


# ---------------- раскладка ----------------
def muntin_layout(pts, pattern: str, v: int = 0, h: int = 0) -> dict:
    """Прутки раскладки в видимом стекле ячейки (pts — выпуклый многоугольник).

    → {"bars": [ломаные], "lengths": [мм], "crosses": шт, "min_piece": мм}. min_piece — самый короткий кусок
    прутка между пересечениями и краем (для правила 5.22).
    """
    out = {"bars": [], "lengths": [], "crosses": 0, "min_piece": None}
    if not pts or pattern == "decor":
        return out
    x0, y0, x1, y1 = bbox(pts)
    pieces = []
    if pattern == "cross":
        pattern, v, h = "grid", 1, 1
    if pattern == "grid":
        xs = [x0 + (x1 - x0) * i / (v + 1) for i in range(1, v + 1)]
        ys = [y0 + (y1 - y0) * j / (h + 1) for j in range(1, h + 1)]
        vert, hor = [], []
        for x in xs:
            s = _chord(pts, (x, y0 - 1), (x, y1 + 1))
            if s:
                vert.append(s)
        for y in ys:
            s = _chord(pts, (x0 - 1, y), (x1 + 1, y))
            if s:
                hor.append(s)
        for s in vert:
            cuts = sorted([s[0][1], s[1][1]] + [y for y in ys if s[0][1] < y < s[1][1]])
            pieces += [b - a for a, b in zip(cuts, cuts[1:])]
        for s in hor:
            cuts = sorted([s[0][0], s[1][0]] + [x for x in xs if s[0][0] < x < s[1][0]])
            pieces += [b - a for a, b in zip(cuts, cuts[1:])]
        out["crosses"] = sum(1 for x in xs for y in ys if inside(pts, (x, y), eps=-1e-6))
        out["bars"] = [[a, b] for a, b in vert + hor]
    elif pattern == "sun":
        cx, cy = (x0 + x1) / 2, y1                       # центр низа дуги
        def ray(ang):
            d = (math.cos(ang), -math.sin(ang))
            s = _chord(pts, (cx, cy), (cx + d[0] * 1e5, cy + d[1] * 1e5))
            return math.dist(s[0], s[1]) if s else 0.0
        R = ray(math.pi / 2)
        rays = [math.pi * k / (v + 1) for k in range(1, v + 1)]
        radii = [R * j / (h + 1) for j in range(1, h + 1)]
        for a in rays:
            L = ray(a)
            if L > 0:
                out["bars"].append([(cx, cy), (cx + L * math.cos(a), cy - L * math.sin(a))])
                rs = [r for r in radii if r < L]
                cuts = [0.0] + rs + [L]
                pieces += [b - a_ for a_, b in zip(cuts, cuts[1:])]
                out["crosses"] += len(rs)
        for r in radii:
            ring = [(cx + r * math.cos(math.radians(a)), cy - r * math.sin(math.radians(a))) for a in range(0, 181, 5)]
            ring = [p for p in ring if inside(pts, p, eps=1e-3)]
            if len(ring) >= 2:
                out["bars"].append(ring)
                if v:
                    pieces.append(r * math.pi / (v + 1))
    out["lengths"] = [round(sum(math.dist(b[i], b[i + 1]) for i in range(len(b) - 1)), 1) for b in out["bars"]]
    pieces = [p for p in pieces if p > 0.5]
    out["min_piece"] = round(min(pieces), 1) if pieces else None
    return out
