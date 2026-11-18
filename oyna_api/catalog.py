"""Каталог и цены (S14, веб): бренды → серии → позиции; очередь ручной разметки ролей (FR-C2).

Чтение — любой сотрудник (с ценами цеха поверх базовых, если вошёл в цех). Разметка ролей — общий каталог,
поэтому только администратор Eskiz (заголовок X-Admin-Token).
"""
from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from . import store
from .auth import Ctx, ctx
from .settings import settings

router = APIRouter(prefix="/oyna/catalog", tags=["каталог"])

ROLES = ["frame", "sash", "mullion", "door_frame", "door_sash", "door_mullion", "shtulp", "threshold", "bead_single",
         "bead_igu", "bead_triple", "lambri", "reinforcement", "connector", "joint_profile", "coupling_profile",
         "thermo_insert", "fit_hinge", "fit_handle", "fit_lock", "fit_scissors", "fit_drive", "fit_set", "fit_cap", "seal",
         "sill", "sill_cap", "mosquito_profile", "corner_cleat", "machine", "other"]
UNITS = ["bar", "m", "kg", "pcs", "m2", "pack"]


def _cat():
    from .app import CAT
    return CAT


def _item(it: dict, cx: Ctx | None) -> dict:
    own = cx.company.item_prices.get((it["item_id"], it["color"])) if cx else None
    return {"item_id": it["item_id"], "system": it["system_code"], "article": it["article"], "color": it["color"],
            "role": it["role"], "unit": it["unit"], "unit_confirmed": it["unit_confirmed"] == "1",
            "pack_kg": it.get("pack_kg") or None, "price_sum": float(it["price_sum"]) if it["price_sum"] else None,
            "demo_price_sum": float(it["demo_price_sum"]) if it.get("demo_price_sum") else None, "own_price_sum": own,
            "price_updated": it["price_updated"], "needs_review": it["needs_review"] == "1"}


@router.get("/brands", summary="Бренды и серии")
def brands():
    cat = _cat()
    out = defaultdict(list)
    for code, s in cat.systems.items():
        out[s["brand"]].append({"system": code, "series": s["series"], "material": s["material_class"],
                                "usable_for_calc": s["usable_for_calc"] == "1", "items": int(s["items"]),
                                "items_without_price": int(s["items_without_price"]), "price_updated": s["price_updated"],
                                "incomplete": s["series_incomplete"] == "1"})
    return [{"brand": b, "series": v} for b, v in sorted(out.items())]


@router.get("/items", summary="Позиции серии / роли / поиска")
def items(system: str | None = None, role: str | None = None, q: str | None = None, color: str | None = None,
          limit: int = 200, cx: Ctx = Depends(ctx)):
    cat = _cat()
    res = []
    for it in cat.items:
        if system and it["system_code"] != system or role and it["role"] != role or color and it["color"] != color:
            continue
        if q and q.lower() not in it["article"].lower():
            continue
        res.append(_item(it, cx))
        if len(res) >= limit:
            break
    return res


@router.get("/review", summary="Очередь разметки: позиции с role = other и бухты без веса")
def review(limit: int = 300):
    return [_item(it, None) for it in _cat().items if it["needs_review"] == "1"][:limit]


class RoleIn(BaseModel):
    role: str
    unit: str | None = None


def _admin(x_admin_token: str | None):
    if x_admin_token != settings().admin_token:
        raise HTTPException(403, "только администратор каталога")


@router.patch("/items/{item_id}/role", summary="Разметить роль позиции (администратор)")
def set_role(item_id: str, body: RoleIn, x_admin_token: str | None = Header(None)):
    _admin(x_admin_token)
    if body.role not in ROLES or body.unit and body.unit not in UNITS:
        raise HTTPException(422, f"роль из {ROLES}, единица из {UNITS}")
    cat = _cat()
    if not any(it["item_id"] == item_id for it in cat.items):
        raise HTTPException(404, "нет такой позиции")
    if store.dsn():
        with store.conn() as c:
            c.execute("""INSERT INTO catalog_role_overrides (item_id, role, unit) VALUES (%s,%s,%s)
                         ON CONFLICT (item_id) DO UPDATE SET role = EXCLUDED.role, unit = EXCLUDED.unit, updated_at = now()""",
                      (item_id, body.role, body.unit))
    cat.apply_role_overrides([{"item_id": item_id, "role": body.role, "unit": body.unit}])
    return _item(next(it for it in cat.items if it["item_id"] == item_id), None)


def load_overrides() -> int:
    """При старте: разметка из базы поверх файлов."""
    if not store.dsn():
        return 0
    try:
        with store.conn() as c:
            rows = list(c.execute("SELECT item_id, role, unit FROM catalog_role_overrides"))
    except Exception:                                    # базы ещё нет — работаем по файлам
        return 0
    _cat().apply_role_overrides(rows)
    return len(rows)
