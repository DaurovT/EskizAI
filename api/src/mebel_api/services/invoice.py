"""Счёт по заказу EMAN (PDF, карточка заказа SCR-16 «Счёт EMAN · PDF»).

Документа от EMAN в базе пока нет (интеграции нет — оплату и статусы ведёт менеджер), поэтому счёт
собирается из снимка состава заказа: позиции, доставка, итог (сумма по счёту EMAN, если менеджер её ввёл).
Шрифт DejaVu из ядра — кириллица и узбекская латиница.
"""

import io
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from ..db import utcnow
from ..models import Order, Project, Workshop

import mebel_core.exports.pdf  # noqa: F401 — регистрирует шрифты DejaVu

F, FB = "DejaVu", "DejaVu-Bold"
INK = colors.HexColor("#21201F")
MUTED = colors.HexColor("#6E6B66")
HAIR = colors.HexColor("#E6E5E1")
HEAD = colors.HexColor("#F2F1EE")

T = {
    "ru": {"title": "Счёт EMAN", "order": "Заказ №{n} от {d}", "supplier": "Поставщик", "buyer": "Покупатель",
           "project": "Проект", "cols": ["№", "Наименование", "Кол-во", "Ед.", "Цена", "Сумма"],
           "goods": "Материалы и услуги", "delivery": "Доставка", "pickup": "Самовывоз", "total": "Итого к оплате",
           "excluded": "Не входят в заказ (цена под запрос): {items}", "paid": "Оплачено {d}", "wait": "Ждёт оплаты",
           "cancelled": "Заказ отменён", "ref": "Номер платежа: {r}",
           "note": "Счёт сформирован по составу заказа. Оплата — напрямую EMAN (Click, Payme или по счёту), "
                   "окончательная сумма — по счёту поставщика.", "sum": "сум"},
    "uz": {"title": "EMAN hisobi", "order": "Buyurtma №{n}, {d}", "supplier": "Yetkazib beruvchi", "buyer": "Xaridor",
           "project": "Loyiha", "cols": ["№", "Nomi", "Soni", "Birl.", "Narxi", "Summa"],
           "goods": "Materiallar va xizmatlar", "delivery": "Yetkazib berish", "pickup": "O‘zi olib ketadi",
           "total": "To‘lov uchun jami", "excluded": "Buyurtmaga kirmaydi (narx so‘rov bo‘yicha): {items}",
           "paid": "To‘langan {d}", "wait": "To‘lov kutilmoqda", "cancelled": "Buyurtma bekor qilindi",
           "ref": "To‘lov raqami: {r}",
           "note": "Hisob buyurtma tarkibi bo‘yicha tuzilgan. To‘lov to‘g‘ridan-to‘g‘ri EMANga (Click, Payme yoki hisob "
                   "bo‘yicha), yakuniy summa — yetkazib beruvchi hisobi bo‘yicha.", "sum": "so‘m"},
}


def _money(v: int | float | None) -> str:
    return "—" if v is None else f"{round(v):,}".replace(",", " ")


def _qty(v) -> str:
    if v is None:
        return ""
    return f"{v:g}".replace(".", ",") if isinstance(v, (int, float)) else str(v)


def invoice_pdf(order: Order, project: Project, workshop: Workshop, language: str = "ru",
                supplier_name: str = "EMAN") -> bytes:
    lang = "uz" if language == "uz" else "ru"
    t = T[lang]
    tz = ZoneInfo("Asia/Tashkent")
    comp = order.composition or {}
    number = order.number or str(order.id)[:8].upper()

    st = ParagraphStyle("b", fontName=F, fontSize=9.5, leading=13, textColor=INK)
    small = ParagraphStyle("s", parent=st, fontSize=8.5, leading=12, textColor=MUTED)
    h1 = ParagraphStyle("h1", parent=st, fontName=FB, fontSize=20, leading=24)

    story = [Paragraph(t["title"], h1), Spacer(1, 2 * mm),
             Paragraph(t["order"].format(n=number, d=order.created_at.astimezone(tz).strftime("%d.%m.%Y")), small),
             Spacer(1, 6 * mm)]

    buyer = ", ".join(x for x in (workshop.name, workshop.city, workshop.phone) if x)
    parties = Table([[Paragraph(t["supplier"], small), Paragraph(supplier_name, st)],
                     [Paragraph(t["buyer"], small), Paragraph(buyer or "—", st)],
                     [Paragraph(t["project"], small), Paragraph(project.title, st)]],
                    colWidths=[32 * mm, 140 * mm])
    parties.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                                 ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [parties, Spacer(1, 6 * mm)]

    rows = [t["cols"]]
    for i, line in enumerate(comp.get("lines") or [], 1):
        rows.append([str(i), Paragraph(str(line.get("name") or ""), st), _qty(line.get("qty")),
                     str(line.get("unit") or ""), _money(line.get("price")), _money(line.get("total"))])
    table = Table(rows, colWidths=[9 * mm, 85 * mm, 18 * mm, 14 * mm, 23 * mm, 25 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), FB, 8.5), ("FONT", (0, 1), (-1, -1), F, 9),
        ("TEXTCOLOR", (0, 0), (-1, 0), MUTED), ("BACKGROUND", (0, 0), (-1, 0), HEAD),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"), ("ALIGN", (4, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, HAIR),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [table, Spacer(1, 4 * mm)]

    delivery = comp.get("delivery")
    total = order.invoice_total if order.invoice_total is not None else order.estimate_total
    if total is None:
        total = comp.get("total")
    totals = [[t["goods"], _money(comp.get("goods_total"))],
              [t["delivery"], _money(delivery.get("cost")) if delivery else t["pickup"]],
              [t["total"], f"{_money(total)} {t['sum']}"]]
    tt = Table(totals, colWidths=[60 * mm, 40 * mm], hAlign="RIGHT")
    tt.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -2), F, 9.5), ("FONT", (0, -1), (-1, -1), FB, 11.5),
        ("TEXTCOLOR", (0, 0), (0, -2), MUTED), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.8, INK), ("TOPPADDING", (0, -1), (-1, -1), 6),
    ]))
    story += [tt, Spacer(1, 5 * mm)]

    excluded = comp.get("excluded") or []
    if excluded:
        story += [Paragraph(t["excluded"].format(items=", ".join(map(str, excluded))), small), Spacer(1, 2 * mm)]
    if order.status == "cancelled":
        story.append(Paragraph(t["cancelled"], st))
    elif order.paid_at is not None:
        story.append(Paragraph(t["paid"].format(d=order.paid_at.astimezone(tz).strftime("%d.%m.%Y %H:%M")), st))
    else:
        story.append(Paragraph(t["wait"], st))
    if order.payment_reference:
        story.append(Paragraph(t["ref"].format(r=order.payment_reference), small))
    story += [Spacer(1, 6 * mm), Paragraph(t["note"], small),
              Paragraph(f"Eskiz AI · {utcnow().astimezone(tz):%d.%m.%Y %H:%M}", small)]

    out = io.BytesIO()
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm,
                            bottomMargin=16 * mm, title=f"{t['title']} №{number}", author="Eskiz AI")
    doc.build(story)
    return out.getvalue()
