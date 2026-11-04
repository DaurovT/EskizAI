"""Правила конструкции и значения по умолчанию.

Значения задаёт и подтверждает конструктор (раздел 5 PRD), потом они
переедут в админку с версиями. Пока — один набор в коде.
Помеченные «уточнить» — допущения, их нужно проверить с конструктором.
"""

from pydantic import BaseModel

from .units import mm


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

    # Присадка (система 32)
    system32_front: int = mm(37)  # линия отверстий от переднего края боковины
    shelf_pin_hole_below: int = mm(5)  # центр отверстия полкодержателя ниже низа полки

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

    def confirmats_for_depth(self, depth: int) -> int:
        for limit, count in self.confirmat_by_depth:
            if depth <= limit:
                return count
        return self.confirmat_by_depth[-1][1]


DEFAULT_RULES = RuleSet()
