"""DXF деталей в собственном универсальном формате слоёв (FR-30).

Одна деталь — один DXF. Координаты — мм, начало — левый нижний угол
детали в размере распила; ось X — длина, Y — ширина.

Слои:
- CUT — контур распила;
- FINISH — чистовой контур (после кромки), для контроля;
- EDGE_<сторона>_<толщина> — линии кромлённых сторон;
- DRILL_<A|B>_D<диаметр>_Z<глубина> — отверстия в пласти (Z0 — сквозное);
  A — лицевая пласть (по нормали детали), B — обратная;
- DRILL_EDGE_<сторона>_D<диаметр>_Z<глубина> — отверстия в торце: точка на краю, глубина — внутрь;
- CUTOUT — сквозные вырезы;
- GROOVE_<A|B>_W<ширина>_Z<глубина> — пазы и четверти (прямоугольник паза);
- POCKET_<A|B>_Z<глубина> — выборки;
- MILLING_<A|B>_W<фреза>_Z<глубина> — фрезеровка декора фасада: осевая линия фрезы (дуги — bulge),
  незамкнутые пути — рифление, волны; у фасадов лицевая сторона — B;
- INLAY_<A|B>_W<ширина>_Z<глубина> — паз под металлическую вставку (латунная рамка, полоса);
- OVERLAY_MARK — разметка наклейки молдинга (не обработка, для сборщика);
- TEXT — номер, имя, материал.
"""

import io
import zipfile

import ezdxf

from ..assembler import BuildResult
from ..catalog import edge_type, material
from ..units import to_mm


def _f(v: float) -> str:
    return f"{v:g}".replace(".", "_")


def _polyline(contour, dx: float, dy: float, keep_last: bool = False) -> list[tuple]:
    """Контур из линий и дуг → вершины LWPOLYLINE с bulge (мм, со сдвигом)."""
    import math

    pts = [[to_mm(contour.start_x) + dx, to_mm(contour.start_y) + dy, 0.0]]
    for seg in contour.segments:
        x, y = to_mm(seg.x) + dx, to_mm(seg.y) + dy
        if seg.kind == "arc":
            px, py = pts[-1][0], pts[-1][1]
            cx, cy = to_mm(seg.cx) + dx, to_mm(seg.cy) + dy
            a1, a2 = math.atan2(py - cy, px - cx), math.atan2(y - cy, x - cx)
            sweep = -((a1 - a2) % (2 * math.pi)) if seg.clockwise else (a2 - a1) % (2 * math.pi)
            pts[-1][2] = math.tan(sweep / 4)
        pts.append([x, y, 0.0])
    if not keep_last and abs(pts[-1][0] - pts[0][0]) < 1e-6 and abs(pts[-1][1] - pts[0][1]) < 1e-6:
        pts.pop()
    return [(x, y, 0, 0, b) for x, y, b in pts]


def part_dxf(p) -> bytes:
    doc = ezdxf.new("R2010", setup=True)
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    e = {s: to_mm(p.edge_thickness(s)) for s in ("x0", "x1", "y0", "y1")}
    L, W = to_mm(p.cut_length), to_mm(p.cut_width)

    if p.contour is not None:
        msp.add_lwpolyline(_polyline(p.contour, -e["x0"], -e["y0"]), format="xyseb", close=True,
                           dxfattribs={"layer": "CUT"})
    else:
        msp.add_lwpolyline([(0, 0), (L, 0), (L, W), (0, W)], close=True, dxfattribs={"layer": "CUT"})
    for c in p.cutouts:
        msp.add_lwpolyline(_polyline(c, -e["x0"], -e["y0"]), format="xyseb", close=True,
                           dxfattribs={"layer": "CUTOUT"})
    for g in p.grooves:
        x0, y0 = to_mm(g.x0) - e["x0"], to_mm(g.y0) - e["y0"]
        x1, y1 = to_mm(g.x1) - e["x0"], to_mm(g.y1) - e["y0"]
        layer = f"GROOVE_{g.face}_W{_f(to_mm(g.width))}_Z{_f(to_mm(g.depth))}"
        msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": layer})
    for pk in p.pockets:
        x0, y0 = to_mm(pk.x) - e["x0"], to_mm(pk.y) - e["y0"]
        x1, y1 = x0 + to_mm(pk.width), y0 + to_mm(pk.height)
        layer = f"POCKET_{pk.face}_Z{_f(to_mm(pk.depth))}"
        msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": layer})
    if p.decor is not None:
        face = p.decor.face
        for m in p.decor.milling:
            msp.add_lwpolyline(_polyline(m.path, -e["x0"], -e["y0"], keep_last=not m.closed), format="xyseb",
                               close=m.closed, dxfattribs={"layer": f"MILLING_{face}_W{_f(to_mm(m.width))}_Z{_f(to_mm(m.depth))}"})
        for m in p.decor.inlay:
            if m.depth:
                msp.add_lwpolyline(_polyline(m.path, -e["x0"], -e["y0"], keep_last=not m.closed), format="xyseb",
                                   close=m.closed, dxfattribs={"layer": f"INLAY_{face}_W{_f(to_mm(m.width))}_Z{_f(to_mm(m.depth))}"})
        for m in p.decor.overlay:
            msp.add_lwpolyline(_polyline(m.path, -e["x0"], -e["y0"], keep_last=not m.closed), format="xyseb",
                               close=m.closed, dxfattribs={"layer": "OVERLAY_MARK"})
    msp.add_lwpolyline(
        [(-e["x0"], -e["y0"]), (L + e["x1"], -e["y0"]), (L + e["x1"], W + e["y1"]), (-e["x0"], W + e["y1"])],
        close=True, dxfattribs={"layer": "FINISH"},
    )
    sides = {"y0": ((0, 0), (L, 0)), "y1": ((0, W), (L, W)), "x0": ((0, 0), (0, W)), "x1": ((L, 0), (L, W))}
    for side, edge_id in p.edges.items():
        layer = f"EDGE_{side}_{_f(to_mm(edge_type(edge_id).thickness))}"
        msp.add_line(*sides[side], dxfattribs={"layer": layer})

    for h in p.holes:
        # Координаты отверстий — в чистовой системе детали; переводим в систему распила
        x, y = to_mm(h.x) - e["x0"], to_mm(h.y) - e["y0"]
        d, z = to_mm(h.diameter), to_mm(h.depth)
        if h.face in ("A", "B"):
            layer = f"DRILL_{h.face}_D{_f(d)}_Z{_f(z)}"
        else:
            layer = f"DRILL_EDGE_{h.face}_D{_f(d)}_Z{_f(z)}"
            x, y = min(max(x, 0), L), min(max(y, 0), W)  # точка на краю распила
        msp.add_circle((x, y), d / 2, dxfattribs={"layer": layer})

    msp.add_text(
        f"{p.number}. {p.name} · {material(p.material).name} · {L:g}×{W:g}",
        height=max(min(W, L) / 20, 5),
        dxfattribs={"layer": "TEXT"},
    ).set_placement((5, W + 10))
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")


def export_dxf_zip(result: BuildResult) -> bytes:
    """Архив: по DXF на каждую листовую деталь и на каждый кусок столешницы (стык и вырезы режет поставщик)."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in result.parts:
            if material(p.material).is_sheet or material(p.material).kind == "countertop":
                name = f"{p.number:03d}_{p.key.replace('[', '_').replace(']', '').replace('.', '_')}.dxf"
                z.writestr(name, part_dxf(p))
    return out.getvalue()
