/**
 * Схема кухни в редакторе (SCR-37): раскладка модулей по реальным ширинам (мм), подписи по виду модуля,
 * правки рядов (добавить / удалить / дублировать / сдвинуть), подгонка суммы к стене и выбор модуля по детали 3D.
 * Источник правды по полям и диапазонам — core/src/mebel_core/schema.py (Kitchen, BaseCabinet, WallCabinet,
 * WallTop, CountertopUnit). Чистые функции — без React, покрыты тестами.
 */
import type { ProductTree } from '../api/types';

export type KRow = 'base' | 'wall' | 'base2' | 'wall2' | 'mid';
/** Выбранный элемент схемы; tier — антресольный ярус верхнего модуля. */
export type KSel = { row: KRow; i: number; tier?: boolean };
export type KMod = { kind: string; width?: number; [k: string]: unknown };

/** Значения по умолчанию ядра (Kitchen) и пределы полей. */
export const KDEF = {
  legs_height: 100, base_height: 720, base_depth: 560, wall_bottom: 1400, wall_height: 720, wall_depth: 300,
  ct_depth: 600, hood_height: 360, micro_niche: 380, oven_niche: 600, fridge_height: 1850, tier_auto: 350,
} as const;

export const KLIM = {
  legs_height: [60, 200], base_height: [500, 900], base_depth: [300, 700], wall_bottom: [1100, 1800],
  wall_height: [300, 1400], wall_depth: [200, 400], ct_depth: [400, 900],
  width: [150, 1200], mid_width: [150, 900], mid_height: [150, 900], mid_x: [0, 20000], mod_height: [200, 1400],
  tier_height: [250, 600], niche_height: [300, 700], fridge_height: [1000, 2300], drawers: [1, 5], shelves: [0, 4],
  cargo_width: [150, 300], open_bottom: [150, 900],
} as const satisfies Record<string, readonly [number, number]>;

export const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, v));

export const rowMods = (tree: ProductTree, row: KRow): KMod[] => (Array.isArray(tree[row]) ? (tree[row] as KMod[]) : []);
export const isUpper = (row: KRow) => row === 'wall' || row === 'wall2';
export const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Дверей у модуля: задано — как есть, null — по ширине (до 600 мм — одна), как _door_count ядра. */
export const doorCount = (m: KMod) => (m.doors === 1 || m.doors === 2 ? m.doors : (m.width ?? 600) <= 600 ? 1 : 2);

/**
 * Код подписи модуля (ключ i18n — kit_k_<код>). Верхние: двери — «Дверь» / «2 двери», два ряда — «2 ряда дверей»,
 * подъёмные — «Подъёмный» / «Подъёмные ×2» / «Складной» (складной подъёмник), с открытой нишей внизу — «Подъёмный + ниша» / «Двери + ниша», ниша
 * техники — «Микроволновка» / «Духовка». Нижние: ниша под технику с варкой — «Варка», посудомойка — «ПММ», иначе
 * «Техника»; бутылочница — «Бутылочница».
 */
export function labelCode(m: KMod, row: KRow): string {
  if (row === 'mid') return 'mid';
  const k = m.kind;
  if (isUpper(row)) {
    if (k === 'doors' && hasOpenBottom(m)) return m.opening === 'lift' ? 'niche_lift' : 'niche_door';
    if (k === 'doors' && m.opening !== 'lift' && m.rows === 2) return 'rows';
    if (k === 'doors' && isFold(m)) return 'fold';
    if (k === 'doors') return m.opening === 'lift' ? (m.flaps === 2 ? 'lift2' : 'lift') : doorCount(m) === 1 ? 'door' : 'doors2';
    if (k === 'appliance') return m.appliance === 'oven' ? 'oven' : 'micro';
    if (k === 'open' || k === 'hood' || k === 'gap') return k;
    return k;
  }
  if (k === 'doors') return doorCount(m) === 1 ? 'door' : 'doors2';
  if (k === 'appliance') return m.hob ? 'hob' : m.dw || (m.width ?? 600) <= 450 ? 'dw' : 'tech';
  if (k === 'drawers' || k === 'sink' || k === 'corner' || k === 'fridge' || k === 'cargo') return k;
  return k;
}

