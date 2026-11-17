"""Присадка корпуса (drilling.py): соединения, полкодержатели, планки петель, направляющие, ножки, навесы, проверки."""

import copy
import csv
import io
import json
import time
from pathlib import Path
from types import SimpleNamespace

import ezdxf
import pytest

from mebel_core import build, export_csv
from mebel_core.drilling import drilling_problems
from mebel_core.exports.dxf_parts import part_dxf
from mebel_core.geometry import Placement, Vec3
from mebel_core.parts import Hole, Part
from mebel_core.rules import DEFAULT_RULES, RuleSet
from mebel_core.units import mm

FIXTURES = Path(__file__).parent / "fixtures"
ALL = sorted(p.stem for p in FIXTURES.glob("*.json"))
JOINTS = ("конфирмат", "шкант")


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def world(p: Part, x: float, y: float, z: float) -> tuple[int, int, int]:
    o = p.placement.origin
    w = {"X": o.x, "Y": o.y, "Z": o.z}
    for ax, val in ((p.placement.u, x), (p.placement.v, y), (p.placement.n, z)):
        w[ax[1]] += val if ax[0] == "+" else -val
    return round(w["X"]), round(w["Y"]), round(w["Z"])


def face_z(p: Part, face: str) -> int:
    return p.thickness if face == "A" else 0


def wardrobe_2doors() -> dict:
    return {"width": 1000, "height": 2200, "depth": 600, "body": {"material": "ldsp_16_white"},
            "sections": [{"fill": [{"kind": "shelves", "count": 4}], "doors": {"count": 2}}]}


def hw(r, kind: str) -> int:
    return sum(h.qty for h in r.hardware if h.kind == kind)


# ---------- Соединения ----------


@pytest.mark.parametrize("name", ALL)
def test_joint_pairs_match_and_hardware_equals_pairs(name: str) -> None:
    """Каждое отверстие соединителя в пласти — против отверстия в торце другой детали (та же точка изделия);
    конфирматов и шкантов в фурнитуре столько же, сколько просверленных пар."""
    r = build(load(name))
    edge_pts = {}
    for p in r.parts:
        for h in p.holes:
            if h.purpose in JOINTS and h.face not in ("A", "B"):
                edge_pts[(h.purpose, world(p, h.x, h.y, p.thickness / 2))] = (p, h)
    faces = 0
    for p in r.parts:
        for h in p.holes:
            if h.purpose in JOINTS and h.face in ("A", "B"):
                faces += 1
                touched = h.face if h.purpose == "шкант" else ("B" if h.face == "A" else "A")
                partner = edge_pts.get((h.purpose, world(p, h.x, h.y, face_z(p, touched))))
                assert partner is not None, (p.key, h)
                e, eh = partner
                assert e is not p and eh.diameter == (mm(5) if h.purpose == "конфирмат" else mm(8))
    assert faces == len(edge_pts)
    n_conf = sum(1 for (purpose, _) in edge_pts if purpose == "конфирмат")
    n_dowel = len(edge_pts) - n_conf
    assert hw(r, "confirmat") == n_conf and hw(r, "dowel") == n_dowel


@pytest.mark.parametrize("name", ALL)
def test_standard_products_have_no_drilling_problems(name: str) -> None:
    r = build(load(name))
    assert not [i.message for i in r.issues if i.code.startswith("drill_") or i.code == "join_no_contact"]


