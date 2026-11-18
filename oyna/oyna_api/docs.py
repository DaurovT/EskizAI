"""Документы PDF (S12): КП (FR-Q1/Q2/Q9), лист для цеха (FR-Q7), монтажный лист (FR-Q8), заявка поставщику (FR-Q6).

Шрифт с кириллицей: OYNA_FONT / OYNA_FONT_BOLD, иначе DejaVu (Linux, пакет fonts-dejavu-core) или Arial (macOS).
"""
from __future__ import annotations

import io
import os
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table,
                                TableStyle)
from svglib.svglib import svg2rlg

from oyna_core.api import calc
from oyna_core.order import order_cutting
from oyna_core.render import render_svg

from . import store
from .auth import Ctx, ctx, need_company

router = APIRouter(tags=["документы"])

FONT_CANDIDATES = [
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ("/Library/Fonts/Arial Unicode.ttf", "/Library/Fonts/Arial Unicode.ttf"),
]

T = {
    "ru": {"quote": "Коммерческое предложение", "client": "Клиент", "address": "Адрес", "date": "Дата", "version": "Версия",
           "variant": "Вариант", "room": "Помещение", "size": "Размер, мм", "qty": "Кол-во", "price": "Цена, сум",
           "total": "Итого", "demo": "ДЕМО: цены для показа, не настоящие", "badge": "Рассчитано в Eskiz Oyna",
           "valid": "Цены зафиксированы на дату КП. Монтаж и доставка — по условиям цеха.", "schema": "Схема (вид изнутри)"},
    "uz": {"quote": "Tijorat taklifi", "client": "Mijoz", "address": "Manzil", "date": "Sana", "version": "Versiya",
           "variant": "Variant", "room": "Xona", "size": "O'lcham, mm", "qty": "Soni", "price": "Narx, so'm",
           "total": "Jami", "demo": "DEMO: narxlar namoyish uchun, haqiqiy emas", "badge": "Eskiz Oyna'da hisoblangan",
           "valid": "Narxlar taklif sanasiga qayd etilgan. O'rnatish va yetkazish — sex shartlariga ko'ra.",
           "schema": "Sxema (ichkaridan ko'rinish)"},
}


@lru_cache
def fonts() -> tuple[str, str]:
    env = os.environ.get("OYNA_FONT"), os.environ.get("OYNA_FONT_BOLD")
    for reg, bold in ([env] if env[0] else []) + FONT_CANDIDATES:
        if reg and os.path.exists(reg):
            pdfmetrics.registerFont(TTFont("Oyna", reg))
            pdfmetrics.registerFont(TTFont("Oyna-Bold", bold if bold and os.path.exists(bold) else reg))
            from svglib.fonts import register_font
            register_font("sans-serif", reg, rlgFontName="Oyna")      # кириллица на схемах (SVG → PDF)
            return "Oyna", "Oyna-Bold"
    raise HTTPException(503, "нет шрифта с кириллицей для PDF (OYNA_FONT)")


def styles():
    f, b = fonts()
    return {"h1": ParagraphStyle("h1", fontName=b, fontSize=16, leading=20, spaceAfter=6),
            "h2": ParagraphStyle("h2", fontName=b, fontSize=12, leading=15, spaceBefore=8, spaceAfter=4),
            "p": ParagraphStyle("p", fontName=f, fontSize=9.5, leading=12.5),
            "small": ParagraphStyle("s", fontName=f, fontSize=8, leading=10, textColor=colors.HexColor("#555555")),
            "demo": ParagraphStyle("d", fontName=b, fontSize=11, leading=14, textColor=colors.HexColor("#B3261E"))}


def money(v) -> str:
    return "—" if v is None else f"{v:,.0f}".replace(",", " ")


def schema(doc: dict, cat, co, width_mm: float = 38):
    d = svg2rlg(io.BytesIO(render_svg(doc, cat, co, max_px=420, dims=True).encode()))
    if d is None:
        return Paragraph("—", styles()["small"])
    k = width_mm * mm / d.width
    d.width, d.height = d.width * k, d.height * k
    d.scale(k, k)
    return d