/** Высота верхнего модуля, мм: своя, у вытяжки — 360, иначе как у ряда; ниша техники без верха — высота ниши. */
export function wallModHeight(m: KMod, tree: ProductTree): number {
  if (typeof m.height === 'number') return m.height;
  if (m.kind === 'hood') return KDEF.hood_height;
  if (m.kind === 'appliance' && m.above === 'none') return nicheHeight(m);
  return num(tree.wall_height, KDEF.wall_height);
}
export const nicheHeight = (m: KMod) => num(m.niche_height, m.appliance === 'oven' ? KDEF.oven_niche : KDEF.micro_niche);
/** Высота антресольного яруса для рисунка: своя или 350 (null — «до потолка / 350»). */
export const tierHeight = (m: KMod) => num((m.top as { height?: number } | null | undefined)?.height, KDEF.tier_auto);
export const hasTier = (m: KMod) => m.top != null && typeof m.top === 'object' && m.kind !== 'gap';
/**
 * Складной подъёмник (lift_type fold, как ядро is_fold): два фасада на петлях складываются и уходят вверх — у
 * подъёмных фасадов (doors/hood с opening lift) и над нишей техники (above lift). flaps у него не учитывается.
 */
export const isFold = (m: KMod) =>
  m.lift_type === 'fold' && (m.kind === 'appliance' ? m.above === 'lift' : (m.kind === 'doors' || m.kind === 'hood') && m.opening === 'lift');
/** Есть ли у верхнего модуля подъёмные фасады (выбор механизма: отдельные / складной). */
export const hasLift = (m: KMod) => (m.kind === 'appliance' ? m.above === 'lift' : (m.kind === 'doors' || m.kind === 'hood') && m.opening === 'lift');
/** Открытая ниша без фасада внизу верхнего модуля с дверями (open_bottom, мм в свету). */
export const hasOpenBottom = (m: KMod) => m.kind === 'doors' && typeof m.open_bottom === 'number';

/**
 * Линии между фасадами ящиков для рисунка — доли высоты сверху вниз (как ядро: drawer_ratios). small_top (1+2) —
 * верхний ящик 1/5 высоты, остальные поровну; иначе — поровну.
 */
export function drawerLines(m: KMod): number[] {
  const n = Math.max(1, Math.round(num(m.drawers, 3)));
  if (m.drawer_layout === 'small_top' && n >= 2) {
    const rest = (1 - SMALL_TOP) / (n - 1);
    return Array.from({ length: n - 1 }, (_, j) => SMALL_TOP + j * rest);
  }
  return Array.from({ length: n - 1 }, (_, j) => (j + 1) / n);
}
export const SMALL_TOP = 0.2;

// ---------- раскладка ----------

export type KBox = { sel: KSel; x: number; w: number; m: KMod };
export type KLayout = {
  base: KBox[]; wall: KBox[]; mid: KBox[];
  /** Угловая зона ряда 2 (от угла до первого модуля): x, w в мм; sel — угловой модуль ряда 1, если есть. */
  corner: { x: number; w: number; sel: KSel | null } | null;
  /** Длина вида, мм (самый длинный ряд). */
  len: number;
  /** Длина нижнего ряда (сумма модулей вместе с угловой зоной). */
  baseLen: number;
  wallLen: number;
};

const seq = (mods: KMod[], row: KRow, start = 0) => {
  let x = start;
  return mods.map((m, i) => { const b = { sel: { row, i }, x, w: num(m.width, 0), m }; x += b.w; return b; });
};
const total = (mods: KMod[]) => mods.reduce((s, m) => s + num(m.width, 0), 0);

