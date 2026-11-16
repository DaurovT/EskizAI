"""Кухня: подъёмные фасады, ниша под технику в верхнем ряду, антресольный ярус, полка на столешнице."""

import copy
import io
import json
import zipfile
from pathlib import Path

import pytest

from mebel_core import apply_fix, build, estimate, export_csv, export_dxf_zip, export_glb, nest, parse_tree, viewer_model
from mebel_core.hw3d import hardware_visuals
from mebel_core.units import mm

FIXTURES = Path(__file__).parent / "fixtures"
KITCHENS = sorted(p.stem for p in FIXTURES.glob("kitchen_*.json"))


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def errors(r) -> list[str]:
    return [i.message for i in r.issues if i.level == "error"]


def codes(r) -> set[str]:
    return {i.code for i in r.issues}


def kitchen(wall: list[dict], **kw) -> dict:
    t = load("kitchen_straight")
    t["wall"] = wall
    t.update(kw)
    return t


def parts(r, prefix: str) -> list:
    return [p for p in r.parts if p.module == prefix or p.module.startswith(prefix + ".")
            or p.key.startswith(prefix + ".")]


def hw(r, kind: str, module: str | None = None) -> int:
    return sum(h.qty for h in r.hardware if h.kind == kind and (module is None or h.module.startswith(module)))


# --- Совместимость ---


@pytest.mark.parametrize("name", KITCHENS)
def test_existing_kitchens_unchanged(name: str) -> None:
    """Старые кухни не задействуют новые модули; дерево после схемы (с новыми полями по умолчанию) собирается
    так же (детали — побайтно; полный эталон — test_golden)."""
    t = load(name)
    r = build(t)
    assert "kitchen_wall_ext" not in r.module_versions and "kitchen_mid" not in r.module_versions
    dumped = parse_tree(t).model_dump(mode="json", exclude_none=True)
    assert all(k not in c for c in dumped.get("wall", [])
               for k in ("opening", "flaps", "appliance", "above", "top", "lift_type"))
    again = build(dumped)
    assert [p.model_dump() for p in again.parts] == [p.model_dump() for p in r.parts]
    assert [n.model_dump() for n in again.nodes] == [n.model_dump() for n in r.nodes]


# --- Подъёмные фасады ---


def test_lift_single_flap_on_hood() -> None:
    r = build(kitchen([{"kind": "hood", "width": 600, "opening": "lift"}]))
    assert r.ok, errors(r)
    flaps = [p for p in r.parts if ".flap[" in p.key]
    assert len(flaps) == 1 and flaps[0].role == "door" and flaps[0].name == "Фасад подъёмный"
    f = flaps[0]
    assert f.length == mm(360) - mm(2) and f.width == mm(600) - mm(2)  # высота вытяжки 360, зазор 2
    node = next(n for n in r.nodes if n.id == f.node)
    assert node.kind == "lift" and node.axis == "-X" and node.range == 100
    assert node.origin[2] == f.aabb().max.z  # ось — по верхней кромке
    assert not [n for n in r.nodes if n.module == "wall[0]" and n.kind == "rotate"]  # нет вертикальных петель
    cups = [h for h in f.holes if h.purpose == "чашка петли"]
    assert len(cups) == 2 and all(h.x == f.length - mm(22.5) for h in cups)  # петли — по верхней кромке
    assert hw(r, "gas_lift", "wall[0]") == 1 and hw(r, "hinge", "wall[0]") == 2
    handle = [h for h in f.holes if h.purpose == "ручка"]
    assert len(handle) == 2 and handle[0].x == handle[1].x == mm(50)  # горизонтально у нижней кромки


def test_lift_two_flaps_stacked() -> None:
    r = build(kitchen([{"kind": "doors", "width": 800, "opening": "lift", "flaps": 2, "shelves": 2}]))
    assert r.ok, errors(r)
    flaps = sorted((p for p in r.parts if ".flap[" in p.key), key=lambda p: p.aabb().min.z)
    assert len(flaps) == 2
    lo, hi = flaps
    assert lo.aabb().max.z < hi.aabb().min.z  # друг над другом
    assert all(mm(250) <= p.length <= mm(600) for p in flaps)
    assert [p.key for p in r.parts if p.key == "wall[0].lift_shelf"]  # неподвижная полка под петли нижнего
    assert hw(r, "gas_lift", "wall[0]") == 4  # шире 600 — два газлифта на фасад
    assert {n.kind for n in r.nodes if n.module == "wall[0]"} == {"lift"}
    shelves = [p for p in r.parts if p.role == "shelf" and p.module.startswith("wall[0]")]
    assert len(shelves) == 2  # неподвижная + одна съёмная
    e = estimate(r)
    line = next(ln for ln in e.lines if ln.name == "Подъёмный механизм (газлифт)")
    assert line.qty == 4 and line.unit_price == 250_000 and line.status == "analog"


