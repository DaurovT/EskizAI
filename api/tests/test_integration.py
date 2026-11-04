"""Стык API и приложения мастера: цена в списке, «оценка», push, заказы и оплата, нестандарт,
«под запрос», декоры, раскрой, фурнитура, имена файлов, чат."""

import io
import json
import uuid

import pytest

from mebel_ai import LLM
from mebel_api.deps import get_llm
from mebel_api.models import Device, Notification
from mebel_api.services.notify import ExpoPushSender, PushMessage, money_short, price_text, render

from .conftest import ADMIN, build_app, load_tree, make_settings
from .fake_anthropic import FakeClient, design, edit_reply, response
from .test_roles import employee

TOKEN = "ExponentPushToken[owner-phone-0001]"


@pytest.fixture
def push(app):
    return app.state.test_push


@pytest.fixture
def fake(app):
    holder = FakeClient([])
    app.dependency_overrides[get_llm] = lambda: LLM(client=holder)
    yield holder
    app.dependency_overrides.clear()


def register(client, h, token=TOKEN, platform="android", device_id="phone-1"):
    r = client.post("/devices", json={"push_token": token, "platform": platform, "device_id": device_id}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def task(client, h, r):
    assert r.status_code == 202, r.text
    t = client.get(f"/tasks/{r.json()['task_id']}", headers=h).json()
    assert t["status"] == "done", t
    return t["result"]


# --- 1. Цена в списке проектов ---


def test_project_list_price_from_cache(api, client, owner):
    pid = api.project(owner, title="Шкаф Азизы")
    item = client.get("/projects", headers=owner).json()["items"][0]
    assert item["price"] is None  # смету ещё не считали — список не пересчитывает
    card = client.get(f"/projects/{pid}", headers=owner).json()
    assert card["price"] == {"from": card["estimate"]["total"]["from"], "to": card["estimate"]["total"]["to"]}
    item = client.get("/projects", headers=owner).json()["items"][0]
    assert item["price"] == card["price"] and item["price"]["from"] < item["price"]["to"]
    # новая версия — своя цена (ещё не посчитана)
    client.post(f"/projects/{pid}/model", json={"tree": load_tree() | {"width": 1300}}, headers=owner)
    assert client.get("/projects", headers=owner).json()["items"][0]["price"] is None


# --- 2. «Оценка» на сервере ---


def test_estimated_pointers_confirm_and_measurement(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    fake.replies.append(response(design(estimated=["/height", "/depth", "/sections/0/width"])))
    out = task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф 1,2 м"}, headers=owner))
    vid = out["version_id"]
    v = client.get(f"/projects/{pid}/versions/{vid}", headers=owner).json()
    assert v["estimated"] == ["/height", "/depth", "/sections/0/width"]
    r = client.post(f"/projects/{pid}/versions/{vid}/confirm", json={"pointers": ["/depth"]}, headers=owner)
    assert r.status_code == 200 and r.json()["estimated"] == ["/height", "/sections/0/width"]
    # другое устройство видит то же
    assert client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["estimated"] == [
        "/height", "/sections/0/width"]
    # правка поля снимает пометку только с изменённого значения
    tree = v["tree"]
    tree["sections"][0]["width"] = 500
    s = client.post(f"/projects/{pid}/model", json={"tree": tree}, headers=owner).json()
    assert s["version"]["estimated"] == ["/height"]
    # замер: высота с замера подтверждена; модель получила новые размеры новой версией
    client.post(f"/projects/{pid}/sketch", headers=owner)
    m = client.post(f"/projects/{pid}/measurements", json={"height": 2350}, headers=owner).json()
    assert m["applied_version_id"] and m["apply_error"] is None
    cur = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    assert cur["id"] == m["applied_version_id"] and cur["tree"]["height"] == 2350 and cur["estimated"] == []
    assert cur["label"].startswith("Замер")
    # замер с теми же размерами не создаёт версию
    m2 = client.post(f"/projects/{pid}/measurements", json={"height": 2350}, headers=owner).json()
    assert m2["applied_version_id"] is None


def test_measurement_that_breaks_model_keeps_version(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "sketch")
    before = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["id"]
    m = client.post(f"/projects/{pid}/measurements", json={"width": 300}, headers=owner).json()
    assert m["applied_version_id"] is None and m["apply_error"]
    assert client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["id"] == before


# --- 3. Push ---


def test_devices_register_and_delete(api, client, owner, db):
    d = register(client, owner)
    assert d["has_push"] and d["platform"] == "android"
    # тот же телефон, новый токен — та же строка
    d2 = register(client, owner, token="ExponentPushToken[owner-phone-0002]")
    assert d2["id"] == d["id"]
    # токен «переехал» к другому номеру — у первого отвязывается
    other = api.login("+998935550111")
    register(client, other, token="ExponentPushToken[owner-phone-0002]", device_id="phone-1")
    assert db.get(Device, uuid.UUID(d["id"])).push_token is None
    assert client.delete("/devices?device_id=phone-1", headers=other).json() == {"ok": True}
    assert client.delete("/devices", headers=other).status_code == 422
    # старый путь приложения (POST /devices с полем token) тоже принимается
    assert client.post("/devices", json={"token": TOKEN, "platform": "ios"}, headers=owner).status_code == 200


def test_share_open_and_ar_push_with_dedupe(api, client, owner, push):
    register(client, owner)
    pid = api.project(owner, title="Шкаф Азизы")
    api.advance(owner, pid, "sketch")
    token = client.post(f"/projects/{pid}/share-links", json={}, headers=owner).json()["token"]
    for _ in range(3):
        assert client.post(f"/share/{token}/events", json={"event": "opened"}).status_code == 204
    client.post(f"/share/{token}/events", json={"event": "ar_started"})
    bodies = [m.body for m in push.sent]
    assert bodies == ["Клиент смотрит «Шкаф Азизы» прямо сейчас", "Клиент примерил «Шкаф Азизы» у себя в комнате"]
    assert push.sent[0].to == TOKEN and push.sent[0].data["project_id"] == pid
    assert push.sent[0].data["kind"] == "share_opened" and push.sent[0].data["notification_id"]
    lst = client.get("/notifications", headers=owner).json()
    assert [n["kind"] for n in lst] == ["ar_started", "share_opened"] and lst[0]["status"] == "sent"
    assert client.post(f"/notifications/{lst[0]['id']}/read", headers=owner).json() == {"ok": True}


def test_push_in_uzbek_and_device_not_registered(api, client, owner, app, db):
    client.patch("/auth/me", json={"language": "uz"}, headers=owner)
    register(client, owner, token="ExponentPushToken[dead]")
    app.state.test_push.fail_tokens.add("ExponentPushToken[dead]")
    pid = api.project(owner, title="Shkaf")
    api.advance(owner, pid, "sketch")
    token = client.post(f"/projects/{pid}/share-links", json={}, headers=owner).json()["token"]
    client.post(f"/share/{token}/events", json={"event": "opened"})
    n = db.query(Notification).one()
    assert n.body == "Mijoz hozir «Shkaf» loyihasini ko‘ryapti" and n.status == "failed"
    assert n.error == "DeviceNotRegistered"
    assert db.query(Device).one().push_token is None  # токен удалённого приложения больше не используем


def test_limit_one_left_push(api, client, owner, push):
    register(client, owner)
    for i in range(2):
        pid = api.project(owner, title=f"П{i}")
        api.advance(owner, pid, "sketch")
    assert [m.body for m in push.sent] == ["Остался 1 проект. Закажите материалы по проекту — лимит вернётся"]


def test_order_status_push_to_owner(api, client, owner, push):
    register(client, owner)
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    order = client.post(f"/projects/{pid}/orders", json={}, headers=owner).json()
    client.post(f"/admin/projects/{pid}/order-paid", json={}, headers=ADMIN)
    for st in ("accepted", "cutting", "ready"):
        client.post(f"/admin/orders/{order['id']}/status", json={"status": st}, headers=ADMIN)
    bodies = [m.body for m in push.sent]
    assert bodies[-1] == f"Заказ №{order['number']} готов к выдаче"
    assert f"Заказ №{order['number']} оплачен" in bodies and len(bodies) == 4
    assert push.sent[-1].data["order_id"] == order["id"]


def test_model_ready_push_when_master_left(tmp_path, monkeypatch):
    """Задача ИИ закончилась, а приложение давно не спрашивало статус → push «модель готова» с ценой."""
    from fastapi.testclient import TestClient

    from .conftest import Api

    application = build_app(make_settings(tmp_path, push_presence_seconds=-1))
    holder = FakeClient([response(design())])
    application.dependency_overrides[get_llm] = lambda: LLM(client=holder)
    with TestClient(application) as c:
        a = Api(c, application.state.test_sender)
        h = a.login()
        register(c, h)
        pid = a.project(h, title="Шкаф для Азизы", tree=None)
        r = c.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=h)
        assert r.status_code == 202
    sent = application.state.test_push.sent
    assert len(sent) == 1 and sent[0].title == "Модель готова"
    assert sent[0].body.startswith("Шкаф для Азизы готов — ") and "млн" in sent[0].body
    application.state.db.engine.dispose()


def test_model_ready_no_push_when_master_polls(api, client, owner, fake, push):
    register(client, owner)
    pid = api.project(owner, tree=None)
    fake.replies.append(response(design()))
    task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner))
    assert push.sent == []


