"""Рабочие экраны суперадмина (routers/admin_ops.py и доработки admin_platform): цеха — поиск, фильтры, сортировка,
CSV, вкладки карточки, сброс лимита; заказы — фильтры и SLA, комиссия заказа; споры — все статусы, фильтры,
предел возврата; комиссия поставщика как ставка по умолчанию; показатели поставщиков; отчёт CSV; сотрудники;
«глазами мастера» — ответ для веба."""

import csv
import io
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from mebel_api.db import utcnow
from mebel_api.models import AiRequest, Order, Payment, StaffSession, Supplier, Workshop

from .conftest import ADMIN
from .staff_helpers import make_supplier, staff, superadmin


@pytest.fixture
def root(app, client):
    return superadmin(app, client)


def _order(api, client, owner) -> tuple[str, dict]:
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    r = client.post(f"/projects/{pid}/orders", json={}, headers=owner)
    assert r.status_code == 201, r.text
    return pid, r.json()


def _workshop_id(client, h) -> str:
    return client.get("/workshops/me", headers=h).json()["id"]


def _csv(r) -> list[list[str]]:
    assert r.status_code == 200, r.text
    return list(csv.reader(io.StringIO(r.content.decode("utf-8-sig")), delimiter=";"))


# --- Цеха ---


def test_workshops_list_filters_sort_and_csv(app, client, api, owner, root, db):
    make_supplier(app, "eman", "EMAN")
    wid = _workshop_id(client, owner)
    client.patch("/workshops/me", json={"name": "Цех Азиз", "city": "Самарканд"}, headers=owner)
    _order(api, client, owner)
    other = api.login("+998907770000")
    oid = _workshop_id(client, other)
    # Цех без активности и с «формулой» в названии (для CSV)
    w = Workshop(name="=HYPERLINK(\"http://x\")", city="Бухара", plan="pro", blocked=True)
    db.add(w)
    db.add(AiRequest(workshop_id=uuid.UUID(oid), purpose="design", model="m", cost_microusd=2_500_000,
                     validation_result="ok"))
    db.commit()

    r = client.get("/admin/workshops", headers=root).json()
    assert r["total"] == 3 and "Самарканд" in r["cities"]
    row = next(x for x in r["items"] if x["id"] == wid)
    assert row["projects"] == 1 and row["orders"] == 1 and row["last_activity"] and row["members"] == 1
    assert set(row) >= {"turnover", "ai_spend_usd", "plan", "pro_until", "free_left", "owner_name", "phone"}

    def ids(**params):
        return [x["id"] for x in client.get("/admin/workshops", params=params, headers=root).json()["items"]]

    assert ids(q="азиз") == [wid]
    assert ids(q="самарк") == [wid]
    assert ids(q="7770000") == [oid]
    assert ids(city="самарканд") == [wid]
    assert ids(plan="pro") == [str(w.id)]
    assert ids(blocked=True) == [str(w.id)]
    assert ids(has_orders=True) == [wid]
    assert set(ids(has_orders=False)) == {oid, str(w.id)}
    assert set(ids(active_days=7)) == {wid, oid}
    assert ids(inactive_days=30) == [str(w.id)]
    assert ids(sort="ai_spend", order="desc")[0] == oid
    assert ids(sort="projects", order="desc")[0] == wid
    assert ids(sort="last_activity", order="desc")[-1] == str(w.id)  # без активности — в конце
    page = client.get("/admin/workshops", params={"limit": 2, "offset": 2}, headers=root).json()
    assert len(page["items"]) == 1 and page["total"] == 3

    rows = _csv(client.get("/admin/workshops.csv", params={"sort": "name", "order": "asc"}, headers=root))
    assert rows[0][0] == "Цех" and len(rows) == 4
    assert any(r[0] == "'=HYPERLINK(\"http://x\")" for r in rows[1:])  # формула — текстом
    assert all(not r[2].startswith("+") for r in rows[1:])  # телефон «+998…» — тоже с апострофом
    assert len(_csv(client.get("/admin/workshops.csv", params={"blocked": True}, headers=root))) == 2


