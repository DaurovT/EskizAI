"""Поставщики и деление заказа (§4), комиссия по категориям с датой, миграция 0008 на данных,
лимиты ИИ и SMS, режим обслуживания, рассылки, журнал, сводка суперадмина (§4a)."""

import uuid
from datetime import UTC, datetime, timedelta

import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, select

from mebel_api.db import utcnow
from mebel_api.deps import get_llm
from mebel_api.models import Notification, Order
from mebel_api.services.supplier_routes import category_of

from .conftest import ADMIN
from .staff_helpers import login, make_supplier, staff, superadmin
from .test_misc import API_DIR

BASE_ORDER_KEYS = {"id", "number", "project_id", "project_title", "version_id", "supplier", "status", "status_label",
                   "estimate_total", "invoice_total", "total", "goods_total", "delivery", "pickup", "distance_km",
                   "weight_kg", "composition", "items", "excluded", "payment", "steps", "cancellable", "ready_date",
                   "documents", "paid_at", "handed_over_at", "created_at"}
SECTION9_KEYS = {"supplier_id", "supplier_name", "group_id", "invoice_total", "due_date", "assignee",
                 "vendor_status_note", "reject_reason", "unread_count", "returns_count", "disputes_count", "events"}


def test_category_of_line_keys():
    assert category_of("sheet:ldsp_16_white") == "sheet"
    assert category_of("sheet:mirror_4_silver") == "glass"
    assert category_of("edge:pvc_2:body") == "edge"
    assert category_of("service:cut:ldsp") == "service"
    assert category_of("countertop:countertop_38_oak:top") == "countertop"
    assert category_of("hw:hinge") == "hardware"
    assert category_of("hw:glass:4") == "glass"
    assert category_of("hw:leg:100") == "metal"
    assert category_of("hw:rollers") == "front"
    assert category_of("decor:led:x") == "other" and category_of(None) == "other"


def test_single_supplier_order_is_one_and_compatible(client, api, owner, db):
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    o = client.post(f"/projects/{pid}/orders", json={"distance_km": 5}, headers=owner).json()
    assert BASE_ORDER_KEYS | SECTION9_KEYS <= set(o)
    assert o["supplier"] == "eman" and o["supplier_name"] == "EMAN Materials" and len(o["group_orders"]) == 1
    assert o["assignee"] is None and o["unread_count"] == 0 and o["returns_count"] == 0
    assert o["events"] == [o["events"][0]] and o["events"][0]["type"] == "status_changed"
    assert set(o["events"][0]) >= {"id", "type", "status", "actor_type", "actor_name", "comment", "data", "created_at"}
    assert o["events"][0]["actor_type"] == "master" and o["events"][0]["status"] == "created"
    assert o["delivery"] and o["total"] == o["goods_total"] + o["delivery"]["cost"]
    assert db.scalar(select(sa.func.count(Order.id))) == 1


def test_blocked_supplier_falls_back(app, client, api, owner):
    root = superadmin(app, client)
    eman = make_supplier(app, "eman", "EMAN Materials")
    metal = make_supplier(app, "metal", "Металлоцех")
    assert client.put("/admin/supplier-routes", json={"routes": [{"category": "hardware", "supplier_id": metal},
                                                                 {"category": "hardware", "supplier_id": eman}]},
                      headers=root).status_code == 422
    client.put("/admin/supplier-routes", json={"routes": [{"category": "hardware", "supplier_id": metal}]}, headers=root)
    client.post(f"/admin/suppliers/{metal}/block", json={"blocked": True, "reason": "Пауза"}, headers=root)
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    o = client.post(f"/projects/{pid}/orders", json={}, headers=owner).json()
    assert len(o["group_orders"]) == 1 and o["supplier_id"] == eman  # маршрут на заблокированного → по умолчанию
    # поставщик по умолчанию тоже заблокирован → очередь платформы
    client.post(f"/admin/suppliers/{eman}/block", json={"blocked": True, "reason": "Тест"}, headers=root)
    client.post(f"/orders/{o['id']}/cancel", json={}, headers=owner)
    o2 = client.post(f"/projects/{pid}/orders", json={}, headers=owner).json()
    assert o2["supplier_id"] is None and o2["supplier"] == "platform"
    card = client.get(f"/admin/suppliers/{metal}", headers=root).json()
    assert card["active"] is False and card["blocked_reason"] == "Пауза" and "metrics" in card


