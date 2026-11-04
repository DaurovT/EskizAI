"""Приглашения сотрудников на 7 дней (SCR-38a, SCR-23)."""

import uuid
from datetime import timedelta

from sqlalchemy import select

from mebel_api.models import Invite, User, Workshop

PHONE = "+998901234567"
EMP = "+998935550000"


def login_raw(api, client, phone: str) -> dict:
    client.post("/auth/request-code", json={"phone": phone, "channel": "sms"})
    r = client.post("/auth/verify-code", json={"phone": phone, "code": api.sender.sent[-1][1]})
    assert r.status_code == 200, r.text
    body = r.json()
    body["h"] = {"Authorization": f"Bearer {body['access_token']}"}
    return body


def test_invite_is_pending_until_accepted(api, client, owner, db):
    client.patch("/workshops/me", json={"name": "Мебель Плюс", "city": "Ташкент"}, headers=owner)
    client.patch("/auth/me", json={"name": "Тимур"}, headers=owner)
    r = client.post("/workshops/me/employees", json={"phone": "93 555 00 00", "name": "Бахтиёр", "title": "Замерщик",
                                                     "can_order": True}, headers=owner)
    assert r.status_code == 201, r.text
    inv = r.json()
    assert inv["status"] == "pending" and inv["phone"] == EMP and inv["title"] == "Замерщик"
    assert inv["can_order"] is True and inv["can_see_cost"] is False
    assert inv["role"] == "employee" and inv["is_active"] is False  # совместимость с EmployeeOut
    assert inv["workshop"]["name"] == "Мебель Плюс" and inv["owner"]["name"] == "Тимур"
    sent = uuid.UUID(inv["id"])
    expires = db.get(Invite, sent).expires_at - db.get(Invite, sent).sent_at
    assert timedelta(days=6, hours=23) < expires <= timedelta(days=7)
    # до входа сотрудник ещё не в цехе
    assert [e["phone"] for e in client.get("/workshops/me/employees", headers=owner).json()] == [PHONE]
    assert [i["id"] for i in client.get("/workshops/me/invites", headers=owner).json()] == [inv["id"]]

    # вход по приглашённому номеру: приглашение в ответе, роль пока — владелец своего (пустого) цеха
    body = login_raw(api, client, EMP)
    assert body["invite"]["id"] == inv["id"] and body["invite"]["status"] == "pending"
    assert body["invite"]["estimate_views"] == ["total"]
    assert body["user"]["role"] == "owner"
    temp_ws = body["user"]["workshop_id"]
    assert client.get("/auth/invite", headers=body["h"]).json()["id"] == inv["id"]

    r = client.post(f"/auth/invite/{inv['id']}/accept", headers=body["h"])
    assert r.status_code == 200, r.text
    tk = r.json()
    assert tk["user"]["role"] == "employee" and tk["user"]["title"] == "Замерщик" and tk["user"]["can_order"]
    owner_ws = client.get("/auth/me", headers=owner).json()["workshop_id"]
    assert tk["user"]["workshop_id"] == owner_ws
    assert db.get(Workshop, uuid.UUID(temp_ws)) is None  # пустой цех, созданный при входе, удалён
    emp = {"Authorization": f"Bearer {tk['access_token']}"}
    assert client.get("/auth/invite", headers=emp).json() is None
    emps = client.get("/workshops/me/employees", headers=owner).json()
    assert [e["phone"] for e in emps] == [PHONE, EMP]
    assert emps[1]["name"] == "Бахтиёр" and emps[1]["title"] == "Замерщик"
    assert client.get("/workshops/me/invites", headers=owner).json() == []
    # повторный вход — без приглашения
    assert login_raw(api, client, EMP)["invite"] is None
    # уже сотрудник — второй раз пригласить нельзя
    r = client.post("/workshops/me/employees", json={"phone": EMP}, headers=owner)
    assert r.status_code == 409 and r.json()["error"]["code"] == "phone_taken"


def test_decline_leads_to_own_workshop(api, client, owner):
    inv = client.post("/workshops/me/invites", json={"phone": EMP}, headers=owner).json()
    body = login_raw(api, client, EMP)
    assert client.post(f"/auth/invite/{inv['id']}/decline", headers=body["h"]).status_code == 200
    assert client.get("/auth/invite", headers=body["h"]).json() is None
    me = client.get("/auth/me", headers=body["h"]).json()
    assert me["role"] == "owner" and me["workshop_id"] == body["user"]["workshop_id"]
    assert client.get("/workshops/me/invites", headers=owner).json() == []
    assert client.post(f"/auth/invite/{inv['id']}/accept", headers=body["h"]).status_code == 404


