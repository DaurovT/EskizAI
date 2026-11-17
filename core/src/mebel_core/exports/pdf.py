"""PDF-документы мастера (раздел 8 PRD): спецификация, карты раскроя, чертежи
деталей с присадкой, общий вид, схема сборки, коммерческое предложение (КП).

Производственные документы — на листах с рамкой и штампом (sheet.SheetCanvas: «Лист N», «Листов M»,
масштаб, цех, дата); чертежи, виды и взрыв-схема — в drawings.py. КП клиенту — свой макет без штампа.

Шрифт DejaVu Sans (свободная лицензия, файл LICENSE_DEJAVU рядом со шрифтами) —
чтобы кириллица и узбекская латиница печатались одинаково на любом сервере.
КП клиенту — шрифтом Onest, как в макете (OFL, LICENSE_ONEST); без файлов — DejaVu.
"""

import io
import math
from datetime import date

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm as MM
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

from ..assembler import BuildResult
from ..catalog import material
from ..nesting import Nesting
from ..spec import hardware_rows, number_ranges, spec_rows
from ..units import to_mm
from .sheet import _FONTS, F, FB, DocInfo, SheetCanvas  # noqa: F401 — шрифты DejaVu регистрируются в sheet

INK = colors.black
LINE = colors.black
FILL = colors.Color(0.93, 0.93, 0.93)
HEAD_BG = colors.Color(0.9, 0.9, 0.9)
FRONT_ROLES = {"door", "drawer_front", "sliding_fill"}


def _header(c: canvas.Canvas, title: str, meta: str, page_w: float, page_h: float) -> None:
    """Заголовок страницы без штампа (оставлен для совместимости)."""
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


def doc_info(result: BuildResult, project: str, workshop: str = "") -> DocInfo:
    from .drawings import product_line

    return DocInfo(project=project, product=product_line(result), workshop=workshop)


def _table(c: SheetCanvas, data: list[list], widths: list[float], x: float, y_top: float, title: str,
           font_size: float = 7.5) -> float:
    """Таблица с переносом на следующие листы (с тем же наименованием). Возвращает y под таблицей."""
    style = TableStyle([
        ("FONT", (0, 0), (-1, -1), F, font_size),
        ("FONT", (0, 0), (-1, 0), FB, font_size),
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ])
    header, rows = data[0], data[1:]
    y = y_top
    while True:
        avail = y - c.content().y0
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
        y = c.sheet(title, c.sheet_scale).y1


# --- Спецификация ---

def draw_spec(c: SheetCanvas, result: BuildResult) -> None:
    title = "Спецификация деталей"
    box = c.sheet(title, "—")
    data = [["№", "Деталь", "Материал", "Толщ.", "Чистовой, мм", "Распил, мм", "Кол.", "Кромка", "Текстура"]]
    for r in spec_rows(result):
        data.append([number_ranges(r.numbers), r.name, r.material, f"{r.thickness:g}", f"{r.length:g}×{r.width:g}",
                     f"{r.cut_length:g}×{r.cut_width:g}", r.qty,
                     " ".join(f"{k}:{v}" for k, v in r.edges.items()) or "—", r.grain])
    widths = [34 * MM, 46 * MM, 36 * MM, 12 * MM, 29 * MM, 29 * MM, 11 * MM, 40 * MM, 25 * MM]  # № шире: «12–13, 18–19, 24–25»
    y = _table(c, data, widths, box.x0, box.y1, title)
    hw = [["Фурнитура и крепёж", "Кол-во"]] + [[h.name, h.qty] for h in hardware_rows(result)]
    if y - c.content().y0 < 40 * MM:
        c.showPage()
        y = c.sheet(title, "—").y1 + 8 * MM
    _table(c, hw, [110 * MM, 20 * MM], box.x0, y - 8 * MM, title)
    fb = c.frame_box()
    c.setFont(F, 6.5)
    c.setFillColor(INK)
    c.drawString(fb.x0 + 2 * MM, fb.y0 + 14 * MM, "Кромка: Д1/Д2 — длинные стороны, Ш1/Ш2 — короткие;")
    c.drawString(fb.x0 + 2 * MM, fb.y0 + 10.5 * MM, "распил = чистовой − кромка. Номера — как на чертежах.")
    c.showPage()


