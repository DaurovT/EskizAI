"""Нестандарт (US-7, FR-34, FR-56; SCR-19, SCR-34; ADM-09).

Мастер отправляет заявку: описание, фото, отличия от ближайшего варианта (из разбора ИИ).
Статусы: отправлена (sent) → оценена (estimated: цена и срок от конструктора EMAN) → в работе (in_work:
мастер принял цену) → готово (done: доработанные файлы в проекте); отмена — до «в работе».
Менеджер в админке назначает конструктора, ставит цену и срок, прикрепляет файлы.
"""

import uuid
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..db import utcnow
from ..deps import AdminDep, CurrentDep, DbDep, StorageDep
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import AiSession, NonstandardRequest, Project, ProjectPhoto, Workshop
from ..services import events
from ..services.action_log import log_action
from .projects import get_project

router = APIRouter(tags=["nonstandard"], responses=ERROR_RESPONSES)

STATUS_LABELS = {"sent": "Отправлена", "estimated": "Оценена", "in_work": "В работе", "done": "Готово",
                 "cancelled": "Отменена"}
STATUS_LABELS_UZ = {"sent": "Yuborildi", "estimated": "Baholandi", "in_work": "Ishda", "done": "Tayyor",
                    "cancelled": "Bekor qilindi"}
FLOW = ["sent", "estimated", "in_work", "done"]
MAX_FILE_BYTES = 50 * 1024 * 1024


class NonstandardIn(BaseModel):
    description: str = Field(min_length=3, max_length=5000, description="Что нужно и чем отличается от модулей")
    photo_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    differences: list[str] | None = Field(None, description="Отличия от ближайшего варианта; нет — из разбора ИИ")
    path: Literal["eman", "self"] = Field("eman", description="eman — конструкторам EMAN; self — доработаю сам")


def out(r: NonstandardRequest, project: Project | None = None, *, admin: bool = False) -> dict:
    o = {
        "id": str(r.id), "number": r.number, "project_id": str(r.project_id),
        "project_title": project.title if project else None,
        "version_id": str(r.version_id) if r.version_id else None,
        "description": r.description, "photo_ids": r.photo_ids or [], "differences": r.differences or [],
        "path": r.path, "status": r.status, "status_label": STATUS_LABELS.get(r.status, r.status),
        "status_label_uz": STATUS_LABELS_UZ.get(r.status, r.status),
        "steps": [{"status": s, "label": STATUS_LABELS[s],
                   "done": r.status in FLOW and FLOW.index(s) <= FLOW.index(r.status)} for s in FLOW],
        "price": r.price, "lead_days": r.lead_days, "assignee": r.assignee,
        "designer_comment": r.designer_comment,
        "files": [{k: f.get(k) for k in ("id", "name", "content_type", "size", "uploaded_at")}
                  | {"url": f"/projects/{r.project_id}/nonstandard/{r.id}/files/{f['id']}"} for f in r.files or []],
        "can_accept": r.status == "estimated", "can_cancel": r.status in ("sent", "estimated"),
        "estimated_at": r.estimated_at, "accepted_at": r.accepted_at, "done_at": r.done_at,
        "created_at": r.created_at, "updated_at": r.updated_at,
    }
    if admin:
        o["manager_note"] = r.manager_note
        o["workshop_id"] = str(r.workshop_id)
        o["files"] = [{**f, "admin_url": f"/admin/nonstandard/{r.id}/files/{f['id']}"} for f in r.files or []]
    return o


def _get(db, project: Project, request_id: uuid.UUID) -> NonstandardRequest:
    r = db.get(NonstandardRequest, request_id)
    if r is None or r.project_id != project.id:
        raise not_found("Заявка")
    return r


@router.post("/projects/{project_id}/nonstandard", status_code=201, summary="Отправить заявку «нестандарт» (SCR-19)")
def create(project_id: uuid.UUID, body: NonstandardIn, current: CurrentDep, db: DbDep) -> dict:
    p = get_project(db, current, project_id)
    if body.photo_ids:
        found = set(db.scalars(select(ProjectPhoto.id).where(ProjectPhoto.project_id == p.id,
                                                             ProjectPhoto.id.in_(body.photo_ids))))
        if len(found) != len(set(body.photo_ids)):
            raise not_found("Фото")
    differences = body.differences
    if differences is None:
        session = db.scalar(select(AiSession).where(AiSession.project_id == p.id))
        differences = list(((session.last_result or {}).get("differences") or [])) if session else []
    number = (db.scalar(select(func.max(NonstandardRequest.number))) or 0) + 1
    r = NonstandardRequest(number=number, project_id=p.id, workshop_id=p.workshop_id, author_id=current.user.id,
                           version_id=p.current_version_id, description=body.description.strip(),
                           photo_ids=[str(i) for i in body.photo_ids], differences=differences, path=body.path)
    db.add(r)
    db.flush()
    log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="nonstandard",
               entity_id=r.id, action="create", after={"path": body.path})
    db.commit()
    return out(r, p)


