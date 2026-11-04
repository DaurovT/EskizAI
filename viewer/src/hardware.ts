import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Path,
  Quaternion,
  Shape,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { coreToThreeMatrix } from './axes.js';
import { flipWinding } from './geometry.js';
import type { CoreVec3, HardwareBox, HardwareCylinder, HardwareFinish, HardwareShape, ViewerHardware } from './types.js';

/** Отделки по умолчанию (как в ядре, hw3d.FINISHES) — если в модели нет hardwareFinishes. */
export const DEFAULT_FINISHES: Readonly<Record<string, HardwareFinish>> = {
  steel: { name: 'Сталь шлифованная', color: '#b8bcc0', metal: true, roughness: 0.38 },
  chrome: { name: 'Хром', color: '#d9dcdf', metal: true, roughness: 0.16 },
  nickel: { name: 'Никель', color: '#c4c7ca', metal: true, roughness: 0.3 },
  zinc: { name: 'Оцинковка', color: '#a9adb1', metal: true, roughness: 0.45 },
  alu: { name: 'Алюминий', color: '#c6c9cc', metal: true, roughness: 0.34 },
  plastic_black: { name: 'Пластик чёрный', color: '#2b2b2b', metal: false, roughness: 0.6 },
  plastic_light: { name: 'Пластик светлый', color: '#deddd8', metal: false, roughness: 0.55 },
  // Латунь — тёплая, приглушённая, шлифованная; золото — яркое, полированное
  brass: { name: 'Латунь', color: '#c9a45c', metal: true, roughness: 0.34 },
  gold: { name: 'Золото', color: '#e3b84a', metal: true, roughness: 0.16 },
  black: { name: 'Чёрный матовый', color: '#2a2a2a', metal: true, roughness: 0.45 },
};

const DEG = Math.PI / 180;

/** Атрибуты должны совпадать для слияния: оставляем position, normal, uv; без индекса. */
function normalize(g: BufferGeometry): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name);
  }
  out.clearGroups();
  return out;
}

/**
 * Одна форма фурнитуры (мм, оси ядра) → геометрия в осях three.js, мм
 * (three.x = X, three.y = Z, three.z = −Y).
 */
