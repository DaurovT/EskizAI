import uuid
from datetime import timedelta

from fastapi import APIRouter, File, Query, UploadFile
from sqlalchemy import select

from ..deps import CurrentDep, DbDep, OwnerDep, StorageDep
from ..domain import Role
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import ActionLog, Invite, RefreshToken, User, Workshop
from ..schemas.common import Ok
from ..schemas.workshops import (
    ActionLogOut,
    EmployeeIn,
    EmployeeOut,
    EmployeeUpdateIn,
    InviteOut,
    PricingOut,
    PricingUpdateIn,
    WorkshopOut,
    WorkshopOwnerOut,
    WorkshopUpdateIn,
)
from ..db import utcnow
from ..services.account import INVITE_DAYS, create_or_refresh_invite, invite_out, send_invite
from ..services.action_log import log_action
from ..services.auth_codes import normalize_phone

router = APIRouter(prefix="/workshops/me", tags=["workshops"], responses=ERROR_RESPONSES)

PRICING_FIELDS = list(PricingOut.model_fields)
PROFILE_FIELDS = list(WorkshopUpdateIn.model_fields)


def pricing_dict(w: Workshop) -> dict:
    return PricingOut.model_validate(w).model_dump(mode="json")


def workshop_out(w: Workshop, owner: bool) -> WorkshopOut:
    base = WorkshopOut.model_validate(w)
    if not owner:
        return base
    return WorkshopOwnerOut(**base.model_dump(), pricing=PricingOut.model_validate(w))


@router.get(
    "",
    response_model=WorkshopOwnerOut | WorkshopOut,
    summary="Профиль цеха",
    description="Владелец получает и цены (`pricing`); сотрудник — без себестоимости и наценок.",
)
def get_workshop(current: CurrentDep) -> WorkshopOut:
    return workshop_out(current.workshop, current.is_owner)


@router.patch("", response_model=WorkshopOwnerOut, summary="Изменить профиль цеха")
def update_workshop(body: WorkshopUpdateIn, current: OwnerDep, db: DbDep) -> WorkshopOut:
    w = current.workshop
    data = body.model_dump(exclude_unset=True)
    if data.get("phone"):
        data["phone"] = normalize_phone(data["phone"])
    before = {k: getattr(w, k) for k in PROFILE_FIELDS}
    if "logo_url" in data and data["logo_url"] != w.logo_url:
        w.logo_key = None  # ссылка задана вручную — файл в хранилище больше не наш логотип
    for k, v in data.items():
        if k == "name" and v is None:
            continue
        setattr(w, k, v)
    log_action(
        db, actor_type="user", actor_id=current.user.id, workshop_id=w.id, entity="workshop", entity_id=w.id,
        action="update_profile", before=before, after={k: getattr(w, k) for k in PROFILE_FIELDS},
    )
    db.commit()
    return workshop_out(w, True)


LOGO_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
LOGO_MAX_BYTES = 2 * 1024 * 1024


def _drop_logo(w: Workshop, storage) -> None:
    if w.logo_key:
        try:
            storage.delete(w.logo_key)
        except Exception:  # файл уже удалён или хранилище недоступно — ссылку всё равно убираем
            pass
    w.logo_url, w.logo_key = None, None


