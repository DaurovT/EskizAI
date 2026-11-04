"""PDF-документы мастера (раздел 8 PRD): спецификация, карты раскроя, чертежи
деталей с присадкой, общий вид, схема сборки, коммерческое предложение (КП).

Шрифт DejaVu Sans (свободная лицензия, файл LICENSE_DEJAVU рядом со шрифтами) —
чтобы кириллица и узбекская латиница печатались одинаково на любом сервере.
КП клиенту — шрифтом Onest, как в макете (OFL, LICENSE_ONEST); без файлов — DejaVu.
"""

import io
import math
from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm as MM
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

from ..assembler import BuildResult
from ..catalog import edge_type, material
from ..nesting import Nesting
from ..spec import hardware_rows, number_ranges, spec_rows
from ..units import to_mm

_FONTS = Path(__file__).resolve().parent.parent / "fonts"
pdfmetrics.registerFont(TTFont("DejaVu", str(_FONTS / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(_FONTS / "DejaVuSans-Bold.ttf")))
F, FB = "DejaVu", "DejaVu-Bold"

INK = colors.HexColor("#2b2118")
LINE = colors.HexColor("#5a4632")
EDGE = colors.HexColor("#c0392b")
FACE_A = colors.HexColor("#1f6fb2")
FACE_B = colors.HexColor("#2e8b57")
EDGE_HOLE = colors.HexColor("#e67e22")
FILL = colors.HexColor("#efe4d4")
FRONT = colors.HexColor("#d9bf9a")
HEAD_BG = colors.HexColor("#eee6da")


def _header(c: canvas.Canvas, title: str, meta: str, page_w: float, page_h: float) -> None:
    c.setFont(FB, 13)
    c.setFillColor(INK)
    c.drawString(12 * MM, page_h - 14 * MM, title)
    c.setFont(F, 8)
    c.drawRightString(page_w - 12 * MM, page_h - 14 * MM, meta)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.4)
    c.line(12 * MM, page_h - 17 * MM, page_w - 12 * MM, page_h - 17 * MM)


def _meta(result: BuildResult, project: str) -> str:
    w, h, d = (to_mm(v) for v in result.size)
    return f"{project} · {w:g}×{h:g}×{d:g} мм · {date.today():%d.%m.%Y}"


