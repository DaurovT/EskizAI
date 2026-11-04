"""Встроенная мебель: ниша с замером в трёх точках, доборы, фальш-панели, цоколь на ножках, без задней стенки,
кухня — холодильник, посудомойка, фальш-панели, цоколь с решётками, добор до потолка; блок room в 3D."""

import copy
import io
import json
import zipfile
from pathlib import Path

import pytest

from mebel_core import (apply_fix, apply_measurements, build, estimate, estimate_range, export_csv, export_dxf_zip,
                        export_glb, fit_to_niche, viewer_model)
from mebel_core.units import mm

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def part(r, key):
    return next(p for p in r.parts if p.key == key)


def codes(r) -> set[str]:
    return {i.code for i in r.issues}


def wardrobe(**builtin) -> dict:
    return {
        "width": 2300, "height": 2650, "depth": 600, "installation": "niche",
        "builtin": {"niche": {"width": 2400, "height": 2700}, **builtin},
        "sections": [{"fill": [{"kind": "shelves", "count": 4}], "doors": {"count": 2}},
                     {"fill": [{"kind": "rod"}], "doors": {"count": 2}},
                     {"fill": [{"kind": "shelves", "count": 4}], "doors": {"count": 2}}],
    }


# ---------- Шкаф: доборы ----------


def test_three_point_niche_fillers_from_narrowest_and_widest():
    r = build(load("wardrobe_builtin"))
    assert r.ok, [i.message for i in r.issues if i.level == "error"]
    t = load("wardrobe_builtin")
    # Корпус — по самому узкому месту (2394) минус фальш-панель 18 и два добора по 50; высота — 2692 − 50
    assert (t["width"], t["height"]) == (2276, 2642)
    left, right, top = part(r, "builtin.filler.left"), part(r, "builtin.filler.right"), part(r, "builtin.filler.top")
    # Справа стена завалена (lean right): слева щель постоянная 50, справа 50→68 (2412 − 2276 − 18 − 50) + припуск 15
    assert left.width == mm(65) and right.width == mm(83) and left.length == mm(2642)
    assert left.contour is None and right.contour is not None and right.name == "Добор правый клином 50→68 мм"
    assert top.width == mm(2700 - 2642 + 15)
    # Кромка только к фасадам; к стене — подрезка
    assert left.edges == {"y1": "pvc_2"} and right.edges == {"y0": "pvc_2"} and top.edges == {"y0": "pvc_2"}
    assert left.role == "niche_filler" and left.material == "ldsp_18_oak" and left.node is None
    strips = [p for p in r.parts if p.role == "filler_strip"]
    assert len(strips) == 3 and all(p.material == "ldsp_16_white" for p in strips)
    assert "niche_out_of_plumb" in codes(r)
    msg = next(i.message for i in r.issues if i.code == "niche_out_of_plumb")
    assert "Стена справа завалена на 18 мм" in msg and "клином" in msg
    assert any(h.kind == "wall_anchor" for h in r.hardware)
    # Всё изделие сдвинуто вправо, габарит — с доборами
    assert min(p.aabb().min.x for p in r.parts) == 0
    assert r.size[0] == max(p.aabb().max.x for p in r.parts)


def test_nominal_fillers_without_measurement():
    t = wardrobe()
    t["builtin"]["niche"] = {}
    r = build(t)
    assert r.ok and part(r, "builtin.filler.left").width == mm(50 + 15)
    assert not codes(r) & {"niche_out_of_plumb", "filler_too_wide", "filler_too_narrow"}


def test_filler_too_wide_fix_and_extra_section():
    t = wardrobe()
    t["width"] = 1900  # щели по 250
    r = build(t)
    issue = next(i for i in r.issues if i.code == "filler_too_wide")
    assert "шире 150" in issue.message
    assert [f.description for f in issue.fixes][:1] == ["Корпус шире — добор 50 мм"]
    fixed = build(apply_fix(t, issue.fixes[0]))
    assert fixed.ok and "filler_too_wide" not in codes(fixed)
    assert part(fixed, "builtin.filler.left").width == mm(50 + 15)
    section = next(f for f in issue.fixes if "секцию" in f.description)
    with_section = build(apply_fix(t, section))
    assert with_section.ok and len(with_section.product.sections) == 4


