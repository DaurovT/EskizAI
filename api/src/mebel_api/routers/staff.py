"""Сотрудники платформы и поставщиков: вход (почта + пароль, 2FA), сессии, управление сотрудниками.

docs/staff_vendor_contract.md §2, §3, §4a. Мастера (users, вход по SMS) сюда не относятся.
"""

import re
import secrets
import uuid
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from ..db import utcnow
from ..deps import (
    DbDep,
    SettingsDep,
    StaffActor,
    StaffManageDep,
    StaffSelfDep,
    mfa_required_for,
    require_reason,
)
from ..errors import ERROR_RESPONSES, ApiError, forbidden, not_found
from ..models import StaffMfa, StaffMfaChallenge, StaffRefreshToken, StaffSession, StaffUser, Supplier
from ..services import staff_auth as sa
from ..services.action_log import log_action

router = APIRouter(prefix="/staff", tags=["staff"], responses=ERROR_RESPONSES)

INVALID = "Неверная почта или пароль. После 5 ошибок подряд вход закрывается на 15 минут"
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")


def _norm_email(email: str) -> str:
    e = (email or "").strip().lower()
    if not _EMAIL.match(e) or len(e) > 254:
        raise ApiError(422, "invalid_email", "Проверьте адрес почты")
    return e


def _client(request: Request) -> tuple[str | None, str | None]:
    """IP и браузер для сессии и счётчиков входа.

    IP — только `request.client.host`: заголовок X-Forwarded-For здесь не читается (его может прислать кто угодно).
    За Caddy uvicorn запущен с `--proxy-headers` и сам подставляет в client.host адрес из X-Forwarded-For, а Caddy
    (без trusted_proxies) не принимает этот заголовок от клиента — пишет туда адрес соединения. Порт API наружу
    не открыт (docker-compose: 127.0.0.1), поэтому подделать адрес можно только с самого сервера."""
    ip = request.client.host if request.client else None
    return (ip or None) and ip[:64], (request.headers.get("user-agent") or "")[:300] or None


def _log(db, staff: StaffUser | None, action: str, after: dict | None = None, actor_id: str | None = None) -> None:
    log_action(db, actor_type="staff", actor_id=actor_id or (staff.id if staff else None), entity="staff_auth",
               entity_id=staff.id if staff else None, action=action, after=after)


def org_out(db, s: StaffUser) -> dict:
    if s.supplier_id is None:
        return {"kind": "platform", "supplier_id": None, "supplier_code": None, "supplier_name": None}
    sup = db.get(Supplier, s.supplier_id)
    return {"kind": "supplier", "supplier_id": str(s.supplier_id), "supplier_code": sup.code if sup else None,
            "supplier_name": sup.name if sup else None}


def staff_me(db, settings, s: StaffUser) -> dict:
    mfa = db.get(StaffMfa, s.id)
    enabled = mfa is not None and mfa.enabled_at is not None
    required = mfa_required_for(db, settings, s.role)
    return {"id": str(s.id), "email": s.email, "name": s.name, "role": s.role,
            "role_title": sa.ROLES.get(s.role, {}).get("title", s.role), "org": org_out(db, s),
            "permissions": sa.permissions_of(s.role), "must_change_password": s.must_change_password,
            "mfa_enabled": enabled, "mfa_required": required, "mfa_setup_required": required and not enabled}


def user_out(db, s: StaffUser) -> dict:
    mfa = db.get(StaffMfa, s.id)
    return {"id": str(s.id), "email": s.email, "name": s.name, "role": s.role,
            "role_title": sa.ROLES.get(s.role, {}).get("title", s.role), "org": org_out(db, s),
            "is_active": s.is_active, "must_change_password": s.must_change_password,
            "mfa_enabled": mfa is not None and mfa.enabled_at is not None,
            "locked": sa.staff_locked(db, s.id), "last_login_at": s.last_login_at,
            "created_at": s.created_at}


def _issue(db, settings, s: StaffUser, request: Request, session: StaffSession | None = None) -> dict:
    now = utcnow()
    if session is None:
        ip, ua = _client(request)
        session = StaffSession(staff_id=s.id, ip=ip, user_agent=ua)
        db.add(session)
        db.flush()
    session.last_seen_at = now
    jti = uuid.uuid4()
    expires = now + timedelta(days=settings.staff_refresh_ttl_days)
    db.add(StaffRefreshToken(id=jti, staff_id=s.id, session_id=session.id, expires_at=expires))
    return {"access_token": sa.create_staff_access(settings, s.id, session.id),
            "refresh_token": sa.create_staff_refresh(settings, s.id, jti, int(expires.timestamp())),
            "token_type": "bearer", "expires_in": settings.staff_access_ttl_minutes * 60}


