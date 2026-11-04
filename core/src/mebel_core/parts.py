"""Модель деталей — единственный источник правды.

Из неё строятся 3D, смета, раскрой и все файлы. Размеры — dmm.
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from .catalog import edge_type
from .geometry import AABB, Contour, Placement, placed_aabb

# Стороны детали для кромки:
#   y0 / y1 — длинные стороны (идут вдоль длины) при локальной y = 0 и y = ширина;
#   x0 / x1 — короткие стороны (идут вдоль ширины) при локальной x = 0 и x = длина.
EdgeSide = Literal["x0", "x1", "y0", "y1"]
Grain = Literal["length", "width", "none"]


class Hole(BaseModel):
    x: int
    y: int
    diameter: int
    depth: int  # 0 — сквозное
    face: Literal["A", "B", "x0", "x1", "y0", "y1"] = "A"  # A — лицевая пласть, B — обратная, остальное — торцы
    purpose: str = ""  # петля, полкодержатель, конфирмат…


class Groove(BaseModel):
    x0: int
    y0: int
    x1: int
    y1: int
    width: int
    depth: int
    face: Literal["A", "B"] = "A"
    purpose: str = ""


class Pocket(BaseModel):
    x: int
    y: int
    width: int
    height: int
    depth: int
    face: Literal["A", "B"] = "A"
    purpose: str = ""


class DecorPath(BaseModel):
    """Путь декора на лицевой стороне детали (dmm, система детали). Тот же путь — в DXF и в 3D."""

    path: Contour  # начало + сегменты (линии и дуги)
    closed: bool = True
    width: int  # ширина фрезы / профиля
    depth: int = 0  # глубина фрезеровки (паза под вставку)
    height: int = 0  # высота накладного профиля над фасадом
    profile: str = ""  # накладной декор: flat / round
    finish: str = ""  # вставка: brass / gold / black / chrome


class PartDecor(BaseModel):
    """Декор фасада: что нарисовать в 3D, что фрезеровать и что посчитать в смете."""

    face: Literal["A", "B"] = "B"  # пласть с декором (у фасада лицевая — B, локальная z = 0)
    paint: Optional[dict] = None  # color, code, gloss, both_sides
    milling_pattern: str = "none"
    milling: list[DecorPath] = Field(default_factory=list)
    overlay_pattern: str = "none"
    overlay_profile: str = ""
    overlay: list[DecorPath] = Field(default_factory=list)
    inlay_kind: str = "none"
    inlay_finish: str = ""
    inlay: list[DecorPath] = Field(default_factory=list)
    radius: int = 0


class LightRun(BaseModel):
    """Отрезок подсветки: профиль с лентой (точки — в координатах изделия, dmm)."""

    id: str
    zone: str
    start: tuple[int, int, int]
    end: tuple[int, int, int]
    temp: int
    part: Optional[str] = None  # деталь, к которой крепится профиль
    node: Optional[str] = None
    mount: str = "groove"
    light: int = 0  # индекс в списке lighting дерева

    @property
    def length(self) -> int:
        return round(sum((a - b) ** 2 for a, b in zip(self.start, self.end)) ** 0.5)


class Part(BaseModel):
    key: str  # стабильный путь: какой модуль и что именно, например "sections[1].shelf[2]"
    number: int = 0  # сквозной номер во всех файлах; назначается после сборки
    name: str
    role: str  # side, top, bottom, partition, shelf, plinth, back …
    module: str  # путь модуля в дереве
    material: str
    thickness: int
    length: int  # чистовой размер по локальной x
    width: int  # чистовой размер по локальной y
    contour: Optional[Contour] = None  # None — прямоугольник length × width
    edges: dict[EdgeSide, str] = Field(default_factory=dict)  # сторона → id кромки
    grain: Grain = "length"  # куда идёт текстура декора относительно детали
    placement: Placement
    holes: list[Hole] = Field(default_factory=list)
    grooves: list[Groove] = Field(default_factory=list)
    cutouts: list[Contour] = Field(default_factory=list)  # сквозные вырезы внутри контура
    pockets: list[Pocket] = Field(default_factory=list)
    node: Optional[str] = None  # id подвижного узла, если деталь двигается
    decor: Optional[PartDecor] = None  # фрезеровка, накладки, вставки, покраска (только фасады)

    def edge_thickness(self, side: EdgeSide) -> int:
        edge_id = self.edges.get(side)
        return edge_type(edge_id).thickness if edge_id else 0

    @property
    def cut_length(self) -> int:
        """Размер распила по длине = чистовой − кромка на коротких сторонах."""
        return self.length - self.edge_thickness("x0") - self.edge_thickness("x1")

    @property
    def cut_width(self) -> int:
        """Размер распила по ширине = чистовой − кромка на длинных сторонах."""
        return self.width - self.edge_thickness("y0") - self.edge_thickness("y1")

    def aabb(self) -> AABB:
        return placed_aabb(self.placement, self.length, self.width, self.thickness)


class HardwareItem(BaseModel):
    kind: str  # confirmat, shelf_pin, hinge, slide …
    name: str
    qty: int
    module: str
    params: dict[str, str | int | float] = Field(default_factory=dict)


class MovingNode(BaseModel):
    """Подвижный узел: дверь, ящик, дверь-купе. Детали ссылаются на него через Part.node."""

    id: str
    kind: Literal["rotate", "slide", "sliding_door", "lift"]
    module: str
    origin: tuple[int, int, int]  # точка на оси поворота или начало хода
    axis: Literal["+X", "-X", "+Y", "-Y", "+Z", "-Z"]  # ось поворота или направление хода
    range: float  # угол в градусах или ход в dmm
    parent: Optional[str] = None  # узел, внутри которого двигается этот (например, ящик за дверью-купе)


class PatchOp(BaseModel):
    """Операция JSON Patch (RFC 6902) над деревом модулей."""

    op: Literal["replace", "add", "remove"]
    path: str  # например "/sections/0/doors/count"
    value: object = None


class Fix(BaseModel):
    """Готовое исправление: мастер или ИИ применяет его одним действием."""

    description: str  # по-русски, для мастера
    patch: list[PatchOp]


class Issue(BaseModel):
    level: Literal["error", "warning"]
    code: str
    message: str  # по-русски, для мастера
    path: str = ""  # где в дереве модулей
    fixes: list[Fix] = Field(default_factory=list)
