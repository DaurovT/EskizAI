"""Вызов Claude API: модели, структурированный вывод, кэш, журнал стоимости.

Модели — из PRD (раздел 6): Sonnet 5.5 — фото, дерево модулей, вопросы;
Haiku 5.5 — простые правки словами.
"""

import json
import time
from dataclasses import dataclass, field
from typing import Any

import anthropic
from pydantic import BaseModel, ValidationError

from .schema import output_schema

import os

OPUS = "claude-opus-5-5"
SONNET = "claude-sonnet-5-5"
HAIKU = "claude-haiku-5-5"

# Модель распознавания фото и сборки дерева: Opus 5.5 видит фото точнее (≈ $0,12 против $0,06 у Sonnet).
# Переопределяется переменной окружения MEBEL_DESIGN_MODEL.
DESIGN_MODEL = os.environ.get("MEBEL_DESIGN_MODEL", OPUS)

# $ за 1 млн токенов: вход, выход, чтение кэша, запись кэша (×1,25 входа)
PRICES = {
    OPUS: (4.00, 20.00, 0.40, 5.00),
    SONNET: (2.00, 10.00, 0.20, 2.50),
    HAIKU: (0.10, 0.50, 0.01, 0.125),
}


@dataclass
class AIRequestRecord:
    """Строка ИИ-журнала (FR-38, ADM-11)."""

    model: str
    purpose: str  # design, answer, edit
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float
    duration_ms: int
    stop_reason: str
    validation: str  # ok, schema_error, build_error, refusal
    served_by: str = ""


class AIRefused(Exception):
    """Модель отказалась отвечать (stop_reason=refusal)."""


@dataclass
class LLM:
    """Тонкая обёртка: один вызов → проверенный pydantic-ответ + запись в журнал."""

    client: Any = None
    log: list[AIRequestRecord] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.client is None:
            self.client = anthropic.Anthropic()

    def call(self, *, model: str, system: str, messages: list[dict], response_model: type[BaseModel],
             purpose: str, effort: str = "medium", max_tokens: int = 16000) -> tuple[BaseModel | None, Any, str]:
        """Возвращает (ответ или None, сырой ответ API, ошибку валидации).

        Системный промпт кэшируется: он одинаковый у всех мастеров.
        """
        params: dict[str, Any] = dict(
            model=model,
            max_tokens=max_tokens,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
            messages=messages,
            output_config={"effort": effort,
                           "format": {"type": "json_schema", "schema": output_schema(response_model)}},
        )
        started = time.monotonic()
        if model in (SONNET, OPUS):
            # Если классификатор безопасности откажет — сервер сам повторит запрос на запасной модели
            response = self.client.beta.messages.create(
                **params, betas=["server-side-fallback-2026-07-01"], fallbacks="default"
            )
        else:
            response = self.client.messages.create(**params)
        duration = int((time.monotonic() - started) * 1000)

        parsed, error, validation = None, "", "ok"
        if response.stop_reason == "refusal":
            validation, error = "refusal", "Модель отказалась отвечать"
        elif response.stop_reason == "max_tokens":
            validation, error = "schema_error", "Ответ обрезан по лимиту токенов"
        else:
            text = next((b.text for b in response.content if getattr(b, "type", "") == "text"), "")
            try:
                parsed = response_model.model_validate(json.loads(text))
            except (json.JSONDecodeError, ValidationError) as e:
                validation, error = "schema_error", str(e)[:2000]

        self.log.append(self._record(model, purpose, response, duration, validation))
        if validation == "refusal":
            raise AIRefused(error)
        return parsed, response, error

    def mark_last(self, validation: str) -> None:
        if self.log:
            self.log[-1].validation = validation

    @staticmethod
    def _record(model: str, purpose: str, response: Any, duration: int, validation: str) -> AIRequestRecord:
        u = response.usage
        inp = getattr(u, "input_tokens", 0) or 0
        out = getattr(u, "output_tokens", 0) or 0
        cr = getattr(u, "cache_read_input_tokens", 0) or 0
        cw = getattr(u, "cache_creation_input_tokens", 0) or 0
        p_in, p_out, p_cr, p_cw = PRICES.get(getattr(response, "model", model), PRICES[model])
        cost = (inp * p_in + out * p_out + cr * p_cr + cw * p_cw) / 1_000_000
        return AIRequestRecord(model=model, purpose=purpose, input_tokens=inp, output_tokens=out,
                               cache_read_tokens=cr, cache_write_tokens=cw, cost_usd=round(cost, 6),
                               duration_ms=duration, stop_reason=response.stop_reason or "", validation=validation,
                               served_by=getattr(response, "model", model))

    @property
    def total_cost(self) -> float:
        return round(sum(r.cost_usd for r in self.log), 6)

    @property
    def total_tokens(self) -> int:
        return sum(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens for r in self.log)


def content_to_params(content: list) -> list[dict]:
    """Ответ модели → блоки для истории. Передаём всё как есть, включая блоки размышлений."""
    out = []
    for b in content:
        out.append(b.model_dump(exclude_none=True) if hasattr(b, "model_dump") else dict(b))
    return out