ANON_LOG_PER_HOUR = 200  # неудачные входы по неизвестной почте: в журнал не больше стольких в час (все IP)


def _log_failure(db, settings, s: StaffUser | None, action: str, email: str, ip: str | None) -> None:
    """Неизвестная почта — в журнал только отпечаток (HMAC), не сама почта, и не больше ANON_LOG_PER_HOUR в час."""
    if s is not None:
        _log(db, s, action, {"ip": ip})
    elif sa.rate_hit(db, "anon-log", limit=ANON_LOG_PER_HOUR, window_seconds=3600) <= ANON_LOG_PER_HOUR:
        _log(db, None, action, {"email_hash": sa.email_fingerprint(settings, email), "ip": ip})
    db.commit()


def _too_many(minutes: int) -> ApiError:
    return ApiError(429, "too_many_attempts",
                    f"Слишком много неудачных попыток с вашего адреса. Попробуйте через {minutes} минут")


def _ip_gate(db, settings, kind: str, ip: str | None) -> str:
    """Не больше staff_login_ip_limit неудачных попыток с IP за окно (удачные возвращают попытку)."""
    key = sa.guard_key(settings, kind, ip)
    n = sa.rate_hit(db, key, limit=settings.staff_login_ip_limit,
                    window_seconds=settings.staff_login_ip_window_minutes * 60)
    if n > settings.staff_login_ip_limit:
        if n == settings.staff_login_ip_limit + 1:  # в журнал — один раз за окно
            _log(db, None, f"{kind}_throttled", {"ip": ip})
            db.commit()
        raise _too_many(settings.staff_login_ip_window_minutes)
    if secrets.randbelow(200) == 0:
        sa.prune_attempts(db)
        db.commit()
    return key


def revoke_sessions(db, staff_id: uuid.UUID, keep: uuid.UUID | None = None) -> int:
    """Завершает сессии сотрудника (кроме keep) и гасит выданные, но не использованные mfa_token."""
    now = utcnow()
    n = 0
    for sess in db.scalars(select(StaffSession).where(StaffSession.staff_id == staff_id,
                                                      StaffSession.revoked_at.is_(None))):
        if sess.id == keep:
            continue
        sess.revoked_at = now
        n += 1
    for t in db.scalars(select(StaffRefreshToken).where(StaffRefreshToken.staff_id == staff_id,
                                                        StaffRefreshToken.revoked_at.is_(None))):
        if keep is None or t.session_id != keep:
            t.revoked_at = now
    db.execute(update(StaffMfaChallenge).where(StaffMfaChallenge.staff_id == staff_id,
                                               StaffMfaChallenge.used_at.is_(None))
               .values(used_at=now).execution_options(synchronize_session=False))
    return n


# --- Вход ---


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=sa.MAX_PASSWORD)


@router.post("/auth/login", summary="Вход по почте и паролю")
def login(body: LoginIn, request: Request, db: DbDep, settings: SettingsDep) -> dict:
    """Ответ при неверной почте, неверном пароле и закрытом входе одинаковый — `401 invalid_credentials`.
    С 2FA — `{mfa_required: true, mfa_token}` → `POST /staff/auth/mfa`. Слишком много неудач с IP — `429`."""
    email = (body.email or "").strip().lower()[:254]
    ip, _ = _client(request)
    ip_key = _ip_gate(db, settings, "login", ip)
    s = db.scalar(select(StaffUser).where(StaffUser.email == email))
    # Блокировка — по паре «почта + IP», попытка резервируется до проверки пароля (параллельные запросы
    # сверх лимита пароль не проверяют). Для неизвестной почты — так же, чтобы ответ её не выдавал.
    key = sa.guard_key(settings, "acct", email, ip)
    n = sa.reserve_attempt(db, key, limit=settings.staff_max_failed_logins,
                           lock_seconds=settings.staff_lockout_minutes * 60, staff_id=s.id if s else None)
    if n > settings.staff_max_failed_logins:
        if s is not None:
            _log(db, s, "login_while_locked", {"ip": ip})
            db.commit()
        raise ApiError(401, "invalid_credentials", INVALID)
    ok = sa.verify_password(body.password, s.password_hash if s else None)  # время ответа не зависит от почты
    if s is None or not s.is_active or not ok:
        _log_failure(db, settings, s, "login_failed", email, ip)
        if s is not None and n == settings.staff_max_failed_logins:
            _log(db, s, "login_locked", {"ip": ip})
            db.commit()
        raise ApiError(401, "invalid_credentials", INVALID)
    sa.clear_attempts(db, key)
    sa.refund_attempt(db, ip_key)
    mfa = db.get(StaffMfa, s.id)
    if mfa is not None and mfa.enabled_at is not None:
        jti = uuid.uuid4()
        db.add(StaffMfaChallenge(id=jti, staff_id=s.id, expires_at=utcnow() + sa.MFA_TOKEN_TTL))
        db.commit()
        return {"mfa_required": True, "mfa_token": sa.create_mfa_token(settings, s.id, jti)}
    return _complete_login(db, settings, s, request)