def _table(c: canvas.Canvas, data: list[list], widths: list[float], x: float, y_top: float, page_h: float,
           page_w: float, title: str, meta: str, font_size: float = 7.5) -> float:
    """Таблица с переносом на новые страницы. Возвращает y под таблицей."""
    style = TableStyle([
        ("FONT", (0, 0), (-1, -1), F, font_size),
        ("FONT", (0, 0), (-1, 0), FB, font_size),
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#b9a68f")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ])
    header, rows = data[0], data[1:]
    y = y_top
    while True:
        avail = y - 14 * MM
        chunk: list[list] = []
        for r in rows:
            t = Table([header] + chunk + [r], colWidths=widths)
            _, h = t.wrap(0, 0)
            if h > avail and chunk:
                break
            chunk.append(r)
        t = Table([header] + chunk, colWidths=widths)
        t.setStyle(style)
        _, h = t.wrap(0, 0)
        t.drawOn(c, x, y - h)
        rows = rows[len(chunk):]
        if not rows:
            return y - h
        c.showPage()
        _header(c, title, meta, page_w, page_h)
        y = page_h - 22 * MM


# --- Спецификация ---

def export_spec_pdf(result: BuildResult, project: str = "Проект") -> bytes:
    buf = io.BytesIO()
    pw, ph = landscape(A4)
    c = canvas.Canvas(buf, pagesize=(pw, ph))
    title, meta = "Спецификация деталей", _meta(result, project)
    _header(c, title, meta, pw, ph)
    data = [["№", "Деталь", "Материал", "Толщ.", "Чистовой, мм", "Распил, мм", "Кол.", "Кромка", "Текстура"]]
    for r in spec_rows(result):
        data.append([number_ranges(r.numbers), r.name, r.material, f"{r.thickness:g}", f"{r.length:g}×{r.width:g}",
                     f"{r.cut_length:g}×{r.cut_width:g}", r.qty,
                     " ".join(f"{k}:{v}" for k, v in r.edges.items()) or "—", r.grain])
    y = _table(c, data, [22 * MM, 48 * MM, 46 * MM, 13 * MM, 30 * MM, 30 * MM, 12 * MM, 44 * MM, 26 * MM],
               12 * MM, ph - 22 * MM, ph, pw, title, meta)
    hw = [["Фурнитура и крепёж", "Кол-во"]] + [[h.name, h.qty] for h in hardware_rows(result)]
    if y < 60 * MM:
        c.showPage()
        _header(c, title, meta, pw, ph)
        y = ph - 22 * MM
    _table(c, hw, [110 * MM, 20 * MM], 12 * MM, y - 8 * MM, ph, pw, title, meta)
    c.setFont(F, 7)
    c.drawString(12 * MM, 8 * MM, "Кромка: Д1/Д2 — длинные стороны, Ш1/Ш2 — короткие; распил = чистовой − кромка.")
    c.save()
    return buf.getvalue()


# --- Карты раскроя ---

def export_cutmaps_pdf(result: BuildResult, nesting: Nesting, project: str = "Проект") -> bytes:
    buf = io.BytesIO()
    pw, ph = landscape(A4)
    c = canvas.Canvas(buf, pagesize=(pw, ph))
    names = {p.number: p.name for p in result.parts}
    for m in nesting.materials:
        for s in m.sheets:
            _header(c, f"Карта раскроя · {material(m.material).name} · лист {s.index} из {len(m.sheets)}",
                    _meta(result, project), pw, ph)
            L, W = to_mm(s.length), to_mm(s.width)
            scale = min((pw - 24 * MM) / L, (ph - 40 * MM) / W)
            ox, oy = 12 * MM, 14 * MM
            c.setStrokeColor(LINE)
            c.setFillColor(colors.white)
            c.setLineWidth(0.8)
            c.rect(ox, oy, L * scale, W * scale, fill=1)
            trim = 10  # обрезка листа, мм (rules.sheet_trim)
            for pl in s.parts:
                x, y = (to_mm(pl.x) + trim) * scale, (to_mm(pl.y) + trim) * scale
                w, h = to_mm(pl.length) * scale, to_mm(pl.width) * scale
                c.setFillColor(FILL)
                c.setLineWidth(0.5)
                c.rect(ox + x, oy + y, w, h, fill=1)
                c.setFillColor(INK)
                fs = max(5, min(9, h / 3, w / 8))
                c.setFont(FB, fs)
                c.drawCentredString(ox + x + w / 2, oy + y + h / 2 + 1, str(pl.number))
                if h > 14 and w > 40:
                    c.setFont(F, max(4.5, fs - 2))
                    c.drawCentredString(ox + x + w / 2, oy + y + h / 2 - fs,
                                        f"{to_mm(pl.length):g}×{to_mm(pl.width):g}" + (" ↻" if pl.rotated else ""))
            c.setFont(F, 8)
            c.setFillColor(INK)
            c.drawString(ox, oy - 6 * MM, f"Лист {L:g}×{W:g} мм · заполнение {round(100 * s.usage)}% · "
                                          f"отход по материалу {m.waste_percent}% · ↻ — деталь повёрнута")
            c.showPage()
    c.save()
    return buf.getvalue()


# --- Чертежи деталей с присадкой ---

def export_part_drawings_pdf(result: BuildResult, project: str = "Проект") -> bytes:
    buf = io.BytesIO()
    pw, ph = landscape(A4)
    c = canvas.Canvas(buf, pagesize=(pw, ph))
    seen = set()
    for p in result.parts:
        if not material(p.material).is_sheet:
            continue
        sig = (p.name, p.length, p.width, p.thickness, tuple(sorted(p.edges.items())),
               tuple((h.x, h.y, h.diameter, h.depth, h.face) for h in p.holes))
        same = [q.number for q in result.parts if q is not p and q.name == p.name and q.length == p.length
                and q.width == p.width and tuple((h.x, h.y, h.diameter, h.depth, h.face) for h in q.holes)
                == sig[5]]
        if sig in seen:
            continue
        seen.add(sig)
        nums = number_ranges([p.number] + same)
        _header(c, f"Деталь {nums} · {p.name}", _meta(result, project), pw, ph)
        e = {s: to_mm(p.edge_thickness(s)) for s in ("x0", "x1", "y0", "y1")}
        L, W = to_mm(p.cut_length), to_mm(p.cut_width)
        draw_w, draw_h = pw * 0.62, ph - 60 * MM
        scale = min(draw_w / L, draw_h / W)
        ox, oy = 18 * MM, 26 * MM
        c.setStrokeColor(LINE)
        c.setFillColor(FILL)
        c.setLineWidth(0.8)
        c.rect(ox, oy, L * scale, W * scale, fill=1)
        # Кромка — толстые красные линии по кромлённым сторонам
        c.setStrokeColor(EDGE)
        c.setLineWidth(2.2)
        sides = {"y0": ((0, 0), (L, 0)), "y1": ((0, W), (L, W)), "x0": ((0, 0), (0, W)), "x1": ((L, 0), (L, W))}
        for side in p.edges:
            (x0, y0), (x1, y1) = sides[side]
            c.line(ox + x0 * scale, oy + y0 * scale, ox + x1 * scale, oy + y1 * scale)
        # Размеры
        c.setFillColor(INK)
        c.setFont(F, 8)
        c.drawCentredString(ox + L * scale / 2, oy - 6 * MM, f"{L:g} (чистовой {to_mm(p.length):g})")
        c.saveState()
        c.translate(ox - 5 * MM, oy + W * scale / 2)
        c.rotate(90)
        c.drawCentredString(0, 0, f"{W:g} (чистовой {to_mm(p.width):g})")
        c.restoreState()
        if p.grain != "none":
            c.setFont(F, 8)
            c.drawString(ox, oy + W * scale + 4 * MM, "Текстура → вдоль длины" if p.grain == "length"
                         else "Текстура → вдоль ширины")
        # Отверстия
        rows = [["№", "Сторона", "X", "Y", "Ø", "Глуб.", "Назначение"]]
        for i, h in enumerate(sorted(p.holes, key=lambda h: (h.face, h.x, h.y)), start=1):
            x, y = to_mm(h.x) - e["x0"], to_mm(h.y) - e["y0"]
            col = FACE_A if h.face == "A" else FACE_B if h.face == "B" else EDGE_HOLE
            c.setStrokeColor(col)
            c.setLineWidth(0.7)
            r = max(to_mm(h.diameter) / 2 * scale, 1.6)
            c.circle(ox + min(max(x, 0), L) * scale, oy + min(max(y, 0), W) * scale, r)
            rows.append([i, {"A": "пласть A", "B": "пласть B"}.get(h.face, f"торец {h.face}"), f"{x:g}", f"{y:g}",
                         f"{to_mm(h.diameter):g}", "скв." if h.depth == 0 else f"{to_mm(h.depth):g}", h.purpose])
        info = [["Материал", material(p.material).name], ["Толщина", f"{to_mm(p.thickness):g} мм"],
                ["Кромка", ", ".join(f"{s}: {to_mm(edge_type(t).thickness):g}" for s, t in p.edges.items()) or "—"],
                ["Кол-во", str(1 + len(same))]]
        t = Table(info, colWidths=[22 * MM, 52 * MM])
        t.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), F, 7.5), ("GRID", (0, 0), (-1, -1), 0.3, colors.grey)]))
        _, th = t.wrap(0, 0)
        tx = pw - 96 * MM
        t.drawOn(c, tx, ph - 24 * MM - th)
        if len(rows) > 1:
            shown = rows[:40]
            ht = Table(shown, colWidths=[7 * MM, 15 * MM, 11 * MM, 11 * MM, 7 * MM, 9 * MM, 25 * MM])
            ht.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), F, 6.2), ("FONT", (0, 0), (-1, 0), FB, 6.2),
                                    ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                                    ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
            _, hh = ht.wrap(0, 0)
            ht.drawOn(c, tx, ph - 28 * MM - th - hh)
            if len(rows) > 40:
                c.setFont(F, 6)
                c.drawString(tx, ph - 31 * MM - th - hh, f"…ещё {len(rows) - 40} отверстий — в DXF")
        c.setFont(F, 6.5)
        c.drawString(12 * MM, 8 * MM, "Координаты — от левого нижнего угла детали в размере распила, мм. "
                                      "Синие — пласть A, зелёные — пласть B, оранжевые — торец, красное — кромка.")
        c.showPage()
    c.save()
    return buf.getvalue()


