"""Смета: типы ответа. Расчёт — в ядре (mebel_core.estimate).

* ClientEstimate — для ссылки клиента; это ровно `mebel_core.estimate.client_view()`
  в выбранном виде (раздел 7 PRD):
  - total:    `total`;
  - short:    `total`, `materials`, `work`;
  - detailed: плюс `groups` (листы, кромка, распил и кромкование, фурнитура, фасады…)
              с ценами для клиента и `requests` — позиции «под запрос» с пометкой «уточняется».
  До замера суммы — диапазон «от–до» (`exact=false`): ожидаемая цена ± 3–8 % по реальной
  неопределённости, круглые суммы; что оценено — `uncertainty` и готовая строка `uncertainty_text`
  («оценка: размеры, фасады») / `uncertainty_text_uz`. После замера `exact=true`, from == to.
  Процент наценки, поставщик, артикулы и комиссия сюда не попадают никогда.
* StaffEstimate — для сотрудника цеха: суммы для клиента без себестоимости и наценок.
* MasterEstimate — для владельца: плюс себестоимость, разбивка по категориям и строки.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..domain import EstimateView


class PriceRange(BaseModel):
    """Сумма в сумах. Точная цена — from == to."""

    model_config = ConfigDict(populate_by_name=True)

    from_: int = Field(alias="from", description="От, сумы")
    to: int = Field(description="До, сумы")


class UncertaintyItem(BaseModel):
    """Что в цене до замера — оценка."""

    category: Literal["sizes", "body", "fronts", "hardware", "services"]
    name: str = Field(description="«размеры», «фасады»…")
    name_uz: str
    reason: str = Field(description="«размеры по фото, уточнятся на замере», «цена по аналогу», «цена уточняется»…")
    reason_uz: str


class _Uncertainty(BaseModel):
    uncertainty: list[UncertaintyItem] = Field(
        default_factory=list, description="До замера: категории-оценки, главное первым; после замера — пусто")
    uncertainty_text: str = Field("", description="Готовая строка: «оценка: размеры, фасады»; после замера — пусто")
    uncertainty_text_uz: str = Field("", description="То же по-узбекски: «taxminiy: o‘lchamlar, fasadlar»")


class ClientEstimateGroup(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(description="Например «Листы», «Фурнитура»")
    from_: int = Field(alias="from")
    to: int


class ClientRequestItem(BaseModel):
    name: str
    note: str = "уточняется"


class ClientEstimate(_Uncertainty):
    view: EstimateView
    exact: bool = Field(description="false — до замера, диапазон «от–до»")
    total: PriceRange
    materials: PriceRange | None = Field(None, description="Короткая и подробная: материалы по цене для клиента")
    work: PriceRange | None = Field(None, description="Короткая и подробная: работа мастера")
    groups: list[ClientEstimateGroup] | None = Field(None, description="Только подробная")
    requests: list[ClientRequestItem] | None = Field(None, description="Подробная: позиции «под запрос»")


class StaffEstimate(_Uncertainty):
    """Смета для сотрудника цеха: без себестоимости и наценок."""

    exact: bool
    total: PriceRange
    expected: int = Field(0, description="Ожидаемая цена клиенту (середина диапазона), сумы")
    band_percent: float = Field(0, description="Полуширина диапазона, %: 3–8 до замера, 0 после")
    materials_client: PriceRange
    work: PriceRange
    has_requests: bool = Field(description="Есть позиции «под запрос»")
    sheets: dict[str, int] = Field(description="Листов по материалам (с запасом), по ожидаемой смете")
    priced_at: datetime


class MasterEstimateLine(BaseModel):
    key: str
    category: Literal["body", "fronts", "hardware", "services"]
    group: str
    name: str
    unit: str
    qty: float
    unit_price: int = Field(description="Себестоимость за единицу, сумы")
    cost: int = Field(description="Себестоимость строки, сумы")
    status: str = Field(description="catalog | analog | request | nonstandard")
    source: str
    priced_at: str


class MasterEstimate(StaffEstimate):
    """Смета для владельца: плюс себестоимость. Строки — по ожидаемой смете (размеры модели)."""

    cost_materials: PriceRange = Field(description="Себестоимость материалов и услуг")
    cost_by_category: dict[str, int]
    markup_percent: dict[str, float] = Field(description="Наценки цеха по категориям, %")
    lines: list[MasterEstimateLine]
