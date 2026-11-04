"""Смета: модель деталей + раскрой + прайс → себестоимость и цена клиенту.

Раздел 7 PRD:
- листы — по раскрою, с запасом +1 лист, если последний заполнен больше чем на 70%;
- кромка — по длине кромлённых сторон, +10%; распил — по листам; кромкование — по метрам;
- фурнитура — из модели (петли, направляющие, ручки…);
- цена клиенту = материалы × (1 + наценка категории) + работа мастера;
- до замера — диапазон «от–до»: ожидаемая цена ± 3–8 % по реальной неопределённости (см. estimate_range).
"""

import copy
import math
from datetime import date as _date
from collections import defaultdict
from typing import Literal, Optional

from pydantic import BaseModel, Field

from .assembler import BuildResult, build
from .catalog import edge_type, material
from .nesting import Nesting, nest
from .pricing import DEMO_PRICES, PRICE_DATE, PRICE_SOURCE, Category, PriceBook
from .rules import DEFAULT_RULES, RuleSet
from .units import to_mm

FRONT_ROLES = {"door", "drawer_front", "sliding_fill", "niche_filler", "false_panel"}  # доборы и фальш-панели — с фасадами
FRONT_HARDWARE = {"profile", "rail", "rollers", "glass"}
CATEGORY_NAMES = {"body": "Корпус", "fronts": "Фасады", "hardware": "Фурнитура", "services": "Услуги поставщика"}


class PricingSettings(BaseModel):
    """Цена мастера (раздел 7 PRD). Значения по умолчанию дают прежние +50% на всё."""

    work_percent: float = Field(50, ge=0, le=500, description="Работа мастера, % от себестоимости материалов")
    work_fixed: Optional[int] = Field(None, ge=0, description="Работа мастера фиксированной суммой, сум")
    markup: dict[Category, float] = Field(
        default_factory=lambda: {"body": 0, "fronts": 0, "hardware": 0, "services": 0},
        description="Наценка на материалы по категориям, %",
    )


class EstimateLine(BaseModel):
    key: str  # стабильный ключ строки — чтобы сопоставить «от» и «до»
    category: Category
    group: str  # для подробной сметы клиенту: Листы, Кромка, Распил и кромкование, Фурнитура…
    name: str
    client_name: str = ""  # без каталожных подробностей (формат листа, артикул) — для клиента
    unit: str
    qty: float
    unit_price: int
    cost: int
    status: Literal["catalog", "analog", "request", "nonstandard"]
    source: str = PRICE_SOURCE
    priced_at: str = PRICE_DATE
    stale: bool = False  # цена старше 14 дней — пересчитать перед отправкой клиенту (раздел 7 PRD)


class Estimate(BaseModel):
    lines: list[EstimateLine]
    cost_by_category: dict[str, int]
    cost_total: int  # себестоимость материалов и услуг
    materials_client: int  # материалы для клиента (с наценкой)
    work: int  # работа мастера
    total_client: int
    sheets: dict[str, int]  # материал → листов (с запасом)
    waste_percent: dict[str, float]
    has_requests: bool  # есть позиции «под запрос»
    has_stale: bool = False  # есть устаревшие цены
    price_source: str = PRICE_SOURCE


STALE_DAYS = 14


