import { BufferGeometry, Float32BufferAttribute } from 'three';
import { coreToThree } from './axes.js';
import { partCoreBounds } from './dimensions.js';
import type { CoreVec3, ViewerPart } from './types.js';

/**
 * Дешёвая «окклюзия» (AO) без шейдеров и запекания: полосы-градиенты (чёрный, альфа в цвете вершин)
 * на гранях деталей у стыков — полка у задней стенки, у боковины, стойка на дне, столешница над боковиной.
 * Всё изделие — один меш, один вызов отрисовки. Ниша перестаёт быть «дыркой»: углы и стыки темнеют.
 *
 * Как ищем стыки: для каждой большой грани неподвижной детали A берём слой толщиной `width` над гранью;
 * каждая деталь B, заходящая в этот слой, «затеняет» грань: от краёв её следа на плоскости грани
 * наружу идут полосы-градиенты, обрезанные по грани A. Чем дальше B от грани, тем слабее тень.
 */

export interface ContactShadowOptions {
  /** Ширина полосы тени, мм. По умолчанию 64. */
  width?: number;
  /** Сила у самого стыка (0..1). По умолчанию 0.3. */
  strength?: number;
  /** Подъём над гранью, мм (против мерцания в 16-битном буфере глубины). По умолчанию 2. */
  lift?: number;
}

/** Профиль затухания поперёк полосы: [доля ширины, сила]. Похоже на exp — без резкой границы. */
const PROFILE: [number, number][] = [
  [0, 1],
  [0.18, 0.55],
  [0.45, 0.2],
  [1, 0],
];

function profileAt(t: number): number {
  if (t <= 0) return 1;
  for (let i = 1; i < PROFILE.length; i++) {
    const [t1, a1] = PROFILE[i]!;
    const [t0, a0] = PROFILE[i - 1]!;
    if (t <= t1) return a0 + ((a1 - a0) * (t - t0)) / (t1 - t0);
  }
  return 0;
}

/** Роли, которые не дают и не получают тень (движутся отдельно, тонкие, круглые). */
const SKIP_ROLES = new Set(['rod']);
const MIN_FACE = 30;
const EPS = 0.5;

interface Box {
  min: CoreVec3;
  max: CoreVec3;
}

/** Детали, участвующие в AO: неподвижные (двери и ящики двигаются — у них своих стыков не считаем). */
export function aoParts(parts: ViewerPart[]): ViewerPart[] {
  return parts.filter((p) => !p.node && !SKIP_ROLES.has(p.role));
}

/**
 * Геометрия полос AO (координаты сцены three.js, масштаб `scale`), атрибуты position и color (RGBA, чёрный + альфа).
 * null — стыков нет.
 */
