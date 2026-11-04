"""Кабинет поставщика и заказ у поставщика (docs/staff_vendor_contract.md §5, форматы мастера — §9):
изоляция поставщиков, очередь и конструкторы, принять / вернуть / отклонить, оплата и производство,
переписка с подписанными ссылками, исправления, возвраты с подтверждением владельца, споры, нестандарт,
позиции без цены, каталог и загрузка прайса, источник цен, деньги и сводка."""

import io
import json
from datetime import timedelta

import pytest
from sqlalchemy import select

from mebel_api.db import utcnow
from mebel_api.models import CatalogItem, Notification, Order, ParserRun, PriceHistory, PriceRequest

from .conftest import ADMIN, tree_variant
from .staff_helpers import make_supplier, staff, superadmin

JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00"


@pytest.fixture
def world(app, client, api, owner):
    """Два поставщика: EMAN (по умолчанию) и металлоцех; у каждого владелец, у EMAN — два конструктора."""
    a = make_supplier(app, "eman", "EMAN Materials")
    b = make_supplier(app, "metal", "Металлоцех")
    w = {
        "a": a, "b": b, "owner": owner,
        "owner_a": staff(app, client, "owner@eman.uz", "vendor_owner", a),
        "des1": staff(app, client, "d1@eman.uz", "vendor_designer", a),
        "des2": staff(app, client, "d2@eman.uz", "vendor_designer", a),
        "owner_b": staff(app, client, "owner@metal.uz", "vendor_owner", b),
    }
    return w


def _order(api, client, owner) -> tuple[str, dict]:
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    r = client.post(f"/projects/{pid}/orders", json={}, headers=owner)
    assert r.status_code == 201, r.text
    return pid, r.json()


def _paid_order(api, client, w) -> tuple[str, dict]:
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    assert client.post(f"/vendor/orders/{oid}/accept", json={"invoice_total": 4_000_000}, headers=w["des1"]).status_code == 200
    r = client.post(f"/vendor/orders/{oid}/status", json={"status": "paid"}, headers=w["des1"])
    assert r.status_code == 200, r.text
    return pid, o


def test_vendor_isolation_between_suppliers(app, client, api, world, db):
    w = world
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    assert o["supplier_id"] == w["a"] and o["supplier_name"] == "EMAN Materials" and o["group_id"]
    b = w["owner_b"]
    assert client.get("/vendor/orders?scope=all", headers=b).json()["total"] == 0
    for method, path, kw in (
        ("get", f"/vendor/orders/{oid}", {}), ("get", f"/vendor/orders/{oid}/csv", {}),
        ("get", f"/vendor/orders/{oid}/files/cutmaps_pdf", {}), ("get", f"/vendor/orders/{oid}/model", {}),
        ("post", f"/vendor/orders/{oid}/take", {}), ("post", f"/vendor/orders/{oid}/accept", {"json": {}}),
        ("post", f"/vendor/orders/{oid}/return", {"json": {"comment": "чужой заказ"}}),
        ("post", f"/vendor/orders/{oid}/reject", {"json": {"reason": "other", "comment": "чужой"}}),
        ("post", f"/vendor/orders/{oid}/status", {"json": {"status": "paid"}}),
        ("patch", f"/vendor/orders/{oid}", {"json": {"notes": "x"}}),
        ("get", f"/vendor/orders/{oid}/messages", {}),
        ("post", f"/vendor/orders/{oid}/messages", {"data": {"text": "привет"}}),
        ("get", f"/vendor/orders/{oid}/corrections", {}),
        ("post", f"/vendor/orders/{oid}/corrections", {"data": {"lines_after": "[]", "comment": "абв"}}),
        ("post", f"/vendor/orders/{oid}/returns", {"data": {"type": "defect", "description": "брак"}}),
        ("post", f"/vendor/orders/{oid}/assign", {"json": {"assignee_id": None}}),
    ):
        r = getattr(client, method)(path, headers=b, **kw)
        assert r.status_code == 404, (path, r.status_code, r.text)
    # платформа и мастер — не в кабинете
    assert client.get("/vendor/dashboard", headers=w["owner"]).status_code == 401
    assert client.get("/vendor/dashboard", headers=ADMIN).status_code == 401
    assert client.get("/vendor/orders", headers=staff(app, client, "om@eskizai.uz", "orders_manager")).status_code == 403
    # блокировка поставщика: его сотрудники не входят в кабинет
    root = superadmin(app, client)
    assert client.post(f"/admin/suppliers/{w['b']}/block", json={"blocked": True}, headers=root).status_code == 422
    assert client.post(f"/admin/suppliers/{w['b']}/block", json={"blocked": True, "reason": "Долг"},
                       headers=root).json()["active"] is False
    assert client.get("/vendor/dashboard", headers=b).json()["error"]["code"] == "supplier_blocked"


