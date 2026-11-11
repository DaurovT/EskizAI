"""AR (docs/ar_contract.md): USDZ ссылки клиента, ссылки мастера /projects/{id}/ar, /ar-files, кэш файлов."""

import io
import uuid
import zipfile
from datetime import timedelta

import pytest

from mebel_api.services import ar_files

from .conftest import load_tree, make_settings

BASE = "http://localhost:8000"


@pytest.fixture
def settings(tmp_path):
    # текстуры декоров — во временной папке, не в api/static/textures
    return make_settings(tmp_path, textures_dir=tmp_path / "textures")


def _share(api, client, h, tree=None):
    pid = api.project(h, tree=tree or load_tree("wardrobe_2sec"))
    api.advance(h, pid, "sketch")
    link = client.post(f"/projects/{pid}/share-links", json={}, headers=h).json()
    return pid, link, client.get(f"/share/{link['token']}").json()


@pytest.fixture
def builds(monkeypatch):
    """Сколько раз ядро собирало файлы AR (кэш: повторный запрос не пересобирает)."""
    calls: list[tuple[str, str]] = []
    real = ar_files._build

    def counting(version, state, fmt, settings):
        calls.append((state, fmt))
        return real(version, state, fmt, settings)

    monkeypatch.setattr(ar_files, "_build", counting)
    return calls


def test_share_payload_has_usdz_and_placement(api, client, owner):
    _, link, d = _share(api, client, owner)
    assert d["glb"]["closedUsdz"] == f"{BASE}/share/{link['token']}/usdz/closed"
    assert d["glb"]["placement"] == "floor"
    assert d["model"]["placement"] == "floor"


def test_share_usdz_is_public_and_cached(api, client, owner, builds):
    _, link, d = _share(api, client, owner)
    url = d["glb"]["closedUsdz"].removeprefix(BASE)
    r = client.get(url)  # без входа
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "model/vnd.usdz+zip"
    assert r.headers["content-disposition"].startswith("inline")
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        assert z.namelist()[0] == "model.usda"
    assert client.get(url).content == r.content
    assert builds == [("closed", "usdz")]  # второй раз — из кэша
    # GLB тоже кэшируется по состоянию
    for _ in range(2):
        g = client.get(d["glb"]["closed"].removeprefix(BASE))
        assert g.status_code == 200 and g.content[:4] == b"glTF"
    assert builds == [("closed", "usdz"), ("closed", "glb")]
    assert client.get(f"/share/{link['token']}/usdz/open").status_code == 404


def test_share_usdz_respects_revoked_link(api, client, owner):
    pid, link, d = _share(api, client, owner)
    client.delete(f"/projects/{pid}/share-links/{link['id']}", headers=owner)
    assert client.get(d["glb"]["closedUsdz"].removeprefix(BASE)).status_code == 410
    assert client.get("/share/nope/usdz/closed").status_code == 404


def test_project_ar_returns_signed_links(api, client, owner, builds):
    pid = api.project(owner, tree=load_tree("wardrobe_full"))
    r = client.get(f"/projects/{pid}/ar", headers=owner)
    assert r.status_code == 200, r.text
    d = r.json()
    card = client.get(f"/projects/{pid}", headers=owner).json()
    assert set(d) == {"version_id", "version_number", "size_mm", "placement", "glb_url", "usdz_url", "expires_at"}
    assert d["version_number"] == 1 and d["placement"] == "floor"
    assert d["size_mm"] == [1800, 600, 2400]  # ширина × глубина × высота
    assert d["glb_url"].startswith(f"{BASE}/ar-files/") and d["glb_url"].endswith(".glb")
    assert d["usdz_url"].startswith(f"{BASE}/ar-files/") and d["usdz_url"].endswith(".usdz")
    assert builds == []  # ссылки выдаются сразу, файлы строятся при скачивании
    assert card["id"] == pid

    g = client.get(d["glb_url"].removeprefix(BASE))  # без токена входа
    assert g.status_code == 200 and g.content[:4] == b"glTF"
    assert g.headers["content-type"] == "model/gltf-binary"
    assert g.headers["content-disposition"].startswith("inline")
    u = client.get(d["usdz_url"].removeprefix(BASE))
    assert u.status_code == 200 and u.headers["content-type"] == "model/vnd.usdz+zip"
    assert u.headers["content-disposition"].startswith("inline") and u.content[:2] == b"PK"
    client.get(d["usdz_url"].removeprefix(BASE))
    assert builds == [("closed", "glb"), ("closed", "usdz")]