/**
 * Фасад ряда: оба ряда (нижний и верхний) от x = 0 слева, как в ядре; полки на столешнице — по своему x (ряд 1).
 * Ряд 2 угловой кухни — вид на стену Б: нижние начинаются за угловой зоной (глубина столешницы или Г-модуль),
 * верхние — от угла (или от фасадов верхних ряда 1, если те доходят до угла). Угол справа от ряда 1 — на виде
 * стены Б угол слева; угол слева — справа (порядок модулей зеркальный, как _build_run ядра).
 */
export function schemeLayout(tree: ProductTree, run: 1 | 2 = 1): KLayout {
  if (run === 1) {
    const base = seq(rowMods(tree, 'base'), 'base');
    const wall = seq(rowMods(tree, 'wall'), 'wall');
    const mid = rowMods(tree, 'mid').map((m, i) => ({ sel: { row: 'mid' as const, i }, x: num(m.x, 0), w: num(m.width, 300), m }));
    const baseLen = total(rowMods(tree, 'base'));
    const wallLen = total(rowMods(tree, 'wall'));
    const len = Math.max(baseLen, wallLen, ...mid.map((b) => b.x + b.w), 1);
    return { base, wall, mid, corner: null, len, baseLen, wallLen };
  }
  const b2 = rowMods(tree, 'base2');
  const w2 = rowMods(tree, 'wall2');
  const base1 = rowMods(tree, 'base');
  const cornerIdx = base1.findIndex((m) => m.kind === 'corner');
  const sq = cornerIdx >= 0 && base1[cornerIdx].corner_shape === 'square' ? num(base1[cornerIdx].width, 900) : null;
  const off = sq ?? num((tree.countertop as { depth?: number } | undefined)?.depth, KDEF.ct_depth);
  const wall1 = rowMods(tree, 'wall');
  const left = tree.corner_side === 'left';
  const wallDepth = num(tree.wall_depth, KDEF.wall_depth);
  // верхние ряда 1 доходят до угла — верхние ряда 2 начинаются перед их фасадами
  const reaches = wall1.length > 0 && (left || total(wall1) > total(base1) - wallDepth);
  const wStart = reaches ? wallDepth : 0;
  const baseLen = off + total(b2);
  const wallLen = wStart + total(w2);
  const len = Math.max(baseLen, wallLen, 1);
  // расстояние от угла d → x на виде: угол слева (corner_side right) — x = d, справа — x = len − d − w
  const place = (mods: KMod[], row: KRow, start: number) => {
    let d = start;
    return mods.map((m, i) => {
      const w = num(m.width, 0);
      const box = { sel: { row, i }, x: left ? len - d - w : d, w, m };
      d += w;
      return box;
    });
  };
  return {
    base: place(b2, 'base2', off), wall: place(w2, 'wall2', wStart), mid: [],
    corner: { x: left ? len - off : 0, w: off, sel: cornerIdx >= 0 ? { row: 'base', i: cornerIdx } : null },
    len, baseLen, wallLen,
  };
}

/** Холодильники ряда (x, w) — над ними в верхнем ряду должно быть пустое место. */
export const fridgeSpans = (l: KLayout) => l.base.filter((b) => b.m.kind === 'fridge').map((b) => ({ x: b.x, w: b.w }));

/** Верхние модули (не пустое место), висящие над холодильником: ядро такую кухню не соберёт (fridge_wall_overlap). */
export function wallOverFridge(tree: ProductTree, run: 1 | 2 = 1): number[] {
  const l = schemeLayout(tree, run);
  const fr = fridgeSpans(l);
  return l.wall.filter((b) => b.m.kind !== 'gap' && fr.some((f) => b.x < f.x + f.w - 1 && b.x + b.w > f.x + 1)).map((b) => b.sel.i);
}

// ---------- правки рядов ----------

