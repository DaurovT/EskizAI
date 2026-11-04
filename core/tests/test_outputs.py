"""Раскрой, смета, файлы."""

import io
import json
import zipfile
from pathlib import Path

import ezdxf
import openpyxl
import pytest

from mebel_core import build
from mebel_core.catalog import material
from mebel_core.estimate import PricingSettings, client_view, estimate, estimate_range
from mebel_core.exports.csv_cut import export_csv
from mebel_core.exports.dxf_parts import export_dxf_zip, part_dxf
from mebel_core.exports.xlsx import export_xlsx
from mebel_core.nesting import nest
from mebel_core.rules import DEFAULT_RULES as R

FIXTURES = Path(__file__).parent / "fixtures"
GOOD = ["wardrobe_2sec", "wardrobe_3sec_niche", "wardrobe_full", "kupe_3doors", "rack_no_back"]


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", GOOD)
def test_nesting_places_every_sheet_part_inside_sheet(name: str) -> None:
    result = build(load(name))
    n = nest(result)
    assert n.unplaced == []
    sheet_parts = {p.number for p in result.parts if material(p.material).is_sheet}
    placed = {pl.number for m in n.materials for s in m.sheets for pl in s.parts}
    assert placed == sheet_parts
    usable_l, usable_w = R.sheet_length - 2 * R.sheet_trim, R.sheet_width - 2 * R.sheet_trim
    for m in n.materials:
        for s in m.sheets:
            for pl in s.parts:
                assert pl.x + pl.length <= usable_l and pl.y + pl.width <= usable_w
            # Детали на листе не перекрываются (с учётом пропила)
            rects = [(pl.x, pl.y, pl.x + pl.length + R.sheet_kerf, pl.y + pl.width + R.sheet_kerf) for pl in s.parts]
            for i, a in enumerate(rects):
                for b in rects[i + 1:]:
                    assert a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1]


def test_grain_parts_are_not_rotated() -> None:
    result = build(load("wardrobe_full"))
    n = nest(result)
    oak = next(m for m in n.materials if m.material == "ldsp_18_oak")
    assert all(not pl.rotated for s in oak.sheets for pl in s.parts)


def test_estimate_default_is_plus_50_percent() -> None:
    e = estimate(build(load("wardrobe_full")))
    assert e.materials_client == e.cost_total  # наценка на материалы 0%
    assert e.work == round(e.cost_total * 0.5)
    assert e.total_client == e.cost_total + e.work
    assert e.sheets["ldsp_16_white"] >= 3


def test_estimate_markup_and_fixed_work() -> None:
    result = build(load("wardrobe_full"))
    s = PricingSettings(work_fixed=2_000_000, markup={"body": 10, "fronts": 0, "hardware": 20, "services": 0})
    e = estimate(result, s)
    assert e.work == 2_000_000
    expected = round(e.cost_by_category["body"] * 1.1) + e.cost_by_category["fronts"] \
        + round(e.cost_by_category["hardware"] * 1.2) + e.cost_by_category["services"]
    assert e.materials_client == expected


def test_range_before_measurement_and_exact_after() -> None:
    tree = load("wardrobe_full")
    er = estimate_range(tree)
    assert er.total.low < er.expected == er.low.total_client < er.total.high
    assert er.total.low % 10_000 == 0 and er.total.high % 10_000 == 0  # круглые суммы
    exact = estimate_range(tree, measured=True)
    assert exact.total.low == exact.total.high == exact.low.total_client == exact.expected
    assert exact.band == 0 and exact.uncertainty == [] and exact.uncertainty_text == ""


def test_client_views_never_leak_cost_or_supplier() -> None:
    er = estimate_range(load("kupe_3doors"))
    for view in ("total", "short", "detailed"):
        text = json.dumps(client_view(er, view), ensure_ascii=False)
        for forbidden in ("cost", "markup", "EMAN", "unit_price", "2800×2070", "source"):
            assert forbidden not in text, (view, forbidden)
    assert set(client_view(er, "total")) == {"view", "exact", "total", "has_requests", "has_stale", "uncertainty",
                                             "uncertainty_text", "uncertainty_text_uz"}
    assert {"materials", "work"} <= set(client_view(er, "short"))


def test_csv_has_only_sheet_parts_in_cut_size() -> None:
    result = build(load("kupe_3doors"))
    text = export_csv(result).decode("utf-8-sig")
    rows = [r.split(";") for r in text.strip().split("\r\n")]
    assert rows[0][0] == "№"
    names = {r[1] for r in rows[1:]}
    assert "Зеркало двери-купе" not in names and "Штанга" not in names
    side = next(r for r in rows[1:] if r[1] == "Боковина левая")
    assert side[3] == "2399.6"  # распил: 2400 − 0,4 мм кромки сверху


def test_dxf_layers_and_holes() -> None:
    result = build(load("wardrobe_full"))
    door = next(p for p in result.parts if p.role == "door")
    doc = ezdxf.read(io.StringIO(part_dxf(door).decode()))
    layers = {e.dxf.layer for e in doc.modelspace()}
    assert {"CUT", "FINISH", "DRILL_A_D35_Z13"} <= layers
    archive = zipfile.ZipFile(io.BytesIO(export_dxf_zip(result)))
    assert len(archive.namelist()) == sum(1 for p in result.parts if material(p.material).is_sheet)


def test_xlsx_sheets() -> None:
    result = build(load("wardrobe_full"))
    n = nest(result)
    wb = openpyxl.load_workbook(io.BytesIO(export_xlsx(result, n, estimate(result, nesting=n))))
    assert wb.sheetnames == ["Спецификация", "Фурнитура", "Раскрой", "Смета мастера"]
    no_cost = openpyxl.load_workbook(io.BytesIO(export_xlsx(result, n, estimate(result, nesting=n), with_cost=False)))
    assert "Смета мастера" not in no_cost.sheetnames


@pytest.mark.parametrize("name", ["wardrobe_full", "kitchen_straight", "kupe_3doors"])
def test_pdfs_render(name: str) -> None:
    import mebel_core as mc

    tree = load(name)
    result = build(tree)
    n = nest(result)
    for data in (mc.export_spec_pdf(result), mc.export_cutmaps_pdf(result, n), mc.export_part_drawings_pdf(result),
                 mc.export_general_view_pdf(result), mc.export_assembly_pdf(result)):
        assert data[:5] == b"%PDF-" and len(data) > 5000
    view = client_view(estimate_range(tree, result=result), "detailed")
    for lang in ("ru", "uz"):
        kp = mc.export_kp_pdf(result, view, workshop="Цех", master_phone="+998901234567", language=lang)
        assert kp[:5] == b"%PDF-"


def test_viewer_model_has_sections_types_and_cutouts() -> None:
    from mebel_core import viewer_model

    vm = viewer_model(build(load("wardrobe_full")))
    widths = [round(s["x1"] - s["x0"]) for s in vm["sections"] if s["key"].startswith("sections")]
    assert widths == [570, 596, 570]
    assert vm["materials"]["ldsp_16_white"]["type"] == "matte"
    assert all("cutouts" in p for p in vm["parts"]) and all("parent" in n for n in vm["nodes"])
    kupe = viewer_model(build(load("kupe_3doors")))
    assert kupe["materials"]["mirror_4_silver"]["type"] == "mirror"
