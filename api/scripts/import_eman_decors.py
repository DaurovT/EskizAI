"""Декоры EMAN (core data/eman_decors.json) → каталог БД (админка ADM-04 видит позиции, смета берёт цены).

    uv run python scripts/import_eman_decors.py --database-url sqlite:////path/to/phone.db [--dry-run]

Идемпотентно: позиция ищется по (поставщик eman, sku = id декора); цена, наличие и дата обновляются,
изменение цены пишется в историю. Кромка (`edge`) в каталог листов не идёт — только листы и столешницы.
Цена столешницы — за погонный метр плиты 600 мм (если разобралась из названия).
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mebel_core.decors import STD_SHEET_M2, load_decors  # noqa: E402
from sqlalchemy import select  # noqa: E402

from mebel_api.db import Database, utcnow  # noqa: E402
from mebel_api.models import CatalogItem, PriceHistory  # noqa: E402
from mebel_api.services.catalog.pipeline import ensure_supplier  # noqa: E402

SOURCE = "eman.uz"


def import_decors(db: Database, *, dry_run: bool = False) -> dict[str, int]:
    stats = {"created": 0, "updated": 0, "skipped": 0}
    now = utcnow()
    with db.sessionmaker() as s:
        sup = ensure_supplier(s, "eman")
        have = {i.sku: i for i in s.scalars(select(CatalogItem).where(CatalogItem.supplier_id == sup.id))}
        for d in load_decors():
            if d["kind"] in ("edge", "hpl") or not d.get("price"):
                stats["skipped"] += 1
                continue
            top = d["kind"] == "countertop"
            if top and not d.get("price_per_m"):
                stats["skipped"] += 1
                continue
            sheet = d.get("sheet_mm") or [2800, 2070]
            price = d["price_per_m"] if top else d["price"]
            if not top and tuple(sheet) != (2800, 2070):  # цена листа 2800×2070 по цене за м²
                price = round(d["price"] / (sheet[0] * sheet[1] / 1e6) * STD_SHEET_M2 / 100) * 100
            it = have.get(d["id"])
            fields = dict(type="countertop" if top else "sheet", name=d["name"], core_key=d["id"],
                          length_mm=sheet[0], width_mm=sheet[1], thickness_mm=d.get("thickness_mm"),
                          decor=(d.get("code") or "")[:120] or None, has_grain=bool(d.get("has_grain")),
                          price=int(price), unit="м" if top else "лист", available=bool(d.get("available", True)))
            if it is None:
                it = CatalogItem(supplier_id=sup.id, sku=d["id"], price_date=now, price_source=SOURCE,
                                 last_seen_at=now, **fields)
                s.add(it)
                s.flush()
                s.add(PriceHistory(item_id=it.id, old_price=None, new_price=it.price, source=SOURCE,
                                   changed_by="import_eman_decors"))
                stats["created"] += 1
            else:
                if it.price != fields["price"]:
                    s.add(PriceHistory(item_id=it.id, old_price=it.price, new_price=fields["price"], source=SOURCE,
                                       changed_by="import_eman_decors"))
                for k, v in fields.items():
                    setattr(it, k, v)
                it.price_date, it.price_source, it.last_seen_at = now, SOURCE, now
                stats["updated"] += 1
        if dry_run:
            s.rollback()
        else:
            s.commit()
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    print(import_decors(Database(a.database_url), dry_run=a.dry_run))


if __name__ == "__main__":
    main()
