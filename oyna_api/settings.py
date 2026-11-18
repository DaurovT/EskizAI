"""Настройки сервера из переменных окружения (как в Eskiz Temir, но без pydantic-settings)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

DEV_JWT_SECRET = "dev-only-oyna-secret-change-me-0123456789"


@dataclass(frozen=True)
class Settings:
    env: str = "dev"                                  # dev | prod
    dsn: str | None = None
    jwt_secret: str = DEV_JWT_SECRET
    access_ttl_min: int = 30
    refresh_ttl_days: int = 30
    code_provider: str = "dev"                        # dev (код в лог) | eskiz (SMS)
    code_length: int = 5
    code_ttl_s: int = 300
    code_max_attempts: int = 5
    code_resend_s: int = 60
    code_max_per_hour: int = 5
    dev_code: str = "00000"                           # принимается только при env=dev и provider=dev
    eskiz_email: str = ""
    eskiz_password: str = ""
    eskiz_sender: str = "4546"
    eskiz_base_url: str = "https://notify.eskiz.uz"
    eskiz_template: str = "IQLabs Confirmation code: {code}"   # должен совпадать с шаблоном в кабинете Eskiz
    admin_token: str = "dev-admin-token"              # администратор каталога (S14, разметка ролей)
    public_base_url: str = "https://oyna.eskizai.uz"  # для ссылок на КП

    @property
    def dev_headers(self) -> bool:
        """X-Company / X-Role без входа — только в разработке (фронтенд на заглушках)."""
        return self.env != "prod"

    def check(self) -> None:
        if self.env == "prod":
            if self.jwt_secret == DEV_JWT_SECRET or len(self.jwt_secret) < 32:
                raise RuntimeError("OYNA_JWT_SECRET: в prod нужен свой секрет ≥ 32 символов")
            if self.code_provider == "dev":
                raise RuntimeError("OYNA_CODE_PROVIDER=dev в prod запрещён")
            if self.admin_token == "dev-admin-token":
                raise RuntimeError("OYNA_ADMIN_TOKEN: задайте в prod")


@lru_cache
def settings() -> Settings:
    e = os.environ.get
    s = Settings(env=e("OYNA_ENV", "dev"), dsn=e("OYNA_DSN"), jwt_secret=e("OYNA_JWT_SECRET", DEV_JWT_SECRET),
                 code_provider=e("OYNA_CODE_PROVIDER", "dev"), eskiz_email=e("ESKIZ_EMAIL", ""),
                 eskiz_password=e("ESKIZ_PASSWORD", ""), eskiz_sender=e("ESKIZ_SENDER", "4546"),
                 eskiz_template=e("ESKIZ_TEMPLATE", Settings.eskiz_template),
                 admin_token=e("OYNA_ADMIN_TOKEN", "dev-admin-token"),
                 public_base_url=e("OYNA_PUBLIC_URL", Settings.public_base_url))
    s.check()
    return s
