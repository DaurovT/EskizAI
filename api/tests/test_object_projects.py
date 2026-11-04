"""Несколько предметов на фото → несколько проектов: POST /projects/{id}/ai/choose-objects."""

import pytest

from mebel_ai import LLM
from mebel_api.deps import get_llm

from .conftest import ADMIN
from .fake_anthropic import FakeClient, design, response

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 100
OBJECTS = [
    {"label": "шкаф распашной", "photo": 0, "box": [0.05, 0.1, 0.35, 0.95], "chosen": True,
     "size": [1200, 600, 2200], "summary": "2 двери"},
    {"label": "тумба под ТВ", "photo": 0, "box": [0.4, 0.6, 0.7, 0.9], "chosen": False,
     "size": [1600, 400, 450], "summary": "3 ящика"},
    {"label": "комод", "photo": 0, "box": [0.75, 0.4, 0.95, 0.9], "chosen": False},
]
Q_OBJECT = [{"id": "object", "text": "Какой предмет делаем?", "options": [o["label"] for o in OBJECTS],
             "default": OBJECTS[0]["label"], "affects": "/"}]


@pytest.fixture
def fake(app):
    holder = FakeClient([])
    app.dependency_overrides[get_llm] = lambda: LLM(client=holder)
    yield holder
    app.dependency_overrides.clear()


def recognized(api, client, owner, fake, **project) -> str:
    """Проект с фото, распознанным как три предмета."""
    pid = api.project(owner, tree=None, **project)
    client.post(f"/projects/{pid}/photos", files={"file": ("a.jpg", JPEG, "image/jpeg")}, headers=owner)
    fake.replies.append(response(design(questions=Q_OBJECT, objects=OBJECTS)))
    r = client.post(f"/projects/{pid}/ai/design", json={"text": "как на фото"}, headers=owner)
    assert r.status_code == 202
    out = client.get(f"/tasks/{r.json()['task_id']}", headers=owner).json()["result"]
    assert out["status"] == "questions" and len(out["objects"]) == 3
    assert out["objects"][0]["size"] == [1200, 600, 2200] and out["objects"][0]["summary"] == "2 двери"
    assert out["objects"][2]["size"] == [] and out["objects"][2]["summary"] == ""
    return pid


def projects(client, owner) -> list[dict]:
    return client.get("/projects", headers=owner).json()["items"]


def free_used(client, owner) -> int:
    return client.get("/billing/limits", headers=owner).json()["free_used"]


def test_three_objects_make_three_projects(api, client, owner, fake):
    client_id = client.post("/clients", json={"name": "Алишер", "phone": "+998901112233"}, headers=owner).json()["id"]
    pid = recognized(api, client, owner, fake, client_id=client_id)
    fake.replies += [response(design()) for _ in range(3)]
    r = client.post(f"/projects/{pid}/ai/choose-objects", json={"objects": [1, 0, 2]}, headers=owner)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["charged"] == 2
    items = body["projects"]
    assert [i["object_index"] for i in items] == [1, 0, 2]
    assert items[0]["project_id"] == pid and items[0]["created"] is False and items[0]["label"] == "тумба под ТВ"
    assert [i["title"] for i in items[1:]] == ["Шкаф распашной", "Комод"] and all(i["created"] for i in items[1:])

    # каждая задача — своя модель в своём проекте
    for it in items:
        t = client.get(f"/tasks/{it['task_id']}", headers=owner).json()
        assert t["status"] == "done" and t["result"]["status"] == "ready" and t["result"]["version_id"]
        card = client.get(f"/projects/{it['project_id']}", headers=owner).json()
        assert card["current_version_id"] == t["result"]["version_id"]
        assert card["client"]["id"] == client_id and card["source_text"] == "как на фото"
        assert len(card["photos"]) == 1
        chat = client.get(f"/projects/{it['project_id']}/chat", headers=owner).json()["messages"]
        assert chat[-2]["author"] == "master" and chat[-2]["text"] == it["label"]
    # новые проекты списаны сразу, текущий — как раньше, при «Эскизе»
    cards = {i["project_id"]: client.get(f"/projects/{i['project_id']}", headers=owner).json() for i in items}
    assert [cards[i["project_id"]]["charged"] for i in items] == [False, True, True]
    assert free_used(client, owner) == 2
    assert len(projects(client, owner)) == 3

    # фото — тот же файл; удаление в одном проекте не ломает другой
    photos = [cards[i["project_id"]]["photos"][0] for i in items]
    assert len({p["url"] for p in photos}) == 1
    assert client.delete(f"/projects/{pid}/photos/{photos[0]['id']}", headers=owner).status_code == 200
    assert client.get(photos[1]["url"]).status_code == 200

    # копия сессии: история с фото + выбор предмета по рамке; журнал ИИ — в своём проекте
    calls = fake.calls[1:]
    assert all(c["messages"][0]["content"][0]["type"] == "image" for c in calls)
    # (список сообщений — тот же объект, после вызова в него дописан ответ ассистента)
    assert "тумба под ТВ" in calls[0]["messages"][-2]["content"][0]["text"]
    assert "[0.75, 0.4, 0.95, 0.9]" in calls[2]["messages"][-2]["content"][0]["text"]
    for it in items[1:]:
        log = client.get(f"/admin/ai-requests?project_id={it['project_id']}", headers=ADMIN).json()
        assert len(log) == 1


