"""Производственные чертежи (как печатает цех из «Базис-Мебельщика»):

- общий вид: вид спереди с фасадами, разрез, вид сверху; вид без фасадов с цепочками размеров;
  у кухни — высоты от пола, цепочки нижнего и верхнего рядов, план обоих рядов;
- развёртка стен кухни: модули, ширины и положения от угла, высоты, выводы коммуникаций;
- чертежи деталей: контур в масштабе, размеры, таблица отверстий, пазы и выборки, кромка по сторонам,
  направление текстуры, одинаковые детали — одним чертежом с количеством;
- взрыв-схема сборки в изометрии с номерами позиций и ведомость фурнитуры;
- «Комплект чертежей»: титул, виды, развёртка, взрыв-схема, детали, спецификация, карты раскроя.

Чёрное на белом, вектор, на каждом листе — рамка и штамп (sheet.SheetCanvas).
Размеры — мм; внутри ядра — dmm (units.py), здесь всё переводится в мм сразу.
"""

import io
import math
from dataclasses import dataclass
from typing import Callable, Iterable

from reportlab.lib import colors
from reportlab.lib.units import mm as MM
from reportlab.pdfbase import pdfmetrics

from ..assembler import BuildResult
from ..catalog import edge_type, material
from ..parts import Part
from ..spec import SIDE_LABELS, number_ranges
from ..units import to_mm
from .sheet import A4L, STAMP_H, STAMP_W, Box, DocInfo, F, FB, SheetCanvas, fit_text

BLACK = colors.black
GREY_CUT = colors.Color(0.55, 0.55, 0.55)
SHADE_TOP = colors.Color(0.95, 0.95, 0.95)
SHADE_SIDE = colors.Color(0.84, 0.84, 0.84)
WHITE = colors.white

FRONT_ROLES = {"door", "drawer_front", "sliding_fill"}
DRAWER_ROLES = {"drawer_side", "drawer_wall", "drawer_bottom"}
VIEW_SCALES = [5, 10, 15, 20, 25, 40, 50, 75, 100]
PART_SCALES = [1, 2, 2.5, 4, 5, 10, 15, 20, 25, 40, 50]

DIM_FS = 6.3  # кегль размерных чисел, pt
LEVEL = 6.5 * MM  # шаг уровней размерных линий


def fmt(v: float) -> str:
    """1304 → «1304», 397.5 → «397,5», 0.4 → «0,4»."""
    r = round(v, 1)
    if abs(r - round(r)) < 1e-6:
        return str(int(round(r)))
    return f"{r:.1f}".replace(".", ",")


def scale_label(n: float) -> str:
    return f"1:{fmt(n)}"


def pick_scale(need_w_mm: float, need_h_mm: float, avail_w: float, avail_h: float, fixed_w: float = 0,
               fixed_h: float = 0, scales: list[float] = VIEW_SCALES) -> float:
    """Крупнейший стандартный масштаб, при котором need (мм изделия) + fixed (pt) влезает в avail (pt)."""
    for n in scales:
        s = MM / n
        if need_w_mm * s + fixed_w <= avail_w and need_h_mm * s + fixed_h <= avail_h:
            return n
    return scales[-1]


# --- Детали в мм ---

