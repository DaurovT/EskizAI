"""Каталог и парсер прайса: импорт файла → сопоставление → проверка > 15% → публикация; HTML-скелет eman.uz."""

from pathlib import Path

from mebel_api.services.catalog.sources import EmanHtmlSource, parse_price

from .conftest import ADMIN
from .test_roles import employee

SAMPLE = Path(__file__).resolve().parents[1] / "src/mebel_api/services/catalog/samples/eman_sample.html"

CSV1 = (
    "Артикул;Наименование;Тип;Цена;Ед;Декор;Толщина;Длина;Ширина;Текстура;Наличие\n"
    "EM-1;ЛДСП 16 Белый 2800×2070;лдсп;520 000;лист;Белый;16;2800;2070;нет;да\n"
    "EM-2;Кромка ПВХ 2 мм;кромка;4 200;м;;2;;;;да\n"
    "EM-3;Петля 110° с доводчиком;фурнитура;24000;шт;;;;;;да\n"
    ";Без артикула;;100;шт;;;;;;\n"
).encode("utf-8-sig")
CSV2 = (
    "sku,name,type,price,unit\n"
    "EM-1,ЛДСП 16 Белый 2800×2070,sheet,650000,лист\n"   # +25% → на проверку
    "EM-2,Кромка ПВХ 2 мм,edge,4500,м\n"                 # +7% → автоматически
    "EM-4,Направляющие 450,hardware,44000,пара\n"        # новая
).encode()                                                # EM-3 исчезла


def upload(client, data: bytes, name="prices.csv", source="csv", **form):
    return client.post("/admin/catalog/parser-runs", files={"file": (name, data, "text/plain")},
                       data={"source": source, **form}, headers=ADMIN)


def test_csv_import_match_publish(client):
    r = upload(client, CSV1)
    assert r.status_code == 201, r.text
    run = r.json()
    assert run["status"] == "matched" and run["stats"]["new"] == 3 and run["stats"]["invalid"] == 1
    card = client.get(f"/admin/catalog/parser-runs/{run['id']}", headers=ADMIN).json()
    assert {x["match_status"] for x in card["records"]} == {"new", "invalid"}
    assert card["records"][0]["data"]["Наименование"].startswith("ЛДСП")  # сырые данные как есть
    pub = client.post(f"/admin/catalog/parser-runs/{run['id']}/publish", json={}, headers=ADMIN).json()
    assert pub["published"]["created"] == 3 and pub["status"] == "published"
    items = client.get("/admin/catalog/items", headers=ADMIN).json()["items"]
    sheet = next(i for i in items if i["sku"] == "EM-1")
    assert sheet["price"] == 520_000 and sheet["type"] == "sheet" and sheet["thickness_mm"] == 16
    assert sheet["price_source"] == "file:prices.csv" and sheet["price_date"] and not sheet["price_stale"]
    assert client.post(f"/admin/catalog/parser-runs/{run['id']}/publish", json={}, headers=ADMIN).status_code == 409

    # Второй прайс: +25% ждёт подтверждения, +7% — сразу, новая позиция, исчезнувшая
    run2 = upload(client, CSV2, name="p2.csv").json()
    assert run2["status"] == "review"
    assert {k: run2["stats"][k] for k in ("changed", "new", "review", "missing")} == {
        "changed": 2, "new": 1, "review": 1, "missing": 1}
    queue = client.get("/admin/catalog/review-queue", headers=ADMIN).json()
    assert len(queue) == 1 and queue[0]["sku"] == "EM-1" and queue[0]["change_pct"] == 25.0
    r = client.post(f"/admin/catalog/parser-runs/{run2['id']}/publish", json={}, headers=ADMIN)
    assert r.status_code == 409 and r.json()["error"]["code"] == "price_review_pending"

    client.post(f"/admin/catalog/raw-records/{queue[0]['id']}/review", json={"action": "approve"}, headers=ADMIN)
    assert client.get("/admin/catalog/review-queue", headers=ADMIN).json() == []
    pub = client.post(f"/admin/catalog/parser-runs/{run2['id']}/publish", json={}, headers=ADMIN).json()
    assert pub["published"] == {"created": 1, "updated": 2, "confirmed": 0, "hidden": 1, "skipped_pending": 0}
    items = {i["sku"]: i for i in client.get("/admin/catalog/items", headers=ADMIN).json()["items"]}
    assert items["EM-1"]["price"] == 650_000 and items["EM-3"]["available"] is False
    hist = client.get(f"/admin/catalog/items/{items['EM-1']['id']}/history", headers=ADMIN).json()
    assert [(h["old_price"], h["new_price"]) for h in hist] == [(520_000, 650_000), (None, 520_000)]
    log = client.get("/admin/action-log", headers=ADMIN).json()
    assert any(e["entity"] == "catalog_item" and e["action"] == "price_publish" for e in log)
    assert any(e["entity"] == "raw_price_record" and e["action"] == "review" for e in log)


