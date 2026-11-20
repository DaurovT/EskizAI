"""Проверки уровня 1 (rules_level1.json) + пределы паспорта системы (уровень 2, где он есть).

Каждая проверка добавляет нарушение через ev.add(code, msg, path, fix): реакция и название — из данных.
Правила, которым не хватает данных о проёме (6.4, 6.5, 6.9 и т. п.), срабатывают, только если данные есть.
"""
from __future__ import annotations

from . import shapes as shp
from .geometry import CellGeo
from .glass import Glass, GlassError, fits_beads
from .model import (decor, guillotine_of, guillotine_problems, is_leaf, mosquito_type, profile_color_id, root_of,
                    sliding_of, sliding_problems, special_kind, walk_nodes)

KIT_OPENINGS = ("folding", "psk", "hs", "vslide")   # сдвижные, гармошка, гильотинное: фурнитура комплектом, свои пределы

MUNTIN_WIDTHS = {"inner": (8, 18, 26), "overlay": (18, 26, 45)}
MUNTIN_PATTERNS = ("grid", "sun", "cross", "decor")
MUNTIN_COLORS = ("white", "decor", "gold")


def _sys(ev) -> str:
    """Название системы для мастера («Akfa 6000 QVT»), а не код."""
    r = ev.cat.systems.get(ev.setup["system"], {})
    return f"{r.get('brand', '')} {r.get('series', '')}".strip() or ev.setup["system"]


def muntin_layout(cg: CellGeo, m: dict) -> dict:
    """Прутки раскладки ячейки по видимому стеклу."""
    pts = cg.vis_poly or shp.rect_poly(cg.light.x0, cg.light.y0, cg.light.x1, cg.light.y1)[0]
    return shp.muntin_layout(pts, m.get("pattern", "grid"), int(m.get("v") or 0), int(m.get("h") or 0))


def shaped_openings(ev, cg: CellGeo) -> tuple[str, ...]:
    """Какие открывания можно в фигурной ячейке (4.20): у круга, полукруга и треугольника — только откидное."""
    geo = ev.geo
    semicircle = geo.shape == "arch" and geo.shape_params.get("rise", 0) >= geo.h - 0.5     # пяты на низу рамы
    if geo.shape in ("circle", "triangle") or semicircle:
        return ("tilt",)
    return ("turn", "tilt")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _floor(ev) -> int | None:
    o = ev.doc.get("opening") or {}
    return o.get("floor") or (ev.doc.get("extras") or {}).get("floor")


