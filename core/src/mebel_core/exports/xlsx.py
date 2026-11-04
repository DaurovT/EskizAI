"""Excel: спецификация, фурнитура, раскрой, смета мастера (раздел 8 PRD)."""

import io

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from ..assembler import BuildResult
from ..catalog import material
from ..estimate import CATEGORY_NAMES, Estimate
from ..nesting import Nesting
from ..spec import hardware_rows, number_ranges, spec_rows

HEAD = Font(bold=True)
HEAD_FILL = PatternFill("solid", fgColor="EEE6DA")


def _sheet(wb, title: str, header: list[str], rows: list[list], widths: list[int]):
    ws = wb.create_sheet(title)
    ws.append(header)
    for c in ws[1]:
        c.font, c.fill = HEAD, HEAD_FILL
        c.alignment = Alignment(wrap_text=True, vertical="center")
    for r in rows:
        ws.append(r)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    return ws


def export_xlsx(result: BuildResult, nesting: Nesting | None = None, est: Estimate | None = None,
                with_cost: bool = True) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    _sheet(
        wb, "Спецификация",
        ["№", "Деталь", "Материал", "Толщина", "Чистовой L", "Чистовой W", "Распил L", "Распил W", "Кол-во",
         "Кромка", "Текстура"],
        [[number_ranges(r.numbers), r.name, r.material, r.thickness, r.length, r.width, r.cut_length, r.cut_width,
          r.qty, " ".join(f"{k}:{v}" for k, v in r.edges.items()) or "—", r.grain] for r in spec_rows(result)],
        [12, 26, 24, 9, 11, 11, 11, 11, 8, 24, 14],
    )
    _sheet(wb, "Фурнитура", ["Наименование", "Кол-во"], [[h.name, h.qty] for h in hardware_rows(result)], [48, 10])
    if nesting:
        _sheet(
            wb, "Раскрой", ["Материал", "Листов", "Отход, %", "Заполнение последнего листа, %"],
            [[material(m.material).name, len(m.sheets), m.waste_percent, round(100 * m.last_sheet_usage)]
             for m in nesting.materials],
            [28, 10, 10, 18],
        )
    if est and with_cost:
        rows = [[CATEGORY_NAMES[l.category], l.name, l.qty, l.unit, l.unit_price, l.cost,
                 {"catalog": "каталог", "analog": "аналог", "request": "под запрос"}.get(l.status, l.status)]
                for l in est.lines]
        rows += [[], ["", "Себестоимость", "", "", "", est.cost_total],
                 ["", "Материалы для клиента", "", "", "", est.materials_client],
                 ["", "Работа мастера", "", "", "", est.work],
                 ["", "Итог клиенту", "", "", "", est.total_client]]
        ws = _sheet(wb, "Смета мастера", ["Категория", "Позиция", "Кол-во", "Ед.", "Цена, сум", "Сумма, сум", "Статус"],
                    rows, [18, 44, 10, 8, 12, 14, 12])
        for row in ws.iter_rows(min_row=2, min_col=5, max_col=6):
            for c in row:
                c.number_format = "# ##0"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
