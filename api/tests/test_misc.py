import uuid
from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, select

from mebel_api.db import Base
from mebel_api.models import AiRequest
from mebel_api.services.ai_log import log_ai_request

API_DIR = Path(__file__).resolve().parents[1]
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 100


def test_photos_upload_limit_and_delete(api, client, owner, settings):
    pid = api.project(owner)
    ids = []
    for i in range(5):
        r = client.post(f"/projects/{pid}/photos", files={"file": (f"{i}.jpg", JPEG, "image/jpeg")}, headers=owner)
        assert r.status_code == 201, r.text
        ids.append(r.json())
    assert ids[0]["url"].startswith("/media/workshops/")
    stored = settings.media_dir / ids[0]["url"].removeprefix("/media/")
    assert stored.read_bytes() == JPEG
    assert client.get(ids[0]["url"]).content == JPEG  # локальное хранилище отдаёт файл

    r = client.post(f"/projects/{pid}/photos", files={"file": ("6.jpg", JPEG, "image/jpeg")}, headers=owner)
    assert r.status_code == 409 and "не больше 5 фото" in r.json()["error"]["message"]
    # фото готовой работы — отдельный счётчик
    r = client.post(
        f"/projects/{pid}/photos", files={"file": ("done.jpg", JPEG, "image/jpeg")}, data={"kind": "result"},
        headers=owner,
    )
    assert r.status_code == 201 and r.json()["kind"] == "result"

    r = client.post(f"/projects/{pid}/photos", files={"file": ("a.pdf", b"%PDF", "application/pdf")}, headers=owner)
    assert r.status_code == 415

    assert len(client.get(f"/projects/{pid}", headers=owner).json()["photos"]) == 6
    assert client.delete(f"/projects/{pid}/photos/{ids[0]['id']}", headers=owner).status_code == 200
    assert not stored.exists()
    assert len(client.get(f"/projects/{pid}", headers=owner).json()["photos"]) == 5


def test_photo_size_limit(api, client, owner, settings):
    pid = api.project(owner)
    big = b"\xff\xd8" + b"0" * (settings.max_photo_bytes + 10)
    r = client.post(f"/projects/{pid}/photos", files={"file": ("big.jpg", big, "image/jpeg")}, headers=owner)
    assert r.status_code == 413


def test_clients_crud_and_search(api, client, owner):
    r = client.post(
        "/clients", json={"name": "Азиза", "phone": "90 765 43 21", "address": "Чиланзар", "notes": "после 18:00"},
        headers=owner,
    )
    assert r.status_code == 201
    c = r.json()
    assert c["phone"] == "+998907654321"
    client.post("/clients", json={"name": "Бобур"}, headers=owner)
    assert client.get("/clients", headers=owner).json()["total"] == 2
    assert [x["name"] for x in client.get("/clients?q=азиз", headers=owner).json()["items"]] == ["Азиза"]
    assert client.get("/clients?q=7654", headers=owner).json()["total"] == 1

    r = client.patch(f"/clients/{c['id']}", json={"address": "Юнусабад"}, headers=owner)
    assert r.json()["address"] == "Юнусабад" and r.json()["name"] == "Азиза"

    pid = api.project(owner, "Кухня", client_id=c["id"])
    card = client.get(f"/clients/{c['id']}", headers=owner).json()
    assert card["projects"][0]["id"] == pid and card["projects"][0]["status_label"] == "Черновик"
    r = client.delete(f"/clients/{c['id']}", headers=owner)
    assert r.status_code == 409 and "есть проекты" in r.json()["error"]["message"]
    other = client.get("/clients?q=Бобур", headers=owner).json()["items"][0]
    assert client.delete(f"/clients/{other['id']}", headers=owner).status_code == 200


def test_projects_list_filter_and_search(api, client, owner):
    aziza = client.post("/clients", json={"name": "Азиза", "phone": "+998907654321"}, headers=owner).json()
    p1 = api.project(owner, "Шкаф в прихожую", client_id=aziza["id"])
    p2 = api.project(owner, "Стеллаж")
    api.advance(owner, p2, "sketch")

    def ids(query):
        return {x["id"] for x in client.get(f"/projects{query}", headers=owner).json()["items"]}

    assert ids("") == {p1, p2}
    assert ids("?status=sketch") == {p2}
    assert ids("?status=draft&status=sketch") == {p1, p2}
    assert ids("?q=азиза") == {p1}
    assert ids("?q=765") == {p1}
    assert ids("?q=стеллаж") == {p2}
    assert ids(f"?client_id={aziza['id']}") == {p1}
    item = client.get("/projects?q=азиза", headers=owner).json()["items"][0]
    assert item["client"]["name"] == "Азиза" and item["status_label"] == "Черновик"
    r = client.get("/projects?status=bogus", headers=owner)
    assert r.status_code == 422


def test_task_queue_inline(app, client, owner):
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    task_id = app.state.tasks.enqueue("echo", {"x": 1}, workshop_id=wid)
    r = client.get(f"/tasks/{task_id}", headers=owner).json()
    assert r["state"] == "done" and r["result"] == {"x": 1}

    app.state.tasks.register("boom", lambda p: 1 / 0)
    failed = app.state.tasks.enqueue("boom", {}, workshop_id=wid)
    assert client.get(f"/tasks/{failed}", headers=owner).json()["state"] == "failed"
    assert client.get("/tasks/unknown", headers=owner).status_code == 404


def test_ai_request_log(api, client, owner, db):
    pid = api.project(owner)
    row = log_ai_request(
        db, purpose="recognize_photo", model="claude-sonnet-5-5", tokens_in=12000, tokens_out=800,
        cost_microusd=48_000, validation_result="retried", validation_errors=[{"path": "sections"}],
        project_id=uuid.UUID(pid),
    )
    db.commit()
    assert db.scalar(select(AiRequest)).id == row.id
    log = client.get(f"/admin/ai-requests?project_id={pid}", headers={"X-Admin-Token": "test-admin"}).json()
    assert log[0]["tokens_in"] == 12000 and log[0]["validation_result"] == "retried"
    assert client.get("/admin/ai-requests").status_code == 401


def test_openapi_has_tags_and_docs(client):
    spec = client.get("/openapi.json").json()
    tags = {t for p in spec["paths"].values() for op in p.values() for t in op.get("tags", [])}
    assert tags == {
        "auth", "workshops", "clients", "projects", "models", "estimates", "share", "billing", "tasks", "admin",
        "system", "ai", "files", "catalog", "orders", "nonstandard", "devices", "staff", "vendor",
    }
    assert client.get("/docs").status_code == 200


def test_alembic_migration_matches_models(tmp_path):
    url = f"sqlite:///{tmp_path / 'm.db'}"
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    cfg.attributes["database_url"] = url
    command.upgrade(cfg, "head")
    engine = create_engine(url)
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    assert diff == []
    command.downgrade(cfg, "base")
