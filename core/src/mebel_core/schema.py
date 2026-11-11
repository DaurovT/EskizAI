"""Схема дерева модулей — то, что собирает ИИ или мастер.

Размеры здесь — в миллиметрах (удобно человеку и модели), ядро переводит
их в dmm. Из этой схемы генерируются JSON Schema для tool use Claude
и типы TypeScript для приложения (scripts/dump_schema.py).
"""

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


_ZONE_HEIGHT = Field(
    None, gt=0, description="Высота зоны в свету, мм. Не задана — делится поровну из остатка высоты секции"
)


class ShelvesFill(_Strict):
    """Полки, равномерно по высоте зоны."""

    kind: Literal["shelves"] = "shelves"
    count: int = Field(ge=1, le=20, description="Сколько полок")
    mount: Literal["pins", "fixed"] = Field(
        "pins", description="pins — на полкодержателях (съёмные), fixed — на конфирматах"
    )
    height: Optional[float] = _ZONE_HEIGHT
    doors: Optional["Doors"] = Field(
        None, description="Двери только на эту зону (например, тумба с дверцами внизу под открытыми полками); "
                          "null — как у секции"
    )


class RodFill(_Strict):
    """Зона для одежды со штангой под верхом зоны."""

    kind: Literal["rod"] = "rod"
    height: Optional[float] = _ZONE_HEIGHT
    doors: Optional["Doors"] = Field(
        None, description="Двери только на эту зону (например, тумба с дверцами внизу под открытыми полками); "
                          "null — как у секции"
    )


class DrawersFill(_Strict):
    """Ящики на шариковых направляющих."""

    kind: Literal["drawers"] = "drawers"
    count: int = Field(ge=1, le=6, description="Сколько ящиков в зоне")
    external: bool = Field(
        False, description="true — у ящиков свои фасады снаружи; false — внутренние ящики за дверью"
    )
    height: Optional[float] = _ZONE_HEIGHT
    style: Optional["FrontStyle"] = Field(None, description="Стиль фасадов этих ящиков; null — как у изделия")


class EmptyFill(_Strict):
    """Пустая зона (открытая ниша или место под технику)."""

    kind: Literal["empty"] = "empty"
    height: Optional[float] = _ZONE_HEIGHT
    doors: Optional["Doors"] = Field(
        None, description="Двери только на эту зону (например, тумба с дверцами внизу под открытыми полками); "
                          "null — как у секции"
    )


Fill = Annotated[Union[ShelvesFill, RodFill, DrawersFill, EmptyFill], Field(discriminator="kind")]


# --- Декор фасадов (docs/decor_contract.md) ---

MillingPattern = Literal["none", "shaker", "classic", "arcs", "rhombus", "grooves_v", "grooves_h", "waves"]
OverlayPattern = Literal["none", "frame", "arch", "rhombus", "moulding"]
InlayKind = Literal["none", "frame", "line_h", "line_v", "edge"]
MetalFinish = Literal["brass", "gold", "black", "chrome"]


class Milling(_Strict):
    """Фрезеровка по лицевой стороне МДФ (путь фрезы строит ядро)."""

    pattern: MillingPattern = Field(
        "none", description="shaker — рамка, classic — рамка с филёнкой, arcs — арка сверху, rhombus — ромб "
                            "(на высоком фасаде — решётка), grooves_v / grooves_h — рифление, waves — волны")
    inset: float = Field(60, ge=0, le=300, description="Отступ рисунка от края фасада, мм (не меньше 40)")
    width: float = Field(8, gt=0, le=30, description="Ширина фрезы, мм")
    depth: float = Field(3, gt=0, le=15, description="Глубина фрезеровки, мм (не больше толщины − 6)")
    radius: float = Field(0, ge=0, le=200, description="Скругление углов рамки, мм")
    pitch: float = Field(40, ge=10, le=200, description="Шаг линий рифления и волн, мм")


class Overlay(_Strict):
    """Накладной декор (молдинг), клеится на фасад."""

    pattern: OverlayPattern = "none"
    profile: Literal["flat_20", "round_25"] = Field("flat_20", description="flat_20 — плоский 20 мм, round_25 — "
                                                                            "полукруглый 25 мм")
    inset: float = Field(50, ge=0, le=300, description="Отступ от края фасада, мм")


