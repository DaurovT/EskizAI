"""Раздвижные системы и гильотина для террас (docs/shapes_contract.md §11.1, §11.3).

У таких изделий нет дерева ячеек: корень рамы — root.sliding или root.guillotine. Ядро раскладывает полотна
само и отдаёт их как ячейки геометрии:
  раздвижная — "<i>" слева направо, полотна равной ширины с перехлёстом по паспорту системы;
  гильотина  — "<i>.<j>": модуль i слева направо, полотно j сверху вниз (верхние глухие, moving нижних подвижные).
Это пути раскладки, не узлы дерева: команды над ячейками (split, set_cell) к ним не применяются.
Гильотинное окно (split "vslide", §11.2) — обычное дерево, оно в geometry.py / rules.py / bom.py.
"""
from __future__ import annotations

import math

from . import shapes as shp
from .geometry import CellGeo, Geometry, GeometryError, Rect
from .glass import Glass, GlassError, parse
from .model import guillotine_of, root_of, sliding_of

M = 1000.0
FRAME_SIDES = {"left": "frame", "right": "frame", "top": "frame", "bottom": "frame"}


# ---------------- геометрия ----------------
def _leaf(path: str, cell: dict, rect: Rect, face: float, bite: float, extra: dict) -> CellGeo:
    """Полотно: габарит rect, видимое стекло — внутри профиля шириной face, стекло заходит в профиль на bite."""
    light = Rect(rect.x0 + face, rect.y0 + face, rect.x1 - face, rect.y1 - face)
    if light.w <= 0 or light.h <= 0:
        raise GeometryError("1.5", f"полотно {path}: нет стекла ({rect.w:.0f}×{rect.h:.0f} мм)", path)
    cg = CellGeo(path=path, cell=cell, axis=rect, sides=dict(FRAME_SIDES), light=light, sash=rect,
                 ffb=rect.w, ffh=rect.h)
    cg.glass_w, cg.glass_h = light.w + 2 * bite, light.h + 2 * bite
    cg.glass_area_m2 = cg.glass_w * cg.glass_h / 1e6
    cg.glass_perim_mm = 2 * (cg.glass_w + cg.glass_h)
    cg.vis_poly = shp.rect_poly(light.x0, light.y0, light.x1, light.y1)[0]
    cg.extra = extra
    return cg


def build_sliding(doc: dict, passport: dict) -> Geometry:
    """Полотна: W_in = W − 2·(рама − заход полотна), ширина полотна = (W_in + (n−1)·перехлёст) / n."""
    fr = doc["frame"]
    W, H = float(fr["w"]), float(fr["h"])
    s = sliding_of(root_of(doc))
    P = passport["sliding"]
    n, rails = s["leaves"], s["rails"]
    ov = float(P["overlap_mm"] if s["overlap_mm"] in (None, "passport") else s["overlap_mm"])
    pano = s["kind"] == "panoramic"
    face = float((P.get("panoramic") or {}).get("leaf_face_mm", P["leaf_face_mm"]) if pano else P["leaf_face_mm"])
    e = float(P["frame_face_mm"] - P["leaf_into_mm"])
    lw, lh = (W - 2 * e + (n - 1) * ov) / n, H - 2 * e
    if lw <= ov or lh <= 0:
        raise GeometryError("1.5", f"раздвижная {W:g}×{H:g}: полотно {lw:.0f}×{lh:.0f} мм не помещается")
    cells = []
    for i in range(n):
        x0 = e + i * (lw - ov)
        mv = bool(s["moving"][i])
        cells.append(_leaf(str(i), {"type": "sash" if mv else "fixed", "open": "sliding"}, Rect(x0, e, x0 + lw, e + lh),
                           face, float(P["glass_bite_mm"]), {"leaf": {"index": i, "rail": i % rails, "moving": mv}}))
    geo = Geometry(W, H, cells, [], [], [W, W, H, H], {}, area_m2=W * H / 1e6, perimeter_mm=2 * (W + H))
    geo.special = {"type": "sliding", "leaves": n, "rails": rails, "overlap_mm": ov, "leaf_w": round(lw, 1),
                   "leaf_h": round(lh, 1), "kind": s["kind"], "threshold": s["threshold"],
                   "moving": [bool(x) for x in s["moving"]], "frame_face_mm": float(P["frame_face_mm"]),
                   "leaf_face_mm": face}
    return geo