# --- Общий вид и схема сборки ---

FRONT_ROLES = {"door", "drawer_front", "sliding_fill"}


def _front_projection(c: canvas.Canvas, result: BuildResult, ox: float, oy: float, scale: float, fronts: bool,
                      numbers: bool) -> None:
    parts = [p for p in result.parts if fronts or p.role not in FRONT_ROLES]
    for p in sorted(parts, key=lambda p: -p.aabb().min.y):
        b = p.aabb()
        x0, x1, z0, z1 = to_mm(b.min.x), to_mm(b.max.x), to_mm(b.min.z), to_mm(b.max.z)
        c.setStrokeColor(LINE)
        c.setLineWidth(0.4)
        c.setFillColor(FRONT if p.role in FRONT_ROLES else (colors.HexColor("#f6f1ea") if p.role == "back" else FILL))
        c.rect(ox + x0 * scale, oy + z0 * scale, (x1 - x0) * scale, (z1 - z0) * scale, fill=1)
        if numbers and p.role != "back" and (x1 - x0) * scale > 6 and (z1 - z0) * scale > 6:
            c.setFillColor(INK)
            c.setFont(F, 5.5)
            c.drawCentredString(ox + (x0 + x1) / 2 * scale, oy + (z0 + z1) / 2 * scale - 2, str(p.number))


def _dim(c: canvas.Canvas, x0: float, y0: float, x1: float, y1: float, text: str, vertical: bool = False) -> None:
    c.setStrokeColor(INK)
    c.setLineWidth(0.4)
    c.line(x0, y0, x1, y1)
    for x, y in ((x0, y0), (x1, y1)):
        c.line(x - 1.5, y - 1.5, x + 1.5, y + 1.5)
    c.setFont(F, 7)
    c.setFillColor(INK)
    if vertical:
        c.saveState()
        c.translate(x0 - 3, (y0 + y1) / 2)
        c.rotate(90)
        c.drawCentredString(0, 0, text)
        c.restoreState()
    else:
        c.drawCentredString((x0 + x1) / 2, y0 + 2.5, text)


