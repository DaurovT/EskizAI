"""Отправка кода входа: dev (в лог), SMS через Eskiz, Telegram Gateway.

Eskiz подключён (notify.eskiz.uz). Telegram Gateway — заглушка: пока он не настроен,
код уходит SMS.
"""

import logging
import re
import secrets
import threading
from datetime import timedelta
from typing import Literal, Protocol

import httpx

from sqlalchemy import func, select, update

from ..config import Settings
from ..db import utcnow
from ..errors import ApiError
from ..models import AuthCode
from ..security import hash_code

log = logging.getLogger("mebel_api.auth")

Channel = Literal["sms", "telegram"]


class CodeSender(Protocol):
    name: str

    def send(self, phone: str, code: str, channel: Channel) -> Channel | None: ...


class DevCodeSender:
    """Пишет код в лог. В тестах коды можно прочитать из `sent`."""

    name = "dev"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def send(self, phone: str, code: str, channel: Channel) -> None:
        self.sent.append((phone, code))
        log.warning("Код входа для %s (%s): %s", phone, channel, code)


class EskizSmsSender:
    """SMS через Eskiz (notify.eskiz.uz).

    POST /api/auth/login (email, password) → токен (живёт ~30 дней), держим в памяти процесса;
    POST /api/message/sms/send (mobile_phone=998…, message, from=ESKIZ_SENDER).
    На 401 — один раз входим заново. Текст SMS (ESKIZ_TEMPLATE) должен совпадать с шаблоном,
    согласованным в кабинете Eskiz, иначе Eskiz отклонит отправку.
    """

    name = "eskiz"

    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None):
        self.settings = settings
        self._token: str | None = None
        self._lock = threading.Lock()
        self._client = httpx.Client(base_url=settings.eskiz_base_url, timeout=15.0, transport=transport)

    def _login(self) -> str:
        s = self.settings
        if not (s.eskiz_email and s.eskiz_password):
            raise ApiError(503, "sms_unavailable", "SMS не настроены: нет учётных данных Eskiz")
        r = self._client.post("/api/auth/login", data={"email": s.eskiz_email, "password": s.eskiz_password})
        token = (r.json().get("data") or {}).get("token") if r.status_code == 200 else None
        if not token:
            log.error("Eskiz: вход не удался (%s): %s", r.status_code, r.text[:300])
            raise ApiError(503, "sms_unavailable", "Не удалось отправить SMS. Попробуйте чуть позже")
        return token

    def _post_sms(self, token: str, phone: str, text: str) -> httpx.Response:
        return self._client.post(
            "/api/message/sms/send",
            headers={"Authorization": f"Bearer {token}"},
            data={"mobile_phone": phone.lstrip("+"), "message": text, "from": self.settings.eskiz_sender},
        )

    def send(self, phone: str, code: str, channel: Channel) -> Channel:
        tpl = self.settings.eskiz_template or Settings.model_fields["eskiz_template"].default
        text = tpl.format(code=code)
        try:
            with self._lock:
                if self._token is None:
                    self._token = self._login()
                token = self._token
            r = self._post_sms(token, phone, text)
            if r.status_code == 401:  # токен истёк — входим заново один раз
                with self._lock:
                    self._token = self._login()
                    token = self._token
                r = self._post_sms(token, phone, text)
        except httpx.HTTPError as e:
            log.error("Eskiz: сеть: %s", e)
            raise ApiError(503, "sms_unavailable", "Не удалось отправить SMS. Попробуйте чуть позже") from e
        if r.status_code >= 300:
            log.error("Eskiz: отправка не удалась (%s): %s", r.status_code, r.text[:300])
            raise ApiError(503, "sms_unavailable", "Не удалось отправить SMS. Попробуйте чуть позже")
        return "sms"


class TelegramGatewaySender:
    """Telegram Gateway (gatewayapi.telegram.org) — заглушка.

    План: POST /sendVerificationMessage с phone_number и code (наш код),
    заголовок Authorization: Bearer TELEGRAM_GATEWAY_TOKEN; при ошибке
    «нет Telegram» — предложить SMS.
    """

    name = "telegram"

    def __init__(self, settings: Settings):
        self.settings = settings

    def send(self, phone: str, code: str, channel: Channel) -> None:
        raise ApiError(503, "telegram_unavailable", "Отправка кода в Telegram пока не подключена. Попробуйте SMS")