class Inlay(_Strict):
    """Металлическая вставка: латунная рамка, золотой кант по краю, полоса."""

    kind: InlayKind = Field("none", description="frame — рамка, line_h / line_v — полоса поперёк / вдоль, "
                                                "edge — кант по периметру фасада")
    finish: MetalFinish = "brass"
    width: float = Field(6, ge=2, le=20, description="Ширина профиля, мм")
    inset: float = Field(40, ge=0, le=300, description="Отступ от края, мм (для edge не используется)")


class Paint(_Strict):
    """Покраска фасадов МДФ."""

    color: str = Field("#E8E4DC", pattern=r"^#[0-9A-Fa-f]{6}$", description="Цвет для 3D, #RRGGBB")
    code: Optional[str] = Field(None, max_length=40, description="Код цвета: «RAL 9001», «NCS S 0502-Y»")
    system: Literal["RAL", "NCS", "custom"] = "RAL"
    gloss: Literal["matte", "satin", "gloss"] = Field("matte", description="matte — мат, satin — полумат, gloss — глянец")
    both_sides: bool = Field(True, description="Красить и обратную сторону (дешевле лицевой)")


class Corners(_Strict):
    radius: float = Field(0, ge=0, le=200, description="Скругление углов фасада, мм")


class FrontStyle(_Strict):
    """Стиль фасадов. У изделия — для всех фасадов; у двери/ящика/модуля — переопределение
    (заданное поле заменяет поле изделия целиком; pattern/kind "none" — выключить)."""

    milling: Optional[Milling] = None
    overlay: Optional[Overlay] = None
    inlay: Optional[Inlay] = None
    paint: Optional[Paint] = None
    corners: Optional[Corners] = None


class Light(_Strict):
    """Подсветка: светодиодная лента в алюминиевом профиле с рассеивателем."""

    zone: Literal["under_wall", "niche", "shelf", "wardrobe_rod", "plinth", "inside_top"] = Field(
        description="under_wall — под навесными шкафами кухни, niche — в открытой нише (под верхом ниши), "
                    "shelf — под полками, wardrobe_rod — над штангой, plinth — по цоколю, inside_top — под крышей "
                    "внутри секции")
    target: str = Field("all", max_length=40,
                        description="all, sections[i] (шкаф), wall[i] / wall2[i] / base[i] (кухня)")
    temp: Literal[3000, 4000, 6000] = Field(4000, description="Цветовая температура, K: 3000 — тёплый, "
                                                               "4000 — нейтральный, 6000 — холодный")
    sensor: Literal["none", "door", "motion", "touch"] = "none"
    mount: Literal["groove", "surface"] = Field("groove", description="groove — профиль в паз, surface — накладной")
    power: float = Field(9.6, ge=2, le=30, description="Мощность ленты, Вт/м")


class Doors(_Strict):
    count: Literal[1, 2] = Field(1, description="Сколько распашных дверей на секцию")
    hinge: Literal["left", "right"] = Field("left", description="Сторона петель для одной двери")
    style: Optional[FrontStyle] = Field(None, description="Стиль только этих дверей; null — как у фасадов изделия")


for _m in (ShelvesFill, RodFill, EmptyFill, DrawersFill):
    _m.model_rebuild()


class Section(_Strict):
    width: Optional[float] = Field(
        None, gt=0, description="Ширина секции в свету, мм. Не задана — делится поровну из остатка"
    )
    fill: list[Fill] = Field(
        default_factory=list,
        description="Зоны снизу вверх; между зонами ставится неподвижная полка. Пусто — открытая ниша",
    )
    doors: Optional[Doors] = Field(None, description="Распашные двери; null — без дверей")


class Plinth(_Strict):
    height: float = Field(70, ge=0, le=200, description="Высота цоколя, мм")
    setback: float = Field(0, ge=0, le=100, description="Отступ цокольной планки от переднего края, мм")
    legs: bool = Field(False, description="На регулируемых ножках: боковины и дно над цоколем, планка цоколя на "
                                          "клипсах спереди и с открытых боков; false — боковины до пола")
    floor_allowance: float = Field(5, ge=0, le=30, description="Зазор планки до пола на неровность пола, мм "
                                                                "(только при legs)")


class Back(_Strict):
    kind: Literal["nailed", "none"] = Field("nailed", description="nailed — ХДФ на гвоздях сзади, none — без стенки")
    material: str = "hdf_3_white"


