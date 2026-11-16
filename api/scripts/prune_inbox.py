"""Чистка входящих чертежей Eskiz DWG (services/inbox.prune). Для cron раз в сутки:

    python scripts/prune_inbox.py

Файлы удалённых и истёкших (90 дней без открытия) чертежей удаляются, если на тот же пакет (sha256)
не осталось живых строк у других пользователей; истёкшие строки — сразу, удалённые — через сутки.
"""

from mebel_api.config import Settings
from mebel_api.db import Database
from mebel_api.services.inbox import prune
from mebel_api.services.storage import make_storage


def main() -> None:
    s = Settings()
    with Database(s.database_url).sessionmaker() as db:
        print(prune(db, make_storage(s)))


if __name__ == "__main__":
    main()