@router.get("/projects/{project_id}/nonstandard", summary="Заявки «нестандарт» проекта (SCR-34)")
def list_for_project(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> list[dict]:
    p = get_project(db, current, project_id)
    rows = db.scalars(select(NonstandardRequest).where(NonstandardRequest.project_id == p.id)
                      .order_by(NonstandardRequest.created_at.desc()))
    return [out(r, p) for r in rows]


@router.get("/projects/{project_id}/nonstandard/{request_id}", summary="Заявка «нестандарт»: статус, цена, файлы")
def get_one(project_id: uuid.UUID, request_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    p = get_project(db, current, project_id)
    return out(_get(db, p, request_id), p)


@router.post("/projects/{project_id}/nonstandard/{request_id}/accept", summary="Принять цену и срок → «в работе»")
def accept(project_id: uuid.UUID, request_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    p = get_project(db, current, project_id)
    r = _get(db, p, request_id)
    if r.status != "estimated":
        raise ApiError(409, "not_estimated", "Цену можно принять, когда конструктор её назначит")
    r.status, r.accepted_at = "in_work", utcnow()
    log_action(db, actor_type="user", actor_id=str(current.user.id), workshop_id=p.workshop_id, entity="nonstandard",
               entity_id=r.id, action="accept", after={"price": r.price, "lead_days": r.lead_days})
    db.commit()
    return out(r, p)


@router.post("/projects/{project_id}/nonstandard/{request_id}/cancel", summary="Отозвать заявку (до «в работе»)")
def cancel(project_id: uuid.UUID, request_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    p = get_project(db, current, project_id)
    r = _get(db, p, request_id)
    if r.status not in ("sent", "estimated"):
        raise ApiError(409, "not_cancellable", "Заявка уже в работе — отменить её может менеджер")
    r.status = "cancelled"
    db.commit()
    return out(r, p)


def _file_response(storage, f: dict) -> Response:
    data = storage.read(f["key"])
    name = f.get("name") or "file"
    ascii_name = name.encode("ascii", "ignore").decode() or "file"
    return Response(content=data, media_type=f.get("content_type") or "application/octet-stream",
                    headers={"Content-Disposition": f"attachment; filename=\"{ascii_name}\"; "
                                                    f"filename*=UTF-8''{quote(name)}"})


@router.get("/projects/{project_id}/nonstandard/{request_id}/files/{file_id}", summary="Скачать доработанный файл",
            responses={200: {"content": {"application/octet-stream": {}}}})
def download(project_id: uuid.UUID, request_id: uuid.UUID, file_id: str, current: CurrentDep, db: DbDep,
             storage: StorageDep) -> Response:
    p = get_project(db, current, project_id)
    r = _get(db, p, request_id)
    f = next((f for f in r.files or [] if f["id"] == file_id), None)
    if f is None:
        raise not_found("Файл")
    return _file_response(storage, f)


# --- Админка (ADM-09) ---

admin_router = APIRouter(prefix="/admin/nonstandard", tags=["admin"], responses=ERROR_RESPONSES)


def _admin_get(db, request_id: uuid.UUID) -> tuple[NonstandardRequest, Project]:
    r = db.get(NonstandardRequest, request_id)
    if r is None:
        raise not_found("Заявка")
    return r, db.get(Project, r.project_id)


@admin_router.get("", summary="Очередь заявок «нестандарт»")
def admin_list(admin: AdminDep, db: DbDep,
               status: Annotated[list[str] | None, Query(description="sent, estimated, in_work, done, cancelled")] = None,
               limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict:
    stmt = select(NonstandardRequest)
    if status:
        stmt = stmt.where(NonstandardRequest.status.in_(status))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = list(db.scalars(stmt.order_by(NonstandardRequest.created_at.desc()).limit(limit).offset(offset)))
    items = []
    for r in rows:
        p = db.get(Project, r.project_id)
        w = db.get(Workshop, r.workshop_id)
        items.append({**out(r, p, admin=True), "workshop_name": w.name if w else None})
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@admin_router.get("/{request_id}", summary="Заявка «нестандарт»")
def admin_get(request_id: uuid.UUID, admin: AdminDep, db: DbDep) -> dict:
    r, p = _admin_get(db, request_id)
    w = db.get(Workshop, r.workshop_id)
    photos = []
    if r.photo_ids:
        photos = [{"id": str(ph.id), "url": ph.url} for ph in db.scalars(
            select(ProjectPhoto).where(ProjectPhoto.id.in_([uuid.UUID(i) for i in r.photo_ids])))]
    return {**out(r, p, admin=True), "workshop_name": w.name if w else None, "photos": photos}


class AdminPatchIn(BaseModel):
    assignee: str | None = Field(None, max_length=200, description="Конструктор EMAN")
    price: int | None = Field(None, ge=0, description="Цена доработки, сумы")
    lead_days: int | None = Field(None, ge=0, le=365, description="Срок, дней")
    status: Literal["sent", "estimated", "in_work", "done", "cancelled"] | None = None
    manager_note: str | None = Field(None, max_length=2000)
    designer_comment: str | None = Field(None, max_length=2000,
                                         description="Комментарий конструктора мастеру: как сделаем (видит мастер)")


@admin_router.patch("/{request_id}", summary="Назначить, оценить (цена, срок), сменить статус")
def admin_patch(request_id: uuid.UUID, body: AdminPatchIn, admin: AdminDep, db: DbDep) -> dict:
    """Цена и срок в «отправленной» заявке переводят её в «оценена» (мастеру — push).
    «Готово» — мастеру push «доработанные файлы в проекте»."""
    r, p = _admin_get(db, request_id)
    before = {"status": r.status, "price": r.price, "lead_days": r.lead_days, "assignee": r.assignee,
              "designer_comment": r.designer_comment}
    data = body.model_dump(exclude_unset=True)
    for k in ("assignee", "price", "lead_days", "manager_note", "designer_comment"):
        if k in data:
            setattr(r, k, data[k])
    target = body.status
    if target is None and r.status == "sent" and r.price is not None and r.lead_days is not None:
        target = "estimated"
    now = utcnow()
    if target and target != r.status:
        if target == "estimated" and (r.price is None or r.lead_days is None):
            raise ApiError(422, "price_required", "Для оценки нужны цена и срок")
        if r.status in ("done", "cancelled"):
            raise ApiError(409, "nonstandard_closed", "Заявка закрыта")
        r.status = target
        if target == "estimated":
            r.estimated_at = now
            events.nonstandard(db, r, "nonstandard_estimated")
        elif target == "in_work":
            r.accepted_at = r.accepted_at or now
        elif target == "done":
            r.done_at = now
            events.nonstandard(db, r, "nonstandard_done")
    log_action(db, actor_type="admin", actor_id=admin, workshop_id=r.workshop_id, entity="nonstandard",
               entity_id=r.id, action="update", before=before,
               after={"status": r.status, "price": r.price, "lead_days": r.lead_days, "assignee": r.assignee,
                      "designer_comment": r.designer_comment})
    db.commit()
    return out(r, p, admin=True)


@admin_router.post("/{request_id}/files", status_code=201, summary="Прикрепить доработанный файл")
async def admin_upload(request_id: uuid.UUID, admin: AdminDep, db: DbDep, storage: StorageDep,
                       file: UploadFile = File(description="PDF, DXF, архив и т. п., до 50 МБ")) -> dict:
    r, p = _admin_get(db, request_id)
    data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ApiError(413, "file_too_large", "Файл больше 50 МБ")
    if not data:
        raise ApiError(422, "empty_file", "Файл пустой")
    fid = uuid.uuid4().hex
    name = (file.filename or "file").replace("/", "_")[:200]
    key = f"workshops/{r.workshop_id}/projects/{r.project_id}/nonstandard/{r.id}/{fid}_{name.encode('ascii', 'ignore').decode() or 'file'}"
    stored = storage.save(key, data, file.content_type or "application/octet-stream")
    entry = {"id": fid, "name": name, "key": stored.key, "content_type": file.content_type or "application/octet-stream",
             "size": len(data), "uploaded_at": utcnow().isoformat(), "uploaded_by": admin}
    r.files = [*(r.files or []), entry]
    log_action(db, actor_type="admin", actor_id=admin, workshop_id=r.workshop_id, entity="nonstandard",
               entity_id=r.id, action="file", after={"name": name, "size": len(data)})
    db.commit()
    return out(r, p, admin=True)


@admin_router.get("/{request_id}/files/{file_id}", summary="Скачать файл заявки (админка)")
def admin_download(request_id: uuid.UUID, file_id: str, admin: AdminDep, db: DbDep, storage: StorageDep) -> Response:
    r, _ = _admin_get(db, request_id)
    f = next((f for f in r.files or [] if f["id"] == file_id), None)
    if f is None:
        raise not_found("Файл")
    return _file_response(storage, f)


@admin_router.delete("/{request_id}/files/{file_id}", summary="Удалить файл заявки")
def admin_delete_file(request_id: uuid.UUID, file_id: str, admin: AdminDep, db: DbDep, storage: StorageDep) -> dict:
    r, p = _admin_get(db, request_id)
    f = next((f for f in r.files or [] if f["id"] == file_id), None)
    if f is None:
        raise not_found("Файл")
    try:
        storage.delete(f["key"])
    except Exception:
        pass
    r.files = [x for x in r.files if x["id"] != file_id]
    db.commit()
    return out(r, p, admin=True)
