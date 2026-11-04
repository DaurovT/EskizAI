"""ИИ-эндпоинты: контракт для приложения мастера (раздел 6 PRD).

Тяжёлая работа идёт через очередь: POST → 202 {task_id}; результат — GET /tasks/{task_id}
(`result` — DesignOut или EditOut).
"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TaskAccepted(BaseModel):
    task_id: str


class DesignIn(BaseModel):
    text: str | None = Field(None, max_length=4000, description="Описание мастера или клиента")
    photo_ids: list[uuid.UUID] | None = Field(
        None, max_length=5, description="Фото проекта (POST /projects/{id}/photos); не задано — все исходные фото"
    )
    language: Literal["ru", "uz"] | None = Field(None, description="Не задан — язык мастера")
    confirm_extra_project: bool = Field(False, description="Бюджет ИИ исчерпан: списать ещё один проект из лимита")


class AnswerItem(BaseModel):
    question_id: str = Field(min_length=1, max_length=100)
    value: str = Field(max_length=500, description="Выбранный вариант, свой текст или «не знаю» (= по умолчанию)")


MAX_ANSWERS = 50


class AnswerIn(BaseModel):
    answers: dict[str, str] | list[AnswerItem] = Field(
        description="Все ответы разом: [{question_id, value}] или (прежняя форма) id вопроса → ответ. "
                    f"Не больше {MAX_ANSWERS} ответов, ответ — до 500 символов; в ИИ уходят только ответы на "
                    "заданные вопросы (GET /projects/{id}/chat → questions), прочие id отбрасываются")
    confirm_extra_project: bool = False

    @field_validator("answers")
    @classmethod
    def _bounded(cls, v):
        if len(v) > MAX_ANSWERS:
            raise ValueError(f"Не больше {MAX_ANSWERS} ответов")
        if isinstance(v, dict):
            for k, val in v.items():
                if len(k) > 100:
                    raise ValueError("id вопроса — до 100 символов")
                if len(val) > 500:
                    raise ValueError("Ответ — не длиннее 500 символов")
        return v

    def answer_map(self) -> dict[str, str]:
        if isinstance(self.answers, dict):
            return dict(self.answers)
        return {a.question_id: a.value for a in self.answers}


class ChooseTypeIn(BaseModel):
    product_kind: str = Field(min_length=1, max_length=100)
    confirm_extra_project: bool = False


class ChooseObjectsIn(BaseModel):
    objects: list[int] = Field(min_length=1, max_length=10,
                               description="Номера предметов в DesignOut.objects; первый остаётся в этом проекте")
    confirm_extra_project: bool = False


class ObjectProjectOut(BaseModel):
    project_id: str
    task_id: str
    object_index: int
    label: str
    title: str
    created: bool = Field(description="false — текущий проект, true — новый")


class ChooseObjectsOut(BaseModel):
    """Текущий проект первым, затем новые. Результат каждой задачи — DesignOut (GET /tasks/{task_id})."""

    projects: list[ObjectProjectOut]
    charged: int = Field(description="Сколько новых проектов списано из лимита")


class EditIn(BaseModel):
    instruction: str = Field(min_length=1, max_length=2000)
    confirm_extra_project: bool = Field(
        False, description="Бюджет ИИ на проект исчерпан: подтверждение списать ещё один проект из лимита"
    )


class ElementOut(BaseModel):
    name: str
    kind: str
    count: int
    sure: bool
    note: str = ""


class PhotoObjectOut(BaseModel):
    """Предмет мебели на фото, когда их несколько (тогда задаётся вопрос с id `object`)."""

    label: str
    photo: int = 0
    box: list[float] = Field(description="[x0, y0, x1, y1] в долях ширины и высоты фото, 0–1")
    chosen: bool = False
    size: list[int] = Field(default_factory=list, description="Примерные габариты [ширина, глубина, высота], мм")
    summary: str = Field("", description="Коротко: «2 двери», «3 ящика»")


class QuestionOut(BaseModel):
    id: str
    text: str
    options: list[str]
    default: str
    affects: str


class PriceDelta(BaseModel):
    """Цена для клиента до и после правки, сумы (по оценочным размерам, без округления диапазона)."""

    model_config = ConfigDict(populate_by_name=True)

    from_: int = Field(alias="from")
    to: int


class BudgetOut(BaseModel):
    spent_usd: float
    limit_usd: float = Field(description="Бюджет проекта с учётом доп. списаний")
    percent: int
    extra_projects: int = Field(description="Сколько раз списан доп. проект за перерасход")
    warning: bool = Field(description="Потрачено ≥ 80% — показать плашку")
    exceeded: bool = Field(description="Следующий ИИ-запрос требует confirm_extra_project")
    message: str | None = None


class DesignOut(BaseModel):
    status: Literal["ready", "questions", "choose_type", "failed"]
    product_kind: str = ""
    confidence: float = 0
    alternatives: list[str] = []
    elements: list[ElementOut] = []
    understood: list[str] = []
    unclear: list[str] = []
    estimated: list[str] = Field(default_factory=list, description="JSON Pointer'ы значений «оценка»")
    questions: list[QuestionOut] = []
    differences: list[str] = []
    objects: list[PhotoObjectOut] = Field(default_factory=list, description="Рамки предметов на фото (если их несколько)")
    room: dict[str, Any] | None = Field(None, description="Пустая ниша на фото: участки стены и пола (доли фото) и "
                                                          "подсказки цвета; снятый с фото цвет — в tree.room_colors")
    message: str = ""
    version_id: str | None = None
    issues: list[dict[str, Any]] = []
    error: str | None = None
    budget: BudgetOut | None = Field(None, description="Расширение контракта: бюджет ИИ проекта")
    answers: dict[str, str] = Field(default_factory=dict,
                                    description="Все ответы мастера в этой сессии (повторно не спрашиваются)")


class EditOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ok: bool
    summary: str = ""
    question: QuestionOut | None = None
    version_id: str | None = None
    price_delta: PriceDelta | None = None
    issues: list[dict[str, Any]] = []
    error: str | None = None
    budget: BudgetOut | None = Field(None, description="Расширение контракта: бюджет ИИ проекта")


class ChatMessageOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    author: Literal["master", "ai"]
    kind: str = Field("text", description="design, answer, choose_type, edit, question, error")
    text: str
    options: list[str] | None = None
    version_id: str | None = None
    price_delta: PriceDelta | None = None
    undone: bool = False
    created_at: datetime


class ChatOut(BaseModel):
    messages: list[ChatMessageOut]
    questions: list[QuestionOut] = Field(default_factory=list,
                                         description="Вопросы распознавания без ответа (ответить — POST /ai/answer)")
    answers: dict[str, str] = Field(default_factory=dict, description="Уже данные ответы: id вопроса → ответ")
