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
    dev_auth_code: str = "00000"  # принимается только при ENV=dev
    eskiz_email: str = ""
    eskiz_password: str = ""
    eskiz_sender: str = "4546"
    telegram_gateway_token: str = ""

    # Админка (временно — общий токен до ролей админки)
    admin_token: str = "dev-admin-token"

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
            if self.admin_token == "dev-admin-token":
                raise ValueError("В prod задайте ADMIN_TOKEN")
            if self.auth_code_provider == "dev":
                raise ValueError("В prod нельзя использовать AUTH_CODE_PROVIDER=dev")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
