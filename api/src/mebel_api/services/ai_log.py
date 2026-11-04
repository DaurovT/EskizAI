"""Журнал ИИ-запросов (ADM-11). Сам ИИ — позже (недели 8–10)."""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from ..domain import AiValidation
from ..models import AiRequest


def log_ai_request(
    db: Session,
    *,
    purpose: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    cost_microusd: int,
    validation_result: AiValidation | str,
    validation_errors: list[Any] | None = None,
    workshop_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    cache_read_tokens: int = 0,
    duration_ms: int | None = None,
) -> AiRequest:
    row = AiRequest(
        purpose=purpose,
        model=model,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cache_read_tokens=cache_read_tokens,
        cost_microusd=cost_microusd,
        validation_result=AiValidation(validation_result).value,
        validation_errors=validation_errors,
        workshop_id=workshop_id,
        project_id=project_id,
        duration_ms=duration_ms,
    )
    db.add(row)
    db.flush()
    return row
