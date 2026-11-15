"""Чистка кэша AR-файлов (services/ar_files.prune_local_cache). Для cron раз в сутки:

    python scripts/prune_ar_cache.py [--days 30]
"""

import argparse

from mebel_api.config import Settings
from mebel_api.db import Database
from mebel_api.services.ar_files import prune_local_cache


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    a = ap.parse_args()
    s = Settings()
    with Database(s.database_url).sessionmaker() as db:
        print(prune_local_cache(db, s.media_dir, older_than_days=a.days))


if __name__ == "__main__":
    main()
