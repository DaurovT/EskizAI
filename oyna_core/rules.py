"""Проверки уровня 1 (rules_level1.json) + пределы паспорта системы (уровень 2, где он есть).

Каждая проверка добавляет нарушение через ev.add(code, msg, path, fix): реакция и название — из данных.
Правила, которым не хватает данных о проёме (6.4, 6.5, 6.9 и т. п.), срабатывают, только если данные есть.
"""
from __future__ import annotations

from .geometry import CellGeo
from .glass import Glass, GlassError, fits_beads
from .model import decor, is_leaf, root_of, walk_nodes


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
    if not (p12["min"] <= w <= p12["max"] and p12["min"] <= h <= p12["max"]):
        ev.add("1.2", f"{w}×{h} мм: сторона блока должна быть {p12['min']}–{p12['max']} мм",
               fix="проверьте единицы и нули; большие проёмы делите на блоки")
        if w < ev.cat.rules["1.7"]["params"]["both_lt"] and h < ev.cat.rules["1.7"]["params"]["both_lt"]:
            ev.add("1.7", f"{w}×{h} — похоже, введено в сантиметрах", fix=f"имелось в виду {w * 10}×{h * 10} мм?")
        ev.stopped = True
        return
    if w > ev.cat.rules["1.3"]["params"]["gt"] or h > ev.cat.rules["1.3"]["params"]["gt"]:
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
    # совместимость набора фурнитуры с системой (7.2)
    fs = ev.cat.fitting_systems.get(ev.setup["fittings"])
    if not fs or ev.groove not in fs["grooves"] or ev.material not in fs["materials"]:
        ok = ev.cat.compatible_fitting_sets(ev.setup["system"])
        ev.add("7.2", f"набор «{ev.setup['fittings']}» не подходит к пазу «{ev.groove}» системы {ev.setup['system']}",
               fix="подходят: " + ", ".join(ok) if ok else "для системы нет совместимой фурнитуры")
    # декор (7.10 / 7.5)
    colors = ev.cat.system_colors(ev.setup["system"])
    mat = "alu" if ev.material.startswith("alu") else "pvc"
    for side in ("color_out", "color_in"):
        d = decor(ev.cat, ev.setup[side])
        if d.get("material") and mat not in d["material"]:
            ev.add("7.10", f"декор «{d.get('name_ru', d['id'])}» не для {'алюминия' if mat == 'alu' else 'ПВХ'}")
    if colors and ev.group not in colors:
        ev.add("7.10", f"ценовой группы «{ev.group}» нет у системы (есть: {', '.join(colors)})")
    # проём и этаж
    op = ev.doc.get("opening") or {}
    if op.get("width") and op.get("height"):
        ow = min(op["width"]) if isinstance(op["width"], list) else op["width"]
        oh = min(op["height"]) if isinstance(op["height"], list) else op["height"]
        gap_min = ev.cat.rules["9.5"]["params"]["gap_mm"][0]
        if ow - w < gap_min or oh - h < gap_min:
            ev.add("9.5", f"проём {ow}×{oh}, блок {w}×{h}: зазор меньше {gap_min} мм",
                   fix=f"блок {ow - ev.company.install_gap_mm}×{oh - ev.company.install_gap_mm} мм")
    fl = _floor(ev)
    if fl and fl > ev.cat.rules["5.7"]["params"]["floor_gt"]:
        ev.add("5.7", f"этаж {fl}", fix="проверьте ветровую нагрузку, усиленное армирование")
    if fl and fl >= 5 and not (ev.doc.get("extras") or {}).get("outside"):
        ev.add("9.6", f"этаж {fl}", fix="добавьте работу снаружи (альпинист/вышка)")


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
        # ---- стекло ----
        if isinstance(g, GlassError):
            ev.add("4.9", str(g), path, fix="пример: 4-12-4, 6t-14-4i, 4-10-4-10-4")
        elif isinstance(g, Glass):
            if not fits_beads(g, p):
                rng = ", ".join(f"{a}–{b}" for a, b in p.get("beads", {}).values())
                ev.add("4.6", f"стеклопакет {g.thickness_mm:g} мм не входит в систему (штапики: {rng} мм)", path,
                       fix="выберите стеклопакет допустимой толщины")
            side_min = min(cg.glass_w, cg.glass_h)
            if side_min < cat.rules["4.1"]["params"]["min"]:
                ev.add("4.1", f"сторона стекла {side_min:.0f} мм", path)
            area = cg.glass_w * cg.glass_h / 1e6
            if area > cat.rules["4.4"]["params"]["max_m2"]:
                ev.add("4.4", f"стекло {area:.2f} м²", path, fix="разделите импостом")
            thin = [x for x in g.panes if not x.tempered and not x.triplex]
            if any(x.glass_mm <= 4 for x in thin) and area > cat.rules["4.2"]["params"]["max_m2"]:
                ev.add("4.2", f"стекло 4 мм на {area:.2f} м²", path, fix="стекло 5–6 мм или деление")
            elif any(5 <= x.glass_mm <= 6 for x in thin) and area > cat.rules["4.3"]["params"]["max_m2"]:
                ev.add("4.3", f"стекло 5–6 мм на {area:.2f} м²", path)
            ratio = max(cg.glass_w, cg.glass_h) / max(1.0, min(cg.glass_w, cg.glass_h))
            if ratio > cat.rules["4.5"]["params"]["max_ratio"]:
                ev.add("4.5", f"соотношение сторон стекла {ratio:.1f}", path)
            low = floor_base is not None and floor_base + (geo.h - cg.axis.y1) < cat.rules["4.7"]["params"]["below_floor_mm"]
            if (low or cell.get("type") == "door_sash") and not any(x.tempered or x.triplex for x in g.panes):
                ev.add("4.7", "стекло ниже 800 мм от пола или в двери", path,
                       fix="закалённое или триплекс в этой ячейке (например, 6t-12-4)")
            if g.single and ev.material in ("pvc", "alu_thermo"):
                ev.add("4.8", "одинарное стекло в тёплой системе", path)
        if cell.get("mosquito") and cell.get("type") not in ("sash", "door_sash"):
            ev.add("9.1", "москитная сетка на глухой части", path, fix="уберите сетку или сделайте створку")
        if not cg.opening:
            continue
        # ---- створка ----
        opening = cell.get("open", "turn")
        hinge = cell.get("hinge", "left")
        if opening == "tilt" and hinge != "bottom" or opening in ("turn", "tilt_turn") and hinge in ("top", "bottom"):
            ev.add("6.3", f"открывание «{opening}» с петлями «{hinge}»", path)
        key = "door" if cell.get("type") == "door_sash" and ev.kind == "door" else ("shtulp" if cg.sides.get("left") == "shtulp" or cg.sides.get("right") == "shtulp" else opening)
        L = lim.get(key) or lim.get(opening) or {}
        sw, sh = cg.sash.w, cg.sash.h
        maxw = L.get("w", [0, 1e9])[1]
        maxh = L.get("h", [0, 1e9])[1]
        pw = p.get("max_window_sash_mm") if cell.get("type") == "sash" else p.get("max_door_sash_mm")
        if pw and (cell.get("type") == "door_sash" or opening in ("turn", "tilt_turn")):   # уровень 2: паспорт строже (не для фрамуг)
            maxw, maxh = min(maxw, pw[0]), min(maxh, pw[1])
        if L:
            if sw < L["w"][0] or sh < L["h"][0]:
                ev.add("2.1", f"створка {sw:.0f}×{sh:.0f} мм меньше {L['w'][0]}×{L['h'][0]}", path)
            area = sw * sh / 1e6
            if sw > maxw or sh > maxh or (L.get("max_m2") and area > L["max_m2"]):
                ev.add("2.2", f"створка {sw:.0f}×{sh:.0f} мм ({area:.2f} м²), предел {maxw:.0f}×{maxh:.0f}"
                              + (f", {L['max_m2']} м²" if L.get("max_m2") else ""), path, fix="разделите импостом")
            elif sw > 0.9 * maxw or sh > 0.9 * maxh:
                ev.add("2.4", f"створка {sw:.0f}×{sh:.0f} у предела {maxw:.0f}×{maxh:.0f}", path)
            if L.get("h_le_w") and sh / sw > L["h_le_w"] or L.get("w_le_h") and sw / sh > L["w_le_h"]:
                ev.add("2.3", f"пропорция створки {sw:.0f}×{sh:.0f}", path)
        if cell.get("type") == "door_sash" and ev.kind == "door":
            d1, d2 = cat.rules["8.1"]["params"], cat.rules["8.2"]["params"]
            if not d1["min"] <= sw <= d1["max"]:
                ev.add("8.1", f"ширина дверной створки {sw:.0f} мм", path)
            if not d2["min"] <= sh <= d2["max"]:
                ev.add("8.2", f"высота дверной створки {sh:.0f} мм", path)
            if "door" not in fs.get("openings", []):
                ev.add("8.6", f"набор «{ev.setup['fittings']}» — оконная фурнитура", path)
        # ---- вес ----
        if cg.weight_kg is not None:
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

    # ---- армирование ПВХ ----
    if ev.material == "pvc" and p.get("reinforce") == "always":
        if geo.mullions:
            ev.add("5.1", f"импостов: {len(geo.mullions)}")
        if ev.group == "Белый":
            long_ = [x for x in geo.frame_pieces if x > cat.rules["5.2"]["params"]["gt"]]
            long_ += [m.length for m in geo.mullions if m.length > cat.rules["5.2"]["params"]["gt"]]
            for cg in cells:
                if cg.sash:
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