def test_lift_flap_height_rule_and_fix() -> None:
    auto = build(kitchen([{"kind": "doors", "width": 600, "opening": "lift"}]))  # 720, число не задано → 2
    assert auto.ok and len([p for p in auto.parts if p.key.startswith("wall[0].flap")]) == 2
    one = build(kitchen([{"kind": "doors", "width": 600, "opening": "lift"}], wall_height=700))  # до 700 — один
    assert one.ok and len([p for p in one.parts if p.key.startswith("wall[0].flap")]) == 1
    assert "lift_flap_height" not in codes(one)
    t = kitchen([{"kind": "doors", "width": 600, "opening": "lift", "flaps": 1}])  # 720 одним фасадом
    r = build(t)
    issue = next(i for i in r.issues if i.code == "lift_flap_height")
    assert issue.level == "warning" and r.ok  # 700–900 — бывает на усиленном газлифте
    fixed = apply_fix(t, issue.fixes[0])
    assert fixed["wall"][0]["flaps"] == 2 and build(fixed).ok
    tall = kitchen([{"kind": "doors", "width": 600, "opening": "lift", "flaps": 1}], wall_height=1000)
    r = build(tall)
    issue = next(i for i in r.issues if i.code == "lift_flap_height")
    assert issue.level == "error" and not r.ok
    assert build(apply_fix(tall, issue.fixes[0])).ok
    low = kitchen([{"kind": "hood", "width": 600, "opening": "lift", "flaps": 2}])  # 2 × 178 мм
    r = build(low)
    issue = next(i for i in r.issues if i.code == "lift_flap_height")
    assert build(apply_fix(low, issue.fixes[0])).ok


# --- Ниша под технику ---


def test_microwave_niche() -> None:
    r = build(kitchen([{"kind": "appliance", "width": 600}]))
    assert r.ok, errors(r)
    bottom = next(p for p in r.parts if p.key == "wall[0].bottom").aabb()
    shelf = next(p for p in r.parts if p.key == "wall[0].niche_shelf").aabb()
    assert shelf.min.z - bottom.max.z == mm(380)  # ниша в свету
    doors = [p for p in r.parts if p.role == "door" and p.module.startswith("wall[0]")]
    assert doors and all(d.aabb().min.z > shelf.min.z for d in doors)  # фасад только над нишей
    assert "appliance_niche" in codes(r)
    e = estimate(r)
    assert not [ln for ln in e.lines if "икроволнов" in ln.name]  # технику покупает клиент
    vis = [h for h in hardware_visuals(r) if h.kind == "appliance"]
    assert vis and vis[0].name == "Микроволновка (клиента)"


def test_appliance_above_variants_and_rules() -> None:
    lift = build(kitchen([{"kind": "appliance", "width": 600, "above": "lift"}], wall_height=760))
    assert lift.ok, errors(lift)
    assert [n for n in lift.nodes if n.kind == "lift"]
    opened = build(kitchen([{"kind": "appliance", "width": 600, "above": "open", "shelves": 1}], wall_height=900))
    assert opened.ok and not [p for p in opened.parts if p.role == "door" and p.key.startswith("wall")]
    alone = build(kitchen([{"kind": "appliance", "width": 600, "above": "none"}]))
    assert alone.ok, errors(alone)
    side = next(p for p in alone.parts if p.key == "wall[0].side.left")
    assert side.length == mm(380) + 2 * mm(16)
    assert not [p for p in alone.parts if p.key == "wall[0].niche_shelf"]
    low = build(kitchen([{"kind": "appliance", "width": 600, "niche_height": 340}]))
    assert "appliance_niche_low" in codes(low) and not low.ok
    short = build(kitchen([{"kind": "appliance", "width": 600, "height": 450}]))
    assert "appliance_cabinet_low" in codes(short)
    oven = build(kitchen([{"kind": "appliance", "width": 600, "appliance": "oven", "height": 1000}]))
    assert oven.ok and "appliance_niche_shallow" in codes(oven)


