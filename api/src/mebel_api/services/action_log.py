"""Журнал действий: кто, когда, что было и что стало (цены, настройки, тарифы, оплаты)."""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from ..models import ActionLog


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
    )
    db.add(entry)
    return entry
