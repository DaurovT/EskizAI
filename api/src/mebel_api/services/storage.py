"""Хранилище файлов: локальная папка в разработке, S3-совместимое в проде (заглушка)."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..config import Settings


@dataclass
class StoredFile:
    key: str
    url: str


class Storage(Protocol):
    def save(self, key: str, data: bytes, content_type: str) -> StoredFile: ...

    def delete(self, key: str) -> None: ...

    def read(self, key: str) -> bytes: ...


class LocalStorage:
    """Файлы в MEDIA_DIR, отдаются приложением по /media (только для разработки)."""

    def __init__(self, root: Path, base_url: str):
        self.root = root
        self.base_url = base_url.rstrip("/")

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise ValueError("Недопустимый ключ файла")
        return path

    def save(self, key: str, data: bytes, content_type: str) -> StoredFile:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return StoredFile(key=key, url=f"{self.base_url}/{key}")

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()


class S3Storage:
    """S3-совместимое хранилище — заглушка.

    План: boto3 (или aioboto3) с endpoint_url, put_object(Bucket, Key, Body,
    ContentType), публичная ссылка через S3_PUBLIC_BASE_URL или presigned URL.
    """

    def __init__(self, settings: Settings):
        self.settings = settings

    def save(self, key: str, data: bytes, content_type: str) -> StoredFile:
        raise NotImplementedError("S3-хранилище ещё не подключено (STORAGE_BACKEND=local для разработки)")

    def delete(self, key: str) -> None:
        raise NotImplementedError("S3-хранилище ещё не подключено")

    def read(self, key: str) -> bytes:
        raise NotImplementedError("S3-хранилище ещё не подключено")


def make_storage(settings: Settings) -> Storage:
    if settings.storage_backend == "s3":
        return S3Storage(settings)
    return LocalStorage(settings.media_dir, settings.media_base_url)
