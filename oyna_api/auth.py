"""Вход по коду из SMS (S01) и контекст запроса: пользователь, цех, роль.

Как в Eskiz Temir: код (5 цифр, 5 минут, 5 попыток, повтор через 60 с, не больше 5 в час) → access (30 мин)
и refresh (30 дней, ротация). В access-токене — текущий цех; роль берётся из company_members при каждом запросе,
чтобы снятый доступ действовал сразу. SMS — через Eskiz (notify.eskiz.uz); в разработке код пишется в лог.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
import jwt
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from oyna_core.data import Company

from . import store
from .settings import Settings, settings

log = logging.getLogger("oyna_api.auth")
router = APIRouter(prefix="/auth", tags=["вход"])
ROLES = ("owner", "manager", "measurer", "installer", "production")


def now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------- телефон и код ----------------
def normalize_phone(raw: str) -> str:
    d = re.sub(r"\D", "", raw or "")
    if len(d) == 9:
        d = "998" + d
    if not (len(d) == 12 and d.startswith("998")):
        raise HTTPException(422, "Номер в формате +998 XX XXX XX XX")
    return "+" + d


def hash_code(s: Settings, phone: str, code: str) -> str:
    return hmac.new(s.jwt_secret.encode(), f"{phone}:{code}".encode(), hashlib.sha256).hexdigest()


class DevSender:
    sent: list[tuple[str, str]] = []

    def send(self, phone: str, code: str) -> None:
        DevSender.sent.append((phone, code))
        log.warning("Код входа для %s: %s", phone, code)


class EskizSender:
    """SMS через Eskiz: вход (email+пароль) → токен в памяти процесса; на 401 — один повторный вход."""
    _token: str | None = None
    _lock = threading.Lock()

    def __init__(self, s: Settings):
        self.s = s
        self.http = httpx.Client(base_url=s.eskiz_base_url, timeout=15)

    def _login(self) -> str:
        r = self.http.post("/api/auth/login", data={"email": self.s.eskiz_email, "password": self.s.eskiz_password})
        tok = (r.json().get("data") or {}).get("token") if r.status_code == 200 else None
        if not tok:
            log.error("Eskiz: вход не удался %s %s", r.status_code, r.text[:200])
            raise HTTPException(503, "Не удалось отправить SMS. Попробуйте чуть позже")
        return tok

    def send(self, phone: str, code: str) -> None:
        text = self.s.eskiz_template.format(code=code)
        for attempt in (1, 2):
            with self._lock:
                if EskizSender._token is None or attempt == 2:
                    EskizSender._token = self._login()
                tok = EskizSender._token
            try:
                r = self.http.post("/api/message/sms/send", headers={"Authorization": f"Bearer {tok}"},
                                   data={"mobile_phone": phone.lstrip("+"), "message": text, "from": self.s.eskiz_sender})
            except httpx.HTTPError as e:
                raise HTTPException(503, "Не удалось отправить SMS. Попробуйте чуть позже") from e
            if r.status_code != 401:
                break
        if r.status_code >= 300:
            log.error("Eskiz: отправка не удалась %s %s", r.status_code, r.text[:200])
            raise HTTPException(503, "Не удалось отправить SMS. Попробуйте чуть позже")


def sender(s: Settings):
    return EskizSender(s) if s.code_provider == "eskiz" else DevSender()


# ---------------- токены ----------------
def access_token(s: Settings, user_id: str, company_id: str | None) -> str:
    return jwt.encode({"sub": user_id, "cid": company_id, "typ": "access",
                       "exp": now() + timedelta(minutes=s.access_ttl_min)}, s.jwt_secret, "HS256")


def refresh_token(s: Settings, user_id: str, jti: str, exp: datetime) -> str:
    return jwt.encode({"sub": user_id, "jti": jti, "typ": "refresh", "exp": exp}, s.jwt_secret, "HS256")


def decode(s: Settings, token: str, typ: str) -> dict:
    try:
        p = jwt.decode(token, s.jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Сессия истекла")
    except jwt.PyJWTError:
        raise HTTPException(401, "Неверный токен")
    if p.get("typ") != typ:
        raise HTTPException(401, "Неверный токен")
    return p


def companies_of(c, user_id: str) -> list[dict]:
    return [{"id": str(r["id"]), "name": r["name"], "role": r["role"]} for r in c.execute(
        "SELECT co.id, co.name, m.role FROM company_members m JOIN companies co ON co.id = m.company_id "
        "WHERE m.user_id = %s ORDER BY co.created_at", (user_id,))]


def issue(c, s: Settings, user_id: str, company_id: str | None) -> dict:
    comps = companies_of(c, user_id)
    if company_id is None and comps:
        company_id = comps[0]["id"]
    exp = now() + timedelta(days=s.refresh_ttl_days)
    jti = str(c.execute("INSERT INTO refresh_tokens (user_id, company_id, expires_at) VALUES (%s,%s,%s) RETURNING id",
                        (user_id, company_id, exp)).fetchone()["id"])
    return {"access_token": access_token(s, user_id, company_id), "refresh_token": refresh_token(s, user_id, jti, exp),
            "expires_in": s.access_ttl_min * 60, "company_id": company_id, "companies": comps,
            "needs_onboarding": not comps}


# ---------------- эндпоинты ----------------
class PhoneIn(BaseModel):
    phone: str


class VerifyIn(PhoneIn):
    code: str


class RefreshIn(BaseModel):
    refresh_token: str


class SwitchIn(BaseModel):
    company_id: str


def _db():
    if not store.dsn():
        raise HTTPException(503, "хранение не настроено (OYNA_DSN)")
    return store.conn()


@router.post("/request-code", summary="Запросить код входа")
def request_code(body: PhoneIn, request: Request):
    s = settings()
    phone = normalize_phone(body.phone)
    with _db() as c:
        last = c.execute("SELECT created_at FROM auth_codes WHERE phone = %s ORDER BY created_at DESC LIMIT 1", (phone,)).fetchone()
        if last and (now() - last["created_at"]).total_seconds() < s.code_resend_s:
            wait = s.code_resend_s - int((now() - last["created_at"]).total_seconds())
            raise HTTPException(429, f"Новый код можно запросить через {wait} с")
        n = c.execute("SELECT count(*) AS n FROM auth_codes WHERE phone = %s AND created_at > now() - interval '1 hour'",
                      (phone,)).fetchone()["n"]
        if n >= s.code_max_per_hour:
            raise HTTPException(429, "Слишком много запросов кода. Попробуйте через час")
        code = "".join(secrets.choice("0123456789") for _ in range(s.code_length))
        c.execute("INSERT INTO auth_codes (phone, code_hash, ip, expires_at) VALUES (%s,%s,%s,%s)",
                  (phone, hash_code(s, phone, code), request.client.host if request.client else None,
                   now() + timedelta(seconds=s.code_ttl_s)))
        sender(s).send(phone, code)
    return {"phone": phone, "expires_in": s.code_ttl_s, "resend_in": s.code_resend_s, "length": s.code_length}


@router.post("/verify-code", summary="Подтвердить код и войти")
def verify_code(body: VerifyIn):
    s = settings()
    phone = normalize_phone(body.phone)
    with _db() as c:
        row = c.execute("SELECT * FROM auth_codes WHERE phone = %s AND consumed_at IS NULL AND expires_at > now() "
                        "ORDER BY created_at DESC LIMIT 1 FOR UPDATE", (phone,)).fetchone()
        dev_ok = s.env == "dev" and s.code_provider == "dev" and body.code == s.dev_code
        if not row and not dev_ok:
            raise HTTPException(400, "Код истёк — запросите новый")
        if row and not dev_ok:
            if row["attempts"] >= s.code_max_attempts:
                raise HTTPException(429, "Слишком много попыток — запросите новый код")
            if not hmac.compare_digest(row["code_hash"], hash_code(s, phone, body.code.strip())):
                c.execute("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = %s", (row["id"],))
                c.commit()
                left = s.code_max_attempts - row["attempts"] - 1
                raise HTTPException(400, f"Неверный код. Осталось попыток: {left}")
        if row:
            c.execute("UPDATE auth_codes SET consumed_at = now() WHERE id = %s", (row["id"],))
        u = c.execute("SELECT id FROM users WHERE phone = %s", (phone,)).fetchone()
        is_new = u is None
        if is_new:
            u = c.execute("INSERT INTO users (phone) VALUES (%s) RETURNING id", (phone,)).fetchone()
        return dict(issue(c, s, str(u["id"]), None), is_new=is_new)


@router.post("/refresh", summary="Обновить токены (старый refresh отзывается)")
def refresh(body: RefreshIn):
    s = settings()
    p = decode(s, body.refresh_token, "refresh")
    with _db() as c:
        rt = c.execute("UPDATE refresh_tokens SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL "
                       "AND expires_at > now() RETURNING *", (p["jti"],)).fetchone()
        if not rt:
            raise HTTPException(401, "Сессия завершена — войдите заново")
        cid = str(rt["company_id"]) if rt["company_id"] else None
        if cid and not any(x["id"] == cid for x in companies_of(c, p["sub"])):
            cid = None                                     # доступ к цеху закрыли
        return issue(c, s, p["sub"], cid)


@router.post("/logout", summary="Выйти")
def logout(body: RefreshIn):
    p = decode(settings(), body.refresh_token, "refresh")
    with _db() as c:
        c.execute("UPDATE refresh_tokens SET revoked_at = now() WHERE id = %s", (p["jti"],))
    return {"ok": True}


@router.post("/switch-company", summary="Переключить цех (если состоите в нескольких)")
def switch_company(body: SwitchIn, authorization: str | None = Header(None)):
    s = settings()
    p = decode(s, (authorization or "").removeprefix("Bearer ").strip(), "access")
    with _db() as c:
        if not any(x["id"] == body.company_id for x in companies_of(c, p["sub"])):
            raise HTTPException(403, "Нет доступа к этому цеху")
        return issue(c, s, p["sub"], body.company_id)


@router.get("/me", summary="Текущий пользователь и цеха")
def me(authorization: str | None = Header(None)):
    p = decode(settings(), (authorization or "").removeprefix("Bearer ").strip(), "access")
    with _db() as c:
        u = c.execute("SELECT id, phone, name FROM users WHERE id = %s", (p["sub"],)).fetchone()
        if not u:
            raise HTTPException(401, "Пользователь удалён")
        return {"id": str(u["id"]), "phone": u["phone"], "name": u["name"], "company_id": p.get("cid"),
                "companies": companies_of(c, p["sub"])}


# ---------------- контекст запроса ----------------
@dataclass
class Ctx:
    company: Company
    company_id: str | None = None                   # None — демо/боевой цех без базы (заглушки фронтенда)
    role: str = "owner"
    user_id: str | None = None


DEMO, REAL = Company.demo(), Company()


def ctx(authorization: str | None = Header(None), x_company: str | None = Header(None),
        x_role: str | None = Header(None)) -> Ctx:
    """Bearer-токен → цех и роль из базы. Без токена в dev — заголовки X-Company / X-Role."""
    s = settings()
    if authorization and authorization.startswith("Bearer "):
        p = decode(s, authorization[7:].strip(), "access")
        if not p.get("cid"):
            raise HTTPException(409, "Сначала создайте цех или выберите его")
        with _db() as c:
            m = c.execute("SELECT role FROM company_members WHERE company_id = %s AND user_id = %s",
                          (p["cid"], p["sub"])).fetchone()
            if not m:
                raise HTTPException(403, "Доступ к цеху закрыт")
            cid, co = store.load_company(c, p["cid"])
        return Ctx(co, cid, m["role"], p["sub"])
    if not s.dev_headers:
        raise HTTPException(401, "Войдите по номеру телефона")
    role = x_role if x_role in ROLES else "owner"
    comp = x_company or "demo"
    if comp in ("demo", "real") and not store.dsn():
        return Ctx(DEMO if comp == "demo" else REAL, None, role)
    if comp == "real":
        return Ctx(REAL, None, role)
    with _db() as c:
        try:
            cid, co = store.load_company(c, comp)
        except store.NotFound as e:
            raise HTTPException(404, str(e))
    return Ctx(co, cid, role)


def require(cx: Ctx, *roles: str) -> None:
    if cx.role not in roles:
        raise HTTPException(403, "Недостаточно прав")


def need_company(cx: Ctx) -> str:
    if not cx.company_id:
        raise HTTPException(503, "хранение не настроено (OYNA_DSN)")
    return cx.company_id


def new_uuid() -> str:
    return str(uuid.uuid4())
