import { Matrix4, Vector3 } from 'three';
import type { Axis, CoreVec3, Placement } from './types.js';

/** Единицы сцены: мм (как в ядре) или метры (для AR и GLB). */
export type SceneUnits = 'mm' | 'm';

export function unitScale(units: SceneUnits): number {
  return units === 'm' ? 0.001 : 1;
}

/** Единичный вектор оси в координатах ядра. */
export function coreAxisVector(axis: Axis): CoreVec3 {
  const sign = axis[0] === '-' ? -1 : 1;
  switch (axis[1]) {
    case 'X':
      return [sign, 0, 0];
    case 'Y':
      return [0, sign, 0];
    case 'Z':
      return [0, 0, sign];
    default:
      throw new Error(`Неизвестная ось: ${axis}`);
  }
}

/**
 * Точка/вектор ядра → three.js (Y вверх): three.x = X, three.y = Z, three.z = −Y.
 * Фасад изделия (Y = 0) смотрит в +z, к камере по умолчанию.
 */
export function coreToThree(v: CoreVec3, scale = 1): Vector3 {
  return new Vector3(v[0] * scale, v[2] * scale, -v[1] * scale);
}

/** Направление оси ядра в three.js (без масштаба). */
export function axisToThree(axis: Axis): Vector3 {
  return coreToThree(coreAxisVector(axis));
}

/** Матрица ядро → three.js (поворот на −90° вокруг X, det = +1) с масштабом. */
export function coreToThreeMatrix(scale = 1): Matrix4 {
  // three = M · core; столбцы — образы осей ядра X, Y, Z.
  return new Matrix4().set(
    scale, 0, 0, 0,
    0, 0, scale, 0,
    0, -scale, 0, 0,
    0, 0, 0, 1,
  );
}

/**
 * Матрица локальная система детали (x — длина, y — ширина, z — толщина, мм)
 * → координаты ядра (мм). Может быть зеркальной (det = −1), если оси u, v, n
 * образуют левую тройку — это нормально для контракта.
 */
export function placementMatrix(p: Placement): Matrix4 {
  const u = coreAxisVector(p.u);
  const v = coreAxisVector(p.v);
  const n = coreAxisVector(p.n);
  if (new Set([p.u[1], p.v[1], p.n[1]]).size !== 3) {
    throw new Error(`Оси размещения должны быть разными: ${p.u}, ${p.v}, ${p.n}`);
  }
  const [ox, oy, oz] = p.origin;
  return new Matrix4().set(
    u[0], v[0], n[0], ox,
    u[1], v[1], n[1], oy,
    u[2], v[2], n[2], oz,
    0, 0, 0, 1,
  );
}

/** Полная матрица: локальная система детали → сцена three.js в выбранных единицах. */
export function partToSceneMatrix(p: Placement, scale = 1): Matrix4 {
  return coreToThreeMatrix(scale).multiply(placementMatrix(p));
}
