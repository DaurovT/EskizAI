"""Данные для экранов нового дизайна: подсказки в списке, настройки уведомлений, платежи, логотип,
дубль проекта, цена версии, цена файлов, «действует до», комментарий конструктора, счёт EMAN."""

import uuid
from datetime import timedelta
from pathlib import Path

from mebel_api.db import utcnow
from mebel_api.models import ShareLink, User
from mebel_api.services import notif_settings
from mebel_api.services.notify import PushMessage

from .conftest import ADMIN, tree_variant
from .test_roles import employee

TOKEN = "ExponentPushToken[owner-phone-0001]"
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


def register(client, h):
    r = client.post("/devices", json={"push_token": TOKEN, "platform": "android", "device_id": "p1"}, headers=h)
    assert r.status_code == 200, r.text


def hints(client, h) -> dict:
    return {i["title"]: i["activity"] for i in client.get("/projects", headers=h).json()["items"]}


# --- 1. Подсказки в списке проектов ---


def test_activity_hints(api, client, owner, db):
    a = api.project(owner, title="Ссылка")
    api.advance(owner, a, "sent")
    b = api.project(owner, title="Заказ")
    api.advance(owner, b, "contract")
    order = client.post(f"/projects/{b}/orders", json={}, headers=owner).json()
    api.project(owner, title="Черновик")

    h = hints(client, owner)
    assert h["Черновик"] is None
    assert h["Ссылка"] is None  # ссылку отправили только что
    assert h["Заказ"] == {"text": "ждёт оплаты", "tone": "amber"}

    link = db.query(ShareLink).filter_by(project_id=uuid.UUID(a)).one()
    link.created_at = utcnow() - timedelta(days=3, hours=1)
    db.commit()
    assert hints(client, owner)["Ссылка"] == {"text": "не открыл 3 дн.", "tone": "amber"}
    token = link.token
    for _ in range(2):
        client.post(f"/share/{token}/events", json={"event": "opened"})
    assert hints(client, owner)["Ссылка"] == {"text": "открыл 2 раза", "tone": "green"}
    client.post(f"/share/{token}/agree")
    assert hints(client, owner)["Ссылка"] == {"text": "клиент согласен", "tone": "green"}

    client.post(f"/admin/projects/{b}/order-paid", json={}, headers=ADMIN)
    assert hints(client, owner)["Заказ"]["text"] == f"заказ EMAN №{order['number']}"
    for st in ("accepted", "cutting", "ready"):
        client.post(f"/admin/orders/{order['id']}/status", json={"status": st}, headers=ADMIN)
    assert hints(client, owner)["Заказ"] == {"text": "готов — забрать в EMAN", "tone": "green"}

    client.patch("/auth/me", json={"language": "uz"}, headers=owner)
    assert hints(client, owner)["Заказ"]["text"] == "tayyor — EMANdan olib keting"


# --- 2. Настройки уведомлений ---


def test_notification_settings_defaults_and_patch(client, owner):
    s = client.get("/me/notification-settings", headers=owner).json()
    assert [t["key"] for t in s["types"]] == list(notif_settings.TYPES)
    assert all(t["enabled"] for t in s["types"]) and s["types"][0]["title"] == "Клиент открыл ссылку"
    assert s["quiet"] == {"enabled": True, "from": "22:00", "to": "08:00", "timezone": "Asia/Tashkent", "silent": True}

    r = client.patch("/me/notification-settings", json={"types": {"prices_stale": False},
                                                         "quiet": {"from": "23:00"}}, headers=owner)
    assert r.status_code == 200, r.text
    s = r.json()
    assert {t["key"]: t["enabled"] for t in s["types"]}["prices_stale"] is False
    assert s["quiet"]["from"] == "23:00" and s["quiet"]["to"] == "08:00" and s["quiet"]["enabled"]
    s = client.patch("/me/notification-settings", json={"quiet": {"enabled": False}}, headers=owner).json()
    assert s["quiet"]["enabled"] is False and s["quiet"]["from"] == "23:00"

    assert client.patch("/me/notification-settings", json={"types": {"bogus": True}},
                        headers=owner).status_code == 422
    assert client.patch("/me/notification-settings", json={"quiet": {"to": "25:00"}}, headers=owner).status_code == 422
    client.patch("/auth/me", json={"language": "uz"}, headers=owner)
    assert client.get("/me/notification-settings", headers=owner).json()["types"][0]["title"] == "Mijoz havolani ochdi"