# ---------------- ввод: до геометрии ----------------
def check_input(ev) -> None:
    fr = ev.doc.get("frame") or {}
    w, h = fr.get("w"), fr.get("h")
    for name, v in (("ширина", w), ("высота", h)):
        if not _num(v) or v <= 0 or int(v) != v:
            ev.add("1.1", f"{name} рамы: {v!r} — нужно целое положительное число в мм")
    if ev.has("1.1"):
        ev.stopped = True
        return
    p12 = ev.cat.rules["1.2"]["params"]
    sp = special_kind(root_of(ev.doc))                      # раздвижные и гильотина (§11): свои пределы блока
    mx_w, mx_h = (p12["special"][sp]["w"], p12["special"][sp]["h"]) if sp else (p12["max"], p12["max"])
    if not (p12["min"] <= w <= mx_w and p12["min"] <= h <= mx_h):
        ev.add("1.2", f"{w}×{h} мм: блок должен быть {p12['min']}–{mx_w} × {p12['min']}–{mx_h} мм",
               fix="проверьте единицы и нули; большие проёмы делите на блоки")
        if w < ev.cat.rules["1.7"]["params"]["both_lt"] and h < ev.cat.rules["1.7"]["params"]["both_lt"]:
            ev.add("1.7", f"{w}×{h} — похоже, введено в сантиметрах", fix=f"имелось в виду {w * 10}×{h * 10} мм?")
        ev.stopped = True
        return
    if not sp and (w > ev.cat.rules["1.3"]["params"]["gt"] or h > ev.cat.rules["1.3"]["params"]["gt"]):
        ev.add("1.3", f"{w}×{h} мм", fix="добавьте импост или разделите на блоки")
    k = ev.cat.rules["1.6"]["params"]["multiple_of"]
    for name, v in (("ширина", w), ("высота", h)):
        if v % k:
            ev.add("1.6", f"{name} {v} мм не кратна {k}", fix=f"проверьте: {round(v / k) * k} мм?")
    root = root_of(ev.doc)
    for path, node in walk_nodes(root):
        if is_leaf(node) or "parts" not in node:
            continue
        for i, part in enumerate(node["parts"]):
            s = part.get("size")
            pp = f"{path}.{i}" if path else str(i)
            if _num(s):
                if s <= 0 or int(s) != s:
                    ev.add("1.1", f"размер части {s!r}", pp)
                elif s % k:
                    ev.add("1.6", f"размер части {s} мм не кратен {k}", pp)
    if ev.has("1.1"):
        ev.stopped = True
        return
    # раздвижные и гильотина (§11): параметры корня (1.9), система умеет такое изделие (7.21, 7.22)
    if sp:
        probs = sliding_problems(sliding_of(root)) if sp == "sliding" else guillotine_problems(guillotine_of(root))
        if probs:
            ev.add("1.9", "; ".join(probs))
            ev.stopped = True
            return
        if not ev.passport.get(sp):
            ok = ev.cat.systems_with(sp)
            ev.add("7.22", f"у системы {_sys(ev)} нет {'раздвижных' if sp == 'sliding' else 'гильотины'}",
                   fix="подходят: " + ", ".join(ok) if ok else "нужна раздвижная система")
            ev.stopped = True
            return
    elif ev.passport.get("sliding_only"):
        ev.add("7.21", f"система {_sys(ev)} — только раздвижные и гильотина",
               fix="сделайте эту раму такой же, как соседние, или выберите оконную систему")
    # совместимость набора фурнитуры с системой (7.2)
    fs = ev.cat.fitting_systems.get(ev.setup["fittings"])
    if not fs or ev.groove not in fs["grooves"] or ev.material not in fs["materials"]:
        ok = ev.cat.compatible_fitting_sets(ev.setup["system"])
        ev.add("7.2", f"набор «{ev.setup['fittings']}» не подходит к пазу «{ev.groove}» системы {_sys(ev)}",
               fix="подходят: " + ", ".join(ok) if ok else "для системы нет совместимой фурнитуры")
    # декор (7.10 / 7.5): ламинация по сторонам
    colors = ev.cat.system_colors(ev.setup["system"])
    mat = "alu" if ev.material.startswith("alu") else "pvc"
    for side in ("lam_out", "lam_in"):
        if not ev.setup.get(side):
            continue
        d = decor(ev.cat, ev.setup[side])
        if d.get("material") and mat not in d["material"]:
            ev.add("7.10", f"декор «{d.get('name_ru', d['id'])}» не для {'алюминия' if mat == 'alu' else 'ПВХ'}")
    if colors and ev.group not in colors:
        ev.add("7.10", f"ценовой группы «{ev.group}» нет у системы (есть: {', '.join(colors)})")
    # цвет профиля в массе (2.20)
    pc = profile_color_id(ev.setup.get("profile_color"))
    if pc != "white":
        ok = ev.cat.profile_colors_for(ev.setup["system"])
        known = ev.cat.profile_colors.get(pc)
        if not known or mat not in known.get("material", []) or pc not in ok:
            names = [ev.cat.profile_colors.get(x, {}).get("name_ru", x) for x in ok]
            ev.add("2.20", f"цвета профиля «{(known or {}).get('name_ru', ev.setup.get('profile_color'))}» нет у системы "
                           f"{_sys(ev)}", fix="есть: " + ", ".join(names) + "; или ламинация плёнкой")
    check_opening(ev, w, h)


