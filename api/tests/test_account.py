"""Удаление аккаунта (SCR-44): код подтверждения, что стирается и что остаётся."""

import uuid

from sqlalchemy import func, select

from mebel_api.models import (
    ActionLog,
    AuthCode,
    Client,
    Device,
    Measurement,
    ModelVersion,
    Order,
    Project,
    ProjectPhoto,
    RefreshToken,
    ShareLink,
    User,
    Workshop,
)

from .conftest import ADMIN

PHONE = "+998901234567"
EMP = "+998935550000"
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 100


def delete_code(api, client, h) -> str:
    r = client.post("/auth/delete-account/request-code", json={"channel": "sms"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["phone"] == PHONE or r.json()["phone"].startswith("+998")
    assert r.json()["code_length"] == 5
    return api.sender.sent[-1][1]


def count(db, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def test_delete_requires_auth_and_delete_purpose_code(api, client, owner):
    assert client.post("/auth/delete-account/request-code").status_code == 401
    assert client.post("/auth/delete-account", json={"code": "1234"}).status_code == 401
    # код входа для удаления не подходит
    client.post("/auth/request-code", json={"phone": PHONE, "channel": "sms"})
    login_code = api.sender.sent[-1][1]
    r = client.post("/auth/delete-account", json={"code": login_code}, headers=owner)
    assert r.status_code == 400 and r.json()["error"]["code"] == "code_expired"
    # и код удаления не годится для входа (кода входа уже нет — он один и тот же запрос выше)
    code = delete_code(api, client, owner)
    wrong = "00000" if code != "00000" else "11111"
    r = client.post("/auth/delete-account", json={"code": wrong}, headers=owner)
    assert r.status_code == 400 and r.json()["error"]["code"] == "code_invalid"
    assert client.get("/auth/me", headers=owner).status_code == 200  # ничего не удалено


def test_delete_code_cannot_be_used_to_login(api, client, owner):
    code = delete_code(api, client, owner)
    r = client.post("/auth/verify-code", json={"phone": PHONE, "code": code})
    assert r.status_code == 400 and r.json()["error"]["code"] == "code_expired"


def test_delete_code_resend_pause_is_separate_from_login(tmp_path):
    from fastapi.testclient import TestClient

    from .conftest import Api, build_app, make_settings

    app = build_app(make_settings(tmp_path, auth_code_resend_seconds=60))
    with TestClient(app) as c:
        api = Api(c, app.state.test_sender)
        h = api.login(PHONE)
        assert c.post("/auth/delete-account/request-code", headers=h).status_code == 200  # пауза входа не мешает
        r = c.post("/auth/delete-account/request-code", headers=h)
        assert r.status_code == 429 and r.json()["error"]["code"] == "code_too_often"
    app.state.db.engine.dispose()


def test_owner_deletes_whole_workshop(api, client, owner, db, settings):
    emp = api.employee(owner, EMP, "Бахтиёр")
    ws_id = client.get("/auth/me", headers=owner).json()["workshop_id"]
    c = client.post("/clients", json={"name": "Азиза", "phone": "+998901112233", "address": "Юнусабад"},
                    headers=owner).json()
    # проект с фото, замером, ссылкой клиента и оплаченным заказом EMAN
    pid = api.project(owner, title="Шкаф для Азизы", client_id=c["id"])
    photo = client.post(f"/projects/{pid}/photos", files={"file": ("a.jpg", JPEG, "image/jpeg")}, headers=owner).json()
    stored = settings.media_dir / photo["url"].removeprefix("/media/")
    assert stored.exists()
    api.advance(owner, pid, "in_work")
    token = client.get(f"/projects/{pid}/share-links", headers=owner).json()[0]["token"]
    order = db.scalar(select(Order).where(Order.project_id == uuid.UUID(pid)))
    order_total, order_status = order.estimate_total, order.status
    # второй проект без заказа (сотрудника)
    pid2 = api.project(emp, title="Тумба")
    client.post("/auth/request-code", json={"phone": PHONE, "channel": "sms"})  # код входа — должен исчезнуть

    code = delete_code(api, client, owner)
    r = client.post("/auth/delete-account", json={"code": code}, headers=owner)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "scope": "workshop"}
    db.expire_all()

    # доступ закрыт всем сотрудникам цеха
    assert client.get("/auth/me", headers=owner).status_code == 401
    assert client.get("/auth/me", headers=emp).status_code == 401
    users = db.scalars(select(User).where(User.workshop_id == uuid.UUID(ws_id))).all()
    assert len(users) == 2
    for u in users:
        assert u.phone.startswith("del:") and u.name == "" and not u.is_active and u.deleted_at is not None
        assert count(db, RefreshToken, RefreshToken.user_id == u.id) == 0
        assert count(db, Device, Device.user_id == u.id) == 0
    assert count(db, AuthCode, AuthCode.phone.in_([PHONE, EMP])) == 0
    # цех стёрт, но строка осталась ради заказов
    w = db.get(Workshop, uuid.UUID(ws_id))
    assert w.deleted_at is not None and w.blocked and w.phone is None and w.name == "Удалённый цех"
    # клиенты, фото, замеры — удалены; файл фото удалён из хранилища
    assert count(db, Client, Client.workshop_id == w.id) == 0
    assert count(db, ProjectPhoto, ProjectPhoto.project_id == uuid.UUID(pid)) == 0
    assert count(db, Measurement, Measurement.project_id == uuid.UUID(pid)) == 0
    assert not stored.exists()
    # проекты и версии — пустые оболочки
    for p_id in (pid, pid2):
        p = db.get(Project, uuid.UUID(p_id))
        assert p.title == "Удалённый проект" and p.deleted_at is not None and p.client_id is None
        assert p.current_version_id is None
        for v in db.scalars(select(ModelVersion).where(ModelVersion.project_id == p.id)):
            assert v.tree == {} and v.viewer == {} and v.price_cache is None
    # ссылка клиента: «отозвана»
    link = db.scalar(select(ShareLink).where(ShareLink.token == token))
    assert link.revoked_at is not None and link.price_snapshot is None
    r = client.get(f"/share/{token}")
    assert r.status_code == 410 and r.json()["error"]["code"] == "share_revoked"
    assert client.get(f"/share/{token}/glb/closed").status_code == 410
    # заказ EMAN остался: сумма и статус для учёта
    order = db.scalar(select(Order).where(Order.project_id == uuid.UUID(pid)))
    assert order.estimate_total == order_total and order.status == order_status and order.notes is None
    r = client.get("/admin/orders", headers=ADMIN)
    assert r.status_code == 200
    # в журнале — запись об удалении, без личных данных
    entry = db.scalar(select(ActionLog).where(ActionLog.action == "delete_workshop"))
    assert entry is not None and entry.workshop_id == w.id
    assert entry.after["projects"] == 2 and entry.after["orders_kept"] == 1 and entry.after["clients"] == 1
    for e in db.scalars(select(ActionLog).where(ActionLog.workshop_id == w.id)):
        assert PHONE not in str(e.before) + str(e.after) and EMP not in str(e.before) + str(e.after)
        assert e.entity_id is None or not e.entity_id.startswith("+")

    # тот же номер — новый аккаунт с нуля
    client.post("/auth/request-code", json={"phone": PHONE, "channel": "sms"})
    r = client.post("/auth/verify-code", json={"phone": PHONE, "code": api.sender.sent[-1][1]})
    assert r.status_code == 200 and r.json()["is_new_user"] is True
    assert r.json()["user"]["workshop_id"] != ws_id


def test_employee_deletes_only_own_account(api, client, owner, db):
    emp = api.employee(owner, EMP, "Бахтиёр")
    emp_id = client.get("/auth/me", headers=emp).json()["id"]
    pid = api.project(emp, title="Шкаф")
    api.advance(emp, pid, "sent")
    token = client.get(f"/projects/{pid}/share-links", headers=emp).json()[0]["token"]

    code = delete_code(api, client, emp)
    r = client.post("/auth/delete-account", json={"code": code}, headers=emp)
    assert r.status_code == 200 and r.json()["scope"] == "user"

    assert client.get("/auth/me", headers=emp).status_code == 401
    assert client.get("/auth/me", headers=owner).status_code == 200
    emps = client.get("/workshops/me/employees", headers=owner).json()
    assert [e["phone"] for e in emps] == [PHONE]
    assert client.get(f"/projects/{pid}", headers=owner).status_code == 200  # проект остаётся цеху
    page = client.get(f"/share/{token}").json()  # ссылка работает, без данных удалённого сотрудника
    assert not page["master"]["phone"].startswith("del:") and page["master"]["name"] != ""
    u = db.get(User, uuid.UUID(emp_id))
    assert u.phone.startswith("del:") and u.deleted_at is not None
    assert db.scalar(select(ActionLog).where(ActionLog.action == "delete_user")) is not None
    # номер свободен: можно войти заново (свой новый цех)
    client.post("/auth/request-code", json={"phone": EMP, "channel": "sms"})
    r = client.post("/auth/verify-code", json={"phone": EMP, "code": api.sender.sent[-1][1]})
    assert r.status_code == 200 and r.json()["is_new_user"] and r.json()["user"]["role"] == "owner"


def test_deleted_owner_refresh_token_is_dead(api, client):
    client.post("/auth/request-code", json={"phone": PHONE, "channel": "sms"})
    tk = client.post("/auth/verify-code", json={"phone": PHONE, "code": api.sender.sent[-1][1]}).json()
    h = {"Authorization": f"Bearer {tk['access_token']}"}
    code = delete_code(api, client, h)
    assert client.post("/auth/delete-account", json={"code": code}, headers=h).status_code == 200
    assert client.post("/auth/refresh", json={"refresh_token": tk["refresh_token"]}).status_code == 401


def test_shared_photo_key_deleted_once(api, client, owner, db, settings):
    """Фото с нескольких объектов — один файл на несколько проектов цеха: удаляется один раз, без ошибок."""
    pid = api.project(owner)
    pid2 = api.project(owner, title="Второй объект")
    photo = client.post(f"/projects/{pid}/photos", files={"file": ("a.jpg", JPEG, "image/jpeg")}, headers=owner).json()
    row = db.get(ProjectPhoto, uuid.UUID(photo["id"]))
    db.add(ProjectPhoto(project_id=uuid.UUID(pid2), kind="source", storage_key=row.storage_key, url=row.url,
                        content_type=row.content_type, size_bytes=row.size_bytes))
    db.commit()
    stored = settings.media_dir / row.storage_key
    assert stored.exists()
    code = delete_code(api, client, owner)
    assert client.post("/auth/delete-account", json={"code": code}, headers=owner).status_code == 200
    assert not stored.exists()
    db.expire_all()
    assert count(db, ProjectPhoto, ProjectPhoto.project_id.in_([uuid.UUID(pid), uuid.UUID(pid2)])) == 0
