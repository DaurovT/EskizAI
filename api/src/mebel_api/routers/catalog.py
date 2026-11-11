"""Каталог для мастера: декоры, фурнитура, цены — у каждой цены источник и дата (раздел 7 PRD)."""

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, or_, select

from ..deps import CurrentDep, DbDep
from ..errors import ERROR_RESPONSES
from ..models import CatalogItem, Supplier
from ..services.catalog.pipeline import is_stale

router = APIRouter(prefix="/catalog", tags=["catalog"], responses=ERROR_RESPONSES)


def item_out(i: CatalogItem, supplier: Supplier | None, with_price: bool) -> dict:
    return {
        "id": str(i.id), "sku": i.sku, "type": i.type, "name": i.name, "decor": i.decor,
        "thickness_mm": i.thickness_mm, "length_mm": i.length_mm, "width_mm": i.width_mm, "has_grain": i.has_grain,
        "unit": i.unit, "available": i.available, "core_key": i.core_key,
        "supplier": supplier.name if supplier else None,
        "price": i.price if with_price else None,
        "price_date": i.price_date.isoformat() if with_price else None,
        "price_source": i.price_source if with_price else None,
        "price_stale": is_stale(i),
    }


@router.get("/items", summary="Позиции каталога")
def items(
    current: CurrentDep, db: DbDep,
    q: Annotated[str | None, Query(description="Поиск по наименованию, декору, артикулу")] = None,
    type: Annotated[str | None, Query(description="sheet, edge, hardware, service, countertop, front, other")] = None,
    available: bool | None = None,
    limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
) -> dict:
    """Цена — закупочная цена поставщика: владельцу — с источником и датой; сотруднику цены не показываются.
    `price_stale` — цена не обновлялась больше 14 дней."""
    stmt = select(CatalogItem)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(CatalogItem.name).like(like), func.lower(CatalogItem.decor).like(like),
                              func.lower(CatalogItem.sku).like(like)))
    if type:
        stmt = stmt.where(CatalogItem.type == type)
    if available is not None:
        stmt = stmt.where(CatalogItem.available.is_(available))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = list(db.scalars(stmt.order_by(CatalogItem.type, CatalogItem.name).limit(limit).offset(offset)))
    suppliers = {s.id: s for s in db.scalars(select(Supplier))}
    return {"items": [item_out(i, suppliers.get(i.supplier_id), current.sees_cost) for i in rows],
            "total": total, "limit": limit, "offset": offset}


_UZ_WORDS = [("ЛДСП", "LDSP"), ("ХДФ", "XDF"), ("МДФ", "MDF"), ("Белый", "Oq"), ("Серый", "Kulrang"),
             ("Дуб сонома", "Sonoma eman"), ("Дуб", "Eman"), ("Зеркало", "Oyna"), ("серебро", "kumush"),
             ("Камень серый", "Kulrang tosh"), ("Столешница", "Stoleshnitsa"), ("мм", "mm"),
             ("ЛМДФ", "LMDF"), ("ЛХДФ", "LXDF"), ("Акрил", "Akril"), ("Кромка", "Chet lenta"), ("Чёрный", "Qora"),
             ("Черный", "Qora"), ("Бежевый", "Bej"), ("Орех", "Yong‘oq"), ("Сосна", "Qarag‘ay"), ("Мрамор", "Marmar"),
             ("Бетон", "Beton"), ("Серый", "Kulrang"), ("Светло-серый", "Och kulrang"), ("Зелёный", "Yashil"),
             ("Синий", "Ko‘k"), ("Красный", "Qizil"), ("Коричневый", "Jigarrang")]


def name_uz(name: str) -> str:
    for ru, uz in _UZ_WORDS:
        name = name.replace(ru, uz)
    return name


def _core_materials() -> list:
    """Листовые материалы ядра (то, что ядро принимает в дереве). Список ядра — внутренний модуль
    `mebel_core.catalog`; когда ядро опубликует его в __init__, импорт поменяется."""
    from mebel_core.catalog import MATERIALS

    return [m for m in MATERIALS.values() if m.is_sheet]


