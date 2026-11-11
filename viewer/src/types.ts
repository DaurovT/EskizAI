/**
 * Контракт «viewer model» (format "1") — см. core/src/mebel_core/viewer.py.
 *
 * Размеры — в мм. Оси ядра: X — ширина (слева направо), Y — глубина
 * (0 — передняя плоскость, растёт назад), Z — высота (вверх).
 */

export type AxisName = 'X' | 'Y' | 'Z';
export type Axis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

/** Точка в координатах ядра, мм: [X, Y, Z]. */
export type CoreVec3 = [number, number, number];

export interface ViewerMaterial {
  name: string;
  /** Цвет декора, "#rrggbb" (sRGB). */
  color: string;
  hasGrain: boolean;
  /** Тип поверхности из каталога (matte, gloss, softtouch…) — может отсутствовать. */
  type?: string;
  /** Скан декора: URL, путь `/static/…` или `bundled:<имя>` (приложение) — грузит `loadTexture`. */
  texture?: string | null;
  /** Сколько мм приходится на одну плитку скана: [по горизонтали картинки, по вертикали]. Волокна — по горизонтали. */
  textureSizeMm?: [number, number] | null;
}

/** Направление текстуры детали: вдоль длины (локальная x), вдоль ширины (локальная y) или без ограничения. */
export type Grain = 'length' | 'width' | 'none';

export interface LineSegment {
  kind: 'line';
  /** Конечная точка; начало — конец предыдущего сегмента. */
  x: number;
  y: number;
}

export interface ArcSegment {
  kind: 'arc';
  /** Конечная точка дуги. */
  x: number;
  y: number;
  /** Центр дуги. */
  cx: number;
  cy: number;
  /**
   * true — дуга идёт по часовой стрелке в локальной плоскости детали
   * (x — длина вправо, y — ширина вверх), то есть угол убывает.
   */
  clockwise: boolean;
}

export type ContourSegment = LineSegment | ArcSegment;

/** Замкнутый контур в локальных координатах детали (x — длина, y — ширина), мм. */
export interface Contour {
  start: [number, number];
  segments: ContourSegment[];
}

export interface Placement {
  /** Точка изделия (мм, оси ядра), где лежит локальный (0, 0, 0) детали. */
  origin: CoreVec3;
  /** Куда направлена локальная x (длина). */
  u: Axis;
  /** Куда направлена локальная y (ширина). */
  v: Axis;
  /** Куда направлена толщина. */
  n: Axis;
}

export interface Hole {
  x: number;
  y: number;
  diameter: number;
  depth: number;
  face: string;
}

export interface ViewerPart {
  /** Номер детали — один во всех файлах мастера. */
  number: number;
  key: string;
  name: string;
  role: string;
  material: string;
  thickness: number;
  length: number;
  width: number;
  grain: string;
  contour: Contour | null;
  /** Внутренние вырезы (мойка, варочная панель, ручка-прорезь), локальные мм. Поле может отсутствовать. */
  cutouts?: Contour[];
  placement: Placement;
  holes: Hole[];
  /** id подвижного узла, если деталь двигается. */
  node: string | null;
  /** Декор фасада (docs/decor_contract.md): покраска, фрезеровка, накладки, вставки, скругление. */
  decor?: PartDecor;
}

/** Начало пути декора (ядро кладёт его первым сегментом). */
export interface MoveSegment {
  kind: 'move';
  x: number;
  y: number;
}

export type DecorSegment = ContourSegment | MoveSegment;

/** Путь декора на лицевой стороне детали (локальные мм, лицевая сторона — z = 0). */
export interface DecorStroke {
  /** Сегменты как у контура; первый может быть `move` — начало пути. */
  path: DecorSegment[];
  /** Начало пути, если нет `move` (иначе — конец последнего сегмента у замкнутого пути). */
  start?: [number, number];
  closed?: boolean;
  /** Ширина фрезы / профиля / вставки, мм. */
  width?: number;
  /** Фрезеровка: глубина, мм. */
  depth?: number;
  /** Накладка: высота над фасадом, мм. */
  height?: number;
  /** Накладка: 'flat' | 'round'. */
  profile?: string;
  /** Вставка: brass | gold | black | chrome. */
  finish?: string;
  /** Вставка-кант по краю фасада. */
  edge?: boolean;
}

export type PaintGloss = 'matte' | 'satin' | 'gloss';

export interface PartDecor {
  /** Пласть с декором; 'front' — локальная z = 0. */
  face?: string;
  paint?: { color: string; gloss?: PaintGloss | string; code?: string };
  milling?: DecorStroke[];
  overlay?: DecorStroke[];
  inlay?: DecorStroke[];
  /** Скругление углов детали, мм (если контур его ещё не содержит). */
  radius?: number;
}

/** Светодиодная подсветка: профиль с лентой от `from` до `to` (мм, оси ядра). */
export interface ViewerLight {
  id: string;
  from: CoreVec3;
  to: CoreVec3;
  /** Цветовая температура, K: 3000 тёплый, 4000 нейтральный, 6000 холодный. */
  temp?: number;
  /** Узел, с которым свет двигается. */
  nodeId?: string | null;
  /** Деталь, к которой крепится профиль (с ней он разлетается при «взрыве»). */
  part?: string | null;
  zone?: string;
  /** 'groove' — в пазу (заподлицо), 'surface' — накладной. */
  mount?: string;
  profile?: { width: number; height: number };
}

