import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { DecorStroke, PartDecor, ViewerPart } from './types.js';

/**
 * Декор фасада (docs/decor_contract.md) — геометрия в локальной системе детали, мм
 * (x — длина, y — ширина, лицевая сторона — z = 0, наружу — z < 0).
 *
 * Как рисуем дёшево:
 * - фрезеровка — плоская полоса чуть перед лицом фасада: стенки паза с наклонёнными нормалями
 *   и тёмное дно (цвет вершин), без CSG. Видна как паз с освещённой и тенистой стенкой;
 * - накладка (молдинг) — настоящий профиль (плоский с фасками или полукруглый), выдавлен по пути;
 * - металлическая вставка — тонкая полоса с «бликующими» нормалями + тёмный шов под ней.
 * Всё идёт в тот же меш, что и сам фасад (общий материал с vertexColors) — ноль лишних вызовов
 * отрисовки; металл вставки — атрибут `metalMask` = 1, сдвиг глубины декора — `decorLift` = 1
 * (шейдерный патч patchDecorMaterial).
 */

type P2 = [number, number];

/** Точка профиля поперёк пути: s — смещение поперёк (мм), z — высота над лицом (мм), нормаль (ns, nz), цвет. */
interface ProfilePt {
  s: number;
  z: number;
  ns: number;
  nz: number;
  c: number;
}

/** Профиль: набор ломаных; внутри ломаной нормали гладкие, между ломаными — жёсткий излом. */
type Profile = ProfilePt[][];

const TWO_PI = Math.PI * 2;
const EPS = 1e-6;

export interface DecorPolyline {
  pts: P2[];
  closed: boolean;
}

/**
 * Путь декора → ломаная. Понимает оба вида: с первым сегментом `move` (как шлёт ядро) и без него
 * (контракт: тогда начало — `start` или, у замкнутого пути, конец последнего сегмента).
 */
export function strokePolyline(stroke: DecorStroke, curveSegments = 16): DecorPolyline {
  const segs = Array.isArray(stroke.path) ? stroke.path.filter(Boolean) : [];
  let start: P2 | null = null;
  let rest = segs;
  if (segs[0]?.kind === 'move') {
    start = [segs[0].x, segs[0].y];
    rest = segs.slice(1);
  } else if (Array.isArray(stroke.start) && stroke.start.length >= 2) {
    start = [stroke.start[0], stroke.start[1]];
  } else if (rest.length) {
    const last = rest[rest.length - 1]!;
    start = [last.x, last.y];
  }
  if (!start) return { pts: [], closed: false };
  const pts: P2[] = [start];
  let [px, py] = start;
  for (const seg of rest) {
    if (seg.kind === 'move') {
      // Разрыв внутри пути не поддерживаем — просто переходим
      pts.push([seg.x, seg.y]);
    } else if (seg.kind === 'arc') {
      const r = Math.hypot(px - seg.cx, py - seg.cy);
      const a0 = Math.atan2(py - seg.cy, px - seg.cx);
      let a1 = Math.atan2(seg.y - seg.cy, seg.x - seg.cx);
      const same = Math.abs(px - seg.x) < EPS && Math.abs(py - seg.y) < EPS;
      if (same) a1 = seg.clockwise ? a0 - TWO_PI : a0 + TWO_PI;
      else if (seg.clockwise) while (a1 > a0 - EPS) a1 -= TWO_PI;
      else while (a1 < a0 + EPS) a1 += TWO_PI;
      const sweep = a1 - a0;
      const n = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * curveSegments));
      for (let i = 1; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        pts.push(i === n ? [seg.x, seg.y] : [seg.cx + r * Math.cos(a), seg.cy + r * Math.sin(a)]);
      }
    } else {
      pts.push([seg.x, seg.y]);
    }
    px = seg.x;
    py = seg.y;
  }
  // Убираем повторы
  const clean: P2[] = [];
  for (const p of pts) {
    const q = clean[clean.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.01) clean.push(p);
  }
  const first = clean[0];
  const last = clean[clean.length - 1];
  const loops = Boolean(first && last && clean.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.05);
  const closed = stroke.closed ?? loops;
  if (loops) clean.pop();
  return { pts: clean, closed: closed && clean.length > 2 };
}

