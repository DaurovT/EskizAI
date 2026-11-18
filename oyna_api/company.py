"""Цех: первый вход (S02), настройки (S13), работы, комплектации, свои цены, стекольщик, сотрудники.

Менять настройки может только владелец. Комплектации проверяются ядром: система есть и пригодна,
фурнитура подходит к пазу, стеклопакет входит в штапик — иначе 422 с причиной.
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from oyna_core.glass import GlassError, fits_beads, parse

from . import store
from .auth import ROLES, Ctx, ctx, decode, issue, need_company, normalize_phone, require
from .settings import settings

router = APIRouter(prefix="/oyna/company", tags=["цех"])

FIELDS = ("name", "phone", "inn", "address", "logo_url", "mode", "dealer_coef", "markup_kind", "markup_value", "usd_rate",
          "install_gap_mm", "rounding_sum", "lang_default", "skew_warn_mm", "waste_pct", "quote_price_check_days")


def _cat():
    from .app import CAT
    return CAT


class CompanyIn(BaseModel):
    name: str
    phone: str | None = None
    inn: str | None = None
    address: str | None = None
    mode: Literal["manufacturer", "dealer"] = "manufacturer"
    dealer_coef: float | None = None
    markup_kind: Literal["percent", "per_m2"] = "percent"
    markup_value: float = 30
    usd_rate: float | None = None
    lang_default: Literal["ru", "uz"] = "ru"
    systems: list[str] = Field(default_factory=lambda: ["akfa__6000_qvt"])
    works: dict[str, float] = {}
    kits: list[dict[str, Any]] | None = None


class CompanyPatch(BaseModel):
    name: str | None = None
    phone: str | None = None
    inn: str | None = None
    address: str | None = None
    logo_url: str | None = None
    mode: Literal["manufacturer", "dealer"] | None = None
    dealer_coef: float | None = None
    markup_kind: Literal["percent", "per_m2"] | None = None
    markup_value: float | None = None
    usd_rate: float | None = None
    install_gap_mm: int | None = Field(None, ge=0, le=60)
    rounding_sum: int | None = Field(None, ge=0)
    lang_default: Literal["ru", "uz"] | None = None
    skew_warn_mm: int | None = Field(None, ge=0, le=100)
    waste_pct: float | None = Field(None, ge=0, le=50)
    quote_price_check_days: int | None = Field(None, ge=1, le=365)


class Kit(BaseModel):
    name: str
    setup: dict[str, Any]


class PriceRow(BaseModel):
    item_id: str
    color: str
    price_sum: float | None = Field(..., description="None — убрать свою цену, вернуть базовую")


class MemberIn(BaseModel):
    phone: str
    role: Literal["owner", "manager", "measurer", "installer", "production"] = "measurer"
    discount_limit_pct: float = 0


def check_kit(setup: dict) -> list[str]:
    """Проблемы комплектации (пусто — годится)."""
    cat = _cat()
    errs = []
    sysc = setup.get("system")
    if sysc not in cat.systems or cat.systems[sysc]["usable_for_calc"] != "1":
        return [f"система «{sysc}» не пригодна для расчёта"]
    if setup.get("fittings") and setup["fittings"] not in cat.compatible_fitting_sets(sysc):
        errs.append(f"фурнитура «{setup['fittings']}» не подходит к пазу системы (7.2)")
    if setup.get("glass"):
        try:
            g = parse(setup["glass"], cat)
            if not fits_beads(g, cat.passport(sysc)):
                errs.append(f"стеклопакет {g.thickness_mm:g} мм не входит в систему (4.6)")
        except GlassError as e:
            errs.append(f"формула стекла: {e} (4.9)")
    return errs


def _out(c, cid: str) -> dict:
    r = c.execute("SELECT * FROM companies WHERE id = %s", (cid,)).fetchone()
    works = {w["work_code"]: {"unit": w["unit"], "price_sum": float(w["price_sum"])}
             for w in c.execute("SELECT * FROM work_rates WHERE company_id = %s", (cid,))}
    cat = _cat()
    defaults = {k: {"name": v["name"], "unit": v["unit"], "ref_price_sum": v.get("ref_price_sum") or None,
                    "set": k in works, "price_sum": works.get(k, {}).get("price_sum")} for k, v in cat.works.items()}
    return {"company": store.jsonable(r), "works": defaults,
            "kits": [{"id": str(k["id"]), "name": k["name"], "setup": k["setup"]}
                     for k in c.execute("SELECT * FROM kits WHERE company_id = %s ORDER BY name", (cid,))],
            "systems": [x["system_code"] for x in c.execute("SELECT system_code FROM company_systems WHERE company_id = %s", (cid,))],
            "glass_prices": {x["glass_code"]: float(x["price_sum_m2"]) for x in c.execute(
                "SELECT glass_code, price_sum_m2 FROM glass_prices WHERE company_id = %s", (cid,))},
            "own_prices": c.execute("SELECT count(*) AS n FROM company_prices WHERE company_id = %s", (cid,)).fetchone()["n"],
            "onboarding": {"works_missing": [k for k, v in defaults.items() if not v["set"] and k in (
                "install", "dismantle", "slopes", "sill_install", "drip_install")],
                           "glass_missing": not c.execute("SELECT 1 FROM glass_prices WHERE company_id = %s LIMIT 1", (cid,)).fetchone()}}


@router.post("", summary="Создать цех (первый вход, S02)")
def create_company(body: CompanyIn, authorization: str | None = Header(None)):
    s = settings()
    p = decode(s, (authorization or "").removeprefix("Bearer ").strip(), "access")
    kits = body.kits
    if kits is None:
        import json
        kits = json.load(open(_cat().dir / "demo_company.json", encoding="utf-8"))["kits"]
    for k in kits:
        errs = check_kit(k["setup"])
        if errs:
            raise HTTPException(422, f"комплектация «{k['name']}»: " + "; ".join(errs))
    with store.conn() as c:
        cid = str(c.execute(
            """INSERT INTO companies (name, phone, inn, address, mode, dealer_coef, markup_kind, markup_value, usd_rate, lang_default)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (body.name, body.phone, body.inn, body.address, body.mode, body.dealer_coef, body.markup_kind, body.markup_value,
             body.usd_rate, body.lang_default)).fetchone()["id"])
        c.execute("INSERT INTO company_members (company_id, user_id, role) VALUES (%s,%s,'owner')", (cid, p["sub"]))
        for code in body.systems:
            c.execute("INSERT INTO company_systems (company_id, system_code) VALUES (%s,%s) ON CONFLICT DO NOTHING", (cid, code))
        for code, price in body.works.items():
            unit = _cat().works.get(code, {}).get("unit", "pcs")
            c.execute("INSERT INTO work_rates (company_id, work_code, unit, price_sum) VALUES (%s,%s,%s,%s)", (cid, code, unit, price))
        for k in kits:
            c.execute("INSERT INTO kits (company_id, name, setup) VALUES (%s,%s,%s)", (cid, k["name"], Jsonb(k["setup"])))
        return {"company": _out(c, cid), "tokens": issue(c, s, p["sub"], cid)}


