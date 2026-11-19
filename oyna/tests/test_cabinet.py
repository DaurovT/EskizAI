"""Веб-кабинет цен (§10) и поставщики (§9.7): вход cookie + CSRF, правка цены, импорт CSV и xlsx, отмена импорта,
поставщик в расчёте, наценка по группам, миграция схемы на живую базу.

Нужен OYNA_TEST_DSN (как в test_store.py). Без него — пропуск.
"""
import io

import pytest

from tests.test_auth_company import H, login
from tests.test_store import ADMIN, client  # noqa: F401  (фикстура с чистой базой)

pytestmark = pytest.mark.skipif(not ADMIN, reason="OYNA_TEST_DSN не задан")
OWNER, MANAGER, MEASURER, STRANGER = "+998907770001", "+998907770002", "+998907770003", "+998907770004"


def cab(client):
    """Заголовок double-submit: значение cookie oyna_csrf (её ставит GET /cabinet)."""
    return {"X-CSRF-Token": client.cookies.get("oyna_csrf")}


def cab_login(client, phone):
    client.cookies.clear()
    page = client.get("/cabinet")
    assert page.status_code == 200 and "Кабинет цен" in page.text and client.cookies.get("oyna_csrf")
    return client.post("/cabinet/login/verify", json={"phone": phone, "code": "00000"}, headers=cab(client))


def pick_item():
    from oyna_api.app import CAT
    white = [x for x in CAT.items if x["color"] == "Белый"]
    for it in white:
        if it["unit"] == "bar" and it["price_sum"] and it["role"] == "frame" and \
                sum(1 for x in white if x["article"] == it["article"]) == 1:
            return it
    raise AssertionError("нет подходящей позиции")


@pytest.fixture(scope="module")
def shop(client):
    """Цех с владельцем, менеджером и замерщиком (через API приложения)."""
    tok = login(client, OWNER)
    r = client.post("/oyna/company", headers=H(tok), json={"name": "Окна Сергели", "markup_value": 30, "usd_rate": 12000,
                                                          "demo_prices": True}).json()
    tok = r["tokens"]
    client.post("/oyna/company/members", headers=H(tok), json={"phone": MANAGER, "role": "manager"})
    client.post("/oyna/company/members", headers=H(tok), json={"phone": MEASURER, "role": "measurer"})
    return tok


def test_migrate_applies_on_existing_db(client):
    from oyna_api.migrate import migrate
    assert migrate() in ("applied", "up-to-date")
    assert migrate() == "up-to-date"


def test_cabinet_login_roles_and_csrf(client, shop):
    client.cookies.clear()
    client.get("/cabinet")
    # без CSRF-заголовка и с чужим Origin — отказ
    assert client.post("/cabinet/login/request", json={"phone": STRANGER}).status_code == 403
    assert client.post("/cabinet/login/request", json={"phone": STRANGER},
                       headers={**cab(client), "Origin": "https://evil.example"}).status_code == 403
    assert client.post("/cabinet/login/request", json={"phone": STRANGER}, headers=cab(client)).status_code == 200
    # без цеха и замерщику — нельзя
    assert cab_login(client, STRANGER).status_code == 403
    assert cab_login(client, MEASURER).status_code == 403
    # менеджер — можно, наценку не видит и не меняет
    r = cab_login(client, MANAGER)
    assert r.status_code == 200 and r.json()["companies"][0]["role"] == "manager"
    assert "httponly" in r.headers["set-cookie"].lower() and "samesite=lax" in r.headers["set-cookie"].lower()
    s = client.get("/cabinet/session").json()
    assert s["role"] == "manager" and s["company"]["name"] == "Окна Сергели"
    assert client.patch("/oyna/company", json={"markup_value": 1}, headers=cab(client)).status_code == 403
    # владелец
    r = cab_login(client, OWNER)
    assert r.status_code == 200 and not r.json()["choose"]
    assert client.get("/cabinet/session").json()["role"] == "owner"
    # cookie-сессия без CSRF-заголовка не меняет данные
    assert client.put("/oyna/company/works", json={"install": 1}).status_code == 403
    assert client.put("/oyna/company/works", json={"install": 75000}, headers=cab(client)).status_code == 200
    # продление и выход
    assert client.post("/cabinet/refresh", headers=cab(client)).status_code == 200
    assert client.get("/cabinet/session").status_code == 200
    assert client.post("/cabinet/logout", headers=cab(client)).status_code == 200
    assert client.get("/cabinet/session").status_code == 401


