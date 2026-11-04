"""Фурнитура: варианты замены с разницей в цене (FR-46, экран SCR-26).

Для каждого вида (петли, направляющие, ручки) — варианты того же вида по типу
и классу. У варианта: разница в цене для клиента, готовый JSON Patch к дереву
и признак совместимости (несовместимое не предлагается к применению).
"""

from typing import Literal, Optional

from pydantic import BaseModel

from .assembler import build
from .estimate import PricingSettings, estimate
from .fixes import apply_patch
from .nesting import nest
from .parts import PatchOp
from .pricing import PriceBook

CLASS_LABELS = {"econom": "Эконом", "standard": "Стандарт", "premium": "Премиум"}

GROUPS = [
    ("hinge", "Петли", "/hardware/hinge",
     {"standard": "Без доводчика", "soft_close": "С доводчиком", "push": "Push-to-open (без ручек)"}),
    ("hinge_class", "Класс петель", "/hardware/hinge_class", CLASS_LABELS),
    ("slides", "Направляющие ящиков", "/hardware/slides",
     {"ball": "Шариковые", "hidden_full": "Скрытые полного выдвижения", "hidden_soft": "Скрытые с доводчиком"}),
    ("slides_class", "Класс направляющих", "/hardware/slides_class", CLASS_LABELS),
    ("handles", "Ручки", "/fronts/handles",
     {"bar_128": "Скоба 128 мм", "bar_160": "Скоба 160 мм", "bar_192": "Скоба 192 мм", "knob": "Кнопка (грибок)",
      "gola": "Профиль Gola (без ручек)", "none": "Без ручек"}),
    ("handle_finish", "Отделка ручек", "/fronts/handles/finish",
     {"steel": "Сталь", "black": "Чёрный матовый", "chrome": "Хром", "brass": "Латунь", "gold": "Золото"}),
    ("lighting", "Подсветка", "/lighting", {}),  # варианты — по типу изделия (LIGHTING_OPTIONS)
]

# Подсветка одним вариантом на изделие: зона для всех секций/модулей; «Своя» — если в дереве несколько зон
LIGHTING_OPTIONS = {
    "kitchen": {"none": "Без подсветки", "under_wall": "Под навесными шкафами", "plinth": "По цоколю"},
    "wardrobe": {"none": "Без подсветки", "niche": "В открытых нишах", "inside_top": "Внутри секций, под крышей",
                 "wardrobe_rod": "Над штангой"},
}


# Наполнение углового модуля кухни (SCR-37b, вкладка «Угол»)
CORNER_FILLS = {"carousel": "Карусель", "swing": "Поворотная полка", "blind": "Глухой угол (полка)"}


def _corner_group(tree: dict) -> tuple[str, str, str] | None:
    """Угловой модуль кухни: (JSON Pointer поля corner_fill, текущее значение, заголовок) или None."""
    if tree.get("type") != "kitchen":
        return None
    for row in ("base", "base2"):
        for i, cab in enumerate(tree.get(row, [])):
            if cab.get("kind") == "corner":
                w = f"{cab['width']:g}"
                size = f"{w}×{w}" if cab.get("corner_shape") == "square" else w
                return f"/{row}/{i}/corner_fill", cab.get("corner_fill", "blind"), f"Угловой модуль {size} мм"
    return None


class HardwareOption(BaseModel):
    value: str
    label: str
    current: bool
    delta: Optional[int]  # разница в цене для клиента, сум; None — вариант не собирается
    patch: list[PatchOp]
    available: bool
    note: str = ""


class HardwareGroup(BaseModel):
    key: str
    title: str
    options: list[HardwareOption]


def _current(tree: dict, key: str) -> str:
    hw = tree.get("hardware", {})
    defaults = {"hinge": "soft_close", "hinge_class": "standard", "slides": "ball", "slides_class": "standard"}
    if key == "handles":
        h = tree.get("fronts", {}).get("handles", {})
        kind, spacing = h.get("kind", "bar"), h.get("spacing", 128)
        return f"bar_{spacing}" if kind == "bar" else kind
    if key == "handle_finish":
        return tree.get("fronts", {}).get("handles", {}).get("finish", "steel")
    if key == "lighting":
        lights = tree.get("lighting") or []
        if not lights:
            return "none"
        return lights[0]["zone"] if len(lights) == 1 and lights[0].get("target", "all") == "all" else "custom"
    return hw.get(key, defaults[key])


