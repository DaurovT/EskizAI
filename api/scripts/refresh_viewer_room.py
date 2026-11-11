"""Пересчитать блок `room` (стены, пол, потолок вокруг встроенной мебели) в сохранённых 3D-снимках версий.

Снимок 3D (`model_versions.viewer`) сохраняется при сборке версии, поэтому правки `room.py` видны только в новых
версиях. Скрипт обновляет у встроенной мебели только `viewer.room`: детали, смета, раскрой и файлы не меняются.

    python scripts/refresh_viewer_room.py [--database-url URL] [--dry-run]
"""

import argparse

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from mebel_api.config import Settings
from mebel_api.db import Database
from mebel_api.models import ModelVersion
from mebel_core import build, viewer_model


def refresh(db: Database, *, dry_run: bool = False) -> dict[str, int]:
    stats = {"checked": 0, "updated": 0, "failed": 0}
    with db.sessionmaker() as s:
        for v in s.scalars(select(ModelVersion)):
            tree = v.tree if isinstance(v.tree, dict) else None
            if not tree or not (tree.get("builtin") or tree.get("installation") == "niche" or tree.get("site")):
                continue
            stats["checked"] += 1
            try:
                room = viewer_model(build(tree)).get("room")
            except Exception:
                stats["failed"] += 1
                continue
            viewer = dict(v.viewer or {})
            if room is None or viewer.get("room") == room:
                continue
            viewer["room"] = room
            v.viewer = viewer
            flag_modified(v, "viewer")
            stats["updated"] += 1
        if dry_run:
            s.rollback()
        else:
            s.commit()
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    print(refresh(Database(a.database_url or Settings().database_url), dry_run=a.dry_run))


if __name__ == "__main__":
    main()
