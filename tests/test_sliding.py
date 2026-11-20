"""Раздвижные, гильотинное окно, гильотина для террас (docs/shapes_contract.md §11)."""
import pytest
from fastapi.testclient import TestClient

from oyna_api.app import app
from oyna_core import Catalog, Company, calc, commands, validate
from oyna_core.commands import CommandError
from oyna_core.model import SLIDING_DEMO, default_moving
from oyna_core.order import calc_order, order_cutting
from oyna_core.render import render_svg

CAT = Catalog()
DEMO = Company.demo()
NEW = ["T58", "T59", "T60", "T61", "T62", "T63", "T64", "T65", "T66", "T67", "T68"]


def t(tid, w=None, h=None, **kw):
    return commands.create_from_template(CAT, tid, w, h, **kw)


def codes(res, sev=None):
    return {v["code"] for v in res["violations"] if sev is None or v["severity"] == sev}


def bom(res, code):
    return [l for l in res["bom"] if l.get("code") == code]


def qty(res, code):
    return sum(l["qty"] for l in bom(res, code))


# ---------- шаблоны ----------
@pytest.mark.parametrize("tid", ["T12", "T13", "T14"] + NEW)
def test_new_templates_ready_and_calculate(tid):
    tpl = CAT.templates[tid]
    assert tpl["ready"] and tpl["category"] in ("sliding", "window", "guillotine", "corner") and len(tpl["short"]) <= 22
    r = calc(t(tid), CAT, DEMO)
    assert r["can_quote"] and not codes(r, "block") and not codes(r, "lock"), r["violations"]
    assert r["price"]["total"] > 0 and r["price"]["demo"] and "9.7" not in codes(r)
    assert "<svg" in render_svg(t(tid), CAT, DEMO)


def test_assembly_templates_width_is_sum_of_frames():
    for tid in ("T62", "T68"):
        tpl = CAT.templates[tid]
        assert tpl["default_w"] == sum(x["frame"]["w"] for x in tpl["root"]["assembly"] if "frame" in x)


def test_special_templates_default_to_demo_system():
    for tid in ("T12", "T58", "T62", "T66", "T68"):
        assert t(tid)["setup"]["system"] == SLIDING_DEMO
    assert t("T63").get("setup", {}).get("system") is None              # гильотинное окно — в раме обычной системы
    # у цеха нет своей раздвижной системы — ДЕМО; своя setup.system в запросе важнее
    assert t("T12", company_systems=["akfa__6000_qvt"])["setup"]["system"] == SLIDING_DEMO
    assert t("T12", setup={"system": "akfa__aldoks"})["setup"]["system"] == "akfa__aldoks"


# ---------- 11.1 раздвижные ----------
def test_sliding_leaves_overlap_and_bom():
    r = calc(t("T12"), CAT, DEMO)                                        # 2000 × 1400, 2 полотна
    g = r["geometry"]
    p = CAT.passport(SLIDING_DEMO)["sliding"]
    e = p["frame_face_mm"] - p["leaf_into_mm"]
    lw = (2000 - 2 * e + p["overlap_mm"]) / 2
    assert g["sliding"]["leaf_w"] == lw and g["sliding"]["overlap_mm"] == 50
    assert [c["path"] for c in g["cells"]] == ["0", "1"] and all(c["leaf"]["moving"] for c in g["cells"])
    assert g["cells"][1]["axis"][0] == pytest.approx(g["cells"][0]["axis"][2] - 50)
    assert qty(r, "sl_frame") == pytest.approx(6.8) and qty(r, "sl_rail") == pytest.approx(4.0)
    assert len(bom(r, "sl_sash")) == 2 and qty(r, "sl_roller") == 4 and qty(r, "sl_lock") == 2
    assert qty(r, "sl_interlock") == pytest.approx(g["sliding"]["leaf_h"] / 1000)
    assert len([l for l in r["bom"] if l["kind"] == "glass"]) == 2 and bom(r, "sl_brush")
    assert bom(r, "install")[0]["qty"] == pytest.approx(2.8)              # монтаж по площади
    assert not bom(r, "sl_threshold_low")


