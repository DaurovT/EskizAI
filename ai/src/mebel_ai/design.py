"""Сессия проектирования: фото или текст → дерево модулей → вопросы → ответы.

Раздел 6 PRD:
- ответ всегда проверяется схемой; невалидный — повтор, максимум 2, потом вопрос мастеру;
- уверенность < 0,6 → мастер выбирает тип изделия сам из вариантов;
- размеры с фото — «оценка», пока мастер не подтвердит;
- до эскиза — не больше 3 вопросов.

История сообщений только дописывается (append-only): так блоки размышлений модели
остаются действительными и работает кэш.
"""

import base64
import json
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from mebel_core import BuildResult, build, parse_tree
from pydantic import ValidationError

from .llm import DESIGN_MODEL, LLM, SONNET, AIRefused, content_to_params
from .prompts import design_system
from .schema import DesignResponse, DesignWire, Question

MAX_RETRIES = 2
LOW_CONFIDENCE = 0.6
DONT_KNOW = "не знаю"  # ответ мастера «не знаю» → значение по умолчанию, «оценка»


@dataclass
class Photo:
    data: bytes
    media_type: str = "image/jpeg"


@dataclass
class DesignResult:
    status: Literal["ready", "questions", "choose_type", "failed"]
    response: Optional[DesignResponse]
    tree: Optional[dict]
    build: Optional[BuildResult]
    questions: list[Question] = field(default_factory=list)
    error: str = ""

    @property
    def issues(self) -> list:
        return self.build.issues if self.build else []


