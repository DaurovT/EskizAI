import { BufferAttribute, BufferGeometry } from 'three';

/**
 * UV по направлению текстуры (grain).
 *
 * Считаем в локальной системе детали, в мм (до размещения): x — длина,
 * y — ширина, z — толщина. Текстура декора лежит так, что волокна идут вдоль
 * оси U картинки (горизонтально). Для каждой грани берём две оси её плоскости:
 * ось, вдоль которой идут волокна, → U, вторая → V. UV = мм / размер плитки,
 * поэтому масштаб реальный: при плитке 1000 мм одна плитка — метр плиты.
 */

/** Ось локальной системы детали: 0 — x (длина), 1 — y (ширина), 2 — z (толщина). */
export type LocalAxis = 0 | 1 | 2;

export interface GrainUvOptions {
  /** Размер плитки текстуры в мм: [по U картинки, по V картинки]. По умолчанию 1000 × 1000. */
  tileMm?: number | [number, number];
  /** Вдоль какой оси картинки идут волокна. По умолчанию 'u' (горизонтально). */
  grainAxis?: 'u' | 'v';
}

/** Локальная ось, вдоль которой идут волокна: length → x, width → y, none → x (без поворота). */
export function grainLocalAxis(grain: string): LocalAxis {
  return grain === 'width' ? 1 : 0;
}

/**
 * Какие локальные оси идут в U и V для грани с нормалью вдоль `normalAxis`.
 * Возвращает [ось волокон, поперечная ось] в плоскости грани.
 * На торцах, перпендикулярных волокнам, волокна «уходят» в толщину: U = z.
 */
export function grainUvAxes(grain: string, normalAxis: LocalAxis): [LocalAxis, LocalAxis] {
  const g = grainLocalAxis(grain);
  const inPlane = ([0, 1, 2] as LocalAxis[]).filter((a) => a !== normalAxis) as [LocalAxis, LocalAxis];
  if (g !== normalAxis) {
    const other = inPlane[0] === g ? inPlane[1] : inPlane[0];
    return [g, other];
  }
  // Торец поперёк волокон: в плоскости только «другая» ось и толщина.
  const other = inPlane[0] === 2 ? inPlane[1] : inPlane[0];
  return [2, other];
}

function tile(opts: GrainUvOptions): [number, number] {
  const t = opts.tileMm ?? 1000;
  return typeof t === 'number' ? [t, t] : t;
}

/**
 * UV одной точки грани. `p` — локальные мм, `normalAxis` — главная ось нормали грани.
 * Результат — в плитках (1 = одна плитка текстуры).
 */
export function grainUv(
  p: [number, number, number],
  normalAxis: LocalAxis,
  grain: string,
  opts: GrainUvOptions = {},
): [number, number] {
  const [along, across] = grainUvAxes(grain, normalAxis);
  const [tu, tv] = tile(opts);
  if (opts.grainAxis === 'v') return [p[across] / tu, p[along] / tv];
  return [p[along] / tu, p[across] / tv];
}

/**
 * Записывает атрибут `uv` в геометрию детали без индекса, заданную в локальных мм.
 * Нормаль грани берётся по треугольнику, поэтому подходит и для выдавленного контура.
 */
export function applyGrainUvs(geometry: BufferGeometry, grain: string, opts: GrainUvOptions = {}): void {
  const pos = geometry.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const a = [0, 0, 0] as [number, number, number];
  const b = [0, 0, 0] as [number, number, number];
  const c = [0, 0, 0] as [number, number, number];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      a[k] = pos.getComponent(i, k);
      b[k] = pos.getComponent(i + 1, k);
      c[k] = pos.getComponent(i + 2, k);
    }
    // Нормаль треугольника: (b − a) × (c − a).
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      Math.abs(e1[1]! * e2[2]! - e1[2]! * e2[1]!),
      Math.abs(e1[2]! * e2[0]! - e1[0]! * e2[2]!),
      Math.abs(e1[0]! * e2[1]! - e1[1]! * e2[0]!),
    ];
    const axis: LocalAxis = n[0]! >= n[1]! && n[0]! >= n[2]! ? 0 : n[1]! >= n[2]! ? 1 : 2;
    const pts = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const [u, v] = grainUv(pts[k]!, axis, grain, opts);
      uv[(i + k) * 2] = u;
      uv[(i + k) * 2 + 1] = v;
    }
  }
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
}
