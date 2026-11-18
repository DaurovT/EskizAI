"""Цена позиции (FR-P3…P7): себестоимость → режим дилера → наценка → скидка → округление.

P = round_N((C · (1 + m) или C + m_м² · S) · (1 − d)), где C = материалы (× (1 + коэф. дилера)) + работы.
"""
from __future__ import annotations

from datetime import date, datetime

from .bom import Line
from .evaluate import Eval


def round_to(v: float, step: int) -> int:
    return int(round(v / step) * step) if step else int(round(v))


def price_position(ev: Eval, lines: list[Line], discount_pct: float = 0.0, today: date | None = None) -> dict:
    co, cat = ev.company, ev.cat
    qty = ev.doc.get("qty", 1) or 1
    area = ev.geo.w * ev.geo.h / 1e6
    missing = [l for l in lines if l.price_status == "none"]
    demo = [l for l in lines if l.price_status == "demo"]

    materials = sum(l.cost or 0 for l in lines if l.kind != "work")
    works = sum(l.cost or 0 for l in lines if l.kind == "work")
    if co.mode == "dealer":
        materials *= 1 + (co.dealer_coef or 0)          # FR-P7: заказ у производителя
    cost = (materials + works) * qty
    if co.markup_kind == "per_m2":
        before = cost + co.markup_value * area * qty
    else:
        before = cost * (1 + co.markup_value / 100)
    total = round_to(before * (1 - discount_pct / 100), co.rounding_sum)
    per_m2 = total / (area * qty) if area else 0

    # правила цены
    if missing:
        names = ", ".join(sorted({l.name for l in missing}))
        if co.demo_prices:
            ev.add("D.1", f"нет цены и демо-цены: {names}")
        ev.add("P.1", f"нет цены: {names}", fix="введите цену вручную или обновите прайс")
    if demo:
        ev.add("D.1", f"ДЕМО-цены в {len(demo)} строках: " + ", ".join(sorted({l.name for l in demo}))[:300],
               fix="КП уйдёт с меткой «ДЕМО»")
    p2 = cat.rules["P.2"]["params"]
    if not missing and total and not (p2["min_sum_m2"] <= per_m2 <= p2["max_sum_m2"]):
        ev.add("P.2", f"{per_m2:,.0f} сум/м² вне {p2['min_sum_m2']:,}–{p2['max_sum_m2']:,}".replace(",", " "))
    today = today or date.today()
    oldest = None
    for l in lines:
        it = next((x for x in cat.items if x["item_id"] == l.item_id), None) if l.item_id else None
        if it and it.get("price_updated"):
            d = datetime.strptime(it["price_updated"], "%Y-%m-%d").date()
            oldest = d if oldest is None or d < oldest else oldest
    if oldest and (today - oldest).days > cat.rules["7.7"]["params"]["days"]:
        ev.add("7.7", f"самая старая цена в расчёте — {oldest:%d.%m.%Y}")

    out = {"currency": "UZS", "qty": qty, "area_m2": round(area, 3), "materials": round(materials * qty),
           "works": round(works * qty), "cost": round(cost), "markup_kind": co.markup_kind, "markup_value": co.markup_value,
           "discount_pct": discount_pct, "total": total, "per_m2": round(per_m2), "demo": bool(demo) or co.demo_prices and bool(missing),
           "complete": not missing, "missing": [l.name for l in missing]}
    if co.usd_rate:
        out["total_usd"] = round(total / co.usd_rate, 2)
    return out