export type NodeKind = 'rotate' | 'slide' | 'sliding_door' | 'lift';

export interface ViewerNode {
  id: string;
  kind: NodeKind;
  /** Точка на оси поворота или начало хода, мм, оси ядра. */
  origin: CoreVec3;
  /** Ось поворота (по правилу правой руки) или направление хода. */
  axis: Axis;
  /** Градусы для rotate/lift, мм для slide/sliding_door. */
  range: number;
}

export interface ViewerIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

/** Параллелепипед по осям ядра, мм. */
export interface HardwareBox {
  type: 'box';
  min: CoreVec3;
  max: CoreVec3;
}

/**
 * Цилиндр вдоль оси ядра (по центру `center`, длина `length`), мм.
 * `start`/`sweep` — сектор в градусах (только ось Z, угол от +X к +Y);
 * `inner` — внутренний радиус (кольцо, например бортик полки карусели).
 */
export interface HardwareCylinder {
  type: 'cylinder';
  axis: AxisName;
  center: CoreVec3;
  radius: number;
  length: number;
  start?: number;
  sweep?: number;
  inner?: number;
}

export type HardwareShape = HardwareBox | HardwareCylinder;

/** Вид фурнитуры в 3D. Список может расти — неизвестный вид рисуется как есть. */
export type HardwareKind =
  | 'handle'
  | 'hinge'
  | 'rod_holder'
  | 'slide'
  | 'leg'
  | 'profile'
  | 'rail'
  | 'carousel'
  | 'swing_shelf'
  | 'knob'
  | 'gola'
  | (string & {});

/**
 * Фурнитура для картинки (ручки, петли, штангодержатели, ножки, направляющие, профили купе,
 * угловые механизмы). Детали и смету не меняет. Строится ядром (core/src/mebel_core/hw3d.py).
 */
export interface ViewerHardware {
  id: string;
  kind: HardwareKind;
  /** Название как в смете: «Ручка-скоба 128 мм», «Петля накладная 110° с доводчиком (стандарт)». */
  name: string;
  /** Узел, с которым фурнитура двигается (дверь, ящик); null — стоит на корпусе. */
  node: string | null;
  /** Ключ детали-«родителя»: с ней фурнитура разлетается при «взрыве». */
  part: string;
  /** Отделка: ключ в `hardwareFinishes` (steel, chrome, nickel, zinc, alu, plastic_black, plastic_light, brass, gold, black). */
  finish: string;
  shapes: HardwareShape[];
}

export interface HardwareFinish {
  name: string;
  /** "#rrggbb" (sRGB). */
  color: string;
  metal: boolean;
  roughness: number;
}

export interface ViewerModel {
  format: string;
  /** Габарит изделия, мм: [ширина, высота, глубина]. */
  size: [number, number, number];
  materials: Record<string, ViewerMaterial>;
  parts: ViewerPart[];
  nodes: ViewerNode[];
  issues: ViewerIssue[];
  /** Фурнитура для картинки. В старых моделях поля нет. */
  hardware?: ViewerHardware[];
  /** Отделки фурнитуры по ключу. Нет — берутся значения по умолчанию. */
  hardwareFinishes?: Record<string, HardwareFinish>;
  /** Подсветка (LED-профили). В старых моделях поля нет. */
  lights?: ViewerLight[];
  /** Комната для встроенной мебели (стены, пол, потолок) — только контекст, не изделие. */
  room?: ViewerRoom;
  /** Размещение в AR: floor — на пол, wall — навесное (на стену). В старых моделях поля нет — floor. */
  placement?: 'floor' | 'wall';
}

/** Плоскость комнаты: бокс в мм, оси ядра (как у изделия). */
export interface RoomWall {
  id?: string;
  /** wall_left | wall_right | wall_back | ceiling | floor (может быть и другое). */
  kind?: string;
  min: CoreVec3;
  max: CoreVec3;
}

export interface ViewerRoom {
  walls: RoomWall[];
  /** Цвета комнаты (с фото ниши или вручную), "#rrggbb". Нет — светло-серые. */
  colors?: { wall?: string; floor?: string; ceiling?: string };
}

/** Что вернул выбор детали лучом. */
export interface PickResult {
  /**
   * 'part' — попали в деталь (в т. ч. в фрезеровку и накладку — это часть фасада); 'decor' — в металлическую вставку;
   * 'hardware' — в фурнитуру (тогда number/key/name/role/node — её детали-«родителя»,
   * например двери с ручкой, а сама фурнитура — в `hardware`). Поля может не быть у старых сборок.
   */
  kind?: 'part' | 'hardware' | 'decor';
  hardware?: { id: string; kind: HardwareKind; name: string };
  /** Попали в металлическую вставку (kind 'decor'): что это. Деталь — её фасад. */
  decor?: { kind: 'inlay'; name: string; finish: string };
  number: number;
  key: string;
  name: string;
  role: string;
  /** id узла, если деталь подвижная. */
  node: string | null;
  /** Точка попадания в координатах сцены three.js (в единицах сцены). */
  point: [number, number, number];
  distance: number;
}
