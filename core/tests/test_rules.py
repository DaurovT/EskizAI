"""Правила конструкции и готовые исправления."""

import json
from pathlib import Path

from mebel_core import apply_patch, build
from mebel_core.fixes import apply_fix
from mebel_core.units import mm

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def codes(result) -> set[str]:
    return {i.code for i in result.issues}


def issue(result, code: str):
    return next(i for i in result.issues if i.code == code)


def test_shelf_span_warns_and_split_fix_resolves() -> None:
    tree = {"width": 1000, "height": 2000, "depth": 500, "sections": [{"fill": [{"kind": "shelves", "count": 4}]}]}
    result = build(tree)
    assert "shelf_span" in codes(result)  # 968 мм > 800 мм для 16 мм
    fixed = apply_fix(tree, issue(result, "shelf_span").fixes[0])
    assert len(fixed["sections"]) == 2
    assert "shelf_span" not in codes(build(fixed))


def test_shelf_span_offers_thicker_board_when_it_helps() -> None:
    tree = {"width": 900, "height": 2000, "depth": 500, "sections": [{"fill": [{"kind": "shelves", "count": 4}]}]}
    result = build(tree)
    fixes = issue(result, "shelf_span").fixes
    thicker = next(f for f in fixes if "18" in f.description)
    assert "shelf_span" not in codes(build(apply_fix(tree, thicker)))


def test_wide_door_fix_makes_two_doors() -> None:
    tree = load("wardrobe_2sec")
    tree["sections"] = [{"doors": {"count": 1}}]
    result = build(tree)
    fixed = apply_fix(tree, issue(result, "door_too_wide").fixes[0])
    assert fixed["sections"][0]["doors"]["count"] == 2
    assert "door_too_wide" not in codes(build(fixed))


def test_niche_door_on_outer_side_warns_and_fix_moves_hinges() -> None:
    tree = {
        "width": 1200, "height": 2400, "depth": 600, "installation": "niche",
        "sections": [{"doors": {"count": 1, "hinge": "left"}}, {"doors": {"count": 1, "hinge": "right"}}],
    }
    result = build(tree)
    warnings = [i for i in result.issues if i.code == "door_hits_niche_wall"]
    assert len(warnings) == 2
    fixed = apply_fix(tree, warnings[0].fixes[0])
    assert fixed["sections"][0]["doors"]["hinge"] == "right"


def test_internal_drawers_behind_door_get_spacers() -> None:
    result = build(load("wardrobe_full"))
    spacers = [p for p in result.parts if p.role == "spacer"]
    # Секция 3: одна дверь на правых петлях, 2 внутренних ящика → 2 проставки справа
    assert len(spacers) == 2 and all(p.key.endswith("spacer.right") for p in spacers)
    assert all(any(h.purpose == "направляющая" for h in p.holes) for p in spacers)


def test_sliding_doors() -> None:
    result = build(load("kupe_3doors"))
    assert result.ok, [i.message for i in result.issues]
    fills = [p for p in result.parts if p.role == "sliding_fill"]
    assert len(fills) == 3 and sum(p.material == "mirror_4_silver" for p in fills) == 1
    # Соседние двери на разных рельсах
    ys = [p.placement.origin.y for p in fills]
    assert ys[0] != ys[1] and ys[0] == ys[2]
    # Наполнение отступает на зону рельсов
    shelves = [p for p in result.parts if p.role == "shelf"]
    assert min(p.aabb().min.y for p in shelves) >= mm(100)
    assert len([n for n in result.nodes if n.kind == "sliding_door"]) == 3


def test_sliding_doors_reject_hinged_doors() -> None:
    tree = load("kupe_3doors")
    tree["sections"][0]["doors"] = {"count": 1}
    assert "sliding_and_hinged" in codes(build(tree))


def test_cornice_lowers_body_and_doors() -> None:
    result = build(load("wardrobe_cornice_ends"))
    assert result.ok, [i.message for i in result.issues]
    cornice = next(p for p in result.parts if p.role == "cornice")
    side = next(p for p in result.parts if p.key == "body.side.left")
    door = next(p for p in result.parts if p.role == "door")
    assert side.length == mm(2300)  # 2400 − карниз 100
    assert cornice.aabb().min.z == mm(2300) and cornice.aabb().max.z == mm(2400)
    assert door.aabb().max.z <= mm(2300)


def test_end_units_add_width_and_round_shelves() -> None:
    result = build(load("wardrobe_cornice_ends"))
    assert result.size[0] == mm(1800)  # 1200 + 2 × 300
    shelves = [p for p in result.parts if p.role == "end_shelf"]
    assert len(shelves) == 2 * 6  # дно + 4 полки + крыша с каждой стороны
    assert all(p.contour is not None and any(s.kind == "arc" for s in p.contour.segments) for p in shelves)
    left = [p for p in shelves if p.key.startswith("end_unit.left")]
    assert all(p.aabb().min.x == 0 for p in left)
    assert next(p for p in result.parts if p.key == "body.side.left").aabb().min.x == mm(300)