export const insertAt = <T>(list: T[], i: number, item: T): T[] => [...list.slice(0, i), item, ...list.slice(i)];
export const removeAt = <T>(list: T[], i: number): T[] => list.filter((_, j) => j !== i);
export const replaceAt = <T>(list: T[], i: number, item: T): T[] => list.map((x, j) => (j === i ? item : x));
export const duplicateAt = <T>(list: T[], i: number): T[] => (i < 0 || i >= list.length ? list : insertAt(list, i + 1, JSON.parse(JSON.stringify(list[i])) as T));
/** Сдвиг модуля на соседнее место (dir −1 — влево, +1 — вправо); у края — без изменений. */
export function moveAt<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Новый модуль в конец ряда: нижний и верхний — двери 600, полка на столешнице — 300 правее последней. */
export function newModule(row: KRow, tree: ProductTree, width?: number): KMod {
  if (row === 'mid') {
    const mids = rowMods(tree, 'mid');
    const x = mids.reduce((s, m) => Math.max(s, num(m.x, 0) + num(m.width, 300)), 0);
    return { kind: 'open', x, width: clamp(width ?? 300, KLIM.mid_width), height: null, shelves: 1, depth: null };
  }
  if (isUpper(row)) return { kind: 'doors', width: clamp(width ?? 600, KLIM.width), shelves: 1 };
  return { kind: 'doors', width: clamp(width ?? 600, KLIM.width) };
}

/** Варианты вида: нижний — двери / ящики / мойка / бутылочница / техника / холодильник; верхний — двери / подъёмные / открытые / вытяжка / техника / пусто. */
export const BASE_KINDS = ['doors', 'drawers', 'sink', 'cargo', 'appliance', 'fridge'] as const;
export const WALL_KINDS = ['doors', 'lift', 'open', 'hood', 'appliance', 'gap'] as const;
export type WallKindChoice = (typeof WALL_KINDS)[number];

/** Какой вариант вида выбран у верхнего модуля (подъёмные — это doors с opening lift). */
export const wallKindOf = (m: KMod): string => (m.kind === 'doors' && m.opening === 'lift' ? 'lift' : m.kind);

/**
 * Смена вида модуля: ширина, стиль и (у верхних) ярус сохраняются, поля чужого вида убираются, у нового — разумные
 * значения по умолчанию (ящиков 3, полок 1, ниша — микроволновка).
 */
export function withKind(m: KMod, row: KRow, choice: string): KMod {
  const keep: KMod = { kind: m.kind, width: m.width };
  if (m.style != null) keep.style = m.style;
  if (isUpper(row)) {
    const tier = m.top != null && choice !== 'gap' ? { top: m.top } : {};
    const h = typeof m.height === 'number' && (choice === 'doors' || choice === 'lift' || choice === 'open') ? { height: m.height } : {};
    const ob = hasOpenBottom(m) ? { open_bottom: m.open_bottom } : {};
    switch (choice) {
      case 'doors': return { ...keep, kind: 'doors', shelves: num(m.shelves, 1), ...(m.doors ? { doors: m.doors } : {}), ...(m.hinge ? { hinge: m.hinge } : {}), ...(m.rows === 2 ? { rows: 2 } : {}), ...ob, ...h, ...tier };
      case 'lift': return { ...keep, kind: 'doors', opening: 'lift', flaps: m.flaps === 2 && m.lift_type !== 'fold' ? 2 : null, ...(m.lift_type === 'fold' ? { lift_type: 'fold' } : {}), shelves: num(m.shelves, 1), ...ob, ...h, ...tier };
      case 'open': return { ...keep, kind: 'open', shelves: m.kind === 'open' ? num(m.shelves, 2) : 2, ...h, ...tier };
      case 'hood': return { ...keep, kind: 'hood', shelves: 0, ...tier };
      case 'appliance': return { ...keep, kind: 'appliance', appliance: m.appliance === 'oven' ? 'oven' : 'microwave', shelves: 0, ...tier };
      case 'gap': return { ...keep, kind: 'gap' };
      default: return { ...keep, kind: choice };
    }
  }
  switch (choice) {
    case 'doors': return { ...keep, kind: 'doors', ...(m.doors ? { doors: m.doors } : {}), ...(m.hinge ? { hinge: m.hinge } : {}) };
    case 'drawers': return { ...keep, kind: 'drawers', drawers: typeof m.drawers === 'number' ? m.drawers : 3 };
    case 'sink': return { ...keep, kind: 'sink' };
    // механизм карго — 150–300 мм: шире — сужаем (сумму ряда сводит подсказка «подогнать соседний»)
    case 'cargo': return { ...keep, kind: 'cargo', width: clamp(num(m.width, 150), KLIM.cargo_width) };
    case 'appliance': return { ...keep, kind: 'appliance' };
    case 'fridge': return { ...keep, kind: 'fridge', width: Math.max(600, num(m.width, 600)) };
    default: return { ...keep, kind: choice };
  }
}

