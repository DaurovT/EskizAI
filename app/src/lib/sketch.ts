/**
 * Изометрический эскиз изделия для миниатюры списка проектов (Projects.dc.html, .pi): верх #F7F3EA, правый бок
 * #E6D3B1, фасад — контур #21201F с линиями дверей, ящиков и полок, ручки.
 *
 * Сервер отдаёт компактное описание (ProjectListItem.sketch, api services/sketch.py), здесь — геометрия:
 * коробки в мм → изометрия (ось ширины вправо-вниз под 30°, глубины — влево-вниз, высота вверх), как в макете.
 * sketchFromTree — то же описание из дерева модулей (мок API; повторяет services/sketch.py).
 */
import type { KitchenSketch, ProductSketch, ProductTree, SketchCol, SketchModule, SketchZone, WardrobeSketch } from '../api/types';

export const SKETCH_COLORS = { top: '#F7F3EA', side: '#E6D3B1', paper: '#FCFBF8', ink: '#21201F' } as const;

export type Pt = [number, number];
/** Грань-параллелограмм: o, o+u, o+u+v, o+v (в координатах проекции). */
export interface SketchFace { o: Pt; u: Pt; v: Pt; fill: string }
/** Отрезок: edge — контур коробки, line — двери/ящики/полки, handle — ручка, faint — штанга. */
export interface SketchLine { a: Pt; b: Pt; kind: 'edge' | 'line' | 'handle' | 'faint' }
/** Фигуры в порядке рисования (дальние коробки раньше ближних, у каждой — сначала грани, потом линии). */
export type SketchShape = ({ type: 'face' } & SketchFace) | ({ type: 'line' } & SketchLine);
export interface SketchGeometry { shapes: SketchShape[]; box: { x: number; y: number; w: number; h: number } }

const C = Math.cos(Math.PI / 6);
const S = 0.5;
type P3 = [number, number, number];
/** (x — ширина, y — глубина к зрителю, z — высота) → плоскость рисунка (y вниз). */
const proj = ([x, y, z]: P3): Pt => [(x - y) * C, (x + y) * S - z];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];

interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }
/** Что рисовать на видимой грани коробки: на фасаде (y = y1) или на правом боку (x = x1, у второго ряда угловой кухни). */
type FaceDraw = (at: (u: number, z: number) => P3, line: (a: P3, b: P3, kind?: SketchLine['kind']) => void) => void;

class Scene {
  shapes: SketchShape[] = [];
  private hulls: Pt[][] = [];
  private boxes: Box[] = [];

  line(a: P3, b: P3, kind: SketchLine['kind'] = 'line') {
    this.shapes.push({ type: 'line', a: proj(a), b: proj(b), kind });
  }

  private face(o: P3, u: P3, v: P3, fill: string) {
    const po = proj(o);
    this.shapes.push({ type: 'face', o: po, u: sub(proj(u), po), v: sub(proj(v), po), fill });
  }

