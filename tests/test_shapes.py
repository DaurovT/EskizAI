"""Фигурные рамы, раскладка, новые открывания, составные изделия, цвет профиля (docs/shapes_contract.md §1–8)."""
import math

import pytest
from fastapi.testclient import TestClient

from oyna_api.app import app
from oyna_core import Catalog, Company, calc, commands, validate
from oyna_core.alternatives import alternatives
from oyna_core.commands import CommandError
from oyna_core.model import side_color
from oyna_core.render import render_svg

CAT = Catalog()
DEMO = Company.demo()
P = CAT.passport("akfa__6000_qvt")
WELD = P.get("weld_mm", 0)


def t(tid, w=None, h=None, **kw):
    return commands.create_from_template(CAT, tid, w, h, **kw)


def codes(res, sev=None):
    return {v["code"] for v in res["violations"] if sev is None or v["severity"] == sev}


def at(res, code):
    return {v.get("path", "") for v in res["violations"] if v["code"] == code}


def bom(res, code):
    return [l for l in res["bom"] if l.get("code") == code]


def shaped(shape, params, w, h, tid="T02"):
    return commands.set_shape(t(tid, w, h), shape, params)


def frame_len(res):
    return sum(sum(l["pieces"]) for l in res["bom"] if l["kind"] == "profile" and l["name"] == "Рама")


# ---------- §1 формы: площадь, длина контура, ограничения ----------
def test_arch_area_and_arc_length():
    w, h, rise = 1200, 1600, 300
    r = calc(shaped("arch", {"rise": rise}, w, h), CAT, DEMO)
    R = ((w / 2) ** 2 + rise ** 2) / (2 * rise)
    phi = math.asin((w / 2) / R)
    seg = R * R * phi - (w / 2) * (R - rise)                 # площадь сегмента над пятами
    assert r["geometry"]["area_m2"] == pytest.approx((w * (h - rise) + seg) / 1e6, rel=0.01)
    arc = 2 * R * phi
    assert frame_len(r) == pytest.approx(arc + 2 * (h - rise) + w + 8 * WELD, rel=0.01)
    bend = bom(r, "work_bend")
    assert bend and bend[0]["qty"] == pytest.approx(arc / 1000, rel=0.01)
    cell = r["geometry"]["cells"][0]
    assert cell["shaped"] and len(cell["poly"]) > 8


def test_circle_area_length_and_block():
    d = 1000
    r = calc(shaped("circle", {}, d, d), CAT, DEMO)
    assert r["geometry"]["area_m2"] == pytest.approx(math.pi * (d / 2) ** 2 / 1e6, rel=0.01)
    assert frame_len(r) == pytest.approx(math.pi * d, rel=0.01)
    assert bom(r, "work_bend")
    with pytest.raises(CommandError):
        shaped("circle", {}, 1000, 900)
    bad = t("T02", 1000, 900)
    bad["frame"]["shape"] = "circle"
    assert "1.8" in codes(validate(bad, CAT), "block")


def test_trapezoid_area_and_slope_length():
    r = calc(shaped("trapezoid", {"h_left": 900, "h_right": 1400}, 1200, 1400), CAT, DEMO)
    assert r["geometry"]["area_m2"] == pytest.approx(1.2 * (0.9 + 1.4) / 2, rel=0.005)
    assert frame_len(r) == pytest.approx(900 + 1400 + 1200 + math.hypot(1200, 500) + 8 * WELD, rel=0.005)
    assert not bom(r, "work_bend")                          # наклон не гнётся
    with pytest.raises(CommandError):
        shaped("trapezoid", {"h_left": 250, "h_right": 1400}, 1200, 1400)    # min < 300
    with pytest.raises(CommandError):
        shaped("trapezoid", {"h_left": 900, "h_right": 1300}, 1200, 1400)    # ни одна не равна h


