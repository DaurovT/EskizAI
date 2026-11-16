"""Eskiz DWG → Eskiz Mebel: вход без создания аккаунта, ограниченный токен, входящие чертежи (docs/dwg_contract.md).

Пакеты .eskiz здесь — синтетические (настоящие с данными заказчиков в репозиторий не кладём)."""

import asyncio
import hashlib
import io
import json
import os
import uuid
import zipfile
from datetime import timedelta

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from mebel_api.db import utcnow
from mebel_api.deps import get_current_user, get_current_user_inbox
from mebel_api.models import AuthCode, Device, InboxDrawing, Invite, RefreshToken, User, Workshop
from mebel_api.services import inbox as inbox_service
from mebel_api.services import signed_files

from .conftest import build_app, make_settings

A, B, NEW = "+998901234567", "+998901112233", "+998977770000"


def webp(tag: bytes = b"s1") -> bytes:
    body = b"VP8 " + tag * 20
    return b"RIFF" + len(body).to_bytes(4, "little") + b"WEBP" + body


def manifest(**over) -> dict:
    m = {
        "format": "eskiz", "format_version": 1,
        "converter": {"name": "Eskiz.Dwg.Core", "version": "0.1.0"},
        "created_at": "2026-11-16T14:40:11.690116+00:00",
        "app": {"name": "eskiz-dwg", "version": "0.1.0", "platform": "ios"},
        "target": "mebel", "title": "Кухня Азизы",
        "source": {"file_name": "kitchen.dwg", "size": 10, "sha256": "a" * 64, "kind": "dwg"},
        "units": {"code": "mm", "to_mm": 1, "source": "file"},
        "stats": {"objects": 10, "layers": 2, "sheets": 2},
        "sheets": [
            {"id": "s1", "number": "1", "name": "План", "preview": "previews/s1.webp", "selected": False},
            {"id": "s2", "number": "2", "name": "Разрез", "preview": "previews/s2.webp", "selected": True},
        ],
        "not_shown": [], "files": {"data": "data.json", "source": "source.dwg"},
        "future_field": {"anything": [1, 2]},
    }
    m.update(over)
    return {k: v for k, v in m.items() if v is not None}


def package(m: dict | None = None, *, previews: dict[str, bytes] | None = None, salt: bytes = b"",
            raw_manifest: bytes | None = None, with_manifest: bool = True) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if with_manifest:
            zf.writestr("manifest.json", raw_manifest if raw_manifest is not None
                        else json.dumps(m if m is not None else manifest(), ensure_ascii=False))
        zf.writestr("data.json", json.dumps({"data_version": 0}))
        for name, data in (previews if previews is not None else
                           {"previews/s1.webp": webp(b"s1"), "previews/s2.webp": webp(b"s2")}).items():
            zf.writestr(name, data)
        zf.writestr("source.dwg", b"AC1032" + salt + bytes(range(256)) * 4)
    return buf.getvalue()


def code_for(api, client, phone: str) -> str:
    r = client.post("/auth/request-code", json={"phone": phone, "channel": "sms"})
    assert r.status_code == 200, r.text
    assert r.json()["channel"] == "sms"
    return api.sender.sent[-1][1]


def dwg_login(api, client, phone: str, **extra) -> dict:
    r = client.post("/auth/verify-code", json={"phone": phone, "code": code_for(api, client, phone), "create": False,
                                               "scope": "dwg_upload", **extra})
    assert r.status_code == 200, r.text
    return r.json()


