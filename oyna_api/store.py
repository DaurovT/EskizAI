"""Хранение в PostgreSQL (schema.sql): цеха, заказы, позиции с ревизиями, версии КП.

Синхронизация офлайн-замера (PRD 5): клиент шлёт позицию с base_rev — ревизией, от которой он правил.
  • позиции нет            → создаётся с id клиента (UUID с телефона), rev = 1
  • base_rev == rev сервера → сохраняется, rev + 1
  • base_rev  < rev сервера → конфликт: ответ с обеими версиями; клиент показывает их и шлёт выбранную с force
"""
from __future__ import annotations

import os
import secrets
import uuid
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
    items, sup_items = current_prices(c, r["id"])
    glass, sup_glass = {}, {}
    for x in c.execute("SELECT supplier_id, glass_code, price_sum_m2 FROM glass_prices WHERE company_id = %s", (r["id"],)):
        (sup_glass.setdefault(str(x["supplier_id"]), {}) if x["supplier_id"] else glass)[x["glass_code"]] = float(x["price_sum_m2"])
    suppliers = {str(x["id"]): x["name"] for x in c.execute("SELECT id, name FROM suppliers WHERE company_id = %s ORDER BY created_at",
                                                             (r["id"],))}
    defaults = {x["category"]: str(x["supplier_id"]) for x in c.execute(
        "SELECT category, supplier_id FROM company_suppliers_default WHERE company_id = %s", (r["id"],))}
    gp = c.execute("SELECT data FROM glass_pricing WHERE company_id = %s ORDER BY updated_at DESC LIMIT 1", (r["id"],)).fetchone()
    systems = [x["system_code"] for x in c.execute("SELECT system_code FROM company_systems WHERE company_id = %s ORDER BY system_code",
                                                   (r["id"],))]
    co = Company(name=r["name"], mode=r["mode"], dealer_coef=float(r["dealer_coef"] or 0), markup_kind=r["markup_kind"],
                 markup_value=float(r["markup_value"]), usd_rate=float(r["usd_rate"]) if r["usd_rate"] else None,
                 install_gap_mm=r["install_gap_mm"], rounding_sum=r["rounding_sum"], skew_warn_mm=r["skew_warn_mm"],
                 demo_prices=r["demo_prices"], waste_pct=float(r["waste_pct"]),
                 quote_price_check_days=r["quote_price_check_days"], plan=r["plan"], work_rates=works, kits=kits,
                 item_prices=items, glass_prices=glass, glass_pricing=(gp or {}).get("data") or {},
                 suppliers=suppliers, default_suppliers=defaults, supplier_prices=sup_items, supplier_glass_prices=sup_glass,
                 markup_groups=r.get("markup_groups") or None, systems=systems)
    return str(r["id"]), co


CURRENT_PRICES_SQL = """SELECT DISTINCT ON (ip.supplier_id, ip.item_id, ip.color)
        ip.supplier_id, ip.item_id, ip.color, ip.price_sum, ip.price_version_id, v.loaded_at
    FROM item_prices ip JOIN price_versions v ON v.id = ip.price_version_id
    WHERE v.company_id = %s AND v.reverted_at IS NULL
    ORDER BY ip.supplier_id, ip.item_id, ip.color, ip.price_version_id DESC"""


def current_prices(c, company_id) -> tuple[dict, dict]:
    """Цены цеха из версий: последняя неотменённая версия по (поставщик, позиция, цвет); NULL-цена — своя цена убрана.

    → ({(item_id, color): цена} основного прайса, {supplier_id: {(item_id, color): цена}})."""
    own, sup = {}, {}
    for x in c.execute(CURRENT_PRICES_SQL, (company_id,)):
        if x["price_sum"] is None:
            continue
        (sup.setdefault(str(x["supplier_id"]), {}) if x["supplier_id"] else own)[(x["item_id"], x["color"])] = float(x["price_sum"])
    return own, sup


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


