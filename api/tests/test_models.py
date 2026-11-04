from .conftest import ADMIN, BAD_TREE, GOOD_TREE, tree_variant


def save(client, h, pid, tree, **extra):
    return client.post(f"/projects/{pid}/model", json={"tree": tree, **extra}, headers=h)


def test_create_version_stores_build(api, client, owner):
    pid = api.project(owner, tree=None)
    r = save(client, owner, pid, GOOD_TREE, label="Первый вариант")
    assert r.status_code == 201
    state = r.json()
    v = state["version"]
    assert v["number"] == 1 and v["ok"] is True and v["is_current"] is True
    assert v["label"] == "Первый вариант"
    assert v["rules_version"] and v["module_versions"]
    assert v["schema_version"] == v["tree"]["schema_version"]
    assert v["summary"]["parts_count"] > 0 and v["summary"]["size_mm"] == [1200.0, 2400.0, 600.0]
    assert v["viewer"]["parts"] and v["viewer"]["format"]
    assert v["tree"]["body"]["material"] == "ldsp_16_white"  # дерево нормализовано со значениями по умолчанию
    assert v["build_ms"] < 300
    assert state["can_undo"] is False and state["can_redo"] is False
    card = client.get(f"/projects/{pid}", headers=owner).json()
    assert card["current_version_id"] == v["id"] and card["product_type"] == "wardrobe"
    assert card["model_summary"]["sections"] == 2


def test_invalid_schema_is_rejected_and_not_stored(api, client, owner):
    pid = api.project(owner, tree=None)
    r = save(client, owner, pid, {"width": 1200, "sections": []})
    assert r.status_code == 422
    e = r.json()["error"]
    assert e["code"] == "invalid_tree"
    assert e["message"].startswith("Дерево модулей не прошло проверку")
    assert {d["path"] for d in e["details"]} >= {"height", "depth", "sections"}
    assert client.get(f"/projects/{pid}/versions", headers=owner).json() == []


def test_model_with_errors_is_stored_unless_rejected(api, client, owner):
    pid = api.project(owner)
    r = save(client, owner, pid, BAD_TREE)
    assert r.status_code == 201
    v = r.json()["version"]
    assert v["ok"] is False
    assert any(i["level"] == "error" for i in v["issues"])
    assert v["summary"]["errors"] >= 1

    before = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["id"]
    r = save(client, owner, pid, BAD_TREE, reject_on_errors=True)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "model_has_errors"
    assert client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["id"] == before


def test_undo_redo_moves_pointer(api, client, owner):
    pid = api.project(owner)  # v1
    save(client, owner, pid, tree_variant(width=1400))  # v2
    save(client, owner, pid, tree_variant(width=1600))  # v3

    r = client.post(f"/projects/{pid}/model/undo", headers=owner)
    assert r.status_code == 200
    s = r.json()
    assert s["version"]["number"] == 2 and s["can_undo"] and s["can_redo"]
    assert client.post(f"/projects/{pid}/model/undo", headers=owner).json()["version"]["number"] == 1

    r = client.post(f"/projects/{pid}/model/undo", headers=owner)
    assert r.status_code == 409 and "первая версия" in r.json()["error"]["message"]

    assert client.post(f"/projects/{pid}/model/redo", headers=owner).json()["version"]["number"] == 2
    s = client.post(f"/projects/{pid}/model/redo", headers=owner).json()
    assert s["version"]["number"] == 3 and s["can_redo"] is False
    assert s["version"]["tree"]["width"] == 1600
    r = client.post(f"/projects/{pid}/model/redo", headers=owner)
    assert r.status_code == 409 and "последняя правка" in r.json()["error"]["message"]

    versions = client.get(f"/projects/{pid}/versions", headers=owner).json()
    assert [v["number"] for v in versions] == [3, 2, 1]
    assert [v["is_current"] for v in versions] == [True, False, False]


def test_edit_after_undo_branches_and_redo_follows_newest(api, client, owner):
    pid = api.project(owner)  # v1
    save(client, owner, pid, tree_variant(width=1400))  # v2
    client.post(f"/projects/{pid}/model/undo", headers=owner)  # → v1
    s = save(client, owner, pid, tree_variant(width=1000)).json()  # v3, родитель v1
    assert s["version"]["number"] == 3 and s["version"]["parent_id"] is not None
    assert s["can_redo"] is False
    client.post(f"/projects/{pid}/model/undo", headers=owner)  # → v1
    assert client.post(f"/projects/{pid}/model/redo", headers=owner).json()["version"]["number"] == 3


def test_get_version_returns_viewer_and_issues(api, client, owner):
    pid = api.project(owner, tree=BAD_TREE)
    vid = client.get(f"/projects/{pid}/versions", headers=owner).json()[0]["id"]
    v = client.get(f"/projects/{pid}/versions/{vid}", headers=owner).json()
    assert v["viewer"]["parts"]
    assert v["issues"] and all(i["message"] for i in v["issues"])


