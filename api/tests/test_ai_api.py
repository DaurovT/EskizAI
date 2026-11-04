"""ИИ-эндпоинты на подставном клиенте: контракт, версии, чат, бюджет, лимит, журнал."""

import time

import pytest

from mebel_ai import LLM
from mebel_api.deps import get_llm

from .conftest import ADMIN, build_app, make_settings
from .fake_anthropic import HAIKU, FakeClient, design, edit_reply, response

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 100
Q = [{"id": "doors", "text": "Сколько дверей?", "options": ["2", "3"], "default": "2", "affects": "/sections"}]


@pytest.fixture
def fake(app):
    """Очередь ответов для LLM; каждый запрос получает свой LLM (как в API)."""
    holder = FakeClient([])
    app.dependency_overrides[get_llm] = lambda: LLM(client=holder)
    yield holder
    app.dependency_overrides.clear()


def task(client, h, r):
    assert r.status_code == 202, r.text
    t = client.get(f"/tasks/{r.json()['task_id']}", headers=h).json()
    assert t["id"] == r.json()["task_id"] and t["status"] == "done", t
    return t["result"]


def test_design_ready_creates_version_and_chat(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    ph = client.post(f"/projects/{pid}/photos", files={"file": ("a.jpg", JPEG, "image/jpeg")}, headers=owner).json()
    fake.replies.append(response(design()))
    out = task(client, owner, client.post(f"/projects/{pid}/ai/design",
                                         json={"text": "шкаф 1,2 м", "photo_ids": [ph["id"]]}, headers=owner))
    assert set(out) >= {"status", "product_kind", "confidence", "alternatives", "elements", "understood", "unclear",
                        "estimated", "questions", "differences", "message", "version_id", "issues", "error"}
    assert out["status"] == "ready" and out["version_id"] and out["error"] is None
    assert out["elements"][0] == {"name": "двери", "kind": "door", "count": 2, "sure": True, "note": ""}
    assert out["objects"] == []
    # фото ушло в запрос Claude
    assert fake.calls[0]["messages"][0]["content"][0]["type"] == "image"
    model = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    assert model["id"] == out["version_id"] and model["source"] == "ai"
    chat = client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"]
    assert [m["author"] for m in chat] == ["master", "ai"]
    assert chat[1]["version_id"] == out["version_id"] and chat[1]["undone"] is False
    assert "options" not in chat[0]
    # журнал ИИ: проект, стоимость в микродолларах, проверка
    log = client.get(f"/admin/ai-requests?project_id={pid}", headers=ADMIN).json()
    assert len(log) == 1 and log[0]["validation_result"] == "ok" and log[0]["cost_microusd"] == 28_000
    assert log[0]["cache_write_tokens"] == 4000
    # повтор распознавания лимит не тратит (проект ещё черновик)
    assert client.get(f"/projects/{pid}", headers=owner).json()["charged"] is False
    assert client.get(f"/projects/{pid}/ai/design", headers=owner).json()["status"] == "ready"
    # ИИ-статистика админки: проект с ИИ-версией, мастер правит дерево вручную → «исправлено»
    client.post(f"/projects/{pid}/model", json={"tree": model["tree"] | {"width": 1300}}, headers=owner)
    acc = client.get("/admin/ai-stats", headers=ADMIN).json()["accuracy"]
    assert acc["ai_projects"] == 1 and acc["corrected_by_master"] == 1 and acc["design_valid_first_try_share"] == 1
    assert client.get(f"/admin/projects/{pid}", headers=ADMIN).json()["chat"][0]["author"] == "master"


def test_questions_answer_and_choose_type(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    assert client.post(f"/projects/{pid}/ai/answer", json={"answers": {"doors": "3"}}, headers=owner).status_code == 409
    fake.replies += [response(design(questions=Q)), response(design())]
    out = task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner))
    assert out["status"] == "questions" and out["questions"] == Q
    chat = client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"]
    assert chat[-1]["text"] == "Сколько дверей?" and chat[-1]["options"] == ["2", "3"]
    out2 = task(client, owner, client.post(f"/projects/{pid}/ai/answer", json={"answers": {"doors": "3"}},
                                           headers=owner))
    assert out2["status"] == "ready" and out2["version_id"] != out["version_id"]
    # история диалога сохраняется между запросами: второй запрос содержит первый ответ модели
    assert fake.calls[1]["messages"][1]["role"] == "assistant"

    fake.replies += [response(design(confidence=0.4)), response(design())]
    low = task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "что-то"}, headers=owner))
    assert low["status"] == "choose_type"
    assert client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"][-1]["options"] == [
        "распашной шкаф", "шкаф-купе", "стеллаж"]
    chosen = task(client, owner, client.post(f"/projects/{pid}/ai/choose-type",
                                             json={"product_kind": "шкаф-купе"}, headers=owner))
    assert chosen["status"] == "ready"


