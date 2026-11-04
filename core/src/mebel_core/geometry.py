"""Геометрия деталей.

Система координат изделия:
- X — ширина, слева направо (0 — левый край изделия);
- Y — глубина, спереди назад (0 — передняя плоскость корпуса);
- Z — высота, снизу вверх (0 — пол).

Деталь — плита. У неё своя локальная система: x — длина, y — ширина,
толщина — по нормали. Размещение (Placement) говорит, куда в изделии
смотрят локальные оси. Все значения — в dmm (см. units.py).
"""

from typing import Literal, Union

from pydantic import BaseModel

Axis = Literal["+X", "-X", "+Y", "-Y", "+Z", "-Z"]


class Vec3(BaseModel):
    x: int
    y: int
    z: int


class Placement(BaseModel):
    """Куда в изделии направлены локальные оси детали."""

    origin: Vec3  # точка изделия, где лежит локальный (0, 0, 0)
    u: Axis  # локальная x (длина детали)
    v: Axis  # локальная y (ширина детали)
    n: Axis  # толщина


class LineSeg(BaseModel):
    kind: Literal["line"] = "line"
    x: int  # конечная точка; начало — конец предыдущего сегмента
    y: int


class ArcSeg(BaseModel):
    kind: Literal["arc"] = "arc"
    x: int  # конечная точка
    y: int
    cx: int  # центр дуги
    cy: int
    clockwise: bool = False


Segment = Union[LineSeg, ArcSeg]


class Contour(BaseModel):
    """Замкнутый контур детали из линий и дуг (в локальных координатах)."""

    start_x: int
    start_y: int
    segments: list[Segment]


def rect_contour(length: int, width: int) -> Contour:
    return Contour(
        start_x=0,
        start_y=0,
        segments=[
            LineSeg(x=length, y=0),
            LineSeg(x=length, y=width),
            LineSeg(x=0, y=width),
            LineSeg(x=0, y=0),
        ],
    )


class AABB(BaseModel):
    """Габаритный параллелепипед детали в координатах изделия."""

    min: Vec3
    max: Vec3

    def overlap_volume(self, other: "AABB") -> int:
        """Объём пересечения; касание гранями — 0."""
        dx = min(self.max.x, other.max.x) - max(self.min.x, other.min.x)
        dy = min(self.max.y, other.max.y) - max(self.min.y, other.min.y)
        dz = min(self.max.z, other.max.z) - max(self.min.z, other.min.z)
        if dx <= 0 or dy <= 0 or dz <= 0:
            return 0
        return dx * dy * dz


def placed_aabb(placement: Placement, length: int, width: int, thickness: int) -> AABB:
    """Габарит детали в изделии по её размещению и размерам."""
    lo = {"X": placement.origin.x, "Y": placement.origin.y, "Z": placement.origin.z}
    hi = dict(lo)
    for axis, extent in ((placement.u, length), (placement.v, width), (placement.n, thickness)):
        sign, name = axis[0], axis[1]
        if sign == "+":
            hi[name] += extent
        else:
            lo[name] -= extent
    used = {placement.u[1], placement.v[1], placement.n[1]}
    if len(used) != 3:
        raise ValueError(f"Оси размещения должны быть разными: {placement.u}, {placement.v}, {placement.n}")
    return AABB(
        min=Vec3(x=lo["X"], y=lo["Y"], z=lo["Z"]),
        max=Vec3(x=hi["X"], y=hi["Y"], z=hi["Z"]),
    )


def axis_value(v: Vec3, axis: str) -> int:
    return {"X": v.x, "Y": v.y, "Z": v.z}[axis]


def to_local(placement: Placement, point: Vec3) -> tuple[int, int, int]:
    """Точка изделия → локальные координаты детали (x — длина, y — ширина, z — толщина)."""
    out = []
    for axis in (placement.u, placement.v, placement.n):
        sign, name = axis[0], axis[1]
        delta = axis_value(point, name) - axis_value(placement.origin, name)
        out.append(delta if sign == "+" else -delta)
    return out[0], out[1], out[2]
