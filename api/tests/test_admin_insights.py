"""Рабочий стол суперадмина: сводка со сравнением периодов, тревоги, поиск, журнал с IP/причиной/CSV, права."""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from mebel_api.db import utcnow
from mebel_api.models import (
    ActionLog,
    AiRequest,
    AppSetting,
    AuthCode,
    Order,
    OrderDispute,
    OrderReturn,
    ParserRun,
    Payment,
    Project,
    RawPriceRecord,
    SupplierSettlement,
    User,
    Workshop,
)
from mebel_api.services.finance import TZ

from .staff_helpers import make_supplier, staff, superadmin


def _today() -> str:
    return utcnow().astimezone(TZ).date().isoformat()


def _days_ago(n: int) -> str:
    return (utcnow().astimezone(TZ).date() - timedelta(days=n)).isoformat()


@pytest.fixture
def world(app):
    """Два цеха, проекты, заказы (оплаченные сейчас и неделю назад, просроченный), платежи, ИИ, споры, возвраты."""
    now = utcnow()
    eman = uuid.UUID(make_supplier(app, "eman", "EMAN Materials"))
    with app.state.db.sessionmaker() as s:
        w1 = Workshop(name="Цех Азиз", city="Ташкент", phone="+998901112233")
        w2 = Workshop(name="Мебель Плюс", city="Самарканд", created_at=now - timedelta(days=9))
        s.add_all([w1, w2])
        s.flush()
        s.add_all([User(phone="+998901112233", name="Азиз Каримов", workshop_id=w1.id, role="owner"),
                   User(phone="+998935554433", name="Бобур", workshop_id=w2.id, role="owner")])
        p1 = Project(workshop_id=w1.id, title="Шкаф-купе в прихожую")
        p2 = Project(workshop_id=w2.id, title="Кухня угловая", created_at=now - timedelta(days=8),
                     updated_at=now - timedelta(days=8))
        s.add_all([p1, p2])
        s.flush()
        paid_now = Order(project_id=p1.id, number=1001, status="paid", invoice_total=4_000_000, paid_at=now,
                         created_at=now - timedelta(hours=30), accepted_at=now - timedelta(hours=28),
                         supplier_id=eman, commission_amount=120_000)
        paid_before = Order(project_id=p2.id, number=1002, status="issued", estimate_total=1_000_000,
                            paid_at=now - timedelta(days=8), created_at=now - timedelta(days=8),
                            accepted_at=now - timedelta(days=8) + timedelta(hours=2), supplier_id=eman,
                            commission_amount=30_000)
        overdue = Order(project_id=p1.id, number=1003, status="created", estimate_total=900_000,
                        created_at=now - timedelta(hours=40), supplier_id=eman)
        s.add_all([paid_now, paid_before, overdue])
        s.flush()
        s.add_all([
            Payment(workshop_id=w1.id, kind="pro", amount=200_000, method="click", paid_at=now),
            Payment(workshop_id=w1.id, kind="pack", amount=100_000, method="click", status="refunded",
                    paid_at=now, refunded_at=now),
            SupplierSettlement(supplier_id=eman, amount=50_000, paid_at=now),
            # ИИ: у цеха 1 — обычно копейки, сегодня всплеск; у цеха 2 — ровный расход
            *[AiRequest(workshop_id=w1.id, purpose="edit", model="m", cost_microusd=10_000, validation_result="ok",
                        created_at=now - timedelta(days=d)) for d in range(2, 9)],
            AiRequest(workshop_id=w1.id, purpose="edit", model="m", cost_microusd=3_000_000, validation_result="ok"),
            AiRequest(workshop_id=w2.id, purpose="edit", model="m", cost_microusd=150_000, validation_result="ok"),
            AuthCode(phone="+998901112233", code_hash="x", channel="sms", expires_at=now),
            OrderDispute(order_id=paid_before.id, subject="return", reason="amount_wrong",
                         created_at=now - timedelta(hours=5)),
            OrderReturn(order_id=paid_now.id, opened_by_type="master", kind="defect", amount=300_000,
                        status="awaiting_owner"),
            ActionLog(actor_type="system", entity="limits", entity_id=f"ai_daily_workshop:{w1.id}", action="cap_hit",
                      after={"spent_usd": 3.0}),
        ])
        run = ParserRun(supplier_id=eman, source="csv")
        s.add(run)
        s.flush()
        s.add(RawPriceRecord(run_id=run.id, data={}, name="ЛДСП", price=600_000, old_price=500_000, change_pct=20,
                             match_status="changed", review_status="pending", created_at=now - timedelta(hours=30)))
        s.commit()
        return {"w1": str(w1.id), "w2": str(w2.id), "p1": str(p1.id), "eman": str(eman),
                "paid_now": str(paid_now.id), "overdue": str(overdue.id)}


