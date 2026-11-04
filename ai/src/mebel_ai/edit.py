"""Правки словами (FR-13): «шире на 20 см», «добавь ящики вниз», «дверцы только на нижнюю тумбу».

Модель возвращает JSON Patch к дереву; патч применяется и проверяется сборкой ядра.

Порядок моделей:
- есть фото проекта → Sonnet 5.5 (видит фото), до двух попыток;
- нет фото → Haiku 5.5, затем Sonnet 5.5. Если Haiku вместо правки задаёт вопрос, сначала
  пробуем Sonnet — мастеру уходит только его вопрос (раздел 6 PRD: Haiku — для простых правок).

ИИ видит последние сообщения чата (свои вопросы и ответы мастера), поэтому не переспрашивает.
«Ничего не менять» — нормальный ответ: правка без изменений, не ошибка.
"""

import base64
import json
from dataclasses import dataclass, field
from typing import Optional

from mebel_core import BuildResult, PatchOp, apply_patch, build, parse_tree
from pydantic import ValidationError

from .llm import HAIKU, LLM, SONNET, AIRefused
from .prompts import EDIT_SYSTEM
from .schema import EditResponse, Question


@dataclass
class EditResult:
    ok: bool
    tree: Optional[dict] = None
    build: Optional[BuildResult] = None
    summary: str = ""
    question: Optional[Question] = None
    error: str = ""
    changed: bool = True  # False — мастер попросил ничего не менять
    attempts: list[str] = field(default_factory=list)  # какие модели пробовали


def _content(base: str, photos: list | None) -> list[dict] | str:
    if not photos:
        return base
    blocks: list[dict] = []
    for p in photos[:5]:
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": p.media_type,
                                                   "data": base64.standard_b64encode(p.data).decode()}})
    blocks.append({"type": "text", "text": base})
    return blocks


def edit_tree(tree: dict, instruction: str, llm: LLM | None = None, language: str = "ru",
              history: list[str] | None = None, photos: list | None = None) -> EditResult:
    """history — последние сообщения чата строками «Мастер: …» / «ИИ: …»; photos — фото проекта (Photo)."""
    llm = llm or LLM()
    lang = "Russian" if language == "ru" else "Uzbek (Latin)"
    base = (f"Master's language: {lang}.\n"
            + ("Photos of what the client wants are attached.\n" if photos else "")
            + f"Current tree:\n{json.dumps(tree, ensure_ascii=False)}\n"
            + ("Recent chat (oldest first):\n" + "\n".join(history[-12:]) + "\n" if history else "")
            + f"Master's new message: {instruction}")
    models = [SONNET, SONNET] if photos else [HAIKU, SONNET, SONNET]
    result = EditResult(ok=False)
    feedback = ""
    for i, model in enumerate(models):
        result.attempts.append(model)
        text = base + (f"\nPrevious attempt failed: {feedback}" if feedback else "")
        try:
            parsed, raw, error = llm.call(model=model, system=EDIT_SYSTEM,
                                          messages=[{"role": "user", "content": _content(text, photos)}],
                                          response_model=EditResponse, purpose="edit",
                                          effort="low" if model == HAIKU else "medium", max_tokens=8000)
        except AIRefused as e:
            result.error = str(e)
            return result
        if parsed is None:
            feedback = f"Ответ не прошёл схему: {error}"
        elif not parsed.ops and parsed.question is None:
            # Ничего менять не нужно
            return EditResult(ok=True, tree=tree, summary=parsed.summary or "Оставил как есть",
                              changed=False, attempts=result.attempts)
        elif not parsed.ops:
            # Вопрос: от Haiku — сначала пробуем более сильную модель, от Sonnet — отдаём мастеру
            if model == HAIKU and i + 1 < len(models):
                feedback = ("Instead of asking, make the most reasonable change you can infer from the tree and "
                            "the chat; ask only if it is truly impossible to decide.")
                continue
            return EditResult(ok=False, tree=tree, summary=parsed.summary, question=parsed.question,
                              attempts=result.attempts)
        else:
            try:
                patch = [PatchOp(op=o.op, path=o.path, value=json.loads(o.value_json) if o.value_json else None)
                         for o in parsed.ops]
                new_tree = apply_patch(tree, patch)
                built = build(parse_tree(new_tree))
            except (ValueError, KeyError, IndexError, TypeError, ValidationError) as e:
                feedback = f"Патч не применился: {str(e)[:1500]}"
            else:
                errors = [x for x in built.issues if x.level == "error"]
                if not errors:
                    return EditResult(ok=True, tree=new_tree, build=built, summary=parsed.summary,
                                      attempts=result.attempts)
                feedback = "После правки изделие не собирается: " + "; ".join(x.message for x in errors)
            llm.mark_last("build_error")
        result.error = feedback
    return result
