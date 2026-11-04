"""Позиции «под запрос» (FR-53, ADM-07, SCR-30).

Строка сметы ядра со статусом `request` → строка `price_requests` (pending). Менеджер вводит цену и срок;
цена сохраняется в каталог (позиция с `core_key`) — следующие сметы считают её как обычную, а такие же
позиции в других проектах получают ту же цену. Мастер получает push и принимает или отказывается;
в заказ поставщику позиция попадает только после «принять».
"""

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError
from ..models import CatalogItem, ModelVersion, PriceHistory, PriceRequest, Project, Supplier
from .action_log import log_action

OPEN = ("pending", "priced", "declined")  # всё, кроме «принято», в заказ не идёт
VALID_DAYS = 7  # цена под запрос действует 7 дней, если менеджер не указал срок


def sync(db: Session, project: Project, version: ModelVersion, er) -> None:
    lines = [l for l in er.low.lines if l.status == "request"]
    if not lines:
        return
    existing = {r.line_key: r for r in db.scalars(select(PriceRequest).where(PriceRequest.project_id == project.id))}
    from .supplier_routes import route_for_key

    for line in lines:
        r = existing.get(line.key)
        if r is None:
            supplier = route_for_key(db, line.key)  # позиция без цены уходит поставщику по маршруту категории
            db.add(PriceRequest(project_id=project.id, workshop_id=project.workshop_id, line_key=line.key,
                                name=line.client_name or line.name, unit=line.unit, qty=float(line.qty),
                                estimate_price=line.unit_price, supplier_id=supplier.id if supplier else None))
        elif r.status == "pending":
            r.qty, r.name = float(line.qty), line.client_name or line.name
    db.flush()


def catalog_target(line_key: str) -> tuple[str, str] | None:
    """Ключ строки сметы → (тип позиции каталога, core_key) для прайса ядра (services/prices.py)."""
    parts = line_key.split(":")
    if parts[0] == "sheet" and len(parts) >= 2:
        return "sheet", parts[1]
    if parts[0] == "edge" and len(parts) >= 2:
        return "edge", parts[1]
    if parts[0] == "service" and len(parts) >= 3 and parts[1] == "cut":
        return "service", "cut_hdf" if parts[2] == "hdf" else "cut"
    if parts[0] == "hw" and len(parts) >= 2:
        if parts[1] == "slide" and len(parts) >= 3 and parts[2].isdigit():
            return "hardware", f"slide_{parts[2]}"
        return "hardware", parts[1]
    return None  # столешница по ключу детали и пр. — цена только в заявке


def out(r: PriceRequest, project: Project | None = None) -> dict[str, Any]:
    delta = None
    if r.price is not None:
        delta = round(r.qty * r.price) - round(r.qty * (r.estimate_price or 0))
    o = {
        "id": str(r.id), "project_id": str(r.project_id), "line_key": r.line_key, "name": r.name, "unit": r.unit,
        "qty": r.qty, "status": r.status, "price": r.price, "total": round(r.qty * r.price) if r.price else None,
        "estimate_price": r.estimate_price, "delta": delta, "lead_days": r.lead_days,
        "supplier_name": r.supplier_name, "note": r.note, "priced_at": r.priced_at, "decided_at": r.decided_at,
        "valid_until": r.valid_until,
        "expired": bool(r.valid_until and r.status == "priced" and r.valid_until < utcnow()),
        "created_at": r.created_at,
    }
    if project is not None:
        o["project_title"] = project.title
        o["workshop_id"] = str(project.workshop_id)
    return o


