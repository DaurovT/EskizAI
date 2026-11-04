"""Угловая кухня (Г-образный угловой модуль, карусель, столешница) и замер кухни (стены, окно, коммуникации)."""

import copy
import io
import json
import zipfile
from pathlib import Path

import pytest

from mebel_core import apply_measurements, build, estimate, export_dxf_zip, fit_kitchen, hardware_options
from mebel_core.estimate import _scaled_tree
from mebel_core.units import mm

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def codes(r) -> set[str]:
    return {i.code for i in r.issues}


def errors(r) -> list[str]:
    return [i.message for i in r.issues if i.level == "error"]


def square(side: str = "right", width: int = 900, fill: str = "blind") -> dict:
    t = load("kitchen_corner")
    t["corner_side"] = side
    t["base"][-1] = {"kind": "corner", "width": width, "corner_shape": "square", "corner_fill": fill}
    if side == "left":
        t["base"] = list(reversed(t["base"]))
    return t


# --- Угловой модуль ---


@pytest.mark.parametrize("side", ["right", "left"])
@pytest.mark.parametrize("width", [900, 1000])
@pytest.mark.parametrize("fill", ["blind", "carousel", "swing"])
def test_square_corner_builds_on_both_walls(side: str, width: int, fill: str) -> None:
    r = build(square(side, width, fill))
    assert r.ok, errors(r)
    # Стена Б = угловой модуль + второй ряд (1200); глубина изделия считается от передней кромки столешницы
    assert r.size[2] == mm(width + 1200 - 40)
    leg = [p for p in r.parts if p.module.startswith("base2.corner")]
    assert {p.role for p in leg} >= {"side", "bottom", "rail", "back", "door"}
    kinds = {h.kind for h in r.hardware}
    assert ("corner_carousel" in kinds) == (fill == "carousel")
    assert ("corner_swing" in kinds) == (fill == "swing")
    shelves = [p for p in r.parts if p.role == "shelf" and p.module.startswith("base[")]
    assert bool(shelves) == (fill == "blind")


def test_carousel_rules() -> None:
    long = load("kitchen_corner")
    long["base"][-1]["corner_fill"] = "carousel"
    assert "carousel_needs_square" in codes(build(long))

    odd = square(width=950)
    assert "corner_square_size" in codes(build(odd))

    deep = square(fill="carousel")
    deep["base_depth"] = 650  # проём 900 − 650 = 250 мм — дверь не открыть
    assert "corner_opening_narrow" in codes(build(deep))

    narrow = load("kitchen_corner")
    narrow["base"][-1] = {"kind": "corner", "width": 1000, "corner_fill": "swing"}
    assert "corner_opening_narrow" in codes(build(narrow))  # глухой модуль 1000: проём 372 мм < 400
    narrow["base"][-1]["width"] = 1100
    assert build(narrow).ok


def test_carousel_in_estimate_and_hardware_options() -> None:
    t = square(fill="carousel")
    e = estimate(build(t))
    line = next(x for x in e.lines if x.key.startswith("hw:corner_carousel"))
    assert line.unit_price > 0 and line.status == "analog"

    group = hardware_options(square())[0]
    assert group.key == "corner_fill" and "900×900" in group.title
    opts = {o.value: o for o in group.options}
    assert opts["blind"].current and opts["carousel"].delta > opts["swing"].delta > 0
    assert opts["carousel"].patch[0].path == "/base/2/corner_fill"

    long = {o.value: o for o in hardware_options(load("kitchen_corner"))[0].options}
    assert not long["carousel"].available and "Г-образный" in long["carousel"].note
    assert long["swing"].available


def test_estimate_range_keeps_corner_size() -> None:
    scaled = _scaled_tree(square(fill="carousel"), 1.1)
    assert scaled["base"][-1]["width"] == 900
    assert build(scaled).ok


# --- Столешница ---


def test_countertop_longer_than_slab_is_split_with_warning() -> None:
    t = load("kitchen_straight")  # 2850 мм — цельная
    r = build(t)
    assert len([p for p in r.parts if p.role == "countertop"]) == 1 and "countertop_joint" not in codes(r)
    t["base"].append({"kind": "doors", "width": 400})  # 3250 мм > 3050
    r = build(t)
    pieces = [p for p in r.parts if p.role == "countertop"]
    assert len(pieces) == 2 and max(p.length for p in pieces) <= mm(3050)
    assert "countertop_joint" in codes(r) and any(h.kind == "countertop_joint" for h in r.hardware)


