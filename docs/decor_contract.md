# Декор фасадов, цвета, подсветка — контракт ядро ↔ 3D ↔ приложение

Общий формат для трёх частей работы: ядро (`core/`) считает геометрию, цену и файлы для ЧПУ;
3D (`viewer/`) только рисует то, что пришло в модели вьюера; приложение (`app/`) даёт выбор.
Все размеры — мм, координаты декора — в системе детали (x — длина, y — ширина, начало в углу x0y0,
лицевая сторона — `face: "front"`), как у контура детали в `viewer.py`.

## 1. Дерево изделия (schema.py) — что выбирает мастер

На уровне изделия (`Fronts`) и при необходимости на конкретной двери/ящике (переопределение):

```jsonc
"fronts": {
  "material": "mdf_19_paint",          // как раньше
  "handles": { "type": "bar" | "knob" | "gola" | "none", "size": 128, "finish": "black" | "chrome" | "brass" | "gold" | "steel" },
  "style": {
    "milling": { "pattern": "none" | "shaker" | "classic" | "arcs" | "rhombus" | "grooves_v" | "grooves_h" | "waves",
                 "inset": 60, "width": 8, "depth": 3, "radius": 0 },      // фрезеровка по МДФ
    "overlay": { "pattern": "none" | "frame" | "arch" | "rhombus" | "moulding", "profile": "flat_20" | "round_25",
                 "inset": 50 },                                             // накладной декор (молдинг)
    "inlay":   { "kind": "none" | "frame" | "line_h" | "line_v" | "edge",   // латунные рамки, золотые канты
                 "finish": "brass" | "gold" | "black" | "chrome", "width": 6, "inset": 40 },
    "paint":   { "color": "#E8E4DC", "code": "RAL 9001", "system": "RAL" | "NCS", "gloss": "matte" | "satin" | "gloss" },
    "corners": { "radius": 0 }                                              // скругление углов фасада
  }
},
"lighting": [
  { "zone": "under_wall" | "niche" | "shelf" | "wardrobe_rod" | "plinth" | "inside_top",
    "target": "sections[1]" | "wall[0..n]" | "all",
    "temp": 3000 | 4000 | 6000, "sensor": "none" | "door" | "motion" | "touch" }
]
```

Правила (ядро, `rules.py`): фрезеровка и покраска — только МДФ (ЛДСП → ошибка с понятным текстом
и fix «заменить на МДФ 19 под покраску»); фрезеровка не ближе `inset` ≥ 40 к краю и не глубже
толщина − 6; Gola требует паз в боковинах (как уже делается для Gola в фурнитуре); подсветка в нише
требует паз/профиль и блок питания (одна позиция на изделие, мощность по длине лент).

## 2. Модель вьюера (viewer.py → JSON) — что рисует 3D

У детали (элемент `parts[]`) появляется необязательное поле `decor`:

```jsonc
"decor": {
  "paint":   { "color": "#E8E4DC", "gloss": "matte" },          // перекрывает цвет/текстуру материала
  "milling": [ { "path": [ /* сегменты как у контура: {"kind":"line","x":..,"y":..} | {"kind":"arc",...} */ ],
                 "closed": true, "width": 8, "depth": 3 } ],     // канавка по пути на лицевой стороне
  "overlay": [ { "path": [...], "closed": true, "width": 20, "height": 8, "profile": "flat" | "round" } ],
  "inlay":   [ { "path": [...], "closed": true, "width": 6, "finish": "brass" } ],   // металлическая вставка/кант
  "radius":  12                                                   // скругление углов детали в 3D (если не задано контуром)
}
```

Пути строит ЯДРО (тот же путь идёт в DXF для ЧПУ), 3D их не придумывает.
Отделки металла (`hardwareFinishes` уже есть) дополняются `brass`, `gold`.

Подсветка — отдельный список верхнего уровня:

```jsonc
"lights": [ { "id": "led1", "from": [x,y,z], "to": [x,y,z], "temp": 3000, "nodeId": null,
              "profile": { "width": 16, "height": 7 } } ]
```

3D рисует профиль (алюминий + молочный рассеиватель, светится), мягкий свет вниз/внутрь ниши;
кнопка «Подсветка» в редакторе включает/выключает свет и затемняет сцену.

Ручки: `hardware[].kind` получает `knob` (грибок) и `gola` (профиль по длине фасада/ряда).

## 3. Смета и файлы

Каждая опция — строка сметы со статусом «под запрос», если цены у EMAN нет:
фрезеровка (за м² или за фасад по шаблону), покраска (за м², глянец дороже), накладной декор (за п. м),
латунная рамка/кант (за п. м профиля + работа), подсветка (профиль + лента за п. м, блок питания, датчик),
кнопки/Gola. Фрезеровка и пазы под профили уходят в DXF отдельным слоем `MILLING` / `GROOVE`.

## 4. Как сделано в ядре (04.11.2026)