FAMILIES = ("white", "grey", "beige", "wood-light", "wood-dark", "black", "colour")


def _eman_row(d: dict, it: CatalogItem | None, sees_cost: bool) -> dict:
    """Декор EMAN из data/eman_decors.json; если позиция опубликована в БД — наличие и цена оттуда."""
    from mebel_core.catalog import DECOR_MATERIALS

    m = DECOR_MATERIALS.get(d["id"])  # у кромки материала ядра нет
    price = it.price if it else d.get("price")
    row = {
        "id": d["id"], "name": d["name"], "name_uz": d.get("name_uz") or name_uz(d["name"]), "kind": m.kind if m else "edge",
        "eman_kind": d["kind"], "decor": d.get("code"), "color": m.color if m else (d.get("color") or "#dddddd"),
        "has_grain": m.has_grain if m else False,
        "thickness": d["thickness_mm"], "texture": d.get("texture"), "texture_size_mm": d.get("texture_size_mm"),
        "finish": m.finish_type if m else "", "available": it.available if it else d.get("available", True),
        "brand": d.get("brand") or "EMAN", "sku": d.get("code"), "source": "eman", "family": d.get("family"),
        "sheet_mm": d.get("sheet_mm"), "source_url": d.get("url"), "price_stale": is_stale(it) if it else False,
    }
    if sees_cost:  # закупочная цена листа; сотруднику цеха не показываем
        row["price"] = price
        row["price_per_m2"] = d.get("price_per_m2")
    return row


@router.get("/decors", summary="Декоры для SCR-09: листовые материалы с id ядра, цветом, текстурой, наличием")
def decors(current: CurrentDep, db: DbDep,
           kind: Annotated[str | None, Query(description="ldsp, mdf, hdf, lmdf, acrylic, hpl, countertop, edge; через запятую — несколько")] = None,
           q: Annotated[str | None, Query(description="Поиск по названию, коду и бренду")] = None,
           brand: Annotated[str | None, Query(description="Бренд: Egger, Ultradecor…")] = None,
           family: Annotated[str | None, Query(description="white, grey, beige, wood-light, wood-dark, black, colour")] = None,
           thickness: Annotated[float | None, Query(description="Толщина, мм")] = None,
           min_thickness: Annotated[float | None, Query(description="Толщина не меньше, мм")] = None,
           available: bool | None = None,
           limit: int = Query(500, ge=1, le=2000), offset: int = Query(0, ge=0)) -> dict:
    """`id` — id материала ядра (его пишут в дерево: body.material, fronts.material). Сначала идут материалы ядра
    (название, наличие, поставщик берутся из опубликованных позиций каталога с `core_key`), затем каталог EMAN
    (`source: "eman"`: бренд, код, текстура, формат листа). `thickness` — мм. `texture` — путь от корня API
    (`/static/textures/…`). Цена листа — только тем, кто видит закупку. Кромка (`kind=edge`) — только по запросу.
    В ответе также `brands` и `families` — значения для фильтров по текущей выборке без учёта brand/family."""
    from mebel_core.catalog import DECOR_MATERIALS, MATERIALS
    from mebel_core.decors import load_decors
    from mebel_core.units import to_mm

    items = db.scalars(select(CatalogItem).where(CatalogItem.type.in_(("sheet", "countertop", "edge")),
                                                 CatalogItem.core_key.is_not(None))
                       .order_by(CatalogItem.updated_at.desc())).all()
    suppliers = {s.id: s for s in db.scalars(select(Supplier))}
    by_key: dict[str, CatalogItem] = {}
    for it in items:
        cur = by_key.get(it.core_key)
        if cur is None or (it.available and not cur.available):
            by_key[it.core_key] = it
    kinds = {k.strip() for k in kind.split(",") if k.strip()} if kind else set()
    rows = []
    for m in _core_materials():
        if m.id in DECOR_MATERIALS:
            continue
        it = by_key.get(m.id)
        name = it.name if it else m.name
        rows.append({
            "id": m.id, "name": name, "name_uz": name_uz(name), "kind": m.kind,
            "decor": (it.decor if it and it.decor else None), "color": m.color, "has_grain": m.has_grain,
            "thickness": to_mm(m.thickness), "texture": m.texture, "finish": m.finish_type,
            "available": it.available if it else True,
            "brand": (suppliers.get(it.supplier_id).name if it and suppliers.get(it.supplier_id) else "EMAN"),
            "sku": it.sku if it else None, "source": "catalog" if it else "core",
            "price_stale": is_stale(it) if it else False,
        })
    for d in load_decors():
        if (d["id"] in DECOR_MATERIALS and d["kind"] != "edge") or (d["kind"] == "edge" and "edge" in kinds):
            rows.append(_eman_row(d, by_key.get(d["id"]), current.sees_cost))

    def match(r: dict, *, skip_facets: bool = False) -> bool:
        if kinds and not kinds & {r["kind"], r.get("eman_kind")}:
            return False
        if min_thickness is not None and r["thickness"] < min_thickness:
            return False
        if thickness is not None and abs(r["thickness"] - thickness) > 0.01:
            return False
        if available is not None and r["available"] is not available:
            return False
        if q and q.strip().lower() not in f"{r['name']} {r['decor'] or ''} {r['name_uz']} {r['brand']}".lower():
            return False
        if not skip_facets:
            if brand and r["brand"].lower() != brand.strip().lower():
                return False
            if family and r.get("family") != family:
                return False
        return True

    base = [r for r in rows if match(r, skip_facets=True)]
    out = [r for r in base if match(r)]
    brands = sorted({r["brand"] for r in base if r["source"] == "eman"})
    fams = [f for f in FAMILIES if any(r.get("family") == f for r in base)]
    return {"items": out[offset:offset + limit], "total": len(out), "limit": limit, "offset": offset,
            "brands": brands, "families": fams}


