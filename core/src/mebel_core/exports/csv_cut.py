"""CSV для онлайн-кроя поставщика (FR-31).

Формат EMAN пока не известен (уточняется на переговорах после MVP), поэтому
это общий формат: разделитель «;», UTF-8 с BOM (открывается в Excel).
Размеры — размер распила, мм; кромка — толщина по сторонам; «Обработка» — фрезеровка, вставки,
покраска, пазы под подсветку (файлы ЧПУ — в DXF).
"""

import csv
import io

from ..assembler import BuildResult
from ..catalog import edge_type, material
from ..decor import part_ops
from ..units import to_mm
from .csv_safe import SafeWriter

HEADER = ["№", "Наименование", "Материал", "Длина", "Ширина", "Кол-во", "Кромка Д1", "Кромка Д2", "Кромка Ш1",
          "Кромка Ш2", "Текстура", "Поворот", "Обработка"]


def export_csv(result: BuildResult) -> bytes:
    buf = io.StringIO()
    w = SafeWriter(csv.writer(buf, delimiter=";", lineterminator="\r\n"))  # названия — текстом, не формулой
    w.writerow(HEADER)
    for p in result.parts:
        mat = material(p.material)
        if not mat.is_sheet:
            continue

        def edge(side: str) -> str:
            e = p.edges.get(side)
            return f"{to_mm(edge_type(e).thickness):g}" if e else ""

        w.writerow([
            p.number, p.name, mat.name, f"{to_mm(p.cut_length):g}", f"{to_mm(p.cut_width):g}", 1,
            edge("y0"), edge("y1"), edge("x0"), edge("x1"),
            "по длине" if p.grain == "length" else ("по ширине" if p.grain == "width" else "нет"),
            "нельзя" if p.grain != "none" else "можно",
            part_ops(p),
        ])
    return ("﻿" + buf.getvalue()).encode("utf-8")