def bearer(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def upload(client, h, data: bytes, name: str = "Кухня.eskiz"):
    return client.post("/inbox/drawings", files={"file": (name, data, "application/octet-stream")}, headers=h)


def counts(db) -> tuple[int, int]:
    db.expire_all()
    return db.scalar(select(func.count(User.id))), db.scalar(select(func.count(Workshop.id)))


# --- вход ---


def test_create_false_unknown_number_404_and_nothing_created(api, client, db):
    before = counts(db)
    code = code_for(api, client, NEW)  # SMS на номер без аккаунта уходит как обычно
    r = client.post("/auth/verify-code", json={"phone": NEW, "code": code, "create": False, "scope": "dwg_upload",
                                               "device_id": "iphone", "push_token": "ExponentPushToken[x]"})
    assert r.status_code == 404
    err = r.json()["error"]
    assert err["code"] == "account_not_found"
    assert err["message"] == "Аккаунт с этим номером не найден — зарегистрируйтесь в приложении Eskiz Mebel"
    assert counts(db) == before
    assert db.scalar(select(func.count(Device.id))) == 0
    assert db.scalar(select(func.count(RefreshToken.id))) == 0
    # код погашен: тем же кодом не войти — ни снова, ни с create=true
    assert db.scalar(select(AuthCode.consumed_at).where(AuthCode.phone == NEW)) is not None
    r = client.post("/auth/verify-code", json={"phone": NEW, "code": code})
    assert r.status_code == 400 and r.json()["error"]["code"] == "code_expired"
    assert counts(db) == before


def test_create_false_wrong_code_is_checked_first(api, client, db):
    code = code_for(api, client, NEW)
    wrong = "99999" if code != "99999" else "88888"
    r = client.post("/auth/verify-code", json={"phone": NEW, "code": wrong, "create": False})
    assert r.status_code == 400 and r.json()["error"]["code"] == "code_invalid"
    assert db.scalar(select(AuthCode.attempts).where(AuthCode.phone == NEW)) == 1
    r = client.post("/auth/verify-code", json={"phone": NEW, "code": code, "create": False})
    assert r.status_code == 404


def test_create_false_invited_number_does_not_touch_invite(api, client, owner, db):
    r = client.post("/workshops/me/employees", json={"phone": NEW, "name": "Бахтиёр"}, headers=owner)
    assert r.status_code == 201
    before = counts(db)
    r = client.post("/auth/verify-code", json={"phone": NEW, "code": code_for(api, client, NEW), "create": False})
    assert r.status_code == 404 and r.json()["error"]["code"] == "account_not_found"
    assert counts(db) == before
    inv = db.scalar(select(Invite).where(Invite.phone == NEW))
    assert inv.status == "pending" and inv.user_id is None


def test_create_false_known_number_logs_in(api, client, db):
    api.login(A)
    r = client.post("/auth/verify-code", json={"phone": A, "code": code_for(api, client, A), "create": False})
    assert r.status_code == 200
    body = r.json()
    assert body["is_new_user"] is False and body["scope"] == "full"
    assert client.get("/projects", headers=bearer(body)).status_code == 200
    assert db.scalar(select(func.count(User.id)).where(User.phone == A)) == 1


def test_default_verify_unchanged(api, client):
    r = client.post("/auth/verify-code", json={"phone": NEW, "code": code_for(api, client, NEW)})
    assert r.status_code == 200
    assert r.json()["is_new_user"] is True and r.json()["scope"] == "full"


def test_dwg_scope_token_and_refresh_keep_scope(api, client, app, db):
    api.login(A)
    t = dwg_login(api, client, A)
    assert t["scope"] == "dwg_upload"
    s = app.state.settings
    assert jwt.decode(t["access_token"], s.jwt_secret, algorithms=[s.jwt_algorithm])["scp"] == "dwg_upload"
    h = bearer(t)
    assert client.get("/auth/me", headers=h).json()["phone"] == A
    r = client.get("/projects", headers=h)
    assert r.status_code == 403 and r.json()["error"]["code"] == "scope_limited"

    r = client.post("/auth/refresh", json={"refresh_token": t["refresh_token"]})
    assert r.status_code == 200
    t2 = r.json()
    assert t2["scope"] == "dwg_upload"
    assert client.get("/projects", headers=bearer(t2)).status_code == 403
    assert client.get("/inbox/drawings", headers=bearer(t2)).status_code == 200
    # и ещё одна ротация — всё так же ограниченный
    t3 = client.post("/auth/refresh", json={"refresh_token": t2["refresh_token"]}).json()
    assert t3["scope"] == "dwg_upload"
    assert client.patch("/auth/me", json={"name": "X"}, headers=bearer(t3)).status_code == 403
    assert client.post("/auth/logout", json={"refresh_token": t3["refresh_token"]}).status_code == 200
    assert client.post("/auth/refresh", json={"refresh_token": t3["refresh_token"]}).status_code == 401


def test_dwg_login_does_not_register_device_or_push(api, client, db):
    api.login(A)
    dwg_login(api, client, A, device_id="dwg-iphone", platform="ios", push_token="ExponentPushToken[dwg]")
    assert db.scalar(select(func.count(Device.id))) == 0


def test_dwg_login_hides_invite(api, client, owner):
    client.post("/auth/verify-code", json={"phone": NEW, "code": code_for(api, client, NEW)})  # свободный аккаунт
    assert client.post("/workshops/me/employees", json={"phone": NEW}, headers=owner).status_code == 201
    t = dwg_login(api, client, NEW)
    assert t["invite"] is None


def test_token_without_scope_claim_is_full(api, client, app):
    h = api.login(A)
    s = app.state.settings
    payload = jwt.decode(h["Authorization"].split()[1], s.jwt_secret, algorithms=[s.jwt_algorithm])
    payload.pop("scp")
    old = jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)
    assert client.get("/projects", headers={"Authorization": f"Bearer {old}"}).status_code == 200
    payload["scp"] = "admin"  # неизвестная область — не принимается нигде
    odd = {"Authorization": f"Bearer {jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)}"}
    assert client.get("/auth/me", headers=odd).status_code == 403


