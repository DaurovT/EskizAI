"""ИИ в API: проектирование по фото и тексту, ответы на вопросы, правки словами, чат (раздел 6 PRD).

- Сам ИИ — пакет mebel_ai (DesignSession, edit_tree); API хранит сессию, создаёт версии модели,
  пишет журнал ИИ-запросов и чат редактора.
- Задачи выполняются в очереди (services/tasks.py); каждая открывает свою сессию базы.
- Бюджет ИИ на проект: $0,30 (настраивается в админке). При 80% — предупреждение; после
  превышения следующий ИИ-запрос требует подтверждения и списывает ещё один проект из лимита.
- ИИ не работает без лимита проектов: нельзя запустить ИИ в несписанном проекте, если лимит
  исчерпан (примеры — без лимита).
"""

import json
import logging
import uuid
from typing import Any

from mebel_ai import LLM, SONNET, DesignResult, DesignSession, EditResult, Photo, edit_tree
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..db import Database, utcnow
from ..domain import AiValidation, VersionSource
from ..errors import ApiError
from ..models import (
    AiRequest,
    AiSession,
    ChatMessage,
    ExtraCharge,
    ModelVersion,
    Project,
    ProjectPhoto,
    User,
    Workshop,
)
from ..schemas.ai import BudgetOut, ChatMessageOut, DesignOut, EditOut, PriceDelta, QuestionOut
from .app_settings import get_setting
from .estimate import compute_range, is_measured, price_of
from .limits import charge_extra, limit_exhausted_error, limit_state
from .storage import Storage
from .versions import create_version

log = logging.getLogger(__name__)

# Форматы, которые принимает Claude (HEIC — нет)
CLAUDE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
FAILED_MESSAGE = {
    "ru": "Не смог разобрать. Выберите тип изделия вручную, опишите словами или отправьте как нестандарт",
    "uz": "Tushuna olmadim. Buyum turini qo‘lda tanlang, so‘z bilan yozing yoki nostandart sifatida yuboring",
}


# --- Бюджет и лимит ---


def budget_state(db: Session, settings: Settings, project: Project) -> BudgetOut:
    """Бюджет ИИ проекта. Пример — маленький бюджет, общий на все примеры цеха (удалить пример и создать
    новый — бюджет не обновляет)."""
    if project.is_example:
        examples = select(Project.id).where(Project.workshop_id == project.workshop_id, Project.is_example.is_(True))
        spent = db.scalar(select(func.coalesce(func.sum(AiRequest.cost_microusd), 0)).where(
            AiRequest.project_id.in_(examples))) or 0
        extra = 0
        budget_micro = round(settings.ai_example_budget_usd * 1_000_000)
    else:
        spent = db.scalar(select(func.coalesce(func.sum(AiRequest.cost_microusd), 0)).where(
            AiRequest.project_id == project.id)) or 0
        extra = db.scalar(select(func.count(ExtraCharge.id)).where(
            ExtraCharge.project_id == project.id, ExtraCharge.reason == "ai_budget")) or 0
        budget_micro = round(float(get_setting(db, settings, "ai_budget_usd")) * 1_000_000)
    warn_ratio = float(get_setting(db, settings, "ai_warn_ratio"))
    limit = budget_micro * (1 + extra)
    ratio = spent / limit if limit else 1.0
    exceeded = spent >= limit
    warning = not exceeded and ratio >= warn_ratio
    message = None
    if exceeded:
        message = "Бюджет ИИ-правок в этом проекте исчерпан. Следующая ИИ-правка спишет ещё один проект из лимита"
    elif warning:
        message = f"Осталось ~{max(0, round(100 * (1 - ratio)))}% ИИ-правок в этом проекте"
    return BudgetOut(spent_usd=round(spent / 1_000_000, 4), limit_usd=round(limit / 1_000_000, 4),
                     percent=min(999, round(100 * ratio)), extra_projects=extra, warning=warning,
                     exceeded=exceeded, message=message)


def task_key(project: Project | uuid.UUID | str) -> str:
    """Ключ очереди: в проекте одновременно — одна ИИ-задача."""
    pid = project.id if isinstance(project, Project) else project
    return f"ai:{pid}"


def ai_busy_error() -> ApiError:
    return ApiError(409, "ai_busy", "ИИ уже работает над этим проектом. Дождитесь ответа")


