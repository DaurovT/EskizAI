import uuid
from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict

T = TypeVar("T")


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class Ok(BaseModel):
    ok: bool = True


class TaskOut(BaseModel):
    """Контракт: {id, status: queued|running|done|failed, result, error}. task_id/state — прежние имена."""

    id: str
    status: str
    task_id: str
    name: str
    state: str
    result: object | None = None
    error: str | None = None
    created_at: datetime
    finished_at: datetime | None = None


class Ref(Out):
    id: uuid.UUID