def estimate(result: BuildResult, settings: PricingSettings | None = None, rules: RuleSet = DEFAULT_RULES,
             nesting: Nesting | None = None, extra_sheet: bool = False, prices: PriceBook | None = None,
             today: _date | None = None) -> Estimate:
    """prices — прайс (по умолчанию демо); today — для пометки устаревших цен."""
    settings = settings or PricingSettings()
    pb = prices or DEMO_PRICES
    nesting = nesting or nest(result, rules)
    lines: list[EstimateLine] = []

    # Категория материала: только фасадные детали → «Фасады», иначе «Корпус»
    roles_by_mat: dict[str, set] = defaultdict(set)
    for p in result.parts:
        roles_by_mat[p.material].add(p.role)

    def mat_category(mat_id: str) -> Category:
        return "fronts" if roles_by_mat[mat_id] and roles_by_mat[mat_id] <= FRONT_ROLES else "body"

    # Листы
    total_sheets = 0
    sheets_by_kind: dict[str, int] = defaultdict(int)
    sheets: dict[str, int] = {}
    for m in nesting.materials:
        count = len(m.sheets)
        if m.last_sheet_usage > rules.sheet_reserve_threshold:
            count += 1
        if extra_sheet:
            count += 1
        sheets[m.material] = count
        total_sheets += count
        sheets_by_kind[material(m.material).kind] += count
        item = pb.sheets.get(m.material)
        lines.append(_line(f"sheet:{m.material}", mat_category(m.material), "Листы",
                           item.name if item else material(m.material).name, "лист", count,
                           item.price if item else 0, item.status if item else "request",
                           client_name=material(m.material).name))

    # Столешницы — погонными метрами
    for p in result.parts:
        if material(p.material).kind == "countertop":
            item = pb.countertops.get(p.material)
            meters = math.ceil(to_mm(p.length) / 100) / 10  # до 10 см вверх
            lines.append(_line(f"countertop:{p.material}:{p.key}", "body", "Столешница",
                               item.name if item else material(p.material).name, "м", meters,
                               item.price if item else 0, item.status if item else "request"))

    # Вырезы в столешнице (под мойку) режет поставщик по файлу
    cutouts = sum(len(p.cutouts) for p in result.parts if material(p.material).kind == "countertop")
    if cutouts:
        s = pb.services.get("countertop_cutout")
        lines.append(_line("service:countertop_cutout", "services", "Столешница",
                           s.name if s else "Вырез в столешнице под мойку", "шт", cutouts,
                           s.price if s else 0, s.status if s else "request"))

    # Доборы клином: косой рез по контуру на каждый добор
    wedges = sum(1 for p in result.parts if p.role == "niche_filler" and p.contour is not None)
    if wedges:
        s = pb.services.get("wedge_cut")
        lines.append(_line("service:wedge_cut", "services", "Распил и кромкование",
                           s.name if s else "Косой рез добора (клин по замеру)", "шт", wedges,
                           s.price if s else 0, s.status if s else "request"))

    # Кромка: длина кромлённых сторон + 10%
    edge_m: dict[tuple[str, Category], float] = defaultdict(float)
    for p in result.parts:
        cat: Category = "fronts" if p.role in FRONT_ROLES else "body"
        for side, edge_id in p.edges.items():
            length = p.width if side in ("x0", "x1") else p.length
            edge_m[(edge_id, cat)] += to_mm(length) / 1000
    total_edge = 0.0
    for (edge_id, cat), meters in sorted(edge_m.items()):
        qty = math.ceil(meters * 1.1 * 10) / 10
        total_edge += qty
        item = pb.edges.get(edge_id)
        name = (item.name if item else edge_type(edge_id).name) + (" (фасады)" if cat == "fronts" else "")
        lines.append(_line(f"edge:{edge_id}:{cat}", cat, "Кромка" if not pb.edging_includes_tape else "Распил и кромкование", name,
                           "м", qty, item.price if item else 0, item.status if item else "request"))

    # Услуги поставщика
    for kind, count in sorted(sheets_by_kind.items()):
        s = pb.services.get("cut_hdf" if kind == "hdf" else "cut") or pb.services["cut"]
        lines.append(_line(f"service:cut:{kind}", "services", "Распил и кромкование", s.name, s.unit, count, s.price,
                           s.status))
    if total_edge and not pb.edging_includes_tape:
        s = pb.services["edging"]
        lines.append(_line("service:edging", "services", "Распил и кромкование", s.name, s.unit,
                           round(total_edge, 1), s.price, s.status))

    # Фурнитура
    lines += _hardware_lines(result, pb)
    # Декор фасадов, ручки-кнопки, Gola, подсветка
    lines += _decor_lines(result, pb)

    # Источник и дата цены у каждой строки; старше 14 дней — «устарела»
    today = today or _date.today()
    for line in lines:
        item_id = line.key.split(":")[1] if ":" in line.key else line.key
        line.source = pb.source
        line.priced_at = pb.date_of(item_id)
        try:
            line.stale = line.status != "request" and (today - _date.fromisoformat(line.priced_at)).days > STALE_DAYS
        except ValueError:
            line.stale = False

    cost_by_category = {c: 0 for c in CATEGORY_NAMES}
    for line in lines:
        cost_by_category[line.category] += line.cost
    cost_total = sum(cost_by_category.values())
    materials_client = sum(
        round(cost * (1 + settings.markup.get(cat, 0) / 100)) for cat, cost in cost_by_category.items()
    )
    work = settings.work_fixed if settings.work_fixed is not None else round(cost_total * settings.work_percent / 100)
    return Estimate(
        lines=lines,
        cost_by_category=cost_by_category,
        cost_total=cost_total,
        materials_client=materials_client,
        work=work,
        total_client=materials_client + work,
        sheets=sheets,
        waste_percent={m.material: m.waste_percent for m in nesting.materials},
        has_requests=any(line.status == "request" for line in lines),
        has_stale=any(line.stale for line in lines),
        price_source=pb.source,
    )


