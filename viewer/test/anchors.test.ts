import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DIMENSION_MARGINS, PART_MARGINS, dimensionAnchors, partAnchors } from '../src/anchors.js';
import { ProductScene } from '../src/product.js';
import { ViewRig, partViewAngles, viewBasis, type Projection } from '../src/rig.js';
import type { ViewerModel } from '../src/types.js';

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8')) as ViewerModel;

/** Пределы проекции точек, px. */
function extent(rig: ViewRig, pts: Vector3[]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of pts) {
    const p = rig.project(q.clone());
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

const corners = (b: Box3) => {
  const out: Vector3[] = [];
  for (let i = 0; i < 8; i++) out.push(new Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
  return out;
};

// Редактор на iPhone 17e: канвас 390 × 440 (шторка наполовину) или 390 × 630 (свёрнута), сверху шапка и «Вид · AR» (153 pt)
const W = 390;
const H = 440;
const TOP = 153;
const editorRig = (h = H) => {
  const rig = new ViewRig({ padding: 28 });
  rig.setViewport(W, h);
  rig.setInsets({ top: TOP });
  return rig;
};

const PRODUCTS: [string, Box3][] = [
  ['шкаф 2400 × 2400 × 600', new Box3(new Vector3(0, 0, -0.6), new Vector3(2.4, 2.4, 0))],
  ['пенал 820 × 1800 × 450', new Box3(new Vector3(0, 0, -0.45), new Vector3(0.82, 1.8, 0))],
  ['кухня 3000 × 900 × 600', new Box3(new Vector3(0, 0, -0.6), new Vector3(3, 0.9, 0))],
];

describe('изделие по центру свободной области', () => {
  it('поля под размеры симметричны', () => {
    expect(DIMENSION_MARGINS.left).toBe(DIMENSION_MARGINS.right);
    expect(DIMENSION_MARGINS.top).toBe(DIMENSION_MARGINS.bottom);
  });

  for (const [name, b] of PRODUCTS) {
    for (const [projection, H] of [['perspective', 440], ['orthographic', 440], ['perspective', 630], ['orthographic', 630]] as [Projection, number][]) {
      it(`${name}, ${projection}, канвас ${H}: центр габарита ±4 pt от центра свободной области, плашки в канвасе`, () => {
        const rig = editorRig(H);
        rig.setContent(b, DIMENSION_MARGINS);
        rig.setProjection(projection, false);
        rig.fit({ animate: false });
        const e = extent(rig, corners(b));
        expect(Math.abs(e.cx - W / 2)).toBeLessThanOrEqual(4);
        expect(Math.abs(e.cy - (TOP + H) / 2)).toBeLessThanOrEqual(4);
        // Изделие заметно: узкая сторона области занята
        expect(Math.max((e.x1 - e.x0) / (W - 56 - 152), (e.y1 - e.y0) / (H - TOP - 56 - 76))).toBeGreaterThan(0.97);
        const a = rig.anchors()!;
        // высота справа, глубина слева, ширина сверху; плашки (52 × 26) не вылезают за свободную область
        expect(a.height.label[0]).toBeGreaterThan(e.x1);
        // глубина короче 18 px не рисуется (маленькая область); в большой — видна, плашка левее изделия
        if (H > 600 && !name.startsWith('кухня')) expect(a.depth.visible).toBe(true);
        expect(a.depth.label[0] + 26).toBeLessThan(e.x0);
        expect(a.width.label[1]).toBeLessThan(e.y0);
        for (const k of ['width', 'height', 'depth'] as const) {
          const [x, y] = a[k].label;
          expect(x - 26).toBeGreaterThanOrEqual(0);
          expect(x + 26).toBeLessThanOrEqual(W);
          expect(y - 13).toBeGreaterThanOrEqual(TOP);
          expect(y + 13).toBeLessThanOrEqual(H);
        }
      });
    }
  }

  it('глубина — по левому ребру силуэта: камера справа — верхнее, слева — нижнее', () => {
    const b = PRODUCTS[1]![1];
    const project = (rig: ViewRig) => (v: Vector3) => rig.project(v, v);
    const rig = editorRig();
    rig.setContent(b, DIMENSION_MARGINS);
    rig.fit({ animate: false });
    let a = dimensionAnchors(b, project(rig), viewBasis(rig.pose.theta, rig.pose.phi).back);
    const left = rig.project(new Vector3(0, 1.8, 0));
    expect(a.depth.edgeA[0]).toBeCloseTo(left.x, 3);
    expect(a.depth.edgeA[1]).toBeCloseTo(left.y, 3);
    rig.view(-0.4, rig.pose.phi, 'perspective', false);
    a = dimensionAnchors(b, project(rig), viewBasis(rig.pose.theta, rig.pose.phi).back);
    const low = rig.project(new Vector3(0, 0, 0));
    expect(a.depth.edgeA[1]).toBeCloseTo(low.y, 3);
    expect(a.depth.normal[0]).toBeLessThan(0); // наружу — влево
  });
});

describe('размеры детали на самой детали', () => {
  const m = fixture('wardrobe_2sec.viewer.json');

  it('partBox: углы по осям детали, размеры чистовые', () => {
    const s = new ProductScene(m, { quality: 'medium', loadTexture: null });
    const side = s.partBox('body.side.left')!;
    expect(side.size).toEqual([2400, 597, 16]);
    const [c0, cL, cW, , cT] = side.corners;
    expect(c0!.distanceTo(cL!)).toBeCloseTo(2.4, 5);
    expect(c0!.distanceTo(cW!)).toBeCloseTo(0.597, 5);
    expect(c0!.distanceTo(cT!)).toBeCloseTo(0.016, 5);
    // боковина вертикальна, толщина — по x
    expect(Math.abs(cL!.y - c0!.y)).toBeCloseTo(2.4, 5);
    expect(Math.abs(cT!.x - c0!.x)).toBeCloseTo(0.016, 5);
    expect(s.partBox(9999)).toBeNull();
    // по номеру — то же
    expect(s.partBox(1)!.corners[1]!.distanceTo(cL!)).toBeLessThan(1e-9);
    // при «взрыве» углы едут вместе с деталью
    s.setExplode(1);
    const moved = s.partBox('body.side.left')!;
    expect(moved.corners[0]!.distanceTo(c0!)).toBeGreaterThan(0.01);
    expect(moved.corners[0]!.distanceTo(moved.corners[1]!)).toBeCloseTo(2.4, 5);
    s.dispose();
  });

  it('вид на деталь: видны плоскость и толщина (полка, боковина, задняя стенка в лоб)', () => {
    const s = new ProductScene(m, { quality: 'medium', loadTexture: null });
    for (const key of ['body.side.left', 'sections[0].fill[0].shelf[1]', 'body.plinth.front']) {
      const c = s.partBox(key)!.corners;
      const n = c[4]!.clone().sub(c[0]!).normalize();
      for (const [theta, phi] of [[0.4, Math.PI / 2 - 0.26], [0, Math.PI / 2], [-1.2, 1.2]] as const) {
        const a = partViewAngles(c, theta, phi);
        const cz = Math.abs(viewBasis(a.theta, a.phi).back.dot(n));
        expect(cz).toBeGreaterThanOrEqual(0.5 - 1e-6);
        expect(cz).toBeLessThanOrEqual(0.88 + 1e-6);
        expect(Math.abs(a.theta - theta)).toBeLessThanOrEqual(Math.PI);
      }
    }
    s.dispose();
  });

  for (const projection of ['perspective', 'orthographic'] as Projection[]) {
    it(`focusPart (${projection}): деталь по центру области, три размера видны, вдоль своих рёбер; null — назад`, () => {
      const s = new ProductScene(m, { quality: 'medium', loadTexture: null });
      s.setExplode(1);
      const rig = editorRig();
      rig.setContent(s.currentBounds(), {});
      rig.setProjection(projection, false);
      rig.fit({ animate: false });
      const theta0 = rig.pose.theta;
      for (const key of ['body.side.right', 'sections[0].fill[0].shelf[2]', 'body.top']) {
        const box = s.partBox(key)!;
        rig.focusPart(box.corners, { animate: false });
        expect(rig.partFocused).toBe(true);
        const e = extent(rig, box.corners);
        expect(Math.abs(e.cx - W / 2)).toBeLessThanOrEqual(4);
        expect(Math.abs(e.cy - (TOP + H) / 2)).toBeLessThanOrEqual(4);
        expect(e.x0).toBeGreaterThanOrEqual(28 + PART_MARGINS.left - 1);
        expect(e.x1).toBeLessThanOrEqual(W - 28 - PART_MARGINS.right + 1);
        expect(e.y0).toBeGreaterThanOrEqual(TOP + 28 + PART_MARGINS.top - 1);
        expect(e.y1).toBeLessThanOrEqual(H - 28 - PART_MARGINS.bottom + 1);
        const a = rig.partAnchors()!;
        const P = box.corners.map((c) => rig.project(c.clone()));
        const bits = { length: 1, width: 2, thickness: 4 } as const;
        for (const k of ['length', 'width', 'thickness'] as const) {
          const d = a[k];
          expect(d.visible).toBe(true);
          expect(d.key).toBe(k);
          // мерное ребро — одно из четырёх рёбер вдоль своей оси
          const hit = [0, 1, 2, 3, 4, 5, 6, 7].some((i) => !(i & bits[k])
            && Math.hypot(P[i]!.x - d.edgeA[0], P[i]!.y - d.edgeA[1]) < 1e-6
            && Math.hypot(P[i | bits[k]]!.x - d.edgeB[0], P[i | bits[k]]!.y - d.edgeB[1]) < 1e-6);
          expect(hit).toBe(true);
          // линия — за силуэтом детали, плашка — в канвасе
          const out = (q: [number, number]) => (q[0] - d.edgeA[0]) * d.normal[0] + (q[1] - d.edgeA[1]) * d.normal[1];
          for (const c of P) expect(out(d.a)).toBeGreaterThanOrEqual(out([c.x, c.y]) + 13);
          expect(d.label[0]).toBeGreaterThan(0);
          expect(d.label[0]).toBeLessThan(W);
          expect(d.label[1]).toBeGreaterThan(TOP);
          expect(d.label[1]).toBeLessThan(H);
        }
        // длина длиннее толщины и на экране
        expect(a.length.length).toBeGreaterThan(a.thickness.length);
      }
      rig.focusPart(null, { animate: false });
      expect(rig.partFocused).toBe(false);
      expect(rig.partAnchors()).toBeNull();
      expect(rig.pose.theta).toBeCloseTo(theta0);
      s.dispose();
    });
  }

  it('partAnchors без штатива: ось → своё ребро, плашка рядом с линией', () => {
    // Плита 600 × 400 × 18 в плоскости XY, вид чуть сверху-справа (ортогональ)
    const c: Vector3[] = [];
    for (let i = 0; i < 8; i++) c.push(new Vector3(i & 1 ? 0.6 : 0, i & 2 ? 0.4 : 0, i & 4 ? 0.018 : 0));
    const { right, up } = viewBasis(0.5, 1.1);
    const project = (v: Vector3) => v.set(200 + 400 * v.dot(right), 200 - 400 * v.dot(up), 0);
    const a = partAnchors(c, project);
    expect(a.length.length).toBeGreaterThan(a.width.length);
    expect(a.width.length).toBeGreaterThan(a.thickness.length);
    for (const k of ['length', 'width', 'thickness'] as const) {
      const d = a[k];
      const mid: [number, number] = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
      const off = Math.hypot(d.label[0] - mid[0], d.label[1] - mid[1]);
      expect(off).toBeGreaterThanOrEqual(13 + 3 - 1e-6); // не на линии
      expect(off).toBeLessThanOrEqual(Math.hypot(26, 13) + 3 + 1e-6);
    }
  });
});
