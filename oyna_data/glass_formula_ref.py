"""Эталонный разбор формулы стеклопакета (для ядра oyna_core и проверки glass_formula.json).

    python glass_formula_ref.py            # проверить worked_examples
    python glass_formula_ref.py 6t-14-4i   # разобрать формулу
"""
import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.load(open(HERE / "glass_formula.json", encoding="utf-8"))
P = {k: v["value"] for k, v in CFG["pricing_sum_m2"].items()}
LIM = CFG["grammar"]["limits"]
PRESETS = {r["formula"].split(" ")[0]: r for r in csv.DictReader(open(HERE / "glass.csv", encoding="utf-8"))}

RU = str.maketrans({"и": "i", "з": "t"})
PANE = re.compile(r"^(?:(\d+(?:\.\d+)?)\.(\d+(?:\.\d+)?)\.(\d+)|(\d+(?:\.\d+)?))(tn|i|t|m)*$")
SUFFIX = re.compile(r"tn|i|t|m")


def parse(formula: str) -> dict:
    f = formula.strip().lower().translate(RU).replace(" ", "")
    parts = f.split("-")
    if len(parts) % 2 == 0:
        raise ValueError("формула: стекло-рамка-стекло…, число частей должно быть нечётным")
    panes, spacers = [], []
    for i, p in enumerate(parts):
        if i % 2:                                     # рамка
            m = re.fullmatch(r"(\d+)(ar)?", p)
            if not m:
                raise ValueError(f"рамка «{p}»: число мм и необязательный суффикс ar")
            w = int(m.group(1))
            if not LIM["spacer_mm"][0] <= w <= LIM["spacer_mm"][1]:
                raise ValueError(f"рамка {w} мм вне {LIM['spacer_mm']}")
            spacers.append({"mm": w, "argon": bool(m.group(2))})
        else:                                         # стекло
            m = PANE.match(p)
            if not m:
                raise ValueError(f"стекло «{p}»: толщина + i/t/tn/m или триплекс 4.4.1")
            if m.group(1):                            # триплекс a.b.c — два стекла + плёнка c×0,38 мм
                mm = float(m.group(1)) + float(m.group(2)) + int(m.group(3)) * 0.38
                glass_mm, triplex = float(m.group(1)) + float(m.group(2)), True
            else:
                mm = glass_mm = float(m.group(4)); triplex = False
            sfx = SUFFIX.findall(p[len(p.rstrip("itnm")):]) if not p.rstrip("itnm") == p else []
            if not triplex and not LIM["pane_mm"][0] <= mm <= LIM["pane_mm"][1]:
                raise ValueError(f"стекло {mm} мм вне {LIM['pane_mm']}")
            panes.append({"mm": mm, "glass_mm": glass_mm, "triplex": triplex, "low_e": "i" in sfx,
                          "tempered": "t" in sfx, "tinted": "tn" in sfx, "matte": "m" in sfx})
    if len(spacers) > LIM["chambers_max"]:
        raise ValueError(f"камер больше {LIM['chambers_max']}")
    thickness = round(sum(p["mm"] for p in panes) + sum(s["mm"] for s in spacers), 1)
    glass_mm = sum(p["glass_mm"] for p in panes)
    return {"formula": formula, "panes": panes, "spacers": spacers, "chambers": len(spacers),
            "thickness_mm": thickness, "glass_mm_total": glass_mm, "weight_kg_m2": round(glass_mm * 2.5, 1)}


def price(g: dict) -> tuple[int, str]:
    preset = PRESETS.get(g["formula"].strip())
    if preset and preset["price_sum_m2"]:
        return int(preset["price_sum_m2"]), f"пресет {preset['glass_code']}"
    if g["chambers"] == 0:
        s = P["single_pane_4mm"]
    else:
        s = P["base_single_chamber"] + P["extra_chamber"] * (g["chambers"] - 1)
    for p in g["panes"]:
        s += max(0, p["glass_mm"] - 4 * (2 if p["triplex"] else 1)) * P["pane_extra_per_mm"]
        s += P["low_e"] * p["low_e"] + P["tempered"] * p["tempered"] + P["tinted"] * p["tinted"]
        s += P["matte"] * p["matte"] + P["triplex"] * p["triplex"]
    s += P["argon"] * sum(sp["argon"] for sp in g["spacers"])
    return int(s), "по надбавкам glass_formula.json"


if __name__ == "__main__":
    if len(sys.argv) > 1:
        g = parse(sys.argv[1]); print(json.dumps(g, ensure_ascii=False, indent=1), price(g))
    else:
        bad = 0
        for ex in CFG["worked_examples"]:
            g = parse(ex["formula"]); pr, how = price(g)
            ok = (g["thickness_mm"], g["weight_kg_m2"], pr) == (ex["thickness_mm"], ex["weight_kg_m2"], ex["price_sum_m2"])
            bad += not ok
            print("OK " if ok else "ERR", ex["formula"].ljust(20), g["thickness_mm"], g["weight_kg_m2"], pr, "|", how)
        sys.exit(bad)