LIST_SQL = """SELECT o.*, cl.name AS client_name, cl.phone AS client_phone, cl.telegram AS client_telegram,
        agg.positions, agg.units, agg.total, agg.area_m2, agg.missing_price_positions, agg.blocked_positions, agg.demo,
        COALESCE((SELECT sum(e.qty * e.price_sum) FROM extra_lines e WHERE e.order_id = o.id), 0) AS extras_total,
        (SELECT p1.doc FROM order_positions p1 WHERE p1.order_id = o.id AND NOT p1.deleted ORDER BY p1.sort, p1.updated_at LIMIT 1) AS first_doc,
        lq.version AS quote_version, lq.sent_at AS quote_sent_at, lq.accepted_at,
        lq.variants -> lq.accepted_variant ->> 'kit' AS accepted_kit,
        (lq.variants -> lq.accepted_variant ->> 'total')::numeric AS accepted_total
    FROM orders o
    LEFT JOIN clients cl ON cl.id = o.client_id
    LEFT JOIN LATERAL (
        SELECT count(*) AS positions,
               COALESCE(sum((p.summary->>'qty')::int), 0) AS units,
               sum((p.summary->>'total')::numeric) AS total,
               round(COALESCE(sum((p.summary->>'area_m2')::numeric), 0), 2) AS area_m2,
               count(*) FILTER (WHERE NOT COALESCE((p.summary->>'complete')::boolean, true)) AS missing_price_positions,
               count(*) FILTER (WHERE NOT COALESCE((p.summary->>'can_quote')::boolean, true)) AS blocked_positions,
               COALESCE(bool_or((p.summary->>'demo')::boolean), false) AS demo
        FROM order_positions p WHERE p.order_id = o.id AND NOT p.deleted) agg ON true
    LEFT JOIN LATERAL (SELECT * FROM quotes qq WHERE qq.order_id = o.id ORDER BY version DESC LIMIT 1) lq ON true
    WHERE o.company_id = %s"""


def list_orders(c, company_id: str, status: str | None = None, q: str | None = None, limit: int = 50) -> list[dict]:
    sql = LIST_SQL
    args: list = [company_id]
    if status:
        sql += " AND o.status = %s"; args.append(status)
    if q:
        sql += " AND (o.address ILIKE %s OR cl.name ILIKE %s OR cl.phone ILIKE %s)"; args += [f"%{q}%"] * 3
    sql += " ORDER BY o.updated_at DESC LIMIT %s"; args.append(limit)
    return list(c.execute(sql, args))


def order_counts(c, company_id: str) -> dict:
    rows = c.execute("SELECT status, count(*) AS n FROM orders WHERE company_id = %s GROUP BY status", (company_id,))
    out = {r["status"]: r["n"] for r in rows}
    out["all"] = sum(out.values())
    return out


def upsert_client(c, company_id: str, order: dict, client: dict) -> str:
    if order.get("client_id"):
        sets = {k: v for k, v in client.items() if k in ("name", "phone", "telegram", "lang")}
        if sets:
            c.execute(f"UPDATE clients SET {', '.join(f'{k} = %s' for k in sets)} WHERE id = %s",
                      list(sets.values()) + [order["client_id"]])
        return str(order["client_id"])
    cid = c.execute("INSERT INTO clients (company_id, name, phone, telegram, lang) VALUES (%s,%s,%s,%s,%s) RETURNING id",
                    (company_id, client.get("name"), client.get("phone"), client.get("telegram"), client.get("lang", "ru"))).fetchone()["id"]
    c.execute("UPDATE orders SET client_id = %s WHERE id = %s", (cid, order["id"]))
    return str(cid)


def update_order(c, company_id: str, order_id: str, data: dict) -> dict:
    o = get_order_row(c, company_id, order_id)
    if data.get("client"):
        upsert_client(c, company_id, o, data["client"])
    allowed = {"address", "floor", "status", "discount_pct", "works", "kit_name"}
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


def user_name(c, user_id) -> dict | None:
    if not user_id:
        return None
    try:
        uuid.UUID(str(user_id))
    except ValueError:                                  # «dev» — правка без входа (режим разработки)
        return {"id": str(user_id), "name": str(user_id)}
    u = c.execute("SELECT id, name, phone FROM users WHERE id = %s", (user_id,)).fetchone()
    return {"id": str(u["id"]), "name": u["name"] or u["phone"]} if u else None


def _same_doc(a: dict, b: dict) -> bool:
    """Тот же документ позиции (порядок ключей не важен)."""
    import json
    return json.dumps(a, sort_keys=True, ensure_ascii=False) == json.dumps(b, sort_keys=True, ensure_ascii=False)