def test_queue_take_assign_accept_pay_produce(app, client, api, world, db):
    w = world
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    q = client.get("/vendor/orders?scope=queue", headers=w["des2"]).json()
    assert q["total"] == 1 and q["items"][0]["id"] == oid and q["items"][0]["waiting_hours"] is not None
    d = client.get("/vendor/dashboard", headers=w["des1"]).json()
    assert d["queue"] == 1 and d["mine"] == 0
    assert client.get("/vendor/orders?scope=all", headers=w["des1"]).status_code == 403
    assert client.post(f"/vendor/orders/{oid}/take", headers=w["des1"]).json()["assignee"]["name"] == "d1"
    # второй конструктор больше не видит заказ
    assert client.get(f"/vendor/orders/{oid}", headers=w["des2"]).status_code == 404
    assert client.get("/vendor/orders?scope=mine", headers=w["des1"]).json()["total"] == 1
    # владелец видит всё и переназначает
    des2_id = client.get("/staff/me", headers=w["des2"]).json()["id"]
    assert client.post(f"/vendor/orders/{oid}/assign", json={"assignee_id": des2_id},
                       headers=w["des1"]).status_code == 403
    r = client.post(f"/vendor/orders/{oid}/assign", json={"assignee_id": des2_id}, headers=w["owner_a"])
    assert r.json()["assignee"]["id"] == des2_id
    card = client.get(f"/vendor/orders/{oid}", headers=w["des2"]).json()
    assert card["lines"] and card["workshop"]["phone"] and card["project"]["version"]["number"] >= 1
    assert card["allowed_statuses"] == ["accepted", "returned", "rejected"]
    assert {f["kind"] for f in card["files"]} >= {"csv", "cutmaps_pdf", "dxf_zip", "invoice"}
    for kind in ("csv", "cutmaps_pdf", "invoice"):
        f = client.get(f"/vendor/orders/{oid}/files/{kind}", headers=w["des2"])
        assert f.status_code == 200 and f.content, kind
    assert client.get(f"/vendor/orders/{oid}/csv", headers=w["des2"]).status_code == 200
    # принять: счёт, срок → мастеру push
    due = (utcnow() + timedelta(days=3)).isoformat()
    r = client.post(f"/vendor/orders/{oid}/accept", json={"invoice_total": 4_100_000, "due_date": due,
                                                          "comment": "Проверено"}, headers=w["des2"])
    assert r.status_code == 200 and r.json()["status"] == "accepted"
    m = client.get(f"/orders/{oid}", headers=w["owner"]).json()
    assert m["status"] == "accepted" and m["invoice_total"] == 4_100_000 and m["due_date"]
    assert m["assignee"]["id"] == des2_id and m["cancellable"]
    assert [e["type"] for e in m["events"]] == ["status_changed", "status_changed"]
    assert m["events"][-1] | {"status": "accepted", "actor_type": "vendor"} == m["events"][-1]
    assert [s["status"] for s in m["steps"]][:3] == ["created", "accepted", "paid"]
    assert db.scalar(select(Notification).where(Notification.kind == "order_status")).data["order_id"] == oid
    # недопустимые переходы
    bad = client.post(f"/vendor/orders/{oid}/status", json={"status": "ready"}, headers=w["des2"])
    assert bad.status_code == 409 and bad.json()["error"]["details"]["allowed"] == ["paid", "returned", "rejected"]
    # оплата получена → проект «В работе»; производство
    assert client.post(f"/vendor/orders/{oid}/status", json={"status": "paid"}, headers=w["des2"]).status_code == 200
    assert client.get(f"/projects/{pid}", headers=w["owner"]).json()["status"] == "in_work"
    for st in ("cutting", "ready", "issued"):
        assert client.post(f"/vendor/orders/{oid}/status", json={"status": st}, headers=w["des2"]).status_code == 200
    m = client.get(f"/orders/{oid}", headers=w["owner"]).json()
    assert m["status"] == "issued" and all(s["done"] for s in m["steps"])
    order = db.get(Order, __import__("uuid").UUID(oid))
    db.refresh(order)
    assert order.commission_status == "accrued" and order.commission_amount == 0  # ставки нет
    hist = client.get(f"/vendor/orders/{oid}", headers=w["owner_a"]).json()["history"]
    assert {e["type"] for e in hist} >= {"status_changed", "take", "assign"}


def test_old_flow_paid_before_accept_still_works(client, api, world):
    w = world
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    assert client.post(f"/admin/projects/{pid}/order-paid", json={}, headers=ADMIN).json()["id"] == oid
    card = client.get(f"/vendor/orders/{oid}", headers=w["owner_a"]).json()
    assert card["status"] == "paid" and card["allowed_statuses"] == ["accepted", "cutting"]
    # оплачен, но никому не назначен: конструктор его не видит (не очередь) — назначает владелец
    assert client.get(f"/vendor/orders/{oid}", headers=w["des1"]).status_code == 404
    des1_id = client.get("/staff/me", headers=w["des1"]).json()["id"]
    assert client.post(f"/vendor/orders/{oid}/assign", json={"assignee_id": des1_id},
                       headers=w["owner_a"]).status_code == 200
    assert client.post(f"/vendor/orders/{oid}/accept", json={}, headers=w["des1"]).json()["status"] == "accepted"
    m = client.get(f"/orders/{oid}", headers=w["owner"]).json()
    assert [s["status"] for s in m["steps"]][:3] == ["created", "paid", "accepted"]
    assert client.post(f"/vendor/orders/{oid}/status", json={"status": "cutting"}, headers=w["des1"]).status_code == 200


