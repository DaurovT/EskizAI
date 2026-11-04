"""Декор фасадов, ручки-кнопки и Gola, подсветка (docs/decor_contract.md)."""

import copy
import io
import json
from pathlib import Path

import ezdxf
import pytest

from mebel_core import apply_patch, build, client_view, estimate, estimate_range, export_glb, part_dxf, viewer_model
from mebel_core.decor import MIN_INSET, inlay_paths, milling_paths, overlay_paths, path_points
from mebel_core.exports.csv_cut import export_csv
from mebel_core.units import mm

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def fronts(result):
    return [p for p in result.parts if p.role in ("door", "drawer_front")]


def wardrobe(style=None, material="mdf_19_paint", handles=None, **extra):
    t = {"width": 1200, "height": 2200, "depth": 600,
         "fronts": {"material": material, "style": style or {}, "handles": handles or {"kind": "bar"}},
         "sections": [{"fill": [{"kind": "drawers", "count": 2, "external": True, "height": 400},
                                {"kind": "shelves", "count": 3}], "doors": {"count": 1}},
                      {"fill": [{"kind": "rod"}], "doors": {"count": 1, "hinge": "right"}}]}
    t.update(extra)
    return t


SIZES = [(mm(400), mm(1800)), (mm(596), mm(716)), (mm(596), mm(176)), (mm(900), mm(250))]


@pytest.mark.parametrize("pattern", ["shaker", "classic", "arcs", "rhombus", "grooves_v", "grooves_h", "waves"])
@pytest.mark.parametrize("w,h", SIZES)
def test_milling_paths_stay_inside_inset(pattern, w, h) -> None:
    inset = mm(50)
    paths = milling_paths(pattern, w, h, inset, mm(8), 0, mm(40))
    if min(w, h) - 2 * inset < mm(60) and pattern not in ("grooves_v", "grooves_h", "waves"):
        return  # такие фасады ядро оставляет гладкими
    assert paths, pattern
    for c, _ in paths:
        for x, y in path_points(c):
            assert inset - 2 <= x <= w - inset + 2 and inset - 2 <= y <= h - inset + 2, (pattern, x, y)


def test_rhombus_becomes_lattice_on_tall_door_and_arcs_rise_from_width() -> None:
    tall = milling_paths("rhombus", mm(450), mm(2000), mm(60), mm(8), 0, mm(40))
    assert len(tall) >= 4  # рамка + решётка из ромбов
    (arch, _), = milling_paths("arcs", mm(500), mm(700), mm(60), mm(8), 0, mm(40))
    arc = next(s for s in arch.segments if s.kind == "arc")
    sag = mm(700) - mm(60) - arc.y  # стрела арки
    assert sag == round((mm(500) - 2 * mm(60)) * 0.25)


@pytest.mark.parametrize("pattern", ["frame", "arch", "rhombus", "moulding"])
def test_overlay_paths_inside(pattern) -> None:
    w, h = mm(500), mm(1500)
    for c, closed in overlay_paths(pattern, w, h, mm(50), mm(20)):
        assert closed
        assert all(0 < x < w and 0 < y < h for x, y in path_points(c))


@pytest.mark.parametrize("kind", ["frame", "line_h", "line_v", "edge"])
def test_inlay_paths_inside(kind) -> None:
    w, h = mm(500), mm(1500)
    paths = inlay_paths(kind, w, h, mm(40), mm(6), True)
    assert paths
    for c, _ in paths:
        assert all(0 <= x <= w and 0 <= y <= h for x, y in path_points(c))


def test_decor_on_fronts_in_part_coordinates_and_edge_distance() -> None:
    r = build(wardrobe({"milling": {"pattern": "shaker", "inset": 60}, "paint": {"code": "RAL 9001"}}))
    assert r.ok, r.issues
    for p in fronts(r):
        assert p.decor and p.decor.milling and p.edges == {}  # крашеный МДФ — без кромки
        for m in p.decor.milling:
            for x, y in path_points(m.path):
                assert MIN_INSET <= x <= p.length - MIN_INSET and MIN_INSET <= y <= p.width - MIN_INSET


def test_ldsp_milling_is_error_with_fix_to_mdf() -> None:
    t = wardrobe({"milling": {"pattern": "arcs"}}, material="ldsp_16_white")
    r = build(t)
    issue = next(i for i in r.issues if i.code == "decor_needs_mdf")
    assert issue.level == "error" and "МДФ" in issue.message
    fixed = apply_patch(t, issue.fixes[0].patch)
    assert fixed["fronts"]["material"] == "mdf_19_paint" and build(fixed).ok


