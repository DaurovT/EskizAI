"""Цены цеха (S14, кабинет цен §10): прайс-лист с фильтрами, версии и история, поставщики (§9.7), стекло, импорт Excel/CSV.

Хранение:
  • price_versions (company_id = цех) + item_prices (supplier_id NULL — основной прайс цеха, иначе прайс поставщика).
    Текущая цена = строка последней неотменённой версии по (поставщик, позиция, цвет); price_sum NULL — своя цена убрана.
    Правка в строке — версия 'manual', импорт файла — версия 'import'; «Отменить последний импорт» ставит reverted_at.
  • suppliers, company_suppliers_default (основной поставщик по категории), glass_prices.supplier_id.
Права: владелец и менеджер (наценка — только владелец, она в PATCH /oyna/company).
"""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from oyna_core.glass import GlassError, parse, price_m2
from oyna_core.groups import GROUP_NAMES, SUPPLIER_CATEGORIES, supplier_category

from . import store
from .auth import Ctx, ctx, need_company, require

router = APIRouter(prefix="/oyna/company", tags=["цены"])
PRICE_ROLES = ("owner", "manager")
MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_ROWS = 20000

ROLE_NAMES = {
    "frame": "рама", "sash": "створка", "mullion": "импост", "door_frame": "рама двери", "door_sash": "створка двери",
    "door_mullion": "импост двери", "shtulp": "штульп", "threshold": "порог", "bead_single": "штапик", "bead_igu": "штапик",
    "bead_triple": "штапик", "lambri": "ламбри", "reinforcement": "армирование", "connector": "соединитель",
    "joint_profile": "соединительный профиль", "coupling_profile": "расширитель", "thermo_insert": "термовставка",
    "fit_hinge": "петли", "fit_handle": "ручка", "fit_lock": "замок", "fit_scissors": "ножницы", "fit_drive": "привод",
    "fit_set": "комплект фурнитуры", "fit_cap": "накладка", "seal": "уплотнитель", "sill": "подоконник",
    "sill_cap": "заглушка подоконника", "mosquito_profile": "москитный профиль", "corner_cleat": "уголок",
    "machine": "станок", "other": "прочее", "profile_color": "цвет профиля", "lamination": "ламинация",
    "glass_decor": "декор стекла"}
UNIT_NAMES = {"bar": "хлыст", "m": "м", "kg": "кг", "pcs": "шт", "m2": "м²", "pack": "упак.", "pct": "%"}
UNIT_ALIASES = {"bar": ["bar", "хлыст", "хл", "palka", "палка"], "m": ["m", "м", "мп", "м.п", "п.м", "пм", "метр", "metr"],
                "kg": ["kg", "кг"], "pcs": ["pcs", "шт", "штука", "dona", "pc", "ед"], "m2": ["m2", "м2", "м²", "кв.м", "kv.m"],
                "pack": ["pack", "упак", "уп", "бухта", "пачка", "rulon", "рулон"]}
KIND_NAMES = {"base": "базовый прайс", "legacy": "свои цены (до версий)", "manual": "правка", "import": "импорт"}


def _cat():
    from .app import CAT
    return CAT


# ---------------- общие помощники ----------------
def own_supplier(c, cid: str, supplier_id: str | None) -> dict | None:
    if not supplier_id:
        return None
    try:
        uuid.UUID(str(supplier_id))
    except ValueError:
        raise HTTPException(404, "нет такого поставщика")
    row = c.execute("SELECT * FROM suppliers WHERE id = %s AND company_id = %s", (supplier_id, cid)).fetchone()
    if not row:
        raise HTTPException(404, "нет такого поставщика")
    return row