def ensure_ai_allowed(
    db: Session, settings: Settings, workshop: Workshop, project: Project, *, confirm_extra: bool, user_id,
    commit: bool = True, tasks=None, task_count: int = 1,
) -> None:
    """Проверки перед постановкой ИИ-задачи. Списание доп. проекта — здесь же (с подтверждением).
    commit=False — списание остаётся в общей транзакции вызывающего (несколько предметов на фото).
    tasks — очередь: занят ли проект (409 ai_busy) и сколько уже зарезервировано задачами в очереди."""
    from .spend_limits import ensure_ai_allowed as ensure_spend

    if tasks is not None and tasks.busy(task_key(project)):
        raise ai_busy_error()
    # выключатель ИИ, дневные лимиты (общий и на цех), часовой лимит цеха; резерв задач в очереди — §4a, §8
    ensure_spend(db, settings, workshop,
                 reserved_global=tasks.reserved_usd() if tasks is not None else 0.0,
                 reserved_workshop=tasks.reserved_usd(str(workshop.id)) if tasks is not None else 0.0,
                 reserve=settings.ai_task_reserve_usd * max(task_count, 1))
    if not project.is_example and project.charged_at is None:
        state = limit_state(db, settings, workshop)
        if not state.can_charge:
            raise limit_exhausted_error(state)
    budget = budget_state(db, settings, project)
    if not budget.exceeded:
        return
    if project.is_example:
        raise ApiError(402, "ai_budget_example",
                       "В примере закончился бюджет ИИ. Создайте свой проект — в нём ИИ снова доступен",
                       budget.model_dump())
    if not confirm_extra:
        raise ApiError(
            402,
            "ai_budget_exceeded",
            "Бюджет ИИ-правок в этом проекте исчерпан. Следующая ИИ-правка спишет ещё один проект из лимита — "
            "подтвердите. Правка полями и тапом остаётся бесплатной",
            budget.model_dump(),
        )
    charge_extra(db, settings, workshop, project, user_id=user_id)  # 402 limit_exhausted, если лимита нет
    if commit:
        db.commit()


# --- Журнал ---


def log_llm(db: Session, llm: LLM, project: Project, offset: int = 0) -> None:
    for r in llm.log[offset:]:
        try:
            validation = AiValidation(r.validation).value
        except ValueError:
            validation = AiValidation.failed.value
        db.add(AiRequest(
            workshop_id=project.workshop_id, project_id=project.id, purpose=r.purpose[:40], model=r.model,
            tokens_in=r.input_tokens, tokens_out=r.output_tokens, cache_read_tokens=r.cache_read_tokens,
            cache_write_tokens=r.cache_write_tokens, cost_microusd=round(r.cost_usd * 1_000_000),
            validation_result=validation, duration_ms=r.duration_ms, stop_reason=(r.stop_reason or None),
            served_by=r.served_by or r.model,
        ))


def log_call_error(db: Session, project: Project, purpose: str, error: Exception) -> None:
    """Вызов не дошёл до ответа (сеть, ключ, перегрузка) — тоже строка журнала (раздел 19)."""
    db.add(AiRequest(
        workshop_id=project.workshop_id, project_id=project.id, purpose=purpose, model=SONNET,
        validation_result=AiValidation.error.value, validation_errors=[f"{type(error).__name__}: {error}"[:500]],
    ))


# --- Чат ---


def add_chat(db: Session, project: Project, author: str, text: str, *, kind: str = "text", options=None,
             version_id=None, price_delta=None, user_id=None) -> ChatMessage:
    msg = ChatMessage(project_id=project.id, author=author, kind=kind, text=text, options=options,
                      version_id=version_id, price_delta=price_delta, user_id=user_id)
    db.add(msg)
    db.flush()
    return msg


def active_versions(db: Session, project: Project) -> set[uuid.UUID]:
    """Текущая версия и все её предки: правки из чата, чьих версий тут нет, — отменены."""
    parents = dict(db.execute(select(ModelVersion.id, ModelVersion.parent_id).where(
        ModelVersion.project_id == project.id)).all())
    out: set[uuid.UUID] = set()
    cur = project.current_version_id
    while cur is not None and cur not in out:
        out.add(cur)
        cur = parents.get(cur)
    return out