class Cornice(_Strict):
    height: float = Field(80, ge=40, le=250, description="Высота карниза, мм (входит в общую высоту шкафа)")


class EndUnit(_Strict):
    """Торцевая открытая секция со скруглёнными полками (угловой радиусный элемент)."""

    side: Literal["left", "right"]
    width: float = Field(300, ge=200, le=450, description="Ширина секции, мм (к общей ширине корпуса прибавляется)")
    shelves: int = Field(3, ge=1, le=8, description="Полок между низом и верхом")


# --- Встроенная мебель: ниша, доборы, фальш-панели ---


class Niche(_Strict):
    """Замер ниши. Ширина — в трёх точках (верх, середина, низ), высота — у левой и правой стены.
    Корпус делается по самому узкому месту, разница уходит в доборы."""

    width: Optional[float] = Field(None, gt=0, le=10000, description="Ширина ниши, мм (если мерили в одной точке)")
    width_top: Optional[float] = Field(None, gt=0, le=10000, description="Ширина ниши вверху, мм")
    width_middle: Optional[float] = Field(None, gt=0, le=10000, description="Ширина ниши посередине, мм")
    width_bottom: Optional[float] = Field(None, gt=0, le=10000, description="Ширина ниши внизу, мм")
    height: Optional[float] = Field(None, gt=0, le=6000, description="Высота ниши (до потолка), мм")
    height_left: Optional[float] = Field(None, gt=0, le=6000, description="Высота у левой стены, мм")
    height_right: Optional[float] = Field(None, gt=0, le=6000, description="Высота у правой стены, мм")
    depth: Optional[float] = Field(None, gt=0, le=3000, description="Глубина ниши, мм")
    lean: Optional[Literal["left", "right"]] = Field(
        None, description="Какая стена завалена (по уровню): left / right — весь перекос ширины уходит в добор этой "
                          "стороны; null — неизвестно, делится поровну")

    def widths(self) -> list[float]:
        return [v for v in (self.width, self.width_top, self.width_middle, self.width_bottom) if v is not None]

    def heights(self) -> list[float]:
        return [v for v in (self.height, self.height_left, self.height_right) if v is not None]


FillerSide = Literal["left", "right", "top"]


class Builtin(_Strict):
    """Встроенный шкаф: корпус целиком (боковины, крыша, дно) стоит в нише, щели до стен и потолка закрыты
    доборами. Ширина и высота изделия — размеры корпуса (без доборов)."""

    niche: Niche = Field(default_factory=Niche, description="Замер ниши; пусто — доборы номинальной ширины")
    fillers: list[FillerSide] = Field(
        default_factory=lambda: ["left", "right", "top"], max_length=3,
        description="Где доборы: left / right — у стен, top — до потолка. Без добора — монтажный зазор")
    filler_width: float = Field(50, ge=0, le=300, description="Видимая ширина бокового добора в самом узком месте "
                                                               "ниши, мм (по ней подгоняется корпус)")
    top_filler_width: float = Field(50, ge=0, le=500, description="Видимая высота верхнего добора, мм")
    allowance_side: float = Field(10, ge=0, le=50, description="Монтажный зазор до стены там, где нет добора, мм")
    allowance_top: float = Field(20, ge=0, le=100, description="Монтажный зазор до потолка без добора, мм")
    scribe: float = Field(15, ge=0, le=40, description="Припуск добора на подрезку по стене, мм (мастер подрезает "
                                                       "на месте)")
    filler_material: Optional[str] = Field(None, description="Материал доборов (id); null — как фасады")
    filler_position: Literal["flush", "setback"] = Field(
        "flush", description="flush — заподлицо с фасадами, setback — утоплен за плоскость фасадов")
    filler_setback: float = Field(20, ge=0, le=100, description="На сколько утоплен добор при setback, мм")
    filler_mount: Literal["strip", "screws"] = Field(
        "strip", description="strip — на планке крепления (деталь из ЛДСП корпуса), screws — уголками и саморезами")
    wedge: list[FillerSide] = Field(
        default_factory=list, max_length=3,
        description="Доборы клином: кромка к стене режется по замеру (трапеция по ширинам вверху/посередине/внизу, "
                    "верхний — по высотам слева/справа), подрезать на месте почти не нужно")


FloorMaterial = Literal["oak_light", "walnut", "tile", "concrete", "carpet"]