def build_guillotine(doc: dict, passport: dict) -> Geometry:
    """Модули равной ширины W / modules; стойки на границах модулей (posts between); полотна с перехлёстом."""
    fr = doc["frame"]
    W, H = float(fr["w"]), float(fr["h"])
    g = guillotine_of(root_of(doc))
    G = passport["guillotine"]
    m, P, mv = g["modules"], g["panels"], g["moving"]
    post = float(G["post_mm"]) if g["posts"] == "between" else 0.0
    rail, ovl = float(G["rail_mm"]), float(G["panel_overlap_mm"])
    mw = W / m
    posts = []
    if post:
        for k in range(m + 1):
            x0 = 0.0 if k == 0 else W - post if k == m else k * mw - post / 2
            posts.append([round(x0, 1), round(x0 + post, 1)])
    ph = (H - 2 * rail + (P - 1) * ovl) / P
    if ph <= ovl:
        raise GeometryError("1.5", f"гильотина высотой {H:g} мм: полотно {ph:.0f} мм не помещается")
    cells, mods = [], []
    for i in range(m):
        cx0 = i * mw + ((post if i == 0 else post / 2) if post else 0.0)
        cx1 = (i + 1) * mw - ((post if i == m - 1 else post / 2) if post else 0.0)
        mods.append([round(cx0, 1), round(cx1, 1)])
        for j in range(P):
            y0 = rail + j * (ph - ovl)
            moving = j >= P - mv
            cells.append(_leaf(f"{i}.{j}", {"type": "sash" if moving else "fixed", "open": "guillotine"},
                               Rect(cx0, y0, cx1, y0 + ph), float(G["panel_face_mm"]), float(G["glass_bite_mm"]),
                               {"panel": {"module": i, "index": j, "moving": moving}}))
    geo = Geometry(W, H, cells, [], [], [], {}, area_m2=W * H / 1e6, perimeter_mm=2 * (W + H))
    geo.special = {"type": "guillotine", "modules": m, "panels": P, "moving": mv, "drive": g["drive"],
                   "posts": g["posts"], "glass": g["glass"], "module_w": round(mw, 1), "panel_h": round(ph, 1),
                   "post_mm": post, "rail_mm": rail, "modules_x": mods, "posts_x": posts}
    return geo


# ---------------- оценка ----------------
def evaluate_special(ev, kind: str) -> None:
    """Геометрия полотен, стекло и вес каждого полотна, проверки §11. Вызывается после rules.check_input."""
    try:
        ev.geo = build_sliding(ev.doc, ev.passport) if kind == "sliding" else build_guillotine(ev.doc, ev.passport)
    except GeometryError as e:
        ev.add(e.code, e.msg, e.path)
        ev.stopped = True
        return
    spec = ev.geo.special["glass"] if kind == "guillotine" else ev.setup["glass"]
    try:
        g = parse(spec, ev.cat)
    except GlassError as e:
        g = e
    if kind == "sliding":
        P = ev.passport["sliding"]
        kg_m = (P.get("panoramic") or {}).get("sash_kg_m", P["sash_kg_m"]) if ev.geo.special["kind"] == "panoramic" \
            else P["sash_kg_m"]
    else:
        kg_m = ev.passport["guillotine"]["panel_kg_m"]
    for cg in ev.geo.cells:
        ev.glass[cg.path] = g
        if isinstance(g, Glass):
            cg.weight_kg = round(cg.glass_area_m2 * g.weight_kg_m2 + 2 * (cg.sash.w + cg.sash.h) / M * kg_m, 1)
    check_special(ev)


