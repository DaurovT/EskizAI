from datetime import UTC, datetime

from mebel_api.services.limits import period_of

from .conftest import ADMIN


def sketch(client, h, pid):
    return client.post(f"/projects/{pid}/sketch", headers=h)


def test_free_limit_is_charged_on_sketch(api, client, owner):
    assert client.get("/billing/limits", headers=owner).json()["free_left"] == 3
    pid = api.project(owner)
    assert client.get("/billing/limits", headers=owner).json()["free_used"] == 0  # черновик не списывается
    card = sketch(client, owner, pid).json()
    assert card["charged"] is True
    limits = client.get("/billing/limits", headers=owner).json()
    assert limits["free_used"] == 1 and limits["free_left"] == 2


def test_fourth_project_is_blocked(api, client, owner):
    for i in range(3):
        assert sketch(client, owner, api.project(owner, f"П{i}")).status_code == 200
    pid = api.project(owner, "П4")
    r = sketch(client, owner, pid)
    assert r.status_code == 402
    e = r.json()["error"]
    assert e["code"] == "limit_exhausted"
    assert "3 из 3" in e["message"]
    card = client.get(f"/projects/{pid}", headers=owner).json()
    assert card["status"] == "draft" and card["charged"] is False
    assert client.get("/billing/limits", headers=owner).json()["can_create_sketch"] is False


def test_examples_never_charged(api, client, owner):
    for i in range(5):
        pid = api.project(owner, f"Пример {i}", is_example=True)
        assert sketch(client, owner, pid).status_code == 200
    assert client.get("/billing/limits", headers=owner).json()["free_used"] == 0


def test_paid_order_returns_project_to_limit(api, client, owner):
    first = api.project(owner, "П0")
    api.advance(owner, first, "contract")
    for i in range(2):
        sketch(client, owner, api.project(owner, f"П{i + 1}"))
    blocked = api.project(owner, "П4")
    assert sketch(client, owner, blocked).status_code == 402

    r = client.post(f"/admin/projects/{first}/order-paid", json={"invoice_total": 4_500_000}, headers=ADMIN)
    assert r.status_code == 200
    assert client.get(f"/projects/{first}", headers=owner).json()["returned_to_limit"] is True
    assert client.get("/billing/limits", headers=owner).json()["free_left"] == 1
    assert sketch(client, owner, blocked).status_code == 200


def test_cancel_and_delete_do_not_return_limit(api, client, owner):
    a, b = api.project(owner, "A"), api.project(owner, "B")
    sketch(client, owner, a)
    sketch(client, owner, b)
    client.post(f"/projects/{a}/cancel", json={}, headers=owner)
    client.delete(f"/projects/{b}", headers=owner)
    assert client.get("/billing/limits", headers=owner).json()["free_used"] == 2


def test_pack_used_after_free_and_returned_on_order(api, client, owner):
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    r = client.post(f"/admin/workshops/{wid}/plan", json={"plan": "pack", "add_pack_projects": 1}, headers=ADMIN)
    assert r.status_code == 200
    for i in range(3):
        sketch(client, owner, api.project(owner, f"П{i}"))
    packed = api.project(owner, "Пакетный")
    api.advance(owner, packed, "contract")
    assert client.get("/billing/limits", headers=owner).json()["pack_left"] == 0
    assert sketch(client, owner, api.project(owner, "ещё")).status_code == 402
    client.post(f"/admin/projects/{packed}/order-paid", json={}, headers=ADMIN)
    assert client.get("/billing/limits", headers=owner).json()["pack_left"] == 1
    # ручное начисление пишется в журнал действий
    log = client.get("/admin/action-log", headers=ADMIN).json()
    assert any(e["entity"] == "workshop_plan" and e["after"]["pack_projects_left"] == 1 for e in log)


def test_pro_is_unlimited(api, client, owner):
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    client.post(f"/admin/workshops/{wid}/plan", json={"plan": "pro"}, headers=ADMIN)
    for i in range(5):
        assert sketch(client, owner, api.project(owner, f"П{i}")).status_code == 200
    limits = client.get("/billing/limits", headers=owner).json()
    assert limits["unlimited"] is True and limits["free_used"] == 0


def test_limits_are_per_workshop(api, client, owner):
    for i in range(3):
        sketch(client, owner, api.project(owner, f"П{i}"))
    other = api.login("+998977777777")
    assert sketch(client, other, api.project(other)).status_code == 200


def test_period_uses_tashkent_time(settings):
    # 30 ноября 20:00 UTC — в Ташкенте уже 1 декабря
    assert period_of(settings, datetime(2026, 11, 30, 20, 0, tzinfo=UTC)) == "2026-12"
    assert period_of(settings, datetime(2026, 11, 30, 18, 59, tzinfo=UTC)) == "2026-11"