class RoomColors(_Strict):
    """Стены и пол помещения — только для вида в 3D (фасады на фоне комнаты): на модель, смету и файлы не
    влияет никогда. photo — цвет снят с фото, manual — мастер выбрал сам."""

    wall: Optional[str] = Field(None, pattern=r"^#[0-9A-Fa-f]{6}$", description="Цвет стен, #RRGGBB")
    floor: Optional[str] = Field(None, pattern=r"^#[0-9A-Fa-f]{6}$",
                                 description="Цвет пола, #RRGGBB; null — цвет пресета floor_material")
    floor_material: Optional[FloorMaterial] = Field(
        None, description="Пол: oak_light — дуб светлый, walnut — орех, tile — плитка, concrete — бетон, "
                          "carpet — ковролин")
    walls_visible: bool = Field(True, description="Показывать стены комнаты в 3D")
    source: Literal["photo", "manual"] = "manual"


class SidePanel(_Strict):
    """Фальш-панель: декоративная боковина снаружи корпуса, закрывает торец и цоколь до пола.
    Глубина — корпус вместе с фасадами."""

    side: Literal["left", "right"]
    material: Optional[str] = Field(None, description="Материал (толщина — по материалу); null — как фасады")
    to_floor: bool = Field(True, description="До пола, закрывает цоколь; false — от низа корпуса")


class Body(_Strict):
    material: str = Field("ldsp_16_white", description="Материал корпуса (id из каталога)")
    top: Literal["between", "over"] = Field(
        "between", description="between — крыша между боковинами, over — крыша накладная, на боковины"
    )
    plinth: Optional[Plinth] = Field(default_factory=Plinth, description="Цоколь; null — боковины и дно на полу")
    back: Back = Field(default_factory=Back)
    cornice: Optional[Cornice] = Field(None, description="Карниз сверху по фасаду")


class Handles(_Strict):
    kind: Literal["none", "bar", "knob", "gola"] = Field(
        "bar", description="none — без ручек (push), bar — скоба, knob — кнопка (грибок), gola — профиль Gola")
    spacing: Literal[96, 128, 160, 192, 256, 320] = Field(128, description="Межосевое расстояние скобы, мм")
    finish: Literal["steel", "black", "chrome", "brass", "gold"] = Field("steel", description="Отделка ручек")


HardwareClass = Literal["econom", "standard", "premium"]


class HardwareChoice(_Strict):
    """Фурнитура изделия (FR-46): тип и класс. Конкретные позиции подбирает ядро по правилам."""

    hinge: Literal["standard", "soft_close", "push"] = Field(
        "soft_close", description="Петли: standard — без доводчика, soft_close — с доводчиком, push — push-to-open"
    )
    hinge_class: HardwareClass = "standard"
    slides: Literal["ball", "hidden_full", "hidden_soft"] = Field(
        "ball", description="Направляющие ящиков: ball — шариковые, hidden_full — скрытые полного выдвижения, "
                            "hidden_soft — скрытые с доводчиком"
    )
    slides_class: HardwareClass = "standard"


class Fronts(_Strict):
    material: Optional[str] = Field(None, description="Материал фасадов; null — как у корпуса")
    handles: Handles = Field(default_factory=Handles)
    style: FrontStyle = Field(default_factory=FrontStyle, description="Фрезеровка, накладной декор, вставки, "
                                                                       "покраска, скругление углов")


class SlidingDoors(_Strict):
    """Двери-купе на весь фасад. Наполнение корпуса отступает на глубину рельсов."""

    count: int = Field(ge=2, le=6, description="Сколько дверей-купе")
    fills: list[Literal["panel", "mirror"]] = Field(
        default_factory=list,
        description="Заполнение каждой двери слева направо: panel — ЛДСП, mirror — зеркало. Пусто — все ЛДСП",
    )
    panel_material: str = Field("ldsp_10_white", description="Заполнение (10 мм): ЛДСП нужного декора или «mdf_10_paint» — тогда купе красятся в цвет fronts.style.paint")


class Mezzanine(_Strict):
    height: float = Field(ge=200, le=800, description="Высота антресоли в свету, мм")
    doors: bool = Field(True, description="Двери на антресоли (по одной или две на секцию — по ширине)")


Corner = Literal["x0y0", "x1y0", "x0y1", "x1y1"]