class RoutingSender:
    """Выбирает отправителя по каналу. В dev всё уходит в лог."""

    def __init__(self, settings: Settings, dev: DevCodeSender | None = None):
        self.settings = settings
        self.dev = dev or DevCodeSender()
        self.sms = EskizSmsSender(settings)
        self.telegram = TelegramGatewaySender(settings)
        self.name = settings.auth_code_provider

    def send(self, phone: str, code: str, channel: Channel) -> Channel:
        """Отправляет код; возвращает канал, которым он реально ушёл."""
        if self.settings.auth_code_provider == "dev":
            self.dev.send(phone, code, channel)
            return channel
        # Telegram Gateway ещё не подключён — без токена код уходит SMS
        if channel == "telegram" and self.settings.telegram_gateway_token:
            self.telegram.send(phone, code, channel)
            return "telegram"
        return self.sms.send(phone, code, "sms")


_DIGITS = re.compile(r"\D+")


def normalize_phone(raw: str) -> str:
    """Номер в формате +998XXXXXXXXX. Девять цифр без кода страны — тоже Узбекистан."""
    digits = _DIGITS.sub("", raw or "")
    if len(digits) == 9:
        digits = "998" + digits
    if not (digits.startswith("998") and len(digits) == 12):
        raise ApiError(422, "invalid_phone", "Введите номер телефона Узбекистана: +998 XX XXX XX XX")
    return "+" + digits


# --- выдача и проверка кода (вход и удаление аккаунта — разные назначения) ---

LOGIN = "login"
DELETE_ACCOUNT = "delete_account"


def account_exists(db, phone: str) -> bool:
    """У номера есть действующий аккаунт мастера — ему достаётся запас общего лимита SMS."""
    from ..models import User

    return db.scalar(select(User.id).where(User.phone == phone, User.is_active.is_(True),
                                           User.deleted_at.is_(None)).limit(1)) is not None


def phone_block(phone: str) -> str:
    """Блок из 10 000 номеров: +99890123xxxx → +99890123 (накрутка идёт подряд идущими номерами)."""
    return phone[:-4]


def failures_today(db, phone: str) -> int:
    """Неверные коды номера за 24 часа: попытки по всем кодам минус удачные (удачная — тоже попытка)."""
    since = utcnow() - timedelta(days=1)
    attempts, consumed = db.execute(
        select(func.coalesce(func.sum(AuthCode.attempts), 0), func.count(AuthCode.consumed_at))
        .where(AuthCode.phone == phone, AuthCode.created_at > since)
    ).one()
    return int(attempts or 0) - int(consumed or 0)


def ensure_not_locked(db, settings: Settings, phone: str) -> None:
    limit = settings.auth_code_max_failures_per_day
    if limit and failures_today(db, phone) >= limit:
        log.warning("Вход по номеру %s закрыт: %s неверных кодов за сутки", phone, limit)
        raise ApiError(429, "code_locked", "Слишком много неверных кодов. Вход по этому номеру закрыт на сутки")


def _new_numbers_codes(db, since, *conds) -> int:
    """Коды на номера без аккаунта (по ним идёт накрутка; вход существующих мастеров не считается)."""
    from ..models import User

    return db.scalar(select(func.count(AuthCode.id)).where(
        AuthCode.created_at > since, AuthCode.phone.not_in(select(User.phone)), *conds)) or 0


def ensure_new_number_limits(db, settings: Settings, phone: str, ip: str | None) -> None:
    """Лимиты на IP и на блок номеров — для номеров без аккаунта (§8, защита от SMS-накрутки)."""
    from .spend_limits import cap_hit

    now = utcnow()
    checks = []
    if ip:
        checks += [(AuthCode.ip == ip, timedelta(minutes=10), settings.auth_code_ip_per_10min, "ip_10min"),
                   (AuthCode.ip == ip, timedelta(days=1), settings.auth_code_ip_per_day, "ip_day")]
    block = phone_block(phone)
    checks += [(AuthCode.phone.like(block + "%"), timedelta(hours=1), settings.auth_code_prefix_per_hour, "block_hour"),
               (AuthCode.phone.like(block + "%"), timedelta(days=1), settings.auth_code_prefix_per_day, "block_day")]
    for cond, window, limit, name in checks:
        if limit and _new_numbers_codes(db, now - window, cond) >= limit:
            who = ip if name.startswith("ip") else block
            cap_hit(db, f"sms_{name}:{who}", {"phone": phone, "ip": ip, "limit": limit})
            raise ApiError(429, "code_limit", "Слишком много запросов кода. Попробуйте позже")


