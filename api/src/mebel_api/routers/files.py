"""Файлы мастера: список пакета и скачивание по одному (раздел 8 PRD); доступ — раздел 9."""

import uuid
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import Response

from ..deps import CurrentDep, DbDep, SettingsDep
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import FileDownload
from ..services import files as fs
from .projects import get_project

router = APIRouter(tags=["files"], responses={**ERROR_RESPONSES, 402: {"description": fs.LOCKED_MESSAGE}})


@router.get("/projects/{project_id}/files", summary="Пакет файлов мастера: что доступно")
def list_files(project_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> dict:
    """КП и 3D — бесплатно всегда; производственные файлы — после оплаченного заказа в EMAN
    или оплаты файлов (`access.production`). `available=false` — с причиной `reason`.
    `purchase` — цена файлов без заказа (с учётом скидки Pro); null, когда файлы открыты."""
    p = get_project(db, current, project_id)
    return fs.list_files(db, p, current.workshop, current.user.language, settings)


@router.get("/projects/{project_id}/files/{kind}", summary="Скачать файл пакета",
            responses={200: {"content": {"application/octet-stream": {}}}})
def download(project_id: uuid.UUID, kind: str, current: CurrentDep, db: DbDep, settings: SettingsDep) -> Response:
    p = get_project(db, current, project_id)
    k = fs.KINDS.get(kind)
    if k is None:
        raise not_found("Файл")
    version = fs.file_version(db, p)
    if version is None:
        raise ApiError(409, "model_missing", "Модель ещё не построена")
    if not version.ok:
        raise ApiError(409, "model_invalid", "В модели есть ошибки — исправьте их, чтобы получить файлы")
    basis = "free"
    if not k.free:
        access = fs.production_access(db, p, current.workshop)
        if not access.granted:
            raise ApiError(402, "files_locked", fs.LOCKED_MESSAGE, {"pro_discount": access.pro_discount})
        basis = access.basis or "order"
    builder = fs.Builder(db, p, current.workshop, version, with_cost=current.sees_cost, language=current.user.language,
                         share_base_url=settings.share_base_url)
    data = builder.make(k.kind)
    db.add(FileDownload(project_id=p.id, version_id=version.id, kind=k.kind, basis=basis, user_id=current.user.id))
    db.commit()
    name = fs.file_name(p, version, k, current.user.language)
    # Старые клиенты берут filename (ASCII), новые — filename* (UTF-8, RFC 6266)
    ascii_name = name if name.isascii() else f"project_{k.kind}_v{version.number}.{k.ext}"
    return Response(
        content=data, media_type=k.content_type,
        headers={"Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}",
                 "X-Model-Version": str(version.number)},
    )