def test_insights_require_staff_and_permissions(app, client, world):
    for path in ("/admin/insights/dashboard", "/admin/insights/alerts", "/admin/insights/search?q=аз",
                 "/admin/insights/audit"):
        assert client.get(path).status_code == 401, path
    vendor = staff(app, client, "owner@eman.uz", "vendor_owner", world["eman"])
    assert client.get("/admin/insights/dashboard", headers=vendor).status_code == 403
    support = staff(app, client, "help@eskizai.uz", "support")
    assert client.get("/admin/insights/audit", headers=support).status_code == 403
    assert client.get("/admin/insights/audit/export.csv", headers=support).status_code == 403

    # поддержка: сводка без денег, ИИ и поставщиков
    d = client.get(f"/admin/insights/dashboard?from={_days_ago(6)}&to={_today()}", headers=support).json()
    assert d["sections"] == {"money": False, "ai": False, "suppliers": False}
    assert "turnover" not in d["kpis"] and "ai_usd" not in d["kpis"] and "commission_accrued" not in d["kpis"]
    assert "top_turnover" not in d and "suppliers" not in d and "turnover" not in d["series"][0]
    assert d["kpis"]["orders"]["value"] == 2

    # тревоги поддержки — без заказов, споров, цен, ИИ
    keys = {a["key"] for a in client.get("/admin/insights/alerts", headers=support).json()["items"]}
    assert not keys & {"overdue_orders", "open_disputes", "price_review", "ai_anomaly", "returns"}

    # менеджер заказов: просрочки и возвраты видит, споры и цены — нет
    om = staff(app, client, "orders@eskizai.uz", "orders_manager")
    keys = {a["key"] for a in client.get("/admin/insights/alerts", headers=om).json()["items"]}
    assert {"overdue_orders", "returns"} <= keys and not keys & {"open_disputes", "price_review", "ai_anomaly"}
    # поиск: заказы и цеха есть, сотрудников и поставщиков (suppliers.manage) — нет
    r = client.get("/admin/insights/search?q=1003", headers=om).json()
    assert [g["key"] for g in r["groups"]] == ["orders"]
    assert r["groups"][0]["items"][0]["href"] == f"/admin/orders/{world['overdue']}"
    assert not [g for g in client.get("/admin/insights/search?q=help", headers=om).json()["groups"]
                if g["key"] == "staff"]


def test_dashboard_kpis_compare_and_series(app, client, world):
    root = superadmin(app, client)
    r = client.get(f"/admin/insights/dashboard?from={_days_ago(6)}&to={_today()}", headers=root)
    assert r.status_code == 200, r.text
    d = r.json()
    k = d["kpis"]
    assert d["days"] == 7 and len(d["series"]) == 7 and d["series"][-1]["date"] == _today()
    assert k["turnover"] == {"value": 4_000_000, "prev": 1_000_000}
    assert k["orders_paid"]["value"] == 1 and k["orders"]["value"] == 2 and k["orders"]["prev"] == 1
    assert k["commission_accrued"]["value"] == 120_000 and k["commission_accrued"]["prev"] == 30_000
    assert k["revenue_pro"]["value"] == 200_000 and k["revenue_refunds"]["value"] == 100_000
    assert k["commission_received"]["value"] == 50_000
    assert k["revenue_net"]["value"] == 200_000  # 200 000 Pro + 100 000 пакет − 100 000 возврат
    assert k["registrations"] == {"value": 1, "prev": 1}
    assert k["projects_created"]["value"] == 1 and k["projects_created"]["prev"] == 1
    assert k["sms_sent"]["value"] == 1
    assert k["ai_usd"]["value"] == pytest.approx(3.0 + 0.15 + 0.05, abs=1e-6)
    assert sum(x["turnover"] for x in d["series"]) == 4_000_000
    assert sum(x["orders"] for x in d["series"]) == 2
    assert d["top_turnover"][0]["name"] == "Цех Азиз" and d["top_ai"][0]["workshop_id"] == world["w1"]
    eman = next(s for s in d["suppliers"] if s["supplier_id"] == world["eman"])
    assert eman["queue"] == 1 and eman["overdue"] == 1 and eman["median_accept_hours"] == 2.0
    assert eman["paid"] == 1 and eman["return_rate"] == 1.0

    # «сегодня» сравнивается с тем же отрезком вчера
    d = client.get(f"/admin/insights/dashboard?from={_today()}&to={_today()}", headers=root).json()
    assert d["days"] == 1 and d["prev_to"] < d["from"]
    assert client.get("/admin/insights/dashboard?from=2026-12-01&to=2026-11-01", headers=root).status_code == 422
    assert client.get("/admin/insights/dashboard?from=2024-01-01&to=2026-01-01", headers=root).status_code == 422