  /**
   * Коробка: верх, правый бок (без частей, закрытых соседом справа вплотную), фасад. Фасад прозрачный (видна клетка),
   * но если его перекрывает уже нарисованная коробка — заливается цветом бумаги, чтобы задние линии не просвечивали.
   * front — линии на фасаде (u — вдоль ширины от x0), side — на правом боку (u — вдоль глубины от y0).
   */
  box(b: Box, opts: { front?: FaceDraw; side?: FaceDraw; neighbors?: Box[] } = {}) {
    const { x0, y0, z0, x1, y1, z1 } = b;
    const frontPoly = [proj([x0, y1, z0]), proj([x1, y1, z0]), proj([x1, y1, z1]), proj([x0, y1, z1])];
    const solid = this.hulls.some((h) => overlap(h, frontPoly));
    // верх
    this.face([x0, y0, z1], [x1, y0, z1], [x0, y1, z1], SKETCH_COLORS.top);
    // правый бок: вычитаем соседей справа вплотную, закрывающих всю глубину
    const covers = [...this.boxes, ...(opts.neighbors ?? [])]
      .filter((n) => Math.abs(n.x0 - x1) < 1 && n.y0 <= y0 + 1 && n.y1 >= y1 - 1)
      .map((n) => [Math.max(n.z0, z0), Math.min(n.z1, z1)] as [number, number])
      .filter(([a, c]) => c > a);
    const open = subtract([z0, z1], covers);
    for (const [za, zb] of open) {
      this.face([x1, y0, za], [x1, y1, za], [x1, y0, zb], SKETCH_COLORS.side);
    }
    if (solid) this.face([x0, y1, z0], [x1, y1, z0], [x0, y1, z1], SKETCH_COLORS.paper);
    // контур
    this.line([x0, y1, z0], [x1, y1, z0], 'edge');
    this.line([x1, y1, z0], [x1, y1, z1], 'edge');
    this.line([x1, y1, z1], [x0, y1, z1], 'edge');
    this.line([x0, y1, z1], [x0, y1, z0], 'edge');
    this.line([x0, y1, z1], [x0, y0, z1], 'edge');
    this.line([x0, y0, z1], [x1, y0, z1], 'edge');
    this.line([x1, y0, z1], [x1, y1, z1], 'edge');
    for (const [za, zb] of open) {
      this.line([x1, y0, za], [x1, y0, zb], 'edge');
      this.line([x1, y0, za], [x1, y1, za], 'edge');
      if (zb < z1) this.line([x1, y0, zb], [x1, y1, zb], 'edge');
    }
    opts.front?.((u, z) => [x0 + u, y1, z], (a, c, k) => this.line(a, c, k));
    opts.side?.((u, z) => [x1, y0 + u, z], (a, c, k) => this.line(a, c, k));
    const corners: P3[] = [];
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) corners.push([x, y, z]);
    this.hulls.push(hull(corners.map(proj)));
    this.boxes.push(b);
  }

  geometry(): SketchGeometry {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const h of this.hulls) for (const [x, y] of h) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX)) return { shapes: [], box: { x: 0, y: 0, w: 1, h: 1 } };
    return { shapes: this.shapes, box: { x: minX, y: minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) } };
  }
}

/** [a, b] минус отрезки covers. */
function subtract([a, b]: [number, number], covers: [number, number][]): [number, number][] {
  let out: [number, number][] = [[a, b]];
  for (const [c, d] of covers) {
    out = out.flatMap(([p, q]) => {
      if (d <= p || c >= q) return [[p, q]] as [number, number][];
      const r: [number, number][] = [];
      if (c > p) r.push([p, c]);
      if (d < q) r.push([d, q]);
      return r;
    });
  }
  return out.filter(([p, q]) => q - p > 1);
}

function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: Pt[] = [];
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Выпуклые многоугольники перекрываются (по площади, касание не в счёт) — теорема о разделяющей оси. */
function overlap(a: Pt[], b: Pt[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const n: Pt = [q[1] - p[1], p[0] - q[0]];
      const span = (ps: Pt[]) => { const d = ps.map((x) => x[0] * n[0] + x[1] * n[1]); return [Math.min(...d), Math.max(...d)]; };
      const [a0, a1] = span(a), [b0, b1] = span(b);
      const eps = 1e-6 * (Math.abs(n[0]) + Math.abs(n[1])) * 1000;
      if (a1 <= b0 + eps || b1 <= a0 + eps) return false;
    }
  }
  return true;
}

// ---------- шкаф ----------

/** Высоты зон снизу вверх: заданные как есть, остальные — поровну из остатка. */
function zoneHeights(zones: SketchZone[], total: number): number[] {
  const fixed = zones.reduce((s, z) => s + (z.h ?? 0), 0);
  const auto = zones.filter((z) => !z.h).length;
  const k = !auto && fixed > total ? total / fixed : 1;
  const rest = auto ? Math.max(total - fixed, 0) / auto : 0;
  return zones.map((z) => (z.h ? z.h * k : rest));
}

