import uuid
from typing import Literal

from pydantic import BaseModel, Field

from ..domain import Language, Role
from .common import Out
from .workshops import InviteOut


class RequestCodeIn(BaseModel):
    phone: str = Field(description="Номер телефона, например +998 90 123 45 67", examples=["+998901234567"])
    channel: Literal["sms", "telegram"] = "telegram"


class RequestCodeOut(BaseModel):
    phone: str = Field(description="Номер в формате +998XXXXXXXXX")
    channel: str
    expires_in: int = Field(description="Срок жизни кода, секунд")
    resend_in: int = Field(description="Через сколько секунд можно запросить код снова")
    code_length: int = Field(5, description="Сколько цифр в коде")


class VerifyCodeIn(BaseModel):
    phone: str
    code: str = Field(min_length=4, max_length=8)
    device_id: str | None = Field(None, max_length=200)
    platform: Literal["ios", "android", "web"] | None = None
    push_token: str | None = Field(None, max_length=500)


class UserOut(Out):
    id: uuid.UUID
    phone: str
    name: str
    role: Role
    language: Language
    workshop_id: uuid.UUID
    title: str | None = None
    can_see_cost: bool = False
    can_order: bool = False


class TokensOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = Field(description="Срок жизни access-токена, секунд")
    user: UserOut
    is_new_user: bool = False
    invite: InviteOut | None = Field(None, description="Приглашение в цех для этого номера (SCR-38a) — показать до онбординга")


class RefreshIn(BaseModel):
    refresh_token: str


class UserUpdateIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    language: Language | None = None


class DeleteCodeIn(BaseModel):
    channel: Literal["sms", "telegram"] = "sms"


class DeleteAccountIn(BaseModel):
    code: str = Field(min_length=4, max_length=8)


class DeleteAccountOut(BaseModel):
    ok: bool = True
    scope: Literal["workshop", "user"] = Field(description="workshop — удалён цех целиком (владелец), user — только сотрудник")
