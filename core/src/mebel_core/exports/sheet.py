"""Листы производственной документации: рамка и основная надпись (штамп), упрощённо по ГОСТ 2.104.

SheetCanvas — холст reportlab, который на каждом листе рисует рамку (поле подшивки 20 мм слева, 5 мм
с остальных сторон) и штамп 185×22 мм в правом нижнем углу: наименование листа, проект/изделие,
масштаб, «Лист N», «Листов M», цех, дата, «Eskiz Mebel». Число листов известно только в конце,
поэтому листы копятся и штампуются в save() (приём «NumberedCanvas»).

Шрифт DejaVu Sans (кириллица и узбекская латиница на любом сервере).
"""

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Callable

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm as MM
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

_FONTS = Path(__file__).resolve().parent.parent / "fonts"
pdfmetrics.registerFont(TTFont("DejaVu", str(_FONTS / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(_FONTS / "DejaVuSans-Bold.ttf")))
F, FB = "DejaVu", "DejaVu-Bold"

BLACK = colors.black
A4L = landscape(A4)
A4P = A4

FRAME_L, FRAME = 20 * MM, 5 * MM  # поле подшивки и остальные поля
STAMP_W, STAMP_H = 185 * MM, 22 * MM
GAP = 3 * MM  # отступ содержимого от рамки и штампа


@dataclass
class DocInfo:
    project: str = "Проект"  # проект · версия · дата (как в имени файла)
    product: str = ""  # «Шкаф-купе 2400×2400×650 мм»
    workshop: str = ""
    issued: str = field(default_factory=lambda: f"{date.today():%d.%m.%Y}")


@dataclass
class Box:
    """Прямоугольник на листе, pt."""

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


def fit_text(s: str, font: str, size: float, width: float) -> str:
    """Обрезать строку с «…», чтобы влезла в ширину."""
    if pdfmetrics.stringWidth(s, font, size) <= width:
        return s
    while s and pdfmetrics.stringWidth(s + "…", font, size) > width:
        s = s[:-1]
    return s.rstrip() + "…"


class SheetCanvas(canvas.Canvas):
    """Холст с рамкой и штампом на каждом листе. Перед рисованием листа — sheet(title, scale, size)."""

    def __init__(self, buf, info: DocInfo | None = None, **kw):
        kw.setdefault("pagesize", A4L)
        super().__init__(buf, **kw)
        self.info = info or DocInfo()
        self.setAuthor("Eskiz Mebel")
        self.setTitle(self.info.project)
        self._sheets: list[dict] = []
        self.sheet_title = ""
        self.sheet_scale = ""
        self.stamp = True
        self.deferred: list[Callable[["SheetCanvas", list[str]], None]] = []

    # --- листы ---
    def sheet(self, title: str, scale: str = "", size: tuple[float, float] = A4L, stamp: bool = True) -> Box:
        """Начать лист: размер, наименование, масштаб. Возвращает поле для содержимого (над штампом)."""
        self.setPageSize(size)
        self.sheet_title, self.sheet_scale, self.stamp = title, scale, stamp
        return self.content()

    def content(self) -> Box:
        pw, ph = self._pagesize
        return Box(FRAME_L + GAP, FRAME + STAMP_H + GAP, pw - FRAME - GAP, ph - FRAME - GAP)

    def frame_box(self) -> Box:
        pw, ph = self._pagesize
        return Box(FRAME_L, FRAME, pw - FRAME, ph - FRAME)

    def defer(self, fn: Callable[["SheetCanvas", list[str]], None]) -> None:
        """Нарисовать на этом листе в конце, когда известны все листы (содержание на титуле)."""
        self.deferred.append(fn)

    @property
    def sheet_no(self) -> int:
        return len(self._sheets) + 1

    def showPage(self) -> None:  # noqa: N802 — имя из reportlab
        self._sheets.append(dict(self.__dict__))
        self.deferred = []
        self._startPage()

    def save(self) -> None:
        if self._code:
            self.showPage()
        total = len(self._sheets)
        titles = [s["sheet_title"] for s in self._sheets]
        for i, state in enumerate(self._sheets, start=1):
            self.__dict__.update(state)
            self._frame_and_stamp(i, total)
            for fn in state["deferred"]:
                fn(self, titles)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    # --- рамка и штамп ---
    def _frame_and_stamp(self, n: int, total: int) -> None:
        fb = self.frame_box()
        self.saveState()
        self.setStrokeColor(BLACK)
        self.setFillColor(BLACK)
        self.setDash()
        self.setLineWidth(0.9)
        self.rect(fb.x0, fb.y0, fb.w, fb.h, stroke=1, fill=0)
        if not self.stamp:
            self.restoreState()
            return
        x0, y0 = fb.x1 - STAMP_W, fb.y0
        x1, y1 = fb.x1, fb.y0 + STAMP_H
        self.setFillColor(colors.white)
        self.rect(x0, y0, STAMP_W, STAMP_H, stroke=1, fill=1)
        self.setFillColor(BLACK)
        # колонки: наименование | масштаб | лист | листов; нижняя строка: цех | дата | Eskiz Mebel
        cA, cB, cC = x0 + 100 * MM, x0 + 128 * MM, x0 + 156 * MM
        r1, r2 = y0 + 8 * MM, y0 + 17 * MM
        self.setLineWidth(0.9)
        self.line(x0, r1, x1, r1)
        self.line(cA, r1, cA, y1)
        self.setLineWidth(0.4)
        self.line(cB, r1, cB, y1)
        self.line(cC, r1, cC, y1)
        self.line(cA, r2, x1, r2)
        self.line(x0 + 100 * MM, y0, x0 + 100 * MM, r1)
        self.line(x0 + 142 * MM, y0, x0 + 142 * MM, r1)
        info = self.info
        self.setFont(FB, 9.5)
        self.drawString(x0 + 2.5 * MM, y0 + 17.2 * MM, fit_text(self.sheet_title, FB, 9.5, 95 * MM))
        self.setFont(F, 7)
        self.drawString(x0 + 2.5 * MM, y0 + 12.8 * MM, fit_text(info.product, F, 7, 95 * MM))
        self.drawString(x0 + 2.5 * MM, y0 + 9.4 * MM, fit_text(info.project, F, 7, 95 * MM))
        for cx, label, value in ((cA, "Масштаб", self.sheet_scale or "—"), (cB, "Лист", str(n)),
                                 (cC, "Листов", str(total))):
            self.setFont(F, 6)
            self.drawCentredString(cx + 14 * MM, r2 + 1.6 * MM, label)
            fs = 10 if pdfmetrics.stringWidth(value, FB, 10) < 26 * MM else 6.5
            self.setFont(FB, fs)
            self.drawCentredString(cx + 14 * MM, r1 + 3.0 * MM, fit_text(value, FB, fs, 27 * MM))
        self.setFont(F, 7)
        ws = f"Цех: {info.workshop}" if info.workshop else "Цех: ____________________"
        self.drawString(x0 + 2.5 * MM, y0 + 2.8 * MM, fit_text(ws, F, 7, 95 * MM))
        self.drawString(x0 + 102.5 * MM, y0 + 2.8 * MM, f"Дата {info.issued}")
        self.setFont(FB, 8)
        self.drawCentredString(x0 + 163.5 * MM, y0 + 2.8 * MM, "Eskiz Mebel")
        self.restoreState()


def page_count(data: bytes) -> int:
    """Число листов в PDF reportlab (объекты /Type /Page)."""
    import re

    return len(re.findall(rb"/Type /Page\b(?!s)", data))
