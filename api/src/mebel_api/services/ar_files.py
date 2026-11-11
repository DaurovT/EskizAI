"""Файлы AR (docs/ar_contract.md): GLB для Scene Viewer и USDZ для AR Quick Look.

Строятся из версии модели ядром (export_glb / export_usdz) и кэшируются в закрытой зоне хранилища по
(версия, состояние, формат) — повторный запрос не пересобирает. Версия модели не меняется после сборки,
поэтому кэш не устаревает; CACHE_REV — поднять, когда меняется сборка файлов в ядре (новая геометрия).

Мастеру — короткоживущие подписанные ссылки `/ar-files/{token}.{glb|usdz}` (1 час, непрозрачный токен
services/signed_files): системный AR-просмотрщик заголовок авторизации не передаёт.
"""

import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from mebel_core import ar_placement, build, export_glb, export_usdz, parse_tree

from ..config import Settings
from ..db import utcnow
from ..errors import ApiError
from ..models import ModelVersion
from .signed_files import make_token, verify
from .storage import Storage

log = logging.getLogger(__name__)

Format = Literal["glb", "usdz"]
State = Literal["closed", "open"]

CACHE_REV = "1"
LINK_TTL = timedelta(hours=1)
CONTENT_TYPES: dict[str, str] = {"glb": "model/gltf-binary", "usdz": "model/vnd.usdz+zip"}

_TOKEN_KEY = re.compile(r"^ar:(?P<vid>[0-9a-f-]{36}):(?P<state>closed|open):(?P<fmt>glb|usdz)$")


def cache_key(version_id: uuid.UUID, state: str, fmt: str) -> str:
    return f"private/ar-cache/{version_id}/{CACHE_REV}-{state}.{fmt}"


def texture_loader(settings: Settings):
    """URL текстуры декора (`/static/textures/x.jpg`) → байты файла из TEXTURES_DIR (только имя файла)."""
    root = Path(settings.textures_dir)

    def load(url: str) -> bytes | None:
        name = Path(url.split("?", 1)[0]).name
        if not name or not name.lower().endswith((".jpg", ".jpeg", ".png")):
            return None
        try:
            return (root / name).read_bytes()
        except OSError:
            return None

    return load


def placement(version: ModelVersion) -> str:
    """Размещение из снимка 3D (viewer.placement); у старых версий без поля — собрать модель."""
    p = (version.viewer or {}).get("placement") if isinstance(version.viewer, dict) else None
    if p in ("floor", "wall"):
        return p
    try:
        return ar_placement(build(parse_tree(version.tree)))
    except Exception:  # noqa: BLE001 — непонятное дерево: по умолчанию «на пол»
        return "floor"


def _build(version: ModelVersion, state: str, fmt: str, settings: Settings) -> bytes:
    result = build(parse_tree(version.tree))
    if fmt == "usdz":
        return export_usdz(result, placement=placement(version), texture_loader=texture_loader(settings))
    return export_glb(result, opened=state == "open")


def _save(storage: Storage, key: str, data: bytes, fmt: str) -> None:
    """Запись в кэш: во временный ключ и перенос — параллельный запрос не прочтёт половину файла."""
    try:
        if hasattr(storage, "move"):
            tmp = f"{key}.{secrets.token_hex(4)}.tmp"
            storage.save(tmp, data, CONTENT_TYPES[fmt], private=True)
            storage.move(tmp, key)
        else:
            storage.save(key, data, CONTENT_TYPES[fmt], private=True)
    except (OSError, ValueError, NotImplementedError) as e:
        log.warning("AR cache write failed for %s: %s", key, e)


def get_file(storage: Storage, settings: Settings, version: ModelVersion, state: str, fmt: str) -> bytes:
    """Файл AR из кэша; нет в кэше — собрать и положить."""
    if fmt == "usdz" and state != "closed":
        raise ApiError(404, "not_found", "USDZ есть только в закрытом виде")
    key = cache_key(version.id, state, fmt)
    try:
        return storage.read(key)
    except (OSError, ValueError, NotImplementedError):
        pass
    data = _build(version, state, fmt, settings)
    _save(storage, key, data, fmt)
    return data


def signed_link(settings: Settings, version: ModelVersion, fmt: str) -> tuple[str, datetime]:
    """Абсолютная подписанная ссылка на файл AR «закрыто» и срок её жизни."""
    exp = utcnow() + LINK_TTL
    token = make_token(settings, {"key": f"ar:{version.id}:closed:{fmt}", "name": f"model.{fmt}",
                                  "content_type": CONTENT_TYPES[fmt]}, ttl=LINK_TTL)
    return f"{settings.public_api_url.rstrip('/')}/ar-files/{token}.{fmt}", exp


def read_link(settings: Settings, token: str, ext: str) -> tuple[uuid.UUID, str, str]:
    """Токен ссылки → (версия, состояние, формат). Чужой токен (вложения и т. п.) или не тот формат — 404."""
    payload = verify(settings, token)  # подделка — 404, истёк — 410 link_expired
    m = _TOKEN_KEY.match(payload.get("k") or "")
    if m is None or m["fmt"] != ext:
        raise ApiError(404, "not_found", "Файл не найден")
    return uuid.UUID(m["vid"]), m["state"], m["fmt"]
