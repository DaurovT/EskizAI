"""Второй этап гибкости (docs/shapes_contract.md §9.1–9.6, 9.7 — свои строки): двери и порталы, сетки,
дополнительные профили, встроенное, лоджия, опции фурнитуры, стекло, уплотнитель и штапик."""
import pytest

from oyna_core import Catalog, Company, calc, commands, validate
from oyna_core.alternatives import alternatives
from oyna_core.commands import CommandError
from oyna_core.glass import parse, price_m2
from oyna_core.render import render_svg

CAT = Catalog()
DEMO = Company.demo()


def t(tid, w=None, h=None, **kw):
    return commands.create_from_template(CAT, tid, w, h, **kw)


def codes(res, sev=None):
    return {v["code"] for v in res["violations"] if sev is None or v["severity"] == sev}


def bom(res, code):
    return [l for l in res["bom"] if l.get("code") == code]


# ---------- 9.1 двери и порталы ----------
def test_door_out_and_low_threshold():
    d = commands.set_cell(t("T11"), "", open_dir="out", threshold="low_alu")
    r = calc(d, CAT, DEMO)
    assert r["can_quote"] and bom(r, "fit_door_out") and bom(r, "threshold_alu")[0]["unit"] == "m"
    assert "наружу" in render_svg(d, CAT, DEMO)
    assert not bom(calc(t("T11"), CAT, DEMO), "fit_door_out")
    with pytest.raises(CommandError):
        commands.set_cell(t("T11"), "", open_dir="up")


def test_folding_door_kit_per_leaf():
    r = calc(t("T52"), CAT, DEMO)
    assert r["can_quote"] and len(bom(r, "fit_folding")) == 4 and not r["geometry"]["mullions"]
    d = commands.split(commands.set_cell(t("T02", 2400, 2100), "", type="door_sash", open="turn"), "", "folding", 3)
    assert [p["cell"]["open"] for p in d["frame"]["root"]["parts"]] == ["folding"] * 3
    assert len(bom(calc(d, CAT, DEMO), "fit_folding")) == 3


def test_psk_weight_rule_320():
    r = calc(t("T51"), CAT, DEMO)
    assert r["can_quote"] and bom(r, "fit_psk")
    big = commands.set_setup(t("T51", 3000, 2400), system="akfa__7000_akfa_eko", glass="g4_16_4")
    assert "3.20" not in codes(validate(commands.set_fill(big, "0", {"kind": "glass", "glass": "8-12-8"}), CAT))
    heavy = commands.set_fill(big, "0", {"kind": "glass", "glass": "12-8-10"})      # ~163 кг
    assert "3.20" in codes(validate(heavy, CAT), "block")


def test_hs_needs_system_flag_720():
    r = calc(t("T30"), CAT, DEMO)
    assert r["can_quote"] and bom(r, "fit_hs") and bom(r, "threshold_hs")
    no = commands.set_setup(t("T30"), system="akfa__6000_qvt", glass="g4_12_4")
    v = [x for x in validate(no, CAT)["violations"] if x["code"] == "7.20"]
    assert v and v[0]["severity"] == "lock"


@pytest.mark.parametrize("tid", ["T53", "T54", "T55"])
def test_aluminium_entrance_groups(tid):
    d = t(tid)
    assert CAT.material(d["setup"]["system"]).startswith("alu")
    r = calc(d, CAT, DEMO)
    assert r["can_quote"] and not codes(r, "block") and r["price"]["total"] > 0
    assert r["setup"]["fittings"] in ("alu_tr_a3400", "alu_uz")


# ---------- 9.2 москитные сетки ----------
def test_mosquito_types_and_rule_922():
    r = calc(t("T01"), CAT, DEMO)                                  # mosquito: true → рамочная
    line = bom(r, "mosq_frame")[0]
    sash = r["geometry"]["cells"][0]["sash"]
    assert line["qty"] == pytest.approx(sash[0] * sash[1] / 1e6, abs=0.001) and line["unit"] == "m2"
    pl = commands.set_cell(t("T01"), "", mosquito={"type": "pleated"})
    rp = calc(pl, CAT, DEMO)
    assert bom(rp, "mosq_pleated") and "9.22" in codes(rp, "warn")
    door = calc(commands.set_cell(t("T24"), "", mosquito={"type": "door"}), CAT, DEMO)
    assert bom(door, "mosq_door")[0]["unit"] == "pcs" and "9.22" not in codes(door)
    with pytest.raises(CommandError):
        commands.set_cell(t("T01"), "", mosquito={"type": "steel"})


