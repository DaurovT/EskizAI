import { ApiError } from '../errors';
import { createMockApi } from '../mock/mockApi';
import { withOfflineCache, type KV } from '../offline';

const memKV = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => { m.set(k, v); }, removeItem: async (k) => { m.delete(k); } };
};

describe('офлайн-кэш и очередь замеров', () => {
  it('без сети отдаёт последнюю загруженную версию', async () => {
    const base = createMockApi({ latencyMs: 0 });
    let offline = false;
    const net = new ApiError(0, 'network', 'offline');
    const flaky = new Proxy(base, {
      get(t, k) {
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === 'function' ? (...a: unknown[]) => (offline ? Promise.reject(net) : (v as (...x: unknown[]) => unknown)(...a)) : v;
      },
    });
    const fromCache = jest.fn();
    const api = withOfflineCache(flaky, memKV(), { onServedFromCache: fromCache });
    const list = await api.listProjects();
    const id = list.items[0].id;
    const card = await api.getProject(id);
    offline = true;
    await expect(api.getProject(id)).resolves.toEqual(card);
    expect(fromCache).toHaveBeenCalledWith('getProject');
    await expect(api.getModel('нет-в-кэше')).rejects.toBe(net);
    // правка без сети не кэшируется и не подменяется
    await expect(api.saveModel(id, { tree: {} })).rejects.toBe(net);

    // замер без сети — в очередь, при связи — отправка
    const sentId = list.items.find((p) => p.status === 'sent')!.id;
    const m = await api.addMeasurement(sentId, { width: 1810 });
    expect(m.id).toMatch(/^pending-/);
    expect(await api.pendingMeasurements(sentId)).toHaveLength(1);
    offline = false;
    expect(await api.flushOutbox()).toBe(1);
    expect(await api.pendingMeasurements()).toHaveLength(0);
    expect((await api.getProject(sentId)).status).toBe('measured');
  });
});
