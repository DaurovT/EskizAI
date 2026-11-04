import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, ExtrudeGeometry, Path, Shape } from 'three';
import type { Contour, ViewerPart } from './types.js';
import { partToSceneMatrix } from './axes.js';
import { applyGrainUvs, type GrainUvOptions } from './uv.js';

const TWO_PI = Math.PI * 2;
const EPS = 1e-6;

/** Контур детали (локальные мм) → THREE.Shape. Дуги — по центру и направлению. */
export function contourToShape(contour: Contour): Shape {
  const shape = new Shape();
  tracePath(shape, contour);
  return shape;
}

function tracePath(shape: Path, contour: Contour): void {
  let [px, py] = contour.start;
  shape.moveTo(px, py);
  for (const seg of contour.segments) {
    if (seg.kind === 'line') {
      shape.lineTo(seg.x, seg.y);
    } else {
      const r = Math.hypot(px - seg.cx, py - seg.cy);
      const a0 = Math.atan2(py - seg.cy, px - seg.cx);
      let a1 = Math.atan2(seg.y - seg.cy, seg.x - seg.cx);
      const samePoint = Math.abs(px - seg.x) < EPS && Math.abs(py - seg.y) < EPS;
      if (samePoint) {
        // Конец совпадает с началом — полная окружность.
        a1 = seg.clockwise ? a0 - TWO_PI : a0 + TWO_PI;
      }
      shape.absarc(seg.cx, seg.cy, r, a0, a1, seg.clockwise);
    }
    px = seg.x;
    py = seg.y;
  }
  shape.closePath();
}

/** Внутренний вырез → THREE.Path (дырка в Shape). */
export function contourToPath(contour: Contour): Path {
  const path = new Path();
  tracePath(path, contour);
  return path;
}

function rectContour(length: number, width: number): Contour {
  return {
    start: [0, 0],
    segments: [
      { kind: 'line', x: length, y: 0 },
      { kind: 'line', x: length, y: width },
      { kind: 'line', x: 0, y: width },
      { kind: 'line', x: 0, y: 0 },
    ],
  };
}

/** Прямоугольник со скруглёнными углами радиуса r (обход против часовой, как у rectContour). */
export function roundedRectContour(length: number, width: number, r: number): Contour {
  const R = Math.min(r, length / 2 - 0.01, width / 2 - 0.01);
  if (!(R > 0)) return rectContour(length, width);
  return {
    start: [R, 0],
    segments: [
      { kind: 'line', x: length - R, y: 0 },
      { kind: 'arc', x: length, y: R, cx: length - R, cy: R, clockwise: false },
      { kind: 'line', x: length, y: width - R },
      { kind: 'arc', x: length - R, y: width, cx: length - R, cy: width - R, clockwise: false },
      { kind: 'line', x: R, y: width },
      { kind: 'arc', x: 0, y: width - R, cx: R, cy: width - R, clockwise: false },
      { kind: 'line', x: 0, y: R },
      { kind: 'arc', x: R, y: 0, cx: R, cy: R, clockwise: false },
    ],
  };
}

/** Меняет порядок обхода треугольников (нужно после зеркальной матрицы). */
export function flipWinding(geometry: BufferGeometry): void {
  if (geometry.index) {
    const idx = geometry.index;
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
    return;
  }
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name) as BufferAttribute;
    const size = attr.itemSize;
    const arr = attr.array as Float32Array;
    for (let v = 0; v + 2 < attr.count; v += 3) {
      const o1 = (v + 1) * size;
      const o2 = (v + 2) * size;
      for (let k = 0; k < size; k++) {
        const t = arr[o1 + k]!;
        arr[o1 + k] = arr[o2 + k]!;
        arr[o2 + k] = t;
      }
    }
    attr.needsUpdate = true;
  }
}

export interface PartGeometryOptions {
  /** Масштаб единиц сцены (1 — мм, 0.001 — метры). */
  scale?: number;
  /** Сегментов на дугу контура. */
  curveSegments?: number;
  /**
   * UV по направлению текстуры (`part.grain`) в реальном масштабе. По умолчанию
   * плитка 1000 мм. `false` — без UV (как раньше).
   */
  uv?: GrainUvOptions | false;
}

/**
 * Геометрия детали в локальной системе (мм): x ∈ [0, length], y ∈ [0, width],
 * z ∈ [0, thickness]. Контур, если есть, выдавливается на толщину.
 */
export function localPartGeometry(part: ViewerPart, curveSegments = 24): BufferGeometry {
  const cutouts = (part.cutouts ?? []).filter((c) => c && c.segments.length > 0);
  const hasContour = Boolean(part.contour && part.contour.segments.length > 0);
  // Скругление углов из декора — только если ядро не прислало контур
  const radius = !hasContour && part.role !== 'rod' ? part.decor?.radius ?? 0 : 0;
  if (hasContour || cutouts.length > 0 || radius > 0) {
    const outline = hasContour
      ? part.contour!
      : radius > 0
        ? roundedRectContour(part.length, part.width, radius)
        : rectContour(part.length, part.width);
    const shape = contourToShape(outline);
    for (const c of cutouts) shape.holes.push(contourToPath(c));
    const g = new ExtrudeGeometry(shape, {
      depth: part.thickness,
      bevelEnabled: false,
      curveSegments,
    });
    // У ExtrudeGeometry нет индекса, но на всякий случай приводим.
    return g.index ? g.toNonIndexed() : g;
  }
  if (part.role === 'rod') {
    // Штанга — овальная труба по габариту детали (ширина × толщина), вдоль длины
    const tube = new CylinderGeometry(1, 1, part.length, 20);
    tube.rotateZ(-Math.PI / 2);
    tube.scale(1, part.width / 2, part.thickness / 2);
    tube.translate(part.length / 2, part.width / 2, part.thickness / 2);
    const g = tube.toNonIndexed();
    tube.dispose();
    return g;
  }
  const box = new BoxGeometry(part.length, part.width, part.thickness);
  box.translate(part.length / 2, part.width / 2, part.thickness / 2);
  const g = box.toNonIndexed();
  box.dispose();
  return g;
}

/**
 * Геометрия детали сразу в координатах сцены three.js (размещение «запечено»).
 * Так в GLB/USDZ не попадают зеркальные матрицы, а нормали и обход граней верные.
 */
export function partGeometry(part: ViewerPart, opts: PartGeometryOptions = {}): BufferGeometry {
  return placeLocalGeometry(localPartGeometry(part, opts.curveSegments), part, opts);
}

/**
 * Локальная геометрия детали (мм) → сцена: UV по волокнам, размещение, масштаб, обход граней.
 * Нужна и для декора (фрезеровка, накладки, вставки строятся в системе детали).
 */
export function placeLocalGeometry(g: BufferGeometry, part: ViewerPart, opts: PartGeometryOptions = {}): BufferGeometry {
  const scale = opts.scale ?? 1;
  const m = partToSceneMatrix(part.placement, scale);
  // UV строим в локальных мм, до размещения: волокна идут вдоль part.grain.
  if (opts.uv === false) g.deleteAttribute('uv');
  else applyGrainUvs(g, part.grain, opts.uv ?? {});
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
