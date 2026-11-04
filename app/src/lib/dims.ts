/**
 * Габариты в редакторе: тип изделия, допустимый диапазон с причиной и быстрые значения рядом с текущим.
 * Границ изделия в API нет (ядро проверяет только «> 0» и лист 2800) — пределы по типу заданы здесь.
 */
import type { ProductTree } from '../api/types';

export type DimKey = 'width' | 'height' | 'depth';
export type FurnitureKind = 'wardrobe' | 'wardrobe_sliding' | 'pencil' | 'dresser' | 'tv_stand' | 'rack' | 'hallway' | 'other';

interface Spec { min: number; max: number; step: number; std: number[] }
type Specs = Record<DimKey, Spec>;

/** Самая длинная деталь из листа 2800 с припуском на распил. */
export const SHEET_MAX = 2750;

const SPECS: Record<FurnitureKind, Specs> = {
  wardrobe: {
    width: { min: 400, max: 3000, step: 100, std: [800, 1000, 1200, 1500, 1600, 1800, 2000, 2400] },
    height: { min: 1200, max: SHEET_MAX, step: 100, std: [2000, 2100, 2200, 2400, 2500, 2600, 2700] },
    depth: { min: 300, max: 700, step: 50, std: [450, 500, 550, 600, 650] },
  },
  wardrobe_sliding: {
    width: { min: 1000, max: 4000, step: 100, std: [1200, 1500, 1600, 1800, 2000, 2200, 2400, 2700, 3000] },
    height: { min: 1800, max: SHEET_MAX, step: 100, std: [2200, 2400, 2500, 2600, 2700] },
    depth: { min: 450, max: 750, step: 50, std: [450, 500, 600, 650] },
  },
  pencil: {
    width: { min: 250, max: 1000, step: 50, std: [300, 400, 450, 500, 600, 800] },
    height: { min: 1000, max: SHEET_MAX, step: 100, std: [1600, 1800, 2000, 2100, 2200, 2400] },
    depth: { min: 250, max: 650, step: 50, std: [300, 350, 400, 450, 500, 560, 600] },
  },
  dresser: {
    width: { min: 400, max: 2000, step: 100, std: [600, 800, 900, 1000, 1200, 1400, 1600] },
    height: { min: 500, max: 1400, step: 50, std: [700, 800, 850, 900, 1000, 1100, 1200] },
    depth: { min: 300, max: 650, step: 50, std: [400, 450, 500, 550] },
  },
  tv_stand: {
    width: { min: 600, max: 3000, step: 100, std: [1000, 1200, 1400, 1600, 1800, 2000, 2400] },
    height: { min: 250, max: 800, step: 50, std: [350, 400, 450, 500, 550, 600] },
    depth: { min: 250, max: 600, step: 50, std: [350, 400, 450, 500] },
  },
  rack: {
    width: { min: 300, max: 2800, step: 100, std: [400, 600, 800, 1000, 1200, 1600, 2000] },
    height: { min: 400, max: SHEET_MAX, step: 100, std: [1000, 1200, 1600, 1800, 2000, 2200, 2400] },
    depth: { min: 200, max: 650, step: 50, std: [250, 300, 350, 400, 450] },
  },
  hallway: {
    width: { min: 600, max: 2800, step: 100, std: [800, 1000, 1200, 1500, 1800, 2000] },
    height: { min: 1600, max: SHEET_MAX, step: 100, std: [2000, 2100, 2200, 2400] },
    depth: { min: 300, max: 650, step: 50, std: [350, 400, 450, 500, 600] },
  },
  other: {
    width: { min: 300, max: 6000, step: 100, std: [] },
    height: { min: 300, max: SHEET_MAX, step: 100, std: [] },
    depth: { min: 200, max: 1000, step: 50, std: [] },
  },
};

const HINTED: FurnitureKind[] = ['wardrobe_sliding', 'pencil', 'dresser', 'tv_stand', 'rack', 'hallway'];