def test_templates_and_expo_sender():
    assert money_short(9_800_000, "ru") == "9,8 млн" and money_short(450_000, "uz") == "450 ming"
    assert price_text({"from": 9_800_000, "to": 11_200_000}, "ru") == "9,8–11,2 млн"
    title, body = render("prices_stale", "uz", {"title": "Shkaf"})
    assert "EMAN" in body and title == "Narxlar o‘zgardi"
    sent = {}

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"data": [{"status": "ok", "id": "t1"}, {"status": "error",
                                                                         "details": {"error": "DeviceNotRegistered"}}]}).encode()

    def opener(req, timeout):
        sent["url"], sent["body"], sent["auth"] = req.full_url, json.loads(req.data), req.headers.get("Authorization")
        return Resp()

    s = ExpoPushSender(access_token="secret", opener=opener)
    out = s.send([PushMessage("ExponentPushToken[a]", "T", "B", {"project_id": "p"}),
                  PushMessage("ExponentPushToken[b]", "T", "B")])
    assert sent["url"] == "https://exp.host/--/api/v2/push/send" and sent["auth"] == "Bearer secret"
    assert sent["body"][0]["data"] == {"project_id": "p"} and out[1]["details"]["error"] == "DeviceNotRegistered"

    def failing(req, timeout):
        raise OSError("network down")

    assert ExpoPushSender(opener=failing).send([PushMessage("x", "T", "B")])[0]["status"] == "error"


