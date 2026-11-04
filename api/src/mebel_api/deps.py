"""Зависимости FastAPI: база, текущий пользователь, роли, админ-токен."""

import hmac
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import Depends, Header, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import Settings
from .domain import Role
from .errors import ApiError, forbidden
from .models import StaffMfa, StaffSession, StaffUser, Supplier, User, Workshop
from .security import decode_token
from .services.storage import Storage
from .services.tasks import TaskQueue


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    yield from request.app.state.db.session()


def get_storage(request: Request) -> Storage:
    return request.app.state.storage


def get_tasks(request: Request) -> TaskQueue:
    return request.app.state.tasks


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbDep = Annotated[Session, Depends(get_db)]
StorageDep = Annotated[Storage, Depends(get_storage)]
TasksDep = Annotated[TaskQueue, Depends(get_tasks)]

_bearer = HTTPBearer(auto_error=False, description="Access-токен из /auth/verify-code")


@dataclass
class CurrentUser:
    user: User
    workshop: Workshop
    impersonated_by: str | None = None  # id сотрудника платформы («глазами мастера», только чтение)

    @property
    def is_owner(self) -> bool:
        return self.user.role == Role.owner

    @property
    def role(self) -> Role:
        return Role(self.user.role)

    @property
    def sees_cost(self) -> bool:
        """Себестоимость и наценки: владелец или сотрудник с правом (SCR-23)."""
        return self.is_owner or bool(self.user.can_see_cost)

    @property
    def can_order(self) -> bool:
        """Заказ в EMAN: владелец или сотрудник с правом."""
        return self.is_owner or bool(self.user.can_order)


