"""Демо-прайс поставщика (суммы — целые сумы).

Листы, распил и кромкование — по публичным ценам eman.uz на 02.11.2026
(docs/eman_research.md): ориентир, не договорные цены. Фурнитура — выдумана.
До договора с EMAN и парсера прайса эти цены не должны попадать к мастерам.
"""

from typing import Literal

from pydantic import BaseModel, Field

from .decors import STD_SHEET_M2, load_decors

PRICE_SOURCE = "demo (ориентир: eman.uz, 02.11.2026)"
PRICE_DATE = "2026-11-02"

Category = Literal["body", "fronts", "hardware", "services"]


class PriceItem(BaseModel):
    id: str
    name: str
    unit: str  # лист, м, шт, м², пара, комплект
    price: int  # сум за единицу
    status: Literal["catalog", "analog", "request"] = "catalog"


# Листы 2800×2070 (5,796 м²); ближайшие по цене позиции EMAN указаны в комментариях
SHEETS: dict[str, PriceItem] = {
    i.id: i
    for i in [
        PriceItem(id="ldsp_16_white", name="ЛДСП 16 Белый 2800×2070", unit="лист", price=524_600),  # Ultradecor 5,796
        PriceItem(id="ldsp_16_grey", name="ЛДСП 16 Серый 2800×2070", unit="лист", price=683_200),  # Egger U755
        PriceItem(id="ldsp_16_oak", name="ЛДСП 16 Дуб сонома 2800×2070", unit="лист", price=719_800),  # Egger H3395
        PriceItem(id="ldsp_16_wenge", name="ЛДСП 16 Венге 2800×2070", unit="лист", price=683_200, status="analog"),
        PriceItem(id="ldsp_18_wenge", name="ЛДСП 18 Венге 2800×2070", unit="лист", price=1_000_000, status="analog"),
        PriceItem(id="ldsp_18_white", name="ЛДСП 18 Белый 2800×2070", unit="лист", price=976_000),  # Egger W1000
        PriceItem(id="ldsp_18_oak", name="ЛДСП 18 Дуб сонома 2800×2070", unit="лист", price=1_073_600),  # Egger H3325
        PriceItem(id="ldsp_10_white", name="ЛДСП 10 Белый 2800×2070", unit="лист", price=573_400, status="analog"),  # 8 мм
        PriceItem(id="ldsp_10_oak", name="ЛДСП 10 Дуб сонома 2800×2070", unit="лист", price=600_000, status="analog"),
        # МДФ под покраску — цены сырого МДФ EMAN (Egger MB / Кроностар, 2800×2070); покраска — DECOR_PRICES ниже
        PriceItem(id="mdf_22_paint", name="МДФ 22 под покраску 2800×2070", unit="лист", price=854_000),
        PriceItem(id="mdf_19_paint", name="МДФ 19 под покраску 2800×2070", unit="лист", price=707_600),
        PriceItem(id="mdf_16_paint", name="МДФ 16 под покраску 2800×2070", unit="лист", price=634_400),
        PriceItem(id="hdf_3_white", name="ХДФ 3 Белый 2800×2070", unit="лист", price=165_000, status="request"),
    ]
}

# Кромкование с кромкой, за метр (у EMAN услуга названа по типу кромки и, похоже, включает её)
EDGES: dict[str, PriceItem] = {
    i.id: i
    for i in [
        PriceItem(id="pvc_04", name="Кромкование ПВХ 0,4 мм (с кромкой)", unit="м", price=3_500, status="analog"),
        PriceItem(id="pvc_1", name="Кромкование ПВХ 1 мм (с кромкой)", unit="м", price=4_800),  # HUALI 21/1
        PriceItem(id="pvc_2", name="Кромкование ПВХ 2 мм (с кромкой)", unit="м", price=6_000),  # HUALI 21/2
    ]
}
EDGING_INCLUDES_TAPE = True  # если false — кромка и кромкование считаются отдельно