def test_price_edit_history_and_calc(client, shop):
    cab_login(client, OWNER)
    it = pick_item()
    q = {"q": it["item_id"]}
    row = client.get("/oyna/company/price-list", params=q).json()["rows"][0]
    assert row["status"] == "base" and row["value"] is None
    lst = client.get("/oyna/company/price-list", params={"flag": "missing", "limit": 5}).json()
    assert lst["counts"]["missing"] > 0 and all(r["no_price"] for r in lst["rows"])
    assert all(r["status"] == "demo" for r in client.get("/oyna/company/price-list", params={"flag": "demo", "limit": 5}).json()["rows"])
    # правка в строке → новая версия, расчёт берёт цену
    r = client.put("/oyna/company/prices", json=[{"item_id": it["item_id"], "color": it["color"], "price_sum": 333000}],
                   headers=cab(client))
    assert r.status_code == 200, r.text
    assert r.json()["rows"][0]["value"] == 333000 and r.json()["rows"][0]["status"] == "own"
    client.put("/oyna/company/prices", json=[{"item_id": it["item_id"], "color": it["color"], "price_sum": 334000}], headers=cab(client))
    hist = client.get("/oyna/company/prices/history", params={"item_id": it["item_id"], "color": it["color"]}).json()["history"]
    assert [h["price_sum"] for h in hist[:2]] == [334000, 333000] and hist[-1]["kind"] == "base"
    # убрать свою цену → снова базовая
    client.put("/oyna/company/prices", json=[{"item_id": it["item_id"], "color": it["color"], "price_sum": None}], headers=cab(client))
    assert client.get("/oyna/company/price-list", params=q).json()["rows"][0]["status"] == "base"
    vers = client.get("/oyna/company/price-versions").json()["versions"]
    assert len([v for v in vers if v["kind"] == "manual"]) >= 3


def test_suppliers_in_calc(client, shop):
    cab_login(client, OWNER)
    h = cab(client)
    s1 = client.post("/oyna/company/suppliers", json={"name": "Стекло-Сервис"}, headers=h).json()["id"]
    s2 = client.post("/oyna/company/suppliers", json={"name": "Glass Pro", "note": "+998 71 000"}, headers=h).json()["id"]
    assert client.put("/oyna/company/glass-prices", params={"supplier_id": s1}, json={"g4_12_4": 210000}, headers=h).json() == {"g4_12_4": 210000}
    client.put("/oyna/company/glass-prices", params={"supplier_id": s2}, json={"g4_12_4": 230000}, headers=h)
    client.put("/oyna/company/glass-prices", json={"g4_12_4": 190000}, headers=h)            # основной прайс цеха
    d = client.put("/oyna/company/suppliers/defaults", json={"glass": s1}, headers=h).json()
    assert d["defaults"]["glass"] == s1 and d["suppliers"][0]["glass_prices"] == 1
    gl = client.get("/oyna/company/glass-list", params={"supplier_id": s2}).json()
    assert next(g for g in gl["presets"] if g["code"] == "g4_12_4")["value"] == 230000
    # расчёт (Bearer, как приложение): основной поставщик стекла, потом переопределение в позиции
    doc = client.post("/oyna/positions/from-template", json={"template": "T03", "setup": {"glass": "g4_12_4"}}, headers=H(shop)).json()["doc"]
    g = [l for l in client.post("/oyna/positions/calc", json={"doc": doc}, headers=H(shop)).json()["bom"] if l["kind"] == "glass"][0]
    assert g["unit_price"] == 210000 and g["supplier_name"] == "Стекло-Сервис"
    doc2 = {**doc, "setup": {**doc["setup"], "suppliers": {"glass": s2}}}
    g2 = [l for l in client.post("/oyna/positions/calc", json={"doc": doc2}, headers=H(shop)).json()["bom"] if l["kind"] == "glass"][0]
    assert g2["unit_price"] == 230000 and g2["supplier_name"] == "Glass Pro"
    alt = client.post("/oyna/positions/alternatives", json={"doc": doc, "what": "supplier:glass"}, headers=H(shop)).json()
    assert {o["value"] for o in alt["options"]} == {None, s2}
    # без основного поставщика — свой прайс цеха
    client.put("/oyna/company/suppliers/defaults", json={"glass": None}, headers=h)
    g3 = [l for l in client.post("/oyna/positions/calc", json={"doc": doc}, headers=H(shop)).json()["bom"] if l["kind"] == "glass"][0]
    assert g3["unit_price"] == 190000 and "supplier_name" not in g3
    # удаление поставщика убирает его цены
    left = client.delete(f"/oyna/company/suppliers/{s2}", headers=h).json()
    assert [s["name"] for s in left["suppliers"]] == ["Стекло-Сервис"]
    assert client.patch("/oyna/company/suppliers/00000000-0000-0000-0000-000000000000", json={"name": "x"}, headers=h).status_code == 404


