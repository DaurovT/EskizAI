"""Несколько предметов на одном фото → несколько проектов (SCR-05b).

- Первый выбранный предмет остаётся в текущем проекте; для остальных создаются новые проекты того же
  цеха: тот же клиент и описание, те же исходные фото (ссылки на те же файлы хранилища, без копий),
  копия ИИ-сессии — дизайн продолжается выбором своего предмета (кэш промпта общий).
- Новые проекты списываются из лимита сразу. Сначала проверяется лимит на все сразу (вместе с текущим,
  если он ещё не списан): не хватает — 402 limit_exhausted, ничего не создаётся. Всё — одна транзакция,
  коммит делает вызывающий.
- Из примера получаются тоже примеры: они лимит не тратят.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings
from ..domain import PhotoKind, ProjectStatus
from ..errors import ApiError
from ..models import AiSession, Project, ProjectPhoto, ProjectStatusChange, Workshop
from .limits import charge_project, ensure_can_charge


@dataclass
class ObjectPlan:
    project: Project
    index: int
    obj: dict
    created: bool
    charged: bool = False


def object_title(obj: dict) -> str:
    label = (obj.get("label") or "").strip() or "Предмет"
    return (label[:1].upper() + label[1:])[:200]


def split_objects(db: Session, settings: Settings, workshop: Workshop, user_id: uuid.UUID, project: Project,
                  indices: list[int]) -> list[ObjectPlan]:
    row = db.scalar(select(AiSession).where(AiSession.project_id == project.id))
    if row is None:
        raise ApiError(409, "ai_session_missing", "Сначала запустите распознавание фото или описания")
    objects = (row.last_result or {}).get("objects") or []
    if not objects:
        raise ApiError(409, "no_objects", "На фото не найдено нескольких предметов — выбирать не из чего")
    if len(set(indices)) != len(indices):
        raise ApiError(422, "duplicate_objects", "Предмет выбран дважды")
    if any(i < 0 or i >= len(objects) for i in indices):
        raise ApiError(422, "unknown_object", "Такого предмета на фото нет — обновите экран")

    extra = len(indices) - 1
    if extra and not project.is_example:
        # Текущий проект спишется при переходе в «Эскиз» — на него тоже нужен лимит
        ensure_can_charge(db, settings, workshop, extra + (0 if project.charged_at else 1))

    plans = [ObjectPlan(project, indices[0], objects[indices[0]], created=False)]
    photos = list(db.scalars(select(ProjectPhoto).where(ProjectPhoto.project_id == project.id,
                                                        ProjectPhoto.kind == PhotoKind.source)
                             .order_by(ProjectPhoto.created_at)))
    for i in indices[1:]:
        obj = objects[i]
        # название по предмету с фото — временное: после дизайна станет «вид + размеры»
        p = Project(workshop_id=workshop.id, author_id=user_id, title=object_title(obj), title_source="auto",
                    client_id=project.client_id, source_text=project.source_text, is_example=project.is_example)
        db.add(p)
        db.flush()
        db.add(ProjectStatusChange(project_id=p.id, from_status=None, to_status=ProjectStatus.draft,
                                   actor_user_id=user_id, note="Предмет с фото другого проекта"))
        for ph in photos:  # тот же файл в хранилище; удаление фото не трогает файл, пока на него есть ссылки
            db.add(ProjectPhoto(project_id=p.id, kind=ph.kind, storage_key=ph.storage_key, url=ph.url,
                                content_type=ph.content_type, size_bytes=ph.size_bytes, uploaded_by=ph.uploaded_by))
        db.add(AiSession(project_id=p.id, language=row.language, data=row.data))
        charged = charge_project(db, settings, workshop, p) is not None
        db.flush()  # autoflush выключен — следующее списание должно видеть это
        plans.append(ObjectPlan(p, i, obj, created=True, charged=charged))
    return plans