// ---------- типы модуля (KitchenEditor.dc.html .types / TKitchen2 .pal) ----------

/**
 * Готовые типы модуля в панели «Модуль»: вид ядра + настройка (ящики 1+2, два ряда дверей, складной подъёмник,
 * рамка под СВЧ, ниша под фасадом). Тап — модуль становится этим типом; точная настройка — строками ниже.
 */
export const BASE_PRESETS = ['doors', 'dr12', 'drawers', 'cargo', 'appliance', 'dw', 'sink', 'fridge'] as const;
export const WALL_PRESETS = ['doors', 'rows2', 'lift', 'fold', 'niche', 'open', 'hood', 'appliance', 'mwf', 'gap'] as const;
/** Типы с плашкой «новое» (как NEW в макете). */
export const NEW_PRESETS: ReadonlySet<string> = new Set(['dr12', 'cargo', 'rows2', 'fold', 'niche', 'mwf']);

/** Какой тип модуля выбран (самый точный из списка). */
export function presetOf(m: KMod, row: KRow): string {
  if (row === 'mid') return 'mid';
  const k = m.kind;
  if (isUpper(row)) {
    if (k === 'doors' && hasOpenBottom(m)) return 'niche';
    if (k === 'doors' && m.opening === 'lift') return isFold(m) ? 'fold' : 'lift';
    if (k === 'doors' && m.rows === 2) return 'rows2';
    if (k === 'appliance' && m.niche_frame === true) return 'mwf';
    return k;
  }
  if (k === 'drawers') return m.drawer_layout === 'small_top' && num(m.drawers, 3) >= 2 ? 'dr12' : 'drawers';
  if (k === 'appliance') return m.dw === true ? 'dw' : 'appliance';
  return k;
}

const drop = (m: KMod, ...keys: string[]): KMod => {
  const out: KMod = { ...m };
  for (const k of keys) delete out[k];
  return out;
};

/**
 * Модуль → выбранный тип. Вид меняется через withKind (ширина, стиль, ярус сохраняются), настройка типа
 * выставляется, настройки других типов снимаются. Бутылочница — 150 мм, из бутылочницы в другой тип — 450 (как в макете).
 */
export function applyPreset(m: KMod, row: KRow, key: string): KMod {
  if (isUpper(row)) {
    switch (key) {
      case 'doors': return drop(withKind(m, row, 'doors'), 'rows', 'open_bottom');
      case 'rows2': return { ...drop(withKind(m, row, 'doors'), 'open_bottom'), rows: 2 };
      case 'lift': return drop(withKind(m, row, 'lift'), 'open_bottom', 'lift_type');
      case 'fold': return { ...drop(withKind(m, row, 'lift'), 'open_bottom'), lift_type: 'fold', flaps: null };
      case 'niche': {
        const base = m.kind === 'doors' ? m : withKind(m, row, 'doors');
        return { ...drop(base, 'rows'), open_bottom: hasOpenBottom(m) ? m.open_bottom : 400 };
      }
      case 'appliance': return drop(withKind(m, row, 'appliance'), 'niche_frame');
      case 'mwf': return { ...withKind(m, row, 'appliance'), appliance: 'microwave', niche_frame: true };
      default: return withKind(m, row, key);
    }
  }
  const leaveCargo = m.kind === 'cargo' && key !== 'cargo';
  const w = (x: KMod): KMod => (leaveCargo ? { ...x, width: 450 } : x);
  switch (key) {
    case 'dr12': return w({ ...withKind(m, row, 'drawers'), drawers: num(m.drawers, 3) >= 2 ? num(m.drawers, 3) : 3, drawer_layout: 'small_top' });
    case 'drawers': return w(drop(withKind(m, row, 'drawers'), 'drawer_layout'));
    case 'cargo': return { ...withKind(m, row, 'cargo'), width: 150 };
    case 'appliance': return w(withKind(m, row, 'appliance'));
    case 'dw': return w({ ...withKind(m, row, 'appliance'), dw: true });
    default: return w(withKind(m, row, key));
  }
}

