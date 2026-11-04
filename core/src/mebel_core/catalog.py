"""Демо-каталог материалов и кромки.

Временный: до парсера прайса EMAN (неделя 7) ядру нужны толщины,
наличие текстуры и толщины кромки. Цены здесь не хранятся.
"""

from pydantic import BaseModel

from .decors import load_decors
from .units import mm


class Material(BaseModel):
    id: str
    name: str
    kind: str  # ldsp, mdf, hdf
    thickness: int  # dmm
    has_grain: bool  # есть ли направление текстуры (дерево, камень, линии)
    color: str = "#dddddd"  # основной цвет для 3D, пока нет текстур
    finish: str = ""  # тип отделки для 3D: matte, gloss, softtouch, veneer, acrylic, mirror, metal (пусто — по виду)
    texture: str | None = None  # URL скана декора
    texture_size_mm: tuple[int, int] = (1000, 1000)  # сколько мм приходится на одну плитку текстуры
    brand: str = ""  # бренд декора (Egger, Ultradecor…); пусто у демо-материалов
    code: str = ""  # код декора у производителя (H1145 ST10)
    sheet_mm: tuple[int, int] | None = None  # формат листа поставщика, если не 2800×2070

    @property
    def finish_type(self) -> str:
        if self.finish:
            return self.finish
        return {"glass": "mirror", "metal": "metal", "countertop": "gloss", "hpl": "matte"}.get(self.kind, "matte")

    @property
    def is_sheet(self) -> bool:
        """Листовой материал: идёт в раскрой и спецификацию деталей."""
        return self.kind in ("ldsp", "mdf", "hdf")


class EdgeType(BaseModel):
    id: str
    name: str
    thickness: int  # dmm
    code: str  # короткое обозначение для спецификации


MATERIALS: dict[str, Material] = {
    m.id: m
    for m in [
        Material(id="ldsp_16_white", name="ЛДСП 16 Белый", kind="ldsp", thickness=mm(16), has_grain=False, color="#f2f0eb"),
        Material(id="ldsp_16_grey", name="ЛДСП 16 Серый", kind="ldsp", thickness=mm(16), has_grain=False, color="#9b9b97"),
        Material(id="ldsp_16_oak", name="ЛДСП 16 Дуб сонома", kind="ldsp", thickness=mm(16), has_grain=True, color="#c9a57b"),
        Material(id="ldsp_16_wenge", name="ЛДСП 16 Венге", kind="ldsp", thickness=mm(16), has_grain=True, color="#3d2b22"),
        Material(id="ldsp_18_wenge", name="ЛДСП 18 Венге", kind="ldsp", thickness=mm(18), has_grain=True, color="#3d2b22"),
        Material(id="ldsp_18_white", name="ЛДСП 18 Белый", kind="ldsp", thickness=mm(18), has_grain=False, color="#f2f0eb"),
        Material(id="ldsp_18_oak", name="ЛДСП 18 Дуб сонома", kind="ldsp", thickness=mm(18), has_grain=True, color="#c9a57b"),
        Material(id="ldsp_10_white", name="ЛДСП 10 Белый", kind="ldsp", thickness=mm(10), has_grain=False, color="#f2f0eb"),
        Material(id="ldsp_10_oak", name="ЛДСП 10 Дуб сонома", kind="ldsp", thickness=mm(10), has_grain=True, color="#c9a57b"),
        Material(id="mirror_4_silver", name="Зеркало 4 мм серебро", kind="glass", thickness=mm(4), has_grain=False, color="#dfe6ea"),
        Material(id="countertop_38_oak", name="Столешница 38 мм Дуб", kind="countertop", thickness=mm(38), has_grain=True, color="#b98f62"),
        Material(id="countertop_38_stone", name="Столешница 38 мм Камень серый", kind="countertop", thickness=mm(38), has_grain=False, color="#8f8f8b"),
        Material(id="rod_oval_chrome", name="Штанга овальная хром", kind="metal", thickness=mm(15), has_grain=False, color="#c3c7cc"),
        # МДФ под покраску — для фрезеровки и покраски фасадов (декор, docs/decor_contract.md)
        Material(id="mdf_19_paint", name="МДФ 19 под покраску", kind="mdf", thickness=mm(19), has_grain=False, color="#e9e6df"),
        Material(id="mdf_16_paint", name="МДФ 16 под покраску", kind="mdf", thickness=mm(16), has_grain=False, color="#e9e6df"),
        Material(id="mdf_22_paint", name="МДФ 22 под покраску", kind="mdf", thickness=mm(22), has_grain=False, color="#e9e6df"),
        Material(id="hdf_3_white", name="ХДФ 3 Белый", kind="hdf", thickness=mm(3), has_grain=False, color="#efebe3"),
    ]
}

# Вид декора EMAN → вид материала ядра (kind): акрил и ЛМДФ — МДФ-основа
_CORE_KIND = {"ldsp": "ldsp", "lmdf": "mdf", "mdf": "mdf", "acrylic": "mdf", "lhdf": "hdf", "hdf": "hdf",
              "hpl": "hpl", "countertop": "countertop"}


def _from_decor(d: dict) -> Material | None:
    kind = _CORE_KIND.get(d["kind"])
    if kind is None or d.get("thickness_mm") is None:
        return None
    sheet = tuple(d["sheet_mm"]) if d.get("sheet_mm") and tuple(d["sheet_mm"]) != (2800, 2070) else None
    return Material(
        id=d["id"], name=d["name"], kind=kind, thickness=mm(d["thickness_mm"]), has_grain=bool(d.get("has_grain")),
        color=d.get("color") or "#dddddd", finish=d.get("finish") or "", texture=d.get("texture"),
        texture_size_mm=tuple(d.get("texture_size_mm") or (1000, 1000)), brand=d.get("brand") or "",
        code=d.get("code") or "", sheet_mm=sheet,
    )


# Каталог EMAN (data/eman_decors.json) — отдельно от MATERIALS: там сотни позиций, а MATERIALS
# показывается ИИ в подсказке. Поиск по id (`material()`) видит оба словаря.
DECOR_MATERIALS: dict[str, Material] = {
    m.id: m for m in (_from_decor(d) for d in load_decors()) if m is not None and m.id not in MATERIALS
}


def all_materials() -> dict[str, Material]:
    """Демо-материалы и декоры EMAN вместе."""
    return {**DECOR_MATERIALS, **MATERIALS}


EDGE_TYPES: dict[str, EdgeType] = {
    e.id: e
    for e in [
        EdgeType(id="pvc_04", name="Кромка ПВХ 0,4 мм", thickness=mm(0.4), code="0.4"),
        EdgeType(id="pvc_1", name="Кромка ПВХ 1 мм", thickness=mm(1), code="1"),
        EdgeType(id="pvc_2", name="Кромка ПВХ 2 мм", thickness=mm(2), code="2"),
    ]
}


# Тот же декор в другой толщине — для исправления «пролёт полки» (16 → 18 мм)
THICKER = {"ldsp_16_white": "ldsp_18_white", "ldsp_16_oak": "ldsp_18_oak", "ldsp_16_wenge": "ldsp_18_wenge"}


def material(material_id: str) -> Material:
    try:
        return MATERIALS.get(material_id) or DECOR_MATERIALS[material_id]
    except KeyError:
        raise KeyError(f"Материал «{material_id}» не найден в каталоге") from None


def edge_type(edge_id: str) -> EdgeType:
    try:
        return EDGE_TYPES[edge_id]
    except KeyError:
        raise KeyError(f"Кромка «{edge_id}» не найдена в каталоге") from None