def test_microwave_niche_frame() -> None:
    t = kitchen([{"kind": "appliance", "width": 600, "niche_frame": True}])
    r = build(t)
    assert r.ok, errors(r)
    frame = next(p for p in r.parts if p.key == "wall[0].niche_frame")
    assert frame.name == "Рамка ниши" and frame.role == "false_panel" and frame.material == "ldsp_18_oak"
    shelf = next(p for p in r.parts if p.key == "wall[0].niche_shelf").aabb()
    door = next(p for p in r.parts if p.role == "door" and p.key.startswith("wall[0].")).aabb()
    fb = frame.aabb()
    assert fb.min.z == mm(1400 + 1) and fb.max.z == door.min.z - mm(2)  # от низа модуля до стыка с фасадом
    assert fb.min.y == door.min.y  # в плоскости фасадов
    assert shelf.min.z < fb.max.z < shelf.max.z
    assert len(frame.cutouts) == 1  # вырез под технику — контур для ЧПУ
    xs = [s.x for s in frame.cutouts[0].segments]
    assert min(xs) == mm(45) and max(xs) == frame.length - mm(45)
    vis = [h for h in hardware_visuals(r) if h.kind == "appliance"]
    assert len(vis) == 1 and vis[0].name == "Микроволновка (клиента)"  # одна позиция на нишу
    assert vis[0].shapes[0]["min"][1] > fb.max.y  # техника — за рамкой
    e = estimate(r)
    assert not [ln for ln in e.lines if "икроволнов" in ln.name]
    fronts = next(ln for ln in e.lines if ln.key == "sheet:ldsp_18_oak")
    assert fronts.category == "fronts"  # рамка — из фасадного материала, считается с фасадами
    assert export_glb(r)[:4] == b"glTF"
    assert "Рамка ниши" in export_csv(r).decode("utf-8-sig")
    plain = build(kitchen([{"kind": "appliance", "width": 600}]))
    assert not [p for p in plain.parts if p.key.endswith("niche_frame")]
    tight = build(kitchen([{"kind": "appliance", "width": 500, "niche_frame": True}]))
    assert "niche_frame_tight" in codes(tight)


def test_wall_doors_two_rows() -> None:
    t = kitchen([{"kind": "doors", "width": 800, "doors": 2, "rows": 2, "shelves": 3,
                  "top": {"height": 350, "doors": 2}}], wall_height=1200)
    r = build(t)
    assert r.ok, errors(r)
    doors = sorted((p for p in r.parts if p.role == "door" and p.key.startswith("wall[0].")
                    and not p.key.startswith("wall[0].tier")), key=lambda p: (p.aabb().min.z, p.aabb().min.x))
    assert [p.key for p in doors] == ["wall[0].doors.door[1]", "wall[0].doors.door[2]",
                                      "wall[0].doors[2].door[1]", "wall[0].doors[2].door[2]"]
    lo, hi = doors[0].aabb(), doors[2].aabb()
    assert lo.max.z < hi.min.z and abs((lo.max.z - lo.min.z) - (hi.max.z - hi.min.z)) <= mm(1)  # пополам
    shelf = next(p for p in r.parts if p.key == "wall[0].row_shelf").aabb()
    assert shelf.min.z < lo.max.z + mm(1) <= hi.min.z - mm(1) < shelf.max.z  # стык рядов — по полке
    loose = [p for p in r.parts if p.role == "shelf" and ".fill[" in p.key and p.key.startswith("wall[0].")
             and not p.key.startswith("wall[0].tier")]
    assert len(loose) == 2  # 3 полки = неподвижная + по одной в ряду
    for d in doors:  # ручки — у нижней кромки каждой двери (модуль высоко)
        handle = [h for h in d.holes if h.purpose == "ручка"]
        assert handle and max(h.x for h in handle) < d.length / 2
    rotate = [n for n in r.nodes if n.kind == "rotate" and n.module.startswith("wall[0]")]
    assert len(rotate) == 6  # 2 ряда × 2 + ярус 2
    assert hw(r, "handle", "wall[0]") == 6
    one = build(kitchen([{"kind": "doors", "width": 600}]))
    assert "kitchen_wall_ext" not in one.module_versions  # без rows — как раньше
    low = build(kitchen([{"kind": "doors", "width": 600, "rows": 2, "height": 400}]))
    assert "wall_rows_low" in codes(low)
    lift = build(kitchen([{"kind": "doors", "width": 600, "rows": 2, "opening": "lift"}]))
    assert "wall_rows_ignored" in codes(lift)


