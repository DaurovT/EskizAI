"""Подставной клиент Anthropic (как в ai/tests/fake.py): заготовленные ответы, запросы запоминаются.

Живых запросов к Claude API в тестах нет.
"""

import copy
import json
from dataclasses import dataclass, field
from types import SimpleNamespace

from .conftest import GOOD_TREE

SONNET, HAIKU = "claude-sonnet-5-5", "claude-haiku-5-5"


def text_block(obj) -> SimpleNamespace:
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return SimpleNamespace(type="text", text=text, model_dump=lambda **_: {"type": "text", "text": text})


def response(obj, model=SONNET, stop="end_turn", usage=(5000, 800, 0, 4000)):
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
                reply = outer.replies.pop(0)
                if isinstance(reply, Exception):
                    raise reply
                return reply

        self.messages = _Messages()
        self.beta = SimpleNamespace(messages=_Messages())


def design(tree=None, questions=None, confidence=0.9, **extra) -> dict:
    d = {
        "product_kind": "распашной шкаф", "confidence": confidence, "alternatives": ["шкаф-купе", "стеллаж"],
        "elements": [{"name": "двери", "kind": "door", "count": 2, "sure": True, "note": ""}],
        "understood": ["шкаф 1200 мм, две секции"], "unclear": [],
        # Формат ответа mebel_ai (DesignWire): дерево строкой JSON, рамки предметов — objects
        "tree_json": json.dumps({"type": "wardrobe", **copy.deepcopy(tree or GOOD_TREE)}, ensure_ascii=False),
        "estimated": ["/height"], "questions": questions or [], "differences": [], "objects": [], "message": "Готово",
    }
    d.update(extra)
    return d


def edit_reply(ops, summary="Готово", question=None) -> dict:
    return {"ops": ops, "summary": summary, "question": question}
