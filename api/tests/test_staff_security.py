"""Вход сотрудников под нагрузкой и атаками: параллельные попытки (блокировка не обходится), блокировка по паре
«почта + IP» и лимит на IP, одноразовый mfa_token, атомарное списание кодов 2FA, ротация refresh без «форков»
и с обнаружением повтора, ограничения старого X-Admin-Token, правила владельца поставщика (§3, §8)."""

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from mebel_api.config import Settings
from mebel_api.db import utcnow
from mebel_api.models import ActionLog, AuthThrottle, StaffMfa, StaffSession, StaffUser
from mebel_api.routers import staff as staff_router
from mebel_api.services import staff_auth as sa

from .conftest import ADMIN, build_app, make_settings
from .staff_helpers import PASSWORD, h, login, make_staff, make_supplier, next_code, staff, superadmin

LOGIN = "/staff/auth/login"


@pytest.fixture
def file_app(tmp_path):
    """Файловая SQLite (или Postgres из TEST_DATABASE_URL): у каждого потока своё соединение — настоящая
    конкуренция запросов (in-memory SQLite в тестах — одно общее соединение)."""

    def make(**overrides):
        url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / 'race.db'}"
        app = build_app(make_settings(tmp_path, database_url=url, **overrides))
        apps.append(app)
        return app

    apps: list = []
    yield make
    for a in apps:
        a.state.db.engine.dispose()


def _slow(monkeypatch, name: str, delay: float = 0.15) -> list:
    """Медленная проверка пароля/кода: окно гонки шире, и видно, сколько раз проверка реально выполнялась."""
    calls: list = []
    real = getattr(sa, name)
    lock = threading.Lock()

    def wrapped(*args, **kwargs):
        with lock:
            calls.append(1)
        time.sleep(delay)
        return real(*args, **kwargs)

    monkeypatch.setattr(sa, name, wrapped)
    return calls


def _parallel(fn, n: int) -> list:
    with ThreadPoolExecutor(n) as ex:
        return list(ex.map(fn, range(n)))


# --- H1: блокировка не обходится параллельными запросами ---


def test_parallel_wrong_passwords_cannot_bypass_lockout(file_app, monkeypatch):
    app = file_app(staff_login_ip_limit=1000)
    make_staff(app, "victim@eskizai.uz", "support")
    calls = _slow(monkeypatch, "verify_password")
    with TestClient(app) as c:
        def wrong(i):
            return c.post(LOGIN, json={"email": "victim@eskizai.uz", "password": f"wrong-pass-{i:04d}"}).status_code

        with ThreadPoolExecutor(40) as ex:
            futures = [ex.submit(wrong, i) for i in range(39)]
            time.sleep(0.1)  # все 39 уже зарезервировали попытку, проверка пароля ещё идёт
            right = ex.submit(lambda: c.post(LOGIN, json={"email": "victim@eskizai.uz", "password": PASSWORD}))
            statuses = [f.result() for f in futures]
            r = right.result()
    assert set(statuses) == {401}
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    assert len(calls) <= 5  # проверено не больше 5 паролей; остальные отклонены до scrypt
    with app.state.db.sessionmaker() as s:
        row = s.scalar(select(AuthThrottle).where(AuthThrottle.key.startswith("acct:")))
        assert row.locked_until is not None and row.locked_until > utcnow()


def test_reserve_attempt_is_atomic_sql(app):
    """Счётчик — один UPSERT … RETURNING: N вызовов → номера 1…N, блокировка ставится на N == limit."""
    with app.state.db.sessionmaker() as s:
        got = [sa.reserve_attempt(s, "acct:test", limit=3, lock_seconds=60) for _ in range(5)]
        assert got == [1, 2, 3, 4, 5]
        row = s.get(AuthThrottle, "acct:test")
        assert row.locked_until is not None
        # блокировка истекла → счёт с начала
        row.locked_until = utcnow() - timedelta(seconds=1)
        s.commit()
        assert sa.reserve_attempt(s, "acct:test", limit=3, lock_seconds=60) == 1
        assert s.get(AuthThrottle, "acct:test", populate_existing=True).locked_until is None