def test_import_csv_xlsx_and_undo(client, shop):
    import openpyxl
    cab_login(client, OWNER)
    h = cab(client)
    it = pick_item()
    q = {"q": it["item_id"]}
    base = float(it["price_sum"])
    # CSV: артикул, название, цена «312 000», валюта; одна строка не найдена, одна в долларах
    csv_text = ("Артикул;Наименование;Цена;Валюта\n"
                f"{it['article']};;312 000;сум\n"
                ";Неизвестный профиль XYZ;100;сум\n"
                f"{it['item_id']};;26,5;USD\n").encode("cp1251", errors="replace")
    p = client.post("/oyna/company/price-import/parse", params={"filename": "price.csv"}, content=csv_text, headers=h)
    assert p.status_code == 200, p.text
    p = p.json()
    assert p["total"] == 3 and p["mapping"] == {"article": 0, "name": 1, "price": 2, "currency": 3}
    body = {"rows": p["rows"], "mapping": p["mapping"], "filename": "price.csv"}
    pv = client.post("/oyna/company/price-import/preview", json=body, headers=h).json()
    st = [r["status"] for r in pv["rows"]]
    assert st == ["match", "not_found", "match"] and pv["summary"]["by_article"] == 2
    assert pv["rows"][0]["items"][0]["new"] == 312000 and pv["rows"][2]["items"][0]["new"] == 26.5 * 12000
    ap = client.post("/oyna/company/price-import/apply", json=body, headers=h).json()
    assert ap["items"] == 1                                            # одна позиция: последняя строка (USD) побеждает
    row = client.get("/oyna/company/price-list", params=q).json()["rows"][0]
    assert row["value"] == 318000 and row["status"] == "own"
    # повтор того же файла — нечего применять
    assert client.post("/oyna/company/price-import/apply", json=body, headers=h).status_code == 422

    # xlsx: название (порядок слов другой), цена за метр → хлыст, прайс поставщика
    sup = client.post("/oyna/company/suppliers", json={"name": "Akfa дилер"}, headers=h).json()["id"]
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Прайс"
    ws.append(["Прайс от 19.11.2026"])
    ws.append(["Наименование", "Ед. изм.", "Цена, сум"])
    ws.append([" ".join(reversed(it["article"].split())), "м", 50000])
    ws.append(["Нет такого", "шт", "abc"])
    buf = io.BytesIO()
    wb.save(buf)
    p = client.post("/oyna/company/price-import/parse", params={"filename": "akfa.xlsx"}, content=buf.getvalue(), headers=h).json()
    assert p["sheet"] == "Прайс" and p["columns"] == ["Наименование", "Ед. изм.", "Цена, сум"]
    assert p["mapping"] == {"name": 0, "unit": 1, "price": 2}
    body = {"rows": p["rows"], "mapping": p["mapping"], "supplier_id": sup, "filename": "akfa.xlsx"}
    pv = client.post("/oyna/company/price-import/preview", json=body, headers=h).json()
    assert [r["status"] for r in pv["rows"]] == ["match", "not_found"] and pv["rows"][0]["by"] == "name"
    from oyna_api.app import CAT
    bar_m = CAT.passport(it["system_code"]).get("bar_mm", 6000) / 1000
    assert pv["rows"][0]["items"][0]["new"] == 50000 * bar_m
    client.post("/oyna/company/price-import/apply", json=body, headers=h)
    row = client.get("/oyna/company/price-list", params={**q, "supplier_id": sup}).json()["rows"][0]
    assert row["value"] == 50000 * bar_m and row["status"] == "supplier" and row["own"] == 318000

    # отмена последнего импорта (xlsx поставщика), потом предыдущего (CSV)
    v = client.get("/oyna/company/price-versions").json()
    assert v["undo_import"] == v["versions"][0]["id"]
    assert client.post("/oyna/company/price-versions/undo-import", headers=h).json()["items"] == 1
    assert client.get("/oyna/company/price-list", params={**q, "supplier_id": sup}).json()["rows"][0]["supplier"] is None
    client.post("/oyna/company/price-versions/undo-import", headers=h)
    row = client.get("/oyna/company/price-list", params=q).json()["rows"][0]
    assert row["value"] is None and row["effective"] == base
    assert client.post("/oyna/company/price-versions/undo-import", headers=h).status_code == 404
    # старый .xls и пустой файл — понятная ошибка
    assert client.post("/oyna/company/price-import/parse", params={"filename": "old.xls"}, content=b"\xd0\xcf\x11\xe0",
                       headers=h).status_code == 422


def test_markup_groups_api(client, shop):
    cab_login(client, OWNER)
    h = cab(client)
    assert client.patch("/oyna/company", json={"markup_groups": {"glass": 10, "bad": 5}}, headers=h).status_code == 422
    assert client.patch("/oyna/company", json={"markup_kind": "per_m2", "markup_groups": {"glass": 10}}, headers=h).status_code == 422
    r = client.patch("/oyna/company", json={"markup_kind": "percent", "markup_value": 30,
                                            "markup_groups": {"glass": 10, "profile": 50}}, headers=h).json()
    assert r["company"]["markup_groups"] == {"glass": 10, "profile": 50}
    doc = client.post("/oyna/positions/from-template", json={"template": "T03"}, headers=H(shop)).json()["doc"]
    pr = client.post("/oyna/positions/calc", json={"doc": doc}, headers=H(shop)).json()["price"]
    assert pr["markup_groups"] == {"glass": 10, "profile": 50} and pr["by_group"]["glass"] > 0
    # вернуть общую
    r = client.patch("/oyna/company", json={"markup_groups": None}, headers=h).json()
    assert r["company"]["markup_groups"] is None
    assert "markup_groups" not in client.post("/oyna/positions/calc", json={"doc": doc}, headers=H(shop)).json()["price"]
