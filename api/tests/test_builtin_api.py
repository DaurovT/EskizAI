"""Встроенная мебель через API: варианты для выбора, замер ниши в трёх точках, доборы и исправления,
блок room в 3D, цвет стен и пола с фото пустой ниши (подставной ИИ)."""

import io
import json

import pytest

from mebel_ai import LLM
from mebel_api.deps import get_llm

from .conftest import load_tree
from .fake_anthropic import FakeClient, design, response

NICHE = {"width_top": 1312, "width_middle": 1300, "width_bottom": 1296, "height_left": 2500, "height_right": 2494,
         "depth": 620}


@pytest.fixture
def fake(app):
    holder = FakeClient([])
    app.dependency_overrides[get_llm] = lambda: LLM(client=holder)
    yield holder
    app.dependency_overrides.clear()


def test_builtin_options(api, client, owner):
    r = client.get("/catalog/builtin-options", headers=owner)
    assert r.status_code == 200, r.text
    d = r.json()
    assert [s["id"] for s in d["fillers"]["sides"]] == ["left", "right", "top"]
    assert d["fillers"]["defaults"]["scribe"] == 15 and d["fillers"]["defaults"]["allowance_side"] == 10
    assert {g["id"] for g in d["plinth"]["kitchen"]["grilles"]} == {"sink", "oven"}
    assert d["limits"] == {"filler_min": 20, "filler_max": 150, "plumb_tolerance": 15, "door_clearance": 30,
                           "top_panel_max": 600}
    assert d["price_hint"]["vent_grille"] == {"price": 45000, "unit": "шт", "status": "analog"}
    emp = api.employee(owner, "+998935550002", "Менеджер")
    assert client.get("/catalog/builtin-options", headers=emp).json()["price_hint"] is None


def test_niche_measurement_makes_builtin_version(api, client, owner):
    pid = api.project(owner, tree=load_tree("wardrobe_2sec"))
    api.advance(owner, pid, "sketch")
    r = client.post(f"/projects/{pid}/measurements", json={"niche": NICHE}, headers=owner)
    assert r.status_code == 201, r.text
    m = r.json()
    assert m["data"]["niche"]["width_bottom"] == 1296 and m["niche"]["height_right"] == 2494
    assert (m["width"], m["height"], m["depth"]) == (1296, 2494, 620)
    assert m["applied_version_id"] and not m["apply_error"]
    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    assert v["label"] == "Замер ниши: ширина 1296–1312, высота 2494–2500"
    t = v["tree"]
    assert t["installation"] == "niche" and t["builtin"]["niche"]["width_top"] == 1312
    assert (t["width"], t["height"]) == (1296 - 100, 2494 - 50)
    codes = {i["code"] for i in v["issues"]}
    assert "niche_out_of_plumb" in codes  # 1312 − 1296 = 16 > 15
    room = v["viewer"]["room"]
    assert room["measured"] and room["niche"]["width"] == 1296
    assert {"builtin.filler.left", "builtin.filler.right", "builtin.filler.top"} <= \
        {p["key"] for p in v["viewer"]["parts"]}
    assert client.get(f"/projects/{pid}/measurements", headers=owner).json()[-1]["niche"]["depth"] == 620


def test_niche_measurement_validation(api, client, owner):
    pid = api.project(owner, tree=load_tree("wardrobe_2sec"))
    api.advance(owner, pid, "sketch")
    r = client.post(f"/projects/{pid}/measurements", json={"niche": {"width_top": -5}}, headers=owner)
    assert r.status_code == 422


def test_builtin_tree_fix_and_bad_value(api, client, owner):
    tree = load_tree("wardrobe_builtin")
    tree["width"] = 1900  # доборы по ~240 мм — шире 150
    pid = api.project(owner, tree=tree)
    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    idx = next(i for i, x in enumerate(v["issues"]) if x["code"] == "filler_too_wide")
    r = client.post(f"/projects/{pid}/model/fixes", json={"issue_index": idx, "fix_index": 0}, headers=owner)
    assert r.status_code == 201, r.text
    nv = r.json()["version"]
    assert nv["tree"]["width"] == 2276 and "filler_too_wide" not in {x["code"] for x in nv["issues"]}
    bad = load_tree("wardrobe_builtin")
    bad["builtin"]["fillers"] = ["front"]
    assert client.post(f"/projects/{pid}/model", json={"tree": bad}, headers=owner).status_code == 422


def test_kitchen_builtin_estimate_has_new_lines(api, client, owner):
    pid = api.project(owner, "Кухня", tree=load_tree("kitchen_builtin"))
    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    assert not [i for i in v["issues"] if i["level"] == "error"]
    assert v["viewer"]["room"]["outlets"] and v["viewer"]["room"]["colors"]["source"] == "manual"
    est = client.get(f"/projects/{pid}/estimate", headers=owner)
    assert est.status_code == 200
    assert "вентиляционная" in est.text and "посудомойки" in est.text