def test_reject_and_skip_pending(client):
    upload(client, CSV1)
    client.post(f"/admin/catalog/parser-runs/{client.get('/admin/catalog/parser-runs', headers=ADMIN).json()[0]['id']}"
                "/publish", json={}, headers=ADMIN)
    run2 = upload(client, CSV2, full_snapshot="false").json()
    assert run2["stats"]["missing"] == 0
    rec = client.get("/admin/catalog/review-queue", headers=ADMIN).json()[0]
    client.post(f"/admin/catalog/raw-records/{rec['id']}/review", json={"action": "reject"}, headers=ADMIN)
    client.post(f"/admin/catalog/parser-runs/{run2['id']}/publish", json={}, headers=ADMIN)
    items = {i["sku"]: i for i in client.get("/admin/catalog/items", headers=ADMIN).json()["items"]}
    assert items["EM-1"]["price"] == 520_000 and items["EM-3"]["available"] is True


def test_manual_price_edit_logged(client):
    r = client.post("/admin/catalog/items", json={"sku": "M-1", "name": "Ручка-скоба", "type": "hardware",
                                                   "price": 18000}, headers=ADMIN)
    assert r.status_code == 201
    iid = r.json()["id"]
    r = client.patch(f"/admin/catalog/items/{iid}", json={"price": 19500}, headers=ADMIN).json()
    assert r["price"] == 19500 and r["price_source"] == "manual"
    log = client.get("/admin/action-log", headers=ADMIN).json()
    assert log[0]["entity"] == "catalog_item" and log[0]["before"] == {"price": 18000}
    assert len(client.get(f"/admin/catalog/items/{iid}/history", headers=ADMIN).json()) == 2
    assert client.patch(f"/admin/catalog/items/{iid}", json={"price": 1}).status_code == 401


def test_eman_html_skeleton_parses_sample(client):
    items = list(EmanHtmlSource([SAMPLE.read_text(encoding="utf-8")]).records())
    assert [i.sku for i in items] == ["EM-LDSP16-WH", "EM-LDSP16-OAK", "EM-EDGE-2", "EM-HINGE-110"]
    oak = items[1]
    assert oak.price == 612_000 and oak.decor == "Дуб сонома" and oak.has_grain and oak.thickness_mm == 16
    assert items[3].available is False and items[3].type == "hardware"
    assert all(i.error is None for i in items)
    r = upload(client, SAMPLE.read_bytes(), name="eman_catalog.html", source="eman_html")
    assert r.status_code == 201 and r.json()["stats"]["new"] == 4
    try:
        EmanHtmlSource.fetch_pages()
    except NotImplementedError as e:
        assert "разрешение" in str(e)
    else:
        raise AssertionError("загрузка с сайта не должна быть включена")


def test_parse_price_formats():
    assert parse_price("520 000 сум") == 520_000
    assert parse_price("1 250,70") == 1251
    assert parse_price("цена по запросу") is None


def test_bad_file_fails_run(client):
    run = upload(client, b"foo;bar\n1;2\n").json()
    assert run["status"] == "failed" and "Наименование" in run["error"]


def test_master_catalog_owner_sees_prices_employee_not(api, client, owner):
    upload(client, CSV1)
    rid = client.get("/admin/catalog/parser-runs", headers=ADMIN).json()[0]["id"]
    client.post(f"/admin/catalog/parser-runs/{rid}/publish", json={}, headers=ADMIN)
    data = client.get("/catalog/items?type=sheet", headers=owner).json()
    assert data["total"] == 1
    it = data["items"][0]
    assert it["price"] == 520_000 and it["price_source"] == "file:prices.csv" and it["price_date"]
    assert it["supplier"] == "EMAN Materials"
    emp = employee(api, client, owner)
    it = client.get("/catalog/items?q=лдсп", headers=emp).json()["items"][0]
    assert it["price"] is None and it["price_source"] is None
