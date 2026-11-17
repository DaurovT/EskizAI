"""SCR-58 «Просьбы клиентов»: список по всему цеху, «Сделано» (PATCH), счётчик новых."""

from .test_share import make_link


def _ask(client, token: str, text: str) -> None:
    assert client.post(f"/share/{token}/feedback", json={"text": text}).status_code == 201


def test_workshop_requests_across_projects_with_context(api, client, owner):
    client.post("/clients", json={"name": "Азиз Каримов", "phone": "+998901112233"}, headers=owner)
    pid1, l1 = make_link(api, client, owner)
    pid2, l2 = make_link(api, client, owner)
    _ask(client, l1["token"], "Среднюю дверь без зеркала")
    _ask(client, l2["token"], "Ручки чёрные")
    client.post(f"/share/{l2['token']}/events", json={"event": "opened"})
    client.post(f"/share/{l2['token']}/events", json={"event": "ar_started"})

    r = client.get("/client-requests", headers=owner)
    assert r.status_code == 200, r.text
    page = r.json()
    assert page["new_count"] == 2 and page["total"] == 2
    first, second = page["items"]
    # новые сверху, с проектом, версией и просмотрами ссылки
    assert first["text"] == "Ручки чёрные" and first["project_id"] == pid2 and first["status"] == "new"
    assert first["project_title"] and first["version_number"] == 1
    assert first["views"] == 1 and first["ar"] is True
    assert second["project_id"] == pid1 and second["ar"] is False and second["done_at"] is None

    # фильтр по проекту не меняет счётчик новых по цеху
    only = client.get("/client-requests", params={"project_id": pid1}, headers=owner).json()
    assert [x["text"] for x in only["items"]] == ["Среднюю дверь без зеркала"] and only["new_count"] == 2


def test_mark_done_and_back(api, client, owner):
    pid, link = make_link(api, client, owner)
    _ask(client, link["token"], "Короче на 20 см")
    _ask(client, link["token"], "И светлее")
    items = client.get("/client-requests", headers=owner).json()["items"]
    rid = items[1]["id"]

    r = client.patch(f"/client-requests/{rid}", json={"status": "done"}, headers=owner)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "done" and r.json()["done_at"]
    page = client.get("/client-requests", params={"status": "new"}, headers=owner).json()
    assert [x["text"] for x in page["items"]] == ["И светлее"] and page["new_count"] == 1
    done = client.get("/client-requests", params={"status": "done"}, headers=owner).json()
    assert [x["id"] for x in done["items"]] == [rid] and done["total"] == 1
    # статус виден и в списке проекта; текст просьбы не потерялся
    per_project = client.get(f"/projects/{pid}/client-requests", headers=owner).json()
    assert {x["id"]: x["status"] for x in per_project}[rid] == "done"
    assert {x["id"]: x["text"] for x in per_project}[rid] == "Короче на 20 см"

    # вернуть в новые
    r = client.patch(f"/client-requests/{rid}", json={"status": "new"}, headers=owner)
    assert r.json()["status"] == "new" and r.json()["done_at"] is None
    assert client.get("/client-requests", headers=owner).json()["new_count"] == 2


def test_requests_are_private_to_workshop(api, client, owner):
    _, link = make_link(api, client, owner)
    _ask(client, link["token"], "Посудомойку справа")
    rid = client.get("/client-requests", headers=owner).json()["items"][0]["id"]
    other = api.login("+998935551122")
    assert client.get("/client-requests", headers=other).json() == {"items": [], "new_count": 0, "total": 0}
    assert client.patch(f"/client-requests/{rid}", json={"status": "done"}, headers=other).status_code == 404
    assert client.get("/client-requests").status_code == 401
    assert client.patch(f"/client-requests/{rid}", json={"status": "maybe"}, headers=owner).status_code == 422
    assert client.patch("/client-requests/00000000-0000-0000-0000-000000000000", json={"status": "done"},
                        headers=owner).status_code == 404