def test_dwg_token_not_accepted_by_staff_endpoints(api, client):
    api.login(A)
    h = bearer(dwg_login(api, client, A))
    assert client.get("/staff/me", headers=h).status_code == 401
    assert client.get("/admin/workshops", headers=h).status_code == 401


# --- область токена: запрет по умолчанию по всем ручкам ---


def _routes(app):
    """(путь, APIRoute) всех ручек, включая подключённые роутеры (FastAPI ≥ 0.16x хранит их как _IncludedRouter)."""
    for r in app.routes:
        if hasattr(r, "effective_route_contexts"):
            for c in r.effective_route_contexts():
                yield c.path, c.original_route
        elif hasattr(r, "dependant"):
            yield r.path, r


def _calls(dependant) -> set:
    out = {dependant.call}
    for d in dependant.dependencies:
        out |= _calls(d)
    return out


def _fill(path: str) -> str:
    import re

    return re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)


ALLOWED_FOR_DWG = {("GET", "/auth/me"), ("POST", "/inbox/drawings"), ("GET", "/inbox/drawings"),
                   ("GET", "/inbox/drawings/{drawing_id}"), ("DELETE", "/inbox/drawings/{drawing_id}")}


def test_dwg_scope_default_deny_across_all_routes(api, client, app):
    api.login(A)
    h = bearer(dwg_login(api, client, A))
    full_only, inbox_ok = [], set()
    for path, route in _routes(app):
        calls = _calls(route.dependant)
        for m in route.methods - {"HEAD", "OPTIONS"}:
            if get_current_user_inbox in calls:
                inbox_ok.add((m, path))
            elif get_current_user in calls:
                full_only.append((m, path))
    # только эти ручки явно разрешили ограниченный токен
    assert inbox_ok == ALLOWED_FOR_DWG
    assert len(full_only) > 80
    sample = {("GET", "/projects"), ("GET", "/clients"), ("GET", "/billing/limits"), ("GET", "/workshops/me"),
              ("POST", "/devices"), ("POST", "/projects"), ("PATCH", "/auth/me"),
              ("POST", "/auth/invite/{invite_id}/accept"), ("POST", "/auth/delete-account")}
    assert sample <= set(full_only), sample - set(full_only)
    for m, path in full_only:
        r = client.request(m, _fill(path), headers=h)
        assert r.status_code == 403 and r.json()["error"]["code"] == "scope_limited", (m, path, r.status_code)


def test_orders_and_budget_routes_are_full_only(app):
    paths = {p for p, r in _routes(app) if get_current_user in _calls(r.dependant)}
    assert any(p.startswith("/projects/{project_id}/orders") or p.startswith("/orders") for p in paths)
    assert any("billing" in p for p in paths)


# --- входящие чертежи ---


@pytest.fixture
def a(api, client):
    api.login(A)
    return bearer(dwg_login(api, client, A))


@pytest.fixture
def b(api, client):
    api.login(B)
    return bearer(dwg_login(api, client, B))