def issue_code(db, settings: Settings, sender, phone: str, channel: Channel, purpose: str = LOGIN,
               ip: str | None = None, existing: bool | None = None) -> dict:
    """Создаёт и отправляет код. Пауза между кодами — по назначению, часовой лимит — общий на номер.
    Номер без аккаунта (existing=False) — ещё лимиты на IP и блок номеров и только доля общего лимита SMS."""
    now = utcnow()
    last = db.scalar(
        select(AuthCode).where(AuthCode.phone == phone, AuthCode.purpose == purpose)
        .order_by(AuthCode.created_at.desc()).limit(1)
    )
    if last is not None:
        wait = settings.auth_code_resend_seconds - int((now - last.created_at).total_seconds())
        if wait > 0:
            raise ApiError(429, "code_too_often", f"Новый код можно запросить через {wait} с", {"resend_in": wait})
    hour_count = db.scalar(
        select(func.count(AuthCode.id)).where(AuthCode.phone == phone, AuthCode.created_at > now - timedelta(hours=1))
    )
    if (hour_count or 0) >= settings.auth_code_max_per_hour:
        raise ApiError(429, "code_limit", "Слишком много запросов кода. Попробуйте через час")
    ensure_not_locked(db, settings, phone)
    if existing is None:
        existing = account_exists(db, phone)
    if not existing:
        ensure_new_number_limits(db, settings, phone, ip)
    from .spend_limits import ensure_sms_allowed

    ensure_sms_allowed(db, settings, existing=existing)  # общий лимит SMS в час и в сутки (§4a)

    code = "".join(secrets.choice("0123456789") for _ in range(settings.auth_code_length))
    channel = sender.send(phone, code, channel) or channel  # Telegram без шлюза уходит SMS
    db.add(
        AuthCode(
            phone=phone,
            code_hash=hash_code(settings, phone, code),
            channel=channel,
            purpose=purpose,
            expires_at=now + timedelta(seconds=settings.auth_code_ttl_seconds),
            ip=(ip or None) and ip[:45],
        )
    )
    db.commit()
    return {
        "phone": phone,
        "channel": channel,
        "expires_in": settings.auth_code_ttl_seconds,
        "resend_in": settings.auth_code_resend_seconds,
        "code_length": settings.auth_code_length,
    }


def dev_code_accepted(settings: Settings, code: str) -> bool:
    """Код разработчика — только в локальной разработке: ENV=dev и коды в лог (AUTH_CODE_PROVIDER=dev)."""
    return settings.env == "dev" and settings.auth_code_provider == "dev" and secrets.compare_digest(
        code.encode(), settings.dev_auth_code.encode())


def check_code(db, settings: Settings, phone: str, code: str, purpose: str = LOGIN) -> None:
    """Проверяет последний неиспользованный код этого назначения и гасит его. Ошибка — ApiError.

    Попытка списывается атомарно до сравнения (UPDATE … WHERE attempts < max): параллельные догадки
    не обходят лимит. Списанная попытка коммитится сразу — даже если запрос дальше упадёт."""
    if dev_code_accepted(settings, code):
        return
    now = utcnow()
    ensure_not_locked(db, settings, phone)
    entry = db.scalar(
        select(AuthCode)
        .where(AuthCode.phone == phone, AuthCode.purpose == purpose, AuthCode.consumed_at.is_(None))
        .order_by(AuthCode.created_at.desc())
        .limit(1)
    )
    if entry is None or entry.expires_at <= now:
        raise ApiError(400, "code_expired", "Код устарел или не запрашивался. Запросите новый код")
    took = db.execute(
        update(AuthCode)
        .where(AuthCode.id == entry.id, AuthCode.consumed_at.is_(None),
               AuthCode.attempts < settings.auth_code_max_attempts)
        .values(attempts=AuthCode.attempts + 1)
        .execution_options(synchronize_session=False)
    ).rowcount
    db.commit()
    if took != 1:
        if db.scalar(select(AuthCode.consumed_at).where(AuthCode.id == entry.id)) is not None:
            raise ApiError(400, "code_expired", "Код устарел или не запрашивался. Запросите новый код")
        raise ApiError(429, "code_attempts", "Слишком много неверных попыток. Запросите новый код")
    if not secrets.compare_digest(entry.code_hash, hash_code(settings, phone, code)):
        used = db.scalar(select(AuthCode.attempts).where(AuthCode.id == entry.id)) or 0
        left = max(0, settings.auth_code_max_attempts - used)
        raise ApiError(400, "code_invalid", f"Неверный код. Осталось попыток: {left}", {"attempts_left": left})
    consumed = db.execute(
        update(AuthCode).where(AuthCode.id == entry.id, AuthCode.consumed_at.is_(None))
        .values(consumed_at=now).execution_options(synchronize_session=False)
    ).rowcount
    if consumed != 1:  # тот же код уже использован параллельным запросом
        raise ApiError(400, "code_expired", "Код устарел или не запрашивался. Запросите новый код")
    entry.consumed_at = now