def test_lockout_is_per_email_and_ip_and_ignores_forwarded_for(app, client):
    make_staff(app, "boss@eskizai.uz", "support")
    attacker = TestClient(app, client=("203.0.113.7", 40000))
    for i in range(6):  # подделанный X-Forwarded-For не помогает обойти блокировку
        r = attacker.post(LOGIN, json={"email": "boss@eskizai.uz", "password": f"bad-pass-{i}"},
                          headers={"X-Forwarded-For": f"198.51.100.{i}"})
        assert r.status_code == 401
    assert attacker.post(LOGIN, json={"email": "boss@eskizai.uz", "password": PASSWORD}).status_code == 401
    # владелец с другого адреса входит
    owner = TestClient(app, client=("192.0.2.10", 50000))
    r = owner.post(LOGIN, json={"email": "boss@eskizai.uz", "password": PASSWORD},
                   headers={"X-Forwarded-For": "203.0.113.7"})
    assert r.status_code == 200
    me = owner.get("/staff/me/sessions", headers={"Authorization": f"Bearer {r.json()['access_token']}"}).json()
    assert me[0]["ip"] == "192.0.2.10"  # IP сессии — адрес соединения (после --proxy-headers), не заголовок
    with app.state.db.sessionmaker() as s:
        uid = s.scalar(select(StaffUser.id).where(StaffUser.email == "boss@eskizai.uz"))
        assert sa.staff_locked(s, uid)  # в карточке видно: вход закрыт (с одного адреса)
    # сброс пароля снимает блокировки
    root = superadmin(app, client)
    assert client.get("/staff/users?q=boss", headers=root).json()["items"][0]["locked"] is True
    temp = client.post(f"/staff/users/{uid}/reset-password", headers=root).json()["temp_password"]
    assert attacker.post(LOGIN, json={"email": "boss@eskizai.uz", "password": temp}).status_code == 200


def test_ip_throttle_counts_failures_only_and_answers_429(tmp_path):
    app = build_app(make_settings(tmp_path, staff_login_ip_limit=3))
    make_staff(app, "ok@eskizai.uz", "support")
    with TestClient(app) as c:
        for _ in range(4):  # удачные входы лимит не тратят
            assert c.post(LOGIN, json={"email": "ok@eskizai.uz", "password": PASSWORD}).status_code == 200
        for i in range(3):
            assert c.post(LOGIN, json={"email": f"nobody{i}@x.uz", "password": "whatever-123"}).status_code == 401
        r = c.post(LOGIN, json={"email": "ok@eskizai.uz", "password": PASSWORD})
        assert r.status_code == 429 and r.json()["error"]["code"] == "too_many_attempts"
        other = TestClient(app, client=("192.0.2.55", 1))
        assert other.post(LOGIN, json={"email": "ok@eskizai.uz", "password": PASSWORD}).status_code == 200
    with app.state.db.sessionmaker() as s:
        entries = list(s.scalars(select(ActionLog).where(ActionLog.entity == "staff_auth")))
        assert sum(e.action == "login_throttled" for e in entries) == 1
        anon = [e for e in entries if e.action == "login_failed"]
        assert len(anon) == 3
        for e in anon:  # неизвестная почта — только отпечаток
            assert "email" not in e.after and len(e.after["email_hash"]) == 16 and "nobody" not in str(e.after)
    app.state.db.engine.dispose()


def test_anonymous_failed_login_log_is_capped(app, client, monkeypatch):
    monkeypatch.setattr(staff_router, "ANON_LOG_PER_HOUR", 2)
    for i in range(4):
        client.post(LOGIN, json={"email": f"ghost{i}@x.uz", "password": "whatever-123"})
    with app.state.db.sessionmaker() as s:
        n = len(list(s.scalars(select(ActionLog).where(ActionLog.action == "login_failed"))))
    assert n == 2


# --- H1 / L4: второй шаг ---


def test_parallel_mfa_codes_cannot_bypass_lockout(file_app, monkeypatch):
    app = file_app(staff_login_ip_limit=1000)
    secret = sa.new_totp_secret()
    make_staff(app, "root@eskizai.uz", "superadmin", mfa_secret=secret)
    with TestClient(app) as c:
        mt = c.post(LOGIN, json={"email": "root@eskizai.uz", "password": PASSWORD}).json()["mfa_token"]
        calls = _slow(monkeypatch, "verify_totp")
        good = next_code(secret)

        def wrong(i):
            code = f"{(int(good) + 1 + i) % 1_000_000:06d}"
            return c.post("/staff/auth/mfa", json={"mfa_token": mt, "code": code}).status_code

        with ThreadPoolExecutor(30) as ex:
            futures = [ex.submit(wrong, i) for i in range(29)]
            time.sleep(0.1)
            right = ex.submit(lambda: c.post("/staff/auth/mfa", json={"mfa_token": mt, "code": good}))
            statuses = [f.result() for f in futures]
            r = right.result()
    assert set(statuses) <= {401}
    assert r.status_code == 401
    assert len(calls) <= 5


