"""Сборка: дерево модулей → модель деталей.

Порядок: корпус → антресоль → секции и перегородки → зоны и наполнение →
фасады → задняя стенка → проверки.
"""

from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, TypeAdapter

from .catalog import material
from .geometry import Placement, Vec3, to_local
from .modules import MODULES, load_all
from .parts import HardwareItem, Hole, Issue, LightRun, MovingNode, Part
from .rules import DEFAULT_RULES, RuleSet
from .schema import Kitchen, Product, ProductTree
from .units import mm, to_mm


@dataclass(frozen=True)
class Box:
    """Свободное пространство, в которое ставится модуль (dmm)."""

    x0: int
    x1: int
    y0: int
    y1: int
    z0: int
    z1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def depth(self) -> int:
        return self.y1 - self.y0

    @property
    def height(self) -> int:
        return self.z1 - self.z0


@dataclass
class Slot:
    """Секция: пространство и детали, которые её ограничивают."""

    index: int
    path: str
    box: Box
    left: Part
    right: Part
    bottom: Part
    top: Part
    zones: list["Zone"] = field(default_factory=list)


@dataclass
class Zone:
    """Зона секции по высоте (в свету) и что в ней."""

    z0: int
    z1: int
    kind: str
    external_drawers: int = 0
    path: str = ""
    doors: object = None  # двери только на этой зоне (schema.Doors)


class BuildError(Exception):
    """Сборку нельзя продолжить; превращается в Issue уровня error."""

    def __init__(self, code: str, message: str, path: str = ""):
        super().__init__(message)
        self.code, self.message, self.path = code, message, path


class BuildContext:
    def __init__(self, product: Product, rules: RuleSet):
        self.product = product
        self.rules = rules
        self.parts: list[Part] = []
        self.hardware: list[HardwareItem] = []
        self.nodes: list[MovingNode] = []
        self.issues: list[Issue] = []
        self.module_versions: dict[str, str] = {}
        self.slots: list[Slot] = []
        self.front_y: int = 0  # плоскость фасадов текущего ряда (у верхних модулей кухни — со сдвигом к стене)
        self.walls: tuple[int, int] = (0, 0)  # x стен ниши для текущего ряда (шкаф — края изделия)
        self.mezzanine_slots: list[Slot] = []
        self.lights: list[LightRun] = []
        self.zone_slots: list[Slot] = []  # слоты всех рядов (кухня) — для подсветки
        self.niche = None  # встроенный шкаф: щели и доборы по замеру ниши (niche.NicheLayout)
        self.shift_x: int = 0  # на сколько изделие сдвинуто вправо (левые торцевые секции, панели, доборы)
        self.joined: set[tuple[str, str]] = set()  # соединённые пары (пласть, торец) — drilling.py
        self.contacts_cache = None  # стыки деталей на время прохода присадки

    # Свойства изделия, которые нужны многим модулям
    @property
    def t(self) -> int:
        return material(self.product.body.material).thickness

    @property
    def fronts_material(self) -> str:
        return self.product.fronts.material or self.product.body.material

    # Модули
    def run(self, name: str, *args: Any, **kwargs: Any) -> Any:
        info = MODULES[name]
        self.module_versions[name] = info.version
        return info.fn(self, *args, **kwargs)

    # Детали
    def add_part(
        self,
        *,
        key: str,
        name: str,
        role: str,
        module: str,
        material_id: str,
        length: int,
        width: int,
        placement: Placement,
        edges: dict | None = None,
        grain: str = "length",
        node: str | None = None,
    ) -> Part:
        mat = material(material_id)
        part = Part(
            key=key,
            name=name,
            role=role,
            module=module,
            material=material_id,
            thickness=mat.thickness,
            length=length,
            width=width,
            edges=edges or {},
            grain=grain if mat.has_grain else "none",
            placement=placement,
            node=node,
        )
        self.parts.append(part)
        return part

    def part(self, key: str) -> Part:
        for p in self.parts:
            if p.key == key:
                return p
        raise KeyError(f"Деталь {key} не найдена")

    def add_hardware(self, kind: str, name: str, qty: int, module: str, **params: Any) -> None:
        if qty > 0:
            self.hardware.append(HardwareItem(kind=kind, name=name, qty=qty, module=module, params=params))

    # Присадка
    def drill(self, part: Part, point: Vec3, diameter: int, depth: int, purpose: str) -> None:
        """Отверстие в пласти детали по точке изделия; сторона пласти — по точке."""
        lx, ly, lz = to_local(part.placement, point)
        face = "A" if lz >= part.thickness else "B"
        part.holes.append(Hole(x=lx, y=ly, diameter=diameter, depth=depth, face=face, purpose=purpose))

    def join(self, face_part: Part, edge_part: Part, module: str) -> int:
        """Соединение «торец в пласть» на конфирматах (или шкантах) — drilling.confirmat_joint.

        В пласти — сквозные Ø7 со стороны, противоположной соединению, в торце — Ø5 глубиной 50;
        число — по длине соединения (rules). Фурнитура — по числу просверленных пар."""
        from .drilling import confirmat_joint

        return confirmat_joint(self, face_part, edge_part, module)

    # Замечания
    def error(self, code: str, message: str, path: str = "") -> None:
        self.issues.append(Issue(level="error", code=code, message=message, path=path))

    def warn(self, code: str, message: str, path: str = "") -> None:
        self.issues.append(Issue(level="warning", code=code, message=message, path=path))


