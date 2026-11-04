"""Деление заказа между поставщиками по категориям строк (docs/staff_vendor_contract.md §4) и комиссия (§4a).

- Категория строки — по ключу строки состава ядра: `sheet:…` → sheet (стекло/металл — glass/metal),
  `edge:` → edge, `countertop:` → countertop, `service:` → service, `hw:glass` → glass, ножки → metal,
  система купе → front, остальная фурнитура → hardware, прочее → other. Нестандарт — категория `nonstandard`.
- Маршрут `supplier_routes` (активный, поставщик не заблокирован) → поставщик; иначе поставщик по умолчанию
  (eman). Заблокирован и он — None (очередь платформы).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Supplier, SupplierCommission, SupplierRoute

DEFAULT_SUPPLIER = "eman"
CATEGORIES = ["sheet", "edge", "hardware", "countertop", "front", "service", "glass", "metal", "other", "nonstandard"]
_METAL_HW = {"leg", "legs", "metal_leg", "support"}
_FRONT_HW = {"profile", "rail", "rollers", "mount_rail"}


def category_of(key: str | None) -> str:
    key = key or ""
    head, _, rest = key.partition(":")
    if head == "sheet":
        try:
            from mebel_core.catalog import material

            kind = material(rest).kind
        except Exception:
            kind = ""
        return {"glass": "glass", "metal": "metal"}.get(kind, "sheet")
    if head in ("edge", "countertop", "service"):
        return head
    if head == "hw":
        kind = rest.split(":", 1)[0]
        if kind == "glass":
            return "glass"
        if kind in _METAL_HW:
            return "metal"
        if kind in _FRONT_HW:
            return "front"
        return "hardware"
    if head == "nonstandard":
        return "nonstandard"
    return "other"


def default_supplier(db: Session) -> Supplier:
    from .catalog.pipeline import ensure_supplier

    return ensure_supplier(db, DEFAULT_SUPPLIER)


def routes(db: Session) -> dict[str, Supplier]:
    out = {}
    for r, s in db.execute(select(SupplierRoute, Supplier).join(Supplier, SupplierRoute.supplier_id == Supplier.id)
                           .where(SupplierRoute.active.is_(True))):
        out[r.category] = s
    return out


def route_for_category(db: Session, category: str, table: dict[str, Supplier] | None = None) -> Supplier | None:
    table = routes(db) if table is None else table
    s = table.get(category)
    if s is not None and s.active:
        return s
    d = default_supplier(db)
    return d if d.active else None


def route_for_key(db: Session, key: str) -> Supplier | None:
    return route_for_category(db, category_of(key))


def split_composition(db: Session, composition: dict[str, Any]) -> list[tuple[Supplier | None, dict[str, Any]]]:
    """Строки состава → [(поставщик, состав)]. Один поставщик — состав без изменений (тот же словарь).
    Доставка, «под запрос» и вес — у основного (по умолчанию) поставщика, иначе у самого крупного."""
    table = routes(db)
    lines = composition.get("lines") or []
    groups: dict[uuid.UUID | None, tuple[Supplier | None, list]] = {}
    order: list[uuid.UUID | None] = []
    for line in lines:
        s = route_for_category(db, category_of(line.get("key")), table)
        sid = s.id if s else None
        if sid not in groups:
            groups[sid] = (s, [])
            order.append(sid)
        groups[sid][1].append(line)
    if len(groups) <= 1:
        s = groups[order[0]][0] if order else route_for_category(db, "sheet", table)
        return [(s, composition)]
    default = default_supplier(db)
    primary = default.id if default.id in groups else max(
        order, key=lambda k: sum(int(l.get("total", 0)) for l in groups[k][1]))
    out = []
    for sid in order:
        s, ls = groups[sid]
        goods = sum(int(l.get("total", 0)) for l in ls)
        main = sid == primary
        delivery = composition.get("delivery") if main else None
        out.append((s, {**composition, "lines": ls, "excluded": composition.get("excluded") or [] if main else [],
                        "goods_total": goods, "delivery": delivery,
                        "total": goods + (int(delivery["cost"]) if delivery else 0),
                        "weight_kg": composition.get("weight_kg") if main else None}))
    out.sort(key=lambda x: (x[0] is None or x[0].id != primary))
    return out


# --- Комиссия (ставка по категориям, с датой начала; старые заказы — по старой ставке) ---


def commission_rate_bp(db: Session, supplier: Supplier, category: str | None, at: datetime) -> int:
    rows = list(db.scalars(select(SupplierCommission).where(SupplierCommission.supplier_id == supplier.id,
                                                            SupplierCommission.effective_from <= at)
                           .order_by(SupplierCommission.effective_from.desc(), SupplierCommission.created_at.desc())))
    for r in rows:
        if r.category == category:
            return r.rate_bp
    for r in rows:
        if r.category is None:
            return r.rate_bp
    return supplier.commission_bp or 0


def order_commission(db: Session, supplier: Supplier | None, composition: dict[str, Any] | None, total: int,
                     at: datetime) -> int:
    """Комиссия по строкам заказа (ставка категории на дату оформления); сверх строк — по общей ставке."""
    if supplier is None or not total:
        return 0
    lines = [l for l in (composition or {}).get("lines") or [] if int(l.get("total") or 0) > 0]
    weight = sum(int(l["total"]) for l in lines)
    if weight:  # средневзвешенная ставка по категориям строк, применённая к сумме заказа (счёт может отличаться)
        bp = sum(int(l["total"]) * commission_rate_bp(db, supplier, category_of(l.get("key")), at)
                 for l in lines) / weight
    else:
        bp = commission_rate_bp(db, supplier, None, at)
    return round(total * bp / 10_000)


def effective_rate_bp(order_total: int, commission: int) -> float:
    return commission * 10_000 / order_total if order_total else 0.0