def test_depth_and_inset_rules_with_fixes() -> None:
    t = wardrobe({"milling": {"pattern": "shaker", "depth": 15, "inset": 20}})
    r = build(t)
    codes = {i.code: i for i in r.issues}
    assert {"milling_too_deep", "milling_inset_small"} <= set(codes)
    assert codes["milling_too_deep"].fixes[0].patch[0].value == 13  # 19 − 6
    for code in ("milling_too_deep", "milling_inset_small"):
        t = apply_patch(t, codes[code].fixes[0].patch)
    assert build(t).ok


def test_per_door_override_and_drawer_fronts_scale() -> None:
    t = wardrobe({"milling": {"pattern": "shaker"}})
    t["sections"][1]["doors"]["style"] = {"milling": {"pattern": "arcs"}}
    t["sections"][0]["fill"][0]["style"] = {"milling": {"pattern": "none"}}
    r = build(t)
    by = {p.key: p for p in fronts(r)}
    assert by["sections[1].doors.door[1]"].decor.milling_pattern == "arcs"
    assert by["sections[0].doors.door[1]"].decor.milling_pattern == "shaker"
    assert by["sections[0].fill[0].drawer[1].front"].decor is None


def test_milling_moves_away_from_hinge_cups_on_thin_mdf() -> None:
    from mebel_core.decor import _conflicts

    t = wardrobe({"inlay": {"kind": "frame", "inset": 40, "width": 6}}, material="mdf_16_paint")
    r = build(t)
    door = next(p for p in r.parts if p.key == "sections[0].doors.door[1]")
    paths = [m.path for m in door.decor.inlay]
    # чашка 13 мм + паз 4 мм при толщине 16 — путь сдвинут внутрь и чашку не задевает
    assert not _conflicts(door, paths, mm(3), mm(4))
    assert min(min(x, y) for x, y in path_points(paths[0])) > mm(40)


def test_rounded_corners_need_edge_radius_or_paint() -> None:
    t = wardrobe({"corners": {"radius": 10}}, material="ldsp_18_white")
    issue = next(i for i in build(t).issues if i.code == "front_radius_edge")
    assert issue.fixes[0].patch[0].value == 30
    ok = build(wardrobe({"corners": {"radius": 10}, "paint": {"code": "RAL 9003"}}))
    door = fronts(ok)[0]
    assert ok.ok and door.contour is not None and door.decor.radius == mm(10)


def test_knob_is_one_hole_and_gola_has_no_holes() -> None:
    r = build(wardrobe(handles={"kind": "knob", "finish": "gold"}))
    for p in fronts(r):
        assert len([h for h in p.holes if h.purpose == "ручка"]) == 1
    hw = viewer_model(r)["hardware"]
    knobs = [h for h in hw if h["kind"] == "knob"]
    assert len(knobs) == len(fronts(r)) and {h["finish"] for h in knobs} == {"gold"}
    g = build(wardrobe(handles={"kind": "gola"}, hardware={"hinge": "push"}))
    assert all(not [h for h in p.holes if h.purpose == "ручка"] for p in fronts(g))
    assert "push_with_handles" not in {i.code for i in g.issues}


def test_gola_kitchen_notches_sides_and_lowers_fronts() -> None:
    k = load("kitchen_decor")
    r = build(k)
    side = next(p for p in r.parts if p.key == "base[1].side.left")
    assert side.contour is not None and len(side.contour.segments) > 4
    plain = copy.deepcopy(k)
    plain["fronts"]["handles"] = {"kind": "bar"}
    p0 = {p.key: p for p in build(plain).parts}
    door = next(p for p in r.parts if p.key == "base[1].doors.door[1]")
    assert p0[door.key].length - door.length == mm(30)
    names = {h.kind for h in r.hardware}
    assert {"gola_profile", "gola_fittings"} <= names and "handle" not in names
    assert any(h["kind"] == "gola" for h in viewer_model(r)["hardware"])