def test_single_object_continues_in_current_project(api, client, owner, fake):
    pid = recognized(api, client, owner, fake)
    fake.replies.append(response(design()))
    r = client.post(f"/projects/{pid}/ai/choose-objects", json={"objects": [2]}, headers=owner)
    assert r.status_code == 202, r.text
    assert r.json()["charged"] == 0 and len(r.json()["projects"]) == 1
    assert len(projects(client, owner)) == 1 and free_used(client, owner) == 0
    # старый путь (ответ на вопрос `object`) тоже работает
    fake.replies.append(response(design()))
    r = client.post(f"/projects/{pid}/ai/answer", json={"answers": {"object": "комод"}}, headers=owner)
    assert r.status_code == 202


def test_not_enough_limit_creates_nothing(api, client, owner, fake):
    api.advance(owner, api.project(owner, "П0"), "sketch")  # осталось 2 из 3
    pid = recognized(api, client, owner, fake)
    before = len(projects(client, owner))
    # 2 новых + несписанный текущий = 3 > 2
    r = client.post(f"/projects/{pid}/ai/choose-objects", json={"objects": [0, 1, 2]}, headers=owner)
    assert r.status_code == 402
    e = r.json()["error"]
    assert e["code"] == "limit_exhausted" and e["details"]["needed"] == 3 and e["details"]["left"] == 2
    assert len(projects(client, owner)) == before and free_used(client, owner) == 1
    assert not fake.calls[1:]  # ИИ не вызывался
    # двух хватает
    fake.replies += [response(design()), response(design())]
    r = client.post(f"/projects/{pid}/ai/choose-objects", json={"objects": [0, 1]}, headers=owner)
    assert r.status_code == 202, r.text
    assert free_used(client, owner) == 2 and len(projects(client, owner)) == before + 1


def test_pack_counts_toward_limit(api, client, owner, fake):
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    client.post(f"/admin/workshops/{wid}/plan", json={"plan": "pack", "add_pack_projects": 1}, headers=ADMIN)
    for i in range(2):
        api.advance(owner, api.project(owner, f"П{i}"), "sketch")  # бесплатных осталось 1, пакет 1
    pid = recognized(api, client, owner, fake)
    fake.replies += [response(design()), response(design())]
    r = client.post(f"/projects/{pid}/ai/choose-objects", json={"objects": [0, 1]}, headers=owner)
    assert r.status_code == 202, r.text
    limits = client.get("/billing/limits", headers=owner).json()
    assert limits["free_left"] == 0 and limits["pack_left"] == 1  # новый проект взял бесплатный


def test_pro_is_unlimited(api, client, owner, fake):
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    client.post(f"/admin/workshops/{wid}/plan", json={"plan": "pro"}, headers=ADMIN)
    for i in range(3):
        api.advance(owner, api.project(owner, f"П{i}"), "sketch")
    pid = recognized(api, client, owner, fake)
    fake.replies += [response(design()) for _ in range(3)]
    r = client.post(f"/projects/{pid}/ai/choose-objects", json={"objects": [0, 1, 2]}, headers=owner)
    assert r.status_code == 202, r.text
    assert r.json()["charged"] == 2
    assert free_used(client, owner) == 0


def test_validation_and_foreign_project(api, client, owner, fake):
    pid = recognized(api, client, owner, fake)
    url = f"/projects/{pid}/ai/choose-objects"
    assert client.post(url, json={"objects": []}, headers=owner).status_code == 422
    assert client.post(url, json={"objects": [0, 0]}, headers=owner).json()["error"]["code"] == "duplicate_objects"
    assert client.post(url, json={"objects": [5]}, headers=owner).json()["error"]["code"] == "unknown_object"
    other = api.login("+998909999999")
    r = client.post(url, json={"objects": [0, 1]}, headers=other)
    assert r.status_code == 404
    assert len(projects(client, other)) == 0 and len(projects(client, owner)) == 1
    # без распознавания и без предметов
    bare = api.project(owner, "Без ИИ", tree=None)
    assert client.post(f"/projects/{bare}/ai/choose-objects", json={"objects": [0]},
                       headers=owner).json()["error"]["code"] == "ai_session_missing"
    fake.replies.append(response(design()))
    client.post(f"/projects/{bare}/ai/design", json={"text": "шкаф"}, headers=owner)
    assert client.post(f"/projects/{bare}/ai/choose-objects", json={"objects": [0]},
                       headers=owner).json()["error"]["code"] == "no_objects"