def _complete_login(db, settings, s: StaffUser, request: Request) -> dict:
    s.failed_logins, s.locked_until, s.last_login_at = 0, None, utcnow()
    tokens = _issue(db, settings, s, request)
    ip, ua = _client(request)
    _log(db, s, "login", {"ip": ip, "user_agent": ua})
    db.commit()
    return {**tokens, "mfa_required": False, "staff": staff_me(db, settings, s)}


class MfaLoginIn(BaseModel):
    mfa_token: str
    code: str = Field(min_length=6, max_length=20, description="Код из приложения или резервный код")


def _check_second_factor(db, settings, s: StaffUser, mfa: StaffMfa, code: str) -> bool:
    """Код TOTP или резервный код. Списание — условным UPDATE: два параллельных запроса с одним кодом
    не пройдут оба (TOTP — last_step < шаг, резервный — по version)."""
    step = sa.verify_totp(mfa.secret, code, mfa.last_step)
    if step is not None:
        res = db.execute(update(StaffMfa).where(StaffMfa.staff_id == s.id,
                                                or_(StaffMfa.last_step.is_(None), StaffMfa.last_step < step))
                         .values(last_step=step, version=StaffMfa.version + 1)
                         .execution_options(synchronize_session=False))
        if res.rowcount != 1:
            return False
        db.refresh(mfa)
        return True
    h = sa.backup_code_hash(settings, code)
    for _ in range(5):  # другой запрос мог поменять запись между чтением и записью — перечитываем
        row = db.execute(select(StaffMfa.backup_codes, StaffMfa.version).where(StaffMfa.staff_id == s.id)).first()
        if row is None or h not in (row.backup_codes or []):
            return False
        left = [x for x in row.backup_codes if x != h]
        res = db.execute(update(StaffMfa).where(StaffMfa.staff_id == s.id, StaffMfa.version == row.version)
                         .values(backup_codes=left, version=StaffMfa.version + 1)
                         .execution_options(synchronize_session=False))
        if res.rowcount == 1:
            db.refresh(mfa)
            _log(db, s, "mfa_backup_code_used", {"left": len(left)})
            return True
    return False


@router.post("/auth/mfa", summary="Второй шаг входа: код из приложения-аутентификатора")
def login_mfa(body: MfaLoginIn, request: Request, db: DbDep, settings: SettingsDep) -> dict:
    """mfa_token одноразовый (гаснет после входа, сброса пароля, сброса 2FA, завершения сессий), живёт 5 минут.
    Неверный код — `401 invalid_mfa_code`; 5 неверных кодов подряд → второй шаг закрыт на 15 минут."""
    ip, _ = _client(request)
    ip_key = _ip_gate(db, settings, "mfa", ip)
    payload = sa.decode_staff_token(settings, body.mfa_token, sa.MFA_TYP)
    try:
        jti = uuid.UUID(str(payload.get("jti")))
    except ValueError:
        raise ApiError(401, "token_invalid", "Неверный токен — войдите заново")
    s = db.get(StaffUser, uuid.UUID(payload["sub"]))
    ch = db.get(StaffMfaChallenge, jti)
    mfa = db.get(StaffMfa, s.id) if s else None
    if (s is None or not s.is_active or mfa is None or mfa.enabled_at is None or ch is None
            or ch.staff_id != s.id or ch.used_at is not None or ch.expires_at < utcnow()):
        raise ApiError(401, "invalid_credentials", INVALID)
    key = sa.guard_key(settings, "mfa", str(s.id))
    n = sa.reserve_attempt(db, key, limit=settings.staff_max_failed_logins,
                           lock_seconds=settings.staff_lockout_minutes * 60, staff_id=s.id)
    if n > settings.staff_max_failed_logins:
        _log(db, s, "mfa_while_locked", {"ip": ip})
        db.commit()
        raise ApiError(401, "invalid_credentials", INVALID)
    if not _check_second_factor(db, settings, s, mfa, body.code):
        _log(db, s, "mfa_failed", {"ip": ip})
        if n == settings.staff_max_failed_logins:
            _log(db, s, "login_locked", {"ip": ip, "step": "mfa"})
        db.commit()
        raise ApiError(401, "invalid_mfa_code", "Неверный код")
    used = db.execute(update(StaffMfaChallenge).where(StaffMfaChallenge.id == jti, StaffMfaChallenge.used_at.is_(None))
                      .values(used_at=utcnow()).execution_options(synchronize_session=False))
    if used.rowcount != 1:  # тот же mfa_token уже использован параллельным запросом
        db.rollback()
        raise ApiError(401, "invalid_credentials", INVALID)
    sa.clear_attempts(db, key)
    sa.refund_attempt(db, ip_key)
    return _complete_login(db, settings, s, request)