def test_commission_by_category_and_effective_date(app, client, api, owner, db):
    root = superadmin(app, client)
    eman = make_supplier(app, "eman", "EMAN Materials")
    past = (utcnow() - timedelta(days=30)).isoformat()
    future = (utcnow() + timedelta(days=30)).isoformat()
    assert client.post(f"/admin/suppliers/{eman}/commission", json={"rate_percent": 3}, headers=root).status_code == 422
    client.post(f"/admin/suppliers/{eman}/commission", json={"rate_percent": 3, "effective_from": past,
                                                             "reason": "Договор"}, headers=root)
    client.post(f"/admin/suppliers/{eman}/commission", json={"rate_percent": 10, "category": "hardware",
                                                             "effective_from": past, "reason": "Фурнитура"}, headers=root)
    client.post(f"/admin/suppliers/{eman}/commission", json={"rate_percent": 50, "effective_from": future,
                                                             "reason": "Позже"}, headers=root)
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    o = client.post(f"/projects/{pid}/orders", json={}, headers=owner).json()
    client.post(f"/admin/projects/{pid}/order-paid", json={}, headers=ADMIN)
    row = db.get(Order, uuid.UUID(o["id"]))
    db.refresh(row)
    lines = row.composition["lines"]
    total = sum(int(l["total"]) for l in lines)
    hw = sum(int(l["total"]) for l in lines if l["key"].startswith("hw:"))
    expected = round(row.estimate_total * ((hw * 1000 + (total - hw) * 300) / total) / 10_000)
    assert row.commission_amount == expected and row.commission_status == "accrued"
    hist = client.get(f"/admin/suppliers/{eman}/commission", headers=root).json()["items"]
    assert len(hist) == 3 and hist[0]["rate_percent"] == 50
    # смена общей ставки через PATCH поставщика — с причиной
    r = client.patch(f"/admin/suppliers/{eman}", json={"commission_percent": 7}, headers=root)
    assert r.status_code == 422
    assert client.patch(f"/admin/suppliers/{eman}", json={"commission_percent": 7, "reason": "Новый договор"},
                        headers=root).json()["commission_percent"] == 7


def test_create_supplier_with_first_owner(app, client):
    root = superadmin(app, client)
    r = client.post("/admin/suppliers", json={"code": "glass", "name": "Стекольщик", "settings": {"inn": "1"},
                                              "owner": {"email": "boss@glass.uz", "name": "Бобур"}}, headers=root)
    assert r.status_code == 201, r.text
    temp = r.json()["owner"]["temp_password"]
    t = login(client, "boss@glass.uz", temp)
    me = client.get("/staff/me", headers={"Authorization": t["Authorization"]}).json()
    assert me["role"] == "vendor_owner" and me["org"]["supplier_code"] == "glass" and me["must_change_password"]
    r = client.post(f"/admin/suppliers/{r.json()['id']}/owner", json={"email": "co@glass.uz", "name": "Второй"},
                    headers=root)
    assert r.status_code == 201 and r.json()["user"]["role"] == "vendor_owner"


