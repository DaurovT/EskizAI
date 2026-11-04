"""Устройства и push-токены (раздел 12 «Устройство», раздел 19), история уведомлений мастера."""

import uuid
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import AliasChoices, BaseModel, Field
from sqlalchemy import select

from ..db import utcnow
from ..deps import CurrentDep, DbDep
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import Device, Notification
from ..schemas.common import Ok
from ..services import notif_settings

router = APIRouter(tags=["devices"], responses=ERROR_RESPONSES)


class DeviceIn(BaseModel):
    push_token: str = Field(min_length=10, max_length=500, validation_alias=AliasChoices("push_token", "token"),
                            description="Expo push token: ExponentPushToken[…]")
    platform: Literal["ios", "android", "web"]
    device_id: str | None = Field(None, max_length=200, description="Не задан — устройство определяется по токену")


class DeviceOut(BaseModel):
    id: uuid.UUID
    device_id: str
    platform: str | None
    has_push: bool
    last_seen_at: str


def _out(d: Device) -> DeviceOut:
    return DeviceOut(id=d.id, device_id=d.device_id, platform=d.platform, has_push=bool(d.push_token),
                     last_seen_at=d.last_seen_at.isoformat())


@router.post("/devices", response_model=DeviceOut, summary="Зарегистрировать push-токен устройства")
def register(body: DeviceIn, current: CurrentDep, db: DbDep) -> DeviceOut:
    """Повторный вызов с тем же устройством обновляет токен. Токен отвязывается от других аккаунтов
    (на телефоне вошли под другим номером)."""
    device_key = body.device_id or f"token:{body.push_token[-60:]}"
    for other in db.scalars(select(Device).where(Device.push_token == body.push_token, Device.user_id != current.user.id)):
        other.push_token = None
    d = db.scalar(select(Device).where(Device.user_id == current.user.id, Device.device_id == device_key))
    if d is None:
        d = db.scalar(select(Device).where(Device.user_id == current.user.id, Device.push_token == body.push_token))
    if d is None:
        d = Device(user_id=current.user.id, device_id=device_key)
        db.add(d)
    d.platform, d.push_token, d.last_seen_at = body.platform, body.push_token, utcnow()
    db.commit()
    return _out(d)


@router.delete("/devices", response_model=Ok, summary="Отключить push на устройстве (выход, выключены уведомления)")
def unregister(current: CurrentDep, db: DbDep, device_id: str | None = Query(None), push_token: str | None = Query(None)) -> Ok:
    if not device_id and not push_token:
        raise ApiError(422, "device_required", "Укажите device_id или push_token")
    stmt = select(Device).where(Device.user_id == current.user.id)
    stmt = stmt.where(Device.device_id == device_id) if device_id else stmt.where(Device.push_token == push_token)
    rows = list(db.scalars(stmt))
    if not rows:
        raise not_found("Устройство")
    for d in rows:
        d.push_token = None
    db.commit()
    return Ok()


@router.get("/notifications", summary="Последние уведомления мастера")
def notifications(current: CurrentDep, db: DbDep, limit: int = Query(50, ge=1, le=200)) -> list[dict]:
    rows = db.scalars(select(Notification).where(Notification.user_id == current.user.id)
                      .order_by(Notification.created_at.desc()).limit(limit))
    return [{"id": str(n.id), "kind": n.kind, "title": n.title, "body": n.body, "data": n.data, "status": n.status,
             "project_id": str(n.project_id) if n.project_id else None, "read": n.read_at is not None,
             "created_at": n.created_at.isoformat()} for n in rows]


@router.post("/notifications/{notification_id}/read", response_model=Ok, summary="Отметить прочитанным")
def mark_read(notification_id: uuid.UUID, current: CurrentDep, db: DbDep) -> Ok:
    n = db.get(Notification, notification_id)
    if n is None or n.user_id != current.user.id:
        raise not_found("Уведомление")
    n.read_at = n.read_at or utcnow()
    db.commit()
    return Ok()


# --- Настройки уведомлений (FR-66, Misc.dc.html) ---


class QuietIn(BaseModel):
    enabled: bool | None = None
    from_: str | None = Field(None, alias="from", description="Начало тихих часов, ЧЧ:ММ (Ташкент)")
    to: str | None = Field(None, description="Конец тихих часов, ЧЧ:ММ (Ташкент)")


class NotificationSettingsIn(BaseModel):
    types: dict[str, bool] | None = Field(None, description="Тип → вкл/выкл: client_opened, client_agreed, model_ready, "
                                                            "order_status, prices_stale, price_request, nonstandard")
    quiet: QuietIn | None = None


@router.get("/me/notification-settings", summary="Настройки уведомлений: типы и тихие часы")
def get_notification_settings(current: CurrentDep) -> dict:
    """Выключенный тип — push не приходит (в истории событие остаётся). Тихие часы — push без звука."""
    return notif_settings.settings_out(current.user)


@router.patch("/me/notification-settings", summary="Изменить настройки уведомлений")
def patch_notification_settings(body: NotificationSettingsIn, current: CurrentDep, db: DbDep) -> dict:
    quiet = body.quiet.model_dump(by_alias=True, exclude_unset=True) if body.quiet else None
    notif_settings.update(current.user, body.types, quiet)
    db.commit()
    return notif_settings.settings_out(current.user)
