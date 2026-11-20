"""Заказ: сумма позиций, варианты комплектации для КП (FR-M11, FR-T4, FR-Q1), раскрой."""
from __future__ import annotations

from . import commands
from .api import calc
from .cutting import cut_order
from .data import Catalog, Company
from .price import round_to


def calc_order(positions: list[dict], cat: Catalog, company: Company, discount_pct: float = 0.0,
               kit: dict | None = None, role: str = "owner") -> dict:
    """kit — комплектация цеха ({'name', 'setup'}): подменяет setup всех позиций (переключение заказа одним нажатием)."""
    res, total, cost, blocking, demo = [], 0, 0, [], False
    for doc in positions:
        if kit:
            doc = commands.apply_kit(doc, kit["setup"])
        r = calc(doc, cat, company, role="owner")
        res.append((doc, r))
        if r.get("price"):
            total += r["price"]["total"]
            cost += r["price"]["cost"]
            demo = demo or r["price"]["demo"]
        blocking += [dict(v, position=doc.get("id")) for v in r["violations"] if v["severity"] in ("block", "lock")]
    total = round_to(total * (1 - discount_pct / 100), company.rounding_sum)
    out = {"kit": kit["name"] if kit else None, "positions": [], "total": total, "discount_pct": discount_pct,
           "demo": demo, "can_quote": not blocking, "blocking": blocking}
    if role == "owner":
        out["cost"] = round(cost)
        out["margin"] = round(total - cost)
    if company.usd_rate:
        out["total_usd"] = round(total / company.usd_rate, 2)
    for doc, r in res:
        p = r.get("price") or {}
        item = {"id": doc.get("id"), "room": doc.get("room"), "qty": doc.get("qty", 1), "w": doc["frame"]["w"],
                "h": doc["frame"]["h"], "total": p.get("total"), "per_m2": p.get("per_m2"),
                "violations": [v for v in r["violations"] if v["severity"] in ("block", "lock", "warn")]}
        out["positions"].append(item)
    return out


def quote_variants(positions: list[dict], cat: Catalog, company: Company, kits: list[dict] | None = None,
                   discount_pct: float = 0.0, role: str = "owner") -> list[dict]:
    """До 3 вариантов комплектации для КП («Эконом / Стандарт / Тёплый»)."""
    kits = (kits or company.kits)[:3]
    return [calc_order(positions, cat, company, discount_pct, kit=k, role=role) for k in kits]


def order_cutting(positions: list[dict], cat: Catalog, company: Company) -> dict:
    rows = []
    for i, doc in enumerate(positions):
        r = calc(doc, cat, company)
        rows.append((doc.get("id") or f"pos{i + 1}", r.get("bom", []), doc.get("qty", 1)))
    p = cat.passport((positions[0].get("setup") or {}).get("system", "akfa__6000_qvt")) if positions else {}
    return cut_order(rows, p.get("bar_mm", 6000), p.get("cut_mm", 4))
