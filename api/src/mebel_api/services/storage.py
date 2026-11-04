"""Хранилище файлов: локальная папка (сейчас и в проде), S3-совместимое — заглушка.

Две зоны:
- публичная — фото проектов (страница клиента /p), логотипы цехов: ссылка `/media/{key}`;
- закрытая (`private=True`) — вложения переписки по заказу, фото и файлы возвратов, споров и исправлений,
  файлы «нестандарта»: ключ начинается с `private/`, публичной ссылки нет, отдаются только через
  `/signed-files/{token}` и ручки с проверкой доступа. `/media/private/…` не отдаётся (см. PublicMedia).
"""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..config import Settings

PRIVATE_PREFIX = "private/"


def is_private(key: str) -> bool:
    return key.startswith(PRIVATE_PREFIX)


@dataclass
class StoredFile:
    key: str
    url: str | None  # None — закрытый файл (ссылка только подписанная)


class Storage(Protocol):
    def save(self, key: str, data: bytes, content_type: str, *, private: bool = False) -> StoredFile: ...

    def delete(self, key: str) -> None: ...

    def read(self, key: str) -> bytes: ...


class LocalStorage:
    """Файлы в MEDIA_DIR; публичные отдаются приложением по /media, закрытые — в MEDIA_DIR/private (не отдаются)."""

    def __init__(self, root: Path, base_url: str):
        self.root = root
        self.base_url = base_url.rstrip("/")

    @property
    def private_root(self) -> Path:
        return self.root / PRIVATE_PREFIX.rstrip("/")

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise ValueError("Недопустимый ключ файла")
        return path

    def save(self, key: str, data: bytes, content_type: str, *, private: bool = False) -> StoredFile:
        key = key.lstrip("/")
        if private and not is_private(key):
            key = PRIVATE_PREFIX + key
        if not private and is_private(key):
            raise ValueError("Публичный файл не может лежать в закрытой зоне")
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return StoredFile(key=key, url=None if private else f"{self.base_url}/{key}")

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def move(self, key: str, new_key: str) -> None:
        """Перенос файла (scripts/move_private_media.py)."""
        src, dst = self._path(key), self._path(new_key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, dst)

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()


class S3Storage:
    """S3-совместимое хранилище — заглушка.

    План: boto3 (или aioboto3) с endpoint_url, put_object(Bucket, Key, Body,
    ContentType), публичная ссылка через S3_PUBLIC_BASE_URL — только для публичных ключей;
    `private/…` — закрытый бакет или префикс без публичного доступа.
    """

    def __init__(self, settings: Settings):
        self.settings = settings

    def save(self, key: str, data: bytes, content_type: str, *, private: bool = False) -> StoredFile:
        raise NotImplementedError("S3-хранилище ещё не подключено (STORAGE_BACKEND=local для разработки)")

    def delete(self, key: str) -> None:
        raise NotImplementedError("S3-хранилище ещё не подключено")

    def read(self, key: str) -> bytes:
        raise NotImplementedError("S3-хранилище ещё не подключено")


def make_storage(settings: Settings) -> Storage:
    if settings.storage_backend == "s3":
        return S3Storage(settings)
    return LocalStorage(settings.media_dir, settings.media_base_url)
