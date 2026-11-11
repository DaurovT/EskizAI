"""Логика ИИ на подставном клиенте: повторы, проверка сборкой, вопросы, правки, журнал."""

import copy
import json
from pathlib import Path

import pytest

from mebel_ai import LLM, DesignSession, Photo, edit_tree
from mebel_ai.schema import DesignWire, EditResponse, output_schema
from tests.fake import FakeClient, response

CORE_FIXTURES = Path(__file__).resolve().parents[2] / "core" / "tests" / "fixtures"
TREE = json.loads((CORE_FIXTURES / "wardrobe_2sec.json").read_text(encoding="utf-8"))


def design(tree=None, questions=None, confidence=0.9, **extra) -> dict:
    d = {
        "product_kind": "распашной шкаф", "confidence": confidence, "alternatives": ["шкаф-купе", "стеллаж"],
        "elements": [{"name": "двери", "kind": "door", "count": 2, "sure": True, "note": ""}],
        "understood": ["шкаф 1200 мм, две секции"], "unclear": [],
        "tree_json": json.dumps({"type": "wardrobe", **(tree or TREE)}, ensure_ascii=False),
        "estimated": ["/height"], "questions": questions or [], "differences": [], "objects": [],
        "message": "Готово",
    }
    d.update(extra)
    return d


def test_schema_has_no_unsupported_keywords() -> None:
    text = json.dumps(output_schema(DesignWire)) + json.dumps(output_schema(EditResponse))
    for bad in ('"oneOf"', '"minimum"', '"maximum"', '"discriminator"', '"exclusiveMinimum"'):
        assert bad not in text
    # Все объекты закрыты
    def walk(n):
        if isinstance(n, dict):
            if n.get("type") == "object" and "properties" in n:
                assert n.get("additionalProperties") is False
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)
    walk(output_schema(DesignWire))


