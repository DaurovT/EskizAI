import { BufferAttribute, BufferGeometry, DataTexture, LinearFilter, RGBAFormat, UnsignedByteType, Vector3 } from 'three';

/**
 * LED-подсветка: алюминиевый профиль с молочным рассеивателем + «пятно» света на поверхности под ним.
 * Пятно — прямоугольник с градиентной текстурой и аддитивным смешением (дёшево, работает в expo-gl
 * и в Lambert), плюс одна PointLight на отрезок — чтобы подсветились стенки ниши.
 */

/**
 * Градиенты пятен (атлас 64 × 128, RGBA8). Нижняя половина — «лужа» под профилем: поперёк мягкий гаусс,
 * вдоль — плато с затуханием к концам. Верхняя — «заливка» стены: ярко у профиля (v = 1), гаснет вниз.
 */
export function createGlowTexture(size = 64): DataTexture {
  const H = size * 2;
  const data = new Uint8Array(size * H * 4);
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let j = 0; j < H; j++) {
    const wash = j >= size;
    const v = ((j % size) + 0.5) / size;
    // Края каждой половины — ноль, чтобы половины не «текли» друг в друга при фильтрации
    const edge = smooth(0, 0.06, v) * smooth(1, 0.94, v);
    const across = wash
      ? Math.pow(v, 2.2) * (0.35 + 0.65 * Math.exp(-((1 - v) * (1 - v)) / 0.02)) * smooth(1, 0.9, v) + 0.0
      : Math.exp(-((v - 0.5) * (v - 0.5)) / 0.03);
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const along = smooth(0, 0.3, u) * smooth(1, 0.7, u);
      const a = Math.round(255 * Math.min(1, across * along * edge));
      const o = (j * size + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = a;
      data[o + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, H, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.name = 'led-glow';
  tex.needsUpdate = true;
  return tex;
}

interface Quad {
  /** Центр, ось «вдоль» (u) и «поперёк» (v) — полуразмеры уже в векторах. */
  c: Vector3;
  u: Vector3;
  v: Vector3;
  normal: Vector3;
  /** Обрезка по UV (0..1), если пятно упирается в край детали. */
  u0?: number;
  u1?: number;
  v0?: number;
  v1?: number;
  /** Половина атласа: 'pool' — пятно под профилем (по умолчанию), 'wash' — заливка стены (v = 1 — у профиля). */
  atlas?: 'pool' | 'wash';
}

/** Прямоугольники → одна геометрия (position, normal, uv), лицом по normal. */
export function quadsGeometry(quads: Quad[]): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const p = new Vector3();
  for (const q of quads) {
    const u0 = q.u0 ?? 0, u1 = q.u1 ?? 1, v0 = q.v0 ?? 0, v1 = q.v1 ?? 1;
    const corner = (a: number, b: number) => {
      p.copy(q.c).addScaledVector(q.u, a * 2 - 1).addScaledVector(q.v, b * 2 - 1);
      pos.push(p.x, p.y, p.z);
      nrm.push(q.normal.x, q.normal.y, q.normal.z);
      uv.push(a, (q.atlas === 'wash' ? 0.5 : 0) + b * 0.5);
    };
    // Обход: смотрим против нормали; если u × v смотрит против нормали — меняем порядок
    const flip = new Vector3().crossVectors(q.u, q.v).dot(q.normal) < 0;
    const tri = flip
      ? [[u0, v0], [u1, v1], [u1, v0], [u0, v0], [u0, v1], [u1, v1]]
      : [[u0, v0], [u1, v0], [u1, v1], [u0, v0], [u1, v1], [u0, v1]];
    for (const [a, b] of tri) corner(a!, b!);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  return g;
}

export interface LedFrame {
  /** Начало и конец в сцене. */
  a: Vector3;
  b: Vector3;
  /** Вдоль профиля (единичный). */
  t: Vector3;
  /** Куда светит (единичный): вниз, у вертикального — к фасаду. */
  emit: Vector3;
  /** Поперёк профиля (единичный). */
  side: Vector3;
  length: number;
}

export function ledFrame(a: Vector3, b: Vector3): LedFrame {
  const t = b.clone().sub(a);
  const length = t.length();
  t.normalize();
  const down = new Vector3(0, -1, 0);
  const emit = Math.abs(t.dot(down)) > 0.7 ? new Vector3(0, 0, 1) : down;
  const side = new Vector3().crossVectors(t, emit).normalize();
  return { a, b, t, emit, side, length };
}

/**
 * Профиль: алюминий (цвет вершин 0.6) + рассеиватель (1.0). groove — заподлицо с панелью (виден только низ),
 * иначе накладной короб высотой h. Размеры — в единицах сцены.
 */
export function ledProfileGeometry(f: LedFrame, width: number, height: number, groove: boolean): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const box = (s0: number, s1: number, e0: number, e1: number, c: number, faces: Array<'bottom' | 'sides' | 'ends'>) => {
    // s — поперёк (side), e — вдоль emit (0 — плоскость панели), x — вдоль t
    const P = (x: number, s: number, e: number) =>
      f.a.clone().addScaledVector(f.t, x).addScaledVector(f.side, s).addScaledVector(f.emit, e);
    const L = f.length;
    const quad = (p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, n: Vector3) => {
      const e1 = p1.clone().sub(p0);
      const e2 = p2.clone().sub(p0);
      const flip = e1.cross(e2).dot(n) < 0;
      const order = flip ? [p0, p2, p1, p0, p3, p2] : [p0, p1, p2, p0, p2, p3];
      for (const p of order) {
        pos.push(p.x, p.y, p.z);
        nrm.push(n.x, n.y, n.z);
        col.push(c, c, c);
      }
    };
    if (faces.includes('bottom')) quad(P(0, s0, e1), P(L, s0, e1), P(L, s1, e1), P(0, s1, e1), f.emit);
    if (faces.includes('sides')) {
      const ns = f.side.clone();
      quad(P(0, s1, e0), P(L, s1, e0), P(L, s1, e1), P(0, s1, e1), ns);
      quad(P(0, s0, e0), P(L, s0, e0), P(L, s0, e1), P(0, s0, e1), ns.clone().negate());
    }
    if (faces.includes('ends')) {
      quad(P(0, s0, e0), P(0, s1, e0), P(0, s1, e1), P(0, s0, e1), f.t.clone().negate());
      quad(P(L, s0, e0), P(L, s1, e0), P(L, s1, e1), P(L, s0, e1), f.t);
    }
  };
  const w = width / 2;
  const rim = Math.min(width * 0.15, w * 0.4);
  if (groove) {
    // Заподлицо: рамка алюминия и рассеиватель чуть ниже панели
    const e = height * 0.08;
    box(-w, w, 0, e, 0.6, ['bottom', 'sides', 'ends']);
    box(-w + rim, w - rim, 0, e * 1.6, 1, ['bottom']);
  } else {
    box(-w, w, 0, height, 0.6, ['bottom', 'sides', 'ends']);
    box(-w + rim, w - rim, 0, height * 1.04, 1, ['bottom']);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  return g;
}

export type { Quad };