def _line(key, category, group, name, unit, qty, unit_price, status, client_name: str = "") -> EstimateLine:
    return EstimateLine(key=key, category=category, group=group, name=name, client_name=client_name or name,
                        unit=unit, qty=qty, unit_price=unit_price, cost=round(qty * unit_price), status=status)


def _hardware_lines(result: BuildResult, pb: PriceBook) -> list[EstimateLine]:
    out: list[EstimateLine] = []
    counts: dict[tuple, float] = defaultdict(float)
    names: dict[tuple, str] = {}
    hinge_params: dict[tuple, dict] = {}
    for h in result.hardware:
        if h.kind in DECOR_HARDWARE:  # считаются в _decor_lines
            continue
        if h.kind in ("rod", "profile", "rail", "mount_rail"):
            key, qty, unit = (h.kind,), h.qty * to_mm(int(h.params.get("length", 0))) / 1000, "м"
        elif h.kind == "glass":
            area = to_mm(int(h.params.get("width", 0))) * to_mm(int(h.params.get("height", 0))) / 1e6
            key, qty, unit = (h.kind,), h.qty * area, "м²"
        elif h.kind == "slide":
            key = (h.kind, int(to_mm(int(h.params.get("length", 0)))), h.params.get("type", "ball"),
                   h.params.get("hclass", "standard"))
            qty, unit = h.qty, "пара"
        else:
            key, qty, unit = (h.kind, h.name), h.qty, "шт"
            if h.kind in ("hinge", "handle"):
                hinge_params[key] = h.params
        counts[key] += qty
        long_kind = h.kind in ("rod", "profile", "rail", "mount_rail", "glass") and h.kind in pb.hardware
        names[key] = pb.hardware[h.kind].name if long_kind else h.name
        names[key + ("unit",)] = unit
    for key, qty in counts.items():
        kind = key[0]
        item = pb.hardware.get(kind)
        category: Category = "fronts" if kind in FRONT_HARDWARE else "hardware"
        group = "Зеркало и стекло" if kind == "glass" else ("Система купе" if kind in FRONT_HARDWARE else "Фурнитура")
        if kind == "slide":
            base = pb.slides.get(key[1], 0)
            price = round(base * pb.slide_factor.get(key[2], 1) * pb.class_factor.get(key[3], 1))
            status = "catalog" if price else "request"
        else:
            price = item.price if item else 0
            status = item.status if item else "request"
            if kind == "handle" and price:
                price = round(price * pb.handle_finish_factor.get(str(hinge_params.get(key, {}).get("finish", "steel")), 1))
            if kind == "hinge" and price:
                params = hinge_params.get(key, {})
                price = round(price * pb.hinge_factor.get(params.get("type", "soft_close"), 1)
                              * pb.class_factor.get(params.get("hclass", "standard"), 1))
        qty = round(qty, 2) if names[key + ("unit",)] in ("м", "м²") else qty
        out.append(_line(f"hw:{':'.join(map(str, key))}", category, group, names[key], names[key + ("unit",)],
                         qty, price, status))
    return out


DECOR_HARDWARE = {"knob", "gola_profile", "gola_fittings", "led_profile", "led_strip", "led_sensor", "power_supply"}
DECOR_GROUP, LIGHT_GROUP = "Декор фасадов", "Подсветка"
FRAME_PATTERNS = {"shaker", "classic"}
GROOVE_PATTERNS = {"grooves_v", "grooves_h"}


def _fronts_word(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} фасад"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} фасада"
    return f"{n} фасадов"


def _m(v: float) -> str:
    return f"{v:.1f}".replace(".", ",").replace(",0", "")