def test_workshop_card_tabs_and_reset_limits(app, client, api, owner, root, db, settings):
    wid = _workshop_id(client, owner)
    emp = api.employee(owner, "+998935551111", "Рустам", can_order=True)
    pid = api.project(owner)
    api.advance(owner, pid, "sketch")  # списан из бесплатного лимита
    db.add_all([
        AiRequest(workshop_id=uuid.UUID(wid), project_id=uuid.UUID(pid), purpose="design", model="m",
                  cost_microusd=1_200_000, validation_result="ok"),
        AiRequest(workshop_id=uuid.UUID(wid), project_id=None, purpose="chat", model="m", cost_microusd=300_000,
                  validation_result="failed"),
        Payment(workshop_id=uuid.UUID(wid), kind="pack", amount=150_000, method="click", title="Пакет 10"),
        Payment(workshop_id=uuid.UUID(wid), kind="pro", amount=99_000, method="payme", status="refunded",
                refunded_at=utcnow()),
    ])
    db.commit()
    assert emp

    s = client.get(f"/admin/workshops/{wid}/summary", headers=root).json()
    assert s["stats"]["projects"] == 1 and s["stats"]["ai_spend_usd"] == 1.5
    assert s["stats"]["payments_total"] == 150_000 and s["stats"]["payments_refunded"] == 99_000
    assert s["limits"]["free_used"] == 1 and s["owner"]["phone"] == "+998901234567"
    m = {x["phone"]: x for x in s["members"]}
    assert m["+998935551111"]["can_order"] is True and m["+998935551111"]["can_see_cost"] is False
    assert m["+998901234567"]["can_see_cost"] is True

    p = client.get(f"/admin/workshops/{wid}/payments", headers=root).json()
    assert p["totals"] == {"paid": 249_000, "refunded": 99_000, "net": 150_000, "count": 2}

    ai = client.get(f"/admin/workshops/{wid}/ai-usage", params={"days": 7}, headers=root).json()
    assert len(ai["by_day"]) == 7 and ai["period"]["requests"] == 2 and ai["period"]["errors"] == 1
    assert ai["by_project"][0]["project_id"] == pid and ai["by_project"][0]["cost_usd"] == 1.2
    assert {x["purpose"] for x in ai["by_purpose"]} == {"design", "chat"}

    # Сброс лимита: причина обязательна, проект возвращается в лимит, в журнал
    r = client.post(f"/admin/workshops/{wid}/reset-limits", json={}, headers=root)
    assert r.status_code == 422 and r.json()["error"]["code"] == "reason_required"
    assert client.post(f"/admin/workshops/{wid}/reset-limits", json={"reason": "x"},
                       headers=staff(app, client, "cat@eskizai.uz", "catalog_manager")).status_code == 403
    r = client.post(f"/admin/workshops/{wid}/reset-limits", json={"reason": "Сбой ИИ съел лимит"}, headers=root)
    assert r.status_code == 200, r.text
    assert r.json()["free_used"] == 0 and r.json()["returned_projects"] == 1
    assert client.get("/billing/limits", headers=owner).json()["free_left"] == settings.free_projects_per_month

    log = client.get(f"/admin/workshops/{wid}/activity", headers=root).json()
    e = next(x for x in log["items"] if x["entity"] == "workshop_limits")
    assert e["after"]["reason"] == "Сбой ИИ съел лимит" and e["actor_name"]
    assert client.get(f"/admin/workshops/{wid}/activity", params={"actor": "staff"}, headers=root).json()["total"] >= 1


def test_impersonation_response_and_read_only(app, client, api, owner, root):
    wid = _workshop_id(client, owner)
    api.project(owner, "Кухня Азиза")
    r = client.post(f"/admin/workshops/{wid}/impersonate", json={"reason": "Жалоба: не видит проект"}, headers=root)
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["read_only"] and b["expires_at"] and b["user_role"] == "owner" and b["workshop_name"]
    h = {"Authorization": f"Bearer {b['access_token']}"}
    assert client.get("/projects", headers=h).json()["items"][0]["title"] == "Кухня Азиза"
    r = client.post("/projects", json={"title": "x"}, headers=h)
    assert r.status_code == 403 and r.json()["error"]["code"] == "impersonation_read_only"
    # запросы просмотра в журнале цеха по умолчанию скрыты, но доступны
    log = client.get(f"/admin/workshops/{wid}/activity", headers=root).json()["items"]
    assert not any(x["entity"] == "impersonation" and x["action"] == "request" for x in log)
    assert any(x["action"] == "start" for x in log)
    full = client.get(f"/admin/workshops/{wid}/activity", params={"hide_requests": False}, headers=root).json()
    assert any(x["action"] == "request" for x in full["items"])