def test_design_ready_and_request_shape() -> None:
    client = FakeClient([response(design())])
    s = DesignSession(llm=LLM(client=client))
    r = s.start("шкаф 1,2 м, две двери", photos=[Photo(b"\xff\xd8fake")])
    assert r.status == "ready" and r.build.ok and len(r.build.parts) > 10
    call = client.calls[0]
    assert call["model"] == "claude-opus-5-5"  # распознавание — Opus 5.5 по умолчанию
    assert call["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in call["betas"]
    assert call["system"][0]["cache_control"]["type"] == "ephemeral"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert "tool_choice" not in call  # принудительный вызов инструмента на Sonnet 5.5 запрещён
    assert call["messages"][0]["content"][0]["type"] == "image"
    rec = s.llm.log[0]
    assert rec.validation == "ok" and rec.cost_usd > 0


def test_questions_capped_at_six_and_answer_appends_history() -> None:
    qs = [{"id": f"q{i}", "text": "?", "options": ["а", "б"], "default": "а", "affects": "/width"} for i in range(8)]
    client = FakeClient([response(design(questions=qs)), response(design())])
    s = DesignSession(llm=LLM(client=client))
    r = s.start("шкаф")
    assert r.status == "questions" and len(r.questions) == 6
    before = copy.deepcopy(s.messages)
    r2 = s.answer({"q0": "а"})
    assert r2.status == "ready"
    assert s.messages[: len(before)] == before  # история только дописывается


def test_low_confidence_asks_to_choose_type() -> None:
    s = DesignSession(llm=LLM(client=FakeClient([response(design(confidence=0.4))])))
    assert s.start("что-то").status == "choose_type"


def test_schema_error_then_build_error_then_success() -> None:
    bad_build = dict(TREE, sections=[{"width": 500}, {"width": 500}])  # сумма ширин не сходится
    client = FakeClient([response("не json"), response(design(tree=bad_build)), response(design())])
    s = DesignSession(llm=LLM(client=client))
    r = s.start("шкаф")
    assert r.status == "ready"
    assert [x.validation for x in s.llm.log] == ["schema_error", "build_error", "ok"]
    # Ошибка сборки передана модели текстом
    assert "Сумма ширин секций" in s.messages[-2]["content"][0]["text"]


def test_gives_up_after_two_retries() -> None:
    client = FakeClient([response("x"), response("y"), response("z")])
    r = DesignSession(llm=LLM(client=client)).start("шкаф")
    assert r.status == "failed" and len(client.calls) == 3


def test_refusal_fails_gracefully() -> None:
    client = FakeClient([response("", stop="refusal")])
    s = DesignSession(llm=LLM(client=client))
    r = s.start("шкаф")
    assert r.status == "failed" and s.llm.log[0].validation == "refusal"


def test_session_roundtrip_json() -> None:
    s = DesignSession(llm=LLM(client=FakeClient([response(design())])))
    s.start("шкаф")
    s2 = DesignSession.from_json(s.to_json(), llm=LLM(client=FakeClient([])))
    assert s2.messages == s.messages


def test_edit_with_haiku_patch() -> None:
    reply = {"ops": [{"op": "replace", "path": "/width", "value_json": "1400"}], "summary": "Шире на 20 см",
             "question": None}
    client = FakeClient([response(reply, model="claude-haiku-5-5")])
    r = edit_tree(TREE, "шире на 20 см", llm=LLM(client=client))
    assert r.ok and r.tree["width"] == 1400 and r.build.size[0] == 14000
    assert client.calls[0]["model"] == "claude-haiku-5-5" and "fallbacks" not in client.calls[0]


def test_edit_escalates_to_sonnet_after_two_bad_patches() -> None:
    bad = {"ops": [{"op": "replace", "path": "/sections/0/width", "value_json": "5000"}], "summary": "",
           "question": None}
    good = {"ops": [{"op": "replace", "path": "/sections/0/doors", "value_json": '{"count": 1}'}],
            "summary": "Дверь в первой секции", "question": None}
    client = FakeClient([response(bad, model="claude-haiku-5-5"), response(bad), response(good)])
    r = edit_tree(TREE, "дверь в первую секцию", llm=LLM(client=client))
    assert r.ok and r.attempts == ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"]


def test_edit_ambiguous_returns_question() -> None:
    reply = {"ops": [], "summary": "Уточните", "question": {"id": "which", "text": "В какую секцию?",
             "options": ["левую", "правую"], "default": "левую", "affects": "/sections"}}
    # Вопрос от Haiku сначала уходит к Sonnet; мастеру — только вопрос Sonnet
    client = FakeClient([response(reply, model="claude-haiku-5-5"), response(reply)])
    r = edit_tree(TREE, "добавь ящики", llm=LLM(client=client))
    assert not r.ok and r.question.id == "which" and r.attempts == ["claude-haiku-5-5", "claude-sonnet-5-5"]


def test_several_objects_on_photo_ask_which() -> None:
    objects = [
        {"label": "шкаф слева", "photo": 0, "box": [0.05, 0.1, 0.45, 0.95], "chosen": True},
        {"label": "тумба под ТВ", "photo": 0, "box": [0.5, 0.6, 0.95, 0.9], "chosen": False},
    ]
    q = [{"id": "object", "text": "Какой предмет делаем?", "options": ["шкаф слева", "тумба под ТВ"],
          "default": "шкаф слева", "affects": "/"}]
    client = FakeClient([response(design(questions=q, objects=objects)), response(design())])
    s = DesignSession(llm=LLM(client=client))
    r = s.start("как на фото", photos=[Photo(b"x")])
    assert r.status == "questions" and len(r.response.objects) == 2 and r.questions[0].id == "object"
    assert s.choose_object("шкаф слева").status == "ready"
    assert "object: шкаф слева" in s.messages[-2]["content"][0]["text"]


def test_choose_object_with_box_continues_copied_session() -> None:
    """Несколько предметов → несколько проектов: копия сессии продолжается выбором своего предмета по рамке."""
    objects = [
        {"label": "шкаф", "photo": 0, "box": [0.05, 0.1, 0.45, 0.95], "chosen": True,
         "size": [1200, 600, 2200], "summary": "2 двери"},
        {"label": "шкаф", "photo": 0, "box": [0.5, 0.1, 0.95, 0.95], "chosen": False},
    ]
    client = FakeClient([response(design(objects=objects)), response(design())])
    s = DesignSession(llm=LLM(client=client))
    r = s.start("как на фото", photos=[Photo(b"x")])
    assert r.response.objects[0].size == [1200, 600, 2200] and r.response.objects[0].summary == "2 двери"
    assert r.response.objects[1].size == [] and r.response.objects[1].summary == ""
    copy_ = DesignSession.from_json(s.to_json(), llm=LLM(client=client))
    assert copy_.choose_object("шкаф", photo=0, box=[0.5, 0.1, 0.95, 0.95]).status == "ready"
    text = copy_.messages[-2]["content"][0]["text"]
    assert "object: шкаф" in text and "[0.5, 0.1, 0.95, 0.95]" in text
    # история копии начинается с исходного фото — кэш промпта общий
    assert client.calls[1]["messages"][0]["content"][0]["type"] == "image"
    assert len(s.messages) == 2  # исходная сессия не изменилась



def test_bad_tree_json_is_retried() -> None:
    bad = design()
    bad["tree_json"] = "{не json"
    client = FakeClient([response(bad), response(design())])
    s = DesignSession(llm=LLM(client=client))
    assert s.start("шкаф").status == "ready"
    assert s.llm.log[0].validation == "schema_error"
    assert "tree_json" in s.messages[-2]["content"][0]["text"]


def test_wire_schema_is_small() -> None:
    # Грамматика структурированного вывода не должна включать полную схему дерева
    assert len(json.dumps(output_schema(DesignWire))) < 15000


def test_field_named_default_survives_cleaning() -> None:
    q = output_schema(DesignWire)["$defs"]["Question"]
    assert "default" in q["properties"] and "default" in q["required"]


def test_edit_nothing_to_change_is_ok() -> None:
    reply = {"ops": [], "summary": "Оставил как есть", "question": None}
    r = edit_tree(TREE, "ничего не меняй", llm=LLM(client=FakeClient([response(reply, model="claude-haiku-5-5")])))
    assert r.ok and not r.changed and r.tree == TREE


def test_edit_with_photos_uses_sonnet_and_sends_images_and_history() -> None:
    reply = {"ops": [{"op": "replace", "path": "/width", "value_json": "1300"}], "summary": "ok", "question": None}
    client = FakeClient([response(reply)])
    r = edit_tree(TREE, "как на фото", llm=LLM(client=client), photos=[Photo(b"x")],
                  history=["ИИ: Где добавить дверцы?", "Мастер: внизу справа"])
    assert r.ok and r.attempts == ["claude-sonnet-5-5"]
    content = client.calls[0]["messages"][0]["content"]
    assert content[0]["type"] == "image" and "Мастер: внизу справа" in content[-1]["text"]


def test_prompts_know_corner_module_and_carousel() -> None:
    from mebel_ai.prompts import EDIT_SYSTEM, design_system

    text = design_system("ru")
    assert '{"kind": "corner", "width": 900, "corner_shape": "square"' in text
    assert "«в угол карусель»" in text and "«в угол карусель»" in EDIT_SYSTEM
    assert "{{" not in text and '"swing"' in text and '"gap"' in text


def test_edit_corner_carousel_patch_builds() -> None:
    kitchen = json.loads((CORE_FIXTURES / "kitchen_corner.json").read_text(encoding="utf-8"))
    ops = [{"op": "replace", "path": "/base/2", "value_json": json.dumps(
        {"kind": "corner", "width": 900, "corner_shape": "square", "corner_fill": "carousel"})}]
    client = FakeClient([response({"ops": ops, "summary": "Угол — карусель", "question": None},
                                  model="claude-haiku-5-5")])
    r = edit_tree(kitchen, "в угол карусель", llm=LLM(client=client))
    assert r.ok and any(h.kind == "corner_carousel" for h in r.build.hardware)


def test_answers_batch_persist_and_are_not_asked_again() -> None:
    q1 = {"id": "doors", "text": "Сколько дверей?", "options": ["2", "3"], "default": "2", "affects": "/sections"}
    q2 = {"id": "legs", "text": "Какая высота ножек?", "options": ["100", "150"], "default": "100", "affects": "/plinth"}
    # второй раунд: модель снова спрашивает про двери и добавляет новый вопрос
    client = FakeClient([response(design(questions=[q1])), response(design(questions=[q1, q2])), response(design())])
    s = DesignSession(llm=LLM(client=client))
    assert [q.id for q in s.start("шкаф").questions] == ["doors"]
    r2 = s.answer({"doors": "3"}, {q.id: q for q in s.last.questions})
    assert r2.status == "questions" and [q.id for q in r2.questions] == ["legs"]
    text = s.messages[-2]["content"][0]["text"]
    assert "Сколько дверей?" in text and "doors" in text
    # сессия пережила сохранение в базу: ответы с ней
    s2 = DesignSession.from_json(s.to_json(), llm=s.llm)
    assert s2.answers == {"doors": "3"}
    r3 = s2.answer({"legs": "не знаю"}, {q.id: q for q in r2.questions})
    assert r3.status == "ready" and s2.answers == {"doors": "3", "legs": "не знаю"}
    assert "по умолчанию «100»" in s2.messages[-2]["content"][0]["text"]


def test_prompts_know_decor_handles_and_lighting() -> None:
    from mebel_ai.prompts import EDIT_SYSTEM, design_system

    text = design_system("ru")
    for phrase in ("«фрезеровка дугой»", "«добавь латунную рамку»", "«золотой кант по краю»",
                   "«подсветка под навесными тёплая»", "«покрась фасады в RAL 9001 матовый»",
                   "«ручки-кнопки золотые»", "mdf_19_paint"):
        assert phrase in EDIT_SYSTEM, phrase
    assert '"arcs"' in text and '"under_wall"' in text and '"knob"' in text and "{{" not in text
    assert "mdf_19_paint" in text  # МДФ под покраску есть в списке материалов


DECOR_EDITS = [
    ("фрезеровка дугой", [("add", "/fronts/material", "mdf_19_paint"),
                          ("add", "/fronts/style", {"milling": {"pattern": "arcs", "inset": 60, "width": 8, "depth": 3}})],
     lambda r: [p for p in r.parts if p.role == "door"]
     and all(p.decor.milling_pattern == "arcs" for p in r.parts if p.role == "door")),
    ("добавь латунную рамку", [("add", "/fronts/material", "mdf_19_paint"),
                               ("add", "/fronts/style", {"inlay": {"kind": "frame", "finish": "brass", "width": 6,
                                                                   "inset": 60}})],
     lambda r: all(p.decor.inlay_finish == "brass" for p in r.parts if p.role == "door")),
    ("золотой кант по краю", [("add", "/fronts/style", {"inlay": {"kind": "edge", "finish": "gold", "width": 4}})],
     lambda r: all(p.decor.inlay_kind == "edge" for p in r.parts if p.role == "door")),
    ("покрась фасады в RAL 9001 матовый", [
        ("add", "/fronts/material", "mdf_19_paint"),
        ("add", "/fronts/style", {"paint": {"color": "#E9E0D2", "code": "RAL 9001", "system": "RAL", "gloss": "matte"}})],
     lambda r: all(p.decor.paint["code"] == "RAL 9001" and not p.edges for p in r.parts if p.role == "door")),
    ("ручки-кнопки золотые", [("replace", "/fronts/handles", {"kind": "knob", "spacing": 128, "finish": "gold"})],
     lambda r: any(h.kind == "knob" and h.params["finish"] == "gold" for h in r.hardware)),
    ("подсветка внутри тёплая", [("add", "/lighting", [{"zone": "inside_top", "target": "all", "temp": 3000,
                                                        "sensor": "door"}])],
     lambda r: r.lights and all(lr.temp == 3000 for lr in r.lights)),
]


@pytest.mark.parametrize("message,ops,check", DECOR_EDITS, ids=[d[0] for d in DECOR_EDITS])
def test_edit_decor_patches_build(message, ops, check) -> None:
    tree = json.loads((CORE_FIXTURES / "wardrobe_full.json").read_text(encoding="utf-8"))  # с дверями и ящиками
    tree.setdefault("fronts", {})
    wire = [{"op": op, "path": path, "value_json": json.dumps(value, ensure_ascii=False)} for op, path, value in ops]
    client = FakeClient([response({"ops": wire, "summary": message, "question": None}, model="claude-haiku-5-5")])
    r = edit_tree(tree, message, llm=LLM(client=client))
    assert r.ok, r.build.issues
    assert check(r.build)


def test_edit_kitchen_gola_and_under_wall_light() -> None:
    kitchen = json.loads((CORE_FIXTURES / "kitchen_straight.json").read_text(encoding="utf-8"))
    ops = [{"op": "add", "path": "/fronts/handles", "value_json": json.dumps({"kind": "gola", "spacing": 128,
                                                                               "finish": "steel"})},
           {"op": "add", "path": "/lighting", "value_json": json.dumps(
               [{"zone": "under_wall", "target": "all", "temp": 3000, "sensor": "none"}])}]
    client = FakeClient([response({"ops": ops, "summary": "Gola и подсветка", "question": None},
                                  model="claude-haiku-5-5")])
    r = edit_tree(kitchen, "Gola и подсветка под навесными тёплая", llm=LLM(client=client))
    assert r.ok and any(h.kind == "gola_profile" for h in r.build.hardware)
    assert {lr.zone for lr in r.build.lights} == {"under_wall"}


# ---------- Встроенная мебель ----------

BUILTIN_PHRASES = ("«встроенный в нишу»", "«доборы к стене»", "«добор до потолка»", "«фальш-панель до пола слева»",
                   "«панель над холодильником»", "«фасад на посудомойку»", "«цоколь 100 с решёткой»",
                   "«без задней стенки»")


def test_prompts_know_builtin_fillers_and_false_panels() -> None:
    from mebel_ai.prompts import EDIT_SYSTEM, design_system

    text = design_system("ru")
    for phrase in BUILTIN_PHRASES:
        assert phrase in EDIT_SYSTEM, phrase
        assert phrase in text, phrase
    assert '"fillers"' in text and '"fridge"' in text and '"dw": true' in text and "{{" not in text
    assert "EMPTY niche" in text and "`room`" in text


def _niche_wardrobe() -> dict:
    tree = json.loads((CORE_FIXTURES / "wardrobe_2sec.json").read_text(encoding="utf-8"))
    tree["sections"] = [{"fill": [{"kind": "shelves", "count": 4}], "doors": {"count": 2}},
                        {"fill": [{"kind": "rod"}], "doors": {"count": 2}}]
    return tree


BUILTIN_EDITS = [
    ("встроенный в нишу 1300×2500", [("add", "/installation", "niche"),
                                       ("add", "/builtin", {"niche": {"width": 1300, "height": 2500},
                                                            "fillers": ["left", "right", "top"]}),
                                       ("replace", "/width", 1200), ("replace", "/height", 2450)],
     lambda r: {p.key for p in r.parts} >= {"builtin.filler.left", "builtin.filler.right", "builtin.filler.top"}),
    ("фальш-панель до пола слева", [("add", "/side_panels", [{"side": "left"}])],
     lambda r: any(p.key == "side_panel.left" and p.aabb().min.z == 0 for p in r.parts)),
    ("без задней стенки", [("replace", "/body/back", {"kind": "none"})],
     lambda r: not any(p.role == "back" for p in r.parts) and any(h.kind == "wall_anchor" for h in r.hardware)),
    ("на ножках", [("replace", "/body/plinth", {"height": 100, "legs": True})],
     lambda r: any(h.kind == "leg" for h in r.hardware)),
]


@pytest.mark.parametrize("message,ops,check", BUILTIN_EDITS, ids=[d[0] for d in BUILTIN_EDITS])
def test_edit_builtin_patches_build(message, ops, check) -> None:
    tree = _niche_wardrobe()
    tree.setdefault("body", {}).setdefault("back", {"kind": "nailed"})
    tree["body"].setdefault("plinth", {"height": 70})
    wire = [{"op": op, "path": path, "value_json": json.dumps(value, ensure_ascii=False)} for op, path, value in ops]
    client = FakeClient([response({"ops": wire, "summary": message, "question": None}, model="claude-haiku-5-5")])
    r = edit_tree(tree, message, llm=LLM(client=client))
    assert r.ok, [i.message for i in r.build.issues if i.level == "error"]
    assert check(r.build)


def test_edit_kitchen_fridge_dw_plinth_grille_top_filler() -> None:
    kitchen = json.loads((CORE_FIXTURES / "kitchen_straight.json").read_text(encoding="utf-8"))
    ops = [("replace", "/base/2/dw", True),
           ("add", "/base/-", {"kind": "fridge", "width": 600, "fridge_height": 1850, "top_panel": True}),
           ("add", "/wall/-", {"kind": "gap", "width": 600}),
           ("replace", "/legs_height", 100),
           ("add", "/plinth", {"grilles": ["sink", "oven"]}),
           ("add", "/top_filler", {"ceiling": 2600})]
    wire = [{"op": op, "path": path, "value_json": json.dumps(value)} for op, path, value in ops]
    msg = "панель над холодильником, фасад на посудомойку, цоколь 100 с решёткой, добор до потолка"
    client = FakeClient([response({"ops": wire, "summary": msg, "question": None}, model="claude-haiku-5-5")])
    r = edit_tree(kitchen, msg, llm=LLM(client=client))
    assert r.ok, [i.message for i in r.build.issues if i.level == "error"]
    keys = {p.key for p in r.build.parts}
    assert {"base[2].dw_front", "base[5].top_panel"} <= keys
    assert any(h.kind == "vent_grille" for h in r.build.hardware)
    assert any(p.role == "niche_filler" for p in r.build.parts)


def test_empty_niche_photo_proposes_builtin_with_room_regions() -> None:
    tree = {"type": "wardrobe", "width": 1700, "height": 2650, "depth": 600, "installation": "niche",
            "builtin": {"niche": {"width": 1800, "height": 2700, "depth": 650}, "fillers": ["left", "right", "top"]},
            "sections": [{"fill": [{"kind": "rod"}], "doors": {"count": 2}},
                         {"fill": [{"kind": "shelves", "count": 5}], "doors": {"count": 2}}]}
    room = {"photo": 0, "wall_region": [0.1, 0.2, 0.3, 0.5], "floor_region": [0.2, 0.85, 0.8, 0.98],
            "wall_color_hint": "#E8E1D5", "floor_color_hint": "#8B6A4E"}
    reply = design(tree=tree, product_kind="встроенный шкаф", room=room,
                   estimated=["/builtin/niche/width", "/builtin/niche/height", "/width", "/height"],
                   understood=["пустая ниша ~1800×2700"], message="Встроенный шкаф в нишу с доборами")
    reply["tree_json"] = json.dumps(tree, ensure_ascii=False)
    client = FakeClient([response(reply)])
    s = DesignSession(llm=LLM(client=client))
    r = s.start("сюда встроить шкаф", photos=[Photo(b"\xff\xd8fake")])
    assert r.status == "ready" and r.build.ok
    assert r.response.room is not None and r.response.room.wall_color_hint == "#E8E1D5"
    assert "/builtin/niche/width" in r.response.estimated
    assert any(p.role == "niche_filler" for p in r.build.parts)
    fmt = client.calls[0]["output_config"]["format"]["schema"]
    assert "room" in fmt["properties"]


def test_edit_wedge_filler_and_floor_preset() -> None:
    from mebel_ai.prompts import EDIT_SYSTEM

    assert "«добор клином»" in EDIT_SYSTEM and '"walnut"' in EDIT_SYSTEM and "walls_visible" in EDIT_SYSTEM
    tree = json.loads((CORE_FIXTURES / "wardrobe_builtin.json").read_text(encoding="utf-8"))
    tree["builtin"]["wedge"] = []
    tree["builtin"]["niche"].pop("lean", None)
    ops = [{"op": "replace", "path": "/builtin/wedge", "value_json": json.dumps(["right"])},
           {"op": "add", "path": "/builtin/niche/lean", "value_json": json.dumps("right")},
           {"op": "replace", "path": "/room_colors", "value_json": json.dumps(
               {"floor_material": "walnut", "walls_visible": True, "source": "manual"})}]
    client = FakeClient([response({"ops": ops, "summary": "Добор клином справа, пол — орех", "question": None},
                                  model="claude-haiku-5-5")])
    r = edit_tree(tree, "стена справа завалена — добор клином, пол орех", llm=LLM(client=client))
    assert r.ok
    right = next(p for p in r.build.parts if p.key == "builtin.filler.right")
    assert right.contour is not None and "клином" in right.name
    assert r.tree["room_colors"]["floor_material"] == "walnut"
