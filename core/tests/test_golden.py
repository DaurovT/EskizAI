"""Эталонные сборки: дерево модулей → спецификация, фурнитура, замечания.

Любое изменение модуля или правила, которое меняет детали, роняет этот тест.
Если изменение задумано — обновить эталоны и показать разницу конструктору:

    UPDATE_GOLDEN=1 uv run pytest tests/test_golden.py
"""

import json
import os
from pathlib import Path

import pytest

from mebel_core import build
from mebel_core.spec import hardware_rows, spec_rows

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = Path(__file__).parent / "golden"
CASES = sorted(p.stem for p in FIXTURES.glob("*.json"))


def snapshot(name: str) -> dict:
    result = build(json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8")))
    return {
        "ok": result.ok,
        "module_versions": result.module_versions,
        "rules_version": result.rules_version,
        "spec": [r.model_dump() for r in spec_rows(result)],
        "hardware": [r.model_dump() for r in hardware_rows(result)],
        "issues": [i.model_dump() for i in result.issues],
    }


@pytest.mark.parametrize("name", CASES)
def test_golden(name: str) -> None:
    actual = snapshot(name)
    path = GOLDEN / f"{name}.json"
    if os.environ.get("UPDATE_GOLDEN") or not path.exists():
        path.write_text(json.dumps(actual, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        pytest.skip(f"Эталон записан: {path.name}")
    expected = json.loads(path.read_text(encoding="utf-8"))
    assert actual == expected