def export_general_view_pdf(result: BuildResult, project: str = "Проект") -> bytes:
    """Общий вид: с фасадами и без, габариты и ширины секций."""
    buf = io.BytesIO()
    pw, ph = landscape(A4)
    c = canvas.Canvas(buf, pagesize=(pw, ph))
    _header(c, "Общий вид", _meta(result, project), pw, ph)
    W, H, D = (to_mm(v) for v in result.size)
    scale = min((pw / 2 - 30 * MM) / W, (ph - 55 * MM) / H)
    for i, (fronts, label) in enumerate(((True, "С фасадами"), (False, "Без фасадов"))):
        ox, oy = 22 * MM + i * pw / 2, 24 * MM
        _front_projection(c, result, ox, oy, scale, fronts, numbers=False)
        c.setFont(FB, 9)
        c.setFillColor(INK)
        c.drawString(ox, oy + H * scale + 9 * MM, label)
        _dim(c, ox, oy + H * scale + 4 * MM, ox + W * scale, oy + H * scale + 4 * MM, f"{W:g}")
        _dim(c, ox - 5 * MM, oy, ox - 5 * MM, oy + H * scale, f"{H:g}", vertical=True)
        if not fronts and getattr(result.product, "type", "wardrobe") == "wardrobe":
            # Ширины секций в свету — по перегородкам
            xs = sorted({to_mm(p.aabb().min.x) for p in result.parts if p.role in ("side", "partition")} |
                        {to_mm(p.aabb().max.x) for p in result.parts if p.role in ("side", "partition")})
            for a, b in zip(xs[1::2], xs[2::2]):
                if b - a > 50:
                    _dim(c, ox + a * scale, oy - 5 * MM, ox + b * scale, oy - 5 * MM, f"{b - a:g}")
    c.setFont(F, 7)
    c.drawString(12 * MM, 8 * MM, f"Глубина корпуса {D:g} мм. Размеры — мм.")
    c.save()
    return buf.getvalue()


def export_assembly_pdf(result: BuildResult, project: str = "Проект") -> bytes:
    """Схема сборки (MVP): вид без фасадов с номерами деталей и перечень."""
    buf = io.BytesIO()
    pw, ph = landscape(A4)
    c = canvas.Canvas(buf, pagesize=(pw, ph))
    title, meta = "Схема сборки", _meta(result, project)
    _header(c, title, meta, pw, ph)
    W, H, _ = (to_mm(v) for v in result.size)
    scale = min((pw * 0.58) / W, (ph - 45 * MM) / H)
    _front_projection(c, result, 14 * MM, 22 * MM, scale, fronts=False, numbers=True)
    rows = [["№", "Деталь"]] + [[number_ranges(r.numbers), r.name] for r in spec_rows(result)]
    _table(c, rows, [24 * MM, 70 * MM], pw - 104 * MM, ph - 22 * MM, ph, pw, title, meta, font_size=7)
    c.save()
    return buf.getvalue()


# --- Коммерческое предложение для клиента ---
#
# Вёрстка — по макету docs/design/ProposalPDF.dc.html (A4 = 595×842 pt, 1 px макета = 1 pt).
# Координаты ниже — «сверху вниз», как в макете; в reportlab переводим через _Y().
# Шрифт — Onest (как в макете); если файлов нет — DejaVu.

KP_TEXT = {
    "ru": {"title": "Коммерческое предложение", "total": "Итого", "materials": "Материалы",
           "work": "Работа мастера: изготовление, доставка, сборка", "cost": "Стоимость",
           "range": "Точная цена после замера.", "requests_note": "Позиции «уточняется» подтверждаем отдельно.",
           "request": "уточняется", "sum": "сум", "mln": "млн", "thousand": "тыс.", "for": "Для",
           "item": "Изделие", "mm": "мм", "no": "№ {n} от {date}", "date_only": "от {date}",
           "valid": "действует {days} дней", "qr": ["3D и примерка в комнате:", "наведите камеру на QR"],
           "term_lead": "Срок", "term_pay": "Оплата", "term_warranty": "Гарантия", "project": "Проект {v}",
           "made": "сформировано в Eskiz AI", "page": "стр. {i} из {n}", "body": "Корпус", "fronts": "фасады",
           "months": ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
                      "октября", "ноября", "декабря"]},
    "uz": {"title": "Tijorat taklifi", "total": "Jami", "materials": "Materiallar",
           "work": "Usta ishi: tayyorlash, yetkazish, yig‘ish", "cost": "Narxi",
           "range": "Aniq narx o‘lchovdan keyin.", "requests_note": "«Aniqlanadi» pozitsiyalarini alohida tasdiqlaymiz.",
           "request": "aniqlanadi", "sum": "so‘m", "mln": "mln", "thousand": "ming", "for": "Kimga",
           "item": "Buyum", "mm": "mm", "no": "№ {n} · {date}", "date_only": "{date}",
           "valid": "{days} kun amal qiladi", "qr": ["3D va xonada ko‘rish:", "kamerani QR’ga qarating"],
           "term_lead": "Muddat", "term_pay": "To‘lov", "term_warranty": "Kafolat", "project": "Loyiha {v}",
           "made": "Eskiz AI’da yaratilgan", "page": "{i}/{n} bet", "body": "Korpus", "fronts": "fasadlar",
           "months": ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentyabr", "oktyabr",
                      "noyabr", "dekabr"]},
}

_ONEST = {w: _FONTS / f"Onest-{w}.ttf" for w in ("Regular", "Medium", "SemiBold", "Bold")}
if all(p.exists() for p in _ONEST.values()):
    for _w, _p in _ONEST.items():
        pdfmetrics.registerFont(TTFont(f"Onest-{_w}", str(_p)))
    K400, K500, K600, K700 = "Onest-Regular", "Onest-Medium", "Onest-SemiBold", "Onest-Bold"
