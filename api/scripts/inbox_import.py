"""Положить пакет .eskiz во «Входящие чертежи» мастера с сервера — по просьбе владельца аккаунта
(например, тестовый чертёж, когда отправить из Eskiz DWG с телефона нельзя). Те же проверки и хранение,
что у POST /inbox/drawings.

    python scripts/inbox_import.py --share-token TOKEN  /tmp/file.eskiz   # мастер — автор ссылки клиента
    python scripts/inbox_import.py --user-id UUID       /tmp/file.eskiz
    python scripts/inbox_import.py --phone +998901234567 /tmp/file.eskiz
"""

import argparse
import hashlib
import json
import uuid
from pathlib import Path

from sqlalchemy import select

from mebel_api.config import Settings
from mebel_api.db import Database
from mebel_api.models import ShareLink, User
from mebel_api.services import inbox
from mebel_api.services.storage import make_storage


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--share-token")
    g.add_argument("--user-id")
    g.add_argument("--phone", help="номер мастера, например +998901234567")
    ap.add_argument("package")
    a = ap.parse_args()

    settings = Settings()
    db = Database(settings.database_url)
    data = Path(a.package).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    with db.sessionmaker() as s:
        if a.share_token:
            link = s.scalar(select(ShareLink).where(ShareLink.token == a.share_token))
            if link is None or link.created_by is None:
                raise SystemExit("ссылка не найдена или без автора")
            user_id = link.created_by
        elif a.phone:
            from mebel_api.services.auth_codes import normalize_phone
            u = s.scalar(select(User).where(User.phone == normalize_phone(a.phone)))
            if u is None:
                raise SystemExit("пользователь с таким номером не найден")
            user_id = u.id
        else:
            user_id = uuid.UUID(a.user_id)
        if s.get(User, user_id) is None:
            raise SystemExit("пользователь не найден")
        d, created = inbox.store_drawing(s, settings, make_storage(settings), user_id, Path(a.package).name, data, sha)
        print(json.dumps({"drawing_id": str(d.id), "created": created, "title": d.title}, ensure_ascii=False))


if __name__ == "__main__":
    main()