def _decor_lines(result: BuildResult, pb: PriceBook) -> list[EstimateLine]:
    """Строки декора: покраска (м², обратная сторона дешевле), фрезеровка (за фасад или м²), молдинг (п. м +
    установка), металлические вставки (п. м + работа), кнопки, Gola, подсветка. Нет цены — «под запрос»."""
    from .decor import GLOSS_NAMES, MILLING_NAMES, OVERLAY_NAMES, path_length
    from .lighting import SENSOR_NAMES, ZONE_NAMES

    out: list[EstimateLine] = []

    def add(key, group, item_id, name, client, unit, qty, price_factor=1.0, category: Category = "fronts"):
        item = pb.decor.get(item_id)
        price = round(item.price * price_factor) if item else 0
        out.append(_line(key, category, group, name, unit, qty, price, item.status if item else "request",
                         client_name=client))

    paint: dict[tuple, list[float]] = defaultdict(lambda: [0.0, 0.0])  # (gloss, code) → [лицо, обратная]
    milling: dict[str, list] = defaultdict(lambda: [0, 0.0])  # рисунок → [фасадов, м²]
    overlay: dict[str, list] = defaultdict(lambda: [0, 0.0])  # рисунок → [фасадов, м]
    inlay: dict[tuple, list] = defaultdict(lambda: [0, 0.0])  # (вид, отделка) → [фасадов, м]
    for p in result.parts:
        d = p.decor
        if d is None:
            continue
        area = to_mm(p.length) * to_mm(p.width) / 1e6
        if d.paint:
            k = (d.paint.get("gloss", "matte"), d.paint.get("code") or d.paint.get("color"))
            paint[k][0] += area
            if d.paint.get("both_sides"):
                paint[k][1] += area
        if d.milling:
            milling[d.milling_pattern][0] += 1
            milling[d.milling_pattern][1] += area
        if d.overlay:
            overlay[d.overlay_pattern][0] += 1
            overlay[d.overlay_pattern][1] += sum(to_mm(path_length(o.path)) for o in d.overlay) / 1000
        if d.inlay:
            k = (d.inlay_kind, d.inlay_finish)
            inlay[k][0] += 1
            inlay[k][1] += sum(to_mm(path_length(o.path)) for o in d.inlay) / 1000

    for (gloss, code), (face, back) in sorted(paint.items()):
        g = GLOSS_NAMES.get(gloss, gloss)
        add(f"decor:paint:{gloss}:{code}:face", DECOR_GROUP, f"paint_{gloss}", f"Покраска МДФ {g}, {code} — лицевая сторона",
            f"Покраска фасадов {code}, {g}", "м²", math.ceil(face * 100) / 100)
        if back:
            add(f"decor:paint:{gloss}:{code}:back", DECOR_GROUP, f"paint_{gloss}",
                f"Покраска МДФ {g}, {code} — обратная сторона", f"Покраска фасадов {code}, обратная сторона", "м²",
                math.ceil(back * 100) / 100, pb.paint_back_factor)
    for pattern, (n, area) in sorted(milling.items()):
        title = f"Фрезеровка «{MILLING_NAMES.get(pattern, pattern)}»"
        if pattern in GROOVE_PATTERNS:
            add(f"decor:milling:{pattern}", DECOR_GROUP, "milling_grooves", f"{title}, {_fronts_word(n)}",
                f"{title}, {_fronts_word(n)}", "м²", math.ceil(area * 100) / 100)
        else:
            add(f"decor:milling:{pattern}", DECOR_GROUP, "milling_frame" if pattern in FRAME_PATTERNS else "milling_figured",
                title, f"{title}, {_fronts_word(n)}", "фасад", n)
    for pattern, (n, meters) in sorted(overlay.items()):
        meters = math.ceil(meters * 10) / 10
        title = f"Накладной молдинг «{OVERLAY_NAMES.get(pattern, pattern)}»"
        add(f"decor:overlay:{pattern}", DECOR_GROUP, "overlay_profile", title,
            f"{title}, {_fronts_word(n)}, {_m(meters)} м", "м", math.ceil(meters * 10) / 10)
        add(f"decor:overlay_install:{pattern}", DECOR_GROUP, "overlay_install", "Установка молдинга",
            f"Установка молдинга, {_fronts_word(n)}", "фасад", n)
    metal = {"brass": "Латунная", "gold": "Золотая", "black": "Чёрная", "chrome": "Хромированная"}
    kinds = {"frame": "рамка", "line_h": "полоса поперёк", "line_v": "полоса вдоль", "edge": "кант по краю"}
    for (kind, finish), (n, meters) in sorted(inlay.items()):
        meters = math.ceil(meters * 10) / 10
        title = f"{metal.get(finish, finish)} {kinds.get(kind, kind)}"
        if kind == "edge":
            title = f"{metal.get(finish, finish).replace('ая', 'ой')} кант по краю"
        item_id = "inlay_brass" if finish in ("brass", "gold") else "inlay_metal"
        add(f"decor:inlay:{kind}:{finish}", DECOR_GROUP, item_id, f"Профиль-вставка: {title}",
            f"{title}, {_fronts_word(n)}, {_m(meters)} м", "м", math.ceil(meters * 10) / 10)
        add(f"decor:inlay_labour:{kind}:{finish}", DECOR_GROUP, "inlay_labour", f"Установка вставки: {title}",
            f"Установка: {title.lower()}, {_fronts_word(n)}", "фасад", n)

    # Кнопки и Gola — по фурнитуре модели
    knobs: dict[str, int] = defaultdict(int)
    gola_m, gola_fronts = 0.0, 0
    leds: dict[str, dict] = {}
    for h in result.hardware:
        if h.kind == "knob":
            knobs[str(h.params.get("finish", "steel"))] += h.qty
        elif h.kind == "gola_profile":
            gola_m += h.qty * to_mm(int(h.params.get("length", 0))) / 1000
        elif h.kind == "gola_fittings":
            gola_fronts += h.qty
        elif h.kind in ("led_profile", "led_strip", "led_sensor"):
            leds.setdefault(h.module, {})[h.kind] = h
        elif h.kind == "power_supply":
            add("decor:power", LIGHT_GROUP, f"power_{h.params.get('watts')}", h.name, "Блок питания подсветки", "шт",
                h.qty, category="hardware")
    names = {"steel": "сталь", "black": "чёрные", "chrome": "хром", "brass": "латунь", "gold": "золото"}
    for finish, n in sorted(knobs.items()):
        add(f"decor:knob:{finish}", "Фурнитура", "knob_brass" if finish in ("brass", "gold") else "knob",
            f"Ручка-кнопка ({names.get(finish, finish)})", f"Ручки-кнопки ({names.get(finish, finish)})", "шт", n,
            category="hardware")
    if gola_m:
        gola_m = math.ceil(gola_m * 10) / 10
        add("decor:gola", "Фурнитура", "gola_profile", "Профиль Gola", f"Профиль Gola вместо ручек, {_m(gola_m)} м",
            "м", math.ceil(gola_m * 10) / 10, category="hardware")
        add("decor:gola_fittings", "Фурнитура", "gola_fittings", "Заглушки и крепёж Gola",
            f"Крепёж Gola, {_fronts_word(gola_fronts)}", "фасад", gola_fronts, category="hardware")

    # Подсветка: профиль с рассеивателем + лента одной строкой на зону
    for mod, items in sorted(leds.items()):
        strip, prof = items.get("led_strip"), items.get("led_profile")
        if not strip:
            continue
        meters = math.ceil(to_mm(int(strip.params.get("length", 0))) / 100) / 10
        zone, temp = strip.params.get("zone", ""), strip.params.get("temp", 4000)
        title = f"Подсветка {ZONE_NAMES.get(zone, zone)}, {_m(meters)} м, {temp} K"
        p_item, s_item = pb.decor.get("led_profile"), pb.decor.get("led_strip")
        price = (p_item.price if p_item and prof else 0) + (s_item.price if s_item else 0)
        status = "analog" if price and "catalog" not in {p_item and p_item.status, s_item and s_item.status} else (
            "catalog" if price else "request")
        out.append(_line(f"decor:led:{mod}", "hardware", LIGHT_GROUP,
                         f"Профиль с рассеивателем + {strip.name}", "м", meters, price, status, client_name=title))
        sensor = items.get("led_sensor")
        if sensor:
            st = str(sensor.params.get("sensor"))
            add(f"decor:sensor:{mod}", LIGHT_GROUP, f"sensor_{st}", sensor.name,
                f"{SENSOR_NAMES.get(st, st).capitalize()} для подсветки", "шт", sensor.qty, category="hardware")
    return out


