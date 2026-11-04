/**
 * docs/staff_vendor_contract.md §8 «Вход по SMS, расходы ИИ и права мастера»: пример от сервера (POST /projects/example),
 * понятные тексты новых ошибок, права сотрудника в заказе (переписка, возвраты, споры, исправления, суммы).
 */
import { ApiError } from '../errors';
import { Http, type TokenStore } from '../http';
import { createHttpApi } from '../httpApi';
import { createMockApi } from '../mock/mockApi';
import { pollTask } from '../tasks';
import type { EditOut } from '../types';
import { ensureExample } from '../../lib/example';
import { orderAccess } from '../../lib/orders';
import { routeForPush } from '../../lib/pushRoute';
import { errorInfo, errorLine } from '../../ui/dialogs';

const fast = (o: Parameters<typeof createMockApi>[0] = {}) => createMockApi({ latencyMs: 0, designMs: 0, editMs: 0, ...o });
const tokens = (): TokenStore => {
  let v: { access: string; refresh: string } | null = { access: 'A', refresh: 'R' };
  return { get: async () => v, set: async (t) => { v = t; } };
};
const json = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe('пример «Попробовать на примере»', () => {
  it('мок: сервер создаёт пример из шаблона; повторно — тот же; удалённый — заново, но не больше 3', async () => {
    const api = fast();
    const p = await api.createExample();
    expect(p).toMatchObject({ is_example: true, title: 'Пример: шкаф-купе' });
    const m = await api.getModel(p.id);
    expect(m.version.number).toBe(1);
    expect(m.version.estimated).toEqual(['/width']);
    expect(m.version.tree.sliding_doors?.count).toBe(3);
    expect((await api.createExample()).id).toBe(p.id);
    await api.deleteProject(p.id);
    const p2 = await api.createExample();
    expect(p2.id).not.toBe(p.id);
    await api.deleteProject(p2.id);
    await api.deleteProject((await api.createExample()).id);
    await expect(api.createExample()).rejects.toMatchObject({ status: 409, code: 'example_limit' });
  });

  it('ensureExample: открыть пример; 409 example_limit — подсказка, а не ошибка; прочее — дальше', async () => {
    const api = fast();
    const r = await ensureExample(api);
    expect(r.kind).toBe('open');
    const limit = await ensureExample({ createExample: async () => { throw new ApiError(409, 'example_limit', 'Пример уже был создан'); } });
    expect(limit).toEqual({ kind: 'limit', message: 'Пример уже был создан' });
    await expect(ensureExample({ createExample: async () => { throw new ApiError(0, 'network', 'x'); } })).rejects.toMatchObject({ isNetwork: true });
  });

  it('HTTP: POST /projects/example (201 новый, 200 действующий); 409 → example_limit', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const replies = [json(201, { id: 'p1', is_example: true }), json(200, { id: 'p1', is_example: true }),
      json(409, { error: { code: 'example_limit', message: 'Пример уже был создан' } })];
    const fetch = async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return replies.shift()!; };
    const api = createHttpApi(new Http({ baseUrl: 'http://api', tokens: tokens(), fetch }));
    expect((await api.createExample()).id).toBe('p1');
    expect(await ensureExample(api)).toEqual({ kind: 'open', id: 'p1' });
    expect(await ensureExample(api)).toMatchObject({ kind: 'limit' });
    expect(calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ['POST', 'http://api/projects/example', '{}'], ['POST', 'http://api/projects/example', '{}'], ['POST', 'http://api/projects/example', '{}'],
    ]);
  });

  it('мок: ИИ в примерах — общий бюджет цеха (402 ai_budget_example, без вопроса «списать проект»)', async () => {
    const api = fast({ exampleAiTasks: 1 });
    const p = await api.createExample();
    const ok = await pollTask<EditOut>((t) => api.getTask<EditOut>(t), (await api.aiEdit(p.id, 'высота 2200')).task_id, { sleep: async () => undefined });
    expect(ok.ok).toBe(true);
    await expect(api.aiEdit(p.id, 'высота 2100')).rejects.toMatchObject({ status: 402, code: 'ai_budget_example' });
  });
});