def test_alerts_cover_attention_items(app, client, world):
    root = superadmin(app, client)
    with app.state.db.sessionmaker() as s:
        s.add(AppSetting(key="maintenance_on", value=True))
        for _ in range(12):
            s.add(ActionLog(actor_type="staff", entity="staff_auth", action="login_failed", ip="10.0.0.9",
                            after={"ip": "10.0.0.9"}))
        s.commit()
    r = client.get("/admin/insights/alerts", headers=root)
    assert r.status_code == 200, r.text
    body = r.json()
    by = {a["key"]: a for a in body["items"]}
    assert {"maintenance", "overdue_orders", "open_disputes", "returns", "price_review", "caps_hit", "ai_anomaly",
            "failed_logins"} <= set(by)
    assert body["maintenance"]["on"] is True and body["count"] == len(body["items"])
    assert by["overdue_orders"]["count"] == 1 and by["overdue_orders"]["items"][0]["href"].endswith(world["overdue"])
    assert by["price_review"]["severity"] == "critical"  # поставщик не подтвердил за сутки
    assert "Цех Азиз" in by["caps_hit"]["items"][0]["label"]
    assert by["ai_anomaly"]["count"] == 1 and by["ai_anomaly"]["items"][0]["label"] == "Цех Азиз"
    assert by["failed_logins"]["count"] == 12 and by["failed_logins"]["items"][0]["label"] == "IP 10.0.0.9"
    assert body["items"][0]["severity"] == "critical"  # сначала критичные


def test_search_groups(app, client, world):
    root = superadmin(app, client)
    staff(app, client, "orders@eskizai.uz", "orders_manager")
    groups = lambda q: {g["key"]: g["items"] for g in  # noqa: E731
                        client.get(f"/admin/insights/search?q={q}", headers=root).json()["groups"]}
    g = groups("1112233")  # телефон мастера и цеха
    assert g["workshops"][0]["href"] == f"/admin/workshops/{world['w1']}"
    assert g["masters"][0]["title"] == "Азиз Каримов"
    g = groups("азиз")  # регистр не важен
    assert g["workshops"][0]["title"] == "Цех Азиз" and g["masters"]
    g = groups("прихож")
    assert g["projects"][0]["href"] == f"/admin/projects/{world['p1']}" and g["orders"]
    assert groups("1001")["orders"][0]["title"] == "Заказ №1001"
    assert groups("orders@")["staff"][0]["sub"].startswith("orders@eskizai.uz")
    assert groups("eman")["suppliers"][0]["href"] == f"/admin/suppliers/{world['eman']}"
    assert client.get("/admin/insights/search?q=%25", headers=root).json()["groups"] == []  # % — не шаблон


def test_audit_ip_reason_filters_and_csv(app, client, world):
    root = superadmin(app, client)
    r = client.post(f"/admin/workshops/{world['w1']}/block", json={"blocked": True, "reason": "Мошенничество с картой"},
                    headers=root)
    assert r.status_code == 200, r.text
    with app.state.db.sessionmaker() as s:
        e = s.scalar(select(ActionLog).where(ActionLog.entity == "workshop", ActionLog.action == "block"))
        assert e.ip == "testclient"  # IP запроса пишется в записи сотрудников
        s.add(ActionLog(actor_type="staff", actor_id="admin-token", entity="workshop", entity_id=world["w2"],
                        action="block", after={"blocked": True, "reason": "=HYPERLINK(\"http://x\")"}))
        s.commit()

    support = staff(app, client, "help@eskizai.uz", "support")
    assert client.get("/admin/insights/audit/facets", headers=support).status_code == 403

    page = client.get("/admin/insights/audit?q=мошенничеств", headers=root).json()
    assert page["total"] == 1
    item = page["items"][0]
    assert item["reason"] == "Мошенничество с картой" and item["ip"] == "testclient"
    assert item["actor_name"] == "root" and item["actor_role"] == "Суперадмин"
    assert item["workshop_name"] == "Цех Азиз" and item["href"] == f"/admin/workshops/{world['w1']}"
    assert client.get("/admin/insights/audit?q=root@eskizai", headers=root).json()["total"] >= 2  # по почте: вход + блок
    assert client.get("/admin/insights/audit?entity=workshop&action=block", headers=root).json()["total"] == 2
    assert client.get("/admin/insights/audit?actor=admin-token", headers=root).json()["total"] == 1
    assert client.get("/admin/insights/audit?ip=testclient&entity=workshop", headers=root).json()["total"] == 1
    p2 = client.get("/admin/insights/audit?page_size=1&page=2", headers=root).json()
    assert len(p2["items"]) == 1 and p2["total"] >= 3

    facets = client.get("/admin/insights/audit/facets", headers=root).json()
    assert "block" in facets["actions"]["workshop"] and any(s["name"] == "root" for s in facets["staff"])

    r = client.get("/admin/insights/audit/export.csv?entity=workshop", headers=root)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    text = r.content.decode("utf-8-sig")
    assert "Мошенничество с картой" in text and "testclient" in text
    assert "'=HYPERLINK" in text  # формула — текстом
    # выгрузка журнала сама попадает в журнал
    assert client.get("/admin/insights/audit?entity=audit&action=export", headers=root).json()["total"] == 1