@dataclass
class PB:
    """Габарит детали в изделии, мм."""

    p: Part
    x0: float
    y0: float
    z0: float
    x1: float
    y1: float
    z1: float

    @property
    def c(self) -> tuple[float, float, float]:
        return (self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2, (self.z0 + self.z1) / 2

    def moved(self, dx: float = 0, dy: float = 0, dz: float = 0) -> "PB":
        return PB(self.p, self.x0 + dx, self.y0 + dy, self.z0 + dz, self.x1 + dx, self.y1 + dy, self.z1 + dz)


def boxes(parts: Iterable[Part]) -> list[PB]:
    out = []
    for p in parts:
        b = p.aabb()
        out.append(PB(p, to_mm(b.min.x), to_mm(b.min.y), to_mm(b.min.z), to_mm(b.max.x), to_mm(b.max.y),
                      to_mm(b.max.z)))
    return out


def head(path: str) -> str:
    """«base[1].fill[0]» → «base[1]»."""
    return path.split(".")[0]


# --- Надписи без наложений ---

class Ink:
    """Рисование текста с учётом уже занятых мест на листе."""

    def __init__(self, c: SheetCanvas):
        self.c = c
        self.taken: list[tuple[float, float, float, float]] = []

    @staticmethod
    def rect(x: float, y: float, s: str, size: float, anchor: str = "c", rot: int = 0,
             font: str = F) -> tuple[float, float, float, float]:
        w = pdfmetrics.stringWidth(s, font, size)
        a = {"l": 0.0, "c": 0.5, "r": 1.0}[anchor]
        if rot == 0:
            return x - a * w, y - 0.22 * size, x + (1 - a) * w, y + 0.78 * size
        return x - 0.78 * size, y - a * w, x + 0.22 * size, y + (1 - a) * w

    def free(self, r, pad: float = 0.4) -> bool:
        for t in self.taken:
            if r[0] - pad < t[2] and t[0] < r[2] + pad and r[1] - pad < t[3] and t[1] < r[3] + pad:
                return False
        return True

    def reserve(self, r) -> None:
        self.taken.append(tuple(r))

    def text(self, x: float, y: float, s: str, size: float = DIM_FS, anchor: str = "c", rot: int = 0,
             font: str = F, reserve: bool = True, color=BLACK):
        c = self.c
        c.setFillColor(color)
        c.setFont(font, size)
        if rot:
            c.saveState()
            c.translate(x, y)
            c.rotate(90)
            {"l": c.drawString, "c": c.drawCentredString, "r": c.drawRightString}[anchor](0, 0, s)
            c.restoreState()
        else:
            {"l": c.drawString, "c": c.drawCentredString, "r": c.drawRightString}[anchor](x, y, s)
        r = self.rect(x, y, s, size, anchor, rot, font)
        if reserve:
            self.reserve(r)
        return r

    def place(self, cands: list[tuple[float, float, str, int]], s: str, size: float = DIM_FS, font: str = F,
              force: bool = True):
        """Первое свободное место из кандидатов (x, y, anchor, rot); нет свободных — первое (force)."""
        for x, y, a, rot in cands:
            r = self.rect(x, y, s, size, a, rot, font)
            if self.free(r):
                return self.text(x, y, s, size, a, rot, font), (x, y, a, rot)
        if not force or not cands:
            return None, None
        x, y, a, rot = cands[0]
        return self.text(x, y, s, size, a, rot, font), cands[0]


# --- Линии ---

def thin(c, w: float = 0.3) -> None:
    c.setStrokeColor(BLACK)
    c.setLineWidth(w)
    c.setDash()


def dashed(c, w: float = 0.35, pattern=(2.2, 1.2)) -> None:
    c.setStrokeColor(BLACK)
    c.setLineWidth(w)
    c.setDash(*pattern)


def dashdot(c, w: float = 0.3) -> None:
    c.setStrokeColor(BLACK)
    c.setLineWidth(w)
    c.setDash([5, 1.2, 0.8, 1.2], 0)


def tick(c, x: float, y: float) -> None:
    """Засечка размерной линии (45°)."""
    d = 1.1 * MM
    c.line(x - d, y - d, x + d, y + d)


# --- Размеры ---

def hdim(ink: Ink, x1: float, x2: float, y: float, text: str, ext: float | tuple[float, float] | None = None,
         up: bool = True, size: float = DIM_FS) -> None:
    """Горизонтальный размер на высоте y; ext — откуда тянуть выносные (y точки детали)."""
    c = ink.c
    if x2 < x1:
        x1, x2 = x2, x1
    thin(c, 0.3)
    if ext is not None:
        e1, e2 = ext if isinstance(ext, tuple) else (ext, ext)
        for x, e in ((x1, e1), (x2, e2)):
            sgn = 1 if y > e else -1
            c.line(x, e + sgn * 0.8 * MM, x, y + sgn * 1.4 * MM)
    c.line(x1 - 1.2 * MM, y, x2 + 1.2 * MM, y)
    tick(c, x1, y)
    tick(c, x2, y)
    w = pdfmetrics.stringWidth(text, F, size)
    gap = 0.7 * MM
    ty = y + gap if up else y - gap - 0.78 * size
    row = size + 0.6 * MM
    rows = [ty + k * row * (1 if up else -1) for k in range(3)]
    mid = (x1 + x2) / 2
    if w + 1.2 * MM < x2 - x1:
        cands = [(mid, rows[0], "c", 0), (mid, rows[1], "c", 0), (x2 + 1.6 * MM, rows[0], "l", 0),
                 (x1 - 1.6 * MM, rows[0], "r", 0), (mid, rows[2], "c", 0)]
    else:
        cands = [(x2 + 1.6 * MM, rows[0], "l", 0), (x1 - 1.6 * MM, rows[0], "r", 0), (mid, rows[1], "c", 0),
                 (x2 + 1.6 * MM, rows[1], "l", 0), (x1 - 1.6 * MM, rows[1], "r", 0), (mid, rows[2], "c", 0)]
    _, used = ink.place(cands, text, size)
    if used and used[1] != rows[0] and used[2] == "c":  # число на втором ряду — выноска к линии
        c.line(mid, y, mid, used[1] - (0.2 * size if up else -0.78 * size))


def vdim(ink: Ink, y1: float, y2: float, x: float, text: str, ext: float | tuple[float, float] | None = None,
         left: bool = True, size: float = DIM_FS) -> None:
    """Вертикальный размер на абсциссе x; число — повёрнуто, слева от линии (left) или справа."""
    c = ink.c
    if y2 < y1:
        y1, y2 = y2, y1
    thin(c, 0.3)
    if ext is not None:
        e1, e2 = ext if isinstance(ext, tuple) else (ext, ext)
        for y, e in ((y1, e1), (y2, e2)):
            sgn = 1 if x > e else -1
            c.line(e + sgn * 0.8 * MM, y, x + sgn * 1.4 * MM, y)
    c.line(x, y1 - 1.2 * MM, x, y2 + 1.2 * MM)
    tick(c, x, y1)
    tick(c, x, y2)
    w = pdfmetrics.stringWidth(text, F, size)
    gap = 0.7 * MM
    col = size + 0.6 * MM
    tx = x - gap if left else x + gap + 0.78 * size
    cols = [tx - k * col if left else tx + k * col for k in range(3)]
    mid = (y1 + y2) / 2
    if w + 1.2 * MM < y2 - y1:
        cands = [(cols[0], mid, "c", 90), (cols[1], mid, "c", 90), (cols[0], y2 + 1.6 * MM, "l", 90),
                 (cols[0], y1 - 1.6 * MM, "r", 90), (cols[2], mid, "c", 90)]
    else:
        cands = [(cols[0], y2 + 1.6 * MM, "l", 90), (cols[0], y1 - 1.6 * MM, "r", 90), (cols[1], mid, "c", 90),
                 (cols[1], y2 + 1.6 * MM, "l", 90), (cols[2], mid, "c", 90)]
    _, used = ink.place(cands, text, size)
    if used and used[0] != cols[0] and used[2] == "c":
        c.line(x, mid, used[0] + (0.22 * size if left else -0.78 * size), mid)


def hchain(ink: Ink, xs_model: list[float], X: Callable[[float], float], y: float, ext: float | None,
           up: bool = True, skip_below: float = 0.0) -> None:
    """Цепочка горизонтальных размеров по точкам модели (мм). skip_below — не подписывать отрезки короче."""
    xs = sorted(set(round(v, 1) for v in xs_model))
    for a, b in zip(xs, xs[1:]):
        if b - a < skip_below:
            continue
        hdim(ink, X(a), X(b), y, fmt(b - a), ext, up)


def vchain(ink: Ink, zs_model: list[float], Y: Callable[[float], float], x: float, ext: float | None,
           left: bool = True, skip_below: float = 0.0) -> None:
    zs = sorted(set(round(v, 1) for v in zs_model))
    for a, b in zip(zs, zs[1:]):
        if b - a < skip_below:
            continue
        vdim(ink, Y(a), Y(b), x, fmt(b - a), ext, left)


def v_ordinate(ink: Ink, zs_model: list[float], Y: Callable[[float], float], x: float, left: bool = True,
               prefix: str = "") -> None:
    """Отметки высот от пола: вертикальная база с засечками и числами (абсолютные значения)."""
    c = ink.c
    zs = sorted(set(round(v, 1) for v in zs_model))
    if not zs:
        return
    thin(c, 0.3)
    c.line(x, Y(zs[0]), x, Y(zs[-1]))
    last = -1e9
    step = DIM_FS + 0.8
    for z in zs:
        y = Y(z)
        c.line(x - 1.2 * MM, y, x + 1.2 * MM, y)
        ty = max(y - 0.3 * DIM_FS, last + step)
        tx = x - 1.8 * MM if left else x + 1.8 * MM
        if abs(ty - (y - 0.3 * DIM_FS)) > 0.5:  # сдвинули — короткая выноска
            c.line(x, y, tx + (0.6 * MM if left else -0.6 * MM), ty + 0.3 * DIM_FS)
        ink.text(tx, ty, prefix + fmt(z), DIM_FS, "r" if left else "l")
        last = ty


def h_ordinate(ink: Ink, xs_model: list[float], X: Callable[[float], float], y: float, down: bool = True,
               size: float = 5.6) -> None:
    """Координаты от базы вдоль низа (числа повёрнуты), с отводом, если числа теснятся."""
    c = ink.c
    xs = sorted(set(round(v, 1) for v in xs_model), key=X)
    if not xs:
        return
    thin(c, 0.25)
    last = -1e9
    step = size + 0.6
    for v in xs:
        x = X(v)
        tx = max(x, last + step)
        c.line(x, y, x, y - 1.2 * MM if down else y + 1.2 * MM)
        if down:
            c.line(x, y - 1.2 * MM, tx, y - 2.4 * MM)
            ink.text(tx + 0.3 * size, y - 2.8 * MM, fmt(v), size, "r", 90)
        else:
            c.line(x, y + 1.2 * MM, tx, y + 2.4 * MM)
            ink.text(tx + 0.3 * size, y + 2.8 * MM, fmt(v), size, "l", 90)
        last = tx


def v_ordinate_side(ink: Ink, ys_model: list[float], Y: Callable[[float], float], x: float, left: bool = True,
                    size: float = 5.6) -> None:
    """Координаты от базы вдоль левого края (числа горизонтальные), с отводом."""
    c = ink.c
    ys = sorted(set(round(v, 1) for v in ys_model))
    thin(c, 0.25)
    last = -1e9
    step = size + 0.6
    for v in ys:
        y = Y(v)
        ty = max(y, last + step)
        sgn = -1 if left else 1
        c.line(x, y, x + sgn * 1.2 * MM, y)
        c.line(x + sgn * 1.2 * MM, y, x + sgn * 2.4 * MM, ty)
        ink.text(x + sgn * 2.8 * MM, ty - 0.3 * size, fmt(v), size, "r" if left else "l")
        last = ty


# --- Проекции ---

class View:
    """Ортогональный вид: (u, v) на листе и глубина (меньше — ближе к зрителю).

    front — спереди (u = x, v = z); left — слева, взгляд вдоль +X (u = R − y: фасад справа);
    right — справа, взгляд вдоль −X (u = y − R); top — сверху (u = x, v = y: фасад внизу).
    """

    def __init__(self, kind: str, ref: float = 0.0):
        self.kind, self.ref = kind, ref

    def box(self, b: PB) -> tuple[float, float, float, float, float]:
        k = self.kind
        if k == "front":
            return b.x0, b.x1, b.z0, b.z1, b.y0
        if k == "left":
            return self.ref - b.y1, self.ref - b.y0, b.z0, b.z1, b.x0
        if k == "right":
            return b.y0 - self.ref, b.y1 - self.ref, b.z0, b.z1, -b.x1
        return b.x0, b.x1, b.y0, b.y1, -b.z1  # top

    def pt(self, x: float, y: float, z: float) -> tuple[float, float]:
        k = self.kind
        if k == "front":
            return x, z
        if k == "left":
            return self.ref - y, z
        if k == "right":
            return y - self.ref, z
        return x, y

    def extent(self, bs: list[PB]) -> tuple[float, float, float, float]:
        us = [self.box(b) for b in bs]
        if not us:
            return 0, 1, 0, 1
        return min(u[0] for u in us), max(u[1] for u in us), min(u[2] for u in us), max(u[3] for u in us)


@dataclass
class Xf:
    """Модель (u, v, мм) → лист (pt)."""

    ox: float
    oy: float
    s: float  # pt на мм
    u0: float = 0.0
    v0: float = 0.0

    def X(self, u: float) -> float:
        return self.ox + (u - self.u0) * self.s

    def Y(self, v: float) -> float:
        return self.oy + (v - self.v0) * self.s


def _node_of(result: BuildResult, p: Part):
    if not p.node:
        return None
    return next((n for n in result.nodes if n.id == p.node), None)


def draw_ortho(c: SheetCanvas, result: BuildResult, bs: list[PB], view: View, xf: Xf, *,
               cut: Callable[[PB], bool] | None = None, marks: bool = True, lw: float = 0.45) -> None:
    """Детали прямоугольниками с белой заливкой, от дальних к ближним (ближние закрывают дальние).
    cut — детали в секущей плоскости: рисуются последними, с заливкой «сечение»."""
    items = []
    for b in bs:
        u0, u1, v0, v1, d = view.box(b)
        is_cut = bool(cut and cut(b))
        items.append((is_cut, -d, b, (u0, u1, v0, v1)))
    items.sort(key=lambda t: (t[0], t[1]))
    for is_cut, _, b, (u0, u1, v0, v1) in items:
        x0, x1, y0, y1 = xf.X(u0), xf.X(u1), xf.Y(v0), xf.Y(v1)
        w, h = max(x1 - x0, 0.2), max(y1 - y0, 0.2)
        thin(c, lw if not is_cut else 0.35)
        if is_cut:
            c.setFillColor(GREY_CUT)
            c.rect(x0, y0, w, h, stroke=1, fill=1)
            continue
        c.setFillColor(WHITE)
        c.rect(x0, y0, w, h, stroke=1, fill=1)
        p = b.p
        if not marks:
            continue
        if p.role == "sliding_fill" and "mirror" in p.material and w > 6 and h > 6:
            _mirror_hatch(c, x0, y0, w, h)
        if p.role == "door" and view.kind in ("front", "left", "right") and w > 4 and h > 4:
            node = _node_of(result, p)
            if node is not None and node.kind == "rotate":
                nu, nv = view.pt(*(to_mm(v) for v in node.origin))
                vertical = node.axis[1] == "Z"
                dashed(c, 0.3, (2.5, 1.5))
                if vertical:
                    hinge_left = abs(xf.X(nu) - x0) < abs(xf.X(nu) - x1)
                    hx, ox = (x0, x1) if hinge_left else (x1, x0)
                    c.line(ox, y0, hx, y0 + h / 2)
                    c.line(ox, y1, hx, y0 + h / 2)
                else:
                    hinge_top = abs(xf.Y(nv) - y1) < abs(xf.Y(nv) - y0)
                    hy, oy = (y1, y0) if hinge_top else (y0, y1)
                    c.line(x0, oy, x0 + w / 2, hy)
                    c.line(x1, oy, x0 + w / 2, hy)
                thin(c)


def _mirror_hatch(c, x0: float, y0: float, w: float, h: float) -> None:
    """Зеркало: три косые штриха в углу (условное обозначение стекла)."""
    thin(c, 0.25)
    cx, cy = x0 + w * 0.62, y0 + h * 0.62
    L = min(w, h) * 0.18
    for k in (-1, 0, 1):
        dx = k * 1.6 * MM
        c.line(cx + dx - L / 2, cy - L / 2, cx + dx + L / 2, cy + L / 2)


def view_label(ink: Ink, x: float, y: float, s: str, size: float = 8.5) -> None:
    ink.text(x, y, s, size, "l", font=FB)
    c = ink.c
    w = pdfmetrics.stringWidth(s, FB, size)
    thin(c, 0.4)
    c.line(x, y - 1.0, x + w, y - 1.0)


# --- Разбор изделия ---

def is_kitchen(result: BuildResult) -> bool:
    return getattr(result.product, "type", "wardrobe") == "kitchen"


def product_name(result: BuildResult) -> str:
    p = result.product
    if is_kitchen(result):
        return "Кухня угловая" if p.layout == "corner" else "Кухня прямая"
    if p.builtin:
        return "Шкаф встроенный" + ("-купе" if p.sliding_doors else "")
    if p.sliding_doors:
        return "Шкаф-купе"
    if not any(pt.role in FRONT_ROLES for pt in result.parts):
        return "Стеллаж"
    return "Шкаф распашной"


def product_line(result: BuildResult) -> str:
    w, h, d = (to_mm(v) for v in result.size)
    return f"{product_name(result)} {fmt(w)}×{fmt(h)}×{fmt(d)} мм"


def run_of(p: Part) -> int:
    """Ряд угловой кухни: 2 — второй (base2/wall2/countertop2/цоколь 2), иначе 1."""
    h = head(p.module)
    k = p.key
    if h.startswith(("base2", "wall2", "countertop2")) or k.startswith(("countertop2", "kitchen.plinth2",
                                                                         "base2", "wall2")):
        return 2
    return 1


@dataclass
class Cell:
    """Проём в свету: секция шкафа или модуль кухни (мм)."""

    x0: float
    x1: float
    z0: float
    z1: float
    key: str = ""


def wardrobe_cells(result: BuildResult) -> list[Cell]:
    return [Cell(to_mm(s.x0), to_mm(s.x1), to_mm(s.z0), to_mm(s.z1), s.key) for s in result.sections]


def kitchen_cells(bs: list[PB]) -> list[Cell]:
    """Проёмы модулей первого ряда кухни: между боковинами, от дна до крыши/царг."""
    groups: dict[str, list[PB]] = {}
    for b in bs:
        if run_of(b.p) == 1 and head(b.p.module).startswith(("base[", "wall[")):
            groups.setdefault(head(b.p.module), []).append(b)
    out = []
    for key, g in groups.items():
        sides = sorted((b for b in g if b.p.role == "side"), key=lambda b: b.x0)
        bottoms = [b for b in g if b.p.role == "bottom"]
        tops = [b for b in g if b.p.role in ("top", "rail")]
        if len(sides) < 2 or not bottoms:
            continue
        z0 = max(b.z1 for b in bottoms)
        z1 = min((b.z0 for b in tops if b.z0 > z0), default=max(s.z1 for s in sides))
        out.append(Cell(sides[0].x1, sides[-1].x0, z0, z1, key))
    return out


def cell_levels(cell: Cell, bs: list[PB]) -> list[float]:
    """Отметки полок/перегородок и ящиков в проёме: края полок, низ коробов ящиков."""
    mid = (cell.x0 + cell.x1) / 2
    zs = [cell.z0, cell.z1]
    drawers: dict[str, float] = {}
    for b in bs:
        if not (b.x0 - 1 <= mid <= b.x1 + 1) or b.z1 <= cell.z0 + 1 or b.z0 >= cell.z1 - 1:
            continue
        if b.p.role in ("shelf", "divider", "end_shelf") and b.z1 - b.z0 < 60:
            zs += [b.z0, b.z1]
        elif b.p.role in DRAWER_ROLES and b.p.node:
            drawers[b.p.node] = min(drawers.get(b.p.node, 1e9), b.z0)
    zs += list(drawers.values())
    return sorted(set(round(z, 1) for z in zs if cell.z0 - 0.1 <= z <= cell.z1 + 0.1))


@dataclass
class KitchenHeights:
    legs: float = 0
    base_top: float = 0
    worktop: float = 0
    wall_bottom: float = 0
    wall_top: float = 0
    top: float = 0

    def marks(self) -> list[float]:
        return [v for v in (0, self.legs, self.base_top, self.worktop, self.wall_bottom, self.wall_top, self.top)
                if v or v == 0]


def kitchen_heights(bs: list[PB], run: int | None = None) -> KitchenHeights:
    sel = [b for b in bs if run is None or run_of(b.p) == run]
    base = [b for b in sel if head(b.p.module).startswith("base") and b.p.role == "side"]
    wall = [b for b in sel if head(b.p.module).startswith("wall") and b.p.role in ("side", "top", "bottom")]
    ct = [b for b in sel if b.p.role == "countertop"]
    k = KitchenHeights()
    if base:
        k.legs = min(b.z0 for b in base)
        k.base_top = max(b.z1 for b in base)
    if ct:
        k.base_top = min(b.z0 for b in ct)
        k.worktop = max(b.z1 for b in ct)
    if wall:
        k.wall_bottom = min(b.z0 for b in wall)
        k.wall_top = max(b.z1 for b in wall)
    k.top = max((b.z1 for b in sel), default=0)
    return k


@dataclass
class Mod:
    row: str  # base / wall / base2 / wall2
    index: int
    kind: str
    a: float  # от угла (у прямой — от левого края ряда), мм
    b: float

    @property
    def width(self) -> float:
        return self.b - self.a


def kitchen_mods(result: BuildResult) -> list[Mod]:
    from ..kitchen_site import spans

    tree = result.product.model_dump(mode="json")
    return [Mod(s.row, s.index, s.cab.get("kind", ""), s.a, s.b) for s in spans(tree)]


@dataclass
class WallFrame:
    """Развёртка стены кухни: u — по стене слева направо (как видно из комнаты), мм; corner_u — где угол."""

    wall: str  # a / b
    view: View
    parts: list[PB]
    to_u: Callable[[float], float]  # «от угла» → u на виде
    from_u: Callable[[float], float]
    length: float  # длина стены (по замеру) или ряда
    corner_u: float | None


def kitchen_walls(result: BuildResult, bs: list[PB]) -> list[WallFrame]:
    k = result.product
    corner = k.layout == "corner"
    right = k.corner_side == "right"
    site = k.site
    run1 = [b for b in bs if run_of(b.p) == 1]
    base1 = [b for b in run1 if head(b.p.module).startswith("base[")]
    mods = kitchen_mods(result)
    la = sum(m.width for m in mods if m.row == "base")
    # x левого края нижнего ряда в изделии: по первому модулю, у которого есть детали
    x_start = 0.0
    for m in sorted((m for m in mods if m.row == "base"), key=lambda m: m.index):
        own = [b for b in base1 if head(b.p.module) == f"base[{m.index}]" and b.p.role == "side"]
        if own:
            left_x = min(b.x0 for b in own)
            before = sum(mm.width for mm in mods if mm.row == "base" and mm.index < m.index)
            x_start = left_x - before
            break
    walls: list[WallFrame] = []
    if not corner or right:
        x_corner = x_start + la if corner else x_start
        if corner:  # угол справа: «от угла» = x_corner − x, на виде u = x
            to_u = (lambda d, xc=x_corner: xc - d)
            from_u = (lambda u, xc=x_corner: xc - u)
        else:
            to_u = (lambda d, xs=x_start: xs + d)
            from_u = (lambda u, xs=x_start: u - xs)
    else:  # угол слева
        x_corner = x_start
        to_u = (lambda d, xc=x_corner: xc + d)
        from_u = (lambda u, xc=x_corner: u - xc)
    length_a = site.wall_a if site and site.wall_a else la
    walls.append(WallFrame("a", View("front"), run1, to_u, from_u, length_a,
                           x_corner if corner else None))
    if corner:
        run2 = [b for b in bs if run_of(b.p) == 2]
        y_corner = max(b.y1 for b in bs)
        length_b = site.wall_b if site and site.wall_b else max(
            (m.b for m in mods if m.row in ("base2", "wall2")), default=0)
        if right:  # взгляд вдоль +X: u = y_corner − y = «от угла», угол слева
            view = View("left", y_corner)
            walls.append(WallFrame("b", view, run2, lambda d: d, lambda u: u, length_b, 0.0))
        else:  # взгляд вдоль −X: u = y − y0; угол справа (u = y_corner − y0)
            y0 = y_corner - length_b
            view = View("right", y0)
            uc = y_corner - y0
            walls.append(WallFrame("b", view, run2, lambda d, uc=uc: uc - d, lambda u, uc=uc: uc - u, length_b, uc))
    return walls


# --- Листы видов ---

def _intervals_to_levels(items: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    """Интервалы → уровни размерных линий без наложения (короткие — ближе к изделию)."""
    levels: list[list[tuple[float, float]]] = []
    for a, b in sorted(set(items), key=lambda t: (t[1] - t[0], t[0])):
        for lv in levels:
            if all(b <= x0 + 0.5 or a >= x1 - 0.5 for x0, x1 in lv):
                lv.append((a, b))
                break
        else:
            levels.append([(a, b)])
    return levels


def _front_size_labels(ink: Ink, bs: list[PB], view: View, xf: Xf) -> None:
    """Размер фасада «ширина×высота» прямо на фасаде (как на эскизах цеха)."""
    for b in bs:
        if b.p.role not in FRONT_ROLES:
            continue
        u0, u1, v0, v1, _ = view.box(b)
        x0, x1, y0, y1 = xf.X(u0), xf.X(u1), xf.Y(v0), xf.Y(v1)
        s = f"{fmt(u1 - u0)}×{fmt(v1 - v0)}"
        size = 5.4
        tw = pdfmetrics.stringWidth(s, F, size)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if tw + 2 < x1 - x0 and size + 2 < y1 - y0:
            r = ink.rect(cx, cy - 0.3 * size, s, size)
            if ink.free(r):
                ink.text(cx, cy - 0.3 * size, s, size)
        elif tw + 2 < y1 - y0 and size + 2 < x1 - x0:
            r = ink.rect(cx + 0.3 * size, cy, s, size, rot=90)
            if ink.free(r):
                ink.text(cx + 0.3 * size, cy, s, size, rot=90)


def _section_x(result: BuildResult, bs: list[PB]) -> tuple[float, Cell | None]:
    """Где резать разрез: середина проёма, через который проходит больше всего деталей."""
    cells = kitchen_cells(bs) if is_kitchen(result) else [c for c in wardrobe_cells(result)
                                                          if not c.key.startswith("mezzanine")]
    if not cells:
        u0, u1, _, _ = View("front").extent(bs)
        return (u0 + u1) / 2, None
    best, best_n = None, -1
    for cl in cells:
        xm = (cl.x0 + cl.x1) / 2
        n = sum(1 for b in bs if b.x0 < xm < b.x1)
        if n > best_n:
            best, best_n = cl, n
    return (best.x0 + best.x1) / 2, best


def _section_marks(ink: Ink, x: float, y_bot: float, y_top: float, letter: str = "А") -> None:
    """След секущей плоскости на виде спереди: штрихи, стрелки взгляда (+X), буквы."""
    c = ink.c
    c.setStrokeColor(BLACK)
    c.setDash()
    for y0, y1, ya in ((y_bot - 3.0 * MM, y_bot - 0.6 * MM, y_bot - 3.0 * MM),
                       (y_top + 0.6 * MM, y_top + 3.0 * MM, y_top + 3.0 * MM)):
        c.setLineWidth(1.4)
        c.line(x, y0, x, y1)
        c.setLineWidth(0.4)
        c.line(x, ya, x + 3.5 * MM, ya)
        p = c.beginPath()
        p.moveTo(x + 3.5 * MM, ya)
        p.lineTo(x + 2.2 * MM, ya + 0.55 * MM)
        p.lineTo(x + 2.2 * MM, ya - 0.55 * MM)
        p.close()
        c.setFillColor(BLACK)
        c.drawPath(p, stroke=0, fill=1)
        up = ya > y_bot
        ink.place([(x + 4.0 * MM, ya - 0.35 * 7, "l", 0), (x - 1.0 * MM, ya - 0.35 * 7, "r", 0)], letter, 7, FB)


def _wardrobe_right_levels(bs: list[PB], H: float) -> list[tuple[float, float]]:
    """Высоты фасадов и цоколя для правой стороны вида с фасадами."""
    items = []
    for b in bs:
        if b.p.role in FRONT_ROLES:
            items.append((round(b.z0, 1), round(b.z1, 1)))
    bottoms = [b for b in bs if b.p.role == "bottom" and head(b.p.module) == "body"]
    if bottoms and min(b.z0 for b in bottoms) > 1:
        items.append((0.0, round(min(b.z0 for b in bottoms), 1)))
    return items


def sheet_views(c: SheetCanvas, result: BuildResult, bs: list[PB]) -> None:
    """Лист «Общий вид»: вид спереди с фасадами, разрез А–А, (у шкафа) вид сверху."""
    kitchen = is_kitchen(result)
    box = c.sheet("Общий вид. Вид спереди, разрез" + (", вид сверху" if not kitchen else ""))
    ink = Ink(c)
    fv = View("front")
    U0, U1, V0, V1 = fv.extent(bs)
    W, H = U1 - U0, V1 - V0
    xc, cell = _section_x(result, bs)
    y_ref = max(b.y1 for b in bs)
    run1 = [b for b in bs if run_of(b.p) == 1] if kitchen else bs
    sec_bs = [b for b in run1 if b.x1 > xc and (not kitchen or cell is None or b.x0 < cell.x1 + 30)]
    sv = View("left", y_ref)
    S0, S1, _, _ = sv.extent([b for b in sec_bs] or bs)
    Dsec = S1 - S0
    top_bs = bs
    tv = View("top")
    _, _, T0, T1 = tv.extent(top_bs)
    Dtop = T1 - T0
    if kitchen:
        mL, mR, mT, mB = LEVEL + 15 * MM, 3 * MM, LEVEL + 9 * MM, 2 * LEVEL + 3 * MM
    else:
        nlev = len(_intervals_to_levels(_wardrobe_right_levels(bs, H))) + 1
        fr = [(round(b.x0, 1), round(b.x1, 1)) for b in bs if b.p.role in FRONT_ROLES]
        nbot = min(len(_intervals_to_levels(fr)), 2) + 1 if fr else 1
        mL, mR, mT, mB = 4 * MM, nlev * LEVEL + 3 * MM, 9 * MM, max(nbot, 2) * LEVEL + 3 * MM
    gap = 10 * MM
    secR = 3 * MM
    # Вид сверху: под видом спереди (в проекционной связи) или справа от разреза — где масштаб крупнее
    with_top = not kitchen
    base_w, base_h = mL + mR + gap + secR, mT + mB
    n = pick_scale(W + Dsec, H, box.w, box.h, base_w, base_h)
    top_at = None
    if with_top:
        n_below = pick_scale(W + Dsec, H + Dtop, box.w, box.h, base_w + LEVEL + 3 * MM, base_h + 11 * MM)
        n_right = pick_scale(W + Dsec + W, max(H, Dtop), box.w, box.h, base_w + gap + LEVEL + 3 * MM, base_h)
        top_at = "below" if n_below <= n_right else "right"
        n = min(n_below, n_right)
        if n > 25:  # вид сверху не влезает в крупном масштабе — уходит на отдельный лист
            with_top, top_at = False, None
            n = pick_scale(W + Dsec, H, box.w, box.h, base_w, base_h)
    s = MM / n
    c.sheet_scale = scale_label(n)
    c.sheet_title = "Общий вид. Вид спереди, разрез" + (", вид сверху" if with_top else "")
    total_w = (W + Dsec) * s + base_w
    total_h = H * s + base_h
    left_extra = 0.0
    if top_at == "below":
        total_w += LEVEL + 3 * MM
        total_h += Dtop * s + 11 * MM
        left_extra = LEVEL + 3 * MM
    elif top_at == "right":
        total_w += gap + LEVEL + 3 * MM + W * s
    ox = box.x0 + (box.w - total_w) / 2 + mL + left_extra
    oy_top_of_front = box.y1 - (box.h - total_h) / 2 - mT
    oy = oy_top_of_front - H * s
    xf = Xf(ox, oy, s, U0, V0)

    # Вид спереди
    draw_ortho(c, result, bs, fv, xf)
    _front_size_labels(ink, bs, fv, xf)
    view_label(ink, xf.X(U0), xf.Y(V1) + (mT - 4 * MM if not kitchen else LEVEL + 4 * MM), "Вид спереди")
    bottom, top_y, right_x, left_x = xf.Y(V0), xf.Y(V1), xf.X(U1), xf.X(U0)
    if kitchen:
        _kitchen_front_dims(ink, result, bs, xf, U0, U1, V0, V1)
    else:
        fronts = [(round(b.x0, 1), round(b.x1, 1)) for b in bs if b.p.role in FRONT_ROLES]
        levels = _intervals_to_levels(fronts) if fronts else []
        y = bottom - LEVEL
        for lv in levels[:2]:
            for a, b in lv:
                hdim(ink, xf.X(a), xf.X(b), y, fmt(b - a), bottom)
            y -= LEVEL
        hdim(ink, left_x, right_x, y if levels else bottom - LEVEL, fmt(W), bottom)
        rl = _intervals_to_levels(_wardrobe_right_levels(bs, H))
        x = right_x + LEVEL
        for lv in rl:
            for a, b in lv:
                vdim(ink, xf.Y(a), xf.Y(b), x, fmt(b - a), right_x)
            x += LEVEL
        vdim(ink, bottom, top_y, x, fmt(H), right_x)
    _section_marks(ink, xf.X(xc), bottom, top_y, "А")

    # Разрез А–А
    sx0 = right_x + mR + gap
    sxf = Xf(sx0, oy, s, S0, V0)
    draw_ortho(c, result, sec_bs, sv, sxf, cut=lambda b: b.x0 < xc < b.x1)
    view_label(ink, sxf.X(S0), top_y + (mT - 4 * MM if not kitchen else LEVEL + 4 * MM), "А–А")
    sb = sxf.Y(V0)
    if kitchen:
        _kitchen_section_dims(ink, sec_bs, sv, sxf)
    else:
        body = [b for b in bs if b.p.role not in FRONT_ROLES]
        lv = 1
        if body:
            by0, by1 = min(b.y0 for b in body), max(b.y1 for b in body)
            if abs((by1 - by0) - Dsec) > 0.5:
                hdim(ink, sxf.X(y_ref - by1), sxf.X(y_ref - by0), sb - LEVEL, fmt(by1 - by0), sb)
                lv = 2
        hdim(ink, sxf.X(S0), sxf.X(S1), sb - lv * LEVEL, fmt(Dsec), sb)

    # Вид сверху
    if top_at == "below":
        ty1 = bottom - mB - 8 * MM
        txf = Xf(ox, ty1 - Dtop * s, s, U0, T0)
        draw_ortho(c, result, top_bs, tv, txf)
        view_label(ink, left_x, ty1 + 3 * MM, "Вид сверху")
        vdim(ink, txf.Y(T0), txf.Y(T1), left_x - LEVEL, fmt(Dtop), left_x)
    elif top_at == "right":
        tx0 = sxf.X(S1) + secR + gap + LEVEL + 3 * MM
        txf = Xf(tx0, top_y - Dtop * s, s, U0, T0)
        draw_ortho(c, result, top_bs, tv, txf)
        view_label(ink, tx0, top_y + mT - 4 * MM, "Вид сверху")
        vdim(ink, txf.Y(T0), txf.Y(T1), tx0 - LEVEL, fmt(Dtop), tx0)
        hdim(ink, txf.X(U0), txf.X(U1), txf.Y(T0) - LEVEL, fmt(W), txf.Y(T0))
    _legend_views(c, ink)
    c.showPage()
    if not with_top and not kitchen:
        sheet_plan(c, result, bs)


def _legend_views(c: SheetCanvas, ink: Ink) -> None:
    """Пояснения слева от штампа."""
    fb = c.frame_box()
    x, y = fb.x0 + 2 * MM, fb.y0 + STAMP_H - 4 * MM
    lines = ["Размеры — мм. Пунктир на дверях — сторона петель (вершина угла).",
             "Серым — детали в секущей плоскости."]
    for i, s in enumerate(lines):
        ink.text(x, y - i * 3.2 * MM, fit_text(s, F, 5.8, fb.w - STAMP_W - 4 * MM), 5.8, "l", reserve=False)


def _kitchen_front_dims(ink: Ink, result: BuildResult, bs: list[PB], xf: Xf, U0: float, U1: float, V0: float,
                        V1: float) -> None:
    """Кухня, вид спереди: цепочки нижнего и верхнего рядов, высоты от пола."""
    walls = kitchen_walls(result, bs)
    wa = walls[0]
    mods = kitchen_mods(result)
    bottom, top_y, left_x, right_x = xf.Y(V0), xf.Y(V1), xf.X(U0), xf.X(U1)
    base = [m for m in mods if m.row == "base"]
    wall = [m for m in mods if m.row == "wall"]
    if base:
        xs = sorted({wa.to_u(m.a) for m in base} | {wa.to_u(m.b) for m in base})
        hchain(ink, xs, xf.X, bottom - LEVEL, bottom)
        hdim(ink, xf.X(xs[0]), xf.X(xs[-1]), bottom - 2 * LEVEL, fmt(xs[-1] - xs[0]), bottom)
    if wall:
        xs = sorted({wa.to_u(m.a) for m in wall} | {wa.to_u(m.b) for m in wall})
        kh = kitchen_heights(bs, 1)
        hchain(ink, xs, xf.X, top_y + LEVEL, xf.Y(kh.wall_top) if kh.wall_top else top_y)
    kh = kitchen_heights(bs, 1)
    marks = kh.marks()
    vchain(ink, marks, xf.Y, left_x - LEVEL, left_x, skip_below=5)
    v_ordinate(ink, marks, xf.Y, left_x - LEVEL - 4 * MM, left=True)


def _kitchen_section_dims(ink: Ink, sec_bs: list[PB], sv: View, sxf: Xf) -> None:
    """Разрез кухни: глубина корпуса, столешницы, верхних модулей."""
    sb = sxf.Y(min(b.z0 for b in sec_bs))
    base = [b for b in sec_bs if head(b.p.module).startswith("base") and b.p.role not in FRONT_ROLES]
    ct = [b for b in sec_bs if b.p.role == "countertop"]
    wall = [b for b in sec_bs if head(b.p.module).startswith("wall") and b.p.role not in FRONT_ROLES]

    def span(sel):
        us = [sv.box(b) for b in sel]
        return min(u[0] for u in us), max(u[1] for u in us), max(u[3] for u in us), min(u[2] for u in us)

    if base:
        a, b, _, _ = span(base)
        hdim(ink, sxf.X(a), sxf.X(b), sb - LEVEL, fmt(b - a), sb)
    if ct:
        a, b, _, _ = span(ct)
        hdim(ink, sxf.X(a), sxf.X(b), sb - 2 * LEVEL, fmt(b - a), sb)
    if wall:
        a, b, top, _ = span(wall)
        yt = sxf.Y(top)
        hdim(ink, sxf.X(a), sxf.X(b), yt + LEVEL, fmt(b - a), yt)


def sheet_no_fronts(c: SheetCanvas, result: BuildResult, bs: list[PB]) -> None:
    """Лист «Вид без фасадов»: ширины проёмов, высоты полок и ящиков по секциям, габариты."""
    kitchen = is_kitchen(result)
    box = c.sheet("Вид без фасадов. Секции, полки, ящики")
    ink = Ink(c)
    fv = View("front")
    inner = [b for b in bs if b.p.role not in FRONT_ROLES and (not kitchen or run_of(b.p) == 1)]
    if not inner:
        inner = bs
    U0, U1, V0, V1 = fv.extent(inner)
    W, H = U1 - U0, V1 - V0
    if kitchen:
        mL, mR, mT, mB = LEVEL + 15 * MM, 4 * MM, LEVEL + 9 * MM, 2 * LEVEL + 3 * MM
    else:
        mL, mR, mT, mB = LEVEL + 4 * MM, LEVEL + 4 * MM, LEVEL + 9 * MM, 2 * LEVEL + 3 * MM
    n = pick_scale(W, H, box.w, box.h, mL + mR, mT + mB)
    s = MM / n
    c.sheet_scale = scale_label(n)
    ox = box.x0 + (box.w - (W * s + mL + mR)) / 2 + mL
    oy = box.y0 + (box.h - (H * s + mT + mB)) / 2 + mB
    xf = Xf(ox, oy, s, U0, V0)
    draw_ortho(c, result, inner, fv, xf)
    bottom, top_y, left_x, right_x = xf.Y(V0), xf.Y(V1), xf.X(U0), xf.X(U1)
    view_label(ink, left_x, top_y + LEVEL + 4 * MM, "Вид спереди без фасадов")
    cells = kitchen_cells(inner) if kitchen else wardrobe_cells(result)
    # Высоты полок и ящиков в каждом проёме (числа — в свету)
    for cl in cells:
        zs = cell_levels(cl, inner)
        if len(zs) < 2:
            continue
        w = cl.x1 - cl.x0
        x = xf.X(cl.x0 + (0.2 * w if w * s > 22 * MM else 0.5 * w))
        vchain(ink, zs, xf.Y, x, None, skip_below=25)
    if kitchen:
        _kitchen_front_dims(ink, result, inner, xf, U0, U1, V0, V1)
    else:
        main = [cl for cl in cells if not cl.key.startswith("mezzanine")]
        mez = [cl for cl in cells if cl.key.startswith("mezzanine")]
        for cl in main:
            hdim(ink, xf.X(cl.x0), xf.X(cl.x1), bottom - LEVEL, fmt(cl.x1 - cl.x0), bottom)
        hdim(ink, left_x, right_x, bottom - 2 * LEVEL, fmt(W), bottom)
        for cl in mez:
            hdim(ink, xf.X(cl.x0), xf.X(cl.x1), top_y + LEVEL, fmt(cl.x1 - cl.x0), top_y)
        vdim(ink, bottom, top_y, left_x - LEVEL, fmt(H), left_x)
        body_z = [0.0, H]
        for b in inner:
            if b.p.role in ("bottom", "top", "divider") and head(b.p.module) in ("body", "mezzanine"):
                body_z += [b.z0, b.z1]
        vchain(ink, body_z, xf.Y, right_x + LEVEL, right_x, left=False, skip_below=25)
    _legend_views(c, ink)
    c.showPage()


def sheet_plan(c: SheetCanvas, result: BuildResult, bs: list[PB]) -> None:
    """План (вид сверху). У кухни: нижние ряды, верхние — пунктиром, стены, ряды от угла."""
    kitchen = is_kitchen(result)
    box = c.sheet("План (вид сверху)")
    ink = Ink(c)
    tv = View("top")
    U0, U1, V0, V1 = tv.extent(bs)
    W, D = U1 - U0, V1 - V0
    m = 2 * LEVEL + 8 * MM
    n = pick_scale(W, D, box.w, box.h, 2 * m, 2 * m)
    s = MM / n
    c.sheet_scale = scale_label(n)
    ox = box.x0 + (box.w - W * s) / 2
    oy = box.y0 + (box.h - D * s) / 2
    xf = Xf(ox, oy, s, U0, V0)
    if kitchen:
        k = result.product
        wall_parts = [b for b in bs if head(b.p.module).startswith("wall") and b.z0 > 1000]
        low = [b for b in bs if b not in wall_parts]
        draw_ortho(c, result, low, tv, xf)
        dashed(c, 0.35)
        for b in wall_parts:
            if b.p.role in FRONT_ROLES or b.p.role in ("side", "back"):
                continue
            u0, u1, v0, v1, _ = tv.box(b)
            c.rect(xf.X(u0), xf.Y(v0), (u1 - u0) * s, (v1 - v0) * s, stroke=1, fill=0)
        thin(c)
        # Стены: A — за первым рядом (y max), B — у второго ряда
        c.setLineWidth(2.2)
        yA = xf.Y(V1) + 1.2
        c.line(xf.X(U0) - 4 * MM, yA, xf.X(U1) + (1.2 if k.layout == "corner" and k.corner_side == "right" else 4 * MM), yA)
        ink.text(xf.X(U0) - 5 * MM, yA - 1, "Стена А", 7, "r", font=FB)
        walls = kitchen_walls(result, bs)
        mods = kitchen_mods(result)
        top_y = xf.Y(V1)
        base = [md for md in mods if md.row == "base"]
        if base:
            xs = sorted({walls[0].to_u(md.a) for md in base} | {walls[0].to_u(md.b) for md in base})
            hchain(ink, xs, xf.X, top_y + LEVEL + 2 * MM, top_y)
        if k.layout == "corner":
            right = k.corner_side == "right"
            xB = xf.X(U1) + 1.2 if right else xf.X(U0) - 1.2
            c.setLineWidth(2.2)
            c.line(xB, top_y + 1.2, xB, xf.Y(V0) - 4 * MM)
            ink.text(xB, xf.Y(V0) - 7 * MM, "Стена Б", 7, "c", font=FB)
            y_corner = max(b.y1 for b in bs)
            b2 = [md for md in mods if md.row == "base2"]
            if b2:
                ys = sorted({y_corner - md.a for md in b2} | {y_corner - md.b for md in b2} | {y_corner})
                xline = xB + (LEVEL + 2 * MM) * (1 if right else -1)
                vchain(ink, ys, xf.Y, xline, xB, left=not right)
            vdim(ink, xf.Y(V0), xf.Y(V1), xB + (2 * LEVEL + 2 * MM) * (1 if right else -1), fmt(D),
                 xB, left=not right)
        hdim(ink, xf.X(U0), xf.X(U1), xf.Y(V0) - LEVEL - 4 * MM, fmt(W), xf.Y(V0))
    else:
        draw_ortho(c, result, bs, tv, xf)
        hdim(ink, xf.X(U0), xf.X(U1), xf.Y(V0) - LEVEL, fmt(W), xf.Y(V0))
        vdim(ink, xf.Y(V0), xf.Y(V1), xf.X(U0) - LEVEL, fmt(D), xf.X(U0))
    view_label(ink, box.x0 + 2 * MM, box.y1 - 5 * MM, "План, вид сверху" + (" (верхние модули — пунктир)" if kitchen else ""))
    _legend_views(c, ink)
    c.showPage()


# --- Чертежи деталей ---

FACE_ORDER = {"A": 0, "B": 1, "x0": 2, "x1": 3, "y0": 4, "y1": 5}
FACE_SHORT = {"A": "A", "B": "B", "x0": "т. Ш1", "x1": "т. Ш2", "y0": "т. Д1", "y1": "т. Д2"}


@dataclass
class PartGroup:
    p: Part
    numbers: list[int]
    size: str = "quarter"  # full | half | quarter

    @property
    def qty(self) -> int:
        return len(self.numbers)

    @property
    def holes(self):
        return sorted(self.p.holes, key=lambda h: (FACE_ORDER.get(h.face, 9), h.x, h.y))


def _drawn(p: Part) -> bool:
    try:
        m = material(p.material)
    except KeyError:
        return False
    return m.is_sheet or m.kind == "countertop"


def _sig(p: Part) -> tuple:
    return (p.name, p.material, p.thickness, p.length, p.width, tuple(sorted(p.edges.items())), p.grain,
            tuple((h.x, h.y, h.diameter, h.depth, h.face, h.purpose) for h in p.holes),
            tuple((g.x0, g.y0, g.x1, g.y1, g.width, g.depth, g.face) for g in p.grooves),
            tuple((k.x, k.y, k.width, k.height, k.depth, k.face) for k in p.pockets),
            p.contour.model_dump_json() if p.contour else "",
            tuple(cu.model_dump_json() for cu in p.cutouts),
            p.decor.model_dump_json() if p.decor else "")


def part_groups(result: BuildResult) -> list[PartGroup]:
    """Одинаковые детали — один чертёж с количеством (номера — как в спецификации)."""
    groups: dict[tuple, PartGroup] = {}
    for p in result.parts:
        if not _drawn(p):
            continue
        key = _sig(p)
        if key in groups:
            groups[key].numbers.append(p.number)
        else:
            groups[key] = PartGroup(p, [p.number])
    out = list(groups.values())
    for g in out:
        n_rows = len(g.p.holes) + len(g.p.grooves) + len(g.p.pockets)
        L, W = to_mm(g.p.length), to_mm(g.p.width)
        if n_rows > 15:
            g.size = "full"
        elif n_rows > 7 or max(L, W) / 76 > 15 or (g.p.contour is not None and max(L, W) > 900):
            g.size = "half"
        else:
            g.size = "quarter"
    return out


def _arc_points(px: float, py: float, seg, n_per_quarter: int = 8) -> list[tuple[float, float]]:
    cx, cy = to_mm(seg.cx), to_mm(seg.cy)
    x, y = to_mm(seg.x), to_mm(seg.y)
    r = math.hypot(px - cx, py - cy)
    a1, a2 = math.atan2(py - cy, px - cx), math.atan2(y - cy, x - cx)
    sweep = -((a1 - a2) % (2 * math.pi)) if seg.clockwise else (a2 - a1) % (2 * math.pi)
    n = max(2, int(abs(sweep) / (math.pi / 2) * n_per_quarter) + 1)
    return [(cx + r * math.cos(a1 + sweep * k / n), cy + r * math.sin(a1 + sweep * k / n)) for k in range(1, n + 1)]


def contour_points(contour) -> tuple[list[tuple[float, float]], list[tuple[float, float, float, float, float]]]:
    """Контур → точки (мм) и дуги (x, y середины, радиус, центр x, y) для подписей R."""
    pts = [(to_mm(contour.start_x), to_mm(contour.start_y))]
    arcs = []
    for seg in contour.segments:
        if seg.kind == "arc":
            ap = _arc_points(pts[-1][0], pts[-1][1], seg)
            r = math.hypot(pts[-1][0] - to_mm(seg.cx), pts[-1][1] - to_mm(seg.cy))
            mid = ap[len(ap) // 2]
            arcs.append((mid[0], mid[1], r, to_mm(seg.cx), to_mm(seg.cy)))
            pts += ap
        else:
            pts.append((to_mm(seg.x), to_mm(seg.y)))
    return pts, arcs


def contour_vertices(contour) -> list[tuple[float, float]]:
    """Концы сегментов контура (без промежуточных точек дуг) — для размеров от базы."""
    return [(to_mm(contour.start_x), to_mm(contour.start_y))] + [(to_mm(sg.x), to_mm(sg.y)) for sg in contour.segments]


def _poly(c, pts: list[tuple[float, float]], X, Y, closed: bool = True, fill: bool = False) -> None:
    if len(pts) < 2:
        return
    path = c.beginPath()
    path.moveTo(X(pts[0][0]), Y(pts[0][1]))
    for x, y in pts[1:]:
        path.lineTo(X(x), Y(y))
    if closed:
        path.close()
    c.drawPath(path, stroke=1, fill=1 if fill else 0)


def grid_table(c, ink: Ink, x: float, y_top: float, widths: list[float], rows: list[list[str]], size: float = 5.6,
               head: bool = True, row_h: float | None = None, aligns: str | None = None) -> float:
    """Таблица сеткой; возвращает нижний край. Тексты обрезаются по ширине колонки."""
    rh = row_h or (size + 2.4)
    W = sum(widths)
    y = y_top
    thin(c, 0.3)
    for i, row in enumerate(rows):
        bold = head and i == 0
        font = FB if bold else F
        if bold:
            c.setFillColor(colors.Color(0.92, 0.92, 0.92))
            c.rect(x, y - rh, W, rh, stroke=0, fill=1)
        cx = x
        for j, (w, s) in enumerate(zip(widths, row)):
            al = (aligns[j] if aligns and not bold else "l")
            s = fit_text(str(s), font, size, w - 2.2)
            tx = cx + 1.2 if al == "l" else cx + w / 2 if al == "c" else cx + w - 1.2
            ink.text(tx, y - rh + (rh - 0.56 * size) / 2, s, size, al, font=font, reserve=False)
            cx += w
        c.setStrokeColor(BLACK)
        c.line(x, y - rh, x + W, y - rh)
        y -= rh
    c.line(x, y_top, x + W, y_top)
    cx = x
    for w in [0.0] + widths:
        cx += w
        c.line(cx, y_top, cx, y)
    ink.reserve((x, y, x + W, y_top))
    return y


def _edge_text(p: Part) -> str:
    out = []
    for side in ("y0", "y1", "x0", "x1"):
        e = p.edges.get(side)
        out.append(f"{SIDE_LABELS[side]} {fmt(to_mm(edge_type(e).thickness)) if e else '—'}")
    return ", ".join(out)


def draw_part(c: SheetCanvas, ink: Ink, g: PartGroup, cell: Box) -> float:
    """Чертёж одной детали в ячейке. Возвращает масштаб (N из 1:N)."""
    from ..decor import part_ops

    p = g.p
    L, W, T = to_mm(p.length), to_mm(p.width), to_mm(p.thickness)
    mat = material(p.material)
    holes = g.holes
    edge_faces = {h.face for h in holes if h.face not in ("A", "B")}
    # Заголовок ячейки
    nums = number_ranges(g.numbers)
    ink.text(cell.x0 + 1 * MM, cell.y1 - 3.6 * MM, fit_text(f"Поз. {nums} · {p.name}", FB, 8.2, cell.w * 0.7), 8.2,
             "l", font=FB)
    ink.text(cell.x1 - 1 * MM, cell.y1 - 3.6 * MM, f"{g.qty} шт. · {fmt(L)}×{fmt(W)}×{fmt(T)}", 7.2, "r", font=FB)
    # Правая колонка: сведения и таблица отверстий
    rp = {"full": 80 * MM, "half": 80 * MM, "quarter": 56 * MM}[g.size]
    n_rows = len(holes)
    size = 5.4 if g.size == "quarter" else 5.6
    rh = size + 2.4
    info_rows = [["Материал", mat.name], ["Толщина", f"{fmt(T)} мм"], ["Чистовой", f"{fmt(L)} × {fmt(W)}"],
                 ["Распил", f"{fmt(to_mm(p.cut_length))} × {fmt(to_mm(p.cut_width))}"], ["Кол-во", f"{g.qty} шт."],
                 ["Кромка", _edge_text(p)],
                 ["Текстура", {"length": "вдоль длины", "width": "вдоль ширины"}.get(p.grain, "—")
                  if mat.has_grain else "—"]]
    ops = part_ops(p)
    if ops:
        info_rows.append(["Обработка", ops])
    tab_top = cell.y1 - 6.5 * MM
    rx = cell.x1 - rp
    lw = 17 * MM if g.size != "quarter" else 14 * MM
    y = grid_table(c, ink, rx, tab_top, [lw, rp - lw], info_rows, size, head=False)
    area = Box(cell.x0, cell.y0, rx - 3 * MM, cell.y1 - 6 * MM)
    hole_rows = []
    for i, h in enumerate(holes, start=1):
        hole_rows.append([str(i), fmt(to_mm(h.x)), fmt(to_mm(h.y)), fmt(to_mm(h.diameter)),
                          "скв." if h.depth == 0 else fmt(to_mm(h.depth)), FACE_SHORT.get(h.face, h.face), h.purpose])
    if hole_rows:
        colw_q = [4.5, 7.5, 7.5, 4.5, 5.5, 8, 0]
        colw_f = [5.5, 9.5, 9.5, 6, 7, 9.5, 0]
        cw = [v * MM for v in (colw_q if g.size == "quarter" else colw_f)]
        cw[-1] = rp - sum(cw[:-1])
        headr = ["№", "X", "Y", "Ø", "Гл.", "Стор.", "Назначение"]
        fit = max(1, int((y - 6.2 * MM - cell.y0) / rh) - 1)
        first, rest = hole_rows[:fit], hole_rows[fit:]
        ink.text(rx, y - 3.2 * MM, "Отверстия (координаты от угла 0, пласть A):", 5.8, "l", font=FB, reserve=False)
        yb = grid_table(c, ink, rx, y - 4.2 * MM, cw, [headr] + first, size, aligns="crrrrll")
        if rest and g.size == "full":
            # Продолжение таблицы — полосой под чертежом, колонками по ширине поля
            ncol = max(1, min(int((area.w + 3 * MM) // (rp + 3 * MM)), 3))
            per = -(-len(rest) // ncol)
            per = min(per, int((area.h * 0.55) / rh) - 1)
            band = (per + 1) * rh + 3 * MM
            for k in range(ncol):
                chunk = rest[k * per:(k + 1) * per]
                if chunk:
                    grid_table(c, ink, area.x0 + k * (rp + 3 * MM), area.y0 + band - 1 * MM, cw, [headr] + chunk, size,
                               aligns="crrrrll")
            rest = rest[ncol * per:]
            area = Box(area.x0, area.y0 + band + 2 * MM, area.x1, area.y1)
        if rest:
            ink.text(rx, yb - 3 * MM, f"…ещё {len(rest)} отв. — в DXF детали", 5.6, "l", reserve=False)
    # Поле чертежа
    strip = 3.6 * MM  # толщина торца на «развёртке торцов» (не в масштабе, если деталь мельче)
    has = {f: f in edge_faces for f in ("x0", "x1", "y0", "y1")}
    ordx = 11 * MM
    m_left = 2 * MM + (strip + 2.5 * MM if has["x0"] else 0) + ordx + LEVEL
    m_bot = 2 * MM + (strip + 2.5 * MM if has["y0"] else 0) + ordx + LEVEL
    m_top = 3 * MM + (strip + 2.5 * MM if has["y1"] else 0)
    m_right = 2 * MM + (strip + 2.5 * MM if has["x1"] else 0)
    n = pick_scale(L, W, area.w, area.h, m_left + m_right, m_bot + m_top, PART_SCALES)
    s = MM / n
    ox = area.x0 + m_left + max(0, (area.w - m_left - m_right - L * s) / 2)
    oy = area.y0 + m_bot + max(0, (area.h - m_bot - m_top - W * s) / 2)
    X = lambda v: ox + v * s  # noqa: E731
    Y = lambda v: oy + v * s  # noqa: E731
    ink.text(area.x0 + 1 * MM, area.y1 - 3 * MM, scale_label(n), 6.2, "l", reserve=True)
    # Контур
    c.setStrokeColor(BLACK)
    c.setFillColor(WHITE)
    c.setDash()
    c.setLineWidth(0.9)
    arcs = []
    if p.contour is not None:
        pts, arcs = contour_points(p.contour)
        _poly(c, pts, X, Y, True, True)
    else:
        pts = [(0, 0), (L, 0), (L, W), (0, W)]
        c.rect(X(0), Y(0), L * s, W * s, stroke=1, fill=1)
    ink.reserve((X(0), Y(0), X(L), Y(W)))  # на детали подписи ставим сами, без «свободных мест»
    ink.taken.pop()
    for cu in p.cutouts:
        cp, ca = contour_points(cu)
        c.setLineWidth(0.7)
        _poly(c, cp, X, Y, True, False)
        arcs += ca
    # Кромка — толстая линия снаружи кромлённой стороны + подпись толщины
    sides = {"y0": ((0, 0), (L, 0), (0, -1)), "y1": ((0, W), (L, W), (0, 1)),
             "x0": ((0, 0), (0, W), (-1, 0)), "x1": ((L, 0), (L, W), (1, 0))}
    for side, eid in p.edges.items():
        et = edge_type(eid)
        (ax, ay), (bx, by), (nx, ny) = sides[side]
        wline = 2.2 if et.thickness >= 10 else 1.2
        off = 0.6 + wline / 2
        c.setLineWidth(wline)
        c.setDash()
        c.line(X(ax) + nx * off, Y(ay) + ny * off, X(bx) + nx * off, Y(by) + ny * off)
        mx, my = (X(ax) + X(bx)) / 2, (Y(ay) + Y(by)) / 2
        lab = f"кр. {fmt(to_mm(et.thickness))}"
        if side in ("y0", "y1"):
            ty = my - (2.2 * MM if side == "y1" else -1.2 * MM)
            r = ink.rect(mx + L * s * 0.18, ty, lab, 5.2)
            if L * s > 22 * MM and ink.free(r):
                ink.text(mx + L * s * 0.18, ty, lab, 5.2)
        elif W * s > 14 * MM:
            tx = mx + (2.4 * MM if side == "x0" else -1.0 * MM)
            r = ink.rect(tx, my, lab, 5.2, rot=90)
            if ink.free(r):
                ink.text(tx, my, lab, 5.2, rot=90)
    # Пазы, выборки, фрезеровка
    for gr in p.grooves:
        x0, y0, x1, y1 = (to_mm(v) for v in (gr.x0, gr.y0, gr.x1, gr.y1))
        (dashed if gr.face == "B" else thin)(c, 0.45)
        c.rect(X(min(x0, x1)), Y(min(y0, y1)), max(abs(x1 - x0) * s, 0.4), max(abs(y1 - y0) * s, 0.4), stroke=1,
               fill=0)
        ink.place([(X((x0 + x1) / 2), Y(max(y0, y1)) + 0.8 * MM, "c", 0),
                   (X((x0 + x1) / 2), Y(min(y0, y1)) - 2.6 * MM, "c", 0)],
                  f"паз {fmt(to_mm(gr.width))}×{fmt(to_mm(gr.depth))} ({gr.face})", 5.2, force=False)
    for pk in p.pockets:
        x0, y0 = to_mm(pk.x), to_mm(pk.y)
        w, h = to_mm(pk.width), to_mm(pk.height)
        (dashed if pk.face == "B" else thin)(c, 0.45)
        c.rect(X(x0), Y(y0), w * s, h * s, stroke=1, fill=0)
        c.line(X(x0), Y(y0), X(x0 + w), Y(y0 + h))
        ink.place([(X(x0 + w / 2), Y(y0 + h) + 0.8 * MM, "c", 0), (X(x0 + w / 2), Y(y0) - 2.6 * MM, "c", 0)],
                  f"выборка гл. {fmt(to_mm(pk.depth))} ({pk.face})", 5.2, force=False)
    if p.decor is not None:
        for paths, style in ((p.decor.milling, dashdot), (p.decor.inlay, dashed), (p.decor.overlay, thin)):
            for m in paths:
                mp, _ = contour_points(m.path)
                style(c, 0.4)
                _poly(c, mp, X, Y, m.closed, False)
    thin(c)
    for ax, ay, r, acx, acy in arcs:
        dl = math.hypot(acx - ax, acy - ay) or 1
        k = min(4 * MM, r * s * 0.5)
        tx, ty = X(ax) + (acx - ax) / dl * k, Y(ay) + (acy - ay) / dl * k
        ink.place([(tx, ty - 1.5, "c", 0), (X(ax) + 1 * MM, Y(ay) + 1 * MM, "l", 0),
                   (X(ax) - 1 * MM, Y(ay) - 2.6 * MM, "r", 0)], f"R{fmt(r)}", 5.4, force=False)
    # Текстура
    if mat.has_grain and p.grain in ("length", "width"):
        cx, cy = X(L / 2), Y(W * 0.78)
        ln = min(L * s, W * s) * 0.35 if p.grain == "width" else min(L * s * 0.3, 30 * MM)
        thin(c, 0.4)
        if p.grain == "length":
            a, b = (cx - ln / 2, cy), (cx + ln / 2, cy)
        else:
            a, b = (cx, cy - ln / 2), (cx, cy + ln / 2)
        c.line(*a, *b)
        for (px, py), (qx, qy) in ((a, b), (b, a)):
            ang = math.atan2(py - qy, px - qx)
            for da in (0.45, -0.45):
                c.line(px, py, px - 1.6 * MM * math.cos(ang + da), py - 1.6 * MM * math.sin(ang + da))
        ink.text(cx + (0 if p.grain == "length" else 1.2 * MM), cy + (1.0 * MM if p.grain == "length" else 0),
                 "текстура", 5.2, "c" if p.grain == "length" else "l")
    # Отверстия в пласти и в торце (скрытые — пунктир)
    hole_marks = []
    for i, h in enumerate(holes, start=1):
        x, y = to_mm(h.x), to_mm(h.y)
        d, dep = to_mm(h.diameter), to_mm(h.depth)
        if h.face in ("A", "B"):
            r = max(d / 2 * s, 1.0)
            if h.face == "A":
                thin(c, 0.45)
            else:
                dashed(c, 0.45, (1.2, 0.8))
            c.circle(X(x), Y(y), r, stroke=1, fill=0)
            thin(c, 0.25)
            if h.depth == 0:
                k = r * 0.7
                c.line(X(x) - k, Y(y) - k, X(x) + k, Y(y) + k)
                c.line(X(x) - k, Y(y) + k, X(x) + k, Y(y) - k)
            elif r > 2.5:
                c.line(X(x) - r - 1, Y(y), X(x) + r + 1, Y(y))
                c.line(X(x), Y(y) - r - 1, X(x), Y(y) + r + 1)
            hole_marks.append((i, X(x), Y(y), r))
        else:
            dashed(c, 0.35, (1.2, 0.8))
            ln = (dep if dep else (L if h.face in ("x0", "x1") else W)) * s
            wd = max(d * s, 0.8)
            if h.face == "x0":
                c.rect(X(0), Y(y) - wd / 2, ln, wd, stroke=1, fill=0)
                hole_marks.append((i, X(0) + ln, Y(y), wd / 2))
            elif h.face == "x1":
                c.rect(X(L) - ln, Y(y) - wd / 2, ln, wd, stroke=1, fill=0)
                hole_marks.append((i, X(L) - ln, Y(y), wd / 2))
            elif h.face == "y0":
                c.rect(X(x) - wd / 2, Y(0), wd, ln, stroke=1, fill=0)
                hole_marks.append((i, X(x), Y(0) + ln, wd / 2))
            else:
                c.rect(X(x) - wd / 2, Y(W) - ln, wd, ln, stroke=1, fill=0)
                hole_marks.append((i, X(x), Y(W) - ln, wd / 2))
    thin(c)
    for _, hx, hy, r in hole_marks:
        ink.reserve((hx - r, hy - r, hx + r, hy + r))
    if len(hole_marks) <= 60:
        for i, hx, hy, r in hole_marks:
            ink.place([(hx + r + 0.4 * MM, hy + 0.3 * MM, "l", 0), (hx - r - 0.4 * MM, hy + 0.3 * MM, "r", 0),
                       (hx + r + 0.3 * MM, hy - 2.0 * MM, "l", 0), (hx - r - 0.3 * MM, hy - 2.0 * MM, "r", 0)],
                      str(i), 4.4, force=False)
    # Развёртка торцов с отверстиями: полоса вдоль стороны
    strips = {}
    strip_labels: list = []
    for f in ("x0", "x1", "y0", "y1"):
        if not has[f]:
            continue
        thin(c, 0.4)
        if f == "y0":
            sb = Box(X(0), Y(0) - 2.5 * MM - strip, X(L), Y(0) - 2.5 * MM)
        elif f == "y1":
            sb = Box(X(0), Y(W) + 2.5 * MM, X(L), Y(W) + 2.5 * MM + strip)
        elif f == "x0":
            sb = Box(X(0) - 2.5 * MM - strip, Y(0), X(0) - 2.5 * MM, Y(W))
        else:
            sb = Box(X(L) + 2.5 * MM, Y(0), X(L) + 2.5 * MM + strip, Y(W))
        c.setFillColor(WHITE)
        c.rect(sb.x0, sb.y0, sb.w, sb.h, stroke=1, fill=1)
        strips[f] = sb
        dashdot(c, 0.2)
        if f in ("y0", "y1"):
            c.line(sb.x0 - 1 * MM, (sb.y0 + sb.y1) / 2, sb.x1 + 1 * MM, (sb.y0 + sb.y1) / 2)
        else:
            c.line((sb.x0 + sb.x1) / 2, sb.y0 - 1 * MM, (sb.x0 + sb.x1) / 2, sb.y1 + 1 * MM)
        thin(c, 0.45)
        for h in holes:
            if h.face != f:
                continue
            r = max(to_mm(h.diameter) / 2 * s, 0.9)
            r = min(r, strip / 2 - 0.3)
            if f in ("y0", "y1"):
                c.circle(X(to_mm(h.x)), (sb.y0 + sb.y1) / 2, r, stroke=1, fill=0)
            else:
                c.circle((sb.x0 + sb.x1) / 2, Y(to_mm(h.y)), r, stroke=1, fill=0)
        ink.reserve((sb.x0, sb.y0, sb.x1, sb.y1))
        lab = f"торец {SIDE_LABELS[f]}"
        if f in ("y0", "y1"):
            strip_labels.append(([(sb.x1 + 1 * MM, sb.y0 + 0.4 * MM, "l", 0), (sb.x0 - 1 * MM, sb.y0 + 0.4 * MM, "r", 0)],
                                 lab))
        else:
            strip_labels.append(([(sb.x0 + 0.5 * MM, sb.y1 + 1.2 * MM, "l", 0), (sb.x1, sb.y1 + 1.2 * MM, "r", 0),
                                  (sb.x0 + 0.5 * MM, sb.y1 + 4.0 * MM, "l", 0), (sb.x0, sb.y0 - 2.6 * MM, "l", 0)],
                                 lab))
    # Координаты от угла 0: X — по низу, Y — по левому краю
    xs, ys = set(), set()
    for h in holes:
        x, y = to_mm(h.x), to_mm(h.y)
        if h.face in ("A", "B"):
            xs.add(x)
            ys.add(y)
        elif h.face in ("y0", "y1"):
            xs.add(x)
        else:
            ys.add(y)
    for gr in p.grooves:
        xs |= {to_mm(gr.x0), to_mm(gr.x1)}
        ys |= {to_mm(gr.y0), to_mm(gr.y1)}
    for pk in p.pockets:
        xs |= {to_mm(pk.x), to_mm(pk.x + pk.width)}
        ys |= {to_mm(pk.y), to_mm(pk.y + pk.height)}
    for cu in p.cutouts:
        cp, _ = contour_points(cu)
        xs |= {min(q[0] for q in cp), max(q[0] for q in cp)}
        ys |= {min(q[1] for q in cp), max(q[1] for q in cp)}
    if p.contour is not None and len(p.contour.segments) <= 16:
        cv = contour_vertices(p.contour)
        xs |= {q[0] for q in cv}
        ys |= {q[1] for q in cv}
    xs = sorted(v for v in xs if 0.5 < v < L - 0.5)
    ys = sorted(v for v in ys if 0.5 < v < W - 0.5)
    y_ord = (strips["y0"].y0 if "y0" in strips else Y(0)) - 0.8 * MM
    x_ord = (strips["x0"].x0 if "x0" in strips else X(0)) - 0.8 * MM
    if xs and len(xs) <= 32:
        h_ordinate(ink, [0.0] + xs, X, y_ord)
    if ys and len(ys) <= 32:
        v_ordinate_side(ink, [0.0] + ys, Y, x_ord)
    hdim(ink, X(0), X(L), y_ord - ordx - (LEVEL - 4 * MM), fmt(L), Y(0))
    vdim(ink, Y(0), Y(W), x_ord - ordx - (LEVEL - 4 * MM), fmt(W), X(0))
    # «0» — начало координат
    if not (xs and len(xs) <= 32) and not (ys and len(ys) <= 32):
        ink.place([(X(0) - 0.8 * MM, Y(0) - 2.6 * MM, "r", 0)], "0", 5.4, force=False)
    for cands, lab in strip_labels:
        ink.place(cands, lab, 5.2)
    return n


def _pack(groups: list[PartGroup]) -> list[list[list[PartGroup]]]:
    """Листы → строки → детали: full — лист; half — строка; quarter — пол-строки."""
    pages: list[list[list[PartGroup]]] = []
    cur: list[list[PartGroup]] = []

    def flush():
        nonlocal cur
        if cur:
            pages.append(cur)
        cur = []

    queue = list(groups)
    while queue:
        g = queue.pop(0)
        if g.size == "full":
            flush()
            pages.append([[g]])
            continue
        if g.size == "half":
            if cur and cur[-1][0].size == "quarter" and len(cur[-1]) == 1:
                mate = next((q for q in queue if q.size == "quarter"), None)
                if mate is not None:  # дополнить пол-строки следующей маленькой деталью
                    queue.remove(mate)
                    cur[-1].append(mate)
            if len(cur) >= 2:
                flush()
            cur.append([g])
            continue
        if cur and cur[-1][0].size == "quarter" and len(cur[-1]) == 1:
            cur[-1].append(g)
        else:
            if len(cur) >= 2:
                flush()
            cur.append([g])
    flush()
    return pages


def _parts_legend(c: SheetCanvas, ink: Ink) -> None:
    fb = c.frame_box()
    x, y = fb.x0 + 2 * MM, fb.y0 + STAMP_H - 3.2 * MM
    wmax = fb.w - STAMP_W - 4 * MM
    thin(c, 0.45)
    c.circle(x + 1.2 * MM, y + 0.8 * MM, 1.0 * MM)
    ink.text(x + 3 * MM, y, "отв. в пласти A", 5.6, "l", reserve=False)
    dashed(c, 0.45, (1.2, 0.8))
    c.circle(x + 29 * MM, y + 0.8 * MM, 1.0 * MM)
    ink.text(x + 31 * MM, y, "пласть B (обратная)", 5.6, "l", reserve=False)
    thin(c, 0.45)
    c.circle(x + 62 * MM, y + 0.8 * MM, 1.0 * MM)
    c.line(x + 61.3 * MM, y + 0.1 * MM, x + 62.7 * MM, y + 1.5 * MM)
    c.line(x + 61.3 * MM, y + 1.5 * MM, x + 62.7 * MM, y + 0.1 * MM)
    ink.text(x + 64 * MM, y, "сквозное", 5.6, "l", reserve=False)
    y -= 3.4 * MM
    c.setLineWidth(2.2)
    c.line(x, y + 0.8 * MM, x + 6 * MM, y + 0.8 * MM)
    ink.text(x + 7.5 * MM, y, "кромка ≥1 мм", 5.6, "l", reserve=False)
    c.setLineWidth(1.2)
    c.line(x + 29 * MM, y + 0.8 * MM, x + 35 * MM, y + 0.8 * MM)
    ink.text(x + 36.5 * MM, y, "кромка 0,4 мм", 5.6, "l", reserve=False)
    dashed(c, 0.35, (1.2, 0.8))
    c.rect(x + 58 * MM, y + 0.4 * MM, 4 * MM, 0.8 * MM)
    ink.text(x + 64 * MM, y, "отв. в торце", 5.6, "l", reserve=False)
    thin(c)
    for i, s in enumerate(("Д1/Д2 — длинные стороны (низ/верх), Ш1/Ш2 — короткие (лево/право). Размеры чистовые,",
                           "с кромкой; X, Y — от угла 0 (низ-лево) пласти A. Распил = чистовой − кромка.")):
        ink.text(x, y - (3.4 + 3.0 * i) * MM, fit_text(s, F, 5.4, wmax), 5.4, "l", reserve=False)


def sheets_parts(c: SheetCanvas, result: BuildResult) -> int:
    """Листы чертежей деталей. Возвращает число листов."""
    groups = part_groups(result)
    pages = _pack(groups)
    for rows in pages:
        box = c.sheet("Чертежи деталей", size=A4L)
        ink = Ink(c)
        scales = set()
        heights = [box.h] if len(rows) == 1 and rows[0][0].size == "full" else [(box.h - 4 * MM) / 2] * 2
        y_top = box.y1
        for ri, row in enumerate(rows):
            h = heights[ri] if ri < len(heights) else heights[-1]
            if row[0].size == "quarter":
                w = (box.w - 5 * MM) / 2
                for ci, g in enumerate(row):
                    cell = Box(box.x0 + ci * (w + 5 * MM), y_top - h, box.x0 + ci * (w + 5 * MM) + w, y_top)
                    scales.add(draw_part(c, ink, g, cell))
                if len(row) == 2:
                    thin(c, 0.3)
                    c.line(box.x0 + w + 2.5 * MM, y_top - h, box.x0 + w + 2.5 * MM, y_top)
            else:
                scales.add(draw_part(c, ink, row[0], Box(box.x0, y_top - h, box.x1, y_top)))
            y_top -= h + 4 * MM
            if ri == 0 and len(rows) > 1:
                thin(c, 0.3)
                c.line(box.x0, y_top + 2 * MM, box.x1, y_top + 2 * MM)
        c.sheet_scale = scale_label(scales.pop()) if len(scales) == 1 else "см. на чертеже"
        _parts_legend(c, ink)
        c.showPage()
    if not pages:
        box = c.sheet("Чертежи деталей")
        Ink(c).text(box.x0, box.y1 - 10 * MM, "Нет листовых деталей", 10, "l")
        c.showPage()
        return 1
    return len(pages)


# --- Взрыв-схема в изометрии ---

ISO_C, ISO_S = math.cos(math.radians(30)), math.sin(math.radians(30))


def iso(x: float, y: float, z: float) -> tuple[float, float]:
    """Изометрия, взгляд спереди-слева-сверху: видны грани x0 (левая), y0 (передняя), z1 (верхняя)."""
    return (x - y) * ISO_C, z + (x + y) * ISO_S


def _rot_front(b: PB, front: tuple[str, int]) -> PB:
    """Повернуть коробку вокруг Z так, чтобы фасад смотрел в −Y."""
    axis, sign = front
    if axis == "Y" and sign < 0:
        return b
    if axis == "Y":  # фасад в +Y: поворот на 180°
        return PB(b.p, -b.x1, -b.y1, b.z0, -b.x0, -b.y0, b.z1)
    if sign < 0:  # фасад в −X: (x, y) → (−y, x)
        return PB(b.p, -b.y1, b.x0, b.z0, -b.y0, b.x1, b.z1)
    return PB(b.p, b.y0, -b.x1, b.z0, b.y1, -b.x0, b.z1)  # фасад в +X: (x, y) → (y, −x)


def _front_dir(group: list[PB]) -> tuple[str, int]:
    fr = [b for b in group if b.p.role in FRONT_ROLES or b.p.role == "filler"]
    if not fr:
        return "Y", -1
    gx = (min(b.x0 for b in group) + max(b.x1 for b in group)) / 2
    gy = (min(b.y0 for b in group) + max(b.y1 for b in group)) / 2
    f = max(fr, key=lambda b: (b.x1 - b.x0) * (b.z1 - b.z0) + (b.y1 - b.y0) * (b.z1 - b.z0))
    if (f.x1 - f.x0) < (f.y1 - f.y0):  # фасад тонкий по X — смотрит вдоль X
        return "X", (1 if f.c[0] > gx else -1)
    return "Y", (1 if f.c[1] > gy else -1)


def explode(group: list[PB]) -> list[PB]:
    """Разнести детали по направлению сборки: боковины — в стороны, крыша — вверх, полки и фасады — вперёд."""
    if not group:
        return []
    front = _front_dir(group)
    g = [_rot_front(b, front) for b in group]
    X0, X1 = min(b.x0 for b in g), max(b.x1 for b in g)
    Y0, Y1 = min(b.y0 for b in g), max(b.y1 for b in g)
    Z0, Z1 = min(b.z0 for b in g), max(b.z1 for b in g)
    cx, cy, cz = (X0 + X1) / 2, (Y0 + Y1) / 2, (Z0 + Z1) / 2
    clamp = lambda v, a, b: max(a, min(b, v))  # noqa: E731
    ex, ey, ez = clamp(0.28 * (X1 - X0), 120, 520), clamp(0.6 * (Y1 - Y0), 150, 420), clamp(0.2 * (Z1 - Z0), 120, 480)
    out = []
    for b in g:
        role = b.p.role
        dims = (b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0)
        n_axis = dims.index(min(dims))
        bc = b.c
        sgn = [1 if bc[i] >= (cx, cy, cz)[i] else -1 for i in range(3)]
        dx = dy = dz = 0.0
        if role in FRONT_ROLES or role == "filler":
            dy = -2.3 * ey
        elif role in DRAWER_ROLES or (b.p.node and role not in ("side", "top", "bottom")):
            dy = -1.5 * ey
        elif role in ("shelf", "end_shelf", "rod"):
            dy = -0.95 * ey
        elif role == "back":
            dy = 1.1 * ey
        elif role == "plinth":
            dz = -1.1 * ez
        elif role == "countertop":
            dz = 1.3 * ez
        elif role in ("top", "cornice", "rail"):
            dz = ez
        elif role in ("niche_filler", "filler_strip"):
            dz = 1.7 * ez
        elif role == "bottom":
            dz = -0.55 * ez
        elif role in ("partition", "divider"):
            pass
        elif role in ("side", "false_panel", "end_rear"):
            dx = sgn[0] * ex * (1.6 if role == "false_panel" else 1.0)
        else:
            d = [0.0, 0.0, 0.0]
            d[n_axis] = sgn[n_axis] * (ex, ey, ez)[n_axis] * 0.8
            dx, dy, dz = d
        out.append(b.moved(dx, dy, dz))
    return out


def _corners(b: PB) -> list[tuple[float, float]]:
    return [iso(x, y, z) for x in (b.x0, b.x1) for y in (b.y0, b.y1) for z in (b.z0, b.z1)]


def _hull(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = sorted(set((round(x, 4), round(y, 4)) for x, y in pts))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _inside(pt, hull) -> bool:
    n = len(hull)
    if n < 3:
        return False
    for i in range(n):
        a, b = hull[i], hull[(i + 1) % n]
        if (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]) < -1e-9:
            return False
    return True


def iso_order(bs: list[PB]) -> list[PB]:
    """Порядок рисования (дальние — первыми): по разделяющей плоскости для перекрывающихся пар."""
    n = len(bs)
    eps = 0.01
    bbox = []
    for b in bs:
        cs = _corners(b)
        bbox.append((min(p[0] for p in cs), min(p[1] for p in cs), max(p[0] for p in cs), max(p[1] for p in cs)))
    depth = [b.c[0] + b.c[1] - b.c[2] for b in bs]

    def behind(a: PB, b: PB, ia: int, ib: int) -> bool:
        if a.x0 >= b.x1 - eps:
            return True
        if b.x0 >= a.x1 - eps:
            return False
        if a.y0 >= b.y1 - eps:
            return True
        if b.y0 >= a.y1 - eps:
            return False
        if a.z1 <= b.z0 + eps:
            return True
        if b.z1 <= a.z0 + eps:
            return False
        return depth[ia] > depth[ib]

    after: list[list[int]] = [[] for _ in range(n)]  # i рисуется раньше j
    indeg = [0] * n
    for i in range(n):
        for j in range(i + 1, n):
            p, q = bbox[i], bbox[j]
            if p[0] >= q[2] or q[0] >= p[2] or p[1] >= q[3] or q[1] >= p[3]:
                continue
            if behind(bs[i], bs[j], i, j):
                after[i].append(j)
                indeg[j] += 1
            else:
                after[j].append(i)
                indeg[i] += 1
    order: list[int] = []
    ready = sorted((i for i in range(n) if indeg[i] == 0), key=lambda i: -depth[i])
    done = [False] * n
    while len(order) < n:
        if not ready:  # цикл (пересекающиеся коробки) — рвём на детали с наименьшим числом «ждущих»
            i = min((k for k in range(n) if not done[k]), key=lambda k: (indeg[k], -depth[k]))
            indeg[i] = 0
            ready = [i]
        i = ready.pop(0)
        if done[i]:
            continue
        done[i] = True
        order.append(i)
        for j in after[i]:
            indeg[j] -= 1
            if indeg[j] == 0 and not done[j]:
                ready.append(j)
        ready.sort(key=lambda k: -depth[k])
    return [bs[i] for i in order]


def draw_iso(c: SheetCanvas, ink: Ink, bs: list[PB], area: Box, balloons: bool = True, lw: float = 0.35) -> None:
    """Коробки деталей в изометрии, вписанные в area; с номерами позиций в кружках."""
    if not bs:
        return
    order = iso_order(bs)
    pts = [p for b in order for p in _corners(b)]
    u0, v0 = min(p[0] for p in pts), min(p[1] for p in pts)
    u1, v1 = max(p[0] for p in pts), max(p[1] for p in pts)
    pad = 11 * MM if balloons else 2 * MM
    s = min((area.w - 2 * pad) / max(u1 - u0, 1), (area.h - 2 * pad) / max(v1 - v0, 1))
    ox = area.x0 + (area.w - (u1 - u0) * s) / 2 - u0 * s
    oy = area.y0 + (area.h - (v1 - v0) * s) / 2 - v0 * s
    P = lambda x, y, z: (ox + iso(x, y, z)[0] * s, oy + iso(x, y, z)[1] * s)  # noqa: E731
    faces_of = {}
    hulls = []
    for b in order:
        f_front = [P(b.x0, b.y0, b.z0), P(b.x1, b.y0, b.z0), P(b.x1, b.y0, b.z1), P(b.x0, b.y0, b.z1)]
        f_left = [P(b.x0, b.y0, b.z0), P(b.x0, b.y1, b.z0), P(b.x0, b.y1, b.z1), P(b.x0, b.y0, b.z1)]
        f_top = [P(b.x0, b.y0, b.z1), P(b.x1, b.y0, b.z1), P(b.x1, b.y1, b.z1), P(b.x0, b.y1, b.z1)]
        faces_of[id(b)] = (f_front, f_left, f_top)
        ghost = balloons and b.p.role in FRONT_ROLES  # на взрыв-схеме фасады — контуром, чтобы не закрывали ящики
        hulls.append([] if ghost else _hull(f_front + f_left + f_top + [P(b.x1, b.y1, b.z0)]))
        for poly, fillc in ((f_left, SHADE_SIDE), (f_top, SHADE_TOP), (f_front, WHITE)):
            path = c.beginPath()
            path.moveTo(*poly[0])
            for q in poly[1:]:
                path.lineTo(*q)
            path.close()
            c.setFillColor(fillc)
            thin(c, lw)
            c.drawPath(path, stroke=1, fill=0 if ghost else 1)
    if not balloons:
        return
    # Номера позиций: якорь — видимая точка самой большой грани, кружок — снаружи по лучу от центра
    gcx, gcy = ox + (u0 + u1) / 2 * s, oy + (v0 + v1) / 2 * s

    def area_of(poly):
        return abs(sum(poly[i][0] * poly[(i + 1) % 4][1] - poly[(i + 1) % 4][0] * poly[i][1] for i in range(4))) / 2

    anchors = []
    for k, b in enumerate(order):
        faces = sorted(faces_of[id(b)], key=area_of, reverse=True)
        found = None
        for poly in faces:
            if area_of(poly) < 0.5:
                continue
            cxp = sum(q[0] for q in poly) / 4
            cyp = sum(q[1] for q in poly) / 4
            for t in (0.0, 0.3, -0.3, 0.6, -0.6):
                pt = (cxp + (poly[1][0] - poly[0][0]) * t * 0.5, cyp + (poly[1][1] - poly[0][1]) * t * 0.5)
                if not any(_inside(pt, hulls[m]) for m in range(k + 1, len(order))):
                    found = pt
                    break
            if found:
                break
        if found:
            anchors.append((b, found))
    r = 2.3 * MM
    for b, (ax, ay) in sorted(anchors, key=lambda t: t[0].p.number):
        label = str(b.p.number)
        rr = r if len(label) < 3 else r * 1.2
        base = math.atan2(ay - gcy, ax - gcx) if (ax, ay) != (gcx, gcy) else math.pi / 2
        placed = None
        for dist in (7 * MM, 10 * MM, 13 * MM, 17 * MM):
            for da in (0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6):
                bx, by = ax + math.cos(base + da) * dist, ay + math.sin(base + da) * dist
                rect = (bx - rr, by - rr, bx + rr, by + rr)
                if rect[0] < area.x0 or rect[2] > area.x1 or rect[1] < area.y0 or rect[3] > area.y1:
                    continue
                if ink.free(rect, 0.6):
                    placed = (bx, by)
                    break
            if placed:
                break
        if placed is None:
            placed = (ax + math.cos(base) * 7 * MM, ay + math.sin(base) * 7 * MM)
        bx, by = placed
        thin(c, 0.3)
        dxl, dyl = bx - ax, by - ay
        dl = math.hypot(dxl, dyl) or 1
        c.line(ax, ay, bx - dxl / dl * rr, by - dyl / dl * rr)
        c.setFillColor(BLACK)
        c.circle(ax, ay, 0.45, stroke=0, fill=1)
        c.setFillColor(WHITE)
        c.circle(bx, by, rr, stroke=1, fill=1)
        ink.reserve((bx - rr, by - rr, bx + rr, by + rr))
        ink.text(bx, by - 0.3 * 6, label, 6 if len(label) < 3 else 5.4, "c", font=FB, reserve=False)


KIND_PRIORITY = ["confirmat", "dowel", "eccentric", "minifix", "shelf_pin", "hinge", "hinge_plate", "slide", "lift",
                 "handle", "leg", "rod", "rod_holder", "sliding"]


def hardware_list(result: BuildResult) -> list[tuple[str, int]]:
    """Фурнитура и крепёж: конфирматы, полкодержатели, петли, направляющие… — суммарно по изделию."""
    totals: dict[tuple[str, str], int] = {}
    first: dict[tuple[str, str], int] = {}
    for i, h in enumerate(result.hardware):
        key = (h.kind, h.name)
        totals[key] = totals.get(key, 0) + h.qty
        first.setdefault(key, i)

    def prio(k):
        kind = k[0]
        for j, p in enumerate(KIND_PRIORITY):
            if kind.startswith(p):
                return j, first[k]
        return len(KIND_PRIORITY), first[k]

    return [(k[1], totals[k]) for k in sorted(totals, key=prio)]


def _hardware_table(c: SheetCanvas, ink: Ink, x: float, y_top: float, w: float, y_min: float,
                    rows: list[tuple[str, int]], start: int = 0) -> int:
    """Ведомость фурнитуры; возвращает, сколько строк влезло."""
    rh = 5.8 + 2.4
    fit = max(0, int((y_top - y_min) / rh) - 1)
    chunk = rows[start:start + fit]
    data = [["№", "Фурнитура и крепёж", "Кол."]] + [[str(start + i + 1), n, str(q)] for i, (n, q) in enumerate(chunk)]
    grid_table(c, ink, x, y_top, [7 * MM, w - 19 * MM, 12 * MM], data, 5.8, aligns="clr")
    return len(chunk)


MODULE_ROWS = {"base": "Нижний модуль", "wall": "Верхний модуль", "base2": "Ряд 2, нижний модуль",
               "wall2": "Ряд 2, верхний модуль"}
KIND_NAMES = {"doors": "двери", "drawers": "ящики", "sink": "под мойку", "appliance": "ниша под технику",
              "corner": "угловой", "fridge": "под холодильник", "cargo": "карго", "hood": "под вытяжку",
              "open": "открытый", "gap": "проём", "lift": "подъёмный"}


def _module_title(result: BuildResult, key: str) -> str:
    import re

    if key == "corner_leg":
        return "Угловой модуль — крыло (ряд 2)"
    m = re.match(r"(base2|wall2|base|wall)\[(\d+)\]$", key)
    if not m:
        return "Цоколь, столешница, панели"
    row, i = m.group(1), int(m.group(2))
    items = getattr(result.product, row, [])
    cab = items[i] if i < len(items) else None
    kind = KIND_NAMES.get(getattr(cab, "kind", ""), getattr(cab, "kind", "")) if cab else ""
    width = f", {fmt(cab.width)} мм" if cab is not None else ""
    return f"{MODULE_ROWS[row]} {i + 1}" + (f" — {kind}" if kind else "") + width


def sheets_exploded(c: SheetCanvas, result: BuildResult, bs: list[PB]) -> None:
    """Взрыв-схема сборки: шкаф — целиком, кухня — по модулям (4 на лист). Плюс ведомость фурнитуры."""
    rows = hardware_list(result)
    if not is_kitchen(result):
        box = c.sheet("Схема сборки (взрыв-схема)", "без масштаба")
        ink = Ink(c)
        tw = 78 * MM
        _hardware_or_rest(c, ink, box, tw, rows)
        area = Box(box.x0, box.y0, box.x1 - tw - 4 * MM, box.y1 - 5 * MM)
        view_label(ink, box.x0, box.y1 - 4 * MM, "Изометрия, детали разнесены")
        draw_iso(c, ink, explode(bs), area)
        _iso_legend(c, ink)
        c.showPage()
        return
    groups: dict[str, list[PB]] = {}
    for b in bs:
        h = head(b.p.module)
        key = h if h.startswith(("base[", "wall[", "base2[", "wall2[")) else \
            "corner_leg" if ".corner" in b.p.module else "misc"
        groups.setdefault(key, []).append(b)

    def order_key(k: str):
        import re

        m = re.match(r"(base2|wall2|base|wall)\[(\d+)\]", k)
        if not m:
            return (2, -1) if k == "corner_leg" else (9, 0)
        return ({"base": 0, "wall": 1, "base2": 2, "wall2": 3}[m.group(1)], int(m.group(2)))

    keys = sorted(groups, key=order_key)
    for start in range(0, len(keys), 4):
        box = c.sheet("Схема сборки по модулям (взрыв-схема)", "без масштаба")
        ink = Ink(c)
        cw, ch = (box.w - 4 * MM) / 2, (box.h - 4 * MM) / 2
        for k, key in enumerate(keys[start:start + 4]):
            col, row = k % 2, k // 2
            cell = Box(box.x0 + col * (cw + 4 * MM), box.y1 - (row + 1) * ch - row * 4 * MM,
                       box.x0 + col * (cw + 4 * MM) + cw, box.y1 - row * (ch + 4 * MM))
            ink.text(cell.x0 + 1 * MM, cell.y1 - 4 * MM, _module_title(result, key), 7.5, "l", font=FB)
            draw_iso(c, ink, explode(groups[key]), Box(cell.x0, cell.y0, cell.x1, cell.y1 - 6 * MM))
        thin(c, 0.3)
        c.line(box.x0 + cw + 2 * MM, box.y0, box.x0 + cw + 2 * MM, box.y1)
        c.line(box.x0, box.y0 + ch + 2 * MM, box.x1, box.y0 + ch + 2 * MM)
        _iso_legend(c, ink)
        c.showPage()
    box = c.sheet("Ведомость фурнитуры и крепежа")
    ink = Ink(c)
    _hardware_or_rest(c, ink, box, box.w / 2 - 2 * MM, rows)
    c.showPage()


def _hardware_or_rest(c: SheetCanvas, ink: Ink, box: Box, tw: float, rows: list[tuple[str, int]]) -> None:
    done = _hardware_table(c, ink, box.x1 - tw, box.y1, tw, box.y0, rows)
    if done < len(rows):  # длинная ведомость — вторая колонка слева
        _hardware_table(c, ink, box.x1 - 2 * tw - 4 * MM, box.y1, tw, box.y0, rows, done)


def _iso_legend(c: SheetCanvas, ink: Ink) -> None:
    fb = c.frame_box()
    x, y = fb.x0 + 2 * MM, fb.y0 + STAMP_H - 4 * MM
    for i, s in enumerate(("Номера в кружках — позиции деталей, как в спецификации и на чертежах деталей.",
                           "Детали разнесены по направлению сборки: боковины — в стороны, крыша — вверх,",
                           "полки, ящики и фасады — вперёд, задняя стенка — назад.")):
        ink.text(x, y - i * 3.2 * MM, fit_text(s, F, 5.6, fb.w - STAMP_W - 4 * MM), 5.6, "l", reserve=False)


# --- Развёртка стен кухни ---

UTIL_NAMES = {"water": "Вода", "sewer": "Канализация", "gas": "Газ", "socket": "Розетка", "vent": "Вентканал"}
UTIL_MARK = {"water": "В", "sewer": "К", "gas": "Г", "socket": "Р", "vent": "ВК"}


def sheet_wall(c: SheetCanvas, result: BuildResult, bs: list[PB], wf: WallFrame) -> None:
    k = result.product
    site = k.site
    corner = k.layout == "corner"
    name = "А" if wf.wall == "a" else "Б"
    utils = [u for u in (site.utilities if site else []) if u.wall == wf.wall]
    box = c.sheet(f"Развёртка стены {name}" + (" (от угла)" if corner else " (от левого края)"))
    ink = Ink(c)
    parts = wf.parts or bs
    U0, U1, V0, V1 = wf.view.extent(parts)
    w0, w1 = sorted((wf.to_u(0), wf.to_u(wf.length)))
    U0, U1 = min(U0, w0), max(U1, w1)
    ceiling = site.ceiling if site and site.ceiling else None
    V0, V1 = 0.0, max(V1, ceiling or 0)
    W, H = U1 - U0, V1 - V0
    tab_w = 72 * MM if utils or (site and site.window and site.window.wall == wf.wall) else 0
    mL, mR, mT, mB = LEVEL + 15 * MM, 4 * MM + (tab_w + 4 * MM if tab_w else 0), 2 * LEVEL + 12 * MM, 3 * LEVEL + 8 * MM
    n = pick_scale(W, H, box.w, box.h, mL + mR, mT + mB)
    s = MM / n
    c.sheet_scale = scale_label(n)
    ox = box.x0 + mL + max(0, (box.w - mL - mR - W * s) / 2)
    oy = box.y0 + mB + max(0, (box.h - mB - mT - H * s) / 2)
    xf = Xf(ox, oy, s, U0, V0)
    # Стена, пол, потолок, угол
    thin(c, 0.3)
    c.rect(xf.X(w0), xf.Y(0), (w1 - w0) * s, (V1 - V0) * s, stroke=1, fill=0)
    c.setLineWidth(1.2)
    c.line(xf.X(U0) - 3 * MM, xf.Y(0), xf.X(U1) + 3 * MM, xf.Y(0))
    thin(c, 0.25)
    x = xf.X(U0) - 3 * MM
    while x < xf.X(U1) + 3 * MM:
        c.line(x, xf.Y(0), x - 1.4 * MM, xf.Y(0) - 1.4 * MM)
        x += 2.5 * MM
    draw_ortho(c, result, parts, wf.view, xf)
    if wf.corner_u is not None:
        c.setLineWidth(1.6)
        xc = xf.X(wf.corner_u)
        c.line(xc, xf.Y(0), xc, xf.Y(V1))
        lft = wf.corner_u <= (U0 + U1) / 2
        ink.place([(xc + (-1.2 * MM if lft else 1.2 * MM), xf.Y(V1) + 1.5 * MM, "r" if lft else "l", 0)],
                  "угол", 6.5, FB)
    _front_size_labels(ink, parts, wf.view, xf)
    # Окно
    win = site.window if site and site.window and site.window.wall == wf.wall else None
    if win:
        a, b = sorted((wf.to_u(win.from_corner), wf.to_u(win.from_corner + win.width)))
        top = min(V1, win.sill + 1400)
        dashed(c, 0.5)
        c.rect(xf.X(a), xf.Y(win.sill), (b - a) * s, (top - win.sill) * s, stroke=1, fill=0)
        thin(c)
        ink.place([((xf.X(a) + xf.X(b)) / 2, xf.Y(top) + 1.2 * MM, "c", 0),
                   ((xf.X(a) + xf.X(b)) / 2, xf.Y(win.sill) - 3.2 * MM, "c", 0)],
                  f"Окно {fmt(win.width)}, подоконник {fmt(win.sill)}", 6)
    # Выводы коммуникаций
    for i, u in enumerate(utils, start=1):
        ux = xf.X(wf.to_u(u.from_corner))
        uy = xf.Y(u.height if u.height is not None else 150)
        mark = UTIL_MARK.get(u.kind, "?")
        r = 1.9 * MM
        thin(c, 0.5)
        c.setFillColor(WHITE)
        if u.kind == "socket":
            c.rect(ux - r, uy - r, 2 * r, 2 * r, stroke=1, fill=1)
        elif u.kind == "vent":
            c.rect(ux - 1.5 * r, uy - r, 3 * r, 2 * r, stroke=1, fill=1)
        else:
            c.circle(ux, uy, r, stroke=1, fill=1)
        ink.text(ux, uy - 0.32 * 5.6, mark, 5.6, "c", font=FB)
        ink.place([(ux + r + 0.8 * MM, uy + 0.8 * MM, "l", 0), (ux - r - 0.8 * MM, uy + 0.8 * MM, "r", 0),
                   (ux + r + 0.8 * MM, uy - 3 * MM, "l", 0)], f"{i}", 6.2, FB)
    # Цепочки: модули нижнего и верхнего рядов, положения от угла (края стены)
    mods = kitchen_mods(result)
    rows_b = [m for m in mods if m.row == ("base" if wf.wall == "a" else "base2")]
    rows_w = [m for m in mods if m.row == ("wall" if wf.wall == "a" else "wall2")]
    bottom, top_y, left_x = xf.Y(0), xf.Y(V1), xf.X(U0)
    if rows_b:
        ds = sorted({m.a for m in rows_b} | {m.b for m in rows_b} | ({0.0} if corner else set()))
        hchain(ink, [wf.to_u(d) for d in ds], xf.X, bottom - LEVEL - 1.5 * MM, bottom)
        h_ordinate(ink, ds, lambda d: xf.X(wf.to_u(d)), bottom - 2 * LEVEL - 1 * MM)
    if wf.length:
        hdim(ink, xf.X(w0), xf.X(w1), bottom - 3 * LEVEL - 6 * MM, f"стена {fmt(wf.length)}", bottom)
    if rows_w:
        kh = kitchen_heights(parts)
        ds = sorted({m.a for m in rows_w} | {m.b for m in rows_w} | ({0.0} if corner else set()))
        yt = xf.Y(kh.wall_top) if kh.wall_top else top_y
        hchain(ink, [wf.to_u(d) for d in ds], xf.X, top_y + LEVEL, yt)
        h_ordinate(ink, ds, lambda d: xf.X(wf.to_u(d)), top_y + LEVEL + 3.5 * MM, down=False)
    kh = kitchen_heights(parts)
    marks = kh.marks() + ([ceiling] if ceiling else [])
    vchain(ink, marks, xf.Y, left_x - LEVEL, left_x, skip_below=5)
    v_ordinate(ink, marks, xf.Y, left_x - LEVEL - 4 * MM)
    ref = "от угла" if corner else "от левого края стены"
    view_label(ink, box.x0, box.y1 - 4 * MM, f"Стена {name}: модули, выводы; размеры по низу и верху — {ref}")
    # Таблица выводов
    if tab_w:
        rows = [["№", "Вывод", "От угла" if corner else "От края", "Высота", "Размер"]]
        for i, u in enumerate(utils, start=1):
            rows.append([str(i), f"{UTIL_MARK.get(u.kind, '')} {UTIL_NAMES.get(u.kind, u.kind)}", fmt(u.from_corner),
                         fmt(u.height) if u.height is not None else "—", u.size or "—"])
        if win:
            rows.append(["", "Окно", fmt(win.from_corner), fmt(win.sill), fmt(win.width)])
        grid_table(c, ink, box.x1 - tab_w, box.y1 - 8 * MM, [7 * MM, 25 * MM, 14 * MM, 13 * MM, tab_w - 59 * MM],
                   rows, 5.8, aligns="clrrl")
    fb = c.frame_box()
    for i, line in enumerate((f"Положения модулей и выводов — {ref}, мм; высоты — от чистого пола.",
                              "В — вода, К — канализация, Г — газ, Р — розетка, ВК — вентканал.")):
        ink.text(fb.x0 + 2 * MM, fb.y0 + STAMP_H - (4 + 3.2 * i) * MM, fit_text(line, F, 5.8, fb.w - STAMP_W - 4 * MM),
                 5.8, "l", reserve=False)
    c.showPage()


def sheets_walls(c: SheetCanvas, result: BuildResult, bs: list[PB]) -> None:
    for wf in kitchen_walls(result, bs):
        sheet_wall(c, result, bs, wf)


# --- Титул «Комплект чертежей» ---

def _material_summary(result: BuildResult) -> list[list[str]]:
    def most(roles: set[str]) -> str:
        cnt: dict[str, int] = {}
        for p in result.parts:
            if p.role in roles:
                cnt[p.material] = cnt.get(p.material, 0) + 1
        if not cnt:
            return "—"
        try:
            return material(max(cnt, key=cnt.get)).name
        except KeyError:
            return max(cnt, key=cnt.get)

    edges: dict[str, int] = {}
    for p in result.parts:
        for e in p.edges.values():
            edges[e] = edges.get(e, 0) + 1
    edge_names = ", ".join(edge_type(e).name for e in sorted(edges)) or "—"
    w, h, d = (to_mm(v) for v in result.size)
    rows = [["Изделие", product_name(result)], ["Габариты (Ш×В×Г)", f"{fmt(w)} × {fmt(h)} × {fmt(d)} мм"],
            ["Корпус", most({"side", "top", "bottom", "partition", "shelf"})],
            ["Фасады", most(FRONT_ROLES)], ["Задняя стенка", most({"back"})]]
    if is_kitchen(result):
        rows.append(["Столешница", most({"countertop"})])
    sheet_parts = [p for p in result.parts if _drawn(p)]
    rows += [["Кромка", edge_names],
             ["Деталей", f"{len(sheet_parts)} шт., чертежей {len(part_groups(result))}"],
             ["Отверстий", str(sum(len(p.holes) for p in sheet_parts))],
             ["Фурнитура", f"{len(hardware_list(result))} позиций, {sum(q for _, q in hardware_list(result))} шт."]]
    return rows


def sheet_cover(c: SheetCanvas, result: BuildResult, bs: list[PB], nesting=None) -> None:
    box = c.sheet("Комплект чертежей. Титульный лист")
    ink = Ink(c)
    info = c.info
    ink.text(box.x0 + 4 * MM, box.y1 - 12 * MM, "Комплект чертежей", 22, "l", font=FB)
    ink.text(box.x0 + 4 * MM, box.y1 - 21 * MM, fit_text(product_line(result), FB, 12, box.w * 0.6), 12, "l",
             font=FB)
    ink.text(box.x0 + 4 * MM, box.y1 - 28 * MM, fit_text(info.project, F, 9, box.w * 0.6), 9, "l")
    ink.text(box.x0 + 4 * MM, box.y1 - 34 * MM, f"Цех: {info.workshop or '____________________'} · {info.issued}",
             9, "l")
    rows = _material_summary(result)
    if nesting is not None:
        sheets = sum(len(m.sheets) for m in nesting.materials)
        rows.append(["Листов в раскрое", f"{sheets} (отход {nesting_waste(nesting)})"])
    y = grid_table(c, ink, box.x0 + 4 * MM, box.y1 - 42 * MM, [34 * MM, 96 * MM], rows, 7, head=False)
    # Изделие в изометрии (закрыто)
    area = Box(box.x0 + box.w * 0.55, box.y0 + 4 * MM, box.x1 - 4 * MM, box.y1 - 6 * MM)
    draw_iso(c, ink, bs, area, balloons=False, lw=0.3)

    def contents(cv: SheetCanvas, titles: list[str]) -> None:
        ink2 = Ink(cv)
        groups: list[list] = []
        for i, t in enumerate(titles, start=1):
            if groups and groups[-1][2] == t:
                groups[-1][1] = i
            else:
                groups.append([i, i, t])
        data = [["Лист", "Содержание"]] + [[f"{a}" if a == b else f"{a}–{b}", t] for a, b, t in groups]
        ink2.text(box.x0 + 4 * MM, y - 6 * MM, "Состав комплекта", 9, "l", font=FB)
        grid_table(cv, ink2, box.x0 + 4 * MM, y - 8 * MM, [16 * MM, 114 * MM], data, 6.6, aligns="cl")

    c.defer(contents)
    c.showPage()


def nesting_waste(nesting) -> str:
    vals = [m.waste_percent for m in nesting.materials]
    return f"{round(sum(vals) / len(vals))}%" if vals else "—"


# --- Экспорт ---

def _doc(result: BuildResult, project: str, workshop: str) -> tuple[io.BytesIO, SheetCanvas]:
    buf = io.BytesIO()
    info = DocInfo(project=project, product=product_line(result), workshop=workshop)
    return buf, SheetCanvas(buf, info)


def _general(c: SheetCanvas, result: BuildResult, bs: list[PB], walls: bool = True) -> None:
    if not bs:
        box = c.sheet("Общий вид")
        Ink(c).text(box.x0, box.y1 - 10 * MM, "Нет деталей — модель не собрана", 10, "l")
        c.showPage()
        return
    sheet_views(c, result, bs)
    sheet_no_fronts(c, result, bs)
    if is_kitchen(result):
        sheet_plan(c, result, bs)
        if walls:
            sheets_walls(c, result, bs)


def export_general_view(result: BuildResult, project: str = "Проект", workshop: str = "") -> bytes:
    buf, c = _doc(result, project, workshop)
    _general(c, result, boxes(result.parts))
    c.save()
    return buf.getvalue()


def export_part_drawings(result: BuildResult, project: str = "Проект", workshop: str = "") -> bytes:
    buf, c = _doc(result, project, workshop)
    sheets_parts(c, result)
    c.save()
    return buf.getvalue()


def export_assembly(result: BuildResult, project: str = "Проект", workshop: str = "") -> bytes:
    buf, c = _doc(result, project, workshop)
    bs = boxes(result.parts)
    if bs:
        sheets_exploded(c, result, bs)
    else:
        c.sheet("Схема сборки")
        c.showPage()
    c.save()
    return buf.getvalue()


def export_drawing_set_pdf(result: BuildResult, nesting=None, project: str = "Проект", workshop: str = "") -> bytes:
    """«Комплект чертежей» одним PDF: титул с составом, общий вид и виды, план и развёртки стен (кухня),
    взрыв-схема с фурнитурой, чертежи деталей, спецификация, карты раскроя. Сквозная нумерация листов."""
    from ..nesting import nest
    from .pdf import draw_cutmaps, draw_spec

    if nesting is None:
        nesting = nest(result)
    buf, c = _doc(result, project, workshop)
    c.setTitle(f"Комплект чертежей · {project}")
    bs = boxes(result.parts)
    sheet_cover(c, result, bs, nesting)
    _general(c, result, bs)
    if bs:
        sheets_exploded(c, result, bs)
    sheets_parts(c, result)
    draw_spec(c, result)
    draw_cutmaps(c, result, nesting)
    c.save()
    return buf.getvalue()
