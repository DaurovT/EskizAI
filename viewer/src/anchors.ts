import { Box3, Vector3 } from 'three';
import type { DimensionKey } from './rig.js';

/**
 * Экранные точки размеров (px канваса, y вниз) — для оверлея поверх 3D (RN-плашки, линии в 1 pt).
 * Габарит изделия: ширина — над изделием, высота — справа, глубина — слева (левое ребро, уходящее вглубь).
 * Деталь (partAnchors): длина, ширина и толщина — по её собственным осям, на рёбрах её силуэта.
 * Линия размера отнесена от силуэта на `gap` px, выносные линии идут от ребра к ней.
 */

export type Pt = [number, number];
export type Seg = [number, number, number, number];

/** Размеры детали: длина × ширина × толщина (локальные оси x, y, z детали). */
export type PartDimensionKey = 'length' | 'width' | 'thickness';

/**
 * Где плашка: число — сдвиг от середины линии по нормали, px; 'beside' — рядом с серединой линии (на полразмера
 * плашки по нормали); 'end' — за концом линии со стороны нормали по горизонтали (глубина: слева от изделия).
 */
export type LabelOffset = number | 'beside' | 'end';

const DEFAULT_LABEL_OFFSET: Record<DimensionKey, LabelOffset> = { width: 0, height: 34, depth: 'end' };
/** Половина плашки «1800» (px) — для 'beside'. */
const PILL_HALF: Pt = [26, 13];

export interface DimensionAnchor<K extends string = DimensionKey> {
  key: K;
  /** false — ребро видно «в торец» (глубина спереди) или за камерой: ничего не рисовать. */
  visible: boolean;
  /** Размерная линия (концы). */
  a: Pt;
  b: Pt;
  /** Ребро, которое меряем (для подсветки в режиме ввода). */
  edgeA: Pt;
  edgeB: Pt;
  /** Выносные линии (от ребра до размерной с заходом). */
  ext: [Seg, Seg];
  /** Засечки 45° на концах размерной линии. */
  ticks: [Seg, Seg];
  /** Центр плашки (середина размерной линии + labelOffset по нормали). */
  label: Pt;
  /** Единичная нормаль от изделия (куда отнесена линия). */
  normal: Pt;
  /** Угол размерной линии, рад (0 — вправо). */
  angle: number;
  /** Длина на экране, px. */
  length: number;
}

export interface DimensionAnchors {
  width: DimensionAnchor;
  height: DimensionAnchor;
  depth: DimensionAnchor;
}

export type PartDimensionAnchors = Record<PartDimensionKey, DimensionAnchor<PartDimensionKey>>;

export interface AnchorOptions<K extends string = DimensionKey> {
  /** Отступ размерной линии от силуэта, px. По умолчанию 14. */
  gap?: number;
  /** Заход выносной линии за размерную, px. По умолчанию 5. */
  overshoot?: number;
  /** Зазор между ребром и началом выносной линии, px. По умолчанию 3. */
  extGap?: number;
  /** Полудлина засечки, px. По умолчанию 4. */
  tick?: number;
  /**
   * Где плашка (LabelOffset), общее или по размерам. Габарит: ширина — 0 (плашка на линии над изделием),
   * высота — 34 (справа от линии), глубина — 'end' (слева от изделия). Деталь — всё 'beside'.
   */
  labelOffset?: LabelOffset | Partial<Record<K, LabelOffset>>;
  /** Короче этого (px) — размер не показываем. Габарит — 18; деталь — 0: толщина 16 мм на экране бывает меньше 1 px. */
  minLength?: number;
}

type Project = (p: Vector3) => Vector3;

