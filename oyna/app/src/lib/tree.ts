/**
 * Дерево изделия на телефоне — те же команды, что в ядре (oyna_core/commands.py), чтобы замер и редактор
 * работали без сети. Онлайн те же команды уходят на сервер (POST …/positions/{id}/commands) и сервер считает
 * проверки и цену. Каждая команда возвращает НОВЫЙ документ.
 *
 * Фигурные рамы, раскладка, подвесное/среднеподвесное, составные изделия — docs/shapes_contract.md:
 * - форма рамы: frame.shape + frame.shape_params, контур — outline(frame) (дуга — ломаная с шагом ≤ 5°);
 * - составное изделие: frame.root.assembly = [рама, стык, рама, …]; пути ячеек — с префиксом рамы «A<i>/».
 * Раздел 11 договора:
 * - раздвижные: корень frame.root.sliding {leaves, rails, overlap_mm, moving, kind, threshold} — полотна внахлёст,
 *   в раскладке — ячейки «0», «1», … (полотна, не узлы дерева), команда set_sliding;
 * - гильотинное окно: узел split 'vslide' (две части сверху вниз), у ячеек open 'vslide', slide, tilt_clean;
 * - гильотина для террас: корень frame.root.guillotine {modules, panels, moving, drive, glass, posts}, ячейки «<модуль>.<полотно>»,
 *   команда set_guillotine; стык сборки corner_free — угол без стойки.
 */
import type {
  AssemblyFrame, AssemblyItem, Cell, Command, Doc, Frame, Guillotine, GuillotineDrive, GuillotineGlass, Joint, JointKind, Muntins, Node, Part,
  Shape, ShapeParams, Sliding, SlidingKind, SlidingThreshold, Template,
} from '@/api/types';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const child = (p: Part): Node => (p.cell ? (p as Node) : (p.node as Node));

// ---------- пути: «1.0» — обычное окно, «A2/1.0» — ячейка третьей рамы сборки, «A2/» — её корень ----------
export type PathRef = { frame: number | null; sub: string };
export function splitPath(path: string): PathRef {
  const m = /^A(\d+)\/(.*)$/.exec(path ?? '');
  return m ? { frame: Number(m[1]), sub: m[2] } : { frame: null, sub: path ?? '' };
}
export const framePrefix = (i: number) => `A${i}/`;
/** путь части i узла parent: '' → «1», «A0/» → «A0/1», «0» → «0.1» */
export const joinPath = (parent: string, i: number) => (parent === '' || parent.endsWith('/') ? `${parent}${i}` : `${parent}.${i}`);
/** родитель: «0.1» → «0», «1» → '', «A0/1.0» → «A0/1», «A0/1» → «A0/» */
export function parentOf(path: string): string {
  const { frame, sub } = splitPath(path);
  const i = sub.lastIndexOf('.');
  return (frame === null ? '' : framePrefix(frame)) + (i < 0 ? '' : sub.slice(0, i));
}
/** номер части в родителе: «0.2» → 2, «A1/3» → 3 */
export function indexOf(path: string): number {
  const { sub } = splitPath(path);
  return Number(sub.slice(sub.lastIndexOf('.') + 1));
}

// ---------- составное изделие ----------
export const isAssembly = (doc: Doc) => Array.isArray(doc.frame?.root?.assembly);
const isJointItem = (x: AssemblyItem): x is Joint => 'joint' in x;

/** Деревья шаблонов (для старых сборок, где рама — id шаблона: {"frame": "T05", "w": 2400}). Заполняет экран шаблонов. */
const TPL: Record<string, { root: Node; w: number; h: number; shape?: string; shape_params?: ShapeParams }> = {};
export function rememberTemplates(list: Template[]) {
  for (const t of list) if (t.root && !t.root.assembly) TPL[t.id] = { root: t.root, w: t.default_w, h: t.default_h, shape: t.shape, shape_params: t.shape_params };
}

function resolveFrame(el: AssemblyFrame, h: number): Frame {
  if (typeof el.frame !== 'string') return el.frame;
  const t = TPL[el.frame];
  return {
    w: el.w ?? t?.w ?? 1000, h: el.h ?? (h || t?.h || 1400), shape: t?.shape ?? 'rect',
    ...(t?.shape_params ? { shape_params: clone(t.shape_params) } : {}),
    root: t ? clone(t.root) : { cell: { type: 'fixed' } },
  };
}
export function normJoint(j: Joint): { joint: JointKind; angle: number } {
  const m = /^angle_?(\d+)$/.exec(String(j.joint));
  if (m) return { joint: 'angle', angle: Number(m[1]) };
  if (j.joint === 'angle') return { joint: 'angle', angle: j.angle ?? 90 };
  if (j.joint === 'post') return { joint: 'post', angle: j.angle ?? 180 };
  if (j.joint === 'corner_free') return { joint: 'corner_free', angle: j.angle ?? 90 };
  return { joint: 'straight', angle: 180 };
}
/** Рамы сборки (строки-шаблоны раскрыты). */
export function asmFrames(doc: Doc): Frame[] {
  const items = doc.frame.root.assembly ?? [];
  return items.filter((x): x is AssemblyFrame => !isJointItem(x)).map((x) => resolveFrame(x, doc.frame.h));
}
/** Стыки сборки: стык i — между рамой i и i+1. */
export function asmJoints(doc: Doc): { joint: JointKind; angle: number }[] {
  return (doc.frame.root.assembly ?? []).filter(isJointItem).map(normJoint);
}
/** Рама i сборки как отдельное окно (для команд и рисунка). */
export function frameDoc(doc: Doc, i: number): Doc {
  const f = asmFrames(doc)[i];
  if (!f) throw new Error(`нет рамы ${i + 1}`);
  return { ...doc, kind: 'window', frame: f };
}
function rebuild(doc: Doc, frames: Frame[], joints: Joint[]): Doc {
  const d = clone(doc);
  const items: AssemblyItem[] = [];
  frames.forEach((f, i) => {
    items.push({ frame: clone(f) });
    if (i < frames.length - 1) items.push(clone(joints[i] ?? { joint: 'straight' }));
  });
  d.frame.root = { assembly: items };
  d.frame.w = frames.reduce((a, f) => a + f.w, 0);
  d.frame.h = frames.reduce((a, f) => Math.max(a, f.h), 0);
  return d;
}
const rawJoints = (doc: Doc): Joint[] => (doc.frame.root.assembly ?? []).filter(isJointItem);

/** Команда над ячейкой с путём: с префиксом A<i>/ — над рамой сборки, иначе над окном. */
function onFrame(doc: Doc, path: string | undefined | null, fn: (d: Doc, sub: string) => Doc): Doc {
  const { frame, sub } = splitPath(path ?? '');
  if (frame === null) return fn(doc, sub);
  if (!isAssembly(doc)) throw new Error('путь A<i>/ — только у составного изделия');
  const frames = asmFrames(doc);
  if (!frames[frame]) throw new Error(`нет рамы ${frame + 1}`);
  const out = fn(frameDoc(doc, frame), sub);
  frames[frame] = out.frame;
  const d = rebuild(doc, frames, rawJoints(doc));
  return { ...out, frame: d.frame };
}