def grid(rows, widths, header=True):
    f, b = fonts()
    t = Table(rows, colWidths=[w * mm for w in widths], repeatRows=1 if header else 0)
    st = [("FONT", (0, 0), (-1, -1), f, 8.5), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
          ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#BBBBBB")),
          ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4)]
    if header:
        st += [("FONT", (0, 0), (-1, 0), b, 8.5), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF3EF"))]
    t.setStyle(TableStyle(st))
    return t


def pdf(story, title: str) -> bytes:
    buf = io.BytesIO()
    f, _ = fonts()

    def foot(canvas, doc):
        canvas.setFont(f, 7.5)
        canvas.setFillColor(colors.HexColor("#777777"))
        canvas.drawString(15 * mm, 10 * mm, f"{title} · стр. {doc.page}")

    SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm, bottomMargin=16 * mm,
                      title=title, author="Eskiz Oyna").build(story, onFirstPage=foot, onLaterPages=foot)
    return buf.getvalue()


def _cat():
    from .app import CAT
    return CAT


def _order(c, cid, order_id):
    o = c.execute("SELECT o.*, cl.name AS client_name, cl.phone AS client_phone FROM orders o "
                  "LEFT JOIN clients cl ON cl.id = o.client_id WHERE o.id = %s AND o.company_id = %s", (order_id, cid)).fetchone()
    if not o:
        raise HTTPException(404, "заказ не найден")
    return o


