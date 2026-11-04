import json
from pathlib import Path

from mebel_core import build, delivery_cost, supplier_order

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def test_order_excludes_requests_and_sums() -> None:
    order = supplier_order(build(load("wardrobe_full")), distance_km=10)
    assert order.excluded  # ХДФ в демо-прайсе — «под запрос»
    keys = {l.key for l in order.lines}
    assert "sheet:hdf_3_white" not in keys and "service:cut:hdf" not in keys
    assert "Распил ХДФ (двухпильный)" in order.excluded
    assert order.goods_total == sum(l.total for l in order.lines)
    assert order.total == order.goods_total + order.delivery.cost
    assert 100 < order.weight_kg < 600


def test_pickup_has_no_delivery() -> None:
    order = supplier_order(build(load("wardrobe_2sec")))
    assert order.delivery is None and order.total == order.goods_total


def test_delivery_rules() -> None:
    small = delivery_cost(200, 3, has_cutting=False)
    assert small.cost == 60_000 + 4 * 5_000  # база + погрузка 4 × 50 кг
    big = delivery_cost(420, 10, has_cutting=True)
    # база + 6 км × 8000 + (420−300)/50 → 3 блока × 5000 + распил 9 × 5000 + погрузка 9 × 5000
    assert big.cost == 60_000 + 48_000 + 15_000 + 45_000 + 45_000