// ---------- рисунок модуля (части фасада, как .m i в макете) ----------

/**
 * Часть рисунка модуля в процентах от внутренней области (без рамки 3 pt): ln — линия стыка/полки, hd — ручка,
 * dk — механизм подъёмника, op — открытая ниша, gl — дисплей, mw — стекло духовки/СВЧ, bt — бутылки карго.
 */
export type KPartKind = 'ln' | 'hd' | 'dk' | 'op' | 'gl' | 'mw' | 'bt';
export type KPart = { c: KPartKind; l: number; t: number; w: number; h: number };
const P = (c: KPartKind, l: number, t: number, w: number, h: number): KPart => ({ c, l, t, w, h });
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Распашные двери в полосе [y0, y1]: стык посередине у двух дверей, вертикальные ручки на высоте hy (доля полосы). */
function doorParts(m: KMod, y0: number, y1: number, hy: number, hh: number): KPart[] {
  const span = y1 - y0;
  const t = r1(y0 + span * hy);
  const h = r1(span * hh);
  if (doorCount(m) === 2) return [P('ln', 49.5, y0, 1, span), P('hd', 40, t, 3, h), P('hd', 57, t, 3, h)];
  return [P('hd', m.hinge === 'right' ? 13 : 84, t, 3, h)];
}

/** Подъёмные фасады в полосе [y0, y1]: горизонтальные ручки внизу фасадов, механизм сверху; складной/два — стык. */
function liftParts(m: KMod, y0: number, y1: number): KPart[] {
  const span = y1 - y0;
  const two = isFold(m) || m.flaps === 2;
  const out: KPart[] = [];
  if (two) {
    const mid = r1(y0 + span * 0.49);
    out.push(P('ln', 0, mid, 100, 1.5), P('hd', 38, r1(y0 + span * 0.4), 24, 3));
    // два отдельных — у каждого свой механизм; складной — один
    if (!isFold(m)) out.push(P('dk', 47, r1(mid + span * 0.1), 6, r1(span * 0.14)));
  }
  out.push(P('hd', 38, r1(y0 + span * 0.88), 24, 3), P('dk', 47, r1(y0 + span * 0.12), 6, r1(span * 0.16)));
  return out;
}

/** Рисунок нижнего модуля (корпус ряда base / base2). */
export function baseParts(m: KMod): KPart[] {
  switch (m.kind) {
    case 'drawers': {
      const ls = drawerLines(m).map((f) => f * 100);
      const edges = [0, ...ls, 100];
      const out: KPart[] = ls.map((y) => P('ln', 0, r1(y), 100, 1.5));
      for (let j = 0; j < edges.length - 1; j++) out.push(P('hd', 38, r1(edges[j] + Math.min((edges[j + 1] - edges[j]) * 0.42, 16)), 24, 3));
      return out;
    }
    case 'cargo': return [P('bt', 22, 30, 16, 48), P('bt', 44, 22, 16, 56), P('bt', 66, 34, 16, 44), P('hd', 30, 8, 40, 3)];
    case 'appliance':
      if (m.dw === true) return [P('hd', 30, 8, 40, 3)];
      return [P('ln', 0, 22, 100, 1.5), P('hd', 38, 8, 24, 3), P('mw', 12, 34, 76, 46), P('hd', 30, 88, 40, 3)];
    case 'sink':
    case 'doors': return doorParts(m, 0, 100, 0.4, 0.18);
    case 'fridge': return [P('ln', 0, 38, 100, 1), P('hd', m.hinge === 'right' ? 13 : 84, 24, 3, 9), P('hd', m.hinge === 'right' ? 13 : 84, 46, 3, 14)];
    default: return [];
  }
}