def set_price(db: Session, req: PriceRequest, *, price: int, lead_days: int | None, supplier_name: str | None,
              note: str | None, save_to_catalog: bool, actor: str,
              valid_until: datetime | None = None, actor_type: str = "admin") -> list[PriceRequest]:
    """Цена от поставщика/партнёра. Возвращает все заявки, получившие цену (эта и такие же в других проектах).
    save_to_catalog=False — разовая цена для этой сметы (конструктор поставщика, §5.2): каталог не меняется."""
    from . import events

    if req.status in ("accepted",):
        raise ApiError(409, "already_accepted", "Мастер уже принял цену — изменить её нельзя")
    now = utcnow()
    valid_until = valid_until or now + timedelta(days=VALID_DAYS)
    item_id = None
    target = catalog_target(req.line_key)
    if save_to_catalog and target is not None:
        type_, core_key = target
        supplier = db.get(Supplier, req.supplier_id) if req.supplier_id else None
        if supplier is None:
            from .catalog.pipeline import ensure_supplier

            supplier = ensure_supplier(db, "eman")
        sku = f"REQ-{core_key}"
        item = db.scalar(select(CatalogItem).where(CatalogItem.supplier_id == supplier.id, CatalogItem.sku == sku))
        old_price = item.price if item else None
        if item is None:
            item = CatalogItem(supplier_id=supplier.id, sku=sku, type=type_, name=req.name, core_key=core_key,
                               price=price, unit=req.unit, price_date=now, price_source="manual: под запрос",
                               available=True, last_seen_at=now)
            db.add(item)
        else:
            item.price, item.price_date, item.available = price, now, True
        db.flush()
        db.add(PriceHistory(item_id=item.id, old_price=old_price, new_price=price, source="manual: под запрос",
                            changed_by=actor))
        item_id = item.id
    same = [req]
    if item_id is not None:  # та же позиция в других проектах получает цену из справочника
        stmt = select(PriceRequest).where(PriceRequest.line_key == req.line_key, PriceRequest.status == "pending",
                                          PriceRequest.id != req.id)
        if req.supplier_id is not None:  # цена поставщика — только его позициям
            stmt = stmt.where(PriceRequest.supplier_id == req.supplier_id)
        same += list(db.scalars(stmt))
    for r in same:
        r.status, r.price, r.lead_days = "priced", price, lead_days
        r.supplier_name, r.note, r.catalog_item_id = supplier_name, note, item_id
        r.priced_by, r.priced_at, r.decided_at, r.valid_until = actor, now, None, valid_until
        events.price_request_priced(db, r)
    log_action(db, actor_type=actor_type, actor_id=actor, workshop_id=req.workshop_id, entity="price_request",
               entity_id=req.id, action="price",
               after={"price": price, "lead_days": lead_days, "valid_until": valid_until.isoformat(),
                      "catalog_item_id": str(item_id) if item_id else None,
                      "applied_to": [str(r.id) for r in same]})
    return same


def decide(db: Session, req: PriceRequest, accept: bool, user_id: uuid.UUID) -> PriceRequest:
    if req.status == "pending":
        raise ApiError(409, "not_priced", "Цены ещё нет — менеджер EMAN её уточняет")
    if accept and req.status == "priced" and req.valid_until is not None and req.valid_until < utcnow():
        raise ApiError(409, "price_expired", "Срок цены истёк — напишите менеджеру EMAN, он уточнит цену")
    req.status = "accepted" if accept else "declined"
    req.decided_at = utcnow()
    log_action(db, actor_type="user", actor_id=str(user_id), workshop_id=req.workshop_id, entity="price_request",
               entity_id=req.id, action="accept" if accept else "decline", after={"price": req.price})
    return req


def apply_to_order(db: Session, project: Project, composition: dict[str, Any]) -> dict[str, Any]:
    """Позиции «под запрос», которые мастер ещё не принял, в заказ не идут (вместе с распилом этих листов)."""
    rows = list(db.scalars(select(PriceRequest).where(PriceRequest.project_id == project.id,
                                                      PriceRequest.status.in_(OPEN))))
    if not rows:
        return composition
    blocked = {r.line_key: r for r in rows}
    kinds = set()
    for key in blocked:
        if key.startswith("sheet:"):
            try:
                from mebel_core.catalog import material

                kinds.add(material(key.split(":", 1)[1]).kind)
            except Exception:
                pass
    lines, excluded = [], list(composition.get("excluded") or [])
    for line in composition.get("lines", []):
        key = line.get("key", "")
        waits = key.startswith("service:cut:") and key.rsplit(":", 1)[1] in kinds
        if key in blocked or waits:
            name = blocked[key].name if key in blocked else line.get("name")
            if name not in excluded:
                excluded.append(name)
            continue
        lines.append(line)
    goods = sum(int(l.get("total", 0)) for l in lines)
    delivery = composition.get("delivery")
    return {**composition, "lines": lines, "excluded": excluded, "goods_total": goods,
            "total": goods + (int(delivery["cost"]) if delivery else 0)}
