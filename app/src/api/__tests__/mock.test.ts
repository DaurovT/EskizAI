import { createMockApi } from '../mock/mockApi';
import { pollTask } from '../tasks';
import type { DesignOut, EditOut } from '../types';
import { isMasterEstimate } from '../types';

const fast = () => createMockApi({ latencyMs: 0, designMs: 0, editMs: 0 });
const poll = <R>(api: ReturnType<typeof fast>, id: string) => pollTask<R>((t) => api.getTask<R>(t), id, { sleep: async () => undefined });

describe('мок API: путь мастера', () => {
  it('вход: код 00000, первый вход — новый пользователь', async () => {
    const api = fast();
    await api.requestCode('+998901234567');
    await expect(api.verifyCode({ phone: '+998901234567', code: '1111' })).rejects.toMatchObject({ status: 400, code: 'code_invalid' });
    const t = await api.verifyCode({ phone: '+998901234567', code: '00000' });
    expect(t.is_new_user).toBe(true);
    expect((await api.verifyCode({ phone: '+998901234567', code: '00000' })).is_new_user).toBe(false);
  });

  it('фото → вопросы → ответы → модель; правка; отмена; смета; ссылка', async () => {
    const api = fast();
    const p = await api.createProject({ title: 'Тест' });
    const ph = await api.uploadPhoto(p.id, { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' });
    const d1 = await poll<DesignOut>(api, (await api.aiDesign(p.id, { photo_ids: [ph.id] })).task_id);
    expect(d1.status).toBe('questions');
    expect(d1.questions.length).toBeLessThanOrEqual(3);
    expect(d1.estimated).toContain('/width');
    const d2 = await poll<DesignOut>(api, (await api.aiAnswer(p.id, { q_width: '2000 мм' })).task_id);
    expect(d2.status).toBe('ready');
    expect(d2.estimated).not.toContain('/width');
    expect(d2.estimated).toContain('/installation');
    const m = await api.getModel(p.id);
    expect(m.version.tree.width).toBe(2000);
    expect(m.version.viewer.size[0]).toBeCloseTo(2000, 0);

    const e = await poll<EditOut>(api, (await api.aiEdit(p.id, 'высота 2200')).task_id);
    expect(e.ok).toBe(true);
    expect(e.price_delta).not.toBeNull();
    expect((await api.getModel(p.id)).version.tree.height).toBe(2200);
    const u = await api.undo(p.id);
    expect(u.version.tree.height).toBe(2400);
    expect(u.can_redo).toBe(true);
    const chat = await api.getChat(p.id);
    expect(chat.messages.some((x) => x.undone)).toBe(true);

    const est = await api.getEstimate(p.id);
    expect(isMasterEstimate(est)).toBe(true);
    expect(est.exact).toBe(false);

    await expect(api.createShareLink(p.id, { language: 'ru', show_price: true })).rejects.toMatchObject({ status: 409 });
    await api.toSketch(p.id);
    const link = await api.createShareLink(p.id, { language: 'uz', show_price: true, estimate_view: 'detailed' });
    expect(link.url).toContain('lang=uz');
    expect((await api.getProject(p.id)).status).toBe('sent');
  });

  it('ответы разом → второй раунд вопросов → готово; отвеченное не спрашивается, видно в чате', async () => {
    const api = fast();
    const p = await api.createProject({ title: 'Раунды' });
    const ph = await api.uploadPhoto(p.id, { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' });
    const d1 = await poll<DesignOut>(api, (await api.aiDesign(p.id, { photo_ids: [ph.id] })).task_id);
    expect((await api.getChat(p.id)).questions?.map((q) => q.id)).toEqual(d1.questions.map((q) => q.id));
    const d2 = await poll<DesignOut>(api, (await api.aiAnswer(p.id, { q_width: '2000 мм', q_ends: 'Нет, в нише', q_fronts: 'не знаю' })).task_id);
    expect(d2.status).toBe('questions');
    expect(d2.questions.map((q) => q.id)).toEqual(['q_niche_h']);
    expect(d2.answers).toMatchObject({ q_width: '2000 мм', q_ends: 'Нет, в нише' });
    const chat = await api.getChat(p.id);
    expect(chat.questions?.map((q) => q.id)).toEqual(['q_niche_h']);
    expect(chat.messages.some((m) => m.author === 'master' && m.text.includes('Какая ширина ниши или места? — 2000 мм'))).toBe(true);
    const d3 = await poll<DesignOut>(api, (await api.aiAnswer(p.id, { q_niche_h: '2600 мм' })).task_id);
    expect(d3.status).toBe('ready');
    expect((await api.getChat(p.id)).questions).toEqual([]);
    const m = await api.getModel(p.id);
    expect([m.version.tree.width, m.version.tree.height]).toEqual([2000, 2600]);
    const part = await api.getPart(p.id, m.version.viewer.parts[0].number);
    expect(part.product_size_mm[0]).toBeCloseTo(2000, 0);
    expect(part.cut_length_mm).toBeLessThanOrEqual(part.length_mm);
  });

  it('несколько фото → рамки предметов и вопрос object (всего ≤ 3)', async () => {
    const api = fast();
    const p = await api.createProject({ title: 'o' });
    const a = await api.uploadPhoto(p.id, { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' });
    const b = await api.uploadPhoto(p.id, { uri: 'file:///b.jpg', name: 'b.jpg', type: 'image/jpeg' });
    const d = await poll<DesignOut>(api, (await api.aiDesign(p.id, { photo_ids: [a.id, b.id] })).task_id);
    expect(d.objects?.length).toBe(2);
    expect(d.objects!.filter((o) => o.chosen)).toHaveLength(1);
    expect(d.questions[0]).toMatchObject({ id: 'object', options: d.objects!.map((o) => o.label) });
    expect(d.questions.length).toBeLessThanOrEqual(3);
    for (const o of d.objects!) for (const v of o.box) expect(v >= 0 && v <= 1).toBe(true);
  });

  it('несколько предметов → несколько проектов; лимит за каждый, не хватает — ничего не создаётся', async () => {
    const api = fast();
    const p = await api.createProject({ title: 'o' });
    const a = await api.uploadPhoto(p.id, { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' });
    const b = await api.uploadPhoto(p.id, { uri: 'file:///b.jpg', name: 'b.jpg', type: 'image/jpeg' });
    const d = await poll<DesignOut>(api, (await api.aiDesign(p.id, { photo_ids: [a.id, b.id] })).task_id);
    expect(d.objects![0].size).toHaveLength(3);
    const before = (await api.listProjects()).total;
    const r = await api.aiChooseObjects(p.id, [1, 0]);
    expect(r.charged).toBe(1);
    expect(r.projects.map((x) => [x.object_index, x.created])).toEqual([[1, false], [0, true]]);
    expect(r.projects[0].project_id).toBe(p.id);
    for (const x of r.projects) expect((await poll<DesignOut>(api, x.task_id)).status).toBe('ready');
    const created = await api.getProject(r.projects[1].project_id);
    expect(created.title).toBe('Шкаф слева');
    expect(created.charged).toBe(true);
    expect(created.photos).toHaveLength(2);
    expect((await api.listProjects()).total).toBe(before + 1);
    expect((await api.limits()).free_left).toBe(1);
    // осталось 1: 1 новый + несписанный текущий = 2 → 402, ничего не создано
    const q = await api.createProject({ title: 'q' });
    const c = await api.uploadPhoto(q.id, { uri: 'file:///c.jpg', name: 'c.jpg', type: 'image/jpeg' });
    const e = await api.uploadPhoto(q.id, { uri: 'file:///e.jpg', name: 'e.jpg', type: 'image/jpeg' });
    await poll<DesignOut>(api, (await api.aiDesign(q.id, { photo_ids: [c.id, e.id] })).task_id);
    await expect(api.aiChooseObjects(q.id, [0, 0])).rejects.toMatchObject({ status: 422 });
    await expect(api.aiChooseObjects(q.id, [0, 1])).rejects.toMatchObject({ status: 402, code: 'limit_exhausted', details: { needed: 2, left: 1 } });
    expect((await api.listProjects()).total).toBe(before + 2);
  });

  it('короткий текст → выбор типа; «ошибка» → failed', async () => {
    const api = fast();
    const p = await api.createProject({ title: 'x' });
    expect((await poll<DesignOut>(api, (await api.aiDesign(p.id, { text: 'шкаф' })).task_id)).status).toBe('choose_type');
    const r = await poll<DesignOut>(api, (await api.aiChooseType(p.id, 'wardrobe_sliding')).task_id);
    expect(r.status).toBe('ready');
    expect((await api.getModel(p.id)).version.tree.sliding_doors).toBeTruthy();
    const p2 = await api.createProject({ title: 'y' });
    expect((await poll<DesignOut>(api, (await api.aiDesign(p2.id, { text: 'ошибка, тут не мебель' })).task_id)).status).toBe('failed');
  });

  it('замечание с исправлением в одно касание', async () => {
    const api = fast();
    const { items } = await api.listProjects();
    const id = items.find((p) => p.title.includes('Азизы'))!.id;
    const m = await api.getModel(id);
    const tree = { ...m.version.tree, sections: m.version.tree.sections!.map((s, i) => (i === 1 ? { ...s, doors: { count: 1 as const } } : s)), width: 2600 };
    const bad = await api.saveModel(id, { tree });
    const i = bad.version.issues.findIndex((x) => x.fixes.length);
    expect(i).toBeGreaterThanOrEqual(0);
    const fixed = await api.applyFix(id, i, 0);
    expect(fixed.version.issues.filter((x) => x.code === 'door_too_wide')).toHaveLength(0);
  });

  it('сотрудник не видит себестоимость', async () => {
    const api = createMockApi({ latencyMs: 0, role: 'employee' });
    const { items } = await api.listProjects();
    const est = await api.getEstimate(items.find((p) => p.current_version_id)!.id);
    expect(isMasterEstimate(est)).toBe(false);
    expect(JSON.stringify(est)).not.toContain('cost');
  });

  it('файлы закрыты без заказа (402), КП открыт всегда', async () => {
    const api = fast();
    const { items } = await api.listProjects();
    const id = items.find((p) => p.status === 'sent')!.id;
    const files = await api.listFiles(id);
    expect(files.find((f) => f.kind === 'offer_pdf')!.available).toBe(true);
    expect(files.find((f) => f.kind === 'parts_dxf')!.available).toBe(false);
    await expect(api.downloadFile(id, 'parts_dxf')).rejects.toMatchObject({ status: 402 });
    const f = await api.downloadFile(id, 'offer_pdf');
    expect(f.mimeType).toBe('application/pdf');
  });
});

describe('мок API: данные экранов нового дизайна', () => {
  it('дубль проекта, цена версий, цена файлов, настройки уведомлений, платежи', async () => {
    const api = fast();
    const { items } = await api.listProjects();
    const src = items.find((p) => p.status === 'sent')!;
    const copy = await api.duplicateProject(src.id);
    expect(copy.title).toBe(`${src.title} (копия)`);
    expect(copy.status).toBe('draft');
    expect((await api.getModel(copy.id)).version.tree).toEqual((await api.getModel(src.id)).version.tree);

    const vs = await api.listVersions(src.id);
    expect(vs[0].price?.from).toBeGreaterThan(0);

    const info = await api.filesInfo(src.id);
    expect(info.purchase).toMatchObject({ price: 45_000, currency: 'UZS' });

    const s = await api.updateNotificationSettings({ types: { prices_stale: false }, quiet: { enabled: false } });
    expect(s.types.find((x) => x.key === 'prices_stale')!.enabled).toBe(false);
    expect((await api.getNotificationSettings()).quiet.enabled).toBe(false);

    const pays = await api.listPayments();
    expect(pays.some((x) => x.status === 'refunded')).toBe(true);
  });
});