def test_bevel_area_and_limits():
    r = calc(shaped("bevel", {"corner": "tl", "dx": 400, "dy": 300}, 1200, 1500), CAT, DEMO)
    assert r["geometry"]["area_m2"] == pytest.approx((1200 * 1500 - 400 * 300 / 2) / 1e6, rel=0.005)
    r2 = calc(shaped("bevel", {"corner": "both", "dx": 400, "dy": 300}, 1200, 1500), CAT, DEMO)
    assert r2["geometry"]["area_m2"] == pytest.approx((1200 * 1500 - 400 * 300) / 1e6, rel=0.005)
    with pytest.raises(CommandError):
        shaped("bevel", {"corner": "both", "dx": 600, "dy": 300}, 1200, 1500)    # dx ≥ w/2
    with pytest.raises(CommandError):
        shaped("bevel", {"corner": "tr", "dx": 1000, "dy": 300}, 1200, 1500)     # dx > w − 300


def test_triangle_area_and_limits():
    r = calc(shaped("triangle", {"apex": 600}, 1200, 900), CAT, DEMO)
    assert r["geometry"]["area_m2"] == pytest.approx(1.2 * 0.9 / 2, rel=0.005)
    assert frame_len(r) == pytest.approx(1200 + 2 * math.hypot(600, 900) + 6 * WELD, rel=0.005)
    with pytest.raises(CommandError):
        shaped("triangle", {"apex": 600}, 1200, 250)
    with pytest.raises(CommandError):
        shaped("arch", {"rise": 700}, 1200, 1600)                  # rise > w/2


def test_shaped_glass_area_with_extra():
    r = calc(t("T16"), CAT, DEMO)
    cell = r["geometry"]["cells"][0]
    g = bom(r, "g4_12_4")[0]
    assert g["qty"] == pytest.approx(cell["glass_area_m2"], abs=0.002)
    assert g["qty"] < cell["glass"][0] * cell["glass"][1] / 1e6          # по контуру, не по габариту
    assert g["unit_price"] == pytest.approx(160000 * 1.3)                # + shaped_extra_pct 30 %
    assert "фигурн" in g["name"]


def test_mullion_clipped_under_arch():
    d = commands.set_shape(commands.split(t("T02", 1400, 1500), "", "v", 2), "arch", {"rise": 500})
    g = validate(d, CAT)["geometry"]
    m = g["mullions"][0]
    assert m["length"] < 1500 - 2 * P["bf"] + 2 * P["imp_add"]           # импост короче: верх под дугой
    assert all(c["shaped"] for c in g["cells"])


def test_legacy_t16_record_reads_as_frame_shape():
    old = {"kind": "window", "frame": {"w": 1200, "h": 1600, "shape": "rect",
                                       "root": {"shape": "arch", "rise_mm": 300, "cell": {"type": "fixed"}, "calc": "этап 3"}}}
    r = calc(old, CAT, DEMO)
    assert "9.7" not in codes(r) and r["can_quote"]
    assert r["geometry"]["shape"] == "arch" and r["geometry"]["cells"][0]["shaped"]
    assert r["price"]["total"] == calc(t("T16"), CAT, DEMO)["price"]["total"]


def test_shaped_sash_rules():
    arch = lambda op: commands.set_cell(commands.set_shape(t("T01", 800, 1500), "arch", {"rise": 250}), "", open=op)
    r = calc(arch("tilt_turn"), CAT, DEMO)
    assert "4.20" in codes(r, "block")
    r = calc(arch("turn"), CAT, DEMO)
    assert "4.20" not in codes(r) and "4.21" in codes(r) and bom(r, "fit_shaped")   # 4.21 — к сведению (hint)
    semi = commands.set_cell(commands.set_shape(t("T01", 1200, 600), "arch", {"rise": 600}), "", open="turn")
    assert "4.20" in codes(validate(semi, CAT))                          # у полукруга — только откидное
    assert "4.20" not in codes(validate(commands.set_cell(semi, "", open="tilt"), CAT))


def test_set_shape_rect_and_unknown():
    d = commands.set_shape(t("T16"), "rect")
    assert d["frame"]["shape"] == "rect" and "shape_params" not in d["frame"]
    with pytest.raises(CommandError):
        commands.set_shape(t("T02"), "star", {})


