/**
 * Геометрия 3D-окна из дерева изделия (договор docs/shapes_contract.md): рама по контуру формы, импосты,
 * створки, ручки, стекло/панели, раскладка, декор стекла, составные изделия (угловые, эркеры).
 * Координаты: метры, центр изделия в начале, y вверх, вид изнутри — со стороны +z (снаружи — −z).
 * Раскладка ячеек и отступы — как в 2D-схеме (Schema.tsx): рама 64, импост по 42 от оси, створка накладывается на 8.
 * Фигурная ячейка = её прямоугольник ∩ контур рамы; многоугольники считаем в мм раскладки (y вниз).
 */
import {
  BoxGeometry, BufferGeometry, Color, DoubleSide, EdgesGeometry, ExtrudeGeometry, Group, LineBasicMaterial, LineSegments, Mesh,
  MeshStandardMaterial, Path, Shape,
  ShapeGeometry, Vector2, type Material,
} from 'three';
import { forgedDecor } from '@/lib/decorPattern';

import type { Cell, Doc, Node } from '@/api/types';
import { layout, type Layout } from '@/lib/tree';

const M = 0.001; // мм → м
const FRAME = 64; // видимая ширина рамы
const MULLION_HALF = 42; // свет от оси импоста (как inset в Schema) → лицо импоста 84
const SASH_OVERLAP = 8; // створка заходит на раму/импост
const SASH_FACE = 50; // видимая ширина профиля створки
const DOOR_FACE = 64; // дверная створка: стойки и верх
const DOOR_BOTTOM = 120; // дверная створка: широкий низ
const SASH_PROUD = 12; // створка выступает внутрь от рамы
const GLASS_BITE = 10; // стекло заходит в профиль
const PANEL = 24; // толщина сэндвич-панели
const ARC_STEP = (5 * Math.PI) / 180; // шаг ломаной дуги (договор: ≤ 10°)

const rad = (deg: number) => (deg * Math.PI) / 180;
const TURN = rad(35); // поворот вокруг вертикальной кромки
const TURN_H = rad(20); // поворот вокруг горизонтальной кромки (петли сверху/снизу)
const TILT = rad(12); // откидывание вокруг нижней кромки
const TOP_HUNG = rad(15); // подвесное — наружу вокруг верхней кромки
const PIVOT = rad(25); // среднеподвесное — вокруг горизонтальной оси посередине

// ---------- поля договора, которых ещё может не быть в types.ts — читаем без опоры на типы ----------
type Muntins = { kind?: string; v?: number; h?: number; width_mm?: number; pattern?: string; color?: string };
type GlassDecor = { decor?: string; tint?: string };
type FrameX = { w: number; h: number; shape?: string; shape_params?: Record<string, unknown>; root?: Node };
type AsmItem = { frame?: FrameX | string; w?: number; joint?: string; angle?: number };

type Pt = [number, number];
type Rect = { x0: number; y0: number; x1: number; y1: number };
type Side = Layout['cells'][0]['sides']['l'];

/** Створка для анимации: pivot стоит на оси открывания, anim крутится/едет, внутри — тело створки. */
export type SashRig = {
  anim: Group;
  mode: 'rotX' | 'rotY' | 'slide';
  /** угол при t = 1 (рад) или сдвиг по x (м) для slide */
  amount: number;
  /** поворотно-откидная: второе положение — откидывание вокруг нижней кромки */
  tiltAnim?: Group;
  tiltAmount?: number;
  /** ножницы откидывания: рычаг от рамы к верху створки, пересчитывается при каждом угле (в метрах, в системе узла откидывания) */
  arm?: { mesh: Mesh; x: number; h: number };
};

export type WindowModel = {
  root: Group;
  sashes: SashRig[];
  /** габарит в метрах: ширина, высота, глубина */
  size: { w: number; h: number; d: number };
  dispose(): void;
};

/** Открывание: tTurn — поворот (и все прочие виды), tTilt — откидывание поворотно-откидных; 0 — закрыто, 1 — открыто. */
export function applyOpen(model: WindowModel, tTurn: number, tTilt = 0) {
  for (const s of model.sashes) {
    s.anim.rotation.set(0, 0, 0);
    s.anim.position.set(0, 0, 0);
    if (s.tiltAnim) {
      s.tiltAnim.rotation.set(0, 0, 0);
      s.anim.rotation.y = s.amount * tTurn;
      s.tiltAnim.rotation.x = (s.tiltAmount ?? 0) * tTilt;
    } else if (s.mode === 'rotX') s.anim.rotation.x = s.amount * Math.max(tTurn, tTilt);
    else if (s.mode === 'rotY') s.anim.rotation.y = s.amount * tTurn;
    else { s.anim.position.x = s.amount * tTurn; s.anim.position.z = 0.03 * tTurn; } // откатная — во внутренний полоз
    if (s.arm) {
      // ножницы: от точки на раме (над верхом створки) к верху наклонённой створки
      const th = s.tiltAnim ? (s.tiltAmount ?? 0) * tTilt : s.amount * Math.max(tTurn, tTilt);
      const { mesh, x, h } = s.arm;
      const ay = h + 0.012, az = -0.006, by = h * Math.cos(th), bz = h * Math.sin(th);
      const dy = by - ay, dz = bz - az, len = Math.hypot(dy, dz);
      mesh.visible = th > 0.01;
      mesh.position.set(x, (ay + by) / 2, (az + bz) / 2);
      mesh.scale.set(0.014, Math.max(len, 0.001), 0.006);
      mesh.rotation.set(Math.atan2(dz, dy), 0, 0);
    }
  }
}

