/** SCR-56 производство цеха и SCR-57 оглавление комплекта чертежей — в моке, как на сервере. */
import { createMockApi } from '../mock/mockApi';

const fast = (role?: 'owner' | 'employee') => createMockApi({ latencyMs: 0, designMs: 0, editMs: 0, ...(role ? { role } : {}) });

describe('мок API: производство и комплект чертежей', () => {
  it('настройки производства: по умолчанию, частичное сохранение, проверка значений', async () => {
    const api = fast();
    const p = await api.getProduction();
    expect(p).toMatchObject({ fastener: 'confirmat', confirmat_depth: 50, hinge_brand: 'blum', shelf_pin_grid: false, saved: false });
    expect(p.hinge_brands.map((b) => [b.id, b.plate_pattern])).toEqual([['blum', 'along'], ['hettich', 'along'], ['gtv', 'across']]);
    const s = await api.updateProduction({ fastener: 'dowel', hinge_brand: 'gtv' });
    expect(s).toMatchObject({ fastener: 'dowel', confirmat_depth: 50, hinge_brand: 'gtv', saved: true });
    await expect(api.updateProduction({ confirmat_depth: 30 as never })).rejects.toMatchObject({ status: 422 });
    expect((await api.getProduction()).hinge_brand).toBe('gtv');
  });

  it('сотруднику производство недоступно', async () => {
    const api = fast('employee');
    await expect(api.getProduction()).rejects.toMatchObject({ status: 403 });
  });

  it('оглавление комплекта: сквозные номера, разделы подряд, детали на листах, листы в списке файлов', async () => {
    const api = fast();
    const { items } = await api.listProjects();
    const id = items.find((p) => p.current_version_id)!.id;
    const set = await api.getDrawingSet(id);
    expect(set.sheets.map((s) => s.n)).toEqual(Array.from({ length: set.pages }, (_, i) => i + 1));
    expect(set.sections[0]).toMatchObject({ key: 'cover', first: 1, count: 1 });
    expect(set.sections.reduce((a, s) => a + s.count, 0)).toBe(set.pages);
    expect(set.sheets.filter((s) => s.section === 'parts').every((s) => s.parts.length > 0)).toBe(true);
    const files = await api.listFiles(id);
    expect(files.find((f) => f.kind === 'production_set_pdf')!.sheets).toBe(set.pages);
    expect(files.find((f) => f.kind === 'cut_pdf')!.sheets).toBe(set.sections.find((s) => s.key === 'cutting')!.count);
  });
});