describe('мок: новые ошибки сервера', () => {
  it('одна ИИ-задача на проект — 409 ai_busy, после ответа — снова можно', async () => {
    let t = 0;
    const api = createMockApi({ latencyMs: 0, designMs: 1000, editMs: 1000, now: () => t });
    const p = await api.createProject({ title: 'Шкаф' });
    const { task_id } = await api.aiChooseType(p.id, 'wardrobe');
    await expect(api.aiEdit(p.id, 'высота 2200')).rejects.toMatchObject({ status: 409, code: 'ai_busy' });
    t = 2000;
    expect((await api.getTask(task_id)).status).toBe('done');
    expect((await api.aiEdit(p.id, 'высота 2200')).task_id).toBeTruthy();
  });

  it('фото не картинка — 415 unsupported_photo', async () => {
    const api = fast();
    const p = await api.createProject({ title: 'x' });
    await expect(api.uploadPhoto(p.id, { uri: 'file:///a.pdf', name: 'a.pdf', type: 'application/pdf' })).rejects.toMatchObject({ status: 415, code: 'unsupported_photo' });
    expect((await api.uploadPhoto(p.id, { uri: 'file:///a.heic', name: 'a.heic', type: 'image/heic' })).id).toBeTruthy();
  });

  it('регистрация закрыта — 503 registration_closed уже на request-code; приглашённый номер проходит', async () => {
    const api = fast({ registrationClosed: true });
    await expect(api.requestCode('+998901112233')).rejects.toMatchObject({ status: 503, code: 'registration_closed' });
    expect((await api.requestCode('+998935550000')).code_length).toBe(5);
  });
});

describe('тексты ошибок (ru/uz)', () => {
  const e = (status: number, code: string, msg = 'server') => new ApiError(status, code, msg);
  it('ИИ: занят, часовой лимит, бюджет примера; вход: блок на сутки, частые запросы, регистрация закрыта; фото', () => {
    expect(errorInfo(e(409, 'ai_busy'), 'ru')).toMatchObject({ kind: 'busy', title: 'ИИ ещё работает над этим проектом' });
    expect(errorInfo(e(409, 'ai_busy'), 'uz').title).toBe('SI hali bu loyiha ustida ishlayapti');
    expect(errorInfo(e(429, 'ai_workshop_hourly_limit'), 'ru').kind).toBe('limit');
    expect(errorInfo(e(402, 'ai_budget_example'), 'ru').title).toBe('ИИ в примере закончился');
    expect(errorInfo(e(429, 'code_locked'), 'ru').title).toBe('Вход по номеру закрыт до завтра');
    expect(errorLine(e(429, 'code_locked'), 'ru')).toContain('Попробуйте завтра');
    expect(errorLine(e(429, 'code_limit'), 'uz')).toContain('Kod juda ko‘p so‘raldi');
    expect(errorLine(e(503, 'registration_closed'), 'ru')).toContain('Регистрация временно закрыта');
    expect(errorInfo(e(415, 'unsupported_photo'), 'ru')).toMatchObject({ kind: 'bad_photo', text: 'Загрузите фото в формате JPEG, PNG, WebP или HEIC' });
    // неизвестный код — сообщение сервера как есть
    expect(errorLine(e(409, 'something_new', 'Текст сервера'), 'uz')).toBe('Текст сервера');
  });
  it('403 без права: по-русски — точный текст сервера, по-узбекски — общий', () => {
    const f = e(403, 'forbidden', 'Это делает владелец цеха или сотрудник с правом заказа');
    expect(errorInfo(f, 'ru')).toMatchObject({ kind: 'forbidden', title: 'Нет прав', text: 'Это делает владелец цеха или сотрудник с правом заказа' });
    expect(errorInfo(f, 'uz')).toMatchObject({ title: 'Huquq yo‘q', text: 'Buni sex egasi yoki kerakli huquqi bor xodim qila oladi' });
  });
});

