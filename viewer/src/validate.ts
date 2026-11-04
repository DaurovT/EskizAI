import type { ViewerModel } from './types.js';

export class ViewerModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewerModelError';
  }
}

const AXES = new Set(['+X', '-X', '+Y', '-Y', '+Z', '-Z']);
const NODE_KINDS = new Set(['rotate', 'slide', 'sliding_door', 'lift']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Быстрая проверка формы JSON перед построением сцены.
 * Не заменяет JSON Schema — ловит только то, что сломает 3D.
 */
export function parseViewerModel(data: unknown): ViewerModel {
  if (!isObj(data)) throw new ViewerModelError('viewer model: ожидается объект');
  if (data.format !== '1') throw new ViewerModelError(`viewer model: неизвестный формат ${String(data.format)}`);
  if (!Array.isArray(data.parts)) throw new ViewerModelError('viewer model: нет parts');
  if (!isObj(data.materials)) throw new ViewerModelError('viewer model: нет materials');
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  data.parts.forEach((p: unknown, i: number) => {
    if (!isObj(p) || !isObj(p.placement)) throw new ViewerModelError(`viewer model: деталь #${i} без placement`);
    const pl = p.placement;
    for (const k of ['u', 'v', 'n'] as const) {
      if (!AXES.has(pl[k] as string)) throw new ViewerModelError(`viewer model: деталь #${i}: ось ${k}=${String(pl[k])}`);
    }
    for (const k of ['length', 'width', 'thickness'] as const) {
      if (typeof p[k] !== 'number' || !(p[k] as number > 0)) {
        throw new ViewerModelError(`viewer model: деталь #${i}: ${k} должно быть > 0`);
      }
    }
  });
  nodes.forEach((n: unknown, i: number) => {
    if (!isObj(n) || typeof n.id !== 'string') throw new ViewerModelError(`viewer model: узел #${i} без id`);
    if (!NODE_KINDS.has(n.kind as string)) throw new ViewerModelError(`viewer model: узел ${n.id}: kind=${String(n.kind)}`);
    if (!AXES.has(n.axis as string)) throw new ViewerModelError(`viewer model: узел ${n.id}: axis=${String(n.axis)}`);
  });
  return { ...(data as unknown as ViewerModel), nodes: nodes as ViewerModel['nodes'], issues: (data.issues as ViewerModel['issues']) ?? [] };
}