else:  # запасной вариант — DejaVu (полужирного 500/600 нет)
    K400, K500, K600, K700 = F, F, FB, FB

K_INK = colors.HexColor("#21201F")
K_MUTED = colors.HexColor("#6E6B66")
K_MUTED2 = colors.HexColor("#55524D")
K_LINE = colors.HexColor("#F0EFEC")
K_BEIGE = colors.HexColor("#F4EBDD")
K_BG = colors.HexColor("#F2F1EE")
K_WOOD = colors.HexColor("#E6D3B1")
K_WOOD2 = colors.HexColor("#DCC59F")
K_TAG_BG = colors.HexColor("#FFF0D4")
K_TAG = colors.HexColor("#8A4B00")

PAGE_W, PAGE_H = A4
PAD_X, PAD_TOP, PAD_BOTTOM = 44, 36, 24
CONTENT_W = PAGE_W - 2 * PAD_X
FOOTER_TOP = PAGE_H - PAD_BOTTOM - 24  # верх подвала (линия)
LS = -0.005  # letter-spacing макета, em


def _Y(y: float) -> float:
    return PAGE_H - y


def _money(v: int) -> str:
    return f"{v:,}".replace(",", " ")


# Табличные цифры Onest (font-variant-numeric: tabular-nums в макете), 1/1000 em:
# reportlab не включает OpenType-фичу tnum, поэтому ставим цифры в ячейки этой ширины.
_TNUM = {"Onest-Regular": {"d": 672, ",": 270, ".": 270}, "Onest-Medium": {"d": 672, ",": 292, ".": 287},
         "Onest-SemiBold": {"d": 673, ",": 313, ".": 304}, "Onest-Bold": {"d": 673, ",": 335, ".": 321}}


def _cell(ch: str, font: str) -> float | None:
    tab = _TNUM.get(font)
    if not tab:
        return None
    return tab["d"] if ch.isdigit() else tab.get(ch)


def _sw(s: str, font: str, size: float, ls: float = LS, tnum: bool = False) -> float:
    """Ширина строки с межбуквенным интервалом (как letter-spacing в CSS)."""
    if tnum and font in _TNUM:
        w = sum((_cell(ch, font) or pdfmetrics.stringWidth(ch, font, 1000)) for ch in s) * size / 1000
        return w + ls * size * len(s)
    return pdfmetrics.stringWidth(s, font, size) + ls * size * len(s)


def _text(c: canvas.Canvas, x: float, base: float, s: str, font: str, size: float, color=K_INK,
          ls: float = LS, align: str = "left", tnum: bool = False) -> float:
    """Строка по базовой линии base (сверху вниз). Возвращает ширину."""
    w = _sw(s, font, size, ls, tnum)
    if align == "right":
        x -= w
    elif align == "center":
        x -= w / 2
    c.setFillColor(color)
    if tnum and font in _TNUM:
        # посимвольно: цифры по центру ячейки табличной ширины
        cx = x
        for ch in s:
            cell = _cell(ch, font)
            gw = pdfmetrics.stringWidth(ch, font, size)
            adv = cell * size / 1000 if cell else gw
            c.setFont(font, size)
            c.drawString(cx + (adv - gw) / 2, _Y(base), ch)
            cx += adv + ls * size
        return w
    t = c.beginText(x, _Y(base))
    t.setFont(font, size)
    t.setCharSpace(ls * size)
    t.setFillColor(color)
    t.textOut(s)
    c.drawText(t)
    return w


def _wrap(s: str, font: str, size: float, width: float) -> list[str]:
    lines: list[str] = []
    cur = ""
    for word in s.split():
        cand = f"{cur} {word}" if cur else word
        if cur and _sw(cand, font, size) > width:
            lines.append(cur)
            cur = word
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines or [""]


def _dec1(x: float) -> str:
    s = f"{round(x * 10) / 10:.1f}"
    return s[:-2] if s.endswith(".0") else s.replace(".", ",")


def _compact(r: dict, t: dict) -> str:
    """Диапазон коротко, как в макете: «6,1–6,3 млн», «400–600 тыс.»; точная сумма — полностью."""
    lo, hi = r["from"], r["to"]
    if lo == hi:
        return _money(lo)

    def unit(v: int) -> str:
        return "mln" if v >= 1_000_000 else "thousand"

    def val(v: int, u: str, up: bool) -> str:
        if u == "mln":
            x = v / 1_000_000
            if v % 100_000:  # узкая полоса: «3,05–3,35 млн», без расширения до десятых
                c = (math.ceil(x * 100 - 1e-9) if up else math.floor(x * 100 + 1e-9)) / 100
                return f"{c:.2f}".rstrip("0").rstrip(".").replace(".", ",")
            return _dec1((math.ceil(x * 10 - 1e-9) if up else math.floor(x * 10 + 1e-9)) / 10)
        k = v / 1000
        return str(math.ceil(k - 1e-9) if up else math.floor(k + 1e-9))

    ul, uh = unit(lo), unit(hi)
    if ul == uh:
        return f"{val(lo, ul, False)}–{val(hi, uh, True)} {t[uh]}"
    return f"{val(lo, ul, False)} {t[ul]} – {val(hi, uh, True)} {t[uh]}"


