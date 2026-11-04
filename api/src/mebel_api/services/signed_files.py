"""Подписанные ссылки на закрытые файлы (вложения переписки, фото возвратов и споров, файлы исправлений).

Ссылка открывается без токена входа (картинка в приложении, скачивание в браузере), но живёт недолго (2 часа).
Токен непрозрачный: ключ файла в хранилище, имя, тип и срок зашифрованы и подписаны ключом из JWT_SECRET
(свои подключи для шифрования и подписи; без JWT_SECRET ни прочитать, ни подделать). Как токен входа не годится.

Схема (только стандартная библиотека): v1 = 0x01 ‖ nonce(16) ‖ шифртекст ‖ тег(16);
поток ключа — SHAKE-256(k_enc ‖ nonce), тег — HMAC-SHA256(k_mac, 0x01 ‖ nonce ‖ шифртекст), усечённый до 16 байт
(encrypt-then-MAC). Сравнение тега — постоянное по времени.
"""

import base64
import hashlib
import hmac
import json
import secrets
from datetime import timedelta
from typing import Any

from ..config import Settings
from ..db import utcnow
from ..errors import ApiError

VERSION = b"\x01"
TTL = timedelta(hours=2)
_NONCE, _TAG = 16, 16


def _keys(settings: Settings) -> tuple[bytes, bytes]:
    secret = settings.jwt_secret.encode()
    return (hmac.new(secret, b"eskiz/signed-files/enc/v1", hashlib.sha256).digest(),
            hmac.new(secret, b"eskiz/signed-files/mac/v1", hashlib.sha256).digest())


def _xor(data: bytes, k_enc: bytes, nonce: bytes) -> bytes:
    stream = hashlib.shake_256(k_enc + nonce).digest(len(data))
    return bytes(a ^ b for a, b in zip(data, stream))


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_token(settings: Settings, f: dict[str, Any], ttl: timedelta = TTL) -> str:
    k_enc, k_mac = _keys(settings)
    payload = json.dumps({"k": f["key"], "n": (f.get("name") or "file")[:200],
                          "ct": (f.get("content_type") or "application/octet-stream")[:100],
                          "exp": int((utcnow() + ttl).timestamp())}, ensure_ascii=False,
                         separators=(",", ":")).encode()
    nonce = secrets.token_bytes(_NONCE)
    body = VERSION + nonce + _xor(payload, k_enc, nonce)
    return _b64(body + hmac.new(k_mac, body, hashlib.sha256).digest()[:_TAG])


def signed_url(settings: Settings, f: dict[str, Any], ttl: timedelta = TTL) -> str:
    return f"/signed-files/{make_token(settings, f, ttl)}"


def attachment_out(settings: Settings, f: dict[str, Any]) -> dict[str, Any]:
    """Attachment = {key, url, name?, content_type?, size?} (docs/staff_vendor_contract.md §9).
    `key` — id файла (не ключ хранилища)."""
    return {"key": f["id"], "url": signed_url(settings, f), "name": f.get("name"),
            "content_type": f.get("content_type"), "size": f.get("size")}


def verify(settings: Settings, token: str) -> dict[str, Any]:
    """Расшифровать и проверить: подделка или мусор — 404, истёк срок — 410 link_expired."""
    gone = ApiError(404, "not_found", "Файл не найден")
    if len(token) > 4096:
        raise gone
    try:
        raw = _unb64(token)
    except (ValueError, TypeError):
        raise gone from None
    if len(raw) < 1 + _NONCE + _TAG + 2 or raw[:1] != VERSION:
        raise gone
    k_enc, k_mac = _keys(settings)
    body, tag = raw[:-_TAG], raw[-_TAG:]
    if not hmac.compare_digest(hmac.new(k_mac, body, hashlib.sha256).digest()[:_TAG], tag):
        raise gone
    nonce = body[1:1 + _NONCE]
    try:
        payload = json.loads(_xor(body[1 + _NONCE:], k_enc, nonce))
    except ValueError:
        raise gone from None
    if not isinstance(payload, dict) or not isinstance(payload.get("k"), str) \
            or not isinstance(payload.get("exp"), int):
        raise gone
    if payload["exp"] < int(utcnow().timestamp()):
        raise ApiError(410, "link_expired", "Ссылка устарела — откройте файл заново")
    return payload
