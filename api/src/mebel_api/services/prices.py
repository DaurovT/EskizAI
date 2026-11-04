"""Прайс для сметы: опубликованный каталог → mebel_core.PriceBook.

Позиции каталога с `core_key` и `available=True` заменяют демо-цены ядра;
чего в каталоге нет — считается по демо-прайсу (так смета не ломается, пока
каталог наполняется). У каждой цены своя дата — ядро помечает устаревшие (> 14 дней).

Соответствие типов каталога разделам прайса ядра:
sheet → листы, edge → кромкование, service → услуги (cut, cut_hdf, edging),
hardware → фурнитура (по виду: hinge, slide_550 → направляющие 550 мм …), countertop → столешницы.
"""

from typing import Optional

from mebel_core import DEMO_PRICES, PriceBook, PriceItem
from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from ..models import CatalogItem

_SECTIONS = {"sheet": "sheets", "edge": "edges", "service": "services", "hardware": "hardware",
             "countertop": "countertops"}


def catalog_price_book(db: Optional[Session]) -> PriceBook:
    if db is None:
        return DEMO_PRICES
    items = db.scalars(
        select(CatalogItem).where(CatalogItem.available.is_(True), CatalogItem.core_key.is_not(None))
    ).all()
    if not items:
        return DEMO_PRICES
    pb = DEMO_PRICES.model_copy(deep=True)
    sources = set()
    for it in items:
        key = it.core_key
        date = it.price_date.date().isoformat() if it.price_date else pb.date
        sources.add(it.price_source)
        if it.type == "hardware" and key.startswith("slide_") and key[6:].isdigit():
            pb.slides[int(key[6:])] = it.price
            pb.price_dates[f"slide:{key[6:]}"] = date
            continue
        section = _SECTIONS.get(it.type)
        if not section:
            continue
        getattr(pb, section)[key] = PriceItem(id=key, name=it.name, unit=it.unit, price=it.price, status="catalog")
        pb.price_dates[key] = date
    pb.source = "каталог: " + ", ".join(sorted(sources)) + " (остальное — демо-прайс)"
    return pb


def price_book_for(obj) -> PriceBook:
    """Прайс по любому объекту из базы (цех, проект): сессию берём из него."""
    return catalog_price_book(object_session(obj) if obj is not None else None)
