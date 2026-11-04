/**
 * Приближённая «пересборка» viewer-модели для мока (без ядра): растягиваем детали
 * по габаритам и меняем декоры. На сервере модель строит ядро — там этого кода нет.
 */
import type { ViewerModel, ViewerPart, Axis } from '@mebel/viewer';
import { DECORS, FRONT_ROLES } from './catalog';

const axisIndex = (a: Axis) => ({ X: 0, Y: 1, Z: 2 } as const)[a[1] as 'X' | 'Y' | 'Z'];

/** scale[i] — коэффициент по оси ядра (0 X ширина, 1 Y глубина, 2 Z высота). */
export function scaleViewer(model: ViewerModel, scale: [number, number, number]): ViewerModel {
  const m: ViewerModel = JSON.parse(JSON.stringify(model));
  m.size = [m.size[0] * scale[0], m.size[1] * scale[2], m.size[2] * scale[1]] as ViewerModel['size'];
  for (const p of m.parts as ViewerPart[]) {
    const o = p.placement.origin;
    p.placement.origin = [o[0] * scale[0], o[1] * scale[1], o[2] * scale[2]];
    const su = scale[axisIndex(p.placement.u)];
    const sv = scale[axisIndex(p.placement.v)];
    p.length *= su;
    p.width *= sv;
    if (p.contour) {
      p.contour.start = [p.contour.start[0] * su, p.contour.start[1] * sv];
      for (const s of p.contour.segments) {
        s.x *= su;
        s.y *= sv;
        if (s.kind === 'arc') {
          s.cx *= su;
          s.cy *= sv;
        }
      }
    }
  }
  for (const n of m.nodes) {
    n.origin = [n.origin[0] * scale[0], n.origin[1] * scale[1], n.origin[2] * scale[2]];
    if (n.kind === 'sliding_door' || n.kind === 'slide') n.range *= scale[axisIndex(n.axis)];
  }
  return m;
}

/** Сменить декор корпуса или фасадов. */
export function recolorViewer(model: ViewerModel, target: 'body' | 'fronts', decorId: string): ViewerModel {
  const d = DECORS.find((x) => x.id === decorId);
  if (!d) return model;
  const m: ViewerModel = JSON.parse(JSON.stringify(model));
  m.materials[d.id] = { name: d.name, color: d.color, hasGrain: d.hasGrain };
  for (const p of m.parts) {
    const isFront = FRONT_ROLES.has(p.role);
    if (p.material.startsWith('ldsp') && (target === 'fronts' ? isFront : !isFront)) p.material = d.id;
  }
  return m;
}