def _insert(c, table: str, **values) -> None:
    """Строка с обязательными колонками схемы 0007: незаданные NOT NULL — нейтральные значения."""
    for _, name, typ, notnull, default, _pk in c.execute(sa.text(f"PRAGMA table_info({table})")).all():
        if name in values or not notnull or default is not None:
            continue
        t = typ.upper()
        values[name] = (0 if any(x in t for x in ("INT", "BOOL", "FLOAT", "NUMERIC", "REAL")) else
                        "[]" if t == "JSON" else datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f") if "DATE" in t else "x")
    cols = ", ".join(values)
    c.execute(sa.text(f"INSERT INTO {table} ({cols}) VALUES ({', '.join(':' + k for k in values)})"), values)


def test_migration_0008_backfills_real_data(tmp_path):
    url = f"sqlite:///{tmp_path / 'm.db'}"
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    cfg.attributes["database_url"] = url
    command.upgrade(cfg, "0007")
    eng = create_engine(url)
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")
    ids = {k: uuid.uuid4().hex for k in ("w", "p", "o1", "o2", "n1", "n2", "pr")}
    with eng.begin() as c:
        _insert(c, "workshops", id=ids["w"], name="W", created_at=now)
        _insert(c, "projects", id=ids["p"], workshop_id=ids["w"], title="P", status="in_work", created_at=now,
                updated_at=now)
        for oid, sup in ((ids["o1"], "eman"), (ids["o2"], "metalshop")):
            _insert(c, "orders", id=oid, project_id=ids["p"], supplier=sup, status="paid", created_at=now)
        for nid, path in ((ids["n1"], "eman"), (ids["n2"], "self")):
            _insert(c, "nonstandard_requests", id=nid, project_id=ids["p"], workshop_id=ids["w"], path=path,
                    status="sent", created_at=now, updated_at=now)
        _insert(c, "price_requests", id=ids["pr"], project_id=ids["p"], workshop_id=ids["w"], line_key="hw:x",
                status="pending", created_at=now)
    eng.dispose()
    command.upgrade(cfg, "head")
    eng = create_engine(url)
    with eng.connect() as c:
        sups = dict(c.execute(sa.text("SELECT code, id FROM suppliers")).all())
        assert set(sups) == {"eman", "metalshop"}
        rows = dict(c.execute(sa.text("SELECT id, supplier_id FROM orders")).all())
        assert rows[ids["o1"]] == sups["eman"] and rows[ids["o2"]] == sups["metalshop"]
        assert c.execute(sa.text("SELECT count(*) FROM orders WHERE group_id = id")).scalar() == 2
        ns = dict(c.execute(sa.text("SELECT path, supplier_id FROM nonstandard_requests")).all())
        assert ns["eman"] == sups["eman"] and ns["self"] is None
        assert c.execute(sa.text("SELECT supplier_id FROM price_requests")).scalar() == sups["eman"]
        assert c.execute(sa.text("SELECT settings FROM suppliers WHERE code='eman'")).scalar() in ("{}", {})
    eng.dispose()
    command.downgrade(cfg, "0007")
    eng = create_engine(url)
    with eng.connect() as c:
        assert c.execute(sa.text("SELECT count(*) FROM orders")).scalar() == 2  # данные целы
    eng.dispose()


def test_ai_and_sms_limits_and_registration_switch(app, client, api, owner):
    root = superadmin(app, client)
    pid = api.project(owner, tree=None)
    app.dependency_overrides[get_llm] = lambda: object()
    try:
        r = client.put("/admin/maintenance", json={"ai_enabled": False}, headers=root)
        assert r.status_code == 422  # причина обязательна
        r = client.put("/admin/maintenance", json={"ai_enabled": False, "reason": "Перерасход"}, headers=root)
        assert r.status_code == 200 and r.json()["values"]["ai_enabled"] is False
        r = client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner)
        assert r.status_code == 503 and r.json()["error"]["code"] == "ai_disabled"
        client.put("/admin/maintenance", json={"ai_enabled": True, "reason": "Ок"}, headers=root)
        from mebel_api.models import AiRequest

        with app.state.db.sessionmaker() as s:
            w = s.scalar(select(__import__("mebel_api.models", fromlist=["Workshop"]).Workshop))
            s.add(AiRequest(workshop_id=w.id, project_id=uuid.UUID(pid), purpose="design", model="m", tokens_in=1,
                            tokens_out=1, cost_microusd=6_000_000, validation_result="ok"))
            s.commit()
        r = client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner)
        assert r.status_code == 429 and r.json()["error"]["code"] == "ai_workshop_daily_limit"
        assert client.put("/admin/limits", json={"ai_daily_usd_per_workshop": 0, "ai_daily_usd_global": 1},
                          headers=root).status_code == 200
        r = client.post(f"/projects/{pid}/ai/design", json={"text": "шкаф"}, headers=owner)
        assert r.status_code == 503 and r.json()["error"]["code"] == "ai_daily_limit"
    finally:
        app.dependency_overrides.pop(get_llm, None)
    assert client.put("/admin/limits", json={"sms_per_hour": -1}, headers=root).status_code == 422
    assert client.put("/admin/limits", json={"bogus": 1}, headers=root).status_code == 422
    lim = client.get("/admin/limits", headers=root).json()
    assert lim["values"]["ai_daily_usd_global"] == 1 and lim["today"]["ai_usd"] == 6
    # SMS: owner уже входил (1 код) → лимит 1 в час
    client.put("/admin/limits", json={"sms_per_hour": 1}, headers=root)
    r = client.post("/auth/request-code", json={"phone": "+998907777777", "channel": "sms"})
    assert r.status_code == 429 and r.json()["error"]["code"] == "sms_limit"
    client.put("/admin/limits", json={"sms_per_hour": 0}, headers=root)
    # регистрация новых цехов закрыта; существующий мастер входит
    client.put("/admin/maintenance", json={"registration_enabled": False, "reason": "Атака"}, headers=root)
    sent = len(app.state.test_sender.sent)
    r = client.post("/auth/request-code", json={"phone": "+998907777777", "channel": "sms"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "registration_closed"
    assert len(app.state.test_sender.sent) == sent  # SMS новому номеру не ушло
    assert api.login("+998901234567")


def test_broadcast_audit_and_dashboard(app, client, api, owner, db):
    root = superadmin(app, client)
    api.project(owner)
    om = staff(app, client, "om@eskizai.uz", "orders_manager")
    assert client.post("/admin/broadcasts", json={"title_ru": "x", "body_ru": "y"}, headers=om).status_code == 403
    r = client.post("/admin/broadcasts", json={"title_ru": "Новое", "body_ru": "Обновите приложение",
                                               "segment": {"city": "Ташкент"}, "dry_run": True}, headers=root)
    assert r.json() == {"recipients": 1, "sent": 0, "dry_run": True}
    r = client.post("/admin/broadcasts", json={"title_ru": "Новое", "body_ru": "Обновите приложение",
                                               "title_uz": "Yangi", "body_uz": "Yangilang"}, headers=root)
    assert r.json()["sent"] == 1
    n = db.scalar(select(Notification).where(Notification.kind == "broadcast"))
    assert n.title == "Новое" and n.body == "Обновите приложение"
    assert client.get("/admin/broadcasts", headers=root).json()[0]["recipients"] == 1
    a = client.get("/admin/audit?entity=broadcast", headers=root).json()
    assert a["total"] == 1 and a["items"][0]["actor_name"] == "root"
    assert client.get("/admin/audit?entity=staff_auth&action=login", headers=root).json()["total"] >= 2
    # журнал только на чтение: изменяющих ручек нет
    assert client.delete("/admin/audit", headers=root).status_code == 405
    d = client.get("/admin/dashboard?from=2020-01-01", headers=root).json()
    assert d["workshops"]["total"] == 1 and d["period"]["workshops_new"] == 1
    assert set(d["period"]) >= {"turnover", "commission", "platform_revenue", "ai", "sms", "overdue_orders",
                                "open_disputes", "open_returns", "orders_by_supplier"}
    assert "period" not in client.get("/admin/dashboard", headers=om).json()  # без права finance
    s = client.get("/admin/ai-stats", headers=root).json()
    assert "by_day" in s and "suspicious" in s


def test_scheduler_runs_due_sources(app, monkeypatch, db):
    from mebel_api.models import SupplierPriceSource
    from mebel_api.services import price_import

    sid = make_supplier(app, "eman", "EMAN")
    db.add(SupplierPriceSource(supplier_id=uuid.UUID(sid), url="https://prices.example.com/p.csv", format="csv",
                               mapping={}, schedule="daily", active=True, kind="file_url"))
    db.commit()
    monkeypatch.setattr(price_import, "fetch", lambda *a, **k: b"sku;name;price\nZ-1;Z;1000\n")
    assert price_import.run_due(app.state.db, app.state.settings) == 1
    assert price_import.run_due(app.state.db, app.state.settings) == 0  # раз в день
    src = db.scalar(select(SupplierPriceSource))
    db.refresh(src)
    assert src.last_status == "ok" and src.last_run_at is not None
