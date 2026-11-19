/**
 * Кованая декоративная вставка (раскладка pattern «decor») — ОДНА форма для схемы (Schema.tsx) и 3D (window3dGeometry.ts).
 * Раньше схема рисовала ромб с кругом и завитками, а 3D — два вложенных ромба: мастер видел разные узоры.
 * Возвращает ломаные в мм (y вниз) внутри прямоугольника стекла: ромб, круг в центре, четыре завитка к углам и стойки.
 */
export type DPt = [number, number];
export type DBox = { x0: number; y0: number; x1: number; y1: number };

export function forgedDecor(g: DBox): DPt[][] {
  const gw = g.x1 - g.x0, gh = g.y1 - g.y0;
  const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2;
  const rx = gw * 0.38, ry = gh * 0.38, r = Math.min(gw, gh) * 0.12, cr = Math.min(gw, gh) * 0.06;
  const out: DPt[][] = [];
  out.push([[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]]);                // ромб
  out.push(circle(cx, cy, r, 28));                                                                        // круг
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    // завиток: квадратичная кривая от круга к углу + маленькое кольцо на конце
    const p0: DPt = [cx + sx * r * 0.7, cy + sy * r * 0.7], c: DPt = [cx + sx * rx, cy + sy * r];
    const e: DPt = [cx + sx * gw * 0.46, cy + sy * gh * 0.46];
    const curve: DPt[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, u = 1 - t;
      curve.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * e[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * e[1]]);
    }
    out.push(curve);
    out.push(circle(e[0] - sx * cr, e[1] - sy * cr, cr, 14));
  }
  out.push([[cx, g.y0], [cx, cy - ry]], [[cx, cy + ry], [cx, g.y1]]);                                    // стойки
  return out;
}

function circle(x: number, y: number, r: number, n: number): DPt[] {
  const pts: DPt[] = [];
  for (let i = 0; i <= n; i++) { const a = (2 * Math.PI * i) / n; pts.push([x + r * Math.cos(a), y + r * Math.sin(a)]); }
  return pts;
}
