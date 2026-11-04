import json

from mebel_api.schemas.estimate import MasterEstimate, PriceRange, StaffEstimate
from mebel_api.services.visibility import for_client, for_employee


def employee(api, client, owner):
    return api.employee(owner, "+998935550000", "Менеджер")


def test_employee_does_not_see_pricing(api, client, owner):
    emp = employee(api, client, owner)
    owner_view = client.get("/workshops/me", headers=owner).json()
    emp_view = client.get("/workshops/me", headers=emp).json()
    assert "pricing" in owner_view
    assert "pricing" not in emp_view
    assert not any(k.startswith(("markup", "labor", "cost")) for k in emp_view)
    assert emp_view["name"] == owner_view["name"]

    r = client.get("/workshops/me/pricing", headers=emp)
    assert r.status_code == 403
    assert r.json()["error"]["message"] == "Это может сделать только владелец цеха"
    assert client.patch("/workshops/me/pricing", json={"markup_body": 10}, headers=emp).status_code == 403
    assert client.get("/workshops/me/action-log", headers=emp).status_code == 403
    assert client.post("/workshops/me/employees", json={"phone": "+998935550001"}, headers=emp).status_code == 403


def test_employee_project_card_has_no_cost_fields(api, client, owner):
    emp = employee(api, client, owner)
    pid = api.project(emp)
    card = client.get(f"/projects/{pid}", headers=emp).json()
    assert card["title"] == "Шкаф"
    assert not any("cost" in k or "markup" in k for k in card)
    assert client.delete(f"/projects/{pid}", headers=emp).status_code == 403  # удаляет только владелец
    assert client.get(f"/projects/{pid}", headers=owner).status_code == 200  # проект общий для цеха


def test_estimate_filtering_for_employee_and_client():
    pr = PriceRange(**{"from": 100, "to": 120})
    master = MasterEstimate(
        exact=False, materials_client=pr, work=pr, total=pr, has_requests=False, sheets={},
        priced_at="2026-11-02T10:00:00Z", cost_materials=pr, cost_by_category={"body": 90},
        markup_percent={"body": 10}, lines=[],
    ).model_dump(mode="json", by_alias=True)
    staff = for_employee(master)
    assert not {"cost_materials", "cost_by_category", "markup_percent"} & set(staff)
    StaffEstimate.model_validate(staff)  # остаётся валидной сметой сотрудника
    client_view = for_client({**master, "supplier": "EMAN", "nested": [{"sku": 1, "label": "x"}]})
    assert "supplier" not in client_view and client_view["nested"] == [{"label": "x"}]


def test_estimate_owner_sees_cost_employee_does_not(api, client, owner):
    emp = employee(api, client, owner)
    pid = api.project(owner)
    full = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert full["cost_materials"]["from"] > 0 and full["lines"]
    assert full["lines"][0]["cost"] > 0
    assert full["exact"] is False and full["total"]["from"] < full["total"]["to"]  # до замера — «от–до»

    staff = client.get(f"/projects/{pid}/estimate", headers=emp).json()
    assert staff["total"] == full["total"]
    assert not any(k.startswith(("cost", "markup")) or k == "lines" for k in staff)
    assert "cost" not in json.dumps(staff)

    card_emp = client.get(f"/projects/{pid}", headers=emp).json()
    assert card_emp["estimate"]["total"] == full["total"]
    assert "cost" not in json.dumps(card_emp) and "markup" not in json.dumps(card_emp)
    card_owner = client.get(f"/projects/{pid}", headers=owner).json()
    assert card_owner["estimate"]["cost_materials"] == full["cost_materials"]


def test_estimate_uses_workshop_pricing_and_becomes_exact_after_measure(api, client, owner):
    pid = api.project(owner)
    base = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    client.patch("/workshops/me/pricing", json={"labor_percent": 100}, headers=owner)
    more = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert more["work"]["from"] > base["work"]["from"]
    assert more["cost_materials"] == base["cost_materials"]  # себестоимость от наценок не зависит
    api.advance(owner, pid, "measured")
    exact = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert exact["exact"] is True and exact["total"]["from"] == exact["total"]["to"]


def test_estimate_errors(api, client, owner):
    from .conftest import BAD_TREE

    pid = api.project(owner, tree=None)
    r = client.get(f"/projects/{pid}/estimate", headers=owner)
    assert r.status_code == 409 and "после построения модели" in r.json()["error"]["message"]
    pid = api.project(owner, tree=BAD_TREE)
    assert client.get(f"/projects/{pid}/estimate", headers=owner).json()["error"]["code"] == "model_invalid"
    assert client.get(f"/projects/{pid}", headers=owner).json()["estimate"] is None


def test_client_preview_views(api, client, owner):
    pid = api.project(owner)
    total = client.get(f"/projects/{pid}/estimate/client", headers=owner).json()
    assert set(total) >= {"view", "exact", "total"} and total["view"] == "total" and total["materials"] is None
    short = client.get(f"/projects/{pid}/estimate/client?view=short", headers=owner).json()
    assert short["materials"] and short["work"] and short["groups"] is None
    detailed = client.get(f"/projects/{pid}/estimate/client?view=detailed", headers=owner).json()
    assert detailed["groups"] and all({"name", "from", "to"} <= set(g) for g in detailed["groups"])
    assert "cost" not in json.dumps(detailed)


def test_pricing_changes_are_logged(client, owner):
    r = client.patch(
        "/workshops/me/pricing",
        json={"labor_mode": "fixed", "labor_fixed": 2_000_000, "markup_fronts": 20},
        headers=owner,
    )
    assert r.status_code == 200
    assert r.json()["labor_fixed"] == 2_000_000
    client.patch("/workshops/me/pricing", json={"markup_fronts": 20}, headers=owner)  # без изменений — без записи
    log = client.get("/workshops/me/action-log", headers=owner).json()
    assert len(log) == 1
    entry = log[0]
    assert entry["entity"] == "workshop_pricing" and entry["actor_type"] == "user"
    assert entry["before"] == {"labor_fixed": 0, "labor_mode": "percent", "markup_fronts": 0}
    assert entry["after"] == {"labor_fixed": 2_000_000, "labor_mode": "fixed", "markup_fronts": 20}


def test_pricing_validation(client, owner):
    r = client.patch("/workshops/me/pricing", json={"markup_body": -5}, headers=owner)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Проверьте данные запроса"
    r = client.patch("/workshops/me/pricing", json={"labor_percent": None}, headers=owner)
    assert r.status_code == 422
    r = client.patch("/workshops/me/pricing", json={"employee_estimate_views": []}, headers=owner)
    assert r.status_code == 422


def test_workshop_isolation(api, client, owner):
    pid = api.project(owner)
    cid = client.post("/clients", json={"name": "Азиза"}, headers=owner).json()["id"]
    other = api.login("+998977777777")
    assert client.get(f"/projects/{pid}", headers=other).status_code == 404
    assert client.get(f"/clients/{cid}", headers=other).status_code == 404
    assert client.post("/projects", json={"title": "x", "client_id": cid}, headers=other).status_code == 404
    assert client.get("/projects", headers=other).json()["total"] == 0
