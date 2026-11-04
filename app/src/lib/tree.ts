/** Работа с деревом модулей в редакторе: какие поля показывать, «оценка», связь детали с секцией. */
import type { ProductTree } from '../api/types';
import { getAt } from './jsonPatch';

export interface ParamField {
  pointer: string;
  /** ключ словаря i18n для подписи */
  label: 'p_width' | 'p_height' | 'p_depth' | 'p_mezzanine' | 'p_section_width' | 'p_shelves' | 'p_drawers' | 'p_doors' | 'p_sliding_doors';
  index?: number;
  value: number | null;
  min: number;
  max: number;
  step: number;
  /** null допускается: «авто» (ширина секции делится поровну) */
  nullable?: boolean;
}

export function paramFields(tree: ProductTree): ParamField[] {
  const f: ParamField[] = [];
  if (tree.type === 'kitchen') {
    // У кухни свой редактор (SCR-37, не в MVP) — только общие размеры, если они есть.
  }
  const dims: [string, ParamField['label'], number, number][] = [
    ['/width', 'p_width', 300, 6000],
    ['/height', 'p_height', 300, 3200],
    ['/depth', 'p_depth', 200, 1000],
  ];
  for (const [ptr, label, min, max] of dims) {
    const v = getAt(tree, ptr);
    if (typeof v === 'number') f.push({ pointer: ptr, label, value: v, min, max, step: 10 });
  }
  if (tree.mezzanine && typeof tree.mezzanine.height === 'number') {
    f.push({ pointer: '/mezzanine/height', label: 'p_mezzanine', value: tree.mezzanine.height, min: 200, max: 900, step: 10 });
  }
  if (tree.sliding_doors && typeof tree.sliding_doors.count === 'number') {
    f.push({ pointer: '/sliding_doors/count', label: 'p_sliding_doors', value: tree.sliding_doors.count, min: 2, max: 6, step: 1 });
  }
  return f;
}

export function sectionFields(tree: ProductTree, i: number): ParamField[] {
  const s = tree.sections?.[i];
  if (!s) return [];
  const f: ParamField[] = [
    { pointer: `/sections/${i}/width`, label: 'p_section_width', index: i, value: s.width ?? null, min: 150, max: 1500, step: 10, nullable: true },
  ];
  (s.fill ?? []).forEach((z, j) => {
    if ((z.kind === 'shelves' || z.kind === 'drawers') && 'count' in z) {
      f.push({
        pointer: `/sections/${i}/fill/${j}/count`,
        label: z.kind === 'shelves' ? 'p_shelves' : 'p_drawers',
        index: i,
        value: typeof z.count === 'number' ? z.count : 1,
        min: 1,
        max: z.kind === 'shelves' ? 10 : 6,
        step: 1,
      });
    }
  });
  if (s.doors) f.push({ pointer: `/sections/${i}/doors/count`, label: 'p_doors', index: i, value: s.doors.count ?? 1, min: 1, max: 2, step: 1 });
  return f;
}

/** Номер секции по ключу детали («sections[1].fill[0].drawer[2].side.left» → 1). */
export function sectionOfPart(key: string): number | null {
  const m = /sections\[(\d+)\]/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Значение помечено «оценка», если указатель или его родитель есть в списке. */
export function isEstimated(pointer: string, estimated: Iterable<string>): boolean {
  for (const e of estimated) if (pointer === e || pointer.startsWith(e.endsWith('/') ? e : `${e}/`)) return true;
  return false;
}

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/** Пути «оценка» без подтверждённых мастером (тот же путь, предок или потомок — как на сервере). */
export function withoutConfirmed(estimated: readonly string[], confirmed: readonly string[]): string[] {
  const related = (a: string, b: string) => a === b || a.startsWith(`${b.replace(/\/$/, '')}/`) || b.startsWith(`${a.replace(/\/$/, '')}/`);
  return estimated.filter((p) => !confirmed.some((c) => related(p, c)));
}