def test_corner_countertop_two_pieces_cutout_and_files() -> None:
    r = build(square())
    pieces = [p for p in r.parts if p.role == "countertop"]
    assert len(pieces) == 2  # Г-образная: два куска, стык под 90° с планкой
    assert sum(1 for h in r.hardware if h.kind == "countertop_joint") == 1
    # Второй кусок начинается от передней кромки первого: 900 − 600 + 1200
    assert sorted(p.length for p in pieces) == [mm(1200 + 900 - 600), mm(450 + 800 + 900)]
    sink_top = next(p for p in pieces if p.cutouts)
    assert len(sink_top.cutouts) == 1
    e = estimate(r)
    assert next(x for x in e.lines if x.key == "service:countertop_cutout").qty == 1
    meters = sorted(x.qty for x in e.lines if x.group == "Столешница" and x.unit == "м")
    assert meters == [1.5, 2.2]
    names = zipfile.ZipFile(io.BytesIO(export_dxf_zip(r))).namelist()
    assert sum("countertop" in n for n in names) == 2


def test_wall_gap_has_no_parts() -> None:
    r = build(load("kitchen_corner_square"))
    assert r.ok, errors(r)
    assert not [p for p in r.parts if p.module == "wall[2]"]
    rail = next(h for h in r.hardware if h.kind == "mount_rail" and h.module == "wall")
    assert rail.params["length"] == mm(1600)  # 600 + 600 + 400, без проёма 1200


# --- Замер кухни ---

DESIGN_SITE = {
    "wall_a": 2810, "wall_b": 1795, "ceiling": 2680,
    "window": {"wall": "a", "from_corner": 1200, "width": 1200, "sill": 900},
    "utilities": [
        {"kind": "water", "wall": "a", "from_corner": 1650, "height": 500},
        {"kind": "sewer", "wall": "a", "from_corner": 1700, "height": 300},
        {"kind": "gas", "wall": "a", "from_corner": 600, "height": 900},
        {"kind": "socket", "wall": "a", "from_corner": 300, "height": 1100},
        {"kind": "vent", "wall": "b", "from_corner": 200, "size": "200×150"},
    ],
}


def design_tree() -> dict:
    t = load("kitchen_corner_square")
    t["base"] = [t["base"][0], t["base"][3], t["base"][2], t["base"][1]]  # мойка у угла, варка у дальней стены
    t["wall"] = [{"kind": "doors", "width": 600}, {"kind": "doors", "width": 800}, {"kind": "doors", "width": 450},
                 {"kind": "hood", "width": 600}]
    return t


def test_design_measure_fits_walls_outlets_and_window() -> None:
    t, notes = fit_kitchen(design_tree(), DESIGN_SITE)
    # Стена Б короче на 5 мм: бутылочница 450 → 445, цена та же
    assert [c["width"] for c in t["base2"]] == [450, 445]
    assert any("445" in n for n in notes)
    # Стена А длиннее на 10 мм, подгонять нечего — зазор под фальш-планку
    assert any("зазор 10" in n for n in notes)
    # Варка ушла к газу (600 от угла), мойка — ближе к воде
    hob = next(c for c in t["base"] if c.get("hob"))
    assert t["base"].index(hob) == 1
    # Над окном (1200–2400 от угла) верхних нет
    x, over = 0, []
    for c in t["wall"]:
        if c["kind"] != "gap" and x < 2400 and 1200 < x + c["width"]:
            over.append(c)
        x += c["width"]
    assert not over and any(c["kind"] == "gap" for c in t["wall"])
    r = build(t)
    assert r.ok, errors(r)
    assert t["site"]["wall_a"] == 2810
    assert {"site_gas_far", "site_wall_window", "site_sink_water"}.isdisjoint(codes(r))
    assert "site_hob_window" in codes(r)  # окно почти во всю стену — варка всё равно под ним