// ---------- цвета ----------
/** Декор → цвет: невалидный hex — тёплый белый; почти белый — тёплый оттенок, чтобы читались грани. */
function decor(hex: string): Color {
  const v = (hex ?? '').trim();
  const ok = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
  const c = new Color(ok ? (v.startsWith('#') ? v : `#${v}`) : '#F1EDE5');
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return hsl.l > 0.9 && hsl.s < 0.3 ? new Color('#F1EDE5') : c;
}
const lightness = (c: Color) => { const hsl = { h: 0, s: 0, l: 0 }; c.getHSL(hsl); return hsl.l; };

// ---------- многоугольники (мм, y вниз) ----------
const area = (p: Pt[]) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
};
const bbox = (p: Pt[]): Rect => {
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of p) { r.x0 = Math.min(r.x0, x); r.y0 = Math.min(r.y0, y); r.x1 = Math.max(r.x1, x); r.y1 = Math.max(r.y1, y); }
  return r;
};

/** Убрать совпадающие и лежащие на одной прямой точки. */
function clean(p: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const q of p) { const l = out[out.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 0.3) out.push(q); }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.3) out.pop();
  if (out.length < 3) return out;
  return out.filter((b, i) => {
    const a = out[(i - 1 + out.length) % out.length], c = out[(i + 1) % out.length];
    const ab = [b[0] - a[0], b[1] - a[1]], bc = [c[0] - b[0], c[1] - b[1]];
    const sin = (ab[0] * bc[1] - ab[1] * bc[0]) / (Math.hypot(ab[0], ab[1]) * Math.hypot(bc[0], bc[1]) || 1);
    return Math.abs(sin) > 1e-4 || ab[0] * bc[0] + ab[1] * bc[1] < 0;
  });
}

/** Отсечение многоугольника полуплоскостью по оси k: оставить q[k] ≥ v (greater) или ≤ v. */
function clipAxis(p: Pt[], k: 0 | 1, v: number, greater: boolean): Pt[] {
  const out: Pt[] = [];
  const inside = (q: Pt) => (greater ? q[k] >= v - 1e-9 : q[k] <= v + 1e-9);
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (v - a[k]) / (b[k] - a[k]);
      const q: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      q[k] = v;
      out.push(q);
    }
  }
  return out;
}
const clipRect = (p: Pt[], r: Rect) =>
  clean(clipAxis(clipAxis(clipAxis(clipAxis(p, 0, r.x0, true), 0, r.x1, false), 1, r.y0, true), 1, r.y1, false));

/** Отсечение произвольного многоугольника выпуклым (Сазерленд — Ходжмен). */
function clipConvex(p: Pt[], clip: Pt[]): Pt[] {
  const s = area(clip) > 0 ? 1 : -1;
  let out = p;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (q: Pt) => s * ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]));
    const src = out; out = [];
    for (let j = 0; j < src.length; j++) {
      const c = src[j], d = src[(j + 1) % src.length];
      const sc = side(c), sd = side(d);
      if (sc >= 0) out.push(c);
      if ((sc >= 0) !== (sd >= 0)) { const t = sc / (sc - sd); out.push([c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t]); }
    }
  }
  return clean(out);
}

/**
 * Сдвиг сторон выпуклого многоугольника внутрь на d(i) мм (отрицательное — наружу).
 * Пересечение сдвинутых полуплоскостей: углы получаются «на ус», а на коротких рёбрах дуги нет петель.
 */
function offset(p: Pt[], d: (i: number) => number): Pt[] {
  const n = p.length, s = area(p) > 0 ? 1 : -1;
  const r = bbox(p), pad = Math.max(r.x1 - r.x0, r.y1 - r.y0) + 1000;
  let out: Pt[] = [[r.x0 - pad, r.y0 - pad], [r.x1 + pad, r.y0 - pad], [r.x1 + pad, r.y1 + pad], [r.x0 - pad, r.y1 + pad]];
  if (s < 0) out.reverse(); // та же ориентация, что у p
  for (let i = 0; i < n && out.length; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const nx = (-(b[1] - a[1]) / L) * s, ny = ((b[0] - a[0]) / L) * s; // нормаль внутрь
    const di = d(i);
    const side = (q: Pt) => nx * (q[0] - a[0]) + ny * (q[1] - a[1]) - di;
    const src = out; out = [];
    for (let j = 0; j < src.length; j++) {
      const c = src[j], e = src[(j + 1) % src.length];
      const sc = side(c), se = side(e);
      if (sc >= 0) out.push(c);
      if ((sc >= 0) !== (se >= 0)) { const t = sc / (sc - se); out.push([c[0] + (e[0] - c[0]) * t, c[1] + (e[1] - c[1]) * t]); }
    }
  }
  return clean(out);
}
/** Внутренний контур годится: та же ориентация и не вырожден. */
const valid = (inner: Pt[], outer: Pt[]) =>
  inner.length >= 3 && Math.sign(area(inner)) === Math.sign(area(outer)) && Math.abs(area(inner)) > 400;