def test_return_to_master_and_resubmit(client, api, world, db):
    w = world
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    assert client.post(f"/vendor/orders/{oid}/return", json={"comment": ""}, headers=w["des1"]).status_code == 422
    r = client.post(f"/vendor/orders/{oid}/return", json={"comment": "Проверьте ширину ниши"}, headers=w["des1"])
    assert r.json()["status"] == "returned"
    m = client.get(f"/orders/{oid}", headers=w["owner"]).json()
    assert m["status"] == "returned" and m["vendor_status_note"] == "Проверьте ширину ниши" and m["can_resubmit"]
    assert m["unread_count"] == 1  # комментарий ушёл и в переписку
    assert client.post(f"/projects/{pid}/orders", json={}, headers=w["owner"]).status_code == 409  # заказ ещё жив
    # мастер исправляет проект новой версией (договорная заморожена) — заново уходит именно она
    v1 = o["version_id"]
    r = client.post(f"/projects/{pid}/model", json={"tree": tree_variant(width=1300)}, headers=w["owner"])
    assert r.status_code == 201, r.text
    r = client.post(f"/orders/{oid}/resubmit", headers=w["owner"])
    assert r.status_code == 200 and r.json()["status"] == "created" and r.json()["id"] == oid
    assert r.json()["events"][-1]["type"] == "resubmitted"
    v2 = r.json()["version_id"]
    assert v2 != v1 and r.json()["events"][-1]["data"]["version_id"] == v2
    card = client.get(f"/projects/{pid}", headers=w["owner"]).json()
    assert card["frozen_version_id"] == v2 and card["status"] == "contract"
    again = client.post(f"/orders/{oid}/resubmit", headers=w["owner"])
    assert again.status_code == 409 and again.json()["error"]["code"] == "illegal_transition"


def test_reject_and_dispute_resolution(app, client, api, world, db):
    w = world
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    assert client.post(f"/vendor/orders/{oid}/reject", json={"reason": "bogus", "comment": "нет"},
                       headers=w["des1"]).status_code == 422
    r = client.post(f"/vendor/orders/{oid}/reject", json={"reason": "no_material", "comment": "Декора нет до марта"},
                    headers=w["des1"])
    assert r.json()["status"] == "rejected"
    m = client.get(f"/orders/{oid}", headers=w["owner"]).json()
    assert m["reject_reason"] == "no_material" and m["vendor_status_note"] == "Декора нет до марта"
    assert not m["cancellable"]
    # спор об отклонении: multipart subject/reason/comment/files
    r = client.post(f"/orders/{oid}/disputes", data={"subject": "rejection", "reason": "can_be_done",
                                                     "comment": "У соседнего склада есть"},
                    files=[("files", ("a.jpg", b"\xff\xd8jpeg", "image/jpeg"))], headers=w["owner"])
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["subject"] == "rejection" and d["status"] == "open" and d["photos"][0]["url"].startswith("/signed-files/")
    assert set(d) >= {"id", "order_id", "subject", "return_id", "reason", "comment", "photos", "status", "decision",
                      "decision_comment", "amount", "created_at", "resolved_at"}
    dup = client.post(f"/orders/{oid}/disputes", data={"subject": "rejection", "reason": "other"}, headers=w["owner"])
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "dispute_exists"
    assert client.get(f"/orders/{oid}/disputes", headers=w["owner"]).json()["items"][0]["id"] == d["id"]
    # новый заказ по проекту после отклонения — можно
    assert client.post(f"/projects/{pid}/orders", json={}, headers=w["owner"]).status_code == 201
    root = superadmin(app, client)
    q = client.get("/admin/disputes", headers=root).json()["items"]
    assert q[0]["id"] == d["id"] and q[0]["supplier_name"] == "EMAN Materials"
    assert client.post(f"/admin/disputes/{d['id']}/resolve", json={"resolution": "supplier", "comment": "ok"},
                       headers=staff(app, client, "om@eskizai.uz", "orders_manager")).status_code == 403
    r = client.post(f"/admin/disputes/{d['id']}/resolve",
                    json={"resolution": "supplier", "comment": "Поставщик прав: материала нет", "reason": "Проверено"},
                    headers=root)
    assert r.json()["status"] == "resolved" and r.json()["decision"] == "supplier"
    m = client.get(f"/orders/{oid}", headers=w["owner"]).json()
    assert m["disputes_count"] == 1 and m["events"][-1]["type"] == "dispute_resolved"
    assert m["events"][-1]["actor_type"] == "platform"
    push = db.scalar(select(Notification).where(Notification.kind == "order_dispute"))
    assert push.data["order_id"] == oid and push.data["return_id"] is None and push.data["screen"] == "order"