def test_answers_batch_two_rounds_saved_and_not_asked_again(api, client, owner, fake):
    """Раунд 1: все ответы разом (новая форма) → пересборка → новый вопрос; раунд 2 (прежняя форма) → готово."""
    pid = api.project(owner, tree=None)
    legs = {"id": "legs", "text": "Какая высота ножек?", "options": ["100 мм", "150 мм"], "default": "100 мм",
            "affects": "/plinth"}
    round_ = {"id": "round", "text": "Скругление на всю высоту?", "options": ["да", "нет"], "default": "да",
              "affects": "/sections"}
    # модель во втором раунде снова спрашивает про двери — сервер это отсекает
    fake.replies += [response(design(questions=[*Q, round_])), response(design(questions=[*Q, legs])),
                     response(design())]
    out = task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner))
    assert [q["id"] for q in out["questions"]] == ["doors", "round"]
    chat = client.get(f"/projects/{pid}/chat", headers=owner).json()
    assert [q["id"] for q in chat["questions"]] == ["doors", "round"] and chat["answers"] == {}

    batch = {"answers": [{"question_id": "doors", "value": "3"}, {"question_id": "round", "value": "не знаю"}]}
    out2 = task(client, owner, client.post(f"/projects/{pid}/ai/answer", json=batch, headers=owner))
    assert out2["status"] == "questions" and [q["id"] for q in out2["questions"]] == ["legs"]
    assert out2["answers"] == {"doors": "3", "round": "не знаю"}
    assert out2["version_id"] and out2["version_id"] != out["version_id"]  # ответы применены — новая версия
    assert client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["id"] == out2["version_id"]
    # модели ушли оба ответа одним сообщением, с текстом вопросов и значением по умолчанию
    sent = next(m for m in reversed(fake.calls[1]["messages"]) if m["role"] == "user")["content"][0]["text"]
    assert "Сколько дверей?" in sent and "- doors" in sent and "по умолчанию «да»" in sent
    chat = client.get(f"/projects/{pid}/chat", headers=owner).json()
    answer_msg = [m for m in chat["messages"] if m["kind"] == "answer" and m["author"] == "master"][-1]
    assert answer_msg["text"] == "Сколько дверей? — 3\nСкругление на всю высоту? — по умолчанию (да)"
    assert [q["id"] for q in chat["questions"]] == ["legs"] and chat["answers"]["doors"] == "3"

    out3 = task(client, owner, client.post(f"/projects/{pid}/ai/answer", json={"answers": {"legs": "150 мм"}},
                                           headers=owner))
    assert out3["status"] == "ready" and out3["questions"] == []
    assert out3["answers"] == {"doors": "3", "round": "не знаю", "legs": "150 мм"}
    chat = client.get(f"/projects/{pid}/chat", headers=owner).json()
    assert chat["questions"] == [] and len(chat["answers"]) == 3
    assert client.get(f"/projects/{pid}/ai/design", headers=owner).json()["answers"]["legs"] == "150 мм"
    # пустой список ответов — 422
    r = client.post(f"/projects/{pid}/ai/answer", json={"answers": []}, headers=owner)
    assert r.status_code == 422 and r.json()["error"]["code"] == "no_answers"


def test_answer_after_manual_edit_keeps_master_changes(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    fake.replies += [response(design(questions=Q)), response(design())]
    out = task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner))
    tree = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["tree"]
    client.post(f"/projects/{pid}/model", json={"tree": tree | {"width": 1300}}, headers=owner)
    task(client, owner, client.post(f"/projects/{pid}/ai/answer", json={"answers": {"doors": "3"}}, headers=owner))
    sent = next(m for m in reversed(fake.calls[1]["messages"]) if m["role"] == "user")["content"][0]["text"]
    assert "правил модель" in sent and '"width": 1300' in sent
    assert out["status"] == "questions"


def test_design_failure_is_reported_and_logged(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    fake.replies += [response("x"), response("y"), response("z")]
    out = task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner))
    assert out["status"] == "failed" and out["version_id"] is None and out["error"]
    assert out["message"].startswith("Не смог разобрать")
    log = client.get(f"/admin/ai-requests?project_id={pid}", headers=ADMIN).json()
    assert [r["validation_result"] for r in log] == ["schema_error"] * 3
    # сбой вызова API — тоже строка журнала
    fake.replies.append(RuntimeError("сеть"))
    out = task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner))
    assert out["status"] == "failed" and "сеть" in out["error"]
    assert client.get(f"/admin/ai-requests?project_id={pid}&validation=error", headers=ADMIN).json()