def test_open_niche_below_lift_flap() -> None:
    t = kitchen([{"kind": "doors", "width": 450, "opening": "lift", "flaps": 1, "open_bottom": 480,
                  "shelves": 2}], wall_height=1200)
    r = build(t)
    assert r.ok, errors(r)
    flaps = [p for p in r.parts if ".flap[" in p.key]
    assert len(flaps) == 1 and not [p for p in r.parts if p.role == "door" and p.key.startswith("wall[0].doors")]
    bottom = next(p for p in r.parts if p.key == "wall[0].bottom").aabb()
    shelf = next(p for p in r.parts if p.key == "wall[0].niche_shelf").aabb()
    assert shelf.min.z - bottom.max.z == mm(480)  # открытая ниша в свету
    f = flaps[0].aabb()
    assert shelf.min.z < f.min.z < shelf.max.z and f.max.z == mm(1400 + 1200 - 1)  # фасад — над нишей
    assert mm(250) <= flaps[0].length <= mm(700) and "lift_flap_height" not in codes(r)
    loose = [p for p in r.parts if p.role == "shelf" and p.key.startswith("wall[0].fill[")]
    assert len(loose) == 2
    zs = sorted(p.aabb().min.z for p in loose)
    assert bottom.max.z < zs[0] < shelf.min.z < zs[1]  # полка в нише и полка за фасадом
    assert sum(1 for n in r.nodes if n.kind == "lift") == 1
    assert not [i for i in r.issues if i.code.startswith("appliance") and i.path.startswith("wall")]  # не техника
    hinged = build(kitchen([{"kind": "doors", "width": 600, "open_bottom": 300}], wall_height=900))
    assert hinged.ok and [p for p in hinged.parts if p.role == "door" and p.key.startswith("wall[0].doors")]
    big = build(kitchen([{"kind": "doors", "width": 600, "open_bottom": 700}]))
    assert "open_bottom_tall" in codes(big)


# --- Антресольный ярус ---


def test_tier_explicit_inside_column() -> None:
    r = build(kitchen([{"kind": "doors", "width": 600, "top": {"height": 350, "doors": 2}}], wall_height=1100))
    assert r.ok, errors(r)
    main = next(p for p in r.parts if p.key == "wall[0].side.left").aabb()
    tier = next(p for p in r.parts if p.key == "wall[0].tier.side.left").aabb()
    assert tier.min.z == main.max.z and tier.max.z - tier.min.z == mm(350)
    assert main.min.z == mm(1400) and tier.max.z == mm(1400 + 1100)  # низ — с рядом, верх — верх ряда
    tdoors = [p for p in r.parts if p.role == "door" and p.key.startswith("wall[0].tier.")]
    assert len(tdoors) == 2
    assert {p.role for p in parts(r, "wall[0].tier")} >= {"side", "top", "bottom", "back", "door"}


def test_tier_auto_fills_to_ceiling() -> None:
    t = kitchen([{"kind": "doors", "width": 600, "top": {}}, {"kind": "doors", "width": 600}],
                site={"wall_a": 3000, "ceiling": 2700})
    r = build(t)
    assert r.ok, errors(r)
    tier = next(p for p in r.parts if p.key == "wall[0].tier.side.left").aabb()
    assert tier.min.z == mm(1400 + 720) and tier.max.z == mm(2700 - 30)
    assert r.size[1] == mm(2670)
    no_ceiling = build(kitchen([{"kind": "doors", "width": 600, "top": {"opening": "lift"}}]))
    assert no_ceiling.ok, errors(no_ceiling)
    tier = next(p for p in no_ceiling.parts if p.key == "wall[0].tier.side.left").aabb()
    assert tier.max.z - tier.min.z == mm(350) and tier.max.z == mm(2120)
    assert [n for n in no_ceiling.nodes if n.kind == "lift" and n.module == "wall[0].tier"]


