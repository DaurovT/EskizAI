"""Загруженные пользователями файлы: тип по содержимому и безопасная отдача.

- Тип файла определяется по первым байтам (PNG, JPEG, WebP, GIF, HEIC, PDF); заявленному клиентом типу
  не верим: «картинка», которая не картинка, и всё, что браузер может исполнить (HTML, SVG, XML, JS),
  сохраняется как `application/octet-stream`.
- Имя в ключе хранилища — только ASCII-буквы, цифры, `._-`, расширение — из белого списка (иначе `.bin`).
- Отдача (`file_response`): прямо в браузере открываются только PNG/JPEG/WebP (по содержимому), остальное —
  `Content-Disposition: attachment`; всегда `X-Content-Type-Options: nosniff` и `Content-Security-Policy: sandbox`.
"""

import os
import re
from pathlib import PurePosixPath
from urllib.parse import quote

from fastapi.responses import Response
from starlette.staticfiles import StaticFiles

OCTET = "application/octet-stream"
INLINE_TYPES = {"image/png", "image/jpeg", "image/webp"}
SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"}
# Типы, которые браузер может исполнить или отрисовать со скриптами — им не доверяем никогда
_ACTIVE = ("text/html", "application/xhtml", "image/svg", "text/xml", "application/xml", "javascript",
           "ecmascript", "text/css", "multipart/", "message/", "application/x-shockwave")
SAFE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "pdf", "dxf", "dwg", "zip", "rar", "7z",
                   "xlsx", "xls", "docx", "doc", "csv", "txt", "stl", "obj", "step", "stp", "b3d", "bz2", "gz"}


def sniff(data: bytes) -> str | None:
    """Тип по сигнатуре или None."""
    head = data[:16]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"hevc", b"heim", b"heis", b"mif1", b"msf1"):
        return "image/heic"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    return None


def safe_content_type(data: bytes, claimed: str | None) -> str:
    """Тип для сохранения: по содержимому; иначе заявленный, если он не картинка и не исполняемый в браузере."""
    found = sniff(data)
    if found:
        return found
    ct = (claimed or "").split(";", 1)[0].strip().lower()[:100]
    if not ct or "/" not in ct or ct.startswith("image/") or any(a in ct for a in _ACTIVE):
        return OCTET
    if ct.startswith("text/") and ct not in ("text/plain", "text/csv"):
        return OCTET
    return ct


def key_name(name: str | None) -> str:
    """Имя для ключа хранилища: ASCII без спецсимволов, расширение из белого списка, иначе `.bin`."""
    p = PurePosixPath((name or "file").replace("\\", "/")).name
    stem, dot, ext = p.rpartition(".")
    if not dot:
        stem, ext = p, ""
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", stem).strip("_")[:80] or "file"
    ext = ext.lower()
    return f"{stem}.{ext if ext in SAFE_EXTENSIONS else 'bin'}"


def display_name(name: str | None) -> str:
    """Имя для показа и скачивания: без путей и управляющих символов."""
    p = PurePosixPath((name or "file").replace("\\", "/")).name
    p = "".join(ch for ch in p if ch.isprintable() and ch not in '"<>')
    return p.strip()[:200] or "file"


def content_disposition(name: str, *, inline: bool = False) -> str:
    name = display_name(name)
    ascii_name = name.encode("ascii", "ignore").decode().replace('"', "") or "file"
    return f"{'inline' if inline else 'attachment'}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def file_response(data: bytes, name: str, content_type: str | None = None, *,
                  headers: dict[str, str] | None = None) -> Response:
    """Отдать сохранённый файл: тип — по содержимому; inline — только PNG/JPEG/WebP."""
    found = sniff(data)
    if found in INLINE_TYPES:
        media_type, inline = found, True
    else:
        media_type = found or safe_content_type(data, content_type)
        inline = False
    return Response(content=data, media_type=media_type,
                    headers={"Content-Disposition": content_disposition(name, inline=inline), **SECURITY_HEADERS,
                             **(headers or {})})


def download_response(data: bytes, name: str, media_type: str, *, headers: dict[str, str] | None = None) -> Response:
    """Отдать файл, собранный сервером (PDF, CSV, DXF): всегда как вложение, `nosniff`."""
    return Response(content=data, media_type=media_type,
                    headers={"Content-Disposition": content_disposition(name), "X-Content-Type-Options": "nosniff",
                             **(headers or {})})


# --- Статика /media и /static/textures ---

_INLINE_EXT = {".png", ".jpg", ".jpeg", ".webp"}


class PublicMedia(StaticFiles):
    """StaticFiles с заголовками защиты; закрытая зона (`blocked`, напр. MEDIA_DIR/private) не отдаётся никогда.

    Сравнение путей — после realpath и без учёта регистра (macOS/Windows: `PRIVATE/` = `private/`).
    Всё, кроме PNG/JPEG/WebP, — `Content-Disposition: attachment`."""

    def __init__(self, *, directory, blocked=None, **kw):
        super().__init__(directory=directory, **kw)
        self._blocked = os.path.normcase(os.path.realpath(blocked)).lower() if blocked is not None else None

    def lookup_path(self, path: str):
        full_path, stat_result = super().lookup_path(path)
        if full_path and self._blocked is not None:
            real = os.path.normcase(os.path.realpath(full_path)).lower()
            if real == self._blocked or real.startswith(self._blocked + os.sep):
                return "", None
        return full_path, stat_result

    def file_response(self, full_path, stat_result, scope, status_code: int = 200):
        resp = super().file_response(full_path, stat_result, scope, status_code)
        for k, v in SECURITY_HEADERS.items():
            resp.headers[k] = v
        if os.path.splitext(str(full_path))[1].lower() not in _INLINE_EXT:
            resp.headers["Content-Disposition"] = "attachment"
        return resp