def test_filler_too_narrow_is_not_cut_and_fix_removes_it():
    t = wardrobe()
    t["width"] = 2370  # щели по 15
    r = build(t)
    issue = next(i for i in r.issues if i.code == "filler_too_narrow" and "левый" in i.message)
    assert not any(p.key == "builtin.filler.left" for p in r.parts)
    remove = next(f for f in issue.fixes if "Без добора" in f.description)
    r2 = build(apply_fix(t, remove))
    assert "left" not in r2.product.builtin.fillers


def test_carcass_bigger_than_niche_error_with_fit_fix():
    t = wardrobe()
    t["width"] = 2420
    r = build(t)
    issue = next(i for i in r.issues if i.code == "builtin_too_big")
    assert issue.level == "error" and "шире ниши" in issue.message
    fixed = build(apply_fix(t, issue.fixes[0]))
    assert fixed.ok and fixed.product.width == 2300


def test_niche_too_narrow():
    t = wardrobe()
    t["width"], t["builtin"]["niche"]["width"] = 200, 250
    t["sections"] = [{}]
    r = build(t)
    assert "niche_too_narrow" in codes(r) and not r.ok


def test_open_gap_without_filler_suggests_filler():
    t = wardrobe(fillers=["top"])
    t["width"] = 2300
    r = build(t)
    issue = next(i for i in r.issues if i.code == "niche_gap_open")
    assert apply_fix(t, issue.fixes[0])["builtin"]["fillers"] == ["top", "left"]


def test_door_hits_niche_wall_only_with_small_clearance():
    t = wardrobe()
    t["sections"] = [{"fill": [{"kind": "shelves", "count": 4}], "doors": {"count": 1, "hinge": "left"}}] * 3
    t["width"] = 1700
    assert "door_hits_niche_wall" not in codes(build(t))  # добор ≥ 30 мм — дверь открывается
    t["builtin"]["fillers"] = ["top"]
    t["width"] = 2380  # без добора: 10 мм до стены
    assert "door_hits_niche_wall" in codes(build(t))


def test_tilt_and_shallow_niche_and_sliding_rails():
    t = wardrobe()
    t["builtin"]["niche"] = {"width": 2400, "height": 2700, "depth": 550}
    t["body"] = {"plinth": None}
    t["sections"] = [{"fill": [{"kind": "shelves", "count": 4}]}] * 3
    t["sliding_doors"] = {"count": 3}
    r = build(t)
    assert {"builtin_tilt", "niche_too_shallow", "sliding_niche_rails"} <= codes(r)
    # У купе доборы — в плоскости корпуса (двери внутри)
    assert part(r, "builtin.filler.left").aabb().min.y == 0


def test_setback_and_screw_mount():
    t = wardrobe(filler_position="setback", filler_setback=20, filler_mount="screws", filler_material="ldsp_16_white")
    r = build(t)
    f = part(r, "builtin.filler.left")
    assert f.aabb().min.y == mm(-16 + 20) and f.material == "ldsp_16_white"
    assert not any(p.role == "filler_strip" for p in r.parts)
    assert any(h.kind == "bracket" for h in r.hardware)


def test_apply_measurements_niche_makes_builtin():
    tree = load("wardrobe_2sec")
    out = apply_measurements(tree, niche={"width_top": 1305, "width_middle": 1300, "width_bottom": 1298,
                                          "height_left": 2500, "height_right": 2496, "depth": 580})
    assert out["installation"] == "niche" and out["builtin"]["niche"]["width_bottom"] == 1298
    assert out["width"] == 1298 - 100 and out["height"] == 2496 - 50 and out["depth"] <= 580
    r = build(out)
    assert r.ok and part(r, "builtin.filler.left").width == mm((1305 - 1198) / 2 + 15)
    assert fit_to_niche(out) == out  # повторная подгонка ничего не меняет


# ---------- Шкаф: фальш-панели, ножки, без задней стенки ----------


def test_side_panel_to_floor_and_conflict_with_end_unit():
    t = load("wardrobe_2sec")
    t["side_panels"] = [{"side": "right"}]
    r = build(t)
    sp = part(r, "side_panel.right")
    box = sp.aabb()
    assert box.min.z == 0 and box.max.z == mm(t["height"]) and box.min.y == -mm(16)
    assert sp.edges == {"y0": "pvc_2", "x1": "pvc_2"} and sp.role == "false_panel"
    assert r.size[0] == mm(t["width"]) + sp.thickness
    t["end_units"] = [{"side": "right"}]
    assert "side_panel_end_unit" in codes(build(t))