def test_mfa_token_single_use_and_revoked_by_reset(app, client):
    root = superadmin(app, client)
    secret = sa.new_totp_secret()
    uid = make_staff(app, "sec@eskizai.uz", "support", mfa_secret=secret)
    mt = client.post(LOGIN, json={"email": "sec@eskizai.uz", "password": PASSWORD}).json()["mfa_token"]
    # неверный код не сжигает токен
    assert client.post("/staff/auth/mfa", json={"mfa_token": mt, "code": "000000"}).status_code == 401
    r = client.post("/staff/auth/mfa", json={"mfa_token": mt, "code": next_code(secret)})
    assert r.status_code == 200
    # тот же mfa_token второй раз — нет (даже с новым кодом)
    later = sa.totp_now(secret, time.time() + 2 * sa.TOTP_STEP)
    with app.state.db.sessionmaker() as s:
        s.get(StaffMfa, uuid.UUID(uid)).last_step = None
        s.commit()
    r = client.post("/staff/auth/mfa", json={"mfa_token": mt, "code": later})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    # выданный, но не использованный mfa_token гаснет при завершении сессий и при сбросе пароля
    mt2 = client.post(LOGIN, json={"email": "sec@eskizai.uz", "password": PASSWORD}).json()["mfa_token"]
    assert client.delete(f"/staff/users/{uid}/sessions", headers=root).status_code == 200
    assert client.post("/staff/auth/mfa", json={"mfa_token": mt2, "code": later}).status_code == 401
    mt3 = client.post(LOGIN, json={"email": "sec@eskizai.uz", "password": PASSWORD}).json()["mfa_token"]
    client.post(f"/staff/users/{uid}/reset-password", headers=root)
    assert client.post("/staff/auth/mfa", json={"mfa_token": mt3, "code": later}).status_code == 401


