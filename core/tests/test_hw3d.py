"""Фурнитура для 3D: стоит по присадке, двигается с узлом, совпадает со сметой по количеству."""

import io
import json
from pathlib import Path

import trimesh

from mebel_core import build, viewer_model
from mebel_core.glb import export_glb
from mebel_core.hw3d import hardware_visuals

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def test_handles_on_every_front_and_on_drilling() -> None:
    r = build(load("wardrobe_full"))
    hw = hardware_visuals(r)
    fronts = [p for p in r.parts if p.role in ("door", "drawer_front")]
    handles = {h.part: h for h in hw if h.kind == "handle"}
    assert set(handles) == {p.key for p in fronts}
    for p in fronts:
        h = handles[p.key]
        assert h.node == p.node and h.name.startswith("Ручка-скоба 128")
        # Стойки скобы — над отверстиями присадки, ручка — перед фасадом (Y < лицевой плоскости)
        b = p.aabb()
        posts = [s for s in h.shapes if s["radius"] == 40]
        assert len(posts) == 2
        for s in h.shapes:
            assert s["center"][1] < b.min.y
    # Количество скоб = количество в смете
    assert len(handles) == sum(i.qty for i in r.hardware if i.kind == "handle")


def test_hinges_follow_cups_and_count() -> None:
    r = build(load("wardrobe_full"))
    cups = [h for h in hardware_visuals(r) if h.kind == "hinge" and not h.id.endswith(".arm")]
    arms = [h for h in hardware_visuals(r) if h.id.endswith(".arm")]
    assert len(cups) == len(arms) == sum(i.qty for i in r.hardware if i.kind == "hinge")
    assert all(c.node for c in cups) and all(a.node is None for a in arms)


def test_door_handle_height_rules() -> None:
    """Высокая дверь — на высоте руки, верхние модули кухни — у низа, нижние — у верха."""
    r = build(load("kitchen_straight"))
    for h in hardware_visuals(r):
        if h.kind != "handle" or ".door[" not in h.part:
            continue
        door = next(p for p in r.parts if p.key == h.part).aabb()
        z = sum(s["center"][2] for s in h.shapes) / len(h.shapes)
        if h.part.startswith("wall"):
            assert z < (door.min.z + door.max.z) / 2
        else:
            assert z > (door.min.z + door.max.z) / 2
    r = build(load("wardrobe_full"))
    tall = next(h for h in hardware_visuals(r) if h.part == "sections[0].doors.door[1]" and h.kind == "handle")
    grip = max(tall.shapes, key=lambda s: s["length"])
    assert abs(grip["center"][2] - 10000) < 10  # 1 м от пола


def test_kitchen_legs_rods_carousel() -> None:
    r = build(load("kitchen_corner_square"))
    hw = hardware_visuals(r)
    legs = [h for h in hw if h.kind == "leg"]
    assert len(legs) == sum(i.qty for i in r.hardware if i.kind == "leg")
    assert all(min(s["center"][2] - s["length"] / 2 for s in h.shapes) == 0 for h in legs)
    assert any(h.kind == "carousel" for h in hw)
    vm = viewer_model(build(load("wardrobe_full")))
    holders = [h for h in vm["hardware"] if h["kind"] == "rod_holder"]
    assert len(holders) == 2 and "steel" in vm["hardwareFinishes"]


def test_viewer_parts_unchanged_and_glb_has_hardware() -> None:
    r = build(load("kupe_3doors"))
    assert any(h.kind == "profile" for h in hardware_visuals(r))
    scene = trimesh.load(io.BytesIO(export_glb(r)), file_type="glb")
    names = list(scene.graph.nodes_geometry)
    assert any(n.startswith("hw:") for n in names)
    assert sum(1 for n in names if not n.startswith("hw:")) == len(r.parts)