// ---------- дерево ----------
export function nodeAt(doc: Doc, path: string): Node {
  const { frame, sub } = splitPath(path);
  let n = frame === null ? doc.frame.root : frameDoc(doc, frame).frame.root;
  for (const i of sub.split('.').filter((x) => x !== '')) {
    if (!n.parts) throw new Error(`путь ${path}: дальше листа`);
    n = child(n.parts[Number(i)]);
    if (!n) throw new Error(`путь ${path}: нет части`);
  }
  return n;
}
export function partAt(doc: Doc, path: string): Part | null {
  const { sub } = splitPath(path);
  if (sub === '') return null;
  const parent = nodeAt(doc, parentOf(path));
  return parent.parts?.[indexOf(path)] ?? null;
}
export function cells(doc: Doc): { path: string; cell: Cell }[] {
  const out: { path: string; cell: Cell }[] = [];
  const rec = (n: Node, p: string) => {
    if (n.cell) { out.push({ path: p, cell: n.cell }); return; }
    (n.parts ?? []).forEach((part, i) => rec(child(part), joinPath(p, i)));
  };
  if (isAssembly(doc)) asmFrames(doc).forEach((f, i) => rec(f.root, framePrefix(i)));
  else rec(doc.frame.root, '');
  return out;
}

// ---------- геометрия контура ----------
export type Pt = [number, number];
export type Box = { x0: number; y0: number; x1: number; y1: number };
const STEP = (5 * Math.PI) / 180; // шаг дуги (договор: не больше 10°)

/** Форма рамы с учётом старой записи root.shape = 'arch' + rise_mm (T16) и параметрами по умолчанию. */
export function frameShape(f: Frame): { shape: Shape; params: ShapeParams } {
  let shape = (f.shape && f.shape !== 'rect' ? f.shape : f.root?.shape === 'arch' ? 'arch' : 'rect') as Shape;
  const p: ShapeParams = { ...(f.shape_params ?? {}) };
  const { w, h } = f;
  if (shape === 'arch') {
    p.rise ??= f.root?.rise_mm ?? Math.round(Math.min(w / 2, h) / 2);
  } else if (shape === 'trapezoid') {
    p.h_left ??= h; p.h_right ??= h;
  } else if (shape === 'bevel') {
    p.corner ??= 'tl'; p.dx ??= Math.round(Math.min(w, h) / 4); p.dy ??= p.dx;
  } else if (shape === 'triangle') {
    p.apex ??= w / 2;
  } else if (shape !== 'circle') shape = 'rect';
  return { shape, params: p };
}
export const isShaped = (f: Frame) => frameShape(f).shape !== 'rect';

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  // угол от «вверх» по часовой (y вниз): точка = (cx + r·sin a, cy − r·cos a)
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / STEP));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)] as Pt;
  });
}

/** Контур рамы, мм от левого верхнего угла габарита, по часовой от левого нижнего угла. */
export function outline(frame: Frame): Pt[] {
  const { w, h } = frame;
  const { shape, params: p } = frameShape(frame);
  let pts: Pt[];
  if (shape === 'arch') {
    const s = Math.max(1, Math.min(p.rise!, h)), c = w / 2;
    const R = (c * c + s * s) / (2 * s);
    const a = Math.atan2(c, R - s);
    pts = [[0, h], [0, s], ...arcPts(c, R, R, -a, a), [w, s], [w, h]];
  } else if (shape === 'circle') {
    const r = Math.min(w, h) / 2;
    pts = arcPts(w / 2, h / 2, r, Math.PI, 3 * Math.PI).slice(0, -1);
  } else if (shape === 'trapezoid') {
    pts = [[0, h], [0, h - Math.min(h, p.h_left!)], [w, h - Math.min(h, p.h_right!)], [w, h]];
  } else if (shape === 'bevel') {
    const dx = p.dx!, dy = p.dy!, l = p.corner !== 'tr', r = p.corner !== 'tl';
    pts = [[0, h], ...(l ? [[0, dy], [dx, 0]] as Pt[] : [[0, 0]] as Pt[]), ...(r ? [[w - dx, 0], [w, dy]] as Pt[] : [[w, 0]] as Pt[]), [w, h]];
  } else if (shape === 'triangle') {
    pts = [[0, h], [Math.max(0, Math.min(w, p.apex!)), 0], [w, h]];
  } else {
    pts = [[0, h], [0, 0], [w, 0], [w, h]];
  }
  return dedupe(pts);
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.5) out.push(q);
  }
  if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.5) out.pop();
  return out;
}
export function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
}
export const boxPts = (b: Box): Pt[] => [[b.x0, b.y1], [b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1]];

/** Пересечение многоугольника subject с выпуклым clip (Сазерленд — Ходжмен). */
export function clipPoly(subject: Pt[], clip: Pt[]): Pt[] {
  const s = Math.sign(polyArea(clip)) || 1;
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p: Pt) => s * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const cross = (p: Pt, q: Pt): Pt => {
      const sp = side(p), sq = side(q), t = sp / (sp - sq);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    };
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const ip = side(p) >= -1e-6, iq = side(q) >= -1e-6;
      if (ip) out.push(p);
      if (ip !== iq) out.push(cross(p, q));
    }
  }
  return dedupe(out);
}

/** Выпуклый контур, сдвинутый внутрь на d мм (полоса рамы/створки по контуру).
 * Считается пересечением полуплоскостей «сторона, сдвинутая внутрь»: у дуги, сходящейся с прямой под углом
 * (полукруг, низкая арка), сдвиг вершин давал самопересечение у углов — стекло обрезалось в пустоту. */
export function insetPoly(poly: Pt[], d: number): Pt[] {
  const p = dedupe(poly);
  const n = p.length;
  if (n < 3 || d === 0) return p;
  const s = Math.sign(polyArea(p)) || 1;
  let out = p;
  for (let i = 0; i < n && out.length; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    // внутрь: знак как в clipPoly (side ≥ 0 — внутри), отступ d
    const side = (q: Pt) => (s * (dx * (q[1] - a[1]) - dy * (q[0] - a[0]))) / L - d;
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const q = inp[j], r = inp[(j + 1) % inp.length];
      const sq = side(q), sr = side(r);
      if (sq >= -1e-6) out.push(q);
      if ((sq >= -1e-6) !== (sr >= -1e-6)) { const t = sq / (sq - sr); out.push([q[0] + (r[0] - q[0]) * t, q[1] + (r[1] - q[1]) * t]); }
    }
  }
  return dedupe(out);
}

/** Отрезок прямой x = at (orient 'v') или y = at ('h'), который лежит внутри выпуклого контура. */
export function lineSpan(poly: Pt[], orient: 'v' | 'h', at: number): [number, number] | null {
  const ys: number[] = [];
  const [u, v] = orient === 'v' ? [0, 1] : [1, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[u] - at) * (b[u] - at) > 0 || a[u] === b[u]) {
      if (a[u] === at) ys.push(a[v]);
      continue;
    }
    ys.push(a[v] + ((b[v] - a[v]) * (at - a[u])) / (b[u] - a[u]));
  }
  if (!ys.length) return null;
  return [Math.min(...ys), Math.max(...ys)];
}

