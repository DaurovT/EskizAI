import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';
import { coreAxisVector, coreToThree } from './axes.js';
import type { CoreVec3, ViewerModel, ViewerPart } from './types.js';

/**
 * Размеры (FR-19): габарит и ширины секций.
 *
 * Значения считаются в мм в осях ядра. Секции — промежутки между вертикальными
 * стойками (роль side / partition) на одной высоте. Стойки, которые касаются
 * друг друга (боковины соседних модулей кухни), считаются одной.
 */

export interface DimensionSection {
  /** Левая и правая граница секции (внутренние плоскости стоек), мм по X. */
  x0: number;
  x1: number;
  /** Ширина «в свету», мм. */
  width: number;
}

export interface DimensionRow {
  /** По какой высоте (Z, мм) снят ряд и пределы стоек этого ряда. */
  zMin: number;
  zMax: number;
  sections: DimensionSection[];
}

export interface DimensionInfo {
  overall: { width: number; height: number; depth: number };
  /** Пределы деталей в закрытом виде, мм, оси ядра (фасады — Y < 0). */
  bounds: { min: CoreVec3; max: CoreVec3 };
  /** Ряды секций снизу вверх (у кухни — нижние и верхние модули). */
  rows: DimensionRow[];
}

const VERTICAL_ROLES = new Set(['side', 'partition']);
/** Промежутки уже этого не считаем секцией (зазоры, стыки модулей), мм. */
const MIN_SECTION = 40;
const EPS = 0.5;

/** Пределы детали в осях ядра (мм) — по прямоугольнику length × width × thickness. */
export function partCoreBounds(p: ViewerPart): { min: CoreVec3; max: CoreVec3 } {
  const u = coreAxisVector(p.placement.u);
  const v = coreAxisVector(p.placement.v);
  const n = coreAxisVector(p.placement.n);
  const min: CoreVec3 = [Infinity, Infinity, Infinity];
  const max: CoreVec3 = [-Infinity, -Infinity, -Infinity];
  for (const a of [0, p.length]) {
    for (const b of [0, p.width]) {
      for (const c of [0, p.thickness]) {
        for (let k = 0; k < 3; k++) {
          const val = p.placement.origin[k]! + u[k]! * a + v[k]! * b + n[k]! * c;
          if (val < min[k]!) min[k] = val;
          if (val > max[k]!) max[k] = val;
        }
      }
    }
  }
  return { min, max };
}

interface Stand {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  idx: number;
}

/** Габарит и ширины секций по viewer model (без three.js-сцены). */
export function computeDimensions(model: ViewerModel): DimensionInfo {
  const min: CoreVec3 = [Infinity, Infinity, Infinity];
  const max: CoreVec3 = [-Infinity, -Infinity, -Infinity];
  const stands: Stand[] = [];
  model.parts.forEach((p, idx) => {
    const b = partCoreBounds(p);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, b.min[k]!);
      max[k] = Math.max(max[k]!, b.max[k]!);
    }
    // Вертикальная стойка: толщина вдоль X, неподвижная.
    if (VERTICAL_ROLES.has(p.role) && p.placement.n[1] === 'X' && !p.node) {
      stands.push({ x0: b.min[0], x1: b.max[0], z0: b.min[2], z1: b.max[2], idx });
    }
  });
  if (!model.parts.length) {
    min.fill(0);
    max.fill(0);
  }

  // Высоты, на которых «режем» изделие: середины стоек.
  const levels = [...new Set(stands.map((s) => (s.z0 + s.z1) / 2))].sort((a, b) => a - b);
  type Cut = { set: Set<number>; row: DimensionRow };
  const cuts: Cut[] = [];
  for (const z of levels) {
    const crossing = stands.filter((s) => s.z0 < z - EPS && s.z1 > z + EPS).sort((a, b) => a.x0 - b.x0);
    if (crossing.length < 2) continue;
    // Сливаем касающиеся стойки в блоки.
    const blocks: { x0: number; x1: number }[] = [];
    for (const s of crossing) {
      const last = blocks[blocks.length - 1];
      if (last && s.x0 <= last.x1 + EPS) last.x1 = Math.max(last.x1, s.x1);
      else blocks.push({ x0: s.x0, x1: s.x1 });
    }
    const sections: DimensionSection[] = [];
    for (let i = 0; i + 1 < blocks.length; i++) {
      const x0 = blocks[i]!.x1;
      const x1 = blocks[i + 1]!.x0;
      if (x1 - x0 >= MIN_SECTION) sections.push({ x0, x1, width: round1(x1 - x0) });
    }
    if (!sections.length) continue;
    cuts.push({
      set: new Set(crossing.map((s) => s.idx)),
      row: {
        zMin: Math.min(...crossing.map((s) => s.z0)),
        zMax: Math.max(...crossing.map((s) => s.z1)),
        sections,
      },
    });
  }
  // Убираем срезы, чьи стойки — часть другого среза (тот же ряд, просто ниже/выше короткой стойки).
  const kept = cuts.filter(
    (c) => !cuts.some((o) => o !== c && o.set.size > c.set.size && [...c.set].every((i) => o.set.has(i))),
  );
  // Одинаковые наборы секций (шкаф и антресоль над ним) — один ряд.
  const rows: DimensionRow[] = [];
  for (const c of kept) {
    const sig = signature(c.row.sections);
    const same = rows.find((r) => signature(r.sections) === sig);
    if (same) {
      same.zMin = Math.min(same.zMin, c.row.zMin);
      same.zMax = Math.max(same.zMax, c.row.zMax);
    } else {
      rows.push({ ...c.row, sections: c.row.sections.map((s) => ({ ...s })) });
    }
  }
  rows.sort((a, b) => a.zMin - b.zMin);
  const [w, h, d] = model.size;
  return { overall: { width: w, height: h, depth: d }, bounds: { min, max }, rows };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function signature(s: DimensionSection[]): string {
  return s.map((x) => `${Math.round(x.x0)}:${Math.round(x.x1)}`).join('|');
}