// ---------- Профили ----------

const flatPt = (s: number, z: number, c: number): ProfilePt => ({ s, z, ns: 0, nz: 1, c });

/** Паз фрезы: стенки с нормалями к центру, тёмное дно. Лежит на 0.3 мм перед лицом. */
export function grooveProfile(width: number): Profile {
  const w = width / 2;
  const b = width * 0.3;
  const z = 0.3;
  const t = 0.72; // наклон нормали стенки (≈ 46°)
  const n = Math.sqrt(1 - t * t);
  return [
    [
      { s: -w, z, ns: t, nz: n, c: 0.86 },
      { s: -w + b, z, ns: t, nz: n, c: 0.7 },
    ],
    [flatPt(-w + b, z, 0.56), flatPt(w - b, z, 0.56)],
    [
      { s: w - b, z, ns: -t, nz: n, c: 0.7 },
      { s: w, z, ns: -t, nz: n, c: 0.86 },
    ],
  ];
}

/** Тёмный шов под металлической вставкой (паз под неё). */
export function seamProfile(width: number): Profile {
  const w = width / 2 + 0.8;
  return [[flatPt(-w, 0.2, 0.32), flatPt(w, 0.2, 0.32)]];
}

/** Накладка: 'round' — полукруг (эллипс w × h), иначе плоская с фасками. */
export function overlayProfile(width: number, height: number, kind: string): Profile {
  const w = width / 2;
  const h = Math.max(0.5, height);
  if (kind === 'round') {
    const pts: ProfilePt[] = [];
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const th = Math.PI - (Math.PI * i) / n;
      const ns = Math.cos(th) / w;
      const nz = Math.sin(th) / h;
      const l = Math.hypot(ns, nz) || 1;
      pts.push({ s: Math.cos(th) * w, z: Math.sin(th) * h, ns: ns / l, nz: nz / l, c: 0.8 + 0.2 * Math.sin(th) });
    }
    return [pts];
  }
  const c = Math.min(1.5, h * 0.3, w * 0.25);
  const d = Math.SQRT1_2;
  return [
    [
      { s: -w, z: 0, ns: -1, nz: 0, c: 0.78 },
      { s: -w, z: h - c, ns: -1, nz: 0, c: 0.95 },
    ],
    [
      { s: -w, z: h - c, ns: -d, nz: d, c: 1 },
      { s: -w + c, z: h, ns: -d, nz: d, c: 1 },
    ],
    [flatPt(-w + c, h, 1), flatPt(w - c, h, 1)],
    [
      { s: w - c, z: h, ns: d, nz: d, c: 1 },
      { s: w, z: h - c, ns: d, nz: d, c: 1 },
    ],
    [
      { s: w, z: h - c, ns: 1, nz: 0, c: 0.95 },
      { s: w, z: 0, ns: 1, nz: 0, c: 0.78 },
    ],
  ];
}

/** Металлическая вставка: чуть выпуклая полоса, нормали утрированы — блик бежит по краям. */
export function inlayProfile(width: number): Profile {
  const w = width / 2;
  const ss = [-1, -0.6, 0, 0.6, 1];
  const zs = [0.15, 0.55, 0.65, 0.55, 0.15];
  const ns = [-0.8, -0.38, 0, 0.38, 0.8];
  return [ss.map((s, i) => ({ s: s * w, z: zs[i]!, ns: ns[i]!, nz: Math.sqrt(1 - ns[i]! ** 2), c: 1 }))];
}

// ---------- Выдавливание профиля по ломаной ----------

interface Builder {
  pos: number[];
  nrm: number[];
  col: number[];
  msk: number[];
  /** Текущее значение metalMask для новых вершин. */
  metal: number;
}

const newBuilder = (): Builder => ({ pos: [], nrm: [], col: [], msk: [], metal: 0 });

/**
 * Профиль по ломаной. faceZ — лицевая плоскость (локальная z), out — куда «наружу» по z (−1 у лицевой стороны z = 0).
 */
