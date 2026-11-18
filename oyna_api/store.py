"""Хранение в PostgreSQL (schema.sql): цеха, заказы, позиции с ревизиями, версии КП.

Синхронизация офлайн-замера (PRD 5): клиент шлёт позицию с base_rev — ревизией, от которой он правил.
  • позиции нет            → создаётся с id клиента (UUID с телефона), rev = 1
  • base_rev == rev сервера → сохраняется, rev + 1
  • base_rev  < rev сервера → конфликт: ответ с обеими версиями; клиент показывает их и шлёт выбранную с force
"""
from __future__ import annotations

import os
import secrets
from contextlib import contextmanager
from datetime import datetime, timezone

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from oyna_core.data import Company

DEMO_NAME = "Демо-цех"


class Conflict(Exception):
    def __init__(self, server: dict):
        self.server = server


class NotFound(Exception):
    pass


def dsn() -> str | None:
    return os.environ.get("OYNA_DSN")


@contextmanager
def conn():
    d = dsn()
    if not d:
        raise RuntimeError("OYNA_DSN не задан — хранение недоступно")
    with psycopg.connect(d, row_factory=dict_row) as c:
        yield c


def _company_row(c, company: str) -> dict:
    if company in (None, "", "demo"):
        row = c.execute("SELECT * FROM companies WHERE name = %s ORDER BY created_at LIMIT 1", (DEMO_NAME,)).fetchone()
    else:
        row = c.execute("SELECT * FROM companies WHERE id = %s", (company,)).fetchone()
    if not row:
        raise NotFound(f"цех {company!r} не найден")
    return row


def load_company(c, company: str) -> tuple[str, Company]:
    r = _company_row(c, company)
    works = {w["work_code"]: (w["unit"], float(w["price_sum"]))
             for w in c.execute("SELECT * FROM work_rates WHERE company_id = %s", (r["id"],))}
    kits = [{"name": k["name"], "setup": k["setup"]}
            for k in c.execute("SELECT * FROM kits WHERE company_id = %s ORDER BY name <> 'Эконом', name", (r["id"],))]
    order = {"Эконом": 0, "Стандарт": 1, "Тёплый": 2}
    kits.sort(key=lambda k: order.get(k["name"], 9))
    items = {(x["item_id"], x["color"]): float(x["price_sum"])
             for x in c.execute("SELECT item_id, color, price_sum FROM company_prices WHERE company_id = %s", (r["id"],))}
    glass = {x["glass_code"]: float(x["price_sum_m2"]) for x in c.execute(
        "SELECT glass_code, price_sum_m2 FROM glass_prices WHERE company_id = %s", (r["id"],))}
    gp = c.execute("SELECT data FROM glass_pricing WHERE company_id = %s ORDER BY updated_at DESC LIMIT 1", (r["id"],)).fetchone()
    co = Company(name=r["name"], mode=r["mode"], dealer_coef=float(r["dealer_coef"] or 0), markup_kind=r["markup_kind"],
                 markup_value=float(r["markup_value"]), usd_rate=float(r["usd_rate"]) if r["usd_rate"] else None,
                 install_gap_mm=r["install_gap_mm"], rounding_sum=r["rounding_sum"], skew_warn_mm=r["skew_warn_mm"],
                 demo_prices=r["demo_prices"], waste_pct=float(r["waste_pct"]),
                 quote_price_check_days=r["quote_price_check_days"], plan=r["plan"], work_rates=works, kits=kits,
                 item_prices=items, glass_prices=glass, glass_pricing=(gp or {}).get("data") or {})
    return str(r["id"]), co


# ---------------- заказы ----------------
def create_order(c, company_id: str, data: dict, order_id: str | None = None) -> dict:
    client_id = None
    if data.get("client"):
        cl = data["client"]
        client_id = c.execute("INSERT INTO clients (company_id, name, phone, telegram, lang) VALUES (%s,%s,%s,%s,%s) RETURNING id",
                              (company_id, cl.get("name"), cl.get("phone"), cl.get("telegram"), cl.get("lang", "ru"))).fetchone()["id"]
    row = c.execute(
        """INSERT INTO orders (id, company_id, client_id, address, floor, discount_pct, works)
           VALUES (COALESCE(%s::uuid, gen_random_uuid()), %s, %s, %s, %s, %s, %s)
           ON CONFLICT (id) DO NOTHING RETURNING *""",
        (order_id, company_id, client_id, data.get("address"), data.get("floor"), data.get("discount_pct", 0),
         Jsonb(data.get("works", {})))).fetchone()
    if row is None:                                   # повторная отправка с телефона — заказ уже есть
        row = get_order_row(c, company_id, order_id)
    return row


def get_order_row(c, company_id: str, order_id: str) -> dict:
    row = c.execute("SELECT * FROM orders WHERE id = %s AND company_id = %s", (order_id, company_id)).fetchone()
    if not row:
        raise NotFound("заказ не найден")
    return row


