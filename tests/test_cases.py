"""Прогон oyna_data/test_cases.json через ядро."""
import json
from pathlib import Path

import pytest

from oyna_core import Catalog, Company, calc, commands, validate

CAT = Catalog()
CASES = json.load(open(Path(CAT.dir) / "test_cases.json", encoding="utf-8"))["cases"]


def build_pos(case):
    if "template" in case:
        doc = commands.create_from_template(CAT, case["template"], case.get("w"), case.get("h"))
    else:
        doc = json.loads(json.dumps(case["pos"]))
    return commands.apply(doc, case.get("commands", []))


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_case(case):
    exp = case["expect"]
    if not exp:
        pytest.skip(case.get("note", "нет ожиданий"))
    doc = build_pos(case)
    real = Company()                                         # боевой режим: demo_prices = False
    res = calc(doc, CAT, real) if case.get("stage", 1) >= 2 else validate(doc, CAT, real)
    got = {}
    for v in res["violations"]:
        sev = "block" if v["severity"] in ("block", "lock") else v["severity"]
        got.setdefault(sev, set()).add(v["code"])
    msg = json.dumps(res["violations"], ensure_ascii=False, indent=1)
    for sev in ("block", "warn", "hint", "auto_add"):
        if sev in exp:
            want = set(exp[sev])
            if not want and sev == "block":
                assert not got.get("block"), f"не ждали блоков:\n{msg}"
            assert want <= got.get(sev, set()), f"{sev}: ждали {want}, получили {got.get(sev)}\n{msg}"
        key = sev + "_absent"
        if key in exp:
            assert not set(exp[key]) & got.get(sev, set()), f"{key}: {exp[key]}\n{msg}"
    if "block_absent" in exp:
        assert not set(exp["block_absent"]) & got.get("block", set()), msg
    for key, want_present in (("warn_at", True), ("warn_absent_at", False)):
        for path, codes in exp.get(key, {}).items():
            here = {v["code"] for v in res["violations"] if v.get("path", "") == path}
            for c in codes:
                assert (c in here) == want_present, f"{key} {path}: {c}\n{msg}"
    if "price_group" in exp:
        assert res["price_group"] == exp["price_group"]
    codes = {l.get("code") for l in res.get("bom", [])}
    for c in exp.get("bom_has", []):
        assert c in codes, f"в спецификации нет {c}: {sorted(x for x in codes if x)}"
    for c in exp.get("bom_absent", []):
        assert c not in codes, f"в спецификации лишнее {c}"