/** Общая часть: размерная линия по ребру A–B, отнесённая от силуэта (углы cs) наружу. */
function makeAnchor<K extends string>(
  key: K,
  A: Vector3,
  B: Vector3,
  cs: Vector3[],
  c: Pt,
  p: { gap: number; over: number; extGap: number; tick: number; minLength: number; behind: boolean; offset: LabelOffset },
  normalHint?: Pt,
): DimensionAnchor<K> {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  let nx = len > 1e-6 ? -dy / len : 0;
  let ny = len > 1e-6 ? dx / len : -1;
  const mx = (A.x + B.x) / 2;
  const my = (A.y + B.y) / 2;
  // Нормаль — от центра (или по подсказке, если ребро идёт через центр)
  const side = (mx - c[0]) * nx + (my - c[1]) * ny;
  const flip = Math.abs(side) > 0.5 || !normalHint ? side < 0 : normalHint[0] * nx + normalHint[1] * ny < 0;
  if (flip) {
    nx = -nx;
    ny = -ny;
  }
  // Отнести линию за силуэт (все углы по эту сторону)
  let off = 0;
  for (const q of cs) off = Math.max(off, (q.x - A.x) * nx + (q.y - A.y) * ny);
  off += p.gap;
  const a: Pt = [A.x + nx * off, A.y + ny * off];
  const b: Pt = [B.x + nx * off, B.y + ny * off];
  const ux = len > 1e-6 ? dx / len : 1;
  const uy = len > 1e-6 ? dy / len : 0;
  // Засечка 45°: между направлением линии и нормалью
  const tx = ((ux + nx) / Math.SQRT2) * p.tick;
  const ty = ((uy + ny) / Math.SQRT2) * p.tick;
  let label: Pt;
  if (p.offset === 'end') {
    const sx = nx < 0 ? -1 : 1;
    const e = (a[0] - b[0]) * sx >= 0 ? a : b;
    label = [e[0] + sx * (PILL_HALF[0] + 4), e[1]];
  } else {
    const lo = p.offset === 'beside' ? Math.abs(nx) * PILL_HALF[0] + Math.abs(ny) * PILL_HALF[1] + 3 : p.offset;
    label = [(a[0] + b[0]) / 2 + nx * lo, (a[1] + b[1]) / 2 + ny * lo];
  }
  return {
    key,
    visible: !p.behind && len >= p.minLength,
    a,
    b,
    edgeA: [A.x, A.y],
    edgeB: [B.x, B.y],
    ext: [
      [A.x + nx * p.extGap, A.y + ny * p.extGap, a[0] + nx * p.over, a[1] + ny * p.over],
      [B.x + nx * p.extGap, B.y + ny * p.extGap, b[0] + nx * p.over, b[1] + ny * p.over],
    ],
    ticks: [
      [a[0] - tx, a[1] - ty, a[0] + tx, a[1] + ty],
      [b[0] - tx, b[1] - ty, b[0] + tx, b[1] + ty],
    ],
    label,
    normal: [nx, ny],
    angle: Math.atan2(dy, dx),
    length: len,
  };
}

function params<K extends string>(opts: AnchorOptions<K>, minLength: number) {
  return {
    gap: opts.gap ?? 14,
    over: opts.overshoot ?? 5,
    extGap: opts.extGap ?? 3,
    tick: opts.tick ?? 4,
    minLength: opts.minLength ?? minLength,
  };
}

function offsetOf<K extends string>(opts: AnchorOptions<K>, key: K, fallback: LabelOffset): LabelOffset {
  const lo = opts.labelOffset;
  if (lo === undefined) return fallback;
  if (typeof lo === 'number' || lo === 'beside' || lo === 'end') return lo as LabelOffset;
  return (lo as Partial<Record<K, LabelOffset>>)[key] ?? fallback;
}

const centerOf = (cs: Vector3[]): Pt => [cs.reduce((s, q) => s + q.x, 0) / cs.length, cs.reduce((s, q) => s + q.y, 0) / cs.length];
const isBehind = (cs: Vector3[]) => cs.some((q) => q.z > 1 || q.z < -1);

/**
 * Точки размеров по габариту (единицы сцены) и проекции в px (`project` → x, y, z как у Vector3.project, но в px).
 * `viewDir` — от изделия к камере: по нему выбираем ребро глубины (левое, на силуэте).
 */
