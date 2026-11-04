"""Операции формы: скругления, вырезы, пазы, выборки и их проверки."""

import io
import json
import math
from pathlib import Path

import ezdxf

from mebel_core import build
from mebel_core.exports.dxf_parts import part_dxf
from mebel_core.units import mm

FIXTURES = Path(__file__).parent / "fixtures"


def tree(ops: list) -> dict:
    t = json.loads((FIXTURES / "rack_no_back.json").read_text(encoding="utf-8"))
    t["operations"] = ops
    return t


def codes(r) -> set:
    return {i.code for i in r.issues}


def test_round_corner_on_banded_side_needs_big_radius() -> None:
    # У боковины передний торец (y0) с кромкой 2 мм: R20 — мало, R150 — можно
    bad = build(tree([{"op": "round_corner", "part": "body.side.right", "corner": "x1y0", "radius": 20}]))
    assert "edge_radius" in codes(bad)
    good = build(tree([{"op": "round_corner", "part": "body.side.right", "corner": "x1y0", "radius": 150}]))
    assert good.ok
    side = next(p for p in good.parts if p.key == "body.side.right")
    arcs = [s for s in side.contour.segments if s.kind == "arc"]
    assert len(arcs) == 1 and arcs[0].cx == side.length - mm(150)


def test_rounded_contour_goes_to_dxf_with_bulge() -> None:
    r = build(tree([{"op": "round_corner", "part": "body.side.right", "corner": "x1y0", "radius": 150}]))
    side = next(p for p in r.parts if p.key == "body.side.right")
    doc = ezdxf.read(io.StringIO(part_dxf(side).decode()))
    cut = next(e for e in doc.modelspace() if e.dxf.layer == "CUT")
    bulges = [b for *_, b in cut.get_points("xyseb") if b]
    assert len(bulges) == 1 and math.isclose(bulges[0], math.tan(math.pi / 8), rel_tol=1e-6)  # дуга 90°


def test_cutout_margin_and_dxf() -> None:
    bad = build(tree([{"op": "cutout", "part": "body.side.left", "x": 10, "y": 100, "width": 80, "height": 60}]))
    assert "cutout_margin" in codes(bad)
    ok = build(tree([{"op": "cutout", "part": "body.side.left", "x": 900, "y": 150, "width": 80, "height": 60}]))
    assert ok.ok
    side = next(p for p in ok.parts if p.key == "body.side.left")
    doc = ezdxf.read(io.StringIO(part_dxf(side).decode()))
    assert "CUTOUT" in {e.dxf.layer for e in doc.modelspace()}


def test_groove_and_pocket_limits() -> None:
    deep = build(tree([{"op": "groove", "part": "body.top", "offset": 10, "width": 4, "depth": 10}]))
    assert "groove_too_deep" in codes(deep)
    pocket = build(tree([{"op": "pocket", "part": "body.top", "x": 100, "y": 100, "width": 100, "height": 30,
                          "depth": 12}]))
    assert "pocket_too_deep" in codes(pocket)  # 16 − 12 = 4 мм < 6 мм
    fine = build(tree([
        {"op": "groove", "part": "body.top", "offset": 10, "width": 4, "depth": 6},
        {"op": "pocket", "part": "body.top", "x": 100, "y": 100, "width": 100, "height": 30, "depth": 8},
    ]))
    assert fine.ok
    top = next(p for p in fine.parts if p.key == "body.top")
    layers = {e.dxf.layer for e in ezdxf.read(io.StringIO(part_dxf(top).decode())).modelspace()}
    assert {"GROOVE_A_W4_Z6", "POCKET_A_Z8"} <= layers


def test_unknown_part_is_error() -> None:
    assert "op_unknown_part" in codes(build(tree([{"op": "pocket", "part": "nope", "x": 1, "y": 1, "width": 1,
                                                    "height": 1, "depth": 1}])))
