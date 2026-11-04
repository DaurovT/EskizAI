"""Запустить источники цен поставщиков, у которых подошло время по расписанию (раз в час / в день).

    uv run python scripts/run_price_sources.py [--database-url …]

Для cron (например, каждые 15 минут). Альтернатива — PRICE_SOURCE_SCHEDULER=true: фоновая проверка в процессе API.
Изменения ≤ 15% применяются сразу, остальные ждут подтверждения владельца поставщика.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mebel_api.config import get_settings  # noqa: E402
from mebel_api.db import Database  # noqa: E402
from mebel_api.services.price_import import run_due  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url")
    a = ap.parse_args()
    settings = get_settings()
    print({"ran": run_due(Database(a.database_url or settings.database_url), settings)})


if __name__ == "__main__":
    main()
