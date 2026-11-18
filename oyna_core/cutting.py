"""Раскрой профиля по всему заказу (FR-K1): группировка по (артикул, цвет), best-fit decreasing, ширина пилы.

Вход — строки спецификации позиций (kind profile/bead/reinforcement с pieces).
Выход — хлысты по артикулам, отход, деловые остатки (≥ порога, FR-K2) и цена по целым хлыстам.
"""
from __future__ import annotations

from collections import defaultdict


def cut(pieces: list[float], bar_mm: float, saw_mm: float) -> list[dict]:
    bars: list[dict] = []
    for p in sorted(pieces, reverse=True):
        if p > bar_mm:
            raise ValueError(f"отрезок {p:.0f} мм длиннее хлыста {bar_mm:.0f} мм")
        best, best_rest = None, None
        for b in bars:
            rest = b["free"] - p - (saw_mm if b["cuts"] else 0)
            if rest >= 0 and (best_rest is None or rest < best_rest):
                best, best_rest = b, rest
        if best is None:
            best = {"cuts": [], "free": bar_mm}
            bars.append(best)
            best_rest = bar_mm - p
        best["cuts"].append(round(p, 1))
        best["free"] = best_rest
    return bars


def cut_order(positions: list[tuple[str, list[dict], int]], bar_mm: float = 6000, saw_mm: float = 4,
              offcut_min_mm: float = 500) -> dict:
    """positions: [(id позиции, bom-строки as_dict, qty)]."""
    groups: dict = defaultdict(lambda: {"pieces": [], "unit_price": None, "name": "", "status": ""})
    for pos_id, lines, qty in positions:
        for l in lines:
            if l.get("kind") not in ("profile", "bead", "reinforcement") or not l.get("pieces") or not l.get("article"):
                continue
            g = groups[(l["article"], l.get("item_id", ""))]
            g["name"], g["unit_price"], g["status"] = l["name"], l.get("unit_price"), l.get("price_status", "")
            g["pieces"] += [(x, pos_id) for x in l["pieces"]] * qty
    out, total = [], 0.0
    for (article, item_id), g in groups.items():
        bars = cut([x for x, _ in g["pieces"]], bar_mm, saw_mm)
        used = sum(sum(b["cuts"]) for b in bars)
        offcuts = [round(b["free"]) for b in bars if b["free"] >= offcut_min_mm]
        cost = len(bars) * g["unit_price"] if g["unit_price"] is not None else None
        total += cost or 0
        out.append({"article": article, "item_id": item_id, "name": g["name"], "bars": len(bars),
                    "used_m": round(used / 1000, 2), "waste_pct": round(100 * (1 - used / (len(bars) * bar_mm)), 1),
                    "offcuts_mm": offcuts, "layout": [b["cuts"] for b in bars], "cost": cost, "price_status": g["status"]})
    out.sort(key=lambda x: x["article"])
    return {"bar_mm": bar_mm, "saw_mm": saw_mm, "items": out, "profile_cost_whole_bars": round(total)}