def _full(r: dict) -> str:
    """Диапазон полностью: «3 070 000–3 170 000»."""
    return _money(r["from"]) if r["from"] == r["to"] else f"{_money(r['from'])}–{_money(r['to'])}"


def _initials(name: str) -> str:
    words = [w for w in "".join(" " if ch in "«»\"'“”„()" else ch for ch in name).split() if w]
    return "".join(w[0] for w in words[:2]).upper() or "·"


def _phone(p: str) -> str:
    d = "".join(ch for ch in p if ch.isdigit())
    if len(d) == 12 and d.startswith("998"):
        return f"+998 {d[3:5]} {d[5:8]} {d[8:10]} {d[10:12]}"
    return p


def _day(d: date, t: dict, language: str) -> str:
    m = t["months"][d.month - 1]
    return f"{d.day}-{m} {d.year}" if language == "uz" else f"{d.day} {m} {d.year}"


def _material_name(mid: str) -> str:
    try:
        return material(mid).name
    except Exception:  # noqa: BLE001 — неизвестный материал: показываем код
        return mid


def _auto_description(result: BuildResult, t: dict) -> str:
    """«Корпус ЛДСП 16 Белый, фасады ЛДСП 18 Дуб сонома» — из самых частых материалов."""
    body: dict[str, int] = {}
    front: dict[str, int] = {}
    for p in result.parts:
        if p.role in FRONT_ROLES or p.role == "facade":
            front[p.material] = front.get(p.material, 0) + 1
        elif p.role in ("side", "top", "bottom", "partition", "shelf"):
            body[p.material] = body.get(p.material, 0) + 1
    parts = []
    if body:
        parts.append(f"{t['body']} {_material_name(max(body, key=body.get))}")
    if front:
        parts.append(f"{t['fronts']} {_material_name(max(front, key=front.get))}")
    return ", ".join(parts) + ("." if parts else "")


def _sketch(c: canvas.Canvas, result: BuildResult, x: float, y: float, w: float, h: float) -> None:
    """Эскиз в плашке: вид спереди, корпус тёмный, фасады «дерево» (как мини-шкаф в макете)."""
    W, H = to_mm(result.size[0]), to_mm(result.size[1])  # ширина и высота (по оси z деталей)
    if W <= 0 or H <= 0:
        return
    frame = 3  # корпусные детали утолщаем на 3 pt — тёмная рамка, как .carc в макете
    scale = min((w - 2 * frame) / W, (h - 2 * frame) / H)
    ox, oy = x + (w - W * scale) / 2, _Y(y + (h + H * scale) / 2)  # низ изделия (в координатах pdf)
    for p in sorted(result.parts, key=lambda p: -p.aabb().min.y):
        if p.role == "back":
            continue
        b = p.aabb()
        x0, x1, z0, z1 = to_mm(b.min.x), to_mm(b.max.x), to_mm(b.min.z), to_mm(b.max.z)
        rx, ry, rw, rh = ox + x0 * scale, oy + z0 * scale, (x1 - x0) * scale, (z1 - z0) * scale
        if p.role in FRONT_ROLES or p.role == "facade":
            m = None
            try:
                m = material(p.material)
            except Exception:  # noqa: BLE001
                pass
            grain = bool(m and m.has_grain)
            base = K_WOOD if grain or m is None else colors.HexColor(m.color)
            inset = 1.5  # тёмный зазор между фасадами (3 pt, как в макете)
            c.setFillColor(K_INK)
            c.rect(rx, ry, rw, rh, stroke=0, fill=1)
            c.setFillColor(base)
            c.rect(rx + inset, ry + inset, max(0, rw - 2 * inset), max(0, rh - 2 * inset), stroke=0, fill=1)
            if grain:
                c.saveState()
                path = c.beginPath()
                path.rect(rx + inset, ry + inset, max(0, rw - 2 * inset), max(0, rh - 2 * inset))
                c.clipPath(path, stroke=0, fill=0)
                c.setFillColor(K_WOOD2)
                sx = rx + inset + 7
                while sx < rx + rw:
                    c.rect(sx, ry, 2, rh, stroke=0, fill=1)
                    sx += 9
                c.restoreState()
        else:
            c.setFillColor(K_INK)
            c.rect(rx - frame, ry - frame, rw + 2 * frame, rh + 2 * frame, stroke=0, fill=1)


def _qr(c: canvas.Canvas, url: str, x: float, y: float, size: float) -> None:
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing

    q = QrCodeWidget(url, barBorder=0)
    x0, y0, x1, y1 = q.getBounds()
    d = Drawing(size, size, transform=[size / (x1 - x0), 0, 0, size / (y1 - y0), 0, 0])
    q.barFillColor = K_INK
    d.add(q)
    renderPDF.draw(d, c, x, _Y(y + size))


