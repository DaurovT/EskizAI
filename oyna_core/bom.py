"""Спецификация позиции (FR-P1): что и сколько, с ценой за единицу каталога.

Цена строки: price_sum из каталога → иначе demo_price_sum (только при company.demo_prices) → иначе «нет цены» (P.1).
Профиль в позиции считается по метрам с отходом (waste_pct); по целым хлыстам — в раскрое заказа (cutting.py).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .evaluate import Eval
from .geometry import sash_perimeter, sash_pieces
from .glass import Glass, fits_beads, min_area, parse, price_m2
from .model import addon_ext, mosquito_type, profile_color_id, threshold_of

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
    no_markup: bool = False          # своя строка без наценки (§9.7): в цену — client_total
    client_total: float | None = None

    def as_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if v not in ("", None, []) and not (k == "no_markup" and not v)}
        for k in ("qty", "cost", "unit_price"):
            if k in d:
                d[k] = round(d[k], 3 if k == "qty" else 0)
        return d


def _price_item(ev: Eval, it: dict | None) -> tuple[float | None, str]:
    if not it:
        return None, "none"
    own = ev.company.item_prices.get((it["item_id"], it["color"]))
    if own is not None:
        return float(own), "price"                       # цена цеха поверх базовой (FR-C4)
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


def _role_line(ev: Eval, kind: str, role: str, qty: float, unit: str, name: str = "", variant: str = "",
               path: str = "", note: str = "") -> Line:
    """Строка по роли каталога (новые роли §7–8): цена цеха → цена → ДЕМО (только у демо-цеха) → «нет цены»."""
    it = ev.cat.role_item(role, variant, system=ev.setup["system"])
    ln = Line(kind, name or (it or {}).get("article") or role, qty, unit, code=role, path=path, note=note,
              article=(it or {}).get("article", ""), item_id=(it or {}).get("item_id", ""))
    price, st = _price_item(ev, it)
    ln.unit_price, ln.price_unit, ln.price_status = price, (it or {}).get("unit", unit), st
    if price is not None:
        ln.cost = qty * price
    elif not it:
        ln.note = (note + "; " if note else "") + f"нет позиции роли «{role}» в каталоге"
    return ln


MUNTIN_KIND = {"inner": "внутренняя", "overlay": "накладная"}
MUNTIN_COLOR = {"white": "белая", "decor": "в цвет ламинации", "gold": "золотая"}
GLASS_DECOR = {"matte": "матовое", "tinted": "тонированное", "mirror": "зеркальное", "pattern": "узорчатое", "stained": "витраж"}


def _muntin_lines(ev: Eval, cg) -> list[Line]:
    from .rules import muntin_layout
    m = cg.cell.get("muntins")
    if not m or cg.cell.get("type") == "panel":
        return []
    kind, pattern = m.get("kind", "inner"), m.get("pattern", "grid")
    tail = f"{MUNTIN_KIND.get(kind, kind)}, {m.get('width_mm', 18)} мм, {MUNTIN_COLOR.get(m.get('color', 'white'), m.get('color'))}"
    if pattern == "decor":
        return [_role_line(ev, "muntin", "muntin_decor", cg.glass_area_m2, "m2", "Декоративная вставка в стекло",
                           path=cg.path, note=f"{cg.glass_area_m2:.3f} м² стекла ячейки")]
    lay = muntin_layout(cg, m)
    meters = sum(lay["lengths"]) / M
    if not meters:
        return []
    if kind == "overlay":
        ln = _role_line(ev, "muntin", "muntin_overlay", meters * 2, "m", f"Раскладка ({tail})", path=cg.path,
                        note=f"{meters:.2f} м × 2 стороны")
        ln.pieces = [x for x in lay["lengths"] for _ in (0, 1)]
        return [ln]
    out = [_role_line(ev, "muntin", "muntin_inner", meters, "m", f"Раскладка ({tail})", path=cg.path)]
    out[0].pieces = list(lay["lengths"])
    if lay["crosses"]:
        out.append(_role_line(ev, "muntin", "muntin_cross", lay["crosses"], "pcs", "Крестовина раскладки", path=cg.path))
    return out


def _color_lines(ev: Eval, lines: list[Line]) -> list[Line]:
    """Цвет профиля в массе (наценка %) и ламинация не из прайса (погонные метры × стороны)."""
    out = []
    prof = [l for l in lines if l.kind in ("profile", "bead")]
    meters = sum(l.qty for l in prof)
    if ev.color_surcharge and meters:
        pc = ev.color_surcharge["id"]
        it = ev.cat.role_item("profile_color", pc)
        name = ev.cat.profile_colors.get(pc, {}).get("name_ru", ev.color_surcharge["code"])
        ln = Line("profile", f"Цвет профиля: {name}", meters, "m", code="profile_color",
                  article=(it or {}).get("article", ""), item_id=(it or {}).get("item_id", ""))
        pct, st = _price_item(ev, it)
        ln.price_status, ln.price_unit = st, "pct"
        if pct is not None:
            base = sum(l.cost or 0 for l in prof)
            ln.cost = base * pct / 100
            ln.unit_price = ln.cost / meters
            ln.note = f"+{pct:g} % к цене профиля ({ev.color_surcharge['code']})"
        else:
            ln.note = "наценка за цвет в массе — в настройках цеха"
        out.append(ln)
    if ev.lam_extra_sides and meters:
        sides = [x for x in ("out", "in") if ev.setup.get(f"lam_{x}")]
        names = ", ".join(f"{'снаружи' if x == 'out' else 'внутри'} — "
                          f"{ev.cat.decors.get(ev.setup[f'lam_{x}'], {}).get('name_ru', ev.setup[f'lam_{x}'])}" for x in sides)
        out.append(_role_line(ev, "work", "lamination", meters * len(sides), "m", f"Ламинация профиля ({names})",
                              note=f"{meters:.1f} м × {len(sides)} стор.; ламинированного профиля этой системы нет в прайсе"))
        out[-1].kind = "lamination"
    return out


def build_bom(ev: Eval) -> list[Line]:
    if ev.parts:
        return _assembly_bom(ev)
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
            sash_seal_m += sash_perimeter(cg) / M
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
            lines += _sash_extras(ev, cg)
        if cg.cell.get("vent"):
            lines.append(_role_line(ev, "fitting", "vent_valve", 1, "pcs", "Приточный клапан", path=cg.path,
                                    note=f"{(cg.cell['vent'] or {}).get('type', 'supply_valve')}, в верхний профиль"))
        # заполнение
        if g is None:                                             # панель
            it = (cat.items_for(s["system"], "lambri", ev.group) or cat.items_for(s["system"], "lambri", "Белый") or [None])[0]
            area = cg.glass_area_m2
            meters = area / 0.1
            ln = Line("panel", "Панель (ламбри)", meters, "m", article=(it or {}).get("article", ""),
                      item_id=(it or {}).get("item_id", ""), path=cg.path, note="ДЕМО: ширина ламели 100 мм")
            price, st = _price_item(ev, it)
            ln.unit_price, ln.price_status = price, st
            if price is not None:
                ln.cost = meters / (p.get("bar_mm", 6000) / M) * price
            lines.append(ln)
        elif isinstance(g, Glass):
            area = cg.glass_area_m2
            calc_area = max(area, min_area(cat))
            shaped_pct = 0.0
            if cg.shaped:                                         # фигурное стекло: площадь по контуру + наценка
                row = cat.glass_presets.get(g.preset or "") or cat.glass_presets.get(s["glass"]) or {}
                shaped_pct = float(row.get("shaped_extra_pct") or 30)
            pr, st, how = price_m2(g, cat, ev.company)
            if pr is None and ev.company.demo_prices:
                g2 = parse(g.formula, cat)
                g2.preset = None
                pr, _, how = price_m2(g2, cat, ev.company)
                st = "demo"
            # «оценка» (коэффициенты) — не прайс стекольщика: у боевого цеха это «нет цены», пока он не внесёт свой прайс
            status = {"найдено": "price", "оценка": "demo" if ev.company.demo_prices else "none"}.get(st, st)
            label = cat.glass_presets[g.preset]["formula"].split(" ")[0] + ("i" if g.preset.endswith("i") and not cat.glass_presets[g.preset]["formula"].split(" ")[0].endswith("i") else "") \
                if g.preset else g.formula
            ln = Line("glass", f"Стеклопакет {label}" + (" фигурный" if cg.shaped else ""), calc_area, "m2",
                      code=g.preset or g.formula, article=label, path=cg.path,
                      note=f"{cg.glass_w:.0f}×{cg.glass_h:.0f} мм, {area:.3f} м²; {how}"
                           + (f"; фигурное +{shaped_pct:g} %" if cg.shaped else "")
                           + ("; нужен прайс стекольщика цеха" if status == "none" else ""))
            if pr is not None and shaped_pct:
                pr = pr * (1 + shaped_pct / 100)
            ln.unit_price, ln.price_unit = pr, "m2"
            ln.price_status = "none" if pr is None else status
            if status == "none":
                pr = None
            if pr is not None:
                ln.cost = calc_area * pr
            lines.append(ln)
            bead_role = fits_beads(g, p) or "bead_igu"
            lines.append(_profile_line(ev, "bead", bead_role, "Штапик", cg.bead_lengths, path=cg.path))
            glass_seal_m += cg.glass_perim_mm / M * 2
            dec = (cg.cell.get("fill") or {}).get("decor")
            if dec:
                tint = (cg.cell.get("fill") or {}).get("tint")
                lines.append(_role_line(ev, "glass", "glass_decor", calc_area, "m2",
                                        f"Декор стекла: {GLASS_DECOR.get(dec, dec)}" + (f" ({tint})" if tint else ""),
                                        variant=dec, path=cg.path))
        lines += _muntin_lines(ev, cg)
    grey = s.get("seal_color") == "grey"
    if sash_seal_m:
        lines.append(_seal_line(ev, "Уплотнитель притвора" + (" (серый)" if grey else ""), "Rezina EPDM X (3kg)", sash_seal_m))
    if glass_seal_m:
        lines.append(_seal_line(ev, "Уплотнитель стекла" + (" (серый)" if grey else ""), "Rezina EPDM Steklo (6kg)", glass_seal_m))
    if grey:
        for l in lines[-2:]:
            if l.kind == "seal":
                l.note += "; серого артикула нет в каталоге — по цене чёрного"
    bead = s.get("bead")
    if bead in ("round", "profiled", "square"):
        beads = [l for l in lines if l.kind == "bead"]
        for l in beads:
            l.name += {"round": " (круглый)", "profiled": " (фигурный)", "square": " (прямой)"}[bead]
        if bead == "profiled" and beads:
            lines.append(_role_line(ev, "bead", "bead_profiled", sum(l.qty for l in beads), "m", "Штапик фигурный (доплата)"))
    lines += _addon_lines(ev, geo.w, geo.h)

    if geo.bent_mm:
        lines.append(_work_line(ev, "work_bend", geo.bent_mm / M))
    lines += _color_lines(ev, lines)
    lines += _extras_lines(ev, geo.w, geo.h, geo.area_m2, geo.perimeter_mm / M)
    return [l for l in lines if l is not None]


def _extras_lines(ev: Eval, W: float, H: float, area_m2: float, perim_m: float) -> list[Line]:
    """Добивки и работы позиции: подоконник, отлив, откосы, демонтаж, монтаж и монтажные материалы."""
    cat = ev.cat
    lines: list[Line] = []
    ext = addon_ext(ev.doc)
    W, H = W + ext["left"] + ext["right"], H + ext["top"] + ext["bottom"]
    lines += _builtin_lines(ev, W, H)
    # добивки и работы
    ex = ev.doc.get("extras") or {}
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
    lines += _custom_lines(ev)
    return lines


MOSQ = {"frame": ("mosq_frame", "рамочная"), "sliding": ("mosq_sliding", "раздвижная"), "pleated": ("mosq_pleated", "плиссе"),
        "door": ("mosq_door", "дверная на петлях"), "antipet": ("mosq_antipet", "«антикошка»")}


def _sash_extras(ev: Eval, cg) -> list[Line]:
    """Створка: москитная сетка (§9.2), порог двери (§9.1), порог HS."""
    out = []
    c = cg.cell
    mq = mosquito_type(c)
    if mq:
        role, name = MOSQ.get(mq, MOSQ["frame"])
        if role == "mosq_door":
            out.append(_role_line(ev, "mosquito", role, 1, "pcs", f"Москитная сетка {name}", path=cg.path))
        else:
            a = cg.sash.w * cg.sash.h / 1e6
            out.append(_role_line(ev, "mosquito", role, a, "m2", f"Москитная сетка {name}", path=cg.path,
                                  note=f"{cg.sash.w:.0f}×{cg.sash.h:.0f} мм"))
    th = threshold_of(c) if c.get("type") == "door_sash" else None
    if th == "low_alu":
        out.append(_role_line(ev, "profile", "threshold_alu", cg.sash.w / M, "m", "Порог алюминиевый низкий", path=cg.path))
    if (c.get("open") == "hs"):
        out.append(_role_line(ev, "profile", "threshold_hs", cg.axis.w / M, "m", "Порог HS", path=cg.path))
    return out


ADDON = {"extender": ("addon_extender", "Расширитель"), "base_profile": ("addon_base", "Подставочный профиль"),
         "frame_connector": ("addon_connector", "Соединитель коробок"), "cover_strip": ("addon_cover", "Нащельник"),
         "canopy": ("addon_canopy", "Козырёк")}
SIDE_RU = {"top": "сверху", "bottom": "снизу", "left": "слева", "right": "справа", "all": "по периметру"}


def _addon_lines(ev: Eval, W: float, H: float) -> list[Line]:
    """Дополнительные профили doc.addons (§9.3): длина по умолчанию = сторона рамы."""
    out = []
    for a in ev.doc.get("addons") or []:
        if a.get("type") not in ADDON:
            continue
        role, name = ADDON[a["type"]]
        side = a.get("side", "bottom")
        L = a.get("length_mm") or (2 * (W + H) if side == "all" else W if side in ("top", "bottom") else H)
        variant = ""
        if a["type"] == "extender":
            sizes = sorted({int(it["type_ru"]) for it in ev.cat._by_role.get(role, []) if (it.get("type_ru") or "").isdigit()})
            want = int(a.get("size_mm") or 40)
            variant = str(min(sizes, key=lambda x: (abs(x - want), x))) if sizes else ""
            name += f" {want} мм"
        elif a.get("size_mm"):
            name += f" {a['size_mm']} мм"
        ln = _role_line(ev, "addon", role, L / M, "m", f"{name} ({SIDE_RU.get(side, side)})", variant=variant)
        ln.pieces = [round(L, 1)] if side != "all" else [W, W, H, H]
        out.append(ln)
    return out


def _builtin_lines(ev: Eval, W: float, H: float) -> list[Line]:
    """Встроенное в окно (§9.4): рольставня/жалюзи, решётка — по габариту; лоджия (§9.5)."""
    out = []
    area = W * H / 1e6
    sh = ev.doc.get("shutter")
    if sh:
        kind = sh.get("type", "roller")
        role = "shutter_blinds" if kind == "blinds" else "shutter_roller"
        out.append(_role_line(ev, "shutter", role, area, "m2", "Жалюзи в коробе" if kind == "blinds" else "Рольставня",
                              note=f"{W:.0f}×{H:.0f} мм; управление {'электро' if sh.get('control') == 'electric' else 'ручное'}"))
        if sh.get("control") == "electric":
            out.append(_role_line(ev, "shutter", "shutter_motor", 1, "pcs", "Электропривод"))
    gr = ev.doc.get("grille")
    if gr:
        pat = gr.get("pattern", "straight")
        out.append(_role_line(ev, "grille", "grille", area, "m2", f"Решётка {'кованая' if pat == 'forged' else 'из прутка'}"
                              + (", открывающаяся" if gr.get("type") == "opening" else ""), variant=pat))
    lg = ev.doc.get("loggia")
    if lg:
        L = float(ev.doc["frame"]["w"])                         # длина остекления — развёртка
        out_mm = float(lg.get("outrigger_mm") or 0)
        if out_mm:
            out.append(_role_line(ev, "loggia", "loggia_outrigger", L / M, "m", f"Вынос остекления {out_mm:.0f} мм"))
        if lg.get("roof"):
            a = L * (out_mm + 500) / 1e6
            out.append(_role_line(ev, "loggia", "loggia_roof", a, "m2", "Крыша лоджии",
                                  note=f"{L:.0f} × ({out_mm:.0f} + 500) мм"))
        cl = lg.get("cladding")
        if cl:
            sides = 2 if cl == "both" else 1
            ph = float(lg.get("parapet_h_mm") or 1000)
            a = L * ph / 1e6 * sides
            out.append(_role_line(ev, "loggia", "loggia_cladding", a, "m2",
                                  f"Обшивка парапета ({ {'outside': 'снаружи', 'inside': 'внутри', 'both': 'с двух сторон'}.get(cl, cl) })",
                                  note=f"{L:.0f} × {ph:.0f} мм × {sides}" + (f"; парапет: {lg['parapet']}" if lg.get("parapet") else "")))
    return out


def _custom_lines(ev: Eval) -> list[Line]:
    """Своя строка позиции (§9.7): цена цеха; no_markup — в цену как есть, без наценки."""
    out = []
    for i, c in enumerate(ev.doc.get("custom_lines") or []):
        try:                                                  # документ мог прийти целиком (PUT) — без команды
            qty, price = float(c.get("qty") or 0), float(c.get("price_sum") or 0)
            float(c.get("cost_sum") or 0)
        except (TypeError, ValueError, AttributeError):
            continue
        ln = Line("custom", c.get("name") or f"Строка {i + 1}", qty, c.get("unit") or "pcs", code=f"custom:{i}",
                  unit_price=price, price_status="price", price_unit=c.get("unit") or "pcs")
        if c.get("no_markup"):
            ln.no_markup = True
            ln.client_total = qty * price
            ln.cost = qty * float(c["cost_sum"]) if c.get("cost_sum") is not None else qty * price
            ln.note = "без наценки"
        else:
            ln.cost = qty * float(c["cost_sum"] if c.get("cost_sum") is not None else price)
        out.append(ln)
    return out


def _assembly_bom(ev: Eval) -> list[Line]:
    """Сборка: спецификации рам (без монтажа) с путями A<i>/ + соединители по высоте стыка + монтаж на всю сборку."""
    lines: list[Line] = []
    for i, part in enumerate(ev.parts):
        for ln in build_bom(part):
            ln.path = f"A{i}/" + ln.path
            lines.append(ln)
    for j in ev.joints:
        if not j["role"]:
            continue
        what = {"conn_straight": "прямой", "conn_corner90": "угловой 90°", "conn_bay": f"эркерный {j['angle']}°",
                "conn_post": "стойка"}[j["role"]]
        ln = _role_line(ev, "connector", j["role"], j["height"] / M, "m", f"Соединитель рам: {what}",
                        note=f"стык {j['index'] + 1} (A{j['index']}–A{j['index'] + 1}), {j['height']:.0f} мм")
        ln.pieces = [j["height"]]
        lines.append(ln)
    W, H = float(ev.doc["frame"]["w"]), float(ev.doc["frame"]["h"])
    lines += _addon_lines(ev, W, H)
    lines += _extras_lines(ev, W, H, ev.area_m2, 2 * (W + H) / M)
    return lines
