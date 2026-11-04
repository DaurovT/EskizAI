import uuid
from datetime import timedelta

from fastapi import APIRouter, Request
from sqlalchemy import select

from ..db import utcnow
from ..deps import CurrentDep, DbDep, SettingsDep, StorageDep
from ..domain import Role
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import Device, Invite, RefreshToken, User, Workshop
from ..schemas.auth import (
    DeleteAccountIn,
    DeleteAccountOut,
    DeleteCodeIn,
    RefreshIn,
    RequestCodeIn,
    RequestCodeOut,
    TokensOut,
    UserOut,
    UserUpdateIn,
    VerifyCodeIn,
)
from ..schemas.common import Ok
from ..schemas.workshops import InviteOut
from ..security import create_access_token, create_refresh_token, decode_token
from ..services.account import accept_invite, delete_account, invite_for_user, invite_out, invite_status
from ..services.action_log import log_action
from ..services.auth_codes import DELETE_ACCOUNT, LOGIN, account_exists, check_code, issue_code, normalize_phone

router = APIRouter(prefix="/auth", tags=["auth"], responses=ERROR_RESPONSES)


@router.post("/request-code", response_model=RequestCodeOut, summary="Запросить код входа")
def request_code(body: RequestCodeIn, request: Request, db: DbDep, settings: SettingsDep) -> RequestCodeOut:
    """Лимиты: на номер (пауза, в час, неверные коды за сутки), для номеров без аккаунта — на IP и на блок
    номеров и доля общего лимита SMS (остаток — входу существующих мастеров). Регистрация закрыта —
    новому номеру без приглашения `503 registration_closed` до отправки SMS."""
    phone = normalize_phone(body.phone)
    existing = account_exists(db, phone)
    if not existing and not _invited(db, phone):
        from ..services.spend_limits import registration_open

        if not registration_open(db, settings):  # аварийный выключатель (§4a) — SMS не тратим
            raise ApiError(503, "registration_closed", "Регистрация новых цехов временно закрыта. Попробуйте позже")
    # IP клиента — как его видит uvicorn за Caddy (--proxy-headers; Caddy подменяет X-Forwarded-For)
    ip = request.client.host if request.client else None
    return RequestCodeOut(**issue_code(db, settings, request.app.state.code_sender, phone, body.channel, LOGIN,
                                       ip=ip, existing=existing))


def _invited(db, phone: str) -> bool:
    return db.scalar(select(Invite.id).where(Invite.phone == phone, Invite.status == "pending").limit(1)) is not None


def _issue_tokens(db, settings, user: User, is_new: bool = False) -> TokensOut:
    expires = utcnow() + timedelta(days=settings.refresh_token_ttl_days)
    rt = RefreshToken(user_id=user.id, expires_at=expires)
    db.add(rt)
    db.flush()
    return TokensOut(
        access_token=create_access_token(settings, user.id, user.workshop_id, user.role),
        refresh_token=create_refresh_token(settings, user.id, rt.id, int(expires.timestamp())),
        expires_in=settings.access_token_ttl_minutes * 60,
        user=UserOut.model_validate(user),
        is_new_user=is_new,
    )


@router.post("/verify-code", response_model=TokensOut, summary="Подтвердить код и войти")
def verify_code(body: VerifyCodeIn, db: DbDep, settings: SettingsDep) -> TokensOut:
    """Новый номер — новый аккаунт владельца и новый цех. Если номер пригласили в цех —
    в ответе `invite`: приложение показывает приглашение до онбординга (SCR-38a)."""
    phone = normalize_phone(body.phone)
    now = utcnow()
    check_code(db, settings, phone, body.code, LOGIN)

    user = db.scalar(select(User).where(User.phone == phone))
    is_new = user is None
    if user is None:
        from ..services.spend_limits import registration_open

        if not _invited(db, phone) and not registration_open(db, settings):  # аварийный выключатель (§4a)
            raise ApiError(503, "registration_closed", "Регистрация новых цехов временно закрыта. Попробуйте позже")
        workshop = Workshop(phone=phone)
        db.add(workshop)
        db.flush()
        user = User(phone=phone, role=Role.owner, workshop_id=workshop.id)
        db.add(user)
        db.flush()
    elif not user.is_active:
        raise ApiError(403, "user_inactive", "Аккаунт отключён владельцем цеха")
    user.last_login_at = now

    if body.device_id:
        device = db.scalar(select(Device).where(Device.user_id == user.id, Device.device_id == body.device_id))
        if device is None:
            device = Device(user_id=user.id, device_id=body.device_id)
            db.add(device)
        device.platform = body.platform or device.platform
        device.push_token = body.push_token or device.push_token
        device.last_seen_at = now

    tokens = _issue_tokens(db, settings, user, is_new)
    inv = invite_for_user(db, user)
    if inv is not None:
        tokens.invite = invite_out(db, inv)
    db.commit()
    return tokens


def _load_refresh(db, settings, token: str) -> RefreshToken:
    payload = decode_token(settings, token, "refresh")
    rt = db.get(RefreshToken, uuid.UUID(payload["jti"]))
    if rt is None or rt.revoked_at is not None or rt.expires_at <= utcnow():
        raise ApiError(401, "refresh_invalid", "Сессия завершена — войдите заново")
    return rt


