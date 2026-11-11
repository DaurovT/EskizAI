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
    closedUsdz: str | None = Field(None, description="USDZ «закрыто» для AR Quick Look (iPhone)")
    openUsdz: str | None = None
    placement: Literal["floor", "wall"] | None = Field(
        None, description="Размещение в AR: floor — на пол, wall — навесное (на стену)")


class ArOut(BaseModel):
    """GET /projects/{id}/ar — файлы AR мастера (docs/ar_contract.md)."""

    version_id: str
    version_number: int
    size_mm: list[float] = Field(description="[ширина, глубина, высота], мм — в порядке подписи «1600 × 600 × 2400»")
    placement: Literal["floor", "wall"]
    glb_url: str = Field(description="Подписанная ссылка на GLB «закрыто» (Scene Viewer), без входа, 1 час")
    usdz_url: str = Field(description="Подписанная ссылка на USDZ «закрыто» (AR Quick Look), без входа, 1 час")
    expires_at: str = Field(description="Когда ссылки перестанут работать, ISO 8601 (UTC)")


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
    glb: dict[str, str] = Field(description="ShareGlb: closed, open, closedUsdz, placement (+ openUsdz, если есть)")
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