export function contactShadowGeometry(parts: ViewerPart[], scale = 0.001, opts: ContactShadowOptions = {}): BufferGeometry | null {
  const W = opts.width ?? 64;
  const strength = opts.strength ?? 0.3;
  const lift = opts.lift ?? 2;
  const list = aoParts(parts);
  const boxes: Box[] = list.map((p) => partCoreBounds(p));
  const pos: number[] = [];
  const col: number[] = [];
  const pt = (k: number, i: number, j: number, P: number, a: number, b: number) => {
    const v: CoreVec3 = [0, 0, 0];
    v[k] = P;
    v[i] = a;
    v[j] = b;
    const t = coreToThree(v, scale);
    pos.push(t.x, t.y, t.z);
  };
  for (let ai = 0; ai < boxes.length; ai++) {
    const A = boxes[ai]!;
    for (let k = 0; k < 3; k++) {
      const i = (k + 1) % 3;
      const j = (k + 2) % 3;
      // Грань должна быть «большой» по обеим осям (торцы плит пропускаем)
      if (A.max[i]! - A.min[i]! < MIN_FACE || A.max[j]! - A.min[j]! < MIN_FACE) continue;
      for (const s of [1, -1]) {
        const P = s > 0 ? A.max[k]! : A.min[k]!;
        const R = { i0: A.min[i]!, i1: A.max[i]!, j0: A.min[j]!, j1: A.max[j]! };
        const plane = P + s * lift;
        for (let bi = 0; bi < boxes.length; bi++) {
          if (bi === ai) continue;
          const B = boxes[bi]!;
          // B должна заходить в слой [P, P + W] над гранью (снаружи детали)
          const outHi = s > 0 ? B.max[k]! - P : P - B.min[k]!;
          const gap = s > 0 ? B.min[k]! - P : P - B.max[k]!;
          if (outHi <= 1 || gap >= W - EPS) continue;
          const fade = gap > 0 ? 1 - gap / W : 1;
          // След B на плоскости грани
          const Q = { i0: B.min[i]!, i1: B.max[i]!, j0: B.min[j]!, j1: B.max[j]! };
          // Должен касаться грани (пересекаться или прилегать)
          if (Q.i0 > R.i1 + EPS || Q.i1 < R.i0 - EPS || Q.j0 > R.j1 + EPS || Q.j1 < R.j0 - EPS) continue;
          const a0 = strength * fade;
          // Четыре полосы от краёв следа наружу: [ось поперёк, знак, край]
          const strips: [0 | 1, 1 | -1, number][] = [
            [0, 1, Q.i1],
            [0, -1, Q.i0],
            [1, 1, Q.j1],
            [1, -1, Q.j0],
          ];
          for (const [axis, dir, edge] of strips) {
            // Вдоль полосы — пересечение следа и грани
            const along0 = axis === 0 ? Math.max(Q.j0, R.j0) : Math.max(Q.i0, R.i0);
            const along1 = axis === 0 ? Math.min(Q.j1, R.j1) : Math.min(Q.i1, R.i1);
            // Короткие «торцы» следа (кромка полки на задней стенке) не тянем: полоса ушла бы за стойку в соседнюю нишу
            if (along1 - along0 < MIN_FACE) continue;
            // Поперёк — от края следа на W наружу, обрезка по грани
            const lo = axis === 0 ? R.i0 : R.j0;
            const hi = axis === 0 ? R.i1 : R.j1;
            const c0 = dir > 0 ? Math.max(edge, lo) : Math.min(edge, hi);
            const c1 = dir > 0 ? Math.min(edge + W, hi) : Math.max(edge - W, lo);
            if ((c1 - c0) * dir < 1) continue;
            const t0 = ((c0 - edge) * dir) / W;
            const t1 = ((c1 - edge) * dir) / W;
            const ts = [t0, ...PROFILE.map((p) => p[0]).filter((t) => t > t0 && t < t1), t1];
            for (let n = 0; n + 1 < ts.length; n++) {
              const ta = ts[n]!;
              const tb = ts[n + 1]!;
              const xa = edge + dir * ta * W;
              const xb = edge + dir * tb * W;
              const aa = a0 * profileAt(ta);
              const ab = a0 * profileAt(tb);
              if (aa < 0.004 && ab < 0.004) continue;
              // Два треугольника; рисуем с обеих сторон, обход не важен
              const quad: [number, number, number][] =
                axis === 0
                  ? [
                      [xa, along0, aa],
                      [xb, along0, ab],
                      [xb, along1, ab],
                      [xa, along0, aa],
                      [xb, along1, ab],
                      [xa, along1, aa],
                    ]
                  : [
                      [along0, xa, aa],
                      [along1, xa, aa],
                      [along1, xb, ab],
                      [along0, xa, aa],
                      [along1, xb, ab],
                      [along0, xb, ab],
                    ];
              for (const [u, v, alpha] of quad) {
                pt(k, i, j, plane, u, v);
                col.push(0, 0, 0, alpha);
              }
            }
          }
        }
      }
    }
  }
  if (!pos.length) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 4));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