# --- Диапазон «от–до» до замера ---
# Ожидаемая цена — модель как есть. Полоса вокруг неё — из реальной неопределённости:
# незамеренные / оценённые по фото размеры, позиции по аналогу, материалы «оценка». Полоса 3–8 %.

BAND_MIN, BAND_MAX = 0.03, 0.08
# Линейная ошибка размера до замера: оценка по фото — по измерению; заданы словами — остаточная
SIZE_ERR = {"width": 0.04, "height": 0.03, "depth": 0.015}
SIZE_ERR_UNMEASURED = 0.015
ANALOG_ERR = 0.15  # цена по аналогу
MATERIAL_ERR = 0.10  # материал категории не выбран (оценка ИИ)
SIZE_CATEGORIES = ("body", "fronts", "services")  # стоимость растёт с площадью
UNC_TEXT_MAX = 3  # в строке пояснения — три главных причины

UNC_NAMES = {"sizes": ("размеры", "o‘lchamlar"), "body": ("корпус", "korpus"), "fronts": ("фасады", "fasadlar"),
             "hardware": ("фурнитура", "furnitura"), "services": ("услуги", "xizmatlar")}
UNC_REASONS = {
    "photo": ("размеры по фото, уточнятся на замере", "o‘lchamlar fotodan, o‘lchovda aniqlanadi"),
    "unmeasured": ("уточнятся на замере", "o‘lchovda aniqlanadi"),
    "analog": ("цена по аналогу", "analog narxi"),
    "request": ("цена уточняется", "narx aniqlanadi"),
    "material": ("материал уточняется", "material aniqlanadi"),
}


