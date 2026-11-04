"""Настройки, которые админка меняет без перезапуска (ADM-12). Значения по умолчанию — из Settings."""

import re
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..config import Settings
from ..models import AppSetting

def _bool(v: Any) -> bool:
    if isinstance(v, str):
        if v.strip().lower() in ("1", "true", "yes", "on", "да"):
            return True
        if v.strip().lower() in ("", "0", "false", "no", "off", "нет"):
            return False
        raise ValueError(v)
    return bool(v)


def _str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        raise ValueError(v)
    return str(v).strip()


# ключ → (тип, описание)
KNOWN: dict[str, tuple[Any, str]] = {
    "ai_budget_usd": (float, "Бюджет ИИ на проект, $"),
    "ai_warn_ratio": (float, "Порог предупреждения о бюджете ИИ (доля, 0–1)"),
    "free_projects_per_month": (int, "Бесплатных проектов в месяц (пока только для показа; лимит берётся из env)"),
    # Тарифы (раздел 9): файлы проекта без заказа в EMAN и скидка Pro на них
    "files_price": (int, "Файлы проекта без заказа в EMAN, сум"),
    "files_pro_discount_pct": (int, "Скидка Pro на файлы без заказа, %"),
    # Версия приложения и техработы (SCR-45)
    "app_min_version": (_str, "Минимальная версия приложения (ниже — «Обновите приложение»)"),
    "app_latest_version": (_str, "Последняя версия приложения (ниже — «Вышла новая версия»)"),
    "app_store_url_ios": (_str, "Ссылка в App Store"),
    "app_store_url_android": (_str, "Ссылка в Google Play"),
    "app_release_notes_ru": (_str, "Что нового (по-русски, пункт на строку)"),
    "app_release_notes_uz": (_str, "Что нового (по-узбекски, пункт на строку)"),
    "maintenance_on": (_bool, "Техработы: создание и правка проектов недоступны"),
    "maintenance_until": (_str, "Техработы до (ISO, например 2026-11-03T14:00:00+05:00)"),
    "maintenance_message_ru": (_str, "Текст о техработах (по-русски, необязательно)"),
    "maintenance_message_uz": (_str, "Текст о техработах (по-узбекски, необязательно)"),
}


def defaults(settings: Settings) -> dict[str, Any]:
    return {
        "ai_budget_usd": settings.ai_budget_usd,
        "ai_warn_ratio": settings.ai_warn_ratio,
        "free_projects_per_month": settings.free_projects_per_month,
        "files_price": 45_000,
        "files_pro_discount_pct": 50,
        "app_min_version": "0.0.0",
        "app_latest_version": "0.0.0",
        "app_store_url_ios": "https://apps.apple.com/app/id0000000000",
        "app_store_url_android": "https://play.google.com/store/apps/details?id=uz.mebel.master",
        "app_release_notes_ru": "",
        "app_release_notes_uz": "",
        "maintenance_on": False,
        "maintenance_until": "",
        "maintenance_message_ru": "",
        "maintenance_message_uz": "",
    }


_VERSION = re.compile(r"^\d+(\.\d+){0,2}$")


def coerce(key: str, value: Any) -> Any:
    """Приводит и проверяет значение из админки. Ошибка — ValueError с текстом для менеджера."""
    try:
        value = KNOWN[key][0](value)
    except (TypeError, ValueError):
        raise ValueError(f"Неверное значение для {key}") from None
    if key == "ai_warn_ratio" and not 0 < value < 1:
        raise ValueError("Порог предупреждения — от 0 до 1")
    if key == "files_price" and value < 0:
        raise ValueError("Цена файлов не может быть отрицательной")
    if key == "files_pro_discount_pct" and not 0 <= value <= 100:
        raise ValueError("Скидка Pro — от 0 до 100 %")
    if key == "ai_budget_usd" and value <= 0:
        raise ValueError("Бюджет ИИ должен быть больше нуля")
    if key in ("app_min_version", "app_latest_version") and not _VERSION.match(value):
        raise ValueError("Версия — в виде 1.2.3")
    if key == "maintenance_until" and value:
        try:
            dt = datetime.fromisoformat(value)
        except ValueError:
            raise ValueError("Время окончания техработ — в виде 2026-11-03T14:00:00+05:00") from None
        if dt.tzinfo is None:
            raise ValueError("Укажите часовой пояс, например +05:00 (Ташкент)")
    return value


def all_settings(db: Session, settings: Settings) -> dict[str, Any]:
    values = defaults(settings)
    for row in db.query(AppSetting).all():
        if row.key in KNOWN:
            values[row.key] = row.value
    return values


def get_setting(db: Session, settings: Settings, key: str) -> Any:
    row = db.get(AppSetting, key)
    return row.value if row is not None else defaults(settings)[key]


def set_setting(db: Session, key: str, value: Any) -> None:
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