def test_upload_list_get_download(client, a, db, settings):
    data = package()
    r = upload(client, a, data)
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["title"] == "Кухня Азизы" and d["filename"] == "Кухня.eskiz"
    assert d["size"] == len(data) and d["sha256"] == hashlib.sha256(data).hexdigest()
    assert d["sheet_count"] == 2 and d["units_guessed"] is False and d["units_note"] is None
    assert d["package_created_at"] == "2026-11-16T14:40:11.690116+00:00"
    assert d["last_opened_at"] is None
    # превью — отмеченного листа (s2), WebP, по подписанной ссылке без токена
    p = client.get(d["preview_url"])
    assert p.status_code == 200 and p.content == webp(b"s2")
    assert p.headers["content-type"] == "image/webp"

    page = client.get("/inbox/drawings", headers=a).json()
    assert page["total"] == 1 and page["items"][0]["id"] == d["id"]

    r = client.get(f"/inbox/drawings/{d['id']}", headers=a)
    assert r.status_code == 200
    full = r.json()
    assert full["manifest"]["future_field"] == {"anything": [1, 2]}  # неизвестные поля сохраняются как есть
    assert [s["number"] for s in full["sheets"]] == ["1", "2"]
    assert full["sheets"][0]["preview_url"] is None and full["sheets"][1]["preview_url"]
    assert full["sheets"][1]["selected"] is True
    dl = client.get(full["download_url"])
    assert dl.status_code == 200 and dl.content == data
    assert dl.headers["content-disposition"].startswith("attachment")
    row = db.get(InboxDrawing, uuid.UUID(d["id"]))
    assert row.storage_key.startswith("private/inbox/") and row.workshop_id is None
    assert (settings.media_dir / row.storage_key).read_bytes() == data
    assert client.get("/media/" + row.storage_key).status_code == 404  # закрытая зона по /media не отдаётся


def test_full_token_also_uses_inbox(api, client):
    h = api.login(A)
    assert upload(client, h, package()).status_code == 201
    assert client.get("/inbox/drawings", headers=h).json()["total"] == 1


def test_inbox_requires_login(client):
    assert client.get("/inbox/drawings").status_code == 401
    assert upload(client, {}, package()).status_code == 401


def test_same_package_twice_returns_existing(client, a):
    data = package()
    first = upload(client, a, data).json()
    r = upload(client, a, data, name="другое имя.eskiz")
    assert r.status_code == 200 and r.json()["id"] == first["id"]
    assert client.get("/inbox/drawings", headers=a).json()["total"] == 1


def test_units_guessed_and_model_preview(client, a):
    m = manifest(units={"code": "mm", "to_mm": 1, "source": "guessed", "note": "Единицы не указаны в файле"},
                 sheets=[], stats={"sheets": 0}, model_preview="previews/model.webp")
    d = upload(client, a, package(m, previews={"previews/model.webp": webp(b"md")})).json()
    assert d["units_guessed"] is True and d["units_note"] == "Единицы не указаны в файле"
    assert d["sheet_count"] == 0
    assert client.get(d["preview_url"]).content == webp(b"md")


def test_preview_fallbacks(client, a):
    # ни один лист не отмечен флагом, но есть selected_sheets
    sheets = [{"id": "s1", "number": "1", "preview": "previews/s1.webp"},
              {"id": "s2", "number": "2", "preview": "previews/s2.webp"}]
    d = upload(client, a, package(manifest(sheets=sheets, selected_sheets=["s2"]))).json()
    assert client.get(d["preview_url"]).content == webp(b"s2")
    # не WebP внутри — без превью, пакет всё равно принят
    d = upload(client, a, package(manifest(title="без превью"), previews={"previews/s2.webp": b"\x89PNG\r\n\x1a\n"},
                                  salt=b"x")).json()
    assert d["preview_url"] is None


@pytest.mark.parametrize("data,reason", [
    (b"", "empty"),
    (b"not a zip at all", "not_zip"),
    (package(with_manifest=False), "no_manifest"),
    (package(raw_manifest=b"{broken"), "manifest_invalid"),
    (package(raw_manifest=b"[1, 2]"), "manifest_invalid"),
    (package(raw_manifest=b'{"format": "eskiz", "x": NaN}'), "manifest_invalid"),
    (package(raw_manifest=b" " * (256 * 1024 + 1)), "manifest_too_large"),
    (package(manifest(format="dxf")), "format"),
    (package(manifest(format_version="1")), "format_version"),
    (package(manifest(source={"kind": "dwg"})), "source"),
    (package(manifest(source={"sha256": "A" * 64, "kind": "dwg"})), "source"),
    (package(manifest(source={"sha256": "a" * 64})), "source"),
    (package(manifest(title=None)), "title"),
    (package(manifest(files=None)), "files"),
])
def test_bad_packages(client, a, data, reason):
    r = upload(client, a, data)
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "bad_package" and r.json()["error"]["details"]["reason"] == reason


