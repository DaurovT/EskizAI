from datetime import timedelta

import pytest

from sqlalchemy import select

from mebel_api.models import Project, ShareEvent, ShareLink
from mebel_api.services.visibility import find_forbidden_client_keys

from .conftest import ADMIN, CORE_FIXTURES, load_tree

# Что не должно попасть клиенту ни при каких условиях (раздел 7 PRD, NFR-10)
FORBIDDEN_SUBSTRINGS = ("cost", "markup", "supplier", "commission", "sku", "margin")


def make_link(api, client, h, **body):
    pid = api.project(h)
    api.advance(h, pid, "sketch")
    r = client.post(f"/projects/{pid}/share-links", json=body, headers=h)
    assert r.status_code == 201, r.text
    return pid, r.json()


def assert_client_safe(payload: dict):
    assert find_forbidden_client_keys(payload) == []
    keys: list[str] = []

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                keys.append(k.lower())
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(payload)
    for k in keys:
        assert not any(s in k for s in FORBIDDEN_SUBSTRINGS), k


def test_share_link_moves_sketch_to_sent(api, client, owner):
    pid, link = make_link(api, client, owner, language="uz", estimate_view="short", show_price=False)
    assert link["url"].endswith(link["token"])
    assert link["language"] == "uz" and link["estimate_view"] == "short" and link["show_price"] is False
    assert client.get(f"/projects/{pid}", headers=owner).json()["status"] == "sent"
    # повторная ссылка статус не меняет
    assert client.post(f"/projects/{pid}/share-links", json={}, headers=owner).status_code == 201
    assert client.get(f"/projects/{pid}", headers=owner).json()["status"] == "sent"
    assert len(client.get(f"/projects/{pid}/share-links", headers=owner).json()) == 2


def test_default_view_comes_from_workshop(api, client, owner):
    client.patch("/workshops/me/pricing", json={"default_estimate_view": "detailed"}, headers=owner)
    _, link = make_link(api, client, owner)
    assert link["estimate_view"] == "detailed"


def test_public_share_returns_only_client_safe_data(api, client, owner):
    client.patch("/workshops/me", json={"name": "Цех Бахтиёра", "phone": "+998901112233"}, headers=owner)
    client.patch("/auth/me", json={"name": "Бахтиёр"}, headers=owner)
    client.patch("/workshops/me/pricing", json={"markup_body": 15, "labor_percent": 60}, headers=owner)
    _, link = make_link(api, client, owner, estimate_view="detailed")

    r = client.get(f"/share/{link['token']}")  # без токена входа
    assert r.status_code == 200
    data = r.json()
    assert data["master"] == {"name": "Бахтиёр", "workshop": "Цех Бахтиёра", "city": "Ташкент", "phone": "+998901112233"}
    est = data["estimate"]
    assert est["view"] == "detailed" and est["exact"] is False
    assert est["total"]["from"] < est["total"]["to"]  # до замера — диапазон
    assert est["groups"] and est["materials"] and est["work"]
    assert data["priceDate"]
    assert data["model"]["parts"]
    assert "issues" not in data["model"]  # замечания — для мастера, не для клиента
    assert_client_safe(data)


def test_price_snapshot_is_sanitized_before_reaching_client(api, client, owner, db):
    """Даже если в снимок сметы попадут внутренние поля, клиент их не увидит."""
    _, link = make_link(api, client, owner, estimate_view="short")
    row = db.scalar(select(ShareLink).where(ShareLink.token == link["token"]))
    row.price_snapshot = {
        "view": "short", "exact": False,
        "total": {"from": 9_800_000, "to": 11_200_000},
        "materials": {"from": 6_500_000, "to": 7_400_000},
        "work": {"from": 3_300_000, "to": 3_800_000},
        "cost_materials": {"from": 5_000_000, "to": 6_000_000},
        "markup_percent": 15, "supplier": "EMAN", "commission": 3,
        "groups": [{"name": "Листы", "from": 1, "to": 2, "supplier_sku": "X-1", "cost": 1}],
    }
    db.commit()
    data = client.get(f"/share/{link['token']}").json()
    assert data["estimate"]["total"] == {"from": 9_800_000, "to": 11_200_000}
    assert data["estimate"]["materials"]["from"] == 6_500_000
    assert_client_safe(data)


def test_hidden_price_hides_estimate(api, client, owner, db):
    _, link = make_link(api, client, owner, show_price=False)
    row = db.scalar(select(ShareLink).where(ShareLink.token == link["token"]))
    assert row.price_snapshot is not None  # снимок есть, но клиенту не отдаётся
    data = client.get(f"/share/{link['token']}").json()
    assert data["estimate"] is None and data["priceDate"] is None