def test_plinth_on_legs():
    t = load("wardrobe_2sec")
    t["body"] = {"plinth": {"height": 100, "legs": True, "floor_allowance": 5}}
    r = build(t)
    assert r.ok
    side = part(r, "body.side.left")
    assert side.aabb().min.z == mm(100)
    front = part(r, "body.plinth.front")
    assert front.aabb().min.z == mm(5) and front.width == mm(95) and front.length == mm(t["width"])
    assert {"body.plinth.left", "body.plinth.right"} <= {p.key for p in r.parts}  # свободностоящий — бока видны
    legs = [h for h in viewer_model(r)["hardware"] if h["kind"] == "leg"]
    assert legs and sum(h.qty for h in r.hardware if h.kind == "leg") == len(legs)
    t["installation"] = "niche"
    assert "body.plinth.left" not in {p.key for p in build(t).parts}


def test_back_none_wall_fixing_and_fix():
    t = load("wardrobe_2sec")
    t.setdefault("body", {})["back"] = {"kind": "none"}
    r = build(t)
    issue = next(i for i in r.issues if i.code == "back_none_wall")
    assert sum(h.qty for h in r.hardware if h.kind == "wall_anchor") == 2 * (len(t["sections"]) + 1)
    assert not any(p.role == "back" for p in r.parts)
    assert any(p.role == "back" for p in build(apply_fix(t, issue.fixes[0])).parts)


# ---------- Кухня ----------


def test_kitchen_builtin_parts():
    r = build(load("kitchen_builtin"))
    assert r.ok, [i.message for i in r.issues if i.level == "error"]
    keys = {p.key for p in r.parts}
    assert {"base[5].panel.left", "base[5].panel.right", "base[5].shelf", "base[5].roof", "base[5].top_panel",
            "base.side_panel.left", "wall.side_panel.left", "base[1].dw_front"} <= keys
    # Холодильник: без столешницы и цоколя над/под ним
    fridge = part(r, "base[5].panel.left").aabb()
    for key in ("countertop", "kitchen.plinth"):
        for p in r.parts:
            if p.key.startswith(key):
                assert p.aabb().max.x <= fridge.min.x
    # Столешница — над левой фальш-панелью (от x = 0)
    assert part(r, "countertop").aabb().min.x == 0
    # Посудомойка: фасад открывается вниз, крепёж в смете
    dw = next(n for n in r.nodes if n.id == "base[1].dw_front")
    assert dw.axis == "+X" and dw.kind == "rotate"
    assert any(h.kind == "dw_front_kit" for h in r.hardware)
    # Решётки в цоколе — под мойкой и духовкой (вырезы + строки)
    plinth = [p for p in r.parts if p.role == "plinth"]
    assert sum(len(p.cutouts) for p in plinth) == 2
    assert sum(h.qty for h in r.hardware if h.kind == "vent_grille") == 2
    assert all(p.aabb().min.z == mm(5) for p in plinth)
    # Добор до потолка из замера (2700): над верхними и над холодильником
    tops = [p for p in r.parts if p.role == "niche_filler"]
    assert tops and all(p.aabb().min.z == mm(1400 + 900) for p in tops)
    assert max(p.aabb().max.z for p in tops) == mm(2700 + 15)


def test_kitchen_fridge_position_and_wall_overlap():
    k = load("kitchen_builtin")
    k2 = copy.deepcopy(k)
    k2["base"].insert(1, k2["base"].pop())  # холодильник в середине ряда
    assert "fridge_position" in codes(build(k2))
    k3 = copy.deepcopy(k)
    k3["wall"][-1] = {"kind": "doors", "width": 650}
    assert "fridge_wall_overlap" in codes(build(k3))


def test_kitchen_side_panel_on_corner_end_rejected_and_run2():
    k = load("kitchen_corner")
    k["side_panels"] = [{"side": k.get("corner_side", "right")}]
    assert "side_panel_corner" in codes(build(k))
    k["side_panels"] = [{"side": "left"}, {"side": "left", "run": 2}]
    r = build(k)
    assert r.ok and {"base.side_panel.left", "base2.side_panel.right"} <= {p.key for p in r.parts}