def chat_messages(db: Session, project: Project) -> list[ChatMessageOut]:
    active = active_versions(db, project)
    rows = db.scalars(select(ChatMessage).where(ChatMessage.project_id == project.id)
                      .order_by(ChatMessage.created_at, ChatMessage.id))
    return [
        ChatMessageOut(
            id=str(m.id), author=m.author, kind=m.kind, text=m.text, options=m.options or None,
            version_id=str(m.version_id) if m.version_id else None,
            price_delta=m.price_delta, undone=m.version_id is not None and m.version_id not in active,
            created_at=m.created_at,
        )
        for m in rows
    ]


# --- Выполнение задач ---


def _question(q) -> QuestionOut:
    return QuestionOut(id=q.id, text=q.text, options=list(q.options), default=q.default, affects=q.affects)


DONT_KNOW = "не знаю"


def session_answers(row: AiSession | None) -> dict[str, str]:
    """Ответы мастера, сохранённые в сессии DesignSession."""
    if row is None:
        return {}
    try:
        return dict(json.loads(row.data).get("answers") or {})
    except (ValueError, TypeError, AttributeError):
        return {}


def last_questions(row: AiSession | None) -> list[QuestionOut]:
    """Вопросы последнего распознавания (из last_result)."""
    if row is None or not row.last_result:
        return []
    out = []
    for q in row.last_result.get("questions") or []:
        try:
            out.append(QuestionOut.model_validate(q))
        except ValueError:
            continue
    return out


def pending_questions(db: Session, project: Project) -> tuple[list[QuestionOut], dict[str, str]]:
    """Вопросы распознавания, на которые мастер ещё не ответил, и уже данные ответы."""
    row = db.scalar(select(AiSession).where(AiSession.project_id == project.id))
    answers = session_answers(row)
    if row is None or row.last_status != "questions":
        return [], answers
    return [q for q in last_questions(row) if q.id not in answers], answers


MAX_ANSWERS = 50
MAX_ANSWER_CHARS = 500


def answerable_ids(row: AiSession | None) -> set[str]:
    """id вопросов последнего распознавания и уже отвеченных (можно переответить); `object` — выбор предмета
    на фото с несколькими предметами (прежний путь вместо choose-objects)."""
    return {q.id for q in last_questions(row)} | set(session_answers(row)) | {"object"}


def known_answers(answers: dict[str, str], asked) -> dict[str, str]:
    """Только ответы на заданные вопросы, не больше MAX_ANSWERS, каждый — не длиннее MAX_ANSWER_CHARS."""
    out = {}
    for qid, value in answers.items():
        if qid in asked and len(out) < MAX_ANSWERS:
            out[qid] = str(value)[:MAX_ANSWER_CHARS]
    return out


def answer_text(answers: dict[str, str], questions: dict[str, QuestionOut]) -> str:
    """Реплика мастера в чате: «вопрос — ответ» по строке (вместо id вопросов)."""
    lines = []
    for qid, value in answers.items():
        q = questions.get(qid)
        shown = value
        if value.strip().lower() == DONT_KNOW:
            shown = f"по умолчанию ({q.default})" if q and q.default else "по умолчанию"
        lines.append(f"{q.text} — {shown}" if q and q.text else f"{qid}: {shown}")
    return "\n".join(lines)