class PriceRange(BaseModel):
    low: int
    high: int


class Uncertainty(BaseModel):
    category: str  # sizes | body | fronts | hardware | services
    name: str
    name_uz: str
    reason: str
    reason_uz: str


class EstimateRange(BaseModel):
    exact: bool
    low: Estimate  # ожидаемая смета (low и high — одна и та же, поля оставлены для совместимости)
    high: Estimate
    total: PriceRange
    materials: PriceRange
    work: PriceRange
    expected: int = 0  # ожидаемая цена клиенту
    band: float = 0.0  # полуширина полосы, доля (0.05 = ±5 %)
    uncertainty: list[Uncertainty] = Field(default_factory=list)
    uncertainty_text: str = ""  # «оценка: размеры, фасады»
    uncertainty_text_uz: str = ""

    def band_range(self, value: int, step: int = 1000) -> PriceRange:
        """Та же полоса для любой суммы (группа сметы, себестоимость); после замера — точно."""
        if self.exact:
            return PriceRange(low=value, high=value)
        return PriceRange(low=_round(value * (1 - self.band), step), high=_round(value * (1 + self.band), step))


def _round(v: float, step: int) -> int:
    return int(math.floor(v / step + 0.5)) * step


STEPS = (500_000, 250_000, 100_000, 50_000, 20_000, 10_000)


def _step(v: int, band: float) -> int:
    """Шаг округления: «3,05–3,35 млн», а не «3 104 220»; не крупнее трети полуширины полосы — чтобы
    округление не искажало полосу."""
    return next((s for s in STEPS if s <= v * band / 3), 1000)


def _ptr_parts(ptr: str) -> list[str]:
    return [p for p in ptr.split("/") if p != ""]


def _size_dim(ptr: str, kitchen: bool) -> str | None:
    """К какому размеру относится JSON Pointer «оценки»: width | height | depth | None (не размер)."""
    parts = _ptr_parts(ptr)
    if not parts:
        return None
    last, head = parts[-1], parts[0]
    if kitchen:
        if head in ("base", "base2", "wall", "wall2") and last == "width":
            return "width"
        if head in ("wall_height", "base_height", "wall_bottom", "legs_height") or (
                head in ("wall", "wall2") and last == "height"):
            return "height"
        if head in ("base_depth", "wall_depth"):
            return "depth"
        if head == "site":
            return "width"
        return None
    if head in ("width", "height", "depth") and len(parts) == 1:
        return head
    if head == "builtin" and len(parts) >= 2 and parts[1] == "niche":
        return last if last in ("width", "height", "depth") else "width"
    if head == "sections" and last == "width":
        return "width"
    if head == "sections" and last == "height" or head == "mezzanine" and last == "height":
        return "height"
    return None


def _material_category(ptr: str) -> Category | None:
    """Оценённый не-размер → категория цены: фасады, корпус, фурнитура."""
    parts = _ptr_parts(ptr)
    if not parts:
        return None
    if parts[0] in ("fronts", "sliding_doors") or "style" in parts or "doors" in parts:
        return "fronts"
    if parts[0] in ("body", "countertop", "side_panels", "plinth"):
        return "body"
    if parts[0] in ("hardware", "handles", "lighting") or "handles" in parts:
        return "hardware"
    return None


