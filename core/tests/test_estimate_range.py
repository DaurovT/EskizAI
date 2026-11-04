"""Диапазон цены до замера: ожидаемая цена ± полоса 3–8 % по реальной неопределённости."""

import json
from pathlib import Path

import pytest

from mebel_core import client_view, estimate_range
from mebel_core.estimate import BAND_MAX, BAND_MIN

FIXTURES = Path(__file__).parent / "fixtures"
GOOD = sorted(p.stem for p in FIXTURES.glob("*.json") if not p.stem.startswith("bad"))
PHOTO_SIZES = ["/width", "/height", "/depth"]


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


@pytest.mark.parametrize("name", GOOD)
def test_band_is_narrow_and_centered(name: str) -> None:
    for estimated in (None, PHOTO_SIZES + ["/fronts/material"]):
        er = estimate_range(load(name), estimated=estimated)
        assert BAND_MIN <= er.band <= BAND_MAX
        lo, hi, mid = er.total.low, er.total.high, er.expected
        assert lo < mid < hi
        # с учётом округления до круглых сумм — не шире ±9 % и не уже ±2 %
        assert 0.02 <= (mid - lo) / mid <= 0.09 and 0.02 <= (hi - mid) / mid <= 0.09, (name, lo, mid, hi)
        assert er.uncertainty and er.uncertainty_text.startswith("оценка: ")
        assert er.uncertainty_text_uz.startswith("taxminiy: ")


def test_photo_sizes_widen_band_and_are_explained() -> None:
    tree = load("wardrobe_2sec")
    plain = estimate_range(tree)
    photo = estimate_range(tree, estimated=PHOTO_SIZES)
    assert plain.band == BAND_MIN  # размеры заданы словами — только остаточная неопределённость
    assert photo.band > plain.band
    sizes = next(u for u in photo.uncertainty if u.category == "sizes")
    assert sizes.reason == "размеры по фото, уточнятся на замере" and sizes.name_uz == "o‘lchamlar"
    assert "размеры" in photo.uncertainty_text
    # ширина влияет сильнее глубины
    assert estimate_range(tree, estimated=["/width"]).band >= estimate_range(tree, estimated=["/depth"]).band


def test_estimated_material_marks_its_category() -> None:
    er = estimate_range(load("wardrobe_2sec"), estimated=["/fronts/material"])
    fronts = next(u for u in er.uncertainty if u.category == "fronts")
    assert "материал уточняется" in fronts.reason and "material aniqlanadi" in fronts.reason_uz
    assert er.band >= estimate_range(load("wardrobe_2sec")).band


def test_band_is_capped_at_8_percent() -> None:
    er = estimate_range(load("wardrobe_decor"), estimated=PHOTO_SIZES + ["/fronts/material", "/hardware/hinge"])
    assert er.band == BAND_MAX
    assert er.total.high - er.total.low <= er.expected * 0.17


def test_analog_and_request_items_are_listed() -> None:
    er = estimate_range(load("kupe_3doors"))
    reasons = {u.category: u.reason for u in er.uncertainty}
    assert "цена по аналогу" in reasons["fronts"]  # система купе — по аналогу
    has_request = any(line.status == "request" for line in er.low.lines)
    if has_request:
        assert any("цена уточняется" in r for r in reasons.values())
    # главная причина — первой, в строке не больше трёх
    assert len(er.uncertainty_text.removeprefix("оценка: ").split(", ")) <= 3


def test_exact_after_measurement() -> None:
    er = estimate_range(load("kupe_3doors"), measured=True, estimated=PHOTO_SIZES)
    assert er.exact and er.band == 0 and er.uncertainty == [] and er.uncertainty_text == ""
    assert er.total.low == er.total.high == er.expected
    view = client_view(er, "detailed")
    assert all(g["from"] == g["to"] for g in view["groups"])
    assert view["uncertainty"] == [] and view["uncertainty_text"] == ""


def test_client_view_carries_uncertainty_and_banded_groups() -> None:
    er = estimate_range(load("wardrobe_2sec"), estimated=PHOTO_SIZES)
    view = client_view(er, "detailed")
    assert view["uncertainty_text"] == er.uncertainty_text and view["uncertainty_text_uz"]
    assert {"category", "name", "name_uz", "reason", "reason_uz"} == set(view["uncertainty"][0])
    for g in view["groups"]:
        assert g["from"] <= g["to"]
        if g["to"] > 100_000:
            assert (g["to"] - g["from"]) / ((g["to"] + g["from"]) / 2) <= 2 * BAND_MAX + 0.01
    assert view["materials"]["from"] < view["materials"]["to"]
    text = json.dumps(view, ensure_ascii=False)
    assert "cost" not in text and "EMAN" not in text


def test_kp_compact_range_keeps_narrow_band() -> None:
    from mebel_core.exports.pdf import KP_TEXT, _compact

    t = KP_TEXT["ru"]
    assert _compact({"from": 3_050_000, "to": 3_350_000}, t) == "3,05–3,35 млн"
    assert _compact({"from": 3_000_000, "to": 3_400_000}, t) == "3–3,4 млн"
    assert _compact({"from": 960_000, "to": 1_040_000}, t) == "960 тыс. – 1,04 млн"


def test_kp_pdf_with_uncertainty_note() -> None:
    import mebel_core as mc
    from mebel_core import build

    tree = load("wardrobe_2sec")
    result = build(tree)
    view = client_view(estimate_range(tree, result=result, estimated=PHOTO_SIZES), "short")
    for lang in ("ru", "uz"):
        assert mc.export_kp_pdf(result, view, workshop="Цех", master_phone="+998901234567", language=lang)[:5] == b"%PDF-"
