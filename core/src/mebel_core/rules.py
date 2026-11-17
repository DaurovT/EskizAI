"""Правила конструкции и значения по умолчанию.

Значения задаёт и подтверждает конструктор (раздел 5 PRD), потом они
переедут в админку с версиями. Пока — один набор в коде.
Помеченные «уточнить» — допущения, их нужно проверить с конструктором.
"""

from typing import Literal

from pydantic import BaseModel, Field

from .units import mm


def _grid_slide_holes(length: int) -> list[int]:
    """Перед — 37 мм, середина и зад — на сетке 32 мм от первого отверстия (≈, без каталога)."""
    first, step = mm(37), mm(32)
    mid = first + step * round((length / 2 - first) / step)
    back = first + step * ((length - 2 * first) // step)
    return sorted({first, mid, back})


def _slide_holes() -> dict[str, dict[int, list[int]]]:
    lengths = [mm(v) for v in (250, 300, 350, 400, 450, 500, 550, 600)]
    grid = {n: _grid_slide_holes(n) for n in lengths}
    # ball — шариковые 45 мм; hidden — скрытые (Blum Tandem/Movento, Hettich Quadro…): уточнить по системе
    return {"ball": dict(grid), "hidden": dict(grid)}


class RuleSet(BaseModel):
    version: str = "2026.11-draft"

    # Кромка
    edge_front: str = "pvc_2"  # лицевые торцы корпуса и полок
    edge_visible: str = "pvc_04"  # видимые, но не лицевые торцы

    # Цоколь и задняя стенка
    plinth_height_default: int = mm(70)
    back_inset: int = mm(2)  # отступ ХДФ от наружных краёв корпуса с каждой стороны

    # Полки
    shelf_front_setback: int = mm(20)  # уточнить: отступ полки от передней кромки
    shelf_pin_side_gap: int = mm(1)  # зазор полки на полкодержателях с каждой стороны
    shelf_pins_per_shelf: int = 4

    # Конфирматы на одно соединение — по длине соединения (≤ длины → штук)
    confirmat_by_depth: list[tuple[int, int]] = [(mm(300), 2), (mm(500), 3), (mm(10000), 4)]
    confirmat_end_offset: int = mm(50)  # от края соединения до первого конфирмата
    # Отверстия конфирмата 7×50 (drilling.py): в пласти — сквозное, в торце — глухое по оси толщины
    confirmat_face_diameter: int = mm(7)
    confirmat_face_depth: int = 0  # 0 — сквозное
    confirmat_edge_diameter: int = mm(5)
    confirmat_edge_depth: int = mm(50)  # уточнить с цехом: для 7×50 в ЛДСП 16 часто сверлят 35–45 мм
    # Шкант вместо конфирмата, если пласть со стороны головки уже закрыта другой деталью
    # (полки на одной высоте по обе стороны перегородки: вторая — на шкантах с клеем)
    dowel_diameter: int = mm(8)
    dowel_face_depth: int = mm(12)  # глухое в пласти
    dowel_edge_depth: int = mm(30)  # в торце (шкант 8×40: 12 + 28 с запасом)
    joint_shift_step: int = mm(32)  # занято место — конфирмат сдвигается вдоль соединения на шаг

    # Присадка (система 32)
    system32_front: int = mm(37)  # линия отверстий от переднего края боковины
    system32_step: int = mm(32)
    shelf_pin_hole_below: int = mm(5)  # центр отверстия полкодержателя ниже низа полки
    shelf_pin_diameter: int = mm(5)
    shelf_pin_depth: int = mm(12)  # уточнить: в ЛДСП 16 при отверстиях с двух сторон перегородки — 10
    # single — только отверстия под каждую полку; system32 — ряд через 32 мм на всю зону (полки
    # переставляются), полки встают на сетку ряда
    shelf_pin_rows: Literal["single", "system32"] = "single"
    shelf_pin_row_margin: int = mm(40)  # ряд system32: от низа и верха зоны до крайнего отверстия

    # Монтажные планки петель на корпусе: 2 отверстия под евровинт на линии 37 мм от переднего края,
    # через 32 мм вдоль кромки двери (центр — на высоте чашки). across — линейная планка: отверстия
    # на 37 и 69 мм от края на высоте чашки. Схема зависит от марки планки — уточнить (Blum, Hettich, GTV)
    hinge_plate_pattern: Literal["along", "across"] = "along"
    hinge_plate_spacing: int = mm(32)
    hinge_plate_hole_diameter: int = mm(5)
    hinge_plate_hole_depth: int = mm(12)

    # Направляющие ящиков: отверстия на боковине корпуса (или проставке) — от переднего торца направляющей.
    # По умолчанию — сетка 32 мм от 37 мм (перед, середина, зад); заменить таблицей производителя.
    slide_holes: dict[str, dict[int, list[int]]] = Field(default_factory=lambda: _slide_holes())
    slide_hole_diameter: int = mm(5)  # под евровинт 6,3
    slide_hole_depth: int = mm(12)
    # Ответная часть на боковине ящика (шариковые): саморез 4×16 — засверловка
    slide_drawer_hole_diameter: int = mm(3)
    slide_drawer_hole_depth: int = mm(10)
    # Скрытые направляющие: линия крепления на корпусе — выше низа ящика (≈, по системе)
    hidden_slide_hole_z: int = mm(10)
    # Скрытые: крючки задней стенки ящика — Ø6 глубиной 10, от боковины и от низа стенки (≈, Blum Tandem)
    hidden_slide_rear_hole: tuple[int, int] = (mm(6), mm(10))
    hidden_slide_rear_from_side: int = mm(11)
    hidden_slide_rear_from_bottom: int = mm(7)

    # Подъёмные механизмы (≈ — по шаблону производителя): отверстия на боковине изнутри,
    # (от переднего края корпуса, ниже низа детали с планками петель), Ø5×12
    gas_lift_holes: list[tuple[int, int]] = [(mm(60), mm(90)), (mm(60), mm(122))]
    fold_lift_holes: list[tuple[int, int]] = [(mm(37), mm(60)), (mm(37), mm(92)), (mm(69), mm(60)),
                                              (mm(69), mm(92))]  # Aventos HF и похожие, на каждую боковину

    # Ножки на дне снизу (≈, площадка ножки на 4 самореза): центр ножки — за планкой цоколя
    # и от торцов дна; отверстия — квадрат вокруг центра
    drill_legs: bool = True
    leg_behind_plinth: int = mm(30)  # центр ножки за задней пластью планки цоколя
    leg_back_inset: int = mm(70)  # от заднего края дна
    leg_side_inset: int = mm(80)  # от торца дна (дальше отверстий конфирмата в торце)
    leg_hole_offsets: list[tuple[int, int]] = [(-mm(16), -mm(16)), (mm(16), -mm(16)), (-mm(16), mm(16)),
                                               (mm(16), mm(16))]
    leg_hole_diameter: int = mm(3)
    leg_hole_depth: int = mm(10)

    # Навес верхнего модуля (≈, типа Camar 807): в верхнем заднем углу боковины изнутри —
    # (от заднего края боковины, ниже крыши)
    hanger_holes: list[tuple[int, int]] = [(mm(22), mm(18)), (mm(22), mm(50))]
    hanger_hole_diameter: int = mm(5)
    hanger_hole_depth: int = mm(12)

    # Проверки присадки (drilling.check_drilling)
    drill_edge_min: int = mm(3)  # от стенки отверстия до края детали меньше — вырыв
    drill_min_gap: int = mm(1)  # между стенками соседних отверстий
    drill_min_rest: int = mm(3)  # остаток толщины между встречными глухими отверстиями

    # Фасады
    front_gap: int = mm(2)  # зазор между фасадами; у наружного края — половина
    door_max_width: int = mm(600)
    hinge_angle: int = 110
    hinge_cup_diameter: int = mm(35)
    hinge_cup_depth: int = mm(13)
    hinge_cup_from_edge: int = mm(22.5)  # центр чашки от края двери
    hinge_end_offset: int = mm(100)  # от торца двери до крайней петли
    # Петли по высоте двери (≤ высоты → штук), раздел 5 PRD
    hinges_by_height: list[tuple[int, int]] = [(mm(900), 2), (mm(1600), 3), (mm(2000), 4), (mm(10000), 5)]
    handle_edge_offset: int = mm(50)  # скоба на двери — от края открывания
    handle_height: int = mm(1000)  # центр скобы на высокой двери от пола
    drawer_handle_from_top: int = mm(70)  # центр скобы ящика от верхнего края фасада

    # Ящики
    slide_side_gap: int = mm(13)  # шариковые направляющие: зазор с каждой стороны
    # Скрытые направляющие: зазор ящика с каждой стороны — уточнить по выбранной системе (Blum, Hettich…)
    hidden_slide_side_gap: int = mm(5)
    slide_lengths: list[int] = [mm(v) for v in (250, 300, 350, 400, 450, 500, 550, 600)]
    drawer_box_min_height: int = mm(80)
    drawer_box_max_height: int = mm(250)
    drawer_box_clearance: int = mm(40)  # высота ящика = высота места − зазор
    internal_drawer_setback: int = mm(25)  # уточнить: внутренний ящик за дверью — отступ от фасада

    # Пролёт полки без опоры (толщина ЛДСП → максимум), раздел 5 PRD
    shelf_max_span: dict[int, int] = {mm(16): mm(800), mm(18): mm(900)}
    spacer_thickness: int = mm(16)  # проставка под направляющие за распашной дверью
    spacer_height: int = mm(60)

    # Двери-купе (значения зависят от профильной системы — уточнить с поставщиком)
    sliding_track_depth: int = mm(100)  # глубина зоны рельсов спереди корпуса
    sliding_overlap: int = mm(26)  # перекрытие соседних дверей (ширина вертикального профиля)
    sliding_height_deduction: int = mm(40)  # высота двери = проём − вычет
    sliding_fill_width_deduction: int = mm(52)  # заполнение = ширина двери − вычет
    sliding_fill_height_deduction: int = mm(72)
    sliding_rail_front_y: int = mm(12)
    sliding_rail_back_y: int = mm(52)
    sliding_door_min_width: int = mm(450)
    sliding_door_max_width: int = mm(1100)

    # Правила станка (ЧПУ поставщика — уточнить у EMAN)
    cutter_radius: int = mm(3)  # минимальный внутренний радиус = радиус фрезы
    min_edge_radius: dict[str, int] = {"pvc_04": mm(10), "pvc_1": mm(20), "pvc_2": mm(30)}
    cutout_min_margin: int = mm(30)  # от выреза до края детали
    pocket_min_rest: int = mm(6)  # остаток толщины под выборкой

    # Кухня
    kitchen_rail_width: int = mm(100)  # царги вместо крыши у нижних модулей
    kitchen_plinth_setback: int = mm(50)
    countertop_max_length: int = mm(3050)  # плита столешницы EMAN; длиннее — стык с планкой
    hood_height: int = mm(360)
    corner_square_sizes: list[int] = [mm(900), mm(1000)]  # Г-образный угловой модуль
    corner_min_opening: int = mm(300)  # проём под дверь у углового модуля (с механизмом)
    corner_swing_min_opening: int = mm(400)  # поворотная полка в длинном глухом модуле
    carousel_diameter: dict[int, int] = {mm(900): mm(760), mm(1000): mm(830)}  # карусель 3/4 по размеру угла
    carousel_min_depth: int = mm(500)  # глубина корпуса под карусель
    sink_cutout_max: tuple[int, int] = (mm(780), mm(480))  # вырез под мойку в столешнице (уточнить по мойке)

    # Замер кухни (раздел SCR-13b): правила расстановки — уточнить с конструктором
    outlet_reach: int = mm(600)  # вода/канализация дальше этого от модуля мойки — предупреждение
    gas_hose_max: int = mm(1500)  # гибкая газовая подводка
    hob_sink_min_gap: int = mm(400)  # столешница между мойкой и варкой
    hob_wall_min_gap: int = mm(300)  # от варки до стены
    hood_vent_max: int = mm(1500)  # воздуховод от вытяжки до вентканала
    wall_ceiling_gap: int = mm(30)  # зазор над верхними «до потолка» — чтобы навесить на шину
    countertop_height_guess: int = mm(850)  # для оценки длины газового шланга

    # Встроенная мебель: доборы, фальш-панели, цоколь на ножках — уточнить с конструктором
    filler_min: int = mm(20)  # уже — добор не закрепить
    filler_max: int = mm(150)  # шире — лучше шире корпус или ещё секция
    side_gap_open_max: int = mm(30)  # щель до стены без добора больше — предложить добор
    filler_door_clearance: int = mm(30)  # добор у петель от 30 мм — дверь у стены открывается
    plumb_tolerance: int = mm(15)  # разница ширин/высот ниши больше — стены «завалены»
    filler_strip_width: int = mm(50)  # планка крепления добора
    filler_fix_step: int = mm(400)  # шаг саморезов/уголков по длине добора
    niche_min_section: int = mm(150)  # минимум секции при проверке узкой ниши
    fridge_top_gap: int = mm(50)  # над холодильником — вентиляция до полки
    top_panel_max: int = mm(600)  # добор до потолка у кухни выше — лучше верхние до потолка
    grille_max_length: int = mm(500)
    grille_margin: int = mm(15)  # от выреза решётки до края планки цоколя по высоте
    wardrobe_leg_step: int = mm(800)  # ножки шкафа по ширине

    # Штанга
    rod_below_top: int = mm(60)  # от верха зоны до штанги

    # Лист и раскрой
    sheet_length: int = mm(2800)
    sheet_width: int = mm(2070)
    sheet_trim: int = mm(10)  # обрезка кромок листа с каждой стороны
    sheet_kerf: int = mm(4)  # пропил
    sheet_reserve_threshold: float = 0.7  # последний лист заполнен больше чем на 70% → +1 лист запаса

    # Невязка суммы ширин секций / высот зон, которую последняя забирает сама (с предупреждением)
    max_auto_fit: int = mm(60)

    # Ограничения размеров
    min_section_width: int = mm(150)  # уточнить
    min_part_size: int = mm(30)

    def hinges_for_height(self, height: int) -> int:
        for limit, count in self.hinges_by_height:
            if height <= limit:
                return count
        return self.hinges_by_height[-1][1]

    def slide_length_for(self, depth: int) -> int | None:
        fitting = [s for s in self.slide_lengths if s <= depth]
        return max(fitting) if fitting else None

    def slide_hole_positions(self, kind: str, length: int) -> list[int]:
        """Отверстия направляющей от её переднего торца (тип ball / hidden_*)."""
        table = self.slide_holes.get("ball" if kind == "ball" else "hidden") or {}
        return table.get(length) or _grid_slide_holes(length)

    def confirmats_for_depth(self, depth: int) -> int:
        for limit, count in self.confirmat_by_depth:
            if depth <= limit:
                return count
        return self.confirmat_by_depth[-1][1]


DEFAULT_RULES = RuleSet()
