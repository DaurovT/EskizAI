import { createMockApi } from '../mock/mockApi';

const fast = () => createMockApi({ latencyMs: 0, designMs: 0, editMs: 0 });

describe('мок API: просьбы клиентов (SCR-58)', () => {
  it('по цеху: новые сверху, счётчик, «Сделано» и обратно', async () => {
    const api = fast();
    const all = await api.listWorkshopClientRequests();
    expect(all.total).toBe(5);
    expect(all.new_count).toBe(2);
    expect(all.items[0]).toMatchObject({ status: 'new', project_title: 'Шкаф для Азизы', client_name: 'Азиза' });
    const fresh = await api.listWorkshopClientRequests({ status: 'new' });
    expect(fresh.items.map((r) => r.status)).toEqual(['new', 'new']);

    const done = await api.setClientRequestStatus(fresh.items[0].id, 'done');
    expect(done.status).toBe('done');
    expect((await api.listWorkshopClientRequests()).new_count).toBe(1);
    expect((await api.setClientRequestStatus(done.id, 'new')).done_at).toBeNull();
    await expect(api.setClientRequestStatus('nope', 'done')).rejects.toMatchObject({ status: 404 });
  });

  it('по проекту — только его просьбы', async () => {
    const api = fast();
    const items = await api.listClientRequests('p-aziza');
    expect(items).toHaveLength(2);
    expect((await api.listWorkshopClientRequests({ project_id: 'p-aziza' })).items).toHaveLength(2);
  });
});