/** Отрезок ∩ выпуклый многоугольник (Сайрус — Бек). */
function clipSeg(a: Pt, b: Pt, poly: Pt[]): [Pt, Pt] | null {
  const s = area(poly) > 0 ? 1 : -1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const nx = -(q[1] - p[1]) * s, ny = (q[0] - p[0]) * s; // внутрь
    const num = nx * (a[0] - p[0]) + ny * (a[1] - p[1]);
    const den = nx * dx + ny * dy;
    if (Math.abs(den) < 1e-12) { if (num < 0) return null; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
}

// ---------- контур рамы (§1 договора), по часовой от левого нижнего угла ----------
function contour(f: FrameX): Pt[] {
  const w = f.w, h = f.h;
  const sp = f.shape_params ?? {};
  const legacy = f.root as (Node & { shape?: string; rise_mm?: number }) | undefined;
  let shape = f.shape ?? 'rect';
  let params: Record<string, unknown> = sp;
  if ((shape === 'rect' || !f.shape) && legacy?.shape === 'arch') { shape = 'arch'; params = { rise: legacy.rise_mm }; }
  const num = (k: string, def: number) => { const v = params[k]; return typeof v === 'number' && Number.isFinite(v) ? v : def; };
  switch (shape) {
    case 'arch': {
      const c = w / 2, s = Math.min(Math.max(num('rise', Math.min(w / 2, h)), 1), Math.min(w / 2, h));
      const R = (c * c + s * s) / (2 * s), f0 = Math.asin(Math.min(1, c / R));
      const n = Math.max(2, Math.ceil((2 * f0) / ARC_STEP));
      const pts: Pt[] = [[0, h]];
      for (let i = 0; i <= n; i++) { const a = -f0 + (2 * f0 * i) / n; pts.push([w / 2 + R * Math.sin(a), R - R * Math.cos(a)]); }
      pts.push([w, h]);
      return clean(pts);
    }
    case 'circle': {
      const r = Math.min(w, h) / 2, n = Math.ceil((2 * Math.PI) / ARC_STEP);
      return Array.from({ length: n }, (_, i): Pt => {
        const a = Math.PI / 2 + (2 * Math.PI * i) / n;
        return [w / 2 + r * Math.cos(a), h / 2 + r * Math.sin(a)];
      });
    }
    case 'trapezoid': {
      const hl = Math.min(h, Math.max(1, num('h_left', h))), hr = Math.min(h, Math.max(1, num('h_right', h)));
      return clean([[0, h], [0, h - hl], [w, h - hr], [w, h]]);
    }
    case 'bevel': {
      const corner = String(params.corner ?? 'tr');
      const dx = Math.min(Math.max(num('dx', w / 4), 0), w / 2), dy = Math.min(Math.max(num('dy', h / 4), 0), h / 2);
      const tl: Pt[] = corner === 'tl' || corner === 'both' ? [[0, dy], [dx, 0]] : [[0, 0]];
      const tr: Pt[] = corner === 'tr' || corner === 'both' ? [[w - dx, 0], [w, dy]] : [[w, 0]];
      return clean([[0, h], ...tl, ...tr, [w, h]]);
    }
    case 'triangle':
      return clean([[0, h], [Math.min(w, Math.max(0, num('apex', w / 2))), 0], [w, h]]);
    default:
      return [[0, h], [0, 0], [w, 0], [w, h]];
  }
}

// ---------- сборка ----------
type Mats = { out: MeshStandardMaterial; in: MeshStandardMaterial; handle: MeshStandardMaterial; white: MeshStandardMaterial; gold: MeshStandardMaterial };
type Env = {
  D: number; unit: BoxGeometry; geos: BufferGeometry[]; mats: Mats; all: Material[]; sashes: SashRig[]; dark: MeshStandardMaterial;
  glass: (fill: GlassDecor | undefined) => MeshStandardMaterial;
};

/** Материал стекла по декору (§8): кэш по ключу. */
function glassFactory(all: Material[]) {
  const cache = new Map<string, MeshStandardMaterial>();
  const make = (key: string, color: string, opacity: number, roughness: number, metalness = 0) => {
    let m = cache.get(key);
    if (!m) {
      m = new MeshStandardMaterial({ color: new Color(color), roughness, metalness, transparent: true, opacity, depthWrite: false, side: DoubleSide });
      cache.set(key, m); all.push(m);
    }
    return m;
  };
  const TINT: Record<string, string> = { bronze: '#8A6A45', grey: '#6E7378', blue: '#4F7FA6' };
  return (f: GlassDecor | undefined) => {
    switch (f?.decor) {
      case 'matte': return make('matte', '#F3F5F6', 0.7, 0.9);
      case 'tinted': { const t = TINT[f.tint ?? ''] ? f.tint! : 'grey'; return make(`tint:${t}`, TINT[t], 0.55, 0.15); }
      case 'mirror': return make('mirror', '#3A4248', 0.85, 0.08, 0.9);
      case 'pattern': return make('pattern', '#E6EEF2', 0.55, 0.75);
      default: return make('clear', '#BFDDEE', 0.3, 0.1);
    }
  };
}

const STAINED = ['#D2574A', '#3F86C6', '#EFC64A', '#4FA66B']; // те же цвета, что у витража на схеме (Schema.tsx)

/** Одна рама (центр в начале координат) → Group. */
function buildFrame(f: FrameX, env: Env): Group {
  const W = Math.max(f.w || 0, 200), H = Math.max(f.h || 0, 200);
  const frame: FrameX = { ...f, w: W, h: H, root: f.root ?? { cell: { type: 'fixed' } } };
  const { D, unit, geos, mats } = env;
  const L = layout({ kind: 'window', frame: frame as Doc['frame'] });
  const root = new Group();
  const X = (x: number) => (x - W / 2) * M;
  const Y = (y: number) => (H / 2 - y) * M;
  const v2 = (p: Pt[]) => p.map(([x, y]) => new Vector2(X(x), Y(y)));

  /** бокс по раскладке: x/y в мм (y вниз), z в мм */
  const box = (parent: Group, mat: Material, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number) => {
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), d = Math.abs(z1 - z0);
    if (w < 0.5 || h < 0.5 || d < 0.5) return;
    const m = new Mesh(unit, mat);
    m.scale.set(w * M, h * M, d * M);
    m.position.set(X((x0 + x1) / 2), Y((y0 + y1) / 2), ((z0 + z1) / 2) * M);
    parent.add(m);
  };
  /** брусок вдоль отрезка a→b шириной w (раскладка) */
  const rod = (parent: Group, a: Pt, b: Pt, w: number, z0: number, z1: number, mat: Material) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 3) return;
    const m = new Mesh(unit, mat);
    m.scale.set(len * M, w * M, (z1 - z0) * M);
    m.position.set(X((a[0] + b[0]) / 2), Y((a[1] + b[1]) / 2), ((z0 + z1) / 2) * M);
    m.rotation.z = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
    parent.add(m);
  };
  /** призма по многоугольнику (с отверстием) — двухцветная по глубине: снаружи out, внутри in */
  const prism = (parent: Group, outer: Pt[], hole: Pt[] | null, z0: number, z1: number, split = true, mat?: Material) => {
    if (outer.length < 3 || Math.abs(area(outer)) < 1) return;
    const shape = new Shape(v2(outer));
    if (hole && hole.length >= 3) shape.holes.push(new Path(v2(hole)));
    const half = split ? (z1 - z0) / 2 : z1 - z0;
    const geo = new ExtrudeGeometry(shape, { depth: half * M, bevelEnabled: false, curveSegments: 1 });
    geos.push(geo);
    const a = new Mesh(geo, split ? mats.out : mat ?? mats.out);
    a.position.z = z0 * M;
    parent.add(a);
    if (split) { const b = new Mesh(geo, mats.in); b.position.z = (z0 + half) * M; parent.add(b); }
  };
  const flat = (parent: Group, poly: Pt[], z: number, mat: Material, order: number) => {
    if (poly.length < 3 || Math.abs(area(poly)) < 1) return;
    const geo = new ShapeGeometry(new Shape(v2(poly)), 1);
    geos.push(geo);
    const g = new Mesh(geo, mat);
    g.position.z = z * M;
    g.renderOrder = order; // после непрозрачных рам
    parent.add(g);
  };

  /** заполнение: стекло (по декору) или панель (два слоя цвета профиля) */
  const fill = (parent: Group, cell: Cell, poly: Pt[], zc: number) => {
    const fl = cell.fill as (Cell['fill'] & GlassDecor) | undefined;
    if (cell.type === 'panel' || fl?.kind === 'panel') { prism(parent, poly, null, zc - PANEL / 2, zc + PANEL / 2); return; }
    flat(parent, poly, zc, env.glass(fl), 2);
    if (fl?.decor === 'stained') {
      // витраж: та же сетка ромбов, что на схеме (Schema.GlassDecorArt): шаг d = max(60, min(ш,в)/3), ряды со сдвигом ½
      const r = bbox(poly), gw = r.x1 - r.x0, gh = r.y1 - r.y0, d = Math.max(60, Math.min(gw, gh) / 3);
      let k = 0;
      for (let j = 0; j * d <= gh + d && k < 160; j++) for (let i = 0; i * d <= gw + d && k < 160; i++) for (const off of [0, 0.5]) {
        const cx = r.x0 + (i + off) * d, cy = r.y0 + (j + off) * d;
        const dia: Pt[] = [[cx, cy - d / 2], [cx + d / 2, cy], [cx, cy + d / 2], [cx - d / 2, cy]];
        const part = clipConvex(dia, poly);
        if (part.length >= 3) flat(parent, part, zc, env.glass({ decor: `stained${(i + j * 2 + (off ? 1 : 0)) % STAINED.length}` }), 3);
        k++;
      }
    }
  };

  /** раскладка (§2) в стекле poly на глубине стекла zc */
  const muntins = (parent: Group, mu: Muntins, poly: Pt[], zc: number) => {
    const r = bbox(poly), cx = (r.x0 + r.x1) / 2;
    const segs: [Pt, Pt][] = [];
    const pattern = mu.pattern ?? 'grid';
    const lines = (v: number, h: number) => {
      for (let i = 1; i <= v; i++) { const x = r.x0 + ((r.x1 - r.x0) * i) / (v + 1); segs.push([[x, r.y0 - 1], [x, r.y1 + 1]]); }
      for (let j = 1; j <= h; j++) { const y = r.y0 + ((r.y1 - r.y0) * j) / (h + 1); segs.push([[r.x0 - 1, y], [r.x1 + 1, y]]); }
    };
    const cnt = (x: unknown, def: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(20, Math.max(0, Math.round(x))) : def);
    if (pattern === 'cross') lines(1, 1);
    else if (pattern === 'sun') {
      // лучи из центра низа и дуговые кольца
      const c: Pt = [cx, r.y1 - 0.5];
      const R = Math.max(...poly.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      const rays = cnt(mu.v, 5), rings = cnt(mu.h, 1);
      for (let k = 1; k <= rays; k++) {
        const a = (Math.PI * k) / (rays + 1);
        segs.push([c, [c[0] + Math.cos(a) * R * 1.1, c[1] - Math.sin(a) * R * 1.1]]);
      }
      for (let k = 1; k <= rings; k++) {
        const rr = (R * k) / (rings + 1), n = 18;
        for (let i = 0; i < n; i++) {
          const a0 = (Math.PI * i) / n, a1 = (Math.PI * (i + 1)) / n;
          segs.push([[c[0] + Math.cos(a0) * rr, c[1] - Math.sin(a0) * rr], [c[0] + Math.cos(a1) * rr, c[1] - Math.sin(a1) * rr]]);
        }
      }
    } else if (pattern === 'decor') {
      // кованая вставка — та же форма, что на схеме (lib/decorPattern)
      for (const line of forgedDecor(r)) for (let i = 1; i < line.length; i++) segs.push([line[i - 1], line[i]]);
    } else lines(cnt(mu.v, 1), cnt(mu.h, 1));

    const overlay = mu.kind === 'overlay';
    const w = typeof mu.width_mm === 'number' && mu.width_mm > 0 ? mu.width_mm : pattern === 'decor' ? 10 : overlay ? 26 : 18;
    const color = mu.color ?? (pattern === 'decor' ? 'gold' : 'white');
    for (const [a, b] of segs) {
      const s = clipSeg(a, b, poly);
      if (!s) continue;
      if (overlay) {
        // фальш-переплёт с двух сторон, цвета профиля своей стороны
        rod(parent, s[0], s[1], w, zc + 14, zc + 22, mats.in);
        rod(parent, s[0], s[1], w, zc - 22, zc - 14, mats.out);
      } else if (color === 'decor') {
        rod(parent, s[0], s[1], w, zc - 3, zc, mats.out);
        rod(parent, s[0], s[1], w, zc, zc + 3, mats.in);
      } else rod(parent, s[0], s[1], w, zc - 3, zc + 3, color === 'gold' ? mats.gold : mats.white);
    }
  };
  const cellMuntins = (parent: Group, cell: Cell, poly: Pt[], zc: number) => {
    const mu = (cell as unknown as { muntins?: Muntins | null }).muntins;
    if (!mu || typeof mu !== 'object' || cell.type === 'panel' || cell.fill?.kind === 'panel') return;
    muntins(parent, mu, poly, zc);
  };

  // ---------- рама: кольцо по контуру с усами в углах ----------
  const outer = contour(frame);
  const inner = offset(outer, () => FRAME);
  const zf0 = -D / 2, zf1 = D / 2;
  if (valid(inner, outer)) prism(root, outer, inner, zf0, zf1);
  else prism(root, outer, null, zf0, zf1);
  if (!valid(inner, outer)) return root;

  // ---------- импосты: прямоугольник ∩ свет рамы ----------
  for (const m of L.mullions) {
    const a = m.from === 0 ? 0 : m.from + MULLION_HALF;
    const r: Rect = m.orient === 'v'
      ? { x0: m.at - MULLION_HALF, y0: a, x1: m.at + MULLION_HALF, y1: m.to === H ? H : m.to - MULLION_HALF }
      : { x0: a, y0: m.at - MULLION_HALF, x1: m.to === W ? W : m.to - MULLION_HALF, y1: m.at + MULLION_HALF };
    prism(root, clipRect(inner, r), null, zf0, zf1);
  }

  // ---------- ячейки ----------
  const mi = (s: Side) => (s === 'mullion' ? MULLION_HALF : 0);
  const solidSide = (s: Side) => s === 'frame' || s === 'mullion';
  for (const { cell, box: b, sides } of L.cells) {
    const cr: Rect = { x0: b.x0 + mi(sides.l), y0: b.y0 + mi(sides.t), x1: b.x1 - mi(sides.r), y1: b.y1 - mi(sides.b) };
    if (cr.x1 - cr.x0 < 1 || cr.y1 - cr.y0 < 1) continue;
    const light = clipRect(inner, cr);
    if (light.length < 3 || Math.abs(area(light)) < 100) continue;
    // сторона ячейки под ребром света: на границе прямоугольника — её тип, иначе это контур рамы
    const solidEdge = (i: number) => {
      const p = light[i], q = light[(i + 1) % light.length];
      const on = (k: 0 | 1, v: number) => Math.abs(p[k] - v) < 0.5 && Math.abs(q[k] - v) < 0.5;
      if (on(0, cr.x0)) return solidSide(sides.l);
      if (on(0, cr.x1)) return solidSide(sides.r);
      if (on(1, cr.y0)) return solidSide(sides.t);
      if (on(1, cr.y1)) return solidSide(sides.b);
      return true;
    };
    const isSash = cell.type === 'sash' || cell.type === 'door_sash';
    if (!isSash) {
      fill(root, cell, offset(light, (i) => (solidEdge(i) ? -GLASS_BITE : 0)), 0);
      cellMuntins(root, cell, light, 0);
      continue;
    }

    // створка: контур = свет + нахлёст на раму/импост (у штульпа — без нахлёста)
    const S = offset(light, (i) => (solidEdge(i) ? -SASH_OVERLAP : 0));
    const sb = bbox(S);
    const door = cell.type === 'door_sash';
    const face = (i: number, k: number) => {
      const p = S[i], q = S[(i + 1) % S.length];
      const bottom = Math.abs(p[1] - q[1]) < 0.5 && Math.abs(p[1] - sb.y1) < 0.5;
      return k * (door ? (bottom ? DOOR_BOTTOM : DOOR_FACE) : SASH_FACE);
    };
    let hole = offset(S, (i) => face(i, 1));
    if (!valid(hole, S)) hole = offset(S, (i) => face(i, 0.4));
    const zs1 = D / 2 + SASH_PROUD, zs0 = zs1 - D, zsm = (zs0 + zs1) / 2;

    const op = String(cell.open ?? 'turn');
    const hinge = String(cell.hinge ?? (op === 'top_hung' ? 'top' : 'left'));
    let px = (sb.x0 + sb.x1) / 2, py = (sb.y0 + sb.y1) / 2, pz = zs1;
    let mode: SashRig['mode'] = 'rotY', amount = 0;
    if (op === 'tilt') { py = sb.y1; mode = 'rotX'; amount = TILT; }
    else if (op === 'top_hung') { py = sb.y0; pz = zs0; mode = 'rotX'; amount = TOP_HUNG; }
    else if (op === 'pivot') { pz = zsm; mode = 'rotX'; amount = PIVOT; }
    else if (op === 'sliding') { mode = 'slide'; amount = ((hinge === 'right' ? 1 : -1) * (sb.x1 - sb.x0) * M) / 3; }
    else if (hinge === 'left') { px = sb.x0; amount = -TURN; }
    else if (hinge === 'right') { px = sb.x1; amount = TURN; }
    else if (hinge === 'top') { py = sb.y0; mode = 'rotX'; amount = -TURN_H; }
    else { py = sb.y1; mode = 'rotX'; amount = TURN_H; }

    /** ножницы: со стороны петель (у откидной — слева), в узле откидывания (низ створки, середина) */
    const makeArm = (holder: Group) => {
      const mesh = new Mesh(unit, mats.handle); mesh.visible = false; holder.add(mesh);
      const side = hinge === 'right' ? sb.x1 - 70 : sb.x0 + 70;
      return { mesh, x: (side - (sb.x0 + sb.x1) / 2) * M, h: (sb.y1 - sb.y0) * M };
    };
    const pivot = new Group();
    pivot.position.set(X(px), Y(py), pz * M);
    const anim = new Group();
    const body = new Group();
    body.position.set(-X(px), -Y(py), -pz * M);
    pivot.add(anim); anim.add(body);
    if (op === 'tilt_turn' && mode === 'rotY') {
      // откидывание: вся створка (с узлом поворота) наклоняется вокруг нижней кромки внутрь
      const tp = new Group(); tp.position.set(X((sb.x0 + sb.x1) / 2), Y(sb.y1), zs1 * M);
      const tAnim = new Group(); const wrap = new Group(); wrap.position.set(-tp.position.x, -tp.position.y, -tp.position.z);
      tp.add(tAnim); tAnim.add(wrap); wrap.add(pivot); root.add(tp);
      env.sashes.push({ anim, mode, amount, tiltAnim: tAnim, tiltAmount: TILT, arm: makeArm(tp) });
    } else {
      root.add(pivot);
      env.sashes.push({ anim, mode, amount, ...(op === 'tilt' ? { arm: makeArm(pivot) } : {}) });
    }

    if (!valid(hole, S)) { prism(body, S, null, zs0, zs1); continue; } // слишком мелкая — сплошная
    prism(body, S, hole, zs0, zs1);
    fill(body, cell, offset(hole, () => -GLASS_BITE), zsm);
    cellMuntins(body, cell, hole, zsm);

    // ручка — у стороны против петель, по середине; откидная и среднеподвесная — сверху, подвесная — снизу
    if (cell.handle !== false) {
      const hb = bbox(hole);
      const side = op === 'tilt' || op === 'pivot' ? 'top' : op === 'top_hung' ? 'bottom'
        : hinge === 'left' ? 'right' : hinge === 'right' ? 'left' : hinge === 'top' ? 'bottom' : 'top';
      const vert = side === 'left' || side === 'right';
      const cx = side === 'left' ? (sb.x0 + hb.x0) / 2 : side === 'right' ? (sb.x1 + hb.x1) / 2 : (sb.x0 + sb.x1) / 2;
      const cy = side === 'top' ? (sb.y0 + hb.y0) / 2 : side === 'bottom' ? (sb.y1 + hb.y1) / 2 : (sb.y0 + sb.y1) / 2;
      const z = zs1, hm = mats.handle;
      if (vert) {
        box(body, hm, cx - 13, cy - 40, cx + 13, cy + 32, z, z + 8); // розетка
        box(body, hm, cx - 8, cy - 8, cx + 8, cy + 8, z + 8, z + 20); // шейка
        box(body, hm, cx - 9, cy - 8, cx + 9, cy + 110, z + 18, z + 30); // рычаг вниз
      } else {
        box(body, hm, cx - 40, cy - 13, cx + 32, cy + 13, z, z + 8);
        box(body, hm, cx - 8, cy - 8, cx + 8, cy + 8, z + 8, z + 20);
        box(body, hm, cx - 8, cy - 9, cx + 110, cy + 9, z + 18, z + 30); // рычаг вдоль профиля
      }
    }

    // петли (накладки) — на стороне петель, по две: у поворотных сбоку сверху/снизу, у откидной — снизу, у подвесной — сверху
    if (op !== 'pivot' && op !== 'sliding' && op !== 'psk' && op !== 'hs' && op !== 'folding') {
      const hs = op === 'tilt' ? 'bottom' : op === 'top_hung' ? 'top' : hinge;
      const L = 90, W = 22, z0 = zs1 - 2, z1 = zs1 + 14;
      const ends: [number, number][] = hs === 'left' || hs === 'right'
        ? [[sb.y0 + 70, sb.y0 + 70 + L], [sb.y1 - 70 - L, sb.y1 - 70]]
        : [[sb.x0 + 70, sb.x0 + 70 + L], [sb.x1 - 70 - L, sb.x1 - 70]];
      for (const [a, b] of ends) {
        if (hs === 'left') box(root, mats.handle, sb.x0 - W / 2, a, sb.x0 + W / 2, b, z0, z1);
        else if (hs === 'right') box(root, mats.handle, sb.x1 - W / 2, a, sb.x1 + W / 2, b, z0, z1);
        else if (hs === 'top') box(root, mats.handle, a, sb.y0 - W / 2, b, sb.y0 + W / 2, z0, z1);
        else box(root, mats.handle, a, sb.y1 - W / 2, b, sb.y1 + W / 2, z0, z1);
      }
    }

    // запорные цапфы по торцу створки (видны, когда створка открыта): со стороны ручки 2–3, сверху и снизу по одной у широких
    if (op === 'turn' || op === 'tilt_turn' || op === 'tilt') {
      const hside = op === 'tilt' ? 'top' : hinge === 'left' ? 'right' : 'left';
      const zc = zs0 + D * 0.35, hh = sb.y1 - sb.y0, ww = sb.x1 - sb.x0;
      const cams: [number, number][] = [];
      if (hside === 'left' || hside === 'right') {
        const n = hh > 1200 ? 3 : 2, xe = hside === 'right' ? sb.x1 : sb.x0, dir = hside === 'right' ? 1 : -1;
        for (let i = 1; i <= n; i++) { const y = sb.y0 + (hh * i) / (n + 1); cams.push([xe + dir * 4, y]); }
        for (const [x, y] of cams) box(body, mats.handle, x - 4, y - 7, x + 4, y + 7, zc - 5, zc + 5);
      }
      if (ww > 600) for (const y of [sb.y0 - 4, sb.y1 + 4]) box(body, mats.handle, (sb.x0 + sb.x1) / 2 - 7, y - 4, (sb.x0 + sb.x1) / 2 + 7, y + 4, zc - 5, zc + 5);
    }

    // варианты ручки и опции (§9.6): ключ, кнопка, блокиратор, гребёнка, ограничитель
    const opts = (cell as unknown as { options?: Record<string, string | null> }).options ?? {};
    const hcode = String(opts.handle ?? '');
    if (cell.handle !== false && (op === 'turn' || op === 'tilt_turn')) {
      const hb = bbox(hole);
      const right = hinge === 'left';
      const cx = right ? (sb.x1 + hb.x1) / 2 : (sb.x0 + hb.x0) / 2, cy = (sb.y0 + sb.y1) / 2;
      const dark = env.dark;
      if (hcode.includes('handle_key')) box(body, dark, cx - 5, cy + 18, cx + 5, cy + 30, zs1 + 7, zs1 + 10);          // личинка под ключ
      if (hcode.includes('handle_lock')) box(body, dark, cx - 4, cy - 34, cx + 4, cy - 26, zs1 + 7, zs1 + 11);         // кнопка
      if (opts.child_lock) box(body, mats.handle, cx - 9, sb.y1 - 160, cx + 9, sb.y1 - 110, zs1, zs1 + 14);            // блокиратор
      const fx = right ? sb.x1 + 14 : sb.x0 - 14;                                                                       // на раме, против ручки
      if (opts.comb) {
        box(root, mats.handle, fx - 7, cy + 60, fx + 7, cy + 150, zs1 - 2, zs1 + 6);
        for (let k = 0; k < 4; k++) box(root, mats.handle, fx - 7, cy + 70 + k * 20, fx + 7, cy + 76 + k * 20, zs1 + 6, zs1 + 14);
      }
      if (opts.limiter) { const lx = right ? sb.x0 + 140 : sb.x1 - 140; box(root, mats.handle, lx - 40, sb.y0 - 10, lx + 40, sb.y0 + 6, zs1 - 2, zs1 + 10); }
    }
    if (opts.micro_vent && op === 'tilt_turn') {
      const mx = hinge === 'left' ? sb.x1 : sb.x0;
      box(root, mats.handle, mx - 6, sb.y0 + 40, mx + 6, sb.y0 + 90, zs1 - 2, zs1 + 8);                                 // ступень микропроветривания
    }
  }
  return root;
}

