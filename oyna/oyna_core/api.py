"""Входные точки ядра — то, что вызывает FastAPI (POST /oyna/positions/{id}/calc и т. п.)."""
from __future__ import annotations

from .data import Catalog, Company
from .evaluate import Eval, evaluate


def _geo_summary(ev: Eval) -> dict | None:
    if not ev.geo:
        return None
    out = {"w": ev.geo.w, "h": ev.geo.h, "cells": [], "mullions": [
        {"path": m.path, "orient": m.orient, "at": m.at, "length": round(m.length, 1)} for m in ev.geo.mullions]}
    for cg in ev.geo.cells:
        g = ev.glass.get(cg.path)
        c = {"path": cg.path, "type": cg.cell.get("type"), "axis": [cg.axis.x0, cg.axis.y0, cg.axis.x1, cg.axis.y1],
             "light": [round(cg.light.w, 1), round(cg.light.h, 1)],
             "glass": [round(cg.glass_w, 1), round(cg.glass_h, 1)] if g is not None else None,
             "glass_spec": getattr(g, "spec", None), "glass_thickness_mm": getattr(g, "thickness_mm", None)}
        if cg.sash:
            c.update(sash=[round(cg.sash.w, 1), round(cg.sash.h, 1)], ffb=round(cg.ffb, 1), ffh=round(cg.ffh, 1),
                     weight_kg=cg.weight_kg)
            sel = ev.fittings.get(cg.path)
            if sel:
                c["fittings"] = [{"code": p.code, "name": p.name, "qty": p.qty, "cams": p.cams} for p in sel.parts]
        out["cells"].append(c)
    return out


def validate(doc: dict, cat: Catalog, company: Company | None = None) -> dict:
    """Только проверки и геометрия (этап 1)."""
    ev = evaluate(doc, cat, company)
    return {"violations": [v.as_dict() for v in ev.violations], "can_quote": not ev.blocking,
            "price_group": ev.group, "setup": ev.setup, "geometry": _geo_summary(ev)}


def calc(doc: dict, cat: Catalog, company: Company | None = None, role: str = "owner") -> dict:
    """Проверки + спецификация + цена. Себестоимость и наценка — только владельцу (FR-P6)."""
    from .bom import build_bom
    from .price import price_position
    ev = evaluate(doc, cat, company)
    res ={"violations": None, "price_group": ev.group, "setup": ev.setup, "geometry": _geo_summary(ev)}
    if not ev.stopped:
        lines = build_bom(ev)
        res["bom"] = [l.as_dict() for l in lines]
        res["price"] = price_position(ev, lines)
        if role not in ("owner",):
            res["price"] = {k: v for k, v in res["price"].items() if k in ("total", "per_m2", "currency", "demo", "area_m2", "total_usd")}
            for l in res["bom"]:
                for k in ("unit_price", "cost", "price_status"):
                    l.pop(k, None)
    res["violations"] = [v.as_dict() for v in ev.violations]
    res["can_quote"] = not ev.blocking
    return res