# ---------- §2 раскладка ----------
def test_muntins_grid_bom_and_crosses():
    d = commands.set_muntins(t("T02", 1000, 1300), "", {"kind": "inner", "v": 2, "h": 1, "width_mm": 18, "pattern": "grid"})
    r = calc(d, CAT, DEMO)
    cell = r["geometry"]["cells"][0]
    vis_w, vis_h = cell["light"]
    inner = bom(r, "muntin_inner")[0]
    assert inner["qty"] == pytest.approx((2 * vis_h + vis_w) / 1000, rel=0.03)
    assert bom(r, "muntin_cross")[0]["qty"] == 2
    assert inner["price_status"] == "demo" and inner["unit_price"] == 25000


def test_muntins_overlay_two_sides_and_decor():
    d = commands.set_muntins(t("T02", 1000, 1300), "", {"kind": "overlay", "pattern": "cross", "width_mm": 26})
    r = calc(d, CAT, DEMO)
    ov = bom(r, "muntin_overlay")[0]
    cell = r["geometry"]["cells"][0]
    assert ov["qty"] == pytest.approx(2 * sum(cell["light"]) / 1000, rel=0.03) and not bom(r, "muntin_cross")
    dec = commands.set_muntins(t("T02", 1000, 1300), "", {"pattern": "decor"})
    line = bom(calc(dec, CAT, DEMO), "muntin_decor")[0]
    assert line["unit"] == "m2" and line["qty"] == pytest.approx(cell["glass"][0] * cell["glass"][1] / 1e6, rel=0.01)
    with pytest.raises(CommandError):
        commands.set_muntins(t("T02"), "", {"kind": "inner", "width_mm": 45})
    assert "muntins" not in commands.set_muntins(d, "", None)["frame"]["root"]["cell"]


def test_muntin_rules_520_521_522():
    d = commands.set_fill(t("T02", 1000, 1300), "", {"kind": "glass", "glass": "4-10-4"})
    inner = commands.set_muntins(d, "", {"kind": "inner", "v": 1, "h": 1})
    assert "5.20" in codes(validate(inner, CAT), "block")
    overlay = commands.set_muntins(d, "", {"kind": "overlay", "v": 1, "h": 1})
    assert "5.20" not in codes(validate(overlay, CAT))
    panel = commands.set_muntins(commands.set_cell(t("T02"), "", type="panel"), "", {"v": 1, "h": 1})
    assert "5.21" in codes(validate(panel, CAT), "block")
    dense = commands.set_muntins(t("T02", 1000, 1300), "", {"v": 8, "h": 1})
    assert "5.22" in codes(validate(dense, CAT), "warn")


def test_muntins_sun_on_semicircle():
    r = calc(t("T43"), CAT, DEMO)
    assert r["can_quote"] and bom(r, "muntin_inner")[0]["qty"] > 1 and bom(r, "muntin_cross")[0]["qty"] == 3   # T43: 3 луча × 1 кольцо


# ---------- §3 открывания ----------
def test_top_hung_and_pivot_fittings():
    r = calc(t("T21"), CAT, DEMO)
    assert r["can_quote"] and bom(r, "fit_top_hung")[0]["unit_price"] == 280000
    d = commands.set_cell(t("T01", 1000, 800), "", open="top_hung")
    assert d["frame"]["root"]["cell"]["hinge"] == "top" and "6.3" not in codes(validate(d, CAT))
    r = calc(t("T22"), CAT, DEMO)
    assert r["can_quote"] and bom(r, "fit_pivot")
    sash = r["geometry"]["cells"][0]["sash"]
    assert sash[0] == pytest.approx(1200 - 2 * P["bf"] + 2 * P["ov"])


def test_pivot_size_limit_422():
    big = t("T22", 1800, 1800)
    r = validate(big, CAT)
    assert "4.22" in codes(r, "block") and "2.2" not in codes(r)


# ---------- §4 составные ----------
def test_bay_window_price_is_frames_plus_connectors():
    doc = commands.set_extras(t("T46"), install=False)
    r = calc(doc, CAT, DEMO)
    assert r["can_quote"] and "9.7" not in codes(r)
    frames = [x["frame"] for x in doc["frame"]["root"]["assembly"] if "frame" in x]
    sub = [calc({"kind": "window", "frame": f, "extras": {"install": False}}, CAT, DEMO) for f in frames]
    conn = bom(r, "conn_bay")
    assert len(conn) == 2 and conn[0]["qty"] == pytest.approx(1.5) and conn[0]["unit_price"] == 110000
    assert r["price"]["cost"] == pytest.approx(sum(s["price"]["cost"] for s in sub) + sum(c["cost"] for c in conn), abs=2)
    assert doc["frame"]["w"] == sum(f["w"] for f in frames) and doc["frame"]["h"] == 1500
    paths = {c["path"] for c in r["geometry"]["cells"]}
    assert {"A0/", "A1/0", "A1/1", "A2/"} <= paths
    assert [j["angle"] for j in r["geometry"]["joints"]] == [135, 135]