/** Составное изделие (§4): рамы по ломаной в плане, стыки — вертикальные соединители. */
function buildAssembly(items: AsmItem[], hDefault: number, env: Env): Group {
  const frames: { f: FrameX; joint?: AsmItem }[] = [];
  for (const it of items) {
    if (it.joint) { if (frames.length) frames[frames.length - 1].joint = it; continue; }
    const f = typeof it.frame === 'object' && it.frame
      ? it.frame
      : { w: it.w ?? 1000, h: hDefault, root: { cell: { type: 'fixed' as const } } }; // id шаблона — заглушка
    frames.push({ f });
  }
  const turn = (j?: AsmItem) => {
    if (!j || j.joint !== 'angle') return 0;
    const a = typeof j.angle === 'number' ? Math.min(180, Math.max(90, j.angle)) : 135;
    return rad(180 - a);
  };
  const Hmax = Math.max(...frames.map((x) => x.f.h || 0), 200);
  const yBase = -Hmax / 2;
  const asm = new Group();
  // общий поворот — половина суммы поворотов, чтобы изделие смотрело на зрителя симметрично
  let psi = frames.slice(0, -1).reduce((s, x) => s + turn(x.joint), 0) / 2;
  let px = 0, pz = 0;
  const D = env.D;
  const post = (x: number, z: number, angle: number, width: number, depth: number, h: number) => {
    const g = new Group();
    g.position.set(x, (yBase + h / 2) * M, z);
    g.rotation.y = angle;
    for (const [mat, z0, z1] of [[env.mats.out, -depth / 2, 0], [env.mats.in, 0, depth / 2]] as const) {
      const m = new Mesh(env.unit, mat);
      m.scale.set(width * M, h * M, (z1 - z0) * M);
      m.position.z = ((z0 + z1) / 2) * M;
      g.add(m);
    }
    asm.add(g);
  };
  frames.forEach(({ f, joint }, i) => {
    const w = Math.max(f.w || 0, 200), h = Math.max(f.h || 0, 200);
    const g = new Group();
    g.position.set(px, 0, pz);
    g.rotation.y = psi;
    const fr = buildFrame(f, env);
    fr.position.set((w / 2) * M, (yBase + h / 2) * M, 0);
    g.add(fr);
    asm.add(g);
    px += Math.cos(psi) * w * M; pz -= Math.sin(psi) * w * M;
    if (!joint || i === frames.length - 1) return;
    const hj = Math.max(h, frames[i + 1].f.h || 0);
    if (joint.joint === 'post') {
      // стойка 100 мм между рамами
      post(px + Math.cos(psi) * 0.05, pz - Math.sin(psi) * 0.05, psi, 100, D + 30, hj);
      px += Math.cos(psi) * 0.1; pz -= Math.sin(psi) * 0.1;
      return;
    }
    const d = turn(joint);
    // соединитель по биссектрисе стыка: перекрывает щель снаружи
    post(px, pz, psi - d / 2, D * Math.tan(d / 2) + 30, D, hj);
    psi -= d;
  });
  return asm;
}