@dataclass
class DesignSession:
    language: Literal["ru", "uz"] = "ru"
    llm: LLM = field(default_factory=LLM)
    messages: list[dict] = field(default_factory=list)
    model: str = DESIGN_MODEL  # Opus 5.5 по умолчанию; SONNET — дешевле и быстрее
    last: Optional[DesignResponse] = None
    # Все ответы мастера за сессию (id вопроса → ответ): повторно эти вопросы не задаём
    answers: dict[str, str] = field(default_factory=dict)

    # --- Публичные шаги ---

    def start(self, text: str = "", photos: list[Photo] | None = None) -> DesignResult:
        if not text and not photos:
            raise ValueError("Нужно фото или описание")
        content: list[dict] = []
        for p in (photos or [])[:5]:
            content.append({"type": "image", "source": {"type": "base64", "media_type": p.media_type,
                                                        "data": base64.standard_b64encode(p.data).decode()}})
        intro = "Сделай дерево модулей по фото и описанию." if photos else "Сделай дерево модулей по описанию."
        content.append({"type": "text", "text": f"{intro}\nОписание мастера: {text or '—'}"})
        self.messages.append({"role": "user", "content": content})
        return self._run("design")

    def answer(self, answers: dict[str, str], questions: dict[str, Any] | None = None,
               current_tree: dict | None = None, notes: list[str] | None = None) -> DesignResult:
        """Ответы мастера на вопросы (id вопроса → вариант или свой текст), все разом.

        `questions` — заданные вопросы (текст и значение по умолчанию): с ними ответ однозначен для модели.
        «не знаю» — значение по умолчанию с пометкой «оценка».
        `current_tree` — дерево с правками мастера после распознавания: ответы применяются к нему, правки не теряются.
        """
        self.answers.update(answers)
        lines = []
        for qid, value in answers.items():
            q = (questions or {}).get(qid)
            head = f"- {qid}" + (f" («{q.text}»)" if q and q.text else "")
            if value.strip().lower() == DONT_KNOW:
                dflt = f" «{q.default}»" if q and q.default else ""
                lines.append(f"{head}: не знаю — поставь значение по умолчанию{dflt} и отметь его как оценку")
            else:
                lines.append(f"{head}: {value}")
        for n in notes or []:
            lines.append(f"- замечание мастера: {n}")
        asked = ", ".join(self.answers)
        base = ""
        if current_tree:
            base = ("\nМастер уже правил модель после распознавания — бери за основу это дерево и сохрани его правки:\n"
                    + json.dumps(current_tree, ensure_ascii=False))
        self.messages.append({"role": "user", "content": [{"type": "text", "text":
                              "Ответы мастера:\n" + "\n".join(lines) + "\nОбнови дерево с учётом всех ответов. "
                              f"Уже отвечено (не спрашивай снова): {asked}. Новые вопросы — "
                              "только если без них нельзя изготовить." + base}]})
        return self._run("answer")

    def choose_object(self, label: str, *, photo: int | None = None, box: list[float] | None = None) -> DesignResult:
        """Мастер выбрал предмет на фото, где их несколько. Рамка — чтобы не спутать одинаковые названия."""
        if not box:
            return self.answer({"object": label})
        self.answers["object"] = label
        where = f" (фото {photo or 0}, рамка {[round(float(v), 3) for v in box[:4]]})"
        self.messages.append({"role": "user", "content": [{"type": "text", "text":
                              f"Мастер выбрал предмет на фото:\n- object: {label}{where}\n"
                              "Собери дерево только для этого предмета (в `objects` у него chosen: true, у остальных "
                              "false). Новые вопросы — только если без них нельзя изготовить."}]})
        return self._run("answer")

    def choose_type(self, product_kind: str) -> DesignResult:
        self.messages.append({"role": "user", "content": [{"type": "text", "text":
                              f"Мастер выбрал тип изделия: {product_kind}. Пересобери дерево под него."}]})
        return self._run("answer")

    # --- Внутреннее ---

    def _run(self, purpose: str) -> DesignResult:
        system = design_system(self.language)
        error = ""
        for attempt in range(MAX_RETRIES + 1):
            try:
                wire, raw, error = self.llm.call(model=self.model, system=system, messages=self.messages,
                                                 response_model=DesignWire, purpose=purpose)
            except AIRefused as e:
                return DesignResult(status="failed", response=None, tree=None, build=None, error=str(e))
            self.messages.append({"role": "assistant", "content": content_to_params(raw.content)})

            parsed = None
            if wire is not None:
                try:
                    parsed = wire.to_response()
                except (ValueError, ValidationError) as e:  # tree_json — не JSON или не по схеме дерева
                    error = str(e)[:2000]
                    self.llm.mark_last("schema_error")
            if parsed is None:
                feedback = (f"Ответ не прошёл проверку схемы: {error}. Верни исправленный ответ целиком; "
                            "tree_json — валидный JSON строго по схеме дерева.")
            else:
                tree = parsed.tree.model_dump(exclude_none=True, mode="json")
                try:
                    result = build(parse_tree(tree))
                except ValidationError as e:  # схема прошла, а модель дерева — нет (ограничения значений)
                    result, error = None, str(e)[:2000]
                    feedback = f"Дерево не прошло проверку: {error}. Исправь значения."
                else:
                    errors = [i for i in result.issues if i.level == "error"]
                    if not errors:
                        return self._result(parsed, tree, result)
                    error = "; ".join(i.message for i in errors)
                    feedback = ("Ядро не смогло собрать изделие: " + error +
                                ". Исправь дерево (не меняя того, что подтвердил мастер).")
                self.llm.mark_last("build_error")
            if attempt < MAX_RETRIES:
                self.messages.append({"role": "user", "content": [{"type": "text", "text": feedback}]})

        # Два повтора не помогли: мастер собирает дерево сам (раздел 19 PRD)
        return DesignResult(status="failed", response=parsed if "parsed" in dir() else None, tree=None, build=None,
                            error=error or "ИИ не справился")

    def _result(self, parsed: DesignResponse, tree: dict, result: BuildResult) -> DesignResult:
        self.last = parsed
        # отвеченное не переспрашиваем, даже если модель вернула тот же вопрос
        questions = [q for q in parsed.questions if q.id not in self.answers][:6]
        if parsed.confidence < LOW_CONFIDENCE:
            status = "choose_type"
        elif questions:
            status = "questions"
        else:
            status = "ready"
        return DesignResult(status=status, response=parsed, tree=tree, build=result, questions=questions)

    # --- Сохранение между запросами (сессия живёт в базе API) ---

    def to_json(self) -> str:
        return json.dumps({"language": self.language, "messages": self.messages, "answers": self.answers},
                          ensure_ascii=False)

    @classmethod
    def from_json(cls, data: str, llm: LLM | None = None) -> "DesignSession":
        d = json.loads(data)
        return cls(language=d["language"], messages=d["messages"], answers=dict(d.get("answers") or {}),
                   llm=llm or LLM())


def describe(result: DesignResult) -> str:
    """Короткий текстовый отчёт — для CLI."""
    r = result.response
    lines = [f"Статус: {result.status}"]
    if result.error:
        lines.append(f"Ошибка: {result.error}")
    if r:
        lines += [f"Изделие: {r.product_kind} (уверенность {r.confidence:.2f}; ещё: {', '.join(r.alternatives)})",
                  "Понял: " + "; ".join(r.understood), "Неясно: " + ("; ".join(r.unclear) or "—"),
                  "Оценка: " + (", ".join(r.estimated) or "—"), f"Мастеру: {r.message}"]
        for q in result.questions:
            lines.append(f"? [{q.id}] {q.text} — {' / '.join(q.options)} (по умолчанию: {q.default})")
        if r.differences:
            lines.append("Не совпадает с фото: " + "; ".join(r.differences))
    if result.build:
        lines.append(f"Деталей: {len(result.build.parts)}; замечаний: {len(result.build.issues)}")
    return "\n".join(lines)


__all__ = ["DesignSession", "DesignResult", "Photo", "describe", "Any"]