/** Подпись размера: целые мм; дробь — до 0.5 мм. */
export function formatMm(v: number): string {
  const r = Math.round(v * 2) / 2;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// ---------- Штриховой шрифт (цифры) ----------
// Семисегментные цифры из тонких полос: без canvas и шрифтов, работает и в вебе,
// и в React Native (expo-gl), и в Node.

type Seg = [number, number, number, number];
const SEG: Record<string, Seg> = {
  a: [0, 6, 4, 6],
  b: [4, 6, 4, 3],
  c: [4, 3, 4, 0],
  d: [0, 0, 4, 0],
  e: [0, 0, 0, 3],
  f: [0, 3, 0, 6],
  g: [0, 3, 4, 3],
};
const DIGITS: Record<string, string> = {
  '0': 'abcdef',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  '-': 'g',
};
const GLYPHS: Record<string, Seg[]> = {
  '1': [[0, 0, 0, 6]],
  '.': [[0, 0, 0.4, 0]],
  '×': [
    [0.8, 1, 3.2, 4],
    [0.8, 4, 3.2, 1],
  ],
};
for (const [ch, segs] of Object.entries(DIGITS)) GLYPHS[ch] = segs.split('').map((c) => SEG[c]!);
/** Ширина знака (без промежутка); промежуток — GAP. */
const GLYPH_W: Record<string, number> = { '1': 0, '.': 0.4 };
const GAP = 2;
const glyphW = (ch: string) => GLYPH_W[ch] ?? 4;
const STROKE = 0.75;

/** Геометрия текста в плоскости XY, центр — (0, 0), высота цифр `height`. Ширина — в userData.width. */
export function strokeTextGeometry(text: string, height: number): BufferGeometry {
  const s = height / 6;
  const pos: number[] = [];
  const chars = [...text];
  const total = chars.reduce((w, ch) => w + glyphW(ch), 0) + GAP * Math.max(0, chars.length - 1);
  let x0 = -total / 2;
  const hw = STROKE / 2;
  for (const ch of chars) {
    for (const [ax, ay, bx, by] of GLYPHS[ch] ?? []) {
      // Полоса от A до B толщиной STROKE (с выносом на полтолщины на концах).
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const tx = (dx / len) * hw;
      const ty = (dy / len) * hw;
      const nx = -ty;
      const ny = tx;
      const p = [
        [ax - tx + nx, ay - ty + ny],
        [ax - tx - nx, ay - ty - ny],
        [bx + tx - nx, by + ty - ny],
        [bx + tx + nx, by + ty + ny],
      ].map(([px, py]) => [(x0 + px!) * s, (py! - 3) * s]);
      for (const i of [0, 1, 2, 0, 2, 3]) pos.push(p[i]![0]!, p[i]![1]!, 0);
    }
    x0 += glyphW(ch) + GAP;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.userData.width = (total + STROKE) * s;
  g.computeBoundingSphere();
  return g;
}

// ---------- Объекты three.js ----------

export interface DimensionOptions {
  /** Цвет линий и цифр. */
  color?: string;
  /** Подложка под цифрами. */
  labelBackground?: string;
  /** Высота цифр, мм. По умолчанию ~3 % от наибольшего габарита (35…110 мм). */
  textHeightMm?: number;
  /** Цифры поворачиваются к камере. По умолчанию true. */
  billboard?: boolean;
  /** Показывать ширины секций. По умолчанию true. */
  sections?: boolean;
  /** Своя подпись (например, canvas-спрайт или drei <Text> через portal). Высота — в единицах сцены. */
  labelFactory?: (text: string, height: number) => Object3D;
}

export interface DimensionsHandle {
  group: Group;
  info: DimensionInfo;
  /** Все подписи (для своих нужд, например повернуть к камере вручную). */
  labels: Object3D[];
  setVisible(on: boolean): void;
  readonly visible: boolean;
  /** Повернуть подписи к камере вручную (если billboard выключен). */
  faceCamera(camera: Camera): void;
  dispose(): void;
}

const noRaycast = () => {};
const tmpQ = new Quaternion();
const tmpCamQ = new Quaternion();

/**
 * Выносные размеры изделия как объекты three.js (единицы сцены `scale`: 1 — мм, 0.001 — м).
 * Линии — LineSegments, цифры — меши из полос на белой подложке. Всё рисуется
 * поверх изделия (depthTest: false) и не участвует в выборе детали.
 */
export function buildDimensions(model: ViewerModel, scale = 0.001, opts: DimensionOptions = {}): DimensionsHandle {
  const info = computeDimensions(model);
  const { min, max } = info.bounds;
  const { width: W, height: H, depth: D } = info.overall;
  const maxDim = Math.max(W, H, D, 1);
  const th = opts.textHeightMm ?? Math.min(110, Math.max(35, maxDim * 0.03));
  const off1 = th * 2.2;
  const off2 = th * 4.4;
  const tick = th * 0.45;
  const color = new Color(opts.color ?? '#1d4ed8');
  const billboard = opts.billboard ?? true;

  const group = new Group();
  group.name = 'dimensions';
  group.userData.isDimensions = true;
  const lineMat = new LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  const plateColor = new Color(opts.labelBackground ?? '#ffffff');
  const labelMat = new MeshBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
  const geometries: BufferGeometry[] = [];
  const linePos: number[] = [];
  const labels: Object3D[] = [];

  const P = (x: number, y: number, z: number) => coreToThree([x, y, z], scale);
  const seg = (a: Vector3, b: Vector3) => linePos.push(a.x, a.y, a.z, b.x, b.y, b.z);

  /**
   * Размерная линия от A до B (мм, оси ядра); `ext` — откуда тянуть выносные линии
   * (точки на изделии), `tickDir` — направление засечки в плоскости размера.
   */
  const dim = (a: CoreVec3, b: CoreVec3, value: number, extA: CoreVec3 | null, extB: CoreVec3 | null, labelOffset: CoreVec3) => {
    const A = P(...a);
    const B = P(...b);
    seg(A, B);
    if (extA) seg(P(...extA), A);
    if (extB) seg(P(...extB), B);
    // Засечки 45° (как в строительных чертежах).
    const dir = B.clone().sub(A).normalize();
    const side = P(...labelOffset).sub(P(0, 0, 0)).normalize();
    const t = dir.clone().add(side).normalize().multiplyScalar(tick * scale);
    for (const p of [A, B]) seg(p.clone().sub(t), p.clone().add(t));
    // Подпись посередине, чуть в сторону от линии.
    const mid = A.clone().add(B).multiplyScalar(0.5).add(side.clone().multiplyScalar(th * 0.9 * scale));
    addLabel(formatMm(value), mid);
  };

  const addLabel = (text: string, at: Vector3) => {
    const h = th * scale;
    let label: Object3D;
    if (opts.labelFactory) {
      label = opts.labelFactory(text, h);
    } else {
      // Подложка и цифры — одна геометрия с цветами вершин: один вызов отрисовки на подпись.
      const tg = strokeTextGeometry(text, h);
      const w = tg.userData.width as number;
      const pw = w / 2 + h * 0.35;
      const ph = h / 2 + h * 0.3;
      const plate = [-pw, -ph, 0, pw, -ph, 0, pw, ph, 0, -pw, -ph, 0, pw, ph, 0, -pw, ph, 0];
      const textPos = Array.from(tg.getAttribute('position').array as Float32Array);
      tg.dispose();
      const colors: number[] = [];
      for (let i = 0; i < plate.length / 3; i++) colors.push(plateColor.r, plateColor.g, plateColor.b);
      for (let i = 0; i < textPos.length / 3; i++) colors.push(color.r, color.g, color.b);
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute([...plate, ...textPos], 3));
      g.setAttribute('color', new Float32BufferAttribute(colors, 3));
      g.computeBoundingSphere();
      g.userData.width = w;
      geometries.push(g);
      const holder = new Mesh(g, labelMat);
      holder.renderOrder = 999;
      holder.raycast = noRaycast;
      if (billboard) {
        // Поворот к камере прямо перед отрисовкой (работает и в вебе, и в expo-gl).
        holder.onBeforeRender = (_r, _s, camera) => {
          orientToCamera(holder, camera);
        };
      }
      label = holder;
    }
    label.name = `dim:${text}`;
    label.position.copy(at);
    labels.push(label);
    group.add(label);
  };

  const yF = Math.min(min[1], 0); // передняя плоскость (фасады)
  const top = Math.max(max[2], H);
  const right = Math.max(max[0], W);

  // Общая ширина — над изделием, в плоскости фасада.
  dim([0, yF, top + off2], [W, yF, top + off2], W, [0, yF, top], [W, yF, top], [0, 0, 1]);
  // Высота — справа, в плоскости фасада.
  dim([right + off2, yF, 0], [right + off2, yF, H], H, [right, yF, 0], [right, yF, H], [1, 0, 0]);
  // Глубина — справа на полу.
  dim([right + off1, 0, 0], [right + off1, D, 0], D, [right, 0, 0], [right, D, 0], [1, 0, 0]);

  if (opts.sections ?? true) {
    for (const row of info.rows) {
      const atTop = row.zMax >= top - EPS;
      for (const s of row.sections) {
        if (atTop) {
          const z = top + off1;
          dim([s.x0, yF, z], [s.x1, yF, z], s.width, [s.x0, yF, row.zMax], [s.x1, yF, row.zMax], [0, 0, 1]);
        } else {
          // Ряд ниже верха (нижние модули кухни): цепочка перед фасадом, у верха ряда.
          const z = row.zMax - th * 1.6;
          const y = yF - th;
          dim([s.x0, y, z], [s.x1, y, z], s.width, null, null, [0, 0, 1]);
        }
      }
    }
  }

  const lineG = new BufferGeometry();
  lineG.setAttribute('position', new Float32BufferAttribute(linePos, 3));
  geometries.push(lineG);
  const lines = new LineSegments(lineG, lineMat);
  lines.name = 'dim:lines';
  lines.renderOrder = 997;
  lines.raycast = noRaycast;
  group.add(lines);
  group.traverse((o) => {
    o.raycast = noRaycast;
  });

  return {
    group,
    info,
    labels,
    setVisible(on: boolean) {
      group.visible = on;
    },
    get visible() {
      return group.visible;
    },
    faceCamera(camera: Camera) {
      for (const l of labels) orientToCamera(l, camera);
    },
    dispose() {
      for (const g of geometries) g.dispose();
      lineMat.dispose();
      labelMat.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}

function orientToCamera(obj: Object3D, camera: Camera): void {
  camera.getWorldQuaternion(tmpCamQ);
  const parent = obj.parent;
  if (parent) {
    parent.getWorldQuaternion(tmpQ).invert();
    obj.quaternion.copy(tmpQ).multiply(tmpCamQ);
  } else {
    obj.quaternion.copy(tmpCamQ);
  }
  obj.updateMatrixWorld(true);
}
