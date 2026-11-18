/**
 * Дерево изделия на телефоне — те же команды, что в ядре (oyna_core/commands.py), чтобы замер и редактор
 * работали без сети. Онлайн те же команды уходят на сервер (POST …/positions/{id}/commands) и сервер считает
 * проверки и цену. Каждая команда возвращает НОВЫЙ документ.
 */
import type { Cell, Command, Doc, Node, Part } from '@/api/types';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const isLeaf = (n: Node) => !!n.cell;
const child = (p: Part): Node => (p.cell ? (p as Node) : (p.node as Node));

export function nodeAt(doc: Doc, path: string): Node {
  let n = doc.frame.root;
  for (const i of path.split('.').filter((x) => x !== '')) {
    if (!n.parts) throw new Error(`путь ${path}: дальше листа`);
    n = child(n.parts[Number(i)]);
  }
  return n;
}
export function partAt(doc: Doc, path: string): Part | null {
  if (path === '') return null;
  const i = path.lastIndexOf('.');
  const parent = nodeAt(doc, i < 0 ? '' : path.slice(0, i));
  return parent.parts![Number(path.slice(i + 1))];
}
export function cells(doc: Doc): { path: string; cell: Cell }[] {
  const out: { path: string; cell: Cell }[] = [];
  const rec = (n: Node, p: string) => {
    if (n.cell) { out.push({ path: p, cell: n.cell }); return; }
    (n.parts ?? []).forEach((part, i) => rec(child(part), p ? `${p}.${i}` : String(i)));
  };
  rec(doc.frame.root, '');
  return out;
}

// ---------- раскладка для схемы (по осям, мм от левого верхнего угла) ----------
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Layout = {
  cells: { path: string; cell: Cell; box: Box; sides: Record<'l' | 'r' | 't' | 'b', 'frame' | 'mullion' | 'shtulp' | 'none'> }[];
  mullions: { path: string; orient: 'v' | 'h'; at: number; from: number; to: number }[];
  sizes: Record<string, number[]>;
  error?: string;
};

export function resolveSizes(parts: Part[], total: number): number[] {
  const fixed = parts.filter((p) => typeof p.size === 'number').reduce((a, p) => a + (p.size as number), 0);
  const nEq = parts.filter((p) => typeof p.size !== 'number').length;
  if (!nEq) return parts.map((p) => p.size as number);
  const eq = (total - fixed) / nEq;
  return parts.map((p) => (typeof p.size === 'number' ? p.size : eq));
}

export function layout(doc: Doc): Layout {
  const out: Layout = { cells: [], mullions: [], sizes: {} };
  const W = doc.frame.w, H = doc.frame.h;
  const rec = (n: Node, path: string, b: Box, sides: Layout['cells'][0]['sides']) => {
    if (n.cell) { out.cells.push({ path, cell: n.cell, box: b, sides }); return; }
    const parts = n.parts ?? [];
    const vertical = n.split !== 'h';
    const total = vertical ? b.x1 - b.x0 : b.y1 - b.y0;
    const sz = resolveSizes(parts, total);
    if (sz.some((x) => x <= 0)) out.error = 'части не помещаются в размер';
    out.sizes[path] = sz;
    const boundary = n.split === 'shtulp' ? 'shtulp' : n.split === 'none' ? 'none' : 'mullion';
    let pos = vertical ? b.x0 : b.y0;
    parts.forEach((part, i) => {
      const s = Math.max(sz[i], 1);
      const p = path ? `${path}.${i}` : String(i);
      const sub: Box = vertical ? { x0: pos, y0: b.y0, x1: pos + s, y1: b.y1 } : { x0: b.x0, y0: pos, x1: b.x1, y1: pos + s };
      const ss = { ...sides };
      if (vertical) { if (i > 0) ss.l = boundary; if (i < parts.length - 1) ss.r = boundary; }
      else { if (i > 0) ss.t = boundary; if (i < parts.length - 1) ss.b = boundary; }
      if (i > 0 && boundary === 'mullion') {
        out.mullions.push(vertical ? { path, orient: 'v', at: pos, from: b.y0, to: b.y1 } : { path, orient: 'h', at: pos, from: b.x0, to: b.x1 });
      }
      rec(child(part), p, sub, ss);
      pos += s;
    });
  };
  rec(doc.frame.root, '', { x0: 0, y0: 0, x1: W, y1: H }, { l: 'frame', r: 'frame', t: 'frame', b: 'frame' });
  return out;
}

