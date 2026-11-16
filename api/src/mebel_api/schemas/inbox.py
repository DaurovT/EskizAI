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


class InboxSheetOut(BaseModel):
    number: str | None
    name: str | None
    selected: bool
    preview_url: str | None = Field(description="Только у листа, превью которого сохранено (первый отмеченный)")


class InboxDrawingDetail(InboxDrawingOut):
    sheets: list[InboxSheetOut] = Field(default_factory=list, description="manifest.sheets[]")
    manifest: dict[str, Any] | None = Field(description="manifest.json целиком, как в пакете")
    download_url: str = Field(description="Подписанная ссылка на пакет .eskiz (живёт 30 минут), путь от адреса API")