class RoundCorner(_Strict):
    """Скругление угла детали (радиусный торец, скруглённая полка)."""

    op: Literal["round_corner"] = "round_corner"
    part: str = Field(description="Ключ детали (key из модели деталей)")
    corner: Corner = Field(description="Угол в координатах детали: x — длина, y — ширина")
    radius: float = Field(gt=0, description="Радиус, мм")


class Cutout(_Strict):
    """Сквозной прямоугольный вырез (ручка-вырез, розетка, труба)."""

    op: Literal["cutout"] = "cutout"
    part: str
    x: float = Field(description="Левый нижний угол выреза от угла детали, мм (чистовые координаты)")
    y: float
    width: float = Field(gt=0, description="Размер вдоль длины детали, мм")
    height: float = Field(gt=0, description="Размер вдоль ширины детали, мм")
    radius: float = Field(0, ge=0, description="Скругление углов выреза, мм")


class GrooveOp(_Strict):
    """Паз или четверть по всей длине (или ширине) детали."""

    op: Literal["groove"] = "groove"
    part: str
    along: Literal["length", "width"] = "length"
    offset: float = Field(ge=0, description="Расстояние от края (y=0 или x=0) до паза, мм; 0 — четверть")
    width: float = Field(gt=0, description="Ширина паза, мм")
    depth: float = Field(gt=0, description="Глубина паза, мм")
    face: Literal["A", "B"] = "A"


class Pocket(_Strict):
    """Выборка на глубину (утопленная ручка, ниша под накладку)."""

    op: Literal["pocket"] = "pocket"
    part: str
    x: float
    y: float
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    depth: float = Field(gt=0)
    face: Literal["A", "B"] = "A"


Operation = Annotated[Union[RoundCorner, Cutout, GrooveOp, Pocket], Field(discriminator="op")]


class Product(_Strict):
    schema_version: Literal["0.2"] = "0.2"
    type: Literal["wardrobe"] = "wardrobe"
    width: float = Field(gt=0, description="Общая ширина, мм")
    height: float = Field(gt=0, description="Общая высота, мм")
    depth: float = Field(gt=0, description="Глубина корпуса вместе с задней стенкой, без фасадов, мм")
    installation: Literal["freestanding", "niche"] = "freestanding"
    body: Body = Field(default_factory=Body)
    fronts: Fronts = Field(default_factory=Fronts)
    hardware: HardwareChoice = Field(default_factory=HardwareChoice)
    mezzanine: Optional[Mezzanine] = Field(None, description="Антресоль над всеми секциями")
    end_units: list[EndUnit] = Field(
        default_factory=list, max_length=2,
        description="Торцевые радиусные секции слева и/или справа; width изделия — без них",
    )
    sliding_doors: Optional[SlidingDoors] = Field(
        None, description="Двери-купе на весь фасад; тогда у секций нет распашных дверей и ящиков с фасадами"
    )
    builtin: Optional[Builtin] = Field(
        None, description="Встроенный в нишу: корпус меньше ниши, щели закрыты доборами (width/height — корпус)")
    side_panels: list[SidePanel] = Field(
        default_factory=list, max_length=2, description="Фальш-панели снаружи боковин (до пола)")
    room_colors: Optional[RoomColors] = Field(None, description="Цвет стен и пола для 3D (заполняет приложение)")
    sections: list[Section] = Field(min_length=1, max_length=10, description="Секции слева направо")
    operations: list[Operation] = Field(
        default_factory=list, description="Операции формы над деталями: скругления, вырезы, пазы, выборки"
    )
    lighting: list[Light] = Field(default_factory=list, max_length=12, description="Подсветка")


# --- Кухня (прямая) ---


