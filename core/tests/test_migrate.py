import json
from pathlib import Path

import mebel_core as mc

FIXTURES = Path(__file__).parent / "fixtures"


def test_public_api_imports() -> None:
    for name in mc.__all__:
        assert hasattr(mc, name), name


def test_migrate_01_tree_builds() -> None:
    tree = json.loads((FIXTURES / "wardrobe_2sec.json").read_text())
    tree["schema_version"] = "0.1"
    assert mc.build(mc.migrate_tree(tree)).ok


def test_apply_measurements_keeps_sections_consistent() -> None:
    tree = json.loads((FIXTURES / "wardrobe_3sec_niche.json").read_text())
    measured = mc.apply_measurements(tree, width=2387, height=2580)
    r = mc.build(measured)
    assert r.ok, [i.message for i in r.issues]
    assert r.size[0] == 23870


def test_estimate_range_reuses_result() -> None:
    tree = json.loads((FIXTURES / "wardrobe_2sec.json").read_text())
    result = mc.build(tree)
    assert mc.estimate_range(tree, result=result).low.total_client == mc.estimate(result).total_client


def test_apply_measurements_kitchen_fits_base_row() -> None:
    tree = json.loads((FIXTURES / "kitchen_straight.json").read_text())
    measured = mc.apply_measurements(tree, width=2900)  # было 2850
    assert sum(c["width"] for c in measured["base"]) == 2900
    r = mc.build(measured)
    assert r.ok, [i.message for i in r.issues if i.level == "error"]
    # мойка и ниша под технику не меняются
    assert [c["width"] for c in measured["base"] if c["kind"] in ("sink", "appliance")] == [600, 800]


def test_public_catalog_and_rules() -> None:
    assert mc.material("ldsp_16_white").kind == "ldsp" and "hdf_3_white" in mc.MATERIALS
    assert mc.DEFAULT_RULES.sheet_kerf > 0 and mc.DEFAULT_RULES.sheet_trim > 0
