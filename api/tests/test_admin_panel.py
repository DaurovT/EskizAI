"""Админка: дашборд, цеха, проекты, заказы (ручная передача, оплата, статусы), ИИ-статистика, настройки."""

from .conftest import ADMIN
from .test_roles import employee


def test_admin_requires_token(client):
    for path in ("/admin/dashboard", "/admin/workshops", "/admin/projects", "/admin/orders", "/admin/ai-stats",
                 "/admin/settings", "/admin/catalog/items", "/admin/suppliers"):
        assert client.get(path).status_code == 401, path
        assert client.get(path, headers={"X-Admin-Token": "wrong"}).status_code == 401


def test_dashboard_workshops_projects(api, client, owner):
    pid = api.project(owner, "Шкаф в прихожую")
    api.advance(owner, pid, "sketch")
    d = client.get("/admin/dashboard", headers=ADMIN).json()
    assert d["workshops"]["total"] == 1 and d["projects"]["total"] == 1
    assert {"today", "week", "month"} == set(d["ai"]) and d["ai"]["today"]["cost_usd"] == 0
    assert next(s for s in d["projects"]["by_status"] if s["status"] == "sketch")["count"] == 1

    ws = client.get("/admin/workshops?q=901234567", headers=ADMIN).json()
    assert ws["total"] == 1 and ws["items"][0]["free_left"] == 2
    wid = ws["items"][0]["id"]
    card = client.get(f"/admin/workshops/{wid}", headers=ADMIN).json()
    assert card["limits"]["free_used"] == 1 and card["users"][0]["role"] == "owner"
    assert card["projects"][0]["id"] == pid

    # ручное начисление проектов — в журнал действий
    client.post(f"/admin/workshops/{wid}/plan", json={"add_pack_projects": 5}, headers=ADMIN)
    assert client.get(f"/admin/workshops/{wid}", headers=ADMIN).json()["limits"]["pack_left"] == 5
    assert client.post(f"/admin/workshops/{wid}/block", json={"blocked": True}, headers=ADMIN).json()["blocked"]
    assert client.get("/projects", headers=owner).status_code == 403
    client.post(f"/admin/workshops/{wid}/block", json={"blocked": False}, headers=ADMIN)
    actions = [e["action"] for e in client.get(f"/admin/workshops/{wid}", headers=ADMIN).json()["action_log"]]
    assert {"update", "block", "unblock"} <= set(actions)

    found = client.get("/admin/projects?q=прихож&status=sketch", headers=ADMIN).json()
    assert found["total"] == 1 and found["items"][0]["workshop_name"]
    pc = client.get(f"/admin/projects/{pid}", headers=ADMIN).json()
    assert pc["current_version"]["viewer"]["format"] == "1" and pc["estimate"]["cost_materials"]
    assert pc["versions"][0]["is_current"] and pc["ai_requests"] == [] and pc["chat"] == []
    vid = pc["versions"][0]["id"]
    assert client.get(f"/admin/projects/{pid}/versions/{vid}", headers=ADMIN).json()["viewer"]