def test_wardrobe_sides_joined_to_top_and_bottom() -> None:
    r = build(wardrobe_2doors())
    parts = {p.key: p for p in r.parts}
    for side in ("body.side.left", "body.side.right"):
        s = parts[side]
        face = [h for h in s.holes if h.purpose == "конфирмат"]
        # крыша, дно, 2 планки цоколя — по длине соединения 584 мм → 4 конфирмата, цоколь 70 мм → 2
        assert len(face) == 4 + 4 + 2 + 2
        assert all(h.face in ("A", "B") and h.depth == 0 and h.diameter == mm(7) for h in face)
        outer = "B" if side.endswith("left") else "A"  # головки — снаружи
        assert {h.face for h in face} == {outer}
    for key in ("body.top", "body.bottom"):
        p = parts[key]
        edge = [h for h in p.holes if h.purpose == "конфирмат"]
        assert {h.face for h in edge} == {"x0", "x1"} and len(edge) == 8
        assert all(h.diameter == mm(5) and h.depth == mm(50) for h in edge)
        # глубина корпуса 597 (600 − ХДФ): первый и последний — 50 мм от краёв, между — поровну
        assert sorted({h.y for h in edge}) == [mm(50), 2157, 3813, mm(547)]
        assert all(h.x in (0, p.length) for h in edge)


def test_drawer_box_walls_joined_to_drawer_sides() -> None:
    """Стенки ящика к боковинам ящика — общим проходом (раньше конфирматы считались без отверстий)."""
    r = build(load("wardrobe_full"))
    walls = [p for p in r.parts if p.role == "drawer_wall"]
    sides = [p for p in r.parts if p.role == "drawer_side"]
    assert walls and all({h.face for h in w.holes if h.purpose == "конфирмат"} == {"x0", "x1"} for w in walls)
    assert all(len([h for h in s.holes if h.purpose == "конфирмат"]) == 4 for s in sides)


def test_same_height_shelves_across_partition_use_dowels() -> None:
    """Неподвижные полки на одной высоте по обе стороны перегородки: головки конфирматов второй полки
    закрыты первой — вторая на шкантах, отверстия не пересекаются."""
    tree = {"width": 1600, "height": 2200, "depth": 600, "body": {"material": "ldsp_16_white"},
            "sections": [{"fill": [{"kind": "shelves", "count": 3, "mount": "fixed"}]},
                         {"fill": [{"kind": "shelves", "count": 3, "mount": "fixed"}]}]}
    r = build(tree)
    part = next(p for p in r.parts if p.key == "partition[0]")
    assert len([h for h in part.holes if h.purpose == "шкант"]) == 3 * 4
    assert hw(r, "dowel") == 12
    assert not [i for i in r.issues if i.code.startswith("drill_")]


# ---------- Полкодержатели ----------


def test_shelf_pins_at_shelf_heights_on_both_sides() -> None:
    r = build(wardrobe_2doors())
    shelves = [p for p in r.parts if p.role == "shelf"]
    left, right = (next(p for p in r.parts if p.key == k) for k in ("body.side.left", "body.side.right"))
    assert len(shelves) == 4
    for s in shelves:
        z = s.aabb().min.z - DEFAULT_RULES.shelf_pin_hole_below
        for panel, face in ((left, "A"), (right, "B")):  # пласти внутрь секции
            pins = [h for h in panel.holes if h.purpose == "полкодержатель" and h.x == z - panel.aabb().min.z]
            assert len(pins) == 2 and {h.face for h in pins} == {face}
            assert sorted(h.y for h in pins) == [mm(20 + 37), panel.width - mm(37)]
            assert all(h.diameter == mm(5) and h.depth == mm(12) for h in pins)
    assert hw(r, "shelf_pin") == 4 * 4


def test_shelf_pins_on_partition_from_both_sides_do_not_meet() -> None:
    r = build(load("wardrobe_2sec"))
    part = next(p for p in r.parts if p.key == "partition[0]")
    pins = [h for h in part.holes if h.purpose == "полкодержатель"]
    assert {h.face for h in pins} == {"A", "B"}
    assert not drilling_problems(SimpleNamespace(parts=[part], rules=DEFAULT_RULES, contacts_cache=None))