def test_straight_kitchen_sink_over_water_and_hob_over_gas() -> None:
    t = load("kitchen_straight")  # ящики 400, двери 600, техника 600 (под вытяжкой), мойка 800, двери 450
    site = {"wall_a": 2850, "utilities": [{"kind": "water", "from_corner": 300, "height": 500},
                                          {"kind": "gas", "from_corner": 2800, "height": 1300}]}
    before = build({**t, "site": site})
    assert {"site_sink_water", "site_gas_far"} <= codes(before)
    new, notes = fit_kitchen(t, site)
    kinds = [c["kind"] for c in new["base"]]
    assert kinds.index("sink") == 0
    r = build(new)
    assert r.ok and {"site_sink_water", "site_gas_far"}.isdisjoint(codes(r)), [i.message for i in r.issues]
    assert any("мойку" in n for n in notes) and any("варку" in n for n in notes)
    # Вытяжка переехала вслед за варкой
    hob = next(i for i, c in enumerate(new["base"]) if c.get("hob"))
    x_hob = sum(c["width"] for c in new["base"][:hob]) + new["base"][hob]["width"] / 2
    x, hood_center = 0, None
    for c in new["wall"]:
        if c["kind"] == "hood":
            hood_center = x + c["width"] / 2
        x += c["width"]
    assert hood_center == x_hob


def test_corner_water_on_wall_b_moves_sink_to_second_run() -> None:
    t = load("kitchen_corner")
    site = {"wall_a": 2350, "wall_b": 2000, "utilities": [{"kind": "water", "wall": "b", "from_corner": 1500}]}
    new, notes = fit_kitchen(t, site)
    assert any(c["kind"] == "sink" for c in new["base2"]) and not any(c["kind"] == "sink" for c in new["base"])
    assert any("стену Б" in n for n in notes)
    assert build(new).ok
    # Ряды после переноса не сходятся со стенами — мойка остаётся, мастеру — пояснение
    tight = {**site, "wall_b": 1800}
    new, notes = fit_kitchen(t, tight)
    assert any(c["kind"] == "sink" for c in new["base"]) and any("не перенести" in n for n in notes)


def test_ceiling_sets_wall_height_to_ceiling() -> None:
    t = load("kitchen_straight")
    t["wall_to_ceiling"] = True
    new, _ = fit_kitchen(t, {"wall_a": 2850, "ceiling": 2680})
    assert new["wall_height"] == 2680 - 30 - 1400
    low = load("kitchen_straight")
    r = build({**low, "site": {"wall_a": 2850, "ceiling": 2000}})
    assert "site_ceiling" in codes(r)
    new, notes = fit_kitchen(low, {"wall_a": 2850, "ceiling": 2000})
    assert new["wall_height"] == 2000 - 30 - 1400 and notes


def test_site_warnings() -> None:
    t = load("kitchen_straight")
    t["base"][2]["hob"] = True  # техника 600 рядом с мойкой? нет — между ними ничего: 1000–1600, мойка 1600–2400
    site = {"wall_a": 2850, "window": {"from_corner": 900, "width": 800, "sill": 1000},
            "utilities": [{"kind": "socket", "from_corner": 2000, "height": 1100},
                          {"kind": "gas", "from_corner": 100, "height": 1500},
                          {"kind": "vent", "from_corner": 2800}]}
    r = build({**t, "site": site})
    c = codes(r)
    assert {"site_hob_sink", "site_socket", "site_gas_far", "site_hob_window", "site_wall_window"} <= c
    assert "site_hood_vent" not in c  # вытяжка 1000–1600, вентканал 2800: 1200 мм — можно
    far = {**site, "utilities": [{"kind": "vent", "from_corner": 3400}], "wall_a": 3500}
    assert {"site_hood_vent", "site_wall_a"} <= codes(build({**t, "site": far}))


def test_apply_measurements_with_kitchen_site() -> None:
    t = load("kitchen_straight")
    new = apply_measurements(t, kitchen={"wall_a": 2900})
    assert sum(c["width"] for c in new["base"]) == 2900 and new["site"]["wall_a"] == 2900
    with pytest.raises(ValueError):
        apply_measurements(copy.deepcopy(t), kitchen={"wall_a": 1500})