def test_tier_with_top_filler_and_rules() -> None:
    t = kitchen([{"kind": "doors", "width": 600, "top": {}}, {"kind": "doors", "width": 600}],
                site={"wall_a": 3000, "ceiling": 2700}, top_filler={})
    r = build(t)
    assert r.ok, errors(r)
    fillers = [p for p in r.parts if p.role == "niche_filler"]
    assert fillers and min(p.aabb().min.z for p in fillers) == mm(2120)  # над модулем без яруса
    big = build(kitchen([{"kind": "doors", "width": 600, "top": {"height": 600}}], wall_height=700))
    assert "wall_tier_tall" in codes(big)
    lift = kitchen([{"kind": "doors", "width": 600, "opening": "lift", "flaps": 1}], wall_height=720)
    r = build(lift)
    issue = next(i for i in r.issues if i.code == "lift_flap_height")
    assert build(apply_fix(lift, issue.fixes[0])).ok
    assert build(kitchen([{"kind": "doors", "width": 600, "opening": "lift", "flaps": 1}], wall_height=600)).ok


# --- Полка на столешнице ---


def test_countertop_shelf_unit() -> None:
    t = kitchen([{"kind": "doors", "width": 600}, {"kind": "doors", "width": 600}],
                mid=[{"x": 650, "width": 400, "shelves": 1}])
    r = build(t)
    assert r.ok, errors(r)
    unit = parts(r, "mid[0]")
    assert {p.role for p in unit} >= {"side", "top", "bottom", "back", "shelf"}
    side = next(p for p in unit if p.key == "mid[0].side.left").aabb()
    ct = next(p for p in r.parts if p.role == "countertop").aabb()
    assert side.min.z == ct.max.z and side.max.z == mm(1400)  # от столешницы до низа верхних
    back = next(p for p in unit if p.role == "back").aabb()
    assert side.min.x == mm(650) and back.max.y == mm(560)  # к стене
    assert hw(r, "bracket", "mid[0]") == 2
    assert not [p for p in unit if p.node]  # открытая — без фасадов


def test_countertop_shelf_rules() -> None:
    base = kitchen([{"kind": "doors", "width": 600}])
    outside = build({**base, "mid": [{"x": 2700, "width": 300}]})  # ряд 2850
    assert "mid_outside_run" in codes(outside)
    tall = build({**base, "mid": [{"x": 0, "width": 300, "height": 700}]})
    issue = next(i for i in tall.issues if i.code == "mid_too_tall")
    assert build(apply_fix({**base, "mid": [{"x": 0, "width": 300, "height": 700}]}, issue.fixes[0])).ok
    overlap = build({**base, "mid": [{"x": 0, "width": 300}, {"x": 200, "width": 300}]})
    assert "mid_overlap" in codes(overlap)
    hob = copy.deepcopy(base)
    hob["base"][2]["hob"] = True  # варка на модуле 1000–1600
    assert "mid_over_hob" in codes(build({**hob, "mid": [{"x": 1100, "width": 300}]}))
    under_tall = kitchen([{"kind": "doors", "width": 600, "height": 1000}], mid=[{"x": 0, "width": 300}])
    r = build(under_tall)  # модуль 1000 опускается до 1120 — полка ниже
    assert r.ok, errors(r)
    assert next(p for p in r.parts if p.key == "mid[0].side.left").aabb().max.z == mm(1400 + 720 - 1000)


# --- Фото владельца: всё вместе, все выходы ---


def owner_photo() -> dict:
    return {
        "type": "kitchen", "installation": "niche", "wall_bottom": 1450, "wall_height": 1200,
        "base": [{"kind": "sink", "width": 600, "doors": 2}, {"kind": "doors", "width": 400},
                 {"kind": "drawers", "width": 500, "drawers": 3}, {"kind": "doors", "width": 600}],
        "wall": [{"kind": "doors", "width": 700, "doors": 2, "top": {"height": 350, "doors": 2}},
                 {"kind": "doors", "width": 500, "opening": "lift", "flaps": 2, "height": 800},
                 {"kind": "appliance", "width": 600, "above": "lift", "flaps": 2}],
        "mid": [{"x": 1500, "width": 400, "shelves": 1}],
    }


def test_owner_photo_kitchen_all_outputs() -> None:
    r = build(owner_photo())
    assert r.ok, errors(r)
    assert {"kitchen_wall_ext", "kitchen_mid"} <= set(r.module_versions)
    vm = viewer_model(r)
    assert sum(1 for n in vm["nodes"] if n["kind"] == "lift") == 4
    assert any(h["kind"] == "gas_lift" for h in vm["hardware"])
    names = zipfile.ZipFile(io.BytesIO(export_dxf_zip(r))).namelist()
    assert len(names) >= len({p.number for p in r.parts if p.role not in ("countertop",)}) // 2
    assert "Фасад подъёмный" in export_csv(r).decode("utf-8-sig")
    assert nest(r).materials
    assert export_glb(r, opened=True)[:4] == b"glTF"
    e = estimate(r)
    assert any(ln.name == "Подъёмный механизм (газлифт)" and ln.qty == 4 for ln in e.lines)