/** Рисунок верхнего модуля: двери / два ряда / подъёмные / ниша под фасадом / ниша техники в рамке / открытые полки. */
export function wallParts(m: KMod, tree: ProductTree): KPart[] {
  const H = Math.max(1, wallModHeight(m, tree));
  if (m.kind === 'gap') return [];
  if (m.kind === 'open') {
    const n = num(m.shelves, 2);
    return [P('op', 0, 0, 100, 100), ...Array.from({ length: n }, (_, j) => P('ln', 0, r1((100 * (j + 1)) / (n + 1)), 100, 1.5))];
  }
  if (m.kind === 'appliance') {
    const nf = m.above === 'none' ? 1 : clamp(nicheHeight(m) / H, [0.25, 0.8]);
    const nt = r1(100 - nf * 100); // верх ниши
    const frame = m.niche_frame === true;
    const out: KPart[] = [];
    const above = typeof m.above === 'string' ? m.above : 'door';
    if (nt > 0) {
      out.push(P('ln', 0, r1(Math.max(0, nt - 6)), 100, 1.5));
      const fb = Math.max(0, nt - 6);
      if (above === 'lift') out.push(...(isFold(m) ? liftParts(m, 0, fb) : [P('hd', 38, r1(fb * 0.78), 24, 3)]));
      else if (above === 'door') out.push(...doorParts(m, 0, fb, 0.55, 0.3));
      else if (above === 'open') out.push(P('op', 0, 0, 100, fb));
    }
    const ny = nt > 0 ? nt + 2 : 0;
    const nh = 100 - ny - (frame ? 6 : 0);
    out.push(frame ? P('op', 8, r1(ny), 84, r1(nh)) : P('op', 0, r1(ny), 100, r1(100 - ny)));
    if (m.appliance === 'oven') out.push(P('mw', 14, r1(ny + nh * 0.14), 72, r1(nh * 0.66)), P('hd', 30, r1(ny + nh * 0.04), 40, 3));
    else out.push(P('mw', 16, r1(ny + nh * 0.12), 58, r1(nh * 0.76)), P('gl', 78, r1(ny + nh * 0.24), 8, r1(Math.min(8, nh * 0.2))));
    return out;
  }
  // doors / hood: открытая ниша внизу, фасады над ней
  const ob = hasOpenBottom(m) ? clamp(num(m.open_bottom, 400) / H, [0.15, 0.7]) * 100 : 0;
  const fb = ob ? r1(100 - ob - 2) : 100;
  const out: KPart[] = [];
  if (ob) out.push(P('ln', 0, fb, 100, 1.5), P('op', 0, r1(fb + 2), 100, r1(100 - fb - 2)));
  if (m.opening === 'lift') out.push(...liftParts(m, 0, fb));
  else if (m.rows === 2 && !ob) {
    const mid = r1(fb * 0.49);
    out.push(P('ln', 0, mid, 100, 1.5), ...doorParts(m, 0, mid, 0.6, 0.25), ...doorParts(m, mid + 1.5, fb, 0.6, 0.25));
  } else out.push(...doorParts(m, 0, fb, ob ? 0.62 : 0.72, ob ? 0.2 : 0.16));
  return out;
}

