"""Команды, геометрия, фурнитура, цена, раскрой, замены."""
import pytest

from oyna_core import Catalog, Company, calc, commands, validate
from oyna_core.alternatives import alternatives
from oyna_core.commands import CommandError
from oyna_core.cutting import cut
from oyna_core.glass import GlassError, parse, price_m2
from oyna_core.model import node_at, price_group
from oyna_core.order import calc_order, order_cutting, quote_variants

CAT = Catalog()
DEMO = Company.demo()


def t(tid, w=None, h=None, **kw):
    return commands.create_from_template(CAT, tid, w, h, **kw)


def codes(res, sev=None):
    return {v["code"] for v in res["violations"] if sev is None or v["severity"] == sev}


# ---------- команды ----------
def test_commands_do_not_mutate():
    d = t("T01")
    d2 = commands.split(d, "", "v", 2)
    assert "cell" in d["frame"]["root"] and "split" in d2["frame"]["root"]


def test_split_merge_roundtrip():
    d = commands.split(t("T02", 1500, 1400), "", "v", 3)
    assert len(d["frame"]["root"]["parts"]) == 3
    d = commands.split(d, "1", "h", 2)
    assert node_at(d, "1.0")["cell"]["type"] == "fixed"
    d = commands.merge(d, "1")
    assert "cell" in node_at(d, "1")
    with pytest.raises(CommandError):
        commands.merge(d, "1")


def test_set_part_size_and_eq():
    d = commands.set_part_size(t("T03", 1400, 1300), "0", 600)
    g = validate(d, CAT)["geometry"]
    assert [c["axis"][2] - c["axis"][0] for c in g["cells"]] == [600, 800]


def test_part_sizes_overflow_blocks():
    d = commands.set_part_size(t("T03", 1400, 1300), "0", 1500)
    assert "1.4" in codes(validate(d, CAT))


def test_mirror_swaps_hinges_and_order():
    d = commands.mirror(t("T03"))
    parts = d["frame"]["root"]["parts"]
    assert parts[0]["cell"]["type"] == "fixed" and parts[1]["cell"]["hinge"] == "right"


def test_accept_warning_marks_accepted():
    d = t("T01", 703, 1300)
    assert any(v["code"] == "1.6" and not v["accepted"] for v in validate(d, CAT)["violations"])
    d = commands.accept_warning(d, "1.6", user="u1")
    assert all(v["accepted"] for v in validate(d, CAT)["violations"] if v["code"] == "1.6")


def test_apply_batch():
    d = commands.apply(t("T02", 1400, 1300), [{"cmd": "split", "path": "", "dir": "v", "n": 2},
                                              {"cmd": "set_cell", "path": "0", "type": "sash", "open": "tilt_turn"}])
    assert node_at(d, "0")["cell"]["handle"] is True


# ---------- геометрия ----------
def test_geometry_two_sash_window():
    g = validate(t("T03", 1400, 1300), CAT)["geometry"]
    sash = g["cells"][0]
    p = CAT.passport("akfa__6000_qvt")
    light_w = 700 - p["bf"] - p["bi"] / 2
    assert sash["light"][0] == pytest.approx(light_w)
    assert sash["sash"][0] == pytest.approx(light_w + 2 * p["ov"])
    assert g["mullions"][0]["length"] == pytest.approx(1300 - 2 * p["bf"] + 2 * p["imp_add"])


def test_nested_transom():
    g = validate(t("T07"), CAT)["geometry"]
    assert len(g["cells"]) == 3 and len(g["mullions"]) == 2


# ---------- стекло ----------
def test_glass_formula():
    g = parse("6t-14-4i", CAT)
    assert (g.thickness_mm, g.weight_kg_m2, g.chambers) == (24, 25, 1)
    assert price_m2(g, CAT)[0] == 495000
    assert parse("6з-14-4и", CAT).panes[0].tempered
    with pytest.raises(GlassError):
        parse("4-30-4", CAT)


def test_cell_fill_overrides_setup_glass():
    d = commands.set_fill(t("T03"), "1", {"kind": "glass", "glass": "4t-12-4"})
    cells = validate(d, CAT)["geometry"]["cells"]
    assert cells[1]["glass_spec"] == "4t-12-4" and cells[0]["glass_spec"] == "g4_12_4"


# ---------- фурнитура ----------
def test_fornax_selection_and_strikes():
    g = validate(t("T01", 700, 1300), CAT)["geometry"]["cells"][0]
    fit = {f["code"]: f for f in g["fittings"]}
    assert g["ffb"] == pytest.approx(548) and g["ffh"] == pytest.approx(1148)
    assert "fornax.tilt_turn.drive_gr02" in fit and "fornax.tilt_turn.scissors_gr1" in fit
    cams = sum(f["cams"] * f["qty"] for f in g["fittings"])
    assert fit["fornax.tilt_turn.strike_plate"]["qty"] == cams


def test_fornax_not_on_aldoks():
    d = commands.set_setup(t("T01", 700, 1300), system="akfa__aldoks", fittings="fornax")
    assert "7.2" in codes(validate(d, CAT))