def test_unsupported_package(client, a):
    r = upload(client, a, package(manifest(format_version=2)))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "unsupported_package"
    assert r.json()["error"]["details"] == {"format_version": 2, "supported": [1]}


def test_missing_file_field(client, a):
    r = client.post("/inbox/drawings", data={"x": "1"}, headers=a)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


# --- размер, квота, лимит загрузок ---


def _small_app(tmp_path, **over):
    return build_app(make_settings(tmp_path, **over))


def _login_in(c: TestClient, app, phone: str) -> dict:
    sender = app.state.test_sender
    c.post("/auth/request-code", json={"phone": phone, "channel": "sms"})
    return bearer(c.post("/auth/verify-code", json={"phone": phone, "code": sender.sent[-1][1]}).json())


def test_too_large_rejected(tmp_path):
    app = _small_app(tmp_path, inbox_max_bytes=20_000)
    with TestClient(app) as c:
        h = _login_in(c, app, A)
        # чуть больше лимита: Content-Length в пределах запаса на multipart — отсев при чтении в ручке
        big = package(salt=os.urandom(25_000))  # несжимаемые байты
        assert len(big) > 20_000
        r = upload(c, h, big)
        assert r.status_code == 413 and r.json()["error"]["code"] == "file_too_large"
        # намного больше: по Content-Length, до разбора тела
        r = upload(c, h, b"0" * (20_000 + 1024 * 1024 + 10))
        assert r.status_code == 413 and r.json()["error"]["code"] == "file_too_large"
        assert "МБ" in r.json()["error"]["message"]
        with app.state.db.sessionmaker() as s:
            assert s.scalar(select(func.count(InboxDrawing.id))) == 0
    app.state.db.engine.dispose()


def test_body_limit_streaming_without_content_length():
    from mebel_api.services.uploads import BodySizeLimit

    reached = {"app": False}

    async def downstream(scope, receive, send):
        reached["app"] = True
        while True:
            try:
                msg = await receive()
            except Exception:
                await send({"type": "http.response.start", "status": 400, "headers": []})
                await send({"type": "http.response.body", "body": b"parse error"})
                raise
            if not msg.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 201, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = BodySizeLimit(downstream, {"/inbox/drawings": 1000}, message="Файл больше 1 КБ")
    chunks = [b"x" * 400] * 5

    async def run(path: str):
        sent, it = [], iter(chunks)

        async def receive():
            c = next(it, None)
            return {"type": "http.request", "body": c or b"", "more_body": c is not None}

        async def send(msg):
            sent.append(msg)

        await mw({"type": "http", "method": "POST", "path": path, "headers": []}, receive, send)
        return sent

    sent = asyncio.run(run("/inbox/drawings"))
    assert reached["app"] and sent[0]["status"] == 413 and len(sent) == 2
    assert json.loads(sent[1]["body"])["error"]["code"] == "file_too_large"
    sent = asyncio.run(run("/projects"))  # другие пути не ограничиваются
    assert sent[0]["status"] == 201


def test_quota_and_daily_limit(tmp_path):
    one = len(package())
    app = _small_app(tmp_path, inbox_quota_bytes=int(one * 2.5), inbox_uploads_per_day=3)
    with TestClient(app) as c:
        h = _login_in(c, app, A)
        ids = [upload(c, h, package(salt=bytes([i]))).json()["id"] for i in range(2)]
        r = upload(c, h, package(salt=b"\x09"))
        assert r.status_code == 409 and r.json()["error"]["code"] == "inbox_quota_exceeded"
        assert r.json()["error"]["details"]["limit"] == int(one * 2.5)
        # удалил — место освободилось, но дневной лимит считает и удалённые
        assert c.delete(f"/inbox/drawings/{ids[0]}", headers=h).status_code == 200
        assert upload(c, h, package(salt=b"\x09")).status_code == 201
        assert c.delete(f"/inbox/drawings/{ids[1]}", headers=h).status_code == 200
        r = upload(c, h, package(salt=b"\x0a"))
        assert r.status_code == 429 and r.json()["error"]["code"] == "upload_limit"
        # у другого пользователя — свои лимиты
        hb = _login_in(c, app, B)
        assert upload(c, hb, package(salt=b"\x0a")).status_code == 201
    app.state.db.engine.dispose()


# --- изоляция между аккаунтами ---