def _niche_photo() -> bytes:
    """Фото пустой ниши: стена сверху (бежевая, с тёмной тенью и бликом), пол снизу (коричневый)."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (200, 200), (232, 224, 210))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 150, 199, 199), fill=(120, 86, 60))
    d.rectangle((10, 10, 30, 60), fill=(40, 40, 40))  # тень
    d.rectangle((60, 10, 70, 60), fill=(255, 255, 255))  # блик
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_empty_niche_photo_room_colors_and_manual_override(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    ph = client.post(f"/projects/{pid}/photos", files={"file": ("n.png", _niche_photo(), "image/png")},
                     headers=owner).json()
    tree = {"type": "wardrobe", "width": 1700, "height": 2650, "depth": 600, "installation": "niche",
            "builtin": {"niche": {"width": 1800, "height": 2700}, "fillers": ["left", "right", "top"]},
            "sections": [{"fill": [{"kind": "rod"}], "doors": {"count": 2}},
                         {"fill": [{"kind": "shelves", "count": 5}], "doors": {"count": 2}}]}
    room = {"photo": 0, "wall_region": [0.0, 0.0, 0.5, 0.5], "floor_region": [0.0, 0.8, 1.0, 1.0],
            "wall_color_hint": "#FFFFFF", "floor_color_hint": "not-a-colour"}
    reply = design(tree=tree, room=room, product_kind="встроенный шкаф",
                   estimated=["/builtin/niche/width", "/builtin/niche/height", "/width", "/height"])
    reply["tree_json"] = json.dumps(tree)
    fake.replies.append(response(reply))
    r = client.post(f"/projects/{pid}/ai/design", json={"text": "сюда встроить шкаф", "photo_ids": [ph["id"]]},
                    headers=owner)
    out = client.get(f"/tasks/{r.json()['task_id']}", headers=owner).json()["result"]
    assert out["status"] == "ready", out
    assert out["room"]["wall_region"] == [0.0, 0.0, 0.5, 0.5]
    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    colors = v["tree"]["room_colors"]
    # Медиана средней полосы яркости: тень и блик не влияют, цвет — с фото, а не из подсказки
    assert {k: colors[k] for k in ("wall", "floor", "source")} == {"wall": "#E8E0D2", "floor": "#78563C",
                                                                  "source": "photo"}
    assert v["viewer"]["room"]["colors"]["wall"] == "#E8E0D2"
    assert "/builtin/niche/width" in v["estimated"]
    # Мастер выбрал цвет сам — обычной правкой модели
    manual = v["tree"] | {"room_colors": {"wall": "#D0D8E0", "floor": "#555555", "source": "manual"}}
    r2 = client.post(f"/projects/{pid}/model", json={"tree": manual}, headers=owner)
    assert r2.status_code in (200, 201), r2.text
    got = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["viewer"]["room"]["colors"]
    assert {k: got[k] for k in ("wall", "floor", "source", "view_only")} == \
        {"wall": "#D0D8E0", "floor": "#555555", "source": "manual", "view_only": True}


def test_room_colors_keep_manual_and_fallback_to_hint():
    from types import SimpleNamespace

    from mebel_api.services.room_colors import region_color, with_room_colors

    room = SimpleNamespace(photo=0, wall_region=[0.1, 0.1, 0.4, 0.4], floor_region=[], wall_color_hint="#abcdef",
                           floor_color_hint="#112233")
    assert with_room_colors({"room_colors": {"wall": "#000000", "source": "manual"}}, room, [b"x"]) == \
        {"room_colors": {"wall": "#000000", "source": "manual"}}
    assert with_room_colors({}, room, [b"broken"])["room_colors"] == {"wall": "#ABCDEF", "floor": "#112233",
                                                                       "source": "photo"}
    assert region_color(_niche_photo(), [0.5, 0.5, 0.5, 0.9]) is None  # пустая рамка


def test_builtin_options_wedge_and_floor_presets(api, client, owner):
    d = client.get("/catalog/builtin-options", headers=owner).json()
    assert d["wedge"]["field"] == "builtin.wedge" and d["wedge"]["price_hint"]["price"] == 15000
    assert [m["id"] for m in d["room"]["floor_materials"]] == ["oak_light", "walnut", "tile", "concrete", "carpet"]
    oak = d["room"]["floor_materials"][0]
    assert oak["name"] == "Дуб светлый" and oak["name_uz"] and oak["color"] == "#D9BF94"
    assert d["room"]["view_only"] is True and "lean" in d["niche_fields"]


def test_wedge_fix_through_api_and_room_view_only(api, client, owner):
    tree = load_tree("wardrobe_builtin")
    tree["builtin"]["wedge"] = []
    pid = api.project(owner, tree=tree)
    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    idx = next(i for i, x in enumerate(v["issues"]) if x["code"] == "niche_out_of_plumb")
    fi = next(i for i, f in enumerate(v["issues"][idx]["fixes"]) if f["description"] == "Добор клином")
    r = client.post(f"/projects/{pid}/model/fixes", json={"issue_index": idx, "fix_index": fi}, headers=owner)
    assert r.status_code == 201, r.text
    nv = r.json()["version"]
    right = next(p for p in nv["viewer"]["parts"] if p["key"] == "builtin.filler.right")
    assert right["contour"] and "клином" in right["name"]
    # Пол комнаты — правкой модели; «только для вида»: смета не меняется
    before = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    t = nv["tree"] | {"room_colors": {"floor_material": "tile", "walls_visible": False, "source": "manual"}}
    assert client.post(f"/projects/{pid}/model", json={"tree": t}, headers=owner).status_code in (200, 201)
    room = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["viewer"]["room"]
    assert room["colors"]["floor"] == "#C9C7C2" and room["colors"]["walls_visible"] is False
    after = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert {k: v for k, v in after.items() if k != "priced_at"} == {k: v for k, v in before.items() if k != "priced_at"}
    bad = t | {"room_colors": {"floor_material": "marble"}}
    assert client.post(f"/projects/{pid}/model", json={"tree": bad}, headers=owner).status_code == 422
