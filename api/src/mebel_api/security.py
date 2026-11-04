"""JWT: короткий access-токен и refresh-токен с ротацией (хранится jti)."""

import hashlib
import hmac
import uuid
from datetime import timedelta
from typing import Any

import jwt

from .config import Settings
from .db import utcnow
from .errors import ApiError


def hash_code(settings: Settings, phone: str, code: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), f"{phone}:{code}".encode(), hashlib.sha256).hexdigest()


def create_access_token(settings: Settings, user_id: uuid.UUID, workshop_id: uuid.UUID, role: str) -> str:
    now = utcnow()
    payload = {
        "sub": str(user_id),
        "wid": str(workshop_id),
        "role": role,
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_ttl_minutes)).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_refresh_token(settings: Settings, user_id: uuid.UUID, jti: uuid.UUID, expires_ts: int) -> str:
    payload = {"sub": str(user_id), "jti": str(jti), "typ": "refresh", "exp": expires_ts}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(settings: Settings, token: str, typ: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError:
        raise ApiError(401, "token_expired", "Сессия истекла — войдите заново")
    except jwt.PyJWTError:
        raise ApiError(401, "token_invalid", "Неверный токен — войдите заново")
    if payload.get("typ") != typ:
        raise ApiError(401, "token_invalid", "Неверный тип токена")
    return payload