class BaseCabinet(_Strict):
    """Нижний модуль кухни."""

    kind: Literal["doors", "drawers", "sink", "appliance", "corner", "fridge"] = Field(
        description="doors — с дверями и полкой, drawers — ящики, sink — под мойку, appliance — ниша под технику, "
                    "corner — угловой модуль в углу Г-образной кухни (см. corner_shape), fridge — ниша под "
                    "холодильник от пола до верха верхних (с края ряда; без столешницы и цоколя)"
    )
    width: float = Field(ge=150, le=1200, description="Ширина модуля, мм")
    doors: Optional[Literal[1, 2]] = Field(None, description="Сколько дверей; null — по ширине (до 600 мм — одна)")
    hinge: Literal["left", "right"] = "left"
    drawers: int = Field(3, ge=1, le=5, description="Ящиков (для kind=drawers)")
    shelf: bool = Field(True, description="Полка внутри (для kind=doors и глухого угла)")
    corner_shape: Literal["square", "long"] = Field(
        "long", description="Для kind=corner: square — Г-образный модуль width×width (900 или 1000) на обе стены, "
                            "второй ряд начинается через width от угла; long — длинный глухой модуль 1000–1200 "
                            "вдоль первого ряда, второй ряд — от кромки столешницы"
    )
    corner_fill: Literal["blind", "carousel", "swing"] = Field(
        "blind", description="Для kind=corner: blind — глухой угол (полка, без механизма), carousel — карусель 3/4 "
                             "(только corner_shape=square), swing — поворотная (выдвижная) полка"
    )
    hob: bool = Field(False, description="Над модулем варочная панель (обычно appliance 600 под духовку)")
    dw: bool = Field(False, description="Для kind=appliance: встраиваемая посудомойка — фасад на дверь машины")
    fridge_height: float = Field(1850, ge=1000, le=2300, description="Для kind=fridge: высота холодильника, мм")
    top_panel: bool = Field(True, description="Для kind=fridge: полка и фальш-панель над холодильником")
    style: Optional[FrontStyle] = Field(None, description="Стиль фасадов модуля; null — как у кухни")


class WallCabinet(_Strict):
    """Верхний модуль кухни."""

    kind: Literal["doors", "open", "hood", "gap"] = Field(
        description="doors — с дверями, open — открытые полки, hood — короткий шкаф над вытяжкой, "
                    "gap — пустое место на стене (окно, вентканал), без корпуса"
    )
    width: float = Field(ge=150, le=1200)
    doors: Optional[Literal[1, 2]] = None
    hinge: Literal["left", "right"] = "left"
    shelves: int = Field(1, ge=0, le=4)
    height: Optional[float] = Field(None, ge=200, le=1000, description="Высота; null — как у верхних (hood — 360)")
    style: Optional[FrontStyle] = Field(None, description="Стиль фасадов модуля; null — как у кухни")


class Countertop(_Strict):
    material: str = Field("countertop_38_oak", description="Столешница (id из каталога)")
    depth: float = Field(600, ge=400, le=900, description="Глубина столешницы, мм")


class KitchenBody(_Strict):
    material: str = Field("ldsp_16_white", description="Материал корпусов")
    back: Back = Field(default_factory=Back)


class KitchenPlinth(_Strict):
    """Цоколь кухни на ножках. Не задан — планка высотой с ножки, отступ 50, без боков и решёток."""

    setback: float = Field(50, ge=0, le=150, description="Отступ планки цоколя от фасадов назад, мм")
    sides: Literal["auto", "none"] = Field(
        "auto", description="auto — боковые планки там, где торец ряда открыт (нет стены, фальш-панели, "
                            "холодильника); none — без боковых")
    grilles: list[Literal["sink", "oven"]] = Field(
        default_factory=list, description="Вентиляционные решётки в цоколе: под мойкой, под духовкой")
    floor_allowance: float = Field(5, ge=0, le=30, description="Зазор планки до пола на неровность, мм")


class KitchenSidePanel(SidePanel):
    """Фальш-панель на торце ряда кухни: нижняя — до пола (закрывает цоколь), под столешницу; верхняя — на торце
    верхних модулей."""

    row: Literal["base", "wall", "both"] = Field("base", description="base — у нижних, wall — у верхних, both")
    run: Literal[1, 2] = Field(1, description="Ряд: 1 — первый (side — его левый/правый торец), 2 — второй ряд "
                                              "угловой кухни (ставится на свободный торец, side не важен)")


class KitchenTopFiller(_Strict):
    """Добор (фальш-панель) от верха верхних модулей до потолка, заподлицо с их фасадами."""

    ceiling: Optional[float] = Field(None, ge=1800, le=5000, description="Высота потолка, мм; null — из замера")
    scribe: float = Field(15, ge=0, le=40, description="Припуск на подрезку по потолку, мм")
    material: Optional[str] = Field(None, description="Материал; null — как фасады")


# --- Замер кухни: стены, окно, коммуникации (SCR-13b) ---


