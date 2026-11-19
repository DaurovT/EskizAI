"""SVG-схема изделия (FR-E1, FR-E6): вид изнутри или снаружи, знаки открывания, размеры, подсветка нарушений.

Знак открывания — как в ГОСТ: вершина треугольника смотрит на сторону петель; подвесное — вершиной вверх,
среднеподвесное — ромб пунктиром (shapes_contract.md §3). Фигурные рамы — по контуру, раскладка — прутками,
сборка — рамы в ряд (развёртка) с отметкой угла стыка.
Подсветка: красный — block/lock, жёлтый — warn (не принятое), по пути ячейки.
"""
from __future__ import annotations

from html import escape

from .data import Catalog, Company
from .evaluate import evaluate
from .model import side_hex

RED, YELLOW, INK, GLASS, PANEL, DIM = "#D93025", "#F2B705", "#2B2B2B", "#DCEBF5", "#D9D9D9", "#6B6B6B"
MUNTIN = {"white": "#FFFFFF", "gold": "#C9A44C"}
GAP = 60                                          # мм между рамами сборки на схеме


def _severity(ev) -> dict:
    sev = {}
    for v in ev.violations:
        if v.accepted:
            continue
        cur = sev.get(v.path)
        if v.severity in ("block", "lock") or cur is None and v.severity == "warn":
            sev[v.path] = v.severity
    return sev


