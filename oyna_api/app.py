"""HTTP-слой Eskiz Oyna поверх oyna_core (FastAPI).

Сейчас без базы: изделие и позиции приходят в теле запроса — этого хватает фронтенду и мастеру замера,
чтобы работать параллельно. Хранение заказов (positions/{id}, quotes, /q/{token}) — следующим шагом с PostgreSQL.

Запуск:  .venv/bin/uvicorn oyna_api.app:app --reload --port 8030
Цех и роль: Bearer-токен (/auth/verify-code). В разработке без токена — заголовки X-Company (demo | real | uuid) и X-Role.
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from oyna_core import Catalog, Company, calc, commands, validate
from oyna_core.alternatives import alternatives
from oyna_core.commands import CommandError
from oyna_core.glass import GlassError, fits_beads, parse, price_m2
from oyna_core.measure import check_value, frame_from_opening
from oyna_core.model import DEFAULT_SYSTEM
from oyna_core.order import calc_order, order_cutting, quote_variants
from oyna_core.render import render_svg

app = FastAPI(title="Eskiz Oyna API", version="0.1.0",
              description="Ядро расчёта окон: команды, проверки, спецификация, цена, КП-варианты, раскрой, замены.")
CAT = Catalog()
from .auth import Ctx, ctx  # noqa: E402


Role = Literal["owner", "manager", "measurer"]


class DocIn(BaseModel):
    doc: dict[str, Any] = Field(..., description="изделие (PRD, раздел 6)")


class CommandsIn(DocIn):
    commands: list[dict[str, Any]] = Field(..., examples=[[{"cmd": "split", "path": "", "dir": "v", "n": 2}]])


class FromTemplateIn(BaseModel):
    template: str = "T03"
    w: int | None = None
    h: int | None = None
    setup: dict[str, Any] | None = None
    room: str | None = None


class AltIn(DocIn):
    what: str = Field(..., examples=["fittings", "system", "glass", "decor_out", "option:handle"])
    path: str | None = None
    same_material: bool = True


class GlassIn(BaseModel):
    formula: str = Field(..., examples=["6t-14-4i"])
    system: str | None = None


class MeasureIn(BaseModel):
    widths: list[int] = Field(..., min_length=1, max_length=3)
    heights: list[int] = Field(..., min_length=1, max_length=3)


class OrderIn(BaseModel):
    positions: list[dict[str, Any]]
    discount_pct: float = 0.0
    kit: dict[str, Any] | None = None


def _bad(e: Exception):
    raise HTTPException(status_code=422, detail=str(e))


# ---------------- позиция ----------------
@app.post("/oyna/positions/from-template", tags=["позиция"])
def from_template(body: FromTemplateIn, cx: Ctx = Depends(ctx)):
    try:
        doc = commands.create_from_template(CAT, body.template, body.w, body.h, setup=body.setup, room=body.room)
    except CommandError as e:
        _bad(e)
    return {"doc": doc, "result": validate(doc, CAT, cx.company)}


@app.post("/oyna/positions/commands", tags=["позиция"])
def apply_commands(body: CommandsIn, cx: Ctx = Depends(ctx)):
    """Применить пакет команд → новое изделие + нарушения (поток расчёта, PRD 5)."""
    try:
        doc = commands.apply(body.doc, body.commands)
    except (CommandError, KeyError, IndexError, TypeError) as e:
        _bad(e)
    return {"doc": doc, "result": validate(doc, CAT, cx.company)}


@app.post("/oyna/positions/validate", tags=["позиция"])
def validate_pos(body: DocIn, cx: Ctx = Depends(ctx)):
    return validate(body.doc, CAT, cx.company)


@app.post("/oyna/positions/calc", tags=["позиция"])
def calc_pos(body: DocIn, cx: Ctx = Depends(ctx)):
    """Проверки + спецификация + цена. Себестоимость — только владельцу."""
    return calc(body.doc, CAT, cx.company, role=cx.role)


@app.post("/oyna/positions/render.svg", tags=["позиция"], response_class=Response)
def render(body: DocIn, view: Literal["inside", "outside"] = "inside", size: int = 560, cx: Ctx = Depends(ctx)):
    svg = render_svg(body.doc, CAT, cx.company, view=view, max_px=size)
    return Response(svg, media_type="image/svg+xml")


@app.post("/oyna/positions/alternatives", tags=["замены"])
def alts(body: AltIn, cx: Ctx = Depends(ctx)):
    """Совместимые замены с разницей в цене; несовместимые — в locked с причиной (FR-F8)."""
    try:
        return alternatives(body.doc, CAT, cx.company, body.what, body.path, body.same_material)
    except (ValueError, KeyError) as e:
        _bad(e)


# ---------------- справочники ----------------
@app.get("/oyna/templates", tags=["справочники"])
def templates():
    return [{k: t[k] for k in ("id", "name", "kind", "default_w", "default_h")} for t in CAT.templates.values()]


@app.get("/oyna/systems", tags=["справочники"])
def systems(material: str | None = None):
    out = []
    for code, s in CAT.systems.items():
        if s["usable_for_calc"] != "1" or (material and s["material_class"] != material):
            continue
        p = CAT.passport(code)
        out.append({"code": code, "brand": s["brand"], "series": s["series"], "material": s["material_class"],
                    "colors": CAT.system_colors(code), "fitting_groove": s["fitting_groove"],
                    "fittings": CAT.compatible_fitting_sets(code), "glass_range_mm": list(p.get("beads", {}).values()),
                    "passport_verified_fields": p.get("verified_fields", [])})
    return out


@app.get("/oyna/fitting-sets", tags=["справочники"])
def fitting_sets(system: str | None = None):
    codes = CAT.compatible_fitting_sets(system) if system else list(CAT.fitting_systems)
    return [{"code": c, **CAT.fitting_systems[c]} for c in codes]


@app.get("/oyna/decors", tags=["справочники"])
def decors(system: str | None = None):
    from oyna_core.model import price_group
    out = []
    for d in CAT.decors.values():
        row = dict(d)
        if system:
            g = price_group(CAT, system, d["id"], d["id"])
            row["available"] = g in CAT.system_colors(system) and (
                "alu" if CAT.material(system).startswith("alu") else "pvc") in d.get("material", [])
        out.append(row)
    return out


@app.get("/oyna/glass", tags=["справочники"])
def glass_presets(system: str | None = None):
    p = CAT.passport(system or DEFAULT_SYSTEM)
    out = []
    for code, row in CAT.glass_presets.items():
        g = parse(code, CAT)
        pr, st, _ = price_m2(g, CAT)
        out.append({"code": code, "formula": row["formula"], "thickness_mm": g.thickness_mm, "price_sum_m2": pr,
                    "price_status": st, "fits_system": bool(fits_beads(g, p))})
    return out


@app.post("/oyna/glass/parse", tags=["справочники"])
def glass_parse(body: GlassIn):
    """Своя формула → толщина, вес, камеры, цена; проверка штапиком системы (4.6) и ограничениями (4.9)."""
    try:
        g = parse(body.formula, CAT)
    except GlassError as e:
        return {"ok": False, "code": "4.9", "error": str(e)}
    pr, st, how = price_m2(g, CAT)
    res = {"ok": True, "formula": g.formula, "thickness_mm": g.thickness_mm, "glass_mm_total": g.glass_mm_total,
           "weight_kg_m2": g.weight_kg_m2, "chambers": g.chambers, "price_sum_m2": pr, "price_status": st, "how": how,
           "preset": g.preset}
    if body.system:
        p = CAT.passport(body.system)
        res["fits_system"] = bool(fits_beads(g, p))
        if not res["fits_system"]:
            res["code"] = "4.6"
            res["error"] = f"{g.thickness_mm:g} мм не входит в систему (штапики: " + \
                           ", ".join(f"{a}–{b}" for a, b in p.get("beads", {}).values()) + " мм)"
    return res


# ---------------- замер ----------------
@app.post("/oyna/measure/frame", tags=["замер"])
def measure_frame(body: MeasureIn, cx: Ctx = Depends(ctx)):
    return frame_from_opening(body.widths, body.heights, cx.company, CAT)


@app.get("/oyna/measure/check", tags=["замер"])
def measure_check(value: int):
    return {"value": value, "issues": check_value(value, CAT)}


# ---------------- заказ ----------------
@app.post("/oyna/orders/calc", tags=["заказ"])
def order_calc(body: OrderIn, cx: Ctx = Depends(ctx)):
    return calc_order(body.positions, CAT, cx.company, body.discount_pct, body.kit, role=cx.role)


@app.post("/oyna/orders/quote-variants", tags=["заказ"])
def order_variants(body: OrderIn, cx: Ctx = Depends(ctx)):
    """До 3 вариантов комплектации для КП (комплектации цеха)."""
    return quote_variants(body.positions, CAT, cx.company, discount_pct=body.discount_pct, role=cx.role)


@app.post("/oyna/orders/cutting", tags=["заказ"])
def order_cut(body: OrderIn, cx: Ctx = Depends(ctx)):
    if cx.role not in ("owner", "production"):
        raise HTTPException(403, "раскрой — для владельца и производства")
    return order_cutting(body.positions, CAT, cx.company)


@app.get("/health")
def health():
    return {"ok": True, "items": len(CAT.items), "systems": sum(1 for s in CAT.systems.values() if s["usable_for_calc"] == "1")}


# заказы, синхронизация, КП и публичная страница (нужен OYNA_DSN)
from .orders import router as _orders_router  # noqa: E402

app.include_router(_orders_router)

# вход, цех, каталог
from .auth import router as _auth_router  # noqa: E402
from .catalog import load_overrides, router as _catalog_router  # noqa: E402
from .company import router as _company_router  # noqa: E402
from .docs import router as _docs_router  # noqa: E402

app.include_router(_auth_router)
app.include_router(_company_router)
app.include_router(_catalog_router)
app.include_router(_docs_router)


@app.on_event("startup")
def _startup():
    load_overrides()
