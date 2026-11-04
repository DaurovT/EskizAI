import { createMockApi } from '../../api/mock/mockApi';
import { withOfflineCache, type KV } from '../../api/offline';
import { ApiError } from '../../api/errors';
import type { ProductTree } from '../../api/types';
import { cleanSite, initialSite, moduleLengths, newUtility, wallDiffs } from '../kitchenMeasure';

const corner: ProductTree = {
  type: 'kitchen', layout: 'corner', corner_side: 'left', countertop: { depth: 600 },
  base: [{ kind: 'corner', width: 900, corner_shape: 'square' }, { kind: 'appliance', width: 600 }, { kind: 'appliance', width: 450 }, { kind: 'sink', width: 850 }],
  base2: [{ kind: 'drawers', width: 450 }, { kind: 'drawers', width: 450 }],
};
const straight: ProductTree = { type: 'kitchen', base: [{ kind: 'doors', width: 600 }, { kind: 'sink', width: 800 }], countertop: { depth: 600 } };

describe('замер кухни: расчёты экрана', () => {
  it('длины рядов: стена Б — с угловым модулем; у длинного глухого угла — от кромки столешницы', () => {
    expect(moduleLengths(corner)).toEqual({ a: 2800, b: 1800 });
    const long = { ...corner, base: [{ kind: 'corner', width: 1100 }, ...(corner.base as object[]).slice(1)] };
    expect(moduleLengths(long).b).toBe(600 + 900);
    expect(moduleLengths(straight)).toEqual({ a: 1400, b: null });
  });

  it('начальный замер — из модели (site) или из длин рядов; разница со стенами', () => {
    const s = initialSite(corner);
    expect(s).toMatchObject({ wall_a: 2800, wall_b: 1800, utilities: [] });
    expect(wallDiffs(corner, { ...s, wall_a: 2810, wall_b: 1795 })).toEqual([{ wall: 'a', diff: 10 }, { wall: 'b', diff: -5 }]);
    const site = { wall_a: 2810, utilities: [newUtility('gas')] };
    expect(initialSite({ ...corner, site }).utilities[0]).toMatchObject({ kind: 'gas', height: 900 });
  });

  it('прямая кухня: всё на стене А, пустые поля не уходят на сервер', () => {
    const s = cleanSite({ wall_a: 2850, wall_b: 1000, ceiling: null, window: { wall: 'b', from_corner: 100, width: 800, sill: 900 },
      utilities: [{ ...newUtility('vent'), wall: 'b' }, { ...newUtility('water'), height: null }] }, false);
    expect(s).toEqual({ wall_a: 2850, window: { wall: 'a', from_corner: 100, width: 800, sill: 900 },
      utilities: [{ kind: 'vent', wall: 'a', from_corner: 0, height: 2300, size: '200×150' }, { kind: 'water', wall: 'a', from_corner: 0 }] });
  });
});

describe('замер кухни: мок и очередь', () => {
  const memKV = (): KV => {
    const m = new Map<string, string>();
    return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => { m.set(k, v); }, removeItem: async (k) => { m.delete(k); } };
  };

  it('мок хранит замер в data.kitchen и в модели (site); без сети — в очереди целиком', async () => {
    const base = createMockApi({ latencyMs: 0 });
    const p = await base.createProject({ title: 'Кухня' });
    await base.saveModel(p.id, { tree: straight });
    await base.toSketch(p.id);
    const kitchen = { wall_a: 1400, utilities: [newUtility('water')] };
    const m = await base.addMeasurement(p.id, { kitchen });
    expect(m.width).toBe(1400);
    expect(m.data).toMatchObject({ kitchen });
    expect(m.applied_version_id).toBeTruthy();
    expect((await base.getModel(p.id)).version.tree.site).toEqual(kitchen);

    let offline = true;
    const net = new ApiError(0, 'network', 'offline');
    const flaky = new Proxy(base, {
      get(t, k) {
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === 'function' ? (...a: unknown[]) => (offline ? Promise.reject(net) : (v as (...x: unknown[]) => unknown)(...a)) : v;
      },
    });
    const api = withOfflineCache(flaky, memKV());
    const q = await api.addMeasurement(p.id, { kitchen: { ...kitchen, wall_a: 1405 } });
    expect(q.id).toMatch(/^pending-/);
    expect((await api.pendingMeasurements(p.id))[0].body.kitchen?.wall_a).toBe(1405);
    offline = false;
    expect(await api.flushOutbox()).toBe(1);
    const list = await base.listMeasurements(p.id);
    expect(list[list.length - 1].kitchen?.wall_a).toBe(1405);
  });
});
