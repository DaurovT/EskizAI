/**
 * Декор фасадов, подсветка, встройка — расчёты без React (покрыто тестами):
 * область переопределения стиля по ключу детали, правило «только по МДФ», SVG-пути превью → ломаные,
 * щели и доборы ниши (порт core/niche.py), подгонка корпуса под замер.
 */
import type { FrontsStyle, NicheMeasure, ProductTree } from '../api/types';
import { getAt } from './jsonPatch';

// ---------- переопределение стиля одного фасада ----------

export interface FrontScope {
  /** JSON Pointer поля `style` (двери секции/зоны, ящики зоны, модуль кухни). */
  pointer: string;
  kind: 'doors' | 'drawers' | 'module';
  /** Номер секции / модуля (с 1) — для подписи. */
  n: number;
  row?: 'base' | 'wall' | 'base2' | 'wall2';
}

/**
 * Ключ детали (как в viewer) → куда писать стиль только этих фасадов. null — у детали своего стиля нет
 * (антресоль, купе, добор): тогда только стиль всего изделия.
 */
export function frontScope(key: string): FrontScope | null {
  let m = /^sections\[(\d+)\]\.fill\[(\d+)\]\.doors\.door\[\d+\]$/.exec(key);
  if (m) return { pointer: `/sections/${m[1]}/fill/${m[2]}/doors/style`, kind: 'doors', n: Number(m[1]) + 1 };
  m = /^sections\[(\d+)\]\.doors\.door\[\d+\]$/.exec(key);
  if (m) return { pointer: `/sections/${m[1]}/doors/style`, kind: 'doors', n: Number(m[1]) + 1 };
  m = /^sections\[(\d+)\]\.fill\[(\d+)\]\.drawer\[\d+\]\.front$/.exec(key);
  if (m) return { pointer: `/sections/${m[1]}/fill/${m[2]}/style`, kind: 'drawers', n: Number(m[1]) + 1 };
  m = /^(base2?|wall2?)\[(\d+)\]\./.exec(key);
  if (m) return { pointer: `/${m[1]}/${m[2]}/style`, kind: 'module', n: Number(m[2]) + 1, row: m[1] as FrontScope['row'] };
  return null;
}

/** Ключи деталей, которые попадают в ту же область (для «2 фасада»). */
export const sameScope = (keys: string[], pointer: string) => keys.filter((k) => frontScope(k)?.pointer === pointer);

/** Стиль фасада с учётом переопределения: заданное поле целиком заменяет поле изделия. */
export function effectiveStyle(tree: ProductTree, pointer?: string | null): FrontsStyle {
  const base = tree.fronts?.style ?? {};
  const own = pointer ? (getAt(tree, pointer) as FrontsStyle | null | undefined) : null;
  return { ...base, ...(own ?? {}) };
}

const on = (v: string | null | undefined) => !!v && v !== 'none';
export const millingOn = (s: FrontsStyle) => on(s.milling?.pattern);
export const overlayOn = (s: FrontsStyle) => on(s.overlay?.pattern);
export const inlayOn = (s: FrontsStyle) => on(s.inlay?.kind);

export const isMdf = (material: string | null | undefined) => !!material && /^mdf_/.test(material);

/** Что в стиле требует МДФ (фрезеровка, покраска, вставка кроме канта). Пусто — ЛДСП подходит. */
export function mdfNeeds(s: FrontsStyle): ('milling' | 'paint' | 'inlay')[] {
  const out: ('milling' | 'paint' | 'inlay')[] = [];
  if (millingOn(s)) out.push('milling');
  if (s.paint) out.push('paint');
  if (inlayOn(s) && s.inlay?.kind !== 'edge') out.push('inlay');
  return out;
}

/** Все стили изделия (общий + переопределения) — для проверки МДФ перед сохранением. */
export function allStyles(tree: ProductTree): FrontsStyle[] {
  const out: FrontsStyle[] = [tree.fronts?.style ?? {}];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'style' && x && typeof x === 'object') out.push(x as FrontsStyle);
        else if (k !== 'fronts') walk(x);
      }
    }
  };
  walk(tree);
  return out;
}

