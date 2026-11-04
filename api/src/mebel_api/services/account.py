"""Приглашения сотрудников (SCR-38a, SCR-23) и удаление аккаунта (SCR-44).

Удаление владельца стирает цех целиком: личные данные, клиентов, файлы, 3D и сметы.
Строки цеха, проектов и версий остаются пустыми «оболочками» — на них ссылаются заказы EMAN
(суммы и статусы нужны для учёта) и отозванные ссылки клиентов (страница показывает «ссылка отозвана»).
"""

import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..db import utcnow
from ..domain import Role
from ..errors import ApiError
from ..models import (
    ActionLog,
    AiSession,
    AuthCode,
    ChatMessage,
    Client,
    Device,
    FileDownload,
    Invite,
    Measurement,
    ModelVersion,
    NonstandardRequest,
    Notification,
    Order,
    PriceRequest,
    Project,
    ProjectPhoto,
    ProjectStatusChange,
    RefreshToken,
    ShareEvent,
    ShareLink,
    User,
    Workshop,
)
from ..schemas.workshops import InviteOut, InviteOwner, InviteWorkshop
from .storage import Storage

log = logging.getLogger("mebel_api.account")

INVITE_DAYS = 7
DELETED_PROJECT_TITLE = "Удалённый проект"
DELETED_WORKSHOP_NAME = "Удалённый цех"
PERSONAL_KEYS = ("phone", "name", "address", "notes", "title")


# --- приглашения ---


def invite_status(inv: Invite, now: datetime | None = None) -> str:
    if inv.status == "pending" and inv.expires_at <= (now or utcnow()):
        return "expired"
    return inv.status


def workshop_owner(db: Session, workshop_id: uuid.UUID) -> User | None:
    return db.scalar(
        select(User).where(User.workshop_id == workshop_id, User.role == Role.owner, User.deleted_at.is_(None))
        .order_by(User.created_at).limit(1)
    )


def invite_out(db: Session, inv: Invite) -> InviteOut:
    w = db.get(Workshop, inv.workshop_id)
    owner = workshop_owner(db, inv.workshop_id)
    return InviteOut(
        id=inv.id, status=invite_status(inv), phone=inv.phone, name=inv.name, title=inv.title,
        can_see_cost=inv.can_see_cost, can_order=inv.can_order,
        estimate_views=list(w.employee_estimate_views or ["total"]),
        sent_at=inv.sent_at, expires_at=inv.expires_at, created_at=inv.created_at,
        workshop=InviteWorkshop(id=w.id, name=w.name, city=w.city or ""),
        owner=InviteOwner(name=(owner.name if owner else "") or "", phone=(w.phone or (owner.phone if owner else None))),
    )


def send_invite(inv: Invite, workshop: Workshop) -> None:
    """Заглушка: текст приглашения уйдёт в SMS / Telegram при подключении провайдеров (как код входа)."""
    log.warning("Приглашение для %s в цех «%s» до %s", inv.phone, workshop.name, inv.expires_at.isoformat())


def is_free(db: Session, user: User) -> bool:
    """Номер ещё не работает ни в каком цехе: свежий владелец без сотрудников, проектов и заказов."""
    if user.role != Role.owner:
        return False
    ws = user.workshop_id
    others = db.scalar(select(func.count(User.id)).where(
        User.workshop_id == ws, User.id != user.id, User.deleted_at.is_(None)))
    if others:
        return False
    real = db.scalar(select(func.count(Project.id)).where(Project.workshop_id == ws, Project.is_example.is_(False)))
    if real:
        return False
    orders = db.scalar(select(func.count(Order.id)).join(Project, Order.project_id == Project.id)
                       .where(Project.workshop_id == ws))
    return not orders


def invite_for_user(db: Session, user: User) -> Invite | None:
    """Приглашение для экрана после входа: сначала действующее, иначе последнее устаревшее."""
    if not is_free(db, user):
        return None
    rows = list(db.scalars(
        select(Invite).join(Workshop, Invite.workshop_id == Workshop.id)
        .where(Invite.phone == user.phone, Invite.status == "pending", Invite.workshop_id != user.workshop_id,
               Workshop.deleted_at.is_(None), Workshop.blocked.is_(False))
        .order_by(Invite.sent_at.desc())
    ))
    now = utcnow()
    for inv in rows:
        if inv.expires_at > now:
            return inv
    return rows[0] if rows else None