def test_order_flow_hand_over_paid_statuses(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    emp = employee(api, client, owner)
    assert client.post(f"/projects/{pid}/orders", json={}, headers=emp).status_code == 403
    prev = client.get(f"/projects/{pid}/orders/preview?distance_km=10", headers=owner).json()
    assert prev["delivery"]["distance_km"] == 10 and prev["total"] == prev["goods_total"] + prev["delivery"]["cost"]
    r = client.post(f"/projects/{pid}/orders", json={"distance_km": 10}, headers=owner)
    assert r.status_code == 201, r.text
    order = r.json()
    assert order["status"] == "created" and order["estimate_total"] == prev["total"]
    assert client.post(f"/projects/{pid}/orders", json={}, headers=owner).status_code == 409
    assert "composition" not in client.get(f"/projects/{pid}/orders", headers=emp).json()[0]

    lst = client.get("/admin/orders?status=created", headers=ADMIN).json()
    assert lst["total"] == 1 and lst["items"][0]["id"] == order["id"]
    card = client.get(f"/admin/orders/{order['id']}", headers=ADMIN).json()
    assert card["lines"] and card["supplier_order"]["delivery"] and card["allowed_statuses"] == ["cancelled"]
    csv = client.get(f"/admin/orders/{order['id']}/csv", headers=ADMIN)
    assert csv.status_code == 200 and b";" in csv.content and "order_" in csv.headers["content-disposition"]
    assert client.post(f"/admin/orders/{order['id']}/hand-over", json={"note": "отправлено в Telegram EMAN"},
                       headers=ADMIN).json()["handed_over_at"]

    # оплата отмечается существующим эндпоинтом и использует оформленный заказ
    r = client.post(f"/admin/projects/{pid}/order-paid", json={"invoice_total": 4_400_000, "payment_provider": "click"},
                    headers=ADMIN)
    assert r.status_code == 200 and r.json()["id"] == order["id"] and r.json()["status"] == "paid"
    assert client.get(f"/projects/{pid}", headers=owner).json()["status"] == "in_work"

    bad = client.post(f"/admin/orders/{order['id']}/status", json={"status": "ready"}, headers=ADMIN)
    assert bad.status_code == 409 and bad.json()["error"]["details"]["allowed"] == ["accepted", "cancelled"]
    for st in ("accepted", "cutting"):
        assert client.post(f"/admin/orders/{order['id']}/status", json={"status": st}, headers=ADMIN).status_code == 200
    r = client.post(f"/admin/orders/{order['id']}/status", json={"status": "cancelled"}, headers=ADMIN)
    assert r.status_code == 409  # после распила отменить нельзя
    for st in ("ready", "issued"):
        client.post(f"/admin/orders/{order['id']}/status", json={"status": st}, headers=ADMIN)
    card = client.get(f"/admin/orders/{order['id']}", headers=ADMIN).json()
    assert card["status"] == "issued" and card["commission_status"] == "accrued"
    assert [h["action"] for h in card["history"]][:4] == ["create", "hand_over", "mark_paid", "status"]
    d = client.get("/admin/dashboard", headers=ADMIN).json()
    assert d["orders"]["turnover"]["today"] == 4_400_000


def test_order_cancel_reverses_commission(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "in_work")
    oid = client.get("/admin/orders", headers=ADMIN).json()["items"][0]["id"]
    r = client.post(f"/admin/orders/{oid}/status", json={"status": "cancelled"}, headers=ADMIN).json()
    assert r["status"] == "cancelled" and r["commission_status"] == "reversed"


def test_settings_and_ai_stats(api, client, owner, root_admin):
    s = client.get("/admin/settings", headers=root_admin).json()
    assert s["values"]["ai_budget_usd"] == 0.3 and s["values"]["ai_warn_ratio"] == 0.8
    r = client.patch("/admin/settings", json={"ai_budget_usd": 0.5}, headers=root_admin)
    assert r.json()["values"]["ai_budget_usd"] == 0.5
    assert client.patch("/admin/settings", json={"ai_warn_ratio": 2}, headers=root_admin).status_code == 422
    assert client.patch("/admin/settings", json={"bogus": 1}, headers=root_admin).status_code == 422
    log = client.get("/admin/action-log", headers=root_admin).json()
    assert log[0]["entity"] == "settings" and log[0]["before"] == {"ai_budget_usd": 0.3}
    stats = client.get("/admin/ai-stats", headers=root_admin).json()
    assert stats["totals"]["month"]["requests"] == 0 and stats["accuracy"]["ai_projects"] == 0


def test_suppliers(client, root_admin):
    sup = client.get("/admin/suppliers", headers=root_admin).json()
    assert sup[0]["code"] == "eman"
    r = client.patch(f"/admin/suppliers/{sup[0]['id']}", json={"commission_percent": 3, "reason": "договор"},
                     headers=root_admin)
    assert r.json()["commission_percent"] == 3
    assert client.get("/admin/action-log", headers=root_admin).json()[0]["entity"] == "supplier"
    assert client.post("/admin/suppliers", json={"code": "eman", "name": "x"}, headers=root_admin).status_code == 409
