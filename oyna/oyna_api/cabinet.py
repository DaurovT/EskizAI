"""Веб-кабинет цен (S14, shapes_contract.md §10): сервер отдаёт страницу сам — GET /cabinet, без сборки фронта.

Вход — кодом из SMS (те же /auth/request-code и /auth/verify-code). Токены — в httpOnly-cookie:
  oyna_at — access (path /, живёт как access-токен), oyna_rt — refresh (path /cabinet, ротация), oyna_csrf — для JS.
Изменяющие запросы с cookie-сессией (и здесь, и в /oyna/company/…) проверяются на CSRF: заголовок X-CSRF-Token
должен совпасть с cookie oyna_csrf (double-submit), Origin — свой хост. Кабинет — для владельца и менеджера.
"""
from __future__ import annotations

import secrets

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from . import auth, store
from .auth import ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE, check_csrf, companies_of, decode, issue
from .settings import settings

router = APIRouter(prefix="/cabinet", tags=["кабинет цен"])
CAB_ROLES = ("owner", "manager")
NO_ACCESS = "Кабинет цен — для владельца и менеджера цеха"


class CompanyIn(BaseModel):
    company_id: str


def _secure() -> bool:
    return settings().env == "prod"


def _set_session(resp, tokens: dict) -> None:
    s = settings()
    resp.set_cookie(ACCESS_COOKIE, tokens["access_token"], max_age=s.access_ttl_min * 60, httponly=True, secure=_secure(),
                    samesite="lax", path="/")
    resp.set_cookie(REFRESH_COOKIE, tokens["refresh_token"], max_age=s.refresh_ttl_days * 86400, httponly=True,
                    secure=_secure(), samesite="lax", path="/cabinet")


def _clear(resp) -> None:
    resp.delete_cookie(ACCESS_COOKIE, path="/", secure=_secure(), httponly=True, samesite="lax")
    resp.delete_cookie(REFRESH_COOKIE, path="/cabinet", secure=_secure(), httponly=True, samesite="lax")


def _revoke(c, refresh: str | None) -> None:
    if not refresh:
        return
    try:
        p = decode(settings(), refresh, "refresh")
    except HTTPException:
        return
    c.execute("UPDATE refresh_tokens SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL", (p["jti"],))


def _allowed(comps: list[dict]) -> list[dict]:
    return [x for x in comps if x["role"] in CAB_ROLES]


def _pick(c, tokens: dict, user_id: str, want: str | None = None) -> dict:
    """Токены на цех, где пользователь — владелец или менеджер (want — выбранный цех)."""
    allowed = _allowed(tokens["companies"])
    if not allowed:
        _revoke(c, tokens["refresh_token"])
        raise HTTPException(403, NO_ACCESS)
    ids = [x["id"] for x in allowed]
    cid = want if want in ids else tokens["company_id"] if tokens["company_id"] in ids else ids[0]
    if want and want not in ids:
        raise HTTPException(403, "Нет доступа к этому цеху")
    if cid != tokens["company_id"]:
        _revoke(c, tokens["refresh_token"])
        tokens = issue(c, settings(), user_id, cid)
    return dict(tokens, companies=allowed)


def _json(data: dict, tokens: dict | None = None, status: int = 200) -> JSONResponse:
    resp = JSONResponse(data, status_code=status)
    if tokens:
        _set_session(resp, tokens)
    return resp


@router.get("", response_class=HTMLResponse, include_in_schema=False)
def cabinet_page(request: Request):
    from .cabinet_page import page
    resp = HTMLResponse(page())
    if not request.cookies.get(CSRF_COOKIE):
        resp.set_cookie(CSRF_COOKIE, secrets.token_urlsafe(32), max_age=30 * 86400, httponly=False, secure=_secure(),
                        samesite="lax", path="/")
    resp.headers.update({"Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
                         "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'none'"})
    return resp


@router.get("/session", summary="Кто вошёл: пользователь, цех, роль, доступные цеха")
def session(request: Request):
    tok = request.cookies.get(ACCESS_COOKIE)
    if not tok:
        raise HTTPException(401, "Войдите по номеру телефона")
    p = decode(settings(), tok, "access")
    with auth._db() as c:
        u = c.execute("SELECT id, phone, name FROM users WHERE id = %s", (p["sub"],)).fetchone()
        if not u:
            raise HTTPException(401, "Пользователь удалён")
        comps = companies_of(c, p["sub"])
        cur = next((x for x in comps if x["id"] == p.get("cid")), None)
        if not cur or cur["role"] not in CAB_ROLES:
            raise HTTPException(403, NO_ACCESS)
        co = c.execute("SELECT demo_prices, usd_rate FROM companies WHERE id = %s", (cur["id"],)).fetchone()
    return {"user": {"phone": u["phone"], "name": u["name"]}, "company": {**cur, "demo_prices": co["demo_prices"],
            "usd_rate": float(co["usd_rate"]) if co["usd_rate"] else None}, "role": cur["role"],
            "companies": _allowed(comps), "env": settings().env}


@router.post("/login/request", summary="Код входа в кабинет (SMS)")
def login_request(body: auth.PhoneIn, request: Request):
    check_csrf(request)
    return auth.request_code(body, request)


@router.post("/login/verify", summary="Войти в кабинет кодом")
def login_verify(body: auth.VerifyIn, request: Request):
    check_csrf(request)
    tokens = auth.verify_code(body)
    p = decode(settings(), tokens["access_token"], "access")
    with auth._db() as c:
        tokens = _pick(c, tokens, p["sub"])
        c.commit()
    return _json({"ok": True, "company_id": tokens["company_id"], "companies": tokens["companies"],
                  "choose": len(tokens["companies"]) > 1}, tokens)


@router.post("/session/company", summary="Выбрать цех (если их несколько)")
def choose_company(body: CompanyIn, request: Request):
    check_csrf(request)
    tok = request.cookies.get(ACCESS_COOKIE)
    if not tok:
        raise HTTPException(401, "Войдите по номеру телефона")
    p = decode(settings(), tok, "access")
    with auth._db() as c:
        comps = companies_of(c, p["sub"])
        if not any(x["id"] == body.company_id and x["role"] in CAB_ROLES for x in comps):
            raise HTTPException(403, "Нет доступа к этому цеху")
        _revoke(c, request.cookies.get(REFRESH_COOKIE))
        tokens = issue(c, settings(), p["sub"], body.company_id)
    return _json({"ok": True, "company_id": body.company_id}, tokens)


@router.post("/refresh", summary="Продлить сессию кабинета (refresh из cookie, ротация)")
def refresh(request: Request):
    check_csrf(request)
    rt = request.cookies.get(REFRESH_COOKIE)
    if not rt:
        raise HTTPException(401, "Войдите по номеру телефона")
    try:
        tokens = auth.refresh(auth.RefreshIn(refresh_token=rt))
    except HTTPException as e:
        resp = _json({"detail": e.detail}, status=e.status_code)
        _clear(resp)
        return resp
    p = decode(settings(), tokens["access_token"], "access")
    with auth._db() as c:
        tokens = _pick(c, tokens, p["sub"])
    return _json({"ok": True, "company_id": tokens["company_id"]}, tokens)


@router.post("/logout", summary="Выйти из кабинета")
def logout(request: Request):
    check_csrf(request)
    if store.dsn():
        with auth._db() as c:
            _revoke(c, request.cookies.get(REFRESH_COOKIE))
    resp = _json({"ok": True})
    _clear(resp)
    return resp