describe('права в заказе: что показывать', () => {
  it('владелец — всё; сотрудник без прав — ничего; с правом заказа без цен — всё, кроме «Подтвердить» и сумм', () => {
    const all = { chat: true, returns: true, disputes: true, corrections: true, approveCorrection: true, resubmit: true, cancel: true, amounts: true };
    expect(orderAccess({ canOrder: true, seesCost: true })).toEqual(all);
    expect(orderAccess({ canOrder: false, seesCost: false })).toEqual(
      { chat: false, returns: false, disputes: false, corrections: false, approveCorrection: false, resubmit: false, cancel: false, amounts: false });
    expect(orderAccess({ canOrder: true, seesCost: false })).toEqual({ ...all, approveCorrection: false, amounts: false });
    expect(orderAccess({ canOrder: false, seesCost: true })).toMatchObject({ chat: false, approveCorrection: false, amounts: true });
  });
  it('push сотруднику без права заказа — в карточку, не в переписку/рекламации', () => {
    expect(routeForPush({ kind: 'order_message', order_id: 'o1' })).toBe('/order/chat/o1');
    expect(routeForPush({ kind: 'order_message', order_id: 'o1' }, false)).toBe('/order/o1');
    expect(routeForPush({ kind: 'return_decided', order_id: 'o1' }, false)).toBe('/order/o1');
  });
});

describe('мок: права сотрудника в заказе (как сервер)', () => {
  const emp = (canOrder: boolean, canSeeCost: boolean) => createMockApi({ latencyMs: 0, designMs: 60_000, role: 'employee', canOrder, canSeeCost });

  it('без права заказа: переписка, возвраты, споры, исправления, resubmit, отмена — 403', async () => {
    const api = emp(false, true);
    const forbidden = { status: 403, code: 'forbidden' };
    await expect(api.listOrderMessages('o-1')).rejects.toMatchObject(forbidden);
    await expect(api.sendOrderMessage('o-1', { text: 'x' })).rejects.toMatchObject(forbidden);
    await expect(api.markOrderMessagesRead('o-1')).rejects.toMatchObject(forbidden);
    await expect(api.listOrderReturns('o-1')).rejects.toMatchObject(forbidden);
    await expect(api.createOrderReturn('o-1', { type: 'defect', description: 'Скол' })).rejects.toMatchObject(forbidden);
    await expect(api.listOrderDisputes('o-5')).rejects.toMatchObject(forbidden);
    await expect(api.openOrderDispute('o-5', { subject: 'rejection', reason: 'other', comment: 'x' })).rejects.toMatchObject(forbidden);
    await expect(api.listOrderCorrections('o-4')).rejects.toMatchObject(forbidden);
    await expect(api.declineOrderCorrection('o-4', 'c')).rejects.toMatchObject(forbidden);
    await expect(api.resubmitOrder('o-3')).rejects.toMatchObject(forbidden);
    await expect(api.cancelOrder('o-3')).rejects.toMatchObject(forbidden);
    // карточка заказа — видна
    expect((await api.getOrder('o-1')).id).toBe('o-1');
  });

  it('с правом заказа без «видит себестоимость»: нет сумм; «Подтвердить» — 403, «Отклонить» — можно', async () => {
    const api = emp(true, false);
    const o = await api.getOrder('o-4');
    expect(o.total).toBeUndefined();
    expect(o.invoice_total).toBeUndefined();
    expect(o.items.every((i) => i.amount === undefined && i.price === undefined)).toBe(true);
    const [c] = await api.listOrderCorrections('o-4');
    expect(c.total_before).toBeUndefined();
    expect(c.total_after).toBeUndefined();
    expect(c.delta).toBeUndefined();
    expect(c.lines_after.every((l) => l.total === undefined && l.price === undefined)).toBe(true);
    await expect(api.approveOrderCorrection('o-4', c.id)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    const returns = await api.listOrderReturns('o-1');
    expect(returns.every((r) => r.amount === undefined && r.refund_amount === undefined)).toBe(true);
    expect((await api.declineOrderCorrection('o-4', c.id, 'дорого')).status).toBe('created');
  });

  it('с обоими правами — суммы есть, подтвердить можно', async () => {
    const api = emp(true, true);
    const [c] = await api.listOrderCorrections('o-4');
    expect(c.delta).toBe(746_000);
    expect((await api.approveOrderCorrection('o-4', c.id)).total).toBe(5_126_000);
  });
});