/** Нужен МДФ, а фасады не из МДФ. */
export const needsMdfFix = (tree: ProductTree) => !isMdf(tree.fronts?.material) && allStyles(tree).some((s) => mdfNeeds(s).length > 0);

// ---------- SVG-пути превью (M / L / A / Z, абсолютные — так их строит API) ----------

export interface Polyline { pts: [number, number][]; closed: boolean }

/** Дуга SVG (rx = ry, без поворота) → точки, как в SVG 1.1 F.6.5. */
function arcPoints(x1: number, y1: number, r: number, large: boolean, sweep: boolean, x2: number, y2: number, step: number): [number, number][] {
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const d2 = dx * dx + dy * dy;
  if (!d2) return [];
  r = Math.max(r, Math.sqrt(d2));
  const k = Math.sqrt(Math.max(0, (r * r - d2) / d2)) * (large === sweep ? -1 : 1);
  const cx = k * dy + (x1 + x2) / 2, cy = -k * dx + (y1 + y2) / 2;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  let da = Math.atan2(y2 - cy, x2 - cx) - a1;
  if (sweep && da < 0) da += 2 * Math.PI;
  if (!sweep && da > 0) da -= 2 * Math.PI;
  const n = Math.max(2, Math.min(24, Math.ceil((Math.abs(da) * r) / step)));
  const pts: [number, number][] = [];
  for (let i = 1; i <= n; i++) pts.push([cx + r * Math.cos(a1 + (da * i) / n), cy + r * Math.sin(a1 + (da * i) / n)]);
  return pts;
}

/** d → ломаные (дуги — отрезками длиной ~step в единицах viewBox). */
export function parseSvgPath(d: string, step = 24): Polyline[] {
  const tok = d.match(/[MLAZHV]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const out: Polyline[] = [];
  let cur: Polyline | null = null;
  let i = 0, x = 0, y = 0;
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    const c = tok[i++].toUpperCase();
    if (c === 'M') { x = num(); y = num(); cur = { pts: [[x, y]], closed: false }; out.push(cur); }
    else if (c === 'L') { x = num(); y = num(); cur?.pts.push([x, y]); }
    else if (c === 'H') { x = num(); cur?.pts.push([x, y]); }
    else if (c === 'V') { y = num(); cur?.pts.push([x, y]); }
    else if (c === 'A') {
      const r = num(); num(); num(); const large = num() === 1; const sweep = num() === 1; const nx = num(), ny = num();
      cur?.pts.push(...arcPoints(x, y, r, large, sweep, nx, ny, step));
      x = nx; y = ny;
    } else if (c === 'Z') { if (cur) { cur.closed = true; cur.pts.push([...cur.pts[0]]); } }
  }
  return out.filter((p) => p.pts.length > 1);
}

// ---------- ниша: щели, доборы, подгонка корпуса (порт core/niche.py) ----------

export interface Builtin {
  niche?: NicheMeasure; fillers?: ('left' | 'right' | 'top')[]; filler_width?: number; top_filler_width?: number;
  allowance_side?: number; allowance_top?: number; scribe?: number; filler_material?: string | null;
  filler_position?: 'flush' | 'setback'; filler_setback?: number; filler_mount?: 'strip' | 'screws';
  /** Добор клином (кромка к стене по замеру). */
  wedge?: ('left' | 'right' | 'top')[];
}
export const BUILTIN_DEFAULTS: Required<Omit<Builtin, 'niche' | 'filler_material'>> = {
  fillers: ['left', 'right', 'top'], filler_width: 50, top_filler_width: 50, allowance_side: 10, allowance_top: 20, scribe: 15,
  filler_position: 'flush', filler_setback: 20, filler_mount: 'strip', wedge: [],
};
export interface Gap { side: 'left' | 'right' | 'top'; filler: boolean; min: number; max: number }
export interface NicheLayout { left: Gap; right: Gap; top: Gap; widths: number[]; heights: number[]; panelLeft: number; panelRight: number }