def test_frozen_version_cannot_change_but_new_versions_allowed(api, client, owner):
    pid = api.project(owner)
    card = api.advance(owner, pid, "contract")
    frozen = card["frozen_version_id"]
    r = client.patch(f"/projects/{pid}/versions/{frozen}", json={"label": "другое"}, headers=owner)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "version_frozen"
    assert "заморожена договором" in r.json()["error"]["message"]

    # правка после договора — только новой версией; замороженная остаётся
    s = save(client, owner, pid, tree_variant(width=1300)).json()
    assert s["version"]["number"] == 2 and s["version"]["frozen"] is False
    assert s["frozen_version_id"] == frozen
    v1 = client.get(f"/projects/{pid}/versions/{frozen}", headers=owner).json()
    assert v1["frozen"] is True and v1["tree"]["width"] == 1200
    versions = client.get(f"/projects/{pid}/versions", headers=owner).json()
    assert [v["frozen"] for v in versions] == [False, True]


def test_model_locked_in_work(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    client.post(f"/admin/projects/{pid}/order-paid", json={}, headers=ADMIN)
    r = save(client, owner, pid, tree_variant(width=1300))
    assert r.status_code == 409
    assert r.json()["error"]["message"] == "Проект в статусе «В работе» — модель изменить нельзя"
    assert client.post(f"/projects/{pid}/model/undo", headers=owner).status_code == 409


def test_restore_creates_new_version(api, client, owner):
    pid = api.project(owner)
    save(client, owner, pid, tree_variant(width=1500))
    v1 = client.get(f"/projects/{pid}/versions", headers=owner).json()[-1]
    s = client.post(f"/projects/{pid}/versions/{v1['id']}/restore", headers=owner).json()
    assert s["version"]["number"] == 3
    assert s["version"]["source"] == "restore"
    assert s["version"]["tree"]["width"] == 1200


def test_validate_and_schema_endpoints(client, owner):
    r = client.post("/models/validate", json={"tree": GOOD_TREE}, headers=owner).json()
    assert r["schema_valid"] and r["ok"] and r["summary"]["parts_count"] > 0
    r = client.post("/models/validate", json={"tree": BAD_TREE}, headers=owner).json()
    assert r["schema_valid"] and not r["ok"] and r["issues"]
    r = client.post("/models/validate", json={"tree": {"width": "x"}}, headers=owner).json()
    assert r["schema_valid"] is False and r["schema_errors"]
    schema = client.get("/models/schema").json()
    assert {"Product", "Kitchen"} <= set(schema["$defs"])  # шкаф или прямая кухня
    assert "sections" in schema["$defs"]["Product"]["properties"]


def test_kitchen_tree_is_accepted(api, client, owner):
    from .conftest import load_tree

    pid = api.project(owner, "Кухня", tree=load_tree("kitchen_straight"))
    v = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    assert v["ok"] and v["tree"]["type"] == "kitchen" and v["summary"]["sections"] > 0
    assert client.get(f"/projects/{pid}/estimate", headers=owner).status_code == 200


def test_versions_isolated_between_workshops(api, client, owner):
    pid = api.project(owner)
    other = api.login("+998977777777")
    assert client.get(f"/projects/{pid}/versions", headers=other).status_code == 404
    assert save(client, other, pid, GOOD_TREE).status_code == 404


def test_apply_fix_creates_new_version(api, client, owner):
    wide_shelves = {"width": 1200, "height": 2400, "depth": 600, "sections": [{"fill": [{"kind": "shelves", "count": 4}]}]}
    pid = api.project(owner, tree=wide_shelves)
    v1 = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    idx = next(i for i, issue in enumerate(v1["issues"]) if issue["fixes"])
    fix = v1["issues"][idx]["fixes"][0]
    assert fix["description"] and fix["patch"]

    r = client.post(f"/projects/{pid}/model/fixes", json={"issue_index": idx, "fix_index": 0}, headers=owner)
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["version"]["number"] == 2 and s["version"]["source"] == "fix"
    assert s["version"]["label"] == fix["description"]
    assert len(s["version"]["tree"]["sections"]) == 2
    assert s["can_undo"] is True  # исправление отменяется как любая правка
    assert client.post(f"/projects/{pid}/model/undo", headers=owner).json()["version"]["number"] == 1

    r = client.post(f"/projects/{pid}/model/fixes", json={"issue_index": 99}, headers=owner)
    assert r.status_code == 404 and "замечания" in r.json()["error"]["message"]


def test_part_details_sizes_cut_edges_holes(api, client, owner):
    pid = api.project(owner, tree=None)
    v = save(client, owner, pid, GOOD_TREE).json()["version"]
    vp = next(x for x in v["viewer"]["parts"] if x["role"] == "side")
    r = client.get(f"/projects/{pid}/parts/{vp['number']}", headers=owner)
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["number"] == vp["number"] and p["key"] == vp["key"] and p["role"] == "side"
    assert (p["length_mm"], p["width_mm"], p["thickness_mm"]) == (vp["length"], vp["width"], vp["thickness"])
    assert p["material"] and p["material_id"] == vp["material"]
    assert [e["side"] for e in p["edges"]] == ["y0", "y1", "x0", "x1"]
    # распил = чистовой − кромка по сторонам
    by = {e["side"]: e["thickness_mm"] for e in p["edges"]}
    assert p["cut_length_mm"] == p["length_mm"] - by["x0"] - by["x1"]
    assert p["cut_width_mm"] == p["width_mm"] - by["y0"] - by["y1"]
    assert any(e["edge_id"] for e in p["edges"]) and p["holes"] and all(h["count"] > 0 for h in p["holes"])
    assert p["product_size_mm"] == [1200.0, 2400.0, 600.0]
    assert client.get(f"/projects/{pid}/parts/9999", headers=owner).status_code == 404