def test_corner_kitchen_lift_on_second_run() -> None:
    t = load("kitchen_corner")
    t["wall2"] = [{"kind": "hood", "width": 600, "opening": "lift"}] + t.get("wall2", [])[1:]
    r = build(t)
    assert r.ok, errors(r)
    node = next(n for n in r.nodes if n.kind == "lift")
    assert node.axis in ("+Y", "-Y")  # ряд повернут — ось вдоль второй стены


# --- Складной подъёмник (lift_type=fold, Aventos HF) ---


def _fold(**kw) -> dict:
    return {"kind": "doors", "width": 900, "opening": "lift", "lift_type": "fold", "shelves": 2, **kw}


def test_fold_lift_parts_nodes_hardware() -> None:
    r = build(kitchen([_fold()]))
    assert r.ok, errors(r)
    up = next(p for p in r.parts if p.key == "wall[0].fold[1]")
    low = next(p for p in r.parts if p.key == "wall[0].fold[2]")
    assert up.role == low.role == "door" and up.length == low.length and up.width == low.width == mm(898)
    assert low.aabb().max.z + mm(2) == up.aabb().min.z  # стык — зазор фасадов, без полки
    assert not [p for p in r.parts if p.key.startswith("wall[0].") and ("lift_shelf" in p.key or ".flap[" in p.key)]
    shelves = [p for p in r.parts if p.role == "shelf" and p.module.startswith("wall[0]")]
    assert len(shelves) == 2  # обе полки — съёмные, как заданы
    nodes = {n.id: n for n in r.nodes if n.module == "wall[0]"}
    nu, nl = nodes["wall[0].fold[1]"], nodes["wall[0].fold[2]"]
    assert (nu.kind, nu.axis, nu.range, nu.parent) == ("lift", "-X", 100, None)
    assert nu.origin[2] == up.aabb().max.z and nu.origin[1] == up.aabb().max.y  # верхняя кромка, внутренняя сторона
    assert (nl.kind, nl.axis, nl.range, nl.parent) == ("lift", "+X", 180, "wall[0].fold[1]")
    assert nl.origin[2] == (up.aabb().min.z + low.aabb().max.z) // 2 and nl.origin[1] == nu.origin[1]
    # Петли: верхний — по верхней кромке и соединительные у стыка; ручка — только на нижнем
    assert len([h for h in up.holes if h.purpose == "чашка петли"]) == 2
    assert len([h for h in up.holes if h.purpose == "чашка петли соединительной"]) == 2
    assert not [h for h in up.holes if h.purpose == "ручка"] and [h for h in low.holes if h.purpose == "ручка"]
    assert hw(r, "fold_lift", "wall[0]") == 1 and hw(r, "gas_lift", "wall[0]") == 0
    assert hw(r, "hinge", "wall[0]") == 4
    assert any(h.name.startswith("Петля соединительная") and h.qty == 2 for h in r.hardware)
    wide = build(kitchen([_fold(width=1200)]))
    assert wide.ok and hw(wide, "hinge", "wall[0]") == 6  # шире 900 — по 3 петли
    e = estimate(r)
    line = next(ln for ln in e.lines if ln.name == "Подъёмник складной (2 фасада)")
    assert line.qty == 1 and line.unit_price == 1_200_000 and line.status == "analog"
    joint = next(ln for ln in e.lines if ln.name.startswith("Петля соединительная"))
    assert joint.qty == 2 and joint.unit_price > 0
    vis = hardware_visuals(r)
    assert len([v for v in vis if v.kind == "fold_lift"]) == 2  # механизм на обеих боковинах
    cups = [v for v in vis if v.id.startswith("wall[0].fold[1].joint[")]
    assert {v.node for v in cups} == {"wall[0].fold[1]", "wall[0].fold[2]"}  # чашка и плечо — каждый со своим
    vm = viewer_model(r)
    assert next(n for n in vm["nodes"] if n["id"] == "wall[0].fold[2]")["parent"] == "wall[0].fold[1]"