function wardrobe(sk: WardrobeSketch): SketchGeometry {
  const { w: W, h: H, d: D } = sk;
  const sc = new Scene();
  const plinth = Math.min(sk.plinth || 0, H * 0.2);
  const mezz = sk.mezz > 0 ? Math.min(sk.mezz + 16, H * 0.45) : 0;
  const top = H - mezz;
  const handleLen = H * 0.16;
  sc.box({ x0: 0, y0: 0, z0: 0, x1: W, y1: D, z1: H }, {
    front: (at, line) => {
      const vline = (u: number, za: number, zb: number, k: SketchLine['kind'] = 'line') => line(at(u, za), at(u, zb), k);
      const hline = (ua: number, ub: number, z: number, k: SketchLine['kind'] = 'line') => line(at(ua, z), at(ub, z), k);
      /** Вертикальная ручка двери по центру проёма [za, zb]. */
      const handle = (u: number, za: number, zb: number) => {
        const len = Math.min(handleLen, (zb - za) * 0.4);
        const mid = (za + zb) / 2;
        vline(u, mid - len / 2, mid + len / 2, 'handle');
      };
      /** Двери на проём [u0, u1] × [za, zb]: 1 — ручка со стороны без петель, 2 — по центру. */
      const doors = (u0: number, u1: number, za: number, zb: number, n: number, hinge: 'left' | 'right' = 'left') => {
        const w = u1 - u0;
        if (n >= 2) {
          vline(u0 + w / 2, za, zb);
          handle(u0 + w * 0.42, za, zb);
          handle(u0 + w * 0.58, za, zb);
        } else {
          handle(hinge === 'right' ? u0 + w * 0.14 : u0 + w * 0.86, za, zb);
        }
      };
      const drawers = (u0: number, u1: number, za: number, zb: number, n: number) => {
        const h = (zb - za) / Math.max(n, 1);
        for (let i = 0; i < n; i++) {
          if (i) hline(u0, u1, za + h * i);
          const m = za + h * (i + 0.5), w = u1 - u0;
          hline(u0 + w * 0.36, u0 + w * 0.64, m, 'handle');
        }
      };
      if (plinth > 0) hline(0, W, plinth);
      // колонки: относительные ширины → доли общей ширины
      const sum = sk.cols.reduce((s, c) => s + Math.max(c.w, 1), 0) || 1;
      const xs: number[] = [0];
      for (const c of sk.cols) xs.push(xs[xs.length - 1] + (Math.max(c.w, 1) / sum) * W);
      if (mezz > 0) {
        hline(0, W, top);
        sk.cols.forEach((c, i) => {
          if (i) vline(xs[i], top, H);
          if (xs[i + 1] - xs[i] > 600) vline((xs[i] + xs[i + 1]) / 2, top, H); // антресоль: до 600 — одна дверь
        });
      }
      if (sk.sliding > 0) {
        const n = sk.sliding, dw = W / n;
        for (let i = 0; i < n; i++) {
          if (i) vline(dw * i, plinth, top);
          handle(dw * i + dw * 0.76, plinth, top);
        }
        return;
      }
      sk.cols.forEach((c: SketchCol, i) => {
        const u0 = xs[i], u1 = xs[i + 1];
        if (i) vline(u0, plinth, top);
        const hs = zoneHeights(c.zones, top - plinth);
        let z = plinth;
        if (c.doors > 0) {
          // ящики снаружи (external) внизу остаются видны, остальное закрывают двери
          let k = 0;
          while (k < c.zones.length && c.zones[k].t === 'drawers' && c.zones[k].ext) {
            drawers(u0, u1, z, z + hs[k], c.zones[k].n ?? 1);
            z += hs[k];
            hline(u0, u1, z);
            k++;
          }
          doors(u0, u1, z, top, c.doors, c.hinge);
          return;
        }
        c.zones.forEach((zone, k) => {
          const za = z, zb = z + hs[k];
          if (k < c.zones.length - 1) hline(u0, u1, zb);
          if (zone.doors) doors(u0, u1, za, zb, zone.doors);
          else if (zone.t === 'shelves') {
            const n = zone.n ?? 1;
            for (let j = 1; j <= n; j++) hline(u0, u1, za + ((zb - za) * j) / (n + 1));
          } else if (zone.t === 'drawers') drawers(u0, u1, za, zb, zone.n ?? 1);
          else if (zone.t === 'rod') hline(u0 + (u1 - u0) * 0.06, u1 - (u1 - u0) * 0.06, zb - Math.min(90, (zb - za) * 0.12), 'faint');
          z = zb;
        });
      });
    },
  });
  return sc.geometry();
}