def _patch(key: str, path: str, value: str, tree: dict | None = None) -> list[PatchOp]:
    if key == "handles":
        cur = (tree or {}).get("fronts", {}).get("handles", {})
        v = {"kind": value, "spacing": cur.get("spacing", 128)} if not value.startswith("bar_") else \
            {"kind": "bar", "spacing": int(value[4:])}
        v["finish"] = cur.get("finish", "steel")
        return [PatchOp(op="replace", path=path, value=v)]
    if key == "handle_finish":
        return [PatchOp(op="add", path=path, value=value)]
    if key == "lighting":
        old = ((tree or {}).get("lighting") or [{}])[0]
        v = [] if value == "none" else [{"zone": value, "target": "all", "temp": old.get("temp", 4000),
                                         "sensor": old.get("sensor", "none")}]
        return [PatchOp(op="add", path=path, value=v)]
    if key == "corner_fill":  # поля может не быть в дереве (по умолчанию — глухой угол)
        return [PatchOp(op="add", path=path, value=value)]
    return [PatchOp(op="replace", path=path, value=value)]


def hardware_options(tree: dict, settings: PricingSettings | None = None,
                     prices: PriceBook | None = None) -> list[HardwareGroup]:
    base_result = build(tree)
    roles = {h.kind for h in base_result.hardware}
    nesting = nest(base_result)
    base_total = estimate(base_result, settings, nesting=nesting, prices=prices).total_client
    t = dict(tree)
    t.setdefault("hardware", {})
    t.setdefault("fronts", {}).setdefault("handles", {"kind": "bar", "spacing": 128})

    groups: list[HardwareGroup] = []
    corner = _corner_group(t)
    groups_spec = list(GROUPS)
    if corner:
        groups_spec.insert(0, ("corner_fill", corner[2], corner[0], CORNER_FILLS))
    for key, title, path, labels in groups_spec:
        if key.startswith("hinge") and "hinge" not in roles:
            continue
        if key.startswith("slides") and "slide" not in roles:
            continue
        has_fronts = any(p.role in ("door", "drawer_front") for p in base_result.parts)
        if key in ("handles", "handle_finish") and not has_fronts:
            continue
        if key == "handle_finish" and _current(t, "handles") == "none":
            continue
        current = corner[1] if key == "corner_fill" else _current(t, key)
        if key == "lighting":
            labels = dict(LIGHTING_OPTIONS["kitchen" if t.get("type") == "kitchen" else "wardrobe"])
            if current == "custom":
                labels = {"custom": "Своя подсветка (несколько зон)", **labels}
        options = []
        for value, label in labels.items():
            patch = _patch(key, path, value, t)
            if value == current:
                options.append(HardwareOption(value=value, label=label, current=True, delta=0, patch=patch,
                                              available=True))
                continue
            variant = build(apply_patch(t, patch))
            errors = [i for i in variant.issues if i.level == "error"]
            if errors:
                options.append(HardwareOption(value=value, label=label, current=False, delta=None, patch=patch,
                                              available=False, note=errors[0].message))
                continue
            no_place = next((i.message for i in variant.issues if i.code == "light_no_place"), None)
            if no_place:
                options.append(HardwareOption(value=value, label=label, current=False, delta=None, patch=patch,
                                              available=False, note=no_place))
                continue
            # Другие направляющие меняют ширину ящиков — раскрой пересчитываем; остальное его не трогает
            n = nest(variant) if key == "slides" else nesting
            delta = estimate(variant, settings, nesting=n, prices=prices).total_client - base_total
            warn = next((i.message for i in variant.issues if i.code in ("push_with_handles", "light_no_place")), "")
            options.append(HardwareOption(value=value, label=label, current=False, delta=delta, patch=patch,
                                          available=True, note=warn))
        groups.append(HardwareGroup(key=key, title=title, options=options))
    return groups


__all__ = ["hardware_options", "HardwareGroup", "HardwareOption", "Literal"]