class RefreshIn(BaseModel):
    refresh_token: str


def _refresh_row(db, settings, token: str) -> StaffRefreshToken:
    payload = sa.decode_staff_token(settings, token, sa.REFRESH_TYP)
    try:
        jti = uuid.UUID(str(payload.get("jti")))
    except ValueError:
        raise ApiError(401, "token_invalid", "Неверный токен — войдите заново")
    row = db.get(StaffRefreshToken, jti)
    if row is None or str(row.staff_id) != str(payload["sub"]):
        raise ApiError(401, "token_revoked", "Сессия завершена — войдите заново")
    return row


def _revoke_session(db, session_id: uuid.UUID | None, now) -> bool:
    """Завершает сессию и все её refresh. True — сессия была активна."""
    if session_id is None:
        return False
    res = db.execute(update(StaffSession).where(StaffSession.id == session_id, StaffSession.revoked_at.is_(None))
                     .values(revoked_at=now).execution_options(synchronize_session=False))
    db.execute(update(StaffRefreshToken).where(StaffRefreshToken.session_id == session_id,
                                               StaffRefreshToken.revoked_at.is_(None))
               .values(revoked_at=now).execution_options(synchronize_session=False))
    return res.rowcount == 1


@router.post("/auth/refresh", summary="Обновить токены (старый refresh отзывается)")
def refresh(body: RefreshIn, request: Request, db: DbDep, settings: SettingsDep) -> dict:
    """Ротация: каждый refresh — один раз. Повтор уже использованного refresh (украден?) завершает всю сессию;
    в первые секунды после ротации (параллельное обновление из двух вкладок) — просто `401 token_revoked`."""
    row = _refresh_row(db, settings, body.refresh_token)
    now = utcnow()
    if row.revoked_at is not None:
        if ((now - row.revoked_at).total_seconds() > settings.staff_refresh_reuse_grace_seconds
                and _revoke_session(db, row.session_id, now)):
            log_action(db, actor_type="staff", actor_id=row.staff_id, entity="staff_auth", entity_id=row.staff_id,
                       action="refresh_reuse", after={"session_id": str(row.session_id), "ip": _client(request)[0]})
            db.commit()
        raise ApiError(401, "token_revoked", "Сессия завершена — войдите заново")
    if row.expires_at < now:
        raise ApiError(401, "token_revoked", "Сессия завершена — войдите заново")
    s = db.get(StaffUser, row.staff_id)
    session = db.get(StaffSession, row.session_id) if row.session_id else None
    if s is None or not s.is_active or session is None or session.revoked_at is not None:
        raise ApiError(401, "staff_inactive", "Сотрудник отключён или сессия завершена")
    # Условный UPDATE: из одного refresh параллельные запросы получат не больше одной новой пары
    res = db.execute(update(StaffRefreshToken).where(StaffRefreshToken.id == row.id,
                                                     StaffRefreshToken.revoked_at.is_(None))
                     .values(revoked_at=now).execution_options(synchronize_session=False))
    if res.rowcount != 1:
        db.rollback()
        raise ApiError(401, "token_revoked", "Сессия завершена — войдите заново")
    tokens = _issue(db, settings, s, request, session)
    db.commit()
    return {"access_token": tokens["access_token"], "refresh_token": tokens["refresh_token"],
            "token_type": "bearer", "expires_in": tokens["expires_in"]}


