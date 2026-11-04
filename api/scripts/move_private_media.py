"""Перенести закрытые файлы из публичной папки /media в закрытую зону MEDIA_DIR/private (один раз после
обновления; повторный запуск ничего не ломает).

    uv run python scripts/move_private_media.py [--database-url …] [--media-dir /data/media] [--dry-run]

Что переносится: вложения переписки по заказу, фото возвратов и споров, файлы исправлений, файлы «нестандарта».
Фото проектов и логотипы цехов остаются публичными (страница клиента /p, КП).
В Docker: docker compose exec api python scripts/move_private_media.py
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mebel_api.config import get_settings  # noqa: E402
from mebel_api.db import Database  # noqa: E402
from mebel_api.services.private_media import move_private_media  # noqa: E402
from mebel_api.services.storage import LocalStorage  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url")
    ap.add_argument("--media-dir", help="По умолчанию MEDIA_DIR из настроек")
    ap.add_argument("--dry-run", action="store_true", help="Только показать, что будет перенесено")
    a = ap.parse_args()
    settings = get_settings()
    if settings.storage_backend != "local" and not a.media_dir:
        sys.exit("STORAGE_BACKEND не local — переносить нечего (или укажите --media-dir)")
    storage = LocalStorage(Path(a.media_dir) if a.media_dir else settings.media_dir, settings.media_base_url)
    with Database(a.database_url or settings.database_url).sessionmaker() as db:
        stats = move_private_media(db, storage, dry_run=a.dry_run)
    print({"dry_run": a.dry_run, **stats})


if __name__ == "__main__":
    main()
