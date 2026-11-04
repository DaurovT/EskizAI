"""Спецификация деталей и сводка фурнитуры.

Кромка обозначается по сторонам детали: Д1 / Д2 — длинные стороны
(y0 / y1), Ш1 / Ш2 — короткие (x0 / x1).
"""

from collections import OrderedDict

from pydantic import BaseModel

from .assembler import BuildResult
from .catalog import edge_type, material
from .decor import part_ops
from .units import to_mm

SIDE_LABELS = {"y0": "Д1", "y1": "Д2", "x0": "Ш1", "x1": "Ш2"}
GRAIN_LABELS = {"length": "вдоль длины", "width": "вдоль ширины", "none": "—"}


class SpecRow(BaseModel):
    numbers: list[int]
    name: str
    material: str
    thickness: float
    length: float  # чистовой, мм
    width: float
    cut_length: float  # распил, мм
    cut_width: float
    qty: int
    edges: dict[str, str]  # Д1/Д2/Ш1/Ш2 → толщина кромки
    grain: str
    ops: str = ""  # обработки: фрезеровка, вставки, покраска, пазы (decor.part_ops)


class HardwareRow(BaseModel):
    name: str
    qty: int


def spec_rows(result: BuildResult) -> list[SpecRow]:
    groups: "OrderedDict[tuple, SpecRow]" = OrderedDict()
    for p in result.parts:
        if not material(p.material).is_sheet:
            continue  # штанга, зеркало — в фурнитуре и списке стекла, не в раскрое
        edges = {SIDE_LABELS[s]: edge_type(e).code for s, e in sorted(p.edges.items())}
        ops = part_ops(p)
        key = (p.name, p.material, p.thickness, p.length, p.width, p.cut_length, p.cut_width,
               tuple(sorted(edges.items())), p.grain, ops)
        if key in groups:
            groups[key].numbers.append(p.number)
            groups[key].qty += 1
        else:
            groups[key] = SpecRow(
                numbers=[p.number],
                name=p.name,
                material=material(p.material).name,
                thickness=to_mm(p.thickness),
                length=to_mm(p.length),
                width=to_mm(p.width),
                cut_length=to_mm(p.cut_length),
                cut_width=to_mm(p.cut_width),
                qty=1,
                edges=edges,
                grain=GRAIN_LABELS[p.grain],
                ops=ops,
            )
    return list(groups.values())


def hardware_rows(result: BuildResult) -> list[HardwareRow]:
    totals: "OrderedDict[str, int]" = OrderedDict()
    for h in result.hardware:
        totals[h.name] = totals.get(h.name, 0) + h.qty
    return [HardwareRow(name=n, qty=q) for n, q in totals.items()]


def number_ranges(numbers: list[int]) -> str:
    """[8, 9, 10, 12] → «8–10, 12»."""
    out, start, prev = [], None, None
    for n in sorted(numbers) + [None]:
        if start is None:
            start = prev = n
        elif n is not None and n == prev + 1:
            prev = n
        else:
            out.append(f"{start}–{prev}" if prev != start else f"{start}")
            start = prev = n
    return ", ".join(out)


def format_text(result: BuildResult) -> str:
    """Спецификация и фурнитура текстом — для CLI и быстрой проверки."""

    def fmt(v: float) -> str:
        return f"{v:g}"

    lines = []
    w, h, d = (to_mm(v) for v in result.size)
    lines.append(f"Изделие {fmt(w)}×{fmt(h)}×{fmt(d)} мм · деталей: {len(result.parts)}")
    lines.append("")
    lines.append(f"{'№':<14}{'Деталь':<24}{'Материал':<22}{'Чистовой':>15}{'Распил':>15}{'Кол':>5}  {'Кромка':<22}Текстура")
    for r in spec_rows(result):
        nums = number_ranges(r.numbers)
        edges = " ".join(f"{k}:{v}" for k, v in r.edges.items()) or "—"
        lines.append(
            f"{nums:<14}{r.name:<24}{r.material:<22}"
            f"{fmt(r.length) + '×' + fmt(r.width):>15}{fmt(r.cut_length) + '×' + fmt(r.cut_width):>15}"
            f"{r.qty:>5}  {edges:<22}{r.grain}" + (f"  · {r.ops}" if r.ops else "")
        )
    lines.append("")
    lines.append("Фурнитура и крепёж:")
    for hw in hardware_rows(result):
        lines.append(f"  {hw.name}: {hw.qty} шт.")
    if result.issues:
        lines.append("")
        lines.append("Замечания:")
        for i in result.issues:
            mark = "ОШИБКА" if i.level == "error" else "внимание"
            lines.append(f"  [{mark}] {i.message}" + (f" ({i.path})" if i.path else ""))
    return "\n".join(lines)
