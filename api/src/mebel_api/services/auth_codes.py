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

from sqlalchemy import func, select

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


def issue_code(db, settings: Settings, sender, phone: str, channel: Channel, purpose: str = LOGIN) -> dict:
    """Создаёт и отправляет код. Пауза между кодами — по назначению, часовой лимит — общий на номер."""
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

    code = "".join(secrets.choice("0123456789") for _ in range(settings.auth_code_length))
    channel = sender.send(phone, code, channel) or channel  # Telegram без шлюза уходит SMS
    db.add(
        AuthCode(
            phone=phone,
            code_hash=hash_code(settings, phone, code),
            channel=channel,
            purpose=purpose,
            expires_at=now + timedelta(seconds=settings.auth_code_ttl_seconds),
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


def check_code(db, settings: Settings, phone: str, code: str, purpose: str = LOGIN) -> None:
    """Проверяет последний неиспользованный код этого назначения и гасит его. Ошибка — ApiError."""
    if settings.env == "dev" and code == settings.dev_auth_code:
        return
    now = utcnow()
    entry = db.scalar(
        select(AuthCode)
        .where(AuthCode.phone == phone, AuthCode.purpose == purpose, AuthCode.consumed_at.is_(None))
        .order_by(AuthCode.created_at.desc())
        .limit(1)
    )
    if entry is None or entry.expires_at <= now:
        raise ApiError(400, "code_expired", "Код устарел или не запрашивался. Запросите новый код")
    if entry.attempts >= settings.auth_code_max_attempts:
        raise ApiError(429, "code_attempts", "Слишком много неверных попыток. Запросите новый код")
    if not secrets.compare_digest(entry.code_hash, hash_code(settings, phone, code)):
        entry.attempts += 1
        db.commit()
        left = settings.auth_code_max_attempts - entry.attempts
        raise ApiError(400, "code_invalid", f"Неверный код. Осталось попыток: {left}", {"attempts_left": left})
    entry.consumed_at = now