# --- 4. Заказы и оплата ---


def test_orders_for_app_payment_states(api, client, owner):
    pid = api.project(owner, title="Шкаф Азизы")
    api.advance(owner, pid, "contract")
    prev = client.get(f"/projects/{pid}/orders/preview", headers=owner).json()
    assert prev["delivery"] is None and prev["total"] == prev["goods_total"]  # самовывоз
    assert "ХДФ 3 Белый" in prev["excluded"]  # «под запрос» — не в заказе
    order = client.post(f"/projects/{pid}/orders", json={"distance_km": 12}, headers=owner).json()
    assert int(order["number"]) >= 1001 and order["payment"] == {
        "status": "waiting", "method": None, "url": None, "paid_at": None, "reference": None}
    assert order["steps"][0] == {**order["steps"][0], "status": "created", "done": True, "current": True}
    assert order["delivery"]["distance_km"] == 12 and not order["pickup"]
    assert any(i["excluded"] for i in order["items"]) and order["cancellable"]

    lst = client.get("/orders", headers=owner).json()
    assert lst["total"] == 1 and lst["items"][0]["project_title"] == "Шкаф Азизы"
    assert client.get("/orders?status=paid", headers=owner).json()["total"] == 0

    r = client.post(f"/admin/orders/{order['id']}/payment", json={"url": "https://pay.eman.uz/i/123", "method": "click"},
                    headers=ADMIN)
    assert r.status_code == 200 and r.json()["payment_url"] == "https://pay.eman.uz/i/123"
    card = client.get(f"/orders/{order['id']}", headers=owner).json()
    assert card["payment"]["status"] == "waiting" and card["payment"]["url"] == "https://pay.eman.uz/i/123"
    client.post(f"/admin/orders/{order['id']}/payment", json={"failed": True}, headers=ADMIN)
    assert client.get(f"/orders/{order['id']}", headers=owner).json()["payment"]["status"] == "failed"
    client.post(f"/admin/projects/{pid}/order-paid", json={"payment_provider": "click"}, headers=ADMIN)
    card = client.get(f"/orders/{order['id']}", headers=owner).json()
    assert card["payment"]["status"] == "paid" and card["status"] == "paid" and not card["cancellable"]
    assert [s["done"] for s in card["steps"]] == [True, True, False, False, False, False]
    assert client.post(f"/orders/{order['id']}/cancel", json={}, headers=owner).status_code == 409

    emp = employee(api, client, owner)
    e = client.get(f"/orders/{order['id']}", headers=emp).json()
    assert "total" not in e and "amount" not in e["items"][0] and e["payment"] == {"status": "paid"}
    other = api.login("+998935550222")
    assert client.get(f"/orders/{order['id']}", headers=other).status_code == 404


