"""Данные для экранов заказа по макетам: список и счётчики (S03), заказ (S04), предупреждения и конфликт (S06),
комплектация на весь заказ и варианты (S08, MSummary), расчёт группами (S09), КП и отзыв ссылки (S10, S11)."""
import os
import uuid

import pytest

from tests.test_store import ADMIN, client  # noqa: F401

pytestmark = pytest.mark.skipif(not ADMIN, reason="OYNA_TEST_DSN не задан")


def tmpl(client, t, **kw):
    return client.post("/oyna/positions/from-template", json={"template": t, **kw}).json()["doc"]


def test_order_screens(client):
    os.environ["OYNA_FX_FIXED"] = "12010.45"
    oid = client.post("/oyna/orders", json={"address": "Юнусабад 4", "floor": 2}).json()["id"]
    p1, p2 = str(uuid.uuid4()), str(uuid.uuid4())
    client.put(f"/oyna/orders/{oid}/positions/{p1}", json={"doc": tmpl(client, "T03", room="Кухня")})
    d2 = tmpl(client, "T01", w=703, h=1300, room="Спальня")                          # 1.6 — предупреждение
    d2["qty"] = 2
    client.put(f"/oyna/orders/{oid}/positions/{p2}", json={"doc": d2})

    # S04: клиент, сопутствующий товар, итоги
    client.patch(f"/oyna/orders/{oid}", json={"client": {"name": "Рустам", "phone": "+998901234500", "telegram": "@rustam"}})
    ex = client.post(f"/oyna/orders/{oid}/extras", json={"name": "Москитная сетка VSN", "qty": 2, "price_sum": 269000}).json()
    assert ex[0]["total"] == 538000
    o = client.get(f"/oyna/orders/{oid}").json()
    assert o["client"]["telegram"] == "@rustam" and o["units"] == 3 and o["extras_total"] == 538000
    assert o["area_m2"] == pytest.approx(1.82 + 2 * 0.914, abs=0.01) and o["total"] > 538000
    assert o["cost"] and o["margin"] and o["markup_value"] == 30 and o["total_usd"]
    assert o["positions"][1]["label"].startswith("Akfa 6000 QVT")

    # S03: строка списка и счётчики
    row = next(r for r in client.get("/oyna/orders").json() if r["id"] == oid)
    assert row["units"] == 3 and row["area_m2"] > 3 and row["total"] == o["total"] and row["client_telegram"] == "@rustam"
    counts = client.get("/oyna/orders/counts").json()
    assert counts["all"] >= 1 and counts["measure"] >= 1

    # S06: принять предупреждение — автор из сервера; отменить
    r = client.post(f"/oyna/orders/{oid}/positions/{p2}/commands",
                    json={"commands": [{"cmd": "accept_warning", "rule": "1.6", "user": "кто-то"}]}).json()
    acc = next(v for v in r["violations"] if v["code"] == "1.6")
    assert acc["accepted"] and acc["accepted_by"] == "dev"
    r = client.post(f"/oyna/orders/{oid}/positions/{p2}/commands",
                    json={"commands": [{"cmd": "unaccept_warning", "rule": "1.6"}]}).json()
    assert not next(v for v in r["violations"] if v["code"] == "1.6")["accepted"]

    # S08: варианты по заказу, комплектация на весь заказ
    vs = client.get(f"/oyna/orders/{oid}/variants").json()
    assert [v["kit"] for v in vs] == ["Эконом", "Стандарт", "Тёплый"] and all(v["per_m2"] for v in vs)
    ak = client.post(f"/oyna/orders/{oid}/apply-kit", json={"kit_name": "Тёплый"}).json()
    assert all(p["doc"]["setup"]["system"] == "akfa__7000_akfa_eko" for p in ak["positions"])
    assert client.get(f"/oyna/orders/{oid}").json()["kit_name"] == "Тёплый"
    stale = client.post(f"/oyna/orders/{oid}/apply-kit", json={"kit_name": "Эконом", "base_revs": {p1: 1}})
    assert stale.status_code == 409

    # S09: расчёт заказа группами с хлыстами
    calc = client.get(f"/oyna/orders/{oid}/calc").json()
    keys = [g["key"] for g in calc["groups"]]
    assert {"profile", "glass", "fitting", "extras"} <= set(keys)
    assert next(g for g in calc["groups"] if g["key"] == "profile")["bars"] >= 1
    assert any(a.startswith("5.1") for a in calc["auto_added"]) and calc["cost"]
    meas = client.get(f"/oyna/orders/{oid}/calc", headers={"X-Role": "measurer"}).json()
    assert "cost" not in meas and all("cost" not in g for g in meas["groups"])

    # S10/S11: КП с описанием позиций, суммой работ и сопутствующими; ссылки; согласие; правка → КП устарело
    q = client.post(f"/oyna/orders/{oid}/quotes", json={"lang": "uz"}).json()
    assert q["public_url"].startswith("https://") and "t.me/share" in q["telegram_share"]
    page = client.get(q["url"]).json()
    v0 = page["variants"][0]
    assert page["status"] == "active" and v0["extras"][0]["name"].startswith("Москитная")
    assert v0["positions"][0]["desc"]["system"] and v0["works_total"] >= 0
    acc = client.post(f"{q['url']}/accept", json={"variant": 1}).json()
    assert acc["kit"] == "Стандарт"
    row = next(r for r in client.get("/oyna/orders").json() if r["id"] == oid)
    assert row["status"] == "agreed" and row["accepted_kit"] == "Стандарт"
    client.put(f"/oyna/orders/{oid}/positions/{p1}", json={"doc": dict(tmpl(client, "T03", room="Кухня"), qty=2), "force": True})
    assert client.get(f"/oyna/orders/{oid}").json()["quote_outdated"]

    # конфликт показывает автора и время
    c409 = client.put(f"/oyna/orders/{oid}/positions/{p1}", json={"doc": tmpl(client, "T03"), "base_rev": 1})
    assert c409.status_code == 409 and "updated_at" in c409.json()["server"]

    # отзыв ссылки
    client.post(f"/oyna/orders/{oid}/quotes/{q['version']}/revoke")
    gone = client.get(q["url"]).json()
    assert gone["status"] == "revoked" and gone["company"] and "variants" not in gone
    assert client.post(f"{q['url']}/accept", json={"variant": 0}).status_code == 410


def test_reference_data_for_screens(client):
    t = {x["id"]: x for x in client.get("/oyna/templates").json()}
    assert t["T03"]["ready"] and not t["T12"]["ready"] and t["T09"]["category"] == "balcony"
    assert {"path": "0", "size": 750} in t["T09"]["fixed_parts"]
    s = {x["code"]: x for x in client.get("/oyna/systems", params={"q": "6000"}).json()}
    assert s["akfa__6000_qvt"]["chambers"] == 4 and s["akfa__6000_trio"]["chambers"] == 3
    assert s["akfa__6000_qvt"]["depth_mm"] == 60 and not s["akfa__6000_qvt"]["demo_passport"]
    assert client.get("/oyna/fx/usd").json()["rate"] == 12010.45