@router.post("/logo", response_model=WorkshopOwnerOut, summary="Загрузить логотип цеха (владелец)")
async def upload_logo(current: OwnerDep, db: DbDep, storage: StorageDep,
                      file: UploadFile = File(description="JPEG, PNG или WebP, до 2 МБ")) -> WorkshopOut:
    """Логотип — в КП и на странице клиента (на странице клиента — только на Pro). Прежний файл удаляется."""
    ext = LOGO_TYPES.get((file.content_type or "").lower())
    if ext is None:
        raise ApiError(415, "unsupported_image", "Загрузите логотип в формате JPEG, PNG или WebP")
    data = await file.read(LOGO_MAX_BYTES + 1)
    if len(data) > LOGO_MAX_BYTES:
        raise ApiError(413, "image_too_large", "Логотип больше 2 МБ")
    if not data:
        raise ApiError(422, "empty_file", "Файл пустой")
    from ..services.uploads import sniff

    real = sniff(data)  # заявленному типу не верим: внутри должна быть картинка того же формата
    if real not in LOGO_TYPES:
        raise ApiError(415, "unsupported_image", "Загрузите логотип в формате JPEG, PNG или WebP")
    ext = LOGO_TYPES[real]
    w = current.workshop
    before = w.logo_url
    _drop_logo(w, storage)
    stored = storage.save(f"workshops/{w.id}/logo/{uuid.uuid4().hex}.{ext}", data, real)
    w.logo_url, w.logo_key = stored.url, stored.key
    log_action(db, actor_type="user", actor_id=current.user.id, workshop_id=w.id, entity="workshop", entity_id=w.id,
               action="upload_logo", before={"logo_url": before}, after={"logo_url": w.logo_url})
    db.commit()
    return workshop_out(w, True)


@router.delete("/logo", response_model=WorkshopOwnerOut, summary="Убрать логотип цеха (владелец)")
def delete_logo(current: OwnerDep, db: DbDep, storage: StorageDep) -> WorkshopOut:
    w = current.workshop
    before = w.logo_url
    _drop_logo(w, storage)
    log_action(db, actor_type="user", actor_id=current.user.id, workshop_id=w.id, entity="workshop", entity_id=w.id,
               action="delete_logo", before={"logo_url": before}, after={"logo_url": None})
    db.commit()
    return workshop_out(w, True)


@router.get("/pricing", response_model=PricingOut, summary="Цены и наценки цеха (владелец)")
def get_pricing(current: OwnerDep) -> Workshop:
    return current.workshop


@router.patch("/pricing", response_model=PricingOut, summary="Изменить цены, наценки и виды сметы (владелец)")
def update_pricing(body: PricingUpdateIn, current: OwnerDep, db: DbDep) -> Workshop:
    """Каждое изменение пишется в журнал действий: что было и что стало."""
    w = current.workshop
    before = pricing_dict(w)
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is None:
            raise ApiError(422, "validation_error", f"Поле «{k}» не может быть пустым")
        setattr(w, k, [x.value for x in v] if k == "employee_estimate_views" else v)
    log_action(
        db, actor_type="user", actor_id=current.user.id, workshop_id=w.id, entity="workshop_pricing",
        entity_id=w.id, action="update", before=before, after=pricing_dict(w),
    )
    db.commit()
    return w


@router.get("/employees", response_model=list[EmployeeOut], summary="Сотрудники цеха")
def list_employees(current: CurrentDep, db: DbDep) -> list[User]:
    return list(db.scalars(select(User).where(User.workshop_id == current.workshop.id, User.deleted_at.is_(None))
                           .order_by(User.created_at)))


def _invite(body: EmployeeIn, current, db) -> InviteOut:
    phone = normalize_phone(body.phone)
    inv = create_or_refresh_invite(db, current.workshop, current.user, phone, body.name, body.title,
                                   body.can_see_cost, body.can_order)
    log_action(
        db, actor_type="user", actor_id=current.user.id, workshop_id=current.workshop.id, entity="invite",
        entity_id=inv.id, action="invite_employee",
        after={"title": body.title, "can_see_cost": body.can_see_cost, "can_order": body.can_order},
    )
    db.commit()
    return invite_out(db, inv)


@router.post("/employees", response_model=InviteOut, status_code=201, summary="Пригласить сотрудника (владелец)")
def add_employee(body: EmployeeIn, current: OwnerDep, db: DbDep) -> InviteOut:
    """Создаёт приглашение на 7 дней (как POST /invites). Сотрудник входит по своему номеру и принимает его.
    Номер, который уже работает в цехе, пригласить нельзя (409 phone_taken)."""
    return _invite(body, current, db)