@router.post("/auth/logout", summary="Выйти (сессия завершается)")
def logout(body: RefreshIn, db: DbDep, settings: SettingsDep) -> dict:
    try:
        row = _refresh_row(db, settings, body.refresh_token)
    except ApiError:
        return {"ok": True}
    _revoke_session(db, row.session_id, utcnow())
    db.execute(update(StaffRefreshToken).where(StaffRefreshToken.id == row.id, StaffRefreshToken.revoked_at.is_(None))
               .values(revoked_at=utcnow()).execution_options(synchronize_session=False))
    db.commit()
    return {"ok": True}


# --- Я ---


@router.get("/me", summary="Текущий сотрудник: роль, организация, права")
def me(actor: StaffSelfDep, db: DbDep, settings: SettingsDep) -> dict:
    return staff_me(db, settings, actor.staff)


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=sa.MAX_PASSWORD)
    new_password: str = Field(max_length=sa.MAX_PASSWORD)


@router.post("/me/password", summary="Сменить пароль (другие сессии завершаются)")
def change_password(body: PasswordIn, actor: StaffSelfDep, db: DbDep) -> dict:
    s = actor.staff
    if not sa.verify_password(body.current_password, s.password_hash):
        _log(db, s, "password_change_failed")
        db.commit()
        raise ApiError(403, "invalid_password", "Текущий пароль неверный")
    sa.check_password_policy(body.new_password)
    if sa.verify_password(body.new_password, s.password_hash):
        raise ApiError(422, "password_same", "Новый пароль должен отличаться от текущего")
    s.password_hash = sa.hash_password(body.new_password)
    s.must_change_password, s.password_changed_at = False, utcnow()
    revoked = revoke_sessions(db, s.id, keep=actor.session_id)
    log_action(db, actor_type="staff", actor_id=s.id, entity="staff_user", entity_id=s.id, action="password_change",
               after={"other_sessions_revoked": revoked})
    db.commit()
    return {"ok": True}


@router.post("/me/mfa/setup", summary="Начать настройку 2FA: секрет и ссылка для QR")
def mfa_setup(actor: StaffSelfDep, db: DbDep, settings: SettingsDep) -> dict:
    """Идемпотентно: повтор в течение MFA_SETUP_REUSE (двойной клик, две вкладки) возвращает тот же секрет;
    позже — новый. Одним UPSERT, без гонки на staff_mfa.staff_id."""
    s = actor.staff
    now = utcnow()
    t = StaffMfa.__table__
    stmt = sa._upsert(db, t).values(staff_id=s.id, secret=sa.new_totp_secret(), backup_codes=[], version=0,
                                    created_at=now)
    stmt = stmt.on_conflict_do_update(
        index_elements=[t.c.staff_id],
        set_={"secret": stmt.excluded.secret, "last_step": None, "backup_codes": [], "created_at": now,
              "version": t.c.version + 1},
        where=and_(t.c.enabled_at.is_(None), t.c.created_at < now - MFA_SETUP_REUSE),
    )
    db.execute(stmt)
    db.commit()
    mfa = db.execute(select(StaffMfa).where(StaffMfa.staff_id == s.id)
                     .execution_options(populate_existing=True)).scalar_one()
    if mfa.enabled_at is not None:
        raise ApiError(409, "mfa_already_enabled", "2FA уже включена")
    return {"otpauth_url": sa.otpauth_url(mfa.secret, s.email, settings.staff_mfa_issuer), "secret": mfa.secret}


MFA_SETUP_REUSE = timedelta(minutes=10)


class MfaCodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=10)


@router.post("/me/mfa/enable", summary="Включить 2FA кодом из приложения → резервные коды (показываются один раз)")
def mfa_enable(body: MfaCodeIn, actor: StaffSelfDep, db: DbDep, settings: SettingsDep) -> dict:
    s = actor.staff
    mfa = db.get(StaffMfa, s.id)
    if mfa is None:
        raise ApiError(409, "mfa_setup_missing", "Сначала начните настройку 2FA")
    if mfa.enabled_at is not None:
        raise ApiError(409, "mfa_already_enabled", "2FA уже включена")
    step = sa.verify_totp(mfa.secret, body.code, mfa.last_step)
    if step is None:
        raise ApiError(422, "invalid_mfa_code", "Неверный код — проверьте время на телефоне")
    codes = sa.new_backup_codes()
    # Условно: параллельное включение не выдаст два набора резервных кодов (действителен был бы один)
    res = db.execute(update(StaffMfa).where(StaffMfa.staff_id == s.id, StaffMfa.enabled_at.is_(None),
                                            StaffMfa.version == mfa.version)
                     .values(backup_codes=[sa.backup_code_hash(settings, c) for c in codes], enabled_at=utcnow(),
                             last_step=step, version=StaffMfa.version + 1)
                     .execution_options(synchronize_session=False))
    if res.rowcount != 1:
        db.rollback()
        raise ApiError(409, "mfa_already_enabled", "2FA уже включена")
    log_action(db, actor_type="staff", actor_id=s.id, entity="staff_user", entity_id=s.id, action="mfa_enable")
    db.commit()
    return {"backup_codes": codes}