export function buildWindow(doc: Doc, colorOut: string, colorIn: string, depthMm = 70): WindowModel {
  const D = Math.max(depthMm, 30);
  const unit = new BoxGeometry(1, 1, 1);
  const geos: BufferGeometry[] = [unit];
  const cOut = decor(colorOut), cIn = decor(colorIn);
  const mats: Mats = {
    out: new MeshStandardMaterial({ color: cOut, roughness: 0.6, metalness: 0 }),
    in: new MeshStandardMaterial({ color: cIn, roughness: 0.6, metalness: 0 }),
    // фурнитура всегда контрастная к профилю: белая ручка на белой створке в 3D не была видна совсем
    handle: lightness(cIn) > 0.6
      ? new MeshStandardMaterial({ color: new Color('#9EA4AB'), roughness: 0.3, metalness: 0.7 })
      : new MeshStandardMaterial({ color: new Color('#D9DCDF'), roughness: 0.3, metalness: 0.6 }),
    white: new MeshStandardMaterial({ color: new Color('#F4F2EE'), roughness: 0.5, metalness: 0 }),
    gold: new MeshStandardMaterial({ color: new Color('#C9A24A'), roughness: 0.35, metalness: 0.7 }),
  };
  const all: Material[] = Object.values(mats);
  const glassOf = glassFactory(all);
  const stained = STAINED.map((c, i) => {
    const m = new MeshStandardMaterial({ color: new Color(c), roughness: 0.2, transparent: true, opacity: 0.6, depthWrite: false, side: DoubleSide });
    all.push(m);
    return [`stained${i}`, m] as const;
  });
  const stainedMap = new Map<string, MeshStandardMaterial>(stained);
  const darkMat = new MeshStandardMaterial({ color: new Color('#3B3F44'), roughness: 0.4, metalness: 0.5 });
  all.push(darkMat);
  const env: Env = {
    D, unit, geos, mats, all, sashes: [], dark: darkMat,
    glass: (f) => stainedMap.get(f?.decor ?? '') ?? glassOf(f),
  };

  const root = new Group();
  const asmItems = (doc.frame.root as unknown as { assembly?: AsmItem[] }).assembly;
  let size: WindowModel['size'];
  if (doc.kind === 'assembly' && Array.isArray(asmItems) && asmItems.some((x) => !x.joint)) {
    const asm = buildAssembly(asmItems, Math.max(doc.frame.h || 0, 200), env);
    root.add(asm);
    // центр сборки — в начало координат
    asm.updateMatrixWorld(true);
    const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    asm.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      b.x0 = Math.min(b.x0, bb.min.x); b.y0 = Math.min(b.y0, bb.min.y); b.z0 = Math.min(b.z0, bb.min.z);
      b.x1 = Math.max(b.x1, bb.max.x); b.y1 = Math.max(b.y1, bb.max.y); b.z1 = Math.max(b.z1, bb.max.z);
    });
    asm.position.set(-(b.x0 + b.x1) / 2, -(b.y0 + b.y1) / 2, -(b.z0 + b.z1) / 2);
    size = { w: b.x1 - b.x0, h: b.y1 - b.y0, d: b.z1 - b.z0 + 2 * (SASH_PROUD + 30) * M };
  } else {
    const f = doc.frame as unknown as FrameX;
    root.add(buildFrame(f, env));
    size = { w: Math.max(f.w || 0, 200) * M, h: Math.max(f.h || 0, 200) * M, d: (D + 2 * (SASH_PROUD + 30)) * M };
  }

  // рёбра профиля тонкой тёмной линией — как на чертеже: створка читается отдельно от рамы, белое не сливается
  const edgeMat = new LineBasicMaterial({ color: new Color('#5E5A54'), transparent: true, opacity: 0.55 });
  all.push(edgeMat);
  const edgeOf = new Map<BufferGeometry, EdgesGeometry>();
  const profile: Mesh[] = [];
  root.traverse((o) => { const m = o as Mesh; if (m.isMesh && (m.material === mats.out || m.material === mats.in || m.material === mats.handle)) profile.push(m); });
  for (const m of profile) {
    let e = edgeOf.get(m.geometry);
    if (!e) { e = new EdgesGeometry(m.geometry, 25); edgeOf.set(m.geometry, e); geos.push(e); }
    m.add(new LineSegments(e, edgeMat));
  }

  return {
    root,
    sashes: env.sashes,
    size,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of all) m.dispose();
    },
  };
}
