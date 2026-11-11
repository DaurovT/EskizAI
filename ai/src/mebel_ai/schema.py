"""Схемы ответов ИИ и их перевод в JSON Schema для структурированного вывода.

Ответ модели ограничен схемой (output_config.format), а после — ещё раз
проверяется pydantic-моделью и сборкой в ядре.
"""

import copy
from typing import Annotated, Literal, Optional, Union

from mebel_core.schema import Kitchen, Product
from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Element(_Strict):
    """Что найдено на фото или в описании (FR-42, экран «Разбор фото»)."""

    name: str = Field(description="Как назвать мастеру: «двери», «антресоль», «ножки металл»")
    kind: Literal["body", "section", "door", "sliding_door", "drawer", "shelf", "rod", "mezzanine", "handle",
                  "legs", "countertop", "glass", "metal", "unusual_shape", "appliance", "other"]
    count: int = Field(1, description="Сколько штук")
    sure: bool = Field(description="Уверен ли ИИ, что элемент есть и понят правильно")
    note: str = Field("", description="Пояснение: форма, материал, где расположен")


class PhotoObject(_Strict):
    """Предмет мебели на фото — рамка для показа мастеру (раздел 19 PRD: «фото с рамками»)."""

    label: str = Field(description="Как назвать мастеру: «шкаф слева», «тумба под ТВ»")
    photo: int = Field(0, description="Номер фото, начиная с 0")
    box: list[float] = Field(description="Рамка [x0, y0, x1, y1] в долях ширины и высоты фото, 0–1")
    chosen: bool = Field(description="По этому предмету собрано дерево")
    size: list[int] = Field(default_factory=list,
                            description="Примерные габариты [ширина, глубина, высота] в мм, на глаз")
    summary: str = Field("", description="Коротко для мастера: «2 двери», «3 ящика»")


class RoomRegions(_Strict):
    """Пустая ниша или комната на фото: участки чистой стены и пола — сервер снимет с них цвет для 3D."""

    photo: int = Field(0, description="Номер фото, начиная с 0")
    wall_region: list[float] = Field(description="Участок чистой стены [x0, y0, x1, y1] в долях фото, 0–1, "
                                                 "без теней, мебели и розеток")
    floor_region: list[float] = Field(description="Участок пола [x0, y0, x1, y1] в долях фото; пусто — пола не видно")
    wall_color_hint: str = Field(description="Цвет стены на глаз, #RRGGBB")
    floor_color_hint: str = Field(description="Цвет пола на глаз, #RRGGBB; пусто — не видно")


class Question(_Strict):
    """Уточняющий вопрос с готовыми вариантами (FR-12)."""

    id: str = Field(description="Короткий идентификатор, например «width» или «doors»")
    text: str = Field(description="Вопрос на языке мастера")
    options: list[str] = Field(description="2–4 готовых варианта ответа")
    default: str = Field(description="Что подставить, если мастер ответит «не знаю»")
    affects: str = Field(description="JSON Pointer поля дерева, которое меняет ответ, например /width")


Tree = Annotated[Union[Product, Kitchen], Field(discriminator="type")]


class DesignResponse(_Strict):
    product_kind: str = Field(description="Что это, словами мастера: «шкаф-купе», «распашной шкаф», «прямая кухня»")
    confidence: float = Field(description="Уверенность в типе изделия, 0–1")
    alternatives: list[str] = Field(description="Две другие версии, что это может быть")
    elements: list[Element]
    understood: list[str] = Field(description="Что понято из фото и текста — коротко, по пунктам")
    unclear: list[str] = Field(description="Что неясно, но вариантами не спросить (то, что спрошено в questions, сюда не дублировать)")
    tree: Tree = Field(description="Дерево модулей изделия строго по схеме")
    estimated: list[str] = Field(
        description="JSON Pointer'ы значений, взятых на глаз или по умолчанию (покажутся мастеру как «оценка»)"
    )
    questions: list[Question] = Field(description="Не больше 6 вопросов с вариантами: каждое сомнение, которое мастер решит выбором")
    differences: list[str] = Field(
        description="Что на фото не собирается из модулей и операций (для «нестандарта»)"
    )
    objects: list[PhotoObject] = Field(
        default_factory=list,
        description="Если на фото несколько предметов мебели — все с рамками; иначе пусто",
    )
    room: Optional[RoomRegions] = Field(None, description="Пустая ниша/комната на фото: где стена и пол")
    message: str = Field(description="Короткий ответ мастеру на его языке, 1–2 предложения")


