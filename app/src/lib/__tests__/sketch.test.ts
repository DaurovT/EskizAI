import { SAMPLES } from '../../api/mock/data';
import { createMockApi } from '../../api/mock/mockApi';
import type { KitchenSketch, WardrobeSketch } from '../../api/types';
import { SKETCH_COLORS, defaultSketch, sketchFromTree, sketchGeometry, type SketchGeometry } from '../sketch';

const faces = (g: SketchGeometry) => g.shapes.flatMap((s) => (s.type === 'face' ? [s] : []));
const lines = (g: SketchGeometry) => g.shapes.flatMap((s) => (s.type === 'line' ? [s] : []));
const finite = (g: SketchGeometry) =>
  [...faces(g).flatMap((f) => [...f.o, ...f.u, ...f.v]), ...lines(g).flatMap((l) => [...l.a, ...l.b]), g.box.w, g.box.h].every(Number.isFinite);

describe('sketchFromTree (как services/sketch.py)', () => {
  it('шкаф: секции, двери, антресоль, цоколь по умолчанию', () => {
    const s = sketchFromTree(SAMPLES.wardrobe_full.tree) as WardrobeSketch;
    expect(s).toMatchObject({ kind: 'wardrobe', w: 1800, h: 2400, d: 600, plinth: 70, mezz: 400, sliding: 0 });
    expect(s.cols.map((c) => c.w)).toEqual([570, 596, 570]);
    expect(s.cols.map((c) => c.doors)).toEqual([1, 2, 1]);
    expect(s.cols[2].hinge).toBe('right');
    expect(s.cols[1].zones[0]).toEqual({ t: 'drawers', n: 3, h: 600, ext: true });
  });
  it('купе, стеллаж, кухня', () => {
    expect((sketchFromTree(SAMPLES.kupe_3doors.tree) as WardrobeSketch).sliding).toBe(3);
    expect((sketchFromTree(SAMPLES.wardrobe_2sec.tree) as WardrobeSketch).cols.every((c) => !c.doors)).toBe(true);
    const k = sketchFromTree(SAMPLES.kitchen_straight.tree) as KitchenSketch;
    expect(k).toMatchObject({ kind: 'kitchen', layout: 'straight', top_t: 38, w: 2850 });
    expect(k.wall.map((m) => m.t)).toEqual(['doors', 'doors', 'hood', 'doors', 'open']);
    expect((sketchFromTree(SAMPLES.kitchen_corner.tree) as KitchenSketch).base2).toHaveLength(2);
  });
  it('непонятное дерево — null', () => {
    expect(sketchFromTree(null)).toBeNull();
    expect(sketchFromTree({})).toBeNull();
    expect(sketchFromTree({ type: 'kitchen', base: [] })).toBeNull();
  });
});

describe('sketchGeometry', () => {
  it('изометрия как в макете: верх шкафа 1500×600×2100 — (0,−2100) → (1299,−1350)', () => {
    const g = sketchGeometry({ kind: 'wardrobe', w: 1500, h: 2100, d: 600, plinth: 0, mezz: 0, sliding: 3, cols: [] });
    const top = faces(g).find((f) => f.fill === SKETCH_COLORS.top)!;
    expect(top.o[0]).toBeCloseTo(0);
    expect(top.o[1]).toBeCloseTo(-2100);
    expect(top.o[0] + top.u[0]).toBeCloseTo(1299, 0);
    expect(top.o[1] + top.u[1]).toBeCloseTo(-1350);
    // три двери купе: две линии раздела и три ручки, фасад прозрачный (видна клетка)
    expect(lines(g).filter((l) => l.kind === 'handle')).toHaveLength(3);
    expect(faces(g).some((f) => f.fill === SKETCH_COLORS.paper)).toBe(false);
  });
  it('стеллаж без дверей — полки видны, ручек нет', () => {
    const g = sketchGeometry(sketchFromTree(SAMPLES.wardrobe_2sec.tree)!);
    expect(lines(g).filter((l) => l.kind === 'handle')).toHaveLength(0);
    expect(lines(g).filter((l) => l.kind === 'line').length).toBeGreaterThanOrEqual(8);
    expect(g.box.h).toBeGreaterThan(g.box.w);
  });
  it('кухня: нижние + столешница + верхние, вытяжка — отдельной коробкой; столешница закрывает линии под собой', () => {
    const g = sketchGeometry(sketchFromTree(SAMPLES.kitchen_straight.tree)!);
    expect(faces(g).filter((f) => f.fill === SKETCH_COLORS.top).length).toBeGreaterThanOrEqual(5);
    expect(faces(g).some((f) => f.fill === SKETCH_COLORS.paper)).toBe(true);
    expect(g.box.w).toBeGreaterThan(g.box.h * 0.6);
    expect(finite(g)).toBe(true);
  });
  it('все образцы и заглушки — конечные числа', () => {
    for (const s of Object.values(SAMPLES)) expect(finite(sketchGeometry(sketchFromTree(s.tree)!))).toBe(true);
    for (const k of ['wardrobe', 'wardrobe_sliding', 'rack', 'kitchen', 'kitchen_corner', 'dresser', 'tv_stand', 'pencil', null]) {
      expect(finite(sketchGeometry(defaultSketch(k)))).toBe(true);
    }
  });
});

describe('мок API', () => {
  it('список отдаёт эскиз текущей версии, у черновика без модели — null', async () => {
    const api = createMockApi({ latencyMs: 0 });
    const { items } = await api.listProjects();
    const byId = Object.fromEntries(items.map((p) => [p.id, p]));
    expect(byId['p-aziza'].sketch?.kind).toBe('wardrobe');
    expect(byId['p-kitchen'].sketch?.kind).toBe('kitchen');
    expect((byId['p-kupe'].sketch as WardrobeSketch).sliding).toBe(3);
    expect(byId['p-shelf'].sketch).toBeNull();
  });
});
