"""Раскрой деталей по листам (FR-29, раздел 7 PRD).

Гильотинная укладка (как на форматно-раскроечном станке), отдельно по
каждому материалу. Учитываются пропил, обрезка кромок листа и направление
текстуры: детали с текстурой не поворачиваются. Размеры — размер распила.
Деталь с контуром укладывается по габариту.
"""

from collections import defaultdict

import rectpack
from pydantic import BaseModel

from .assembler import BuildResult
from .catalog import material
from .rules import DEFAULT_RULES, RuleSet
from .units import to_mm


class Placed(BaseModel):
    number: int  # номер детали
    x: int  # от левого нижнего угла полезной области листа, dmm
    y: int
    length: int  # вдоль длины листа, dmm
    width: int
    rotated: bool  # деталь повёрнута (её длина идёт поперёк листа)


class Sheet(BaseModel):
    material: str
    index: int
    length: int
    width: int
    parts: list[Placed]
    used_area: int

    @property
    def usage(self) -> float:
        return self.used_area / (self.length * self.width)


class MaterialNesting(BaseModel):
    material: str
    sheets: list[Sheet]
    parts_area: int
    waste_percent: float  # отход по всем листам материала, %
    last_sheet_usage: float  # заполнение последнего листа, 0–1


class Nesting(BaseModel):
    materials: list[MaterialNesting]
    unplaced: list[int]  # номера деталей, которые не легли ни на один лист

    def sheets_count(self, material_id: str) -> int:
        for m in self.materials:
            if m.material == material_id:
                return len(m.sheets)
        return 0


def nest(result: BuildResult, rules: RuleSet = DEFAULT_RULES) -> Nesting:
    by_material: dict[str, list] = defaultdict(list)
    for p in result.parts:
        if material(p.material).is_sheet:
            by_material[p.material].append(p)

    kerf, trim = rules.sheet_kerf, rules.sheet_trim
    usable_l = rules.sheet_length - 2 * trim
    usable_w = rules.sheet_width - 2 * trim
    out: list[MaterialNesting] = []
    unplaced: list[int] = []

    for mat_id, parts in sorted(by_material.items()):
        has_grain = material(mat_id).has_grain
        sizes = {}
        for p in parts:
            L, W = (p.cut_width, p.cut_length) if p.grain == "width" else (p.cut_length, p.cut_width)
            sizes[p.number] = (L, W)
        packer = _best_packing(sizes, usable_l + kerf, usable_w + kerf, kerf, rotation=not has_grain)

        sheets: list[Sheet] = []
        placed_numbers = set()
        for b_index, abin in enumerate(packer):
            placed = []
            used = 0
            for rect in abin:
                L, W = sizes[rect.rid]
                rotated = (rect.width - kerf) != L
                placed.append(Placed(number=rect.rid, x=rect.x, y=rect.y, length=rect.width - kerf,
                                     width=rect.height - kerf, rotated=rotated))
                used += L * W
                placed_numbers.add(rect.rid)
            placed.sort(key=lambda r: r.number)
            sheets.append(Sheet(material=mat_id, index=b_index + 1, length=rules.sheet_length,
                                width=rules.sheet_width, parts=placed, used_area=used))
        unplaced += [n for n in sizes if n not in placed_numbers]
        parts_area = sum(L * W for L, W in sizes.values())
        total_area = len(sheets) * rules.sheet_length * rules.sheet_width
        out.append(MaterialNesting(
            material=mat_id,
            sheets=sheets,
            parts_area=parts_area,
            waste_percent=round(100 * (1 - parts_area / total_area), 1) if total_area else 0.0,
            last_sheet_usage=round(sheets[-1].usage, 3) if sheets else 0.0,
        ))
    return Nesting(materials=out, unplaced=sorted(unplaced))


# Гильотинные алгоритмы (раскладка, которую можно распилить сквозными резами) и сортировки
_ALGOS = [
    rectpack.GuillotineBssfSas, rectpack.GuillotineBssfLas, rectpack.GuillotineBssfSlas,
    rectpack.GuillotineBafSas, rectpack.GuillotineBafLas, rectpack.GuillotineBlsfSas,
    rectpack.GuillotineBssfMaxas, rectpack.GuillotineBafMaxas,
]
_SORTS = [rectpack.SORT_AREA, rectpack.SORT_LSIDE, rectpack.SORT_SSIDE, rectpack.SORT_PERI, rectpack.SORT_DIFF]


def _best_packing(sizes: dict, bin_l: int, bin_w: int, kerf: int, rotation: bool, trials: int = 150):
    """Перебирает алгоритмы и берёт раскладку с меньшим числом листов,
    а при равенстве — с самым пустым последним листом (его остаток полезнее)."""
    import random

    rng = random.Random(42)  # детерминированно: одна и та же модель → один и тот же раскрой
    items = list(sizes.items())
    attempts = [(algo, sort, items) for algo in _ALGOS for sort in _SORTS]
    # Плюс случайные порядки деталей: часто дают на лист меньше
    for _ in range(trials):
        order = items[:]
        rng.shuffle(order)
        attempts.append((rng.choice(_ALGOS), rectpack.SORT_NONE, order))

    best, best_key = None, None
    for algo, sort, order in attempts:
        packer = rectpack.newPacker(mode=rectpack.PackingMode.Offline, bin_algo=rectpack.PackingBin.BFF,
                                    pack_algo=algo, sort_algo=sort, rotation=rotation)
        packer.add_bin(bin_l, bin_w, count=float("inf"))
        for number, (L, W) in order:
            packer.add_rect(L + kerf, W + kerf, rid=number)
        packer.pack()
        bins = list(packer)
        placed = sum(len(b) for b in bins)
        last = sum(r.width * r.height for r in bins[-1]) if bins else 0
        key = (len(sizes) - placed, len(bins), last)
        if best_key is None or key < best_key:
            best, best_key = packer, key
    return best


def format_nesting(n: Nesting) -> str:
    lines = ["Раскрой:"]
    for m in n.materials:
        lines.append(
            f"  {material(m.material).name}: листов {len(m.sheets)}, отход {m.waste_percent}%, "
            f"последний лист заполнен на {round(100 * m.last_sheet_usage)}%"
        )
    if n.unplaced:
        lines.append(f"  Не легли на лист: {', '.join(map(str, n.unplaced))}")
    return "\n".join(lines)


__all__ = ["nest", "Nesting", "Sheet", "Placed", "format_nesting", "to_mm"]
