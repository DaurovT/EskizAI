"""Входящие чертежи из Eskiz DWG (docs/dwg_contract.md). Видит только загрузивший пользователь.

Ручки принимают и полный токен приложения мастера, и ограниченный токен Eskiz DWG (scope=dwg_upload).
"""

import uuid

from fastapi import APIRouter, File, Query, Response, UploadFile
from sqlalchemy import func, select

from ..db import utcnow
from ..deps import CurrentDep, DbDep, InboxCurrentDep, SettingsDep, StorageDep
from ..errors import ERROR_RESPONSES
from ..models import InboxDrawing
from ..schemas.common import Ok, Page
from ..schemas.inbox import InboxDrawingDetail, InboxDrawingOut, InboxProjectIn, InboxProjectOut
from ..services import inbox, inbox_project

router = APIRouter(prefix="/inbox", tags=["inbox"], responses={
    **ERROR_RESPONSES,
    413: {"description": "Файл больше 50 МБ (file_too_large)"},
    429: {"description": "Не больше 60 загрузок в сутки (upload_limit)"},
})


@router.post("/drawings", response_model=InboxDrawingOut, status_code=201, summary="Загрузить пакет .eskiz",
             responses={200: {"model": InboxDrawingOut, "description": "Этот пакет уже есть во входящих — он же"}})
async def upload(current: InboxCurrentDep, db: DbDep, settings: SettingsDep, storage: StorageDep,
                 response: Response, file: UploadFile = File(description="Пакет .eskiz (zip с manifest.json), до 50 МБ"),
                 ) -> dict:
    """`422 bad_package` (details.reason) — не zip, нет или неверный manifest.json;
    `422 unsupported_package` — неизвестный `format_version`; `409 inbox_quota_exceeded` — нет места.
    Тот же пакет (по sha256), уже лежащий во входящих этого пользователя, — `200` с прежним чертежом."""
    data, sha = await inbox.read_upload(file, settings.inbox_max_bytes)
    d, created = inbox.store_drawing(db, settings, storage, current.user.id, file.filename or "", data, sha)
    if not created:
        response.status_code = 200
    return inbox.drawing_out(settings, d)


@router.get("/drawings", response_model=Page[InboxDrawingOut], summary="Мои входящие чертежи")
def list_drawings(current: InboxCurrentDep, db: DbDep, settings: SettingsDep,
                  limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict:
    """Новые сверху. Только свои; удалённые и истёкшие не показываются."""
    now = utcnow()
    q = inbox.live_query(current.user.id, now)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(InboxDrawing.created_at.desc(), InboxDrawing.id.desc()).limit(limit).offset(offset))
    return {"items": [inbox.drawing_out(settings, d) for d in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/drawings/{drawing_id}", response_model=InboxDrawingDetail, summary="Открыть чертёж")
def get_drawing(drawing_id: uuid.UUID, current: InboxCurrentDep, db: DbDep, settings: SettingsDep) -> dict:
    """Отмечает открытие и продлевает хранение на 90 дней. Чужой, удалённый или истёкший — `404`."""
    d = inbox.get_own(db, current.user.id, drawing_id)
    inbox.touch(db, settings, d)
    return inbox.drawing_out(settings, d, detail=True)


@router.delete("/drawings/{drawing_id}", response_model=Ok, summary="Удалить чертёж")
def delete_drawing(drawing_id: uuid.UUID, current: InboxCurrentDep, db: DbDep, storage: StorageDep) -> Ok:
    d = inbox.get_own(db, current.user.id, drawing_id)
    inbox.soft_delete(db, storage, d)
    return Ok()


@router.post("/drawings/{drawing_id}/project", response_model=InboxProjectOut, status_code=201,
             summary="Сделать проект по листу чертежа (SCR-55)",
             responses={200: {"model": InboxProjectOut, "description": "Черновик по этому чертежу ещё без модели — "
                                                                       "он же, с новым листом"}})
def drawing_project(drawing_id: uuid.UUID, body: InboxProjectIn, current: CurrentDep, db: DbDep, storage: StorageDep,
                    response: Response) -> dict:
    """Только полный токен мастера (не Eskiz DWG). Проект — в цехе мастера: превью листа — исходное фото,
    `text` — короткая выжимка `data.json` листа (габариты, цепочки размеров, оси, отметки, марки, надписи; мм).
    Дальше приложение запускает обычное распознавание `POST /projects/{id}/ai/design` с этим текстом.
    Пока по чертежу есть проект, чертёж не истекает. Повтор (другой лист), пока черновик без модели, —
    тот же проект (`200`). `422 sheet_not_found` — такого листа нет; чужой/удалённый чертёж — `404`."""
    d = inbox.get_own(db, current.user.id, drawing_id)
    out = inbox_project.make_project(db, storage, current, d, body.sheet)
    if not out["created"]:
        response.status_code = 200
    return out