class MfaDisableIn(BaseModel):
    password: str = Field(max_length=sa.MAX_PASSWORD)
    code: str = Field(min_length=6, max_length=20)


@router.post("/me/mfa/disable", summary="Выключить 2FA (если для роли она не обязательна)")
def mfa_disable(body: MfaDisableIn, actor: StaffSelfDep, db: DbDep, settings: SettingsDep) -> dict:
    s = actor.staff
    mfa = db.get(StaffMfa, s.id)
    if mfa is None or mfa.enabled_at is None:
        raise ApiError(409, "mfa_not_enabled", "2FA не включена")
    if mfa_required_for(db, settings, s.role):
        raise ApiError(409, "mfa_mandatory", "Для вашей роли 2FA обязательна")
    if not sa.verify_password(body.password, s.password_hash) or not _check_second_factor(db, settings, s, mfa,
                                                                                         body.code):
        db.commit()
        raise ApiError(403, "invalid_credentials", "Неверный пароль или код")
    db.delete(mfa)
    log_action(db, actor_type="staff", actor_id=s.id, entity="staff_user", entity_id=s.id, action="mfa_disable")
    db.commit()
    return {"ok": True}


def session_out(sess: StaffSession, current: uuid.UUID | None = None) -> dict:
    return {"id": str(sess.id), "ip": sess.ip, "user_agent": sess.user_agent, "created_at": sess.created_at,
            "last_seen_at": sess.last_seen_at, "revoked_at": sess.revoked_at, "active": sess.revoked_at is None,
            "current": sess.id == current}


@router.get("/me/sessions", summary="Мои входы (устройства)")
def my_sessions(actor: StaffSelfDep, db: DbDep) -> list[dict]:
    rows = db.scalars(select(StaffSession).where(StaffSession.staff_id == actor.staff.id)
                      .order_by(StaffSession.created_at.desc()).limit(50))
    return [session_out(x, actor.session_id) for x in rows]


@router.delete("/me/sessions", summary="Завершить все мои сессии, кроме текущей")
def end_my_sessions(actor: StaffSelfDep, db: DbDep) -> dict:
    n = revoke_sessions(db, actor.staff.id, keep=actor.session_id)
    log_action(db, actor_type="staff", actor_id=actor.id, entity="staff_user", entity_id=actor.id,
               action="sessions_revoke", after={"revoked": n})
    db.commit()
    return {"ok": True, "revoked": n}


# --- Сотрудники (§3) ---


# Владелец поставщика управляет только конструкторами своего поставщика; владельцев (добавить, сбросить пароль,
# отключить, сессии, 2FA) — только суперадмин платформы (§3)
VENDOR_MANAGED_ROLES = {"vendor_designer"}
VENDOR_OWNER_ONLY = "Владельцев поставщика добавляет и меняет платформа — напишите в поддержку"


def _platform_admin(actor: StaffActor) -> bool:
    return not actor.is_vendor and actor.can("staff.manage")


def _target(db, actor: StaffActor, staff_id: uuid.UUID) -> StaffUser:
    s = db.get(StaffUser, staff_id)
    if s is None:
        raise not_found("Сотрудник")
    if _platform_admin(actor):
        return s
    if actor.is_vendor and actor.can("vendor.staff") and s.supplier_id == actor.supplier_id:
        if s.role not in VENDOR_MANAGED_ROLES:
            raise forbidden(VENDOR_OWNER_ONLY)
        return s
    raise not_found("Сотрудник")  # чужие сотрудники не видны