SERVICES: dict[str, PriceItem] = {
    i.id: i
    for i in [
        PriceItem(id="cut", name="Распил ЛДСП (пакетный)", unit="лист", price=50_000),
        PriceItem(id="cut_hdf", name="Распил ХДФ (двухпильный)", unit="лист", price=18_000),
        PriceItem(id="edging", name="Кромкование", unit="м", price=3_500),
        PriceItem(id="countertop_cutout", name="Вырез в столешнице под мойку", unit="шт", price=80_000,
                  status="analog"),
        # Встроенная мебель: косой рез добора клином по замеру — заглушка, подтвердить у EMAN
        PriceItem(id="wedge_cut", name="Косой рез добора (клин по замеру)", unit="шт", price=15_000,
                  status="analog"),
    ]
}

# Фурнитура: по виду (kind) из модели; для длинномеров — цена за метр
HARDWARE: dict[str, PriceItem] = {
    i.id: i
    for i in [
        PriceItem(id="confirmat", name="Конфирмат 7×50", unit="шт", price=250),
        PriceItem(id="shelf_pin", name="Полкодержатель", unit="шт", price=400),
        PriceItem(id="nail", name="Гвоздь для ХДФ 1,6×25", unit="шт", price=30),
        PriceItem(id="screw", name="Саморез", unit="шт", price=80),
        PriceItem(id="hinge", name="Петля 110° с доводчиком", unit="шт", price=24_000),
        PriceItem(id="handle", name="Ручка-скоба", unit="шт", price=18_000),
        PriceItem(id="rod", name="Штанга овальная хром", unit="м", price=32_000),
        PriceItem(id="rod_holder", name="Штангодержатель", unit="шт", price=4_500),
        PriceItem(id="slide", name="Направляющие шариковые (пара)", unit="пара", price=0),  # цена — по длине ниже
        PriceItem(id="profile", name="Профиль купе", unit="м", price=48_000, status="analog"),
        PriceItem(id="rail", name="Рельс купе", unit="м", price=42_000, status="analog"),
        PriceItem(id="rollers", name="Ролики купе (комплект)", unit="комплект", price=95_000, status="analog"),
        PriceItem(id="glass", name="Зеркало 4 мм серебро", unit="м²", price=210_000),
        PriceItem(id="leg", name="Ножка кухонная регулируемая", unit="шт", price=6_000),
        PriceItem(id="plinth_clip", name="Клипса цоколя", unit="шт", price=1_500),
        PriceItem(id="hanger", name="Навес мебельный регулируемый", unit="шт", price=9_000),
        PriceItem(id="mount_rail", name="Шина монтажная", unit="м", price=28_000),
        PriceItem(id="countertop_joint", name="Планка соединения столешницы", unit="шт", price=35_000),
        # Угловой модуль кухни (SCR-37b): цены — ориентир по рынку Ташкента, не прайс поставщика
        PriceItem(id="corner_carousel", name="Карусель 3/4 для углового модуля", unit="шт", price=360_000,
                  status="analog"),
        PriceItem(id="corner_swing", name="Поворотная полка для углового модуля", unit="шт", price=215_000,
                  status="analog"),
        PriceItem(id="corner_bracket", name="Стяжка частей углового модуля", unit="шт", price=2_000),
        # --- Встроенная мебель: ЗАГЛУШКИ ЦЕН (аналоги по рынку Ташкента, 04.11.2026) ---
        # Подтвердить у EMAN и поменять здесь. Доборы и фальш-панели — листы и кромка, считаются по раскрою.
        PriceItem(id="wall_anchor", name="Дюбель-саморез 8×80 + уголок (крепление к стене)", unit="шт",
                  price=4_500, status="analog"),
        PriceItem(id="bracket", name="Уголок мебельный", unit="шт", price=1_200, status="analog"),
        PriceItem(id="vent_grille", name="Решётка вентиляционная цокольная", unit="шт", price=45_000,
                  status="analog"),
        PriceItem(id="dw_front_kit", name="Крепёж фасада посудомойки (комплект)", unit="комплект", price=25_000,
                  status="analog"),
    ]
}

# Шариковые направляющие: длина, мм → цена пары
SLIDE_PRICES = {250: 32_000, 300: 35_000, 350: 38_000, 400: 41_000, 450: 44_000, 500: 47_000, 550: 51_000,
                600: 55_000}