class KitchenWindow(_Strict):
    wall: Literal["a", "b"] = Field("a", description="На какой стене окно")
    from_corner: float = Field(ge=0, le=20000, description="От угла (у прямой — от левого края стены) до окна, мм")
    width: float = Field(gt=0, le=5000, description="Ширина проёма, мм")
    sill: float = Field(900, ge=0, le=3000, description="Высота подоконника от пола, мм")


class Utility(_Strict):
    kind: Literal["water", "sewer", "gas", "socket", "vent"] = Field(
        description="water — вода (мойка), sewer — канализация, gas — газ (варка), socket — розетка, vent — вентканал"
    )
    wall: Literal["a", "b"] = "a"
    from_corner: float = Field(ge=0, le=20000, description="От угла (у прямой — от левого края стены), мм")
    height: Optional[float] = Field(None, ge=0, le=4000, description="Высота от пола, мм")
    size: Optional[str] = Field(None, max_length=40, description="Размер (вентканал: «200×150»)")


class KitchenSite(_Strict):
    """Помещение по замеру: стена A — под первым рядом (base), стена B — под вторым (base2)."""

    wall_a: float = Field(gt=0, le=20000, description="Длина стены A, мм")
    wall_b: Optional[float] = Field(None, gt=0, le=20000, description="Длина стены B (угловая кухня), мм")
    ceiling: Optional[float] = Field(None, ge=1800, le=5000, description="Высота потолка, мм")
    window: Optional[KitchenWindow] = None
    utilities: list[Utility] = Field(default_factory=list, max_length=40)


class Kitchen(_Strict):
    schema_version: Literal["0.2"] = "0.2"
    type: Literal["kitchen"] = "kitchen"
    installation: Literal["freestanding", "niche"] = "niche"
    body: KitchenBody = Field(default_factory=KitchenBody)
    fronts: Fronts = Field(default_factory=Fronts)
    hardware: HardwareChoice = Field(default_factory=HardwareChoice)
    legs_height: float = Field(100, ge=60, le=200, description="Высота ножек (цоколя), мм")
    base_height: float = Field(720, ge=500, le=900, description="Высота нижних корпусов без ножек и столешницы, мм")
    base_depth: float = Field(560, ge=300, le=700, description="Глубина нижних корпусов с задней стенкой, мм")
    countertop: Countertop = Field(default_factory=Countertop)
    wall_bottom: float = Field(1400, ge=1100, le=1800, description="От пола до низа верхних модулей, мм")
    wall_height: float = Field(720, ge=300, le=1400, description="Высота верхних модулей, мм")
    wall_to_ceiling: bool = Field(False, description="Верхние до потолка: по замеру высота = потолок − низ верхних")
    wall_depth: float = Field(300, ge=200, le=400, description="Глубина верхних модулей с задней стенкой, мм")
    base: list[BaseCabinet] = Field(min_length=1, max_length=12, description="Нижние модули слева направо")
    wall: list[WallCabinet] = Field(default_factory=list, max_length=12, description="Верхние модули слева направо")
    layout: Literal["straight", "corner"] = Field("straight", description="straight — прямая, corner — угловая (Г)")
    corner_side: Literal["left", "right"] = Field(
        "right", description="С какой стороны первого ряда угол (для layout=corner)"
    )
    base2: list[BaseCabinet] = Field(
        default_factory=list, max_length=12,
        description="Нижние модули второго ряда, от угла вдоль соседней стены (для layout=corner)",
    )
    wall2: list[WallCabinet] = Field(
        default_factory=list, max_length=12, description="Верхние модули второго ряда, от угла"
    )
    site: Optional[KitchenSite] = Field(
        None, description="Стены, окно и коммуникации с замера (заполняет приложение, не ИИ)"
    )
    plinth: Optional[KitchenPlinth] = Field(None, description="Цоколь: отступ, боковые планки, решётки, зазор до пола")
    side_panels: list[KitchenSidePanel] = Field(
        default_factory=list, max_length=6, description="Фальш-панели на торцах рядов (до пола)")
    top_filler: Optional[KitchenTopFiller] = Field(
        None, description="Добор до потолка над верхними модулями (и над холодильником)")
    room_colors: Optional[RoomColors] = Field(None, description="Цвет стен и пола для 3D (заполняет приложение)")
    operations: list[Operation] = Field(default_factory=list)
    lighting: list[Light] = Field(default_factory=list, max_length=12, description="Подсветка")


ProductTree = Annotated[Union[Product, Kitchen], Field(discriminator="type")]