def create_or_refresh_invite(db: Session, workshop: Workshop, actor: User, phone: str, name: str,
                             title: str | None, can_see_cost: bool, can_order: bool) -> Invite:
    existing = db.scalar(select(User).where(User.phone == phone))
    if existing is not None:
        if existing.workshop_id == workshop.id:
            raise ApiError(409, "phone_taken", "Этот номер уже в вашем цехе")
        if not is_free(db, existing):
            raise ApiError(409, "phone_taken", "Этот номер уже работает в другом цехе. Один номер — один аккаунт")
    now = utcnow()
    inv = db.scalar(select(Invite).where(Invite.workshop_id == workshop.id, Invite.phone == phone,
                                         Invite.status == "pending"))
    if inv is None:
        inv = Invite(workshop_id=workshop.id, phone=phone, status="pending")
        db.add(inv)
    inv.name, inv.title, inv.can_see_cost, inv.can_order = name, title, can_see_cost, can_order
    inv.invited_by = actor.id
    inv.sent_at, inv.expires_at = now, now + timedelta(days=INVITE_DAYS)
    db.flush()
    send_invite(inv, workshop)
    return inv


def accept_invite(db: Session, storage: Storage, user: User, inv: Invite) -> None:
    """Пользователь переходит в цех приглашения; его пустой цех (созданный при входе) удаляется."""
    if not is_free(db, user):
        raise ApiError(409, "invite_busy", "Ваш номер уже работает в своём цехе — принять приглашение нельзя")
    old_ws = user.workshop_id
    now = utcnow()
    user.workshop_id = inv.workshop_id
    user.role = Role.employee
    user.title = inv.title
    user.can_see_cost, user.can_order = inv.can_see_cost, inv.can_order
    user.name = user.name or inv.name
    inv.status, inv.decided_at, inv.user_id = "accepted", now, user.id
    db.flush()
    _drop_empty_workshop(db, storage, old_ws)


def _drop_empty_workshop(db: Session, storage: Storage, workshop_id: uuid.UUID) -> None:
    """Пустой цех (только примеры) удаляется целиком — каскадом базы."""
    pids = list(db.scalars(select(Project.id).where(Project.workshop_id == workshop_id)))
    _delete_project_files(db, storage, pids)
    db.execute(update(Project).where(Project.id.in_(pids)).values(current_version_id=None, frozen_version_id=None)
               .execution_options(synchronize_session=False))
    db.execute(delete(Project).where(Project.id.in_(pids)).execution_options(synchronize_session=False))
    db.execute(delete(Workshop).where(Workshop.id == workshop_id).execution_options(synchronize_session=False))


# --- удаление аккаунта ---


def _storage_delete(storage: Storage, key: str | None) -> None:
    if not key:
        return
    try:
        storage.delete(key)
    except Exception:  # noqa: BLE001 — файл мог уже исчезнуть; данные в базе всё равно стираем
        log.warning("Не удалось удалить файл %s", key)


def _delete_project_files(db: Session, storage: Storage, pids: list[uuid.UUID]) -> int:
    """Файлы всех проектов цеха. Фото с нескольких объектов делят один ключ (только внутри цеха) —
    поэтому вызываем для всех проектов цеха сразу и удаляем каждый ключ один раз."""
    if not pids:
        return 0
    keys = set(db.scalars(select(ProjectPhoto.storage_key).where(ProjectPhoto.project_id.in_(pids))))
    for files in db.scalars(select(NonstandardRequest.files).where(NonstandardRequest.project_id.in_(pids))):
        keys |= {(f or {}).get("key") for f in files or [] if (f or {}).get("key")}
    for key in keys:
        _storage_delete(storage, key)
    return len(keys)


def _anonymize_user(db: Session, user: User, now: datetime) -> None:
    old_phone = user.phone
    user.phone = f"del:{user.id.hex[:16]}"  # номер освобождается — с ним можно зарегистрироваться заново
    user.name, user.title = "", None
    user.can_see_cost = user.can_order = False
    user.is_active = False
    user.deleted_at = now
    for model in (RefreshToken, Device, Notification):
        db.execute(delete(model).where(model.user_id == user.id).execution_options(synchronize_session=False))
    db.execute(delete(AuthCode).where(AuthCode.phone == old_phone).execution_options(synchronize_session=False))
    db.execute(delete(Invite).where(Invite.phone == old_phone).execution_options(synchronize_session=False))