def _check_role(db, actor: StaffActor, role: str, supplier_id: uuid.UUID | None) -> None:
    if actor.is_vendor and supplier_id != actor.supplier_id:
        raise forbidden("Владелец поставщика добавляет только сотрудников своего поставщика")
    if actor.is_vendor and role not in VENDOR_MANAGED_ROLES:
        raise forbidden(VENDOR_OWNER_ONLY)
    if role not in sa.ROLES:
        raise ApiError(422, "invalid_role", f"Роль: {', '.join(sa.ROLES)}")
    if role in sa.PLATFORM_ROLES and supplier_id is not None:
        raise ApiError(422, "invalid_role", "Роль платформы — без поставщика")
    if role in sa.VENDOR_ROLES:
        if supplier_id is None:
            raise ApiError(422, "supplier_required", "Для роли поставщика укажите supplier_id")
        if db.get(Supplier, supplier_id) is None:
            raise not_found("Поставщик")


@router.get("/users", summary="Сотрудники (суперадмин — все, владелец поставщика — свои)")
def list_users(actor: StaffManageDep, db: DbDep, supplier_id: uuid.UUID | None = None,
               scope: Literal["all", "platform", "suppliers"] = "all", q: str | None = None) -> dict:
    stmt = select(StaffUser)
    if _platform_admin(actor):
        if supplier_id:
            stmt = stmt.where(StaffUser.supplier_id == supplier_id)
        elif scope == "platform":
            stmt = stmt.where(StaffUser.supplier_id.is_(None))
        elif scope == "suppliers":
            stmt = stmt.where(StaffUser.supplier_id.is_not(None))
    elif actor.is_vendor and actor.can("vendor.staff"):
        stmt = stmt.where(StaffUser.supplier_id == actor.supplier_id)
    else:
        raise forbidden()
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where((func.lower(StaffUser.name).like(like)) | (StaffUser.email.like(like)))
    rows = list(db.scalars(stmt.order_by(StaffUser.created_at)))
    return {"items": [user_out(db, s) for s in rows], "total": len(rows)}


class StaffIn(BaseModel):
    email: str = Field(max_length=254)
    name: str = Field(min_length=1, max_length=200)
    role: str
    supplier_id: uuid.UUID | None = None


def create_staff(db, actor_id: str, *, email: str, name: str, role: str, supplier_id: uuid.UUID | None,
                 actor_type: str = "staff") -> tuple[StaffUser, str]:
    email = _norm_email(email)
    if db.scalar(select(StaffUser.id).where(StaffUser.email == email)):
        raise ApiError(409, "email_exists", "Сотрудник с такой почтой уже есть")
    password = sa.temp_password()
    s = StaffUser(email=email, name=name.strip(), role=role, supplier_id=supplier_id,
                  password_hash=sa.hash_password(password), must_change_password=True, created_by=actor_id)
    db.add(s)
    try:
        db.flush()
    except IntegrityError:  # параллельное добавление той же почты — 409, а не 500 (запрос всё равно откатится)
        db.rollback()
        raise ApiError(409, "email_exists", "Сотрудник с такой почтой уже есть")
    log_action(db, actor_type=actor_type, actor_id=actor_id, entity="staff_user", entity_id=s.id, action="create",
               after={"email": email, "role": role, "supplier_id": str(supplier_id) if supplier_id else None})
    return s, password


@router.post("/users", status_code=201, summary="Добавить сотрудника → временный пароль (показывается один раз)")
def add_user(body: StaffIn, actor: StaffManageDep, db: DbDep) -> dict:
    supplier_id = body.supplier_id
    if actor.is_vendor:
        if supplier_id is not None and supplier_id != actor.supplier_id:
            raise forbidden("Владелец поставщика добавляет только сотрудников своего поставщика")
        supplier_id = actor.supplier_id
    _check_role(db, actor, body.role, supplier_id)
    try:
        s, password = create_staff(db, actor.id, email=body.email, name=body.name, role=body.role,
                                   supplier_id=supplier_id)
    except ApiError as e:
        # Владельцу поставщика не говорим, что почта занята в другой организации (§3) — общий ответ
        if e.code == "email_exists" and actor.is_vendor:
            other = db.scalar(select(StaffUser.supplier_id).where(StaffUser.email == _norm_email(body.email)))
            if other != actor.supplier_id:
                raise ApiError(422, "cannot_create", "Не удалось добавить сотрудника с этой почтой — "
                                                     "проверьте адрес или напишите в поддержку")
        raise
    db.commit()
    return {"user": user_out(db, s), "temp_password": password}


class StaffPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    role: str | None = None
    is_active: bool | None = None
    reason: str | None = Field(None, max_length=500)


