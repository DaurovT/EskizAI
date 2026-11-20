/**
 * Размеры частей окна для нажимаемых плашек (v3: X5Dim, X4Split) — работает без сети, только командами ядра
 * (set_part_size, set_size), чтобы на сервере получилось то же самое.
 * - ввод ширины (высоты) части: часть становится числом, «поровну» пересчитываются; если «поровну» не осталось — сосед;
 * - «Створки поровну» — все части узла 'eq';
 * - «Стёкла поровну» — видимые стёкла частей одинаковые с учётом профиля створки (ПРИБЛИЖЕНИЕ: по рисунку схемы —
 *   те же константы, что Schema.tsx, а не по паспорту системы; узел внутри части считается одной частью).
 * - rescaleParts — после нового габарита на замере числовые части, которые больше не помещаются, растягиваются пропорционально.
 */
import type { Command, Doc, Node, Part } from '@/api/types';
import { num } from './format';
import { apply, cells, joinPath, layout, nodeAt, parentOf, splitPath, type Layout } from './tree';

// ---------- константы рисунка (Schema.tsx берёт их отсюда) ----------
/** видимая ширина рамы на рисунке, мм (паспорт ПВХ ~60) */
export const FRAME_MM = 64;
/** ширина профиля створки на рисунке, мм */
export const SASH_MM = 70;
/** стекло створки отступает от края створки на SASH_MM × SASH_GLASS_K */
export const SASH_GLASS_K = 0.6;
/** отступ ячейки от оси импоста на рисунке, мм */
export const MULLION_MM = 42;
/** уже этого часть не делаем (мм) — подсказка до сервера; настоящие пределы проверяет сервер */
export const MIN_PART_MM = 100;

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const insetOf = (side: string) => (side === 'frame' ? FRAME_MM : side === 'mullion' ? MULLION_MM : 0);
const isOpen = (t?: string) => t === 'sash' || t === 'door_sash';

export type Axis = 'w' | 'h';
/** что меняет плашка: часть узла (путь части) или габарит рамы ('' — окно, «A1/» — рама сборки, axis h без рамы — вся сборка) */
export type DimTarget = { kind: 'part'; path: string } | { kind: 'frame'; axis: Axis; prefix: string };

export type PartInfo = { parent: string; index: number; axis: Axis; parts: Part[]; sizes: number[]; total: number };

/** Часть узла по пути: родитель, номер, ось, размеры всех частей (мм). Корень окна — null. */
export function partInfo(doc: Doc, path: string, L: Layout = layout(doc)): PartInfo | null {
  if (splitPath(path).sub === '') return null;
  const parent = parentOf(path);
  let node: Node;
  try { node = nodeAt(doc, parent); } catch { return null; }
  if (!node.parts?.length) return null;
  const sizes = L.sizes[parent];
  if (!sizes) return null;
  const sub = splitPath(path).sub;
  const index = Number(sub.slice(sub.lastIndexOf('.') + 1));
  const axis: Axis = node.split === 'h' || node.split === 'vslide' ? 'h' : 'w';
  return { parent, index, axis, parts: node.parts, sizes, total: sizes.reduce((a, b) => a + b, 0) };
}

/** Путь части i родителя */
const partPath = (parent: string, i: number) => joinPath(parent, i);

/** Ячейки внутри части (сама часть-ячейка или все листья её узла) */
function cellsOf(L: Layout, p: string) {
  return L.cells.filter((c) => c.path === p || c.path.startsWith(`${p}.`));
}

// ---------- подписи ----------
const GEN: Record<string, string> = { sash: 'створки', door_sash: 'двери', fixed: 'глухой', panel: 'панели' };
const NOM: Record<string, string> = { sash: 'створка', door_sash: 'дверь', fixed: 'глухая', panel: 'панель' };