@router.get("", summary="Настройки цеха (S13)")
def get_company(cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        out = _out(c, cid)
        if cx.role != "owner":                           # наценка и себестоимость — только владельцу
            for k in ("markup_kind", "markup_value", "dealer_coef"):
                out["company"].pop(k, None)
        return out


@router.patch("", summary="Изменить настройки цеха")
def patch_company(body: CompanyPatch, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    data = body.model_dump(exclude_none=True)
    with store.conn() as c:
        if data:
            c.execute(f"UPDATE companies SET {', '.join(f'{k} = %s' for k in data)} WHERE id = %s", list(data.values()) + [cid])
        return _out(c, cid)


@router.put("/works", summary="Цены работ цеха")
def put_works(body: dict[str, float | None], cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    cat = _cat()
    unknown = [k for k in body if k not in cat.works]
    if unknown:
        raise HTTPException(422, f"неизвестные работы: {', '.join(unknown)}")
    with store.conn() as c:
        for code, price in body.items():
            if price is None:
                c.execute("DELETE FROM work_rates WHERE company_id = %s AND work_code = %s", (cid, code))
            else:
                c.execute("""INSERT INTO work_rates (company_id, work_code, unit, price_sum) VALUES (%s,%s,%s,%s)
                             ON CONFLICT (company_id, work_code) DO UPDATE SET price_sum = EXCLUDED.price_sum""",
                          (cid, code, cat.works[code]["unit"], price))
        return _out(c, cid)["works"]


@router.put("/kits", summary="Комплектации цеха («Эконом / Стандарт / Тёплый»)")
def put_kits(body: list[Kit], cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    if not 1 <= len(body) <= 6:
        raise HTTPException(422, "от 1 до 6 комплектаций")
    problems = {k.name: check_kit(k.setup) for k in body}
    problems = {k: v for k, v in problems.items() if v}
    if problems:
        raise HTTPException(422, {"kits": problems})
    with store.conn() as c:
        c.execute("DELETE FROM kits WHERE company_id = %s", (cid,))
        for k in body:
            c.execute("INSERT INTO kits (company_id, name, setup) VALUES (%s,%s,%s)", (cid, k.name, Jsonb(k.setup)))
        return _out(c, cid)["kits"]


@router.put("/systems", summary="С какими системами работает цех")
def put_systems(body: list[str], cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    cat = _cat()
    bad = [x for x in body if x not in cat.systems or cat.systems[x]["usable_for_calc"] != "1"]
    if bad:
        raise HTTPException(422, f"не пригодны для расчёта: {', '.join(bad)}")
    with store.conn() as c:
        c.execute("DELETE FROM company_systems WHERE company_id = %s", (cid,))
        for x in body:
            c.execute("INSERT INTO company_systems (company_id, system_code) VALUES (%s,%s)", (cid, x))
        return body


@router.put("/glass-prices", summary="Прайс стекольщика: код пресета или формула → сум/м²")
def put_glass_prices(body: dict[str, float | None], cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    cat = _cat()
    with store.conn() as c:
        for key, price in body.items():
            if key not in cat.glass_presets:
                try:
                    key = parse(key, cat).formula               # своя формула — храним в нормальном виде
                except GlassError as e:
                    raise HTTPException(422, f"{key}: {e}")
                c.execute("INSERT INTO glass_types (code, formula, thickness_mm, glass_mm_total, weight_kg_m2) "
                          "VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                          (key, key, int(parse(key, cat).thickness_mm), int(parse(key, cat).glass_mm_total), parse(key, cat).weight_kg_m2))
            c.execute("DELETE FROM glass_prices WHERE company_id = %s AND glass_code = %s", (cid, key))
            if price is not None:
                c.execute("INSERT INTO glass_prices (company_id, glass_code, price_sum_m2, status, source) VALUES (%s,%s,%s,'от стекольщика','цех')",
                          (cid, key, price))
        return _out(c, cid)["glass_prices"]


@router.put("/glass-pricing", summary="Свои надбавки для формул стеклопакета (ключи glass_formula.json)")
def put_glass_pricing(body: dict[str, float], cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    keys = set(_cat().glass_formula["pricing_sum_m2"])
    bad = set(body) - keys
    if bad:
        raise HTTPException(422, f"неизвестные ключи: {', '.join(sorted(bad))}; есть: {', '.join(sorted(keys))}")
    with store.conn() as c:
        c.execute("DELETE FROM glass_pricing WHERE company_id = %s", (cid,))
        c.execute("INSERT INTO glass_pricing (company_id, data) VALUES (%s,%s)", (cid, Jsonb(body)))
    return body


@router.put("/prices", summary="Цены цеха поверх базового прайса (FR-C4)")
def put_prices(body: list[PriceRow], cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    ids = {it["item_id"] for it in _cat().items}
    bad = [r.item_id for r in body if r.item_id not in ids]
    if bad:
        raise HTTPException(422, f"нет в каталоге: {', '.join(bad[:10])}")
    with store.conn() as c:
        for r in body:
            if r.price_sum is None:
                c.execute("DELETE FROM company_prices WHERE company_id = %s AND item_id = %s AND color = %s", (cid, r.item_id, r.color))
            else:
                c.execute("""INSERT INTO company_prices (company_id, item_id, color, price_sum) VALUES (%s,%s,%s,%s)
                             ON CONFLICT (company_id, item_id, color) DO UPDATE SET price_sum = EXCLUDED.price_sum, updated_at = now()""",
                          (cid, r.item_id, r.color, r.price_sum))
        return {"own_prices": c.execute("SELECT count(*) AS n FROM company_prices WHERE company_id = %s", (cid,)).fetchone()["n"]}


# ---------------- сотрудники (платная «Команда», PRD 3) ----------------
@router.get("/members", summary="Сотрудники")
def members(cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    with store.conn() as c:
        return [{"user_id": str(r["user_id"]), "phone": r["phone"], "name": r["name"], "role": r["role"],
                 "discount_limit_pct": float(r["discount_limit_pct"] or 0)} for r in c.execute(
            "SELECT m.*, u.phone, u.name FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = %s", (cid,))]


@router.post("/members", summary="Добавить сотрудника по номеру")
def add_member(body: MemberIn, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    phone = normalize_phone(body.phone)
    with store.conn() as c:
        u = c.execute("SELECT id FROM users WHERE phone = %s", (phone,)).fetchone() or \
            c.execute("INSERT INTO users (phone) VALUES (%s) RETURNING id", (phone,)).fetchone()
        c.execute("""INSERT INTO company_members (company_id, user_id, role, discount_limit_pct) VALUES (%s,%s,%s,%s)
                     ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role, discount_limit_pct = EXCLUDED.discount_limit_pct""",
                  (cid, u["id"], body.role, body.discount_limit_pct))
    return members(cx)


@router.delete("/members/{user_id}", summary="Убрать сотрудника")
def remove_member(user_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx); require(cx, "owner")
    if user_id == cx.user_id:
        raise HTTPException(409, "нельзя убрать себя — передайте цех другому владельцу")
    with store.conn() as c:
        c.execute("DELETE FROM company_members WHERE company_id = %s AND user_id = %s", (cid, user_id))
    return members(cx)


assert set(ROLES) == {"owner", "manager", "measurer", "installer", "production"}