def _uncertainty(tree: dict, est: Estimate, settings: PricingSettings, estimated: list[str] | None):
    """(полоса, позиции неопределённости). Доли считаются в ценах клиента."""
    kitchen = tree.get("type") == "kitchen"
    work_k = 0 if settings.work_fixed is not None else settings.work_percent / 100
    total = max(est.total_client, 1)

    def share(line: EstimateLine) -> float:
        return line.cost * (1 + settings.markup.get(line.category, 0) / 100) * (1 + work_k) / total

    reasons: dict[str, list[str]] = defaultdict(list)
    contrib: dict[str, float] = defaultdict(float)  # вклад категории в полосу
    # Размеры: какие измерения взяты «на глаз»
    dims = {d for d in (_size_dim(p, kitchen) for p in (estimated or [])) if d}
    size_err = sum(SIZE_ERR[d] for d in dims) if dims else SIZE_ERR_UNMEASURED
    contrib["sizes"] += size_err * sum(share(line) for line in est.lines if line.category in SIZE_CATEGORIES)
    reasons["sizes"].append("photo" if dims else "unmeasured")
    # Позиции по аналогу и «под запрос» (вторые — без цены в итоге, только в пояснении)
    for line in est.lines:
        if line.status == "analog":
            contrib[line.category] += ANALOG_ERR * share(line)
            reasons[line.category].append("analog")
        elif line.status in ("request", "nonstandard"):
            contrib[line.category] += 0.0
            reasons[line.category].append("request")
    # Материалы, выбранные ИИ «на глаз»
    cats = {c for c in (_material_category(p) for p in (estimated or []) if not _size_dim(p, kitchen)) if c}
    for cat in sorted(cats):
        contrib[cat] += MATERIAL_ERR * sum(share(line) for line in est.lines if line.category == cat)
        reasons[cat].append("material")
    band = min(max(sum(contrib.values()), BAND_MIN), BAND_MAX)

    items: list[Uncertainty] = []
    order = ("sizes", "fronts", "body", "hardware", "services")
    for cat in sorted(reasons, key=lambda c: (-round(contrib[c], 4), order.index(c))):  # главное — первым
        uniq = list(dict.fromkeys(reasons[cat]))
        ru, uz = UNC_NAMES[cat]
        items.append(Uncertainty(category=cat, name=ru, name_uz=uz,
                                 reason=", ".join(UNC_REASONS[r][0] for r in uniq),
                                 reason_uz=", ".join(UNC_REASONS[r][1] for r in uniq)))
    return band, items


def _scaled_tree(tree: dict, factor: float) -> dict:
    """Размеры ×factor: ширина и высота изделия, заданные ширины секций и высоты зон (для оценок «а если больше»)."""
    t = copy.deepcopy(tree)
    if t.get("type") == "kitchen":
        for row in ("base", "wall", "base2", "wall2"):
            for cab in t.get(row, []):
                if cab.get("kind") in ("corner", "gap", "fridge"):  # угловой модуль, холодильник — стандартные
                    continue
                cab["width"] = min(round(cab["width"] * factor, 1), 1200)
        return t
    t["width"] = round(t["width"] * factor, 1)
    t["height"] = round(t["height"] * factor, 1)
    niche = (t.get("builtin") or {}).get("niche") or {}
    for k in list(niche):  # встроенный: ниша растёт вместе с корпусом, доборы те же
        if isinstance(niche[k], (int, float)) and k != "depth":
            niche[k] = round(niche[k] * factor, 1)
    sections = t.get("sections", [])
    for s in sections:
        if s.get("width") is not None:
            s["width"] = round(s["width"] * factor, 1)
        zones = s.get("fill", [])
        for z in zones:
            if z.get("height") is not None:
                z["height"] = round(z["height"] * factor, 1)
        if zones and all(z.get("height") is not None for z in zones):
            zones[-1]["height"] = None  # последняя зона забирает остаток
    if sections and all(s.get("width") is not None for s in sections):
        sections[-1]["width"] = None
    return t


def estimate_range(tree: dict, settings: PricingSettings | None = None, measured: bool = False,
                   rules: RuleSet = DEFAULT_RULES, result: BuildResult | None = None,
                   prices: PriceBook | None = None, estimated: list[str] | None = None) -> EstimateRange:
    """result — уже собранная модель этого дерева; prices — прайс; estimated — JSON Pointer'ы значений «оценка»
    (размеры по фото, материал на глаз). До замера: ожидаемая цена ± полоса 3–8 %; после — точная."""
    settings = settings or PricingSettings()
    if hasattr(tree, "model_dump"):
        tree = tree.model_dump(mode="json")
    est = estimate(result or build(tree, rules), settings, rules, prices=prices)
    if measured:
        band, items = 0.0, []
    else:
        band, items = _uncertainty(tree, est, settings, estimated)

    def rng(v: int) -> PriceRange:
        if measured:
            return PriceRange(low=v, high=v)
        step = _step(v, band)
        return PriceRange(low=_round(v * (1 - band), step), high=_round(v * (1 + band), step))

    names = [i.name for i in items[:UNC_TEXT_MAX]]
    names_uz = [i.name_uz for i in items[:UNC_TEXT_MAX]]
    return EstimateRange(
        exact=measured, low=est, high=est,
        total=rng(est.total_client), materials=rng(est.materials_client), work=rng(est.work),
        expected=est.total_client, band=round(band, 4), uncertainty=items,
        uncertainty_text=("оценка: " + ", ".join(names)) if names else "",
        uncertainty_text_uz=("taxminiy: " + ", ".join(names_uz)) if names_uz else "",
    )


