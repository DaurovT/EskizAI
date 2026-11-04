"""Сотрудники: вход по почте и паролю, блокировка, 2FA, сессии, роли и права, управление сотрудниками,
старый X-Admin-Token, причины опасных действий, «глазами мастера» (docs/staff_vendor_contract.md §1–4a)."""

from datetime import timedelta

from sqlalchemy import select

from mebel_api.db import utcnow
from mebel_api.models import ActionLog, AuthThrottle, StaffUser
from mebel_api.services import staff_auth as sa

from .conftest import ADMIN, build_app, make_settings
from .staff_helpers import PASSWORD, h, login, make_staff, make_supplier, next_code, staff, superadmin


def test_password_hash_and_totp_primitives():
    hashed = sa.hash_password("long-enough-pass")
    assert hashed.startswith("scrypt$16384$8$1$") and sa.verify_password("long-enough-pass", hashed)
    assert not sa.verify_password("wrong", hashed) and not sa.verify_password("x", None)
    # RFC 6238, приложение B (SHA1, секрет "12345678901234567890"): T=59 → 287082 (последние 6 цифр 94287082)
    import base64

    secret = base64.b32encode(b"12345678901234567890").decode()
    assert sa.totp_now(secret, 59) == "287082"
    assert sa.verify_totp(secret, "287082", None, at=59) == 1
    assert sa.verify_totp(secret, "287082", 1, at=59) is None  # повтор кода
    assert sa.verify_totp(secret, "000000", None, at=59) is None