def test_disabled_type_is_muted_and_quiet_hours_silent(api, client, owner, app, db, monkeypatch):
    push = app.state.test_push
    register(client, owner)
    client.patch("/me/notification-settings", json={"types": {"client_opened": False},
                                                     "quiet": {"enabled": False}}, headers=owner)
    pid = api.project(owner)
    api.advance(owner, pid, "sent")
    token = db.query(ShareLink).filter_by(project_id=uuid.UUID(pid)).one().token
    client.post(f"/share/{token}/events", json={"event": "opened"})
    assert push.sent == []  # выключено — push нет
    lst = client.get("/notifications", headers=owner).json()
    assert lst[0]["kind"] == "share_opened" and lst[0]["status"] == "muted"  # в истории осталось

    # согласие клиента — свой тип, включён; тихие часы на весь день → без звука
    client.patch("/me/notification-settings", json={"quiet": {"enabled": True, "from": "00:00", "to": "23:59"}},
                 headers=owner)
    monkeypatch.setattr(notif_settings, "in_quiet_hours", lambda user, now: True)
    client.post(f"/share/{token}/agree")
    assert [m.body for m in push.sent] == ["Клиент согласовал «Шкаф»"]
    assert push.sent[0].silent and "sound" not in push.sent[0].expo() and push.sent[0].expo()["channelId"] == "quiet"
    client.post(f"/share/{token}/agree")
    assert len(push.sent) == 1  # согласие — один раз


def test_quiet_hours_window():
    u = User(phone="+998900000000", notification_settings=None)
    tz = timedelta(hours=5)  # Ташкент = UTC+5
    at = lambda h, m=0: (utcnow().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(hours=h, minutes=m) - tz)
    assert notif_settings.in_quiet_hours(u, at(23)) and notif_settings.in_quiet_hours(u, at(7, 59))
    assert not notif_settings.in_quiet_hours(u, at(8)) and not notif_settings.in_quiet_hours(u, at(12))
    u.notification_settings = {"quiet": {"enabled": False}}
    assert not notif_settings.in_quiet_hours(u, at(23))
    assert PushMessage(to="x", title="t", body="b").expo()["sound"] == "default"


# --- 3. Платежи ---


def test_payment_history(api, client, owner):
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    pid = api.project(owner, title="Стеллаж")
    pid2 = api.project(owner, title="Тумба")
    assert client.get("/billing/payments", headers=owner).json() == {"items": [], "total": 0}

    r = client.post(f"/admin/workshops/{wid}/payments", json={"kind": "pack", "amount": 125_000, "method": "app_store",
                                                               "paid_at": "2026-11-02T18:58:00+05:00"}, headers=ADMIN)
    assert r.status_code == 201, r.text
    pro = client.post(f"/admin/workshops/{wid}/payments", json={"kind": "pro", "amount": 150_000, "method": "click",
                                                                 "paid_at": "2026-10-01T10:00:00+05:00"}, headers=ADMIN).json()
    assert client.post(f"/admin/payments/{pro['id']}/refund", headers=ADMIN).json()["status"] == "refunded"
    assert client.post(f"/admin/payments/{pro['id']}/refund", headers=ADMIN).status_code == 409
    # оплата файлов вместе с открытием доступа; и раннее открытие «по оплате» без суммы
    client.post(f"/admin/projects/{pid}/file-access", json={"basis": "payment", "amount": 45_000, "method": "payme",
                                                             "receipt_url": "https://payme.uz/r/1"}, headers=ADMIN)
    client.post(f"/admin/projects/{pid2}/file-access", json={"basis": "payment"}, headers=ADMIN)
    client.post(f"/admin/projects/{pid2}/file-access", json={"basis": "admin"}, headers=ADMIN)  # не платёж

    data = client.get("/billing/payments", headers=owner).json()
    items = data["items"]
    assert data["total"] == 4
    files = [i for i in items if i["kind"] == "files"]
    assert {i["title"] for i in files} == {"Файлы проекта «Стеллаж»", "Файлы проекта «Тумба»"}
    paid_files = next(i for i in files if i["amount"] == 45_000)
    assert paid_files["method_label"] == "Payme" and paid_files["receipt_url"] == "https://payme.uz/r/1"
    assert next(i for i in files if i["amount"] is None)["project_id"] == pid2
    pack = next(i for i in items if i["kind"] == "pack")
    assert pack["title"] == "Пакет 10 проектов" and pack["method_label"] == "App Store" and pack["currency"] == "UZS"
    pro_row = next(i for i in items if i["kind"] == "pro")
    assert pro_row["title"] == "Pro · октябрь" and pro_row["status"] == "refunded" and pro_row["refunded_at"]
    assert items[-1]["kind"] == "pro"  # новые сверху

    client.patch("/auth/me", json={"language": "uz"}, headers=owner)
    assert next(i for i in client.get("/billing/payments", headers=owner).json()["items"]
                if i["kind"] == "pro")["title"] == "Pro · oktyabr"
    assert client.get("/billing/payments", headers=employee(api, client, owner)).status_code == 403
    assert client.post(f"/admin/workshops/{wid}/payments", json={"kind": "files", "amount": 1,
                                                                  "project_id": str(uuid.uuid4())},
                       headers=ADMIN).status_code == 404