def test_default_moving_like_app():
    assert default_moving(2) == [True, True] and default_moving(3) == [True, False, True]
    assert default_moving(5) == [False, True, True, True, False]
    d = commands.set_sliding(t("T12"), leaves=4)
    assert "moving" not in d["frame"]["root"]["sliding"]
    r = calc(d, CAT, DEMO)
    assert [c["leaf"]["moving"] for c in r["geometry"]["cells"]] == [False, True, True, False]
    assert [c["type"] for c in r["geometry"]["cells"]] == ["fixed", "sash", "sash", "fixed"]
    assert qty(r, "sl_roller") == 4 and qty(r, "sl_lock") == 2


def test_panoramic_threshold_and_hint():
    r = calc(t("T58"), CAT, DEMO)
    assert bom(r, "sl_threshold_low")[0]["qty"] == pytest.approx(3.0) and "8.20" not in codes(r)
    assert bom(r, "sl_sash")[0]["unit_price"] == 150000                   # узкий профиль — вариант panoramic
    std = calc(commands.set_sliding(t("T58"), threshold="standard"), CAT, DEMO)
    assert "8.20" in codes(std, "hint") and not bom(std, "sl_threshold_low")


def test_sliding_leaf_limits_and_weight():
    wide = calc(t("T12", w=4000, h=1400), CAT, DEMO)                      # полотно ~2000 > 1600 у окна
    assert "2.21" in codes(wide, "block") and not wide["can_quote"]
    ok = calc(commands.set_sliding(t("T12", w=4000, h=1400), leaves=3), CAT, DEMO)
    assert "2.21" not in codes(ok)
    heavy = commands.set_setup(t("T58", w=5000, h=2900), glass="10t-12-10t")
    r = calc(heavy, CAT, DEMO)
    assert "3.21" in codes(r, "block")
    assert any(v["code"] == "3.21" and v["path"] in ("0", "1") for v in r["violations"])


def test_sliding_frame_limits_and_input():
    assert "1.3" not in codes(validate(t("T14"), CAT, DEMO))              # 4000 мм — норма для раздвижной
    assert "1.2" in codes(validate(t("T12", w=9000), CAT, DEMO))
    d = t("T12")
    d["frame"]["root"]["sliding"]["rails"] = 4
    r = validate(d, CAT, DEMO)
    assert "1.9" in codes(r, "block") and r["geometry"] is None


def test_system_compat_rules():
    pvc = commands.set_setup(t("T12"), system="akfa__6000_qvt")
    assert "7.22" in codes(validate(pvc, CAT, DEMO), "lock")
    win = commands.set_setup(t("T03"), system=SLIDING_DEMO)
    assert "7.21" in codes(validate(win, CAT, DEMO), "lock")
    s = {x["code"]: x for x in TestClient(app).get("/oyna/systems", params={"q": "ДЕМО"}).json()}
    assert s[SLIDING_DEMO]["sliding"] and s[SLIDING_DEMO]["guillotine"] and s[SLIDING_DEMO]["sliding_only"]
    assert CAT.passport(SLIDING_DEMO)["sliding"]["overlap_mm"] == 50 and CAT.material(SLIDING_DEMO) == "alu_cold"


def test_set_sliding_command():
    d = commands.set_sliding(t("T03"), leaves=3, kind="door", threshold="low")
    assert d["kind"] == "sliding" and d["frame"]["root"] == {"sliding": {**{"leaves": 3, "rails": 2, "overlap_mm": "passport",
                                                                              "kind": "door", "threshold": "low"}}}
    d = commands.set_sliding(d, moving=[True, True, False], rails=3)
    assert d["frame"]["root"]["sliding"]["moving"] == [True, True, False]
    for bad in ({"leaves": 7}, {"rails": 4}, {"moving": [True]}, {"kind": "hs"}, {"threshold": "none"}):
        with pytest.raises(CommandError):
            commands.set_sliding(t("T12"), **bad)
    with pytest.raises(CommandError):
        commands.set_sliding(t("T62"))                                    # сборка — только path "A<i>/"
    a = commands.set_sliding(t("T62"), path="A1/", leaves=3)
    assert a["frame"]["root"]["assembly"][2]["frame"]["root"]["sliding"]["leaves"] == 3
    m = commands.mirror(commands.set_sliding(t("T12"), leaves=3, moving=[True, True, False]))
    assert m["frame"]["root"]["sliding"]["moving"] == [False, True, True]
    out = commands.apply(t("T12"), [{"cmd": "set_sliding", "leaves": 3, "kind": "panoramic"}])
    assert out["frame"]["root"]["sliding"]["kind"] == "panoramic"