function sweep(b: Builder, line: DecorPolyline, profile: Profile, faceZ: number, out: number, caps: boolean): void {
  const { pts, closed } = line;
  const n = pts.length;
  if (n < 2) return;
  // Касательные и поперечные направления (влево от хода), сдвиг угла — по биссектрисе
  const perp: P2[] = [];
  const miter: P2[] = [];
  const segN = (i: number): P2 => {
    const a = pts[i]!;
    const c = pts[(i + 1) % n]!;
    const dx = c[0] - a[0];
    const dy = c[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const nPrev = hasPrev ? segN((i - 1 + n) % n) : null;
    const nNext = hasNext ? segN(i) : null;
    const a = nPrev ?? nNext!;
    const c = nNext ?? nPrev!;
    let mx = a[0] + c[0];
    let my = a[1] + c[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = c[0];
      my = c[1];
    } else {
      mx /= ml;
      my /= ml;
    }
    // Длина сдвига на углу: 1 / cos(половины угла), не больше 3
    const cos = mx * c[0] + my * c[1];
    const k = Math.min(3, 1 / Math.max(cos, 1 / 3));
    perp.push([mx, my]);
    miter.push([mx * k, my * k]);
  }
  const vert = (i: number, p: ProfilePt) => {
    const q = pts[i]!;
    const m = miter[i]!;
    const pp = perp[i]!;
    b.pos.push(q[0] + m[0] * p.s, q[1] + m[1] * p.s, faceZ + out * p.z);
    b.nrm.push(pp[0] * p.ns, pp[1] * p.ns, out * p.nz);
    b.col.push(p.c);
    b.msk.push(b.metal);
  };
  const segs = closed ? n : n - 1;
  for (const poly of profile) {
    for (let k = 0; k + 1 < poly.length; k++) {
      const pa = poly[k]!;
      const pb = poly[k + 1]!;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        // Два треугольника: (i,a) (j,a) (j,b) и (i,a) (j,b) (i,b)
        vert(i, pa);
        vert(j, pa);
        vert(j, pb);
        vert(i, pa);
        vert(j, pb);
        vert(i, pb);
      }
    }
  }
  if (caps && !closed) {
    // Торцы открытого пути — веер из центра основания профиля
    const outline = profile.flat();
    for (const [i, dir] of [
      [0, -1],
      [n - 1, 1],
    ] as const) {
      const q = pts[i]!;
      const m = miter[i]!;
      const t: P2 = [m[1] * dir, -m[0] * dir]; // касательная наружу
      const tl = Math.hypot(t[0], t[1]) || 1;
      for (let k = 0; k + 1 < outline.length; k++) {
        const pa = outline[k]!;
        const pb = outline[k + 1]!;
        for (const p of [{ s: 0, z: 0 }, pa, pb]) {
          b.pos.push(q[0] + m[0] * p.s, q[1] + m[1] * p.s, faceZ + out * p.z);
          b.nrm.push(t[0] / tl, t[1] / tl, 0);
          b.col.push(b.metal ? 1 : 0.85);
          b.msk.push(b.metal);
        }
      }
    }
  }
}