/** «створка 2» / «глухая 3» / «часть 2» (номер — как «Створка 1» на схеме: слева направо, сверху вниз) */
export function partName(doc: Doc, path: string, form: 'nom' | 'gen' = 'nom'): string {
  let n: Node | null = null;
  try { n = nodeAt(doc, path); } catch { n = null; }
  const list = cells(doc);
  if (n?.cell) {
    const i = list.findIndex((c) => c.path === path);
    return `${(form === 'gen' ? GEN : NOM)[n.cell.type] ?? (form === 'gen' ? 'части' : 'часть')} ${i + 1}`;
  }
  const info = partInfo(doc, path);
  return `${form === 'gen' ? 'части' : 'часть'} ${(info?.index ?? 0) + 1}`;
}

/** Заголовок листа: «Ширина створки 1», «Высота окна», «Ширина рамы 2». */
export function dimTitle(doc: Doc, t: DimTarget): string {
  if (t.kind === 'frame') {
    const f = splitPath(t.prefix).frame;
    const what = f === null ? (t.prefix === '' && doc.frame.root.assembly ? 'изделия' : 'окна') : `рамы ${f + 1}`;
    return `${t.axis === 'w' ? 'Ширина' : 'Высота'} ${what}`;
  }
  const info = partInfo(doc, t.path);
  return `${info?.axis === 'h' ? 'Высота' : 'Ширина'} ${partName(doc, t.path, 'gen')}`;
}

/** Текущее значение плашки, мм */
export function dimValue(doc: Doc, t: DimTarget): number {
  if (t.kind === 'part') {
    const info = partInfo(doc, t.path);
    return info ? Math.round(info.sizes[info.index]) : 0;
  }
  const L = layout(doc);
  const f = splitPath(t.prefix).frame;
  if (L.frames?.length) {
    if (f === null) return t.axis === 'h' ? Math.max(...L.frames.map((x) => x.h)) : L.frames.reduce((a, x) => a + x.w, 0);
    const fr = L.frames[f];
    return fr ? (t.axis === 'w' ? fr.w : fr.h) : 0;
  }
  return t.axis === 'w' ? doc.frame.w : doc.frame.h;
}

// ---------- ввод размера ----------
export type DimResult = {
  commands: Command[];
  /** документ после команд (для живой схемы во время ввода) */
  doc: Doc | null;
  /** части того же узла, которые поменялись: номер → новый размер */
  changed: { index: number; size: number }[];
  /** «створка 2 станет 750» */
  note: string;
  error?: string;
};

/** Часть path = value мм. Есть другие «поровну» — пересчитаются они; нет — сосед справа (у последней — слева) становится «поровну». */
export function partSizeCommands(doc: Doc, path: string, value: number): DimResult {
  const L0 = layout(doc);
  const info = partInfo(doc, path, L0);
  if (!info) return { commands: [], doc: null, changed: [], note: '', error: 'у этой части нет своего размера' };
  if (!(value > 0)) return { commands: [], doc: null, changed: [], note: '', error: 'введите размер в мм' };
  const { parent, index, parts } = info;
  const commands: Command[] = [{ cmd: 'set_part_size', path, size: value }];
  const othersEq = parts.some((p, k) => k !== index && typeof p.size !== 'number');
  if (!othersEq) {
    const j = index + 1 < parts.length ? index + 1 : index - 1;
    commands.push({ cmd: 'set_part_size', path: partPath(parent, j), size: 'eq' });
  }
  return finish(doc, info, commands, value);
}

function finish(doc: Doc, info: PartInfo, commands: Command[], value?: number): DimResult {
  let next: Doc;
  try { next = apply(doc, commands); } catch (e) {
    return { commands: [], doc: null, changed: [], note: '', error: e instanceof Error ? e.message : 'не получилось' };
  }
  const L1 = layout(next);
  const sizes = L1.sizes[info.parent] ?? [];
  const changed = sizes.map((s, k) => ({ index: k, size: Math.round(s) }))
    .filter((x) => x.index !== info.index || value === undefined)
    .filter((x) => Math.abs(x.size - Math.round(info.sizes[x.index] ?? 0)) >= 1);
  const name = (k: number) => partName(doc, partPath(info.parent, k));
  const tooSmall = sizes.map((s, k) => ({ s, k })).filter((x) => x.s < MIN_PART_MM);
  let error: string | undefined;
  if (L1.error || tooSmall.length) {
    const k = tooSmall.find((x) => x.k !== info.index)?.k ?? tooSmall[0]?.k;
    error = k !== undefined ? `${cap(name(k))} станет ${Math.round(sizes[k])} — не помещается` : `не помещается в ${Math.round(info.total)} мм`;
  }
  const note = changed.filter((x) => x.index !== info.index).map((x) => `${name(x.index)} станет ${num(x.size)}`).join(', ');
  return { commands, doc: next, changed, note, error };
}