def export_kp_pdf(result: BuildResult, estimate_view: dict, *, workshop: str, master_phone: str,
                  project: str = "", requisites: str = "", language: str = "ru", client: str = "",
                  number: str | int | None = None, issued: date | None = None, valid_days: int = 14,
                  city: str = "", telegram: str = "", share_url: str = "", version: str = "",
                  description: str | None = None, terms: dict | None = None) -> bytes:
    """КП клиенту (макет ProposalPDF): шапка цеха, эскиз, смета в выбранном виде, условия.

    В смете — только то, что можно показать клиенту (client_view ядра).
    terms — {"lead": "...", "payment": "...", "warranty": "..."} из профиля цеха; без них блок не рисуется.
    share_url — ссылка клиента: QR «3D и примерка в комнате».
    """
    t = KP_TEXT.get(language, KP_TEXT["ru"])
    issued = issued or date.today()

    def footer(c: canvas.Canvas, page: int, total: int) -> None:
        c.setFillColor(K_LINE)
        c.rect(PAD_X, _Y(FOOTER_TOP + 1), CONTENT_W, 1, stroke=0, fill=1)
        right = t["page"].format(i=page, n=total)
        rw = _sw(right, K400, 11)
        left = " · ".join(x for x in (t["project"].format(v=version) if version else "", requisites, t["made"]) if x)
        while _sw(left, K400, 11) > CONTENT_W - rw - 16 and len(left) > 10:
            left = left[:-2].rstrip() + "…"
        _text(c, PAD_X, FOOTER_TOP + 21, left, K400, 11, K_MUTED)
        _text(c, PAGE_W - PAD_X, FOOTER_TOP + 21, right, K400, 11, K_MUTED, align="right")

    def draw(c: canvas.Canvas, total: int) -> int:
        """Рисует КП; возвращает число страниц (первый проход — только посчитать)."""
        pages = [1]

        # --- Шапка: логотип, цех, номер и срок ---
        top = PAD_TOP + 14
        c.setFillColor(K_INK)
        c.circle(PAD_X + 23, _Y(top + 23), 23, stroke=0, fill=1)
        _text(c, PAD_X + 23, top + 23 + 5.2, _initials(workshop), K700, 15, colors.white, ls=LS, align="center")
        name_x = PAD_X + 46 + 12
        right_w = _sw(t["no"].format(n=number, date=_day(issued, t, language)) if number is not None else "", K600, 13)
        name_size = 18
        while name_size > 12 and _sw(workshop, K700, name_size) > CONTENT_W - 58 - right_w - 16:
            name_size -= 1
        _text(c, name_x, top + 21, workshop, K700, name_size)
        sub = " · ".join(x for x in (city, _phone(master_phone) if master_phone else "",
                                     f"Telegram @{telegram.lstrip('@')}" if telegram else "") if x)
        if sub:
            _text(c, name_x, top + 38, sub, K400, 12, K_MUTED)
        head = t["no"].format(n=number, date=_day(issued, t, language)) if number is not None else \
            t["date_only"].format(date=_day(issued, t, language))
        _text(c, PAGE_W - PAD_X, top + 19.5, head, K600, 13, align="right")
        if valid_days:
            _text(c, PAGE_W - PAD_X, top + 35.5, t["valid"].format(days=valid_days), K400, 12, K_MUTED, align="right")

        # --- Заголовок ---
        _text(c, PAD_X, 138, t["title"], K700, 30, ls=-0.025)

        # --- Эскиз и описание ---
        row_top = 160
        c.setFillColor(K_BEIGE)
        c.roundRect(PAD_X, _Y(row_top + 184), 184, 184, 24, stroke=0, fill=1)
        _sketch(c, result, PAD_X + 34, row_top + 23, 116, 138)

        cx = PAD_X + 184 + 20
        cw = PAGE_W - PAD_X - cx
        y = row_top  # верх следующего элемента колонки
        if client:
            _text(c, cx, y + 12, t["for"], K400, 12, K_MUTED)
            _text(c, cx, y + 36, client, K600, 16)
            y += 41 + 8 + 4
        _text(c, cx, y + 12, t["item"], K400, 12, K_MUTED)
        y += 20
        title = project or ""
        for line in _wrap(title, K600, 16, cw)[:2] if title else []:
            _text(c, cx, y + 16, line, K600, 16)
            y += 21
        if title:
            y += 4
        W, H, D = (to_mm(v) for v in result.size)
        _text(c, cx, y + 14, f"{W:g} × {D:g} × {H:g} {t['mm']}", K400, 14, tnum=True)
        y += 18 + 4 + 2
        desc = _auto_description(result, t) if description is None else description
        if desc:
            for line in _wrap(desc, K400, 12, cw)[:4]:
                _text(c, cx, y + 12, line, K400, 12, K_MUTED2)
                y += 17
        row_bottom = max(row_top + 184, y)
        if share_url:
            qr_top = max(y + 4, row_top + 184 - 60)
            _qr(c, share_url, cx, qr_top, 60)
            for i, line in enumerate(t["qr"]):
                _text(c, cx + 72, qr_top + 26 + 16 * i, line, K400, 12, K_MUTED)
            row_bottom = max(row_top + 184, qr_top + 60)

        # --- Стоимость ---
        def new_page() -> float:
            footer(c, len(pages), total)
            c.showPage()
            pages.append(len(pages) + 1)
            return PAD_TOP

        y = row_bottom + 14
        _text(c, PAD_X, y + 18, t["cost"], K700, 18)
        y += 26
        view = estimate_view.get("view", "total")
        exact = bool(estimate_view.get("exact", True))
        lines: list[tuple[str, str, bool]] = []  # (название, сумма, «уточняется»)
        if view == "detailed":
            for g in estimate_view.get("groups", []):
                name = g.get("name_uz") if language == "uz" and g.get("name_uz") else g["name"]
                lines.append((name, _full(g), False))
            for r in estimate_view.get("requests", []):
                lines.append((r["name"], "", True))
            if "work" in estimate_view:
                lines.append((t["work"], _full(estimate_view["work"]), False))
        elif view == "short":
            if "materials" in estimate_view:
                lines.append((t["materials"], _compact(estimate_view["materials"], t), False))
            if "work" in estimate_view:
                lines.append((t["work"], _compact(estimate_view["work"], t), False))
        for name, value, request in lines:
            if y + 33 > FOOTER_TOP - 10:
                y = new_page()
            vw = _sw(value, K600, 14, tnum=True) if value else 0
            tag_w = _sw(t["request"], K600, 11, 0) + 14 if request else 0
            name_lines = _wrap(name, K400, 14, CONTENT_W - vw - tag_w - 16)
            h = 14 + 19 * len(name_lines)
            for i, nl in enumerate(name_lines):
                _text(c, PAD_X, y + 21 + 19 * i, nl, K400, 14)
            if request:
                c.setFillColor(K_TAG_BG)
                c.roundRect(PAGE_W - PAD_X - tag_w, _Y(y + 7 + 19 / 2 + 10), tag_w, 20, 6, stroke=0, fill=1)
                _text(c, PAGE_W - PAD_X - 7, y + 21 - 0.5, t["request"], K600, 11, K_TAG, ls=0, align="right")
            if value:
                _text(c, PAGE_W - PAD_X - tag_w - (6 if request else 0), y + 21, value, K600, 14, align="right",
                      tnum=True)
            c.setFillColor(K_LINE)
            c.rect(PAD_X, _Y(y + h), CONTENT_W, 1, stroke=0, fill=1)
            y += h

        # Итого: крупно + «сум» серым
        if y + 48 + 20 > FOOTER_TOP - 10:
            y = new_page()
        tot = estimate_view["total"]
        total_s = _money(tot["from"]) if exact or tot["from"] == tot["to"] else _compact(tot, t)
        _text(c, PAD_X, y + 39, t["total"], K600, 17)
        sw_sum = _text(c, PAGE_W - PAD_X, y + 39, t["sum"], K500, 17, K_MUTED, ls=0, align="right")
        gap = pdfmetrics.stringWidth(" ", K700, 28)
        _text(c, PAGE_W - PAD_X - sw_sum - gap, y + 39, total_s, K700, 28, ls=-0.02, align="right", tnum=True)
        y += 48
        notes = []
        if not exact:
            notes.append(t["range"])
            unc = estimate_view.get("uncertainty_text_uz" if language == "uz" else "uncertainty_text") or ""
            if unc:  # «Оценка: размеры, фасады.»
                notes.append(unc[:1].upper() + unc[1:] + ".")
        if estimate_view.get("requests"):
            notes.append(t["requests_note"])
        if notes:  # пояснение может не влезть в строку — переносим
            for nl in _wrap(" ".join(notes), K400, 12, CONTENT_W):
                _text(c, PAD_X, y + 16, nl, K400, 12, K_MUTED)
                y += 17
            y += 3

        # --- Условия: срок, оплата, гарантия ---
        items = [(t[k], (terms or {}).get(f)) for k, f in (("term_lead", "lead"), ("term_pay", "payment"),
                                                           ("term_warranty", "warranty"))]
        items = [(label, val) for label, val in items if val]
        if items:
            col_w = (CONTENT_W - 36 - 16 * 2) / 3
            wrapped = [_wrap(v, K400, 13, col_w) for _, v in items]
            bh = 14 + 18 + 4 + 18 * max(len(w) for w in wrapped) + 14
            if y + 14 + bh > FOOTER_TOP - 4:
                y = new_page()
            else:
                y += 14
            c.setFillColor(K_BG)
            c.roundRect(PAD_X, _Y(y + bh), CONTENT_W, bh, 20, stroke=0, fill=1)
            for i, ((label, _), wl) in enumerate(zip(items, wrapped)):
                x = PAD_X + 18 + i * (col_w + 16)
                _text(c, x, y + 14 + 13, label, K400, 13)
                for j, line in enumerate(wl):
                    _text(c, x, y + 14 + 18 + 4 + 13 + 18 * j, line, K400, 13)
            y += bh

        footer(c, len(pages), total)
        c.showPage()
        return len(pages)

    # Два прохода: сначала считаем страницы (для «стр. N из M»), потом рисуем начисто.
    n = draw(canvas.Canvas(io.BytesIO(), pagesize=A4), 1)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(t["title"] + (f" · {project}" if project else ""))
    c.setAuthor("Eskiz AI")
    draw(c, n)
    c.save()
    return buf.getvalue()