def check_opening(ev, w: float, h: float) -> None:
    """Проём и этаж: шов (9.5), ветер (5.7), работа снаружи (9.6). У сборки — по развёртке."""
    op = ev.doc.get("opening") or {}
    if op.get("width") and op.get("height"):
        ow = min(op["width"]) if isinstance(op["width"], list) else op["width"]
        oh = min(op["height"]) if isinstance(op["height"], list) else op["height"]
        gap_min = ev.cat.rules["9.5"]["params"]["gap_mm"][0]        # шов с каждой стороны
        gap = ev.company.install_gap_mm
        if (ow - w) / 2 < gap_min or (oh - h) / 2 < gap_min:
            ev.add("9.5", f"проём {ow}×{oh}, блок {w}×{h}: шов меньше {gap_min} мм с каждой стороны",
                   fix=f"блок {ow - 2 * gap}×{oh - 2 * gap} мм")
    fl = _floor(ev)
    if fl and fl > ev.cat.rules["5.7"]["params"]["floor_gt"]:
        ev.add("5.7", f"этаж {fl}", fix="проверьте ветровую нагрузку, усиленное армирование")
    if fl and fl >= 5 and not (ev.doc.get("extras") or {}).get("outside"):
        ev.add("9.6", f"этаж {fl}", fix="добавьте работу снаружи (альпинист/вышка)")


def check_glass(ev, cg: CellGeo, g, floor_base, door: bool = False, max_m2: float | None = None,
                safety: bool = True) -> None:
    """Стекло ячейки или полотна (4.1–4.9). door — стекло в двери (4.7); max_m2 — свой предел площади
    (панорамные полотна, §11.1); safety=False — 4.7 не проверяется (гильотина: своё правило 4.23)."""
    cat, p, path = ev.cat, ev.passport, cg.path
    if isinstance(g, GlassError):
        ev.add("4.9", str(g), path, fix="пример: 4-12-4, 6t-14-4i, 4-10-4-10-4")
        return
    if not isinstance(g, Glass):
        return
    if not fits_beads(g, p):
        rng = ", ".join(f"{a}–{b}" for a, b in p.get("beads", {}).values())
        ev.add("4.6", f"стеклопакет {g.thickness_mm:g} мм не входит в систему (штапики: {rng} мм)", path,
               fix="выберите стеклопакет допустимой толщины")
    side_min = min(cg.glass_w, cg.glass_h)
    if side_min < cat.rules["4.1"]["params"]["min"]:
        ev.add("4.1", f"сторона стекла {side_min:.0f} мм", path)
    area = cg.glass_area_m2
    if area > (max_m2 or cat.rules["4.4"]["params"]["max_m2"]):
        ev.add("4.4", f"стекло {area:.2f} м²", path, fix="разделите импостом")
    thin = [x for x in g.panes if not x.tempered and not x.triplex]
    if any(x.glass_mm <= 4 for x in thin) and area > cat.rules["4.2"]["params"]["max_m2"]:
        ev.add("4.2", f"стекло 4 мм на {area:.2f} м²", path, fix="стекло 5–6 мм или деление")
    elif any(5 <= x.glass_mm <= 6 for x in thin) and area > cat.rules["4.3"]["params"]["max_m2"]:
        ev.add("4.3", f"стекло 5–6 мм на {area:.2f} м²", path)
    ratio = max(cg.glass_w, cg.glass_h) / max(1.0, min(cg.glass_w, cg.glass_h))
    if ratio > cat.rules["4.5"]["params"]["max_ratio"]:
        ev.add("4.5", f"соотношение сторон стекла {ratio:.1f}", path)
    low = floor_base is not None and floor_base + (ev.geo.h - cg.axis.y1) < cat.rules["4.7"]["params"]["below_floor_mm"]
    if safety and (low or door) and not any(x.tempered or x.triplex for x in g.panes):
        ev.add("4.7", "стекло ниже 800 мм от пола или в двери", path,
               fix="закалённое или триплекс в этой ячейке (например, 6t-12-4)")
    if g.single and ev.material in ("pvc", "alu_thermo"):
        ev.add("4.8", "одинарное стекло в тёплой системе", path)