/** Антресольный ярус: подъёмный фасад — ручка внизу, распашные — по дверям. */
export function tierParts(m: KMod): KPart[] {
  const tp = (m.top as { doors?: number | null; opening?: string } | null) ?? {};
  if (tp.opening === 'lift') return [P('hd', 38, 70, 24, 8)];
  const doors = tp.doors === 1 || tp.doors === 2 ? tp.doors : num(m.width, 600) <= 600 ? 1 : 2;
  return doors === 2 ? [P('ln', 49.5, 0, 1, 100), P('hd', 40, 40, 3, 40), P('hd', 57, 40, 3, 40)] : [P('hd', 84, 40, 3, 40)];
}

/** Полка на столешнице: открытый короб с полками. */
export function midParts(m: KMod): KPart[] {
  const n = num(m.shelves, 1);
  return [P('op', 0, 0, 100, 100), ...Array.from({ length: n }, (_, j) => P('ln', 0, r1((100 * (j + 1)) / (n + 1)), 100, 2))];
}

/** Мини-рисунок типа для списка типов (TKitchen2 .gl2): типичный модуль этого типа. */
export function presetParts(row: KRow, key: string, tree: ProductTree): KPart[] {
  const sample: KMod = applyPreset({ kind: 'doors', width: 600, doors: 2 }, row, key);
  if (key === 'doors') sample.doors = 2;
  if (isUpper(row)) return wallParts(sample, tree);
  return baseParts(sample);
}

// ---------- подгонка суммы к стене ----------

export type SumFix = { kind: 'neighbour'; i: number; from: number; to: number } | { kind: 'add'; width: number };

/**
 * Как свести сумму ряда со стеной (diff = стена − сумма): подогнать соседний модуль выбранного (справа, потом слева,
 * потом крайние) — если новая ширина в пределах 150–1200 (у бутылочницы 150–300); добор — новый модуль на остаток
 * (от 150 мм). Угловой модуль и холодильник не трогаем.
 */
export function sumFixes(mods: KMod[], diff: number, sel: number | null): SumFix[] {
  if (!diff) return [];
  const out: SumFix[] = [];
  const order: number[] = [];
  if (sel != null) order.push(sel + 1, sel - 1);
  for (let i = mods.length - 1; i >= 0; i--) order.push(i);
  const seen = new Set<number>();
  for (const i of order) {
    if (i < 0 || i >= mods.length || seen.has(i) || i === sel) continue;
    seen.add(i);
    const m = mods[i];
    if (m.kind === 'corner' || m.kind === 'fridge') continue;
    const from = num(m.width, 0);
    const to = from + diff;
    const lim = m.kind === 'cargo' ? KLIM.cargo_width : KLIM.width;
    if (to >= lim[0] && to <= lim[1]) { out.push({ kind: 'neighbour', i, from, to }); break; }
  }
  if (diff >= KLIM.width[0] && diff <= KLIM.width[1]) out.push({ kind: 'add', width: diff });
  return out;
}

// ---------- деталь 3D → модуль схемы ----------

/**
 * Ключ детали ядра → модуль схемы: "base[2]…", "wall[0].doors.door[1]", "wall[1].tier.…", "mid[0]", "base2[1]…".
 * Ряды 2 у угла слева ядро строит в обратном порядке (_build_run: reversed) — индекс разворачиваем.
 * "base2.corner…" — крыло Г-образного углового модуля (он в ряду base); столешница — 'top'.
 */
export function selFromPartKey(key: string, tree: ProductTree): KSel | 'top' | null {
  if (/^countertop/.test(key)) return 'top';
  if (/^base2?\.corner/.test(key)) {
    const ci = rowMods(tree, 'base').findIndex((m) => m.kind === 'corner');
    return ci >= 0 ? { row: 'base', i: ci } : null;
  }
  const m = /^(base2|wall2|base|wall|mid)\[(\d+)\](.*)$/.exec(key);
  if (!m) return null;
  const row = m[1] as KRow;
  const n = rowMods(tree, row).length;
  let i = Number(m[2]);
  if ((row === 'base2' || row === 'wall2') && tree.corner_side === 'left') i = n - 1 - i;
  if (i < 0 || i >= n) return null;
  return /^\.tier\b/.test(m[3]) ? { row, i, tier: true } : { row, i };
}