def test_master_cancels_unpaid_order(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    order = client.post(f"/projects/{pid}/orders", json={}, headers=owner).json()
    r = client.post(f"/orders/{order['id']}/cancel", json={"reason": "клиент отказался"}, headers=owner)
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert client.post(f"/projects/{pid}/orders", json={}, headers=owner).status_code == 201  # можно заново


# --- 5. Нестандарт ---


def test_nonstandard_roundtrip(api, client, owner, push):
    register(client, owner)
    pid = api.project(owner, title="Гардероб")
    ph = client.post(f"/projects/{pid}/photos", files={"file": ("a.jpg", b"\xff\xd8\xff" + b"0" * 50, "image/jpeg")},
                     headers=owner).json()
    r = client.post(f"/projects/{pid}/nonstandard", json={"description": "Радиусные двери", "photo_ids": [ph["id"]],
                                                          "differences": ["гнутые фасады"]}, headers=owner)
    assert r.status_code == 201, r.text
    ns = r.json()
    assert ns["status"] == "sent" and ns["differences"] == ["гнутые фасады"] and not ns["can_accept"]
    assert client.post(f"/projects/{pid}/nonstandard/{ns['id']}/accept", headers=owner).status_code == 409

    q = client.get("/admin/nonstandard?status=sent", headers=ADMIN).json()
    assert q["total"] == 1 and q["items"][0]["workshop_name"]
    assert client.get(f"/admin/nonstandard/{ns['id']}", headers=ADMIN).json()["photos"][0]["id"] == ph["id"]
    r = client.patch(f"/admin/nonstandard/{ns['id']}", json={"assignee": "Конструктор EMAN", "price": 1_500_000,
                                                             "lead_days": 5}, headers=ADMIN)
    assert r.json()["status"] == "estimated"
    assert push.sent[-1].body == "«Гардероб»: 1,5 млн, срок 5 дн. Примите цену в приложении"
    ns = client.post(f"/projects/{pid}/nonstandard/{ns['id']}/accept", headers=owner).json()
    assert ns["status"] == "in_work" and ns["accepted_at"]

    r = client.post(f"/admin/nonstandard/{ns['id']}/files", files={"file": ("Двери_радиус.dxf", b"0\nSECTION", "image/vnd.dxf")},
                    headers=ADMIN)
    assert r.status_code == 201
    r = client.patch(f"/admin/nonstandard/{ns['id']}", json={"status": "done"}, headers=ADMIN)
    assert r.json()["status"] == "done" and push.sent[-1].body == "«Гардероб»: доработанные файлы в проекте"
    ns = client.get(f"/projects/{pid}/nonstandard", headers=owner).json()[0]
    assert [s["done"] for s in ns["steps"]] == [True, True, True, True]
    f = ns["files"][0]
    d = client.get(f["url"], headers=owner)
    assert d.status_code == 200 and d.content == b"0\nSECTION"
    assert "filename*=UTF-8''%D0%94%D0%B2%D0%B5%D1%80%D0%B8" in d.headers["content-disposition"]


def test_nonstandard_takes_differences_from_ai(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    fake.replies.append(response(design(differences=["радиусный торец"])))
    task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner))
    ns = client.post(f"/projects/{pid}/nonstandard", json={"description": "Сделайте как на фото"}, headers=owner).json()
    assert ns["differences"] == ["радиусный торец"]
    assert client.post(f"/projects/{pid}/nonstandard/{ns['id']}/cancel", headers=owner).json()["status"] == "cancelled"


# --- 6. «Под запрос» ---