def render_svg(doc: dict, cat: Catalog, company: Company | None = None, view: str = "inside",
               max_px: int = 560, dims: bool = True, highlight: bool = True) -> str:
    """highlight=False — без подсветки нарушений (КП и документы для клиента)."""
    ev = evaluate(doc, cat, company)
    fr = doc.get("frame", {})
    frames = [(p, x) for p, x in zip(ev.parts, ev.offsets)] if ev.parts else [(ev, 0.0)]
    if any(p.geo is None for p, _ in frames):
        w, h = 400, 120
        msg = "; ".join(f"{v.code}: {v.msg or v.title}" for v in ev.blocking)[:120] or "схема недоступна"
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
                f'<rect width="{w}" height="{h}" fill="#fff" stroke="{RED}"/><text x="12" y="64" font-family="sans-serif" '
                f'font-size="13" fill="{RED}">{escape(msg)}</text></svg>')
    # развёртка: рамы в ряд с зазором под отметку стыка
    placed, x = [], 0.0
    for i, (p, _) in enumerate(frames):
        placed.append((p, x, f"A{i}/" if ev.parts else ""))
        x += p.geo.w + (GAP if ev.parts else 0)
    W = x - (GAP if ev.parts else 0)
    H = max(p.geo.h for p, _, _ in placed)
    pad = 46 if dims else 8
    k = (max_px - 2 * pad) / max(W, H)
    mirror = view == "outside"
    X = (lambda x: pad + (W - x) * k) if mirror else (lambda x: pad + x * k)
    Y = lambda y: pad + y * k
    sev = _severity(ev) if highlight else {}
    profile = side_hex(cat, ev.setup, "in" if view == "inside" else "out") or "#F4F4F2"
    mcolor = MUNTIN.get("white")
    out = []
    a = out.append

    def rect(x0, y0, x1, y1, fill, stroke=INK, sw=1.2, extra=""):
        xa, xb = sorted((X(x0), X(x1)))
        a(f'<rect x="{xa:.1f}" y="{Y(y0):.1f}" width="{xb - xa:.1f}" height="{Y(y1) - Y(y0):.1f}" '
          f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>')

    def poly(pts, fill, stroke=INK, sw=1.2, dash=""):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        a('<polygon points="' + " ".join(f"{X(px):.1f},{Y(py):.1f}" for px, py in pts) +
          f'" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def pline(pts, stroke=INK, sw=1.0, dash=""):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        a('<polyline points="' + " ".join(f"{X(px):.1f},{Y(py):.1f}" for px, py in pts) +
          f'" fill="none" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def line(x0, y0, x1, y1, stroke=INK, sw=1.0, dash=""):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        a(f'<line x1="{X(x0):.1f}" y1="{Y(y0):.1f}" x2="{X(x1):.1f}" y2="{Y(y1):.1f}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def text(x, y, s, size=11, fill=DIM, anchor="middle"):
        a(f'<text x="{X(x):.1f}" y="{Y(y):.1f}" text-anchor="{anchor}" font-family="sans-serif" font-size="{size}" '
          f'fill="{fill}">{escape(s)}</text>')

    def draw_frame(sub, ox: float, pre: str):
        from .rules import muntin_layout
        geo, p = sub.geo, sub.passport
        sh = lambda pts: [(px + ox, py) for px, py in pts]
        if geo.contour:
            poly(sh(geo.contour), profile, sw=1.6)
        else:
            rect(ox, 0, ox + geo.w, geo.h, profile, sw=1.6)
        for m in geo.mullions:
            half = p["bi"] / 2
            if m.orient == "v":
                rect(ox + m.at - half, m.c0, ox + m.at + half, m.c1, profile)
            else:
                rect(ox + m.c0, m.at - half, ox + m.c1, m.at + half, profile)
        for cg in geo.cells:
            c, L = cg.cell, cg.light
            g = sub.glass.get(cg.path)
            fill = PANEL if c.get("type") == "panel" or g is None else GLASS
            hl = sev.get(pre + cg.path)
            stroke = RED if hl in ("block", "lock") else YELLOW if hl == "warn" else INK
            if cg.sash:
                S = cg.sash
                if cg.sash_poly:
                    poly(sh(cg.sash_poly), profile)
                else:
                    rect(ox + S.x0, S.y0, ox + S.x1, S.y1, profile)
            vis = cg.vis_poly
            gx0, gy0, gx1, gy1 = min(q[0] for q in vis), min(q[1] for q in vis), max(q[0] for q in vis), max(q[1] for q in vis)
            gx0, gx1 = gx0 + ox, gx1 + ox
            if cg.shaped:
                poly(sh(vis), fill, stroke=stroke, sw=2.4 if hl else 0.8)
            else:
                rect(gx0, gy0, gx1, gy1, fill, stroke=stroke, sw=2.4 if hl else 0.8)
            m = c.get("muntins")
            if m and m.get("pattern") != "decor" and c.get("type") != "panel":
                col = profile if m.get("color") == "decor" else MUNTIN.get(m.get("color", "white"), mcolor)
                wpx = max(1.5, float(m.get("width_mm", 18)) * k)
                for bar in muntin_layout(cg, m)["bars"]:
                    pline(sh(bar), "#9A9A9A", wpx + 1.2)
                    pline(sh(bar), col, wpx)
            elif m and m.get("pattern") == "decor":
                cx, cy = (gx0 + gx1) / 2, (gy0 + gy1) / 2
                rx, ry = (gx1 - gx0) / 4, (gy1 - gy0) / 4
                pline([(cx - rx, cy), (cx, cy - ry), (cx + rx, cy), (cx, cy + ry), (cx - rx, cy)], DIM, 1.2)
                text(cx, cy + 4, "декор", 10)
            if (c.get("fill") or {}).get("decor"):
                text(gx0 + 30, gy0 + 40, {"matte": "мат", "tinted": "тон", "mirror": "зерк", "pattern": "узор",
                                          "stained": "витраж"}.get(c["fill"]["decor"], ""), 10, anchor="start")
            if cg.sash:
                op, hinge = c.get("open", "turn"), c.get("hinge", "left")
                mx, my = (gx0 + gx1) / 2, (gy0 + gy1) / 2
                if op in ("turn", "tilt_turn", "folding") and hinge in ("left", "right"):
                    hx = gx0 if hinge == "left" else gx1
                    ox_ = gx1 if hinge == "left" else gx0
                    line(ox_, gy0, hx, my); line(ox_, gy1, hx, my)
                    if c.get("handle", True):
                        rect(ox_ - 6 if hinge == "left" else ox_, my - 40, ox_ if hinge == "left" else ox_ + 6, my + 40, INK, sw=0)
                if op in ("tilt", "tilt_turn"):
                    dash = "6 4" if op == "tilt_turn" else ""
                    line(gx0, gy0, mx, gy1, dash=dash); line(gx1, gy0, mx, gy1, dash=dash)
                if op == "top_hung":                       # подвесное: вершиной вверх
                    line(gx0, gy1, mx, gy0); line(gx1, gy1, mx, gy0)
                if op == "pivot":                          # среднеподвесное: ромб пунктиром
                    pline([(mx, gy0), (gx1, my), (mx, gy1), (gx0, my), (mx, gy0)], dash="6 4")
                if c.get("open_dir") == "out":
                    text(mx, gy0 + 18 / k, "наружу", 10)
                if op in ("sliding", "psk", "hs"):
                    line(gx0 + 20, my, gx1 - 20, my); line(gx1 - 60, my - 30, gx1 - 20, my); line(gx1 - 60, my + 30, gx1 - 20, my)
                if c.get("mosquito"):
                    a(f'<text x="{min(X(gx0), X(gx1)) + 6:.1f}" y="{Y(gy1) - 6:.1f}" font-family="sans-serif" font-size="10" fill="{DIM}">сетка</text>')
            if c.get("type") == "fixed":
                text((gx0 + gx1) / 2, (gy0 + gy1) / 2 + 4 / k, "Г")

    from .model import addon_ext
    ext = addon_ext(ev.doc)
    for sd, size in ext.items():                         # расширители и подставочный профиль (§9.3)
        if not size:
            continue
        x0, y0, x1, y1 = {"top": (0, -size, W, 0), "bottom": (0, H, W, H + size),
                          "left": (-size, 0, 0, H), "right": (W, 0, W + size, H)}[sd]
        rect(x0, y0, x1, y1, profile, DIM, 0.8)
    if ev.doc.get("shutter"):                            # короб рольставни сверху (§9.4)
        bh = min(150.0, 26 / k)
        rect(0, -bh - ext["top"], W, -ext["top"], "#C8C8C8", DIM, 0.8)
        text(W / 2, -ext["top"] - bh / 2 + 4 / k, "рольставня" if ev.doc["shutter"].get("type") != "blinds" else "жалюзи", 9, INK)
    for sub, ox, pre in placed:
        draw_frame(sub, ox, pre)
    if ev.doc.get("grille"):
        for i in range(1, 8):
            line(W * i / 8, 0, W * i / 8, H, "#555", 0.8, dash="2 3")
    for j in ev.joints:                                  # отметка стыка между рамами
        jx = placed[j["index"] + 1][1] - GAP / 2 if j["index"] + 1 < len(placed) else W
        line(jx, 0, jx, H, DIM, 1.0, dash="4 3")
        label = {"straight": "180°", "post": "стойка"}.get(j["joint"], f"{j['angle']:g}°" if j.get("angle") else "?")
        text(jx, -6 / k, label, 11, INK if not j["role"] else DIM)
    if dims:                                             # размерные цепочки
        def hdim(x0, x1, y, label):
            line(x0, y, x1, y, DIM, 0.8); line(x0, y - 4 / k, x0, y + 4 / k, DIM); line(x1, y - 4 / k, x1, y + 4 / k, DIM)
            a(f'<text x="{(X(x0) + X(x1)) / 2:.1f}" y="{Y(y) - 4:.1f}" text-anchor="middle" font-family="sans-serif" '
              f'font-size="11" fill="{INK}">{label}</text>')

        def vdim(y0, y1, x, label):
            line(x, y0, x, y1, DIM, 0.8)
            tx, ty = X(x) + (12 if not mirror else -12), (Y(y0) + Y(y1)) / 2
            a(f'<text x="{tx:.1f}" y="{ty:.1f}" font-family="sans-serif" font-size="11" fill="{INK}" '
              f'transform="rotate(-90 {tx:.1f} {ty:.1f})" text-anchor="middle">{label}</text>')
        if ev.parts:
            for sub, ox, _ in placed:
                hdim(ox, ox + sub.geo.w, H + 30 / k, f"{sub.geo.w:g}")
            vdim(0, H, W + 22 / k, f"{H:g}")
        else:
            geo = ev.geo
            hdim(0, W, H + 30 / k, f"{W:g}")
            vdim(0, H, W + 22 / k, f"{H:g}")
            sz = geo.sizes.get("")
            root = ev.doc["frame"]["root"]
            if sz and root.get("split") in ("v", "shtulp", "none"):
                x = 0
                for s in sz:
                    hdim(x, x + s, -14 / k, f"{s:.0f}"); x += s
            elif sz and root.get("split") == "h":
                y = 0
                for s in sz:
                    vdim(y, y + s, -30 / k, f"{s:.0f}"); y += s
    total_w = int(2 * pad + W * k)
    total_h = int(2 * pad + H * k)
    title = escape(f"{doc.get('room', '')} {fr.get('w')}×{fr.get('h')} — вид {'изнутри' if view == 'inside' else 'снаружи'}".strip())
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w}" height="{total_h}" '
            f'viewBox="0 0 {total_w} {total_h}"><title>{title}</title><rect width="100%" height="100%" fill="#fff"/>'
            + "".join(out) + "</svg>")