const nums = (...v: (number | null | undefined)[]) => v.filter((x): x is number => typeof x === 'number' && x > 0);
export const nicheWidths = (n: NicheMeasure | undefined) => nums(n?.width, n?.width_top, n?.width_middle, n?.width_bottom);
export const nicheHeights = (n: NicheMeasure | undefined) => nums(n?.height, n?.height_left, n?.height_right);
/** Толщина плиты из id материала (`ldsp_18_oak` → 18); нет числа — 18. */
export const thicknessOf = (id: string | null | undefined) => Number(/_(\d+)(?:_|$)/.exec(id ?? '')?.[1] ?? 18);

export function builtinOf(tree: ProductTree): Builtin & typeof BUILTIN_DEFAULTS {
  return { ...BUILTIN_DEFAULTS, ...((tree.builtin as Builtin | undefined) ?? {}) };
}

type SidePanel = { side: 'left' | 'right'; material?: string | null; to_floor?: boolean; row?: string };
export const sidePanels = (tree: ProductTree) => ((tree.side_panels as SidePanel[] | undefined) ?? []);
function panelT(tree: ProductTree, side: 'left' | 'right') {
  const p = sidePanels(tree).find((x) => x.side === side);
  return p ? thicknessOf(p.material ?? tree.fronts?.material ?? tree.body?.material) : 0;
}

export function nicheLayout(tree: ProductTree): NicheLayout {
  const b = builtinOf(tree);
  const W = tree.width ?? 0, H = tree.height ?? 0;
  const pl = panelT(tree, 'left'), pr = panelT(tree, 'right');
  const fl = b.fillers.includes('left'), fr = b.fillers.includes('right'), ft = b.fillers.includes('top');
  const widths = nicheWidths(b.niche), heights = nicheHeights(b.niche);
  let lMin: number, lMax: number, rMin: number, rMax: number;
  if (widths.length) {
    const gMin = Math.min(...widths) - W - pl - pr, gMax = Math.max(...widths) - W - pl - pr;
    const lean = b.niche?.lean;
    if (fl && fr && lean) {
      // весь перекос — в добор заваленной стены
      const half = gMin / 2;
      if (lean === 'left') { rMin = rMax = half; lMin = half; lMax = gMax - half; } else { lMin = lMax = half; rMin = half; rMax = gMax - half; }
    } else if ((fl && fr) || !(fl || fr)) { lMin = gMin / 2; rMin = gMin - lMin; lMax = gMax / 2; rMax = gMax - lMax; }
    else if (fl) { rMin = rMax = b.allowance_side; lMin = gMin - b.allowance_side; lMax = gMax - b.allowance_side; }
    else { lMin = lMax = b.allowance_side; rMin = gMin - b.allowance_side; rMax = gMax - b.allowance_side; }
  } else {
    lMin = lMax = fl ? b.filler_width : b.allowance_side;
    rMin = rMax = fr ? b.filler_width : b.allowance_side;
  }
  const [tMin, tMax] = heights.length ? [Math.min(...heights) - H, Math.max(...heights) - H] : [ft ? b.top_filler_width : b.allowance_top, ft ? b.top_filler_width : b.allowance_top];
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    left: { side: 'left', filler: fl, min: r1(lMin), max: r1(lMax) }, right: { side: 'right', filler: fr, min: r1(rMin), max: r1(rMax) },
    top: { side: 'top', filler: ft, min: r1(tMin), max: r1(tMax) }, widths, heights, panelLeft: pl, panelRight: pr,
  };
}

/** Корпус под замер: самое узкое место минус доборы (или зазоры) и фальш-панели. */
export function fittedSize(tree: ProductTree): { width: number | null; height: number | null } {
  const b = builtinOf(tree);
  const widths = nicheWidths(b.niche), heights = nicheHeights(b.niche);
  const sides = (['left', 'right'] as const).reduce((a, s) => a + (b.fillers.includes(s) ? b.filler_width : b.allowance_side), 0);
  return {
    width: widths.length ? Math.round((Math.min(...widths) - panelT(tree, 'left') - panelT(tree, 'right') - sides) * 10) / 10 : null,
    height: heights.length ? Math.round((Math.min(...heights) - (b.fillers.includes('top') ? b.top_filler_width : b.allowance_top)) * 10) / 10 : null,
  };
}