def test_price_request_flow(api, client, owner, push):
    register(client, owner)
    pid = api.project(owner, title="Шкаф А")
    pid2 = api.project(owner, title="Шкаф Б")
    reqs = client.get(f"/projects/{pid}/price-requests", headers=owner).json()  # считает смету, если нужно
    client.get(f"/projects/{pid2}", headers=owner)  # смета второго проекта — тоже в очередь
    assert [r["line_key"] for r in reqs] == ["sheet:hdf_3_white"] and reqs[0]["status"] == "pending"
    queue = client.get("/admin/price-requests?status=pending", headers=ADMIN).json()
    assert queue["total"] == 2 and queue["items"][0]["catalog_target"] == ["sheet", "hdf_3_white"]
    assert client.post(f"/projects/{pid}/price-requests/{reqs[0]['id']}/accept", headers=owner).status_code == 409

    r = client.post(f"/admin/price-requests/{reqs[0]['id']}/price",
                    json={"price": 180_000, "lead_days": 3, "supplier_name": "EMAN"}, headers=ADMIN)
    assert r.status_code == 200 and len(r.json()["applied_to"]) == 2  # и во втором проекте
    assert [m.body for m in push.sent] == ["Цена на «ХДФ 3 Белый» добавлена в смету"] * 2
    item = client.get("/catalog/items?q=REQ-hdf", headers=owner).json()["items"][0]
    assert item["core_key"] == "hdf_3_white" and item["price"] == 180_000
    # смета теперь считает позицию как каталожную
    lines = client.get(f"/projects/{pid}/estimate", headers=owner).json()["lines"]
    hdf = next(l for l in lines if l["key"] == "sheet:hdf_3_white")
    assert hdf["status"] == "catalog" and hdf["unit_price"] == 180_000

    r = client.get(f"/projects/{pid}/price-requests", headers=owner).json()[0]
    assert r["status"] == "priced" and r["delta"] == 15_000 and r["lead_days"] == 3
    # до «принять» позиция в заказ не идёт
    api.advance(owner, pid, "contract")
    prev = client.get(f"/projects/{pid}/orders/preview", headers=owner).json()
    assert "ХДФ 3 Белый" in prev["excluded"] and not any(l["key"] == "sheet:hdf_3_white" for l in prev["lines"])
    client.post(f"/projects/{pid}/price-requests/{r['id']}/accept", headers=owner)
    prev2 = client.get(f"/projects/{pid}/orders/preview", headers=owner).json()
    assert any(l["key"] == "sheet:hdf_3_white" for l in prev2["lines"]) and prev2["total"] > prev["total"]
    # отказ во втором проекте — позиция исключена
    r2 = client.get(f"/projects/{pid2}/price-requests", headers=owner).json()[0]
    assert client.post(f"/projects/{pid2}/price-requests/{r2['id']}/decline", headers=owner).json()["status"] == "declined"


# --- 7. Декоры, 8. раскрой, фурнитура ---


def test_decors_from_core_and_catalog(api, client, owner):
    d = client.get("/catalog/decors", headers=owner).json()["items"]
    ids = {x["id"] for x in d}
    assert {"ldsp_16_white", "ldsp_16_oak", "hdf_3_white"} <= ids and "mirror_4_silver" not in ids
    oak = next(x for x in d if x["id"] == "ldsp_16_oak")
    assert oak["has_grain"] and oak["thickness"] == 16 and oak["source"] == "core" and oak["color"].startswith("#")
    supplier = client.post("/admin/suppliers", json={"code": "eman2", "name": "EMAN"}, headers=ADMIN).json()
    client.post("/admin/catalog/items", json={"supplier_id": supplier["id"], "sku": "EG-H3395", "type": "sheet",
                                              "name": "ЛДСП Egger H3395 Дуб Сонома 16", "core_key": "ldsp_16_oak",
                                              "thickness_mm": 16, "decor": "H3395", "has_grain": True,
                                              "price": 700_000, "unit": "лист", "available": False}, headers=ADMIN)
    oak = next(x for x in client.get("/catalog/decors", headers=owner).json()["items"] if x["id"] == "ldsp_16_oak")
    assert oak["source"] == "catalog" and oak["available"] is False and oak["decor"] == "H3395"
    assert "price" not in oak
    found = client.get("/catalog/decors?q=дуб&kind=ldsp", headers=owner).json()["items"]
    assert found and any("oak" in x["id"] for x in found) and all("дуб" in x["name"].lower() for x in found)


def test_nesting_layout(api, client, owner):
    pid = api.project(owner)
    n = client.get(f"/projects/{pid}/nesting", headers=owner).json()
    assert n["sheets_total"] >= 2 and n["unplaced"] == [] and n["trim"] == 10
    m = n["materials"][0]
    s = m["sheets"][0]
    assert s["length"] == 2800 and s["width"] == 2070 and 0 < s["usage"] <= 1
    p = s["parts"][0]
    assert p["name"] and p["x"] >= 10 and p["x"] + p["length"] <= 2800 and p["y"] + p["width"] <= 2070
    assert 0 <= m["waste_percent"] < 100
    assert client.get(f"/projects/{api.project(owner, tree=None)}/nesting", headers=owner).status_code == 409