// ---------- кухня ----------

/** Линии модулей ряда на грани: границы модулей, двери, ящики, полки. */
function moduleLines(mods: SketchModule[], z0: number, z1: number, row: 'base' | 'wall', offset = 0): FaceDraw {
  return (at, line) => {
    let u = offset;
    mods.forEach((m, i) => {
      const u0 = u, u1 = u + m.w;
      u = u1;
      if (m.t === 'gap' || m.t === 'fridge') return;
      const hood = row === 'wall' && m.t === 'hood';
      const top = !hood && row === 'wall' && m.h ? Math.min(z0 + m.h, z1) : z1;
      const bot = hood ? z1 - (m.h ?? 360) : z0;
      if (i || offset > 0) line(at(u0, bot), at(u0, top));
      const h = top - bot;
      const vsplit = () => line(at((u0 + u1) / 2, bot), at((u0 + u1) / 2, top));
      if (m.t === 'drawers') {
        const n = m.n ?? 3;
        for (let k = 1; k < n; k++) line(at(u0, bot + (h * k) / n), at(u1, bot + (h * k) / n));
      } else if (m.t === 'open') {
        const n = m.n ?? 1;
        for (let k = 1; k <= n; k++) line(at(u0, bot + (h * k) / (n + 1)), at(u1, bot + (h * k) / (n + 1)));
      } else if (m.t === 'appliance') {
        const zz = row === 'base' ? bot + h * 0.78 : bot + h * 0.55;
        line(at(u0, zz), at(u1, zz));
      } else if (m.lift) {
        if (h > 700) line(at(u0, bot + h / 2), at(u1, bot + h / 2));
      } else if (m.t === 'doors' || m.t === 'sink' || m.t === 'hood') {
        if (m.rows === 2) line(at(u0, bot + h / 2), at(u1, bot + h / 2));
        if ((m.n ?? (m.w > 600 ? 2 : 1)) >= 2) vsplit();
      }
    });
  };
}

/** Модули ряда → коробки: подряд идущие одной высоты — одна коробка (gap — разрыв, fridge — своя высокая коробка). */
function runs(mods: SketchModule[], z0: number, z1: number, row: 'base' | 'wall', fridgeTop: number) {
  const out: { u0: number; u1: number; z0: number; z1: number; mods: SketchModule[]; fridge?: boolean }[] = [];
  let u = 0;
  for (const m of mods) {
    const u0 = u;
    u += m.w;
    if (m.t === 'gap') continue;
    const fridge = row === 'base' && m.t === 'fridge';
    const hood = row === 'wall' && m.t === 'hood';
    const zt = fridge ? fridgeTop : !hood && row === 'wall' && m.h ? z0 + m.h : z1;
    const zb = fridge ? 0 : hood ? zt - Math.min(m.h ?? 360, z1 - z0) : z0;
    const last = out[out.length - 1];
    if (last && !fridge && !last.fridge && Math.abs(last.u1 - u0) < 1 && last.z0 === zb && last.z1 === zt) {
      last.u1 = u;
      last.mods.push(m);
    } else out.push({ u0, u1: u, z0: zb, z1: zt, mods: [m], fridge });
  }
  return out;
}

