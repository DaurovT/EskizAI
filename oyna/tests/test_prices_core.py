"""Ядро без базы: цена по поставщику (основной по категории, setup.suppliers переопределяет) и наценка по группам (§9.7)."""
from dataclasses import replace

from oyna_core import Catalog, Company, calc, commands
from oyna_core.alternatives import alternatives
from oyna_core.groups import line_group, role_group
from oyna_core.price import round_to

CAT = Catalog()
DEMO = Company.demo()
S1, S2, S3 = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"


def doc(**setup):
    d = commands.create_from_template(CAT, "T03")
    if setup:
        d = {**d, "setup": {**(d.get("setup") or {}), **setup}}
    return d


def lines(res, kind):
    return [l for l in res["bom"] if l["kind"] == kind]


def company_with_suppliers():
    base = calc(doc(), CAT, DEMO)
    frame = lines(base, "profile")[0]
    color = next(it["color"] for it in CAT.items if it["item_id"] == frame["item_id"])
    glass = lines(base, "glass")[0]["code"]
    co = replace(DEMO, suppliers={S1: "Стекло-Сервис", S2: "Glass Pro", S3: "Akfa дилер"},
                 default_suppliers={"glass": S1, "profile": S3},
                 supplier_glass_prices={S1: {glass: 200000}, S2: {glass: 250000}},
                 supplier_prices={S3: {(frame["item_id"], color): 123456}},
                 item_prices={(frame["item_id"], color): 99999})
    return co, frame, glass


def test_groups_by_role():
    assert role_group("frame") == "profile" and role_group("fit_handle") == "fittings"
    assert role_group("glass_decor") == "glass" and role_group("sill") == "other"
    assert line_group("work", "install") == "works" and line_group("fitting", "fornax.tilt_turn.x") == "fittings"
    assert line_group("connector", "conn_bay") == "other" and line_group("seal", "") == "profile"


def test_default_supplier_and_position_override():
    co, frame, glass = company_with_suppliers()
    r = calc(doc(), CAT, co)
    g, f = lines(r, "glass")[0], lines(r, "profile")[0]
    assert g["unit_price"] == 200000 and g["supplier_name"] == "Стекло-Сервис"           # основной поставщик стекла
    assert f["unit_price"] == 123456 and f["supplier_name"] == "Akfa дилер"             # поставщик профиля поверх своей цены
    # в позиции — другой поставщик стекла
    r2 = calc(doc(suppliers={"glass": S2}), CAT, co)
    assert lines(r2, "glass")[0]["unit_price"] == 250000 and lines(r2, "glass")[0]["supplier_name"] == "Glass Pro"
    assert lines(r2, "profile")[0]["unit_price"] == 123456                         # профиль — по-прежнему основной
    assert r2["price"]["total"] > r["price"]["total"]
    # у поставщика нет цены → своя цена цеха, без подписи поставщика
    r3 = calc(doc(suppliers={"profile": S1}), CAT, co)
    assert lines(r3, "profile")[0]["unit_price"] == 99999 and "supplier_name" not in lines(r3, "profile")[0]
    # без поставщиков ничего не меняется
    assert calc(doc(), CAT, DEMO)["price"]["total"] == calc(doc(suppliers={"glass": S2}), CAT, DEMO)["price"]["total"]


def test_alternatives_supplier_glass():
    co, _, _ = company_with_suppliers()
    a = alternatives(doc(), CAT, co, "supplier:glass")
    vals = {o["value"]: o for o in a["options"]}
    assert set(vals) == {None, S2} and vals[None]["current"] and vals[S2]["delta"] > 0


def test_markup_groups():
    d = doc()
    co = replace(DEMO, markup_kind="percent", markup_value=30)
    flat = calc(d, CAT, co)["price"]
    grouped = calc(d, CAT, replace(co, markup_groups={"glass": 0, "profile": 100, "works": 0}))["price"]
    assert "by_group" not in flat and set(grouped["by_group"]) >= {"profile", "glass", "fittings", "works"}
    m = {"glass": 0, "profile": 100, "works": 0}
    want = sum(c * (1 + m.get(g, 30) / 100) for g, c in grouped["by_group"].items())
    assert abs(grouped["total"] - round_to(want, co.rounding_sum)) <= co.rounding_sum
    assert grouped["cost"] == flat["cost"] and grouped["total"] != flat["total"]
    # все группы = общей наценке → та же цена
    same = calc(d, CAT, replace(co, markup_groups={g: 30 for g in ("profile", "glass", "fittings", "works", "other")}))["price"]
    assert same["total"] == flat["total"]
    # доля маржи по группам
    mg = calc(d, CAT, replace(co, markup_kind="margin", markup_groups={"glass": 50}))["price"]
    want = sum(c / (1 - (50 if g == "glass" else 30) / 100) for g, c in mg["by_group"].items())
    assert abs(mg["total"] - round_to(want, co.rounding_sum)) <= co.rounding_sum
    # за м² — группы не применяются
    pm = calc(d, CAT, replace(co, markup_kind="per_m2", markup_value=100000, markup_groups={"glass": 0}))["price"]
    assert "by_group" not in pm
    # строки размечены группой; замерщик не видит разбивку
    r = calc(d, CAT, replace(co, markup_groups={"glass": 0}), role="measurer")
    assert "by_group" not in r["price"] and all("group" in l for l in r["bom"])


def test_supplier_name_only_when_not_main_or_many():
    co, _, glass = company_with_suppliers()
    one = replace(co, suppliers={S1: "Стекло-Сервис"}, default_suppliers={"glass": S1}, supplier_prices={},
                  supplier_glass_prices={S1: {glass: 200000}})
    g = lines(calc(doc(), CAT, one), "glass")[0]
    assert g["unit_price"] == 200000 and "supplier_name" not in g            # единственный и основной — без подписи