def test_totp_and_backup_code_consumed_atomically(app, client, db):
    """Устаревшее чтение (другой запрос уже списал код) не даёт пройти второй раз: списание — условный UPDATE."""
    secret = sa.new_totp_secret()
    uid = uuid.UUID(make_staff(app, "atom@eskizai.uz", "support", mfa_secret=secret))
    settings = app.state.settings
    code = sa.totp_now(secret)
    step = int(time.time() // sa.TOTP_STEP)
    staff_user = db.get(StaffUser, uid)
    stale = db.get(StaffMfa, uid)  # прочитано до того, как другой запрос списал код
    with app.state.db.sessionmaker() as other:
        other.get(StaffMfa, uid).last_step = step + 1
        other.commit()
    assert stale.last_step is None
    assert staff_router._check_second_factor(db, settings, staff_user, stale, code) is False
    db.rollback()
    # резервный код: два запроса с одним кодом — проходит один
    backup = "abcde-fghjk"
    with app.state.db.sessionmaker() as other:
        m = other.get(StaffMfa, uid)
        m.backup_codes = [sa.backup_code_hash(settings, backup), sa.backup_code_hash(settings, "zzzzz-yyyyy")]
        other.commit()
    db.expire_all()
    stale = db.get(StaffMfa, uid)
    with app.state.db.sessionmaker() as other:  # «параллельный» запрос списал тот же код раньше
        assert staff_router._check_second_factor(other, settings, other.get(StaffUser, uid), other.get(StaffMfa, uid),
                                                 backup)
        other.commit()
    assert staff_router._check_second_factor(db, settings, staff_user, stale, backup) is False
    db.rollback()
    assert len(db.get(StaffMfa, uid, populate_existing=True).backup_codes) == 1


def test_parallel_same_totp_code_logs_in_once(file_app):
    app = file_app(staff_login_ip_limit=1000)
    secret = sa.new_totp_secret()
    make_staff(app, "twice@eskizai.uz", "support", mfa_secret=secret)
    with TestClient(app) as c:
        tokens = [c.post(LOGIN, json={"email": "twice@eskizai.uz", "password": PASSWORD}).json()["mfa_token"]
                  for _ in range(6)]
        code = next_code(secret)
        res = _parallel(lambda i: c.post("/staff/auth/mfa", json={"mfa_token": tokens[i], "code": code}).status_code,
                        6)
    assert sorted(res).count(200) == 1


# --- M1: ротация refresh ---


def test_parallel_refresh_rotates_once(file_app):
    app = file_app()
    make_staff(app, "rot@eskizai.uz", "support")
    with TestClient(app) as c:
        rt = login(c, "rot@eskizai.uz")["_refresh"]
        res = _parallel(lambda _: c.post("/staff/auth/refresh", json={"refresh_token": rt}), 10)
        ok = [r for r in res if r.status_code == 200]
        assert len(ok) == 1 and {r.status_code for r in res} == {200, 401}
        # проигравшие в гонке (в пределах нескольких секунд) сессию не завершают — победитель работает
        new = ok[0].json()
        assert c.get("/staff/me", headers={"Authorization": f"Bearer {new['access_token']}"}).status_code == 200
        assert c.post("/staff/auth/refresh", json={"refresh_token": new["refresh_token"]}).status_code == 200
    with app.state.db.sessionmaker() as s:
        assert len(list(s.scalars(select(StaffSession)))) == 1


def test_refresh_reuse_revokes_whole_session(tmp_path):
    app = build_app(make_settings(tmp_path, staff_refresh_reuse_grace_seconds=0))
    make_staff(app, "reuse@eskizai.uz", "support")
    with TestClient(app) as c:
        old = login(c, "reuse@eskizai.uz")["_refresh"]
        new = c.post("/staff/auth/refresh", json={"refresh_token": old}).json()
        time.sleep(0.01)
        r = c.post("/staff/auth/refresh", json={"refresh_token": old})  # украденный старый refresh
        assert r.status_code == 401 and r.json()["error"]["code"] == "token_revoked"
        assert c.post("/staff/auth/refresh", json={"refresh_token": new["refresh_token"]}).status_code == 401
        assert c.get("/staff/me", headers={"Authorization": f"Bearer {new['access_token']}"}).status_code == 401
    with app.state.db.sessionmaker() as s:
        assert s.scalar(select(ActionLog).where(ActionLog.action == "refresh_reuse")) is not None
    app.state.db.engine.dispose()


# --- 2FA: настройка без гонки ---


def test_mfa_setup_concurrent_is_idempotent(file_app):
    app = file_app()
    make_staff(app, "new@eskizai.uz", "support")
    with TestClient(app) as c:
        hdr = h(login(c, "new@eskizai.uz"))
        res = _parallel(lambda _: c.post("/staff/me/mfa/setup", headers=hdr), 4)
        assert {r.status_code for r in res} == {200}
        assert len({r.json()["secret"] for r in res}) == 1
        secret = res[0].json()["secret"]
        assert c.post("/staff/me/mfa/setup", headers=hdr).json()["secret"] == secret  # повтор — тот же секрет
        codes = c.post("/staff/me/mfa/enable", json={"code": sa.totp_now(secret)}, headers=hdr)
        assert codes.status_code == 200 and len(codes.json()["backup_codes"]) == 10
        assert c.post("/staff/me/mfa/setup", headers=hdr).status_code == 409


def test_mfa_setup_new_secret_after_reuse_window(app, client, db):
    uid = make_staff(app, "slow@eskizai.uz", "support")
    hdr = h(login(client, "slow@eskizai.uz"))
    first = client.post("/staff/me/mfa/setup", headers=hdr).json()["secret"]
    db.get(StaffMfa, uuid.UUID(uid)).created_at = utcnow() - timedelta(hours=1)
    db.commit()
    assert client.post("/staff/me/mfa/setup", headers=hdr).json()["secret"] != first


# --- H2: старый X-Admin-Token ---


def test_legacy_admin_token_cannot_change_access_or_money(app, client, owner):
    sup = make_supplier(app, "eman", "EMAN")
    uid = make_staff(app, "x@eskizai.uz", "support")
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    denied = [
        ("get", "/staff/users", None),
        ("post", "/staff/users", {"email": "n@eskizai.uz", "name": "N", "role": "superadmin"}),
        ("patch", f"/staff/users/{uid}", {"role": "superadmin"}),
        ("post", f"/staff/users/{uid}/reset-password", None),
        ("get", f"/staff/users/{uid}/sessions", None),
        ("delete", f"/staff/users/{uid}/sessions", None),
        ("post", f"/staff/users/{uid}/mfa/reset", {"reason": "x"}),
        ("post", f"/admin/workshops/{wid}/impersonate", {"reason": "x"}),
        ("patch", "/admin/settings", {"ai_budget_usd": 1}),
        ("put", "/admin/limits", {"sms_per_hour": 0}),
        ("put", "/admin/maintenance", {"maintenance_on": True, "reason": "x"}),
        ("post", f"/admin/suppliers/{sup}/commission", {"rate_percent": 0, "reason": "x"}),
        ("post", f"/admin/suppliers/{sup}/block", {"blocked": True, "reason": "x"}),
        ("patch", f"/admin/suppliers/{sup}", {"commission_percent": 0}),
        ("post", "/admin/suppliers", {"code": "new", "name": "N", "owner": {"email": "o@n.uz", "name": "O"}}),
        ("post", f"/admin/suppliers/{sup}/owner", {"email": "o2@n.uz", "name": "O"}),
    ]
    for method, path, body in denied:
        kwargs = {"headers": ADMIN} | ({"json": body} if body is not None else {})
        r = getattr(client, method)(path, **kwargs)
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_token_not_allowed", (method, path, r.text)
    # чтение и повседневная работа — можно
    for path in ("/admin/settings", "/admin/limits", "/admin/maintenance", "/admin/orders", "/admin/workshops",
                 "/admin/suppliers", "/admin/finance"):
        assert client.get(path, headers=ADMIN).status_code == 200, path


def test_prod_requires_long_admin_token_only_when_enabled():
    base = dict(_env_file=None, env="prod", jwt_secret="j" * 40, auth_code_provider="eskiz")
    with pytest.raises(ValueError, match="ADMIN_TOKEN"):
        Settings(**base, admin_token="short-token", admin_token_enabled=True)
    with pytest.raises(ValueError, match="ADMIN_TOKEN"):
        Settings(**base, admin_token_enabled=True)  # dev-admin-token
    assert Settings(**base, admin_token="a" * 32, admin_token_enabled=True).admin_token_enabled
    assert not Settings(**base, admin_token_enabled=False).admin_token_enabled  # выключен — токен не нужен


# --- L2, L3: владелец поставщика ---


def test_vendor_owner_manages_only_designers(app, client):
    root = superadmin(app, client)
    a = make_supplier(app, "eman", "EMAN")
    owner_a = staff(app, client, "owner@eman.uz", "vendor_owner", a)
    second = make_staff(app, "owner2@eman.uz", "vendor_owner", a)
    r = client.post("/staff/users", json={"email": "o3@eman.uz", "name": "O3", "role": "vendor_owner"},
                    headers=owner_a)
    assert r.status_code == 403
    for method, path, body in (("patch", f"/staff/users/{second}", {"is_active": False}),
                               ("post", f"/staff/users/{second}/reset-password", None),
                               ("delete", f"/staff/users/{second}/sessions", None),
                               ("post", f"/staff/users/{second}/mfa/reset", {"reason": "x"})):
        kwargs = {"headers": owner_a} | ({"json": body} if body is not None else {})
        assert getattr(client, method)(path, **kwargs).status_code == 403, path
    # список своих видит целиком (в т. ч. владельцев)
    assert len(client.get("/staff/users", headers=owner_a).json()["items"]) == 2
    # суперадмин — может
    assert client.post(f"/staff/users/{second}/reset-password", headers=root).status_code == 200
    r = client.post("/staff/users", json={"email": "o3@eman.uz", "name": "O3", "role": "vendor_owner",
                                          "supplier_id": a}, headers=root)
    assert r.status_code == 201


def test_vendor_owner_does_not_learn_foreign_emails(app, client):
    a = make_supplier(app, "eman", "EMAN")
    b = make_supplier(app, "metal", "Metal")
    owner_a = staff(app, client, "owner@eman.uz", "vendor_owner", a)
    make_staff(app, "secret.person@metal.uz", "vendor_designer", b)
    make_staff(app, "ops@eskizai.uz", "orders_manager")
    make_staff(app, "mine@eman.uz", "vendor_designer", a)
    for email in ("secret.person@metal.uz", "OPS@eskizai.uz"):
        r = client.post("/staff/users", json={"email": email, "name": "X", "role": "vendor_designer"}, headers=owner_a)
        assert r.status_code == 422 and r.json()["error"]["code"] == "cannot_create", email
    # свой сотрудник с этой почтой — обычный 409 (он и так в списке)
    r = client.post("/staff/users", json={"email": "mine@eman.uz", "name": "X", "role": "vendor_designer"},
                    headers=owner_a)
    assert r.status_code == 409


def test_concurrent_create_same_email_is_not_500(file_app):
    app = file_app()
    secret = sa.new_totp_secret()
    make_staff(app, "root@eskizai.uz", "superadmin", mfa_secret=secret)
    with TestClient(app) as c:
        root = h(login(c, "root@eskizai.uz", mfa_secret=secret))
        body = {"email": "dup@eskizai.uz", "name": "D", "role": "support"}
        res = _parallel(lambda _: c.post("/staff/users", json=body, headers=root).status_code, 4)
    assert sorted(res) == [201, 409, 409, 409]
