"""Помощники для тестов сотрудников и кабинета поставщика."""

import time
import uuid

from mebel_api.models import StaffMfa, StaffUser, Supplier
from mebel_api.services import staff_auth as sa

PASSWORD = "correct-horse-battery"


def make_supplier(app, code: str, name: str | None = None) -> str:
    with app.state.db.sessionmaker() as s:
        sup = s.query(Supplier).filter_by(code=code).one_or_none()
        if sup is None:
            sup = Supplier(code=code, name=name or code.upper(), contacts={}, settings={})
            s.add(sup)
            s.commit()
        return str(sup.id)


def make_staff(app, email: str, role: str, supplier_id: str | None = None, *, password: str = PASSWORD,
               must_change: bool = False, mfa_secret: str | None = None, name: str | None = None) -> str:
    with app.state.db.sessionmaker() as s:
        u = StaffUser(email=email, name=name or email.split("@")[0], role=role,
                      supplier_id=uuid.UUID(supplier_id) if supplier_id else None,
                      password_hash=sa.hash_password(password), must_change_password=must_change)
        s.add(u)
        s.flush()
        if mfa_secret:
            from mebel_api.db import utcnow

            s.add(StaffMfa(staff_id=u.id, secret=mfa_secret, backup_codes=[], enabled_at=utcnow()))
        s.commit()
        return str(u.id)


def next_code(secret: str) -> str:
    """Код следующего шага (не совпадает с уже использованным в этом шаге)."""
    return sa.totp_now(secret, time.time() + sa.TOTP_STEP)


def login(client, email: str, password: str = PASSWORD, mfa_secret: str | None = None) -> dict:
    r = client.post("/staff/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    body = r.json()
    if body.get("mfa_required"):
        assert mfa_secret, "нужен секрет 2FA"
        r = client.post("/staff/auth/mfa", json={"mfa_token": body["mfa_token"], "code": next_code(mfa_secret)})
        assert r.status_code == 200, r.text
        body = r.json()
    return {"Authorization": f"Bearer {body['access_token']}", "_refresh": body["refresh_token"]}


def h(headers: dict) -> dict:
    return {k: v for k, v in headers.items() if not k.startswith("_")}


def superadmin(app, client, email: str = "root@eskizai.uz") -> dict:
    secret = sa.new_totp_secret()
    make_staff(app, email, "superadmin", mfa_secret=secret)
    return h(login(client, email, mfa_secret=secret))


def staff(app, client, email: str, role: str, supplier_id: str | None = None) -> dict:
    make_staff(app, email, role, supplier_id)
    return h(login(client, email))