- Ручки — прежние поля `handles.kind` (не `type`) и `handles.spacing` (не `size`): `kind` = bar | knob | gola | none,
  `finish` = steel | black | chrome | brass | gold. Дополнительно: `milling.pitch` (шаг рифления/волн, 40),
  `paint.both_sides` (красить обратную сторону, true), `lighting[].mount` (groove | surface), `lighting[].power` (Вт/м, 9,6).
- Переопределение стиля — поле `style` у `Doors` (двери секции и зоны), у `DrawersFill` (фасады ящиков зоны),
  у `BaseCabinet`/`WallCabinet` кухни. Заданное поле целиком заменяет поле изделия; pattern/kind "none" — выключить.
- Путь в `decor.*[]`: `start: [x, y]` и `path`, где `path[0]` = `{"kind": "move", x, y}` (то же начало), дальше
  сегменты `line`/`arc` (arc: x, y, cx, cy, clockwise) — как у контура. Путь — осевая линия фрезы/профиля;
  `closed: false` — рифление, волны, полосы `line_h/line_v` (идут через весь фасад). У вставки есть `edge: true`
  для канта по периметру. Лицевая сторона фасада — локальная z = 0 (снаружи — z < 0), в DXF это пласть B.
- `lights[]`: id, zone, from, to (мм, оси ядра), temp, nodeId, part (деталь под профилем), mount, profile {17×7}.
- Фурнитура вьюера: `kind: "knob"` (ножка + шляпка), `kind: "gola"` (профиль за фасадом), отделки brass/gold/black
  добавлены в `hardwareFinishes`. GLB: цвет покраски, молдинг и вставки — объёмные полосы, фрезеровка — тёмная
  полоса 0,2 мм по пути, LED — светящийся профиль (`led:<id>`).
- DXF: `MILLING_B_W8_Z3` (фреза 8, глубина 3), `INLAY_B_W6_Z4` (паз под вставку), `OVERLAY_MARK` (разметка молдинга),
  `GROOVE_B_W17_Z7` (паз под LED-профиль), вырезы Gola — в контуре боковины (`CUT`).
- Цены декора — заглушки со статусом analog в `pricing.DECOR_PRICES` (одним блоком).

## 5. Встроенная мебель и помещение (`room`) — 04.11.2026

### Новые детали (обычные детали вьюера, неподвижные: `node: null`)

| role | что это | где |
|---|---|---|
| `niche_filler` | добор к стене / до потолка (в цвет фасадов, заготовка с припуском на подрезку); добор клином — с `contour` (трапеция по замеру) | `builtin.filler.left/right/top`, у кухни `wall.top_filler[n]`, `base.top_filler[n]` |
| `filler_strip` | планка крепления добора (ЛДСП корпуса, за добором) | `builtin.strip.*`, `*.top_filler.strip[n]` |
| `false_panel` | фальш-панель: боковина до пола, боковины ниши холодильника, панель над холодильником | `side_panel.left`, `base.side_panel.left`, `wall.side_panel.left`, `base[i].panel.*`, `base[i].top_panel` |
| `plinth_side` | боковая планка цоколя (шкаф на ножках, кухня с открытым торцом) | `body.plinth.left`, `kitchen.plinth.left` |
| `drawer_front` | фасад посудомойки; узел `base[i].dw_front` — rotate вокруг `+X` на 80° (открывается вниз) | `base[i].dw_front` |

Шкаф на ножках (`body.plinth.legs`) — в `hardware[]` появляются `kind: "leg"` под дном. Решётки цоколя — вырезы
(`cutouts`) в детали цоколя. Изделие, у которого слева фальш-панель или добор, сдвинуто вправо (все x ≥ 0),
`size` — габарит по деталям (заготовки доборов с припуском 15 мм выходят за стену — так их и режут).

**Добор клином** (`builtin.wedge: ["left" | "right" | "top"]`, исправление «Добор клином» у замечаний
`niche_out_of_plumb` / `niche_floor_slope`): кромка к стене режется по замеру — у боковых по ширинам внизу /
посередине / вверху, у верхнего по высотам слева / справа (линейно между точками), + припуск. Кромка к фасадам
прямая и кромится (только она). В детали — `contour` (многоугольник, как у скруглённых деталей): 3D выдавливает
его, DXF пишет контур в `CUT`, раскрой кладёт по габариту. Имя детали — «Добор правый клином 50→68 мм» (видимая
ширина в узком → широком месте; видимая ширина на любой высоте = ширина контура минус припуск). В смете — строка
«Косой рез добора (клин по замеру)» за штуку (`service:wedge_cut`, analog). `builtin.niche.lean` — какая стена
завалена (left | right): весь перекос уходит в добор этой стороны, сообщение «Стена справа завалена на 18 мм,
щель вверху»; без него перекос делится поровну.

### Блок `room` во viewer JSON — только для картинки

Есть только у встроенного шкафа / шкафа в нише (`builtin` или `installation: "niche"`) и у кухни с замером
(`site`). **Не детали**: нет в смете, раскрое, DXF и **в GLB для AR** (`glb.py` его не читает — AR показывает чистую
модель). Рисовать полупрозрачно/приглушённо, без теней на фасадах, можно выключать.

