"""Декоры EMAN и палитра краски: загрузка из data/*.json (собираются скриптами api/scripts).

Файлы лежат в пакете; если их нет (чистая сборка), каталог ядра остаётся прежним.
"""

import json
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

# Листовой формат, под который считаются раскрой и цена листа (2800×2070)
STD_SHEET_M2 = 5.796


def _read(name: str):
    p = DATA_DIR / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@lru_cache(maxsize=1)
def load_decors() -> list[dict]:
    """Все декоры EMAN (ЛДСП, МДФ, акрил, HPL, столешницы, кромка…) в порядке файла."""
    data = _read("eman_decors.json")
    return list(data["items"]) if data else []


@lru_cache(maxsize=1)
def load_paint() -> dict:
    """Палитра RAL/NCS и степени блеска: {"colors": [...], "gloss": [...]}."""
    return _read("paint_colors.json") or {"colors": [], "gloss": []}