def at(x: int, y: int, z: int) -> Vec3:
    return Vec3(x=x, y=y, z=z)


class SectionInfo(BaseModel):
    key: str  # sections[i] или mezzanine.sections[i]
    x0: int
    x1: int
    z0: int
    z1: int


class BuildResult(BaseModel):
    product: Product | Kitchen
    rules_version: str
    module_versions: dict[str, str]
    size: tuple[int, int, int]  # ширина, высота, глубина корпуса, dmm
    parts: list[Part]
    hardware: list[HardwareItem]
    nodes: list[MovingNode]
    issues: list[Issue]
    sections: list[SectionInfo] = []
    lights: list[LightRun] = []

    @property
    def ok(self) -> bool:
        return not any(i.level == "error" for i in self.issues)


_TREE = TypeAdapter(ProductTree)


def parse_tree(data: dict) -> Product | Kitchen:
    """Дерево модулей из JSON; без поля type — шкаф."""
    if "type" not in data:
        data = {**data, "type": "wardrobe"}
    return _TREE.validate_python(data)


def build(product: Product | Kitchen | dict, rules: RuleSet = DEFAULT_RULES) -> BuildResult:
    load_all()
    if not isinstance(product, (Product, Kitchen)):
        product = parse_tree(product)

    ctx = BuildContext(product, rules)
    if isinstance(product, Kitchen):
        return _build_kitchen(ctx)
    try:
        inner = ctx.run("body")
        if product.builtin:
            from .modules.builtin import prepare_builtin

            prepare_builtin(ctx)
        _check_compat(ctx)
        if product.sliding_doors:
            # Наполнение отступает на глубину зоны рельсов
            inner = Box(x0=inner.x0, x1=inner.x1, y0=inner.y0 + rules.sliding_track_depth,
                        y1=inner.y1, z0=inner.z0, z1=inner.z1)
        lower, upper = inner, None
        if product.mezzanine:
            lower, upper = ctx.run("mezzanine", inner)
        ctx.slots = ctx.run("sections", lower, upper)
        for slot, section in zip(ctx.slots, product.sections):
            slot.zones = ctx.run("zones", slot, section)
        ctx.run("fronts")
        if product.body.cornice:
            ctx.run("cornice")
        for i, unit in enumerate(product.end_units):
            ctx.run("end_unit", unit, i)
        if product.body.back.kind == "nailed":
            seams = [
                (a.box.x1 + b.box.x0) // 2 for a, b in zip(ctx.slots, ctx.slots[1:])
            ]
            ctx.run("back", seams)
        else:
            ctx.run("wall_fixing", count=2 * (len(product.sections) + 1), path="body.back")
        if product.side_panels:
            ctx.run("side_panels")
        if product.builtin:
            ctx.run("builtin")
    except BuildError as e:
        ctx.error(e.code, e.message, e.path)
    except KeyError as e:  # нет материала или кромки в каталоге
        ctx.error("catalog", str(e.args[0]) if e.args else str(e))

    _drilling(ctx)
    _decor(ctx)
    if product.operations and ctx.parts:
        from .operations import apply_operations

        apply_operations(ctx)
    size = (mm(product.width), mm(product.height), mm(product.depth))
    if product.end_units or product.side_panels or product.builtin:
        size = _shift_left(ctx, product)
    if ctx.slots:
        _check_spans(ctx)
    _check_drilling(ctx)
    _check_parts(ctx)
    for number, part in enumerate(ctx.parts, start=1):
        part.number = number

    return BuildResult(
        product=product,
        rules_version=rules.version,
        module_versions=dict(sorted(ctx.module_versions.items())),
        size=size,
        sections=_sections(ctx, product),
        parts=ctx.parts,
        hardware=ctx.hardware,
        nodes=ctx.nodes,
        issues=ctx.issues,
        lights=ctx.lights,
    )


