"""Эскиз изделия в списке проектов (Projects.dc.html, миниатюра .pi): summary.sketch версии и поле sketch списка."""

import time

from sqlalchemy import select

from mebel_api.models import ModelVersion
from mebel_api.services.sketch import sketch_from_tree

from .conftest import load_tree


def test_wardrobe_sketch_from_tree():
    s = sketch_from_tree(load_tree("wardrobe_full"))
    assert s["kind"] == "wardrobe" and (s["w"], s["h"], s["d"]) == (1800, 2400, 600)
    assert s["mezz"] == 400 and s["sliding"] == 0 and s["plinth"] == 70
    assert [c["doors"] for c in s["cols"]] == [1, 2, 1]
    assert s["cols"][0]["hinge"] == "left" and s["cols"][2]["hinge"] == "right"
    # секции 570 + авто + 570 в свету 1800 − 4·16
    assert [c["w"] for c in s["cols"]] == [570, 596, 570]
    assert s["cols"][1]["zones"][0] == {"t": "drawers", "n": 3, "h": 600, "ext": True}


def test_kupe_rack_and_kitchen_sketch():
    kupe = sketch_from_tree(load_tree("kupe_3doors"))
    assert kupe["sliding"] == 3 and len(kupe["cols"]) == 3
    rack = sketch_from_tree(load_tree("wardrobe_2sec"))
    assert [c["doors"] for c in rack["cols"]] == [0, 0]
    assert [c["zones"][0]["n"] for c in rack["cols"]] == [4, 5]

    k = sketch_from_tree(load_tree("kitchen_straight"))
    assert k["kind"] == "kitchen" and k["layout"] == "straight"
    assert k["w"] == sum(m["w"] for m in k["base"]) and k["base"] and k["wall"]
    assert k["h"] == k["wall_z"] + k["wall_h"] and k["top_t"] == 38
    corner = sketch_from_tree(load_tree("kitchen_corner_square"))
    assert corner["layout"] == "corner" and corner["base2"] and corner["corner_side"] in ("left", "right")


def test_sketch_tolerates_odd_trees():
    assert sketch_from_tree(None) is None
    assert sketch_from_tree({}) is None
    assert sketch_from_tree({"type": "kitchen", "base": []}) is None
    assert sketch_from_tree({"width": "x", "sections": "?"}) is None


def test_list_returns_stored_sketch(api, client, owner):
    pid = api.project(owner, "Шкаф", tree=load_tree("wardrobe_full"))
    kid = api.project(owner, "Кухня", tree=load_tree("kitchen_straight"))
    draft = api.project(owner, "Пусто", tree=None)
    items = {p["id"]: p for p in client.get("/projects", headers=owner).json()["items"]}
    assert items[pid]["sketch"]["kind"] == "wardrobe" and len(items[pid]["sketch"]["cols"]) == 3
    assert items[kid]["sketch"]["kind"] == "kitchen"
    assert items[draft]["sketch"] is None
    # карточка — тот же эскиз, и он хранится в сводке версии
    card = client.get(f"/projects/{pid}", headers=owner).json()
    assert card["sketch"] == items[pid]["sketch"] == card["model_summary"]["sketch"]


def test_list_sketch_fallback_for_old_versions(api, client, owner, app):
    """Версии до эскиза (summary без sketch) — эскиз из сохранённого дерева, без записи в базу."""
    pid = api.project(owner, "Шкаф", tree=load_tree("kupe_3doors"))
    with app.state.db.sessionmaker() as s:
        v = s.scalars(select(ModelVersion)).one()
        v.summary = {k: x for k, x in v.summary.items() if k != "sketch"}
        s.commit()
    item = client.get("/projects", headers=owner).json()["items"][0]
    assert item["id"] == pid and item["sketch"]["sliding"] == 3
    with app.state.db.sessionmaker() as s:
        assert "sketch" not in s.scalars(select(ModelVersion)).one().summary


def test_list_stays_fast_with_sketches(api, client, owner):
    for i in range(12):
        api.project(owner, f"Шкаф {i}", tree=load_tree("kitchen_straight" if i % 2 else "wardrobe_full"))
    client.get("/projects", headers=owner)
    t = time.perf_counter()
    r = client.get("/projects", headers=owner)
    assert r.status_code == 200 and all(p["sketch"] for p in r.json()["items"])
    assert time.perf_counter() - t < 1.0
