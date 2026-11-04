"""Списки для выбора декора фасадов, ручек и подсветки (docs/decor_contract.md).

Значения — те, что ядро принимает в дереве (`fronts.style`, `fronts.handles`, `lighting`). Превью — SVG-путь
рисунка на эталонной двери (viewBox 0 0 400 700, y вниз), его строит то же ядро, что и файлы для ЧПУ.
Цена-подсказка (`price_hint`) — себестоимость за единицу, видна только тем, кто видит себестоимость.
"""

import math

from fastapi import APIRouter

from ..deps import CurrentDep
from ..errors import ERROR_RESPONSES

router = APIRouter(prefix="/catalog", tags=["catalog"], responses=ERROR_RESPONSES)

PREVIEW_W, PREVIEW_H = 400, 700  # эталонная дверь, мм

MILLING = [
    ("shaker", "Шейкер (рамка)", "Sheyker (ramka)", "milling_frame"),
    ("classic", "Классика с филёнкой", "Klassika (filyonka)", "milling_frame"),
    ("arcs", "Арка", "Arka", "milling_figured"),
    ("rhombus", "Ромб", "Romb", "milling_figured"),
    ("grooves_v", "Рифление вертикальное", "Vertikal chiziqlar", "milling_grooves"),
    ("grooves_h", "Рифление горизонтальное", "Gorizontal chiziqlar", "milling_grooves"),
    ("waves", "Волны", "To‘lqinlar", "milling_figured"),
]
OVERLAY = [
    ("frame", "Молдинг-рамка", "Molding ramka"),
    ("arch", "Молдинг-арка", "Molding arka"),
    ("rhombus", "Молдинг-ромб", "Molding romb"),
    ("moulding", "Двойной молдинг", "Ikki qatorli molding"),
]
INLAY = [
    ("frame", "Металлическая рамка", "Metall ramka"),
    ("line_h", "Полоса поперёк", "Ko‘ndalang chiziq"),
    ("line_v", "Полоса вдоль", "Bo‘ylama chiziq"),
    ("edge", "Кант по краю", "Chet bo‘yicha kant"),
]
FINISHES = [("brass", "Латунь", "Latun"), ("gold", "Золото", "Oltin"), ("black", "Чёрный", "Qora"),
            ("chrome", "Хром", "Xrom"), ("steel", "Сталь", "Po‘lat")]
GLOSS = [("matte", "Матовая", "Mat"), ("satin", "Полуматовая", "Yarim mat"), ("gloss", "Глянцевая", "Yaltiroq")]
HANDLES = [("bar", "Скоба", "Skoba", "handle"), ("knob", "Кнопка (грибок)", "Tugma", "knob"),
           ("gola", "Профиль Gola", "Gola profili", "gola_profile"), ("none", "Без ручек (push)", "Tutqichsiz", None)]
LIGHT_ZONES = [
    ("under_wall", "Под навесными шкафами", "Osma shkaflar ostida", ["kitchen"]),
    ("niche", "В открытой нише", "Ochiq tokchada", ["wardrobe", "kitchen"]),
    ("shelf", "Под полками", "Javonlar ostida", ["wardrobe", "kitchen"]),
    ("wardrobe_rod", "Над штангой", "Shtanga ustida", ["wardrobe"]),
    ("plinth", "По цоколю", "Sokol bo‘ylab", ["wardrobe", "kitchen"]),
    ("inside_top", "Внутри, под крышей", "Ichida, tom ostida", ["wardrobe", "kitchen"]),
]
TEMPS = [(3000, "Тёплый", "Iliq"), (4000, "Нейтральный", "Neytral"), (6000, "Холодный", "Sovuq")]
SENSORS = [("none", "Без датчика", "Sensorsiz", None), ("door", "Датчик открывания двери", "Eshik sensori", "sensor_door"),
           ("motion", "Датчик движения", "Harakat sensori", "sensor_motion"),
           ("touch", "Сенсорный выключатель", "Sensorli o‘chirgich", "sensor_touch")]


def _svg(contour, closed: bool) -> str:
    """Путь ядра (мм, y вверх) → SVG d (y вниз)."""
    def pt(x, y):
        return f"{x / 10:g} {PREVIEW_H - y / 10:g}"

    d = [f"M{pt(contour.start_x, contour.start_y)}"]
    px, py = contour.start_x, contour.start_y
    for s in contour.segments:
        if s.kind == "arc":
            r = math.hypot(px - s.cx, py - s.cy) / 10
            a1, a2 = math.atan2(py - s.cy, px - s.cx), math.atan2(s.y - s.cy, s.x - s.cx)
            sweep = -((a1 - a2) % (2 * math.pi)) if s.clockwise else (a2 - a1) % (2 * math.pi)
            large = 1 if abs(sweep) > math.pi else 0
            # y зеркалится: против часовой у ядра → по часовой в SVG (sweep-flag 0)
            d.append(f"A{r:g} {r:g} 0 {large} {1 if s.clockwise else 0} {pt(s.x, s.y)}")
        else:
            d.append(f"L{pt(s.x, s.y)}")
        px, py = s.x, s.y
    if closed:
        d.append("Z")
    return " ".join(d)


