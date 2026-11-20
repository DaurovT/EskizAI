"""Входные точки ядра — то, что вызывает FastAPI (POST /oyna/positions/{id}/calc и т. п.)."""
from __future__ import annotations

from .data import Catalog, Company
from .evaluate import Eval, evaluate


def _pts(pts) -> list:
    return [[round(x, 1), round(y, 1)] for x, y in pts]


def _assembly_summary(ev: Eval) -> dict | None:
    """Сборка: рамы в развёртке (x — начало рамы), ячейки и импосты с путями A<i>/ и сдвинутыми координатами."""
    out = {"w": float(ev.doc["frame"]["w"]), "h": float(ev.doc["frame"]["h"]), "area_m2": round(ev.area_m2, 3),
           "cells": [], "mullions": [], "frames": [], "joints": []}
    for i, (part, x) in enumerate(zip(ev.parts, ev.offsets)):
        g = _geo_summary(part)
        fr = {"index": i, "x": x, "w": float(part.doc["frame"]["w"]), "h": float(part.doc["frame"]["h"]),
              "shape": part.doc["frame"].get("shape") or "rect"}
        if g is None:
            out["frames"].append(fr)
            continue
        if g.get("contour"):
            fr["contour"] = [[px + x, py] for px, py in g["contour"]]
        for key in ("sliding", "guillotine"):            # §11: параметры полотен рамы; x — в развёртке
            if g.get(key):
                fr["kind"] = key
                fr[key] = _shift_special(g[key], x)
        out["frames"].append(fr)
        for c in g["cells"]:
            c = dict(c, path=f"A{i}/" + c["path"])
            ax = c["axis"]
            c["axis"] = [ax[0] + x, ax[1], ax[2] + x, ax[3]]
            if c.get("poly"):
                c["poly"] = [[px + x, py] for px, py in c["poly"]]
            out["cells"].append(c)
        for m in g["mullions"]:
            out["mullions"].append(dict(m, path=f"A{i}/" + m["path"], at=m["at"] + x if m["orient"] == "v" else m["at"]))
    out["joints"] = [{"index": j["index"], "joint": j["joint"], "angle": j["angle"], "x": j["x"],
                      "length": round(j["height"], 1), "role": j["role"]} for j in ev.joints]
    return out


def _shift_special(sp: dict, x: float) -> dict:
    sp = dict(sp)
    for k in ("modules_x", "posts_x"):
        if k in sp:
            sp[k] = [[a + x, b + x] for a, b in sp[k]]
    return sp


def _geo_summary(ev: Eval) -> dict | None:
    if ev.parts:
        return _assembly_summary(ev)
    if not ev.geo:
        return None
    out = {"w": ev.geo.w, "h": ev.geo.h, "cells": [], "mullions": [
        {"path": m.path, "orient": m.orient, "at": m.at, "length": round(m.length, 1)} for m in ev.geo.mullions]}
    if ev.geo.contour:
        out.update(shape=ev.geo.shape, contour=_pts(ev.geo.contour), area_m2=round(ev.geo.area_m2, 3))
    if ev.geo.special:                                   # раздвижная / гильотина (§11): параметры, ячейки — полотна
        from .sliding import summary
        out[ev.geo.special["type"]] = summary(ev.geo)
    if ev.geo.vslides:                                   # гильотинное окно (§11.2): узлы и их габарит
        out["vslides"] = [{"path": v["path"], "rect": [v["rect"].x0, v["rect"].y0, v["rect"].x1, v["rect"].y1]}
                          for v in ev.geo.vslides]
    for cg in ev.geo.cells:
        g = ev.glass.get(cg.path)
        c = {"path": cg.path, "type": cg.cell.get("type"), "axis": [round(v, 1) for v in (cg.axis.x0, cg.axis.y0, cg.axis.x1, cg.axis.y1)],
             "light": [round(cg.light.w, 1), round(cg.light.h, 1)],
             "glass": [round(cg.glass_w, 1), round(cg.glass_h, 1)] if g is not None else None,
             "glass_spec": getattr(g, "spec", None), "glass_thickness_mm": getattr(g, "thickness_mm", None)}
        if cg.shaped:
            c.update(shaped=True, poly=_pts(cg.poly), glass_area_m2=round(cg.glass_area_m2, 3))
        if cg.extra:                                     # §11: leaf {index, rail, moving} | panel {module, index, moving}
            c.update(cg.extra)
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
    if company is not None:
        company = company.with_suppliers(cat, doc.get("setup"))   # §9.7: поставщик по категории / setup.suppliers
    ev = evaluate(doc, cat, company)
    res ={"violations": None, "price_group": ev.group, "setup": ev.setup, "geometry": _geo_summary(ev)}
    if not ev.stopped:
        lines = build_bom(ev)
        res["price"] = price_position(ev, lines)               # до as_dict: размечает строки (группа, поставщик)
        res["bom"] = [l.as_dict() for l in lines]
        if role not in ("owner",):
            res["price"] = {k: v for k, v in res["price"].items() if k in ("total", "per_m2", "currency", "demo", "area_m2", "total_usd")}
            for l in res["bom"]:
                for k in ("unit_price", "cost", "price_status"):
                    l.pop(k, None)
    res["violations"] = [v.as_dict() for v in ev.violations]
    res["can_quote"] = not ev.blocking
    return res
