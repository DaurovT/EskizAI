from typing import Annotated, Literal

from fastapi import APIRouter, Header, Query

from ..deps import DbDep, SettingsDep
from ..services.app_status import app_status

router = APIRouter(prefix="/app", tags=["system"])


@router.get("/status", summary="Версия приложения и техработы (без входа, SCR-45)")
def status(
    db: DbDep,
    settings: SettingsDep,
    platform: Annotated[Literal["ios", "android", "web"] | None, Query()] = None,
    version: Annotated[str | None, Query(max_length=20, description="Версия приложения, например 1.0.0")] = None,
    x_platform: Annotated[str | None, Header()] = None,
    x_app_version: Annotated[str | None, Header()] = None,
) -> dict:
    """`update`: none | optional («Вышла новая версия») | required («Обновите приложение»).
    `maintenance.on` — идут техработы: изменения проектов отвечают 503 `maintenance`, чтение и ссылки клиентов работают."""
    plat = platform or (x_platform if x_platform in ("ios", "android", "web") else None)
    return app_status(db, settings, plat, version or (x_app_version or "")[:20] or None)
