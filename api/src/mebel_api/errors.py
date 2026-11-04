"""Ошибки API. Все сообщения — по-русски, для мастера.

Формат ответа об ошибке один для всех эндпоинтов:
{"error": {"code": "illegal_transition", "message": "…", "details": …}}
"""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class ErrorBody(BaseModel):
    code: str
    message: str
    details: Any = None


class ErrorResponse(BaseModel):
    error: ErrorBody


def not_found(what: str = "Объект") -> ApiError:
    return ApiError(404, "not_found", f"{what} не найден")


def forbidden(message: str = "Недостаточно прав") -> ApiError:
    return ApiError(403, "forbidden", message)


def _body(code: str, message: str, details: Any = None) -> dict:
    return {"error": {"code": code, "message": message, "details": details}}


_HTTP_MESSAGES = {
    401: "Нужно войти заново",
    403: "Недостаточно прав",
    404: "Не найдено",
    405: "Метод не поддерживается",
    413: "Файл слишком большой",
}


def _jsonable_errors(errors: list[dict]) -> list[dict]:
    out = []
    for e in errors:
        out.append({"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")})
    return out


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=_body(exc.code, exc.message, exc.details))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=_body("validation_error", "Проверьте данные запроса", _jsonable_errors(exc.errors())),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        message = exc.detail if isinstance(exc.detail, str) and exc.status_code not in _HTTP_MESSAGES else None
        return JSONResponse(
            status_code=exc.status_code,
            content=_body(f"http_{exc.status_code}", message or _HTTP_MESSAGES.get(exc.status_code, "Ошибка запроса")),
            headers=getattr(exc, "headers", None),
        )


# Для документации OpenAPI: стандартные ответы об ошибках
ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Не выполнен вход"},
    403: {"model": ErrorResponse, "description": "Недостаточно прав"},
    404: {"model": ErrorResponse, "description": "Не найдено"},
    409: {"model": ErrorResponse, "description": "Действие недопустимо в текущем состоянии"},
    422: {"model": ErrorResponse, "description": "Неверные данные"},
}