def test_edit_creates_version_with_price_delta_and_undo_marks_chat(api, client, owner, fake):
    pid = api.project(owner)
    fake.replies.append(response(edit_reply([{"op": "replace", "path": "/width", "value_json": "1400"}],
                                            "Шире на 20 см"), model=HAIKU))
    out = task(client, owner, client.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире на 20 см"},
                                         headers=owner))
    assert set(out) >= {"ok", "summary", "question", "version_id", "price_delta", "issues", "error"}
    assert out["ok"] and out["summary"] == "Шире на 20 см" and out["question"] is None
    assert out["price_delta"]["to"] > out["price_delta"]["from"] > 0
    v = client.get(f"/projects/{pid}/model", headers=owner).json()
    assert v["version"]["id"] == out["version_id"] and v["version"]["tree"]["width"] == 1400 and v["can_undo"]
    chat = client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"]
    assert chat[-1]["price_delta"] == out["price_delta"] and chat[-1]["undone"] is False

    client.post(f"/projects/{pid}/model/undo", headers=owner)
    assert client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"][-1]["undone"] is True
    client.post(f"/projects/{pid}/model/redo", headers=owner)
    assert client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"][-1]["undone"] is False


def test_edit_question_and_unbuildable(api, client, owner, fake):
    pid = api.project(owner)
    q = {"id": "which", "text": "В какую секцию?", "options": ["левую", "правую"], "default": "левую",
         "affects": "/sections"}
    # Вопрос Haiku сначала уходит к Sonnet; мастеру — вопрос Sonnet
    fake.replies += [response(edit_reply([], "Уточните", q), model=HAIKU), response(edit_reply([], "Уточните", q))]
    out = task(client, owner, client.post(f"/projects/{pid}/ai/edit", json={"instruction": "добавь ящики"},
                                         headers=owner))
    assert not out["ok"] and out["question"] == q and out["version_id"] is None
    assert client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"][-1]["options"] == ["левую", "правую"]
    bad = edit_reply([{"op": "replace", "path": "/sections/0/width", "value_json": "5000"}])
    fake.replies += [response(bad, model=HAIKU), response(bad, model=HAIKU), response(bad)]
    out = task(client, owner, client.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире"}, headers=owner))
    assert not out["ok"] and out["error"] and out["version_id"] is None
    assert len(client.get(f"/projects/{pid}/versions", headers=owner).json()) == 1  # прежняя версия осталась


def test_edit_requires_model_and_editable_project(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    assert client.post(f"/projects/{pid}/ai/edit", json={"instruction": "x"}, headers=owner).status_code == 409
    pid = api.project(owner)
    api.advance(owner, pid, "in_work")
    r = client.post(f"/projects/{pid}/ai/edit", json={"instruction": "x"}, headers=owner)
    assert r.status_code == 409 and r.json()["error"]["code"] == "model_locked"
    assert client.post(f"/projects/{pid}/ai/design", json={}, headers=owner).status_code == 422


def test_budget_warning_402_and_extra_project(api, client, owner, fake, root_admin):
    assert client.patch("/admin/settings", json={"ai_budget_usd": 0.03}, headers=root_admin).status_code == 200
    pid = api.project(owner)
    api.advance(owner, pid, "sketch")  # списан 1 проект
    fake.replies.append(response(edit_reply([{"op": "replace", "path": "/width", "value_json": "1300"}]),
                                 usage=(5000, 800, 0, 4000)))  # Sonnet-цены: $0.028 = 93% от $0.03
    out = task(client, owner, client.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире"}, headers=owner))
    assert out["budget"]["warning"] and not out["budget"]["exceeded"]
    assert out["budget"]["message"].startswith("Осталось ~")

    fake.replies.append(response(edit_reply([{"op": "replace", "path": "/width", "value_json": "1350"}])))
    task(client, owner, client.post(f"/projects/{pid}/ai/edit", json={"instruction": "ещё"}, headers=owner))
    assert client.get(f"/projects/{pid}/ai/budget", headers=owner).json()["exceeded"] is True

    r = client.post(f"/projects/{pid}/ai/edit", json={"instruction": "ещё"}, headers=owner)
    assert r.status_code == 402
    e = r.json()["error"]
    assert e["code"] == "ai_budget_exceeded" and "спишет ещё один проект" in e["message"]
    assert client.get("/billing/limits", headers=owner).json()["free_used"] == 1

    fake.replies.append(response(edit_reply([{"op": "replace", "path": "/width", "value_json": "1250"}]),
                                 model=HAIKU))
    out = task(client, owner, client.post(f"/projects/{pid}/ai/edit",
                                         json={"instruction": "ещё", "confirm_extra_project": True}, headers=owner))
    assert out["ok"] and out["budget"]["extra_projects"] == 1 and not out["budget"]["exceeded"]
    assert client.get("/billing/limits", headers=owner).json()["free_used"] == 2


def test_ai_needs_project_limit_except_examples(api, client, owner, fake):
    for i in range(3):
        api.advance(owner, api.project(owner, f"П{i}"), "sketch")
    pid = api.project(owner, tree=None)
    r = client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner)
    assert r.status_code == 402 and r.json()["error"]["code"] == "limit_exhausted"
    ex = client.post("/projects/example", headers=owner).json()["id"]
    fake.replies.append(response(design()))
    assert task(client, owner, client.post(f"/projects/{ex}/ai/design", json={"text": "шкаф"},
                                          headers=owner))["status"] == "ready"


def test_extra_charge_without_limit_is_402(api, client, owner, fake, root_admin):
    client.patch("/admin/settings", json={"ai_budget_usd": 0.01}, headers=root_admin)
    pid = api.project(owner)
    api.advance(owner, pid, "sketch")
    for i in range(2):
        api.advance(owner, api.project(owner, f"П{i}"), "sketch")
    fake.replies.append(response(edit_reply([{"op": "replace", "path": "/width", "value_json": "1300"}])))
    task(client, owner, client.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире"}, headers=owner))
    r = client.post(f"/projects/{pid}/ai/edit", json={"instruction": "ещё", "confirm_extra_project": True},
                    headers=owner)
    assert r.status_code == 402 and r.json()["error"]["code"] == "limit_exhausted"


def test_ai_unavailable_without_key(api, client, owner):
    pid = api.project(owner)
    r = client.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире"}, headers=owner)
    assert r.status_code == 503 and r.json()["error"]["code"] == "ai_unavailable"


def test_tasks_of_other_workshop_hidden(api, client, owner, fake):
    pid = api.project(owner)
    fake.replies.append(response(edit_reply([{"op": "replace", "path": "/width", "value_json": "1300"}]),
                                 model=HAIKU))
    r = client.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире"}, headers=owner)
    other = api.login("+998909999999")
    assert client.get(f"/tasks/{r.json()['task_id']}", headers=other).status_code == 404
    assert client.get(f"/projects/{pid}/chat", headers=other).status_code == 404


def test_thread_queue_returns_immediately(tmp_path):
    """Режим по умолчанию: задача в фоне, POST сразу отвечает 202 (статус queued/running → done)."""
    from fastapi.testclient import TestClient

    from .conftest import Api

    app = build_app(make_settings(tmp_path, task_queue_mode="thread", database_url=f"sqlite:///{tmp_path / 't.db'}"))
    slow = FakeClient([])

    class Slow:
        def create(self, **kw):
            time.sleep(0.3)
            return response(edit_reply([{"op": "replace", "path": "/width", "value_json": "1300"}]), model=HAIKU)

    slow.messages = Slow()
    app.dependency_overrides[get_llm] = lambda: LLM(client=slow)
    with TestClient(app) as c:
        api = Api(c, app.state.test_sender)
        h = api.login()
        pid = api.project(h)
        started = time.monotonic()
        r = c.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире"}, headers=h)
        assert r.status_code == 202 and time.monotonic() - started < 0.25
        tid = r.json()["task_id"]
        assert c.get(f"/tasks/{tid}", headers=h).json()["status"] in ("queued", "running")
        for _ in range(50):
            t = c.get(f"/tasks/{tid}", headers=h).json()
            if t["status"] == "done":
                break
            time.sleep(0.1)
        assert t["status"] == "done" and t["result"]["ok"], t
    app.state.tasks.shutdown()
    app.state.db.engine.dispose()


def test_edit_nothing_to_change_keeps_version(api, client, owner, fake):
    pid = api.project(owner)
    fake.replies.append(response(edit_reply([], "Оставил как есть"), model=HAIKU))
    out = task(client, owner, client.post(f"/projects/{pid}/ai/edit", json={"instruction": "ничего не меняй"},
                                         headers=owner))
    assert out["ok"] and out["version_id"] is None and not out.get("error")
    assert len(client.get(f"/projects/{pid}/versions", headers=owner).json()) == 1
    assert client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"][-1]["text"] == "Оставил как есть"
