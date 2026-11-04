"""Обязательное обновление и техработы (SCR-45). Значения — из настроек админки (app_settings)."""

import re
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..config import Settings
from ..errors import _body
from .app_settings import all_settings

MAINTENANCE_CODE = "maintenance"
MAINTENANCE_MESSAGE = "Идут технические работы. Создание и правка проектов и заказов временно недоступны"
# Во время техработ запрещены изменения проектов (создание, правка модели, ИИ, замеры, заказы, ссылки)
# и заказов (переписка, повторная отправка, возвраты, споры, решения по исправлениям, отмена).
# Чтение, вход, push, админка, отметка «прочитано» и публичная страница клиента (/share) работают.
BLOCKED_PREFIXES = ("/projects", "/orders", "/ai")
ALLOWED_SUFFIXES = ("/messages/read",)  # отметка «прочитано» — не изменение заказа
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def parse_version(v: str | None) -> tuple[int, ...]:
    nums = [int(x) for x in re.findall(r"\d+", v or "")[:3]]
    return tuple(nums + [0] * (3 - len(nums)))


def _lines(text: str) -> list[str]:
    return [x.strip(" •-\t") for x in (text or "").splitlines() if x.strip(" •-\t")]


def maintenance_state(values: dict[str, Any]) -> dict[str, Any]:
    return {
        "on": bool(values.get("maintenance_on")),
        "until": values.get("maintenance_until") or None,
        "message": {"ru": values.get("maintenance_message_ru") or "", "uz": values.get("maintenance_message_uz") or ""},
    }


def app_status(db: Session, settings: Settings, platform: str | None, version: str | None) -> dict[str, Any]:
    values = all_settings(db, settings)
    min_v, latest_v = values["app_min_version"], values["app_latest_version"]
    update = "none"
    if version:
        cur = parse_version(version)
        if cur < parse_version(min_v):
            update = "required"
        elif cur < parse_version(latest_v):
            update = "optional"
    store = values["app_store_url_android"] if platform == "android" else values["app_store_url_ios"]
    return {
        "platform": platform,
        "version": version,
        "min_version": min_v,
        "latest_version": latest_v,
        "update": update,
        "store_url": store,
        "store_urls": {"ios": values["app_store_url_ios"], "android": values["app_store_url_android"]},
        "release_notes": {"ru": _lines(values["app_release_notes_ru"]), "uz": _lines(values["app_release_notes_uz"])},
        "maintenance": maintenance_state(values),
    }


def is_blocked(method: str, path: str) -> bool:
    path = path.rstrip("/") or "/"
    return (method.upper() in WRITE_METHODS and not path.endswith(ALLOWED_SUFFIXES)
            and any(path == p or path.startswith(p + "/") for p in BLOCKED_PREFIXES))


def install_maintenance_guard(app: FastAPI) -> None:
    """Во время техработ запросы на изменение проектов получают 503 `maintenance` (приложение покажет экран)."""

    @app.middleware("http")
    async def _maintenance(request: Request, call_next):
        if is_blocked(request.method, request.url.path):
            state = request.app.state
            with state.db.sessionmaker() as db:
                m = maintenance_state(all_settings(db, state.settings))
            if m["on"]:
                return JSONResponse(status_code=503, content=_body(MAINTENANCE_CODE, MAINTENANCE_MESSAGE,
                                                                   {"until": m["until"], "message": m["message"]}))
        return await call_next(request)
