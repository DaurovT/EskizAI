"""Замены «в рамках существующего» (FR-F8): совместимые варианты + разница в цене; несовместимые — с причиной.

alternatives(doc, cat, company, what) где what:
  "system"      — серии профиля (по умолчанию того же материала)
  "fittings"    — наборы фурнитуры под паз системы
  "glass"       — пресеты стеклопакетов (для ячейки path — её заполнение)
  "decor_out" / "decor_in"
  "option:<группа>" — варианты детали створки path (handle, hinge, security, hinge_cap, extra_lock)
"""
from __future__ import annotations

from . import commands
from .api import calc
from .data import Catalog, Company
from .glass import fits_beads, parse
from .model import node_at, setup_of


def _try(doc, cat, company, base_total):
    r = calc(doc, cat, company)
    blocks = [v for v in r["violations"] if v["severity"] in ("block", "lock") and v["code"] not in ("P.1",)]
    total = (r.get("price") or {}).get("total")
    return {"total": total, "delta": (total - base_total) if total is not None and base_total is not None else None,
            "blocking": [f"{v['code']} {v.get('msg') or v['title']}" for v in blocks],
            "demo": (r.get("price") or {}).get("demo", False), "complete": (r.get("price") or {}).get("complete", False)}


def alternatives(doc: dict, cat: Catalog, company: Company | None = None, what: str = "fittings",
                 path: str | None = None, same_material: bool = True) -> dict:
    company = company or Company()
    s = setup_of(doc, cat)
    base = calc(doc, cat, company)
    base_total = (base.get("price") or {}).get("total")
    options, locked = [], []

    def offer(key, label, new_doc, **meta):
        t = _try(new_doc, cat, company, base_total)
        row = {"value": key, "label": label, **meta, **t, "current": False}
        (locked if t["blocking"] else options).append(row)

    if what == "system":
        mat = cat.material(s["system"])
        for code, row in cat.systems.items():
            if row["usable_for_calc"] != "1" or (same_material and row["material_class"] != mat):
                continue
            offer(code, f"{row['brand']} {row['series']}", commands.set_setup(doc, system=code), material=row["material_class"])
    elif what == "fittings":
        for code, fs in cat.fitting_systems.items():
            ok = cat.groove(s["system"]) in fs["grooves"] and cat.material(s["system"]) in fs["materials"]
            if not ok:
                locked.append({"value": code, "label": fs["title"], "blocking": [f"7.2 паз «{cat.groove(s['system'])}» системы не подходит"]})
                continue
            offer(code, fs["title"], commands.set_setup(doc, fittings=code))
    elif what == "glass":
        p = cat.passport(s["system"])
        for code, row in cat.glass_presets.items():
            g = parse(code, cat)
            if not fits_beads(g, p):
                locked.append({"value": code, "label": row["formula"], "blocking": [f"4.6 {g.thickness_mm:g} мм не входит в систему"]})
                continue
            nd = commands.set_fill(doc, path, {"kind": "glass", "glass": code}) if path is not None else commands.set_setup(doc, glass=code)
            offer(code, row["formula"], nd, thickness_mm=g.thickness_mm, price_status=row["price_status"])
    elif what in ("decor_out", "decor_in"):
        side = "color_out" if what == "decor_out" else "color_in"
        for did, d in cat.decors.items():
            offer(did, d["name_ru"], commands.set_setup(doc, **{side: did}), hex=d.get("hex"))
    elif what.startswith("option:"):
        group = what.split(":", 1)[1]
        if path is None:
            raise ValueError("для варианта детали нужен path створки")
        cell = node_at(doc, path)["cell"]
        from .fittings import opening_of
        op = opening_of(cell, doc.get("kind", "window"))
        rows = [r for r in cat.fitting_rules if r["option_group"] == group and r["opening"] == op
                and r["fitting_system"] in (s["fittings"], "*" + cat.groove(s["system"]))]
        for r in rows:
            offer(r["code"], r["part_name"], commands.set_option(doc, group, r["code"], path=path), is_default=r["is_default"] == "1")
    else:
        raise ValueError(f"неизвестно, что заменять: {what}")

    cur = {"system": s["system"], "fittings": s["fittings"], "glass": s["glass"], "decor_out": s["color_out"],
           "decor_in": s["color_in"]}.get(what)
    for o in options:
        o["current"] = o["value"] == cur
    options.sort(key=lambda o: (o["delta"] is None, o["delta"] if o["delta"] is not None else 0))
    return {"what": what, "path": path, "base_total": base_total, "options": options, "locked": locked}