def test_system32_rows() -> None:
    rules = RuleSet(shelf_pin_rows="system32")
    r = build(wardrobe_2doors(), rules)
    left = next(p for p in r.parts if p.key == "body.side.left")
    front = sorted(h.x for h in left.holes if h.purpose == "полкодержатель" and h.y == mm(57))
    assert len(front) > 30 and {b - a for a, b in zip(front, front[1:])} == {mm(32)}
    for s in (p for p in r.parts if p.role == "shelf"):  # полки — на сетке ряда
        assert s.aabb().min.z - rules.shelf_pin_hole_below - left.aabb().min.z in front
    assert hw(r, "shelf_pin") == 16 and not [i for i in r.issues if i.code.startswith("drill_")]


# ---------- Петли ----------


@pytest.mark.parametrize("pattern", ["along", "across"])
def test_hinge_plates_aligned_with_door_cups(pattern: str) -> None:
    r = build(wardrobe_2doors(), RuleSet(hinge_plate_pattern=pattern))
    parts = {p.key: p for p in r.parts}
    doors = [p for p in r.parts if p.role == "door"]
    assert len(doors) == 2
    for door in doors:
        cups = [h for h in door.holes if h.purpose == "чашка петли"]
        assert len(cups) == DEFAULT_RULES.hinges_for_height(door.length)
        hinge_left = cups[0].y < door.width / 2
        side = parts["body.side.left" if hinge_left else "body.side.right"]
        plates = [h for h in side.holes if h.purpose == "планка петли"]
        assert len(plates) == 2 * len(cups)
        for c in cups:
            cz = world(door, c.x, c.y, 0)[2]
            lx = cz - side.aabb().min.z
            mine = [h for h in plates if abs(h.x - lx) <= mm(16)]
            if pattern == "along":
                assert sorted((h.x, h.y) for h in mine) == [(lx - mm(16), mm(37)), (lx + mm(16), mm(37))]
            else:
                assert sorted((h.x, h.y) for h in mine) == [(lx, mm(37)), (lx, mm(69))]


def test_hinges_on_shared_partition_shift_instead_of_colliding() -> None:
    """Двери двух секций на петлях к одной перегородке: петли второй сдвигаются на шаг 32 мм."""
    r = build(load("wardrobe_builtin"))
    part = next(p for p in r.parts if p.key == "partition[1]")
    plates = [h for h in part.holes if h.purpose == "планка петли"]
    assert {h.face for h in plates} == {"A", "B"}
    assert not drilling_problems(SimpleNamespace(parts=[part], rules=DEFAULT_RULES, contacts_cache=None))


# ---------- Ящики ----------


@pytest.mark.parametrize("slides", ["ball", "hidden_soft"])
def test_drawer_slide_holes(slides: str) -> None:
    tree = load("kitchen_straight")
    tree["hardware"] = {**tree.get("hardware", {}), "slides": slides}
    r = build(tree)
    items = [h for h in r.hardware if h.kind == "slide"]
    assert items
    for item in items:
        path = item.module
        length = int(item.params["length"])
        n = len(DEFAULT_RULES.slide_hole_positions(slides, length))
        cab = path.split(".fill")[0]
        drawers = [p for p in r.parts if p.role == "drawer_side" and p.module == path]
        k = len(drawers) // 2
        for key in ("left", "right"):
            side = next(p for p in r.parts if p.key == f"{cab}.side.{key}")
            assert len([h for h in side.holes if h.purpose == "направляющая"]) == n * k
        if slides == "ball":
            assert all(len([h for h in d.holes if h.purpose == "направляющая ящика"]) == n for d in drawers)
        else:
            backs = [p for p in r.parts if p.key.endswith(".wall.back") and p.module == path]
            assert all(len([h for h in b.holes if h.purpose == "крючок направляющей"]) == 2 for b in backs)
    assert not [i for i in r.issues if i.code.startswith("drill_")]


# ---------- Кухня ----------