class DesignWire(_Strict):
    """То, что модель возвращает по структурированному выводу. Дерево — JSON-строкой:
    полная схема шкафа и кухни слишком велика для грамматики структурированного вывода,
    поэтому дерево проверяется после ответа (pydantic + сборка ядром) и при ошибке — повтор."""

    product_kind: str = Field(description="Что это, словами мастера: «шкаф-купе», «распашной шкаф», «прямая кухня»")
    confidence: float = Field(description="Уверенность в типе изделия, 0–1")
    alternatives: list[str] = Field(description="Две другие версии, что это может быть")
    elements: list[Element]
    understood: list[str] = Field(description="Что понято из фото и текста — коротко, по пунктам")
    unclear: list[str] = Field(description="Что неясно, но вариантами не спросить (то, что спрошено в questions, сюда не дублировать)")
    tree_json: str = Field(
        description="Дерево модулей одной строкой JSON строго по схеме дерева из системного промпта "
                    "(объект с полем type: wardrobe или kitchen)"
    )
    estimated: list[str] = Field(description="JSON Pointer'ы значений, взятых на глаз или по умолчанию")
    questions: list[Question] = Field(description="Не больше 6 вопросов с вариантами: каждое сомнение, которое мастер решит выбором")
    differences: list[str] = Field(description="Что на фото не собирается из модулей и операций")
    objects: list[PhotoObject] = Field(description="Если на фото несколько предметов мебели — все с рамками; иначе пусто")
    room: Optional[RoomRegions] = Field(None, description="Фото пустой ниши или стены, куда встроить мебель: участки "
                                                          "стены и пола для цвета в 3D; иначе null")
    message: str = Field(description="Короткий ответ мастеру на его языке, 1–2 предложения")

    def to_response(self) -> "DesignResponse":
        import json

        data = self.model_dump(exclude={"tree_json"})
        data["tree"] = json.loads(self.tree_json)
        data["tree"].setdefault("type", "wardrobe")
        return DesignResponse.model_validate(data)


class EditOp(_Strict):
    op: Literal["replace", "add", "remove"]
    path: str = Field(description="JSON Pointer в дереве модулей, например /sections/1/doors/count")
    value_json: Optional[str] = Field(None, description="Новое значение, закодированное в JSON; для remove — null")


class EditResponse(_Strict):
    ops: list[EditOp] = Field(description="Изменения дерева по порядку; пусто, если сначала нужен вопрос")
    summary: str = Field(description="Что изменено — одним предложением на языке мастера")
    question: Optional[Question] = Field(None, description="Вопрос, если правку нельзя сделать однозначно")


# Ограничения, которые структурированный вывод не принимает. Их всё равно проверит pydantic после ответа.
_DROP = {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength",
         "minItems", "maxItems", "default", "discriminator", "title"}


def _clean(node, in_properties: bool = False):
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            # Внутри "properties" ключи — имена полей (у вопроса есть поле default), их не трогаем
            if k in _DROP and not in_properties:
                continue
            out["anyOf" if k == "oneOf" else k] = _clean(v, in_properties=(k == "properties" and not in_properties))
        # Объекты — только с additionalProperties: false
        if out.get("type") == "object" and "properties" in out:
            out["additionalProperties"] = False
        return out
    if isinstance(node, list):
        return [_clean(v) for v in node]
    return node


def output_schema(model: type[BaseModel]) -> dict:
    """JSON Schema модели ответа, пригодная для output_config.format."""
    return _clean(copy.deepcopy(model.model_json_schema()))