# --- Заказы ---


def test_orders_filters_sla_and_commission(app, client, api, owner, root, db):
    a = make_supplier(app, "eman", "EMAN")
    b = make_supplier(app, "metal", "Металл")
    wid = _workshop_id(client, owner)
    _, o1 = _order(api, client, owner)
    _, o2 = _order(api, client, owner)
    other = api.login("+998907770000")
    _, o3 = _order(api, client, other)
    old = utcnow() - timedelta(hours=30)
    x1 = db.get(Order, uuid.UUID(o1["id"]))
    x1.status_changed_at = old
    x1.created_at = old
    x3 = db.get(Order, uuid.UUID(o3["id"]))
    x3.supplier_id, x3.supplier = uuid.UUID(b), "metal"
    x2 = db.get(Order, uuid.UUID(o2["id"]))
    x2.status, x2.paid_at, x2.invoice_total = "paid", utcnow(), 2_000_000
    x2.commission_amount, x2.commission_status, x2.due_date = 60_000, "accrued", utcnow() - timedelta(days=1)
    db.commit()

    r = client.get("/admin/orders", headers=root).json()
    assert r["total"] == 3 and r["overdue_hours"] == 24
    assert r["counters"] == {"overdue": 1, "late": 1, "platform_queue": 0}
    by = {x["id"]: x for x in r["items"]}
    assert by[o1["id"]]["sla"]["overdue"] is True and by[o1["id"]]["sla"]["waiting_on"] == "supplier"
    assert by[o1["id"]]["sla"]["hours_in_status"] >= 29
    assert by[o2["id"]]["sla"]["late"] is True and by[o2["id"]]["sla"]["overdue"] is False

    def ids(**params):
        return [x["id"] for x in client.get("/admin/orders", params=params, headers=root).json()["items"]]

    assert ids(overdue=True) == [o1["id"]]
    assert set(ids(overdue=True, overdue_hours=48)) == set()
    assert ids(late=True) == [o2["id"]]
    assert ids(supplier_id=b) == [o3["id"]]
    assert set(ids(supplier_id=a)) == {o1["id"], o2["id"]}
    assert ids(supplier_id="none") == []
    assert client.get("/admin/orders", params={"supplier_id": "bad"}, headers=root).status_code == 422
    assert set(ids(workshop_id=wid)) == {o1["id"], o2["id"]}
    assert ids(status="paid") == [o2["id"]]
    assert ids(q=str(x3.number)) == [o3["id"]]
    today = (utcnow() + timedelta(hours=5)).date().isoformat()
    assert o1["id"] not in ids(**{"from": today, "to": today})
    assert ids(sort="status_age", order="desc")[0] == o1["id"]  # дольше всех в статусе — сверху

    c = client.get(f"/admin/orders/{o2['id']}/commission", headers=root).json()
    assert c["accrued"] == 60_000 and c["net"] == 60_000 and c["rate_percent"] == 3.0 and c["status"] == "accrued"
    db.get(Supplier, uuid.UUID(a)).commission_bp = 500
    db.commit()
    c = client.get(f"/admin/orders/{o1['id']}/commission", headers=root).json()
    assert c["accrued"] is None and c["status"] == "expected" and c["expected"] > 0 and c["rate_percent"] == 5.0


# --- Споры ---