# Столешницы: цена за погонный метр (плита 600 мм)
COUNTERTOPS: dict[str, PriceItem] = {
    i.id: i
    for i in [
        PriceItem(id="countertop_38_oak", name="Столешница 38 мм Дуб", unit="м", price=290_000),
        PriceItem(id="countertop_38_stone", name="Столешница 38 мм Камень серый", unit="м", price=320_000),
    ]
}


# --- Декор фасадов, подсветка, кнопки и Gola: ЗАГЛУШКИ ЦЕН ---
# Решение владельца (04.11.2026): не «под запрос», а ориентир по рынку Ташкента со статусом analog —
# подтвердить у EMAN или партнёра-покрасочного цеха и поменять здесь. Ключи читает estimate._decor_lines.
DECOR_PRICES: dict[str, PriceItem] = {
    i.id: i
    for i in [
        # Покраска МДФ за м² одной стороны; обратная сторона — paint_back_factor от лицевой
        PriceItem(id="paint_matte", name="Покраска МДФ матовая", unit="м²", price=220_000, status="analog"),
        PriceItem(id="paint_satin", name="Покраска МДФ полуматовая", unit="м²", price=260_000, status="analog"),
        PriceItem(id="paint_gloss", name="Покраска МДФ глянцевая", unit="м²", price=380_000, status="analog"),
        # Фрезеровка: рамочные рисунки — за фасад, рифление — за м² фасада
        PriceItem(id="milling_frame", name="Фрезеровка рамки (шейкер, классика)", unit="фасад", price=90_000,
                  status="analog"),
        PriceItem(id="milling_figured", name="Фрезеровка фигурная (арка, ромб, волны)", unit="фасад", price=130_000,
                  status="analog"),
        PriceItem(id="milling_grooves", name="Фрезеровка рифление", unit="м²", price=140_000, status="analog"),
        # Накладной декор (молдинг): профиль за п. м + установка за фасад
        PriceItem(id="overlay_profile", name="Молдинг накладной", unit="м", price=55_000, status="analog"),
        PriceItem(id="overlay_install", name="Установка молдинга", unit="фасад", price=15_000, status="analog"),
        # Металлические вставки и канты: профиль за п. м + работа за фасад
        PriceItem(id="inlay_brass", name="Профиль латунь/золото (вставка, кант)", unit="м", price=85_000,
                  status="analog"),
        PriceItem(id="inlay_metal", name="Профиль чёрный/хром (вставка, кант)", unit="м", price=60_000,
                  status="analog"),
        PriceItem(id="inlay_labour", name="Установка металлической вставки", unit="фасад", price=20_000,
                  status="analog"),
        # Подсветка
        PriceItem(id="led_profile", name="Профиль алюминиевый с рассеивателем", unit="м", price=65_000,
                  status="analog"),
        PriceItem(id="led_strip", name="Светодиодная лента", unit="м", price=35_000, status="analog"),
        PriceItem(id="power_60", name="Блок питания 60 Вт", unit="шт", price=140_000, status="analog"),
        PriceItem(id="power_100", name="Блок питания 100 Вт", unit="шт", price=190_000, status="analog"),
        PriceItem(id="power_150", name="Блок питания 150 Вт", unit="шт", price=250_000, status="analog"),
        PriceItem(id="sensor_door", name="Датчик открывания двери", unit="шт", price=75_000, status="analog"),
        PriceItem(id="sensor_motion", name="Датчик движения", unit="шт", price=75_000, status="analog"),
        PriceItem(id="sensor_touch", name="Сенсорный выключатель", unit="шт", price=60_000, status="analog"),
        # Ручки-кнопки и Gola
        PriceItem(id="knob", name="Ручка-кнопка", unit="шт", price=25_000, status="analog"),
        PriceItem(id="knob_brass", name="Ручка-кнопка латунь/золото", unit="шт", price=45_000, status="analog"),
        PriceItem(id="gola_profile", name="Профиль Gola", unit="м", price=160_000, status="analog"),
        PriceItem(id="gola_fittings", name="Заглушки и крепёж Gola", unit="фасад", price=30_000, status="analog"),
    ]
}
PAINT_BACK_FACTOR = 0.5  # обратная сторона фасада — 50 % цены лицевой


