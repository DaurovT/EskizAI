"""Зависимости FastAPI: база, текущий пользователь, роли, админ-токен."""

import hmac
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import Settings
from .domain import Role
from .errors import ApiError, forbidden
from .models import User, Workshop
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
    if workshop.blocked:
        raise ApiError(403, "workshop_blocked", "Цех заблокирован. Напишите в поддержку")
    return CurrentUser(user=user, workshop=workshop)


CurrentDep = Annotated[CurrentUser, Depends(get_current_user)]


def require_owner(current: CurrentDep) -> CurrentUser:
    if not current.is_owner:
        raise forbidden("Это может сделать только владелец цеха")
    return current


OwnerDep = Annotated[CurrentUser, Depends(require_owner)]


def require_admin(
    settings: SettingsDep,
    x_admin_token: Annotated[str | None, Header(description="Токен админки (временно, до ролей админки)")] = None,
) -> str:
    if not x_admin_token or not hmac.compare_digest(x_admin_token, settings.admin_token):
        raise ApiError(401, "admin_required", "Нужен токен админки")
    return "admin"


AdminDep = Annotated[str, Depends(require_admin)]


def get_llm(settings: SettingsDep):
    """Клиент Claude для ИИ-задач. В тестах подменяется: app.dependency_overrides[get_llm]."""
    from mebel_ai import LLM

    if not settings.anthropic_api_key:
        raise ApiError(503, "ai_unavailable", "ИИ временно недоступен: не настроен ключ Claude API (ANTHROPIC_API_KEY)")
    import anthropic

    return LLM(client=anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=90.0, max_retries=2))


LLMDep = Annotated[object, Depends(get_llm)]