def test_kitchen_base_rails_legs_and_wall_hangers() -> None:
    r = build(load("kitchen_straight"))
    parts = {p.key: p for p in r.parts}
    rails = [p for p in r.parts if p.role == "rail" and p.module == "base[0]"]
    assert len(rails) == 2
    side = parts["base[0].side.left"]
    for rail in rails:
        edge = [h for h in rail.holes if h.purpose == "конфирмат"]
        assert {h.face for h in edge} == {"x0", "x1"} and len(edge) == 4  # 100 мм → 2 на торец
    top_z = side.length - side.thickness // 2  # конфирматы царг — по середине толщины царги
    assert len([h for h in side.holes if h.purpose == "конфирмат" and h.x == top_z]) == 4
    bottom = parts["base[0].bottom"]
    legs = [h for h in bottom.holes if h.purpose == "ножка"]
    assert len(legs) == 4 * len(DEFAULT_RULES.leg_hole_offsets) and {h.face for h in legs} == {"B"}
    wall = [p for p in r.parts if p.key.startswith("wall[0].side.")]
    assert all(len([h for h in s.holes if h.purpose == "навес"]) == 2 for s in wall)


def test_lift_mechanism_brackets() -> None:
    tree = load("kitchen_straight")
    tree["wall"] = [{"kind": "doors", "width": 900, "opening": "lift", "shelves": 1},
                    {"kind": "doors", "width": 900, "opening": "lift", "lift_type": "fold", "shelves": 2}]
    tree["wall_height"] = 600  # один подъёмный фасад (выше 700 — два)
    r = build(tree)
    for key, purpose, n in (("wall[0]", "кронштейн газлифта", 2), ("wall[1]", "подъёмник складной", 4)):
        for s in ("left", "right"):
            side = next(p for p in r.parts if p.key == f"{key}.side.{s}")
            assert len([h for h in side.holes if h.purpose == purpose]) == n
        top = next(p for p in r.parts if p.key == f"{key}.top")
        assert len([h for h in top.holes if h.purpose == "планка петли"]) == 2 * 2  # фасад 898 мм — 2 петли
    assert not [i for i in r.issues if i.code.startswith("drill_")]


# ---------- Проверки ----------


def _plate(**kw) -> Part:
    return Part(key="p", name="Деталь", role="side", module="m", material="ldsp_16_white", thickness=mm(16),
                length=mm(600), width=mm(400), placement=Placement(origin=Vec3(x=0, y=0, z=0), u="+X", v="+Y",
                                                                     n="+Z"), **kw)


def test_check_finds_collisions_blowout_and_meeting_holes() -> None:
    ctx = SimpleNamespace(rules=DEFAULT_RULES, contacts_cache=None, parts=[])
    p = _plate(holes=[
        Hole(x=mm(100), y=mm(100), diameter=mm(5), depth=mm(12), face="A", purpose="полкодержатель"),
        Hole(x=mm(103), y=mm(100), diameter=mm(5), depth=mm(12), face="A", purpose="планка петли"),  # наложились
        Hole(x=mm(300), y=mm(100), diameter=mm(5), depth=mm(12), face="A", purpose="полкодержатель"),
        Hole(x=mm(300), y=mm(100), diameter=mm(5), depth=mm(12), face="B", purpose="полкодержатель"),  # встречные
        Hole(x=mm(400), y=mm(2), diameter=mm(7), depth=0, face="A", purpose="конфирмат"),  # у края
        Hole(x=0, y=mm(200), diameter=mm(5), depth=mm(50), face="x0", purpose="конфирмат"),
        Hole(x=mm(30), y=mm(200), diameter=mm(5), depth=mm(12), face="B", purpose="ножка"),  # в канал торцевого
    ])
    ctx.parts = [p]
    found = drilling_problems(ctx)
    assert len(found[("drill_collision", "p")]) == 3
    assert ("drill_edge", "p") in found
    ok = _plate(holes=[Hole(x=mm(300), y=mm(100), diameter=mm(5), depth=mm(6), face="A", purpose="x"),
                       Hole(x=mm(300), y=mm(100), diameter=mm(5), depth=mm(6), face="B", purpose="x")])
    ctx.parts = [ok]
    assert not drilling_problems(ctx)  # 6 + 6 < 16 − 3: перемычка остаётся