function kitchen(sk: KitchenSketch): SketchGeometry {
  const sc = new Scene();
  const baseTop = sk.legs + sk.base_h;
  const wallTop = sk.wall_z + sk.wall_h;
  const fridgeTop = Math.max(wallTop, baseTop + 600);
  const corner = sk.layout === 'corner' && (sk.base2?.length || sk.wall2?.length);
  const left = corner && sk.corner_side === 'left';
  // квадратный угловой модуль занимает угол: второй ряд начинается за ним
  const cornerMod = sk.base.find((m) => m.t === 'corner');
  const extra = cornerMod?.shape === 'square' ? Math.max(cornerMod.w - sk.top_d, 0) : 0;

  const row1 = (mods: SketchModule[], kind: 'base' | 'wall') => {
    const z0 = kind === 'base' ? 0 : sk.wall_z;
    const z1 = kind === 'base' ? baseTop : wallTop;
    const depth = kind === 'base' ? sk.base_d : sk.wall_d;
    const rs = runs(mods, z0, z1, kind, fridgeTop);
    const boxes = rs.map((r) => ({ x0: r.u0, y0: 0, z0: r.z0, x1: r.u1, y1: r.fridge ? sk.top_d : depth, z1: r.z1 }));
    rs.forEach((r, i) => {
      const b = boxes[i];
      sc.box(b, {
        neighbors: boxes.slice(i + 1),
        front: r.fridge
          ? (at, line) => line(at(0, r.z1 * 0.62), at(r.u1 - r.u0, r.z1 * 0.62))
          : moduleLines(r.mods, r.z0, r.z1, kind),
      });
      // столешница над нижними (кроме холодильника)
      if (kind === 'base' && !r.fridge) {
        sc.box({ x0: r.u0, y0: 0, z0: baseTop, x1: r.u1, y1: sk.top_d, z1: baseTop + sk.top_t }, { neighbors: boxes.slice(i + 1) });
      }
    });
  };
  row1(sk.base, 'base');
  row1(sk.wall, 'wall');

  if (corner) {
    // второй ряд — вдоль соседней стены, к зрителю; его фасад смотрит вправо (угол слева) или к стене (угол справа)
    const len = (mods: SketchModule[] = []) => mods.reduce((s, m) => s + m.w, 0);
    const W = Math.max(len(sk.base), len(sk.wall));
    // модули второго ряда начинаются за угловым модулем; часть ряда у угла — продолжение углового модуля
    const y0 = sk.top_d + extra;
    const b2 = sk.base2 ?? [];
    const w2 = sk.wall2 ?? [];
    const x0b = left ? 0 : W - sk.base_d;
    if (b2.length) {
      const y1 = y0 + len(b2);
      sc.box({ x0: x0b, y0: sk.top_d, z0: 0, x1: x0b + sk.base_d, y1, z1: baseTop },
        { side: left ? moduleLines(b2, 0, baseTop, 'base', extra) : undefined });
      const x0t = left ? 0 : W - sk.top_d;
      sc.box({ x0: x0t, y0: sk.top_d, z0: baseTop, x1: x0t + sk.top_d, y1, z1: baseTop + sk.top_t });
    }
    if (w2.length) {
      const x0w = left ? 0 : W - sk.wall_d;
      sc.box({ x0: x0w, y0: sk.wall_d, z0: sk.wall_z, x1: x0w + sk.wall_d, y1: y0 + len(w2), z1: wallTop },
        { side: left ? moduleLines(w2, sk.wall_z, wallTop, 'wall', y0 - sk.wall_d) : undefined });
    }
  }
  return sc.geometry();
}

/** Геометрия эскиза в координатах проекции (мм). */
export function sketchGeometry(sk: ProductSketch): SketchGeometry {
  return sk.kind === 'kitchen' ? kitchen(sk) : wardrobe(sk);
}

// ---------- заглушки и дерево (мок) ----------