def _drilling(ctx: BuildContext) -> None:
    """Присадка после сборки модулей: недостающие соединения, ножки, навесы (drilling.py)."""
    if not ctx.parts:
        return
    from .drilling import apply_drilling

    try:
        apply_drilling(ctx)
    except KeyError as e:
        ctx.error("catalog", str(e.args[0]) if e.args else str(e))


def _check_drilling(ctx: BuildContext) -> None:
    """Проверка присадки — после операций формы и сдвигов: пересечения, вырыв у края, закрытые отверстия."""
    if ctx.parts:
        from .drilling import check_drilling

        check_drilling(ctx)


def _decor(ctx: BuildContext) -> None:
    """Декор фасадов, ручки Gola и подсветка — после сборки, до операций формы."""
    if not ctx.parts:
        return
    from .decor import apply_decor
    from .lighting import apply_lighting

    from .modules.builtin import paint_panels

    try:
        apply_decor(ctx)
        paint_panels(ctx)
        apply_lighting(ctx)
    except KeyError as e:
        ctx.error("catalog", str(e.args[0]) if e.args else str(e))


def _sections(ctx: BuildContext, product: Product) -> list[SectionInfo]:
    dx = ctx.shift_x
    return [SectionInfo(key=s.path, x0=s.box.x0 + dx, x1=s.box.x1 + dx, z0=s.box.z0, z1=s.box.z1)
            for s in ctx.slots + ctx.mezzanine_slots]


def _shift_left(ctx: BuildContext, product: Product) -> tuple[int, int, int]:
    """Левая торцевая секция, фальш-панель и добор строились при x < 0 — сдвигаем всё изделие вправо.
    Габарит — по деталям (у встроенного шкафа — с доборами, заготовки с припуском на подрезку)."""
    dx = max(0, -min((p.aabb().min.x for p in ctx.parts), default=0))
    ctx.shift_x = dx
    if dx:
        for p in ctx.parts:
            p.placement.origin.x += dx
        for n in ctx.nodes:
            n.origin = (n.origin[0] + dx, n.origin[1], n.origin[2])
        for lr in ctx.lights:
            lr.start = (lr.start[0] + dx, lr.start[1], lr.start[2])
            lr.end = (lr.end[0] + dx, lr.end[1], lr.end[2])
    sides = [u.side for u in product.end_units]
    if len(sides) != len(set(sides)):
        ctx.error("end_units_duplicate", "Две торцевые секции с одной стороны", "end_units")
    width = mm(product.width) + sum(mm(u.width) for u in product.end_units)
    width = max([width] + [p.aabb().max.x for p in ctx.parts])
    height = max([mm(product.height)] + [p.aabb().max.z for p in ctx.parts])
    return width, height, mm(product.depth)


