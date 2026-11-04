import uuid
from datetime import datetime
from typing import Any, Literal

from mebel_core import KitchenSite, Niche
from pydantic import BaseModel, Field, model_validator

from ..domain import EstimateView, Language, PhotoKind, ProjectStatus
from .common import Out
from .estimate import MasterEstimate, PriceRange, StaffEstimate


class ProjectIn(BaseModel):
    title: str | None = Field(
        None, min_length=1, max_length=200,
        description="Не задано, «Новый проект 03.11.2026» или первая фраза описания — сервер даст название сам "
                    "(«Шкаф-купе 2400×650×2400») и будет обновлять его по модели; иначе — название мастера")
    client_id: uuid.UUID | None = None
    source_text: str | None = Field(None, max_length=10000, description="Исходное описание от мастера или клиента")
    is_example: bool = Field(
        False, json_schema_extra={"deprecated": True},
        description="Устарело — используйте POST /projects/example. true больше не создаёт проект «без лимита» "
                    "из данных клиента: сервер отдаёт пример цеха из своего шаблона (как POST /projects/example), "
                    "остальные поля игнорируются")


class ProjectUpdateIn(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200, description="Название мастера — сервер его не меняет")
    title_source: Literal["auto"] | None = Field(
        None, description="«auto» — вернуть автоназвание по модели (вместо введённого мастером)")
    client_id: uuid.UUID | None = None
    source_text: str | None = Field(None, max_length=10000)


class ClientBrief(Out):
    id: uuid.UUID
    name: str
    phone: str | None


class PhotoOut(Out):
    id: uuid.UUID
    kind: PhotoKind
    url: str
    content_type: str
    size_bytes: int
    created_at: datetime


class ActionOut(BaseModel):
    code: str
    label: str
    to_status: ProjectStatus | None


class Activity(BaseModel):
    text: str = Field(description="«открыл 2 раза», «не открыл 3 дн.», «готов — забрать в EMAN» — на языке пользователя")
    tone: Literal["green", "amber", "gray"]


class ProjectListItem(Out):
    id: uuid.UUID
    title: str = Field(description="«Шкаф-купе 2400×650×2400», «Кухня угловая 2350+1760», «Пенал · Азиз» или название мастера")
    title_source: Literal["auto", "user"] = Field(
        "user", description="auto — название ведёт сервер по модели, user — ввёл мастер (не меняется)")
    short_date: str = Field("", description="Дата создания коротко по Ташкенту: «03.11» или «03.11.25»")
    status: ProjectStatus
    status_label: str
    product_type: str | None
    is_example: bool
    client: ClientBrief | None
    current_version_id: uuid.UUID | None
    client_agreed_at: datetime | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    price: PriceRange | None = Field(
        None, description="Цена клиенту по последней посчитанной смете текущей версии (кэш); null — ещё не считали")
    activity: Activity | None = Field(None, description="Подсказка в списке: ссылка клиента, заказ EMAN, цена пришла")


class ProjectCardOut(ProjectListItem):
    source_text: str | None
    frozen_version_id: uuid.UUID | None
    charged: bool = Field(description="Списан ли проект из лимита")
    charge_period: str | None
    returned_to_limit: bool
    contract_at: datetime | None
    delivered_at: datetime | None
    materials_self_bought: bool
    cancelled_at: datetime | None
    cancel_reason: str | None
    has_order: bool
    photos: list[PhotoOut]
    model_summary: dict[str, Any] | None = Field(None, description="Сводка текущей версии модели (без цен)")
    estimate: MasterEstimate | StaffEstimate | None = Field(
        None,
        description="Смета по текущей версии (только в GET карточки; null — нет модели или в ней ошибки). "
        "Сотрудник получает вид без себестоимости и наценок",
    )
    next_step: str
    actions: list[ActionOut]


class StatusChangeOut(Out):
    from_status: ProjectStatus | None
    to_status: ProjectStatus
    actor: str
    note: str | None
    created_at: datetime


class MeasurementIn(BaseModel):
    width: float | None = Field(None, gt=0, le=20000, description="Ширина ниши / места, мм")
    height: float | None = Field(None, gt=0, le=10000, description="Высота, мм")
    depth: float | None = Field(None, gt=0, le=5000, description="Глубина, мм")
    data: dict[str, Any] = Field(default_factory=dict, description="Прочие замеры: перекосы, плинтус, розетки…")
    notes: str | None = Field(None, max_length=5000)
    apply_to_model: bool = Field(
        True, description="Применить размеры к модели новой версией (шкаф); размеры замера перестают быть «оценкой»")
    kitchen: KitchenSite | None = Field(
        None, description="Замер кухни (SCR-13b): стены A/B, потолок, окно, коммуникации — расстояния от угла, мм. "
                          "Хранится в data.kitchen; модули подгоняются под стены, мойка и варка — к выводам")
    niche: Niche | None = Field(
        None, description="Замер ниши для встроенного шкафа: ширина вверху/посередине/внизу, высота у левой/правой "
                          "стены, глубина (мм). Хранится в data.niche; шкаф становится встроенным, корпус — по самому "
                          "узкому месту минус доборы, перекос стен уходит в доборы (предупреждение, если > 15 мм)")


class MeasurementOut(Out):
    id: uuid.UUID
    version_id: uuid.UUID | None
    width: float | None
    height: float | None
    depth: float | None
    data: dict[str, Any]
    notes: str | None
    created_at: datetime
    applied_version_id: uuid.UUID | None = Field(None, description="Новая версия модели с размерами замера")
    apply_error: str | None = Field(None, description="Почему размеры не применены к модели")
    kitchen: dict[str, Any] | None = Field(None, description="Замер кухни (из data.kitchen)")
    niche: dict[str, Any] | None = Field(None, description="Замер ниши (из data.niche)")
    apply_notes: list[str] = Field(default_factory=list,
                                   description="Что сделано при применении замера кухни (для мастера)")

    @model_validator(mode="after")
    def _kitchen_from_data(self) -> "MeasurementOut":
        if self.kitchen is None and isinstance(self.data, dict) and isinstance(self.data.get("kitchen"), dict):
            self.kitchen = self.data["kitchen"]
        if self.niche is None and isinstance(self.data, dict) and isinstance(self.data.get("niche"), dict):
            self.niche = self.data["niche"]
        return self


class CancelIn(BaseModel):
    reason: str | None = Field(None, max_length=500)


class DeliverIn(BaseModel):
    materials_self_bought: bool = Field(
        False, description="Договор → Сдан без заказа в EMAN: мастер купил материалы сам"
    )


class ShareLinkIn(BaseModel):
    language: Language = Language.ru
    estimate_view: EstimateView | None = Field(None, description="Не задан — вид по умолчанию из профиля цеха")
    show_price: bool = True
    expires_in_days: int | None = Field(None, ge=1, le=365, description="Не задан — 30 дней")


class ShareLinkOut(Out):
    id: uuid.UUID
    token: str
    url: str
    version_id: uuid.UUID
    language: Language
    estimate_view: EstimateView
    show_price: bool
    expires_at: datetime
    revoked_at: datetime | None
    views: int
    ar_starts: int
    ar_failures: int
    first_opened_at: datetime | None
    agreed_at: datetime | None
    created_at: datetime