def test_corrections_approve_and_decline(client, api, world, db):
    w = world
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    card = client.get(f"/vendor/orders/{oid}", headers=w["des1"]).json()
    lines = [dict(l) for l in card["lines"]]
    lines[0]["qty"] = lines[0]["qty"] + 1
    r = client.post(f"/vendor/orders/{oid}/corrections",
                    data={"lines_after": json.dumps(lines), "comment": "Добавил лист на запас"},
                    files=[("files", ("cut.pdf", b"%PDF-1.4", "application/pdf"))], headers=w["des1"])
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["status"] == "pending" and c["total_after"] > c["total_before"] and c["author_name"] == "d1"
    m = client.get(f"/orders/{oid}", headers=w["owner"]).json()
    assert m["status"] == "awaiting_approval" and m["pending_correction_id"] == c["id"]
    assert [e["type"] for e in m["events"]][-2:] == ["correction_created", "status_changed"]
    assert db.scalar(select(Notification).where(Notification.kind == "order_correction")).data["order_id"] == oid
    lst = client.get(f"/orders/{oid}/corrections", headers=w["owner"]).json()
    assert set(lst) == {"items"} and set(lst["items"][0]) >= {
        "id", "order_id", "author_name", "comment", "lines_before", "lines_after", "total_before", "total_after",
        "files", "status", "master_comment", "decided_at", "created_at"}
    f = lst["items"][0]["files"][0]
    assert set(f) >= {"key", "url", "name", "content_type", "size"}
    assert client.get(f["url"]).content == b"%PDF-1.4"  # без токена
    r = client.post(f"/orders/{oid}/corrections/{c['id']}/approve", headers=w["owner"])
    assert r.status_code == 200 and r.json()["status"] == "accepted" and r.json()["invoice_total"] == c["total_after"]
    again = client.post(f"/orders/{oid}/corrections/{c['id']}/approve", headers=w["owner"])
    assert again.status_code == 409 and again.json()["error"]["code"] == "correction_decided"
    # второе исправление — отказ мастера: статус обратно, комментарий в переписку
    lines[0]["price"] = lines[0]["price"] + 1000
    c2 = client.post(f"/vendor/orders/{oid}/corrections", data={"lines_after": json.dumps(lines), "comment": "Цена"},
                     headers=w["des1"]).json()
    r = client.post(f"/orders/{oid}/corrections/{c2['id']}/decline", json={"comment": "Дорого"}, headers=w["owner"])
    assert r.json()["status"] == "accepted" and r.json()["events"][-2]["type"] == "correction_declined"
    msgs = client.get(f"/vendor/orders/{oid}/messages", headers=w["des1"]).json()
    assert "Дорого" in msgs["items"][-1]["text"] and msgs["unread_count"] == 1
    # без изменений состава — сразу применено
    same = client.get(f"/vendor/orders/{oid}", headers=w["des1"]).json()["lines"]
    c3 = client.post(f"/vendor/orders/{oid}/corrections", data={"lines_after": json.dumps(same), "comment": "Файлы ЧПУ"},
                     headers=w["des1"]).json()
    assert c3["status"] == "applied"


def test_chat_signed_urls_and_unread(app, client, api, world, db):
    w = world
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    r = client.post(f"/orders/{oid}/messages", data={"text": "Когда будет готово?"},
                    files=[("files", ("p1.jpg", JPEG + b"img-1", "image/jpeg")),
                           ("files", ("p2.jpg", JPEG + b"img-2", "image/jpeg"))],
                    headers=w["owner"])
    assert r.status_code == 201
    msg = r.json()
    assert set(msg) == {"id", "order_id", "author_type", "author_id", "author_name", "text", "attachments",
                        "created_at", "read_by_master_at", "read_by_vendor_at"}
    assert len(msg["attachments"]) == 2 and msg["author_type"] == "master"
    url = msg["attachments"][1]["url"]
    got = client.get(url)
    assert got.status_code == 200 and got.content == JPEG + b"img-2" and got.headers["content-type"] == "image/jpeg"
    assert client.get(url[:-3] + "abc").status_code == 404  # подпись не сходится
    from mebel_api.services.signed_files import signed_url

    expired = signed_url(app.state.settings, {"key": "x", "name": "x"}, ttl=timedelta(seconds=-5))
    assert client.get(expired).status_code == 410
    assert client.get("/vendor/dashboard", headers=w["des1"]).json()["unread_messages"] == 1
    v = client.get(f"/vendor/orders/{oid}/messages", headers=w["des1"]).json()
    assert v["unread_count"] == 1
    assert client.post(f"/vendor/orders/{oid}/messages/read", headers=w["des1"]).json()["marked"] == 1
    client.post(f"/vendor/orders/{oid}/messages", data={"text": "Завтра к обеду"}, headers=w["des1"])
    m = client.get(f"/orders/{oid}", headers=w["owner"]).json()
    assert m["unread_count"] == 1
    push = db.scalar(select(Notification).where(Notification.kind == "order_message"))
    assert push.data["order_id"] == oid and "Завтра" in push.body
    lst = client.get(f"/orders/{oid}/messages", headers=w["owner"]).json()
    assert [x["author_type"] for x in lst["items"]] == ["master", "vendor"]
    assert client.post(f"/orders/{oid}/messages/read", json={}, headers=w["owner"]).json()["ok"]
    assert client.get(f"/orders/{oid}", headers=w["owner"]).json()["unread_count"] == 0
    # платформа пишет от своего имени — видят оба
    root = superadmin(app, client)
    client.post(f"/admin/orders/{oid}/messages", data={"text": "Платформа на связи"}, headers=root)
    assert client.get(f"/vendor/orders/{oid}/messages", headers=w["des1"]).json()["items"][-1]["author_type"] == "platform"
    assert client.post(f"/orders/{oid}/messages", data={"text": ""}, headers=w["owner"]).status_code == 422