def _previews(kind: str, value: str) -> list[str]:
    from mebel_core import decor
    from mebel_core.units import mm

    w, h = mm(PREVIEW_W), mm(PREVIEW_H)
    if kind == "milling":
        paths = decor.milling_paths(value, w, h, mm(60), mm(8), 0, mm(40))
    elif kind == "overlay":
        paths = decor.overlay_paths(value, w, h, mm(50), mm(20))
    else:
        paths = decor.inlay_paths(value, w, h, mm(40), mm(6), True)
    return [_svg(c, closed) for c, closed in paths]


def _price(item_id: str | None, sees_cost: bool) -> dict | None:
    from mebel_core.pricing import DECOR_PRICES, HARDWARE

    if not sees_cost or not item_id:
        return None
    item = DECOR_PRICES.get(item_id) or HARDWARE.get(item_id)
    return {"price": item.price, "unit": item.unit, "status": item.status} if item else None


@router.get("/front-styles", summary="Декор фасадов: фрезеровка, молдинг, вставки, покраска, ручки — с превью")
def front_styles(current: CurrentDep) -> dict:
    """`requires` — материал фасадов, без которого ядро вернёт ошибку (`mdf` — МДФ под покраску,
    id `paint_material`). `preview` — список SVG-путей (viewBox `0 0 400 700`); фрезеровка рисуется линией
    толщиной 8, молдинг — 20, вставка — 6. Поля дерева: `fronts.style.<kind>.pattern` (у вставки — `kind`)."""
    from mebel_core.decor import PAINT_MDF_ID

    see = current.sees_cost
    brass = lambda f: "inlay_brass" if f in ("brass", "gold") else "inlay_metal"  # noqa: E731
    return {
        "preview_viewbox": [0, 0, PREVIEW_W, PREVIEW_H],
        "paint_material": PAINT_MDF_ID,
        "milling": [{"id": v, "name": ru, "name_uz": uz, "requires": ["mdf"], "preview": _previews("milling", v),
                     "defaults": {"inset": 60, "width": 8, "depth": 3, "pitch": 40}, "price_hint": _price(pid, see)}
                    for v, ru, uz, pid in MILLING],
        "overlay": [{"id": v, "name": ru, "name_uz": uz, "requires": [], "preview": _previews("overlay", v),
                     "profiles": ["flat_20", "round_25"], "price_hint": _price("overlay_profile", see)}
                    for v, ru, uz in OVERLAY],
        "inlay": [{"id": v, "name": ru, "name_uz": uz, "requires": [] if v == "edge" else ["mdf"],
                   "preview": _previews("inlay", v), "finishes": [f for f, *_ in FINISHES if f != "steel"],
                   "price_hint": {f: _price(brass(f), see) for f, *_ in FINISHES if f != "steel"} if see else None}
                  for v, ru, uz in INLAY],
        "paint": {"requires": ["mdf"], "systems": ["RAL", "NCS", "custom"],
                  "gloss": [{"id": g, "name": ru, "name_uz": uz, "price_hint": _price(f"paint_{g}", see)}
                            for g, ru, uz in GLOSS],
                  "back_factor": 0.5},
        "finishes": [{"id": f, "name": ru, "name_uz": uz} for f, ru, uz in FINISHES],
        "handles": [{"id": v, "name": ru, "name_uz": uz, "price_hint": _price(pid, see)} for v, ru, uz, pid in HANDLES],
        "corners": {"max_radius": 200, "edge_min_radius": 30},
    }


@router.get("/lighting-zones", summary="Подсветка: зоны, температура света, датчики")
def lighting_zones(current: CurrentDep) -> dict:
    """Поле дерева — `lighting[]`: {zone, target ("all" | "sections[i]" | "wall[i]"), temp, sensor, mount}.
    Блок питания ядро подбирает само (один на изделие, по длине лент)."""
    see = current.sees_cost
    return {
        "zones": [{"id": z, "name": ru, "name_uz": uz, "products": products} for z, ru, uz, products in LIGHT_ZONES],
        "temps": [{"value": t, "name": ru, "name_uz": uz} for t, ru, uz in TEMPS],
        "sensors": [{"id": s, "name": ru, "name_uz": uz, "price_hint": _price(pid, see)} for s, ru, uz, pid in SENSORS],
        "mounts": [{"id": "groove", "name": "В паз (заподлицо)", "name_uz": "Ariqchaga"},
                   {"id": "surface", "name": "Накладной", "name_uz": "Ustki"}],
        "price_hint": {"profile": _price("led_profile", see), "strip": _price("led_strip", see)} if see else None,
    }


@router.get("/builtin-options", summary="Встроенная мебель: доборы, фальш-панели, цоколь, задняя стенка — варианты и "
                                        "значения по умолчанию")
