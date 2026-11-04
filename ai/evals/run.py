"""Оценка ИИ на наборе заказов (неделя 8 плана).

Сейчас — 5 синтетических текстовых примеров. Основной набор — 30 реальных
заказов от мастеров (фото + текст + эталон), его нужно собрать на этапе 0.

ВНИМАНИЕ: прогон делает реальные запросы к Claude API и стоит денег
(ориентир — до $0,3 на пример). Запуск: uv run python evals/run.py
"""

import json
import sys
from pathlib import Path

from mebel_ai import LLM, DesignSession


def check(case: dict, tree: dict | None) -> list[str]:
    e, fails = case["expect"], []
    if not tree:
        return ["нет дерева"]
    if tree.get("type", "wardrobe") != e["type"]:
        fails.append(f"тип {tree.get('type')} ≠ {e['type']}")
    if "width" in e and abs(tree.get("width", 0) - e["width"]) > 50:
        fails.append(f"ширина {tree.get('width')}")
    if "height" in e and abs(tree.get("height", 0) - e["height"]) > 50:
        fails.append(f"высота {tree.get('height')}")
    if "sections" in e and len(tree.get("sections", [])) != e["sections"]:
        fails.append(f"секций {len(tree.get('sections', []))}")
    sd = tree.get("sliding_doors") or {}
    if "sliding_doors" in e and sd.get("count") != e["sliding_doors"]:
        fails.append(f"купе-дверей {sd.get('count')}")
    if "mirrors" in e and (sd.get("fills") or []).count("mirror") != e["mirrors"]:
        fails.append("зеркала")
    if e["type"] == "kitchen":
        run = sum(c["width"] for c in tree.get("base", []))
        if not e.get("base_run_min", 0) <= run <= e.get("base_run_max", 10**6):
            fails.append(f"длина низа {run}")
        if e.get("has_appliance") and not any(c["kind"] == "appliance" for c in tree.get("base", [])):
            fails.append("нет ниши под технику")
    return fails


def main() -> int:
    cases = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))
    passed, total_cost = 0, 0.0
    for case in cases:
        llm = LLM()
        r = DesignSession(language=case["lang"], llm=llm).start(case["text"])
        fails = check(case, r.tree)
        passed += not fails
        total_cost += llm.total_cost
        print(f"{'OK ' if not fails else 'FAIL'} {case['id']}: {r.status}, ${llm.total_cost:.4f} "
              f"{'; '.join(fails)}")
    print(f"\n{passed}/{len(cases)} верно с первого раза; всего ${total_cost:.3f}")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
