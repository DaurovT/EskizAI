"""Заказы, позиции, синхронизация офлайн-замера, КП с версиями и публичная страница (S03, S04, S10, S11).

Нужен OYNA_DSN (PostgreSQL со schema.sql и seed_import.py). Без него — 503.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from oyna_core import commands, validate
from oyna_core.api import calc
from oyna_core.commands import CommandError
from oyna_core.order import calc_order
from oyna_core.render import render_svg

from . import store

router = APIRouter()
Role = Literal["owner", "manager", "measurer"]


def _cat():
    from .app import CAT
    return CAT


def _ctx(x_company):
    if not store.dsn():
        raise HTTPException(503, "хранение не настроено (OYNA_DSN)")
    return x_company or "demo"


def _guard(fn):
    try:
        return fn()
    except store.NotFound as e:
        raise HTTPException(404, str(e))
    except CommandError as e:
        raise HTTPException(422, str(e))


class OrderIn(BaseModel):
    id: str | None = Field(None, description="UUID с телефона — заказ создан офлайн")
    address: str | None = None
    floor: int | None = None
    discount_pct: float = 0
    works: dict[str, Any] = {}
    client: dict[str, Any] | None = None


class OrderPatch(BaseModel):
    address: str | None = None
    floor: int | None = None
    status: Literal["measure", "quoted", "agreed", "production", "ready", "installed", "closed", "cancelled"] | None = None
    discount_pct: float | None = None
    works: dict[str, Any] | None = None


class PositionPut(BaseModel):
    doc: dict[str, Any]
    base_rev: int | None = Field(None, description="ревизия, от которой правил клиент; None — новая позиция")
    deleted: bool = False
    force: bool = Field(False, description="перезаписать после показа конфликта")
    sort: int | None = None


class PosCommands(BaseModel):
    commands: list[dict[str, Any]]
    base_rev: int | None = None


class SyncItem(BaseModel):
    order_id: str
    position_id: str
    doc: dict[str, Any]
    base_rev: int | None = None
    deleted: bool = False
    force: bool = False


class SyncIn(BaseModel):
    orders: list[OrderIn] = []
    positions: list[SyncItem] = []


class QuoteIn(BaseModel):
    lang: Literal["ru", "uz"] = "ru"
    kits: list[str] | None = Field(None, description="имена комплектаций цеха; по умолчанию — первые 3")
    discount_pct: float | None = None


class AcceptIn(BaseModel):
    variant: int = 0


def _pos_out(row: dict, cat, co, role: str) -> dict:
    r = calc(row["doc"], cat, co, role=role)
    return {"id": str(row["id"]), "rev": row["rev"], "sort": row["sort"], "deleted": row["deleted"], "doc": row["doc"],
            "total": (r.get("price") or {}).get("total"), "per_m2": (r.get("price") or {}).get("per_m2"),
            "can_quote": r["can_quote"], "violations": r["violations"], "updated_at": store.iso(row["updated_at"])}


# ---------------- заказы ----------------
@router.post("/oyna/orders", tags=["заказы"])
def create_order(body: OrderIn, x_company: str | None = Header(None)):
    comp = _ctx(x_company)
    with store.conn() as c:
        cid, _ = _guard(lambda: store.load_company(c, comp))
        return store.jsonable(store.create_order(c, cid, body.model_dump(), body.id))


@router.get("/oyna/orders", tags=["заказы"])
def list_orders(status: str | None = None, q: str | None = None, x_company: str | None = Header(None)):
    comp = _ctx(x_company)
    with store.conn() as c:
        cid, _ = _guard(lambda: store.load_company(c, comp))
        return [store.jsonable(r) for r in store.list_orders(c, cid, status, q)]


@router.get("/oyna/orders/{order_id}", tags=["заказы"])
def get_order(order_id: str, x_company: str | None = Header(None), x_role: Role = Header("owner")):
    comp = _ctx(x_company)
    with store.conn() as c:
        cid, co = _guard(lambda: store.load_company(c, comp))
        o = _guard(lambda: store.get_order_row(c, cid, order_id))
        pos = [_pos_out(p, _cat(), co, x_role) for p in store.positions(c, order_id)]
        quotes = list(c.execute("SELECT version, public_token, sent_at, accepted_at, accepted_variant, demo FROM quotes "
                                "WHERE order_id = %s ORDER BY version DESC", (order_id,)))
        return {"order": store.jsonable(o), "positions": pos, "quotes": [store.jsonable(q) for q in quotes],
                "total": sum(p["total"] or 0 for p in pos), "can_quote": all(p["can_quote"] for p in pos) and bool(pos)}


@router.patch("/oyna/orders/{order_id}", tags=["заказы"])
def patch_order(order_id: str, body: OrderPatch, x_company: str | None = Header(None)):
    comp = _ctx(x_company)
    with store.conn() as c:
        cid, _ = _guard(lambda: store.load_company(c, comp))
        return store.jsonable(_guard(lambda: store.update_order(c, cid, order_id, body.model_dump(exclude_none=True))))


# ---------------- позиции и синхронизация ----------------
@router.put("/oyna/orders/{order_id}/positions/{position_id}", tags=["позиции"])
def put_position(order_id: str, position_id: str, body: PositionPut, x_company: str | None = Header(None),
                 x_role: Role = Header("owner")):
    """Сохранить позицию (в т. ч. созданную офлайн). Конфликт ревизий → 409 с серверной версией."""
    comp = _ctx(x_company)
    with store.conn() as c:
        cid, co = _guard(lambda: store.load_company(c, comp))
        try:
            row = _guard(lambda: store.put_position(c, cid, order_id, position_id, body.doc, body.base_rev,
                                                    body.deleted, body.force, body.sort))
        except store.Conflict as e:
            return JSONResponse(status_code=409, content={"conflict": True, "server": e.server, "client": body.doc})
        return _pos_out(row, _cat(), co, x_role)


@router.post("/oyna/orders/{order_id}/positions/{position_id}/commands", tags=["позиции"])
def position_commands(order_id: str, position_id: str, body: PosCommands, x_company: str | None = Header(None),
                      x_role: Role = Header("owner")):
    comp = _ctx(x_company)
    with store.conn() as c:
        cid, co = _guard(lambda: store.load_company(c, comp))
        cur = c.execute("SELECT * FROM order_positions WHERE id = %s AND order_id = %s", (position_id, order_id)).fetchone()
        if not cur:
            raise HTTPException(404, "позиция не найдена")
        doc = _guard(lambda: commands.apply(cur["doc"], body.commands))
        try:
            row = store.put_position(c, cid, order_id, position_id, doc, body.base_rev if body.base_rev is not None else cur["rev"])
        except store.Conflict as e:
            return JSONResponse(status_code=409, content={"conflict": True, "server": e.server, "client": doc})
        return _pos_out(row, _cat(), co, x_role)


@router.post("/oyna/sync", tags=["позиции"])
def sync(body: SyncIn, x_company: str | None = Header(None)):
    """Пакет изменений с телефона после появления сети: заказы и позиции. Каждая позиция — ok или conflict."""
    comp = _ctx(x_company)
    out = {"orders": [], "positions": []}
    with store.conn() as c:
        cid, _ = _guard(lambda: store.load_company(c, comp))
        for o in body.orders:
            out["orders"].append({"id": str(store.create_order(c, cid, o.model_dump(), o.id)["id"]), "status": "ok"})
        for p in body.positions:
            try:
                row = store.put_position(c, cid, p.order_id, p.position_id, p.doc, p.base_rev, p.deleted, p.force)
                out["positions"].append({"position_id": p.position_id, "status": "ok", "rev": row["rev"]})
            except store.Conflict as e:
                out["positions"].append({"position_id": p.position_id, "status": "conflict", "server": e.server})
            except store.NotFound as e:
                out["positions"].append({"position_id": p.position_id, "status": "error", "error": str(e)})
    return out


# ---------------- КП ----------------
def _variants(cat, co, docs: list[dict], kits: list[dict], discount: float) -> list[dict]:
    out = []
    for k in kits:
        o = calc_order(docs, cat, co, discount, kit=k, role="measurer")       # без себестоимости
        for p, d in zip(o["positions"], docs):
            p["svg"] = render_svg(commands.set_setup(d, **k["setup"]), cat, co, max_px=320)
            p["violations"] = [v for v in p["violations"] if v["severity"] == "warn" and v.get("accepted")]
        out.append({"kit": k["name"], "setup": k["setup"], "total": o["total"], "total_usd": o.get("total_usd"),
                    "demo": o["demo"], "can_quote": o["can_quote"], "blocking": o["blocking"], "positions": o["positions"]})
    return out


@router.post("/oyna/orders/{order_id}/quotes", tags=["КП"])
def create_quote(order_id: str, body: QuoteIn, x_company: str | None = Header(None)):
    """Новая версия КП с замороженными ценами, курсом и версией прайса (FR-Q4). Неполная цена — 409 (P.1)."""
    comp = _ctx(x_company)
    cat = _cat()
    with store.conn() as c:
        cid, co = _guard(lambda: store.load_company(c, comp))
        o = _guard(lambda: store.get_order_row(c, cid, order_id))
        docs = [p["doc"] for p in store.positions(c, order_id)]
        if not docs:
            raise HTTPException(409, "в заказе нет позиций")
        kits = co.kits or [{"name": "Как в позициях", "setup": {}}]
        if body.kits:
            kits = [k for k in kits if k["name"] in body.kits] or kits
        discount = float(o["discount_pct"] or 0) if body.discount_pct is None else body.discount_pct
        variants = _variants(cat, co, docs, kits[:3], discount)
        bad = [v for v in variants if not v["can_quote"]]
        if bad:
            return JSONResponse(status_code=409, content={"error": "КП не отправляется: неполная цена или блок",
                                                          "variants": [{"kit": v["kit"], "blocking": v["blocking"]} for v in bad]})
        q = store.create_quote(c, order_id, variants, body.lang, co.usd_rate, any(v["demo"] for v in variants))
        return {"version": q["version"], "token": q["public_token"], "url": f"/q/{q['public_token']}", "demo": q["demo"],
                "variants": [{"kit": v["kit"], "total": v["total"]} for v in variants]}


@router.get("/q/{token}", tags=["КП"])
def public_quote(token: str):
    """Страница КП для клиента (S11): последняя версия, без себестоимости."""
    if not store.dsn():
        raise HTTPException(503, "хранение не настроено")
    with store.conn() as c:
        q, latest = _guard(lambda: store.quote_by_token(c, token))
        o = c.execute("SELECT o.address, o.status, co.name AS company, co.phone AS company_phone, co.logo_url, cl.name AS client "
                      "FROM orders o JOIN companies co ON co.id = o.company_id LEFT JOIN clients cl ON cl.id = o.client_id "
                      "WHERE o.id = %s", (q["order_id"],)).fetchone()
        return {"company": o["company"], "company_phone": o["company_phone"], "logo_url": o["logo_url"],
                "client": o["client"], "address": o["address"], "version": latest["version"],
                "is_latest": q["id"] == latest["id"], "lang": latest["lang"], "demo": latest["demo"],
                "sent_at": store.iso(latest["sent_at"]), "accepted_at": store.iso(latest["accepted_at"]),
                "accepted_variant": latest["accepted_variant"], "variants": latest["variants"],
                "eskiz_badge": True}


@router.post("/q/{token}/accept", tags=["КП"])
def accept_quote(token: str, body: AcceptIn):
    """«Согласен»: фиксирует вариант; если КП старше порога цеха и цены выросли — предупреждение (FR-Q5)."""
    if not store.dsn():
        raise HTTPException(503, "хранение не настроено")
    cat = _cat()
    with store.conn() as c:
        q, latest = _guard(lambda: store.quote_by_token(c, token))
        if not 0 <= body.variant < len(latest["variants"]):
            raise HTTPException(422, "нет такого варианта")
        comp = str(c.execute("SELECT company_id FROM orders WHERE id = %s", (latest["order_id"],)).fetchone()["company_id"])
        _, co = store.load_company(c, comp)
        warning = None
        days = (datetime.now(timezone.utc) - latest["sent_at"]).days if latest["sent_at"] else 0
        if days > 14:
            v = latest["variants"][body.variant]
            docs = [p["doc"] for p in store.positions(c, str(latest["order_id"]))]
            now = calc_order(docs, cat, co, kit={"name": v["kit"], "setup": v["setup"]}, role="measurer")["total"]
            if now > v["total"]:
                warning = {"code": "Q.5", "msg": f"цены выросли на {100 * (now / v['total'] - 1):.1f}% с {latest['sent_at']:%d.%m.%Y}",
                           "current_total": now, "quoted_total": v["total"]}
        row = store.accept_quote(c, latest["id"], body.variant)
        return {"accepted": True, "version": row["version"], "variant": body.variant, "warning": warning}