/** Тип изделия: подсказка распознавания (кроме общего «шкаф»), иначе по дереву и пропорциям. */
export function furnitureKind(tree: ProductTree, hint?: string | null): FurnitureKind {
  if (hint && (HINTED as string[]).includes(hint)) return hint as FurnitureKind;
  if (tree.sliding_doors) return 'wardrobe_sliding';
  const w = tree.width ?? 0, h = tree.height ?? 0;
  if (!w || !h) return 'other';
  if (h >= 1200 && w <= 900) return 'pencil';
  if (h <= 800 && w >= h * 1.4) return 'tv_stand';
  if (h <= 1400) return 'dresser';
  const secs = tree.sections ?? [];
  if (secs.length && secs.every((s) => !s.doors)) return 'rack';
  return 'wardrobe';
}

/** Причина границы: ключ словаря (dim_r_*) и параметры. */
export interface Reason { key: 'dim_r_kind_min' | 'dim_r_kind_max' | 'dim_r_sheet' | 'dim_r_sliding_min' | 'dim_r_sliding_max' | 'dim_r_sections'; params: Record<string, number> }
export interface DimLimits { min: number; max: number; step: number; minWhy: Reason; maxWhy: Reason }

/** Диапазон размера: тип изделия + лист + двери-купе + число секций. */
export function dimLimits(tree: ProductTree, kind: FurnitureKind, dim: DimKey): DimLimits {
  const sp = SPECS[kind][dim];
  let min = sp.min, max = sp.max;
  let minWhy: Reason = { key: 'dim_r_kind_min', params: { min } };
  let maxWhy: Reason = { key: max === SHEET_MAX && dim === 'height' ? 'dim_r_sheet' : 'dim_r_kind_max', params: { max } };
  if (dim === 'width') {
    const n = tree.sliding_doors?.count;
    if (n) {
      if (n * 450 > min) { min = n * 450; minWhy = { key: 'dim_r_sliding_min', params: { min, n } }; }
      if (n * 1100 < max) { max = n * 1100; maxWhy = { key: 'dim_r_sliding_max', params: { max, n } }; }
    }
    const k = tree.sections?.length ?? 0;
    const bySec = k > 1 ? Math.ceil((k * 150 + (k + 1) * 16) / 10) * 10 : 0;
    if (bySec > min) { min = bySec; minWhy = { key: 'dim_r_sections', params: { min, n: k } }; }
  }
  return { min, max, step: sp.step, minWhy, maxWhy };
}

/** Ошибка ввода: null — можно применять. */
export function checkDim(lim: DimLimits, v: number): Reason | null {
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < lim.min) return lim.minWhy;
  if (v > lim.max) return lim.maxWhy;
  return null;
}

/**
 * Быстрые значения: стандартные размеры типа и шаг сетки вокруг текущего, ближайшие (стандартные — в приоритете),
 * в пределах диапазона, без текущего значения; хотя бы одно меньше и одно больше, если есть куда.
 */
export function quickValues(kind: FurnitureKind, dim: DimKey, current: number, lim: Pick<DimLimits, 'min' | 'max' | 'step'>, n = 4): number[] {
  const sp = SPECS[kind][dim];
  const step = lim.step;
  const base = Math.round(current / step) * step;
  const cand = new Map<number, number>();
  const add = (v: number, w: number) => {
    if (v < lim.min || v > lim.max || Math.abs(v - current) < step / 2) return;
    // при равенстве стандартный размер впереди
    const score = Math.abs(v - current) / w - (w > 1 ? 0.01 : 0);
    if (!cand.has(v) || cand.get(v)! > score) cand.set(v, score);
  };
  // стандартные размеры «ближе» в 4 раза: 1800 → 1600 / 2000 / 2100 / 2200, а не 1700 / 1900
  sp.std.forEach((v) => add(v, 4));
  for (let k = 1; k <= 2; k++) { add(base + k * step, 1); add(base - k * step, 1); }
  const sorted = [...cand.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([v]) => v);
  let pick = sorted.slice(0, n);
  // по обе стороны от текущего
  const below = sorted.find((v) => v < current), above = sorted.find((v) => v > current);
  if (below != null && !pick.some((v) => v < current)) pick = [...pick.slice(0, n - 1), below];
  if (above != null && !pick.some((v) => v > current)) pick = [...pick.slice(0, n - 1), above];
  return pick.sort((a, b) => a - b);
}
