"""Защита CSV от «формул» (CSV/formula injection): ячейка-строка, начинающаяся с `=`, `+`, `-`, `@`,
табуляции или перевода строки, в Excel/LibreOffice/Google Sheets исполняется как формула
(например, `=HYPERLINK(…)` из названия цеха). Такой строке ставим впереди апостроф `'` — она остаётся текстом.
Числа (int/float) не трогаем: отрицательная сумма остаётся числом. Один помощник на все выгрузки CSV.
"""

from typing import Any, Iterable

_DANGER = ("=", "+", "-", "@", "\t", "\r", "\n")


def safe_cell(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(_DANGER):
        return "'" + value
    return value


def safe_row(row: Iterable[Any]) -> list[Any]:
    return [safe_cell(v) for v in row]


class SafeWriter:
    """Обёртка над csv.writer: каждая строка проходит safe_row."""

    def __init__(self, writer):
        self._w = writer

    def writerow(self, row: Iterable[Any]):
        return self._w.writerow(safe_row(row))

    def writerows(self, rows: Iterable[Iterable[Any]]):
        for r in rows:
            self.writerow(r)