# ---------- 9.3 дополнительные профили ----------
def test_addons_lengths_area_and_rule_923():
    base = calc(t("T03"), CAT, DEMO)
    d = commands.set_addons(t("T03"), [{"type": "extender", "side": "left", "size_mm": 40},
                                       {"type": "base_profile", "side": "bottom"},
                                       {"type": "cover_strip", "side": "all"}])
    r = calc(d, CAT, DEMO)
    ext = bom(r, "addon_extender")[0]
    assert ext["qty"] == pytest.approx(1.3) and ext["unit_price"] == 40000
    assert bom(r, "addon_base")[0]["qty"] == pytest.approx(1.4)
    assert bom(r, "addon_cover")[0]["qty"] == pytest.approx(2 * (1.4 + 1.3))
    assert r["price"]["area_m2"] == pytest.approx((1400 + 40) * (1300 + 30) / 1e6, abs=0.001)
    assert r["price"]["area_m2"] > base["price"]["area_m2"]
    assert "9.23" in codes(r, "warn")                              # слева створка
    right = commands.set_addons(t("T03"), [{"type": "extender", "side": "right", "size_mm": 20}])
    assert "9.23" not in codes(validate(right, CAT))               # справа глухая
    with pytest.raises(CommandError):
        commands.set_addons(t("T03"), [{"type": "extender", "side": "left", "size_mm": 35}])
    assert "addons" not in commands.set_addons(d, [])


# ---------- 9.4 встроенное ----------
def test_vent_shutter_grille():
    d = commands.set_cell(t("T03"), "0", vent={"type": "supply_valve"})
    d = commands.set_shutter(d, {"type": "roller", "control": "electric"})
    d = commands.set_grille(d, {"type": "opening", "pattern": "forged"})
    r = calc(d, CAT, DEMO)
    assert bom(r, "vent_valve")[0]["qty"] == 1
    assert bom(r, "shutter_roller")[0]["qty"] == pytest.approx(1.82) and bom(r, "shutter_motor")
    g = bom(r, "grille")[0]
    assert g["unit_price"] == 700000 and "открывающ" in g["name"]
    assert "рольставня" in render_svg(d, CAT, DEMO)
    blinds = calc(commands.set_shutter(t("T03"), {"type": "blinds"}), CAT, DEMO)
    assert bom(blinds, "shutter_blinds") and not bom(blinds, "shutter_motor")
    assert "shutter" not in commands.set_shutter(d, None)


# ---------- 9.5 лоджия ----------
def test_loggia_lines():
    r = calc(t("T57"), CAT, DEMO)                                 # прямая, вынос 300, крыша, обшивка снаружи
    L = 4.8
    assert bom(r, "loggia_outrigger")[0]["qty"] == pytest.approx(L)
    assert bom(r, "loggia_roof")[0]["qty"] == pytest.approx(L * 0.8)
    assert bom(r, "loggia_cladding")[0]["qty"] == pytest.approx(L * 1.0)
    d = commands.set_loggia(t("T56"), {"outrigger_mm": 0, "roof": False, "cladding": "both", "parapet": "brick"})
    rr = calc(d, CAT, DEMO)
    assert not bom(rr, "loggia_roof") and bom(rr, "loggia_cladding")[0]["qty"] == pytest.approx(3.6 * 2)
    assert {"T15", "T56", "T57"} <= {k for k, v in CAT.templates.items() if v["kind"] == "assembly" and v.get("loggia")}


# ---------- 9.6 опции, стекло, уплотнитель, штапик ----------
@pytest.mark.parametrize("group,code", [("handle", "euro_pvc.tilt_turn.handle_key"), ("handle", "euro_pvc.tilt_turn.handle_lock"),
                                        ("child_lock", "euro_pvc.tilt_turn.child_lock"),
                                        ("micro_vent", "euro_pvc.tilt_turn.micro_vent"),
                                        ("limiter", "euro_pvc.tilt_turn.limiter"), ("comb", "euro_pvc.tilt_turn.comb")])