def test_isolation_between_users_even_with_same_bytes(client, a, b, db, settings):
    data = package()
    da = upload(client, a, data).json()
    assert client.get("/inbox/drawings", headers=b).json() == {"items": [], "total": 0, "limit": 50, "offset": 0}
    for m in ("GET", "DELETE"):
        r = client.request(m, f"/inbox/drawings/{da['id']}", headers=b)
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert client.get(f"/inbox/drawings/{uuid.uuid4()}", headers=a).status_code == 404

    r = upload(client, b, data)  # те же байты у другого пользователя — своя строка, а не чужая
    assert r.status_code == 201
    db_ = r.json()
    assert db_["id"] != da["id"]
    assert [i["id"] for i in client.get("/inbox/drawings", headers=b).json()["items"]] == [db_["id"]]
    assert [i["id"] for i in client.get("/inbox/drawings", headers=a).json()["items"]] == [da["id"]]
    ra, rb = db.get(InboxDrawing, uuid.UUID(da["id"])), db.get(InboxDrawing, uuid.UUID(db_["id"]))
    assert ra.storage_key == rb.storage_key  # общий файл — только кэш хранилища
    blob = settings.media_dir / ra.storage_key

    assert client.delete(f"/inbox/drawings/{da['id']}", headers=a).status_code == 200
    assert client.get(f"/inbox/drawings/{da['id']}", headers=a).status_code == 404
    assert blob.exists()  # файл ещё нужен B
    full_b = client.get(f"/inbox/drawings/{db_['id']}", headers=b).json()
    assert client.get(full_b["download_url"]).content == data
    assert client.delete(f"/inbox/drawings/{db_['id']}", headers=b).status_code == 200
    assert not blob.exists()
    assert client.get(full_b["download_url"]).status_code == 404


# --- срок хранения и подписанные ссылки ---


def test_open_extends_expiry_and_expired_is_gone(client, a, db):
    d = upload(client, a, package()).json()
    row = db.get(InboxDrawing, uuid.UUID(d["id"]))
    row.expires_at = utcnow() + timedelta(days=3)
    db.commit()
    r = client.get(f"/inbox/drawings/{d['id']}", headers=a).json()
    db.expire_all()
    row = db.get(InboxDrawing, uuid.UUID(d["id"]))
    assert row.last_opened_at is not None and r["last_opened_at"] is not None
    assert row.expires_at > utcnow() + timedelta(days=89)
    row.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    assert client.get(f"/inbox/drawings/{d['id']}", headers=a).status_code == 404
    assert client.get("/inbox/drawings", headers=a).json()["total"] == 0


def test_signed_urls_expire(client, a, monkeypatch):
    d = upload(client, a, package()).json()
    full = client.get(f"/inbox/drawings/{d['id']}", headers=a).json()
    later = utcnow() + timedelta(minutes=31)
    monkeypatch.setattr(signed_files, "utcnow", lambda: later)
    r = client.get(full["download_url"])
    assert r.status_code == 410 and r.json()["error"]["code"] == "link_expired"
    assert client.get(full["preview_url"]).status_code == 200  # превью живёт час
    later2 = utcnow() + timedelta(hours=1, minutes=1)
    monkeypatch.setattr(signed_files, "utcnow", lambda: later2)
    assert client.get(full["preview_url"]).status_code == 410
    assert client.get(full["download_url"][:-4] + "AAAA").status_code in (404, 410)


def test_list_pagination_newest_first(client, a, db):
    ids = [upload(client, a, package(salt=bytes([i]))).json()["id"] for i in range(3)]
    for i, did in enumerate(ids):  # явные времена — порядок не зависит от разрешения часов
        db.get(InboxDrawing, uuid.UUID(did)).created_at = utcnow() - timedelta(minutes=10 - i)
    db.commit()
    p1 = client.get("/inbox/drawings?limit=2", headers=a).json()
    p2 = client.get("/inbox/drawings?limit=2&offset=2", headers=a).json()
    assert p1["total"] == 3 and [i["id"] for i in p1["items"] + p2["items"]] == ids[::-1]


# --- чистка ---