def test_project_ar_uses_current_version(api, client, owner):
    pid = api.project(owner)
    tree = load_tree("wardrobe_2sec")
    tree["width"] = tree["width"] - 100
    assert client.post(f"/projects/{pid}/model", json={"tree": tree}, headers=owner).status_code == 201
    d = client.get(f"/projects/{pid}/ar", headers=owner).json()
    assert d["version_number"] == 2 and d["size_mm"][0] == tree["width"]


def test_project_ar_no_model_and_access(api, client, owner):
    empty = api.project(owner, tree=None)
    r = client.get(f"/projects/{empty}/ar", headers=owner)
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_model"
    pid = api.project(owner)
    assert client.get(f"/projects/{pid}/ar").status_code == 401
    other = api.login("+998907777777")
    assert client.get(f"/projects/{pid}/ar", headers=other).status_code == 404
    assert client.get(f"/projects/{uuid.uuid4()}/ar", headers=owner).status_code == 404


def test_ar_files_reject_forged_foreign_and_expired(api, client, owner, settings, monkeypatch):
    pid = api.project(owner)
    d = client.get(f"/projects/{pid}/ar", headers=owner).json()
    glb = d["glb_url"].removeprefix(BASE)
    token = glb.removeprefix("/ar-files/").removesuffix(".glb")
    # не тот формат и подделка
    assert client.get(f"/ar-files/{token}.usdz").status_code == 404
    assert client.get(f"/ar-files/{token[:-2]}xx.glb").status_code == 404
    # токен другой подписанной ссылки (вложения) сюда не подходит
    from mebel_api.services.signed_files import make_token

    foreign = make_token(settings, {"key": "private/attachments/x.png", "name": "x.png"})
    assert client.get(f"/ar-files/{foreign}.glb").status_code == 404
    # ссылка живёт час
    from mebel_api.services import signed_files

    later = signed_files.utcnow() + timedelta(hours=1, minutes=1)
    monkeypatch.setattr(signed_files, "utcnow", lambda: later)
    r = client.get(glb)
    assert r.status_code == 410 and r.json()["error"]["code"] == "link_expired"


def test_ar_files_stop_after_project_deleted(api, client, owner):
    pid = api.project(owner)
    d = client.get(f"/projects/{pid}/ar", headers=owner).json()
    assert client.delete(f"/projects/{pid}", headers=owner).status_code in (200, 204)
    assert client.get(d["usdz_url"].removeprefix(BASE)).status_code == 404


def test_expires_at_is_one_hour(api, client, owner):
    from datetime import datetime

    pid = api.project(owner)
    d = client.get(f"/projects/{pid}/ar", headers=owner).json()
    exp = datetime.fromisoformat(d["expires_at"])
    left = exp - ar_files.utcnow()
    assert timedelta(minutes=59) < left <= timedelta(hours=1)


def test_wall_placement_from_viewer_and_legacy_versions(api, client, owner, db):
    from mebel_api.models import ModelVersion

    pid = api.project(owner)
    v = db.query(ModelVersion).filter(ModelVersion.project_id == uuid.UUID(pid)).one()
    # навесное — из снимка 3D
    v.viewer = {**v.viewer, "placement": "wall"}
    db.commit()
    assert client.get(f"/projects/{pid}/ar", headers=owner).json()["placement"] == "wall"
    # старая версия без поля — ядро считает по модели
    v.viewer = {k: x for k, x in v.viewer.items() if k != "placement"}
    db.commit()
    assert client.get(f"/projects/{pid}/ar", headers=owner).json()["placement"] == "floor"


def test_usdz_uses_decor_textures(api, client, owner, settings, tmp_path):
    """Текстура декора берётся из TEXTURES_DIR и кладётся в USDZ (≤ 1024 px)."""
    from mebel_core.catalog import DECOR_MATERIALS
    from PIL import Image

    decor = next(m for m in DECOR_MATERIALS.values() if m.texture and m.kind == "ldsp" and m.thickness == 160)
    settings.textures_dir.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    Image.new("RGB", (1600, 480), (150, 110, 70)).save(buf, "JPEG")
    (settings.textures_dir / decor.texture.rsplit("/", 1)[-1]).write_bytes(buf.getvalue())
    tree = load_tree("wardrobe_2sec")
    tree["body"]["material"] = decor.id
    pid = api.project(owner, tree=tree)
    d = client.get(f"/projects/{pid}/ar", headers=owner).json()
    u = client.get(d["usdz_url"].removeprefix(BASE))
    assert u.status_code == 200, u.text
    with zipfile.ZipFile(io.BytesIO(u.content)) as z:
        tex = [n for n in z.namelist() if n.startswith("textures/")]
        assert len(tex) == 1
        assert max(Image.open(io.BytesIO(z.read(tex[0]))).size) <= 1024