def test_fitting_options(group, code):
    base = calc(t("T01"), CAT, DEMO)
    assert code not in {l.get("code") for l in base["bom"]}         # по умолчанию «нет»
    r = calc(commands.set_option(t("T01"), group, code), CAT, DEMO)
    assert code in {l.get("code") for l in r["bom"]} and r["price"]["total"] > base["price"]["total"]
    if group != "handle":
        a = alternatives(t("T01"), CAT, DEMO, f"option:{group}", path="")
        assert code in {o["value"] for o in a["options"]}


def test_glass_chips_and_presets():
    base = price_m2(parse("4-16-4i", CAT), CAT)[0]
    warm = parse("4-16artgi-4i", CAT)
    warm.preset = None
    assert warm.spacers[0]["warm"] and warm.spacers[0]["argon"]
    assert price_m2(warm, CAT)[0] == base + 15000 + 25000
    p4a = parse("4.4.4p4a-12-4", CAT)
    assert p4a.panes[0].armored and p4a.panes[0].triplex
    for code in ("g331_8_4", "g4_16ar_4i", "g4_16artgi_4i", "g444p4a_12_4"):
        assert parse(code, CAT).preset == code
    assert parse("g331_8_4", CAT).thickness_mm == pytest.approx(18.4)
    r = validate(commands.set_setup(t("T03"), system="akfa__7000_akfa_eko", glass="g4_16artgi_4i"), CAT)
    assert "4.6" not in codes(r)


def test_seal_color_and_bead_shape():
    d = commands.set_setup(t("T03"), seal_color="grey", bead="profiled")
    r = calc(d, CAT, DEMO)
    assert any("серый" in l["name"] for l in r["bom"] if l["kind"] == "seal")
    assert bom(r, "bead_profiled") and all("фигурный" in l["name"] for l in r["bom"] if l["kind"] == "bead" and l.get("code") != "bead_profiled")
    with pytest.raises(CommandError):
        commands.set_setup(t("T03"), bead="oval")


# ---------- 9.7 своя строка ----------
def test_custom_lines_markup_and_no_markup():
    base = calc(commands.set_extras(t("T03"), install=False), CAT, DEMO)["price"]
    d = commands.set_custom_lines(commands.set_extras(t("T03"), install=False),
                                  [{"name": "Подъём на 9 этаж", "qty": 1, "unit": "pcs", "price_sum": 100000},
                                   {"name": "Доставка за город", "qty": 2, "unit": "pcs", "price_sum": 50000, "no_markup": True}])
    r = calc(d, CAT, DEMO)
    lines = [l for l in r["bom"] if l["kind"] == "custom"]
    assert len(lines) == 2 and lines[1]["no_markup"] and "no_markup" not in lines[0]
    assert r["price"]["cost"] == pytest.approx(base["cost"] + 100000 + 100000, abs=2)
    assert r["price"]["total"] == pytest.approx(base["total"] + 100000 * 1.3 + 100000, abs=1000)
    with pytest.raises(CommandError):
        commands.set_custom_lines(d, [{"name": "", "qty": 1, "price_sum": 1}])
    with pytest.raises(CommandError):
        commands.set_custom_lines(d, [{"name": "x", "qty": -1, "price_sum": 1}])


def test_template_from_doc_roundtrip():
    d = commands.set_shape(commands.set_setup(t("T03"), lam_out="golden_oak"), "arch", {"rise": 300})
    d = commands.set_cell(d, "0", open="turn")                     # в фигурной ячейке — поворотная (4.20)
    d = commands.set_custom_lines(d, [{"name": "x", "qty": 1, "price_sum": 1000}])
    tpl = commands.template_from_doc(d)
    nd = commands.create_from_template(CAT, "own", 1600, 1500, template=tpl, room="Зал")
    assert nd["frame"]["shape"] == "arch" and nd["frame"]["w"] == 1600 and nd["setup"]["lam_out"] == "golden_oak"
    assert nd["custom_lines"] and nd["room"] == "Зал"
    assert calc(nd, CAT, DEMO)["can_quote"]


def test_shaped_template_scales_with_size():
    d = t("T34", 1000, 500)                                       # полукруг остаётся полукругом
    assert d["frame"]["shape_params"]["rise"] == 500 and validate(d, CAT)["can_quote"]