/** «Створки поровну»: все части узла — 'eq'. */
export function equalPartsCommands(doc: Doc, path: string): DimResult {
  const info = partInfo(doc, path);
  if (!info) return { commands: [], doc: null, changed: [], note: '', error: 'нечего делить' };
  const commands: Command[] = info.parts
    .map((p, k) => (typeof p.size === 'number' ? { cmd: 'set_part_size', path: partPath(info.parent, k), size: 'eq' } : null))
    .filter(Boolean) as Command[];
  return finish(doc, info, commands);
}

/**
 * Постоянная части для «стёкол поровну»: сколько мм её ширины (высоты) не стекло.
 * По рисунку схемы: рама FRAME_MM, импост MULLION_MM с каждой стороны, у створки ещё SASH_MM × SASH_GLASS_K с двух сторон.
 * ПРИБЛИЖЕНИЕ: реальные профили — в паспорте системы; узел внутри части — как одна часть (створка, если хоть один лист во всю ширину открывается).
 */
export function glassAllowance(L: Layout, parent: string, k: number, axis: Axis): number {
  const list = cellsOf(L, partPath(parent, k));
  if (!list.length) return 0;
  const lo = axis === 'w' ? (c: typeof list[0]) => c.box.x0 : (c: typeof list[0]) => c.box.y0;
  const hi = axis === 'w' ? (c: typeof list[0]) => c.box.x1 : (c: typeof list[0]) => c.box.y1;
  const first = list.reduce((a, c) => (lo(c) < lo(a) ? c : a));
  const last = list.reduce((a, c) => (hi(c) > hi(a) ? c : a));
  const a = insetOf(axis === 'w' ? first.sides.l : first.sides.t);
  const b = insetOf(axis === 'w' ? last.sides.r : last.sides.b);
  const from = Math.min(...list.map(lo)), to = Math.max(...list.map(hi));
  const spanning = list.filter((c) => Math.abs(lo(c) - from) < 0.5 && Math.abs(hi(c) - to) < 0.5);
  const open = spanning.some((c) => isOpen(c.cell.type));
  return a + b + (open ? 2 * SASH_MM * SASH_GLASS_K : 0);
}

/** «Стёкла поровну»: размеры частей так, чтобы видимое стекло у створок и глухих было одинаковым; последняя часть — 'eq'. */
export function equalGlassCommands(doc: Doc, path: string): DimResult & { glass?: number } {
  const L = layout(doc);
  const info = partInfo(doc, path, L);
  if (!info) return { commands: [], doc: null, changed: [], note: '', error: 'нечего делить' };
  const n = info.parts.length;
  const allow = info.parts.map((_, k) => glassAllowance(L, info.parent, k, info.axis));
  const glass = (info.total - allow.reduce((a, b) => a + b, 0)) / n;
  if (!(glass > 0)) return { commands: [], doc: null, changed: [], note: '', error: 'стёкла не помещаются' };
  const sizes = allow.map((c) => Math.round(glass + c));
  const commands: Command[] = sizes.map((s, k) => ({ cmd: 'set_part_size', path: partPath(info.parent, k), size: k === n - 1 ? 'eq' : s }));
  return { ...finish(doc, info, commands), glass: Math.round(glass) };
}

/** Габарит рамы (окно, рама сборки; высота без рамы — всем рамам сборки). */
export function frameSizeCommands(doc: Doc, t: Extract<DimTarget, { kind: 'frame' }>, value: number): DimResult {
  if (!(value > 0)) return { commands: [], doc: null, changed: [], note: '', error: 'введите размер в мм' };
  const commands: Command[] = [{ cmd: 'set_size', [t.axis]: value, ...(t.prefix ? { path: t.prefix } : {}) }];
  let next: Doc;
  try { next = apply(doc, commands); } catch (e) {
    return { commands: [], doc: null, changed: [], note: '', error: e instanceof Error ? e.message : 'не получилось' };
  }
  const L = layout(next);
  const error = L.error ? 'части не помещаются в этот размер' : undefined;
  return { commands, doc: next, changed: [], note: '', error };
}