def export_spec_pdf(result: BuildResult, project: str = "Проект", workshop: str = "") -> bytes:
    buf = io.BytesIO()
    c = SheetCanvas(buf, doc_info(result, project, workshop))
    draw_spec(c, result)
    c.save()
    return buf.getvalue()


# --- Карты раскроя ---

def draw_cutmaps(c: SheetCanvas, result: BuildResult, nesting: Nesting) -> None:
    from .drawings import pick_scale, scale_label

    for m in nesting.materials:
        for s in m.sheets:
            L, W = to_mm(s.length), to_mm(s.width)
            box = c.sheet(f"Карта раскроя · {material(m.material).name} · лист {s.index} из {len(m.sheets)}")
            n = pick_scale(L, W, box.w, box.h - 8 * MM, 0, 0)
            c.sheet_scale = scale_label(n)
            scale = MM / n
            ox, oy = box.x0, box.y1 - W * scale
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


def export_cutmaps_pdf(result: BuildResult, nesting: Nesting, project: str = "Проект", workshop: str = "") -> bytes:
    buf = io.BytesIO()
    c = SheetCanvas(buf, doc_info(result, project, workshop))
    draw_cutmaps(c, result, nesting)
    if not c._code and not c._sheets:  # нет листовых деталей — пустой лист со штампом
        c.sheet("Карты раскроя")
        c.showPage()
    c.save()
    return buf.getvalue()


# --- Чертежи деталей, общий вид, схема сборки (drawings.py) ---

def export_part_drawings_pdf(result: BuildResult, project: str = "Проект", workshop: str = "") -> bytes:
    from .drawings import export_part_drawings

    return export_part_drawings(result, project, workshop)


def export_general_view_pdf(result: BuildResult, project: str = "Проект", workshop: str = "") -> bytes:
    """Общий вид: с фасадами, разрез, вид сверху; без фасадов с цепочками; у кухни — план и развёртки стен."""
    from .drawings import export_general_view

    return export_general_view(result, project, workshop)


def export_assembly_pdf(result: BuildResult, project: str = "Проект", workshop: str = "") -> bytes:
    """Схема сборки: взрыв-схема в изометрии с номерами позиций и ведомость фурнитуры."""
    from .drawings import export_assembly

    return export_assembly(result, project, workshop)


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
           "made": "сформировано в Eskiz Mebel", "page": "стр. {i} из {n}", "body": "Корпус", "fronts": "фасады",
           "months": ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
                      "октября", "ноября", "декабря"]},
    "uz": {"title": "Tijorat taklifi", "total": "Jami", "materials": "Materiallar",
           "work": "Usta ishi: tayyorlash, yetkazish, yig‘ish", "cost": "Narxi",
           "range": "Aniq narx o‘lchovdan keyin.", "requests_note": "«Aniqlanadi» pozitsiyalarini alohida tasdiqlaymiz.",
           "request": "aniqlanadi", "sum": "so‘m", "mln": "mln", "thousand": "ming", "for": "Kimga",
           "item": "Buyum", "mm": "mm", "no": "№ {n} · {date}", "date_only": "{date}",
           "valid": "{days} kun amal qiladi", "qr": ["3D va xonada ko‘rish:", "kamerani QR’ga qarating"],
           "term_lead": "Muddat", "term_pay": "To‘lov", "term_warranty": "Kafolat", "project": "Loyiha {v}",
           "made": "Eskiz Mebel’da yaratilgan", "page": "{i}/{n} bet", "body": "Korpus", "fronts": "fasadlar",
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
    c.setAuthor("Eskiz Mebel")
    draw(c, n)
    c.save()
    return buf.getvalue()


