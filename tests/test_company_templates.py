"""Свои шаблоны цеха (shapes_contract.md §9.7): сохранить изделие, увидеть первым в /oyna/templates, создать позицию, удалить."""
import pytest

from tests.test_store import ADMIN, client  # noqa: F401

pytestmark = pytest.mark.skipif(not ADMIN, reason="OYNA_TEST_DSN не задан")


def test_company_templates_flow(client):
    doc = client.post("/oyna/positions/from-template", json={"template": "T41", "room": "Зал"}).json()["doc"]
    doc = client.post("/oyna/positions/commands", json={"doc": doc, "commands": [
        {"cmd": "set_setup", "lam_out": "golden_oak"},
        {"cmd": "set_custom_lines", "lines": [{"name": "Подъём", "qty": 1, "price_sum": 50000}]}]}).json()["doc"]
    r = client.post("/oyna/company/templates", json={"name": "Наше окно с раскладкой", "short": "Наше 2×3", "doc": doc})
    assert r.status_code == 200, r.text
    own = r.json()
    assert own["own"] and own["category"] == "window" and own["short"] == "Наше 2×3" and own["ready"]
    assert "room" not in own["doc"]
    rows = client.get("/oyna/templates").json()
    assert rows[0]["id"] == own["id"] and rows[0]["own"] and any(x["id"] == "T01" for x in rows)
    assert [x["id"] for x in client.get("/oyna/company/templates").json()] == [own["id"]]
    p = client.post("/oyna/positions/from-template", json={"template": own["id"], "w": 1600, "room": "Кухня"}).json()
    assert p["doc"]["frame"]["w"] == 1600 and p["doc"]["setup"]["lam_out"] == "golden_oak" and p["doc"]["custom_lines"]
    assert p["doc"]["frame"]["root"]["parts"][0]["cell"]["muntins"]["pattern"] == "grid" and p["result"]["can_quote"]
    bad = client.post("/oyna/company/templates", json={"name": "x", "category": "space", "doc": doc})
    assert bad.status_code == 422
    assert client.post("/oyna/company/templates", json={"name": "x", "doc": doc}, headers={"X-Role": "installer"}).status_code == 403
    assert client.delete(f"/oyna/company/templates/{own['id']}").json()["ok"]
    assert client.delete(f"/oyna/company/templates/{own['id']}").status_code == 404
    assert not any(x.get("own") for x in client.get("/oyna/templates").json())