def test_share_link_pins_version(api, client, owner):
    pid, link = make_link(api, client, owner)
    width_before = client.get(f"/share/{link['token']}").json()["model"]["size"][0]
    tree = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["tree"]
    client.post(f"/projects/{pid}/model", json={"tree": {**tree, "width": 1500}}, headers=owner)
    assert client.get(f"/share/{link['token']}").json()["model"]["size"][0] == width_before


def test_share_keeps_price_snapshot_after_price_change(api, client, owner):
    """Раздел 19 PRD: цена изменилась после отправки — ссылка показывает старую цену с датой."""
    _, link = make_link(api, client, owner, estimate_view="short")
    before = client.get(f"/share/{link['token']}").json()
    client.patch("/workshops/me/pricing", json={"labor_percent": 200}, headers=owner)
    after = client.get(f"/share/{link['token']}").json()
    assert after["estimate"] == before["estimate"]
    assert after["priceDate"] == before["priceDate"]


def test_logo_only_on_pro(api, client, owner):
    client.patch("/workshops/me", json={"logo_url": "https://cdn.example/logo.png"}, headers=owner)
    _, link = make_link(api, client, owner)
    assert client.get(f"/share/{link['token']}").json()["master"].get("logoUrl") is None
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    client.post(f"/admin/workshops/{wid}/plan", json={"plan": "pro"}, headers=ADMIN)
    assert client.get(f"/share/{link['token']}").json()["master"]["logoUrl"] == "https://cdn.example/logo.png"


def test_expired_revoked_and_unknown_links(api, client, owner, db):
    pid, link = make_link(api, client, owner)
    assert client.get("/share/nope").status_code == 404
    row = db.scalar(select(ShareLink).where(ShareLink.token == link["token"]))
    row.expires_at = row.expires_at - timedelta(days=365)
    db.commit()
    r = client.get(f"/share/{link['token']}")
    assert r.status_code == 410 and "устарела" in r.json()["error"]["message"]

    r = client.post(f"/projects/{pid}/share-links", json={}, headers=owner).json()
    assert client.delete(f"/projects/{pid}/share-links/{r['id']}", headers=owner).status_code == 200
    assert client.get(f"/share/{r['token']}").status_code == 410
    assert client.post(f"/share/{r['token']}/events", json={"kind": "opened"}).status_code == 410


def test_events_are_counted_and_agreed_marks_project(api, client, owner, db):
    pid, link = make_link(api, client, owner)
    t = link["token"]
    for kind in ("opened", "opened", "ar_started", "ar_failed"):
        r = client.post(f"/share/{t}/events", json={"event": kind, "at": "2026-11-02T10:00:00Z",
                                                     "meta": {"device": "iPhone"}})
        assert r.status_code == 204
    r = client.post(f"/share/{t}/events", json={"kind": "agreed"})  # прежний формат тоже принимается
    assert r.status_code == 204
    stats = client.get(f"/projects/{pid}/share-links", headers=owner).json()[0]
    assert (stats["views"], stats["ar_starts"], stats["ar_failures"]) == (2, 1, 1)
    assert stats["first_opened_at"] and stats["agreed_at"]
    card = client.get(f"/projects/{pid}", headers=owner).json()
    assert card["client_agreed_at"]  # «клиент согласовал» с датой
    assert client.get(f"/share/{t}").json()["agreedAt"]
    assert len(db.scalars(select(ShareEvent)).all()) == 5
    assert client.post(f"/share/{t}/events", json={"kind": "hacked"}).status_code == 422
    big = {"x": "a" * 5000}
    assert client.post(f"/share/{t}/events", json={"kind": "opened", "meta": big}).status_code == 422


def test_employee_can_send_only_allowed_views(api, client, owner):
    emp = api.employee(owner, "+998935550000")
    pid = api.project(emp)
    api.advance(emp, pid, "sketch")
    r = client.post(f"/projects/{pid}/share-links", json={"estimate_view": "detailed"}, headers=emp)
    assert r.status_code == 403
    assert "«Только итог»" in r.json()["error"]["message"]
    assert client.post(f"/projects/{pid}/share-links", json={"estimate_view": "total"}, headers=emp).status_code == 201
    client.patch("/workshops/me/pricing", json={"employee_estimate_views": ["total", "short"]}, headers=owner)
    assert client.post(f"/projects/{pid}/share-links", json={"estimate_view": "short"}, headers=emp).status_code == 201


def test_deleted_project_link_stops_working(api, client, owner, db):
    pid, link = make_link(api, client, owner)
    client.delete(f"/projects/{pid}", headers=owner)
    assert client.get(f"/share/{link['token']}").status_code == 410