def test_disputes_all_filters_and_refund_cap(app, client, api, owner, root, db):
    a = make_supplier(app, "eman", "EMAN")
    designer = staff(app, client, "d@eman.uz", "vendor_designer", a)
    disputes = []
    for _ in range(2):
        _, o = _order(api, client, owner)
        oid = o["id"]
        assert client.post(f"/vendor/orders/{oid}/accept", json={"invoice_total": 1_000_000},
                           headers=designer).status_code == 200
        assert client.post(f"/vendor/orders/{oid}/status", json={"status": "paid"}, headers=designer).status_code == 200
        r = client.post(f"/orders/{oid}/returns", data={"type": "defect", "description": "скол", "amount": "300000"},
                        headers=owner)
        assert r.status_code == 201, r.text
        ret = r.json()
        r = client.patch(f"/vendor/returns/{ret['id']}", json={"decision": "declined", "comment": "Скол при сборке"},
                         headers=designer)
        assert r.status_code == 200, r.text
        r = client.post(f"/orders/{oid}/disputes", data={"subject": "return", "return_id": ret["id"],
                                                         "reason": "decision_unfair", "comment": "Скол с завода"},
                        headers=owner)
        assert r.status_code == 201, r.text
        disputes.append(r.json())
    d1, d2 = disputes
    card = client.get(f"/admin/disputes/{d1['id']}", headers=root).json()
    assert card["max_refund"] == 1_000_000 and card["refunds_committed"] == 0 and card["order_paid_at"]
    r = client.post(f"/admin/disputes/{d1['id']}/resolve",
                    json={"resolution": "partial", "refund_amount": 1_000_001, "comment": "частично", "reason": "r"},
                    headers=root)
    assert r.status_code == 422
    r = client.post(f"/admin/disputes/{d1['id']}/resolve",
                    json={"resolution": "partial", "refund_amount": 200_000, "comment": "Половина вины", "reason": "фото"},
                    headers=root)
    assert r.status_code == 200, r.text

    lst = client.get("/admin/disputes", params={"status": "all"}, headers=root).json()
    assert len(lst["items"]) == 2 and lst["counts"] == {"open": 1, "resolved": 1, "all": 2}
    assert lst["items"][0]["id"] == d2["id"]  # все — новые сверху
    assert [x["id"] for x in client.get("/admin/disputes", headers=root).json()["items"]] == [d2["id"]]
    assert [x["id"] for x in client.get("/admin/disputes", params={"status": "resolved"},
                                        headers=root).json()["items"]] == [d1["id"]]
    assert len(client.get("/admin/disputes", params={"status": "all", "supplier_id": a},
                          headers=root).json()["items"]) == 2
    assert client.get("/admin/disputes", params={"status": "all", "supplier_id": str(uuid.uuid4())},
                      headers=root).json()["items"] == []
    assert client.get("/admin/disputes", params={"status": "all", "subject": "rejection"},
                      headers=root).json()["items"] == []
    num = db.get(Order, uuid.UUID(d2["order_id"])).number
    assert [x["id"] for x in client.get("/admin/disputes", params={"status": "all", "q": str(num)},
                                        headers=root).json()["items"]] == [d2["id"]]


# --- Поставщики: комиссия, показатели, отчёт ---


def test_commission_updates_default_rate(app, client, root, db):
    sid = make_supplier(app, "metal", "Металл")
    r = client.post(f"/admin/suppliers/{sid}/commission", json={"rate_percent": 4.5, "reason": "Договор №7"},
                    headers=root)
    assert r.status_code == 201, r.text
    assert client.get(f"/admin/suppliers/{sid}/commission", headers=root).json()["default_percent"] == 4.5
    sup = next(s for s in client.get("/admin/suppliers", headers=root).json() if s["id"] == sid)
    assert sup["commission_percent"] == 4.5
    # Будущая ставка и ставка категории ставку по умолчанию не меняют
    future = (utcnow() + timedelta(days=10)).isoformat()
    client.post(f"/admin/suppliers/{sid}/commission", json={"rate_percent": 7, "effective_from": future,
                                                           "reason": "С декабря"}, headers=root)
    client.post(f"/admin/suppliers/{sid}/commission", json={"rate_percent": 9, "category": "hardware",
                                                           "reason": "Фурнитура"}, headers=root)
    assert client.get(f"/admin/suppliers/{sid}/commission", headers=root).json()["default_percent"] == 4.5
    # PATCH ставки пишет её в историю — иначе старая запись истории перебивала бы новую ставку
    r = client.patch(f"/admin/suppliers/{sid}", json={"commission_percent": 3, "reason": "Скидка"}, headers=root)
    assert r.status_code == 200, r.text
    items = client.get(f"/admin/suppliers/{sid}/commission", headers=root).json()["items"]
    assert any(x["rate_percent"] == 3 and x["category"] is None and x["reason"] == "Скидка" for x in items)
    perf = client.get("/admin/suppliers/performance", headers=root).json()
    assert next(x for x in perf["items"] if x["id"] == sid)["current_rate_percent"] == 3