const doorsCol = (w: number, doors: number, zones: SketchZone[] = [{ t: 'shelves', n: 4 }]): SketchCol => ({ w, doors, zones });

/** Заглушка по типу изделия — у проекта ещё нет модели (черновик). */
export function defaultSketch(kind: string | null | undefined): ProductSketch {
  const k = kind ?? '';
  if (k.startsWith('kitchen')) {
    return {
      kind: 'kitchen', w: 2800, h: 2120, d: 600, legs: 100, base_h: 720, base_d: 560, top_d: 600, top_t: 38,
      wall_z: 1400, wall_h: 720, wall_d: 300, layout: 'straight',
      base: [{ t: 'drawers', w: 600, n: 3 }, { t: 'doors', w: 600 }, { t: 'sink', w: 800 }, { t: 'doors', w: 800 }],
      wall: [{ t: 'doors', w: 600 }, { t: 'doors', w: 600 }, { t: 'doors', w: 800 }, { t: 'doors', w: 800 }],
    };
  }
  const w = (sk: Partial<WardrobeSketch> & Pick<WardrobeSketch, 'w' | 'h' | 'd' | 'cols'>): WardrobeSketch =>
    ({ kind: 'wardrobe', plinth: 70, mezz: 0, sliding: 0, ...sk });
  if (k === 'rack') return w({ w: 900, h: 2000, d: 350, plinth: 0, cols: [{ w: 900, doors: 0, zones: [{ t: 'shelves', n: 3 }] }] });
  if (k === 'pencil') return w({ w: 450, h: 2000, d: 400, cols: [doorsCol(450, 1)] });
  if (k === 'dresser') return w({ w: 1000, h: 850, d: 450, cols: [{ w: 1000, doors: 0, zones: [{ t: 'drawers', n: 4 }] }] });
  if (k === 'tv_stand') return w({ w: 1800, h: 500, d: 450, cols: [doorsCol(600, 1), { w: 600, doors: 0, zones: [{ t: 'empty' }] }, doorsCol(600, 1)] });
  if (k === 'wardrobe_sliding') return w({ w: 1800, h: 2400, d: 600, sliding: 3, cols: [doorsCol(600, 0), doorsCol(600, 0), doorsCol(600, 0)] });
  return w({ w: 1500, h: 2100, d: 600, cols: [doorsCol(500, 1), doorsCol(1000, 2)] });
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const doorsOf = (v: unknown) => (v && typeof v === 'object' ? num(obj(v).count, 1) : 0);
const ZONES = new Set(['shelves', 'drawers', 'rod', 'empty']);

/** Описание эскиза по дереву модулей — как services/sketch.py на сервере (для мока). */
export function sketchFromTree(tree: ProductTree | null | undefined): ProductSketch | null {
  const t = obj(tree);
  if (!Object.keys(t).length) return null;
  if (t.type === 'kitchen') {
    const baseMod = (m0: unknown): SketchModule => {
      const m = obj(m0);
      const kind = typeof m.kind === 'string' ? m.kind : 'doors';
      const out: SketchModule = { t: kind, w: Math.round(num(m.width, 600)) };
      if (kind === 'drawers') out.n = num(m.drawers, 3);
      else if (num(m.doors)) out.n = num(m.doors);
      if (kind === 'fridge') out.h = Math.round(num(m.fridge_height, 1850));
      if (kind === 'corner') out.shape = m.corner_shape === 'square' ? 'square' : 'long';
      return out;
    };
    const wallMod = (m0: unknown): SketchModule => {
      const m = obj(m0);
      const kind = typeof m.kind === 'string' ? m.kind : 'doors';
      const out: SketchModule = { t: kind, w: Math.round(num(m.width, 600)) };
      if (kind === 'open') out.n = num(m.shelves, 1);
      else if (num(m.doors)) out.n = num(m.doors);
      if (num(m.height) > 0) out.h = Math.round(num(m.height));
      if (m.rows === 2) out.rows = 2;
      if (m.opening === 'lift') out.lift = true;
      return out;
    };
    const base = arr(t.base).map(baseMod);
    if (!base.length) return null;
    const wall = arr(t.wall).map(wallMod);
    const legs = num(t.legs_height, 100), baseH = num(t.base_height, 720), wallZ = num(t.wall_bottom, 1400), wallH = num(t.wall_height, 720);
    const top = obj(t.countertop);
    const thick = Number(String(top.material ?? '').split('_').find((p) => /^\d+$/.test(p)) ?? 38);
    const w1 = base.reduce((s, m) => s + m.w, 0), w2 = wall.filter((m) => m.t !== 'gap').reduce((s, m) => s + m.w, 0);
    const fridge = Math.max(0, ...base.filter((m) => m.t === 'fridge').map((m) => m.h ?? 0));
    const sk: KitchenSketch = {
      kind: 'kitchen', w: Math.max(w1, w2), h: Math.round(Math.max(wall.length ? wallZ + wallH : legs + baseH + thick, fridge)),
      d: Math.round(num(top.depth, 600)), legs, base_h: baseH, base_d: num(t.base_depth, 560), top_d: num(top.depth, 600), top_t: thick,
      wall_z: wallZ, wall_h: wallH, wall_d: num(t.wall_depth, 300), layout: t.layout === 'corner' ? 'corner' : 'straight', base, wall,
    };
    if (sk.layout === 'corner') {
      sk.corner_side = t.corner_side === 'left' ? 'left' : 'right';
      sk.base2 = arr(t.base2).map(baseMod);
      sk.wall2 = arr(t.wall2).map(wallMod);
    }
    return sk;
  }
  let W = num(t.width), H = num(t.height), D = num(t.depth);
  if (W <= 0 || H <= 0 || D <= 0) return null;
  const body = obj(t.body);
  const plinth = 'plinth' in body ? (body.plinth ? num(obj(body.plinth).height, 70) : 0) : 70;
  const sections = arr(t.sections).map(obj);
  const given = sections.map((s) => num(s.width) || null);
  const inner = W - 16 * (given.length + 1);
  const fixed = given.reduce<number>((s, x) => s + (x ?? 0), 0);
  const autoN = given.filter((x) => !x).length;
  const rest = autoN ? Math.max(inner - fixed, 0) / autoN : 0;
  const cols: SketchCol[] = sections.map((s, i) => {
    const zones: SketchZone[] = [];
    for (const z0 of arr(s.fill)) {
      const z = obj(z0);
      if (typeof z.kind !== 'string' || !ZONES.has(z.kind)) continue;
      const zone: SketchZone = { t: z.kind as SketchZone['t'] };
      if (z.kind === 'shelves' || z.kind === 'drawers') zone.n = num(z.count, 1);
      if (num(z.height) > 0) zone.h = Math.round(num(z.height));
      if (z.kind === 'drawers' && z.external) zone.ext = true;
      if (doorsOf(z.doors)) zone.doors = doorsOf(z.doors);
      zones.push(zone);
    }
    const col: SketchCol = { w: Math.round(given[i] ?? rest), doors: doorsOf(s.doors), zones };
    if (col.doors === 1) col.hinge = obj(s.doors).hinge === 'right' ? 'right' : 'left';
    return col;
  });
  for (const e0 of arr(t.end_units)) {
    const e = obj(e0);
    const ew = num(e.width, 300);
    const col: SketchCol = { w: Math.round(ew), doors: 0, zones: [{ t: 'shelves', n: num(e.shelves, 3) }] };
    if (e.side === 'left') cols.unshift(col); else cols.push(col);
    W += ew;
  }
  return {
    kind: 'wardrobe', w: Math.round(W), h: Math.round(H), d: Math.round(D), plinth: Math.round(plinth),
    mezz: Math.round(num(obj(t.mezzanine).height)), sliding: t.sliding_doors ? num(obj(t.sliding_doors).count) : 0, cols,
  };
}