def test_kitchen_plinth_sides_when_freestanding_and_top_filler_tall():
    k = load("kitchen_straight")
    k["installation"] = "freestanding"
    k["plinth"] = {"sides": "auto"}
    k["top_filler"] = {"ceiling": 3000}
    r = build(k)
    assert {"kitchen.plinth.left", "kitchen.plinth.right"} <= {p.key for p in r.parts}
    issue = next(i for i in r.issues if i.code == "top_filler_tall")
    fixed = apply_fix(k, issue.fixes[0])
    assert fixed["wall_to_ceiling"] is True and "top_filler" not in fixed
    k["top_filler"] = {}
    assert "top_filler_no_ceiling" in codes(build(k))


def test_kitchen_back_none_has_no_back_parts():
    k = load("kitchen_straight")
    k["body"]["back"] = {"kind": "none"}
    r = build(k)
    assert not any(p.role == "back" for p in r.parts) and "back_none_wall" in codes(r)


def test_old_kitchen_plinth_unchanged_by_default():
    r = build(load("kitchen_straight"))
    p = next(q for q in r.parts if q.role == "plinth")
    assert p.aabb().min.z == 0 and p.width == mm(100) and p.aabb().min.y == mm(50)


# ---------- Смета, файлы, 3D ----------


def test_estimate_lines_and_categories():
    r = build(load("kitchen_builtin"))
    e = estimate(r)
    keys = {line.key.split(":")[1] for line in e.lines if line.key.startswith("hw:")}
    assert {"vent_grille", "dw_front_kit", "wall_anchor"} <= keys
    grille = next(line for line in e.lines if line.key.startswith("hw:vent_grille"))
    assert grille.unit_price == 45_000 and grille.status == "analog"
    w = estimate(build(load("wardrobe_builtin")))
    oak = next(line for line in w.lines if line.key == "sheet:ldsp_18_oak")
    assert oak.category == "fronts"  # доборы и фальш-панели — вместе с фасадами
    er = estimate_range(load("wardrobe_builtin"), estimated=["/builtin/niche/width", "/builtin/niche/height"])
    assert er.total.low < er.expected < er.total.high  # до замера — полоса и для встроенного
    assert er.uncertainty[0].category == "sizes" and "по фото" in er.uncertainty[0].reason


def test_csv_dxf_and_spec_include_fillers():
    r = build(load("wardrobe_builtin"))
    rows = [row.split(";") for row in export_csv(r).decode("utf-8-sig").splitlines()]
    left = next(row for row in rows if row[1] == "Добор левый")
    assert left[6:10] == ["", "2", "", ""]  # кромка только Д2 (к фасадам), к стене — без кромки
    names = zipfile.ZipFile(io.BytesIO(export_dxf_zip(r))).namelist()
    assert f"{part(r, 'builtin.filler.left').number:03d}_builtin_filler_left.dxf" in names
    assert any("side_panel_left" in n for n in names) and any("builtin_strip_top" in n for n in names)


def test_viewer_room_block_and_glb_without_room():
    v = viewer_model(build(load("wardrobe_builtin")))
    room = v["room"]
    kinds = {w["kind"] for w in room["walls"]}
    assert {"wall_left", "wall_right", "wall_back", "floor", "ceiling"} <= kinds
    assert room["measured"] is True and room["niche"]["width"] == 2394 and room["niche"]["width_max"] == 2412
    left = next(w for w in room["walls"] if w["kind"] == "wall_left")
    right = next(w for w in room["walls"] if w["kind"] == "wall_right")
    assert left["lean"]["top"] == 0 and right["lean"] == {"bottom": 0, "middle": 6, "top": 18}
    assert room["colors"]["wall"] == "#E6E1D8" and room["colors"]["view_only"] is True
    assert room["colors"]["floor_material"] == "oak_light" and room["colors"]["floor"] == "#D9BF94"
    assert "room" not in viewer_model(build(load("wardrobe_2sec")))
    k = viewer_model(build(load("kitchen_builtin")))["room"]
    assert {o["kind"] for o in k["outlets"]} == {"water", "sewer", "socket"}
    fillers = [p for p in v["parts"] if p["role"] in ("niche_filler", "false_panel", "filler_strip")]
    assert fillers and all(p["node"] is None for p in fillers)
    glb = export_glb(build(load("wardrobe_builtin")))
    assert b"wall_left" not in glb and b"builtin.filler.left" in glb


@pytest.mark.parametrize("name", ["wardrobe_builtin", "kitchen_builtin"])
def test_no_intersections(name):
    r = build(load(name))
    assert "intersection" not in codes(r)