def test_expired_invite_is_shown_but_cannot_be_accepted(api, client, owner, db):
    client.patch("/workshops/me", json={"name": "Мебель Плюс"}, headers=owner)
    inv = client.post("/workshops/me/invites", json={"phone": EMP}, headers=owner).json()
    row = db.get(Invite, uuid.UUID(inv["id"]))
    row.expires_at = row.expires_at - timedelta(days=8)
    db.commit()
    assert client.get("/workshops/me/invites", headers=owner).json()[0]["status"] == "expired"

    body = login_raw(api, client, EMP)
    assert body["invite"]["status"] == "expired" and body["invite"]["workshop"]["name"] == "Мебель Плюс"
    assert body["invite"]["owner"]["phone"] == PHONE  # «Написать владельцу»
    r = client.post(f"/auth/invite/{inv['id']}/accept", headers=body["h"])
    assert r.status_code == 410 and r.json()["error"]["code"] == "invite_expired"

    # владелец отправляет заново — ещё 7 дней, и теперь принять можно
    r = client.post(f"/workshops/me/invites/{inv['id']}/resend", headers=owner)
    assert r.status_code == 200 and r.json()["status"] == "pending"
    assert client.post(f"/auth/invite/{inv['id']}/accept", headers=body["h"]).status_code == 200


def test_cancelled_invite_disappears(api, client, owner):
    inv = client.post("/workshops/me/invites", json={"phone": EMP}, headers=owner).json()
    assert client.delete(f"/workshops/me/invites/{inv['id']}", headers=owner).status_code == 200
    assert client.get("/workshops/me/invites", headers=owner).json() == []
    assert client.post(f"/workshops/me/invites/{inv['id']}/resend", headers=owner).status_code == 404
    assert login_raw(api, client, EMP)["invite"] is None


def test_reinvite_refreshes_single_pending_invite(api, client, owner, db):
    a = client.post("/workshops/me/invites", json={"phone": EMP, "title": "Замерщик"}, headers=owner).json()
    b = client.post("/workshops/me/invites", json={"phone": EMP, "title": "Менеджер", "can_see_cost": True},
                    headers=owner).json()
    assert a["id"] == b["id"] and b["title"] == "Менеджер" and b["can_see_cost"]
    assert len(db.scalars(select(Invite)).all()) == 1


def test_busy_number_cannot_be_invited_or_accept(api, client, owner):
    other = api.login("+998977778899")
    api.project(other)  # у номера уже свой рабочий цех
    r = client.post("/workshops/me/invites", json={"phone": "+998977778899"}, headers=owner)
    assert r.status_code == 409 and r.json()["error"]["code"] == "phone_taken"
    # свежий номер (вошёл, но ничего не сделал) пригласить можно
    fresh = login_raw(api, client, EMP)
    inv = client.post("/workshops/me/invites", json={"phone": EMP}, headers=owner).json()
    api.project(fresh["h"])  # …но если он успел начать работу — принять уже нельзя
    assert client.get("/auth/invite", headers=fresh["h"]).json() is None
    r = client.post(f"/auth/invite/{inv['id']}/accept", headers=fresh["h"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "invite_busy"


def test_invites_are_owner_only_and_scoped(api, client, owner):
    emp = api.employee(owner, EMP)
    assert client.post("/workshops/me/invites", json={"phone": "+998935550001"}, headers=emp).status_code == 403
    assert client.get("/workshops/me/invites", headers=emp).status_code == 403
    other = api.login("+998977778899")
    inv = client.post("/workshops/me/invites", json={"phone": "+998935550001"}, headers=owner).json()
    assert client.delete(f"/workshops/me/invites/{inv['id']}", headers=other).status_code == 404
    # чужой номер не может принять чужое приглашение
    assert client.post(f"/auth/invite/{inv['id']}/accept", headers=other).status_code == 404


def test_owner_changes_employee_permissions(api, client, owner):
    emp = api.employee(owner, EMP)
    emp_id = client.get("/auth/me", headers=emp).json()["id"]
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    # без права — ни себестоимости, ни заказа
    assert "cost" not in str(client.get(f"/projects/{pid}/estimate", headers=emp).json())
    r = client.post(f"/projects/{pid}/orders", json={}, headers=emp)
    assert r.status_code == 403

    r = client.patch(f"/workshops/me/employees/{emp_id}", json={"can_see_cost": True, "can_order": True,
                                                                "title": "Менеджер"}, headers=owner)
    assert r.status_code == 200 and r.json()["can_order"] and r.json()["title"] == "Менеджер"
    assert client.get("/auth/me", headers=emp).json()["can_see_cost"] is True
    est = client.get(f"/projects/{pid}/estimate", headers=emp).json()
    full = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert set(est) == set(full) and est["total"] == full["total"]
    r = client.post(f"/projects/{pid}/orders", json={}, headers=emp)
    assert r.status_code == 201, r.text
    assert "estimate_total" in r.json()
    # владельцу права не меняются, сотрудник права не меняет
    owner_id = client.get("/auth/me", headers=owner).json()["id"]
    assert client.patch(f"/workshops/me/employees/{owner_id}", json={"can_order": False}, headers=owner).status_code == 409
    assert client.patch(f"/workshops/me/employees/{emp_id}", json={"can_order": False}, headers=emp).status_code == 403


def test_remove_employee_still_works(api, client, owner, db):
    emp = api.employee(owner, EMP)
    emp_id = client.get("/auth/me", headers=emp).json()["id"]
    assert client.delete(f"/workshops/me/employees/{emp_id}", headers=owner).status_code == 200
    assert client.get("/auth/me", headers=emp).status_code == 401
    assert db.get(User, uuid.UUID(emp_id)).is_active is False
