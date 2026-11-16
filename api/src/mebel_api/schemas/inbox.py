"""Входящие чертежи из Eskiz DWG (docs/dwg_contract.md)."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class InboxDrawingOut(BaseModel):
    id: uuid.UUID
    title: str | None = Field(description="manifest.title")
    filename: str = Field(description="Имя загруженного файла")
    size: int = Field(description="Размер пакета, байт")
    sha256: str = Field(description="SHA-256 загруженного пакета (не source.sha256 из manifest)")
    created_at: datetime
    last_opened_at: datetime | None
    expires_at: datetime = Field(description="Удалится, если не открывать: последнее открытие (или загрузка) + 90 дней")
    preview_url: str | None = Field(description="Подписанная ссылка на превью WebP (живёт 1 час), путь от адреса API")
    sheet_count: int | None = Field(None, description="manifest.stats.sheets")
    units_guessed: bool = Field(False, description="manifest.units.source == \"guessed\" — показать «проверьте размеры»")
    units_note: str | None = Field(None, description="manifest.units.note")
    package_created_at: str | None = Field(None, description="manifest.created_at — время сборки пакета, как в пакете")
    source_kind: str | None = Field(None, description="manifest.source.kind: dwg / dxf")
    project_id: uuid.UUID | None = Field(None, description="Проект, созданный по чертежу; пока он есть, чертёж не истекает")


class InboxSheetOut(BaseModel):
    id: str | None = Field(None, description="manifest.sheets[].id (`s1`…) — для POST /inbox/drawings/{id}/project")
    number: str | None
    name: str | None
    selected: bool
    preview_url: str | None = Field(description="Только у листа, превью которого сохранено (первый отмеченный)")


class InboxDrawingDetail(InboxDrawingOut):
    sheets: list[InboxSheetOut] = Field(default_factory=list, description="manifest.sheets[]")
    manifest: dict[str, Any] | None = Field(description="manifest.json целиком, как в пакете")
    download_url: str = Field(description="Подписанная ссылка на пакет .eskiz (живёт 30 минут), путь от адреса API")


class InboxProjectIn(BaseModel):
    sheet: str | None = Field(None, max_length=50,
                              description="id (`s1`) или номер листа из manifest.sheets; нет — первый отмеченный лист")


class InboxSheetRef(BaseModel):
    id: str | None
    number: str | None
    name: str | None


class InboxProjectOut(BaseModel):
    project_id: uuid.UUID
    created: bool = Field(description="false — тот же черновик по этому чертежу (ещё без модели): лист и текст заменены")
    sheet: InboxSheetRef | None = Field(description="Взятый лист; null — в пакете нет листов (взята модель)")
    text: str = Field(description="Короткое описание листа из data.json (размеры в мм) — текст для POST /projects/{id}/ai/design")
    photo_id: uuid.UUID | None = Field(description="Превью листа как исходное фото проекта; null — превью в пакете нет")
    photo_url: str | None


class SourceDrawingOut(BaseModel):
    """Исходный чертёж проекта (создан из «Входящих»): для «Открыть в Eskiz DWG»."""
    id: uuid.UUID
    title: str | None
    filename: str
    size: int
    source_kind: str | None = Field(description="dwg / dxf")
    download_url: str | None = Field(None, description="Подписанная ссылка на пакет .eskiz (30 минут), путь от адреса API; "
                                                       "только в GET /projects/{id}/source-drawing")