# ---------- Добор клином, пол комнаты ----------


def test_plumb_warning_offers_wedge_fix_and_wedge_follows_measurement():
    t = load("wardrobe_builtin")
    t["builtin"]["niche"].pop("lean")
    t["builtin"]["wedge"] = []
    r = build(t)
    issue = next(i for i in r.issues if i.code == "niche_out_of_plumb")
    assert "Стены ниши не параллельны" in issue.message and "вверху 2412" in issue.message
    fix = next(f for f in issue.fixes if f.description == "Добор клином")
    fixed = build(apply_fix(t, fix))
    assert fixed.product.builtin.wedge == ["left", "right"]
    left, right = part(fixed, "builtin.filler.left"), part(fixed, "builtin.filler.right")
    # Поровну: внизу 50, посередине 53, вверху 59 мм на сторону + 15 мм припуска; кромка к фасадам — прямая
    assert left.contour and right.contour and left.edges == {"y1": "pvc_2"}
    pts = [(left.contour.start_x, left.contour.start_y)] + [(s.x, s.y) for s in left.contour.segments]
    assert left.width == mm(74)
    assert [(0, mm(9)), (left.length // 2, mm(6)), (left.length, 0), (left.length, mm(74))] == pts[:4]
    fixed_issue = next(i for i in fixed.issues if i.code == "niche_out_of_plumb")
    assert not fixed_issue.fixes and "доборы клином" in fixed_issue.message


def test_top_wedge_from_floor_slope():
    t = wardrobe()
    t["builtin"]["niche"] = {"width": 2400, "height_left": 2700, "height_right": 2680}
    r = build(t)
    issue = next(i for i in r.issues if i.code == "niche_floor_slope")
    fixed = build(apply_fix(t, issue.fixes[0]))
    top = part(fixed, "builtin.filler.top")
    assert top.contour is not None and top.edges == {"y0": "pvc_2"} and "клином 30→50" in top.name
    ys = [s.y for s in top.contour.segments]
    assert max(ys) <= top.width and min(y for y in ys if y > 0) < top.width


def test_wedge_in_estimate_dxf_and_viewer():
    r = build(load("wardrobe_builtin"))
    e = estimate(r)
    line = next(line for line in e.lines if line.key == "service:wedge_cut")
    assert line.qty == 1 and line.unit_price == 15_000 and line.status == "analog"
    right = part(r, "builtin.filler.right")
    import ezdxf

    z = zipfile.ZipFile(io.BytesIO(export_dxf_zip(r)))
    name = next(n for n in z.namelist() if n.endswith("builtin_filler_right.dxf"))
    doc = ezdxf.read(io.StringIO(z.read(name).decode("utf-8", errors="ignore")))
    cut = [e for e in doc.modelspace() if e.dxf.layer == "CUT"]
    assert cut and len(list(cut[0].vertices())) == 5  # трапеция с точкой посередине
    vp = next(p for p in viewer_model(r)["parts"] if p["key"] == "builtin.filler.right")
    assert vp["contour"] and len(vp["contour"]["segments"]) == 5
    assert right.cut_width == right.width - mm(2)  # кромка только на прямой стороне


def test_room_colors_floor_presets_and_view_only():
    from mebel_core.room import FLOOR_MATERIALS

    assert set(FLOOR_MATERIALS) == {"oak_light", "walnut", "tile", "concrete", "carpet"}
    assert all(m["name"] and m["name_uz"] and m["color"].startswith("#") for m in FLOOR_MATERIALS.values())
    t = load("wardrobe_builtin")
    t["room_colors"] = {"floor_material": "walnut", "floor": "#112233", "walls_visible": False}
    colors = viewer_model(build(t))["room"]["colors"]
    assert colors["floor"] == "#112233" and colors["floor_texture"]["texture"] == "planks"
    assert colors["walls_visible"] is False and colors["view_only"] is True
    # Только для вида: детали, смета и файлы те же
    bare = load("wardrobe_builtin")
    bare.pop("room_colors")
    assert [p.model_dump() for p in build(t).parts] == [p.model_dump() for p in build(bare).parts]
    assert estimate(build(t)).cost_total == estimate(build(bare)).cost_total
    bad = load("wardrobe_builtin")
    bad["room_colors"] = {"floor_material": "marble"}
    with pytest.raises(Exception):
        build(bad)