def test_returns_refund_approval_commission_and_return_dispute(app, client, api, world, db):
    w = world
    root = superadmin(app, client)
    assert client.post(f"/admin/suppliers/{w['a']}/commission", json={"rate_percent": 5, "reason": "Договор"},
                       headers=root).status_code == 201
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    early = client.post(f"/orders/{oid}/returns", data={"type": "defect", "description": "Скол"}, headers=w["owner"])
    assert early.status_code == 409 and early.json()["error"]["code"] == "order_not_paid"
    client.post(f"/vendor/orders/{oid}/accept", json={"invoice_total": 4_000_000}, headers=w["des1"])
    client.post(f"/vendor/orders/{oid}/status", json={"status": "paid"}, headers=w["des1"])
    fin = client.get("/vendor/finance", headers=w["owner_a"]).json()
    assert fin["turnover"] == 4_000_000 and fin["commission"]["accrued"] == 200_000
    r = client.post(f"/orders/{oid}/returns",
                    data={"type": "defect", "description": "Скол на фасаде",
                          "lines": json.dumps([{"name": "Фасад", "qty": 1}])},
                    files=[("files", ("scol.jpg", b"jpeg", "image/jpeg"))], headers=w["owner"])
    assert r.status_code == 201, r.text
    ret = r.json()
    assert set(ret) >= {"id", "order_id", "number", "type", "description", "lines", "amount", "photos", "status",
                        "decision", "decision_comment", "refund_amount", "created_by", "created_at", "decided_at"}
    assert ret["type"] == "defect" and ret["number"] == 1 and ret["created_by"] == "master"
    bad = client.post(f"/orders/{oid}/disputes", data={"subject": "return", "return_id": ret["id"],
                                                       "reason": "decision_unfair"}, headers=w["owner"])
    assert bad.status_code == 409 and bad.json()["error"]["code"] == "return_not_decided"
    # конструктор решает «вернуть деньги» → ждёт владельца; конструктор подтвердить не может
    r = client.patch(f"/vendor/returns/{ret['id']}", json={"decision": "refund", "comment": "Брак наш",
                                                           "refund_amount": 400_000}, headers=w["des1"])
    assert r.json()["status"] == "awaiting_owner"
    assert client.post(f"/vendor/returns/{ret['id']}/approve-refund", headers=w["des1"]).status_code == 403
    assert client.post(f"/vendor/returns/{ret['id']}/approve-refund", headers=w["owner_b"]).status_code == 404
    assert client.get("/vendor/dashboard", headers=w["owner_a"]).json()["refunds_awaiting"] == 1
    r = client.post(f"/vendor/returns/{ret['id']}/approve-refund", json={}, headers=w["owner_a"])
    assert r.json()["status"] == "resolved" and r.json()["refund_amount"] == 400_000
    fin = client.get("/vendor/finance", headers=w["owner_a"]).json()
    assert fin["commission"]["reversed"] == 20_000 and fin["commission"]["due"] == 180_000
    m = client.get(f"/orders/{oid}/returns", headers=w["owner"]).json()["items"][0]
    assert m["decision"] == "refund" and m["status"] == "resolved" and m["decided_at"]
    # спор по решённому возврату — один
    r = client.post(f"/orders/{oid}/disputes", data={"subject": "return", "return_id": ret["id"],
                                                     "reason": "amount_wrong", "comment": "Мало"}, headers=w["owner"])
    assert r.status_code == 201 and r.json()["return_id"] == ret["id"]
    assert client.post(f"/orders/{oid}/disputes", data={"subject": "return", "return_id": ret["id"],
                                                        "reason": "other"}, headers=w["owner"]).status_code == 409
    r = client.post(f"/admin/disputes/{r.json()['id']}/resolve",
                    json={"resolution": "partial", "refund_amount": 200_000, "comment": "Доплатить 200 тыс.",
                          "reason": "Фото подтверждают"}, headers=root)
    assert r.json()["amount"] == 200_000
    # push о споре по рекламации ведёт к рекламациям (app/src/lib/pushRoute.ts), по отклонению — в карточку
    push = db.scalars(select(Notification).where(Notification.kind == "order_dispute")).all()[-1]
    assert push.data["return_id"] == ret["id"] and push.data["screen"] == "order_returns"
    fin = client.get("/admin/finance", headers=root).json()
    eman = next(x for x in fin["suppliers"] if x["supplier"]["code"] == "eman")
    assert eman["commission"]["reversed"] == 30_000
    # выплата поставщика → долг
    assert client.post(f"/admin/suppliers/{w['a']}/settlements", json={"amount": 100_000, "comment": "Октябрь"},
                       headers=root).status_code == 201
    fin = client.get("/vendor/finance", headers=w["owner_a"]).json()
    assert fin["settled"] == 100_000 and fin["debt"] == 200_000 - 30_000 - 100_000
    assert fin["balance"]["debt"] == fin["debt"]
    act = client.get("/vendor/finance/act.csv", headers=w["owner_a"])
    assert act.status_code == 200 and "Акт сверки" in act.content.decode("utf-8-sig")
    assert client.get("/vendor/finance", headers=w["des1"]).status_code == 403
    # вендор открывает рекламацию сам; решение «отказать»
    r = client.post(f"/vendor/orders/{oid}/returns", data={"type": "shortage", "description": "Недовложение петель"},
                    headers=w["des1"])
    assert r.status_code == 201 and r.json()["created_by"] == "vendor"
    assert client.patch(f"/vendor/returns/{r.json()['id']}", json={"decision": "declined", "comment": "Всё есть"},
                        headers=w["des1"]).json()["status"] == "resolved"
    assert client.get("/vendor/returns", headers=w["owner_a"]).json()["items"][0]["order_number"]


