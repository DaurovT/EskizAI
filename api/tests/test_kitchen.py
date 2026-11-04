"""Кухня: замер помещения (SCR-13b) и угловой модуль с каруселью (SCR-37b)."""

from .conftest import load_tree

SITE = {
    "wall_a": 2850,
    "ceiling": 2680,
    "window": {"wall": "a", "from_corner": 1000, "width": 600, "sill": 900},
    "utilities": [
        {"kind": "water", "wall": "a", "from_corner": 300, "height": 500},
        {"kind": "sewer", "wall": "a", "from_corner": 350, "height": 300},
        {"kind": "gas", "wall": "a", "from_corner": 2500, "height": 900},
        {"kind": "socket", "wall": "a", "from_corner": 2000, "height": 1100},
    ],
}


def test_kitchen_measurement_stored_in_data_and_applied(api, client, owner):
    pid = api.project(owner, "Кухня", tree=load_tree("kitchen_straight"))
    api.advance(owner, pid, "sketch")
    r = client.post(f"/projects/{pid}/measurements", json={"kitchen": SITE, "data": {"plinth": 100}}, headers=owner)
    assert r.status_code == 201, r.text
    m = r.json()
    assert m["data"]["plinth"] == 100 and m["data"]["kitchen"]["wall_a"] == 2850
    assert m["kitchen"]["utilities"][0]["kind"] == "water" and m["width"] == 2850
    assert m["applied_version_id"] and not m["apply_error"]
    assert any("мойку" in n for n in m["apply_notes"])

    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    assert v["label"].startswith("Замер кухни") and v["tree"]["site"]["wall_a"] == 2850
    assert v["tree"]["base"][0]["kind"] == "sink"  # мойка встала к воде (300 мм от угла)
    # Окно 1000–1600: над ним верхних нет
    x = 0
    for c in v["tree"]["wall"]:
        assert c["kind"] == "gap" or not (x < 1600 and 1000 < x + c["width"]), v["tree"]["wall"]
        x += c["width"]
    codes = {i["code"] for i in v["issues"]}
    assert "site_sink_water" not in codes and "site_wall_window" not in codes

    listed = client.get(f"/projects/{pid}/measurements", headers=owner).json()
    assert listed[-1]["kitchen"]["window"]["width"] == 600


def test_kitchen_measurement_that_does_not_fit_keeps_version(api, client, owner):
    pid = api.project(owner, "Кухня", tree=load_tree("kitchen_straight"))
    api.advance(owner, pid, "sketch")
    before = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["id"]
    r = client.post(f"/projects/{pid}/measurements", json={"kitchen": {"wall_a": 1200}}, headers=owner)
    assert r.status_code == 201
    assert r.json()["apply_error"] and r.json()["applied_version_id"] is None
    assert client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["id"] == before


def test_kitchen_measurement_validation(api, client, owner):
    pid = api.project(owner, "Кухня", tree=load_tree("kitchen_straight"))
    api.advance(owner, pid, "sketch")
    bad = {"wall_a": 2850, "utilities": [{"kind": "steam", "from_corner": 100}]}
    assert client.post(f"/projects/{pid}/measurements", json={"kitchen": bad}, headers=owner).status_code == 422


def test_corner_fill_switch_via_hardware(api, client, owner):
    tree = load_tree("kitchen_corner")
    tree["base"][-1] = {"kind": "corner", "width": 900, "corner_shape": "square"}
    pid = api.project(owner, "Угловая кухня", tree=tree)
    h = client.get(f"/projects/{pid}/hardware", headers=owner).json()
    group = h["groups"][0]
    assert group["key"] == "corner_fill"
    opts = {o["value"]: o for o in group["options"]}
    assert opts["blind"]["current"] and opts["carousel"]["delta"] > opts["swing"]["delta"] > 0
    r = client.post(f"/projects/{pid}/hardware", json={"key": "corner_fill", "value": "carousel"}, headers=owner)
    assert r.status_code == 201, r.text
    assert r.json()["version"]["tree"]["base"][-1]["corner_fill"] == "carousel"
    est = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert "Карусель" in str(est)
