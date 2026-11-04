"""Обязательное обновление и техработы (SCR-45)."""

import pytest

from mebel_api.services.app_status import is_blocked, parse_version

from .conftest import ADMIN


def test_status_defaults_without_auth(client):
    r = client.get("/app/status", params={"platform": "ios", "version": "0.1.0"})
    assert r.status_code == 200
    body = r.json()
    assert body["update"] == "none" and body["min_version"] == "0.0.0"
    assert body["store_url"].startswith("https://apps.apple.com")
    assert body["maintenance"] == {"on": False, "until": None, "message": {"ru": "", "uz": ""}}
    assert body["release_notes"] == {"ru": [], "uz": []}


def test_required_and_optional_update(client, root_admin):
    r = client.patch("/admin/settings", json={
        "app_min_version": "1.0.0", "app_latest_version": "1.2", "app_store_url_android": "https://play.example/app",
        "app_release_notes_ru": "Угловые кухни в редакторе\n• Замер кухни по стенам\n",
        "app_release_notes_uz": "Burchakli oshxonalar",
    }, headers=root_admin)
    assert r.status_code == 200, r.text
    s = lambda v, p="ios": client.get("/app/status", params={"platform": p, "version": v}).json()  # noqa: E731
    assert s("0.9.5")["update"] == "required"
    assert s("1.0.0")["update"] == "optional"
    assert s("1.1.9")["update"] == "optional"
    assert s("1.2.0")["update"] == "none" and s("1.10.0")["update"] == "none"
    body = s("1.0.0", "android")
    assert body["store_url"] == "https://play.example/app"
    assert body["release_notes"]["ru"] == ["Угловые кухни в редакторе", "Замер кухни по стенам"]
    # версия и платформа — и заголовками
    r = client.get("/app/status", headers={"X-App-Version": "0.5.0", "X-Platform": "android"}).json()
    assert r["update"] == "required" and r["platform"] == "android"


def test_settings_validation(client, root_admin):
    assert client.patch("/admin/settings", json={"app_min_version": "abc"}, headers=root_admin).status_code == 422
    assert client.patch("/admin/settings", json={"maintenance_until": "завтра"}, headers=root_admin).status_code == 422
    r = client.patch("/admin/settings", json={"maintenance_until": "2026-11-03T14:00:00"}, headers=root_admin)
    assert r.status_code == 422 and "часовой пояс" in r.json()["error"]["message"]
    assert client.patch("/admin/settings", json={"maintenance_on": "maybe"}, headers=root_admin).status_code == 422
    r = client.patch("/admin/settings", json={"maintenance_on": "false"}, headers=root_admin)
    assert r.json()["values"]["maintenance_on"] is False
    assert client.get("/admin/settings", headers=root_admin).json()["descriptions"]["maintenance_on"]


def test_maintenance_blocks_project_writes_only(api, client, owner, root_admin):
    pid = api.project(owner)
    api.advance(owner, pid, "sent")
    token = client.get(f"/projects/{pid}/share-links", headers=owner).json()[0]["token"]
    r = client.patch("/admin/settings", json={
        "maintenance_on": True, "maintenance_until": "2026-11-03T14:00:00+05:00",
        "maintenance_message_ru": "Обновляем каталог",
    }, headers=root_admin)
    assert r.status_code == 200, r.text

    status = client.get("/app/status").json()["maintenance"]
    assert status["on"] and status["until"] == "2026-11-03T14:00:00+05:00"
    assert status["message"]["ru"] == "Обновляем каталог"
    # изменения проектов — 503 maintenance
    r = client.post("/projects", json={"title": "Новый"}, headers=owner)
    assert r.status_code == 503 and r.json()["error"]["code"] == "maintenance"
    assert r.json()["error"]["details"]["until"] == "2026-11-03T14:00:00+05:00"
    assert client.patch(f"/projects/{pid}", json={"title": "x"}, headers=owner).status_code == 503
    assert client.post(f"/projects/{pid}/ai/edit", json={"instruction": "шире"}, headers=owner).status_code == 503
    assert client.post(f"/projects/{pid}/measurements", json={"width": 1200}, headers=owner).status_code == 503
    # чтение, вход, профиль и страница клиента работают
    assert client.get("/projects", headers=owner).status_code == 200
    assert client.get(f"/projects/{pid}", headers=owner).status_code == 200
    assert client.get("/auth/me", headers=owner).status_code == 200
    assert client.patch("/auth/me", json={"name": "Тимур"}, headers=owner).status_code == 200
    assert client.get(f"/share/{token}").status_code == 200
    assert client.post(f"/share/{token}/agree").status_code == 200
    assert client.post("/auth/request-code", json={"phone": "+998935550000"}).status_code == 200

    client.patch("/admin/settings", json={"maintenance_on": False}, headers=root_admin)
    assert client.post("/projects", json={"title": "Новый"}, headers=owner).status_code == 201


@pytest.mark.parametrize("v,expected", [("1", (1, 0, 0)), ("1.2.3", (1, 2, 3)), ("2.0.1-beta", (2, 0, 1)), ("", (0, 0, 0))])
def test_parse_version(v, expected):
    assert parse_version(v) == expected


def test_blocked_paths():
    assert is_blocked("POST", "/projects") and is_blocked("DELETE", "/projects/1")
    assert not is_blocked("GET", "/projects/1") and not is_blocked("POST", "/projectsx")
    assert not is_blocked("POST", "/share/abc/agree") and not is_blocked("POST", "/auth/verify-code")