@router.post("/refresh", response_model=TokensOut, summary="Обновить токены")
def refresh(body: RefreshIn, db: DbDep, settings: SettingsDep) -> TokensOut:
    """Старый refresh-токен отзывается, выдаётся новая пара (ротация)."""
    rt = _load_refresh(db, settings, body.refresh_token)
    user = db.get(User, rt.user_id)
    if user is None or not user.is_active:
        raise ApiError(401, "user_inactive", "Аккаунт не найден или отключён")
    rt.revoked_at = utcnow()
    tokens = _issue_tokens(db, settings, user)
    db.commit()
    return tokens


@router.post("/logout", response_model=Ok, summary="Выйти")
def logout(body: RefreshIn, db: DbDep, settings: SettingsDep) -> Ok:
    rt = _load_refresh(db, settings, body.refresh_token)
    rt.revoked_at = utcnow()
    db.commit()
    return Ok()


@router.get("/me", response_model=UserOut, summary="Текущий пользователь")
def me(current: CurrentDep) -> User:
    return current.user


@router.patch("/me", response_model=UserOut, summary="Изменить имя и язык")
def update_me(body: UserUpdateIn, current: CurrentDep, db: DbDep) -> User:
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(current.user, k, v)
    db.commit()
    return current.user


# --- приглашение в цех (SCR-38a) ---


def _my_invite(db, current, invite_id: uuid.UUID) -> Invite:
    inv = db.get(Invite, invite_id)
    if inv is None or inv.phone != current.user.phone or inv.status != "pending":
        raise not_found("Приглашение")
    return inv


@router.get("/invite", response_model=InviteOut | None, summary="Приглашение в цех для моего номера")
def my_invite(current: CurrentDep, db: DbDep) -> InviteOut | None:
    """Действующее или устаревшее (status=expired) приглашение; null — приглашений нет или номер уже в цехе."""
    inv = invite_for_user(db, current.user)
    return invite_out(db, inv) if inv else None


@router.post("/invite/{invite_id}/accept", response_model=TokensOut, summary="Принять приглашение в цех")
def accept(invite_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep, storage: StorageDep) -> TokensOut:
    """Пользователь становится сотрудником цеха с правами из приглашения. Новые токены — с новым цехом и ролью."""
    inv = _my_invite(db, current, invite_id)
    if invite_status(inv) == "expired":
        raise ApiError(410, "invite_expired", "Приглашение устарело. Попросите владельца цеха отправить его заново")
    w = db.get(Workshop, inv.workshop_id)
    if w is None or w.deleted_at is not None or w.blocked:
        raise ApiError(410, "invite_expired", "Цех больше недоступен")
    user = current.user
    accept_invite(db, storage, user, inv)
    log_action(db, actor_type="user", actor_id=user.id, workshop_id=inv.workshop_id, entity="invite",
               entity_id=inv.id, action="accept")
    tokens = _issue_tokens(db, settings, user)
    db.commit()
    return tokens


@router.post("/invite/{invite_id}/decline", response_model=Ok, summary="Отклонить приглашение")
def decline(invite_id: uuid.UUID, current: CurrentDep, db: DbDep) -> Ok:
    """После отказа — обычный онбординг своего цеха. Отклонить можно и устаревшее приглашение."""
    inv = _my_invite(db, current, invite_id)
    inv.status, inv.decided_at = "declined", utcnow()
    db.commit()
    return Ok()


# --- удаление аккаунта (SCR-44, требование App Store) ---


@router.post("/delete-account/request-code", response_model=RequestCodeOut, summary="Код для удаления аккаунта")
def delete_account_code(request: Request, current: CurrentDep, db: DbDep, settings: SettingsDep,
                        body: DeleteCodeIn | None = None) -> RequestCodeOut:
    """Код уходит на номер аккаунта. Код входа для удаления не подходит (и наоборот)."""
    channel = body.channel if body else "sms"
    return RequestCodeOut(**issue_code(db, settings, request.app.state.code_sender, current.user.phone, channel,
                                       DELETE_ACCOUNT, ip=request.client.host if request.client else None,
                                       existing=True))


@router.post("/delete-account", response_model=DeleteAccountOut, summary="Удалить аккаунт навсегда")
def delete_me(body: DeleteAccountIn, current: CurrentDep, db: DbDep, settings: SettingsDep,
              storage: StorageDep) -> DeleteAccountOut:
    """Владелец — удаляется цех целиком: сотрудники, клиенты, проекты, файлы; ссылки клиентов отзываются.
    Заказы EMAN остаются (суммы и статусы — для учёта), личные данные из них убраны.
    Сотрудник — удаляется только его аккаунт. Все сессии и устройства отключаются."""
    user, workshop = current.user, current.workshop
    check_code(db, settings, user.phone, body.code, DELETE_ACCOUNT)
    db.flush()  # отметка «код использован» — до массового удаления кодов номера
    user_id, workshop_id = user.id, workshop.id
    scope, stats = delete_account(db, storage, user, workshop)
    log_action(db, actor_type="user", actor_id=user_id, workshop_id=workshop_id, entity="account",
               entity_id=user_id, action="delete_workshop" if scope == "workshop" else "delete_user", after=stats)
    db.commit()
    return DeleteAccountOut(scope=scope)
