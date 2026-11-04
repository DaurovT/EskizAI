"""Диапазон до замера: ожидаемая цена ± 3–8 %, пояснение «оценка: …»; после замера — точная цена."""

import uuid

from mebel_api.models import ModelVersion
from mebel_api.services.visibility import find_forbidden_client_keys


def _set_estimated(app, client, owner, pid, pointers):
    vid = client.get(f"/projects/{pid}", headers=owner).json()["current_version_id"]
    with app.state.db.sessionmaker() as s:
        v = s.get(ModelVersion, uuid.UUID(vid))
        v.estimated = pointers
        s.commit()


def test_staff_estimate_has_narrow_band_and_explanation(api, client, owner):
    pid = api.project(owner)
    est = client.get(f"/projects/{pid}", headers=owner).json()["estimate"]
    lo, hi, mid = est["total"]["from"], est["total"]["to"], est["expected"]
    assert est["exact"] is False and lo < mid < hi
    assert 3 <= est["band_percent"] <= 8 and (hi - lo) / mid <= 0.17
    assert est["uncertainty_text"].startswith("оценка: размеры") and est["uncertainty_text_uz"].startswith("taxminiy:")
    assert est["uncertainty"][0] == {"category": "sizes", "name": "размеры", "name_uz": "o‘lchamlar",
                                     "reason": "уточнятся на замере", "reason_uz": "o‘lchovda aniqlanadi"}
    assert est["cost_materials"]["from"] < est["cost_materials"]["to"]
    # список проектов — та же цена
    item = client.get("/projects", headers=owner).json()["items"][0]
    assert item["price"] == est["total"]


def test_photo_sizes_widen_band(app, api, client, owner):
    pid = api.project(owner)
    before = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    _set_estimated(app, client, owner, pid, ["/width", "/height", "/depth"])
    after = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert after["expected"] == before["expected"]
    assert before["band_percent"] < after["band_percent"] <= 8
    assert after["uncertainty"][0]["reason"] == "размеры по фото, уточнятся на замере"


def test_exact_after_measurement(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "measured")
    est = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert est["exact"] is True and est["total"]["from"] == est["total"]["to"] == est["expected"]
    assert est["band_percent"] == 0 and est["uncertainty"] == [] and est["uncertainty_text"] == ""


def test_client_preview_and_share_payload(app, api, client, owner):
    pid = api.project(owner)
    _set_estimated(app, client, owner, pid, ["/width", "/fronts/material"])
    prev = client.get(f"/projects/{pid}/estimate/client?view=detailed", headers=owner).json()
    assert prev["uncertainty_text"].startswith("оценка:") and prev["uncertainty"]
    client.post(f"/projects/{pid}/sketch", headers=owner)
    link = client.post(f"/projects/{pid}/share-links", json={"estimate_view": "total", "language": "uz"},
                       headers=owner).json()
    payload = client.get(f"/share/{link['token']}").json()
    est = payload["estimate"]
    assert est["exact"] is False and est["total"]["from"] < est["total"]["to"]
    assert est["total"]["from"] % 10_000 == 0 and est["total"]["to"] % 10_000 == 0  # чистые суммы
    assert est["uncertainty_text_uz"].startswith("taxminiy:")
    assert find_forbidden_client_keys(payload) == []
