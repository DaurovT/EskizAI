"""GLB для AR: файл собирается, реальный масштаб, «открыто» шире «закрыто»."""

import io
import json
from pathlib import Path

import trimesh

from mebel_core import build
from mebel_core.glb import export_glb

FIXTURE = Path(__file__).parent / "fixtures" / "wardrobe_full.json"


def _bounds(data: bytes):
    return trimesh.load(io.BytesIO(data), file_type="glb").bounds


def test_glb_real_scale_and_open_variant() -> None:
    result = build(json.loads(FIXTURE.read_text(encoding="utf-8")))
    closed, opened = export_glb(result), export_glb(result, opened=True)
    assert closed[:4] == b"glTF"
    lo, hi = _bounds(closed)
    assert abs(hi[0] - lo[0] - 1.8) < 1e-6  # ширина 1,8 м
    assert abs(hi[1] - lo[1] - 2.4) < 1e-6  # высота 2,4 м (Y вверх)
    olo, ohi = _bounds(opened)
    assert ohi[2] > hi[2] + 0.4  # двери и ящики выдвинулись к зрителю
    assert len(closed) < 5 * 1024 * 1024  # лимит PRD для AR


def test_glb_uses_contour_and_cutouts() -> None:
    tree = json.loads((Path(__file__).parent / "fixtures" / "rack_no_back.json").read_text(encoding="utf-8"))
    plain = export_glb(build(tree))
    tree["operations"] = [
        {"op": "round_corner", "part": "body.side.right", "corner": "x1y0", "radius": 150},
        {"op": "cutout", "part": "body.side.left", "x": 900, "y": 150, "width": 80, "height": 60},
    ]
    shaped = export_glb(build(tree))
    scene = trimesh.load(io.BytesIO(shaped), file_type="glb")
    plain_scene = trimesh.load(io.BytesIO(plain), file_type="glb")
    # Скругление и вырез уменьшают объём; вершин у дуги больше, чем у бокса
    assert scene.volume < plain_scene.volume
    assert sum(len(g.vertices) for g in scene.geometry.values()) > sum(len(g.vertices) for g in plain_scene.geometry.values())
