from typing import Any, Literal

from pydantic import BaseModel, Field

from ..domain import Language, ShareEventKind


class LocalizedText(BaseModel):
    ru: str
    uz: str


class ShareProject(BaseModel):
    title: LocalizedText
    sizeMm: list[float] = Field(description="[ширина, высота, глубина], мм")
    modelVersion: str


class ShareMaster(BaseModel):
    name: str
    workshop: str | None = None
    city: str | None = None
    phone: str = Field(description="E.164")
    telegram: str | None = None
    logoUrl: str | None = Field(None, description="Расширение: логотип цеха — только на тарифе Pro")


class ShareGlb(BaseModel):
    closed: str
    open: str
    closedUsdz: str | None = None
    openUsdz: str | None = None


class SharePayload(BaseModel):
    """Ровно тип SharePayload из web/src/lib/share-types.ts (страница /p/[token])."""

    version: Literal[1] = 1
    token: str
    lang: Language
    expiresAt: str | None
    agreedAt: str | None
    project: ShareProject
    master: dict[str, Any] = Field(description="ShareMaster без пустых необязательных полей")
    model: dict[str, Any] = Field(description="Viewer model формата \"1\" (mebel_core.viewer)")
    glb: dict[str, str] = Field(description="ShareGlb: closed, open (+ closedUsdz, openUsdz, если есть)")
    estimate: dict[str, Any] | None = Field(description="client_view() ядра в выбранном виде; null — цена скрыта")
    priceDate: str | None


class AgreeOut(BaseModel):
    agreedAt: str


class ShareEventIn(BaseModel):
    """Событие ссылки. Формат web: {event, at, meta?}; прежний формат {kind, meta} тоже принимается."""

    kind: ShareEventKind | None = None
    event: ShareEventKind | None = None
    at: str | None = Field(None, description="Время на устройстве клиента, ISO 8601")
    meta: dict[str, Any] = Field(default_factory=dict, description="Например устройство, причина ошибки AR")

    @property
    def event_kind(self) -> ShareEventKind | None:
        return self.event or self.kind
