/** Замер кухни (SCR-13b): начальные значения из дерева и сверка длин рядов со стенами. Расстановку делает сервер. */
import type { KitchenSite, KitchenUtility, KitchenWall, ProductTree, UtilityKind } from '../api/types';

type Cab = { kind?: string; width?: number; corner_shape?: string };

const rowSum = (row: unknown): number =>
  Array.isArray(row) ? (row as Cab[]).reduce((s, c) => s + (typeof c.width === 'number' ? c.width : 0), 0) : 0;

export const isCornerKitchen = (tree: ProductTree | null | undefined) => tree?.type === 'kitchen' && tree.layout === 'corner';

/** С какого расстояния от угла по стене Б начинается второй ряд: Г-образный угловой модуль или кромка столешницы. */
export function rowOffsetB(tree: ProductTree): number {
  const square = ((tree.base as Cab[] | undefined) ?? []).find((c) => c.kind === 'corner' && c.corner_shape === 'square');
  if (square?.width) return square.width;
  const ct = tree.countertop as { depth?: number } | undefined;
  return ct?.depth ?? 600;
}

/** Длины рядов нижних модулей по стенам (стена Б — вместе с углом). */
export function moduleLengths(tree: ProductTree): { a: number; b: number | null } {
  return { a: rowSum(tree.base), b: isCornerKitchen(tree) ? rowOffsetB(tree) + rowSum(tree.base2) : null };
}

/** Начальный замер: прошлый замер из модели (site) или длины рядов. */
export function initialSite(tree: ProductTree): KitchenSite {
  const prev = tree.site as KitchenSite | undefined;
  if (prev && typeof prev.wall_a === 'number') return { ...prev, utilities: [...(prev.utilities ?? [])] };
  const len = moduleLengths(tree);
  return { wall_a: len.a, wall_b: len.b, ceiling: null, window: null, utilities: [] };
}

/** Насколько стена длиннее (+) или короче (−) модулей; null — нечего сравнивать. */
export function wallDiffs(tree: ProductTree, site: KitchenSite): { wall: KitchenWall; diff: number }[] {
  const len = moduleLengths(tree);
  const out: { wall: KitchenWall; diff: number }[] = [];
  if (site.wall_a && Math.abs(site.wall_a - len.a) >= 1) out.push({ wall: 'a', diff: site.wall_a - len.a });
  if (len.b != null && site.wall_b && Math.abs(site.wall_b - len.b) >= 1) out.push({ wall: 'b', diff: site.wall_b - len.b });
  return out;
}

/** Типичная высота вывода по виду (мм от пола) — подставляется при добавлении. */
export const DEFAULT_HEIGHT: Record<UtilityKind, number | null> = { water: 500, sewer: 300, gas: 900, socket: 1100, vent: 2300 };
export const UTILITY_KINDS: UtilityKind[] = ['water', 'sewer', 'gas', 'socket', 'vent'];

export function newUtility(kind: UtilityKind, wall: KitchenWall = 'a'): KitchenUtility {
  return { kind, wall, from_corner: 0, height: DEFAULT_HEIGHT[kind], size: kind === 'vent' ? '200×150' : null };
}

/** Замер для сервера: без пустых полей; у прямой кухни — только стена А. */
export function cleanSite(site: KitchenSite, corner: boolean): KitchenSite {
  const out: KitchenSite = { wall_a: site.wall_a, utilities: site.utilities.map((u) => ({
    kind: u.kind, wall: corner ? u.wall : 'a', from_corner: u.from_corner,
    ...(u.height != null ? { height: u.height } : {}), ...(u.size ? { size: u.size } : {}),
  })) };
  if (corner && site.wall_b) out.wall_b = site.wall_b;
  if (site.ceiling) out.ceiling = site.ceiling;
  if (site.window && site.window.width > 0) out.window = { ...site.window, wall: corner ? site.window.wall : 'a' };
  return out;
}
