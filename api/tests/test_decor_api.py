"""Декор фасадов и подсветка через API: списки для выбора, сохранение дерева, исправления, варианты фурнитуры."""

from .conftest import load_tree


def test_front_styles_with_previews_and_price_hints(api, client, owner):
    r = client.get("/catalog/front-styles", headers=owner)
    assert r.status_code == 200, r.text
    d = r.json()
    ids = [m["id"] for m in d["milling"]]
    assert ids == ["shaker", "classic", "arcs", "rhombus", "grooves_v", "grooves_h", "waves"]
    arcs = next(m for m in d["milling"] if m["id"] == "arcs")
    assert arcs["requires"] == ["mdf"] and arcs["preview"][0].startswith("M") and " A" in arcs["preview"][0]
    assert arcs["price_hint"] == {"price": 130000, "unit": "фасад", "status": "analog"}
    assert {i["id"] for i in d["inlay"]} == {"frame", "line_h", "line_v", "edge"}
    assert next(i for i in d["inlay"] if i["id"] == "edge")["requires"] == []
    assert {h["id"] for h in d["handles"]} == {"bar", "knob", "gola", "none"}
    assert d["paint_material"] == "mdf_19_paint" and len(d["paint"]["gloss"]) == 3
    emp = api.employee(owner, "+998935550001", "Менеджер")
    assert client.get("/catalog/front-styles", headers=emp).json()["milling"][0]["price_hint"] is None


def test_lighting_zones(client, owner):
    d = client.get("/catalog/lighting-zones", headers=owner).json()
    assert {z["id"] for z in d["zones"]} == {"under_wall", "niche", "shelf", "wardrobe_rod", "plinth", "inside_top"}
    assert [t["value"] for t in d["temps"]] == [3000, 4000, 6000]
    assert d["price_hint"]["profile"]["price"] == 65000


def test_save_decor_tree_and_viewer(api, client, owner):
    pid = api.project(owner, tree=load_tree("kitchen_decor"))
    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    assert not [i for i in v["issues"] if i["level"] == "error"]
    door = next(p for p in v["viewer"]["parts"] if p["key"] == "base[1].doors.door[1]")
    assert door["decor"]["paint"]["code"] == "RAL 6009" and door["decor"]["milling"]
    assert len(v["viewer"]["lights"]) == 3
    est = client.get(f"/projects/{pid}/estimate", headers=owner)
    assert est.status_code == 200


def test_bad_decor_value_is_rejected(api, client, owner):
    tree = load_tree("wardrobe_full")
    tree["fronts"] = {"style": {"milling": {"pattern": "spiral"}}}
    pid = api.project(owner, tree=None)
    r = client.post(f"/projects/{pid}/model", json={"tree": tree}, headers=owner)
    assert r.status_code == 422


def test_ldsp_milling_error_and_fix_to_mdf(api, client, owner):
    tree = load_tree("wardrobe_full")
    tree["fronts"] = {"material": "ldsp_16_white", "style": {"milling": {"pattern": "shaker"}}}
    pid = api.project(owner, tree=tree)
    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    idx = next(i for i, x in enumerate(v["issues"]) if x["code"] == "decor_needs_mdf")
    r = client.post(f"/projects/{pid}/model/fixes", json={"issue_index": idx, "fix_index": 0}, headers=owner)
    assert r.status_code == 201, r.text
    nv = r.json()["version"]
    assert nv["tree"]["fronts"]["material"] == "mdf_19_paint"
    assert "decor_needs_mdf" not in {x["code"] for x in nv["issues"]}


def test_hardware_knob_and_lighting_options(api, client, owner):
    pid = api.project(owner, tree=load_tree("wardrobe_full"))
    h = client.get(f"/projects/{pid}/hardware", headers=owner).json()
    keys = {g["key"] for g in h["groups"]}
    assert {"handles", "handle_finish", "lighting"} <= keys
    r = client.post(f"/projects/{pid}/hardware", json={"key": "handles", "value": "knob"}, headers=owner)
    assert r.status_code == 201, r.text
    assert r.json()["version"]["tree"]["fronts"]["handles"]["kind"] == "knob"
    r = client.post(f"/projects/{pid}/hardware", json={"key": "lighting", "value": "inside_top"}, headers=owner)
    assert r.status_code == 201, r.text
    v = r.json()["version"]
    assert v["tree"]["lighting"][0]["zone"] == "inside_top" and v["viewer"]["lights"]
