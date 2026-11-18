"""SVG-схема изделия (FR-E1, FR-E6): вид изнутри или снаружи, знаки открывания, размеры, подсветка нарушений.

Знак открывания — как в ГОСТ: вершина треугольника смотрит на сторону петель.
Подсветка: красный — block/lock, жёлтый — warn (не принятое), по пути ячейки.
"""
from __future__ import annotations

from html import escape

from .data import Catalog, Company
from .evaluate import evaluate
from .model import decor

RED, YELLOW, INK, GLASS, PANEL, DIM = "#D93025", "#F2B705", "#2B2B2B", "#DCEBF5", "#D9D9D9", "#6B6B6B"


def render_svg(doc: dict, cat: Catalog, company: Company | None = None, view: str = "inside",
               max_px: int = 560, dims: bool = True) -> str:
    ev = evaluate(doc, cat, company)
    fr = doc.get("frame", {})
    if not ev.geo:
        w, h = 400, 120
        msg = "; ".join(f"{v.code}: {v.msg or v.title}" for v in ev.blocking)[:120] or "схема недоступна"
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
                f'<rect width="{w}" height="{h}" fill="#fff" stroke="{RED}"/><text x="12" y="64" font-family="sans-serif" '
                f'font-size="13" fill="{RED}">{escape(msg)}</text></svg>')
    geo, p = ev.geo, ev.passport
    W, H = geo.w, geo.h
    pad = 46 if dims else 8
    k = (max_px - 2 * pad) / max(W, H)
    mirror = view == "outside"
    X = (lambda x: pad + (W - x) * k) if mirror else (lambda x: pad + x * k)
    Y = lambda y: pad + y * k
    sev = {}
    for v in ev.violations:
        if v.accepted:
            continue
        cur = sev.get(v.path)
        if v.severity in ("block", "lock") or cur is None and v.severity == "warn":
            sev[v.path] = v.severity
    profile = decor(cat, ev.setup["color_in" if view == "inside" else "color_out"]).get("hex") or "#F4F4F2"
    out = []
    a = out.append

    def rect(x0, y0, x1, y1, fill, stroke=INK, sw=1.2, extra=""):
        xa, xb = sorted((X(x0), X(x1)))
        a(f'<rect x="{xa:.1f}" y="{Y(y0):.1f}" width="{xb - xa:.1f}" height="{Y(y1) - Y(y0):.1f}" '
          f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>')

    def line(x0, y0, x1, y1, stroke=INK, sw=1.0, dash=""):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        a(f'<line x1="{X(x0):.1f}" y1="{Y(y0):.1f}" x2="{X(x1):.1f}" y2="{Y(y1):.1f}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    rect(0, 0, W, H, profile, sw=1.6)                                   # рама
    for m in geo.mullions:                                              # импосты
        half = p["bi"] / 2
        if m.orient == "v":
            rect(m.at - half, m.c0, m.at + half, m.c1, profile)
        else:
            rect(m.c0, m.at - half, m.c1, m.at + half, profile)
    for cg in geo.cells:
        c, L = cg.cell, cg.light
        g = ev.glass.get(cg.path)
        fill = PANEL if c.get("type") == "panel" or g is None else GLASS
        hl = sev.get(cg.path)
        if cg.sash:
            S = cg.sash
            rect(S.x0, S.y0, S.x1, S.y1, profile)
            gx0, gy0, gx1, gy1 = S.x0 + p["bs"], S.y0 + p["bs"], S.x1 - p["bs"], S.y1 - p["bs"]
        else:
            gx0, gy0, gx1, gy1 = L.x0, L.y0, L.x1, L.y1
        stroke = RED if hl in ("block", "lock") else YELLOW if hl == "warn" else INK
        rect(gx0, gy0, gx1, gy1, fill, stroke=stroke, sw=2.4 if hl else 0.8)
        if cg.sash:
            op, hinge = c.get("open", "turn"), c.get("hinge", "left")
            mx, my = (gx0 + gx1) / 2, (gy0 + gy1) / 2
            if op in ("turn", "tilt_turn") and hinge in ("left", "right"):
                hx = gx0 if hinge == "left" else gx1
                ox = gx1 if hinge == "left" else gx0
                line(ox, gy0, hx, my); line(ox, gy1, hx, my)
                if c.get("handle", True):
                    hy = my
                    rect(ox - 6 if hinge == "left" else ox, hy - 40, ox if hinge == "left" else ox + 6, hy + 40, INK, sw=0)
            if op in ("tilt", "tilt_turn"):
                line(gx0, gy0, mx, gy1, dash="6 4" if op == "tilt_turn" else ""); line(gx1, gy0, mx, gy1, dash="6 4" if op == "tilt_turn" else "")
            if op == "sliding":
                line(gx0 + 20, my, gx1 - 20, my); line(gx1 - 60, my - 30, gx1 - 20, my); line(gx1 - 60, my + 30, gx1 - 20, my)
            if c.get("mosquito"):
                a(f'<text x="{min(X(gx0), X(gx1)) + 6:.1f}" y="{Y(gy1) - 6:.1f}" font-family="sans-serif" font-size="10" fill="{DIM}">сетка</text>')
        if c.get("type") == "fixed":
            a(f'<text x="{(X(gx0) + X(gx1)) / 2:.1f}" y="{(Y(gy0) + Y(gy1)) / 2 + 4:.1f}" text-anchor="middle" '
              f'font-family="sans-serif" font-size="11" fill="{DIM}">Г</text>')
    if dims:                                                             # размерные цепочки
        def hdim(x0, x1, y, label):
            line(x0, y, x1, y, DIM, 0.8); line(x0, y - 4 / k, x0, y + 4 / k, DIM); line(x1, y - 4 / k, x1, y + 4 / k, DIM)
            a(f'<text x="{(X(x0) + X(x1)) / 2:.1f}" y="{Y(y) - 4:.1f}" text-anchor="middle" font-family="sans-serif" '
              f'font-size="11" fill="{INK}">{label}</text>')

        def vdim(y0, y1, x, label):
            line(x, y0, x, y1, DIM, 0.8)
            tx, ty = X(x) + (12 if not mirror else -12), (Y(y0) + Y(y1)) / 2
            a(f'<text x="{tx:.1f}" y="{ty:.1f}" font-family="sans-serif" font-size="11" fill="{INK}" '
              f'transform="rotate(-90 {tx:.1f} {ty:.1f})" text-anchor="middle">{label}</text>')
        hdim(0, W, H + 30 / k, f"{W:g}")
        vdim(0, H, W + 22 / k, f"{H:g}")
        sz = geo.sizes.get("")
        root = doc["frame"]["root"]
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