def test_lighting_under_wall_grooves_and_power_supply() -> None:
    r = build(load("kitchen_decor"))
    assert len(r.lights) == 3  # над вытяжкой подсветки нет
    bottom = next(p for p in r.parts if p.key == "wall[0].bottom")
    assert any(g.purpose == "паз под LED-профиль" and g.face == "B" for g in bottom.grooves)
    psu = next(h for h in r.hardware if h.kind == "power_supply")
    total = sum(lr.length for lr in r.lights) / 10000  # м
    assert psu.params["watts"] >= total * 9.6 * 1.2 and psu.qty == 1
    lights = viewer_model(r)["lights"]
    assert lights[0]["temp"] == 3000 and lights[0]["profile"] == {"width": 17.0, "height": 7.0}


def test_lighting_in_wardrobe_niche_is_clipped_to_section() -> None:
    r = build(load("wardrobe_decor"))
    niche = next(lr for lr in r.lights if lr.zone == "niche")
    sec = next(s for s in r.sections if s.key == "sections[1]")
    assert sec.x0 <= min(niche.start[0], niche.end[0]) and max(niche.start[0], niche.end[0]) <= sec.x1
    assert {h.kind for h in r.hardware} >= {"led_profile", "led_strip", "led_sensor", "power_supply"}


def test_no_place_for_light_is_a_warning() -> None:
    r = build(wardrobe(lighting=[{"zone": "under_wall"}]))
    assert "light_no_place" in {i.code for i in r.issues} and not r.lights


def test_estimate_lines_and_client_view() -> None:
    t = load("wardrobe_decor")
    e = estimate(build(t))
    lines = {line.key: line for line in e.lines if line.key.startswith("decor:")}
    names = {line.client_name for line in lines.values()}
    assert "Фрезеровка «Шейкер», 5 фасадов" in names
    assert "Фрезеровка «Арка», 2 фасада" in names
    face = lines["decor:paint:matte:RAL 9001:face"]
    back = lines["decor:paint:matte:RAL 9001:back"]
    assert face.unit == "м²" and back.unit_price == face.unit_price // 2 and face.status == "analog"
    assert any(n.startswith("Латунная рамка, 4 фасада") for n in names)
    assert any(n.startswith("Подсветка в нише") and n.endswith("3000 K") for n in names)
    assert all(line.status == "analog" and line.unit_price > 0 for line in lines.values())
    view = client_view(estimate_range(t, measured=True), "detailed")
    assert "Фрезеровка «Шейкер», 5 фасадов" in {g["name"] for g in view["groups"]}
    k = estimate(build(load("kitchen_decor")))
    kn = {line.client_name for line in k.lines}
    assert any(n.startswith("Подсветка под навесными, 1,7 м, 3000 K") for n in kn)
    assert any(n.startswith("Золотой кант по краю") for n in kn) and any(n.startswith("Профиль Gola") for n in kn)


def test_dxf_layers_for_milling_inlay_and_led_groove() -> None:
    r = build(load("wardrobe_decor"))

    def layers(key):
        p = next(q for q in r.parts if q.key == key)
        return {e.dxf.layer for e in ezdxf.read(io.StringIO(part_dxf(p).decode())).modelspace()}

    door = layers("sections[0].doors.door[1]")
    assert {"MILLING_B_W8_Z3", "INLAY_B_W6_Z4"} <= door and not any(x.startswith("EDGE_") for x in door)
    assert "GROOVE_B_W17_Z7" in layers("body.top")
    csv = export_csv(r).decode("utf-8-sig")
    assert "Обработка" in csv.splitlines()[0] and "фрезеровка «Шейкер»" in csv and "паз LED 17×7" in csv


def test_viewer_decor_and_glb() -> None:
    r = build(load("kitchen_decor"))
    v = viewer_model(r)
    d = next(p for p in v["parts"] if p["key"] == "base[1].doors.door[1]")["decor"]
    assert d["paint"]["color"] == "#2F4A3F" and d["milling"][0]["path"][0]["kind"] == "move"
    assert d["inlay"][0]["finish"] == "gold" and d["inlay"][0]["edge"]
    assert "brass" in v["hardwareFinishes"] and "gold" in v["hardwareFinishes"]
    glb = export_glb(r)
    assert b"decor_gold" in glb and b"led_3000" in glb


def test_old_trees_have_no_decor() -> None:
    r = build(load("wardrobe_2sec"))
    v = viewer_model(r)
    assert v["lights"] == [] and not any("decor" in p for p in v["parts"])
    assert "decor" not in r.module_versions