def test_split_order_between_suppliers_and_isolation(app, client, api, world):
    w = world
    root = superadmin(app, client)
    r = client.put("/admin/supplier-routes", json={"routes": [{"category": "hardware", "supplier_id": w["b"]}]},
                   headers=root)
    assert r.status_code == 200 and r.json()["routes"][0]["supplier_code"] == "metal"
    pid, o = _order(api, client, w["owner"])
    assert o["supplier_id"] == w["a"] and len(o["group_orders"]) == 2
    other = next(g for g in o["group_orders"] if g["supplier_id"] == w["b"])
    a_list = client.get("/vendor/orders?scope=all", headers=w["owner_a"]).json()
    b_list = client.get("/vendor/orders?scope=all", headers=w["owner_b"]).json()
    assert [x["id"] for x in a_list["items"]] == [o["id"]] and [x["id"] for x in b_list["items"]] == [other["id"]]
    b_card = client.get(f"/vendor/orders/{other['id']}", headers=w["owner_b"]).json()
    assert all(l["key"].startswith("hw:") for l in b_card["lines"]) and b_card["delivery"] is None
    a_card = client.get(f"/vendor/orders/{o['id']}", headers=w["owner_a"]).json()
    assert a_card["lines"] and not any(l["key"].startswith("hw:") for l in a_card["lines"])
    assert b_card["group_id"] == a_card["group_id"]
    assert client.get(f"/vendor/orders/{other['id']}", headers=w["owner_a"]).status_code == 404
    orders = client.get(f"/projects/{pid}/orders", headers=w["owner"]).json()
    assert {x["supplier_name"] for x in orders} == {"EMAN Materials", "Металлоцех"}