def list_orders(c, company_id: str, status: str | None = None, q: str | None = None, limit: int = 50) -> list[dict]:
    sql = """SELECT o.*, cl.name AS client_name, cl.phone AS client_phone,
                    (SELECT count(*) FROM order_positions p WHERE p.order_id = o.id AND NOT p.deleted) AS positions,
                    (SELECT max(version) FROM quotes qq WHERE qq.order_id = o.id) AS quote_version
             FROM orders o LEFT JOIN clients cl ON cl.id = o.client_id
             WHERE o.company_id = %s"""
    args: list = [company_id]
    if status:
        sql += " AND o.status = %s"; args.append(status)
    if q:
        sql += " AND (o.address ILIKE %s OR cl.name ILIKE %s OR cl.phone ILIKE %s)"; args += [f"%{q}%"] * 3
    sql += " ORDER BY o.updated_at DESC LIMIT %s"; args.append(limit)
    return list(c.execute(sql, args))


def update_order(c, company_id: str, order_id: str, data: dict) -> dict:
    get_order_row(c, company_id, order_id)
    allowed = {"address", "floor", "status", "discount_pct", "works"}
    sets, args = [], []
    for k, v in data.items():
        if k in allowed:
            sets.append(f"{k} = %s"); args.append(Jsonb(v) if k == "works" else v)
    if sets:
        c.execute(f"UPDATE orders SET {', '.join(sets)}, updated_at = now() WHERE id = %s", args + [order_id])
    return get_order_row(c, company_id, order_id)


def positions(c, order_id: str, include_deleted: bool = False) -> list[dict]:
    sql = "SELECT * FROM order_positions WHERE order_id = %s" + ("" if include_deleted else " AND NOT deleted") + " ORDER BY sort, updated_at"
    return list(c.execute(sql, (order_id,)))


def put_position(c, company_id: str, order_id: str, position_id: str, doc: dict, base_rev: int | None,
                 deleted: bool = False, force: bool = False, sort: int | None = None) -> dict:
    get_order_row(c, company_id, order_id)
    cur = c.execute("SELECT * FROM order_positions WHERE id = %s FOR UPDATE", (position_id,)).fetchone()
    doc = dict(doc, id=position_id)
    aw = Jsonb(doc.get("accepted_warnings", []))
    if cur is None:
        row = c.execute(
            """INSERT INTO order_positions (id, order_id, sort, doc, accepted_warnings, rev, deleted)
               VALUES (%s, %s, COALESCE(%s, (SELECT count(*) FROM order_positions WHERE order_id = %s)), %s, %s, 1, %s)
               RETURNING *""", (position_id, order_id, sort, order_id, Jsonb(doc), aw, deleted)).fetchone()
    else:
        if str(cur["order_id"]) != order_id:
            raise NotFound("позиция из другого заказа")
        if not force and base_rev is not None and base_rev < cur["rev"]:
            raise Conflict({"doc": cur["doc"], "rev": cur["rev"], "deleted": cur["deleted"], "updated_at": cur["updated_at"].isoformat()})
        row = c.execute(
            """UPDATE order_positions SET doc = %s, accepted_warnings = %s, deleted = %s, rev = rev + 1,
                      sort = COALESCE(%s, sort), updated_at = now()
               WHERE id = %s RETURNING *""", (Jsonb(doc), aw, deleted, sort, position_id)).fetchone()
    c.execute("UPDATE orders SET updated_at = now(), client_rev = client_rev + 1 WHERE id = %s", (order_id,))
    return row


# ---------------- КП ----------------
def latest_price_version(c) -> int | None:
    r = c.execute("SELECT max(id) AS id FROM price_versions").fetchone()
    return r["id"] if r else None


def create_quote(c, order_id: str, variants: list[dict], lang: str, usd_rate: float | None, demo: bool) -> dict:
    v = c.execute("SELECT COALESCE(max(version), 0) + 1 AS v FROM quotes WHERE order_id = %s", (order_id,)).fetchone()["v"]
    token = secrets.token_urlsafe(12)
    row = c.execute(
        """INSERT INTO quotes (order_id, version, price_version_id, usd_rate, lang, variants, public_token, demo, sent_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now()) RETURNING *""",
        (order_id, v, latest_price_version(c), usd_rate, lang, Jsonb(variants), token, demo)).fetchone()
    c.execute("UPDATE orders SET status = CASE WHEN status = 'measure' THEN 'quoted' ELSE status END, updated_at = now() WHERE id = %s",
              (order_id,))
    return row


def quote_by_token(c, token: str) -> tuple[dict, dict]:
    q = c.execute("SELECT * FROM quotes WHERE public_token = %s", (token,)).fetchone()
    if not q:
        raise NotFound("ссылка недействительна")
    latest = c.execute("SELECT * FROM quotes WHERE order_id = %s ORDER BY version DESC LIMIT 1", (q["order_id"],)).fetchone()
    return q, latest


def accept_quote(c, quote_id: str, variant: int) -> dict:
    row = c.execute("UPDATE quotes SET accepted_at = now(), accepted_variant = %s WHERE id = %s RETURNING *",
                    (variant, quote_id)).fetchone()
    c.execute("UPDATE orders SET status = 'agreed', updated_at = now() WHERE id = %s", (row["order_id"],))
    return row


def iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def jsonable(row: dict) -> dict:
    return {k: (str(v) if k.endswith("id") and v is not None and not isinstance(v, (int, dict, list)) else iso(v))
            for k, v in row.items()}


def now() -> datetime:
    return datetime.now(timezone.utc)
