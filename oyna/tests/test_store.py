"""Хранение: заказ → позиции офлайн → конфликт ревизий → КП → страница клиента → «Согласен».

Нужен пустой PostgreSQL: OYNA_TEST_DSN="host=127.0.0.1 port=55439 user=postgres dbname=postgres".
Тест сам создаёт базу oyna_test, накатывает schema.sql и seed_import.py. Без переменной — пропуск.
"""
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
ADMIN = os.environ.get("OYNA_TEST_DSN")
pytestmark = pytest.mark.skipif(not ADMIN, reason="OYNA_TEST_DSN не задан")


@pytest.fixture(scope="module")
def client():
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS oyna_test")
        c.execute("CREATE DATABASE oyna_test")
    dsn = ADMIN.rsplit("dbname=", 1)[0] + "dbname=oyna_test"
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute((ROOT / "oyna_data/schema.sql").read_text())
    subprocess.run([sys.executable, str(ROOT / "oyna_data/seed_import.py"), dsn], check=True, capture_output=True)
    os.environ["OYNA_DSN"] = dsn
    from fastapi.testclient import TestClient
    from oyna_api.app import app
    yield TestClient(app)
    os.environ.pop("OYNA_DSN", None)


def tmpl(client, t, **kw):
    return client.post("/oyna/positions/from-template", json={"template": t, **kw}).json()["doc"]


def test_full_flow(client):
    # заказ создан на телефоне офлайн — id с телефона, повторная отправка не дублирует
    oid = str(uuid.uuid4())
    body = {"id": oid, "address": "Чиланзар, 9-й кв., д. 12", "floor": 3, "client": {"name": "Азиз", "phone": "+998901234567"}}
    assert client.post("/oyna/orders", json=body).json()["id"] == oid
    assert client.post("/oyna/orders", json=body).json()["id"] == oid
    assert len([o for o in client.get("/oyna/orders").json() if o["id"] == oid]) == 1

    # две позиции пакетом синхронизации
    p1, p2 = str(uuid.uuid4()), str(uuid.uuid4())
    s = client.post("/oyna/sync", json={"positions": [
        {"order_id": oid, "position_id": p1, "doc": tmpl(client, "T03", room="Кухня")},
        {"order_id": oid, "position_id": p2, "doc": tmpl(client, "T01", room="Спальня")}]}).json()
    assert [x["status"] for x in s["positions"]] == ["ok", "ok"]

    # правка с телефона (base_rev 1) и параллельная правка из офиса (base_rev 1) → конфликт
    doc = client.get(f"/oyna/orders/{oid}").json()["positions"][0]["doc"]
    r1 = client.put(f"/oyna/orders/{oid}/positions/{p1}", json={"doc": dict(doc, qty=2), "base_rev": 1})
    assert r1.status_code == 200 and r1.json()["rev"] == 2
    r2 = client.put(f"/oyna/orders/{oid}/positions/{p1}", json={"doc": dict(doc, qty=3), "base_rev": 1})
    assert r2.status_code == 409 and r2.json()["server"]["doc"]["qty"] == 2
    r3 = client.put(f"/oyna/orders/{oid}/positions/{p1}", json={"doc": dict(doc, qty=3), "base_rev": 1, "force": True})
    assert r3.json()["rev"] == 3 and r3.json()["doc"]["qty"] == 3

    # команды над сохранённой позицией
    r = client.post(f"/oyna/orders/{oid}/positions/{p2}/commands", json={"commands": [
        {"cmd": "set_option", "group": "handle", "code": "euro_pvc.tilt_turn.handle_hoppe_hamburg"}]}).json()
    assert r["rev"] == 2 and r["doc"]["setup"]["options"]["handle"].endswith("hoppe_hamburg")

    # замерщик не видит себестоимость в заказе
    full = client.get(f"/oyna/orders/{oid}").json()
    assert full["can_quote"] and full["total"] > 0

    # КП: 3 варианта комплектаций демо-цеха, заказ → quoted
    q = client.post(f"/oyna/orders/{oid}/quotes", json={"lang": "ru"}).json()
    assert q["version"] == 1 and len(q["variants"]) == 3 and q["demo"]
    assert client.get(f"/oyna/orders/{oid}").json()["order"]["status"] == "quoted"

    # страница клиента: без себестоимости, со схемами
    page = client.get(q["url"]).json()
    assert page["is_latest"] and page["client"] == "Азиз" and page["demo"]
    v0 = page["variants"][0]
    assert "cost" not in str(v0.keys()) and v0["positions"][0]["svg"].startswith("<svg")

    # вторая версия — старая ссылка показывает последнюю
    q2 = client.post(f"/oyna/orders/{oid}/quotes", json={"lang": "uz", "kits": ["Стандарт"]}).json()
    old = client.get(q["url"]).json()
    assert q2["version"] == 2 and not old["is_latest"] and old["version"] == 2 and old["lang"] == "uz"

    # документы S12: КП (цех и клиент), лист для цеха, монтажный лист, заявка поставщику
    for kind in ("quote", "shop", "install", "supplier"):
        r = client.get(f"/oyna/orders/{oid}/documents/{kind}.pdf")
        assert r.status_code == 200 and r.content.startswith(b"%PDF") and len(r.content) > 3000, (kind, r.text[:200])
    pub = client.get(f"{q2['url']}/pdf")
    assert pub.status_code == 200 and pub.content.startswith(b"%PDF")
    assert client.get(f"/oyna/orders/{oid}/documents/shop.pdf", headers={"X-Role": "measurer"}).status_code == 403

    # «Согласен»
    a = client.post(f"{q2['url']}/accept", json={"variant": 0}).json()
    assert a["accepted"] and a["warning"] is None
    assert client.get(f"/oyna/orders/{oid}").json()["order"]["status"] == "agreed"


def test_quote_blocked_with_incomplete_price(client):
    oid = client.post("/oyna/orders", json={"address": "тест"}).json()["id"]
    pid = str(uuid.uuid4())
    bad = tmpl(client, "T01", w=1500, h=1300)                  # створка шире предела — блок 2.2 при любой комплектации
    client.put(f"/oyna/orders/{oid}/positions/{pid}", json={"doc": bad})
    r = client.post(f"/oyna/orders/{oid}/quotes", json={})
    assert r.status_code == 409


def test_unknown_order_404(client):
    assert client.get(f"/oyna/orders/{uuid.uuid4()}").status_code == 404
    assert client.get("/q/nope").status_code == 404
