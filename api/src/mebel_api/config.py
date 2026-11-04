"""Настройки из переменных окружения (см. .env.example)."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_JWT_SECRET = "dev-secret-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    database_url: str = "sqlite:///./dev.db"
    redis_url: str = "redis://localhost:6379/0"  # для будущей очереди задач

    # Вход
    jwt_secret: str = DEV_JWT_SECRET
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 30
    refresh_token_ttl_days: int = 30
    auth_code_provider: Literal["dev", "eskiz", "telegram"] = "dev"
    auth_code_length: int = 5
    auth_code_ttl_seconds: int = 300
    auth_code_max_attempts: int = 5
    auth_code_resend_seconds: int = 60
    auth_code_max_per_hour: int = 5
    dev_auth_code: str = "00000"  # принимается только при ENV=dev и AUTH_CODE_PROVIDER=dev
    # Защита от SMS-накрутки (§8): лимиты на IP и на блок из 10 000 номеров (+99890123xxxx) — только для
    # номеров без аккаунта; 0 — без лимита. Новые номера тратят не больше доли общего лимита SMS
    # (sms_per_hour / sms_per_day в админке), остальное — запас для входа существующих мастеров
    auth_code_ip_per_10min: int = 10  # мобильные операторы выводят многих абонентов через один IP (CGNAT)
    auth_code_ip_per_day: int = 60
    auth_code_prefix_per_hour: int = 10
    auth_code_prefix_per_day: int = 30
    auth_code_max_failures_per_day: int = 15  # неверных кодов на номер за 24 ч → вход по номеру закрыт
    sms_new_numbers_share: float = 0.7
    eskiz_email: str = ""
    eskiz_password: str = ""
    eskiz_sender: str = "4546"
    eskiz_base_url: str = "https://notify.eskiz.uz"
    # Текст SMS: должен совпадать с шаблоном, согласованным в кабинете Eskiz; {code} — код входа
    eskiz_template: str = "IQLabs Confirmation code: {code}"
    telegram_gateway_token: str = ""

    # Админка: старый общий токен X-Admin-Token (переходный период); false — отключён. Работает как суперадмин
    # только для чтения и повседневных дел: сотрудники, настройки, лимиты, поставщики, деньги, «глазами мастера» —
    # только под учётной записью с 2FA (deps.require_staff, legacy). В prod — не короче 32 символов.
    admin_token: str = "dev-admin-token"
    admin_token_enabled: bool = True

    # Сотрудники платформы и поставщиков (docs/staff_vendor_contract.md): вход по почте и паролю
    staff_access_ttl_minutes: int = 30
    staff_refresh_ttl_days: int = 14
    staff_max_failed_logins: int = 5
    staff_lockout_minutes: int = 15  # блокировка — по паре «почта + IP» (чужой IP не закрывает вход владельцу)
    # Ограничение частоты неудачных попыток с одного IP (/staff/auth/login и /staff/auth/mfa — отдельно)
    staff_login_ip_limit: int = 20
    staff_login_ip_window_minutes: int = 10
    # Повтор уже ротированного refresh завершает всю сессию; в эти секунды после ротации — просто 401
    # (две вкладки обновили токен одновременно)
    staff_refresh_reuse_grace_seconds: int = 5
    staff_mfa_issuer: str = "Eskiz AI"
    impersonation_ttl_minutes: int = 15  # «глазами мастера» — короткий токен только на чтение
    # Источник цен поставщика: фоновая проверка расписания в процессе API (иначе — scripts/run_price_sources.py)
    price_source_scheduler: bool = False
    price_source_max_bytes: int = 10 * 1024 * 1024
    price_source_timeout_seconds: float = 20.0

    # Хранилище файлов
    storage_backend: Literal["local", "s3"] = "local"
    media_dir: Path = Path("./media")
    media_base_url: str = "/media"
    # Текстуры декоров EMAN (api/scripts/build_eman_decors.py кладёт сюда JPEG); в git не входят
    textures_dir: Path = Path(__file__).resolve().parents[2] / "static" / "textures"
    textures_base_url: str = "/static/textures"
    s3_endpoint_url: str = ""
    s3_bucket: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_public_base_url: str = ""
    max_photo_bytes: int = 10 * 1024 * 1024
    max_photos_per_kind: int = 5

    # Лимиты и ссылки
    free_projects_per_month: int = 3
    limit_timezone: str = "Asia/Tashkent"
    share_base_url: str = "http://localhost:3000/p"  # страница клиента в web: /p/{token}
    public_api_url: str = "http://localhost:8000"  # публичный адрес API — для ссылок на GLB (Scene Viewer качает сам)
    share_default_days: int = 30

    cors_origins: list[str] = ["http://localhost:3000"]

    # Очередь задач: thread — фоновый поток (запрос сразу возвращает task_id), inline — сразу (тесты)
    task_queue_mode: Literal["thread", "inline"] = "thread"

    # ИИ (раздел 6 PRD). Без ключа ИИ-эндпоинты отвечают 503. Бюджет — значения по умолчанию,
    # админка может их переопределить (app_settings: ai_budget_usd, ai_warn_ratio)
    anthropic_api_key: str = ""
    ai_budget_usd: float = 0.30
    ai_warn_ratio: float = 0.8
    ai_photo_limit: int = 5
    # Лимиты ИИ на цех (§8; общий и дневной на цех — в админке, /admin/limits). «Новый» цех — без оплат
    # платформе, без Pro и без оплаченных заказов. Дневной лимит цеха — не больше ai_workshop_max_share
    # от общего; при расходе ai_daily_usd_global × (1 − ai_paying_reserve_share) ИИ закрывается новым цехам,
    # остаток — запас платящим. Перед постановкой задачи резервируется ai_task_reserve_usd
    ai_new_workshop_daily_usd: float = 1.0
    ai_workshop_hourly_usd: float = 2.0
    ai_new_workshop_hourly_usd: float = 0.5
    ai_workshop_max_share: float = 0.2
    ai_paying_reserve_share: float = 0.3
    ai_task_reserve_usd: float = 0.05
    # Пример («Попробовать на примере»): создаёт только сервер (POST /projects/example); бюджет ИИ — общий
    # на все примеры цеха; примеров за всё время — не больше
    ai_example_budget_usd: float = 0.10
    example_projects_max: int = 3

    # Push (раздел 19): log — только лог (dev, тесты), expo — Expo Push API. Отправка после коммита:
    # в фоне (thread) или сразу (inline — как очередь задач в тестах)
    push_provider: Literal["log", "expo"] = "log"
    expo_access_token: str = ""
    # «Мастер вышел»: приложение не опрашивало задачу дольше стольких секунд — модель готова → push
    push_presence_seconds: int = 10

    @model_validator(mode="after")
    def _prod_requires_secrets(self) -> "Settings":
        if self.env == "prod":
            if self.jwt_secret == DEV_JWT_SECRET or len(self.jwt_secret) < 32:
                raise ValueError("В prod задайте JWT_SECRET длиной не меньше 32 символов")
            if self.admin_token_enabled and (self.admin_token == "dev-admin-token" or len(self.admin_token) < 32):
                raise ValueError("В prod задайте ADMIN_TOKEN длиной не меньше 32 символов или ADMIN_TOKEN_ENABLED=false")
            if self.auth_code_provider == "dev":
                raise ValueError("В prod нельзя использовать AUTH_CODE_PROVIDER=dev")
        if self.env == "dev" and not is_local_url(self.public_api_url):
            # ENV=dev принимает код 00000 — на публичном адресе это открытый вход в любой аккаунт
            raise ValueError("ENV=dev — только для локальной разработки: PUBLIC_API_URL указывает на публичный "
                             "адрес. На сервере задайте ENV=prod")
        return self


def is_local_url(url: str) -> bool:
    """localhost, адреса локальной сети, *.local / *.lan / *.localhost и имена без точки (dev-машина, контейнер)."""
    import ipaddress
    from urllib.parse import urlsplit

    host = (urlsplit(url).hostname or "").rstrip(".").lower()
    if not host:
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return "." not in host or host.endswith((".local", ".lan", ".localhost", ".internal", ".home.arpa"))
    return ip.is_private or ip.is_loopback or ip.is_link_local


@lru_cache
def get_settings() -> Settings:
    return Settings()