// ---------- раздвижные и гильотина (§11): параметры с умолчаниями ----------
export const SL_OVERLAP_DEMO = 50;          // перехлёст полотен по паспорту системы (ДЕМО)
export const SL_KINDS: SlidingKind[] = ['window', 'door', 'panoramic'];
export const SL_THRESHOLDS: SlidingThreshold[] = ['standard', 'low', 'flush'];
export const GL_DRIVES: GuillotineDrive[] = ['manual', 'electric', 'remote'];
export const GL_GLASS: GuillotineGlass[] = ['g8t', 'g10t', 'g4t_14_4t'];
export const isSliding = (f?: Frame | null) => !!f?.root?.sliding;
export const isGuillotine = (f?: Frame | null) => !!f?.root?.guillotine;

/** Подвижные по умолчанию: 2 — оба; 3 — крайние; 4 и больше — все, кроме крайних. */
export function defaultMoving(n: number): boolean[] {
  return Array.from({ length: n }, (_, i) => (n <= 2 ? true : n === 3 ? i !== 1 : i > 0 && i < n - 1));
}
/** Направляющая полотна (0 — наружная): своих направляющих хватает — каждому своя, иначе симметрично от краёв. */
export function railsOf(n: number, rails: number): number[] {
  return Array.from({ length: n }, (_, i) => (rails >= n ? i : Math.min(i, n - 1 - i) % rails));
}
export type SlidingSpec = {
  n: number; rails: number; overlap: number; moving: boolean[]; kind: SlidingKind; threshold: SlidingThreshold;
  /** ширина полотна, мм: (W + (n−1)·overlap)/n */
  lw: number;
  rail: number[];
  /** куда едет подвижное полотно: +1 вправо, −1 влево (вид изнутри) — на соседа с другой направляющей */
  dir: (1 | -1)[];
};
export function slidingSpec(f: Frame): SlidingSpec | null {
  const s = f.root?.sliding as Sliding | undefined;
  if (!s) return null;
  const n = Math.max(2, Math.round(Number(s.leaves) || 2));
  const rails = Number(s.rails) === 3 ? 3 : 2;
  const overlap = typeof s.overlap_mm === 'number' && isFinite(s.overlap_mm) ? s.overlap_mm : SL_OVERLAP_DEMO;
  const moving = Array.isArray(s.moving) && s.moving.length === n ? s.moving.map(Boolean) : defaultMoving(n);
  const rail = railsOf(n, rails);
  const dir = rail.map((r, i): 1 | -1 => {
    const l = i > 0 && rail[i - 1] !== r, rr = i < n - 1 && rail[i + 1] !== r;
    if (l && rr) {
      if (!moving[i + 1] && moving[i - 1]) return 1;
      if (!moving[i - 1] && moving[i + 1]) return -1;
      return i < (n - 1) / 2 ? 1 : -1;
    }
    if (rr) return 1;
    if (l) return -1;
    return i < (n - 1) / 2 ? 1 : -1;
  });
  return {
    n, rails, overlap, moving, rail, dir,
    kind: SL_KINDS.includes(s.kind as SlidingKind) ? (s.kind as SlidingKind) : 'window',
    threshold: SL_THRESHOLDS.includes(s.threshold as SlidingThreshold) ? (s.threshold as SlidingThreshold) : 'standard',
    lw: (f.w + (n - 1) * overlap) / n,
  };
}
export type GuillotineSpec = Required<Guillotine>;
export function guillotineSpec(f: Frame): GuillotineSpec | null {
  const g = f.root?.guillotine as Guillotine | undefined;
  if (!g) return null;
  const modules = Math.max(1, Math.round(Number(g.modules) || Math.round(f.w / 1500) || 1));
  const panels = Math.max(2, Math.round(Number(g.panels) || 3));
  const moving = Math.min(panels - 1, Math.max(1, Math.round(Number(g.moving) || panels - 1)));
  return {
    modules, panels, moving,
    drive: GL_DRIVES.includes(g.drive as GuillotineDrive) ? (g.drive as GuillotineDrive) : 'manual',
    glass: GL_GLASS.includes(g.glass as GuillotineGlass) ? (g.glass as GuillotineGlass) : 'g8t',
    posts: g.posts === 'none' ? 'none' : 'between',
  };
}

// ---------- раскладка для схемы (по осям, мм от левого верхнего угла) ----------
export type Side = 'frame' | 'mullion' | 'shtulp' | 'none';
export type LayoutCell = {
  path: string; cell: Cell; box: Box; sides: Record<'l' | 'r' | 't' | 'b', Side>;
  /** ячейку обрезает контур фигурной рамы; poly — box ∩ контур */
  shaped?: boolean; poly?: Pt[];
  /** номер рамы сборки */
  frame?: number;
  /** раздвижное полотно (§11.1): номер, направляющая, подвижное, куда едет */
  leaf?: { index: number; rail: number; moving: boolean; dir: 1 | -1 };
  /** полотно гильотины (§11.3): модуль, номер сверху, поднимается */
  gpanel?: { module: number; panel: number; moving: boolean };
  /** часть гильотинного окна (§11.2) */
  vslide?: 'top' | 'bottom';
};
export type Layout = {
  cells: LayoutCell[];
  /** cut — видимый отрезок импоста внутри контура (у фигурной рамы) */
  mullions: { path: string; orient: 'v' | 'h'; at: number; from: number; to: number; cut?: [number, number]; frame?: number }[];
  sizes: Record<string, number[]>;
  error?: string;
  /** контур рамы, если она фигурная */
  outline?: Pt[];
  /** составное изделие: рамы в развёртке (x0 — сдвиг рамы, рамы стоят по низу) и стыки между ними */
  frames?: { index: number; x0: number; y0: number; w: number; h: number; shape: Shape; outline: Pt[] }[];
  joints?: { index: number; at: number; joint: JointKind; angle: number }[];
};

export function resolveSizes(parts: Part[], total: number): number[] {
  const fixed = parts.filter((p) => typeof p.size === 'number').reduce((a, p) => a + (p.size as number), 0);
  const nEq = parts.filter((p) => typeof p.size !== 'number').length;
  if (!nEq) return parts.map((p) => p.size as number);
  const eq = (total - fixed) / nEq;
  return parts.map((p) => (typeof p.size === 'number' ? p.size : eq));
}

/** Раздвижная (§11.1): полотна равной ширины внахлёст, пути «0», «1», …; глухое полотно — ячейка fixed. */
function slidingLayout(frame: Frame, prefix: string, ox: number, oy: number, fi?: number): Layout {
  const out: Layout = { cells: [], mullions: [], sizes: {} };
  const sp = slidingSpec(frame)!;
  if (sp.lw <= sp.overlap) out.error = 'полотна не помещаются в размер';
  for (let i = 0; i < sp.n; i++) {
    const x0 = i * (sp.lw - sp.overlap);
    const cell: Cell = sp.moving[i]
      ? { type: sp.kind === 'window' ? 'sash' : 'door_sash', open: 'sliding', hinge: sp.dir[i] > 0 ? 'left' : 'right', handle: true }
      : { type: 'fixed' };
    const c: LayoutCell = {
      path: `${prefix}${i}`, cell, box: { x0: x0 + ox, y0: oy, x1: x0 + sp.lw + ox, y1: frame.h + oy },
      sides: { l: i ? 'shtulp' : 'frame', r: i < sp.n - 1 ? 'shtulp' : 'frame', t: 'frame', b: 'frame' },
      leaf: { index: i, rail: sp.rail[i], moving: sp.moving[i], dir: sp.dir[i] },
    };
    if (fi !== undefined) c.frame = fi;
    out.cells.push(c);
  }
  return out;
}