def test_nonstandard_and_price_requests_scoped(app, client, api, world, db):
    w = world
    pid = api.project(w["owner"])
    r = client.post(f"/projects/{pid}/nonstandard", json={"description": "Шкаф с радиусным фасадом"}, headers=w["owner"])
    nid = r.json()["id"]
    self_r = client.post(f"/projects/{pid}/nonstandard", json={"description": "Сделаю сам", "path": "self"},
                         headers=w["owner"])
    assert client.get(f"/vendor/nonstandard/{nid}", headers=w["owner_b"]).status_code == 404
    assert client.patch(f"/vendor/nonstandard/{nid}", json={"price": 1}, headers=w["owner_b"]).status_code == 404
    assert client.post(f"/vendor/nonstandard/{nid}/files", files={"file": ("a.dxf", b"0", "text/plain")},
                       headers=w["owner_b"]).status_code == 404
    lst = client.get("/vendor/nonstandard", headers=w["des1"]).json()
    assert [x["id"] for x in lst["items"]] == [nid]  # «сам» поставщику не уходит
    assert self_r.json()["id"] not in [x["id"] for x in lst["items"]]
    des1_id = client.get("/staff/me", headers=w["des1"]).json()["id"]
    r = client.patch(f"/vendor/nonstandard/{nid}", json={"price": 900_000, "term_days": 5, "comment": "Сделаем",
                                                         "assignee_id": des1_id}, headers=w["des1"])
    assert r.json()["status"] == "estimated" and r.json()["assignee"] == "d1"
    up = client.post(f"/vendor/nonstandard/{nid}/files", files={"file": ("r.dxf", b"DXF", "application/dxf")},
                     headers=w["des1"])
    fid = up.json()["files"][0]["id"]
    assert client.get(f"/vendor/nonstandard/{nid}/files/{fid}", headers=w["des1"]).content == b"DXF"
    assert client.get(f"/projects/{pid}/nonstandard/{nid}", headers=w["owner"]).json()["price"] == 900_000
    # позиции без цены: разовая цена, в каталог не пишется
    req = PriceRequest(project_id=__import__("uuid").UUID(pid), workshop_id=db.get(
        __import__("mebel_api.models", fromlist=["Project"]).Project, __import__("uuid").UUID(pid)).workshop_id,
        line_key="hw:hinge_special", name="Петля спец", unit="шт", qty=4, supplier_id=__import__("uuid").UUID(w["a"]))
    db.add(req)
    db.commit()
    assert client.get("/vendor/price-requests", headers=w["owner_b"]).json()["total"] == 0
    assert client.post(f"/vendor/price-requests/{req.id}/price", json={"price": 25_000},
                       headers=w["owner_b"]).status_code == 404
    before = db.scalar(select(__import__("sqlalchemy").func.count(CatalogItem.id)))
    r = client.post(f"/vendor/price-requests/{req.id}/price", json={"price": 25_000, "lead_days": 3}, headers=w["des1"])
    assert r.json()["status"] == "priced" and r.json()["supplier_name"] == "EMAN Materials"
    assert db.scalar(select(__import__("sqlalchemy").func.count(CatalogItem.id))) == before


def _items(db, supplier_id):
    import uuid

    now = utcnow()
    for sku, price in (("A-1", 100_000), ("A-2", 200_000), ("A-3", 300_000)):
        db.add(CatalogItem(supplier_id=uuid.UUID(supplier_id), sku=sku, type="hardware", name=f"Позиция {sku}",
                           price=price, unit="шт", price_date=now, price_source="manual", available=True))
    db.commit()
    return {i.sku: str(i.id) for i in db.scalars(select(CatalogItem).where(CatalogItem.supplier_id == uuid.UUID(supplier_id)))}


def test_catalog_patch_and_import_preview_confirm(app, client, world, db):
    w = world
    ids = _items(db, w["a"])
    assert client.patch(f"/vendor/catalog/{ids['A-1']}", json={"price": 1}, headers=w["owner_b"]).status_code == 404
    assert client.patch(f"/vendor/catalog/{ids['A-1']}", json={"price": 1}, headers=w["des1"]).status_code == 403
    r = client.patch(f"/vendor/catalog/{ids['A-1']}", json={"price": 105_000, "available": False}, headers=w["owner_a"])
    assert r.json()["price"] == 105_000 and r.json()["available"] is False
    hist = client.get(f"/vendor/catalog/{ids['A-1']}/history", headers=w["owner_a"]).json()
    assert hist[0]["old_price"] == 100_000 and hist[0]["source"] == "vendor"
    assert client.get("/vendor/catalog?q=A-", headers=w["owner_a"]).json()["total"] == 3
    assert client.get("/vendor/catalog", headers=w["owner_b"]).json()["total"] == 0
    csv_data = "sku;name;price;available\nA-1;;110000;1\nA-2;;300000;да\nB-9;Новая петля;5000;1\nC-0;Без цены;;1\n"
    r = client.post("/vendor/catalog/import", files={"file": ("prices.csv", csv_data.encode(), "text/csv")},
                    headers=w["owner_a"])
    assert r.status_code == 201, r.text
    p = r.json()
    assert [x["sku"] for x in p["created"]] == ["B-9"]
    assert {x["sku"] for x in p["changed"]} == {"A-1", "A-2"} and [x["sku"] for x in p["big_changes"]] == ["A-2"]
    assert [x["sku"] for x in p["missing"]] == ["A-3"] and p["errors"][0]["error"] == "Нет цены"
    # чужой поставщик не применит
    assert client.post(f"/vendor/catalog/import/{p['preview_id']}/confirm", headers=w["owner_b"]).status_code == 404
    r = client.post(f"/vendor/catalog/import/{p['preview_id']}/confirm", headers=w["owner_a"])
    assert r.status_code == 200 and r.json()["published"]["updated"] == 2 and r.json()["published"]["created"] == 1
    a2 = db.get(CatalogItem, __import__("uuid").UUID(ids["A-2"]))
    db.refresh(a2)
    assert a2.price == 300_000
    assert db.scalar(select(PriceHistory).where(PriceHistory.item_id == a2.id, PriceHistory.new_price == 300_000))
    a3 = db.get(CatalogItem, __import__("uuid").UUID(ids["A-3"]))
    db.refresh(a3)
    assert a3.available  # не скрываем без hide_missing
    assert client.post(f"/vendor/catalog/import/{p['preview_id']}/confirm", headers=w["owner_a"]).status_code == 409
    # XLSX
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["Артикул", "Цена"])
    ws.append(["A-3", 310_000])
    buf = io.BytesIO()
    wb.save(buf)
    r = client.post("/vendor/catalog/import", files={"file": ("p.xlsx", buf.getvalue(), "application/octet-stream")},
                    headers=w["owner_a"])
    p2 = r.json()
    assert [x["sku"] for x in p2["changed"]] == ["A-3"] and p2["big_changes"] == []
    run = db.get(ParserRun, __import__("uuid").UUID(p2["preview_id"]))
    run.started_at = utcnow() - timedelta(hours=2)
    db.commit()
    r = client.post(f"/vendor/catalog/import/{p2['preview_id']}/confirm", headers=w["owner_a"])
    assert r.status_code == 410 and r.json()["error"]["code"] == "preview_expired"