def _strip_action_log(db: Session, workshop_id: uuid.UUID) -> None:
    for entry in db.scalars(select(ActionLog).where(ActionLog.workshop_id == workshop_id)):
        for attr in ("before", "after"):
            data = getattr(entry, attr)
            if isinstance(data, dict) and any(k in data for k in PERSONAL_KEYS):
                setattr(entry, attr, {k: v for k, v in data.items() if k not in PERSONAL_KEYS})
        if entry.entity == "user" and entry.entity_id and entry.entity_id.startswith("+"):
            entry.entity_id = None  # номер сотрудника в старых записях «add_employee»


def purge_workshop(db: Session, storage: Storage, w: Workshop, now: datetime) -> dict:
    """Стирает цех владельца. Возвращает счётчики для журнала (без личных данных)."""
    users = list(db.scalars(select(User).where(User.workshop_id == w.id, User.deleted_at.is_(None))))
    for u in users:
        _anonymize_user(db, u, now)

    pids = list(db.scalars(select(Project.id).where(Project.workshop_id == w.id)))
    files = _delete_project_files(db, storage, pids)
    sync = {"synchronize_session": False}
    in_p = lambda model: model.project_id.in_(pids)  # noqa: E731

    # клиенты и всё содержимое проектов
    db.execute(update(Project).where(Project.workshop_id == w.id).values(client_id=None).execution_options(**sync))
    clients = db.execute(delete(Client).where(Client.workshop_id == w.id).execution_options(**sync)).rowcount
    for model in (ProjectPhoto, Measurement, ChatMessage, AiSession, ShareEvent, NonstandardRequest, PriceRequest,
                  FileDownload, ProjectStatusChange, Notification):
        db.execute(delete(model).where(in_p(model)).execution_options(**sync))
    db.execute(delete(Notification).where(Notification.workshop_id == w.id).execution_options(**sync))
    # ссылки клиентов: отозваны, снимок сметы стёрт — страница клиента покажет «ссылка отозвана»
    db.execute(update(ShareLink).where(in_p(ShareLink), ShareLink.revoked_at.is_(None))
               .values(revoked_at=now).execution_options(**sync))
    db.execute(update(ShareLink).where(in_p(ShareLink)).values(price_snapshot=None, created_by=None)
               .execution_options(**sync))
    # заказы EMAN остаются (суммы, статусы, оплата); заметки — долой
    orders = db.execute(update(Order).where(in_p(Order)).values(notes=None, version_id=None)
                        .execution_options(**sync)).rowcount
    # проекты и версии — пустые оболочки
    db.execute(update(Project).where(Project.id.in_(pids)).values(
        title=DELETED_PROJECT_TITLE, source_text=None, cancel_reason=None,
        current_version_id=None, frozen_version_id=None,
        deleted_at=func.coalesce(Project.deleted_at, now),
    ).execution_options(**sync))
    db.execute(update(ModelVersion).where(in_p(ModelVersion)).values(
        tree={}, viewer={}, summary={}, issues=[], module_versions={}, estimated=[], price_cache=None, label=None,
    ).execution_options(**sync))
    db.execute(delete(Invite).where(Invite.workshop_id == w.id).execution_options(**sync))
    _strip_action_log(db, w.id)

    _storage_delete(storage, w.logo_key)  # логотип цеха — тоже личные данные
    w.name, w.city, w.phone, w.logo_url = DELETED_WORKSHOP_NAME, "", None, None
    w.logo_key = None
    w.blocked = True
    w.deleted_at = now
    return {"users": len(users), "projects": len(pids), "clients": clients, "files": files, "orders_kept": orders}


def delete_account(db: Session, storage: Storage, user: User, workshop: Workshop) -> tuple[str, dict]:
    """Владелец удаляет цех целиком, сотрудник — только себя. Возвращает (scope, счётчики)."""
    now = utcnow()
    if user.role == Role.owner:
        return "workshop", purge_workshop(db, storage, workshop, now)
    _anonymize_user(db, user, now)
    return "user", {"users": 1}