# --- 4. Логотип цеха ---


def test_logo_upload_replace_delete(api, client, owner, settings):
    r = client.post("/workshops/me/logo", files={"file": ("logo.png", PNG, "image/png")}, headers=owner)
    assert r.status_code == 200, r.text
    url = r.json()["logo_url"]
    first = Path(settings.media_dir) / url.removeprefix(settings.media_base_url + "/")
    assert first.read_bytes() == PNG and "/logo/" in url
    r = client.post("/workshops/me/logo", files={"file": ("l.jpg", b"\xff\xd8\xff" + b"1" * 10, "image/jpeg")},
                    headers=owner)
    assert r.json()["logo_url"].endswith(".jpg") and not first.exists()  # прежний файл удалён

    assert client.post("/workshops/me/logo", files={"file": ("l.svg", b"<svg/>", "image/svg+xml")},
                       headers=owner).status_code == 415
    big = b"0" * (2 * 1024 * 1024 + 1)
    assert client.post("/workshops/me/logo", files={"file": ("l.png", big, "image/png")},
                       headers=owner).status_code == 413
    assert client.post("/workshops/me/logo", files={"file": ("l.png", b"", "image/png")},
                       headers=owner).status_code == 422
    emp = employee(api, client, owner)
    assert client.post("/workshops/me/logo", files={"file": ("l.png", PNG, "image/png")},
                       headers=emp).status_code == 403

    r = client.delete("/workshops/me/logo", headers=owner)
    assert r.status_code == 200 and r.json()["logo_url"] is None
    assert not any((Path(settings.media_dir)).rglob("logo/*"))


# --- 5. Дублировать проект ---


def test_duplicate_project(api, client, owner):
    c = client.post("/clients", json={"name": "Азиза"}, headers=owner).json()
    pid = api.project(owner, title="Шкаф Азизы", client_id=c["id"], source_text="как на фото")
    client.post(f"/projects/{pid}/photos", files={"file": ("a.jpg", b"\xff\xd8\xff1", "image/jpeg")}, headers=owner)
    client.post(f"/projects/{pid}/model", json={"tree": tree_variant(width=1300)}, headers=owner)
    api.advance(owner, pid, "sent")
    src_model = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]
    left = client.get("/billing/limits", headers=owner).json()["free_left"]

    r = client.post(f"/projects/{pid}/duplicate", headers=owner)
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["title"] == "Шкаф Азизы (копия)" and d["status"] == "draft" and d["client"]["id"] == c["id"]
    assert d["source_text"] == "как на фото" and len(d["photos"]) == 1 and not d["charged"]
    model = client.get(f"/projects/{d['id']}/model", headers=owner).json()["version"]
    assert model["number"] == 1 and model["tree"] == src_model["tree"]
    assert client.get(f"/projects/{d['id']}/share-links", headers=owner).json() == []
    assert client.get(f"/projects/{d['id']}/measurements", headers=owner).json() == []
    assert client.get("/billing/limits", headers=owner).json()["free_left"] == left  # черновик не списан
    assert client.post(f"/projects/{d['id']}/sketch", headers=owner).json()["charged"]
    assert client.get("/billing/limits", headers=owner).json()["free_left"] == left - 1
    # фото общее: удаление в копии не стирает файл оригинала
    client.delete(f"/projects/{d['id']}/photos/{d['photos'][0]['id']}", headers=owner)
    url = client.get(f"/projects/{pid}", headers=owner).json()["photos"][0]["url"]
    assert client.get(url).status_code == 200
    assert client.post(f"/projects/{uuid.uuid4()}/duplicate", headers=owner).status_code == 404


# --- 6. Цена версии ---


def test_version_price(api, client, owner):
    pid = api.project(owner)
    client.post(f"/projects/{pid}/model", json={"tree": tree_variant(width=1600)}, headers=owner)
    vs = client.get(f"/projects/{pid}/versions", headers=owner).json()
    assert [v["number"] for v in vs] == [2, 1]
    p2, p1 = vs[0]["price"], vs[1]["price"]
    assert p1 and p2 and p2["to"] > p1["to"] and p2["to"] >= p2["from"] and p2["exact"] is False
    # цена запомнилась в версии — карточка и список показывают ту же
    assert client.get(f"/projects/{pid}/versions", headers=owner).json()[0]["price"] == p2
    assert client.get(f"/projects/{pid}/versions/{vs[0]['id']}", headers=owner).json()["price"] == p2


# --- 7. Цена файлов без заказа ---


