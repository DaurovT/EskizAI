"""Геометрия изделия: размеры частей, световые проёмы, створки, стекла, импосты (PRD, раздел 9).

Система координат: мм от верхнего левого угла рамы (по наружному контуру), y — вниз.
Размеры частей — по осям импостов; крайние части — от наружного края рамы до оси.
"""
from __future__ import annotations

from dataclasses import dataclass, field

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
    W, H = float(doc["frame"]["w"]), float(doc["frame"]["h"])
    bf, bi, bs = passport["bf"], passport["bi"], passport["bs"]
    ov, r, g, lip = passport["ov"], passport["r"], passport["g"], passport.get("lip_mm", 20)
    imp_add, weld = passport.get("imp_add", 0), passport.get("weld_mm", 0)

    cells, mullions, shtulps, sizes = [], [], [], {}

    def ded(side_type: str) -> float:
        return {"frame": bf, "mullion": bi / 2, "shtulp": 0.0, "none": 0.0}[side_type]

    def rec(node: dict, path: str, rect: Rect, sides: dict):
        if is_leaf(node):
            cell = node["cell"]
            light = Rect(rect.x0 + ded(sides["left"]), rect.y0 + ded(sides["top"]),
                         rect.x1 - ded(sides["right"]), rect.y1 - ded(sides["bottom"]))
            cg = CellGeo(path=path, cell=cell, axis=rect, sides=dict(sides), light=light)
            if cg.opening:
                add = {k: (ov if v != "none" else 0.0) for k, v in sides.items()}
                cg.sash = Rect(light.x0 - add["left"], light.y0 - add["top"], light.x1 + add["right"], light.y1 + add["bottom"])
                cg.ffb, cg.ffh = cg.sash.w - 2 * lip, cg.sash.h - 2 * lip
                gl = Rect(cg.sash.x0 + bs, cg.sash.y0 + bs, cg.sash.x1 - bs, cg.sash.y1 - bs)
            else:
                gl = light
            cg.glass_w, cg.glass_h = gl.w + 2 * r - 2 * g, gl.h + 2 * r - 2 * g
            cg.bead_lengths = [gl.w, gl.w, gl.h, gl.h]
            if light.w <= 0 or light.h <= 0:
                raise GeometryError("1.5", f"ячейка {path or 'корень'}: нет светового проёма ({light.w:.0f}×{light.h:.0f} мм)", path)
            cells.append(cg)
            return
        split = node.get("split")
        parts = node.get("parts", [])
        if split not in ("v", "h", "shtulp", "none") or not parts:
            raise GeometryError("1.4", f"узел {path or 'корень'}: неизвестное деление «{split}»", path)
        vertical = split in ("v", "shtulp", "none")      # части идут слева направо
        total = rect.w if vertical else rect.h
        sz = resolve_sizes(parts, total, path)
        sizes[path] = sz
        boundary = {"v": "mullion", "h": "mullion", "shtulp": "shtulp", "none": "none"}[split]
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
                        clear = rect.h - ded(sides["top"]) - ded(sides["bottom"])
                        mullions.append(Mullion(path, "v", pos, (rect.y0, rect.y1), clear + 2 * imp_add, clear,
                                                rect.y0 + ded(sides["top"]), rect.y1 - ded(sides["bottom"])))
                    else:
                        clear = rect.w - ded(sides["left"]) - ded(sides["right"])
                        mullions.append(Mullion(path, "h", pos, (rect.x0, rect.x1), clear + 2 * imp_add, clear,
                                                rect.x0 + ded(sides["left"]), rect.x1 - ded(sides["right"])))
                elif boundary == "shtulp":
                    shtulps.append({"path": path, "at": pos, "length": rect.h - ded(sides["top"]) - ded(sides["bottom"]) + 2 * ov})
            rec(child(part), p_path, sub, sub_sides)
            pos += s

    root = root_of(doc)
    rec(root, "", Rect(0, 0, W, H), {"left": "frame", "right": "frame", "top": "frame", "bottom": "frame"})
    frame_pieces = [W + 2 * weld, W + 2 * weld, H + 2 * weld, H + 2 * weld]
    return Geometry(W, H, cells, mullions, shtulps, frame_pieces, sizes)


def sash_pieces(cg: CellGeo, passport: dict) -> list[float]:
    weld = passport.get("weld_mm", 0)
    return [cg.sash.w + 2 * weld] * 2 + [cg.sash.h + 2 * weld] * 2


def sash_weight(cg: CellGeo, glass_kg_m2: float, passport: dict) -> float:
    """Правило 3: вес стекла по его размеру + профиль створки по периметру."""
    q = passport.get("profile_kg_m", {}).get("sash", 1.7)
    perim_m = 2 * (cg.sash.w + cg.sash.h) / 1000
    return round(cg.glass_w * cg.glass_h / 1e6 * glass_kg_m2 + perim_m * q, 1)