def builtin_options(current: CurrentDep) -> dict:
    """Поля дерева: шкаф — `builtin` (ниша, доборы), `side_panels`, `body.plinth` (`legs`, `floor_allowance`),
    `body.back.kind`; кухня — `side_panels` (с `row`, `run`), `plinth` (`grilles`, `sides`), `top_filler`,
    модули `{"kind": "fridge"}` и `{"kind": "appliance", "dw": true}`. Замер ниши — `POST /projects/{id}/measurements`
    с полем `niche`. `limits` — пороги правил (мм), по ним ядро выдаёт предупреждения с готовыми исправлениями."""
    from mebel_core import DEFAULT_RULES as r
    from mebel_core.room import FLOOR_MATERIALS
    from mebel_core.schema import Builtin, KitchenPlinth
    from mebel_core.units import to_mm

    see = current.sees_cost
    b, kp = Builtin(), KitchenPlinth()
    return {
        "fillers": {
            "sides": [{"id": "left", "name": "Слева", "name_uz": "Chapda"},
                      {"id": "right", "name": "Справа", "name_uz": "O‘ngda"},
                      {"id": "top", "name": "До потолка", "name_uz": "Shiftgacha"}],
            "positions": [{"id": "flush", "name": "Заподлицо с фасадами", "name_uz": "Fasad bilan bir tekisda"},
                          {"id": "setback", "name": "Утоплен", "name_uz": "Ichkariga botirilgan"}],
            "mounts": [{"id": "strip", "name": "На планке крепления", "name_uz": "Mahkamlash planka"},
                       {"id": "screws", "name": "Уголками и саморезами", "name_uz": "Burchak va shuruplar"}],
            "materials": [{"id": None, "name": "Как фасады", "name_uz": "Fasadlar kabi"},
                          {"id": "body", "name": "Как корпус (id материала корпуса)", "name_uz": "Korpus kabi"}],
            "defaults": {"filler_width": b.filler_width, "top_filler_width": b.top_filler_width,
                         "allowance_side": b.allowance_side, "allowance_top": b.allowance_top, "scribe": b.scribe,
                         "filler_setback": b.filler_setback},
        },
        "wedge": {"field": "builtin.wedge", "name": "Добор клином", "name_uz": "Ponasimon qo‘shimcha",
                  "hint": "Кромка к стене режется по замеру (трапеция) — для заваленной стены",
                  "price_hint": _price_service("wedge_cut", see)},
        "niche_fields": ["width_top", "width_middle", "width_bottom", "height_left", "height_right", "depth",
                         "lean"],
        "niche_lean": [{"id": None, "name": "Не знаю — поровну", "name_uz": "Bilmayman — teng"},
                       {"id": "left", "name": "Завалена левая стена", "name_uz": "Chap devor qiyshiq"},
                       {"id": "right", "name": "Завалена правая стена", "name_uz": "O‘ng devor qiyshiq"}],
        "room": {"view_only": True, "walls_visible": True,
                 "floor_materials": [{"id": k, "name": m["name"], "name_uz": m["name_uz"], "color": m["color"],
                                      "texture": m["texture"], "seam": m["seam"], "step_mm": m["step_mm"]}
                                     for k, m in FLOOR_MATERIALS.items()]},
        "side_panels": {"sides": ["left", "right"], "kitchen_rows": [
            {"id": "base", "name": "У нижних (до пола)", "name_uz": "Pastki (polgacha)"},
            {"id": "wall", "name": "У верхних", "name_uz": "Yuqori"},
            {"id": "both", "name": "Нижняя и верхняя", "name_uz": "Ikkalasi"}]},
        "plinth": {
            "wardrobe": {"legs": True, "floor_allowance": 5},
            "kitchen": {"setback": kp.setback, "floor_allowance": kp.floor_allowance, "sides": ["auto", "none"],
                        "grilles": [{"id": "sink", "name": "Под мойкой", "name_uz": "Rakovina ostida"},
                                    {"id": "oven", "name": "Под духовкой", "name_uz": "Duxovka ostida"}]},
        },
        "back": [{"id": "nailed", "name": "ХДФ на гвоздях", "name_uz": "XDF mixlangan"},
                 {"id": "none", "name": "Без задней стенки (к ровной стене)", "name_uz": "Orqa devorsiz"}],
        "kitchen_modules": [{"kind": "fridge", "name": "Ниша холодильника с панелью", "name_uz": "Muzlatgich joyi",
                             "defaults": {"width": 600, "fridge_height": 1850, "top_panel": True}},
                            {"kind": "appliance", "dw": True, "name": "Посудомойка с фасадом",
                             "name_uz": "Idish yuvish mashinasi fasadi", "widths": [450, 600]}],
        "limits": {"filler_min": to_mm(r.filler_min), "filler_max": to_mm(r.filler_max),
                   "plumb_tolerance": to_mm(r.plumb_tolerance), "door_clearance": to_mm(r.filler_door_clearance),
                   "top_panel_max": to_mm(r.top_panel_max)},
        "price_hint": {k: _price(k, see) for k in ("wall_anchor", "bracket", "vent_grille", "dw_front_kit", "leg",
                                                   "plinth_clip")} if see else None,
    }


def _price_service(item_id: str, sees_cost: bool) -> dict | None:
    from mebel_core.pricing import SERVICES

    item = SERVICES.get(item_id) if sees_cost else None
    return {"price": item.price, "unit": item.unit, "status": item.status} if item else None