/** Треугольники — лицом по нормали вершин (обход не зависит от направления пути). */
function toGeometry(b: Builder): BufferGeometry | null {
  if (!b.pos.length) return null;
  const pos = new Float32Array(b.pos);
  const nrm = new Float32Array(b.nrm);
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i]!, ay = pos[i + 1]!, az = pos[i + 2]!;
    const e1x = pos[i + 3]! - ax, e1y = pos[i + 4]! - ay, e1z = pos[i + 5]! - az;
    const e2x = pos[i + 6]! - ax, e2y = pos[i + 7]! - ay, e2z = pos[i + 8]! - az;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const nx = nrm[i]! + nrm[i + 3]! + nrm[i + 6]!;
    const ny = nrm[i + 1]! + nrm[i + 4]! + nrm[i + 7]!;
    const nz = nrm[i + 2]! + nrm[i + 5]! + nrm[i + 8]!;
    if (cx * nx + cy * ny + cz * nz < 0) {
      // Меняем местами 2-ю и 3-ю вершины
      for (const arr of [pos, nrm]) {
        for (let k = 0; k < 3; k++) {
          const t = arr[i + 3 + k]!;
          arr[i + 3 + k] = arr[i + 6 + k]!;
          arr[i + 6 + k] = t;
        }
      }
      const v = i / 3;
      for (const arr of [b.col, b.msk]) {
        const t = arr[v + 1]!;
        arr[v + 1] = arr[v + 2]!;
        arr[v + 2] = t;
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  const col = new Float32Array(b.col.length * 3);
  for (let i = 0; i < b.col.length; i++) col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = b.col[i]!;
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setAttribute('metalMask', new BufferAttribute(new Float32Array(b.msk), 1));
  g.setAttribute('decorLift', new BufferAttribute(new Float32Array(b.msk.length).fill(1), 1));
  return g;
}

export interface LocalDecorGeometry {
  /** Пазы, швы, накладки и вставки — в меш фасада (атрибуты color и metalMask). */
  surface: BufferGeometry | null;
  /** Отделка вставок (одна на фасад: первая встреченная), null — вставок нет. */
  inlayFinish: string | null;
  /** С какой вершины surface начинаются вставки (они идут последними). */
  inlayStart: number;
  /** Вставка — кант по периметру. */
  inlayEdge: boolean;
}

/** Есть ли у детали декор, которому нужен материал с цветом вершин. */
export function hasDecor(part: ViewerPart): boolean {
  return Boolean(part.decor && typeof part.decor === 'object');
}

/** Геометрия декора детали в локальных мм (до размещения). */
export function localDecorGeometry(part: ViewerPart, curveSegments = 16): LocalDecorGeometry {
  const d: PartDecor = part.decor ?? {};
  const back = d.face === 'back' || d.face === 'A';
  const faceZ = back ? part.thickness : 0;
  const out = back ? 1 : -1;
  const surf = newBuilder();
  const seg = Math.max(4, Math.round(curveSegments / 2));
  for (const m of d.milling ?? []) {
    const line = strokePolyline(m, seg);
    sweep(surf, line, grooveProfile(m.width ?? 8), faceZ, out, false);
  }
  for (const o of d.overlay ?? []) {
    const line = strokePolyline(o, seg);
    sweep(surf, line, overlayProfile(o.width ?? 20, o.height ?? 8, o.profile ?? 'flat'), faceZ, out, true);
  }
  const inlays = (d.inlay ?? []).map((s) => ({ s, line: strokePolyline(s, seg) }));
  // Сначала тёмные швы, потом металл — металл последним (диапазон треугольников для выбора касанием)
  for (const { s, line } of inlays) sweep(surf, line, seamProfile(s.width ?? 6), faceZ, out, false);
  const inlayStart = surf.col.length;
  surf.metal = 1;
  for (const { s, line } of inlays) sweep(surf, line, inlayProfile(s.width ?? 6), faceZ, out, true);
  const first = inlays[0]?.s;
  return {
    surface: toGeometry(surf),
    inlayFinish: first ? first.finish ?? 'brass' : null,
    inlayStart,
    inlayEdge: Boolean(first?.edge),
  };
}

/** Атрибуты декора у самой детали: белый color и metalMask = 0 (для слияния в одном материале). */
export function addDecorAttributes(g: BufferGeometry): void {
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  g.setAttribute('metalMask', new BufferAttribute(new Float32Array(n), 1));
  g.setAttribute('decorLift', new BufferAttribute(new Float32Array(n), 1));
}

/** Шероховатость по блеску краски (матовая 0.8, полуматовая 0.45, глянец 0.15). */
export function paintRoughness(gloss: string | undefined): number {
  return gloss === 'gloss' ? 0.15 : gloss === 'satin' ? 0.45 : 0.8;
}

/** Название вставки для выбора касанием. */
export function inlayName(finish: string, edge: boolean | undefined, finishName?: string): string {
  const what = edge ? 'Кант' : 'Вставка';
  const of: Record<string, string> = { brass: 'латунь', gold: 'золото', black: 'чёрный', chrome: 'хром' };
  return `${what} (${of[finish] ?? finishName?.toLowerCase() ?? finish})`;
}

/** Цвет света по температуре (K): тёплый, нейтральный, холодный. sRGB. */
export function kelvinColor(temp: number | undefined): Color {
  const t = temp ?? 3000;
  if (t <= 3400) return new Color('#ffcf94');
  if (t <= 4800) return new Color('#ffe9cf');
  return new Color('#e9f1ff');
}