# ---------------- КП ----------------
def quote_pdf(company: dict, order: dict, q: dict, cat, co) -> bytes:
    S, L = styles(), T.get(q["lang"], T["ru"])
    story = []
    pro = company.get("plan") == "pro"
    story.append(Paragraph(company["name"], S["h1"]))
    meta = " · ".join(x for x in (company.get("phone"), company.get("address"), f"ИНН {company['inn']}" if company.get("inn") else None) if x)
    if meta:
        story.append(Paragraph(meta, S["small"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(f"{L['quote']} № {str(order['id'])[:8]}-{q['version']}", S["h2"]))
    when = (q.get("sent_at") or datetime.now(timezone.utc))
    when = when if isinstance(when, datetime) else datetime.fromisoformat(str(when))
    story.append(Paragraph(f"{L['client']}: {order.get('client_name') or '—'} · {L['address']}: {order.get('address') or '—'} · "
                           f"{L['date']}: {when:%d.%m.%Y} · {L['version']} {q['version']}", S["p"]))
    if q.get("demo"):
        story += [Spacer(1, 4), Paragraph(L["demo"], S["demo"])]
    for i, v in enumerate(q["variants"]):
        story.append(Paragraph(f"{L['variant']} {i + 1}: {v['kit']}", S["h2"]))
        rows = [["№", L["schema"], L["room"], L["size"], L["qty"], L["price"]]]
        for n, p in enumerate(v["positions"], 1):
            img = svg2rlg(io.BytesIO(p["svg"].encode())) if p.get("svg") else None
            if img is not None:
                k = 34 * mm / img.width
                img.width, img.height = img.width * k, img.height * k
                img.scale(k, k)
            rows.append([str(n), img or "—", p.get("room") or "—", f"{p['w']}×{p['h']}", str(p.get("qty", 1)), money(p.get("total"))])
        rows.append(["", "", "", "", L["total"], money(v["total"])])
        t = grid(rows, [8, 40, 40, 30, 16, 36])
        t.setStyle(TableStyle([("FONT", (4, -1), (-1, -1), fonts()[1], 9.5)]))
        story.append(t)
        if v.get("total_usd"):
            story.append(Paragraph(f"≈ {v['total_usd']:,.0f} $".replace(",", " "), S["small"]))
    story += [Spacer(1, 8), Paragraph(L["valid"], S["small"])]
    if not pro:
        story.append(Paragraph(L["badge"], S["small"]))       # FR-Q9: бесплатное КП — с меткой Eskiz
    return pdf(story, f"{L['quote']} — {company['name']}")


@router.get("/oyna/orders/{order_id}/documents/quote.pdf", summary="КП в PDF (последняя или указанная версия)")
def quote_doc(order_id: str, version: int | None = None, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        o = _order(c, cid, order_id)
        q = c.execute("SELECT * FROM quotes WHERE order_id = %s " + ("AND version = %s " if version else "") +
                      "ORDER BY version DESC LIMIT 1", (order_id, version) if version else (order_id,)).fetchone()
        if not q:
            raise HTTPException(404, "КП ещё не создано")
        company = c.execute("SELECT * FROM companies WHERE id = %s", (cid,)).fetchone()
    data = quote_pdf(company, o, q, _cat(), cx.company)
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="kp-{q["version"]}.pdf"'})


@router.get("/q/{token}/pdf", tags=["КП"], summary="КП в PDF для клиента (последняя версия)")
def quote_public_pdf(token: str):
    if not store.dsn():
        raise HTTPException(503, "хранение не настроено")
    with store.conn() as c:
        try:
            q, latest = store.quote_by_token(c, token)
        except store.NotFound as e:
            raise HTTPException(404, str(e))
        o = c.execute("SELECT o.*, cl.name AS client_name FROM orders o LEFT JOIN clients cl ON cl.id = o.client_id "
                      "WHERE o.id = %s", (latest["order_id"],)).fetchone()
        company = c.execute("SELECT * FROM companies WHERE id = %s", (o["company_id"],)).fetchone()
    return Response(quote_pdf(company, o, latest, _cat(), None), media_type="application/pdf")


# ---------------- лист для цеха ----------------
@router.get("/oyna/orders/{order_id}/documents/shop.pdf", summary="Лист для цеха: схемы, комплектация, фурнитура, принятые предупреждения")
def shop_doc(order_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    if cx.role not in ("owner", "manager", "production"):
        raise HTTPException(403, "лист для цеха — владелец, менеджер, производство")
    cat, co, S = _cat(), cx.company, styles()
    with store.conn() as c:
        o = _order(c, cid, order_id)
        docs = [p["doc"] for p in store.positions(c, order_id)]
    story = [Paragraph(f"Лист для цеха · заказ {str(o['id'])[:8]}", S["h1"]),
             Paragraph(f"{o.get('address') or '—'} · этаж {o.get('floor') or '—'} · позиций {len(docs)}", S["p"])]
    for n, d in enumerate(docs, 1):
        r = calc(d, cat, co, role="production")
        s = r["setup"]
        block = [Paragraph(f"{n}. {d.get('room') or 'Позиция'} — {d['frame']['w']}×{d['frame']['h']} мм × {d.get('qty', 1)}", S["h2"])]
        sysrow = cat.systems.get(s["system"], {})
        dec = lambda x: cat.decors.get(x, {}).get("name_ru", x)
        fs = cat.fitting_systems.get(s["fittings"], {}).get("title", s["fittings"])
        P = lambda x: Paragraph(x, S["p"])
        info = [[P("Система"), P(f"{sysrow.get('brand', '')} {sysrow.get('series', s['system'])}")],
                [P("Декор снаружи / внутри"), P(f"{dec(s['color_out'])} / {dec(s['color_in'])} — группа «{r['price_group']}»")],
                [P("Стеклопакет"), P(str(s["glass"]))], [P("Фурнитура"), P(fs)]]
        kinds = {"sash": "створка", "door_sash": "дверь", "fixed": "глухая", "panel": "панель"}
        for cell in (r.get("geometry") or {}).get("cells", []):
            line = f"{kinds.get(cell['type'], cell['type'])}"
            if cell.get("glass"):
                line += f"; стекло {cell['glass_spec']} — {cell['glass'][0]:.0f}×{cell['glass'][1]:.0f}"
            if cell.get("sash"):
                line += f"; створка {cell['sash'][0]:.0f}×{cell['sash'][1]:.0f}, по фальцу {cell['ffb']:.0f}×{cell['ffh']:.0f}, {cell['weight_kg']} кг"
            info.append([P(f"Ячейка {cell['path'] or '—'}"), P(line)])
        t = Table([[schema(d, cat, co, 62), grid(info, [34, 76], header=False)]], colWidths=[66 * mm, 114 * mm])
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        block.append(t)
        fit = [["Деталь", "Код", "Кол-во"]] + [[l["name"], l.get("code", ""), f"{l['qty']:g}"] for l in r.get("bom", []) if l["kind"] == "fitting"]
        if len(fit) > 1:
            block += [Spacer(1, 3), grid(fit, [80, 80, 20])]
        acc = [v for v in r["violations"] if v.get("accepted")]
        if acc:
            block.append(Paragraph("Принятые предупреждения: " + "; ".join(f"{v['code']} {v.get('msg') or v['title']}" for v in acc), S["small"]))
        story.append(KeepTogether(block))
    if co.plan == "pro" and docs:
        cut = order_cutting(docs, cat, co)
        story += [PageBreak(), Paragraph("Раскрой профиля", S["h1"])]
        rows = [["Артикул", "Хлыстов", "Отход %", "Деловые остатки, мм"]] + [
            [i["article"], str(i["bars"]), f"{i['waste_pct']:g}", ", ".join(map(str, i["offcuts_mm"])) or "—"] for i in cut["items"]]
        story.append(grid(rows, [80, 20, 20, 60]))
        for i in cut["items"]:
            story.append(Paragraph(f"<b>{i['article']}</b>: " + " | ".join(" + ".join(f"{x:g}" for x in bar) for bar in i["layout"]), S["small"]))
    else:
        story.append(Paragraph("Раскрой — в платной части (Pro).", S["small"]))
    return Response(pdf(story, "Лист для цеха"), media_type="application/pdf")


# ---------------- монтажный лист ----------------
@router.get("/oyna/orders/{order_id}/documents/install.pdf", summary="Монтажный лист: адрес, помещения, изделия, добивки, демонтаж")
def install_doc(order_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    cat, co, S = _cat(), cx.company, styles()
    with store.conn() as c:
        o = _order(c, cid, order_id)
        docs = [p["doc"] for p in store.positions(c, order_id)]
    story = [Paragraph("Монтажный лист", S["h1"]),
             Paragraph(f"{o.get('address') or '—'} · этаж {o.get('floor') or '—'} · {o.get('client_name') or '—'} "
                       f"{o.get('client_phone') or ''}", S["p"]), Spacer(1, 6)]
    rows = [["№", "Схема", "Помещение", "Размер", "Кол-во", "Добивки и работы"]]
    for n, d in enumerate(docs, 1):
        ex = d.get("extras") or {}
        works = []
        if ex.get("sill"):
            works.append(f"подоконник {(ex['sill'] or {}).get('depth_cm', 30) if isinstance(ex['sill'], dict) else 30} см")
        works += [name for key, name in (("drip", "отлив"), ("slopes", "откосы"), ("outside", "работа снаружи")) if ex.get(key)]
        if ex.get("dismantle"):
            kind = {"wood": "деревянного окна", "metal": "металлического окна", "pvc": "пластикового окна",
                    "alu": "алюминиевого окна"}.get(ex["dismantle"], "") if isinstance(ex["dismantle"], str) else ""
            works.append(f"демонтаж {kind}".strip())
        rows.append([str(n), schema(d, cat, co, 34), d.get("room") or "—", f"{d['frame']['w']}×{d['frame']['h']}",
                     str(d.get("qty", 1)), Paragraph(", ".join(works) or "—", S["p"])])
    story.append(grid(rows, [8, 38, 32, 26, 14, 62]))
    story += [Spacer(1, 10), Paragraph("Фото после монтажа и подпись клиента — в приложении (S15).", S["small"])]
    return Response(pdf(story, "Монтажный лист"), media_type="application/pdf")


# ---------------- заявка поставщику ----------------
@router.get("/oyna/orders/{order_id}/documents/supplier.pdf", summary="Заявка поставщику: хлысты, фурнитура, стеклопакеты")
def supplier_doc(order_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    if cx.role not in ("owner", "manager"):
        raise HTTPException(403, "заявка поставщику — владелец и менеджер")
    cat, co, S = _cat(), cx.company, styles()
    with store.conn() as c:
        _order(c, cid, order_id)
        docs = [p["doc"] for p in store.positions(c, order_id)]
    cut = order_cutting(docs, cat, co) if docs else {"items": []}
    story = [Paragraph(f"Заявка поставщику · заказ {order_id[:8]}", S["h1"]), Paragraph("Профиль и армирование (целые хлысты)", S["h2"]),
             grid([["Артикул", "Хлыстов"]] + [[i["article"], str(i["bars"])] for i in cut["items"]], [140, 40])]
    fit, glass, seal = defaultdict(float), defaultdict(int), defaultdict(float)
    for d in docs:
        q = d.get("qty", 1) or 1
        for l in calc(d, cat, co).get("bom", []):
            if l["kind"] in ("fitting", "connector"):
                fit[l.get("article") or l["name"]] += l["qty"] * q
            elif l["kind"] == "glass":
                size = l.get("note", "").split(",")[0]
                glass[(l["name"].replace("Стеклопакет ", ""), size)] += q
            elif l["kind"] == "seal":
                seal[l.get("article") or l["name"]] += l["qty"] * q
    story += [Paragraph("Фурнитура и соединители", S["h2"]), grid([["Позиция", "Кол-во"]] + [[k, f"{v:g}"] for k, v in sorted(fit.items())], [140, 40]),
              Paragraph("Стеклопакеты", S["h2"]), grid([["Формула", "Размер", "Шт"]] + [[k[0], k[1], str(v)] for k, v in sorted(glass.items())], [60, 80, 40]),
              Paragraph("Уплотнитель", S["h2"]), grid([["Позиция", "кг"]] + [[k, f"{v:.2f}"] for k, v in sorted(seal.items())], [140, 40])]
    return Response(pdf(story, "Заявка поставщику"), media_type="application/pdf")


__all__ = ["router", "quote_pdf"]