def test_assembly_install_once_by_total_area():
    r = calc(t("T46"), CAT, DEMO)
    inst = bom(r, "install")
    assert len(inst) == 1 and inst[0]["qty"] == pytest.approx(r["price"]["area_m2"])


def test_assembly_addressing_and_commands():
    d = t("T46")
    d = commands.split(d, "A0/", "v", 2)
    d = commands.set_cell(d, "A0/1", type="sash", open="tilt_turn", hinge="right")
    assert d["frame"]["root"]["assembly"][0]["frame"]["root"]["parts"][1]["cell"]["type"] == "sash"
    r = validate(d, CAT)
    assert any(c["path"] == "A0/1" and c.get("sash") for c in r["geometry"]["cells"])
    d = commands.set_joint(d, 1, "straight")
    assert bom(calc(d, CAT, DEMO), "conn_straight")
    with pytest.raises(CommandError):
        commands.set_joint(d, 0, "angle", 200)
    d = commands.add_frame(d, 2, 800)
    assert len([x for x in d["frame"]["root"]["assembly"] if "frame" in x]) == 4 and d["frame"]["w"] == 1000 + 1400 + 1000 + 800
    d = commands.remove_frame(d, 0)
    items = d["frame"]["root"]["assembly"]
    assert "frame" in items[0] and len(items) == 5 and d["frame"]["w"] == 1400 + 1000 + 800
    d = commands.set_size(d, h=1450)
    assert all(x["frame"]["h"] == 1450 for x in d["frame"]["root"]["assembly"] if "frame" in x) and d["frame"]["h"] == 1450
    with pytest.raises(CommandError):
        commands.set_size(d, w=3000)


def test_assembly_rules_920_921_and_prefixed_violations():
    d = t("T46")
    d["frame"]["root"]["assembly"][1]["angle"] = 200
    assert "9.20" in codes(validate(d, CAT), "block")
    d = commands.set_size(t("T46"), h=1500, path="A2/")
    d = commands.set_size(d, h=1450, path="A2/")
    r = validate(d, CAT)
    assert "9.21" in codes(r, "warn")
    big = commands.set_part_size(t("T46"), "A1/0", 1300)          # 1300 + rest в 1400 → вторая часть 100
    assert "A1/1" in at(validate(big, CAT), "1.5")


def test_legacy_t15_loggia_counts():
    r = calc(t("T15"), CAT, DEMO)
    assert r["can_quote"] and len(bom(r, "conn_corner90")) == 2 and r["price"]["total"] > 0


# ---------- §8 цвет профиля, ламинация, декор стекла ----------
def test_legacy_colors_read_as_lamination():
    old = t("T03")
    old["setup"] = {"color_out": "golden_oak", "color_in": "white"}
    r = validate(old, CAT)
    assert r["setup"]["lam_out"] == "golden_oak" and r["setup"]["lam_in"] is None
    assert r["price_group"] == "Внешний внутренний" and r["setup"]["color_out"] == "golden_oak"
    new = commands.set_setup(old, profile_color="white")
    assert "color_out" not in new["setup"] and new["setup"]["lam_out"] == "golden_oak"
    assert side_color({"lam_out": None, "profile_color": "cream"}, "out") == "cream"
    assert side_color({"lam_in": "walnut", "profile_color": "cream"}, "in") == "walnut"


