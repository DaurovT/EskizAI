import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from .common import Out


class ClientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    phone: str | None = None
    address: str | None = Field(None, max_length=500)
    notes: str | None = Field(None, max_length=5000)


class ClientUpdateIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    phone: str | None = None
    address: str | None = Field(None, max_length=500)
    notes: str | None = Field(None, max_length=5000)


class ClientOut(Out):
    id: uuid.UUID
    name: str
    phone: str | None
    address: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class ClientProjectBrief(Out):
    id: uuid.UUID
    title: str
    status: str
    status_label: str
    created_at: datetime


class ClientCardOut(ClientOut):
    projects: list[ClientProjectBrief]