// ---------- новый габарит на замере ----------
/**
 * После set_size: если числовые части больше не помещаются (или часть уже MIN_PART_MM), числовые размеры
 * узла растягиваются пропорционально новому габариту (кратно 5 мм). Возвращает команды set_part_size (может быть пусто).
 */
export function rescaleParts(before: Doc, after: Doc): Command[] {
  const L0 = layout(before), L1 = layout(after);
  const out: Command[] = [];
  const walk = (n0: Node, n1: Node, path: string) => {
    if (!n1.parts?.length || !n0.parts) return;
    const s0 = L0.sizes[path], s1 = L1.sizes[path];
    if (s0 && s1) {
      const t0 = s0.reduce((a, b) => a + b, 0), t1 = s1.reduce((a, b) => a + b, 0);
      const bad = s1.some((x) => x < MIN_PART_MM);
      if (bad && t0 > 0 && Math.abs(t1 - t0) > 0.5) {
        n1.parts.forEach((p, k) => {
          if (typeof p.size === 'number') out.push({ cmd: 'set_part_size', path: partPath(path, k), size: Math.max(5, Math.round((p.size * t1) / t0 / 5) * 5) });
        });
      }
    }
    n1.parts.forEach((p, k) => {
      const a = n0.parts?.[k]?.node;
      if (p.node && a) walk(a, p.node, partPath(path, k));
    });
  };
  if (!before.frame.root.assembly && !after.frame.root.assembly) walk(clone(before.frame.root), clone(after.frame.root), '');
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- «Сделать 3 створки» (X5Err) ----------
const CELL_KEYS = ['type', 'open', 'hinge', 'handle', 'mosquito', 'note', 'open_dir', 'threshold', 'vent', 'slide', 'tilt_clean'] as const;

/**
 * Узел из n ячеек «поровну» → n2 ячеек «поровну»: выбранная ячейка повторяется справа (новые — её копии), остальные как были.
 * Командами ядра: merge → split → set_cell (+ set_fill, set_muntins, set_option), чтобы сервер получил то же самое.
 * null — узел не простой (вложенные узлы, числовые размеры) — тогда решение «разделить ячейку».
 */
export function addPartsCommands(doc: Doc, path: string, n2: number): Command[] | null {
  if (splitPath(path).sub === '') return null;
  const parent = parentOf(path);
  let node: Node;
  try { node = nodeAt(doc, parent); } catch { return null; }
  const parts = node.parts ?? [];
  if (node.split !== 'v' || !parts.length || n2 <= parts.length || !parts.every((p) => p.cell && typeof p.size !== 'number')) return null;
  const sub = splitPath(path).sub;
  const idx = Number(sub.slice(sub.lastIndexOf('.') + 1));
  const list = parts.map((p) => p.cell!);
  const extra = Array.from({ length: n2 - parts.length }, () => clone(list[idx]));
  const next = [...list.slice(0, idx + 1), ...extra, ...list.slice(idx + 1)];
  const out: Command[] = [{ cmd: 'merge', path: parent }, { cmd: 'split', path: parent, dir: 'v', n: n2 }];
  next.forEach((c, k) => {
    const p = partPath(parent, k);
    const props: Record<string, unknown> = {};
    for (const key of CELL_KEYS) if (c[key] !== undefined) props[key] = c[key];
    out.push({ cmd: 'set_cell', path: p, ...props });
    if (c.fill) out.push({ cmd: 'set_fill', path: p, fill: c.fill });
    if (c.muntins) out.push({ cmd: 'set_muntins', path: p, muntins: c.muntins });
    for (const [group, code] of Object.entries(c.options ?? {})) out.push({ cmd: 'set_option', group, code, path: p });
  });
  return out;
}