# --- Смета для клиента: три вида (раздел 7 PRD) ---

ClientView = Literal["total", "short", "detailed"]

# Группы подробной сметы: ключ и названия на двух языках
GROUPS = {
    "Листы": ("sheets", "Листы ЛДСП и ХДФ", "LDSP va XDF listlari"),
    "Столешница": ("countertop", "Столешница", "Stol usti"),
    "Кромка": ("edge", "Кромка", "Kromka"),
    "Распил и кромкование": ("cutting", "Распил и кромкование", "Kesish va kromkalash"),
    "Фурнитура": ("hardware", "Фурнитура", "Furnitura"),
    "Система купе": ("sliding", "Система купе", "Kupe tizimi"),
    "Зеркало и стекло": ("glass", "Зеркало и стекло", "Ko‘zgu va shisha"),
    "Декор фасадов": ("decor", "Декор фасадов", "Fasad bezaklari"),
    "Подсветка": ("lighting", "Подсветка", "Yoritish"),
}
# Эти группы клиент видит построчно: «Фрезеровка «Шейкер», 4 фасада», «Подсветка под навесными, 2,4 м, 3000 K»
DETAILED_GROUPS = {"Декор фасадов", "Подсветка"}


def client_view(er: EstimateRange, view: ClientView, settings: PricingSettings | None = None) -> dict:
    """Только то, что можно показать клиенту: без себестоимости, наценки, поставщика и артикулов."""
    settings = settings or PricingSettings()

    def r(pr: PriceRange) -> dict:
        return {"from": pr.low, "to": pr.high}

    out: dict = {"view": view, "exact": er.exact, "total": r(er.total), "has_requests": er.low.has_requests,
                 "has_stale": er.low.has_stale,
                 # что именно оценено до замера: [{category, name, name_uz, reason, reason_uz}] и готовая строка
                 "uncertainty": [u.model_dump() for u in er.uncertainty],
                 "uncertainty_text": er.uncertainty_text, "uncertainty_text_uz": er.uncertainty_text_uz}
    if view in ("short", "detailed"):
        out["materials"] = r(er.materials)
        out["work"] = r(er.work)
    if view == "detailed":
        names: dict[str, str] = {}

        def client_by_group(est: Estimate) -> dict[str, int]:
            groups: dict[str, int] = defaultdict(int)
            for line in est.lines:
                if line.status != "request":
                    g = line.key if line.group in DETAILED_GROUPS else line.group
                    if line.group in DETAILED_GROUPS:
                        names.setdefault(g, line.client_name)
                    groups[g] += round(line.cost * (1 + settings.markup.get(line.category, 0) / 100))
            return groups

        out["groups"] = []
        for g, value in client_by_group(er.low).items():
            if g in names:  # строка декора/подсветки — своим названием
                key, ru, uz = g.split(":")[0] + ":" + g.split(":", 1)[1], names[g], names[g]
            else:
                key, ru, uz = GROUPS.get(g, (g, g, g))
            pr = er.band_range(value)  # та же полоса, что у итога
            out["groups"].append({"key": key, "name": ru, "name_uz": uz, "from": pr.low, "to": pr.high})
        out["requests"] = [
            {"name": line.client_name, "note": "уточняется"} for line in er.low.lines if line.status == "request"
        ]
        out["nonstandard"] = []  # позиции «нестандарт» — вне итога (появятся с заявками US-7)
    return out


def format_estimate(e: Estimate) -> str:
    def money(v: int) -> str:
        return f"{v:,}".replace(",", " ")

    lines = ["Смета (себестоимость):"]
    for line in e.lines:
        flag = "" if line.status == "catalog" else f"  [{ {'analog': 'аналог', 'request': 'под запрос'}.get(line.status, line.status) }]"
        lines.append(f"  {line.name:<42} {line.qty:>8g} {line.unit:<8} × {money(line.unit_price):>9} = {money(line.cost):>11}{flag}")
    for cat, cost in e.cost_by_category.items():
        lines.append(f"  {CATEGORY_NAMES[cat]}: {money(cost)}")
    lines.append(f"  Себестоимость: {money(e.cost_total)}")
    lines.append(f"  Материалы для клиента: {money(e.materials_client)} · работа мастера: {money(e.work)} · "
                 f"итог клиенту: {money(e.total_client)}")
    return "\n".join(lines)