def ensure_items(c, ids) -> None:
    """Позиции каталога из файлов, которых ещё нет в базе (каталог дополняется без повторного seed) — для FK item_prices."""
    ids = set(ids)
    if not ids:
        return
    have = {r["id"] for r in c.execute("SELECT id FROM catalog_items WHERE id = ANY(%s)", (list(ids),))}
    cat = _cat()
    missing = [it for it in cat.items if it["item_id"] in ids - have]
    for it in missing:
        code = it["system_code"] or None
        if code:
            s = cat.systems.get(code) or {}
            c.execute("""INSERT INTO systems (code, brand, series, material_class, passport_class, usable_for_calc, fitting_groove)
                         VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (code) DO NOTHING""",
                      (code, s.get("brand") or it["brand"], s.get("series") or it.get("series") or code,
                       s.get("material_class") or it["material_class"], s.get("passport_class") or None,
                       s.get("usable_for_calc") == "1", s.get("fitting_groove") or None))
        c.execute("""INSERT INTO catalog_items (id, system_code, brand, material_class, article, role, unit, unit_confirmed,
                                                pack_kg, pack_m, needs_review)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""",
                  (it["item_id"], code, it["brand"], it["material_class"], it["article"], it["role"], it["unit"],
                   it.get("unit_confirmed") == "1", float(it["pack_kg"]) if it.get("pack_kg") else None,
                   float(it["pack_m"]) if it.get("pack_m") else None, it.get("needs_review") == "1"))


def ensure_glass_types(c, codes) -> None:
    """Пресеты glass.csv, которых нет в базе (FK glass_prices.glass_code)."""
    cat = _cat()
    for code in codes:
        row = cat.glass_presets.get(code)
        if row:
            c.execute("""INSERT INTO glass_types (code, formula, thickness_mm, glass_mm_total, weight_kg_m2)
                         VALUES (%s,%s,%s,%s,%s) ON CONFLICT (code) DO NOTHING""",
                      (code, row["formula"], int(float(row["thickness_mm"])), int(float(row["glass_mm_total"])),
                       float(row["weight_kg_m2"])))