# ---------- приём полей из приложения (API) ----------
def test_app_fields_accepted_by_api():
    from fastapi.testclient import TestClient
    from oyna_api.app import app
    c = TestClient(app)
    door = c.post("/oyna/positions/from-template", json={"template": "T11"}).json()["doc"]
    r = c.post("/oyna/positions/commands", json={"doc": door, "commands": [
        {"cmd": "set_cell", "path": "", "open_dir": "out", "threshold": "low_alu", "vent": {"type": "supply_valve"},
         "mosquito": {"type": "door"}},
        {"cmd": "set_setup", "seal_color": "grey", "bead": "round", "profile_color": "cream", "lam_out": "golden_oak", "lam_in": None}]})
    assert r.status_code == 200, r.text
    cell, s = r.json()["doc"]["frame"]["root"]["cell"], r.json()["doc"]["setup"]
    assert (cell["open_dir"], cell["threshold"], cell["vent"], cell["mosquito"]) == ("out", "low_alu", {"type": "supply_valve"}, {"type": "door"})
    assert s["seal_color"] == "grey" and s["lam_out"] == "golden_oak" and "lam_in" not in s
    r2 = c.post("/oyna/positions/commands", json={"doc": r.json()["doc"], "commands": [
        {"cmd": "set_cell", "path": "", "vent": None, "threshold": "none", "mosquito": False},
        {"cmd": "set_setup", "seal_color": None, "bead": None, "profile_color": None, "lam_out": None}]}).json()["doc"]
    assert "vent" not in r2["frame"]["root"]["cell"] and r2["frame"]["root"]["cell"]["threshold"] == "none"
    assert not ({"seal_color", "bead", "profile_color", "lam_out"} & set(r2.get("setup", {})))
    win = c.post("/oyna/positions/from-template", json={"template": "T02", "w": 2400, "h": 2100}).json()["doc"]
    for op in ("psk", "hs", "top_hung", "pivot"):
        x = c.post("/oyna/positions/commands", json={"doc": win, "commands": [
            {"cmd": "set_cell", "path": "", "type": "sash", "open": op}]})
        assert x.status_code == 200 and x.json()["doc"]["frame"]["root"]["cell"]["open"] == op
    f = c.post("/oyna/positions/commands", json={"doc": win, "commands": [
        {"cmd": "set_cell", "path": "", "type": "door_sash", "open": "turn"}, {"cmd": "split", "path": "", "dir": "folding", "n": 3}]})
    assert f.status_code == 200 and f.json()["doc"]["frame"]["root"]["split"] == "folding"
    bay = c.post("/oyna/positions/from-template", json={"template": "T46"}).json()["doc"]
    b = c.post("/oyna/positions/commands", json={"doc": bay, "commands": [
        {"cmd": "set_size", "path": "A1/", "w": 1500}, {"cmd": "set_shape", "path": "A1/", "shape": "arch", "params": {"rise": 300}}]})
    assert b.status_code == 200, b.text
    fr = b.json()["doc"]["frame"]["root"]["assembly"][2]["frame"]
    assert fr["w"] == 1500 and fr["shape"] == "arch" and b.json()["doc"]["frame"]["w"] == 3500


def test_doc_level_fields_read_from_saved_doc():
    """Приложение кладёт addons, shutter, grille, loggia, custom_lines прямо в документ (PUT позиции) — без команд."""
    from fastapi.testclient import TestClient
    from oyna_api.app import app
    c = TestClient(app)
    doc = c.post("/oyna/positions/from-template", json={"template": "T03"}).json()["doc"]
    doc.update(addons=[{"type": "canopy", "side": "top", "size_mm": 300}], shutter={"type": "blinds", "control": "manual"},
               grille={"type": "fixed", "pattern": "straight"}, loggia={"outrigger_mm": 200, "roof": True, "cladding": None},
               custom_lines=[{"name": "Подъём", "qty": 1, "unit": "pcs", "price_sum": 40000, "no_markup": True}])
    r = c.post("/oyna/positions/calc", json={"doc": doc}).json()
    got = {l.get("code") for l in r["bom"]}
    assert {"addon_canopy", "shutter_blinds", "grille", "loggia_outrigger", "loggia_roof", "custom:0"} <= got
    assert r["can_quote"]
    for l in r["bom"]:                                         # поле поставщика не мешает (§9.7, агент кабинета)
        assert "supplier_name" not in l or isinstance(l["supplier_name"], str)
