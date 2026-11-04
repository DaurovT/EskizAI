"""Общие проверки, которые должны выполняться для любой корректной сборки."""

import json
from pathlib import Path

import pytest

from mebel_core import build
from mebel_core.units import mm

FIXTURES = Path(__file__).parent / "fixtures"
GOOD = sorted(p for p in FIXTURES.glob("*.json") if not p.stem.startswith("bad_"))


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", GOOD, ids=lambda p: p.stem)
def test_good_fixture_builds_without_errors(path: Path) -> None:
    result = build(load(path))
    assert result.ok, [i.message for i in result.issues if i.level == "error"]


@pytest.mark.parametrize("path", GOOD, ids=lambda p: p.stem)
def test_parts_inside_product_and_not_overlapping(path: Path) -> None:
    result = build(load(path))
    W, H, D = result.size
    boxes = [p.aabb() for p in result.parts]
    for p, b in zip(result.parts, boxes):
        assert 0 <= b.min.x and b.max.x <= W, p.key
        assert -mm(60) <= b.min.y and b.max.y <= D, p.key  # фасады и столешница — перед корпусом (y < 0)
        assert 0 <= b.min.z and b.max.z <= H, p.key
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            assert boxes[i].overlap_volume(boxes[j]) == 0, (result.parts[i].key, result.parts[j].key)


@pytest.mark.parametrize("path", GOOD, ids=lambda p: p.stem)
def test_numbers_are_sequential_and_keys_unique(path: Path) -> None:
    result = build(load(path))
    assert [p.number for p in result.parts] == list(range(1, len(result.parts) + 1))
    keys = [p.key for p in result.parts]
    assert len(keys) == len(set(keys))


def test_body_fills_full_width_and_height() -> None:
    result = build(load(FIXTURES / "wardrobe_2sec.json"))
    W, H, _ = result.size
    xs = [p.aabb() for p in result.parts if p.role != "back"]
    assert min(b.min.x for b in xs) == 0 and max(b.max.x for b in xs) == W
    assert min(b.min.z for b in xs) == 0 and max(b.max.z for b in xs) == H


def test_cut_size_subtracts_edge() -> None:
    result = build(load(FIXTURES / "wardrobe_2sec.json"))
    side = next(p for p in result.parts if p.key == "body.side.left")
    # Передняя кромка 2 мм (Д1) и верхний торец 0,4 мм (Ш2)
    assert side.cut_width == side.width - mm(2)
    assert side.cut_length == side.length - mm(0.4)


def test_sections_split_evenly() -> None:
    result = build(load(FIXTURES / "wardrobe_2sec.json"))
    shelves = [p for p in result.parts if p.role == "shelf"]
    # 1200 − 2×16 (боковины) − 16 (перегородка) = 1152 → по 576; полка на полкодержателях на 2 мм короче
    assert {p.length for p in shelves} == {mm(574)}


def test_grain_part_too_long_for_sheet_is_error() -> None:
    result = build(load(FIXTURES / "bad_too_tall_side.json"))
    assert not result.ok
    assert any(i.code == "part_exceeds_sheet" for i in result.issues)


def test_sections_mismatch_is_error() -> None:
    result = build(load(FIXTURES / "bad_sections_mismatch.json"))
    assert not result.ok
    assert any(i.code == "sections_mismatch" for i in result.issues)


def test_unknown_field_rejected() -> None:
    data = load(FIXTURES / "wardrobe_2sec.json")
    data["colour"] = "red"
    with pytest.raises(Exception):
        build(data)


def test_full_wardrobe_fronts_and_hardware() -> None:
    result = build(load(FIXTURES / "wardrobe_full.json"))
    assert result.ok, [i.message for i in result.issues]
    doors = [p for p in result.parts if p.role == "door"]
    fronts = [p for p in result.parts if p.role == "drawer_front"]
    assert len(fronts) == 3
    # Каждая дверь и каждый ящик — подвижный узел
    assert len([n for n in result.nodes if n.kind == "rotate"]) == len(doors)
    assert len([n for n in result.nodes if n.kind == "slide"]) == 5
    # Двери не шире 600 мм
    assert all(p.width <= mm(600) for p in doors)
    # Высокая дверь 1904 мм — 4 петли, у каждой чашка Ø35
    tall = next(p for p in doors if p.length == mm(1904))
    assert len([h for h in tall.holes if h.purpose == "чашка петли"]) == 4


def test_every_joint_has_matching_holes() -> None:
    result = build(load(FIXTURES / "wardrobe_full.json"))
    face = sum(1 for p in result.parts for h in p.holes if h.purpose == "конфирмат" and h.diameter == mm(7))
    edge = sum(1 for p in result.parts for h in p.holes if h.purpose == "конфирмат" and h.diameter == mm(5))
    assert face == edge > 0


def test_door_too_wide_warns() -> None:
    data = load(FIXTURES / "wardrobe_2sec.json")
    data["sections"] = [{"doors": {"count": 1}}]  # одна дверь на 1200 мм
    result = build(data)
    assert any(i.code == "door_too_wide" for i in result.issues)
