"""SCR-55 «Разбор чертежа»: проект по листу входящего чертежа (POST /inbox/drawings/{id}/project) и
исходный чертёж проекта для «Открыть в Eskiz DWG» (GET /projects/{id}/source-drawing, SCR-54).

Пакеты синтетические: manifest и data.json формата 1 по eskiz-dwg/docs/package_format.md."""

import io
import json
import uuid
import zipfile
from datetime import timedelta

from mebel_api.db import utcnow
from mebel_api.models import InboxDrawing, Project, ProjectPhoto
from mebel_api.services import inbox as inbox_service
from mebel_api.services import inbox_project

from .test_dwg_inbox import A, B, bearer, dwg_login, manifest, upload, webp

DATA_V1 = {
    "data_version": 1, "units": "mm", "to_mm": 1, "units_source": "file",
    "sheets": [
        {
            "id": "s1", "number": "1", "name": "Кухня — план", "scale": 20, "frame_mm": [4000, 2800],
            "stamp": {"total": "2", "code": "КМ-01", "stage": "РП"},
            "axes": [{"summary": "A–Б: 3200; 1–2: 2400",
                      "vertical": {"axes": [{"label": "1", "pos": 0}, {"label": "2", "pos": 2400}],
                                   "steps": [{"from": "1", "to": "2", "mm": 2400, "dim": 2400}]}}],
            "dimensions": {"count": 9, "chains": [
                {"dir": "h", "values": "600 ×4 + 800", "sum": 3200, "overall": 3200, "axes": "А–Б",
                 "start": [0, 0], "end": [3200, 0]},
                {"dir": "v", "values": "600 ×3 + 600", "sum": 2400, "overall": 2400, "start": [0, 0], "end": [0, 2400]},
            ], "single": [{"mm": 720, "count": 3}, {"mm": 2700}, {"text": "R300"}]},
            "elevations": [{"v": "+0.850", "mm": 850, "note": "столешница"}],
            "marks": {"М1": 4, "М2": 1},
            "titles": ["План кухни"],
            "texts": ["Мойка у окна", {"text": "Варочная 600"}, "Мойка у окна"],
            "tables": [{"title": "Спецификация модулей", "header": ["Поз.", "Модуль", "Ширина"], "rows": [["1", "М1", "600"]] * 8}],
        },
        {"id": "s2", "number": "2", "name": "Развёртка", "dimensions": {"chains": [
            {"dir": "h", "values": "3200", "sum": 3200}]}},
    ],
    "marks": [{"mark": "М1", "n": 4, "sheets": ["1"]}],
    "summary": {"sheets": 2, "chains": 3},
}


def kitchen_manifest(**over) -> dict:
    m = manifest(title="Кухня_Юнусабад", sheets=[
        {"id": "s1", "number": "1", "name": "Кухня — план", "scale": 20, "preview": "previews/s1.webp", "selected": True},
        {"id": "s2", "number": "2", "name": "Развёртка", "preview": "previews/s2.webp", "selected": False},
    ], source={"file_name": "kitchen.dxf", "size": 10, "sha256": "b" * 64, "kind": "dxf"})
    m.update(over)
    return {k: v for k, v in m.items() if v is not None}


def kitchen_package(m: dict | None = None, data: dict | None | bytes = DATA_V1, previews: dict | None = None,
                    salt: bytes = b"") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(m or kitchen_manifest(), ensure_ascii=False))
        if data is not None:
            zf.writestr("data.json", data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False))
        for name, b in (previews if previews is not None else
                        {"previews/s1.webp": webp(b"p1"), "previews/s2.webp": webp(b"p2")}).items():
            zf.writestr(name, b)
        zf.writestr("source.dxf", b"0\nSECTION\n" + salt)
    return buf.getvalue()


def make(client, h, **body):
    return client.post(f"/inbox/drawings/{body.pop('drawing_id')}/project", json=body, headers=h)