def test_files_purchase_price(api, client, owner):
    pid = api.project(owner)
    data = client.get(f"/projects/{pid}/files", headers=owner).json()
    assert data["purchase"] == {"price": 45_000, "full_price": 45_000, "discount_pct": 0, "pro_discount_pct": 50,
                                "currency": "UZS"}
    client.patch("/admin/settings", json={"files_price": 60_000, "files_pro_discount_pct": 25}, headers=ADMIN)
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    client.post(f"/admin/workshops/{wid}/plan", json={"plan": "pro"}, headers=ADMIN)
    p = client.get(f"/projects/{pid}/files", headers=owner).json()["purchase"]
    assert p["price"] == 45_000 and p["full_price"] == 60_000 and p["discount_pct"] == 25
    assert client.patch("/admin/settings", json={"files_pro_discount_pct": 120}, headers=ADMIN).status_code == 422
    client.post(f"/admin/projects/{pid}/file-access", json={"basis": "admin"}, headers=ADMIN)
    assert client.get(f"/projects/{pid}/files", headers=owner).json()["purchase"] is None


# --- 8. «Действует до» у цены под запрос ---


def test_price_request_valid_until(api, client, owner, db):
    pid = api.project(owner)
    req = client.get(f"/projects/{pid}/price-requests", headers=owner).json()[0]
    assert req["valid_until"] is None
    r = client.post(f"/admin/price-requests/{req['id']}/price", json={"price": 180_000}, headers=ADMIN).json()
    assert r["valid_until"]
    req = client.get(f"/projects/{pid}/price-requests", headers=owner).json()[0]
    days = (utcnow() + timedelta(days=7)).date().isoformat()
    assert req["valid_until"].startswith(days) and req["expired"] is False

    r = client.post(f"/admin/price-requests/{req['id']}/price",
                    json={"price": 190_000, "valid_until": "2020-01-01T18:00:00+05:00"}, headers=ADMIN).json()
    req = client.get(f"/projects/{pid}/price-requests", headers=owner).json()[0]
    assert req["valid_until"].startswith("2020-01-01") and req["expired"] is True
    r = client.post(f"/projects/{pid}/price-requests/{req['id']}/accept", headers=owner)
    assert r.status_code == 409 and r.json()["error"]["code"] == "price_expired"
    assert client.post(f"/admin/price-requests/{req['id']}/price",
                       json={"price": 1, "valid_until": "2030-01-01T00:00:00"}, headers=ADMIN).status_code == 422


# --- 9. Комментарий конструктора ---


def test_nonstandard_designer_comment(api, client, owner):
    pid = api.project(owner)
    ns = client.post(f"/projects/{pid}/nonstandard", json={"description": "Радиусная ниша"}, headers=owner).json()
    assert ns["designer_comment"] is None
    text = "Нишу сделаем из гнутого МДФ R250, остальное из ваших модулей"
    r = client.patch(f"/admin/nonstandard/{ns['id']}", json={"price": 1_500_000, "lead_days": 2,
                                                             "designer_comment": text}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["status"] == "estimated"
    got = client.get(f"/projects/{pid}/nonstandard/{ns['id']}", headers=owner).json()
    assert got["designer_comment"] == text and got["price"] == 1_500_000


# --- 10. Счёт EMAN ---


def test_order_invoice_pdf(api, client, owner):
    pid = api.project(owner, title="Шкаф Азизы")
    api.advance(owner, pid, "contract")
    order = client.post(f"/projects/{pid}/orders", json={"distance_km": 12}, headers=owner).json()
    assert order["documents"] == [{"kind": "invoice", "title": "Счёт EMAN", "format": "pdf",
                                   "url": f"/orders/{order['id']}/invoice"}]
    r = client.get(f"/orders/{order['id']}/invoice", headers=owner)
    assert r.status_code == 200 and r.content[:4] == b"%PDF" and r.headers["content-type"] == "application/pdf"
    assert f"EMAN_invoice_{order['number']}.pdf" in r.headers["content-disposition"]
    assert "filename*=UTF-8''" in r.headers["content-disposition"]
    client.post(f"/admin/projects/{pid}/order-paid", json={"payment_reference": "PM-1"}, headers=ADMIN)
    client.patch("/auth/me", json={"language": "uz"}, headers=owner)
    assert client.get(f"/orders/{order['id']}/invoice", headers=owner).content[:4] == b"%PDF"

    emp = employee(api, client, owner)
    assert client.get(f"/orders/{order['id']}", headers=emp).json()["documents"] == []
    assert client.get(f"/orders/{order['id']}/invoice", headers=emp).status_code == 403
    assert client.get(f"/orders/{uuid.uuid4()}/invoice", headers=owner).status_code == 404