@pytest.mark.parametrize("fixture", ["wardrobe_full", "kupe_3doors", "wardrobe_3sec_niche"])
@pytest.mark.parametrize("view", ["total", "short", "detailed"])
def test_share_is_client_safe_for_real_models(api, client, owner, fixture, view):
    path = CORE_FIXTURES / f"{fixture}.json"
    if not path.exists():
        pytest.skip(f"нет фикстуры ядра {fixture}")
    client.patch("/workshops/me/pricing", json={"markup_body": 20, "markup_hardware": 30}, headers=owner)
    pid = api.project(owner, tree=load_tree(fixture))
    api.advance(owner, pid, "sketch")
    link = client.post(f"/projects/{pid}/share-links", json={"estimate_view": view}, headers=owner).json()
    data = client.get(f"/share/{link['token']}").json()
    assert data["estimate"]["view"] == view
    assert_client_safe(data)


def _check_share_payload(d: dict) -> None:
    """Форма SharePayload из web/src/lib/share-types.ts."""
    required = {"version", "token", "lang", "expiresAt", "agreedAt", "project", "master", "model", "glb",
                "estimate", "priceDate"}
    assert set(d) == required, set(d) ^ required
    assert d["version"] == 1 and d["lang"] in ("ru", "uz") and isinstance(d["token"], str)
    assert d["agreedAt"] is None or isinstance(d["agreedAt"], str)
    assert isinstance(d["expiresAt"], str)
    p = d["project"]
    assert set(p) == {"title", "sizeMm", "modelVersion"} and set(p["title"]) == {"ru", "uz"}
    assert len(p["sizeMm"]) == 3 and all(isinstance(x, (int, float)) for x in p["sizeMm"])
    assert isinstance(p["modelVersion"], str)
    m = d["master"]
    assert {"name", "phone"} <= set(m) <= {"name", "workshop", "city", "phone", "telegram", "logoUrl"}
    assert m["phone"].startswith("+998")
    assert d["model"]["format"] == "1" and d["model"]["parts"]
    assert set(d["glb"]) <= {"closed", "open", "closedUsdz", "openUsdz"} and {"closed", "open"} <= set(d["glb"])
    e = d["estimate"]
    if e is not None:
        assert e["view"] in ("total", "short", "detailed") and isinstance(e["exact"], bool)
        assert set(e["total"]) == {"from", "to"}
        if e["view"] != "total":
            assert set(e["materials"]) == {"from", "to"} and set(e["work"]) == {"from", "to"}
        if e["view"] == "detailed":
            assert all({"name", "from", "to"} <= set(g) for g in e["groups"])
            assert all({"name", "note"} <= set(r) for r in e["requests"])


@pytest.mark.parametrize("view", ["total", "short", "detailed"])
def test_share_response_matches_web_share_payload(api, client, owner, view):
    _, link = make_link(api, client, owner, estimate_view=view)
    d = client.get(f"/share/{link['token']}").json()
    _check_share_payload(d)
    assert d["token"] == link["token"] and d["estimate"]["view"] == view
    assert link["url"].endswith(f"/p/{link['token']}")  # страница клиента в web — /p/{token}
    glb = client.get(d["glb"]["open"].removeprefix("http://localhost:8000"))
    assert glb.status_code == 200 and glb.content[:4] == b"glTF"
    assert glb.headers["content-type"] == "model/gltf-binary"


def test_share_agree_endpoint(api, client, owner):
    pid, link = make_link(api, client, owner)
    r = client.post(f"/share/{link['token']}/agree")
    assert r.status_code == 200 and r.json()["agreedAt"]
    again = client.post(f"/share/{link['token']}/agree").json()
    assert again["agreedAt"] == r.json()["agreedAt"]
    assert client.get(f"/projects/{pid}", headers=owner).json()["client_agreed_at"]
    _check_share_payload(client.get(f"/share/{link['token']}").json())
    assert client.post("/share/nope/agree").status_code == 404


def test_expired_link_returns_master_contacts(api, client, db, owner):
    """WEB-3: на «ссылка устарела / отозвана» — контакты мастера в details.master."""
    from datetime import timedelta
    from mebel_api.models import ShareLink
    from mebel_api.db import utcnow
    _, link = make_link(api, client, owner)
    row = db.query(ShareLink).filter_by(token=link["token"]).one()
    row.expires_at = utcnow() - timedelta(days=1)
    db.commit()
    r = client.get(f"/share/{link['token']}")
    assert r.status_code == 410 and r.json()["error"]["code"] == "share_expired"
    assert {"name", "phone", "city"} <= set(r.json()["error"]["details"]["master"])
