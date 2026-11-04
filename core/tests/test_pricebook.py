import json
from datetime import date
from pathlib import Path

from mebel_core import DEMO_PRICES, PriceItem, build, client_view, estimate, estimate_range, supplier_order

TREE = json.loads((Path(__file__).parent / "fixtures" / "wardrobe_full.json").read_text(encoding="utf-8"))


def test_custom_price_book_changes_estimate() -> None:
    result = build(TREE)
    base = estimate(result)
    pb = DEMO_PRICES.model_copy(deep=True)
    pb.source = "catalog:eman"
    pb.sheets["ldsp_16_white"] = PriceItem(id="ldsp_16_white", name="ЛДСП 16 Белый (каталог)", unit="лист",
                                           price=600_000)
    e = estimate(result, prices=pb)
    sheets = e.sheets["ldsp_16_white"]
    assert e.cost_total - base.cost_total == sheets * (600_000 - DEMO_PRICES.sheets["ldsp_16_white"].price)
    assert e.price_source == "catalog:eman" and all(l.source == "catalog:eman" for l in e.lines)
    assert supplier_order(result, prices=pb).goods_total > supplier_order(result).goods_total


def test_stale_prices_flagged() -> None:
    result = build(TREE)
    pb = DEMO_PRICES.model_copy(deep=True)
    pb.date = "2026-11-02"
    pb.price_dates = {"ldsp_16_white": "2026-10-01"}
    e = estimate(result, prices=pb, today=date(2026, 11, 5))
    stale = [l for l in e.lines if l.stale]
    assert e.has_stale and [l.key for l in stale] == ["sheet:ldsp_16_white"]
    fresh = estimate(result, prices=pb.model_copy(update={"price_dates": {}}), today=date(2026, 11, 5))
    assert not fresh.has_stale


def test_client_view_reports_stale_without_details() -> None:
    view = client_view(estimate_range(TREE), "total")
    assert "has_stale" in view and set(view) == {"view", "exact", "total", "has_requests", "has_stale", "uncertainty",
                                                 "uncertainty_text", "uncertainty_text_uz"}
