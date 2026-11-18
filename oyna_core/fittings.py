"""Подбор фурнитуры створки по правилам fitting_rules.csv (размер по фальцу, цапфы, варианты)."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from .data import Catalog

SIZE_SUFFIX = re.compile(r"_(s|m|l|gr\d+|\d+)$")
# семейства, которые нужны только начиная с размера: меньше — детали просто нет
OPTIONAL_FROM = {"middle_lock", "middle_lock_h", "middle_lock_w", "scissors_extra", "tilt_hinge", "middle_pressure"}


@dataclass
class Part:
    code: str
    name: str
    qty: float
    cams: int
    item_article: str
    demo_price: float | None
    family: str
    option_group: str = ""
    status: str = ""


@dataclass
class Selection:
    fitting_set: str
    opening: str
    parts: list = field(default_factory=list)
    problems: list = field(default_factory=list)      # (code, msg)


def family(part_code: str) -> str:
    return SIZE_SUFFIX.sub("", part_code)


def opening_of(cell: dict, kind: str) -> str:
    if cell.get("type") == "door_sash" and kind == "door":
        return "door"
    return cell.get("open") or "turn"


def _in(v, lo, hi) -> bool:
    return (lo is None or v >= lo) and (hi is None or v <= hi)


def _qty(expr: str, w: float, h: float, cams: int) -> float:
    expr = (expr or "1").strip()
    if expr == "cams":
        return cams
    try:
        return float(expr)
    except ValueError:
        return float(eval(expr, {"__builtins__": {}}, {"ceil": math.ceil, "w": w, "h": h}))   # выражения из своих данных


def select(cat: Catalog, fitting_set: str, groove: str, cell: dict, kind: str, ffb: float, ffh: float,
           weight: float | None, options: dict, decor_in: dict | None) -> Selection:
    opening = opening_of(cell, kind)
    sel = Selection(fitting_set, opening)
    fs = cat.fitting_systems.get(fitting_set)
    if not fs:
        sel.problems.append(("7.2", f"неизвестный набор фурнитуры «{fitting_set}»"))
        return sel
    if opening not in fs["openings"]:
        sel.problems.append(("7.8", f"набор «{fs['title']}» не делает открывание «{opening}»"))
        return sel
    rows = [r for r in cat.fitting_rules
            if r["fitting_system"] in (fitting_set, "*" + groove) and r["opening"] == opening]
    if not any(r["fitting_system"] == fitting_set for r in rows) and fitting_set != "generic":
        # у набора нет своих деталей для этого открывания (например, откидная фрамуга у Fornax) — типовая фурнитура
        rows = [r for r in cat.fitting_rules if r["fitting_system"] in ("generic", "*" + groove) and r["opening"] == opening]
        sel.problems.append(("info", f"для «{opening}» у набора «{fitting_set}» нет своих деталей — взята типовая"))
    elif opening in ("turn", "tilt_turn"):
        lo_w, hi_w = fs["sash_w_mm"]
        lo_h, hi_h = fs["sash_h_mm"]
        if not (lo_w <= ffb <= hi_w and lo_h <= ffh <= hi_h):
            sel.problems.append(("7.8", f"створка по фальцу {ffb:.0f}×{ffh:.0f} вне набора {lo_w}–{hi_w} × {lo_h}–{hi_h} мм"))

    chosen: list[dict] = []
    # 1) группы вариантов
    groups: dict[str, list] = {}
    for r in rows:
        if r["option_group"]:
            groups.setdefault(r["option_group"], []).append(r)
    for g, cands in groups.items():
        want = options.get(g)
        if want:
            hit = [r for r in cands if r["code"] == want]
            if not hit:
                sel.problems.append(("7.9", f"вариант «{want}» не из группы «{g}» набора «{fitting_set}»"))
            else:
                chosen.append(hit[0])
                continue
        auto = [r for r in cands if r["when"].startswith("auto:")]
        if g == "hinge" and weight is not None and auto:
            pick = [r for r in auto if ("weight>100" in r["when"]) == (weight > 100)]
            if pick:
                chosen.append(pick[0])
                continue
        if g == "hinge_cap" and decor_in and decor_in.get("fornax_cap"):
            pick = [r for r in cands if r["item_article"] == decor_in["fornax_cap"]]
            if pick:
                chosen.append(pick[0])
                continue
        default = [r for r in cands if r["is_default"] == "1"]
        if default:
            chosen.append(default[0])

    # 2) обычные строки: условие, размер, семейство
    fam_rows: dict[str, list] = {}
    for r in rows:
        if r["option_group"]:
            continue
        when = r["when"]
        if when == "never" or when.startswith("опция") or when == "по заказу":
            continue
        if when == "handle" and not cell.get("handle", True):
            continue
        if when == "weight>100" and not (weight is not None and weight > 100):
            continue
        if when == "weight<=100" and not (weight is None or weight <= 100):
            continue
        fam_rows.setdefault(family(r["part_code"]), []).append(r)
    for fam, rs in fam_rows.items():
        ranged = [r for r in rs if any(r[k] is not None for k in ("w_from", "w_to", "h_from", "h_to"))]
        plain = [r for r in rs if r not in ranged]
        chosen.extend(plain)
        if ranged:
            fit = [r for r in ranged if _in(ffb, r["w_from"], r["w_to"]) and _in(ffh, r["h_from"], r["h_to"])]
            if fit:
                fit.sort(key=lambda r: ((r["w_to"] or 1e9) - (r["w_from"] or 0)) + ((r["h_to"] or 1e9) - (r["h_from"] or 0)))
                chosen.append(fit[0])
            elif fam in OPTIONAL_FROM and (min((r["h_from"] or 0) for r in ranged) > ffh
                                           or min((r["w_from"] or 0) for r in ranged) > ffb):
                pass                                  # деталь нужна только начиная с размера (средний запор с 1200 и т. п.)
            else:
                sel.problems.append(("7.8", f"«{rs[0]['part_name']}»: нет размера для створки по фальцу {ffb:.0f}×{ffh:.0f} мм"))

    # 3) количества и цапфы → ответные планки
    cams = 0
    parts = []
    for r in chosen:
        if r["qty"] == "cams":
            continue
        q = _qty(r["qty"], ffb, ffh, 0)
        if q <= 0:
            continue
        c = int(r["cams"] or 0)
        cams += int(c * q)
        parts.append(Part(r["code"], r["part_name"], q, c, r["item_article"], r["demo_price_sum"], family(r["part_code"]),
                          r["option_group"], r["status"]))
    for r in chosen:
        if r["qty"] == "cams" and cams:
            parts.append(Part(r["code"], r["part_name"], cams, 0, r["item_article"], r["demo_price_sum"],
                              family(r["part_code"]), r["option_group"], r["status"]))
    sel.parts = parts
    return sel