def new_version(c, cid: str, kind: str, supplier_id: str | None, user_id: str | None, note: str, items: int,
                source: str = "cabinet") -> int:
    return c.execute("""INSERT INTO price_versions (source, note, company_id, supplier_id, kind, created_by, items)
                        VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                     (source, note, cid, supplier_id, kind, user_id, items)).fetchone()["id"]


def save_manual(c, cid: str, user_id: str | None, rows: list[dict]) -> list[int]:
    """Правка цен (в строке кабинета или из приложения) → версия 'manual' на каждого поставщика."""
    by_sup: dict = {}
    for r in rows:
        by_sup.setdefault(r.get("supplier_id") or None, {})[(r["item_id"], r["color"])] = r["price_sum"]
    ensure_items(c, {r["item_id"] for r in rows})
    out = []
    for sid, prices in by_sup.items():
        sup = own_supplier(c, cid, sid)
        note = "Правка цен" + (f" · {sup['name']}" if sup else "")
        v = new_version(c, cid, "manual", sid, user_id, note, len(prices))
        with c.cursor() as cur:
            cur.executemany("INSERT INTO item_prices (price_version_id, item_id, color, price_sum, supplier_id, updated) "
                            "VALUES (%s,%s,%s,%s,%s,%s)",
                            [(v, i, col, p, sid, date.today()) for (i, col), p in prices.items()])
        out.append(v)
    return out


def _f(v) -> float | None:
    return float(v) if v not in (None, "") else None


def price_row(it: dict, co, supplier_id: str | None = None, dates: dict | None = None) -> dict:
    key = (it["item_id"], it["color"])
    base, demo = _f(it["price_sum"]), _f(it.get("demo_price_sum"))
    own = co.item_prices.get(key)
    sup = co.supplier_prices.get(supplier_id, {}).get(key) if supplier_id else None
    value = sup if supplier_id else own
    if sup is not None:
        eff, st = sup, "supplier"
    elif own is not None:
        eff, st = own, "own"
    elif base is not None:
        eff, st = base, "base"
    elif demo is not None:
        eff, st = demo, "demo" if co.demo_prices else "none"
    else:
        eff, st = None, "none"
    dates = dates or {}
    if value is not None:
        upd = dates.get((supplier_id, *key))
    elif own is not None:
        upd = dates.get((None, *key))
    else:
        upd = it.get("price_updated") or None if st == "base" else None
    return {"item_id": it["item_id"], "article": it["article"], "brand": it["brand"], "series": it.get("series", ""),
            "system": it["system_code"], "role": it["role"], "role_name": ROLE_NAMES.get(it["role"], it["role"]),
            "category": supplier_category(it["role"]), "color": it["color"], "unit": it["unit"],
            "unit_name": UNIT_NAMES.get(it["unit"], it["unit"]), "base": base, "demo": demo, "own": own, "supplier": sup,
            "value": value, "effective": eff, "status": st, "no_price": own is None and base is None and sup is None,
            "updated": upd,
            "needs_review": it.get("needs_review") == "1"}


def price_rows(co, keys: list[tuple[str, str]], supplier_id: str | None = None) -> list[dict]:
    by = {(it["item_id"], it["color"]): it for it in _cat().items}
    return [price_row(by[k], co, supplier_id) for k in keys if k in by]


def _dates(c, cid: str) -> dict:
    return {(str(x["supplier_id"]) if x["supplier_id"] else None, x["item_id"], x["color"]): x["loaded_at"].date().isoformat()
            for x in c.execute(store.CURRENT_PRICES_SQL, (cid,))}


# ---------------- прайс-лист ----------------
@router.get("/price-list", summary="Прайс-лист цеха: фильтры по категории, системе, «без цены», ДЕМО; цены поставщика")
def price_list(system: str | None = None, category: str | None = None, role: str | None = None, q: str | None = None,
               color: str | None = None, flag: Literal["missing", "demo", "own", "review"] | None = None,
               supplier_id: str | None = None, offset: int = 0, limit: int = 100, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    limit = max(1, min(limit, 500))
    words = [w for w in (q or "").lower().split() if w]
    co = cx.company
    with store.conn() as c:
        own_supplier(c, cid, supplier_id)
        dates = _dates(c, cid)
    rows, counts = [], {"all": 0, "missing": 0, "demo": 0, "own": 0, "review": 0}
    for it in _cat().items:
        if system and it["system_code"] != system or role and it["role"] != role or color and it["color"] != color:
            continue
        if category and supplier_category(it["role"]) != category:
            continue
        if words:
            hay = f"{it['article']} {it['item_id']} {it['brand']} {it.get('series', '')}".lower()
            if not all(w in hay for w in words):
                continue
        r = price_row(it, co, supplier_id, dates)
        fl = {"missing": r["no_price"], "demo": r["status"] == "demo" or r["no_price"] and r["demo"] is not None,
              "own": r["value"] is not None, "review": r["needs_review"]}
        counts["all"] += 1
        for k, v in fl.items():
            counts[k] += bool(v)
        if flag and not fl[flag]:
            continue
        rows.append(r)
    return {"total": len(rows), "counts": counts, "offset": offset, "rows": rows[offset:offset + limit],
            "demo_prices": co.demo_prices}


@router.get("/price-filters", summary="Справочники фильтров прайс-листа: системы, роли, цвета, категории")
def price_filters(cx: Ctx = Depends(ctx)):
    require(cx, *PRICE_ROLES)
    cat = _cat()
    systems: dict = {}
    for it in cat.items:
        s = systems.setdefault(it["system_code"], {"code": it["system_code"], "brand": it["brand"],
                                                    "series": it.get("series") or it["system_code"], "items": 0})
        s["items"] += 1
    return {"systems": sorted(systems.values(), key=lambda s: (s["brand"], s["series"])),
            "roles": sorted({it["role"] for it in cat.items}, key=lambda r: ROLE_NAMES.get(r, r)),
            "role_names": ROLE_NAMES, "colors": sorted({it["color"] for it in cat.items}),
            "categories": [{"code": k, "name": GROUP_NAMES[k]} for k in SUPPLIER_CATEGORIES]}


@router.get("/prices/history", summary="История цены позиции: версии цеха и базовый прайс")
def price_history(item_id: str, color: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    it = next((x for x in _cat().items if x["item_id"] == item_id and x["color"] == color), None)
    if not it:
        raise HTTPException(404, "нет такой позиции")
    with store.conn() as c:
        rows = c.execute("""SELECT v.id, v.kind, v.note, v.loaded_at, v.reverted_at, ip.price_sum, ip.supplier_id,
                                   s.name AS supplier, u.phone AS by_phone
                            FROM item_prices ip JOIN price_versions v ON v.id = ip.price_version_id
                            LEFT JOIN suppliers s ON s.id = ip.supplier_id LEFT JOIN users u ON u.id = v.created_by
                            WHERE v.company_id = %s AND ip.item_id = %s AND ip.color = %s
                            ORDER BY v.id DESC LIMIT 100""", (cid, item_id, color)).fetchall()
    out = [{"version_id": r["id"], "kind": r["kind"], "kind_name": KIND_NAMES.get(r["kind"], r["kind"]), "note": r["note"],
            "at": r["loaded_at"].isoformat(), "reverted": r["reverted_at"] is not None, "price_sum": _f(r["price_sum"]),
            "supplier_id": str(r["supplier_id"]) if r["supplier_id"] else None, "supplier": r["supplier"], "by": r["by_phone"]}
           for r in rows]
    out.append({"version_id": None, "kind": "base", "kind_name": KIND_NAMES["base"], "note": it.get("source") or "",
                "at": it.get("price_updated") or None, "reverted": False, "price_sum": _f(it["price_sum"]),
                "demo_price_sum": _f(it.get("demo_price_sum")), "supplier": None, "by": None})
    return {"item_id": item_id, "color": color, "article": it["article"], "history": out}


@router.get("/price-versions", summary="Версии цен цеха (правки и импорты)")
def price_versions(limit: int = 50, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    with store.conn() as c:
        rows = c.execute("""SELECT v.*, s.name AS supplier, u.phone AS by_phone FROM price_versions v
                            LEFT JOIN suppliers s ON s.id = v.supplier_id LEFT JOIN users u ON u.id = v.created_by
                            WHERE v.company_id = %s ORDER BY v.id DESC LIMIT %s""", (cid, max(1, min(limit, 500)))).fetchall()
        last = c.execute("SELECT id FROM price_versions WHERE company_id = %s AND kind = 'import' AND reverted_at IS NULL "
                         "ORDER BY id DESC LIMIT 1", (cid,)).fetchone()
    return {"undo_import": last["id"] if last else None,
            "versions": [{"id": r["id"], "kind": r["kind"], "kind_name": KIND_NAMES.get(r["kind"], r["kind"]), "note": r["note"],
                          "source": r["source"], "at": r["loaded_at"].isoformat(), "items": r["items"],
                          "supplier_id": str(r["supplier_id"]) if r["supplier_id"] else None, "supplier": r["supplier"],
                          "by": r["by_phone"], "reverted_at": r["reverted_at"].isoformat() if r["reverted_at"] else None}
                         for r in rows]}


@router.post("/price-versions/undo-import", summary="Отменить последний импорт прайса (его цены перестают действовать)")
def undo_import(cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    with store.conn() as c:
        r = c.execute("""UPDATE price_versions SET reverted_at = now() WHERE id = (
                             SELECT id FROM price_versions WHERE company_id = %s AND kind = 'import' AND reverted_at IS NULL
                             ORDER BY id DESC LIMIT 1) RETURNING id, note, items""", (cid,)).fetchone()
        if not r:
            raise HTTPException(404, "нет импорта, который можно отменить")
    return {"reverted": r["id"], "note": r["note"], "items": r["items"]}


# ---------------- поставщики (§9.7) ----------------
class SupplierIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    note: str | None = Field(None, max_length=500)


class SupplierPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    note: str | None = Field(None, max_length=500)


def _suppliers(c, cid: str) -> dict:
    own, sup = store.current_prices(c, cid)
    glass = {}
    for x in c.execute("SELECT supplier_id, count(*) AS n FROM glass_prices WHERE company_id = %s AND supplier_id IS NOT NULL "
                       "GROUP BY supplier_id", (cid,)):
        glass[str(x["supplier_id"])] = x["n"]
    defaults = {x["category"]: str(x["supplier_id"]) for x in c.execute(
        "SELECT category, supplier_id FROM company_suppliers_default WHERE company_id = %s", (cid,))}
    return {"suppliers": [{"id": str(r["id"]), "name": r["name"], "note": r["note"], "prices": len(sup.get(str(r["id"]), {})),
                           "glass_prices": glass.get(str(r["id"]), 0),
                           "default_for": [k for k, v in defaults.items() if v == str(r["id"])]}
                          for r in c.execute("SELECT * FROM suppliers WHERE company_id = %s ORDER BY created_at", (cid,))],
            "defaults": {k: defaults.get(k) for k in SUPPLIER_CATEGORIES},
            "categories": [{"code": k, "name": GROUP_NAMES[k]} for k in SUPPLIER_CATEGORIES], "own_prices": len(own)}


@router.get("/suppliers", summary="Поставщики цеха и основной по категориям")
def list_suppliers(cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    with store.conn() as c:
        return _suppliers(c, cid)


@router.post("/suppliers", summary="Добавить поставщика")
def add_supplier(body: SupplierIn, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    with store.conn() as c:
        if c.execute("SELECT count(*) AS n FROM suppliers WHERE company_id = %s", (cid,)).fetchone()["n"] >= 50:
            raise HTTPException(422, "не больше 50 поставщиков")
        r = c.execute("INSERT INTO suppliers (company_id, name, note) VALUES (%s,%s,%s) RETURNING id",
                      (cid, body.name.strip(), body.note)).fetchone()
        return dict(_suppliers(c, cid), id=str(r["id"]))


@router.patch("/suppliers/{supplier_id}", summary="Переименовать поставщика")
def patch_supplier(supplier_id: str, body: SupplierPatch, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    data = body.model_dump(exclude_unset=True)
    with store.conn() as c:
        own_supplier(c, cid, supplier_id)
        if data:
            c.execute(f"UPDATE suppliers SET {', '.join(f'{k} = %s' for k in data)} WHERE id = %s", [*data.values(), supplier_id])
        return _suppliers(c, cid)


@router.delete("/suppliers/{supplier_id}", summary="Удалить поставщика вместе с его ценами")
def delete_supplier(supplier_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    with store.conn() as c:
        own_supplier(c, cid, supplier_id)
        c.execute("DELETE FROM item_prices WHERE supplier_id = %s", (supplier_id,))
        c.execute("DELETE FROM price_versions WHERE company_id = %s AND supplier_id = %s", (cid, supplier_id))
        c.execute("DELETE FROM suppliers WHERE id = %s AND company_id = %s", (supplier_id, cid))
        return _suppliers(c, cid)


@router.put("/suppliers/defaults", summary="Основной поставщик по категориям: {profile|glass|fittings|other: id | null}")
def put_supplier_defaults(body: dict[str, str | None], cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    bad = set(body) - set(SUPPLIER_CATEGORIES)
    if bad:
        raise HTTPException(422, f"категории: {', '.join(SUPPLIER_CATEGORIES)}")
    with store.conn() as c:
        for k, sid in body.items():
            c.execute("DELETE FROM company_suppliers_default WHERE company_id = %s AND category = %s", (cid, k))
            if sid:
                own_supplier(c, cid, sid)
                c.execute("INSERT INTO company_suppliers_default (company_id, category, supplier_id) VALUES (%s,%s,%s)", (cid, k, sid))
        return _suppliers(c, cid)


# ---------------- стекло ----------------
@router.get("/glass-list", summary="Стеклопакеты: базовая цена, своя, у поставщика; надбавки формулы")
def glass_list(supplier_id: str | None = None, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    cat = _cat()
    co = cx.company
    with store.conn() as c:
        own_supplier(c, cid, supplier_id)
    own, sup = co.glass_prices, co.supplier_glass_prices.get(supplier_id, {}) if supplier_id else {}
    presets = []
    for code, row in cat.glass_presets.items():
        try:
            g = parse(code, cat)
            base, st, _ = price_m2(g, cat)
            thick = g.thickness_mm
        except GlassError:
            base, st, thick = _f(row.get("price_sum_m2")), row.get("price_status"), _f(row.get("thickness_mm"))
        presets.append({"code": code, "formula": row["formula"], "thickness_mm": thick, "base": base, "base_status": st,
                        "note": row.get("note") or "", "own": own.get(code), "supplier": sup.get(code),
                        "value": sup.get(code) if supplier_id else own.get(code)})
    custom = sorted((set(own) | set(sup)) - set(cat.glass_presets))
    pr = cat.glass_formula["pricing_sum_m2"]
    return {"presets": presets,
            "custom": [{"code": k, "own": own.get(k), "supplier": sup.get(k), "value": sup.get(k) if supplier_id else own.get(k)}
                       for k in custom],
            "pricing": [{"key": k, "base": v.get("value"), "status": v.get("status"), "note": v.get("note") or "",
                         "own": co.glass_pricing.get(k)} for k, v in pr.items()]}


# ---------------- импорт Excel / CSV ----------------
HEADER_GUESS = {"article": ("артик", "код", "article", "sku", "artikul"), "name": ("назв", "наимен", "name", "товар", "nomi", "позиц"),
                "price": ("цена", "price", "стоим", "narx", "сумма"), "currency": ("валют", "currency", "valyuta"),
                "unit": ("ед.", "единиц", "unit", "изм", "o'lchov", "birlik"), "color": ("цвет", "color", "rang")}


def _cell(v) -> Any:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, (int, float)):
        return v
    return str(v).strip()


def read_table(data: bytes, filename: str = "") -> tuple[list[list[Any]], str | None]:
    """Файл → строки таблицы (первый непустой лист xlsx или CSV с автоопределением разделителя и кодировки)."""
    name = (filename or "").lower()
    if name.endswith(".xls") and not data.startswith(b"PK"):
        raise HTTPException(422, "Старый формат .xls — сохраните файл как .xlsx или .csv")
    if name.endswith((".xlsx", ".xlsm")) or data.startswith(b"PK\x03\x04"):
        try:
            import openpyxl
        except ImportError:
            raise HTTPException(422, "xlsx не поддерживается на сервере (нет openpyxl) — загрузите CSV")
        try:
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception as e:
            raise HTTPException(422, f"Не удалось прочитать xlsx: {e}")
        for ws in wb.worksheets:
            rows = [[_cell(v) for v in r] for r in ws.iter_rows(values_only=True)]
            rows = [r for r in rows if any(x != "" for x in r)]
            if rows:
                return rows, ws.title
        return [], None
    for enc in ("utf-8-sig", "cp1251"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise HTTPException(422, "Не удалось определить кодировку CSV (нужен UTF-8 или Windows-1251)")
    sample = text[:8192]
    try:
        delim = csv.Sniffer().sniff(sample, delimiters=";,\t|").delimiter
    except csv.Error:
        first = sample.splitlines()[0] if sample else ""
        delim = max(";,\t|", key=first.count) if first else ","
    rows = [[x.strip() for x in r] for r in csv.reader(io.StringIO(text), delimiter=delim)]
    return [r for r in rows if any(x != "" for x in r)], None


def split_header(rows: list[list[Any]]) -> tuple[list[str], list[list[Any]]]:
    width = max((len(r) for r in rows), default=0)
    for i, r in enumerate(rows[:20]):
        texts = [x for x in r if isinstance(x, str) and x and not _num(x)]
        if len([x for x in r if x != ""]) >= 2 and texts:
            head = [str(x) if x != "" else f"Колонка {j + 1}" for j, x in enumerate(r)] + \
                   [f"Колонка {j + 1}" for j in range(len(r), width)]
            return head, [list(x) + [""] * (width - len(x)) for x in rows[i + 1:]]
    return [f"Колонка {j + 1}" for j in range(width)], [list(x) + [""] * (width - len(x)) for x in rows]


def guess_mapping(columns: list[str]) -> dict:
    out: dict = {}
    for key, words in HEADER_GUESS.items():
        for j, h in enumerate(columns):
            hl = h.lower()
            if j not in out.values() and any(w in hl for w in words):
                out[key] = j
                break
    return out


def _num(s: str) -> bool:
    return bool(re.fullmatch(r"[\d\s., ]+", s.strip())) if isinstance(s, str) else False


def parse_price(v) -> float | None:
    """312 000 | 312,000.50 | 312000,5 | 1.250.000 | «12 500 сум» → число; пусто/текст → None."""
    if isinstance(v, (int, float)):
        return float(v) if v >= 0 else None
    s = re.sub(r"[^\d.,-]", "", str(v or "").replace(" ", "").replace(" ", ""))
    if not s or s.startswith("-") or not re.search(r"\d", s):
        return None
    if "," in s and "." in s:
        dec = "," if s.rfind(",") > s.rfind(".") else "."
        s = s.replace("." if dec == "," else ",", "").replace(dec, ".")
    elif s.count(",") > 1 or s.count(".") > 1:
        s = s.replace(",", "").replace(".", "")
    elif "," in s:
        s = s.replace(",", "") if len(s.split(",")[1]) == 3 else s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _norm(s) -> str:
    s = str(s or "").lower().replace("ё", "е")
    s = re.sub(r"[«»\"'`’]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _tokens(s) -> str:
    return " ".join(sorted(set(re.findall(r"\w+", _norm(s)))))


def _unit(v) -> str | None:
    s = _norm(v).rstrip(".")
    if not s:
        return None
    for code, al in UNIT_ALIASES.items():
        if s in al:
            return code
    return "?" + s


def _currency(v) -> str | None:
    s = _norm(v)
    if not s:
        return None
    if any(w in s for w in ("$", "usd", "дол", "dol")):
        return "USD"
    if any(w in s for w in ("сум", "sum", "uzs", "so'm", "som", "сўм")):
        return "UZS"
    return "?" + s


class ImportMap(BaseModel):
    article: int | None = None
    name: int | None = None
    price: int
    currency: int | None = None
    unit: int | None = None
    color: int | None = None


class ImportIn(BaseModel):
    rows: list[list[Any]] = Field(..., max_length=MAX_IMPORT_ROWS)
    mapping: ImportMap
    currency: Literal["UZS", "USD"] = "UZS"
    color: str | None = Field("Белый", description="цвет для строк без колонки цвета (позиции без цвета «—» находятся всегда)")
    system: str | None = Field(None, description="искать только в этой серии")
    supplier_id: str | None = None
    filename: str | None = None
    note: str | None = None


def match_rows(body: ImportIn, co) -> tuple[list[dict], dict, dict]:
    """Строки файла → совпадения с каталогом (по артикулу/коду, затем по названию) → (строки, сводка, {(item, color): цена})."""
    cat = _cat()
    items = [it for it in cat.items if not body.system or it["system_code"] in (body.system, body.system + "_aksessuarlari")]
    by_id = {it["item_id"]: it for it in items}
    by_norm: dict = {}
    by_tok: dict = {}
    for it in items:
        by_norm.setdefault(_norm(it["article"]), []).append(it)
        by_tok.setdefault(_tokens(it["article"]), []).append(it)
    m = body.mapping
    sid = body.supplier_id

    def cell(r, j):
        return r[j] if j is not None and 0 <= j < len(r) else ""

    out = []
    for n, r in enumerate(body.rows, 1):
        art, name, raw = cell(r, m.article), cell(r, m.name), cell(r, m.price)
        row = {"n": n, "article": str(art), "name": str(name), "price_in": raw, "items": [], "by": None, "msg": ""}
        out.append(row)
        if art == "" and name == "":
            row["status"] = "empty"
            continue
        cands, by = [], None
        if art != "":
            cands = [by_id[str(art)]] if str(art) in by_id else by_norm.get(_norm(art), [])
            by = "article" if cands else None
        if not cands and name != "":
            cands = by_norm.get(_norm(name)) or by_tok.get(_tokens(name)) or []
            by = "name" if cands else None
        if not cands:
            row.update(status="not_found", msg="нет в каталоге")
            continue
        row["by"] = by
        want = cell(r, m.color) if m.color is not None else ""
        want = want if want != "" else (body.color or "")
        if want:
            picked = [it for it in cands if _norm(it["color"]) == _norm(want)] or [it for it in cands if it["color"] == "—"]
            if not picked and len({it["color"] for it in cands}) == 1 and m.color is None:
                picked = cands
            if not picked:
                row.update(status="no_color", msg=f"нет цвета «{want}»: есть " + ", ".join(sorted({it['color'] for it in cands})))
                continue
            cands = picked
        price = parse_price(raw)
        if price is None:
            row.update(status="bad_price", msg="цена не число")
            continue
        cur = _currency(cell(r, m.currency)) if m.currency is not None else None
        cur = cur or body.currency
        if cur.startswith("?"):
            row.update(status="bad_currency", msg=f"валюта «{cur[1:]}»: нужна сум или USD")
            continue
        if cur == "USD":
            if not co.usd_rate:
                row.update(status="no_rate", msg="нет курса доллара — задайте курс цеха")
                continue
            price = price * co.usd_rate
        row["currency"] = cur
        unit = _unit(cell(r, m.unit)) if m.unit is not None else None
        st = "same"
        for it in cands:
            p = price
            if unit and unit != it["unit"]:
                bar_m = cat.passport(it["system_code"]).get("bar_mm", 6000) / 1000 if it["system_code"] in cat.systems else 6.0
                if (unit, it["unit"]) == ("m", "bar"):
                    p = price * bar_m
                elif (unit, it["unit"]) == ("bar", "m"):
                    p = price / bar_m
                else:
                    row.update(status="unit_mismatch", msg=f"единица «{UNIT_NAMES.get(unit, unit.lstrip('?'))}», в каталоге "
                                                           f"«{UNIT_NAMES.get(it['unit'], it['unit'])}»")
                    break
            p = round(p, 2)
            key = (it["item_id"], it["color"])
            cur_val = co.supplier_prices.get(sid, {}).get(key) if sid else co.item_prices.get(key)
            old = cur_val if cur_val is not None else _f(it["price_sum"])
            row["items"].append({"item_id": it["item_id"], "article": it["article"], "color": it["color"],
                                 "system": it["system_code"], "unit": it["unit"], "old": old, "new": p})
            if cur_val is None or abs(cur_val - p) >= 0.01:
                st = "match"
        else:
            row["status"] = st
            if len(row["items"]) > 1:
                row["msg"] = f"{len(row['items'])} позиции"
            continue
        row["items"] = []
    summary: dict = {"rows": len(out)}
    for row in out:
        summary[row["status"]] = summary.get(row["status"], 0) + 1
    summary["by_article"] = sum(1 for x in out if x["by"] == "article" and x["status"] in ("match", "same"))
    summary["by_name"] = sum(1 for x in out if x["by"] == "name" and x["status"] in ("match", "same"))
    changed = {}
    for row in out:
        if row["status"] in ("match", "same"):
            for x in row["items"]:
                changed[(x["item_id"], x["color"])] = x["new"]          # одна позиция в нескольких строках — последняя
    cur_list = co.supplier_prices.get(sid, {}) if sid else co.item_prices
    changed = {k: v for k, v in changed.items() if cur_list.get(k) is None or abs(cur_list[k] - v) >= 0.01}
    summary["items"] = len(changed)
    return out, summary, changed


@router.post("/price-import/parse", summary="Загрузить xlsx или csv (тело запроса — файл) → колонки, строки, догадка сопоставления")
async def import_parse(request: Request, filename: str = "", cx: Ctx = Depends(ctx)):
    need_company(cx); require(cx, *PRICE_ROLES)
    data = await request.body()
    if not data:
        raise HTTPException(422, "Пустой файл")
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "Файл больше 5 МБ")
    rows, sheet = read_table(data, filename)
    if not rows:
        raise HTTPException(422, "В файле нет строк")
    columns, body = split_header(rows)
    if len(body) > MAX_IMPORT_ROWS:
        raise HTTPException(413, f"Больше {MAX_IMPORT_ROWS} строк — разбейте файл")
    return {"filename": filename, "sheet": sheet, "columns": columns, "rows": body, "total": len(body),
            "mapping": guess_mapping(columns), "colors": sorted({it["color"] for it in _cat().items})}


@router.post("/price-import/preview", summary="Предпросмотр совпадений (по артикулу, затем по названию)")
def import_preview(body: ImportIn, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    with store.conn() as c:
        own_supplier(c, cid, body.supplier_id)
    rows, summary, _ = match_rows(body, cx.company)
    return {"summary": summary, "rows": rows}


@router.post("/price-import/apply", summary="Применить импорт как новую версию цен выбранного поставщика")
def import_apply(body: ImportIn, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, *PRICE_ROLES)
    with store.conn() as c:
        sup = own_supplier(c, cid, body.supplier_id)
        _, summary, changed = match_rows(body, cx.company)
        if not changed:
            raise HTTPException(422, "Нечего применять: нет новых цен")
        ensure_items(c, {k[0] for k in changed})
        note = body.note or (f"Импорт {body.filename or 'файла'}" + (f" · {sup['name']}" if sup else "") + f": {len(changed)} цен")
        v = new_version(c, cid, "import", body.supplier_id, cx.user_id, note, len(changed), source=f"import:{body.filename or ''}"[:200])
        with c.cursor() as cur:
            cur.executemany("INSERT INTO item_prices (price_version_id, item_id, color, price_sum, supplier_id, updated) "
                            "VALUES (%s,%s,%s,%s,%s,%s)",
                            [(v, i, col, p, body.supplier_id, date.today()) for (i, col), p in changed.items()])
    return {"version_id": v, "items": len(changed), "note": note, "summary": summary}
