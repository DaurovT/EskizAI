"""Спецификация позиции (FR-P1): что и сколько, с ценой за единицу каталога.

Цена строки: price_sum из каталога → иначе demo_price_sum (только при company.demo_prices) → иначе «нет цены» (P.1).
Профиль в позиции считается по метрам с отходом (waste_pct); по целым хлыстам — в раскрое заказа (cutting.py).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .evaluate import Eval
from .geometry import sash_pieces
from .glass import Glass, fits_beads, min_area, parse, price_m2

M = 1000.0


@dataclass
class Line:
    kind: str                        # profile | reinforcement | bead | glass | panel | fitting | seal | connector | sill | drip | work | consumable
    name: str
    qty: float                       # в единицах unit
    unit: str                        # m | pcs | m2 | kg
    code: str = ""                   # код правила фурнитуры / роль / работа
    article: str = ""
    item_id: str = ""
    path: str = ""
    pieces: list = field(default_factory=list)   # длины отрезков, мм (для раскроя)
    unit_price: float | None = None  # за единицу каталога (хлыст, бухта, шт, м², м)
    price_unit: str = ""             # bar | pack | pcs | m2 | m | kg
    cost: float | None = None
    price_status: str = ""           # price | demo | estimate | none
    note: str = ""

    def as_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if v not in ("", None, [])}
        for k in ("qty", "cost", "unit_price"):
            if k in d:
                d[k] = round(d[k], 3 if k == "qty" else 0)
        return d


def _price_item(ev: Eval, it: dict | None) -> tuple[float | None, str]:
    if not it:
        return None, "none"
    if it.get("price_sum"):
        return float(it["price_sum"]), "price"
    if ev.company.demo_prices and it.get("demo_price_sum"):
        return float(it["demo_price_sum"]), "demo"
    return None, "none"


def _profile_line(ev: Eval, kind: str, role: str, name: str, pieces: list, path: str = "", note: str = "") -> Line:
    cat, s = ev.cat, ev.setup
    it = (cat.items_for(s["system"], role, ev.group) or [None])[0]
    meters = sum(pieces) / M
    ln = Line(kind, name, meters, "m", code=role, path=path, pieces=[round(x, 1) for x in pieces], note=note)
    if not it:
        ln.price_status, ln.note = "none", (note + "; " if note else "") + f"нет позиции «{role}» цвета «{ev.group}» в каталоге"
        return ln
    ln.article, ln.item_id = it["article"], it["item_id"]
    price, st = _price_item(ev, it)
    ln.unit_price, ln.price_unit, ln.price_status = price, it["unit"], st
    if price is not None:
        if it["unit"] == "bar":
            bar = ev.passport.get("bar_mm", 6000) / M
            ln.cost = meters / bar * price * (1 + ev.company.waste_pct / 100)
        else:
            ln.cost = meters * price
    return ln


def _reinf_line(ev: Eval, profile_role: str, pieces: list) -> Line | None:
    cat = ev.cat
    off = cat.consumables["reinforcement"]["offset_from_corner_mm"]
    pcs = [max(0.0, x - 2 * off) for x in pieces]
    rows = [r for r in cat.reinforcement_map if r["system_code"] == ev.setup["system"] and r["profile_role"] == profile_role]
    want = (ev.setup.get("options") or {}).get("reinforcement_" + profile_role)
    row = next((r for r in rows if r["item_article"] == want), None) or next((r for r in rows if r["is_default"] == "1"), None)
    meters = sum(pcs) / M
    ln = Line("reinforcement", f"Армирование ({profile_role})", meters, "m", code=profile_role, pieces=[round(x, 1) for x in pcs])
    if not row:
        ln.price_status, ln.note = "none", "нет армирования для системы"
        return ln
    it = cat.item_by_article(row["item_article"], system=row["accessory_series"])
    ln.article, ln.item_id = row["item_article"], (it or {}).get("item_id", "")
    price, st = _price_item(ev, it)
    ln.unit_price, ln.price_unit, ln.price_status = price, (it or {}).get("unit", "bar"), st
    if row["status"].startswith("ДЕМО"):
        ln.note = "универсальный металл Akfa того же класса (5.8)"
    if price is not None:
        ln.cost = meters / (ev.passport.get("bar_mm", 6000) / M) * price * (1 + ev.company.waste_pct / 100)
    return ln


def _seal_line(ev: Eval, name: str, article: str, meters: float) -> Line:
    cat = ev.cat
    it = cat.item_by_article(article)
    mpk = cat.consumables["seal_m_per_kg"]["default"]
    kg = meters / mpk
    ln = Line("seal", name, kg, "kg", article=article, item_id=(it or {}).get("item_id", ""),
              note=f"{meters:.1f} м ÷ {mpk} м/кг")
    price, st = _price_item(ev, it)
    ln.unit_price, ln.price_status, ln.price_unit = price, st, (it or {}).get("unit", "kg")
    if price is not None:
        pack = float(it["pack_kg"]) if it.get("pack_kg") else (15.0 if it.get("unit") == "pack" else None)
        ln.cost = kg / pack * price if pack else kg * price
    return ln


def _work_line(ev: Eval, code: str, qty: float, name: str | None = None) -> Line:
    w = ev.cat.works.get(code, {})
    ln = Line("work", name or w.get("name", code), qty, w.get("unit", "pcs"), code=code)
    if code in ev.company.work_rates:
        unit, price = ev.company.work_rates[code]
        ln.unit_price, ln.price_status = price, "price"
    elif ev.company.demo_prices and w.get("demo_price_sum") not in (None, ""):
        ln.unit_price, ln.price_status = float(w["demo_price_sum"]), "demo"
    else:
        ln.price_status, ln.note = "none", "цена работы — в настройках цеха"
    if ln.unit_price is not None:
        ln.cost = qty * ln.unit_price
    return ln


def _ref_line(ev: Eval, kind: str, key: str, name: str, qty: float, unit: str) -> Line:
    ref = ev.cat.consumables["reference_prices_sum"].get(key, {})
    v = ref.get("value", ref.get("default"))
    ln = Line(kind, name, qty, unit, code=key)
    if v is not None and (ev.company.demo_prices or ref.get("status") != "ДЕМО"):
        ln.unit_price, ln.cost, ln.price_status = float(v), qty * float(v), "demo" if ref.get("status") == "ДЕМО" else "estimate"
    else:
        ln.price_status, ln.note = "none", "цена — в настройках цеха"
    return ln


def build_bom(ev: Eval) -> list[Line]:
    cat, s, geo, p = ev.cat, ev.setup, ev.geo, ev.passport
    lines: list[Line] = []
    door_kind = ev.kind in ("door", "balcony_block")
    has = lambda role: bool(cat.items_for(s["system"], role, ev.group))
    reinforce = ev.material == "pvc" and p.get("reinforce") == "always"
    white = ev.group == "Белый"
    long_ = cat.rules["5.2"]["params"]["gt"]
    need_reinf = lambda x: reinforce and (not white or x > long_)

    # рама
    frame_role = "door_frame" if ev.kind == "door" and has("door_frame") else "frame"
    lines.append(_profile_line(ev, "profile", frame_role, "Рама", geo.frame_pieces))
    rp = [x for x in geo.frame_pieces if need_reinf(x)]
    if rp:
        lines.append(_reinf_line(ev, frame_role, rp))
    # импосты
    if geo.mullions:
        door_m = door_kind and has("door_mullion")
        role = "door_mullion" if door_m else "mullion"
        pcs = [m.length for m in geo.mullions]
        lines.append(_profile_line(ev, "profile", role, "Импост", pcs))
        if reinforce:
            lines.append(_reinf_line(ev, role, pcs))              # 5.1: импост ПВХ — всегда
        conn = next((it for it in cat.items if it["role"] == "connector" and it["system_code"] == s["system"] + "_aksessuarlari"), None) \
            or cat.item_by_article("Soedinitel 5200", system="akfa__6000_qvt_aksessuarlari")
        n = cat.consumables["mullion_connectors_per_mullion"] * len(geo.mullions)
        ln = Line("connector", "Соединитель импоста", n, "pcs", article=conn["article"], item_id=conn["item_id"])
        ln.unit_price, ln.price_status = _price_item(ev, conn)
        if ln.unit_price is not None:
            ln.cost = n * ln.unit_price
        lines.append(ln)
    for sh in geo.shtulps:
        lines.append(_profile_line(ev, "profile", "shtulp", "Штульп", [sh["length"]], path=sh["path"]))
        if reinforce:
            lines.append(_reinf_line(ev, "shtulp", [sh["length"]]))

    sash_seal_m, glass_seal_m = 0.0, 0.0
    for cg in geo.cells:
        g = ev.glass.get(cg.path)
        # створка
        if cg.sash:
            role = "door_sash" if cg.cell.get("type") == "door_sash" and has("door_sash") else "sash"
            pcs = sash_pieces(cg, p)
            lines.append(_profile_line(ev, "profile", role, "Створка", pcs, path=cg.path))
            rp = [x for x in pcs if need_reinf(x)]
            if rp:
                lines.append(_reinf_line(ev, role, rp))
            sash_seal_m += 2 * (cg.sash.w + cg.sash.h) / M
            sel = ev.fittings.get(cg.path)
            for part in (sel.parts if sel else []):
                it = cat.item_by_article(part.item_article) if part.item_article else None
                ln = Line("fitting", part.name, part.qty, "pcs", code=part.code, article=part.item_article,
                          item_id=(it or {}).get("item_id", ""), path=cg.path)
                price, st = _price_item(ev, it)
                if price is None and part.demo_price is not None and ev.company.demo_prices:
                    price, st = float(part.demo_price), "demo"
                ln.unit_price, ln.price_status, ln.price_unit = price, st, "pcs"
                if price is not None:
                    ln.cost = part.qty * price
                lines.append(ln)
        # заполнение
        if g is None:                                             # панель
            it = (cat.items_for(s["system"], "lambri", ev.group) or cat.items_for(s["system"], "lambri", "Белый") or [None])[0]
            area = cg.glass_w * cg.glass_h / 1e6
            meters = area / 0.1
            ln = Line("panel", "Панель (ламбри)", meters, "m", article=(it or {}).get("article", ""),
                      item_id=(it or {}).get("item_id", ""), path=cg.path, note="ДЕМО: ширина ламели 100 мм")
            price, st = _price_item(ev, it)
            ln.unit_price, ln.price_status = price, st
            if price is not None:
                ln.cost = meters / (p.get("bar_mm", 6000) / M) * price
            lines.append(ln)
        elif isinstance(g, Glass):
            area = cg.glass_w * cg.glass_h / 1e6
            calc_area = max(area, min_area(cat))
            pr, st, how = price_m2(g, cat)
            if pr is None and ev.company.demo_prices:
                g2 = parse(g.formula, cat)
                g2.preset = None
                pr, _, how = price_m2(g2, cat)
                st = "demo"
            # «оценка» (коэффициенты) — не прайс стекольщика: у боевого цеха это «нет цены», пока он не внесёт свой прайс
            status = {"найдено": "price", "оценка": "demo" if ev.company.demo_prices else "none"}.get(st, st)
            ln = Line("glass", f"Стеклопакет {g.spec}", calc_area, "m2", code=g.preset or g.formula, path=cg.path,
                      note=f"{cg.glass_w:.0f}×{cg.glass_h:.0f} мм, {area:.3f} м²; {how}"
                           + ("; нужен прайс стекольщика цеха" if status == "none" else ""))
            ln.unit_price, ln.price_unit = pr, "m2"
            ln.price_status = "none" if pr is None else status
            if status == "none":
                pr = None
            if pr is not None:
                ln.cost = calc_area * pr
            lines.append(ln)
            bead_role = fits_beads(g, p) or "bead_igu"
            lines.append(_profile_line(ev, "bead", bead_role, "Штапик", cg.bead_lengths, path=cg.path))
            glass_seal_m += 2 * (cg.glass_w + cg.glass_h) / M * 2
    if sash_seal_m:
        lines.append(_seal_line(ev, "Уплотнитель притвора", "Rezina EPDM X (3kg)", sash_seal_m))
    if glass_seal_m:
        lines.append(_seal_line(ev, "Уплотнитель стекла", "Rezina EPDM Steklo (6kg)", glass_seal_m))

    # добивки и работы
    ex = ev.doc.get("extras") or {}
    W, H = geo.w, geo.h
    area_m2 = W * H / 1e6
    perim_m = 2 * (W + H) / M
    if ex.get("sill"):
        depth = (ex["sill"] or {}).get("depth_cm", 30) if isinstance(ex["sill"], dict) else 30
        over = cat.consumables["sill_overhang_mm_each_side"]
        L = (W + 2 * over) / M
        cands = [it for it in cat.items if it["role"] == "sill" and it["sill_depth_cm"] == str(depth)]
        it = next((x for x in cands if x["color"] == "Белый" and x["price_sum"]), None) or (cands or [None])[0]
        ln = Line("sill", f"Подоконник {depth} см", L, "m", article=(it or {}).get("article", ""), item_id=(it or {}).get("item_id", ""),
                  note="цена за хлыст — гипотеза, длина хлыста 6 м — ДЕМО")
        price, st = _price_item(ev, it)
        ln.unit_price, ln.price_status = price, st
        if price is not None:
            ln.cost = L / (cat.consumables["sill_bar_mm"]["value"] / M) * price * (1 + ev.company.waste_pct / 100)
        lines.append(ln)
        lines.append(_work_line(ev, "sill_install", L))
    if ex.get("drip"):
        L = (W + 2 * cat.consumables["drip_overhang_mm_each_side"]) / M
        lines.append(_ref_line(ev, "drip", "drip_galvanized_m", "Отлив оцинкованный", L, "m"))
        lines.append(_work_line(ev, "drip_install", L))
    if ex.get("slopes"):
        lines.append(_work_line(ev, "slopes", (2 * H + W) / M))
    if ex.get("dismantle"):
        lines.append(_work_line(ev, "dismantle", area_m2))
    if ex.get("outside"):
        lines.append(_work_line(ev, "outside_work", 1))
    if ex.get("install", True):
        lines.append(_work_line(ev, "install_door" if ev.kind in ("door", "balcony_block") else "install",
                                1 if ev.kind in ("door", "balcony_block") else area_m2))
        pw = cat.consumables["per_window"]
        lines.append(_ref_line(ev, "consumable", "foam_750ml", "Монтажная пена 750 мл", math.ceil(perim_m * pw["foam_can_per_m_perimeter"] * 10) / 10, "pcs"))
        lines.append(_ref_line(ev, "consumable", "anchor_plate_pcs", "Анкерная пластина", math.ceil(perim_m * pw["anchor_per_m_perimeter"]), "pcs"))
        lines.append(_ref_line(ev, "consumable", "vapor_tape_m", "Пароизоляционная лента", perim_m * pw["tape_m_per_m_perimeter"] / 2, "m"))
        lines.append(_ref_line(ev, "consumable", "psul_m", "ПСУЛ", perim_m * pw["tape_m_per_m_perimeter"] / 2, "m"))
        lines.append(_ref_line(ev, "consumable", "silicone_tube", "Силикон", pw["silicone_tube_per_window"], "pcs"))
    return [l for l in lines if l is not None]
