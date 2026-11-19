"""Стеклопакеты: пресеты (glass.csv) и своя формула (glass_formula.json)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .data import Catalog

RU = str.maketrans({"и": "i", "з": "t"})
PANE = re.compile(r"^(?:(\d+(?:\.\d+)?)\.(\d+(?:\.\d+)?)\.(\d+)|(\d+(?:\.\d+)?))((?:p4a|tn|i|t|m)*)$")


class GlassError(ValueError):
    pass


@dataclass
class Pane:
    mm: float
    glass_mm: float
    triplex: bool = False
    low_e: bool = False
    tempered: bool = False
    tinted: bool = False
    matte: bool = False
    armored: bool = False               # P4A (§9.6)


@dataclass
class Glass:
    spec: str                       # то, что в setup.glass / cell.fill.glass
    formula: str
    panes: list[Pane]
    spacers: list[dict] = field(default_factory=list)
    preset: str | None = None

    @property
    def chambers(self) -> int:
        return len(self.spacers)

    @property
    def thickness_mm(self) -> float:
        return round(sum(p.mm for p in self.panes) + sum(s["mm"] for s in self.spacers), 1)

    @property
    def glass_mm_total(self) -> float:
        return sum(p.glass_mm for p in self.panes)

    @property
    def weight_kg_m2(self) -> float:
        return round(self.glass_mm_total * 2.5, 2)

    @property
    def safety(self) -> bool:
        """Закалённое или триплекс со стороны помещения (последнее стекло) или во всех стёклах."""
        return all(p.tempered or p.triplex for p in self.panes) or (self.panes[-1].tempered or self.panes[-1].triplex)

    @property
    def single(self) -> bool:
        return not self.spacers


def preset_to_formula(code: str) -> str:
    c = code.lower()
    if c.endswith("_tempered"):
        return c[1:].split("_")[0] + "t"
    return "-".join(c[1:].split("_"))


def parse(spec: str, cat: Catalog) -> Glass:
    """setup.glass: код пресета (g4_12_4) или формула (6t-14-4i). Ошибка → GlassError (правило 4.9)."""
    if spec in cat.glass_presets:
        token = cat.glass_presets[spec]["formula"].split(" ")[0]
        try:                                   # формула пресета из glass.csv (триплекс, аргон, тёплая рамка)
            g = _parse_formula(token, cat)
        except GlassError:
            g = _parse_formula(preset_to_formula(spec), cat)
        g.spec, g.preset = spec, spec
        return g
    g = _parse_formula(spec, cat)
    # формула совпала с пресетом — берём пресет (его цена — прайс стекольщика)
    for code, row in cat.glass_presets.items():
        if row["formula"].split(" ")[0] == spec.strip():
            g.preset = code
    return g


def _parse_formula(formula: str, cat: Catalog) -> Glass:
    lim = cat.glass_formula["grammar"]["limits"]
    f = formula.strip().lower().translate(RU).replace(" ", "")
    if not f:
        raise GlassError("пустая формула")
    parts = f.split("-")
    if len(parts) % 2 == 0:
        raise GlassError("формула: стекло-рамка-стекло…")
    panes, spacers = [], []
    for i, p in enumerate(parts):
        if i % 2:
            m = re.fullmatch(r"(\d+)(ar)?(tgi|warm)?", p)
            if not m:
                raise GlassError(f"рамка «{p}»: число мм и необязательно ar, tgi (тёплая рамка)")
            w = int(m.group(1))
            if not lim["spacer_mm"][0] <= w <= lim["spacer_mm"][1]:
                raise GlassError(f"рамка {w} мм вне {lim['spacer_mm'][0]}–{lim['spacer_mm'][1]} мм")
            spacers.append({"mm": w, "argon": bool(m.group(2)), "warm": bool(m.group(3))})
            continue
        m = PANE.match(p)
        if not m:
            raise GlassError(f"стекло «{p}»: толщина + i/t/tn/m или триплекс 4.4.1")
        sfx = m.group(5) or ""
        flags = set(re.findall(r"p4a|tn|i|t|m", sfx))
        if m.group(1):
            gmm = float(m.group(1)) + float(m.group(2))
            pane = Pane(mm=round(gmm + int(m.group(3)) * 0.38, 2), glass_mm=gmm, triplex=True)
        else:
            mm = float(m.group(4))
            if not lim["pane_mm"][0] <= mm <= lim["pane_mm"][1]:
                raise GlassError(f"стекло {mm:g} мм вне {lim['pane_mm'][0]}–{lim['pane_mm'][1]} мм")
            pane = Pane(mm=mm, glass_mm=mm)
        pane.low_e, pane.tempered, pane.tinted, pane.matte = "i" in flags, "t" in flags, "tn" in flags, "m" in flags
        pane.armored = "p4a" in flags
        panes.append(pane)
    if len(spacers) > lim["chambers_max"]:
        raise GlassError(f"камер больше {lim['chambers_max']}")
    return Glass(spec=formula, formula=f, panes=panes, spacers=spacers)


def price_m2(g: Glass, cat: Catalog, company=None) -> tuple[float | None, str, str]:
    """Цена за м²: (цена, статус, как посчитано). Сначала прайс стекольщика цеха, потом базовый пресет,
    потом надбавки (свои у цеха или базовые). Пресет без цены → (None, 'НЕТ ДАННЫХ', …)."""
    own = getattr(company, "glass_prices", {}) or {}
    for key in (g.preset, g.formula):
        if key and key in own:
            return float(own[key]), "найдено", "прайс стекольщика цеха"
    if g.preset:
        row = cat.glass_presets[g.preset]
        if row["price_sum_m2"]:
            return float(row["price_sum_m2"]), row["price_status"], f"пресет {g.preset}"
    P = {k: v["value"] for k, v in cat.glass_formula["pricing_sum_m2"].items()}
    own_rules = getattr(company, "glass_pricing", {}) or {}
    P.update({k: float(v) for k, v in own_rules.items() if k in P})
    if own_rules and set(own_rules) >= {"base_single_chamber"}:
        status_custom = "найдено"
    else:
        status_custom = "оценка"
    s = P["single_pane_4mm"] if g.single else P["base_single_chamber"] + P["extra_chamber"] * (g.chambers - 1)
    for p in g.panes:
        s += max(0.0, p.glass_mm - 4 * (2 if p.triplex else 1)) * P["pane_extra_per_mm"]
        s += P["low_e"] * p.low_e + P["tempered"] * p.tempered + P["tinted"] * p.tinted
        s += P["matte"] * p.matte + P["triplex"] * p.triplex
    s += P["argon"] * sum(sp["argon"] for sp in g.spacers)
    s += P.get("warm_spacer", 0) * sum(sp.get("warm", False) for sp in g.spacers)
    s += P.get("armored_p4a", 0) * sum(p.armored for p in g.panes)
    s += P.get("spacer_extra_per_mm", 0) * sum(max(0, sp["mm"] - 12) for sp in g.spacers)
    how = "по надбавкам цеха" if status_custom == "найдено" else "по надбавкам glass_formula.json"
    return float(s), status_custom, how


def fits_beads(g: Glass, passport: dict) -> str | None:
    """Роль штапика под толщину или None, если не помещается (правило 4.6)."""
    t = g.thickness_mm
    for role, (lo, hi) in passport.get("beads", {}).items():
        if lo <= t <= hi:
            return role
    return None


def min_area(cat: Catalog) -> float:
    return cat.glass_formula["pricing_sum_m2"]["min_area_m2"]["value"]