def test_corner_free_joint():
    r = calc(t("T62"), CAT, DEMO)
    cf = bom(r, "conn_corner_free")
    assert cf and cf[0]["qty"] == pytest.approx(2.4) and r["geometry"]["joints"][0]["role"] == "conn_corner_free"
    assert r["geometry"]["frames"][0]["kind"] == "sliding" and r["geometry"]["cells"][2]["path"] == "A1/0"
    assert "9.24" not in codes(r)
    d = commands.set_joint(t("T45"), 0, "corner_free")                    # ПВХ угловое — угол без стойки нельзя
    assert d["frame"]["root"]["assembly"][1] == {"joint": "corner_free", "angle": 90}
    assert "9.24" in codes(calc(d, CAT, DEMO), "block")
    with pytest.raises(CommandError):
        commands.set_joint(t("T62"), 0, "corner_free", 60)


# ---------- 11.2 гильотинное окно ----------
def test_vslide_split_and_cell_commands():
    d = commands.split(t("T01"), "", "vslide", 2)
    parts = d["frame"]["root"]["parts"]
    assert d["frame"]["root"]["split"] == "vslide"
    assert parts[0]["cell"]["slide"] == "fixed" and parts[1]["cell"]["slide"] == "moving"
    assert all(p["cell"]["open"] == "vslide" and "hinge" not in p["cell"] for p in parts)
    with pytest.raises(CommandError):
        commands.split(t("T01"), "", "vslide", 3)
    d = commands.set_cell(d, "0", slide="moving", tilt_clean=True)
    assert d["frame"]["root"]["parts"][0]["cell"]["tilt_clean"] is True
    with pytest.raises(CommandError):
        commands.set_cell(d, "0", slide="up")
    back = commands.set_cell(d, "0", open="turn")
    assert "slide" not in back["frame"]["root"]["parts"][0]["cell"] and "tilt_clean" not in back["frame"]["root"]["parts"][0]["cell"]
    assert "6.20" in codes(validate(back, CAT, DEMO), "block")            # в узле vslide — не полотно


def test_vslide_bom_and_rules():
    r = calc(t("T65"), CAT, DEMO)                                        # оба подвижные, оба с откидыванием
    assert qty(r, "vs_balance") == 4 and qty(r, "vs_tilt") == 2 and qty(r, "vs_lock") == 1
    assert len(bom(r, "vs_sash")) == 2 and not bom(r, "sash") and bom(r, "vs_frame")[0]["qty"] == pytest.approx(5.2)
    assert bom(r, "vs_brush") and bom(r, "frame")                         # рама — профиль системы
    low = calc(t("T63", h=500), CAT, DEMO)
    assert "2.23" in codes(low, "block")
    heavy = commands.set_setup(t("T63", w=1400, h=2200), glass="6-12-6")
    hv = calc(heavy, CAT, DEMO)
    assert "3.23" in codes(hv, "block") and any(v["code"] == "3.23" and v["path"] == "1" for v in hv["violations"])
    assert not any(v["code"] == "3.23" and v["path"] == "0" for v in hv["violations"])   # верхнее глухое
    svg = render_svg(t("T63"), CAT, DEMO)
    assert "Г" in svg and svg.count("<line") > 4


# ---------- 11.3 гильотина ----------
def test_guillotine_geometry_and_bom():
    r = calc(t("T66"), CAT, DEMO)                                        # 6000 × 2400, 3 модуля × 3 полотна
    g = r["geometry"]
    assert g["guillotine"]["modules"] == 3 and len(g["guillotine"]["posts_x"]) == 4
    assert [c["path"] for c in g["cells"][:3]] == ["0.0", "0.1", "0.2"]
    assert [c["panel"]["moving"] for c in g["cells"][:3]] == [False, True, True]
    assert qty(r, "gl_post") == pytest.approx(4 * 2.4) and qty(r, "gl_motor") == 3 and qty(r, "gl_belt") == 3
    assert not bom(r, "gl_remote") and len(bom(r, "gl_panel")) == 9 and bom(r, "gl_seal") and bom(r, "gl_rail")
    assert len([l for l in r["bom"] if l["kind"] == "glass"]) == 9
    assert "P.2" not in codes(r)                                         # свой коридор цены у гильотины
    assert qty(calc(t("T67"), CAT, DEMO), "gl_remote") == 1
    none = calc(commands.set_guillotine(t("T66"), posts="none"), CAT, DEMO)
    assert not bom(none, "gl_post")


