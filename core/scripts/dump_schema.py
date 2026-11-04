"""Выгружает JSON Schema дерева модулей в /schemas.

Из неё делаются: схема инструмента для Claude (tool use) и типы TypeScript
для приложения. Запуск: uv run python scripts/dump_schema.py
"""

import json
from pathlib import Path

from mebel_core.schema import Product

out = Path(__file__).resolve().parents[2] / "schemas" / "product.schema.json"
out.write_text(json.dumps(Product.model_json_schema(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Схема записана: {out}")