```json
"room": {
  "walls": [
    {"id": "wall_left", "kind": "wall_left", "x0": -76, "y0": -50, "z0": 0, "x1": 24, "y1": 700, "z1": 2700,
     "lean": {"top": 9, "middle": 3, "bottom": 0}},
    {"id": "wall_right", "kind": "wall_right", "...": "..."},
    {"id": "wall_back", "kind": "wall_back", "...": "..."},
    {"id": "floor", "kind": "floor", "...": "..."},
    {"id": "ceiling", "kind": "ceiling", "...": "...", "lean": {"left": 8, "right": 0}},
    {"id": "wall_front_left", "kind": "wall_front", "...": "..."}
  ],
  "niche": {"width": 2394, "width_max": 2412, "height": 2692, "height_max": 2700, "depth": 650},
  "measured": true,
  "colors": {"wall": "#E6E1D8", "floor": "#A07D5A", "source": "photo"},
  "openings": [{"id": "window", "kind": "window", "x0": 0, "y0": 0, "z0": 0, "x1": 0, "y1": 0, "z1": 0}],
  "outlets": [{"id": "outlet1", "kind": "water", "x": 420, "y": 560, "z": 500}]
}
```

- Боксы — в мм, в осях изделия (как детали: X — ширина, Y — глубина от фасада к стене, Z — высота). Стена 100 мм,
  пол и потолок выходят за нишу на 300 мм. `kind`: `wall_left` | `wall_right` | `wall_back` | `ceiling` | `floor` |
  `wall_front` (стена комнаты по бокам от проёма ниши — есть, если мерили глубину ниши) | у кухни `window` в `openings`.
- Заваленная стена: грань бокса — по самому узкому месту ниши; `lean` — на сколько грань уходит от ниши в точках
  замера, мм (`top`/`middle`/`bottom` у боковых стен, `left`/`right` у потолка). Можно рисовать скошенный бокс:
  внутренняя грань в точке замера = грань + lean (наружу). Нет `lean` — стена ровная.
- `niche` — замер (самое узкое и самое широкое место), `measured: false` — размеры номинальные (до замера).
- `colors` — всегда есть: `{"view_only": true, "walls_visible": true, "wall"?, "floor"?, "floor_material"?,
  "floor_texture"?, "source"?}` (из `tree.room_colors`). `view_only: true` — «Только для вида»: комната никогда не
  влияет на детали, смету и файлы (её нет в GLB/AR). `walls_visible: false` — стены не рисовать (пол и потолок —
  по желанию). `source: "photo"` — цвет снят с фото пустой ниши (медиана участка, без теней и бликов), `"manual"` —
  выбран мастером. Нет `wall`/`floor` — нейтральный светло-серый.
- Пол-пресет `floor_material` (если `floor` не задан — подставлен цвет пресета) и `floor_texture`
  `{texture, seam, step_mm}` — подсказка для отрисовки:

  | id | ru | uz | цвет | шов | текстура |
  |---|---|---|---|---|---|
  | `oak_light` | Дуб светлый | Och eman | `#D9BF94` | `#CFB386` | planks, доска 180 мм |
  | `walnut` | Орех | Yong‘oq | `#7C5A3F` | `#6D4E36` | planks, доска 180 мм |
  | `tile` | Плитка | Kafel | `#C9C7C2` | `#B8B6B1` | tiles, 600 мм |
  | `concrete` | Бетон | Beton | `#A8A6A1` | `#94928D` | speckle |
  | `carpet` | Ковролин | Gilam | `#B9AE9E` | `#A89D8D` | plain |

  Тот же список — в `GET /catalog/builtin-options` → `room.floor_materials`.
- Кухня: `outlets[]` — выводы с замера (`water`, `sewer`, `gas`, `socket`, `vent`) точками на стене; `openings[]` —
  окно (бокс-проём в стене).

### Дерево (schema.py) — кратко

- Шкаф: `builtin` {niche {width | width_top/middle/bottom, height | height_left/right, depth}, fillers [left, right,
  top], filler_width 50, top_filler_width 50, allowance_side 10, allowance_top 20, scribe 15, filler_material,
  filler_position flush | setback, filler_setback 20, filler_mount strip | screws, wedge [left, right, top]};
  `niche.lean` left | right; `side_panels[]` {side, material, to_floor}; `body.plinth.legs`,
  `body.plinth.floor_allowance`; `body.back.kind: "none"`; `room_colors` {wall, floor, floor_material,
  walls_visible, source}.
  `width`/`height` изделия — корпус без доборов.
- Кухня: `plinth` {setback, sides auto | none, grilles [sink, oven], floor_allowance}; `side_panels[]` (+ `row`
  base | wall | both, `run` 1 | 2); `top_filler` {ceiling, scribe, material}; модуль `{"kind": "fridge",
  "fridge_height", "top_panel"}` (с края ряда, над ним в верхнем ряду — `gap`); `{"kind": "appliance", "dw": true}`;
  `room_colors`.
- Замер ниши: `POST /projects/{id}/measurements` с `niche` (хранится в `data.niche`), варианты для экранов —
  `GET /catalog/builtin-options`.
