"""ИИ: распознать фото/текст, ответить на вопросы, выбрать тип, правка словами, чат редактора.

Все POST возвращают 202 {task_id}; результат — GET /tasks/{task_id} → result (DesignOut / EditOut).
Проверки лимита, бюджета и статуса проекта — синхронно, до постановки задачи (402 / 409 сразу).
"""

import uuid

from fastapi import APIRouter
from sqlalchemy import select

from ..deps import CurrentDep, CurrentUser, DbDep, LLMDep, SettingsDep, TasksDep
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import AiSession, ModelVersion, Project, ProjectPhoto
from ..schemas.ai import (
    AnswerIn,
    BudgetOut,
    ChatOut,
    ChooseObjectsIn,
    ChooseObjectsOut,
    ChooseTypeIn,
    DesignIn,
    DesignOut,
    EditIn,
    ObjectProjectOut,
    TaskAccepted,
)
from ..services import ai as ai_service
from ..services import object_projects
from ..services.versions import ensure_model_editable
from .projects import get_project

router = APIRouter(tags=["ai"], responses={**ERROR_RESPONSES, 402: {"description": "Лимит проектов или бюджет ИИ"},
                                           503: {"description": "ИИ не настроен"}})


def _prepare(db, settings, current: CurrentUser, project_id: uuid.UUID, confirm: bool) -> Project:
    p = get_project(db, current, project_id)
    ensure_model_editable(p)
    ai_service.ensure_ai_allowed(db, settings, current.workshop, p, confirm_extra=confirm, user_id=current.user.id)
    return p


def _payload(current: CurrentUser, p: Project, **extra) -> dict:
    return {"project_id": str(p.id), "user_id": str(current.user.id), **extra}


def _has_session(db, p: Project) -> None:
    if db.scalar(select(AiSession.id).where(AiSession.project_id == p.id)) is None:
        raise ApiError(409, "ai_session_missing", "Сначала запустите распознавание фото или описания")


@router.post("/projects/{project_id}/ai/design", status_code=202, response_model=TaskAccepted,
             summary="Распознать фото и описание → дерево модулей (асинхронно)")
def design(project_id: uuid.UUID, body: DesignIn, current: CurrentDep, db: DbDep, settings: SettingsDep,
           tasks: TasksDep, llm: LLMDep) -> TaskAccepted:
    """Фото — уже загруженные в проект (`photo_ids`; не заданы — все исходные фото).
    Результат — DesignOut; если дерево собралось, создаётся новая версия модели (`version_id`).
    Повторное распознавание в том же проекте лимит не тратит."""
    p = get_project(db, current, project_id)
    photo_ids = [str(i) for i in body.photo_ids or []]
    if photo_ids:
        found = set(db.scalars(select(ProjectPhoto.id).where(ProjectPhoto.project_id == p.id,
                                                             ProjectPhoto.id.in_(body.photo_ids or []))))
        if len(found) != len(set(body.photo_ids or [])):
            raise not_found("Фото")
    has_photos = bool(photo_ids) or db.scalar(
        select(ProjectPhoto.id).where(ProjectPhoto.project_id == p.id, ProjectPhoto.kind == "source").limit(1)
    ) is not None
    if not (body.text or "").strip() and not has_photos:
        raise ApiError(422, "nothing_to_recognize", "Загрузите фото или опишите изделие словами")
    _prepare(db, settings, current, project_id, body.confirm_extra_project)
    task_id = tasks.enqueue("ai.design", _payload(current, p, text=(body.text or "").strip(), photo_ids=photo_ids,
                                                  language=body.language),
                            workshop_id=str(current.workshop.id), deps={"llm": llm})
    return TaskAccepted(task_id=task_id)


@router.post("/projects/{project_id}/ai/answer", status_code=202, response_model=TaskAccepted,
             summary="Ответы мастера на вопросы ИИ (асинхронно)")
def answer(project_id: uuid.UUID, body: AnswerIn, current: CurrentDep, db: DbDep, settings: SettingsDep,
           tasks: TasksDep, llm: LLMDep) -> TaskAccepted:
    """Все ответы раунда разом: `{"answers": [{"question_id", "value"}]}` (или прежнее `{"answers": {id: value}}`).
    «не знаю» — значение по умолчанию с пометкой «оценка». Ответы хранятся в сессии: отвеченное не спрашивается
    снова; в результате (DesignOut) — пересобранная модель и, если нужно, следующий раунд вопросов."""
    answers = {k: v for k, v in body.answer_map().items() if k.strip()}
    if not answers:
        raise ApiError(422, "no_answers", "Нет ответов")
    p = get_project(db, current, project_id)
    _has_session(db, p)
    _prepare(db, settings, current, project_id, body.confirm_extra_project)
    task_id = tasks.enqueue("ai.answer", _payload(current, p, answers=answers),
                            workshop_id=str(current.workshop.id), deps={"llm": llm})
    return TaskAccepted(task_id=task_id)


@router.post("/projects/{project_id}/ai/choose-type", status_code=202, response_model=TaskAccepted,
             summary="Мастер выбрал тип изделия (асинхронно)")