def test_project_from_selected_sheet(api, client, db):
    h = api.login(A)
    d = upload(client, h, kitchen_package()).json()
    r = make(client, h, drawing_id=d["id"])
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["created"] is True
    assert out["sheet"] == {"id": "s1", "number": "1", "name": "Кухня — план"}
    text = out["text"]
    assert text.startswith("Чертёж из Eskiz DWG «Кухня Юнусабад», лист 1 «Кухня — план», масштаб 1:20. Размеры в мм.")
    assert "Габариты: 3200 × 2400." in text
    assert "600 ×4 + 800 = 3200 (А–Б, гориз.)" in text
    assert "Оси: A–Б: 3200; 1–2: 2400." in text
    assert "720 ×3" in text and "R300" in text
    assert "+0.850 (столешница)" in text
    assert "М1 ×4, М2" in text
    assert "Спецификация модулей (8 строк: Поз., Модуль, Ширина)" in text
    assert text.count("Мойка у окна") == 1  # без дублей
    assert "КМ-01" not in text  # штамп ИИ не отдаём
    assert len(text) <= inbox_project.MAX_TEXT

    # превью листа — исходное фото проекта (публичное, как фото с телефона)
    photo = db.get(ProjectPhoto, uuid.UUID(out["photo_id"]))
    assert photo.kind == "source" and photo.content_type == "image/webp" and out["photo_url"] == photo.url
    card = client.get(f"/projects/{out['project_id']}", headers=h).json()
    assert card["title"] == "Кухня Юнусабад" and card["status"] == "draft" and card["source_text"] == text
    assert [p["id"] for p in card["photos"]] == [out["photo_id"]]
    assert card["source_drawing"]["id"] == d["id"] and card["source_drawing"]["source_kind"] == "dxf"
    assert "download_url" not in card["source_drawing"] or card["source_drawing"]["download_url"] is None

    # во «Входящих» видно, что проект есть
    item = client.get("/inbox/drawings", headers=h).json()["items"][0]
    assert item["project_id"] == out["project_id"] and item["source_kind"] == "dxf"

    # «Открыть в Eskiz DWG» из проекта — свежая подписанная ссылка на пакет
    sd = client.get(f"/projects/{out['project_id']}/source-drawing", headers=h)
    assert sd.status_code == 200, sd.text
    pkg = client.get(sd.json()["download_url"])
    assert pkg.status_code == 200 and pkg.content == kitchen_package()


def test_sheet_selection_by_id_and_number(api, client):
    h = api.login(A)
    d = upload(client, h, kitchen_package()).json()
    r = make(client, h, drawing_id=d["id"], sheet="s2")
    assert r.status_code == 201 and r.json()["sheet"]["name"] == "Развёртка"
    assert "Габариты: 3200." in r.json()["text"]
    pid = r.json()["project_id"]
    # другой лист, пока проект — черновик без модели: тот же проект, превью заменено
    r2 = make(client, h, drawing_id=d["id"], sheet="1")
    assert r2.status_code == 200 and r2.json()["project_id"] == pid and r2.json()["created"] is False
    card = client.get(f"/projects/{pid}", headers=h).json()
    assert [p["id"] for p in card["photos"]] == [r2.json()["photo_id"]]
    assert card["source_text"].startswith("Чертёж из Eskiz DWG «Кухня Юнусабад», лист 1")
    r3 = make(client, h, drawing_id=d["id"], sheet="9")
    assert r3.status_code == 422 and r3.json()["error"]["code"] == "sheet_not_found"


def test_new_project_once_model_exists(api, client, db):
    from .conftest import GOOD_TREE

    h = api.login(A)
    d = upload(client, h, kitchen_package()).json()
    pid = make(client, h, drawing_id=d["id"]).json()["project_id"]
    assert client.post(f"/projects/{pid}/model", json={"tree": GOOD_TREE}, headers=h).status_code == 201
    r = make(client, h, drawing_id=d["id"], sheet="s2")
    assert r.status_code == 201 and r.json()["project_id"] != pid  # готовый проект не трогаем
    assert len(client.get(f"/projects/{pid}", headers=h).json()["photos"]) == 1