@router.post("/invites", response_model=InviteOut, status_code=201, summary="Пригласить сотрудника (владелец)")
def create_invite(body: EmployeeIn, current: OwnerDep, db: DbDep) -> InviteOut:
    """Повторное приглашение того же номера обновляет действующее (новые 7 дней)."""
    return _invite(body, current, db)


@router.get("/invites", response_model=list[InviteOut], summary="Ожидающие приглашения (владелец)")
def list_invites(current: OwnerDep, db: DbDep) -> list[InviteOut]:
    """Отправленные и устаревшие (status=expired); принятые и отменённые не показываются."""
    rows = db.scalars(select(Invite).where(Invite.workshop_id == current.workshop.id, Invite.status == "pending")
                      .order_by(Invite.created_at.desc()))
    return [invite_out(db, inv) for inv in rows]


def _owned_invite(db, current, invite_id: uuid.UUID) -> Invite:
    inv = db.get(Invite, invite_id)
    if inv is None or inv.workshop_id != current.workshop.id or inv.status != "pending":
        raise not_found("Приглашение")
    return inv


@router.post("/invites/{invite_id}/resend", response_model=InviteOut, summary="Отправить приглашение заново (ещё 7 дней)")
def resend_invite(invite_id: uuid.UUID, current: OwnerDep, db: DbDep) -> InviteOut:
    inv = _owned_invite(db, current, invite_id)
    now = utcnow()
    inv.sent_at, inv.expires_at = now, now + timedelta(days=INVITE_DAYS)
    send_invite(inv, current.workshop)
    db.commit()
    return invite_out(db, inv)


@router.delete("/invites/{invite_id}", response_model=Ok, summary="Отменить приглашение")
def cancel_invite(invite_id: uuid.UUID, current: OwnerDep, db: DbDep) -> Ok:
    inv = _owned_invite(db, current, invite_id)
    inv.status, inv.decided_at = "cancelled", utcnow()
    db.commit()
    return Ok()


@router.patch("/employees/{user_id}", response_model=EmployeeOut, summary="Права и должность сотрудника (владелец)")
def update_employee(user_id: uuid.UUID, body: EmployeeUpdateIn, current: OwnerDep, db: DbDep) -> User:
    user = db.get(User, user_id)
    if user is None or user.workshop_id != current.workshop.id or user.deleted_at is not None:
        raise not_found("Сотрудник")
    if user.role == Role.owner:
        raise ApiError(409, "cannot_change_owner", "Владелец видит и может всё")
    fields = ("title", "can_see_cost", "can_order")
    before = {k: getattr(user, k) for k in fields}
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None or k == "title":
            setattr(user, k, v)
    log_action(
        db, actor_type="user", actor_id=current.user.id, workshop_id=current.workshop.id, entity="user",
        entity_id=user.id, action="update_employee", before=before, after={k: getattr(user, k) for k in fields},
    )
    db.commit()
    return user


@router.delete("/employees/{user_id}", response_model=Ok, summary="Отключить сотрудника (владелец)")
def remove_employee(user_id: uuid.UUID, current: OwnerDep, db: DbDep) -> Ok:
    user = db.get(User, user_id)
    if user is None or user.workshop_id != current.workshop.id:
        raise not_found("Сотрудник")
    if user.role == Role.owner:
        raise ApiError(409, "cannot_remove_owner", "Владельца цеха отключить нельзя")
    user.is_active = False
    now = utcnow()
    for rt in db.scalars(select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))):
        rt.revoked_at = now
    log_action(
        db, actor_type="user", actor_id=current.user.id, workshop_id=current.workshop.id, entity="user",
        entity_id=user.id, action="deactivate_employee", before={"is_active": True}, after={"is_active": False},
    )
    db.commit()
    return Ok()


@router.get("/action-log", response_model=list[ActionLogOut], summary="Журнал изменений цен и настроек (владелец)")
def action_log(
    current: OwnerDep, db: DbDep, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)
) -> list[ActionLog]:
    return list(
        db.scalars(
            select(ActionLog)
            .where(ActionLog.workshop_id == current.workshop.id)
            .order_by(ActionLog.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    )
