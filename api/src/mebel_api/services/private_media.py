"""Перенос уже сохранённых закрытых файлов в закрытую зону хранилища (scripts/move_private_media.py).

До этой версии вложения переписки, фото возвратов и споров, файлы исправлений и «нестандарта» лежали
в публичной папке /media. Переносим каждый файл в `private/<прежний ключ>` и меняем ключ в базе; тип файла
пересчитываем по содержимому. Идемпотентно: уже перенесённые пропускаются; файл перенесён, а база нет
(обрыв между шагами) — ключ правится при следующем запуске.
"""

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import NonstandardRequest, OrderCorrection, OrderDispute, OrderMessage, OrderReturn
from .storage import PRIVATE_PREFIX, LocalStorage, is_private
from .uploads import safe_content_type

log = logging.getLogger(__name__)

# (модель, JSON-колонка со списком файлов {id, name, key, content_type, …})
COLUMNS = ((OrderMessage, "attachments"), (OrderReturn, "photos"), (OrderDispute, "photos"),
           (OrderCorrection, "files"), (NonstandardRequest, "files"))


def _move_entry(storage: LocalStorage, f: dict[str, Any], stats: dict[str, int], dry_run: bool) -> dict[str, Any]:
    key = f.get("key")
    if not isinstance(key, str) or not key or is_private(key):
        stats["skipped"] += 1
        return f
    new_key = PRIVATE_PREFIX + key.lstrip("/")
    if storage.exists(key):
        if not dry_run:
            storage.move(key, new_key)
        stats["moved"] += 1
    elif storage.exists(new_key):
        stats["relinked"] += 1
    else:
        stats["missing"] += 1
        log.warning("Нет файла %s — ключ всё равно переводим в закрытую зону", key)
    out = {**f, "key": new_key}
    if not dry_run and storage.exists(new_key):
        out["content_type"] = safe_content_type(storage.read(new_key), f.get("content_type"))
    return out


def move_private_media(db: Session, storage: LocalStorage, *, dry_run: bool = False) -> dict[str, int]:
    stats = {"moved": 0, "relinked": 0, "missing": 0, "skipped": 0, "rows": 0}
    for model, column in COLUMNS:
        for row in db.scalars(select(model)):
            files = getattr(row, column) or []
            if not any(isinstance(f, dict) and not is_private(str(f.get("key") or "")) for f in files):
                continue
            new = [_move_entry(storage, f, stats, dry_run) if isinstance(f, dict) else f for f in files]
            stats["rows"] += 1
            if not dry_run:
                setattr(row, column, new)  # JSON-колонка: новый список, чтобы SQLAlchemy увидел изменение
                db.commit()  # после каждой строки: файл уже перенесён — ключ в базе сразу за ним
    return stats