def test_prune_respects_shared_blobs(client, a, b, db, app, settings):
    shared = package()
    da = upload(client, a, shared).json()
    db_ = upload(client, b, shared).json()
    dc = upload(client, a, package(salt=b"own")).json()
    dd = upload(client, a, package(salt=b"deleted")).json()
    rows = {k: db.get(InboxDrawing, uuid.UUID(v["id"])) for k, v in {"a": da, "b": db_, "c": dc, "d": dd}.items()}
    files = {k: settings.media_dir / r.storage_key for k, r in rows.items()}
    previews = {k: settings.media_dir / r.preview_key for k, r in rows.items()}
    now = utcnow()
    rows["a"].expires_at = now - timedelta(days=1)  # истёк у A, у B тот же файл живой
    rows["c"].expires_at = now - timedelta(days=1)
    db.commit()
    client.delete(f"/inbox/drawings/{dd['id']}", headers=a)
    assert not files["d"].exists()  # удаление сразу убирает неделимый файл

    stats = inbox_service.prune(db, app.state.storage)
    assert stats["rows_deleted"] == 2  # истёкшие; удалённый сегодня — остаётся до суток (лимит загрузок)
    db.expire_all()
    assert db.get(InboxDrawing, uuid.UUID(da["id"])) is None and db.get(InboxDrawing, uuid.UUID(dc["id"])) is None
    assert db.get(InboxDrawing, uuid.UUID(dd["id"])) is not None
    assert files["b"].exists() and previews["b"].exists()  # общий с живой строкой B
    assert not files["c"].exists() and not previews["c"].exists()
    full_b = client.get(f"/inbox/drawings/{db_['id']}", headers=b).json()
    assert client.get(full_b["download_url"]).content == shared

    # через сутки удалённая строка уходит из базы
    stats = inbox_service.prune(db, app.state.storage, now=utcnow() + timedelta(days=2))
    db.expire_all()
    assert db.get(InboxDrawing, uuid.UUID(dd["id"])) is None
    assert db.get(InboxDrawing, uuid.UUID(db_["id"])) is not None  # открыт сегодня — живёт 90 дней
    stats = inbox_service.prune(db, app.state.storage, now=utcnow() + timedelta(days=91))
    assert not files["b"].exists() and db.scalar(select(func.count(InboxDrawing.id))) == 0


def test_prune_script_runs(tmp_path, monkeypatch):
    """scripts/prune_inbox.py: настройки из окружения, печатает счётчики."""
    import runpy
    import sys
    from pathlib import Path

    app = _small_app(tmp_path, database_url=f"sqlite:///{tmp_path / 'p.db'}")
    app.state.db.engine.dispose()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'p.db'}")
    monkeypatch.setenv("MEDIA_DIR", str(tmp_path / "media"))
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setattr(sys, "argv", ["prune_inbox.py"])
    script = Path(__file__).resolve().parents[1] / "scripts" / "prune_inbox.py"
    runpy.run_path(str(script), run_name="__main__")


def test_account_deletion_purges_inbox(api, client, a, b, db, settings):
    shared = package()
    upload(client, b, shared)
    da = upload(client, a, shared).json()
    own = upload(client, a, package(salt=b"own")).json()
    keys = {k: db.get(InboxDrawing, uuid.UUID(v["id"])).storage_key for k, v in {"s": da, "o": own}.items()}
    h = api.login(A)
    client.post("/auth/delete-account/request-code", json={"channel": "sms"}, headers=h)
    r = client.post("/auth/delete-account", json={"code": api.sender.sent[-1][1]}, headers=h)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.scalar(select(func.count(InboxDrawing.id))) == 1  # осталась только строка B
    assert not (settings.media_dir / keys["o"]).exists()
    assert (settings.media_dir / keys["s"]).exists()


# --- request-code по SMS для новых номеров (без изменений поведения) ---


def test_request_code_sms_for_unknown_number(api, client, db):
    r = client.post("/auth/request-code", json={"phone": "+998 97 777 00 01", "channel": "sms"})
    assert r.status_code == 200
    assert r.json()["channel"] == "sms" and r.json()["phone"] == "+998977770001"
    assert api.sender.sent[-1][0] == "+998977770001"
    assert db.scalar(select(func.count(User.id))) == 0


def test_dwg_scope_never_creates_account(api, client, db):
    """scope=dwg_upload с create=true (по умолчанию) всё равно не регистрирует новый номер."""
    before = counts(db)
    phone = "+998901112299"
    r = client.post("/auth/verify-code", json={"phone": phone, "code": code_for(api, client, phone), "scope": "dwg_upload"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "account_not_found"
    assert counts(db) == before
