"""Геометрия изделия: размеры частей, световые проёмы, створки, стекла, импосты (PRD, раздел 9).

Система координат: мм от верхнего левого угла рамы (по наружному контуру), y — вниз.
Размеры частей — по осям импостов; крайние части — от наружного края рамы до оси.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from . import shapes as shp
from .model import child, is_leaf, root_of


class GeometryError(ValueError):
    def __init__(self, code: str, msg: str, path: str = ""):
        super().__init__(msg)
        self.code, self.msg, self.path = code, msg, path


@dataclass
class Rect:
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def w(self) -> float:
        return self.x1 - self.x0

    @property
    def h(self) -> float:
        return self.y1 - self.y0


@dataclass
class CellGeo:
    path: str
    cell: dict
    axis: Rect                         # по осям / наружному краю
    sides: dict                        # left/right/top/bottom -> frame | mullion | shtulp | none
    light: Rect                        # световой проём (в свету между профилями)
    sash: Rect | None = None           # габарит створки
    ffb: float | None = None           # ширина створки по фальцу
    ffh: float | None = None           # высота створки по фальцу
    glass_w: float = 0.0
    glass_h: float = 0.0
    bead_lengths: list = field(default_factory=list)
    weight_kg: float | None = None     # вес створки (заполняет rules/bom, когда известно стекло)
    shaped: bool = False               # контур рамы обрезает ячейку (§1)
    poly: list | None = None           # контур света фигурной ячейки
    glass_poly: list | None = None     # контур стекла (по размеру стекла)
    vis_poly: list | None = None       # видимое стекло (по штапику) — для раскладки и схемы
    sash_poly: list | None = None      # контур створки
    sash_chain: list = field(default_factory=list)   # куски профиля створки [(мм, гнутый)]
    glass_area_m2: float = 0.0
    glass_perim_mm: float = 0.0
    extra: dict = field(default_factory=dict)        # раздвижная / гильотина (§11): leaf / panel для ответа API

    @property
    def opening(self) -> bool:
        return self.cell.get("type") in ("sash", "door_sash")


@dataclass
class Mullion:
    path: str                          # узел деления, которому принадлежит импост
    orient: str                        # v | h
    at: float                          # координата оси
    span: tuple                        # (from, to) по другой оси, по осям/краю
    length: float                      # длина отрезка профиля
    clear: float                       # длина в свету
    c0: float = 0.0                    # начало светового отрезка по другой оси
    c1: float = 0.0                    # конец светового отрезка


@dataclass
class Geometry:
    w: float
    h: float
    cells: list
    mullions: list
    shtulps: list
    frame_pieces: list                 # длины отрезков рамы
    sizes: dict                        # путь узла -> размеры частей
    shape: str = "rect"
    shape_params: dict = field(default_factory=dict)
    contour: list | None = None        # наружный контур фигурной рамы
    area_m2: float = 0.0               # площадь изделия по контуру
    perimeter_mm: float = 0.0
    bent_mm: float = 0.0               # гнутая часть: рама + створки (работа work_bend)
    frame_chain: list = field(default_factory=list)   # куски рамы [(мм, гнутый)]
    vslides: list = field(default_factory=list)       # узлы гильотинного окна (§11.2): {path, rect}
    special: dict | None = None                       # раздвижная / гильотина (§11): параметры для BOM, API, схемы


def resolve_sizes(parts: list, total: float, path: str) -> list[float]:
    fixed = [p["size"] for p in parts if isinstance(p.get("size"), (int, float))]
    n_eq = sum(1 for p in parts if not isinstance(p.get("size"), (int, float)))
    rest = total - sum(fixed)
    if n_eq == 0:
        if abs(rest) > 0.5:
            raise GeometryError("1.4", f"сумма частей {sum(fixed):g} ≠ размеру {total:g} мм", path)
        return [float(p["size"]) for p in parts]
    if rest <= 0:
        raise GeometryError("1.4", f"зафиксированные части ({sum(fixed):g} мм) не оставляют места для остальных в {total:g} мм", path)
    eq = rest / n_eq
    return [float(p["size"]) if isinstance(p.get("size"), (int, float)) else eq for p in parts]


def build(doc: dict, passport: dict) -> Geometry:
    fr = doc["frame"]
    W, H = float(fr["w"]), float(fr["h"])
    bf, bi, bs = passport["bf"], passport["bi"], passport["bs"]
    ov, r, g, lip = passport["ov"], passport["r"], passport["g"], passport.get("lip_mm", 20)
    imp_add, weld = passport.get("imp_add", 0), passport.get("weld_mm", 0)
    shape, sp = fr.get("shape") or "rect", dict(fr.get("shape_params") or {})
    cont = None
    if shape != "rect":
        probs = shp.shape_problems(shape, sp, W, H)
        if probs:
            raise GeometryError("1.8", "; ".join(probs))
        cont = shp.contour(shape, sp, W, H)

    cells, mullions, shtulps, sizes, vslides = [], [], [], {}, []

    def ded(side_type: str) -> float:
        return {"frame": bf, "mullion": bi / 2, "shtulp": 0.0, "none": 0.0, "folding": 0.0, "vslide": 0.0}[side_type]

    def cut(rect: Rect, offset: float):
        return shp.clip(shp.rect_poly(rect.x0, rect.y0, rect.x1, rect.y1), cont, offset)

    def rec(node: dict, path: str, rect: Rect, sides: dict):
        if is_leaf(node):
            cell = node["cell"]
            light = Rect(rect.x0 + ded(sides["left"]), rect.y0 + ded(sides["top"]),
                         rect.x1 - ded(sides["right"]), rect.y1 - ded(sides["bottom"]))
            cg = CellGeo(path=path, cell=cell, axis=rect, sides=dict(sides), light=light)
            if light.w <= 0 or light.h <= 0:
                raise GeometryError("1.5", f"ячейка {path or 'корень'}: нет светового проёма ({light.w:.0f}×{light.h:.0f} мм)", path)
            light0 = light                            # прямоугольник света (до обрезки контуром)
            if cont:
                lp, _ = cut(light, bf)
                la = shp.area(lp)
                if la < 1.0:
                    raise GeometryError("1.5", f"ячейка {path or 'корень'}: целиком вне контура рамы", path)
                if light.w * light.h - la > max(100.0, 0.002 * light.w * light.h):
                    cg.shaped, cg.poly = True, [(round(x, 1), round(y, 1)) for x, y in lp]
                    x0, y0, x1, y1 = shp.bbox(lp)
                    cg.light = light = Rect(x0, y0, x1, y1)
            if cg.opening:
                base = light0
                add = {k: (ov if v not in ("none", "folding") else 0.0) for k, v in sides.items()}
                sash = Rect(base.x0 - add["left"], base.y0 - add["top"], base.x1 + add["right"], base.y1 + add["bottom"])
                if cg.shaped:
                    sp_pts, sp_tags = cut(sash, bf - ov)
                    cg.sash_poly = sp_pts
                    cg.sash_chain = shp.chains(sp_pts, sp_tags, cont[2])
                gl = Rect(sash.x0 + bs, sash.y0 + bs, sash.x1 - bs, sash.y1 - bs)
                if cg.shaped:
                    sash = Rect(*shp.bbox(sp_pts))
                cg.sash = sash
                cg.ffb, cg.ffh = cg.sash.w - 2 * lip, cg.sash.h - 2 * lip
                inset = bf - ov + bs                      # отступ штапика створки от наружного контура
            else:
                gl = light0
                inset = bf
            if cg.shaped:
                vp, vt = cut(gl, inset)
                gp, _ = cut(Rect(gl.x0 - (r - g), gl.y0 - (r - g), gl.x1 + (r - g), gl.y1 + (r - g)), inset - (r - g))
                cg.vis_poly, cg.glass_poly = vp, gp
                bx0, by0, bx1, by1 = shp.bbox(gp)
                cg.glass_w, cg.glass_h = bx1 - bx0, by1 - by0
                cg.glass_area_m2 = shp.area(gp) / 1e6
                cg.glass_perim_mm = shp.perimeter(gp)
                cg.bead_lengths = [L for L, _ in shp.chains(vp, vt, cont[2])]
            else:
                cg.glass_w, cg.glass_h = gl.w + 2 * r - 2 * g, gl.h + 2 * r - 2 * g
                cg.glass_area_m2 = cg.glass_w * cg.glass_h / 1e6
                cg.glass_perim_mm = 2 * (cg.glass_w + cg.glass_h)
                cg.bead_lengths = [gl.w, gl.w, gl.h, gl.h]
                cg.vis_poly = shp.rect_poly(gl.x0, gl.y0, gl.x1, gl.y1)[0]
            cells.append(cg)
            return
        split = node.get("split")
        parts = node.get("parts", [])
        if split not in ("v", "h", "shtulp", "none", "folding", "vslide") or not parts:
            raise GeometryError("1.4", f"узел {path or 'корень'}: неизвестное деление «{split}»", path)
        vertical = split in ("v", "shtulp", "none", "folding")      # части идут слева направо
        total = rect.w if vertical else rect.h
        sz = resolve_sizes(parts, total, path)
        sizes[path] = sz
        boundary = {"v": "mullion", "h": "mullion", "shtulp": "shtulp", "none": "none", "folding": "folding",
                    "vslide": "vslide"}[split]           # vslide: полотна сверху вниз, встречная планка без импоста
        if split == "vslide":
            vslides.append({"path": path, "rect": rect})
        pos = rect.x0 if vertical else rect.y0
        for i, (part, s) in enumerate(zip(parts, sz)):
            p_path = f"{path}.{i}" if path else str(i)
            if vertical:
                sub = Rect(pos, rect.y0, pos + s, rect.y1)
                sub_sides = dict(sides, left=sides["left"] if i == 0 else boundary,
                                 right=sides["right"] if i == len(parts) - 1 else boundary)
            else:
                sub = Rect(rect.x0, pos, rect.x1, pos + s)
                sub_sides = dict(sides, top=sides["top"] if i == 0 else boundary,
                                 bottom=sides["bottom"] if i == len(parts) - 1 else boundary)
            if i > 0:
                if boundary == "mullion":
                    if vertical:
                        c0, c1 = rect.y0 + ded(sides["top"]), rect.y1 - ded(sides["bottom"])
                        if cont:
                            seg = shp.clip_segment((pos, c0), (pos, c1), cont, bf)
                            if not seg:
                                raise GeometryError("1.5", f"импост {path or 'корень'}: вне контура рамы", path)
                            c0, c1 = seg[0][1], seg[1][1]
                        clear = c1 - c0
                        mullions.append(Mullion(path, "v", pos, (rect.y0, rect.y1), clear + 2 * imp_add, clear, c0, c1))
                    else:
                        c0, c1 = rect.x0 + ded(sides["left"]), rect.x1 - ded(sides["right"])
                        if cont:
                            seg = shp.clip_segment((c0, pos), (c1, pos), cont, bf)
                            if not seg:
                                raise GeometryError("1.5", f"импост {path or 'корень'}: вне контура рамы", path)
                            c0, c1 = seg[0][0], seg[1][0]
                        clear = c1 - c0
                        mullions.append(Mullion(path, "h", pos, (rect.x0, rect.x1), clear + 2 * imp_add, clear, c0, c1))
                elif boundary == "shtulp":
                    c0, c1 = rect.y0 + ded(sides["top"]), rect.y1 - ded(sides["bottom"])
                    if cont:
                        seg = shp.clip_segment((pos, c0), (pos, c1), cont, bf)
                        if seg:
                            c0, c1 = seg[0][1], seg[1][1]
                    shtulps.append({"path": path, "at": pos, "length": c1 - c0 + 2 * ov})
            rec(child(part), p_path, sub, sub_sides)
            pos += s

    root = root_of(doc)
    rec(root, "", Rect(0, 0, W, H), {"left": "frame", "right": "frame", "top": "frame", "bottom": "frame"})
    geo = Geometry(W, H, cells, mullions, shtulps, [W + 2 * weld, W + 2 * weld, H + 2 * weld, H + 2 * weld], sizes,
                   shape=shape, shape_params=sp, area_m2=W * H / 1e6, perimeter_mm=2 * (W + H), vslides=vslides)
    if cont:
        bar = passport.get("bar_mm", 6000)
        chain = shp.chains(cont[0], cont[1], cont[2])
        geo.contour = [(round(x, 1), round(y, 1)) for x, y in cont[0]]
        geo.area_m2 = shp.area(cont[0]) / 1e6
        geo.perimeter_mm = shp.perimeter(cont[0])
        pieces, fchain = [], []
        for L, bent in chain:
            n = max(1, math.ceil((L + 2 * weld) / (bar - 50))) if bent else 1   # гнутый кусок длиннее хлыста — из частей
            for _ in range(n):
                pieces.append(L / n + 2 * weld)
                fchain.append((L / n, bent))
        geo.frame_pieces, geo.frame_chain = pieces, fchain
        geo.bent_mm = sum(L for L, b in chain if b) + sum(L for c in cells for L, b in c.sash_chain if b)
    return geo


def sash_pieces(cg: CellGeo, passport: dict) -> list[float]:
    weld = passport.get("weld_mm", 0)
    if cg.sash_chain:
        return [L + 2 * weld for L, _ in cg.sash_chain]
    return [cg.sash.w + 2 * weld] * 2 + [cg.sash.h + 2 * weld] * 2


def sash_perimeter(cg: CellGeo) -> float:
    if cg.sash_chain:
        return sum(L for L, _ in cg.sash_chain)
    return 2 * (cg.sash.w + cg.sash.h)


def sash_weight(cg: CellGeo, glass_kg_m2: float, passport: dict) -> float:
    """Правило 3: вес стекла по его размеру + профиль створки по периметру."""
    q = passport.get("profile_kg_m", {}).get("sash", 1.7)
    perim_m = sash_perimeter(cg) / 1000
    return round(cg.glass_area_m2 * glass_kg_m2 + perim_m * q, 1)