def test_hardware_options_and_apply(api, client, owner):
    groups = client.get(f"/projects/{api.project(owner)}/hardware", headers=owner).json()["groups"]
    assert [g["key"] for g in groups] == ["lighting"]  # без дверей — только подсветка ниш
    pid = api.project(owner, tree=load_tree("wardrobe_full"))
    h = client.get(f"/projects/{pid}/hardware", headers=owner).json()
    keys = [g["key"] for g in h["groups"]]
    assert "hinge" in keys and h["editable"]
    hinge = next(g for g in h["groups"] if g["key"] == "hinge")
    cur = next(o for o in hinge["options"] if o["current"])
    alt = next(o for o in hinge["options"] if not o["current"] and o["available"])
    assert cur["delta"] == 0 and isinstance(alt["delta"], int) and "patch" not in alt
    r = client.post(f"/projects/{pid}/hardware", json={"key": "hinge", "value": alt["value"]}, headers=owner)
    assert r.status_code == 201, r.text
    st = r.json()
    assert st["can_undo"] and st["version"]["tree"]["hardware"]["hinge"] == alt["value"]
    assert st["version"]["label"].startswith("Петли")
    assert client.post(f"/projects/{pid}/hardware", json={"key": "hinge", "value": alt["value"]},
                       headers=owner).status_code == 409
    assert client.post(f"/projects/{pid}/hardware", json={"key": "hinge", "value": "golden"},
                       headers=owner).status_code == 404
    assert client.post(f"/projects/{pid}/model/undo", headers=owner).status_code == 200


# --- 9. Имена файлов, 10. чат, 11. задачи ---


def test_file_names_utf8(api, client, owner):
    pid = api.project(owner, title="Шкаф Азиза")
    api.advance(owner, pid, "in_work")
    r = client.get(f"/projects/{pid}/files/spec_pdf", headers=owner)
    cd = r.headers["content-disposition"]
    from urllib.parse import unquote

    assert r.headers["content-type"] == "application/pdf"
    assert unquote(cd.split("filename*=UTF-8''")[1]) == "Шкаф_Азиза_спецификация_v1.pdf"
    assert 'filename="project_spec_pdf_v1.pdf"' in cd
    files = client.get(f"/projects/{pid}/files", headers=owner).json()["files"]
    csv = next(f for f in files if f["kind"] == "csv")
    assert csv["file_name"] == "Шкаф_Азиза_онлайн_крой_v1.csv" and csv["content_type"].startswith("text/csv")
    client.patch("/auth/me", json={"language": "uz"}, headers=owner)
    cd = client.get(f"/projects/{pid}/files/kp_pdf", headers=owner).headers["content-disposition"]
    assert unquote(cd.split("filename*=UTF-8''")[1]) == "Шкаф_Азиза_TK_v1.pdf"


def test_chat_pairs_undone_after_undo_and_redo(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    fake.replies.append(response(design()))
    task(client, owner, client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner))
    fake.replies.append(response(edit_reply([{"op": "replace", "path": "/width", "value_json": "1400"}], "Шире")))
    out = task(client, owner, client.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире на 20"}, headers=owner))
    msgs = client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"]
    assert [(m["author"], m["kind"]) for m in msgs] == [("master", "design"), ("ai", "design"), ("master", "edit"),
                                                        ("ai", "edit")]
    assert msgs[2]["version_id"] == msgs[3]["version_id"] == out["version_id"]
    client.post(f"/projects/{pid}/model/undo", headers=owner)
    msgs = client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"]
    assert [m["undone"] for m in msgs] == [False, False, True, True]
    client.post(f"/projects/{pid}/model/redo", headers=owner)
    msgs = client.get(f"/projects/{pid}/chat", headers=owner).json()["messages"]
    assert [m["undone"] for m in msgs] == [False, False, False, False]
    # цена после правки — в кэше версии (список проектов)
    assert client.get("/projects", headers=owner).json()["items"][0]["price"]


def test_task_has_status(api, client, owner, fake):
    pid = api.project(owner, tree=None)
    fake.replies.append(response(design()))
    r = client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner)
    t = client.get(f"/tasks/{r.json()['task_id']}", headers=owner).json()
    assert t["status"] == "done" and t["state"] == "done" and t["id"] == r.json()["task_id"]
