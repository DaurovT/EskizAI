"""Журнал действий: кто, когда, что было и что стало (цены, настройки, тарифы, оплаты)."""

import uuid
from contextvars import ContextVar
from typing import Any

from sqlalchemy.orm import Session

from ..models import ActionLog

# IP текущего запроса (request.client.host — за Caddy его подставляет uvicorn --proxy-headers, см. routers/staff.py).
# Ставит RequestIpMiddleware; log_action пишет его в записи сотрудников.
request_ip: ContextVar[str | None] = ContextVar("request_ip", default=None)


class RequestIpMiddleware:
    """ASGI-прослойка: IP запроса → request_ip (ручки в пуле потоков получают копию контекста)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        client = scope.get("client")
        token = request_ip.set(str(client[0])[:64] if client and client[0] else None)
        try:
            await self.app(scope, receive, send)
        finally:
            request_ip.reset(token)


def log_action(
    db: Session,
    *,
    actor_type: str,
    actor_id: str | uuid.UUID | None,
    entity: str,
    entity_id: str | uuid.UUID | None,
    action: str,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    workshop_id: uuid.UUID | None = None,
    ip: str | None = None,
) -> ActionLog | None:
    """Пишет запись, если что-то изменилось. Хранит только изменённые поля."""
    if before is not None and after is not None:
        changed = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
        if not changed:
            return None
        before = {k: before.get(k) for k in sorted(changed)}
        after = {k: after.get(k) for k in sorted(changed)}
    entry = ActionLog(
        actor_type=actor_type,
        actor_id=str(actor_id) if actor_id is not None else None,
        workshop_id=workshop_id,
        entity=entity,
        entity_id=str(entity_id) if entity_id is not None else None,
        action=action,
        before=before,
        after=after,
        # IP — только у сотрудников (вход, опасные действия); у мастеров и системы не храним
        ip=(ip or request_ip.get()) if actor_type == "staff" else None,
    )
    db.add(entry)
    return entry


def staff_names(db: Session, entries) -> dict[str, str]:
    """Имена сотрудников для записей журнала (actor_type = staff) — «кто сделал» рядом с действием."""
    from ..models import StaffUser

    ids = set()
    for e in entries:
        if e.actor_type == "staff" and e.actor_id:
            try:
                ids.add(uuid.UUID(e.actor_id))
            except ValueError:
                pass
    names = {"admin-token": "Админ-токен"}
    if ids:
        from sqlalchemy import select

        names |= {str(i): n for i, n in db.execute(select(StaffUser.id, StaffUser.name).where(StaffUser.id.in_(ids)))}
    return names
