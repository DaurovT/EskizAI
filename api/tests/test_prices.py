"""Смета по опубликованному каталогу: позиции с core_key заменяют демо-цены ядра."""

from datetime import datetime, timedelta, timezone

from mebel_core import DEMO_PRICES

from mebel_api.models import CatalogItem, Supplier
from mebel_api.services.prices import catalog_price_book


def add_item(db, *, core_key, type_, price, days_old=0, available=True):
    sup = db.query(Supplier).filter_by(code="eman").one_or_none()
    if sup is None:
        sup = Supplier(code="eman", name="EMAN")
        db.add(sup)
        db.flush()
    db.add(CatalogItem(supplier_id=sup.id, sku=f"SKU-{core_key}", type=type_, name=f"{core_key} (каталог)",
                       core_key=core_key, price=price, unit="лист",
                       price_date=datetime.now(timezone.utc) - timedelta(days=days_old),
                       price_source="eman.uz", available=available))
    db.commit()


def test_empty_catalog_falls_back_to_demo(db):
    assert catalog_price_book(db) is DEMO_PRICES


def test_catalog_overrides_demo_and_carries_dates(db):
    add_item(db, core_key="ldsp_16_white", type_="sheet", price=600_000, days_old=20)
    add_item(db, core_key="slide_550", type_="hardware", price=60_000)
    add_item(db, core_key="hinge", type_="hardware", price=1, available=False)  # нет в наличии — не берём
    pb = catalog_price_book(db)
    assert pb.sheets["ldsp_16_white"].price == 600_000
    assert pb.slides[550] == 60_000
    assert pb.hardware["hinge"].price == DEMO_PRICES.hardware["hinge"].price
    assert "eman.uz" in pb.source


def test_project_estimate_uses_catalog_prices(api, owner, db):
    pid = api.project(owner)
    before = api.c.get(f"/projects/{pid}/estimate", headers=owner).json()
    add_item(db, core_key="ldsp_16_white", type_="sheet", price=2_000_000)
    after = api.c.get(f"/projects/{pid}/estimate", headers=owner).json()
    assert after["cost_materials"]["from"] > before["cost_materials"]["from"]
