"""Бэкфилл названий проектов: «Новый проект 03.11.2026» и автоназвания → «Шкаф-купе 2400×650×2400».

    uv run python scripts/retitle_projects.py --database-url sqlite:////path/to/phone.db [--dry-run] [--fragments]

Трогает только проекты с title_source=auto или с названием по умолчанию (с датой); название мастера —
никогда. --fragments — ещё и названия, которые приложение вырезало из первой фразы описания.
Перед запуском база должна быть на миграции 0007 (`uv run alembic upgrade head`). Идемпотентно.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mebel_api.db import Database  # noqa: E402
from mebel_api.services.titles import retitle_all  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url", required=True)
    ap.add_argument("--dry-run", action="store_true", help="Показать, что изменится, без записи")
    ap.add_argument("--fragments", action="store_true", help="Ещё и названия из первой фразы описания")
    a = ap.parse_args()
    with Database(a.database_url).sessionmaker() as s:
        changed = retitle_all(s, include_fragments=a.fragments)
        for pid, old, new in changed:
            print(f"{pid}  «{old}» → «{new}»")
        if a.dry_run:
            s.rollback()
        else:
            s.commit()
    print(f"{'Будет изменено' if a.dry_run else 'Изменено'}: {len(changed)}")


if __name__ == "__main__":
    main()