/** Гильотина (§11.3): модули равной ширины, в модуле полотна сверху вниз; пути «<модуль>.<полотно>». */
function guillotineLayout(frame: Frame, prefix: string, ox: number, oy: number, fi?: number): Layout {
  const out: Layout = { cells: [], mullions: [], sizes: {} };
  const g = guillotineSpec(frame)!;
  const mw = frame.w / g.modules, ph = frame.h / g.panels;
  for (let m = 0; m < g.modules; m++) {
    if (m > 0 && g.posts === 'between') {
      const mu: Layout['mullions'][0] = { path: prefix, orient: 'v', at: m * mw + ox, from: oy, to: frame.h + oy };
      if (fi !== undefined) mu.frame = fi;
      out.mullions.push(mu);
    }
    for (let p = 0; p < g.panels; p++) {
      const moving = p >= g.panels - g.moving;
      const c: LayoutCell = {
        path: `${prefix}${m}.${p}`,
        cell: moving ? { type: 'sash', open: 'vslide', slide: 'moving' } : { type: 'fixed' },
        box: { x0: m * mw + ox, y0: p * ph + oy, x1: (m + 1) * mw + ox, y1: (p + 1) * ph + oy },
        sides: { l: m ? (g.posts === 'between' ? 'mullion' : 'none') : 'frame', r: m < g.modules - 1 ? (g.posts === 'between' ? 'mullion' : 'none') : 'frame',
          t: p ? 'none' : 'frame', b: p < g.panels - 1 ? 'none' : 'frame' },
        gpanel: { module: m, panel: p, moving },
      };
      if (fi !== undefined) c.frame = fi;
      out.cells.push(c);
    }
  }
  return out;
}

function frameLayout(frame: Frame, prefix = '', ox = 0, oy = 0, fi?: number): Layout {
  if (frame.root?.sliding) return slidingLayout(frame, prefix, ox, oy, fi);
  if (frame.root?.guillotine) return guillotineLayout(frame, prefix, ox, oy, fi);
  const out: Layout = { cells: [], mullions: [], sizes: {} };
  const W = frame.w, H = frame.h;
  const shaped = isShaped(frame);
  const contour = shaped ? outline(frame) : null;
  const sh = (b: Box): Box => ({ x0: b.x0 + ox, y0: b.y0 + oy, x1: b.x1 + ox, y1: b.y1 + oy });
  const rec = (n: Node, path: string, b: Box, sides: LayoutCell['sides'], vs?: 'top' | 'bottom') => {
    if (n.cell) {
      const c: LayoutCell = { path, cell: n.cell, box: sh(b), sides };
      if (fi !== undefined) c.frame = fi;
      if (vs) c.vslide = vs;
      if (contour) {
        const poly = clipPoly(boxPts(b), contour);
        const full = (b.x1 - b.x0) * (b.y1 - b.y0), a = Math.abs(polyArea(poly));
        if (full - a > Math.max(1, full * 1e-5)) { c.shaped = true; c.poly = poly.map(([x, y]) => [x + ox, y + oy]); }
        if (a < 1) out.error ??= `ячейка ${path || 'целиком'} вне формы рамы`;
      }
      out.cells.push(c);
      return;
    }
    const parts = n.parts ?? [];
    const vertical = n.split !== 'h' && n.split !== 'vslide';
    const total = vertical ? b.x1 - b.x0 : b.y1 - b.y0;
    const sz = resolveSizes(parts, total);
    if (sz.some((x) => x <= 0)) out.error = 'части не помещаются в размер';
    out.sizes[path] = sz;
    // штульп, гармошка, гильотинное — створки встречаются без импоста
    const boundary: Side = n.split === 'shtulp' || n.split === 'folding' || n.split === 'vslide' ? 'shtulp' : n.split === 'none' ? 'none' : 'mullion';
    let pos = vertical ? b.x0 : b.y0;
    parts.forEach((part, i) => {
      const s = Math.max(sz[i], 1);
      const p = joinPath(path, i);
      const sub: Box = vertical ? { x0: pos, y0: b.y0, x1: pos + s, y1: b.y1 } : { x0: b.x0, y0: pos, x1: b.x1, y1: pos + s };
      const ss = { ...sides };
      if (vertical) { if (i > 0) ss.l = boundary; if (i < parts.length - 1) ss.r = boundary; }
      else { if (i > 0) ss.t = boundary; if (i < parts.length - 1) ss.b = boundary; }
      if (i > 0 && boundary === 'mullion') {
        const m: Layout['mullions'][0] = vertical
          ? { path, orient: 'v', at: pos + ox, from: b.y0 + oy, to: b.y1 + oy }
          : { path, orient: 'h', at: pos + oy, from: b.x0 + ox, to: b.x1 + ox };
        if (contour) {
          const span = lineSpan(contour, m.orient, pos);
          const [lo, hi] = vertical ? [b.y0, b.y1] : [b.x0, b.x1];
          const o = vertical ? oy : ox;
          if (span) m.cut = [Math.max(lo, span[0]) + o, Math.min(hi, span[1]) + o];
        }
        if (fi !== undefined) m.frame = fi;
        out.mullions.push(m);
      }
      rec(child(part), p, sub, ss, n.split === 'vslide' ? (i === 0 ? 'top' : 'bottom') : undefined);
      pos += s;
    });
  };
  rec(frame.root, prefix, { x0: 0, y0: 0, x1: W, y1: H }, { l: 'frame', r: 'frame', t: 'frame', b: 'frame' });
  if (contour) out.outline = contour.map(([x, y]) => [x + ox, y + oy]);
  return out;
}

/**
 * Раскладка изделия прямоугольниками. Фигурная рама — те же прямоугольники + shaped/poly у обрезанных ячеек.
 * Составное — рамы в развёртку слева направо (стоят по низу), пути с префиксом A<i>/.
 */
export function layout(doc: Doc): Layout {
  if (!isAssembly(doc)) return frameLayout(doc.frame);
  const frames = asmFrames(doc), joints = asmJoints(doc);
  const H = frames.reduce((a, f) => Math.max(a, f.h), 0);
  const out: Layout = { cells: [], mullions: [], sizes: {}, frames: [], joints: [] };
  let x = 0;
  frames.forEach((f, i) => {
    const y0 = H - f.h;
    const L = frameLayout(f, framePrefix(i), x, y0, i);
    out.cells.push(...L.cells); out.mullions.push(...L.mullions); Object.assign(out.sizes, L.sizes);
    if (L.error) out.error ??= `рама ${i + 1}: ${L.error}`;
    out.frames!.push({ index: i, x0: x, y0, w: f.w, h: f.h, shape: frameShape(f).shape, outline: outline(f).map(([px, py]) => [px + x, py + y0]) });
    x += f.w;
    if (i < frames.length - 1) out.joints!.push({ index: i, at: x, ...(joints[i] ?? { joint: 'straight', angle: 180 }) });
  });
  return out;
}

// ---------- команды (как в ядре) ----------
const SHAPES: Shape[] = ['rect', 'arch', 'circle', 'trapezoid', 'bevel', 'triangle'];
const num = (x: unknown) => (typeof x === 'number' && isFinite(x) ? x : undefined);