def test_check_warns_on_build() -> None:
    """Сборка выдаёт предупреждение drill_* (а не ошибку), если присадка не помещается."""
    # Встречные полкодержатели в перегородке 16 мм почти насквозь, а сдвиг линии — всего 0,1 мм
    rules = RuleSet(shelf_pin_depth=mm(15), system32_step=mm(0.1))
    tree = {"width": 1200, "height": 2200, "depth": 600, "body": {"material": "ldsp_16_white"},
            "sections": [{"fill": [{"kind": "shelves", "count": 4}]}, {"fill": [{"kind": "shelves", "count": 4}]}]}
    r = build(tree, rules)
    drill = [i for i in r.issues if i.code.startswith("drill_")]
    assert drill and all(i.level == "warning" for i in drill)


# ---------- Файлы ----------


def test_dxf_has_face_and_edge_drilling_layers() -> None:
    r = build(wardrobe_2doors())
    side = next(p for p in r.parts if p.key == "body.side.left")
    bottom = next(p for p in r.parts if p.key == "body.bottom")
    layers = {e.dxf.layer for e in ezdxf.read(io.StringIO(part_dxf(side).decode())).modelspace()}
    assert {"DRILL_B_D7_Z0", "DRILL_A_D5_Z12"} <= layers
    doc = ezdxf.read(io.StringIO(part_dxf(bottom).decode()))
    layers = {e.dxf.layer for e in doc.modelspace()}
    assert {"DRILL_EDGE_x0_D5_Z50", "DRILL_EDGE_x1_D5_Z50", "AXIS_DRILL_EDGE"} <= layers
    circles = [e for e in doc.modelspace() if e.dxf.layer == "DRILL_EDGE_x1_D5_Z50"]
    assert all(abs(c.dxf.center.x - bottom.cut_length / 10) < 1e-6 for c in circles)  # центр — на кромке распила


def test_csv_has_drilling_column() -> None:
    r = build(wardrobe_2doors())
    rows = list(csv.reader(io.StringIO(export_csv(r).decode("utf-8-sig")), delimiter=";"))
    assert rows[0][-1] == "Присадка"
    side = next(row for row in rows[1:] if row[1] == "Боковина левая")
    part = next(p for p in r.parts if p.key == "body.side.left")
    assert side[-1] == str(len(part.holes))


def test_big_kitchen_build_time() -> None:
    t = load("kitchen_corner")
    t["base"] = t["base"][:-1] * 4 + t["base"][-1:]
    t["base2"], t["wall"], t["wall2"] = t["base2"] * 3, t["wall"] * 3, t["wall2"] * 3
    build(copy.deepcopy(t))
    t0 = time.perf_counter()
    r = build(copy.deepcopy(t))
    assert len(r.parts) > 120 and time.perf_counter() - t0 < 0.5


# ---------- Настройки производства цеха (SCR-56) ----------


@pytest.mark.parametrize("name", ["wardrobe_2sec", "wardrobe_full", "kitchen_corner", "kupe_3doors"])
def test_dowel_fastener_replaces_all_confirmats(name: str) -> None:
    """Цех на шкантах: ни одного конфирмата, шкантов — по числу просверленных пар, присадка без проблем."""
    from mebel_core.rules import production_rules

    base = build(load(name))
    r = build(load(name), production_rules({"fastener": "dowel"}))
    assert hw(r, "confirmat") == 0 and not [h for p in r.parts for h in p.holes if h.purpose == "конфирмат"]
    face = [h for p in r.parts for h in p.holes if h.purpose == "шкант" and h.face in ("A", "B")]
    edge = [h for p in r.parts for h in p.holes if h.purpose == "шкант" and h.face not in ("A", "B")]
    assert len(face) == len(edge) == hw(r, "dowel")
    # соединений столько же: где был конфирмат — шкант
    assert hw(r, "dowel") == hw(base, "dowel") + hw(base, "confirmat")
    assert all(h.diameter == mm(8) and 0 < h.depth < p.thickness for p in r.parts for h in p.holes
               if h.purpose == "шкант" and h.face in ("A", "B"))
    assert not [i.message for i in r.issues if i.code.startswith("drill_") or i.code == "join_no_contact"]