export function dimensionAnchors(bounds: Box3, project: Project, viewDir: Vector3, opts: AnchorOptions = {}): DimensionAnchors {
  const base = params(opts, 18);
  const { min, max } = bounds;
  const P = (x: number, y: number, z: number) => project(new Vector3(x, y, z));
  const cs: Vector3[] = [];
  for (let i = 0; i < 8; i++) cs.push(P(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
  const behind = isBehind(cs);
  const c = centerOf(cs);
  const make = (key: DimensionKey, A: Vector3, B: Vector3) =>
    makeAnchor(key, A, B, cs, c, { ...base, behind, offset: offsetOf(opts, key, DEFAULT_LABEL_OFFSET[key]) });

  // Ширина: из двух верхних рёбер вдоль X — то, что выше на экране
  const wf = [P(min.x, max.y, max.z), P(max.x, max.y, max.z)] as const;
  const wb = [P(min.x, max.y, min.z), P(max.x, max.y, min.z)] as const;
  const wEdge = (wf[0].y + wf[1].y) / 2 <= (wb[0].y + wb[1].y) / 2 ? wf : wb;
  // Высота: из четырёх вертикальных рёбер — самое правое на экране
  let hEdge: [Vector3, Vector3] | null = null;
  for (const x of [min.x, max.x]) {
    for (const z of [min.z, max.z]) {
      const e: [Vector3, Vector3] = [P(x, min.y, z), P(x, max.y, z)];
      if (!hEdge || e[0].x + e[1].x > hEdge[0].x + hEdge[1].x) hEdge = e;
    }
  }
  // Глубина — слева (справа место занято высотой): левое ребро вглубь, то, что на силуэте.
  // Камера справа сверху — верхнее левое (левая боковина не видна), слева сверху — нижнее ребро видимой левой боковины.
  const sy = viewDir.x >= 0 === viewDir.y >= 0 ? max.y : min.y;
  const d0 = P(min.x, sy, max.z);
  const d1 = P(min.x, sy, min.z);
  return {
    width: make('width', wEdge[0], wEdge[1]),
    height: make('height', hEdge![0], hEdge![1]),
    depth: make('depth', d0, d1),
  };
}

/** Куда предпочтительно выносить размер детали при равных рёбрах: длина — вверх, ширина — влево, толщина — вправо. */
const PART_PREFER: Record<PartDimensionKey, Pt> = { length: [0, -1], width: [-1, 0], thickness: [0.9, 0.45] };
const PART_BIT: Record<PartDimensionKey, number> = { length: 1, width: 2, thickness: 4 };

/**
 * Точки размеров детали: `corners` — 8 углов её коробки в сцене, бит 0 индекса — длина (локальная x), бит 1 — ширина (y),
 * бит 2 — толщина (z) (см. ProductScene.partBox). Для каждой оси из четырёх параллельных рёбер берём ребро силуэта —
 * дальнее от центра по своей нормали; при равенстве — по предпочтению стороны (длина сверху, ширина слева, толщина справа).
 */
export function partAnchors(corners: readonly Vector3[], project: Project, opts: AnchorOptions<PartDimensionKey> = {}): PartDimensionAnchors {
  const base = params(opts, 0);
  const cs = corners.map((q) => project(q.clone()));
  const behind = isBehind(cs);
  const c = centerOf(cs);
  const out = {} as PartDimensionAnchors;
  for (const key of ['length', 'width', 'thickness'] as const) {
    const bit = PART_BIT[key];
    const pref = PART_PREFER[key];
    let best: { score: number; i: number } | null = null;
    for (let i = 0; i < 8; i++) {
      if (i & bit) continue;
      const A = cs[i]!;
      const B = cs[i | bit]!;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len;
      let ny = dx / len;
      const mx = (A.x + B.x) / 2 - c[0];
      const my = (A.y + B.y) / 2 - c[1];
      let side = mx * nx + my * ny;
      if (Math.abs(side) <= 0.5) side = (pref[0] * nx + pref[1] * ny) * 0.5; // ребро через центр — по предпочтению
      if (side < 0) {
        nx = -nx;
        ny = -ny;
        side = -side;
      }
      const score = side + 8 * (nx * pref[0] + ny * pref[1]);
      if (!best || score > best.score + 1e-6) best = { score, i };
    }
    const i = best!.i;
    out[key] = makeAnchor(key, cs[i]!, cs[i | bit]!, cs, c, { ...base, behind, offset: offsetOf(opts, key, 'beside') }, pref);
  }
  return out;
}

/** Поля вокруг изделия (px) под размерные линии и плашки — для вписывания (ViewRig.setContent). Симметричные: изделие по центру. */
export const DIMENSION_MARGINS = { top: 38, right: 76, bottom: 38, left: 76 } as const;
/** Поля вокруг детали в фокусе (ViewRig.focusPart): размеры детали бывают с любой стороны. */
export const PART_MARGINS = { top: 52, right: 64, bottom: 52, left: 64 } as const;