/** Дерево с корпусом, подогнанным под нишу (последняя секция забирает разницу ширины). */
export function fitToNiche(tree: ProductTree): ProductTree {
  const { width, height } = fittedSize(tree);
  const t: ProductTree = JSON.parse(JSON.stringify(tree));
  if (width != null && Math.abs(width - (t.width ?? 0)) >= 0.05) {
    t.width = width;
    const secs = t.sections ?? [];
    if (secs.length && secs.every((s) => s.width != null)) secs[secs.length - 1].width = null;
  }
  if (height != null && Math.abs(height - (t.height ?? 0)) >= 0.05) t.height = height;
  return t;
}

export interface NicheLimits { filler_min: number; filler_max: number; plumb_tolerance: number }
export const DEFAULT_LIMITS: NicheLimits = { filler_min: 20, filler_max: 150, plumb_tolerance: 15 };
export interface NicheWarning { code: 'plumb_w' | 'plumb_h' | 'filler_narrow' | 'filler_wide'; side?: Gap['side']; value: number; limit: number }

/** Предупреждения по замеру и доборам — до сохранения (сервер их повторит своим текстом). */
export function nicheWarnings(tree: ProductTree, lim: NicheLimits = DEFAULT_LIMITS): NicheWarning[] {
  const lay = nicheLayout(tree);
  const out: NicheWarning[] = [];
  if (lay.widths.length > 1) {
    const d = Math.max(...lay.widths) - Math.min(...lay.widths);
    if (d > lim.plumb_tolerance) out.push({ code: 'plumb_w', value: d, limit: lim.plumb_tolerance });
  }
  if (lay.heights.length > 1) {
    const d = Math.max(...lay.heights) - Math.min(...lay.heights);
    if (d > lim.plumb_tolerance) out.push({ code: 'plumb_h', value: d, limit: lim.plumb_tolerance });
  }
  for (const g of [lay.left, lay.right, lay.top]) {
    if (!g.filler) continue;
    if (g.min < lim.filler_min) out.push({ code: 'filler_narrow', side: g.side, value: g.min, limit: lim.filler_min });
    else if (g.min > lim.filler_max) out.push({ code: 'filler_wide', side: g.side, value: g.min, limit: lim.filler_max });
  }
  return out;
}

// ---------- схема фасадов спереди (для превью «Все фасады / Этот фасад») ----------

export interface FrontRect { key: string; number: number; x: number; z: number; w: number; h: number }
type PlacedPart = { key: string; number: number; role: string; length: number; width: number; placement: { origin: number[]; u: string; v: string } };
const FRONT_ROLES = new Set(['door', 'drawer_front', 'sliding_fill']);

/** Фасады в плоскости X–Z (мм, z вверх): по origin и осям u/v детали. */
export function frontRects(parts: PlacedPart[]): FrontRect[] {
  const out: FrontRect[] = [];
  for (const p of parts) {
    if (!FRONT_ROLES.has(p.role)) continue;
    const lo = [p.placement.origin[0], p.placement.origin[2]], hi = [...lo];
    for (const [ax, len] of [[p.placement.u, p.length], [p.placement.v, p.width]] as [string, number][]) {
      const i = ax[1] === 'X' ? 0 : ax[1] === 'Z' ? 1 : -1;
      if (i < 0) continue;
      if (ax[0] === '-') lo[i] -= len; else hi[i] += len;
    }
    out.push({ key: p.key, number: p.number, x: lo[0], z: lo[1], w: hi[0] - lo[0], h: hi[1] - lo[1] });
  }
  return out.filter((r) => r.w > 0 && r.h > 0);
}

/** Длина замкнутой рамки с отступом inset по фасаду w×h, м. */
export const frameLen = (w: number, h: number, inset: number) => Math.max(0, 2 * (w - 2 * inset) + 2 * (h - 2 * inset)) / 1000;
