"""Заказы, позиции, синхронизация офлайн-замера, КП с версиями и публичная страница (S03, S04, S09, S10, S11).

Нужен OYNA_DSN (PostgreSQL со schema.sql и seed_import.py). Без него — 503.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Literal

from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from oyna_core import commands
from oyna_core.api import calc
from oyna_core.commands import CommandError
from oyna_core.cutting import cut_order
from oyna_core.order import calc_order
from oyna_core.price import round_to
from oyna_core.render import render_svg

from . import client_page, store
from .auth import Ctx, ctx, need_company
from .settings import settings

import logging
_log = logging.getLogger("uvicorn.error")
router = APIRouter()
STATUSES = ("measure", "quoted", "agreed", "production", "ready", "installed", "closed", "cancelled")


def _cat():
    from .app import CAT
    return CAT


def _guard(fn):
    try:
        return fn()
    except store.NotFound as e:
        raise HTTPException(404, str(e))
    except CommandError as e:
        raise HTTPException(422, str(e))


class ClientIn(BaseModel):
    name: str | None = None
    phone: str | None = None
    telegram: str | None = None
    lang: Literal["ru", "uz"] | None = None


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
    kit_name: str | None = None
    client: ClientIn | None = None


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


class KitApply(BaseModel):
    kit_name: str
    base_revs: dict[str, int] = Field({}, description="{position_id: rev} — чтобы не затереть чужие правки")


class ExtraIn(BaseModel):
    name: str
    unit: str = "шт"
    qty: float = Field(1, gt=0)
    price_sum: float = Field(..., ge=0)


class QuoteIn(BaseModel):
    lang: Literal["ru", "uz"] = "ru"
    kits: list[str] | None = Field(None, description="имена комплектаций цеха; по умолчанию — первые 3")
    discount_pct: float | None = None


class AcceptIn(BaseModel):
    variant: int = 0


# ---------------- расчёт позиции → кэш и ответ ----------------
def summary(doc: dict, co) -> dict:
    try:
        r = calc(doc, _cat(), co)
    except Exception:                                   # битое изделие с телефона — сохраняем, в итоги не считаем
        return {"total": None, "area_m2": 0, "qty": doc.get("qty", 1), "can_quote": False, "complete": False, "demo": False}
    p = r.get("price") or {}
    qty = doc.get("qty", 1) or 1
    return {"total": p.get("total"), "area_m2": round((p.get("area_m2") or doc["frame"]["w"] * doc["frame"]["h"] / 1e6) * qty, 3),
            "per_m2": p.get("per_m2"), "cost": p.get("cost"), "qty": qty, "can_quote": r["can_quote"],
            "complete": p.get("complete", False), "demo": p.get("demo", False),
            "warns": sum(1 for v in r["violations"] if v["severity"] == "warn" and not v.get("accepted") and v.get("scope") != "price")}


def _pos_out(c, row: dict, co, role: str, names: dict) -> dict:
    r = calc(row["doc"], _cat(), co, role=role)
    for v in r["violations"]:
        if v.get("accepted_by"):
            v["accepted_by_name"] = names.setdefault(v["accepted_by"], (store.user_name(c, v["accepted_by"]) or {}).get("name"))
    d, p = row["doc"], r.get("price") or {}
    s = r["setup"]
    sysrow = _cat().systems.get(s["system"], {})
    return {"id": str(row["id"]), "rev": row["rev"], "sort": row["sort"], "deleted": row["deleted"], "doc": d,
            "room": d.get("room"), "qty": d.get("qty", 1), "size": f"{d['frame']['w']}×{d['frame']['h']}",
            "label": f"{sysrow.get('brand', '')} {sysrow.get('series', '')} · {_cat().decors.get(s['color_out'], {}).get('name_ru', s['color_out'])}".strip(),
            "total": p.get("total"), "per_m2": p.get("per_m2"), "area_m2": p.get("area_m2"), "demo": p.get("demo"),
            "complete": p.get("complete"), "can_quote": r["can_quote"], "violations": r["violations"],
            "warns": sum(1 for v in r["violations"] if v["severity"] == "warn" and not v.get("accepted") and v.get("scope") != "price"),
            "updated_at": store.iso(row["updated_at"]), "updated_by": store.user_name(c, row.get("updated_by"))}


def _who(cx: Ctx) -> str | None:
    return cx.user_id


# ---------------- заказы ----------------
@router.post("/oyna/orders", tags=["заказы"])
def create_order(body: OrderIn, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        return store.jsonable(store.create_order(c, cid, body.model_dump(), body.id))


@router.get("/oyna/orders", tags=["заказы"])
def list_orders(status: str | None = None, q: str | None = None, cx: Ctx = Depends(ctx)):
    """Строка списка: сумма, м², окон, «нет цены: N», блоки, ДЕМО, клиент, последнее КП и согласованный вариант."""
    cid = need_company(cx)
    with store.conn() as c:
        rows = []
        for r in store.list_orders(c, cid, status, q):
            r = store.jsonable(r)
            r["total"] = (float(r["total"]) if r["total"] is not None else 0) + float(r["extras_total"] or 0)
            for k in ("area_m2", "extras_total", "accepted_total"):
                r[k] = float(r[k]) if r[k] is not None else None
            rows.append(r)
        return rows


@router.get("/oyna/orders/counts", tags=["заказы"], summary="Счётчики по статусам для вкладок списка")
def counts(cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        return store.order_counts(c, cid)


@router.get("/oyna/orders/{order_id}", tags=["заказы"])
def get_order(order_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        co = cx.company
        o = _guard(lambda: store.get_order_row(c, cid, order_id))
        names: dict = {}
        pos = [_pos_out(c, p, co, cx.role, names) for p in store.positions(c, order_id)]
        ex = store.extras(c, order_id)
        client = c.execute("SELECT id, name, phone, telegram, lang FROM clients WHERE id = %s", (o["client_id"],)).fetchone() \
            if o["client_id"] else None
        quotes = []
        for q in c.execute("SELECT * FROM quotes WHERE order_id = %s ORDER BY version DESC", (order_id,)):
            acc = q["variants"][q["accepted_variant"]] if q["accepted_variant"] is not None else None
            quotes.append({"version": q["version"], "token": q["public_token"], "url": public_url(q["public_token"]),
                           "sent_at": store.iso(q["sent_at"]), "demo": q["demo"], "lang": q["lang"],
                           "revoked": q["revoked_at"] is not None, "accepted_at": store.iso(q["accepted_at"]),
                           "accepted_variant": q["accepted_variant"], "accepted_kit": acc and acc["kit"],
                           "accepted_total": acc and acc["total"],
                           "variants": [{"kit": v["kit"], "total": v["total"]} for v in q["variants"]]})
        totals = order_totals(pos, ex, o, co, cx.role)
        return {"order": store.jsonable(o), "client": store.jsonable(client) if client else None, "positions": pos,
                "extras": ex, "quotes": quotes, **totals}


def order_totals(pos: list[dict], ex: list[dict], o: dict, co, role: str) -> dict:
    """Итоги заказа (S04): сумма, м², за м², «от … без заблокированных», ДЕМО; себестоимость и маржа — владельцу."""
    ok = [p for p in pos if p["total"] is not None]
    goods = sum(p["total"] for p in ok)
    extras_total = sum(e["total"] for e in ex)
    disc = float(o.get("discount_pct") or 0)
    total = round_to(goods * (1 - disc / 100), co.rounding_sum) + extras_total
    area = round(sum((p["area_m2"] or 0) * (p["qty"] or 1) for p in pos), 2)
    blocked = [p for p in pos if not p["can_quote"]]
    out = {"total": total, "extras_total": extras_total, "area_m2": area, "per_m2": round(goods / area) if area else None,
           "units": sum(p["qty"] or 1 for p in pos), "can_quote": bool(pos) and not blocked,
           "blocked_positions": [p["id"] for p in blocked], "demo": any(p["demo"] for p in pos),
           "total_without_blocked": round_to(sum(p["total"] or 0 for p in pos if p["can_quote"]) * (1 - disc / 100), co.rounding_sum) + extras_total,
           "total_is_from": bool(blocked), "discount_pct": disc, "kit_name": o.get("kit_name"),
           "quote_outdated": o.get("quote_outdated", False)}
    if co.usd_rate:
        out["total_usd"] = round(total / co.usd_rate, 2)
        out["usd_rate"] = co.usd_rate
    if role == "owner":
        cost = sum(summary(p["doc"], co)["cost"] or 0 for p in pos)
        out.update(cost=round(cost), margin=round(total - extras_total - cost), markup_kind=co.markup_kind,
                   markup_value=co.markup_value, margin_pct=round(100 * (total - extras_total - cost) / (total - extras_total), 1)
                   if total - extras_total else None)
    return out


@router.patch("/oyna/orders/{order_id}", tags=["заказы"])
def patch_order(order_id: str, body: OrderPatch, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    data = body.model_dump(exclude_none=True)
    if "kit_name" in data and data["kit_name"] not in [k["name"] for k in cx.company.kits]:
        raise HTTPException(422, f"нет комплектации «{data['kit_name']}»")
    with store.conn() as c:
        return store.jsonable(_guard(lambda: store.update_order(c, cid, order_id, data)))


@router.post("/oyna/orders/{order_id}/apply-kit", tags=["заказы"], summary="Комплектация на весь заказ одним нажатием (FR-T4)")
def apply_kit(order_id: str, body: KitApply, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    kit = next((k for k in cx.company.kits if k["name"] == body.kit_name), None)
    if not kit:
        raise HTTPException(422, f"нет комплектации «{body.kit_name}»")
    with store.conn() as c:
        _guard(lambda: store.get_order_row(c, cid, order_id))
        conflicts, names = [], {}
        rows = store.positions(c, order_id)
        for p in rows:
            if body.base_revs.get(str(p["id"]), p["rev"]) < p["rev"]:
                conflicts.append({"position_id": str(p["id"]), "rev": p["rev"], "updated_by": store.user_name(c, p["updated_by"])})
        if conflicts:
            return JSONResponse(status_code=409, content={"conflict": True, "positions": conflicts})
        out = []
        for p in rows:
            doc = commands.set_setup(p["doc"], **kit["setup"])
            row = store.put_position(c, cid, order_id, str(p["id"]), doc, p["rev"], summary=summary(doc, cx.company), user_id=_who(cx))
            out.append(_pos_out(c, row, cx.company, cx.role, names))
        c.execute("UPDATE orders SET kit_name = %s WHERE id = %s", (body.kit_name, order_id))
        return {"kit_name": body.kit_name, "positions": out}


@router.get("/oyna/orders/{order_id}/variants", tags=["заказы"], summary="Цена заказа в каждой комплектации цеха (MSummary, Kit)")
def variants(order_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        o = _guard(lambda: store.get_order_row(c, cid, order_id))
        docs = [p["doc"] for p in store.positions(c, order_id)]
        ex_total = sum(e["total"] for e in store.extras(c, order_id))
    out = []
    for k in cx.company.kits:
        r = calc_order(docs, _cat(), cx.company, float(o["discount_pct"] or 0), kit=k, role=cx.role)
        area = sum(d["frame"]["w"] * d["frame"]["h"] / 1e6 * (d.get("qty", 1) or 1) for d in docs)
        out.append({"kit": k["name"], "setup": k["setup"], "total": r["total"] + ex_total, "area_m2": round(area, 2),
                    "per_m2": round(r["total"] / area) if area else None, "demo": r["demo"], "can_quote": r["can_quote"],
                    "blocking": r["blocking"], "current": o.get("kit_name") == k["name"]})
    return out


GROUPS = [("profile", "Профиль"), ("reinforcement", "Армирование"), ("bead", "Штапик"), ("glass", "Стеклопакеты"),
          ("panel", "Панели"), ("fitting", "Фурнитура"), ("connector", "Соединители"), ("seal", "Уплотнитель"),
          ("muntin", "Раскладка"), ("mosquito", "Москитные сетки"), ("addon", "Доп. профили"), ("shutter", "Рольставни и жалюзи"),
          ("grille", "Решётки"), ("loggia", "Лоджия"), ("sill", "Подоконники"), ("drip", "Отливы"),
          ("consumable", "Монтажные материалы"), ("work", "Работы"), ("custom", "Свои строки")]
_GROUP_KEYS = {k for k, _ in GROUPS}


@router.get("/oyna/orders/{order_id}/calc", tags=["заказы"], summary="Расчёт заказа: спецификация группами (S09)")
def order_calc(order_id: str, kit: str | None = None, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    co, cat = cx.company, _cat()
    kitd = next((k for k in co.kits if k["name"] == kit), None) if kit else None
    with store.conn() as c:
        o = _guard(lambda: store.get_order_row(c, cid, order_id))
        docs = [p["doc"] for p in store.positions(c, order_id)]
        ex = store.extras(c, order_id)
    if kitd:
        docs = [commands.set_setup(d, **kitd["setup"]) for d in docs]
    groups: dict = defaultdict(lambda: {"qty": 0.0, "cost": 0.0, "lines": defaultdict(float), "status": set(), "unit": ""})
    auto, missing, rows_for_cut = set(), [], []
    for i, d in enumerate(docs):
        r = calc(d, cat, co, role="owner")
        q = d.get("qty", 1) or 1
        rows_for_cut.append((d.get("id") or f"p{i}", r.get("bom", []), q))
        auto |= {f"{v['code']} {v['title']}" for v in r["violations"] if v["severity"] == "auto_add"}
        for l in r.get("bom", []):
            g = groups[l["kind"]]
            g["qty"] += l["qty"] * q
            g["cost"] += (l.get("cost") or 0) * q
            g["unit"] = l["unit"]
            g["lines"][l.get("article") or l["name"]] += l["qty"] * q
            g["status"].add(l.get("price_status", ""))
            if l.get("price_status") == "none":
                missing.append({"item_id": l.get("item_id"), "name": l["name"], "article": l.get("article"), "kind": l["kind"],
                                "color": r["price_group"], "position_id": d.get("id"), "position": d.get("room")})
    p = cat.passport((docs[0].get("setup") or {}).get("system", "akfa__6000_qvt")) if docs else {}
    bars = {i["article"]: i["bars"] for i in cut_order(rows_for_cut, p.get("bar_mm", 6000), p.get("cut_mm", 4))["items"]} if docs else {}
    owner = cx.role == "owner"
    out_groups = []
    # виды строк, которых нет в GROUPS (новые роли ядра), не теряем — иначе сумма групп меньше себестоимости
    extra_keys = [(k, k) for k in groups if k not in _GROUP_KEYS]
    for key, title in GROUPS + extra_keys:
        if key not in groups:
            continue
        g = groups[key]
        row = {"key": key, "title": title, "qty": round(g["qty"], 3), "unit": g["unit"],
               "price_status": "none" if "none" in g["status"] else "demo" if "demo" in g["status"] else "price",
               "lines": [{"name": k, "qty": round(v, 3), **({"bars": bars[k]} if k in bars else {})} for k, v in g["lines"].items()]}
        if key in ("profile", "reinforcement", "bead"):
            row["bars"] = sum(bars.get(k, 0) for k in g["lines"])
        if owner:
            row["cost"] = round(g["cost"])
        out_groups.append(row)
    if ex:
        out_groups.append({"key": "extras", "title": "Сопутствующие товары", "qty": len(ex), "unit": "поз.",
                           "price_status": "price", "lines": [{"name": e["name"], "qty": e["qty"], "total": e["total"]} for e in ex]})
    total = calc_order(docs, cat, co, float(o["discount_pct"] or 0), role=cx.role)
    res = {"kit": kit, "total": total["total"] + sum(e["total"] for e in ex), "total_usd": total.get("total_usd"),
           "usd_rate": co.usd_rate, "discount_pct": float(o["discount_pct"] or 0), "groups": out_groups,
           "auto_added": sorted(auto), "missing": missing, "demo": total["demo"], "can_quote": total["can_quote"]}
    if owner:
        res.update(cost=total.get("cost"), margin=total.get("margin"), markup_kind=co.markup_kind, markup_value=co.markup_value)
    return res


# ---------------- сопутствующие товары ----------------
@router.post("/oyna/orders/{order_id}/extras", tags=["заказы"], summary="Сопутствующий товар (сетка, жалюзи…) строкой")
def add_extra(order_id: str, body: ExtraIn, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        _guard(lambda: store.put_extra(c, cid, order_id, body.model_dump()))
        return store.extras(c, order_id)


@router.put("/oyna/orders/{order_id}/extras/{extra_id}", tags=["заказы"])
def put_extra(order_id: str, extra_id: str, body: ExtraIn, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        _guard(lambda: store.put_extra(c, cid, order_id, body.model_dump(), extra_id))
        return store.extras(c, order_id)


@router.delete("/oyna/orders/{order_id}/extras/{extra_id}", tags=["заказы"])
def del_extra(order_id: str, extra_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        _guard(lambda: store.get_order_row(c, cid, order_id))
        c.execute("DELETE FROM extra_lines WHERE id = %s AND order_id = %s", (extra_id, order_id))
        return store.extras(c, order_id)


# ---------------- позиции и синхронизация ----------------
@router.put("/oyna/orders/{order_id}/positions/{position_id}", tags=["позиции"])
def put_position(order_id: str, position_id: str, body: PositionPut, cx: Ctx = Depends(ctx)):
    """Сохранить позицию (в т. ч. созданную офлайн). Конфликт ревизий → 409 с серверной версией и автором."""
    cid = need_company(cx)
    with store.conn() as c:
        try:
            row = _guard(lambda: store.put_position(c, cid, order_id, position_id, body.doc, body.base_rev, body.deleted,
                                                    body.force, body.sort, summary(body.doc, cx.company), _who(cx)))
        except store.Conflict as e:
            return JSONResponse(status_code=409, content={"conflict": True, "server": e.server, "client": body.doc})
        return _pos_out(c, row, cx.company, cx.role, {})


@router.post("/oyna/orders/{order_id}/positions/{position_id}/commands", tags=["позиции"])
def position_commands(order_id: str, position_id: str, body: PosCommands, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    cmds = []
    for cmd in body.commands:
        if cmd.get("cmd") == "accept_warning":                  # кто принял — из токена, а не от клиента
            cmd = dict(cmd, user=cx.user_id or "dev")
        cmds.append(cmd)
    with store.conn() as c:
        cur = c.execute("SELECT * FROM order_positions WHERE id = %s AND order_id = %s", (position_id, order_id)).fetchone()
        if not cur:
            raise HTTPException(404, "позиция не найдена")
        doc = _guard(lambda: commands.apply(cur["doc"], cmds))
        try:
            row = store.put_position(c, cid, order_id, position_id, doc, body.base_rev if body.base_rev is not None else cur["rev"],
                                     summary=summary(doc, cx.company), user_id=_who(cx))
        except store.Conflict as e:
            return JSONResponse(status_code=409, content={"conflict": True, "server": e.server, "client": doc})
        return _pos_out(c, row, cx.company, cx.role, {})


@router.post("/oyna/sync", tags=["позиции"])
def sync(body: SyncIn, cx: Ctx = Depends(ctx)):
    """Пакет изменений с телефона после появления сети: заказы и позиции. Каждая позиция — ok или conflict."""
    cid = need_company(cx)
    out = {"orders": [], "positions": []}
    with store.conn() as c:
        for o in body.orders:
            out["orders"].append({"id": str(store.create_order(c, cid, o.model_dump(), o.id)["id"]), "status": "ok"})
        for p in body.positions:
            try:
                row = store.put_position(c, cid, p.order_id, p.position_id, p.doc, p.base_rev, p.deleted, p.force,
                                         summary=summary(p.doc, cx.company), user_id=_who(cx))
                out["positions"].append({"position_id": p.position_id, "status": "ok", "rev": row["rev"]})
            except store.Conflict as e:
                _log.warning("sync conflict pos=%s order=%s base_rev=%s server_rev=%s", p.position_id, p.order_id, p.base_rev, e.server.get("rev"))
                out["positions"].append({"position_id": p.position_id, "status": "conflict", "server": e.server})
            except store.NotFound as e:
                _log.warning("sync error pos=%s order=%s: %s", p.position_id, p.order_id, e)
                out["positions"].append({"position_id": p.position_id, "status": "error", "error": str(e)})
    return out


# ---------------- КП ----------------
def public_url(token: str) -> str:
    return f"{settings().public_base_url}/q/{token}"


EXTRA_RU = {"sill": "подоконник", "drip": "отлив", "slopes": "откосы", "dismantle": "демонтаж", "outside": "работа снаружи"}
EXTRA_UZ = {"sill": "deraza tokchasi", "drip": "otliv", "slopes": "qiyaliklar", "dismantle": "demontaj", "outside": "tashqi ish"}


def describe(doc: dict, lang: str) -> dict:
    """Описание позиции для клиента: система, камеры, стекло, фурнитура, добивки."""
    cat = _cat()
    from oyna_core.model import setup_of
    s = setup_of(doc, cat)
    sysrow = cat.systems.get(s["system"], {})
    p = cat.passport(s["system"])
    names = EXTRA_UZ if lang == "uz" else EXTRA_RU
    ex = [names[k] for k in names if (doc.get("extras") or {}).get(k)]
    dec = lambda x: cat.decors.get(x, {}).get("name_uz" if lang == "uz" else "name_ru", x)
    preset = cat.glass_presets.get(s["glass"])
    glass = preset["formula"].split(" ")[0] if preset else s["glass"]          # g4_12_4i → 4-12-4i
    if preset and preset["glass_code"].endswith("i") and not glass.endswith("i"):
        glass += "i"
    fit = cat.fitting_systems.get(s["fittings"], {}).get("title", s["fittings"]).split(" — ")[0].split(" (")[0]
    return {"system": f"{sysrow.get('brand', '')} {sysrow.get('series', '')}".strip(), "chambers": p.get("chambers"),
            "glass": glass, "fittings": fit,
            "decor": f"{dec(s['color_out'])} / {dec(s['color_in'])}", "extras": ex}


def _variants(co, docs: list[dict], kits: list[dict], discount: float, extras: list[dict], lang: str) -> list[dict]:
    cat, out = _cat(), []
    for k in kits:
        rows, goods, works, demo, blocking = [], 0, 0, False, []
        for d in docs:
            dk = commands.set_setup(d, **k["setup"]) if k["setup"] else d
            r = calc(dk, cat, co, role="owner")
            p = r.get("price") or {}
            demo = demo or p.get("demo", False)
            blocking += [dict(v, position=d.get("id"), room=d.get("room")) for v in r["violations"] if v["severity"] in ("block", "lock")]
            total = p.get("total") or 0
            w_cost = sum(l.get("cost") or 0 for l in r.get("bom", []) if l["kind"] == "work") * (d.get("qty", 1) or 1)
            share = round(total * w_cost / p["cost"]) if p.get("cost") else 0
            goods += total
            works += share
            rows.append({"id": d.get("id"), "room": d.get("room"), "w": d["frame"]["w"], "h": d["frame"]["h"], "qty": d.get("qty", 1),
                         "total": total, "works": share, "desc": describe(dk, lang),
                         "svg": render_svg(dk, cat, co, max_px=320, highlight=False),
                         "violations": [v for v in r["violations"] if v["severity"] == "warn" and v.get("accepted")]})
        ex_total = sum(e["total"] for e in extras)
        total = round_to(goods * (1 - discount / 100), co.rounding_sum) + ex_total
        out.append({"kit": k["name"], "setup": k["setup"], "total": total,
                    "works_total": round_to(works * (1 - discount / 100), co.rounding_sum),
                    "total_usd": round(total / co.usd_rate, 2) if co.usd_rate else None, "demo": demo,
                    "can_quote": not blocking, "blocking": blocking, "positions": rows, "extras": extras})
    return out


@router.post("/oyna/orders/{order_id}/quotes", tags=["КП"])
def create_quote(order_id: str, body: QuoteIn, cx: Ctx = Depends(ctx)):
    """Новая версия КП с замороженными ценами, курсом и версией прайса (FR-Q4). Неполная цена — 409 (P.1)."""
    cid = need_company(cx)
    with store.conn() as c:
        co = cx.company
        o = _guard(lambda: store.get_order_row(c, cid, order_id))
        docs = [p["doc"] for p in store.positions(c, order_id)]
        if not docs:
            raise HTTPException(409, "в заказе нет позиций")
        kits = co.kits or [{"name": "Как в позициях", "setup": {}}]
        if body.kits:
            kits = [k for k in kits if k["name"] in body.kits] or kits
        discount = float(o["discount_pct"] or 0) if body.discount_pct is None else body.discount_pct
        vs = _variants(co, docs, kits[:3], discount, store.extras(c, order_id), body.lang)
        bad = [v for v in vs if not v["can_quote"]]
        if bad:
            return JSONResponse(status_code=409, content={"error": "КП не отправляется: неполная цена или блок",
                                                          "variants": [{"kit": v["kit"], "blocking": v["blocking"]} for v in bad]})
        q = store.create_quote(c, order_id, vs, body.lang, co.usd_rate, any(v["demo"] for v in vs))
        url = public_url(q["public_token"])
        return {"version": q["version"], "token": q["public_token"], "url": f"/q/{q['public_token']}", "public_url": url,
                "pdf_url": url + "/pdf", "telegram_share": f"https://t.me/share/url?url={url}", "demo": q["demo"],
                "variants": [{"kit": v["kit"], "total": v["total"]} for v in vs]}


@router.post("/oyna/orders/{order_id}/quotes/{version}/revoke", tags=["КП"], summary="Отозвать ссылку на КП")
def revoke_quote(order_id: str, version: int, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        _guard(lambda: store.get_order_row(c, cid, order_id))
        if not store.revoke_quote(c, order_id, version):
            raise HTTPException(404, "нет такой версии")
        return {"revoked": True, "version": version}


def _wants_html(request: Request) -> bool:
    return "text/html" in request.headers.get("accept", "")


@router.get("/q/{token}", tags=["КП"])
def public_quote(token: str, request: Request, lang: str | None = None, v: int | None = None):
    """Страница КП для клиента (S11): последняя версия, без себестоимости. Отозванная — статус revoked с контактами цеха.
    Браузер (Accept: text/html) получает HTML-страницу по макету, приложение — JSON."""
    data = _public(token)
    if not _wants_html(request):
        if data["status"] == "not_found":
            raise HTTPException(404, "ссылка недействительна")
        return data
    if data.get("status") != "active":
        return HTMLResponse(client_page.invalid(data if data.get("company") else None, token, lang or "ru"),
                            status_code=200 if data.get("company") else 404)
    return HTMLResponse(client_page.page(data, token, lang, v))


def _public(token: str) -> dict:
    if not store.dsn():
        raise HTTPException(503, "хранение не настроено")
    with store.conn() as c:
        try:
            q, latest = store.quote_by_token(c, token)
        except store.NotFound:
            return {"status": "not_found"}
        o = c.execute("SELECT o.address, o.status, co.name AS company, co.phone AS company_phone, co.logo_url, co.plan, "
                      "cl.name AS client FROM orders o JOIN companies co ON co.id = o.company_id "
                      "LEFT JOIN clients cl ON cl.id = o.client_id WHERE o.id = %s", (q["order_id"],)).fetchone()
        head = {"company": o["company"], "company_phone": o["company_phone"],
                "logo_url": o["logo_url"] if o["plan"] == "pro" else None, "address": o["address"]}
        if latest["revoked_at"]:
            return {"status": "revoked", **head}
        return {"status": "active", **head, "client": o["client"], "version": latest["version"],
                "is_latest": q["id"] == latest["id"], "lang": latest["lang"], "demo": latest["demo"],
                "sent_at": store.iso(latest["sent_at"]), "accepted_at": store.iso(latest["accepted_at"]),
                "accepted_variant": latest["accepted_variant"], "variants": latest["variants"],
                "pdf_url": public_url(latest["public_token"]) + "/pdf", "eskiz_badge": o["plan"] != "pro"}


@router.post("/q/{token}/accept", tags=["КП"])
def accept_quote(token: str, body: AcceptIn):
    """«Согласен»: фиксирует вариант; если КП старше порога цеха и цены выросли — предупреждение (FR-Q5)."""
    return _accept(token, body.variant)


@router.post("/q/{token}/agree", tags=["КП"], include_in_schema=False)
async def agree_form(token: str, request: Request, lang: str = "ru"):
    """«Согласен» со страницы клиента — обычная HTML-форма, затем снова страница (уже «Согласовано»)."""
    form = parse_qs((await request.body()).decode())
    variant = int((form.get("variant") or ["0"])[0])
    _accept(token, variant)
    return RedirectResponse(f"/q/{token}?lang={lang}", status_code=303)


def _accept(token: str, variant: int) -> dict:
    if not store.dsn():
        raise HTTPException(503, "хранение не настроено")
    cat = _cat()
    body = AcceptIn(variant=variant)
    with store.conn() as c:
        q, latest = _guard(lambda: store.quote_by_token(c, token))
        if latest["revoked_at"]:
            raise HTTPException(410, "предложение отозвано")
        if not 0 <= body.variant < len(latest["variants"]):
            raise HTTPException(422, "нет такого варианта")
        comp = str(c.execute("SELECT company_id FROM orders WHERE id = %s", (latest["order_id"],)).fetchone()["company_id"])
        _, co = store.load_company(c, comp)
        warning = None
        days = (datetime.now(timezone.utc) - latest["sent_at"]).days if latest["sent_at"] else 0
        if days > co.quote_price_check_days:
            v = latest["variants"][body.variant]
            docs = [p["doc"] for p in store.positions(c, str(latest["order_id"]))]
            now = calc_order(docs, cat, co, kit={"name": v["kit"], "setup": v["setup"]}, role="measurer")["total"]
            if now > v["total"]:
                warning = {"code": "Q.5", "msg": f"цены выросли на {100 * (now / v['total'] - 1):.1f}% с {latest['sent_at']:%d.%m.%Y}",
                           "current_total": now, "quoted_total": v["total"]}
        row = store.accept_quote(c, latest["id"], body.variant)
        v = latest["variants"][body.variant]
        c.execute("UPDATE orders SET kit_name = %s WHERE id = %s", (v["kit"], latest["order_id"]))
        return {"accepted": True, "version": row["version"], "variant": body.variant, "kit": v["kit"], "total": v["total"],
                "warning": warning}


assert set(STATUSES) == {"measure", "quoted", "agreed", "production", "ready", "installed", "closed", "cancelled"}