def get_current_user(
    request: Request,
    db: DbDep,
    settings: SettingsDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> CurrentUser:
    if creds is None:
        raise ApiError(401, "not_authenticated", "Нужно войти по номеру телефона")
    payload = decode_token(settings, creds.credentials, "access")
    user = db.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise ApiError(401, "user_inactive", "Аккаунт не найден или отключён")
    workshop = db.get(Workshop, user.workshop_id)
    assert workshop is not None
    if payload.get("imp"):  # «глазами мастера» (§4a): только чтение, каждый запрос — в журнал
        _impersonation_guard(request, payload, workshop)
        return CurrentUser(user=user, workshop=workshop, impersonated_by=str(payload["imp"]))
    if workshop.blocked:
        raise ApiError(403, "workshop_blocked", "Цех заблокирован. Напишите в поддержку")
    return CurrentUser(user=user, workshop=workshop)


def _impersonation_guard(request: Request, payload: dict, workshop: Workshop) -> None:
    from .models import ActionLog

    read_only = request.method in ("GET", "HEAD", "OPTIONS")
    with request.app.state.db.sessionmaker() as s:  # отдельная сессия: запись остаётся, даже если ручка не коммитит
        s.add(ActionLog(actor_type="staff", actor_id=str(payload["imp"])[:64], workshop_id=workshop.id,
                        entity="impersonation", entity_id=str(workshop.id), action="request" if read_only else "denied",
                        after={"method": request.method, "path": request.url.path[:300]}))
        s.commit()
    if not read_only:
        raise ApiError(403, "impersonation_read_only", "Просмотр «глазами мастера» — только чтение")


CurrentDep = Annotated[CurrentUser, Depends(get_current_user)]


def require_owner(current: CurrentDep) -> CurrentUser:
    if not current.is_owner:
        raise forbidden("Это может сделать только владелец цеха")
    return current


OwnerDep = Annotated[CurrentUser, Depends(require_owner)]


# --- Сотрудники платформы и поставщиков (docs/staff_vendor_contract.md) ---

_staff_bearer = HTTPBearer(auto_error=False, scheme_name="StaffBearer",
                           description="Access-токен сотрудника из /staff/auth/login")
LEGACY_ACTOR_ID = "admin-token"


@dataclass
class StaffActor:
    """Кто действует в админке или кабинете поставщика. staff=None — старый X-Admin-Token (суперадмин)."""

    staff: StaffUser | None
    role: str
    supplier_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None
    type: str = "staff"  # actor_type в action_log

    @property
    def id(self) -> str:
        return str(self.staff.id) if self.staff is not None else LEGACY_ACTOR_ID

    @property
    def staff_uuid(self) -> uuid.UUID | None:
        return self.staff.id if self.staff is not None else None

    @property
    def name(self) -> str:
        return self.staff.name if self.staff is not None else "Админ-токен"

    @property
    def is_superadmin(self) -> bool:
        return self.role == "superadmin"

    @property
    def is_vendor(self) -> bool:
        return self.supplier_id is not None

    def can(self, *keys: str) -> bool:
        from .services.staff_auth import has_permission

        return has_permission(self.role, *keys)

    def __str__(self) -> str:
        return self.id


def mfa_required_for(db: Session, settings: Settings, role: str) -> bool:
    if role == "superadmin":
        return settings.superadmin_mfa_required
    from .models import AppSetting

    row = db.get(AppSetting, "mfa_required_roles")
    return bool(row is not None and isinstance(row.value, list) and role in row.value)


def resolve_staff(db: Session, settings: Settings, x_admin_token: str | None,
                  creds: HTTPAuthorizationCredentials | None, *, gate: bool = True, legacy: bool = True,
                  missing_code: str = "admin_required") -> StaffActor:
    """Bearer сотрудника (typ=staff) или, если разрешено, старый X-Admin-Token.
    gate=False — для /staff/me, смены пароля и настройки 2FA (без них дальше не пускаем)."""
    from .services.staff_auth import ACCESS_TYP, decode_staff_token

    if creds is not None:
        payload = decode_staff_token(settings, creds.credentials, ACCESS_TYP)
        staff = db.get(StaffUser, uuid.UUID(payload["sub"]))
        if staff is None or not staff.is_active:
            raise ApiError(401, "staff_inactive", "Сотрудник не найден или отключён")
        try:
            sid = uuid.UUID(str(payload.get("sid")))
        except ValueError:
            raise ApiError(401, "token_invalid", "Неверный токен — войдите заново")
        session = db.get(StaffSession, sid)
        if session is None or session.staff_id != staff.id or session.revoked_at is not None:
            raise ApiError(401, "session_revoked", "Сессия завершена — войдите заново")
        if staff.supplier_id is not None:
            supplier = db.get(Supplier, staff.supplier_id)
            if supplier is None or not supplier.active:
                raise ApiError(403, "supplier_blocked", "Поставщик отключён платформой")
        if gate:
            if staff.must_change_password:
                raise ApiError(403, "password_change_required", "Смените временный пароль")
            if mfa_required_for(db, settings, staff.role):
                mfa = db.get(StaffMfa, staff.id)
                if mfa is None or mfa.enabled_at is None:
                    raise ApiError(403, "mfa_setup_required", "Включите вход с кодом из приложения-аутентификатора")
        return StaffActor(staff=staff, role=staff.role, supplier_id=staff.supplier_id, session_id=sid)
    if x_admin_token and legacy:
        if settings.admin_token_enabled and hmac.compare_digest(x_admin_token.encode(), settings.admin_token.encode()):
            return StaffActor(staff=None, role="superadmin")
        raise ApiError(401, missing_code, "Неверный токен админки")
    raise ApiError(401, missing_code, "Войдите в админку")


_READ_METHODS = ("GET", "HEAD", "OPTIONS")


def require_staff(*keys: str, area: str = "admin", legacy: Literal["yes", "read", "no"] = "yes"):
    """Зависимость: сотрудник с любым из прав `keys`. area: admin — только платформа, vendor — только поставщик,
    any — оба (проверка области — в ручке).

    legacy — что можно старому X-Admin-Token (суперадмин без 2FA и без имени): yes — всё (чтение и повседневные
    дела), read — только GET, no — ничего. Всё, что меняет доступ (сотрудники, «глазами мастера») или деньги
    и правила платформы (настройки, лимиты, поставщики, финансы, споры), — только под учётной записью с 2FA."""

    def dep(
        request: Request,
        db: DbDep,
        settings: SettingsDep,
        creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_staff_bearer)],
        x_admin_token: Annotated[str | None, Header(description="Старый токен админки (ограниченно)")] = None,
    ) -> StaffActor:
        actor = resolve_staff(db, settings, x_admin_token, creds, legacy=area != "vendor",
                              missing_code="admin_required" if area == "admin" else "staff_required")
        if actor.staff is None and (legacy == "no" or (legacy == "read" and request.method not in _READ_METHODS)):
            raise ApiError(403, "admin_token_not_allowed",
                           "Это действие — только под учётной записью сотрудника (почта, пароль, 2FA). "
                           "Старый токен админки здесь не принимается")
        if area == "admin" and actor.is_vendor:
            raise forbidden("Раздел платформы — для сотрудников платформы")
        if area == "vendor" and not actor.is_vendor:
            raise forbidden("Кабинет поставщика — для сотрудников поставщика")
        if keys and not actor.can(*keys):
            raise forbidden()
        return actor

    return dep


