"""Цена позиции (FR-P3…P7): себестоимость → режим дилера → наценка → скидка → округление.

P = round_N((C · (1 + m) | C / (1 − m) | C + m_м² · S) · (1 − d)) — наценка на себестоимость, доля маржи в цене или за м², где C = материалы (× (1 + коэф. дилера)) + работы.
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
    area = ev.area_m2
    missing = [l for l in lines if l.price_status == "none"]
    demo = [l for l in lines if l.price_status == "demo"]

    as_is = [l for l in lines if getattr(l, "no_markup", False)]      # свои строки без наценки (§9.7)
    lines_m = [l for l in lines if not getattr(l, "no_markup", False)]
    materials = sum(l.cost or 0 for l in lines_m if l.kind != "work")
    works = sum(l.cost or 0 for l in lines_m if l.kind == "work")
    if co.mode == "dealer":
        materials *= 1 + (co.dealer_coef or 0)          # FR-P7: заказ у производителя
    cost = (materials + works) * qty
    by_group = mark_lines(co, lines_m)
    for l in as_is:
        l.group = "other"
    mg = co.markup_groups if co.markup_kind != "per_m2" else None
    if mg:                                               # наценка по группам строк (§9.7), в том же markup_kind
        before = sum(_markup(co.markup_kind, mg.get(g, co.markup_value), c) for g, c in by_group.items()) * qty
    elif co.markup_kind == "per_m2":                     # сумма за м²
        before = cost + co.markup_value * area * qty
    elif co.markup_kind == "margin":                     # доля маржи в цене: 30% → цена = себестоимость / 0,7
        before = cost / (1 - min(co.markup_value, 95) / 100)
    else:                                                # percent: наценка на себестоимость: 30% → × 1,3
        before = cost * (1 + co.markup_value / 100)
    before += sum(l.client_total or 0 for l in as_is) * qty
    cost += sum(l.cost or 0 for l in as_is) * qty
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
    if mg:
        out.update(markup_groups=mg, by_group={g: round(c * qty) for g, c in by_group.items()})
    if co.usd_rate:
        out["total_usd"] = round(total / co.usd_rate, 2)
    return out


def _markup(kind: str, m: float, c: float) -> float:
    if kind == "margin":
        return c / (1 - min(m, 95) / 100)
    return c * (1 + m / 100)


def mark_lines(co, lines: list[Line]) -> dict[str, float]:
    """Группа строки (наценка по группам) и поставщик цены (§9.7) → себестоимость по группам на 1 изделие."""
    from .groups import line_group
    by: dict[str, float] = {}
    for l in lines:
        l.group = line_group(l.kind, l.code)
        sid = co.price_sources.get(("item", l.item_id) if l.item_id else ("glass", l.code))
        catg = l.group if l.group in ("profile", "glass", "fittings") else "other"
        if sid and l.price_status == "price" and (sid != co.default_suppliers.get(catg) or len(co.suppliers) > 1):
            l.supplier_name = co.suppliers.get(sid, sid)   # цена не у основного поставщика или поставщиков несколько
        c = l.cost or 0
        if l.kind != "work" and co.mode == "dealer":
            c *= 1 + (co.dealer_coef or 0)
        by[l.group] = by.get(l.group, 0) + c
    return by