def check_special(ev) -> None:
    from .rules import check_glass
    geo, cat = ev.geo, ev.cat
    sp = geo.special
    if sp["type"] == "sliding":
        P = ev.passport["sliding"]
        kind = sp["kind"]
        door = kind in ("door", "panoramic")
        lim = P["leaf_mm"].get(kind) or P["leaf_mm"]["window"]
        cap = (P.get("carriage_kg") or {}).get(kind, 150)
        max_m2 = (P.get("panoramic") or {}).get("max_glass_m2") if kind == "panoramic" else None
        floor_base = 0 if door else (ev.doc.get("opening") or {}).get("floor_offset")
        for cg in geo.cells:
            check_glass(ev, cg, ev.glass.get(cg.path), floor_base, door=door, max_m2=max_m2)
            w, h = cg.sash.w, cg.sash.h
            if not (lim["w"][0] <= w <= lim["w"][1] and lim["h"][0] <= h <= lim["h"][1]):
                ev.add("2.21", f"полотно {w:.0f}×{h:.0f} мм, паспорт ({kind}): {lim['w'][0]}–{lim['w'][1]} × "
                               f"{lim['h'][0]}–{lim['h'][1]} мм", cg.path,
                       fix="больше или меньше полотен" if w > lim["w"][1] or w < lim["w"][0] else "другая высота блока")
            if cg.extra["leaf"]["moving"] and cg.weight_kg is not None and cg.weight_kg > cap:
                ev.add("3.21", f"полотно {cg.weight_kg:.0f} кг, каретка — до {cap} кг на пару", cg.path,
                       fix="больше полотен, стекло легче" + ("" if kind == "panoramic" else " или панорамная система"))
        if door and sp["threshold"] == "standard":
            ev.add("8.20", "раздвижная дверь с обычным порогом", fix="низкий (low) или в уровень пола (flush)")
        if kind == "window" and not any(sp["moving"]):
            ev.add("6.10", "все полотна глухие", fix="сделайте полотно подвижным")
        return
    # гильотина
    G = ev.passport["guillotine"]
    mx_w, mx_h = G.get("module_max_mm") or [cat.rules["2.22"]["params"]["max_w"], cat.rules["2.22"]["params"]["max_h"]]
    if sp["module_w"] > mx_w or geo.h > mx_h:
        ev.add("2.22", f"модуль {sp['module_w']:.0f}×{geo.h:.0f} мм, предел {mx_w}×{mx_h}",
               fix=f"модулей: {math.ceil(geo.w / mx_w)} и больше" if sp["module_w"] > mx_w else "ниже высота")
    g = ev.glass.get(geo.cells[0].path) if geo.cells else None
    if isinstance(g, Glass) and not all(p.tempered for p in g.panes):
        ev.add("4.23", f"стекло {g.formula} не закалённое", fix="g8t, g10t или g4t_14_4t")
    for cg in geo.cells:
        check_glass(ev, cg, ev.glass.get(cg.path), None, safety=False)
    if sp["drive"] == "manual":
        lim = cat.rules["3.22"]["params"]["max_kg"]
        for i in range(sp["modules"]):
            kg = sum(c.weight_kg or 0 for c in geo.cells if c.extra["panel"]["module"] == i and c.extra["panel"]["moving"])
            if kg > lim:
                ev.add("3.22", f"модуль {i + 1}: подвижные полотна {kg:.0f} кг, вручную — до {lim} кг", str(i),
                       fix="электропривод (drive: electric) или пульт (remote)")


# ---------------- спецификация ----------------
def _split(pieces: list, bar: float) -> list:
    """Отрезок длиннее хлыста — из равных частей (раскрой не принимает отрезок длиннее хлыста)."""
    out = []
    for L in pieces:
        n = max(1, math.ceil(L / (bar - 50)))
        out += [round(L / n, 1)] * n
    return out


