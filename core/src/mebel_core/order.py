"""Заказ материалов у поставщика (US-5, SCR-14, ADM-08).

Из сметы берётся то, что покупается у поставщика: листы, распил, кромкование,
фурнитура, столешницы. Позиции «под запрос» в заказ не идут — помечаются
отдельно и не блокируют остальное (US-5). Вес и доставка — по правилам EMAN
с публичного сайта (docs/eman_research.md), их нужно подтвердить.
"""

import math

from pydantic import BaseModel

from .assembler import BuildResult
from .catalog import material
from .estimate import Estimate, estimate
from .nesting import Nesting, nest
from .units import to_mm

# Плотность, кг/м³ — для оценки веса листов
DENSITY = {"ldsp": 680, "mdf": 750, "hdf": 850, "countertop": 700}
SHEET_AREA_M2 = 5.796  # 2800×2070

# Доставка EMAN (раздел «Оплата и доставка»): ориентир на 02.11.2026
DELIVERY_BASE = 60_000  # до 300 кг и 4 км
DELIVERY_BASE_KG = 300
DELIVERY_BASE_KM = 4
DELIVERY_PER_KM = 8_000
DELIVERY_PER_50KG_OVER = 5_000
DELIVERY_PER_50KG_CUT = 5_000  # если есть листы с распилом
LOADING_PER_50KG = 5_000


class OrderLine(BaseModel):
    key: str
    name: str
    unit: str
    qty: float
    price: int
    total: int


class Delivery(BaseModel):
    weight_kg: float
    distance_km: float
    cost: int
    breakdown: dict[str, int]


class SupplierOrder(BaseModel):
    lines: list[OrderLine]
    excluded: list[str]  # позиции «под запрос» — не в заказе
    goods_total: int
    delivery: Delivery | None
    total: int
    weight_kg: float


def order_weight(result: BuildResult, nesting: Nesting, sheets: dict[str, int]) -> float:
    """Вес: листы целиком (поставщик режет и отдаёт весь лист) + столешницы."""
    kg = 0.0
    for mat_id, count in sheets.items():
        m = material(mat_id)
        kg += count * SHEET_AREA_M2 * to_mm(m.thickness) / 1000 * DENSITY.get(m.kind, 700)
    for p in result.parts:
        m = material(p.material)
        if m.kind == "countertop":
            kg += to_mm(p.length) * to_mm(p.width) * to_mm(p.thickness) / 1e9 * DENSITY["countertop"]
    return round(kg, 1)


def delivery_cost(weight_kg: float, distance_km: float, has_cutting: bool) -> Delivery:
    blocks_over = max(0, math.ceil((weight_kg - DELIVERY_BASE_KG) / 50))
    blocks_all = math.ceil(weight_kg / 50)
    parts = {
        "Базовая доставка": DELIVERY_BASE,
        "Расстояние сверх 4 км": max(0, math.ceil(distance_km - DELIVERY_BASE_KM)) * DELIVERY_PER_KM,
        "Вес сверх 300 кг": blocks_over * DELIVERY_PER_50KG_OVER,
        "Листы с распилом": blocks_all * DELIVERY_PER_50KG_CUT if has_cutting else 0,
        "Погрузка": blocks_all * LOADING_PER_50KG,
    }
    return Delivery(weight_kg=weight_kg, distance_km=distance_km, cost=sum(parts.values()),
                    breakdown={k: v for k, v in parts.items() if v})


def supplier_order(result: BuildResult, est: Estimate | None = None, nesting: Nesting | None = None,
                   distance_km: float | None = None, prices=None) -> SupplierOrder:
    """Состав заказа поставщику по себестоимости. distance_km=None — самовывоз; prices — прайс."""
    nesting = nesting or nest(result)
    est = est or estimate(result, nesting=nesting, prices=prices)
    lines, excluded = [], []
    # Распил листов, которые сами «под запрос», тоже ждёт: без листов его не заказать
    pending_kinds = {material(l.key.split(":", 1)[1]).kind for l in est.lines
                     if l.key.startswith("sheet:") and l.status == "request"}
    for line in est.lines:
        waits_for_sheets = line.key.startswith("service:cut:") and line.key.rsplit(":", 1)[1] in pending_kinds
        if line.status == "request" or waits_for_sheets:
            excluded.append(line.client_name)
            continue
        lines.append(OrderLine(key=line.key, name=line.name, unit=line.unit, qty=line.qty, price=line.unit_price,
                               total=line.cost))
    goods = sum(l.total for l in lines)
    ordered_sheets = {m: n for m, n in est.sheets.items() if material(m).kind not in pending_kinds}
    weight = order_weight(result, nesting, ordered_sheets)
    delivery = None
    if distance_km is not None:
        delivery = delivery_cost(weight, distance_km, has_cutting=any(l.key.startswith("service:cut") for l in lines))
    return SupplierOrder(lines=lines, excluded=excluded, goods_total=goods, delivery=delivery,
                         total=goods + (delivery.cost if delivery else 0), weight_kg=weight)