# Фурнитура по типу и классу — множители к базовой цене (демо; заменятся ценами каталога по позициям)
HARDWARE_CLASS_FACTOR = {"econom": 0.6, "standard": 1.0, "premium": 2.2}
HINGE_TYPE_FACTOR = {"standard": 0.7, "soft_close": 1.0, "push": 1.3}
SLIDE_TYPE_FACTOR = {"ball": 1.0, "hidden_full": 2.4, "hidden_soft": 3.0}
HANDLE_FINISH_FACTOR = {"steel": 1.0, "chrome": 1.1, "black": 1.2, "brass": 2.0, "gold": 2.2}  # ручки-скобы


class PriceBook(BaseModel):
    """Прайс, по которому считается смета. API собирает его из опубликованного каталога;
    по умолчанию — демо-прайс выше. У позиции может быть своя дата цены (price_dates)."""

    source: str = PRICE_SOURCE
    date: str = PRICE_DATE
    sheets: dict[str, PriceItem] = Field(default_factory=dict)
    edges: dict[str, PriceItem] = Field(default_factory=dict)
    services: dict[str, PriceItem] = Field(default_factory=dict)
    hardware: dict[str, PriceItem] = Field(default_factory=dict)
    countertops: dict[str, PriceItem] = Field(default_factory=dict)
    slides: dict[int, int] = Field(default_factory=dict)  # длина направляющих, мм → цена пары
    edging_includes_tape: bool = True
    price_dates: dict[str, str] = Field(default_factory=dict)  # id позиции → дата цены (YYYY-MM-DD)
    class_factor: dict[str, float] = Field(default_factory=lambda: dict(HARDWARE_CLASS_FACTOR))
    hinge_factor: dict[str, float] = Field(default_factory=lambda: dict(HINGE_TYPE_FACTOR))
    slide_factor: dict[str, float] = Field(default_factory=lambda: dict(SLIDE_TYPE_FACTOR))
    handle_finish_factor: dict[str, float] = Field(default_factory=lambda: dict(HANDLE_FINISH_FACTOR))
    # Декор и подсветка: по умолчанию — заглушки выше (прайс каталога может переопределить позиции)
    decor: dict[str, PriceItem] = Field(default_factory=lambda: dict(DECOR_PRICES))
    paint_back_factor: float = PAINT_BACK_FACTOR

    def date_of(self, item_id: str) -> str:
        return self.price_dates.get(item_id, self.date)


# --- Цены декоров EMAN (data/eman_decors.json), статус catalog ---
# Лист другого формата (например, 2800×1220) пересчитывается на стандартный 2800×2070 по цене за м²:
# раскрой считает листы 2800×2070, смета должна совпасть по площади.
def _decor_prices() -> tuple[dict[str, PriceItem], dict[str, PriceItem], dict[str, str]]:
    sheets: dict[str, PriceItem] = {}
    tops: dict[str, PriceItem] = {}
    dates: dict[str, str] = {}
    for d in load_decors():
        price = d.get("price")
        if not price or d["kind"] in ("edge", "hpl"):
            continue
        if d["kind"] == "countertop":
            if d.get("price_per_m"):
                tops[d["id"]] = PriceItem(id=d["id"], name=d["name"], unit="м", price=int(d["price_per_m"]))
            continue
        sheet = d.get("sheet_mm") or [2800, 2070]
        if tuple(sheet) != (2800, 2070):
            price = round(price / (sheet[0] * sheet[1] / 1e6) * STD_SHEET_M2 / 100) * 100
        sheets[d["id"]] = PriceItem(id=d["id"], name=f'{d["name"]} 2800×2070', unit="лист", price=int(price))
        if d.get("fetched_at"):
            dates[d["id"]] = d["fetched_at"][:10]
    return sheets, tops, dates


_DECOR_SHEETS, _DECOR_TOPS, _DECOR_DATES = _decor_prices()
SHEETS.update({k: v for k, v in _DECOR_SHEETS.items() if k not in SHEETS})
COUNTERTOPS.update({k: v for k, v in _DECOR_TOPS.items() if k not in COUNTERTOPS})

DEMO_PRICES = PriceBook(
    sheets=SHEETS, edges=EDGES, services=SERVICES, hardware=HARDWARE, countertops=COUNTERTOPS,
    slides=SLIDE_PRICES, edging_includes_tape=EDGING_INCLUDES_TAPE, price_dates=_DECOR_DATES,
)