def test_dowel_fastener_joint_pairs_match() -> None:
    from mebel_core.rules import production_rules

    r = build(wardrobe_2doors(), production_rules({"fastener": "dowel"}))
    edge_pts = {world(p, h.x, h.y, p.thickness / 2) for p in r.parts for h in p.holes
                if h.purpose == "шкант" and h.face not in ("A", "B")}
    for p in r.parts:
        for h in p.holes:
            if h.purpose == "шкант" and h.face in ("A", "B"):
                assert world(p, h.x, h.y, face_z(p, h.face)) in edge_pts, (p.key, h)


@pytest.mark.parametrize("depth", [35, 40, 45, 50])
def test_confirmat_edge_depth_from_workshop(depth: int) -> None:
    from mebel_core.rules import production_rules

    r = build(wardrobe_2doors(), production_rules({"confirmat_depth": depth}))
    edge = [h for p in r.parts for h in p.holes if h.purpose == "конфирмат" and h.face not in ("A", "B")]
    assert edge and {h.depth for h in edge} == {mm(depth)}
    assert r.rules_version.endswith(f"+c{depth}.blum.single")


@pytest.mark.parametrize("brand,pattern,cup_depth", [("blum", "along", mm(13)), ("hettich", "along", mm(13.5)),
                                                     ("gtv", "across", mm(12))])
def test_hinge_brand_maps_to_plate_and_cup(brand: str, pattern: str, cup_depth: int) -> None:
    from mebel_core.rules import HINGE_BRANDS, production_rules

    rules = production_rules({"hinge_brand": brand})
    assert rules.hinge_plate_pattern == pattern and rules.hinge_cup_depth == cup_depth
    r = build(wardrobe_2doors(), rules)
    door = next(p for p in r.parts if p.role == "door")
    cups = [h for h in door.holes if h.purpose == "чашка петли"]
    assert cups and {h.depth for h in cups} == {cup_depth}
    assert {min(h.y, door.width - h.y) for h in cups} == {rules.hinge_cup_from_edge}
    side = next(p for p in r.parts if p.key == "body.side.left")
    plates = sorted({h.y for h in side.holes if h.purpose == "планка петли"})
    assert plates == ([mm(37)] if pattern == "along" else [mm(37), mm(69)])
    names = {h.name for h in r.hardware if h.kind == "hinge"}
    assert names and all(n.endswith(f"· {HINGE_BRANDS[brand]['name']}") for n in names)


def test_shelf_pin_grid_setting_and_defaults() -> None:
    from mebel_core.rules import normalize_production, production_rules

    assert production_rules(None) is DEFAULT_RULES and production_rules({}) is DEFAULT_RULES
    assert production_rules({"shelf_pin_grid": True}).shelf_pin_rows == "system32"
    assert production_rules({"shelf_pin_grid": False}).shelf_pin_rows == "single"
    assert production_rules({"fastener": "dowel"}) is production_rules({"fastener": "dowel"})  # кэш
    # Blum с конфирматом 50 — та же присадка, что по умолчанию (только марка в названии петли)
    same = build(wardrobe_2doors(), production_rules({"hinge_brand": "blum"}))
    base = build(wardrobe_2doors())
    assert [p.holes for p in same.parts] == [p.holes for p in base.parts]
    for bad in ({"fastener": "glue"}, {"confirmat_depth": 30}, {"hinge_brand": "noname"}):
        with pytest.raises(ValueError):
            normalize_production(bad)
