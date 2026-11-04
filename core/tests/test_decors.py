"""Каталог декоров EMAN (data/eman_decors.json) и палитра краски."""

import re

from mebel_core import DEMO_PRICES
from mebel_core.catalog import DECOR_MATERIALS, MATERIALS, all_materials, material
from mebel_core.decors import load_decors, load_paint


def test_old_ids_still_work():
    for mid in ("ldsp_16_oak", "ldsp_18_white", "mdf_19_paint", "mdf_16_paint", "mdf_22_paint"):
        assert material(mid).id == mid and mid in MATERIALS
    assert len(MATERIALS) < 40  # ИИ видит только короткий список


def test_decors_loaded_and_priced():
    items = load_decors()
    assert len(items) > 500
    assert len({d["id"] for d in items}) == len(items)
    ldsp = [d for d in items if d["kind"] == "ldsp"]
    assert {10 * 1.0, 16, 18} <= {d["thickness_mm"] for d in ldsp} | {10}
    d = next(d for d in ldsp if d["brand"] == "Egger" and d["thickness_mm"] == 16)
    m = material(d["id"])
    assert m.kind == "ldsp" and m.brand == "Egger" and m.code == d["code"]
    assert re.fullmatch(r"ldsp_16_egger_[a-z0-9_]+", d["id"])
    assert DEMO_PRICES.sheets[d["id"]].price > 100_000 and DEMO_PRICES.sheets[d["id"]].status == "catalog"
    assert all(k in all_materials() for k in DECOR_MATERIALS)


def test_texture_fields():
    wood = [d for d in load_decors() if d.get("texture") and d.get("has_grain") and d["kind"] == "ldsp"]
    assert wood and wood[0]["texture_size_mm"] == [1000, 300] and wood[0]["color"].startswith("#")
    assert material(wood[0]["id"]).texture == wood[0]["texture"]


def test_paint_palette_and_mdf_prices():
    pal = load_paint()
    assert sum(c["system"] == "RAL" for c in pal["colors"]) >= 40
    assert sum(c["system"] == "NCS" for c in pal["colors"]) >= 20
    assert all(re.fullmatch(r"#[0-9A-F]{6}", c["hex"]) and c["name_uz"] for c in pal["colors"])
    assert [g["id"] for g in pal["gloss"]] == ["matte", "satin", "gloss"]
    for mid in ("mdf_16_paint", "mdf_19_paint", "mdf_22_paint"):
        assert DEMO_PRICES.sheets[mid].price > 400_000
    assert [DEMO_PRICES.decor[f"paint_{g}"].price for g in ("matte", "satin", "gloss")] == [220_000, 260_000, 380_000]
