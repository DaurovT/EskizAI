"""Сотрудники: роли и права, пароли (scrypt), 2FA (TOTP, RFC 6238), токены (JWT typ=staff).

Всё на стандартной библиотеке — без новых зависимостей. docs/staff_vendor_contract.md §1, §2, §4a.
"""

import base64
import hashlib
import hmac
import secrets
import struct
import time
import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import quote

import jwt

from ..config import Settings
from ..db import utcnow
from ..errors import ApiError

# --- Роли и права (одним словарём; §1) ---

PLATFORM_PERMISSIONS = [
    "workshops.view", "workshops.grant", "projects.view", "orders.manage", "nonstandard.manage",
    "catalog.manage", "price_requests.manage",
    # только суперадмин (§4a)
    "staff.manage", "suppliers.manage", "finance", "tariffs", "settings", "ai.log", "audit.view", "disputes",
    "security", "broadcasts", "impersonate",
]
VENDOR_DESIGNER = ["vendor.orders.work", "vendor.chat", "vendor.corrections", "vendor.returns", "vendor.nonstandard",
                   "vendor.quotes"]
VENDOR_OWNER = VENDOR_DESIGNER + ["vendor.finance", "vendor.analytics", "vendor.orders.all", "vendor.prices",
                                  "vendor.refunds.approve", "vendor.staff", "vendor.settings"]

ROLES: dict[str, dict[str, Any]] = {
    "superadmin": {"org": "platform", "permissions": ["*"], "title": "Суперадмин"},
    "orders_manager": {"org": "platform", "title": "Менеджер заказов",
                       "permissions": ["workshops.view", "projects.view", "orders.manage", "nonstandard.manage"]},
    "catalog_manager": {"org": "platform", "title": "Менеджер каталога",
                        "permissions": ["catalog.manage", "price_requests.manage", "projects.view"]},
    "support": {"org": "platform", "title": "Поддержка",
                "permissions": ["workshops.view", "workshops.grant", "projects.view"]},
    "vendor_owner": {"org": "supplier", "title": "Владелец", "permissions": VENDOR_OWNER},
    "vendor_designer": {"org": "supplier", "title": "Конструктор", "permissions": VENDOR_DESIGNER},
}
PLATFORM_ROLES = {r for r, v in ROLES.items() if v["org"] == "platform"}
VENDOR_ROLES = {r for r, v in ROLES.items() if v["org"] == "supplier"}
ROLE_RANK = {"superadmin": 100, "orders_manager": 10, "catalog_manager": 10, "support": 10, "vendor_owner": 50,
             "vendor_designer": 10}


def permissions_of(role: str) -> list[str]:
    """Для /staff/me: суперадмину — «*» и все ключи платформы (веб может проверять любой вариант)."""
    perms = ROLES.get(role, {}).get("permissions", [])
    if "*" in perms:
        return ["*", *PLATFORM_PERMISSIONS]
    return list(perms)


def has_permission(role: str, *keys: str) -> bool:
    perms = ROLES.get(role, {}).get("permissions", [])
    if "*" in perms:  # суперадмин — все права платформы; кабинет поставщика — только сотрудникам поставщика
        return not keys or any(not k.startswith("vendor.") for k in keys)
    return any(k in perms for k in keys)


# --- Пароли ---