export function shapeGeometry(s: HardwareShape, segments = 16): BufferGeometry {
  if (s.type === 'box') {
    const [x0, y0, z0] = s.min;
    const [x1, y1, z1] = s.max;
    const g = new BoxGeometry(Math.max(x1 - x0, 0.1), Math.max(z1 - z0, 0.1), Math.max(y1 - y0, 0.1));
    g.translate((x0 + x1) / 2, (z0 + z1) / 2, -(y0 + y1) / 2);
    return normalize(g);
  }
  const [cx, cy, cz] = s.center;
  const sweep = s.sweep ?? 360;
  let g: BufferGeometry;
  if (((s.inner ?? 0) > 0 || sweep < 360) && s.axis === 'Z') {
    // Сектор/кольцо в плоскости XY ядра, выдавленный вдоль Z ядра (другие оси не бывают)
    const a0 = (s.start ?? 0) * DEG;
    const a1 = a0 + sweep * DEG;
    const shape = new Shape();
    const inner = s.inner ?? 0;
    const full = sweep >= 360;
    if (full) {
      shape.absarc(0, 0, s.radius, 0, Math.PI * 2, false);
      if (inner > 0) {
        const hole = new Path();
        hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
    } else if (inner > 0) {
      shape.moveTo(Math.cos(a0) * s.radius, Math.sin(a0) * s.radius);
      shape.absarc(0, 0, s.radius, a0, a1, false);
      shape.lineTo(Math.cos(a1) * inner, Math.sin(a1) * inner);
      shape.absarc(0, 0, inner, a1, a0, true);
      shape.closePath();
    } else {
      shape.moveTo(0, 0);
      shape.lineTo(Math.cos(a0) * s.radius, Math.sin(a0) * s.radius);
      shape.absarc(0, 0, s.radius, a0, a1, false);
      shape.closePath();
    }
    g = new ExtrudeGeometry(shape, {
      depth: s.length,
      bevelEnabled: false,
      curveSegments: Math.max(8, Math.round((segments * 2 * Math.abs(sweep)) / 360)),
    });
    g.translate(0, 0, -s.length / 2);
    // (u, v, w) ядра → three (u, w, −v)
    g.rotateX(-Math.PI / 2);
  } else {
    const radial = s.radius > 100 ? segments * 2 : segments;
    g = new CylinderGeometry(s.radius, s.radius, s.length, radial);
    // CylinderGeometry — вдоль Y three (= Z ядра)
    if (s.axis === 'X') g.rotateZ(-Math.PI / 2);
    else if (s.axis === 'Y') g.rotateX(-Math.PI / 2);
  }
  g.translate(cx, cz, -cy);
  return normalize(g);
}

const toThree = (v: CoreVec3) => new Vector3(v[0], v[2], -v[1]);

/**
 * Кнопка-грибок: ядро шлёт два цилиндра (ножка и шляпка) — рисуем тело вращения
 * с розеткой у фасада, тонкой ножкой и скруглённой шляпкой.
 */
export function knobGeometry(shapes: HardwareShape[], segments = 16): BufferGeometry | null {
  const cyl = shapes.filter((s): s is HardwareCylinder => s.type === 'cylinder');
  if (cyl.length < 2) return null;
  const [stem, cap] = [...cyl].sort((a, b) => a.radius - b.radius) as [HardwareCylinder, HardwareCylinder];
  if (stem.axis !== cap.axis) return null;
  const sc = toThree(stem.center);
  const cc = toThree(cap.center);
  const dir = cc.clone().sub(sc);
  if (dir.lengthSq() < 1e-9) return null;
  dir.normalize();
  const face = sc.clone().addScaledVector(dir, -stem.length / 2);
  const tip = cc.clone().addScaledVector(dir, cap.length / 2);
  const T = tip.distanceTo(face);
  const cl = cap.length;
  const h1 = Math.max(stem.length * 0.5, T - cl);
  const rs = stem.radius;
  const rc = cap.radius;
  const pts = [
    [0, 0],
    [rs * 1.7, 0],
    [rs * 1.7, 1],
    [rs * 1.05, 2],
    [rs, h1 * 0.6],
    [rs * 1.25, h1],
    [rc * 0.78, h1 + cl * 0.25],
    [rc, h1 + cl * 0.55],
    [rc * 0.94, h1 + cl * 0.8],
    [rc * 0.68, h1 + cl * 0.96],
    [0, T],
  ].map(([r, h]) => new Vector2(r!, h!));
  const g = new LatheGeometry(pts, Math.max(12, segments + 4));
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
  g.translate(face.x, face.y, face.z);
  return normalize(g);
}

/**
 * Профиль Gola: из бокса ядра — алюминиевый C-профиль вдоль длинной стороны.
 * front — куда смотрит фасад (ось ядра, единичный вектор): полка снизу во всю глубину,
 * задняя стенка, короткая верхняя губа — канал открыт к фасаду.
 */
export function golaGeometry(box: HardwareBox, front: CoreVec3): BufferGeometry | null {
  const ext = [0, 1, 2].map((i) => box.max[i]! - box.min[i]!);
  const fAxis = front.findIndex((c) => Math.abs(c) > 0.5);
  if (fAxis < 0) return null;
  const long = [0, 1, 2].filter((i) => i !== fAxis).sort((a, b) => ext[b]! - ext[a]!)[0]!;
  const up = [0, 1, 2].find((i) => i !== fAxis && i !== long)!;
  const D = ext[fAxis]!;
  const H = ext[up]!;
  const L = ext[long]!;
  if (D <= 0 || H <= 0 || L <= 0) return null;
  const t = Math.min(1.8, H * 0.14, D * 0.14);
  const sh = new Shape();
  sh.moveTo(0, 0);
  sh.lineTo(D, 0);
  sh.lineTo(D, H);
  sh.lineTo(D * 0.42, H);
  sh.lineTo(D * 0.42, H - t);
  sh.lineTo(D - t, H - t);
  sh.lineTo(D - t, t);
  sh.lineTo(0, t);
  sh.closePath();
  const g = new ExtrudeGeometry(sh, { depth: L, bevelEnabled: false });
  // Локальные (d, h, l) → ядро: d — от лица фасада вглубь, h — вверх по оси up, l — вдоль
  const sign = front[fAxis]! > 0 ? 1 : -1;
  const faceCoord = sign > 0 ? box.max[fAxis]! : box.min[fAxis]!;
  const ax = (i: number, k: number) => [0, 1, 2].map((j) => (j === i ? k : 0));
  const dv = ax(fAxis, -sign);
  const hv = ax(up, 1);
  const lv = ax(long, 1);
  const o = [0, 0, 0];
  o[fAxis] = faceCoord;
  o[up] = box.min[up]!;
  o[long] = box.min[long]!;
  const m = new Matrix4().set(
    dv[0]!, hv[0]!, lv[0]!, o[0]!,
    dv[1]!, hv[1]!, lv[1]!, o[1]!,
    dv[2]!, hv[2]!, lv[2]!, o[2]!,
    0, 0, 0, 1,
  );
  const full = coreToThreeMatrix(1).multiply(m);
  g.applyMatrix4(full);
  if (full.determinant() < 0) flipWinding(g);
  return normalize(g);
}

export interface HardwareGeometryContext {
  /** Куда смотрит фасад детали-«родителя» (ось ядра) — для профиля Gola. */
  front?: CoreVec3;
}

/** Все формы элемента → одна геометрия в координатах сцены (масштаб «запечён»). */
export function hardwareGeometry(
  item: ViewerHardware,
  scale = 1,
  segments = 16,
  ctx: HardwareGeometryContext = {},
): BufferGeometry | null {
  let special: BufferGeometry | null = null;
  if (item.kind === 'knob') special = knobGeometry(item.shapes, segments);
  else if (item.kind === 'gola' && item.shapes.length === 1 && item.shapes[0]!.type === 'box' && ctx.front) {
    special = golaGeometry(item.shapes[0] as HardwareBox, ctx.front);
  }
  if (special) {
    if (scale !== 1) special.scale(scale, scale, scale);
    special.computeBoundingBox();
    special.computeBoundingSphere();
    return special;
  }
  const list = item.shapes.map((s) => shapeGeometry(s, segments));
  if (!list.length) return null;
  const g = list.length === 1 ? list[0]! : mergeGeometries(list);
  if (list.length > 1) for (const x of list) x.dispose();
  if (!g) return null;
  if (scale !== 1) g.scale(scale, scale, scale);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
