"""Оценка позиции: всё, что нужно проверкам и спецификации, собирается здесь один раз."""
from __future__ import annotations

from dataclasses import dataclass, field

from . import fittings as fit
from .data import Catalog, Company
from .geometry import Geometry, GeometryError, build, sash_weight
from .glass import Glass, GlassError, parse
from .model import cell_glass_spec, cell_options, decor, price_group, setup_of, special_root


@dataclass
class Violation:
    code: str
    severity: str
    title: str
    msg: str = ""
    path: str = ""
    fix: str = ""
    accepted: bool = False

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v not in ("", None) or k in ("code", "severity")}


@dataclass
class Eval:
    doc: dict
    cat: Catalog
    company: Company
    setup: dict
    passport: dict
    material: str
    groove: str
    group: str                                   # ценовая группа прайса
    geo: Geometry | None = None
    glass: dict = field(default_factory=dict)    # path -> Glass | GlassError
    fittings: dict = field(default_factory=dict) # path -> fittings.Selection
    violations: list = field(default_factory=list)
    stopped: bool = False                        # дальше проверять нельзя (нет геометрии)

    @property
    def kind(self) -> str:
        return self.doc.get("kind", "window")

    def add(self, code: str, msg: str = "", path: str = "", fix: str = "") -> None:
        r = self.cat.rules.get(code, {"severity": "block", "title": code})
        if any(v.code == code and v.path == path for v in self.violations):
            return
        accepted = r["severity"] == "warn" and any(
            a.get("rule") == code and a.get("path", "") in ("", path) for a in self.doc.get("accepted_warnings", []))
        self.violations.append(Violation(code, r["severity"], r["title"], msg, path, fix, accepted))

    def has(self, code: str) -> bool:
        return any(v.code == code for v in self.violations)

    @property
    def blocking(self) -> list:
        return [v for v in self.violations if v.severity in ("block", "lock")]


def evaluate(doc: dict, cat: Catalog, company: Company | None = None) -> Eval:
    company = company or Company()
    s = setup_of(doc, cat)
    system = s["system"]
    ev = Eval(doc, cat, company, s, cat.passport(system), cat.material(system), cat.groove(system),
              price_group(cat, system, s["color_out"], s["color_in"]))
    from . import rules                                  # проверки ввода — до геометрии
    rules.check_input(ev)
    if ev.stopped:
        return ev
    if special_root(doc):
        ev.add("9.7", "раздвижные, составные и арки считаются после MVP (PRD 7.12)")
        ev.stopped = True
        return ev
    try:
        ev.geo = build(doc, ev.passport)
    except GeometryError as e:
        ev.add(e.code, e.msg, e.path)
        ev.stopped = True
        return ev
    decor_in = decor(cat, s["color_in"])
    for cg in ev.geo.cells:
        spec = cell_glass_spec(doc, cg.cell, cat)
        if cg.cell.get("type") == "panel" and not (cg.cell.get("fill") or {}).get("glass"):
            ev.glass[cg.path] = None
        else:
            try:
                ev.glass[cg.path] = parse(spec, cat)
            except GlassError as e:
                ev.glass[cg.path] = e
        g = ev.glass[cg.path]
        if cg.opening and isinstance(g, Glass):
            cg.weight_kg = sash_weight(cg, g.weight_kg_m2, ev.passport)
        if cg.opening:
            ev.fittings[cg.path] = fit.select(cat, s["fittings"], ev.groove, cg.cell, ev.kind, cg.ffb, cg.ffh,
                                              cg.weight_kg, cell_options(doc, cg.cell, cat), decor_in)
    rules.check_all(ev)
    return ev