def _build_kitchen(ctx: BuildContext) -> BuildResult:
    size = (0, 0, 0)
    try:
        size = ctx.run("kitchen")
    except BuildError as e:
        ctx.error(e.code, e.message, e.path)
    except KeyError as e:
        ctx.error("catalog", str(e.args[0]) if e.args else str(e))
    _drilling(ctx)
    _decor(ctx)
    if ctx.product.operations and ctx.parts:
        from .operations import apply_operations

        apply_operations(ctx)
    if ctx.product.site is not None:  # замер помещения: вода, газ, окно, потолок
        from .kitchen_site import check_site

        for code, message in check_site(ctx.product, ctx.rules):
            ctx.warn(code, message, "site")
    _check_drilling(ctx)
    _check_parts(ctx)
    for number, part in enumerate(ctx.parts, start=1):
        part.number = number
    return BuildResult(
        product=ctx.product, rules_version=ctx.rules.version,
        module_versions=dict(sorted(ctx.module_versions.items())), size=size,
        parts=ctx.parts, hardware=ctx.hardware, nodes=ctx.nodes, issues=ctx.issues, lights=ctx.lights,
    )


def _check_compat(ctx: BuildContext) -> None:
    p = ctx.product
    if p.sliding_doors:
        for i, s in enumerate(p.sections):
            if s.doors:
                raise BuildError("sliding_and_hinged", "При дверях-купе у секций не бывает распашных дверей",
                                 f"sections[{i}].doors")
            if any(getattr(f, "external", False) for f in s.fill):
                raise BuildError("sliding_and_external_drawers",
                                 "При дверях-купе ящики только внутренние (без своих фасадов)", f"sections[{i}]")


def _check_spans(ctx: BuildContext) -> None:
    """Пролёт полки без опоры (раздел 5 PRD)."""
    from .fixes import split_section_fix, thicker_body_fix

    limit = ctx.rules.shelf_max_span.get(ctx.t)
    if not limit:
        return
    for slot, section in zip(ctx.slots, ctx.product.sections):
        has_shelves = len(section.fill) > 1 or any(f.kind == "shelves" for f in section.fill)
        if has_shelves and slot.box.width > limit:
            fixes = [split_section_fix(ctx.product, slot.index)]
            thicker = thicker_body_fix(ctx.product)
            if thicker and slot.box.width <= ctx.rules.shelf_max_span.get(ctx.t + mm(2), 0):
                fixes.append(thicker)
            ctx.issues.append(Issue(
                level="warning", code="shelf_span",
                message=f"Секция {slot.index + 1}: полки {to_mm(slot.box.width)} мм без опоры — "
                        f"больше {to_mm(limit)} мм для ЛДСП {to_mm(ctx.t):g} мм, полка прогнётся",
                path=slot.path, fixes=fixes,
            ))


def _check_parts(ctx: BuildContext) -> None:
    r = ctx.rules
    usable_l = r.sheet_length - 2 * r.sheet_trim
    usable_w = r.sheet_width - 2 * r.sheet_trim

    for p in ctx.parts:
        if not material(p.material).is_sheet:
            continue
        if p.length < r.min_part_size or p.width < r.min_part_size:
            ctx.error(
                "part_too_small",
                f"Деталь «{p.name}» слишком маленькая: {to_mm(p.length)}×{to_mm(p.width)} мм",
                p.module,
            )
        cl, cw = p.cut_length, p.cut_width
        fits_as_is = cl <= usable_l and cw <= usable_w
        fits_rotated = cw <= usable_l and cl <= usable_w
        # С текстурой деталь нельзя поворачивать: длина идёт вдоль листа
        if p.grain == "length":
            fits = fits_as_is
        elif p.grain == "width":
            fits = fits_rotated
        else:
            fits = fits_as_is or fits_rotated
        if not fits:
            ctx.error(
                "part_exceeds_sheet",
                f"Деталь «{p.name}» {to_mm(cl)}×{to_mm(cw)} мм не помещается на лист "
                f"{to_mm(r.sheet_length)}×{to_mm(r.sheet_width)} мм",
                p.module,
            )

    boxes = [(p, p.aabb()) for p in ctx.parts]
    for i, (a, box_a) in enumerate(boxes):
        for b, box_b in boxes[i + 1 :]:
            if box_a.overlap_volume(box_b) > 0:
                ctx.error(
                    "intersection",
                    f"Детали пересекаются: «{a.name}» ({a.key}) и «{b.name}» ({b.key})",
                    a.module,
                )