def current_staff_ungated(
    db: DbDep,
    settings: SettingsDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_staff_bearer)],
) -> StaffActor:
    return resolve_staff(db, settings, None, creds, gate=False, legacy=False, missing_code="staff_required")


StaffSelfDep = Annotated[StaffActor, Depends(current_staff_ungated)]

# Админка: права по ролям (§1). AdminDep — только суперадмин. legacy — что можно старому X-Admin-Token.
AdminDep = Annotated[StaffActor, Depends(require_staff("*", legacy="no"))]
PlatformDep = Annotated[StaffActor, Depends(require_staff())]  # любой сотрудник платформы
WorkshopsViewDep = Annotated[StaffActor, Depends(require_staff("workshops.view"))]
WorkshopsGrantDep = Annotated[StaffActor, Depends(require_staff("workshops.grant"))]
ProjectsViewDep = Annotated[StaffActor, Depends(require_staff("projects.view"))]
OrdersDep = Annotated[StaffActor, Depends(require_staff("orders.manage"))]
NonstandardDep = Annotated[StaffActor, Depends(require_staff("nonstandard.manage"))]
CatalogDep = Annotated[StaffActor, Depends(require_staff("catalog.manage"))]
PriceRequestsDep = Annotated[StaffActor, Depends(require_staff("price_requests.manage"))]
SuppliersDep = Annotated[StaffActor, Depends(require_staff("suppliers.manage", legacy="no"))]  # ручки записи
SuppliersReadDep = Annotated[StaffActor, Depends(require_staff("suppliers.manage", "catalog.manage", "orders.manage"))]
FinanceDep = Annotated[StaffActor, Depends(require_staff("finance", legacy="read"))]
TariffsDep = Annotated[StaffActor, Depends(require_staff("tariffs", legacy="read"))]
SettingsAdminDep = Annotated[StaffActor, Depends(require_staff("settings", legacy="read"))]
AiLogDep = Annotated[StaffActor, Depends(require_staff("ai.log"))]
AuditDep = Annotated[StaffActor, Depends(require_staff("audit.view"))]
DisputesDep = Annotated[StaffActor, Depends(require_staff("disputes", legacy="read"))]
BroadcastsDep = Annotated[StaffActor, Depends(require_staff("broadcasts"))]
ImpersonateDep = Annotated[StaffActor, Depends(require_staff("impersonate", legacy="no"))]
StaffManageDep = Annotated[StaffActor, Depends(require_staff("staff.manage", "vendor.staff", area="any",
                                                            legacy="no"))]
SecurityDep = Annotated[StaffActor, Depends(require_staff("security", "vendor.staff", area="any", legacy="no"))]


def vendor_dep(*keys: str):
    return Annotated[StaffActor, Depends(require_staff(*keys, area="vendor"))]


VendorDep = vendor_dep()  # любой сотрудник поставщика


def get_llm(settings: SettingsDep):
    """Клиент Claude для ИИ-задач. В тестах подменяется: app.dependency_overrides[get_llm]."""
    from mebel_ai import LLM

    if not settings.anthropic_api_key:
        raise ApiError(503, "ai_unavailable", "ИИ временно недоступен: не настроен ключ Claude API (ANTHROPIC_API_KEY)")
    import anthropic

    return LLM(client=anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=90.0, max_retries=2))


LLMDep = Annotated[object, Depends(get_llm)]


def require_reason(actor: "StaffActor", reason: str | None) -> str | None:
    """Опасные действия (§4a) требуют причину. Старый X-Admin-Token — переходный период: без проверки."""
    reason = (reason or "").strip() or None
    if reason is None and actor.staff is not None:
        raise ApiError(422, "reason_required", "Укажите причину — действие пишется в журнал")
    return reason