def test_guillotine_rules():
    assert "2.22" in codes(calc(commands.set_guillotine(t("T66"), modules=1), CAT, DEMO), "block")
    manual = calc(commands.set_guillotine(t("T66"), drive="manual"), CAT, DEMO)
    assert "3.22" in codes(manual, "warn") and not bom(manual, "gl_motor")
    assert {v["path"] for v in manual["violations"] if v["code"] == "3.22"} == {"0", "1", "2"}
    plain = calc(commands.set_guillotine(t("T66"), glass="g4_12_4"), CAT, DEMO)
    assert "4.23" in codes(plain, "block")
    assert "4.23" not in codes(calc(commands.set_guillotine(t("T66"), glass="g4t_14_4t"), CAT, DEMO))


def test_set_guillotine_command():
    d = commands.set_guillotine(t("T03"))
    assert d["kind"] == "guillotine" and d["frame"]["root"]["guillotine"]["modules"] == 3
    d = commands.set_guillotine(d, panels=2)
    assert d["frame"]["root"]["guillotine"]["moving"] == 1                # moving ≤ panels − 1
    for bad in ({"modules": 0}, {"panels": 5}, {"moving": 3}, {"drive": "solar"}, {"posts": "all"}):
        with pytest.raises(CommandError):
            commands.set_guillotine(t("T66"), **bad)
    a = commands.apply(t("T68"), [{"cmd": "set_guillotine", "path": "A0/", "drive": "remote"}])
    r = calc(a, CAT, DEMO)
    assert qty(r, "gl_remote") == 1 and r["geometry"]["frames"][1]["guillotine"]["modules_x"][0][0] >= 4000


def test_render_special():
    svg = render_svg(t("T66"), CAT, DEMO)
    assert "электропривод" in svg and svg.count("Г") >= 3
    assert "полотно" in render_svg(t("T12"), CAT, DEMO)


# ---------- заказ, комплектации, раскрой, API ----------
def test_kit_keeps_sliding_system_and_cutting():
    kit = DEMO.kits[0]
    o = calc_order([t("T60"), t("T03")], CAT, DEMO, kit=kit)
    assert o["can_quote"], o["blocking"]
    cut = order_cutting([t("T60"), t("T67")], CAT, DEMO)                  # 6000 и 10000 мм — не длиннее хлыста
    assert cut["items"] and all(max(max(b) for b in i["layout"]) <= cut["bar_mm"] for i in cut["items"])
    assert commands.apply_kit(t("T12"), kit["setup"])["setup"]["system"] == SLIDING_DEMO


def test_api_templates_and_commands():
    c = TestClient(app)
    rows = {x["id"]: x for x in c.get("/oyna/templates").json()}
    assert rows["T12"]["ready"] and rows["T66"]["category"] == "guillotine" and rows["T63"]["category"] == "window"
    assert rows["T62"]["category"] == "corner" and rows["T58"]["short"] == "Панорама ×2"
    doc = c.post("/oyna/positions/from-template", json={"template": "T12"}).json()["doc"]
    r = c.post("/oyna/positions/commands", json={"doc": doc, "commands": [{"cmd": "set_sliding", "leaves": 3}]}).json()
    assert r["result"]["geometry"]["sliding"]["leaves"] == 3 and r["result"]["can_quote"]
    bad = c.post("/oyna/positions/commands", json={"doc": doc, "commands": [{"cmd": "set_sliding", "rails": 5}]})
    assert bad.status_code == 422


def test_alternatives_for_special():
    from oyna_core.alternatives import alternatives
    a = alternatives(t("T66"), CAT, DEMO, "glass")                        # стекло гильотины — в корне, только закалённое
    assert {"g8t", "g10t", "g4t_14_4t"} <= {o["value"] for o in a["options"]}
    assert "g4_12_4" in {o["value"] for o in a["locked"]} and next(o for o in a["options"] if o["value"] == "g8t")["current"]
    s = alternatives(t("T12"), CAT, DEMO, "system")
    assert [o["value"] for o in s["options"]] == [SLIDING_DEMO]           # остальные алюминиевые — 7.22
