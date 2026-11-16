"""Бэкфилл эскиза миниатюры (summary.sketch) у версий, сохранённых до него.

    uv run python scripts/backfill_sketch.py --database-url postgresql+psycopg://… [--dry-run] [--all]

По умолчанию — только текущие версии проектов (их видно в списке); --all — все версии. Список проектов и без
бэкфилла показывает эскиз (считает из дерева на лету), бэкфилл лишь убирает этот лишний обход. Идемпотентно.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sqlalchemy import select  # noqa: E402

from mebel_api.db import Database  # noqa: E402
from mebel_api.models import ModelVersion, Project  # noqa: E402
from mebel_api.services.sketch import sketch_from_tree  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url", required=True)
    ap.add_argument("--dry-run", action="store_true", help="Посчитать, без записи")
    ap.add_argument("--all", action="store_true", help="Все версии, а не только текущие")
    a = ap.parse_args()
    changed = 0
    with Database(a.database_url).sessionmaker() as s:
        q = select(ModelVersion)
        if not a.all:
            q = q.where(ModelVersion.id.in_(select(Project.current_version_id).where(Project.current_version_id.is_not(None))))
        for v in s.scalars(q).yield_per(200):
            summary = v.summary if isinstance(v.summary, dict) else {}
            if isinstance(summary.get("sketch"), dict):
                continue
            sketch = sketch_from_tree(v.tree)
            if sketch is None:
                continue
            v.summary = {**summary, "sketch": sketch}  # новый dict — JSON-колонка без MutableDict
            changed += 1
        if a.dry_run:
            s.rollback()
        else:
            s.commit()
    print(f"{'Будет дописано' if a.dry_run else 'Дописано'}: {changed}")


if __name__ == "__main__":
    main()