def choose_type(project_id: uuid.UUID, body: ChooseTypeIn, current: CurrentDep, db: DbDep, settings: SettingsDep,
                tasks: TasksDep, llm: LLMDep) -> TaskAccepted:
    p = get_project(db, current, project_id)
    _has_session(db, p)
    _prepare(db, settings, current, project_id, body.confirm_extra_project)
    task_id = tasks.enqueue("ai.choose_type", _payload(current, p, product_kind=body.product_kind.strip()),
                            workshop_id=str(current.workshop.id), deps={"llm": llm})
    return TaskAccepted(task_id=task_id)


@router.post("/projects/{project_id}/ai/choose-objects", status_code=202, response_model=ChooseObjectsOut,
             summary="Несколько предметов на фото → несколько проектов (асинхронно)")
def choose_objects(project_id: uuid.UUID, body: ChooseObjectsIn, current: CurrentDep, db: DbDep,
                   settings: SettingsDep, tasks: TasksDep, llm: LLMDep) -> ChooseObjectsOut:
    """`objects` — номера в DesignOut.objects последнего распознавания. Первый предмет остаётся в этом проекте,
    для каждого следующего создаётся новый проект (тот же клиент и фото) и списывается из лимита.
    Лимита не хватает на все сразу → 402 `limit_exhausted` (details: needed, left), ничего не создаётся.
    По каждому проекту — своя задача; результат — DesignOut. Один предмет — то же, что ответ на вопрос `object`."""
    p = get_project(db, current, project_id)
    _has_session(db, p)
    ensure_model_editable(p)
    ai_service.ensure_ai_allowed(db, settings, current.workshop, p, confirm_extra=body.confirm_extra_project,
                                 user_id=current.user.id, commit=False)
    plans = object_projects.split_objects(db, settings, current.workshop, current.user.id, p, body.objects)
    charged = sum(1 for pl in plans if pl.charged)
    if charged:
        from ..services import events

        events.limit_left(db, settings, current.workshop)  # «Остался 1 проект» (раздел 19)
    db.commit()
    out = []
    for pl in plans:
        box = pl.obj.get("box") or None
        # Свой LLM на задачу: журнал ИИ-запросов пишется в свой проект
        task_llm = type(llm)(client=llm.client) if pl.created else llm
        task_id = tasks.enqueue("ai.choose_object", _payload(current, pl.project, label=pl.obj.get("label") or "",
                                                             photo=pl.obj.get("photo", 0), box=box,
                                                             object_index=pl.index),
                                workshop_id=str(current.workshop.id), deps={"llm": task_llm})
        out.append(ObjectProjectOut(project_id=str(pl.project.id), task_id=task_id, object_index=pl.index,
                                    label=pl.obj.get("label") or "", title=pl.project.title, created=pl.created))
    return ChooseObjectsOut(projects=out, charged=charged)


@router.post("/projects/{project_id}/ai/edit", status_code=202, response_model=TaskAccepted,
             summary="Правка словами (асинхронно): новая версия модели")
def edit(project_id: uuid.UUID, body: EditIn, current: CurrentDep, db: DbDep, settings: SettingsDep,
         tasks: TasksDep, llm: LLMDep) -> TaskAccepted:
    """Результат — EditOut. Удачная правка создаёт версию модели (отмена — POST …/model/undo).
    Бюджет ИИ проекта исчерпан → 402 `ai_budget_exceeded`, пока не придёт `confirm_extra_project: true`
    (тогда списывается ещё один проект из лимита)."""
    p = get_project(db, current, project_id)
    if p.current_version_id is None or db.get(ModelVersion, p.current_version_id) is None:
        raise ApiError(409, "model_missing", "Модель ещё не построена — сначала распознайте фото или описание")
    _prepare(db, settings, current, project_id, body.confirm_extra_project)
    task_id = tasks.enqueue("ai.edit", _payload(current, p, instruction=body.instruction.strip()),
                            workshop_id=str(current.workshop.id), deps={"llm": llm})
    return TaskAccepted(task_id=task_id)


@router.get("/projects/{project_id}/chat", response_model=ChatOut, response_model_exclude_none=True,
            summary="Чат редактора: история с ИИ (FR-43)")
def chat(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ChatOut:
    """`undone` — правка отменена (её версия не в цепочке текущей версии после undo).
    `questions` — вопросы распознавания без ответа (в редакторе — собрать ответы и отправить разом в /ai/answer)."""
    p = get_project(db, current, project_id)
    questions, answers = ai_service.pending_questions(db, p)
    return ChatOut(messages=ai_service.chat_messages(db, p), questions=questions, answers=answers)


@router.get("/projects/{project_id}/ai/budget", response_model=BudgetOut, summary="Бюджет ИИ проекта")
def budget(project_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> BudgetOut:
    return ai_service.budget_state(db, settings, get_project(db, current, project_id))


@router.get("/projects/{project_id}/ai/design", response_model=DesignOut, summary="Последний результат распознавания")
def last_design(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    p = get_project(db, current, project_id)
    row = db.scalar(select(AiSession).where(AiSession.project_id == p.id))
    if row is None or row.last_result is None:
        raise ApiError(404, "ai_session_missing", "Распознавания в этом проекте ещё не было")
    return row.last_result