# ---------------- после геометрии ----------------
def check_all(ev) -> None:
    geo, cat, p = ev.geo, ev.cat, ev.passport
    lim = cat.rules_meta["sash_limits"]
    weights = cat.rules_meta["weights"]
    fs = cat.fitting_systems.get(ev.setup["fittings"], {})

    # 1.5 — минимальная секция
    mn = cat.rules["1.5"]["params"]["min"]
    for path, sizes in geo.sizes.items():
        for i, s in enumerate(sizes):
            if s < mn:
                ev.add("1.5", f"часть {s:.0f} мм меньше {mn} мм", f"{path}.{i}" if path else str(i))

    # 6.1 / 6.7 — геометрия делений
    for path, node in walk_nodes(root_of(ev.doc)):
        if is_leaf(node) or "parts" not in node:
            continue
        leaves = [part.get("cell") for part in node["parts"]]
        if node.get("split") == "none":
            for a, b in zip(leaves, leaves[1:]):
                if a and b and a.get("type") in ("sash", "door_sash") and b.get("type") in ("sash", "door_sash"):
                    ev.add("6.1", "две открывающиеся створки рядом без импоста и штульпа", path,
                           fix="поставьте импост или сделайте штульповую пару")
        if node.get("split") == "vslide":                     # гильотинное окно (§11.2): два полотна сверху вниз
            ok = len(leaves) == 2 and all(c and c.get("type") == "sash" and c.get("open") == "vslide" for c in leaves)
            if not ok:
                ev.add("6.20", "в узле vslide должно быть ровно два полотна-створки с open: vslide", path,
                       fix="split {dir: vslide} на ячейке-листе")
        if node.get("split") == "shtulp":
            opens = [c.get("open") for c in leaves if c]
            if opens.count("tilt_turn") > 1:
                ev.add("6.7", "в штульповой паре откидываться может только активная створка", path,
                       fix="пассивную створку сделайте поворотной")

    cells: list[CellGeo] = geo.cells
    if ev.kind == "window" and all(c.cell.get("type") in ("fixed", "panel") for c in cells):
        ev.add("6.10", "все части глухие", fix="добавьте открывающуюся створку для проветривания")

    floor_base = 0 if ev.kind in ("door", "balcony_block") else (ev.doc.get("opening") or {}).get("floor_offset")
    for cg in cells:
        cell, path = cg.cell, cg.path
        g = ev.glass.get(path)
        check_glass(ev, cg, g, floor_base, door=cell.get("type") == "door_sash")
        if cell.get("mosquito") and cell.get("type") not in ("sash", "door_sash"):
            ev.add("9.1", "москитная сетка на глухой части", path, fix="уберите сетку или сделайте створку")
        # ---- раскладка (5.20–5.22) ----
        m = cell.get("muntins")
        if m:
            if cell.get("type") == "panel" or g is None:
                ev.add("5.21", "раскладка на глухой панели", path, fix="уберите раскладку или поставьте стекло")
            elif m.get("kind", "inner") == "inner" and m.get("pattern") != "decor" and isinstance(g, Glass):
                cham = max((sp["mm"] for sp in g.spacers), default=0)
                need = cat.rules["5.20"]["params"]["min_chamber_mm"]
                if cham < need:
                    ev.add("5.20", f"стеклопакет {g.formula}: камера {cham} мм, нужно ≥ {need} мм", path,
                           fix="накладная раскладка (overlay) или стеклопакет с рамкой 12+ мм")
            if m.get("pattern") != "decor" and not ev.has("5.21"):
                lay = muntin_layout(cg, m)
                mn = cat.rules["5.22"]["params"]["min_piece_mm"]
                if lay["min_piece"] is not None and lay["min_piece"] < mn:
                    ev.add("5.22", f"кусок прутка {lay['min_piece']:.0f} мм < {mn} мм", path,
                           fix="меньше прутков или шире ячейка")
        if not cg.opening:
            continue
        # ---- створка ----
        opening = cell.get("open", "turn")
        if "folding" in cg.sides.values():
            opening = "folding"
        hinge = cell.get("hinge", "left")
        if opening == "vslide":
            if "vslide" not in (cg.sides.get("top"), cg.sides.get("bottom")):
                ev.add("6.20", "полотно гильотинного окна вне узла vslide", path, fix="split {dir: vslide} или другое открывание")
            p23 = cat.rules["2.23"]["params"]["min_h"]
            if cg.sash.h < p23:
                ev.add("2.23", f"полотно {cg.sash.h:.0f} мм ниже {p23} мм", path, fix="выше окно или одно полотно")
            mx = cat.rules["3.23"]["params"]["max_kg"]
            if cell.get("slide", "moving") == "moving" and cg.weight_kg is not None and cg.weight_kg > mx:
                ev.add("3.23", f"подвижное полотно {cg.weight_kg:.0f} кг, балансир — до {mx} кг на пару", path,
                       fix="стекло легче, меньше полотно или верхнее глухое")
        if opening == "hs" and not p.get("hs"):
            ev.add("7.20", f"система {_sys(ev)} без подъёмно-сдвижного (HS)", path,
                   fix="PSK или раздвижная, либо система с HS (тёплый алюминий, 70-мм ПВХ)")
        mq = mosquito_type(cell)
        if mq in ("pleated", "door") and cell.get("type") != "door_sash" \
                and cg.sash.w < cat.rules["9.22"]["params"]["wide_mm"]:
            ev.add("9.22", f"сетка «{mq}» на окне {cg.sash.w:.0f} мм", path, fix="рамочная сетка или на двери / проёме от 1200 мм")
        if opening in KIT_OPENINGS:
            pass
        elif opening == "tilt" and hinge != "bottom" or opening in ("turn", "tilt_turn") and hinge in ("top", "bottom") \
                or opening == "top_hung" and hinge != "top":
            ev.add("6.3", f"открывание «{opening}» с петлями «{hinge}»", path)
        if cg.shaped:
            allowed = shaped_openings(ev, cg)
            if opening not in allowed:
                ev.add("4.20", f"«{opening}» в фигурной ячейке; можно: {', '.join(allowed)}", path,
                       fix="поворотная или откидная створка, или глухая часть")
            else:
                ev.add("4.21", "фигурная створка: спецфурнитура в спецификации", path)
        if opening == "pivot":
            p22 = cat.rules["4.22"]["params"]
            if cg.sash.w > p22["max_w"] or cg.sash.h > p22["max_h"]:
                ev.add("4.22", f"среднеподвесная створка {cg.sash.w:.0f}×{cg.sash.h:.0f} мм больше "
                               f"{p22['max_w']}×{p22['max_h']}", path, fix="разделите импостом")
        key = opening if opening in KIT_OPENINGS else "door" if cell.get("type") == "door_sash" and ev.kind == "door" else ("shtulp" if cg.sides.get("left") == "shtulp" or cg.sides.get("right") == "shtulp" else opening)
        L = lim.get(key) or lim.get(opening) or {}
        sw, sh = cg.sash.w, cg.sash.h
        maxw = L.get("w", [0, 1e9])[1]
        maxh = L.get("h", [0, 1e9])[1]
        pw = p.get("max_window_sash_mm") if cell.get("type") == "sash" else p.get("max_door_sash_mm")
        if pw and opening not in KIT_OPENINGS and (cell.get("type") == "door_sash" or opening in ("turn", "tilt_turn")):   # уровень 2: паспорт строже (не для фрамуг)
            maxw, maxh = min(maxw, pw[0]), min(maxh, pw[1])
        if L:
            if sw < L["w"][0] or sh < L["h"][0]:
                ev.add("2.1", f"створка {sw:.0f}×{sh:.0f} мм меньше {L['w'][0]}×{L['h'][0]}", path)
            area = sw * sh / 1e6
            if ev.has("4.22") and any(v.code == "4.22" and v.path == path for v in ev.violations):
                pass
            elif sw > maxw or sh > maxh or (L.get("max_m2") and area > L["max_m2"]):
                ev.add("2.2", f"створка {sw:.0f}×{sh:.0f} мм ({area:.2f} м²), предел {maxw:.0f}×{maxh:.0f}"
                              + (f", {L['max_m2']} м²" if L.get("max_m2") else ""), path, fix="разделите импостом")
            elif sw > 0.9 * maxw or sh > 0.9 * maxh:
                ev.add("2.4", f"створка {sw:.0f}×{sh:.0f} у предела {maxw:.0f}×{maxh:.0f}", path)
            if L.get("h_le_w") and sh / sw > L["h_le_w"] or L.get("w_le_h") and sw / sh > L["w_le_h"]:
                ev.add("2.3", f"пропорция створки {sw:.0f}×{sh:.0f}", path)
        if cell.get("type") == "door_sash" and ev.kind == "door" and opening not in KIT_OPENINGS:
            d1, d2 = cat.rules["8.1"]["params"], cat.rules["8.2"]["params"]
            if not d1["min"] <= sw <= d1["max"]:
                ev.add("8.1", f"ширина дверной створки {sw:.0f} мм", path)
            if not d2["min"] <= sh <= d2["max"]:
                ev.add("8.2", f"высота дверной створки {sh:.0f} мм", path)
            if "door" not in fs.get("openings", []):
                ev.add("8.6", f"набор «{ev.setup['fittings']}» — оконная фурнитура", path)
        # ---- вес ----
        if opening == "psk" and cg.weight_kg is not None and cg.weight_kg > cat.rules["3.20"]["params"]["max_kg"]:
            ev.add("3.20", f"створка PSK {cg.weight_kg:.0f} кг больше {cat.rules['3.20']['params']['max_kg']} кг", path,
                   fix="подъёмно-сдвижная (HS) или стекло легче")
        if cg.weight_kg is not None and opening not in KIT_OPENINGS:
            sel = ev.fittings.get(path)
            heavy = sel and any(pt.option_group == "hinge" and "160" in pt.code for pt in sel.parts)
            limit = (fs.get("max_sash_kg_heavy") if heavy else fs.get("max_sash_kg")) or weights["fitting_limits_kg"]["standard"]
            if cg.weight_kg > limit:
                ev.add("3.1", f"створка {cg.weight_kg:.0f} кг, предел фурнитуры {limit} кг", path,
                       fix="усиленная фурнитура, импост или стекло легче")
            elif cg.weight_kg > cat.rules["3.2"]["params"]["ratio"] * limit:
                ev.add("3.2", f"створка {cg.weight_kg:.0f} кг из {limit} кг", path)
        if sh > cat.rules["3.3"]["params"]["gt"] and opening in ("turn", "tilt_turn"):
            ev.add("3.3", f"высота створки {sh:.0f} мм — средний прижим/запор в спецификации", path)
        # ---- фурнитура ----
        sel = ev.fittings.get(path)
        if sel:
            for code, msg in sel.problems:
                if code == "info":
                    continue
                if code == "7.8" and "ножниц" in msg.lower() and opening in ("tilt", "tilt_turn"):
                    ev.add("6.6", msg, path)
                else:
                    ev.add(code, msg, path)

    # ---- расширитель на стороне со створкой (9.23) ----
    for a in ev.doc.get("addons") or []:
        if a.get("type") != "extender":
            continue
        sides = ("top", "bottom", "left", "right") if a.get("side") == "all" else (a.get("side"),)
        hit = [cg.path or "корень" for cg in cells if cg.opening and any(cg.sides.get(sd) == "frame" for sd in sides)]
        if hit:
            ev.add("9.23", f"расширитель {a.get('size_mm', '')} мм ({a.get('side')}) у створки {', '.join(hit)}",
                   fix="проверьте открывание створки над расширителем")

    # ---- армирование ПВХ ----
    if ev.material == "pvc" and p.get("reinforce") == "always":
        if geo.mullions:
            ev.add("5.1", f"импостов: {len(geo.mullions)}")
        if ev.group == "Белый":
            long_ = [x for x in geo.frame_pieces if x > cat.rules["5.2"]["params"]["gt"]]
            long_ += [m.length for m in geo.mullions if m.length > cat.rules["5.2"]["params"]["gt"]]
            for cg in cells:
                if cg.sash and cg.cell.get("open") != "vslide":     # полотно гильотинного — свой профиль vs_sash
                    long_ += [x for x in (cg.sash.w, cg.sash.h) if x > cat.rules["5.2"]["params"]["gt"]]
            if long_:
                ev.add("5.2", f"элементов длиннее 700 мм: {len(long_)}")
        else:
            ev.add("5.3", f"цвет «{ev.group}» — армируются все элементы")
        rm = [r for r in cat.reinforcement_map if r["system_code"] == ev.setup["system"] and r["is_default"] == "1"]
        if not rm or any(r["status"].startswith("ДЕМО") for r in rm):
            ev.add("5.8", "универсальный металл Akfa того же класса" if rm else "армирования нет в каталоге")
    for m in geo.mullions:
        if m.length > cat.rules["5.4"]["params"]["gt"]:
            ev.add("5.4", f"импост {m.length:.0f} мм", m.path, fix="усиленное замкнутое армирование")
