"""Справочники ядра: каталог, системы, паспорта, правила, фурнитура, стекло, декоры.

Сейчас читаются из файлов oyna_data/ (те же, что грузит seed_import.py в PostgreSQL).
Серверу достаточно подменить загрузку на чтение из базы — интерфейс Catalog тот же.
"""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

DEFAULT_DATA = Path(__file__).resolve().parent.parent / "oyna_data"


def _csv(p: Path) -> list[dict]:
    with open(p, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _json(p: Path):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _num(v):
    if v in (None, ""):
        return None
    try:
        return int(v)
    except ValueError:
        return float(v)


@dataclass
class Company:
    """Настройки цеха, нужные расчёту. Значения по умолчанию — как в schema.sql."""
    name: str = "Цех"
    mode: str = "manufacturer"           # manufacturer | dealer
    dealer_coef: float = 0.0
    markup_kind: str = "percent"         # percent | per_m2
    markup_value: float = 0.0
    usd_rate: float | None = None
    install_gap_mm: int = 20
    rounding_sum: int = 1000
    skew_warn_mm: int = 10
    demo_prices: bool = False
    waste_pct: float = 10.0              # отход профиля при расчёте позиции по метрам (FR-P2)
    quote_price_check_days: int = 14     # FR-Q5
    plan: str = "free"                   # free | pro (брендированное КП, раскрой)
    work_rates: dict = field(default_factory=dict)   # work_code -> (unit, price)
    kits: list = field(default_factory=list)
    item_prices: dict = field(default_factory=dict)  # (item_id, color) -> цена цеха поверх базовой (FR-C4)
    glass_prices: dict = field(default_factory=dict) # glass_code -> цена за м² у стекольщика цеха
    glass_pricing: dict = field(default_factory=dict) # переопределение надбавок glass_formula.json: ключ -> значение

    @classmethod
    def demo(cls, data_dir: Path = DEFAULT_DATA) -> "Company":
        d = _json(data_dir / "demo_company.json")
        c = d["company"]
        works = {w["work_code"]: (w["unit"], float(w["demo_price_sum"]))
                 for w in _csv(data_dir / "works_defaults.csv") if w["demo_price_sum"] != ""}
        return cls(name=c["name"], mode=c["mode"], dealer_coef=c["dealer_coef"], markup_kind=c["markup_kind"],
                   markup_value=c["markup_value"], usd_rate=c["usd_rate"], install_gap_mm=c["install_gap_mm"],
                   rounding_sum=c["rounding_sum"], skew_warn_mm=c["skew_warn_mm"], demo_prices=c["demo_prices"],
                   work_rates=works, kits=d["kits"])


class Catalog:
    def __init__(self, data_dir: Path | str = DEFAULT_DATA):
        self.dir = Path(data_dir)

    # ---------- сырые файлы ----------
    @cached_property
    def items(self) -> list[dict]:
        return _csv(self.dir / "catalog_items.csv")

    @cached_property
    def systems(self) -> dict[str, dict]:
        return {s["system_code"]: s for s in _csv(self.dir / "systems.csv")}

    @cached_property
    def passports_raw(self) -> dict:
        return _json(self.dir / "passports.json")

    @cached_property
    def rules(self) -> dict[str, dict]:
        d = _json(self.dir / "rules_level1.json")
        return {r["code"]: r for r in d["rules"]}

    @cached_property
    def rules_meta(self) -> dict:
        return _json(self.dir / "rules_level1.json")

    @cached_property
    def templates(self) -> dict[str, dict]:
        return {t["id"]: t for t in _json(self.dir / "templates.json")["templates"]}

    @cached_property
    def fitting_rules(self) -> list[dict]:
        rows = _csv(self.dir / "fitting_rules.csv")
        for r in rows:
            for k in ("w_from", "w_to", "h_from", "h_to", "cams", "demo_price_sum"):
                r[k] = _num(r[k])
        return rows

    @cached_property
    def fitting_systems(self) -> dict[str, dict]:
        return {k: v for k, v in _json(self.dir / "fitting_systems.json").items() if not k.startswith("_")}

    @cached_property
    def glass_presets(self) -> dict[str, dict]:
        return {g["glass_code"]: g for g in _csv(self.dir / "glass.csv")}

    @cached_property
    def glass_formula(self) -> dict:
        return _json(self.dir / "glass_formula.json")

    @cached_property
    def decors_cfg(self) -> dict:
        return _json(self.dir / "decors.json")

    @cached_property
    def decors(self) -> dict[str, dict]:
        return {d["id"]: d for d in self.decors_cfg["decors"]}

    @cached_property
    def reinforcement_map(self) -> list[dict]:
        return _csv(self.dir / "reinforcement_map.csv")

    @cached_property
    def consumables(self) -> dict:
        return _json(self.dir / "consumables.json")

    def apply_role_overrides(self, rows: list[dict]) -> None:
        """Ручная разметка ролей из админки каталога (S14): {item_id, role, unit?}."""
        by_id = {it["item_id"]: it for it in self.items}
        for r in rows:
            it = by_id.get(r["item_id"])
            if it:
                it["role"] = r["role"]
                if r.get("unit"):
                    it["unit"] = r["unit"]
                it["needs_review"] = "0"
        for k in ("_by_sys_role_color", "_by_article", "_by_sys_article"):
            self.__dict__.pop(k, None)

    @cached_property
    def works(self) -> dict[str, dict]:
        return {w["work_code"]: w for w in _csv(self.dir / "works_defaults.csv")}

    # ---------- индексы ----------
    @cached_property
    def _by_sys_role_color(self) -> dict:
        idx: dict = {}
        for it in self.items:
            idx.setdefault((it["system_code"], it["role"], it["color"]), []).append(it)
        for v in idx.values():
            v.sort(key=lambda x: int(x["pos"] or 0))
        return idx

    @cached_property
    def _by_article(self) -> dict:
        idx: dict = {}
        for it in self.items:
            idx.setdefault(it["article"], []).append(it)
        return idx

    @cached_property
    def _by_sys_article(self) -> dict:
        return {(it["system_code"], it["article"], it["color"]): it for it in self.items}

    def items_for(self, system: str, role: str, color: str) -> list[dict]:
        return self._by_sys_role_color.get((system, role, color), [])

    def item_by_article(self, article: str, system: str | None = None, color: str | None = None) -> dict | None:
        cands = self._by_article.get(article, [])
        if system:
            cands = [c for c in cands if c["system_code"] == system] or cands
        if color:
            cands = [c for c in cands if c["color"] == color] or cands
        priced = [c for c in cands if c["price_sum"]]
        return (priced or cands or [None])[0]

    # ---------- паспорт ----------
    def passport(self, system_code: str) -> dict:
        raw = self.passports_raw
        sysrow = self.systems.get(system_code)
        if system_code in raw:
            p = dict(raw[system_code])
            base = dict(raw.get(p.get("inherits", ""), {}))
            base.update(p)
            base["_key"] = system_code
            return base
        cls = (sysrow or {}).get("passport_class") or "pvc_60"
        p = dict(raw[cls])
        p["_key"] = cls
        return p

    def material(self, system_code: str) -> str:
        return (self.systems.get(system_code) or {}).get("material_class", "pvc")

    def groove(self, system_code: str) -> str:
        return (self.systems.get(system_code) or {}).get("fitting_groove", "")

    def system_colors(self, system_code: str) -> list[str]:
        s = self.systems.get(system_code)
        return [c for c in (s["colors"].split("|") if s else []) if c]

    def compatible_fitting_sets(self, system_code: str, opening: str | None = None) -> list[str]:
        g, m = self.groove(system_code), self.material(system_code)
        out = []
        for code, fs in self.fitting_systems.items():
            if g in fs["grooves"] and m in fs["materials"] and (opening is None or opening in fs["openings"]):
                out.append(code)
        out.sort(key=lambda c: (not self.fitting_systems[c].get("default"), c))
        return out