def test_only_full_token_and_only_own_drawing(api, client):
    h = api.login(A)
    d = upload(client, h, kitchen_package()).json()
    # токен Eskiz DWG проект не создаёт
    dwg = bearer(dwg_login(api, client, A))
    r = make(client, dwg, drawing_id=d["id"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "scope_limited"
    # чужой чертёж — как несуществующий
    hb = api.login(B)
    r = make(client, hb, drawing_id=d["id"])
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert make(client, h, drawing_id=str(uuid.uuid4())).status_code == 404
    # и исходный чертёж чужого проекта не отдаётся
    pid = make(client, h, drawing_id=d["id"]).json()["project_id"]
    assert client.get(f"/projects/{pid}/source-drawing", headers=hb).status_code == 404
    assert client.post(f"/inbox/drawings/{d['id']}/project", json={}).status_code == 401


def test_package_without_data_or_previews(api, client):
    h = api.login(A)
    d = upload(client, h, kitchen_package(data=None, previews={})).json()
    out = make(client, h, drawing_id=d["id"]).json()
    assert out["photo_id"] is None and out["photo_url"] is None
    assert out["text"] == "Чертёж из Eskiz DWG «Кухня Юнусабад», лист 1 «Кухня — план», масштаб 1:20. Размеры в мм."
    # data.json-заготовка (data_version 0) и мусор — то же, без падения
    for i, data in enumerate(({"data_version": 0}, b"{not json", json.dumps([1, 2]).encode())):
        d = upload(client, h, kitchen_package(data=data, salt=bytes([i]))).json()
        r = make(client, h, drawing_id=d["id"])
        assert r.status_code == 201 and r.json()["text"].endswith("Размеры в мм.")


def test_no_sheets_takes_model_and_guessed_units(api, client):
    h = api.login(A)
    m = kitchen_manifest(sheets=[], model_preview="previews/model.webp", units={"code": "cm", "to_mm": 10, "source": "guessed"})
    data = {"data_version": 1, "sheets": [], "model": {"dimensions": {"chains": [{"dir": "h", "values": "1200", "sum": 1200}]}}}
    d = upload(client, h, kitchen_package(m, data, previews={"previews/model.webp": webp(b"m")})).json()
    out = make(client, h, drawing_id=d["id"]).json()
    assert out["sheet"] is None and out["photo_id"]
    assert "Единицы угаданы — проверьте размеры." in out["text"] and "Габариты: 1200." in out["text"]


def test_uzbek_master_gets_uzbek_labels(api, client):
    h = api.login(A)
    assert client.patch("/auth/me", json={"language": "uz"}, headers=h).status_code == 200
    d = upload(client, h, kitchen_package()).json()
    text = make(client, h, drawing_id=d["id"]).json()["text"]
    assert text.startswith("Eskiz DWG chizmasi «Кухня Юнусабад», varaq 1 «Кухня — план», masshtab 1:20.")
    assert "Gabaritlar: 3200 × 2400." in text


def test_linked_drawing_does_not_expire_until_project_deleted(api, client, db, app):
    h = api.login(A)
    d = upload(client, h, kitchen_package()).json()
    pid = make(client, h, drawing_id=d["id"]).json()["project_id"]
    row = db.get(InboxDrawing, uuid.UUID(d["id"]))
    row.expires_at = utcnow() - timedelta(days=1)
    db.commit()
    assert client.get("/inbox/drawings", headers=h).json()["total"] == 1
    assert client.get(f"/inbox/drawings/{d['id']}", headers=h).status_code == 200
    db.expire_all()
    row = db.get(InboxDrawing, uuid.UUID(d["id"]))
    row.expires_at = utcnow() - timedelta(days=1)
    db.commit()
    stats = inbox_service.prune(db, app.state.storage)
    assert stats["rows_deleted"] == 0
    # проект удалён — чертёж снова живёт обычный срок
    assert client.delete(f"/projects/{pid}", headers=h).status_code == 200
    db.expire_all()
    row = db.get(InboxDrawing, uuid.UUID(d["id"]))
    assert row.project_id is None and row.expires_at > utcnow() + timedelta(days=89)
    assert db.get(Project, uuid.UUID(pid)).deleted_at is not None


def test_deleted_drawing_leaves_project_without_source(api, client):
    h = api.login(A)
    d = upload(client, h, kitchen_package()).json()
    pid = make(client, h, drawing_id=d["id"]).json()["project_id"]
    assert client.delete(f"/inbox/drawings/{d['id']}", headers=h).status_code == 200
    assert client.get(f"/projects/{pid}", headers=h).json()["source_drawing"] is None
    assert client.get(f"/projects/{pid}/source-drawing", headers=h).status_code == 404


def test_sheet_text_is_compact_on_big_sheets():
    chains = [{"dir": "h", "values": f"{600 + i} ×{i + 2}", "sum": 6000 + i} for i in range(40)]
    ds = {"dimensions": {"chains": chains, "single": [{"mm": i} for i in range(200)]},
          "texts": [f"Надпись номер {i} " * 5 for i in range(100)], "titles": ["Вид А" * 40] * 5}
    text = inbox_project.sheet_text("Цех", {"id": "s1", "number": "1", "name": "План"}, ds, None)
    assert len(text) <= inbox_project.MAX_TEXT
    assert text.count("×") <= 40 and "Габариты: 6039." in text


def test_text_uses_single_dimensions_from_dwg():
    """Отдельные размеры Eskiz DWG ({"v": 2400, "dir": "v"}) попадают в текст и в габариты."""
    ds = {"id": "s1", "name": "Шкаф", "dimensions": {
        "chains": [{"dir": "h", "values": "600 ×2", "sum": 1200}, {"dir": "v", "values": "200 ×3", "sum": 600}],
        "single": [{"v": 1200, "dir": "h"}, {"v": 618, "dir": "h"}, {"v": 2400, "dir": "v"}, {"v": 70, "dir": "v"}]}}
    text = inbox_project.sheet_text("Шкаф", {"id": "s1", "name": "Шкаф"}, ds, None, "ru")
    assert "Габариты: 1200 × 2400." in text
    assert "Размеры: 1200, 618, 2400, 70." in text