def test_kitchen_wall_cabinets_hang_on_the_wall() -> None:
    result = build(load("kitchen_straight"))
    walls = [p for p in result.parts if p.module.startswith("wall[") and p.role in ("side", "back")]
    assert max(p.aabb().max.y for p in walls) == mm(560)  # задняя стенка у стены
    wall_doors = [p for p in result.parts if p.role == "door" and p.module.startswith("wall[")]
    assert all(p.aabb().max.y == mm(560 - 300) for p in wall_doors)  # фасад верхних — на их передней плоскости


def test_corner_kitchen_both_sides_and_upper_rows() -> None:
    import copy

    base = load("kitchen_corner")
    for side in ("right", "left"):
        for reach in (False, True):
            t = copy.deepcopy(base)
            t["corner_side"] = side
            if side == "left":
                t["base"] = list(reversed(t["base"]))  # угловой модуль — первым
            if reach:
                t["wall"].append({"kind": "doors", "width": 1100})
            r = build(t)
            assert r.ok, (side, reach, [i.message for i in r.issues if i.level == "error"])
            assert r.size[2] == mm(560 + 1200)  # глубина = первый ряд + длина второго
            filler = [p for p in r.parts if p.role == "filler"]
            assert len(filler) == 1  # фальш-панель у глухого углового модуля
            # Слева верхние первого ряда начинаются от угла — перекрытие есть всегда
            assert ("corner_wall" in {i.code for i in r.issues}) == (reach or side == "left")


def test_corner_cabinet_must_be_in_the_corner() -> None:
    t = load("kitchen_corner")
    t["base"] = list(reversed(t["base"]))  # угловой модуль слева, а угол справа
    assert "corner_cabinet_position" in {i.code for i in build(t).issues}


def test_doors_on_a_single_zone() -> None:
    result = build(load("wardrobe_zone_doors"))
    assert result.ok, [i.message for i in result.issues]
    doors = [p for p in result.parts if p.role == "door"]
    right = [p for p in doors if p.key.startswith("sections[1].fill[0].doors")]
    assert len(right) == 2  # тумба: две дверцы только на нижней зоне
    zone_top = max(p.aabb().max.z for p in right)
    assert zone_top < mm(70 + 16 + 700 + 16)  # выше тумбы дверей нет — там открытые полки
    assert len([p for p in doors if p.key.startswith("sections[0]")]) == 1


def test_small_mismatch_auto_fits_last_zone_and_section() -> None:
    tree = load("wardrobe_zone_doors")
    tree["sections"][1]["fill"][1]["height"] = 1370  # всё задано, сумма не сходится на 12 мм
    r = build(tree)
    assert r.ok and "zones_auto_fit" in codes(r)
    tree = {"width": 1200, "height": 2400, "depth": 600, "sections": [{"width": 560}, {"width": 560}]}
    r = build(tree)  # в свету 1152 мм, задано 1120 — разница 32 мм
    assert r.ok and "sections_auto_fit" in codes(r)
    tree["sections"] = [{"width": 500}, {"width": 500}]  # разница 152 мм — это уже ошибка
    assert "sections_mismatch" in codes(build(tree))


BLACK = {"color": "#0A0A0A", "code": "RAL 9005", "system": "RAL", "gloss": "matte"}


def test_sliding_panels_take_front_paint_only_on_mdf() -> None:
    """Покраска фасадов переходит на заполнения купе из МДФ; зеркало не красится."""
    tree = load("kupe_3doors")
    tree.setdefault("fronts", {}).setdefault("style", {})["paint"] = BLACK
    tree["sliding_doors"]["panel_material"] = "mdf_10_paint"
    result = build(tree)
    assert result.ok, [i.message for i in result.issues]
    fills = [p for p in result.parts if p.role == "sliding_fill"]
    painted = [p for p in fills if p.decor is not None and p.decor.paint]
    mirrors = [p for p in fills if p.material.startswith("mirror")]
    assert len(painted) == 2 and all(p.decor.paint["code"] == "RAL 9005" for p in painted)
    assert mirrors and all(p.decor is None for p in mirrors)
    assert "sliding_paint_needs_mdf" not in codes(result)


def test_sliding_ldsp_panels_warn_and_fix_switches_to_mdf() -> None:
    """Заполнение из ЛДСП не красится: честное предупреждение и исправление на МДФ 10."""
    tree = load("kupe_3doors")
    tree.setdefault("fronts", {}).setdefault("style", {})["paint"] = BLACK
    result = build(tree)
    fills = [p for p in result.parts if p.role == "sliding_fill"]
    assert all(p.decor is None for p in fills)
    warn = issue(result, "sliding_paint_needs_mdf")
    assert warn.level == "warning" and warn.fixes
    fixed = apply_patch(tree, warn.fixes[0].patch)
    assert fixed["sliding_doors"]["panel_material"] == "mdf_10_paint"
    assert "sliding_paint_needs_mdf" not in codes(build(fixed))