def test_profile_color_surcharge_and_rule_220():
    base = calc(t("T03"), CAT, DEMO)
    d = commands.set_setup(t("T03"), profile_color="cream")
    r = calc(d, CAT, DEMO)
    pc = bom(r, "profile_color")[0]
    prof = sum(l["cost"] for l in base["bom"] if l["kind"] in ("profile", "bead"))
    assert pc["cost"] == pytest.approx(prof * 0.12, rel=0.001)
    assert r["price"]["total"] > base["price"]["total"]
    bad = commands.set_setup(commands.set_setup(t("T03"), system="ekopen__prime"), profile_color="cream")
    v = [x for x in validate(bad, CAT)["violations"] if x["code"] == "2.20"]
    assert v and v[0]["severity"] == "lock" and "есть:" in v[0]["fix"]


def test_lamination_line_when_system_has_no_laminated_prices():
    d = commands.set_setup(t("T03"), system="akfa__5200_qvt", lam_out="golden_oak")
    r = calc(d, CAT, DEMO)
    lam = bom(r, "lamination")
    assert lam and lam[0]["unit_price"] == 18000 and "7.10" not in codes(r)
    prof_m = sum(l["qty"] for l in r["bom"] if l["kind"] in ("profile", "bead") and l.get("code") != "profile_color")
    assert lam[0]["qty"] == pytest.approx(prof_m, rel=0.001)                # одна сторона
    both = calc(commands.set_setup(d, lam_in="golden_oak"), CAT, DEMO)
    assert bom(both, "lamination")[0]["qty"] == pytest.approx(2 * prof_m, rel=0.001)
    own = calc(commands.set_setup(t("T03"), lam_out="golden_oak"), CAT, DEMO)   # у 6000 QVT ламинация в прайсе
    assert not bom(own, "lamination") and own["price_group"] == "Внешний внутренний"


def test_glass_decor_line_and_alternatives():
    d = commands.set_fill(t("T03"), "1", decor="matte")
    assert d["frame"]["root"]["parts"][1]["cell"]["fill"] == {"kind": "glass", "decor": "matte"}
    r = calc(d, CAT, DEMO)
    gd = bom(r, "glass_decor")
    assert gd and gd[0]["unit_price"] == 80000 and gd[0]["path"] == "1"
    with pytest.raises(CommandError):
        commands.set_fill(t("T03"), "1", decor="gold")
    a = alternatives(t("T03"), CAT, DEMO, "glass_decor", path="1")
    assert {"matte", "tinted", "mirror", "pattern", "stained"} <= {o["value"] for o in a["options"]}
    assert alternatives(t("T03"), CAT, DEMO, "lam_out")["options"][0]["current"]
    pc = alternatives(commands.set_setup(t("T03"), system="ekopen__prime"), CAT, DEMO, "profile_color")
    assert "cream" in {o["value"] for o in pc["locked"]} and "brown" in {o["value"] for o in pc["options"]}


# ---------- §6 шаблоны ----------
CATS = {"window", "door", "balcony", "sliding", "shaped", "muntins", "corner", "facade", "guillotine"}


@pytest.mark.parametrize("tid", list(CAT.templates))
def test_every_ready_template_calculates(tid):
    tpl = CAT.templates[tid]
    assert tpl["category"] in CATS and 0 < len(tpl["short"]) <= 22
    if not tpl["ready"]:
        assert tpl["kind"] == "sliding"
        return
    r = calc(t(tid), CAT, DEMO)
    assert not codes(r, "block") and not codes(r, "lock"), r["violations"]
    assert r["price"]["total"] > 0 and r["price"]["demo"]
    assert "<svg" in render_svg(t(tid), CAT, DEMO)


def test_templates_api_category_and_count():
    rows = {x["id"]: x for x in TestClient(app).get("/oyna/templates").json()}
    assert len(rows) >= 45
    assert rows["T35"]["category"] == "shaped" and rows["T35"]["shape"] == "circle"
    assert rows["T46"]["category"] == "corner" and rows["T46"]["ready"] and rows["T16"]["ready"]
    assert {r["category"] for r in rows.values()} == CATS


# ---------- §8 рендер ----------
def test_render_shapes_openings_assembly():
    assert "<polygon" in render_svg(t("T35"), CAT, DEMO)
    assert "stroke-dasharray" in render_svg(t("T22"), CAT, DEMO)          # ромб пунктиром
    svg = render_svg(t("T46"), CAT, DEMO)
    assert svg.count("135°") == 2
    assert "<polyline" in render_svg(t("T41"), CAT, DEMO)                 # раскладка