def special_bom(ev) -> list:
    """Строки раздвижной / гильотины (роли §11 — ДЕМО-цены в demo_roles.csv)."""
    from . import bom as B
    geo, p = ev.geo, ev.passport
    sp = geo.special
    W, H = geo.w, geo.h
    bar = p.get("bar_mm", 6000)
    lines = []

    def role(kind, code, qty, unit, name, pieces=None, **kw):
        ln = B._role_line(ev, kind, code, qty, unit, name, **kw)
        if pieces:
            ln.pieces = _split(pieces, bar)
        lines.append(ln)
        return ln

    cells = geo.cells
    moving = [c for c in cells if c.cell.get("type") == "sash"]
    perims = [2 * (c.sash.w + c.sash.h) for c in cells]
    if sp["type"] == "sliding":
        v = "panoramic" if sp["kind"] == "panoramic" else ""
        n, rails = sp["leaves"], sp["rails"]
        role("profile", "sl_frame", 2 * (W + H) / M, "m", "Рама раздвижной системы", [W, W, H, H], variant=v)
        role("profile", "sl_rail", rails * W / M, "m", f"Направляющая ({rails} шт)", [W] * rails)
        for c in cells:
            role("profile", "sl_sash", 2 * (c.sash.w + c.sash.h) / M, "m",
                 "Полотно " + ("подвижное" if c.cell["type"] == "sash" else "глухое"),
                 [c.sash.w, c.sash.w, c.sash.h, c.sash.h], variant=v, path=c.path)
        if n > 1:
            role("profile", "sl_interlock", (n - 1) * sp["leaf_h"] / M, "m", "Замковый профиль (стык полотен)",
                 [sp["leaf_h"]] * (n - 1), variant=v, note=f"{n - 1} × {sp['leaf_h']:.0f} мм")
        if moving:
            role("fitting", "sl_roller", 2 * len(moving), "pcs", "Каретка полотна", variant=v,
                 note=f"2 шт × {len(moving)} подвижн.")
            role("fitting", "sl_lock", len(moving), "pcs", "Замок с ручкой полотна")
        role("seal", "sl_brush", sum(perims) / M, "m", "Щёточный уплотнитель")
        if sp["threshold"] in ("low", "flush"):
            role("profile", "sl_threshold_low", W / M, "m",
                 "Порог низкий" if sp["threshold"] == "low" else "Порог в уровень пола", [W])
    else:
        m = sp["modules"]
        n_posts = len(sp["posts_x"])
        if n_posts:
            role("profile", "gl_post", n_posts * H / M, "m", f"Стойка ({n_posts} шт)", [H] * n_posts)
        mws = [x1 - x0 for x0, x1 in sp["modules_x"]]
        role("profile", "gl_rail", 2 * sum(mws) / M, "m", "Профиль верха и низа модулей", [w for w in mws for _ in (0, 1)])
        for c in cells:
            role("profile", "gl_panel", 2 * (c.sash.w + c.sash.h) / M, "m",
                 "Полотно " + ("подвижное" if c.cell["type"] == "sash" else "верхнее глухое"),
                 [c.sash.w, c.sash.w, c.sash.h, c.sash.h], path=c.path)
        if sp["drive"] in ("electric", "remote"):
            role("fitting", "gl_motor", m, "pcs", "Электропривод модуля")
        if sp["drive"] == "remote":
            role("fitting", "gl_remote", 1, "pcs", "Пульт")
        role("fitting", "gl_belt", m, "pcs", "Ремень / цепь подъёма (комплект на модуль)")
        role("seal", "gl_seal", sum(perims) / M, "m", "Уплотнитель полотен")
    glass_seal = 0.0
    for c in cells:
        g = ev.glass.get(c.path)
        if isinstance(g, Glass):
            lines.append(B._glass_line(ev, c, g))
            glass_seal += c.glass_perim_mm / M * 2
    if glass_seal:
        lines.append(B._seal_line(ev, "Уплотнитель стекла", "Rezina EPDM Steklo (6kg)", glass_seal))
    lines += B._addon_lines(ev, W, H)
    lines += B._color_lines(ev, lines)
    lines += B._extras_lines(ev, W, H, geo.area_m2, geo.perimeter_mm / M)
    return lines


def summary(geo: Geometry) -> dict:
    """Параметры для ответа API (geometry.sliding / geometry.guillotine)."""
    sp = dict(geo.special)
    return {k: v for k, v in sp.items() if k != "type"}