// ---------- команды (как в ядре) ----------
export const cmd = {
  set_size(doc: Doc, a: { w?: number; h?: number }): Doc {
    const d = clone(doc);
    if (a.w !== undefined) d.frame.w = a.w;
    if (a.h !== undefined) d.frame.h = a.h;
    return d;
  },
  split(doc: Doc, a: { path: string; dir: 'v' | 'h' | 'shtulp'; n?: number; sizes?: (number | 'eq')[] }): Doc {
    const d = clone(doc);
    const n = a.n ?? 2;
    const node = nodeAt(d, a.path);
    if (!node.cell) throw new Error('узел уже разделён');
    const base = node.cell;
    const sizes = a.sizes ?? Array(n).fill('eq');
    const parts: Part[] = Array.from({ length: n }, (_, i) => ({
      size: sizes[i],
      cell: a.dir === 'shtulp'
        ? { type: 'sash', open: i === 0 ? 'turn' : 'tilt_turn', hinge: i === 0 ? 'left' : 'right', handle: true }
        : i === 0 ? { ...base } : { type: 'fixed' },
    }));
    const fresh: Node = { split: a.dir, parts };
    const part = partAt(d, a.path);
    if (!part) { delete (node as Node).cell; Object.assign(node, fresh); }
    else { delete part.cell; part.node = fresh; }
    return d;
  },
  merge(doc: Doc, a: { path: string }): Doc {
    const d = clone(doc);
    const node = nodeAt(d, a.path);
    if (node.cell) throw new Error('объединять нечего');
    const first = node.parts![0];
    const c: Cell = first.cell ?? { type: 'fixed' };
    const part = partAt(d, a.path);
    if (!part) { delete node.split; delete node.parts; node.cell = c; }
    else { delete part.node; part.cell = c; }
    return d;
  },
  set_part_size(doc: Doc, a: { path: string; size: number | 'eq' }): Doc {
    const d = clone(doc);
    const part = partAt(d, a.path);
    if (!part) throw new Error('у корня нет размера части');
    part.size = a.size;
    return d;
  },
  set_cell(doc: Doc, a: { path: string } & Partial<Cell>): Doc {
    const d = clone(doc);
    const { path, ...props } = a;
    const node = nodeAt(d, path);
    if (!node.cell) throw new Error('свойства задаются ячейке');
    const c = Object.assign(node.cell, props);
    if (c.type === 'fixed' || c.type === 'panel') {
      delete c.open; delete c.hinge; delete c.handle;
      if (!('mosquito' in props)) delete c.mosquito;
    } else {
      c.open ??= 'tilt_turn'; c.hinge ??= 'left'; c.handle ??= true;
    }
    return d;
  },
  set_fill(doc: Doc, a: { path: string; fill: Cell['fill'] | null }): Doc {
    const d = clone(doc);
    const node = nodeAt(d, a.path);
    if (!node.cell) throw new Error('заполнение задаётся ячейке');
    if (a.fill) node.cell.fill = a.fill; else delete node.cell.fill;
    return d;
  },
  set_setup(doc: Doc, a: Record<string, unknown>): Doc {
    const d = clone(doc);
    const s = (d.setup ??= {});
    if (a.system && a.system !== s.system && !('fittings' in a)) delete s.fittings;
    Object.assign(s, a);
    return d;
  },
  set_option(doc: Doc, a: { group: string; code: string | null; path?: string | null }): Doc {
    const d = clone(doc);
    const opts = a.path == null ? ((d.setup ??= {}).options ??= {}) : ((nodeAt(d, a.path).cell!.options ??= {}));
    if (a.code === null) delete opts[a.group]; else opts[a.group] = a.code;
    return d;
  },
  set_extras(doc: Doc, a: Record<string, unknown>): Doc {
    const d = clone(doc);
    d.extras = { ...(d.extras ?? {}), ...a };
    return d;
  },
  mirror(doc: Doc): Doc {
    const d = clone(doc);
    const sw: Record<string, 'left' | 'right'> = { left: 'right', right: 'left' };
    const rec = (n: Node) => {
      if (n.cell) { if (n.cell.hinge && sw[n.cell.hinge]) n.cell.hinge = sw[n.cell.hinge]; return; }
      if (n.split !== 'h') n.parts!.reverse();
      n.parts!.forEach((p) => rec(child(p)));
    };
    rec(d.frame.root);
    return d;
  },
  accept_warning(doc: Doc, a: { rule: string; user?: string; path?: string }): Doc {
    const d = clone(doc);
    (d.accepted_warnings ??= []).push({ rule: a.rule, path: a.path ?? '', by: a.user ?? 'phone', at: new Date().toISOString() });
    return d;
  },
  unaccept_warning(doc: Doc, a: { rule: string; path?: string }): Doc {
    const d = clone(doc);
    d.accepted_warnings = (d.accepted_warnings ?? []).filter((x) => !(x.rule === a.rule && (x.path ?? '') === (a.path ?? '')));
    return d;
  },
  set_qty(doc: Doc, a: { qty: number }): Doc { const d = clone(doc); d.qty = a.qty; return d; },
  set_meta(doc: Doc, a: { room?: string; kind?: Doc['kind']; opening?: Doc['opening'] }): Doc {
    const d = clone(doc);
    if (a.opening) d.opening = { ...(d.opening ?? {}), ...a.opening };
    if (a.room !== undefined) d.room = a.room;
    if (a.kind) d.kind = a.kind;
    return d;
  },
};

export function apply(doc: Doc, commands: Command[]): Doc {
  return commands.reduce((d, c) => {
    const { cmd: name, ...args } = c;
    const f = (cmd as Record<string, (d: Doc, a: never) => Doc>)[name];
    if (!f) throw new Error(`нет команды ${name}`);
    return f(d, args as never);
  }, doc);
}

/** Простое окно без сети: шаблоны с сервера, а это — запасной вариант для мастера замера (1–4 створки). */
export function simpleWindow(w: number, h: number, leaves: number, transom = false): Doc {
  const leaf = (i: number): Cell => (i === 0 ? { type: 'sash', open: 'tilt_turn', hinge: 'left', handle: true, mosquito: true } : { type: 'fixed' });
  let root: Node = leaves <= 1 ? { cell: leaf(0) } : { split: 'v', parts: Array.from({ length: leaves }, (_, i) => ({ size: 'eq' as const, cell: leaf(i) })) };
  if (transom) root = { split: 'h', parts: [{ size: 500, cell: { type: 'sash', open: 'tilt', hinge: 'bottom', handle: true } }, { size: 'eq', node: root }] };
  return { kind: 'window', qty: 1, frame: { w, h, shape: 'rect', root }, extras: {}, accepted_warnings: [] };
}