MIN_PASSWORD = 10
MAX_PASSWORD = 200
_N, _R, _P, _DKLEN = 2 ** 14, 8, 1, 32


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f"scrypt${_N}${_R}${_P}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str | None) -> bool:
    try:
        algo, n, r, p, salt_b64, dk_b64 = (stored or "").split("$")
        if algo != "scrypt":
            raise ValueError
        salt, expected = base64.b64decode(salt_b64), base64.b64decode(dk_b64)
        dk = hashlib.scrypt(password.encode(), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except (ValueError, TypeError):
        # Неизвестная почта / битый хеш: считаем так же долго, чтобы время ответа не выдавало почту
        hashlib.scrypt(password.encode(), salt=b"0" * 16, n=_N, r=_R, p=_P, dklen=_DKLEN)
        return False
    return hmac.compare_digest(dk, expected)


def check_password_policy(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise ApiError(422, "password_too_short", f"Пароль — не короче {MIN_PASSWORD} символов")
    if len(password) > MAX_PASSWORD:
        raise ApiError(422, "password_too_long", "Слишком длинный пароль")
    if password.strip() != password or len(set(password)) < 4:
        raise ApiError(422, "password_weak", "Пароль слишком простой")


_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def temp_password(length: int = 14) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


# --- TOTP (RFC 6238: HMAC-SHA1, 30 с, 6 цифр) ---

TOTP_STEP = 30
TOTP_DIGITS = 6


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _hotp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 10 ** TOTP_DIGITS
    return str(code).zfill(TOTP_DIGITS)


def totp_now(secret: str, at: float | None = None) -> str:
    return _hotp(secret, int((at if at is not None else time.time()) // TOTP_STEP))


def verify_totp(secret: str, code: str, last_step: int | None, at: float | None = None) -> int | None:
    """Номер шага, если код верен (±1 шаг на рассинхрон часов) и ещё не использовался; иначе None."""
    code = (code or "").strip().replace(" ", "")
    if not code.isdigit() or len(code) != TOTP_DIGITS:
        return None
    now_step = int((at if at is not None else time.time()) // TOTP_STEP)
    for step in (now_step - 1, now_step, now_step + 1):
        if hmac.compare_digest(_hotp(secret, step), code):
            if last_step is not None and step <= last_step:
                return None  # повтор уже использованного кода
            return step
    return None


def otpauth_url(secret: str, email: str, issuer: str) -> str:
    label = quote(f"{issuer}:{email}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30"


def backup_code_hash(settings: Settings, code: str) -> str:
    norm = code.strip().replace("-", "").replace(" ", "").lower()
    return hmac.new(settings.jwt_secret.encode(), f"mfa-backup:{norm}".encode(), hashlib.sha256).hexdigest()


def new_backup_codes(n: int = 10) -> list[str]:
    out = []
    for _ in range(n):
        raw = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(10))
        out.append(f"{raw[:5]}-{raw[5:]}")
    return out


# --- Токены (тот же JWT_SECRET, свой typ: мастерский токен здесь не принимается и наоборот) ---

ACCESS_TYP = "staff"
REFRESH_TYP = "staff_refresh"
MFA_TYP = "staff_mfa"


def create_staff_access(settings: Settings, staff_id: uuid.UUID, session_id: uuid.UUID) -> str:
    now = utcnow()
    payload = {"sub": str(staff_id), "sid": str(session_id), "typ": ACCESS_TYP, "iat": int(now.timestamp()),
               "exp": int((now + timedelta(minutes=settings.staff_access_ttl_minutes)).timestamp())}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_staff_refresh(settings: Settings, staff_id: uuid.UUID, jti: uuid.UUID, expires_ts: int) -> str:
    payload = {"sub": str(staff_id), "jti": str(jti), "typ": REFRESH_TYP, "exp": expires_ts}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


MFA_TOKEN_TTL = timedelta(minutes=5)


def create_mfa_token(settings: Settings, staff_id: uuid.UUID, jti: uuid.UUID | None = None) -> str:
    """jti — id записи staff_mfa_challenges: токен одноразовый (routers/staff.py)."""
    now = utcnow()
    payload = {"sub": str(staff_id), "typ": MFA_TYP, "jti": (jti or uuid.uuid4()).hex, "iat": int(now.timestamp()),
               "exp": int((now + MFA_TOKEN_TTL).timestamp())}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_staff_token(settings: Settings, token: str, typ: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError:
        raise ApiError(401, "token_expired", "Сессия истекла — войдите заново")
    except jwt.PyJWTError:
        raise ApiError(401, "token_invalid", "Неверный токен — войдите заново")
    if payload.get("typ") != typ or "sub" not in payload:
        raise ApiError(401, "token_invalid", "Неверный тип токена")
    try:
        uuid.UUID(str(payload["sub"]))
    except ValueError:
        raise ApiError(401, "token_invalid", "Неверный токен — войдите заново")
    return payload


# --- Попытки входа: атомарные счётчики в БД (docs/staff_vendor_contract.md §8, «Вход и сессии») ---
#
# Счётчик меняется одним INSERT … ON CONFLICT DO UPDATE … RETURNING (SQLite ≥ 3.35 и Postgres): параллельные
# запросы не теряют приращения. Попытка «резервируется» ДО проверки пароля (scrypt) и кода: запросы сверх лимита
# отклоняются сразу, без проверки, поэтому пачка параллельных запросов проверяет не больше `limit` паролей.
# Удачная попытка снимает свой резерв. Работает при любом числе процессов API — состояние только в БД.


def guard_key(settings: Settings, kind: str, *parts: str | None) -> str:
    """Ключ счётчика: вид + HMAC (почта и IP в базе не хранятся)."""
    raw = "\x1f".join(p or "" for p in parts)
    digest = hmac.new(settings.jwt_secret.encode(), f"guard:{kind}:{raw}".encode(), hashlib.sha256).hexdigest()
    return f"{kind}:{digest[:40]}"[:64]


def email_fingerprint(settings: Settings, email: str) -> str:
    """Для журнала неудачных входов по неизвестной почте — вместо самой почты."""
    return hmac.new(settings.jwt_secret.encode(), f"log-email:{email}".encode(), hashlib.sha256).hexdigest()[:16]


def _upsert(db, table):
    name = db.get_bind().dialect.name
    if name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:  # pragma: no cover
        raise RuntimeError(f"UPSERT не поддержан для {name}")
    return insert(table)


def reserve_attempt(db, key: str, *, limit: int, lock_seconds: int, staff_id: uuid.UUID | None = None) -> int:
    """Блокировка «N неудач подряд → закрыто на lock_seconds». Возвращает номер попытки: > limit — закрыто
    (не проверять пароль/код). Попытка номер `limit` сразу ставит locked_until — если она удачна,
    clear_attempts снимает блокировку. Коммитит сразу: иначе параллельные запросы не увидят счётчик."""
    from sqlalchemy import and_, case, literal, null

    from ..db import UTCDateTime
    from ..models import AuthThrottle

    t = AuthThrottle.__table__
    now = utcnow()
    lock_at = literal(now + timedelta(seconds=lock_seconds), UTCDateTime())
    expired = and_(t.c.locked_until.is_not(None), t.c.locked_until <= now)
    active = and_(t.c.locked_until.is_not(None), t.c.locked_until > now)
    new_attempts = case((expired, 1), else_=t.c.attempts + 1)
    stmt = _upsert(db, t).values(
        key=key, staff_id=staff_id, attempts=1, window_start=now, updated_at=now,
        locked_until=now + timedelta(seconds=lock_seconds) if limit <= 1 else None,
    )
    stmt = stmt.on_conflict_do_update(index_elements=[t.c.key], set_={
        "attempts": new_attempts,
        "locked_until": case((active, t.c.locked_until), (new_attempts >= limit, lock_at), else_=null()),
        "window_start": case((expired, now), else_=t.c.window_start),
        "updated_at": now,
    }).returning(t.c.attempts)
    n = db.execute(stmt).scalar_one()
    db.commit()
    return n


def rate_hit(db, key: str, *, limit: int, window_seconds: int) -> int:
    """Ограничение частоты: попыток в окне window_seconds. Возвращает номер попытки в окне (> limit — отказ)."""
    from sqlalchemy import case

    from ..models import AuthThrottle

    t = AuthThrottle.__table__
    now = utcnow()
    stale = t.c.window_start <= now - timedelta(seconds=window_seconds)
    stmt = _upsert(db, t).values(key=key, attempts=1, window_start=now, updated_at=now)
    stmt = stmt.on_conflict_do_update(index_elements=[t.c.key], set_={
        "attempts": case((stale, 1), else_=t.c.attempts + 1),
        "window_start": case((stale, now), else_=t.c.window_start),
        "updated_at": now,
    }).returning(t.c.attempts)
    n = db.execute(stmt).scalar_one()
    db.commit()
    return n


def refund_attempt(db, key: str) -> None:
    """Удачная попытка не тратит лимит IP."""
    from sqlalchemy import update

    from ..models import AuthThrottle

    db.execute(update(AuthThrottle).where(AuthThrottle.key == key, AuthThrottle.attempts > 0)
               .values(attempts=AuthThrottle.attempts - 1).execution_options(synchronize_session=False))


def clear_attempts(db, key: str) -> None:
    from sqlalchemy import delete

    from ..models import AuthThrottle

    db.execute(delete(AuthThrottle).where(AuthThrottle.key == key).execution_options(synchronize_session=False))


def clear_staff_attempts(db, staff_id: uuid.UUID) -> None:
    """Сброс пароля снимает все блокировки сотрудника (с любых IP)."""
    from sqlalchemy import delete

    from ..models import AuthThrottle

    db.execute(delete(AuthThrottle).where(AuthThrottle.staff_id == staff_id)
               .execution_options(synchronize_session=False))


def staff_locked(db, staff_id: uuid.UUID) -> bool:
    """Вход сотрудника закрыт хотя бы с одного IP (для карточки в админке)."""
    from sqlalchemy import select

    from ..models import AuthThrottle

    return db.scalar(select(AuthThrottle.key).where(AuthThrottle.staff_id == staff_id,
                                                    AuthThrottle.locked_until > utcnow()).limit(1)) is not None


def prune_attempts(db, older_than: timedelta = timedelta(days=1)) -> None:
    from sqlalchemy import delete, or_

    from ..models import AuthThrottle

    now = utcnow()
    db.execute(delete(AuthThrottle).where(
        AuthThrottle.updated_at < now - older_than,
        or_(AuthThrottle.locked_until.is_(None), AuthThrottle.locked_until < now),
    ).execution_options(synchronize_session=False))