class AiRunner:
    """Обработчики ИИ-задач очереди. Каждая задача — своя сессия базы."""

    def __init__(self, db: Database, storage: Storage, settings: Settings):
        self.db = db
        self.storage = storage
        self.settings = settings

    # payload: project_id, user_id, …; deps: llm

    def _load(self, db: Session, payload: dict) -> tuple[Project, Workshop, User | None]:
        project = db.get(Project, uuid.UUID(payload["project_id"]))
        if project is None:
            raise RuntimeError("Проект не найден")
        workshop = db.get(Workshop, project.workshop_id)
        user = db.get(User, uuid.UUID(payload["user_id"])) if payload.get("user_id") else None
        return project, workshop, user

    def _photos(self, db: Session, project: Project, photo_ids: list[str] | None) -> list[Photo]:
        stmt = select(ProjectPhoto).where(ProjectPhoto.project_id == project.id)
        if photo_ids:
            stmt = stmt.where(ProjectPhoto.id.in_([uuid.UUID(i) for i in photo_ids]))
        else:
            stmt = stmt.where(ProjectPhoto.kind == "source")
        out = []
        for ph in db.scalars(stmt.order_by(ProjectPhoto.created_at)):
            if ph.content_type not in CLAUDE_IMAGE_TYPES:
                continue
            try:
                out.append(Photo(data=self.storage.read(ph.storage_key), media_type=ph.content_type))
            except Exception:
                log.exception("photo %s unreadable", ph.id)
        return out[: self.settings.ai_photo_limit]

    def design(self, payload: dict[str, Any], llm: LLM) -> dict:
        with self.db.sessionmaker() as db:
            project, workshop, user = self._load(db, payload)
            language = payload.get("language") or (user.language if user else "ru")
            photos = self._photos(db, project, payload.get("photo_ids"))
            text = payload.get("text") or ""
            session = DesignSession(language=language, llm=llm)
            master_text = text or f"Фото: {len(photos)}"
            if text and photos:
                master_text = f"{text} (фото: {len(photos)})"
            msg = add_chat(db, project, "master", master_text, kind="design", user_id=user.id if user else None)
            if text and not project.source_text:
                project.source_text = text
            return self._run_design(db, project, workshop, user, session, "design",
                                    lambda: session.start(text, photos), master_msg=msg, photos=photos)

    def answer(self, payload: dict[str, Any], llm: LLM) -> dict:
        with self.db.sessionmaker() as db:
            project, workshop, user = self._load(db, payload)
            session = self._session(db, project, llm)
            # тексты заданных вопросов — для чата и для модели (ответ без id-шников)
            row = db.scalar(select(AiSession).where(AiSession.project_id == project.id))
            asked = {q.id: q for q in last_questions(row)}
            # в запрос к модели — только ответы на заданные вопросы (ручка уже отфильтровала; здесь — страховка)
            answers = known_answers(payload["answers"], answerable_ids(row))
            # после распознавания мастер правил модель — ответы применяются к текущему дереву, правки не теряются
            current_tree = None
            designed = (row.last_result or {}).get("version_id") if row else None
            if project.current_version_id and str(project.current_version_id) != designed:
                cur = db.get(ModelVersion, project.current_version_id)
                current_tree = cur.tree if cur else None
            msg = add_chat(db, project, "master", answer_text(answers, asked), kind="answer",
                           user_id=user.id if user else None)
            return self._run_design(db, project, workshop, user, session, "answer",
                                    lambda: session.answer(answers, asked, current_tree), master_msg=msg)

    def choose_type(self, payload: dict[str, Any], llm: LLM) -> dict:
        with self.db.sessionmaker() as db:
            project, workshop, user = self._load(db, payload)
            session = self._session(db, project, llm)
            kind = payload["product_kind"]
            msg = add_chat(db, project, "master", kind, kind="choose_type", user_id=user.id if user else None)
            return self._run_design(db, project, workshop, user, session, "choose_type",
                                    lambda: session.choose_type(kind), master_msg=msg)

    def choose_object(self, payload: dict[str, Any], llm: LLM) -> dict:
        """Мастер выбрал предмет на фото (текущий проект или новый — с копией сессии)."""
        with self.db.sessionmaker() as db:
            project, workshop, user = self._load(db, payload)
            session = self._session(db, project, llm)
            label = payload["label"]
            msg = add_chat(db, project, "master", label, kind="answer", user_id=user.id if user else None)
            return self._run_design(db, project, workshop, user, session, "answer",
                                    lambda: session.choose_object(label, photo=payload.get("photo"),
                                                                  box=payload.get("box")), master_msg=msg)

    def _session(self, db: Session, project: Project, llm: LLM) -> DesignSession:
        row = db.scalar(select(AiSession).where(AiSession.project_id == project.id))
        if row is None:
            raise RuntimeError("Сначала запустите распознавание (POST /ai/design)")
        return DesignSession.from_json(row.data, llm=llm)

    def _run_design(self, db: Session, project: Project, workshop: Workshop, user: User | None,
                    session: DesignSession, purpose: str, call, master_msg: ChatMessage | None = None,
                    photos: list[Photo] | None = None) -> dict:
        user_id = user.id if user else None
        result: DesignResult | None = None
        error: str | None = None
        try:
            result = call()
        except Exception as e:  # сеть, ключ, перегрузка API — мастер получает «Не смог разобрать»
            log.exception("AI %s failed", purpose)
            error = f"ИИ недоступен: {e}"[:500]
            log_call_error(db, project, purpose, e)
        log_llm(db, session.llm, project)

        out = DesignOut(status="failed", error=error)
        if result is not None:
            r = result.response
            fields: dict[str, Any] = dict(status=result.status, error=result.error or None)
            if r is not None:
                fields.update(
                    product_kind=r.product_kind, confidence=r.confidence, alternatives=list(r.alternatives),
                    elements=[e.model_dump() for e in r.elements], understood=list(r.understood),
                    unclear=list(r.unclear), estimated=list(r.estimated),
                    questions=[_question(q) for q in result.questions], differences=list(r.differences),
                    objects=[o.model_dump() for o in getattr(r, "objects", None) or []],
                    room=r.room.model_dump() if getattr(r, "room", None) is not None else None,
                    message=r.message,
                )
            out = DesignOut(**fields)
            if result.status != "failed" and result.tree is not None:
                tree = result.tree
                if r is not None and getattr(r, "room", None) is not None:  # пустая ниша: цвет стен и пола для 3D
                    from .room_colors import with_room_colors

                    shots = photos if photos is not None else self._photos(db, project, None)
                    tree = with_room_colors(tree, r.room, [ph.data for ph in shots])
                try:
                    v = create_version(db, project, tree, author_id=user_id, source=VersionSource.ai,
                                       label_text=f"ИИ: {r.product_kind}"[:200] if r else "ИИ",
                                       estimated=list(r.estimated) if r else [])
                    out.version_id = str(v.id)
                    out.issues = v.issues
                except ApiError as e:
                    out.status, out.error = "failed", e.message
                    out.issues = (e.details or {}).get("issues", []) if isinstance(e.details, dict) else []
            elif result.build is not None:
                out.issues = [i.model_dump() for i in result.build.issues]
        if out.status == "failed" and not out.message:
            out.message = FAILED_MESSAGE.get(session.language, FAILED_MESSAGE["ru"])

        # Сессия: история сообщений Claude (только дописывается) и последний результат
        row = db.scalar(select(AiSession).where(AiSession.project_id == project.id))
        if row is None:
            row = AiSession(project_id=project.id, language=session.language, data=session.to_json())
            db.add(row)
        row.data = session.to_json()
        row.language = session.language
        row.last_status = out.status

        # Чат: реплика мастера и ответ ИИ привязаны к версии — после отмены обе помечаются undone
        vid = uuid.UUID(out.version_id) if out.version_id else None
        if master_msg is not None and vid is not None:
            master_msg.version_id = vid
        if out.status == "choose_type":
            add_chat(db, project, "ai", out.message or "Не уверен, что это. Выберите тип изделия", kind="choose_type",
                     options=[o for o in [out.product_kind, *out.alternatives] if o], version_id=vid)
        else:
            add_chat(db, project, "ai", out.message or (out.error or ""), kind="error" if out.status == "failed"
                     else purpose, version_id=vid)
        for q in out.questions:
            add_chat(db, project, "ai", q.text, kind="question", options=q.options)

        db.flush()
        out.budget = budget_state(db, self.settings, project)
        out.answers = dict(session.answers)
        row.last_result = out.model_dump(mode="json")
        db.commit()
        return out.model_dump(mode="json")

    def edit(self, payload: dict[str, Any], llm: LLM) -> dict:
        with self.db.sessionmaker() as db:
            project, workshop, user = self._load(db, payload)
            user_id = user.id if user else None
            instruction: str = payload["instruction"]
            version = db.get(ModelVersion, project.current_version_id) if project.current_version_id else None
            master_msg = add_chat(db, project, "master", instruction, kind="edit", user_id=user_id)
            if version is None:
                out = EditOut(ok=False, error="Модель ещё не построена")
                add_chat(db, project, "ai", out.error, kind="error")
                db.commit()
                return out.model_dump(mode="json", by_alias=True)

            session_row = db.scalar(select(AiSession).where(AiSession.project_id == project.id))
            language = session_row.language if session_row else (user.language if user else "ru")
            # Хвост чата целиком: вопросы ИИ и ответы мастера — чтобы ИИ не переспрашивал (новое сообщение — отдельно)
            recent = list(db.scalars(
                select(ChatMessage).where(ChatMessage.project_id == project.id, ChatMessage.id != master_msg.id)
                .order_by(ChatMessage.created_at.desc()).limit(12)
            ))[::-1]
            history = [("Мастер: " if m.author == "master" else "ИИ: ") + (m.text or "") for m in recent]
            photos = self._photos(db, project, None)

            result: EditResult | None = None
            try:
                result = edit_tree(version.tree, instruction, llm=llm, language=language, history=history,
                                   photos=photos)
            except Exception as e:
                log.exception("AI edit failed")
                log_call_error(db, project, "edit", e)
                out = EditOut(ok=False, error=f"ИИ недоступен: {e}"[:500])
            log_llm(db, llm, project)

            if result is not None:
                out = EditOut(ok=False, summary=result.summary,
                              question=_question(result.question) if result.question else None,
                              error=result.error or None)
                if result.ok and not result.changed:
                    out.ok = True  # мастер попросил ничего не менять — без новой версии
                elif result.ok and result.tree is not None:
                    measured = is_measured(project)
                    before_er = compute_range(version, workshop, measured)
                    before = before_er.low.total_client if before_er else None
                    try:
                        new = create_version(db, project, result.tree, author_id=user_id, source=VersionSource.ai,
                                             label_text=(result.summary or instruction)[:200], reject_on_errors=True)
                    except ApiError as e:
                        out.error = e.message
                        out.issues = (e.details or {}).get("issues", []) if isinstance(e.details, dict) else []
                    else:
                        after_er = compute_range(new, workshop, measured)
                        after = after_er.low.total_client if after_er else None
                        if after_er is not None:  # цена новой версии — в кэш для списка проектов
                            new.price_cache = price_of(after_er)
                        master_msg.version_id = new.id
                        out.ok, out.version_id, out.issues, out.error = True, str(new.id), new.issues, None
                        if before is not None and after is not None:
                            out.price_delta = PriceDelta(**{"from": before, "to": after})

            if out.ok and out.version_id is None:
                add_chat(db, project, "ai", out.summary or "Оставил как есть", kind="edit")
            elif out.ok:
                add_chat(db, project, "ai", out.summary or "Готово", kind="edit",
                         version_id=uuid.UUID(out.version_id),
                         price_delta=out.price_delta.model_dump(by_alias=True) if out.price_delta else None)
            elif out.question is not None:
                add_chat(db, project, "ai", out.question.text, kind="question", options=out.question.options)
            else:
                add_chat(db, project, "ai", "Не получилось изменить модель: " + (out.error or "ИИ не справился"),
                         kind="error")
            db.flush()
            out.budget = budget_state(db, self.settings, project)
            db.commit()
            return out.model_dump(mode="json", by_alias=True)

    def on_task_done(self, info) -> None:
        """Модель готова, а мастер ушёл (приложение давно не опрашивало задачу) → push (раздел 19)."""
        if info.name not in ("ai.design", "ai.answer", "ai.choose_type", "ai.choose_object") or info.state != "done":
            return
        result = info.result or {}
        if not isinstance(result, dict) or not result.get("version_id"):
            return
        if (utcnow() - info.seen_at).total_seconds() <= self.settings.push_presence_seconds:
            return
        from . import events

        with self.db.sessionmaker() as db:
            project = db.get(Project, uuid.UUID(info.payload["project_id"]))
            version = db.get(ModelVersion, uuid.UUID(result["version_id"]))
            if project is None or version is None:
                return
            if version.price_cache is None:
                er = compute_range(version, db.get(Workshop, project.workshop_id), is_measured(project))
                if er is not None:
                    version.price_cache = price_of(er)
            events.model_ready(db, project, version)
            db.commit()

    def register(self, tasks) -> None:
        tasks.add_listener(self.on_task_done)
        tasks.register("ai.design", self.design)
        tasks.register("ai.answer", self.answer)
        tasks.register("ai.choose_type", self.choose_type)
        tasks.register("ai.choose_object", self.choose_object)
        tasks.register("ai.edit", self.edit)