def test_fold_lift_opened_glb_folds_above_cabinet() -> None:
    import numpy as np

    from mebel_core.glb import scene_items

    r = build(kitchen([_fold()]))
    top = next(p for p in r.parts if p.key == "wall[0].top").aabb().max.z
    front_t = next(p for p in r.parts if p.key == "wall[0].fold[1]").thickness
    closed = {n: m.bounds for n, _, m, _, _ in scene_items(r) if ".fold[" in n and not n.startswith("hw:")}
    opened = {n: m.bounds for n, _, m, _, _ in scene_items(r, opened=True) if ".fold[" in n and not n.startswith("hw:")}
    assert len(opened) == 2
    for name, b in opened.items():
        lo_z, hi_z = b[0][1] * 1e4, b[1][1] * 1e4  # glTF: y — высота, м → dmm
        assert lo_z >= top - front_t - mm(1), name  # сложенный пакет — над модулем
        assert hi_z > top
        assert b[1][1] - b[0][1] < 0.2  # лежит, а не висит
    # Без учёта родителя нижний фасад повернулся бы на 180° сам по себе — ушёл бы в корпус
    lo = next(b for n, b in opened.items() if n.endswith("fold[2]"))
    hi = next(b for n, b in opened.items() if n.endswith("fold[1]"))
    assert np.allclose(lo[1][2], hi[1][2], atol=0.01)  # оба выдвинуты к нам одинаково
    assert export_glb(r, opened=True)[:4] == b"glTF"
    assert closed and all(b[0][1] * 1e4 < top for b in closed.values())


def test_fold_lift_rules_and_fixes() -> None:
    low = kitchen([{"kind": "hood", "width": 600, "opening": "lift", "lift_type": "fold"}])  # 360 мм
    r = build(low)
    issue = next(i for i in r.issues if i.code == "lift_fold_height")
    assert issue.level == "error" and not r.ok
    assert [f.description for f in issue.fixes] == ["Один подъёмный фасад вместо складного",
                                                    "Распашная дверь вместо подъёмной"]
    fixed = apply_fix(low, issue.fixes[0])
    assert fixed["wall"][0]["lift_type"] is None and build(fixed).ok
    assert build(apply_fix(low, issue.fixes[1])).ok
    tall = kitchen([_fold()], wall_height=1200)
    r = build(tall)
    issue = next(i for i in r.issues if i.code == "lift_fold_height")
    assert not r.ok and issue.fixes[0].description == "Два отдельных подъёмных фасада друг над другом"
    fixed = apply_fix(tall, issue.fixes[0])
    assert fixed["wall"][0]["flaps"] == 2 and build(fixed).ok
    ok = build(kitchen([_fold()], wall_height=1000))  # до 1040 вместе — можно
    assert ok.ok and "lift_fold_height" not in codes(ok)
    hinged = build(kitchen([{"kind": "doors", "width": 600, "lift_type": "fold"}]))  # без opening=lift
    assert hinged.ok and "wall_fold_ignored" in codes(hinged)
    assert not [p for p in hinged.parts if ".fold[" in p.key] and [p for p in hinged.parts if ".door[" in p.key]
    flaps = build(kitchen([_fold(flaps=1)]))  # flaps у складного не учитывается
    assert flaps.ok and len([p for p in flaps.parts if ".fold[" in p.key]) == 2


def test_fold_lift_over_niches_and_on_second_run() -> None:
    t = kitchen([_fold(open_bottom=300, height=1000, shelves=2),
                 {"kind": "appliance", "width": 600, "above": "lift", "lift_type": "fold", "height": 1000}])
    r = build(t)
    assert r.ok, errors(r)
    for i in (0, 1):
        assert {f"wall[{i}].fold[1]", f"wall[{i}].fold[2]", f"wall[{i}].niche_shelf"} <= {p.key for p in r.parts}
    c = load("kitchen_corner")
    c["wall2"] = [{"kind": "doors", "width": 800, "opening": "lift", "lift_type": "fold"}] + c.get("wall2", [])[1:]
    r = build(c)
    assert r.ok, errors(r)
    up, low = (next(n for n in r.nodes if n.id == f"wall2[0].fold[{k}]") for k in (1, 2))
    assert up.axis in ("+Y", "-Y") and low.axis in ("+Y", "-Y") and up.axis != low.axis
    assert export_glb(r, opened=True)[:4] == b"glTF"