def put_position(c, company_id: str, order_id: str, position_id: str, doc: dict, base_rev: int | None,
                 deleted: bool = False, force: bool = False, sort: int | None = None, summary: dict | None = None,
                 user_id: str | None = None) -> dict:
    order = get_order_row(c, company_id, order_id)
    cur = c.execute("SELECT * FROM order_positions WHERE id = %s FOR UPDATE", (position_id,)).fetchone()
    doc = dict(doc, id=position_id)
    aw = Jsonb(doc.get("accepted_warnings", []))
    if cur is None:
        row = c.execute(
            """INSERT INTO order_positions (id, order_id, sort, doc, accepted_warnings, rev, deleted, summary, updated_by)
               VALUES (%s, %s, COALESCE(%s, (SELECT count(*) FROM order_positions WHERE order_id = %s)), %s, %s, 1, %s, %s, %s)
               RETURNING *""", (position_id, order_id, sort, order_id, Jsonb(doc), aw, deleted, Jsonb(summary or {}), user_id)).fetchone()
    else:
        if str(cur["order_id"]) != order_id:
            raise NotFound("позиция из другого заказа")
        if not force and base_rev is not None and base_rev < cur["rev"]:
            # повтор той же правки (ответ сервера потерялся в сети, телефон шлёт снова) — не конфликт
            if not deleted and not cur["deleted"] and _same_doc(cur["doc"], doc):
                return cur
            raise Conflict({"doc": cur["doc"], "rev": cur["rev"], "deleted": cur["deleted"],
                            "updated_at": cur["updated_at"].isoformat(), "updated_by": user_name(c, cur["updated_by"])})
        row = c.execute(
            """UPDATE order_positions SET doc = %s, accepted_warnings = %s, deleted = %s, rev = rev + 1,
                      sort = COALESCE(%s, sort), summary = COALESCE(%s, summary), updated_by = %s, updated_at = now()
               WHERE id = %s RETURNING *""",
            (Jsonb(doc), aw, deleted, sort, Jsonb(summary) if summary is not None else None, user_id, position_id)).fetchone()
    outdated = order["status"] in ("agreed", "production")      # правка после согласования — нужно новое КП
    c.execute("UPDATE orders SET updated_at = now(), client_rev = client_rev + 1, quote_outdated = quote_outdated OR %s WHERE id = %s",
              (outdated, order_id))
    return row


# ---------------- сопутствующие товары ----------------
def extras(c, order_id: str) -> list[dict]:
    return [{"id": str(e["id"]), "name": e["name"], "unit": e["unit"], "qty": float(e["qty"]), "price_sum": float(e["price_sum"]),
             "total": round(float(e["qty"]) * float(e["price_sum"]))}
            for e in c.execute("SELECT * FROM extra_lines WHERE order_id = %s ORDER BY sort, created_at", (order_id,))]


def put_extra(c, company_id: str, order_id: str, data: dict, extra_id: str | None = None) -> None:
    get_order_row(c, company_id, order_id)
    if extra_id:
        c.execute("UPDATE extra_lines SET name = %s, unit = %s, qty = %s, price_sum = %s WHERE id = %s AND order_id = %s",
                  (data["name"], data["unit"], data["qty"], data["price_sum"], extra_id, order_id))
    else:
        c.execute("INSERT INTO extra_lines (order_id, name, unit, qty, price_sum, sort) VALUES (%s,%s,%s,%s,%s,"
                  "(SELECT count(*) FROM extra_lines WHERE order_id = %s))",
                  (order_id, data["name"], data["unit"], data["qty"], data["price_sum"], order_id))
    c.execute("UPDATE orders SET updated_at = now() WHERE id = %s", (order_id,))


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
    c.execute("UPDATE orders SET status = CASE WHEN status IN ('measure', 'agreed') THEN 'quoted' ELSE status END, "
              "quote_outdated = false, updated_at = now() WHERE id = %s", (order_id,))
    return row


def quote_by_token(c, token: str) -> tuple[dict, dict]:
    q = c.execute("SELECT * FROM quotes WHERE public_token = %s", (token,)).fetchone()
    if not q:
        raise NotFound("ссылка недействительна")
    latest = c.execute("SELECT * FROM quotes WHERE order_id = %s ORDER BY version DESC LIMIT 1", (q["order_id"],)).fetchone()
    return q, latest


def revoke_quote(c, order_id: str, version: int) -> dict | None:
    return c.execute("UPDATE quotes SET revoked_at = now() WHERE order_id = %s AND version = %s RETURNING *",
                     (order_id, version)).fetchone()


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