def test_login_same_error_and_lockout(app, client, db):
    make_staff(app, "ann@eskizai.uz", "orders_manager")
    unknown = client.post("/staff/auth/login", json={"email": "nobody@eskizai.uz", "password": "whatever-123"})
    wrong = client.post("/staff/auth/login", json={"email": "ann@eskizai.uz", "password": "whatever-123"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json() and wrong.json()["error"]["code"] == "invalid_credentials"
    for _ in range(4):
        client.post("/staff/auth/login", json={"email": "ANN@eskizai.uz", "password": "bad-password-1"})
    # 5 ошибок подряд → вход закрыт, даже с верным паролем, ответ тот же
    r = client.post("/staff/auth/login", json={"email": "ann@eskizai.uz", "password": PASSWORD})
    assert r.status_code == 401 and r.json() == wrong.json()
    u = db.scalar(select(StaffUser).where(StaffUser.email == "ann@eskizai.uz"))
    lock = db.scalar(select(AuthThrottle).where(AuthThrottle.staff_id == u.id, AuthThrottle.locked_until.is_not(None)))
    assert lock is not None and lock.key.startswith("acct:") and "ann" not in lock.key  # почта+IP, хеш
    lock.locked_until = utcnow() - timedelta(seconds=1)
    db.commit()
    hdr = login(client, "Ann@EskizAI.uz")
    me = client.get("/staff/me", headers=h(hdr)).json()
    assert me["role"] == "orders_manager" and me["org"]["kind"] == "platform"
    assert set(me["permissions"]) == {"workshops.view", "projects.view", "orders.manage", "nonstandard.manage"}
    actions = {e.action for e in db.scalars(select(ActionLog).where(ActionLog.entity == "staff_auth"))}
    assert {"login", "login_failed", "login_locked", "login_while_locked"} <= actions
    assert all(e.actor_type == "staff" for e in db.scalars(select(ActionLog).where(ActionLog.entity == "staff_auth")))


def test_master_and_staff_tokens_are_not_interchangeable(app, client, owner):
    hdr = staff(app, client, "ops@eskizai.uz", "orders_manager")
    assert client.get("/staff/me", headers=owner).status_code == 401
    assert client.get("/admin/orders", headers=owner).status_code == 401
    assert client.get("/vendor/dashboard", headers=owner).status_code == 401
    assert client.get("/projects", headers=hdr).status_code == 401
    assert client.get("/auth/me", headers=hdr).status_code == 401
    # refresh-токен сотрудника — не access
    tokens = login(client, "ops@eskizai.uz")
    assert client.get("/staff/me", headers={"Authorization": f"Bearer {tokens['_refresh']}"}).status_code == 401


def test_temp_password_gate_and_password_change(app, client, db):
    root = superadmin(app, client)
    r = client.post("/staff/users", json={"email": "new@eskizai.uz", "name": "Новый", "role": "support"}, headers=root)
    assert r.status_code == 201, r.text
    temp = r.json()["temp_password"]
    assert len(temp) >= 10 and r.json()["user"]["must_change_password"]
    first = login(client, "new@eskizai.uz", temp)
    second = login(client, "new@eskizai.uz", temp)
    assert client.get("/staff/me", headers=h(first)).json()["must_change_password"] is True
    r = client.get("/admin/workshops", headers=h(first))
    assert r.status_code == 403 and r.json()["error"]["code"] == "password_change_required"
    bad = client.post("/staff/me/password", json={"current_password": temp, "new_password": "short"},
                      headers=h(first))
    assert bad.status_code == 422
    assert client.post("/staff/me/password", json={"current_password": "nope-nope-nope", "new_password": "x" * 12},
                       headers=h(first)).status_code == 403
    ok = client.post("/staff/me/password", json={"current_password": temp, "new_password": "brand-new-pass-1"},
                     headers=h(first))
    assert ok.status_code == 200 and ok.json() == {"ok": True}
    assert client.get("/admin/workshops", headers=h(first)).status_code == 200
    # другие сессии завершены
    assert client.get("/staff/me", headers=h(second)).status_code == 401
    assert client.post("/staff/auth/refresh", json={"refresh_token": second["_refresh"]}).status_code == 401


def test_refresh_rotation_logout_sessions(app, client):
    make_staff(app, "cat@eskizai.uz", "catalog_manager")
    t = login(client, "cat@eskizai.uz")
    r = client.post("/staff/auth/refresh", json={"refresh_token": t["_refresh"]})
    assert r.status_code == 200 and set(r.json()) >= {"access_token", "refresh_token"}
    assert client.post("/staff/auth/refresh", json={"refresh_token": t["_refresh"]}).status_code == 401  # отозван
    new = {"Authorization": f"Bearer {r.json()['access_token']}"}
    sessions = client.get("/staff/me/sessions", headers=new).json()
    assert len(sessions) == 1 and sessions[0]["current"] and sessions[0]["active"]
    other = login(client, "cat@eskizai.uz")
    assert client.delete("/staff/me/sessions", headers=new).json()["revoked"] == 1
    assert client.get("/staff/me", headers=h(other)).status_code == 401
    assert client.post("/staff/auth/logout", json={"refresh_token": r.json()["refresh_token"]}).json() == {"ok": True}
    assert client.get("/staff/me", headers=new).status_code == 401


def test_superadmin_mfa_mandatory_setup_and_login(app, client):
    make_staff(app, "boss@eskizai.uz", "superadmin")
    t = h(login(client, "boss@eskizai.uz"))
    me = client.get("/staff/me", headers=t).json()
    assert me["mfa_setup_required"] and me["permissions"][0] == "*" and "staff.manage" in me["permissions"]
    r = client.get("/admin/dashboard", headers=t)
    assert r.status_code == 403 and r.json()["error"]["code"] == "mfa_setup_required"
    setup = client.post("/staff/me/mfa/setup", headers=t).json()
    assert setup["otpauth_url"].startswith("otpauth://totp/") and setup["secret"]
    assert client.post("/staff/me/mfa/enable", json={"code": "000000"}, headers=t).status_code == 422
    codes = client.post("/staff/me/mfa/enable", json={"code": sa.totp_now(setup["secret"])}, headers=t).json()
    assert len(codes["backup_codes"]) == 10
    assert client.get("/admin/dashboard", headers=t).status_code == 200
    # вход теперь в два шага
    step1 = client.post("/staff/auth/login", json={"email": "boss@eskizai.uz", "password": PASSWORD}).json()
    assert step1["mfa_required"] and "access_token" not in step1
    bad = client.post("/staff/auth/mfa", json={"mfa_token": step1["mfa_token"], "code": "123456"})
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "invalid_mfa_code"
    ok = client.post("/staff/auth/mfa", json={"mfa_token": step1["mfa_token"], "code": codes["backup_codes"][0]})
    assert ok.status_code == 200 and ok.json()["staff"]["mfa_enabled"]
    again = client.post("/staff/auth/mfa", json={"mfa_token": step1["mfa_token"], "code": codes["backup_codes"][0]})
    assert again.status_code == 401  # резервный код — один раз
    # мастерский токен входа и mfa_token не подменяют друг друга
    assert client.get("/staff/me", headers={"Authorization": f"Bearer {step1['mfa_token']}"}).status_code == 401
    # суперадмину выключить 2FA нельзя
    r = client.post("/staff/me/mfa/disable", json={"password": PASSWORD, "code": next_code(setup["secret"])},
                    headers=t)
    assert r.status_code == 409 and r.json()["error"]["code"] == "mfa_mandatory"


def test_role_permissions_on_old_admin_endpoints(app, client, api, owner):
    pid = api.project(owner)
    om = staff(app, client, "om@eskizai.uz", "orders_manager")
    cm = staff(app, client, "cm@eskizai.uz", "catalog_manager")
    sp = staff(app, client, "sp@eskizai.uz", "support")
    sup = make_supplier(app, "eman", "EMAN Materials")
    vo = staff(app, client, "vo@eman.uz", "vendor_owner", sup)
    allowed = [
        (om, ["/admin/orders", "/admin/workshops", f"/admin/projects/{pid}", "/admin/nonstandard", "/admin/dashboard"]),
        (cm, ["/admin/catalog/items", "/admin/price-requests", "/admin/projects", "/admin/suppliers"]),
        (sp, ["/admin/workshops", "/admin/projects"]),
    ]
    denied = [
        (om, ["/admin/settings", "/admin/ai-requests", "/admin/catalog/items", "/staff/users", "/admin/finance",
             "/admin/audit", "/admin/limits", "/admin/disputes", "/vendor/dashboard"]),
        (cm, ["/admin/orders", "/admin/workshops", "/admin/ai-stats", "/admin/action-log"]),
        (sp, ["/admin/orders", "/admin/catalog/items", "/admin/nonstandard", "/admin/settings"]),
        (vo, ["/admin/dashboard", "/admin/orders", "/admin/workshops", "/admin/catalog/items"]),
    ]
    for hdr, paths in allowed:
        for path in paths:
            assert client.get(path, headers=hdr).status_code == 200, path
    for hdr, paths in denied:
        for path in paths:
            assert client.get(path, headers=hdr).status_code == 403, path
    wid = client.get("/admin/workshops", headers=sp).json()["items"][0]["id"]
    # support: начисление — можно (с причиной), блокировка без причины — 422
    r = client.post(f"/admin/workshops/{wid}/plan", json={"add_pack_projects": 2}, headers=sp)
    assert r.status_code == 422 and r.json()["error"]["code"] == "reason_required"
    assert client.post(f"/admin/workshops/{wid}/plan", json={"add_pack_projects": 2, "reason": "Компенсация"},
                       headers=sp).status_code == 200
    assert client.post(f"/admin/workshops/{wid}/block", json={"blocked": True}, headers=sp).status_code == 422
    # старый токен — суперадмин без причины (переходный период)
    assert client.post(f"/admin/workshops/{wid}/block", json={"blocked": False}, headers=ADMIN).status_code == 200
    log = client.get("/admin/audit?entity=workshop_plan", headers=ADMIN).json()["items"]
    assert log[0]["actor_type"] == "staff" and log[0]["actor_name"] == "sp" and log[0]["after"]["reason"] == "Компенсация"


def test_legacy_admin_token_can_be_disabled(tmp_path):
    from fastapi.testclient import TestClient

    app = build_app(make_settings(tmp_path, admin_token_enabled=False))
    with TestClient(app) as c:
        r = c.get("/admin/workshops", headers=ADMIN)
        assert r.status_code == 401 and r.json()["error"]["code"] == "admin_required"
    app.state.db.engine.dispose()


def test_legacy_token_logs_admin_token_actor(client, db, api, owner):
    api.project(owner)
    wid = client.get("/admin/workshops", headers=ADMIN).json()["items"][0]["id"]
    client.post(f"/admin/workshops/{wid}/plan", json={"add_pack_projects": 1}, headers=ADMIN)
    e = db.scalar(select(ActionLog).where(ActionLog.entity == "workshop_plan"))
    assert e.actor_type == "staff" and e.actor_id == "admin-token"


def test_staff_management_rules_and_vendor_scoping(app, client):
    root = superadmin(app, client)
    a = make_supplier(app, "eman", "EMAN Materials")
    b = make_supplier(app, "metal", "Металлоцех")
    owner_a = staff(app, client, "owner@eman.uz", "vendor_owner", a)
    designer_a = staff(app, client, "designer@eman.uz", "vendor_designer", a)
    owner_b = staff(app, client, "owner@metal.uz", "vendor_owner", b)
    me_a = client.get("/staff/me", headers=owner_a).json()
    assert me_a["org"] == {"kind": "supplier", "supplier_id": a, "supplier_code": "eman",
                           "supplier_name": "EMAN Materials"}
    assert "vendor.staff" in me_a["permissions"] and "vendor.finance" in me_a["permissions"]
    assert "vendor.staff" not in client.get("/staff/me", headers=designer_a).json()["permissions"]

    # владелец поставщика: только vendor_* в своём поставщике
    r = client.post("/staff/users", json={"email": "d2@eman.uz", "name": "Д2", "role": "vendor_designer"},
                    headers=owner_a)
    assert r.status_code == 201 and r.json()["user"]["org"]["supplier_id"] == a
    d2 = r.json()["user"]["id"]
    for body in ({"email": "x@eman.uz", "name": "X", "role": "superadmin"},
                 {"email": "y@eman.uz", "name": "Y", "role": "orders_manager"},
                 {"email": "z@eman.uz", "name": "Z", "role": "vendor_designer", "supplier_id": b}):
        assert client.post("/staff/users", json=body, headers=owner_a).status_code == 403, body
    assert client.post("/staff/users", json={"email": "q@eman.uz", "name": "Q", "role": "vendor_designer"},
                       headers=designer_a).status_code == 403
    # список — только свои
    emails_a = {u["email"] for u in client.get("/staff/users", headers=owner_a).json()["items"]}
    assert emails_a == {"owner@eman.uz", "designer@eman.uz", "d2@eman.uz"}
    assert {u["email"] for u in client.get(f"/staff/users?supplier_id={a}", headers=owner_b).json()["items"]} == \
        {"owner@metal.uz"}
    # чужой сотрудник: 404 на изменение, сброс пароля, сессии, 2FA
    for method, path, body in (("patch", f"/staff/users/{d2}", {"name": "взлом"}),
                               ("post", f"/staff/users/{d2}/reset-password", None),
                               ("get", f"/staff/users/{d2}/sessions", None),
                               ("delete", f"/staff/users/{d2}/sessions", None),
                               ("post", f"/staff/users/{d2}/mfa/reset", {"reason": "x"})):
        kwargs = {"headers": owner_b} | ({"json": body} if body is not None else {})
        assert getattr(client, method)(path, **kwargs).status_code == 404, path
    # владельцев поставщика (в т. ч. себя) меняет только платформа; конструктора нельзя повысить до владельца
    me_id = me_a["id"]
    assert client.patch(f"/staff/users/{me_id}", json={"is_active": False}, headers=owner_a).status_code == 403
    assert client.patch(f"/staff/users/{me_id}", json={"role": "vendor_designer"}, headers=owner_a).status_code == 403
    assert client.patch(f"/staff/users/{d2}", json={"role": "superadmin"}, headers=owner_a).status_code == 403
    assert client.patch(f"/staff/users/{d2}", json={"role": "vendor_owner"}, headers=owner_a).status_code == 403
    # сброс пароля: временный пароль, старые сессии завершены
    d2_tokens = None
    temp = client.post(f"/staff/users/{d2}/reset-password", headers=owner_a).json()["temp_password"]
    d2_tokens = login(client, "d2@eman.uz", temp)
    temp2 = client.post(f"/staff/users/{d2}/reset-password", headers=owner_a).json()["temp_password"]
    assert temp2 != temp and client.get("/staff/me", headers=h(d2_tokens)).status_code == 401
    # отключение
    assert client.patch(f"/staff/users/{d2}", json={"is_active": False}, headers=owner_a).json()["is_active"] is False
    assert client.post("/staff/auth/login", json={"email": "d2@eman.uz", "password": temp2}).status_code == 401
    # последний суперадмин
    root_id = client.get("/staff/me", headers=root).json()["id"]
    assert client.patch(f"/staff/users/{root_id}", json={"is_active": False}, headers=root).status_code == 409
    r = client.patch(f"/staff/users/{root_id}", json={"is_active": False}, headers=ADMIN)
    assert r.status_code == 403 and r.json()["error"]["code"] == "admin_token_not_allowed"
    # суперадмин видит всех и создаёт роль платформы
    assert client.get("/staff/users", headers=root).json()["total"] >= 5
    r = client.post("/staff/users", json={"email": "om2@eskizai.uz", "name": "OM", "role": "orders_manager",
                                          "supplier_id": a}, headers=root)
    assert r.status_code == 422  # роль платформы — без поставщика
    assert client.post("/staff/users", json={"email": "Owner@Eman.uz", "name": "dup", "role": "vendor_owner",
                                             "supplier_id": a}, headers=root).status_code == 409


def test_mfa_reset_requires_reason_and_sessions_admin(app, client):
    root = superadmin(app, client)
    secret = sa.new_totp_secret()
    uid = make_staff(app, "sec@eskizai.uz", "support", mfa_secret=secret)
    t = h(login(client, "sec@eskizai.uz", mfa_secret=secret))
    assert len(client.get(f"/staff/users/{uid}/sessions", headers=root).json()) == 1
    assert client.post(f"/staff/users/{uid}/mfa/reset", json={}, headers=root).status_code == 422
    assert client.post(f"/staff/users/{uid}/mfa/reset", json={"reason": "Потерял телефон"}, headers=root).json()["ok"]
    assert client.get("/staff/me", headers=t).status_code == 401  # сессии завершены
    assert "access_token" in client.post("/staff/auth/login", json={"email": "sec@eskizai.uz",
                                                                    "password": PASSWORD}).json()
    # обязательная 2FA для роли через настройку
    assert client.patch("/admin/settings", json={"mfa_required_roles": ["support"]}, headers=root).status_code == 200
    t2 = h(login(client, "sec@eskizai.uz"))
    assert client.get("/admin/workshops", headers=t2).json()["error"]["code"] == "mfa_setup_required"


def test_impersonation_read_only_and_logged(app, client, api, owner, db):
    root = superadmin(app, client)
    api.project(owner)
    wid = client.get("/admin/workshops", headers=root).json()["items"][0]["id"]
    assert client.post(f"/admin/workshops/{wid}/impersonate", json={}, headers=root).status_code == 422
    r = client.post(f"/admin/workshops/{wid}/impersonate", json={"reason": "Жалоба №5"}, headers=root)
    assert r.status_code == 200 and r.json()["read_only"]
    imp = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/projects", headers=imp).status_code == 200
    w = client.post("/projects", json={"title": "x"}, headers=imp)
    assert w.status_code == 403 and w.json()["error"]["code"] == "impersonation_read_only"
    entries = list(db.scalars(select(ActionLog).where(ActionLog.entity == "impersonation")))
    assert {e.action for e in entries} == {"start", "request", "denied"}
    # обычный сотрудник платформы — без права
    om = staff(app, client, "om@eskizai.uz", "orders_manager")
    assert client.post(f"/admin/workshops/{wid}/impersonate", json={"reason": "x"}, headers=om).status_code == 403
