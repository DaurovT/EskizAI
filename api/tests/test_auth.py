from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from mebel_api.models import AuthCode, Device, User

from .conftest import build_app, make_settings

PHONE = "+998901234567"


def test_full_login_flow_creates_owner_and_workshop(api, client):
    r = client.post("/auth/request-code", json={"phone": "90 123-45-67", "channel": "telegram"})
    assert r.status_code == 200
    assert r.json()["phone"] == PHONE
    code = api.sender.sent[-1][1]
    assert len(code) == 5

    r = client.post(
        "/auth/verify-code",
        json={"phone": PHONE, "code": code, "device_id": "dev-1", "platform": "android"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["is_new_user"] is True
    assert body["user"]["role"] == "owner"
    h = {"Authorization": f"Bearer {body['access_token']}"}

    me = client.get("/auth/me", headers=h).json()
    assert me["phone"] == PHONE
    ws = client.get("/workshops/me", headers=h).json()
    assert ws["id"] == me["workshop_id"]
    assert ws["pricing"]["labor_percent"] == 50  # значения по умолчанию из PRD
    assert ws["employee_estimate_views"] == ["total"]


def test_one_account_per_phone(api, client, db):
    api.login(PHONE)
    r = client.post("/auth/request-code", json={"phone": PHONE})
    r = client.post("/auth/verify-code", json={"phone": PHONE, "code": api.sender.sent[-1][1]})
    assert r.json()["is_new_user"] is False
    assert len(db.scalars(select(User).where(User.phone == PHONE)).all()) == 1


def test_code_is_single_use_and_wrong_code_counts_attempts(api, client):
    client.post("/auth/request-code", json={"phone": PHONE})
    code = api.sender.sent[-1][1]
    wrong = "9999" if code != "9999" else "8888"
    r = client.post("/auth/verify-code", json={"phone": PHONE, "code": wrong})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "code_invalid"
    assert "Неверный код" in r.json()["error"]["message"]
    assert client.post("/auth/verify-code", json={"phone": PHONE, "code": code}).status_code == 200
    r = client.post("/auth/verify-code", json={"phone": PHONE, "code": code})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "code_expired"


def test_too_many_wrong_attempts_blocks_code(api, client, settings):
    client.post("/auth/request-code", json={"phone": PHONE})
    code = api.sender.sent[-1][1]
    wrong = "9999" if code != "9999" else "8888"
    for _ in range(settings.auth_code_max_attempts):
        client.post("/auth/verify-code", json={"phone": PHONE, "code": wrong})
    r = client.post("/auth/verify-code", json={"phone": PHONE, "code": code})
    assert r.status_code == 429


def test_expired_code_rejected(api, client, db):
    client.post("/auth/request-code", json={"phone": PHONE})
    code = api.sender.sent[-1][1]
    entry = db.scalar(select(AuthCode))
    entry.expires_at = entry.expires_at - timedelta(hours=1)
    db.commit()
    r = client.post("/auth/verify-code", json={"phone": PHONE, "code": code})
    assert r.status_code == 400
    assert "устарел" in r.json()["error"]["message"]


def test_resend_cooldown(tmp_path):
    app = build_app(make_settings(tmp_path, auth_code_resend_seconds=60))
    with TestClient(app) as c:
        assert c.post("/auth/request-code", json={"phone": PHONE}).status_code == 200
        r = c.post("/auth/request-code", json={"phone": PHONE})
        assert r.status_code == 429
        assert "через" in r.json()["error"]["message"]


def test_invalid_phone_message_in_russian(client):
    r = client.post("/auth/request-code", json={"phone": "12345"})
    assert r.status_code == 422
    assert r.json()["error"]["message"].startswith("Введите номер телефона")


def test_refresh_rotates_and_old_token_is_rejected(api, client):
    client.post("/auth/request-code", json={"phone": PHONE})
    tokens = client.post("/auth/verify-code", json={"phone": PHONE, "code": api.sender.sent[-1][1]}).json()
    r = client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 200
    new = r.json()
    assert new["refresh_token"] != tokens["refresh_token"]
    assert client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).status_code == 401
    # access-токен нельзя использовать как refresh
    assert client.post("/auth/refresh", json={"refresh_token": new["access_token"]}).status_code == 401
    assert client.post("/auth/logout", json={"refresh_token": new["refresh_token"]}).status_code == 200
    assert client.post("/auth/refresh", json={"refresh_token": new["refresh_token"]}).status_code == 401


def test_endpoints_require_token(client):
    r = client.get("/projects")
    assert r.status_code == 401
    assert r.json()["error"]["message"] == "Нужно войти по номеру телефона"
    r = client.get("/projects", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401


def test_dev_code_only_in_dev(tmp_path, client):
    # В тестовом окружении код разработки не принимается
    r = client.post("/auth/verify-code", json={"phone": PHONE, "code": "00000"})
    assert r.status_code == 400
    client.close()
    dev_app = build_app(make_settings(tmp_path, env="dev"))
    with TestClient(dev_app) as c:
        r = c.post("/auth/verify-code", json={"phone": PHONE, "code": "00000"})
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "owner"


def test_device_is_registered(api, client, db):
    client.post("/auth/request-code", json={"phone": PHONE})
    client.post(
        "/auth/verify-code",
        json={"phone": PHONE, "code": api.sender.sent[-1][1], "device_id": "abc", "push_token": "expo-1"},
    )
    device = db.scalar(select(Device))
    assert device.device_id == "abc" and device.push_token == "expo-1"


def test_employee_added_by_owner_logs_into_same_workshop(api, client, owner):
    emp = api.employee(owner, "+998935550000", "Замерщик")
    me = client.get("/auth/me", headers=emp).json()
    assert me["role"] == "employee"
    assert me["workshop_id"] == client.get("/auth/me", headers=owner).json()["workshop_id"]
    # Занятый номер второй раз добавить нельзя
    r = client.post("/workshops/me/employees", json={"phone": "+998935550000"}, headers=owner)
    assert r.status_code == 409
    # Отключённый сотрудник теряет доступ и не может войти
    client.delete(f"/workshops/me/employees/{me['id']}", headers=owner)
    assert client.get("/auth/me", headers=emp).status_code == 401
    client.post("/auth/request-code", json={"phone": "+998935550000"})
    r = client.post("/auth/verify-code", json={"phone": "+998935550000", "code": api.sender.sent[-1][1]})
    assert r.status_code == 403


def test_providers_are_stubs_outside_dev(tmp_path):
    app = build_app(make_settings(tmp_path, auth_code_provider="eskiz"))
    with TestClient(app) as c:
        r = c.post("/auth/request-code", json={"phone": PHONE, "channel": "sms"})
        assert r.status_code == 503
        assert "SMS" in r.json()["error"]["message"]
