import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from .common import Out


class FixOut(BaseModel):
    description: str
    patch: list[dict[str, Any]] = Field(description="JSON Patch (RFC 6902) над деревом модулей")


class IssueOut(BaseModel):
    level: str
    code: str
    message: str
    path: str = ""
    fixes: list[FixOut] = Field(default_factory=list, description="Готовые исправления — POST …/model/fixes")


class ApplyFixIn(BaseModel):
    issue_index: int = Field(ge=0, description="Номер замечания в issues текущей версии")
    fix_index: int = Field(0, ge=0, description="Номер исправления в fixes замечания")


class ModelIn(BaseModel):
    tree: dict[str, Any] = Field(description="Дерево модулей — схема GET /models/schema (schemas/product.schema.json)")
    label: str | None = Field(None, max_length=200, description="Подпись версии, например «вариант с антресолью»")
    source: str = Field("manual", pattern="^(manual|ai)$")
    reject_on_errors: bool = Field(
        False,
        description="true — если модель с правкой не собирается без ошибок, версия не создаётся (правка из чата)",
    )


class ValidateIn(BaseModel):
    tree: dict[str, Any]


class ValidateOut(BaseModel):
    schema_valid: bool
    ok: bool = Field(description="Схема верна и в модели нет ошибок")
    schema_errors: list[dict[str, Any]] = Field(default_factory=list)
    issues: list[IssueOut] = Field(default_factory=list)
    summary: dict[str, Any] | None = None
    build_ms: int | None = None


class VersionPrice(BaseModel):
    from_: int = Field(alias="from", description="Итог клиенту от, сумы")
    to: int = Field(description="Итог клиенту до, сумы")
    exact: bool = Field(False, description="Точная цена (после замера)")

    model_config = {"populate_by_name": True}


class VersionBrief(Out):
    id: uuid.UUID
    number: int
    parent_id: uuid.UUID | None
    source: str
    label: str | None
    ok: bool
    frozen: bool
    is_current: bool = False
    rules_version: str
    summary: dict[str, Any]
    build_ms: int
    created_at: datetime
    estimated: list[str] = Field(default_factory=list,
                                 description="JSON Pointer'ы значений «оценка» (ИИ оценил, мастер не подтвердил)")
    price: VersionPrice | None = Field(None, description="Цена клиенту по этой версии (сравнение версий); "
                                                         "null — модель с ошибками или смета не посчиталась")


class VersionOut(VersionBrief):
    tree: dict[str, Any]
    schema_version: str
    module_versions: dict[str, str]
    issues: list[IssueOut]
    viewer: dict[str, Any] = Field(description="3D-модель (формат mebel_core.viewer, размеры в мм)")


class VersionUpdateIn(BaseModel):
    label: str | None = Field(None, max_length=200)


class ModelStateOut(BaseModel):
    """Ответ на правку, отмену и повтор: текущая версия и доступность отмены/повтора."""

    version: VersionOut
    can_undo: bool
    can_redo: bool
    frozen_version_id: uuid.UUID | None


class ConfirmIn(BaseModel):
    pointers: list[str] = Field(default_factory=list, description="JSON Pointer'ы подтверждённых значений")
    all: bool = Field(False, description="Подтвердить все значения «оценка» версии")


class ConfirmOut(BaseModel):
    version_id: uuid.UUID
    estimated: list[str]


class HardwareApplyIn(BaseModel):
    key: str = Field(description="Группа: hinge, hinge_class, slides, slides_class, handles, handle_finish, lighting, corner_fill")
    value: str = Field(description="Вариант группы из GET …/hardware")


class PartEdgeOut(BaseModel):
    side: str = Field(description="x0, x1 — короткие стороны (по длине); y0, y1 — длинные")
    edge_id: str | None = None
    name: str | None = None
    thickness_mm: float = 0


class PartHolesOut(BaseModel):
    purpose: str
    diameter_mm: float
    count: int


class PartHardwareOut(BaseModel):
    kind: str
    name: str
    qty: int


class PartOut(BaseModel):
    """Деталь текущей версии (SCR-25 «Выбран элемент»): чистовой размер, распил, кромка, присадка."""

    number: int
    key: str
    name: str
    role: str
    module: str
    material_id: str
    material: str
    length_mm: float = Field(description="Чистовой размер по длине")
    width_mm: float
    thickness_mm: float
    cut_length_mm: float = Field(description="Размер распила = чистовой − кромка")
    cut_width_mm: float
    grain: str
    edges: list[PartEdgeOut]
    holes: list[PartHolesOut]
    grooves: int = 0
    cutouts: int = 0
    hardware: list[PartHardwareOut] = Field(default_factory=list, description="Фурнитура модуля детали")
    product_size_mm: list[float] = Field(default_factory=list, description="Габарит изделия: ширина, высота, глубина")