const g = (x: number) => String(Math.round(x * 10) / 10);
/** Ограничения формы для габарита w × h — как shape_problems ядра (oyna_core/shapes.py). Пусто — форма допустима. */
export function shapeProblems(shape: string, p: ShapeParams | null | undefined, w: number, h: number): string[] {
  p = p ?? {};
  if (!SHAPES.includes(shape as Shape)) return [`неизвестная форма «${shape}»`];
  const out: string[] = [];
  if (shape === 'arch') {
    const r = num(p.rise);
    if (r === undefined) out.push('арка: нужен подъём, мм');
    else if (r < 50 || r > Math.min(w / 2, h)) out.push(`подъём арки ${g(r)} мм вне 50–${g(Math.min(w / 2, h))} мм`);
  } else if (shape === 'circle') {
    if (Math.abs(w - h) > 2) out.push(`круглое окно: ширина ${g(w)} ≠ высоте ${g(h)}`);
  } else if (shape === 'trapezoid') {
    const hl = num(p.h_left), hr = num(p.h_right);
    if (hl === undefined || hr === undefined) out.push('трапеция: нужны высоты сторон, мм');
    else if (Math.abs(Math.max(hl, hr) - h) > 0.5) out.push(`трапеция: большая сторона (${g(Math.max(hl, hr))}) должна быть равна высоте рамы ${g(h)}`);
    else if (Math.min(hl, hr) < 300) out.push(`трапеция: низкая сторона ${g(Math.min(hl, hr))} мм меньше 300 мм`);
  } else if (shape === 'bevel') {
    const dx = num(p.dx), dy = num(p.dy);
    if (!['tl', 'tr', 'both'].includes(p.corner ?? '')) out.push('скос: угол tl | tr | both');
    else if (dx === undefined || dy === undefined || dx <= 0 || dy <= 0) out.push('скос: нужны катеты больше нуля, мм');
    else {
      if (p.corner === 'both' && (dx >= w / 2 || dy >= h / 2)) out.push(`скос двух углов: по ширине меньше ${g(w / 2)}, по высоте меньше ${g(h / 2)}`);
      if (dx > w - 300) out.push(`скос: ${g(dx)} мм больше ${g(w - 300)} (ширина − 300)`);
      if (dy >= h) out.push(`скос: ${g(dy)} мм не меньше высоты рамы`);
    }
  } else if (shape === 'triangle') {
    const ap = num(p.apex);
    if (ap === undefined || ap < 0 || ap > w) out.push(`треугольник: вершина 0–${g(w)} мм`);
    if (h < 300) out.push(`треугольник: высота ${g(h)} мм меньше 300 мм`);
  }
  return out;
}

function setShape(doc: Doc, a: { shape: Shape; params?: ShapeParams | null }): Doc {
  if (!SHAPES.includes(a.shape)) throw new Error(`неизвестная форма: ${a.shape}`);
  const d = clone(doc);
  const f = d.frame;
  const p: ShapeParams = { ...(a.params ?? {}) };
  delete f.root.shape; delete f.root.rise_mm;
  if (a.shape === 'rect') { f.shape = 'rect'; delete f.shape_params; return d; }
  const probs = shapeProblems(a.shape, p, f.w, f.h);
  if (probs.length) throw new Error(probs.join('; '));
  f.shape = a.shape;
  f.shape_params = p;
  const err = frameLayout(f).error;
  if (err) throw new Error(`${err} — сначала объедините части`);
  return d;
}

function mirrorRoot(root: Node) {
  const sw: Record<string, 'left' | 'right'> = { left: 'right', right: 'left' };
  const rec = (n: Node) => {
    if (n.cell) { if (n.cell.hinge && sw[n.cell.hinge]) n.cell.hinge = sw[n.cell.hinge]; return; }
    if (n.sliding) { if (Array.isArray(n.sliding.moving)) n.sliding.moving.reverse(); return; }
    if (n.guillotine) return;
    if (n.split !== 'h' && n.split !== 'vslide') n.parts?.reverse();
    (n.parts ?? []).forEach((p) => rec(child(p)));
  };
  rec(root);
}
function mirrorShape(f: Frame) {
  const sp = f.shape_params;
  if (!sp) return;
  if (f.shape === 'trapezoid') [sp.h_left, sp.h_right] = [sp.h_right, sp.h_left];
  if (f.shape === 'bevel' && sp.corner !== 'both') sp.corner = sp.corner === 'tr' ? 'tl' : 'tr';
  if (f.shape === 'triangle' && sp.apex !== undefined) sp.apex = f.w - sp.apex;
}

const MUNTIN_KEYS = new Set(['kind', 'pattern', 'v', 'h', 'width_mm', 'color']);
const MUNTIN_WIDTHS: Record<string, number[]> = { inner: [8, 18, 26], overlay: [18, 26, 45] };
const OPENINGS = ['turn', 'tilt_turn', 'tilt', 'sliding', 'top_hung', 'pivot', 'folding', 'psk', 'hs', 'vslide'];
const JOINTS: JointKind[] = ['straight', 'angle', 'post', 'corner_free'];
const NO_HINGE = ['pivot', 'vslide'];
const HINGE_OF: Record<string, 'top' | 'bottom'> = { tilt: 'bottom', top_hung: 'top' };
const GLASS_DECORS = ['matte', 'tinted', 'mirror', 'pattern', 'stained'];

