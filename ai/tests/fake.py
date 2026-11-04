"""Подставной клиент Anthropic: отдаёт заранее заготовленные ответы и запоминает запросы."""

import json
from dataclasses import dataclass, field
from types import SimpleNamespace


def text_block(obj) -> SimpleNamespace:
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return SimpleNamespace(type="text", text=text, model_dump=lambda **_: {"type": "text", "text": text})


def response(obj, model="claude-sonnet-5-5", stop="end_turn", usage=(5000, 800, 0, 4000)):
    inp, out, cr, cw = usage
    return SimpleNamespace(
        content=[text_block(obj)], stop_reason=stop, model=model,
        usage=SimpleNamespace(input_tokens=inp, output_tokens=out, cache_read_input_tokens=cr,
                              cache_creation_input_tokens=cw),
    )


@dataclass
class FakeClient:
    replies: list
    calls: list = field(default_factory=list)

    def __post_init__(self):
        outer = self

        class _Messages:
            def create(self, **kwargs):
                outer.calls.append(kwargs)
                return outer.replies.pop(0)

        self.messages = _Messages()
        self.beta = SimpleNamespace(messages=_Messages())