def test_suppliers_performance_and_finance_report(app, client, api, owner, root, db):
    a = make_supplier(app, "eman", "EMAN")
    designer = staff(app, client, "d@eman.uz", "vendor_designer", a)
    _, o1 = _order(api, client, owner)
    _, o2 = _order(api, client, owner)
    assert client.post(f"/vendor/orders/{o1['id']}/accept", json={"invoice_total": 1_000_000},
                       headers=designer).status_code == 200
    assert client.post(f"/vendor/orders/{o1['id']}/status", json={"status": "paid"}, headers=designer).status_code == 200
    x2 = db.get(Order, uuid.UUID(o2["id"]))
    x2.status_changed_at = utcnow() - timedelta(hours=40)
    db.commit()
    perf = client.get("/admin/suppliers/performance", headers=root).json()
    e = next(x for x in perf["items"] if x["id"] == a)
    assert e["queue"] == 1 and e["overdue"] == 1 and e["queue_oldest_hours"] >= 39
    assert e["paid_period"] == 1 and e["turnover"] == 1_000_000 and e["median_accept_hours"] is not None
    assert e["return_rate"] == 0 and e["staff"]["active"] == 1 and e["staff"]["owners"] == 0
    assert set(e["commission"]) == {"accrued", "reversed", "due"} and "debt" in e

    rows = _csv(client.get("/admin/finance/report.csv", headers=root))
    assert rows[0][0] == "Взаиморасчёты платформы"
    assert any(r and r[1] == "eman" and r[3] == "1000000" for r in rows)
    assert client.get("/admin/finance/report.csv", headers=staff(app, client, "o@eskizai.uz",
                                                                       "orders_manager")).status_code == 403


# --- Сотрудники ---


def test_staff_overview_sessions_mfa_lock(app, client, root, db):
    sid = make_supplier(app, "eman", "EMAN")
    staff(app, client, "om@eskizai.uz", "orders_manager")
    staff(app, client, "own@eman.uz", "vendor_owner", sid)
    r = client.get("/admin/staff", headers=root).json()
    by = {x["email"]: x for x in r["items"]}
    assert by["root@eskizai.uz"]["mfa_enabled"] is True and by["root@eskizai.uz"]["self"] is True
    assert by["om@eskizai.uz"]["mfa_enabled"] is False and by["om@eskizai.uz"]["active_sessions"] == 1
    assert by["own@eman.uz"]["supplier_name"] == "EMAN" and by["own@eman.uz"]["locked"] is False
    assert r["counters"]["without_mfa"] == 2
    assert [x["email"] for x in client.get("/admin/staff", params={"scope": "suppliers"},
                                           headers=root).json()["items"]] == ["own@eman.uz"]
    assert len(client.get("/admin/staff", params={"q": "om@"}, headers=root).json()["items"]) == 1
    # Завершение сессий — счётчик обнуляется; отключённый — в фильтре inactive
    uid = by["om@eskizai.uz"]["id"]
    assert client.delete(f"/staff/users/{uid}/sessions", headers=root).json()["revoked"] == 1
    assert client.patch(f"/staff/users/{uid}", json={"is_active": False, "reason": "Уволен"},
                        headers=root).status_code == 200
    r = client.get("/admin/staff", params={"state": "inactive"}, headers=root).json()
    assert [x["email"] for x in r["items"]] == ["om@eskizai.uz"] and r["items"][0]["active_sessions"] == 0
    assert db.scalar(select(StaffSession).where(StaffSession.staff_id == uuid.UUID(uid),
                                                StaffSession.revoked_at.is_(None))) is None
    # Не суперадмин и старый токен — нет доступа
    assert client.get("/admin/staff", headers=ADMIN).status_code == 403
    assert client.get("/admin/staff", headers=staff(app, client, "own2@eman.uz", "vendor_owner",
                                                    sid)).status_code == 403


def test_legacy_lists_still_compatible(client, api, owner):
    """Прежние клиенты /admin/workshops и /admin/orders (старый токен, прежние поля)."""
    _order(api, client, owner)
    w = client.get("/admin/workshops", params={"q": "4567"}, headers=ADMIN).json()
    assert w["total"] == 1 and {"free_left", "pack_left", "unlimited", "projects", "orders"} <= set(w["items"][0])
    o = client.get("/admin/orders", params={"status": "created"}, headers=ADMIN).json()
    assert o["total"] == 1 and o["items"][0]["status_label"] and o["items"][0]["project_title"]