@router.get("/paint-colors", summary="Палитра краски для МДФ-фасадов: RAL Classic и NCS, степени блеска")
def paint_colors(current: CurrentDep, system: Annotated[str | None, Query(description="RAL или NCS")] = None,
                 q: Annotated[str | None, Query(description="Поиск по коду и названию")] = None) -> dict:
    """`colors[].code` пишут в `fronts.style.paint.code`, `hex` — в `.color`. `gloss[]` — степени блеска с ценой
    покраски за м² одной стороны (статус `analog`; обратная сторона — `back_factor` от неё). `materials` — МДФ под
    покраску (id ядра для `fronts.material`)."""
    from mebel_core import DEMO_PRICES
    from mebel_core.catalog import MATERIALS
    from mebel_core.decors import load_paint
    from mebel_core.units import mm, to_mm

    pal = load_paint()
    colors = [c for c in pal["colors"]
              if (not system or c["system"] == system.upper())
              and (not q or q.strip().lower() in f"{c['code']} {c['name_ru']} {c['name_uz']}".lower())]
    gloss = []
    for g in pal["gloss"]:
        pi = DEMO_PRICES.decor.get(g["price_item"])
        gloss.append({**g, "price_m2": pi.price if pi else None, "price_status": pi.status if pi else None})
    mats = [{"id": m.id, "name": m.name, "thickness": to_mm(m.thickness)}
            for m in MATERIALS.values() if m.id.startswith("mdf_") and m.id.endswith("_paint")
            and m.thickness >= mm(16)]  # МДФ 10 — только заполнение купе, фасадом не бывает
    return {"colors": colors, "gloss": gloss, "materials": sorted(mats, key=lambda m: m["thickness"]),
            "back_factor": DEMO_PRICES.paint_back_factor, "total": len(colors)}