def test_price_source_ssrf_and_runs(app, client, world, db, monkeypatch):
    w = world
    ids = _items(db, w["a"])
    for url in ("http://prices.example.com/p.csv", "https://127.0.0.1/p.csv", "https://localhost/p.csv",
                "https://user:pw@example.com/p.csv"):
        r = client.put("/vendor/price-source", json={"url": url}, headers=w["owner_a"])
        assert r.status_code == 422, url
    from mebel_api.services import price_import

    monkeypatch.setattr(price_import, "check_public_https", lambda url: ("prices.example.com", 443))
    r = client.put("/vendor/price-source", json={"url": "https://prices.example.com/p.json", "format": "json",
                                                 "kind": "api", "secret": "s3cr3t", "schedule": "hourly",
                                                 "mapping": {"sku": "code", "price": "cost"}}, headers=w["owner_a"])
    assert r.status_code == 200 and r.json()["source"]["secret_set"] and "s3cr3t" not in r.text
    payload = json.dumps([{"code": "A-1", "cost": 101_000}, {"code": "A-2", "cost": 400_000}]).encode()
    seen = {}

    def fake_fetch(url, *, secret, max_bytes, timeout, transport=None):
        seen["secret"] = secret
        return payload

    monkeypatch.setattr(price_import, "fetch", fake_fetch)
    r = client.post("/vendor/price-source/run", headers=w["owner_a"])
    assert r.status_code == 201, r.text
    run = r.json()
    assert seen["secret"] == "s3cr3t" and run["status"] == "review" and run["pending_review"] == 1
    a1 = db.get(CatalogItem, __import__("uuid").UUID(ids["A-1"]))
    db.refresh(a1)
    assert a1.price == 101_000  # ≤ 15% — сразу
    assert client.get("/vendor/dashboard", headers=w["owner_a"]).json()["price_review"] == 1
    assert client.post(f"/vendor/price-source/runs/{run['id']}/confirm", headers=w["owner_b"]).status_code == 404
    r = client.post(f"/vendor/price-source/runs/{run['id']}/confirm", headers=w["owner_a"])
    assert r.status_code == 200 and r.json()["published"]["updated"] == 1
    assert client.get("/vendor/price-source/runs", headers=w["owner_a"]).json()[0]["id"] == run["id"]
    assert client.get("/vendor/price-source", headers=w["des1"]).status_code == 403


def test_real_ssrf_guard_resolves_private_hosts():
    from mebel_api.errors import ApiError
    from mebel_api.services.price_import import check_public_https

    for url in ("https://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x", "https://169.254.169.254/latest"):
        with pytest.raises(ApiError):
            check_public_https(url)


def test_settings_analytics_dashboard(client, api, world):
    w = world
    _paid_order(api, client, w)
    r = client.patch("/vendor/settings", json={"settings": {"inn": "123456789", "default_lead_days": 5,
                                                            "payment_url": "https://pay.eman.uz/x"}},
                     headers=w["owner_a"])
    assert r.status_code == 200 and r.json()["settings"]["inn"] == "123456789"
    assert client.patch("/vendor/settings", json={"settings": {"hack": 1}}, headers=w["owner_a"]).status_code == 422
    assert client.patch("/vendor/settings", json={"name": "x"}, headers=w["des1"]).status_code == 403
    a = client.get("/vendor/analytics", headers=w["owner_a"]).json()
    assert a["paid_orders"] == 1 and a["turnover"] == 4_000_000 and a["top_workshops"][0]["orders"] == 1
    d1 = next(x for x in a["designers"] if x["name"] == "d1")
    assert d1["accepted"] == 1 and d1["open_orders"] == 1
    assert client.get("/vendor/analytics", headers=w["des1"]).status_code == 403
    d = client.get("/vendor/dashboard", headers=w["owner_a"]).json()
    assert d["in_production"] == 1 and "refunds_awaiting" in d
    dd = client.get("/vendor/dashboard", headers=w["des1"]).json()
    assert "refunds_awaiting" not in dd and dd["mine"] == 1
