"""AR у мастера (SCR-47, docs/ar_contract.md): подписанные ссылки на GLB / USDZ текущей версии и сами файлы."""

import uuid
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import Response

from ..deps import CurrentDep, DbDep, SettingsDep, StorageDep
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import ModelVersion, Project
from ..schemas.share import ArOut
from ..services import ar_files
from ..services.lifecycle import current_version
from .projects import get_project

router = APIRouter(tags=["files"], responses=ERROR_RESPONSES)  # файлы мастера: AR


@router.get("/projects/{project_id}/ar", response_model=ArOut, summary="AR мастера: ссылки на файлы текущей версии")
def project_ar(project_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> ArOut:
    """Текущая версия модели, «закрыто», масштаб 1:1. Ссылки `glb_url` (Scene Viewer) и `usdz_url` (Quick Look)
    открываются без токена и живут 1 час; файлы строятся при первом скачивании и кэшируются.
    Модели ещё нет — 409 `no_model`."""
    p = get_project(db, current, project_id)
    version = current_version(db, p)
    if version is None:
        raise ApiError(409, "no_model", "Модель ещё не построена — AR недоступен")
    glb_url, exp = ar_files.signed_link(settings, version, "glb")
    usdz_url, _ = ar_files.signed_link(settings, version, "usdz")
    w, h, d = (list((version.viewer or {}).get("size") or [0, 0, 0]) + [0, 0, 0])[:3]
    return ArOut(version_id=str(version.id), version_number=version.number, size_mm=[w, d, h],
                 placement=ar_files.placement(version), glb_url=glb_url, usdz_url=usdz_url,
                 expires_at=exp.isoformat())


@router.get("/ar-files/{token}.{ext}", summary="Файл AR по подписанной ссылке (без входа, ссылка живёт 1 час)",
            responses={200: {"content": {"model/gltf-binary": {}, "model/vnd.usdz+zip": {}}}})
def ar_file(token: str, ext: Literal["glb", "usdz"], db: DbDep, settings: SettingsDep, storage: StorageDep) -> Response:
    """Ссылка из `GET /projects/{id}/ar`. Подделка — 404, истёк срок — 410 `link_expired`.
    `Content-Type`: `model/gltf-binary` или `model/vnd.usdz+zip`, `Content-Disposition: inline`."""
    version_id, state, fmt = ar_files.read_link(settings, token, ext)
    version = db.get(ModelVersion, version_id)
    project = db.get(Project, version.project_id) if version is not None else None
    if version is None or project is None or project.deleted_at is not None:
        raise not_found("Файл")
    data = ar_files.get_file(storage, settings, version, state, fmt)
    return Response(content=data, media_type=ar_files.CONTENT_TYPES[fmt], headers={
        "Content-Disposition": f'inline; filename="eskiz_v{version.number}.{fmt}"',
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    })