def _last_superadmin(db, s: StaffUser) -> bool:
    if s.role != "superadmin" or not s.is_active:
        return False
    others = db.scalar(select(func.count(StaffUser.id)).where(StaffUser.role == "superadmin",
                                                              StaffUser.is_active.is_(True), StaffUser.id != s.id))
    return not others


@router.patch("/users/{staff_id}", summary="Изменить имя, роль, включить/отключить")
def patch_user(staff_id: uuid.UUID, body: StaffPatch, actor: StaffManageDep, db: DbDep) -> dict:
    s = _target(db, actor, staff_id)
    data = body.model_dump(exclude_unset=True, exclude={"reason"})
    self_edit = actor.staff is not None and s.id == actor.staff.id
    if self_edit and (("is_active" in data and not data["is_active"]) or ("role" in data and data["role"] != s.role)):
        raise ApiError(409, "self_demote", "Нельзя отключить или понизить самого себя")
    if "role" in data and data["role"] != s.role:
        _check_role(db, actor, data["role"], s.supplier_id)
    if _last_superadmin(db, s) and (data.get("is_active") is False or data.get("role", "superadmin") != "superadmin"):
        raise ApiError(409, "last_superadmin", "Последнего активного суперадмина нельзя отключить или понизить")
    before = {k: getattr(s, k) for k in data}
    for k, v in data.items():
        if v is not None:
            setattr(s, k, v.strip() if isinstance(v, str) and k == "name" else v)
    if data.get("is_active") is False:
        revoke_sessions(db, s.id)
    log_action(db, actor_type="staff", actor_id=actor.id, entity="staff_user", entity_id=s.id, action="update",
               before=before, after={**{k: getattr(s, k) for k in data}, **({"reason": body.reason}
                                                                             if body.reason else {})})
    db.commit()
    return user_out(db, s)


@router.post("/users/{staff_id}/reset-password", summary="Сбросить пароль → временный пароль (один раз)")
def reset_password(staff_id: uuid.UUID, actor: StaffManageDep, db: DbDep) -> dict:
    s = _target(db, actor, staff_id)
    if actor.staff is not None and s.id == actor.staff.id:
        raise ApiError(409, "self_reset", "Свой пароль меняйте в профиле")
    password = sa.temp_password()
    s.password_hash, s.must_change_password = sa.hash_password(password), True
    s.failed_logins, s.locked_until = 0, None
    sa.clear_staff_attempts(db, s.id)
    revoke_sessions(db, s.id)
    log_action(db, actor_type="staff", actor_id=actor.id, entity="staff_user", entity_id=s.id,
               action="reset_password")
    db.commit()
    return {"temp_password": password}


@router.get("/users/{staff_id}/sessions", summary="Входы сотрудника")
def user_sessions(staff_id: uuid.UUID, actor: StaffManageDep, db: DbDep,
                  limit: int = Query(50, ge=1, le=200)) -> list[dict]:
    s = _target(db, actor, staff_id)
    rows = db.scalars(select(StaffSession).where(StaffSession.staff_id == s.id)
                      .order_by(StaffSession.created_at.desc()).limit(limit))
    return [session_out(x) for x in rows]


@router.delete("/users/{staff_id}/sessions", summary="Завершить все сессии сотрудника")
def end_user_sessions(staff_id: uuid.UUID, actor: StaffManageDep, db: DbDep) -> dict:
    s = _target(db, actor, staff_id)
    keep = actor.session_id if actor.staff is not None and s.id == actor.staff.id else None
    n = revoke_sessions(db, s.id, keep=keep)
    log_action(db, actor_type="staff", actor_id=actor.id, entity="staff_user", entity_id=s.id,
               action="sessions_revoke", after={"revoked": n})
    db.commit()
    return {"ok": True, "revoked": n}


class ReasonIn(BaseModel):
    reason: str | None = Field(None, max_length=500)


@router.post("/users/{staff_id}/mfa/reset", summary="Сбросить 2FA сотрудника (с причиной)")
def reset_mfa(staff_id: uuid.UUID, body: ReasonIn, actor: StaffManageDep, db: DbDep) -> dict:
    s = _target(db, actor, staff_id)
    reason = require_reason(actor, body.reason)
    mfa = db.get(StaffMfa, s.id)
    if mfa is not None:
        db.delete(mfa)
    revoke_sessions(db, s.id)
    log_action(db, actor_type="staff", actor_id=actor.id, entity="staff_user", entity_id=s.id, action="mfa_reset",
               after={"reason": reason})
    db.commit()
    return {"ok": True}