export const cmd = {
  set_size(doc: Doc, a: { w?: number; h?: number; path?: string }): Doc {
    if (isAssembly(doc)) {
      const { frame } = splitPath(a.path ?? '');
      const frames = asmFrames(doc).map(clone);
      if (frame !== null) {
        if (!frames[frame]) throw new Error(`нет рамы ${frame + 1}`);
        if (a.w !== undefined) frames[frame].w = a.w;
        if (a.h !== undefined) frames[frame].h = a.h;
      } else {
        // вся сборка: высота — всем рамам; ширина — сумма рам (как в ядре)
        if (a.w !== undefined) throw new Error('ширина сборки — сумма рам: задайте раму, путь A<i>/');
        if (a.h !== undefined) frames.forEach((f) => { f.h = a.h!; });
      }
      return rebuild(doc, frames, rawJoints(doc));
    }
    const d = clone(doc);
    if (a.w !== undefined) d.frame.w = a.w;
    if (a.h !== undefined) d.frame.h = a.h;
    return d;
  },
  /** dir 'folding' — гармошка (§9.1): n створок без импостов, открывание folding, петли попеременно.
   * dir 'vslide' — гильотинное окно (§11.2): две части сверху вниз, верхняя глухая, нижняя поднимается. */
  split(doc: Doc, a: { path: string; dir: 'v' | 'h' | 'shtulp' | 'folding' | 'vslide'; n?: number; sizes?: (number | 'eq')[] }): Doc {
    return onFrame(doc, a.path, (src, path) => {
      const d = clone(src);
      const n = a.n ?? 2;
      const node = nodeAt(d, path);
      if (!node.cell) throw new Error('узел уже разделён');
      const base = node.cell;
      const sizes = a.sizes ?? Array(n).fill('eq');
      if (!['v', 'h', 'shtulp', 'folding', 'vslide'].includes(a.dir)) throw new Error('dir: v | h | shtulp | folding | vslide');
      if (n < 2) throw new Error('n ≥ 2');
      if (a.dir === 'vslide' && n !== 2) throw new Error('гильотинное окно — две части');
      const leafType = base.type === 'door_sash' ? 'door_sash' : 'sash';
      const parts: Part[] = Array.from({ length: n }, (_, i) => ({
        size: sizes[i],
        cell: a.dir === 'shtulp'
          ? { type: 'sash', open: i === 0 ? 'turn' : 'tilt_turn', hinge: i === 0 ? 'left' : 'right', handle: true }
          : a.dir === 'folding'
            ? { type: leafType, open: 'folding', hinge: i % 2 ? 'right' : 'left', handle: i === n - 1 }
            : a.dir === 'vslide'
              ? { type: 'sash', open: 'vslide', slide: i === 0 ? 'fixed' : 'moving' }
              : i === 0 ? { ...base } : { type: 'fixed' },
      }));
      const fresh: Node = { split: a.dir, parts };
      const part = partAt(d, path);
      if (!part) { delete (node as Node).cell; Object.assign(node, fresh); }
      else { delete part.cell; part.node = fresh; }
      return d;
    });
  },
  merge(doc: Doc, a: { path: string }): Doc {
    return onFrame(doc, a.path, (src, path) => {
      const d = clone(src);
      const node = nodeAt(d, path);
      if (node.cell) throw new Error('объединять нечего');
      const first = node.parts![0];
      const c: Cell = first.cell ?? { type: 'fixed' };
      const part = partAt(d, path);
      if (!part) { delete node.split; delete node.parts; node.cell = c; }
      else { delete part.node; part.cell = c; }
      return d;
    });
  },
  set_part_size(doc: Doc, a: { path: string; size: number | 'eq' }): Doc {
    return onFrame(doc, a.path, (src, path) => {
      const d = clone(src);
      const part = partAt(d, path);
      if (!part) throw new Error('у корня нет размера части');
      part.size = a.size;
      return d;
    });
  },
  set_cell(doc: Doc, a: { path: string } & Partial<Cell>): Doc {
    const { path: full, ...props } = a;
    return onFrame(doc, full, (src, path) => {
      const d = clone(src);
      const node = nodeAt(d, path);
      if (!node.cell) throw new Error('свойства задаются ячейке');
      if (props.open && !OPENINGS.includes(props.open)) throw new Error(`open: ${OPENINGS.join(' | ')}`);
      if (props.slide != null && !['moving', 'fixed'].includes(props.slide)) throw new Error('slide: moving | fixed');
      const c = Object.assign(node.cell, props);
      if (props.open && !('hinge' in props)) {      // новое открывание без петель — петли по открыванию (как в ядре)
        const op = props.open;
        if (HINGE_OF[op]) c.hinge = HINGE_OF[op];
        else if (NO_HINGE.includes(op)) delete c.hinge;
        else if (!c.hinge || c.hinge === 'top' || c.hinge === 'bottom') c.hinge = 'left';
      }
      for (const k of ['mosquito', 'vent', 'open_dir', 'threshold', 'muntins', 'slide', 'tilt_clean'] as const) if (c[k] === null) delete c[k];
      if (c.type !== 'door_sash') delete c.threshold;
      if (c.type === 'fixed' || c.type === 'panel') {
        delete c.open; delete c.hinge; delete c.handle; delete c.open_dir; delete c.slide; delete c.tilt_clean;
        if (!('mosquito' in props)) delete c.mosquito;
      } else if ((c.open ??= 'tilt_turn') === 'vslide') {
        // гильотинное (§11.2): без петель, полотно подвижное или глухое
        delete c.hinge;
        c.slide ??= 'moving';
      } else {
        delete c.slide; delete c.tilt_clean;
        if (c.open !== 'pivot') c.hinge ??= HINGE_OF[c.open] ?? 'left';
        c.handle ??= true;
      }
      return d;
    });
  },
  /** fill — заполнение целиком; decor / tint без fill — только декор стекла ячейки, стекло остаётся (как в ядре). */
  set_fill(doc: Doc, a: { path: string; fill?: Cell['fill'] | null; decor?: string | null; tint?: string | null }): Doc {
    return onFrame(doc, a.path, (src, path) => {
      const d = clone(src);
      const node = nodeAt(d, path);
      if (!node.cell) throw new Error('заполнение задаётся ячейке');
      const c = node.cell;
      if ('fill' in a) { if (a.fill) c.fill = clone(a.fill); else delete c.fill; }
      if ('decor' in a || 'tint' in a) {
        const f = (c.fill ??= { kind: 'glass' }) as Record<string, unknown>;
        if (f.kind !== 'glass') throw new Error('декор стекла — у ячейки со стеклом');
        if ('decor' in a) { if (a.decor == null) { delete f.decor; delete f.tint; } else f.decor = a.decor; }
        if ('tint' in a) { if (a.tint == null) delete f.tint; else f.tint = a.tint; }
        if (Object.keys(f).length === 1) delete c.fill;
      }
      const f = c.fill?.kind === 'glass' ? c.fill : null;
      if (f?.decor && !GLASS_DECORS.includes(f.decor)) throw new Error(`декор стекла: ${GLASS_DECORS.join(' | ')}`);
      return d;
    });
  },
  set_muntins(doc: Doc, a: { path: string; muntins: Muntins | null }): Doc {
    return onFrame(doc, a.path, (src, path) => {
      const d = clone(src);
      const node = nodeAt(d, path);
      if (!node.cell) throw new Error('раскладка задаётся ячейке');
      if (!a.muntins) { delete node.cell.muntins; return d; }
      const bad = Object.keys(a.muntins).filter((k) => !MUNTIN_KEYS.has(k));
      if (bad.length) throw new Error(`неизвестные поля раскладки: ${bad.join(', ')}`);
      const m: Muntins = clone(a.muntins);
      m.kind ??= 'inner'; m.pattern ??= 'grid'; m.color ??= 'white';
      if (!MUNTIN_WIDTHS[m.kind]) throw new Error('раскладка: внутри стеклопакета или накладная');
      m.width_mm ??= m.kind === 'inner' ? 18 : 26;
      if (!MUNTIN_WIDTHS[m.kind].includes(m.width_mm)) throw new Error(`ширина раскладки: ${MUNTIN_WIDTHS[m.kind].join(', ')} мм`);
      if (!['grid', 'sun', 'cross', 'decor'].includes(m.pattern)) throw new Error('pattern: grid | sun | cross | decor');
      m.v = m.v ?? 0; m.h = m.h ?? 0;
      if (m.v < 0 || m.v > 20 || m.h < 0 || m.h > 20) throw new Error('прутков 0…20');
      if (m.pattern === 'cross') { m.v = 1; m.h = 1; }
      if ((m.pattern === 'grid' || m.pattern === 'sun') && !m.v && !m.h) throw new Error('раскладка без прутков');
      node.cell.muntins = m;
      return d;
    });
  },
  set_shape(doc: Doc, a: { shape: Shape; params?: ShapeParams | null; path?: string }): Doc {
    if (isAssembly(doc) && splitPath(a.path ?? '').frame === null) throw new Error('форма задаётся раме сборки: путь A<i>/');
    return onFrame(doc, a.path ?? '', (src) => setShape(src, a));
  },
  set_joint(doc: Doc, a: { index: number; joint: JointKind; angle?: number }): Doc {
    if (!isAssembly(doc)) throw new Error('стыки — только у составного изделия');
    const joints = rawJoints(doc).map(clone);
    if (!joints[a.index]) throw new Error(`нет стыка ${a.index + 1}`);
    if (!JOINTS.includes(a.joint)) throw new Error(`joint: ${JOINTS.join(' | ')}`);
    const j: Joint = { joint: a.joint };
    if (a.joint === 'angle' || a.joint === 'corner_free') {
      // угол без стойки (§11.1) — по умолчанию 90°
      const ang = a.angle ?? (a.joint === 'corner_free' ? 90 : 135);
      if (ang < 90 || ang > 179) throw new Error('угол стыка 90…179°; 180° — прямой');
      j.angle = ang;
    }
    joints[a.index] = j;
    return rebuild(doc, asmFrames(doc), joints);
  },
  add_frame(doc: Doc, a: { after: number; w?: number; h?: number }): Doc {
    if (!isAssembly(doc)) throw new Error('рамы добавляются в составное изделие');
    const frames = asmFrames(doc), joints = rawJoints(doc).map(clone);
    if (a.after < -1 || a.after >= frames.length) throw new Error(`нет рамы ${a.after}`);
    const after = a.after;
    const h = a.h || doc.frame.h || frames.reduce((m, f) => Math.max(m, f.h), 0) || 1400;
    const fresh: Frame = { w: a.w ?? 1000, h, shape: 'rect', root: { cell: { type: 'fixed' } } };
    const near = joints.length ? joints[Math.min(Math.max(after, 0), joints.length - 1)] : { joint: 'straight' };
    frames.splice(after + 1, 0, fresh);
    joints.splice(Math.max(0, after), 0, clone(near));
    return rebuild(doc, frames, joints);
  },
  remove_frame(doc: Doc, a: { index: number }): Doc {
    if (!isAssembly(doc)) throw new Error('рамы есть только у составного изделия');
    const frames = asmFrames(doc), joints = rawJoints(doc).map(clone);
    if (!frames[a.index]) throw new Error(`нет рамы ${a.index + 1}`);
    if (frames.length <= 2) throw new Error('в сборке остаются минимум две рамы');
    frames.splice(a.index, 1);
    joints.splice(a.index === 0 ? 0 : a.index - 1, 1);
    return rebuild(doc, frames, joints);
  },
  /** Раздвижная (§11.1): поля корня frame.root.sliding; смена числа полотен без moving — подвижные по умолчанию. */
  set_sliding(doc: Doc, a: { path?: string } & Partial<Sliding>): Doc {
    const { path, ...p } = a;
    return onFrame(doc, path ?? '', (src) => {
      const d = clone(src);
      const s = d.frame.root.sliding;
      if (!s) throw new Error('изделие не раздвижное');
      const bad = Object.keys(p).filter((k) => !['leaves', 'rails', 'overlap_mm', 'moving', 'kind', 'threshold'].includes(k));
      if (bad.length) throw new Error(`неизвестные поля: ${bad.join(', ')}`);
      const n0 = slidingSpec(d.frame)!.n;
      if (p.leaves !== undefined) {
        if (!Number.isInteger(p.leaves) || p.leaves < 2 || p.leaves > 8) throw new Error('полотен 2…8');
        s.leaves = p.leaves;
      }
      if (p.rails !== undefined) {
        if (p.rails !== 2 && p.rails !== 3) throw new Error('направляющих 2 или 3');
        s.rails = p.rails;
      }
      if (p.overlap_mm !== undefined) {
        if (p.overlap_mm !== 'passport' && !(typeof p.overlap_mm === 'number' && p.overlap_mm >= 0 && p.overlap_mm <= 200)) throw new Error('перехлёст: passport или 0…200 мм');
        s.overlap_mm = p.overlap_mm;
      }
      if (p.kind !== undefined) {
        if (!SL_KINDS.includes(p.kind)) throw new Error(`kind: ${SL_KINDS.join(' | ')}`);
        s.kind = p.kind;
      }
      if (p.threshold !== undefined) {
        if (!SL_THRESHOLDS.includes(p.threshold)) throw new Error(`threshold: ${SL_THRESHOLDS.join(' | ')}`);
        s.threshold = p.threshold;
      }
      const n = s.leaves;
      if (p.moving !== undefined) {
        if (!Array.isArray(p.moving) || p.moving.length !== n || p.moving.some((x) => typeof x !== 'boolean')) throw new Error(`moving: ${n} значений true/false`);
        s.moving = [...p.moving];
      } else if (n !== n0 || (s.moving && s.moving.length !== n)) s.moving = defaultMoving(n);
      return d;
    });
  },
  /** Гильотина (§11.3): поля корня frame.root.guillotine; полотен меньше — поднимается не больше panels − 1. */
  set_guillotine(doc: Doc, a: { path?: string } & Partial<Guillotine>): Doc {
    const { path, ...p } = a;
    return onFrame(doc, path ?? '', (src) => {
      const d = clone(src);
      const g = d.frame.root.guillotine;
      if (!g) throw new Error('изделие не гильотина');
      const bad = Object.keys(p).filter((k) => !['modules', 'panels', 'moving', 'drive', 'glass', 'posts'].includes(k));
      if (bad.length) throw new Error(`неизвестные поля: ${bad.join(', ')}`);
      const cur = guillotineSpec(d.frame)!;
      if (p.modules !== undefined) {
        if (!Number.isInteger(p.modules) || p.modules < 1 || p.modules > 12) throw new Error('модулей 1…12');
        g.modules = p.modules;
      }
      if (p.panels !== undefined) {
        if (!Number.isInteger(p.panels) || p.panels < 2 || p.panels > 5) throw new Error('полотен в модуле 2…5');
        g.panels = p.panels;
      }
      const panels = g.panels ?? cur.panels;
      if (p.moving !== undefined) {
        if (!Number.isInteger(p.moving) || p.moving < 1 || p.moving > panels - 1) throw new Error(`поднимаются 1…${panels - 1} (верхнее глухое)`);
        g.moving = p.moving;
      } else g.moving = Math.min(cur.moving, panels - 1);
      if (p.drive !== undefined) {
        if (!GL_DRIVES.includes(p.drive)) throw new Error(`drive: ${GL_DRIVES.join(' | ')}`);
        g.drive = p.drive;
      }
      if (p.glass !== undefined) {
        if (!GL_GLASS.includes(p.glass)) throw new Error(`glass: ${GL_GLASS.join(' | ')}`);
        g.glass = p.glass;
      }
      if (p.posts !== undefined) {
        if (p.posts !== 'between' && p.posts !== 'none') throw new Error('posts: between | none');
        g.posts = p.posts;
      }
      return d;
    });
  },
  set_setup(doc: Doc, a: Record<string, unknown>): Doc {
    const d = clone(doc);
    const s = (d.setup ??= {});
    if (a.system && a.system !== s.system && !('fittings' in a)) delete s.fittings;
    Object.assign(s, a);
    // новые поля вместо старых (shapes_contract §8)
    if ('lam_out' in a) delete s.color_out;
    if ('lam_in' in a) delete s.color_in;
    return d;
  },
  set_option(doc: Doc, a: { group: string; code: string | null; path?: string | null }): Doc {
    if (a.path == null) {
      const d = clone(doc);
      const opts = ((d.setup ??= {}).options ??= {});
      if (a.code === null) delete opts[a.group]; else opts[a.group] = a.code;
      return d;
    }
    return onFrame(doc, a.path, (src, path) => {
      const d = clone(src);
      const opts = (nodeAt(d, path).cell!.options ??= {});
      if (a.code === null) delete opts[a.group]; else opts[a.group] = a.code;
      return d;
    });
  },
  set_extras(doc: Doc, a: Record<string, unknown>): Doc {
    const d = clone(doc);
    d.extras = { ...(d.extras ?? {}), ...a };
    return d;
  },
  mirror(doc: Doc): Doc {
    if (isAssembly(doc)) {
      const frames = asmFrames(doc).map(clone).reverse();
      frames.forEach((f) => { mirrorRoot(f.root); mirrorShape(f); });
      return rebuild(doc, frames, rawJoints(doc).map(clone).reverse());
    }
    const d = clone(doc);
    mirrorRoot(d.frame.root);
    mirrorShape(d.frame);
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

/** Изделие из шаблона (как create_from_template ядра): форма, дерево, сборка — для миниатюр и работы без сети. */
export function docFromTemplate(t: Template, w?: number, h?: number): Doc | null {
  let d: Doc;
  if (t.doc?.frame?.root) {                       // свой шаблон цеха — изделие целиком
    d = { ...clone(t.doc), template: t.id };
    delete d.id;
  } else {
    if (!t.root) return null;
    const legacyArch = t.root.shape === 'arch';
    d = {
      kind: t.kind, qty: 1, template: t.id, extras: {}, accepted_warnings: [],
      frame: {
        w: t.default_w, h: t.default_h, shape: t.shape ?? (legacyArch ? 'arch' : 'rect'),
        ...(t.shape_params ? { shape_params: clone(t.shape_params) } : legacyArch && t.root.rise_mm ? { shape_params: { rise: t.root.rise_mm } } : {}),
        root: clone(t.root),
      },
    };
  }
  // как create_from_template ядра: высота — всем рамам, ширина — пропорционально развёртке (кратно 5 мм)
  if (isAssembly(d)) return scaleAssembly(d, w, h);
  if (w !== undefined || h !== undefined) d = cmd.set_size(d, { w, h });
  return d;
}

/** Лоджия (§9.5): П-образная сборка из трёх рам с углами 90° + doc.loggia — для мастера замера без сети. */
/** sideN / frontN — частей в боковых и фронтальной раме (для иконки — меньше, иначе в 72 px сплошная штриховка) */
export function loggiaDoc(w = 4200, h = 1400, sideW = 1200, sideN = 2, frontN = 3): Doc {
  const leaf = (i: number): Cell => (i === 1 ? { type: 'sash', open: 'tilt_turn', hinge: 'left', handle: true, mosquito: true } : { type: 'fixed' });
  const front = Math.max(600, w - 2 * sideW);
  const frame = (fw: number, n: number): Frame => ({
    w: fw, h, shape: 'rect', root: { split: 'v', parts: Array.from({ length: n }, (_, i) => ({ size: 'eq' as const, cell: leaf(i) })) },
  });
  const d: Doc = {
    kind: 'assembly', qty: 1, extras: {}, accepted_warnings: [], loggia: { outrigger_mm: 0, roof: false, cladding: null, parapet: null },
    frame: { w: 0, h, root: { assembly: [{ frame: frame(sideW, sideN) }, { joint: 'angle', angle: 90 }, { frame: frame(front, frontN) }, { joint: 'angle', angle: 90 }, { frame: frame(sideW, sideN) }] } },
  };
  return rebuild(d, asmFrames(d), rawJoints(d));
}

/** Сборка в новом габарите (не команда): высота — всем рамам, ширина — пропорционально, кратно 5 мм. */
export function scaleAssembly(doc: Doc, w?: number, h?: number): Doc {
  const frames = asmFrames(doc).map(clone);
  if (h) frames.forEach((f) => { f.h = h; });
  const sum = frames.reduce((s, f) => s + f.w, 0);
  if (w && sum && w !== sum) frames.forEach((f) => { f.w = Math.round((f.w * w) / sum / 5) * 5; });
  return rebuild(doc, frames, rawJoints(doc));
}

/** Простое окно без сети: шаблоны с сервера, а это — запасной вариант для мастера замера (1–4 створки). */
export function simpleWindow(w: number, h: number, leaves: number, transom = false): Doc {
  const leaf = (i: number): Cell => (i === 0 ? { type: 'sash', open: 'tilt_turn', hinge: 'left', handle: true, mosquito: true } : { type: 'fixed' });
  let root: Node = leaves <= 1 ? { cell: leaf(0) } : { split: 'v', parts: Array.from({ length: leaves }, (_, i) => ({ size: 'eq' as const, cell: leaf(i) })) };
  if (transom) root = { split: 'h', parts: [{ size: 500, cell: { type: 'sash', open: 'tilt', hinge: 'bottom', handle: true } }, { size: 'eq', node: root }] };
  return { kind: 'window', qty: 1, frame: { w, h, shape: 'rect', root }, extras: {}, accepted_warnings: [] };
}

/** Раздвижная без сети (мастер замера, иконки): корень sliding (§11.1). */
export function slidingDoc(w: number, h: number, leaves = 2, kind: SlidingKind = 'window'): Doc {
  return {
    kind: 'sliding', qty: 1, extras: {}, accepted_warnings: [],
    frame: { w, h, shape: 'rect', root: { sliding: { leaves, rails: 2, overlap_mm: 'passport', moving: defaultMoving(leaves), kind, threshold: kind === 'window' ? 'standard' : 'low' } } },
  };
}
/** Гильотина без сети (§11.3): modules модулей по 3 полотна, 2 нижних поднимаются. */
export function guillotineDoc(w: number, h: number, modules = 3): Doc {
  return {
    kind: 'guillotine', qty: 1, extras: {}, accepted_warnings: [],
    frame: { w, h, shape: 'rect', root: { guillotine: { modules, panels: 3, moving: 2, drive: 'electric', glass: 'g8t', posts: 'between' } } },
  };
}
/** Изделие для кнопок 3D: что делает «Открыть» (раздвижные, гильотины — едут) и есть ли что откидывать. */
export function openCaps(doc: Doc): { turn: boolean; slide: boolean; tilt: boolean } {
  const frames = isAssembly(doc) ? asmFrames(doc) : [doc.frame];
  let turn = false, slide = false, tilt = false;
  for (const f of frames) {
    if (f.root?.sliding || f.root?.guillotine) { slide = true; continue; }
    for (const c of frameLayout(f).cells) {
      const op = c.cell.type === 'sash' || c.cell.type === 'door_sash' ? c.cell.open ?? 'turn' : null;
      if (!op) continue;
      if (op === 'vslide' || op === 'sliding' || op === 'psk' || op === 'hs') slide = true; else turn = true;
      if (op === 'tilt_turn' || (op === 'vslide' && c.cell.tilt_clean)) tilt = true;
    }
  }
  return { turn, slide, tilt };
}
