import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from ..domain import EstimateView, LaborMode, Plan, Role
from .common import Out


def _pct():
    return Field(None, ge=0, le=1000, description="%")



class PricingOut(Out):
    """Цены цеха — видит только владелец."""

    labor_mode: LaborMode = Field(description="percent — процент от материалов, fixed — сумма за проект")
    labor_percent: int = Field(description="Работа мастера, % от себестоимости материалов")
    labor_fixed: int = Field(description="Работа мастера фиксированной суммой, сумы")
    markup_body: int = Field(description="Наценка на корпус, %")
    markup_fronts: int = Field(description="Наценка на фасады, %")
    markup_hardware: int = Field(description="Наценка на фурнитуру, %")
    markup_services: int = Field(description="Наценка на услуги поставщика, %")
    default_estimate_view: EstimateView
    employee_estimate_views: list[EstimateView] = Field(description="Какие виды сметы могут отправлять сотрудники")


class PricingUpdateIn(BaseModel):
    labor_mode: LaborMode | None = None
    labor_percent: int | None = _pct()
    labor_fixed: int | None = Field(None, ge=0)
    markup_body: int | None = _pct()
    markup_fronts: int | None = _pct()
    markup_hardware: int | None = _pct()
    markup_services: int | None = _pct()
    default_estimate_view: EstimateView | None = None
    employee_estimate_views: list[EstimateView] | None = Field(None, min_length=1)

    @field_validator("employee_estimate_views")
    @classmethod
    def _unique(cls, v: list[EstimateView] | None) -> list[EstimateView] | None:
        return sorted(set(v), key=list(EstimateView).index) if v else v


class WorkshopOut(Out):
    """Профиль цеха — видят все сотрудники."""

    id: uuid.UUID
    name: str
    city: str
    logo_url: str | None
    phone: str | None
    kp_lead: str | None = Field(None, description="Срок для КП, например «12–15 рабочих дней после замера»")
    kp_payment: str | None = Field(None, description="Условия оплаты для КП")
    kp_warranty: str | None = Field(None, description="Гарантия для КП")
    plan: Plan
    default_estimate_view: EstimateView
    employee_estimate_views: list[EstimateView]
    created_at: datetime


class WorkshopOwnerOut(WorkshopOut):
    """Профиль цеха для владельца — с ценами."""

    pricing: PricingOut


class WorkshopUpdateIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    city: str | None = Field(None, max_length=100)
    logo_url: str | None = Field(None, max_length=500)
    phone: str | None = None
    kp_lead: str | None = Field(None, max_length=300)
    kp_payment: str | None = Field(None, max_length=300)
    kp_warranty: str | None = Field(None, max_length=300)


class EmployeeIn(BaseModel):
    """Приглашение сотрудника: номер, имя, должность и права (SCR-23)."""

    phone: str
    name: str = Field("", max_length=200)
    title: str | None = Field(None, max_length=60, description="Должность, например «Замерщик»")
    can_see_cost: bool = Field(False, description="Видеть себестоимость и наценку")
    can_order: bool = Field(False, description="Заказывать в EMAN")


class EmployeeOut(Out):
    id: uuid.UUID
    phone: str
    name: str
    role: Role
    is_active: bool
    last_login_at: datetime | None
    title: str | None = None
    can_see_cost: bool = False
    can_order: bool = False


class EmployeeUpdateIn(BaseModel):
    """Права и должность сотрудника — меняет владелец."""

    name: str | None = Field(None, max_length=200)
    title: str | None = Field(None, max_length=60)
    can_see_cost: bool | None = None
    can_order: bool | None = None


class InviteWorkshop(BaseModel):
    id: uuid.UUID
    name: str
    city: str


class InviteOwner(BaseModel):
    name: str
    phone: str | None


class InviteOut(BaseModel):
    """Приглашение в цех. `status`: pending | expired | accepted | declined | cancelled (expired — вычисляется)."""

    id: uuid.UUID
    status: str
    phone: str
    name: str
    title: str | None
    can_see_cost: bool
    can_order: bool
    estimate_views: list[EstimateView] = Field(description="Какие виды сметы сотрудник сможет отправлять")
    sent_at: datetime
    expires_at: datetime
    created_at: datetime
    workshop: InviteWorkshop
    owner: InviteOwner
    # Совместимость с прежним ответом POST /workshops/me/employees (EmployeeOut)
    role: Role = Role.employee
    is_active: bool = False
    last_login_at: datetime | None = None


class LimitsOut(BaseModel):
    plan: Plan
    period: str = Field(description="Месяц лимита, ГГГГ-ММ по времени Ташкента")
    free_limit: int
    free_used: int
    free_left: int
    pack_left: int
    unlimited: bool
    can_create_sketch: bool


class ActionLogOut(Out):
    id: uuid.UUID
    actor_type: str
    actor_id: str | None
    entity: str
    entity_id: str | None
    action: str
    before: dict | None
    after: dict | None
    created_at: datetime