def test_system_change_picks_compatible_fittings():
    d = commands.set_setup(t("T01", 700, 1300, setup={"fittings": "fornax"}), system="akfa__bkc50")
    r = validate(d, CAT)
    assert r["setup"]["fittings"] in CAT.compatible_fitting_sets("akfa__bkc50") and "7.2" not in codes(r)


def test_option_handle_and_invalid_option():
    d = commands.set_option(t("T01", 700, 1300), "handle", "euro_pvc.tilt_turn.handle_hoppe_toulon")
    names = [f["code"] for f in validate(d, CAT)["geometry"]["cells"][0]["fittings"]]
    assert "euro_pvc.tilt_turn.handle_hoppe_toulon" in names
    bad = commands.set_option(t("T01", 700, 1300), "handle", "no.such.code")
    assert "7.9" in codes(validate(bad, CAT))


def test_hinge_cap_follows_decor_in():
    d = commands.set_setup(t("T01", 700, 1300), color_out="golden_oak", color_in="golden_oak")
    cell = validate(d, CAT)["geometry"]["cells"][0]
    assert "fornax.tilt_turn.hinge_cap_zoldub" in [f["code"] for f in cell["fittings"]]


# ---------- декоры ----------
@pytest.mark.parametrize("out,inn,group", [("white", "white", "Белый"), ("golden_oak", "white", "Внешний внутренний"),
                                           ("golden_oak", "mahogany", "Ламинация"), ("anthracite", "white", "Эксклюзив")])
def test_price_group(out, inn, group):
    assert price_group(CAT, "akfa__6000_qvt", out, inn) == group


# ---------- цена ----------
def test_price_in_market_corridor():
    r = calc(commands.set_extras(t("T03", 1400, 1300), install=False), CAT, DEMO)
    assert r["can_quote"] and 550_000 <= r["price"]["per_m2"] <= 900_000
    assert r["price"]["total"] % 1000 == 0


def test_real_company_blocks_without_prices():
    r = calc(t("T03", 1400, 1300), CAT, Company())        # работы не заданы, демо выключено
    assert "P.1" in codes(r) and not r["can_quote"]


def test_role_hides_cost():
    r = calc(t("T03"), CAT, DEMO, role="measurer")
    assert "cost" not in r["price"] and all("cost" not in l for l in r["bom"])


def test_markup_modes():
    d = commands.set_extras(t("T03"), install=False)
    pct, margin = Company.demo(), Company.demo()
    margin.markup_kind = "margin"
    a, b = calc(d, CAT, pct)["price"], calc(d, CAT, margin)["price"]
    assert a["total"] == pytest.approx(a["cost"] * 1.3, abs=1000)          # 30% на себестоимость
    assert b["total"] == pytest.approx(b["cost"] / 0.7, abs=1000)          # 30% — доля маржи в цене
    assert b["total"] > a["total"]


def test_dealer_mode_more_expensive():
    d = commands.set_extras(t("T03"), install=False)
    a = calc(d, CAT, DEMO)["price"]["total"]
    dealer = Company.demo(); dealer.mode = "dealer"
    assert calc(d, CAT, dealer)["price"]["total"] > a


# ---------- заказ, варианты, раскрой ----------
def test_quote_variants_three_kits():
    v = quote_variants([t("T03", 1400, 1300, id="p1"), t("T01", 700, 1300, id="p2")], CAT, DEMO)
    assert [x["kit"] for x in v] == ["Эконом", "Стандарт", "Тёплый"]
    assert all(x["total"] > 0 for x in v)


def test_order_total_and_discount():
    o = calc_order([t("T03", id="p1")], CAT, DEMO, discount_pct=10)
    full = calc_order([t("T03", id="p1")], CAT, DEMO)
    assert o["total"] < full["total"]


def test_cutting_bfd():
    bars = cut([2000, 2000, 1500, 1500, 1000], 6000, 4)
    assert len(bars) == 2 and all(sum(b["cuts"]) <= 6000 for b in bars)
    r = order_cutting([t("T03", id="p1"), t("T03", id="p2")], CAT, DEMO)
    assert any(i["bars"] >= 1 for i in r["items"])


# ---------- замены ----------
def test_alternatives_fittings_only_compatible():
    a = alternatives(t("T01", 700, 1300), CAT, DEMO, "fittings")
    vals = {o["value"] for o in a["options"]}
    assert "fornax" in vals and "alu_uz" in {o["value"] for o in a["locked"]}


def test_alternatives_glass_respects_beads():
    a = alternatives(t("T02", 1000, 1300), CAT, DEMO, "glass")
    assert "g4_16_4" in {o["value"] for o in a["locked"]}
    assert "g4_12_4i" in {o["value"] for o in a["options"]}


def test_alternatives_handles_with_delta():
    a = alternatives(t("T01", 700, 1300), CAT, DEMO, "option:handle", path="")
    toulon = next(o for o in a["options"] if o["value"].endswith("hoppe_toulon"))
    assert toulon["delta"] > 0
