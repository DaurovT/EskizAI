"""HTTP-слой: основные сценарии экранов S05–S10 через API."""
from fastapi.testclient import TestClient

from oyna_api.app import app

c = TestClient(app)


def test_health():
    r = c.get("/health").json()
    assert r["ok"] and r["systems"] == 57


def test_measure_flow_to_position_and_calc():
    m = c.post("/oyna/measure/frame", json={"widths": [1440, 1446, 1452], "heights": [1340, 1338, 1351]}).json()
    assert m["ok"] and m["frame_w"] == 1400 and any(i["code"] == "M.skew" for i in m["issues"])
    p = c.post("/oyna/positions/from-template", json={"template": "T03", "w": m["frame_w"], "h": m["frame_h"], "room": "Кухня"}).json()
    doc = p["doc"]
    r = c.post("/oyna/positions/commands", json={"doc": doc, "commands": [
        {"cmd": "set_extras", "sill": {"depth_cm": 30}, "drip": True, "slopes": True}]}).json()
    calc = c.post("/oyna/positions/calc", json={"doc": r["doc"]}).json()
    assert calc["can_quote"] and calc["price"]["total"] > 0 and calc["price"]["demo"]
    kinds = {l["kind"] for l in calc["bom"]}
    assert {"profile", "glass", "fitting", "sill", "work"} <= kinds


def test_measurer_does_not_see_cost():
    doc = c.post("/oyna/positions/from-template", json={"template": "T01"}).json()["doc"]
    r = c.post("/oyna/positions/calc", json={"doc": doc}, headers={"X-Role": "measurer"}).json()
    assert "cost" not in r["price"] and "materials" not in r["price"]
    assert c.post("/oyna/orders/cutting", json={"positions": [doc]}, headers={"X-Role": "measurer"}).status_code == 403


def test_real_company_blocks_quote_without_prices():
    doc = c.post("/oyna/positions/from-template", json={"template": "T01"}).json()["doc"]
    r = c.post("/oyna/positions/calc", json={"doc": doc}, headers={"X-Company": "real"}).json()
    assert not r["can_quote"] and any(v["code"] == "P.1" for v in r["violations"])


def test_typo_check():
    assert c.get("/oyna/measure/check", params={"value": 14400}).json()["issues"][0]["code"] == "1.2"
    assert c.get("/oyna/measure/check", params={"value": 144}).json()["issues"][0]["code"] == "1.7"


def test_glass_parse_and_system_fit():
    ok = c.post("/oyna/glass/parse", json={"formula": "6t-14-4i", "system": "akfa__7000_akfa_eko"}).json()
    assert ok["ok"] and ok["fits_system"] and ok["price_sum_m2"] == 495000
    no = c.post("/oyna/glass/parse", json={"formula": "6t-14-4i", "system": "akfa__6000_qvt"}).json()
    assert no["code"] == "4.6"
    bad = c.post("/oyna/glass/parse", json={"formula": "4-40-4"}).json()
    assert not bad["ok"] and bad["code"] == "4.9"


def test_render_svg():
    doc = c.post("/oyna/positions/from-template", json={"template": "T07"}).json()["doc"]
    r = c.post("/oyna/positions/render.svg", json={"doc": doc})
    assert r.headers["content-type"].startswith("image/svg+xml") and "<svg" in r.text


def test_alternatives_and_catalogs():
    doc = c.post("/oyna/positions/from-template", json={"template": "T01"}).json()["doc"]
    a = c.post("/oyna/positions/alternatives", json={"doc": doc, "what": "option:handle", "path": ""}).json()
    assert len(a["options"]) == 7                    # 5 ручек + с ключом и с кнопкой (shapes_contract.md §9.6)
    assert {"fornax", "generic", "maco_mm"} == {f["code"] for f in c.get("/oyna/fitting-sets", params={"system": "akfa__6000_qvt"}).json()}
    dec = {d["id"]: d for d in c.get("/oyna/decors", params={"system": "akfa__6000_qvt"}).json()}
    assert dec["white"]["available"] and not dec["ral_any"]["available"]


def test_quote_variants_and_cutting():
    docs = [c.post("/oyna/positions/from-template", json={"template": t}).json()["doc"] for t in ("T03", "T01")]
    v = c.post("/oyna/orders/quote-variants", json={"positions": docs}).json()
    assert len(v) == 3 and v[0]["total"] < v[2]["total"]
    cut = c.post("/oyna/orders/cutting", json={"positions": docs}).json()
    assert cut["items"] and cut["profile_cost_whole_bars"] > 0
