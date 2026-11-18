"""Вход по коду → новый цех (S02) → настройки (S13) → свои цены в расчёте → сотрудники → каталог (S14).

Нужен OYNA_TEST_DSN (как в test_store.py). Без него — пропуск.
"""
import os

import pytest

from tests.test_store import ADMIN, client  # noqa: F401  (фикстура с чистой базой)

pytestmark = pytest.mark.skipif(not ADMIN, reason="OYNA_TEST_DSN не задан")


def login(client, phone):
    from oyna_api.auth import DevSender
    r = client.post("/auth/request-code", json={"phone": phone})
    assert r.status_code == 200, r.text
    code = DevSender.sent[-1][1]
    return client.post("/auth/verify-code", json={"phone": phone, "code": code}).json()


def H(tok):
    return {"Authorization": f"Bearer {tok['access_token']}"}


def test_login_limits_and_errors(client):
    phone = "+998 90 111 22 33"
    assert client.post("/auth/request-code", json={"phone": phone}).status_code == 200
    assert client.post("/auth/request-code", json={"phone": phone}).status_code == 429          # повтор раньше 60 с
    bad = client.post("/auth/verify-code", json={"phone": phone, "code": "99999"})
    assert bad.status_code == 400 and bad.json()["detail"]["attempts_left"] == 4
    assert client.post("/auth/request-code", json={"phone": "12345"}).status_code == 422


def test_onboarding_settings_prices_members(client):
    tok = login(client, "+998901112244")
    assert tok["is_new"] and tok["needs_onboarding"] and tok["company_id"] is None
    assert client.get("/oyna/company", headers=H(tok)).status_code == 409              # цеха ещё нет

    # S02: цех с плохой комплектацией не создаётся
    bad = client.post("/oyna/company", headers=H(tok), json={"name": "Окна Юнусабад", "kits": [
        {"name": "Эконом", "setup": {"system": "akfa__6000_qvt", "glass": "4-16-4"}}]})
    assert bad.status_code == 422 and "4.6" in bad.json()["detail"]
    r = client.post("/oyna/company", headers=H(tok), json={"name": "Окна Юнусабад", "markup_value": 25,
                                                          "works": {"install": 70000}, "usd_rate": 12010.45}).json()
    tok = r["tokens"]
    assert tok["company_id"] and r["company"]["onboarding"]["glass_missing"]

    # S13: настройки, работы, стекольщик
    assert client.patch("/oyna/company", headers=H(tok), json={"skew_warn_mm": 15}).json()["company"]["skew_warn_mm"] == 15
    assert client.patch("/oyna/company", headers=H(tok), json={"usd_rate": None}).json()["company"]["usd_rate"] is None
    client.put("/oyna/company/works", headers=H(tok), json={"dismantle": 40000, "slopes": 45000, "sill_install": 25000,
                                                           "drip_install": 15000, "install_door": 150000})
    gp = client.put("/oyna/company/glass-prices", headers=H(tok), json={"g4_12_4": 150000, "4i-16-4": 210000}).json()
    assert gp["g4_12_4"] == 150000 and gp["4i-16-4"] == 210000

    # расчёт берёт цены цеха: стекло 150 000 вместо 140 000
    doc = client.post("/oyna/positions/from-template", json={"template": "T03"}, headers=H(tok)).json()["doc"]
    calc = client.post("/oyna/positions/calc", json={"doc": doc}, headers=H(tok)).json()
    glass = [l for l in calc["bom"] if l["kind"] == "glass"][0]
    assert glass["unit_price"] == 150000 and "стекольщика цеха" in glass["note"]
    frame = [l for l in calc["bom"] if l["kind"] == "profile"][0]
    client.put("/oyna/company/prices", headers=H(tok), json=[{"item_id": frame["item_id"], "color": "Белый", "price_sum": 150000}])
    calc2 = client.post("/oyna/positions/calc", json={"doc": doc}, headers=H(tok)).json()
    assert [l for l in calc2["bom"] if l["kind"] == "profile"][0]["unit_price"] == 150000

    # сотрудник-замерщик: видит цех, но не наценку и не может менять настройки
    client.post("/oyna/company/members", headers=H(tok), json={"phone": "+998901112255", "role": "measurer"})
    m = login(client, "+998901112255")
    assert m["companies"][0]["role"] == "measurer"
    got = client.get("/oyna/company", headers=H(m)).json()
    assert "markup_value" not in got["company"]
    assert client.patch("/oyna/company", headers=H(m), json={"markup_value": 1}).status_code == 403
    mc = client.post("/oyna/positions/calc", json={"doc": doc}, headers=H(m)).json()
    assert "cost" not in mc["price"]

    # обновление токена: старый refresh больше не работает
    r1 = client.post("/auth/refresh", json={"refresh_token": tok["refresh_token"]}).json()
    assert client.post("/auth/refresh", json={"refresh_token": tok["refresh_token"]}).status_code == 401
    assert client.get("/auth/me", headers=H(r1)).json()["companies"][0]["role"] == "owner"


def test_catalog_review_admin(client):
    review = client.get("/oyna/catalog/review").json()
    assert review and all(x["needs_review"] for x in review)
    item = next(x for x in review if x["role"] == "other")
    assert client.patch(f"/oyna/catalog/items/{item['item_id']}/role", json={"role": "fit_lock"}).status_code == 403
    r = client.patch(f"/oyna/catalog/items/{item['item_id']}/role", json={"role": "fit_lock"},
                     headers={"X-Admin-Token": "dev-admin-token"}).json()
    assert r["role"] == "fit_lock" and not r["needs_review"]
    brands = client.get("/oyna/catalog/brands").json()
    assert any(b["brand"] == "Akfa" for b in brands)
