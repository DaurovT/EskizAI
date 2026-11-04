/** Заказ глазами мастера по контракту поставщика (docs/staff_vendor_contract.md §5.3/§5.6): статусы, исправления, переписка, рекламации, споры, push. */
import { ApiError } from '../errors';
import { Http, type TokenStore } from '../http';
import { createHttpApi } from '../httpApi';
import { createMockApi } from '../mock/mockApi';
import type { OrderDispute, OrderOut } from '../types';
import {
  attachmentUrl, canDisputeRejection, canDisputeReturn, canPay, canReport, canResubmit, diffLines, isActiveOrder, needsMaster,
  orderBadge, orderNote, orderProgress, orderSteps, unreadTotal,
} from '../../lib/orders';
import { routeForPush } from '../../lib/pushRoute';
import { orderEvents } from '../../state/orderEvents';

const o = (status: OrderOut['status'], extra: Partial<OrderOut> = {}) =>
  ({ status, payment: null, ready_date: null, due_date: null, created_at: '2026-11-01T10:00:00Z', paid_at: null, steps: undefined, ...extra }) as OrderOut;

describe('статусы заказа: метка, подпись, прогресс', () => {
  it('новый путь: на проверке → счёт (не оплачен) → оплачен', () => {
    expect(orderBadge(o('created'))).toEqual({ label: 'os_created', tone: 'blue' });
    expect(orderNote(o('created'))).toEqual({ key: 'ol_in_review' });
    const acc = o('accepted', { payment: { status: 'waiting', url: 'https://pay' } });
    expect(orderBadge(acc)).toEqual({ label: 'ol_unpaid', tone: 'red' });
    expect(orderNote(acc)).toEqual({ key: 'ol_wait_pay' });
    expect(needsMaster(acc)).toBe(true);
    expect(orderBadge(o('paid', { payment: { status: 'paid' } }))).toEqual({ label: 'os_paid', tone: 'blue' });
  });
  it('старый путь: created с ссылкой на оплату — «Не оплачен»', () => {
    expect(orderBadge(o('created', { payment: { status: 'waiting', url: 'https://pay' } })).label).toBe('ol_unpaid');
  });
  it('побочные статусы: вернули, ждёт подтверждения, отклонён', () => {
    expect(orderBadge(o('returned'))).toEqual({ label: 'os_returned', tone: 'amber' });
    expect(orderBadge(o('awaiting_approval'))).toEqual({ label: 'os_awaiting_approval', tone: 'amber' });
    expect(orderBadge(o('rejected'))).toEqual({ label: 'os_rejected', tone: 'red' });
    expect(orderNote(o('returned'))?.key).toBe('ol_returned');
    expect(orderNote(o('awaiting_approval'))?.key).toBe('ol_awaiting');
    expect(orderNote(o('rejected'))?.key).toBe('ol_rejected');
    expect(needsMaster(o('returned'))).toBe(true);
    expect(needsMaster(o('awaiting_approval'))).toBe(true);
    expect(isActiveOrder(o('rejected'))).toBe(false);
    expect(isActiveOrder(o('returned'))).toBe(true);
  });
  it('срок: due_date конструктора важнее ready_date', () => {
    expect(orderNote(o('cutting', { ready_date: '2026-11-05', due_date: '2026-11-07' }))).toEqual({ key: 'ol_ready_by', date: '2026-11-07' });
    expect(orderNote(o('cutting', { ready_date: '2026-11-05' }))).toEqual({ key: 'ol_ready_by', date: '2026-11-05' });
  });
  it('прогресс: побочные — как «создан», отклонён — 0', () => {
    expect(orderProgress(o('created'))).toBeCloseTo(1 / 6);
    expect(orderProgress(o('returned'))).toBeCloseTo(1 / 6);
    expect(orderProgress(o('awaiting_approval'))).toBeCloseTo(1 / 6);
    expect(orderProgress(o('accepted'))).toBeCloseTo(2 / 6);
    expect(orderProgress(o('rejected'))).toBe(0);
    expect(orderProgress(o('issued'))).toBe(1);
  });
  it('шаги карточки: побочные статусы строятся в приложении, порядок created → accepted → paid', () => {
    const r = orderSteps(o('returned'));
    expect(r.map((s) => s.status)).toEqual(['created', 'accepted', 'paid', 'cutting', 'ready', 'issued']);
    expect(r[0]).toMatchObject({ current: true, done: false });
    const a = orderSteps(o('awaiting_approval'));
    expect(a[0].done).toBe(true);
    expect(a[1]).toMatchObject({ status: 'accepted', current: true, done: false });
    const server = [{ status: 'created' as const, label: 'Создан', done: true, current: true, at: null }];
    expect(orderSteps(o('created', { steps: server }))).toBe(server);
  });
  it('действия мастера: оплата, повторная отправка, рекламация', () => {
    expect(canPay(o('returned', { payment: { status: 'waiting', url: 'https://pay' } }))).toBe(false);
    expect(canPay(o('accepted', { payment: { status: 'waiting', url: 'https://pay' } }))).toBe(true);
    expect(canResubmit(o('returned'))).toBe(true);
    expect(canResubmit(o('created'))).toBe(false);
    expect(canReport(o('cutting'))).toBe(true);
    expect(canReport(o('accepted', { payment: { status: 'paid' } }))).toBe(true);
    expect(canReport(o('accepted', { payment: { status: 'waiting' } }))).toBe(false);
    expect(canReport(o('created'))).toBe(false);
  });
  it('споры: один по отклонению, один на рекламацию, только после решения', () => {
    const d = (subject: OrderDispute['subject'], return_id: string | null = null) => ({ subject, return_id }) as OrderDispute;
    expect(canDisputeRejection(o('rejected'), [])).toBe(true);
    expect(canDisputeRejection(o('rejected'), [d('rejection')])).toBe(false);
    expect(canDisputeRejection(o('returned'), [])).toBe(false);
    expect(canDisputeReturn({ id: 'r1', decision: 'declined', status: 'resolved' }, [])).toBe(true);
    expect(canDisputeReturn({ id: 'r1', decision: null, status: 'open' }, [])).toBe(false);
    expect(canDisputeReturn({ id: 'r1', decision: 'refund', status: 'awaiting_owner' }, [])).toBe(false);
    expect(canDisputeReturn({ id: 'r1', decision: 'declined', status: 'resolved' }, [d('return', 'r1')])).toBe(false);
    expect(canDisputeReturn({ id: 'r2', decision: 'declined', status: 'resolved' }, [d('return', 'r1')])).toBe(true);
  });
  it('непрочитанные по всем заказам', () => {
    expect(unreadTotal([{ unread_count: 2 }, {}, { unread_count: 1 }])).toBe(3);
  });
});

describe('исправление поставщика: было → стало', () => {
  it('изменённые, новые и убранные строки по ключу', () => {
    const d = diffLines(
      [{ key: 'a', name: 'ЛДСП', unit: 'лист', qty: 4, price: 10, total: 40 }, { key: 'b', name: 'Петля', unit: 'шт', qty: 8, price: 2, total: 16 }, { key: 'c', name: 'Кромка', qty: 10, total: 5 }],
      [{ key: 'a', name: 'ЛДСП', unit: 'лист', qty: 5, price: 10, total: 50 }, { key: 'c', name: 'Кромка', qty: 10, total: 5 }, { key: 'd', name: 'Петля Blum', unit: 'шт', qty: 8, price: 4, total: 32 }],
    );
    expect(d.map((x) => [x.key, x.kind])).toEqual([['a', 'changed'], ['c', 'same'], ['d', 'added'], ['b', 'removed']]);
    expect(d[0].before?.qty).toBe(4);
    expect(d[0].after?.qty).toBe(5);
  });
  it('без ключа — по названию; сумма без total — из qty × price', () => {
    const d = diffLines([{ name: 'Фасад', qty: 1, price: 100 }], [{ name: 'Фасад', qty: 1, price: 100, total: 100 }]);
    expect(d[0].kind).toBe('same');
  });
});

describe('вложения и push', () => {
  it('ссылка вложения: абсолютная как есть, путь — от API', () => {
    expect(attachmentUrl('https://cdn/x.jpg', 'http://api')).toBe('https://cdn/x.jpg');
    expect(attachmentUrl('file:///tmp/a.jpg', 'http://api')).toBe('file:///tmp/a.jpg');
    expect(attachmentUrl('/files/k1', 'http://api/')).toBe('http://api/files/k1');
    expect(attachmentUrl(null, 'http://api')).toBeNull();
  });
  it('push по заказу: сообщение → переписка, рекламация → рекламации, остальное → карточка', () => {
    expect(routeForPush({ kind: 'order_message', order_id: 'o1' })).toBe('/order/chat/o1');
    expect(routeForPush({ kind: 'order_status', order_id: 'o1', status: 'returned' })).toBe('/order/o1');
    expect(routeForPush({ kind: 'order_status', order_id: 'o1', status: 'accepted' })).toBe('/order/o1');
    expect(routeForPush({ kind: 'order_correction', order_id: 'o1' })).toBe('/order/o1');
    expect(routeForPush({ kind: 'return_decided', order_id: 'o1', return_id: 'r1' })).toBe('/order/returns/o1');
    expect(routeForPush({ kind: 'dispute_resolved', order_id: 'o1', return_id: 'r1' })).toBe('/order/returns/o1');
    expect(routeForPush({ kind: 'dispute_resolved', order_id: 'o1' })).toBe('/order/o1');
    expect(routeForPush({ kind: 'anything', order_id: 'o1', screen: 'order_chat' })).toBe('/order/chat/o1');
    expect(routeForPush({ kind: 'order_message', order_id: 'o1', screen: 'order' })).toBe('/order/o1');
  });
  it('шина push: подписка по заказу, активная переписка', () => {
    const got: string[] = [];
    const off = orderEvents.subscribe((id, kind) => got.push(`${id}:${kind}`));
    orderEvents.emit('o1', 'order_message');
    off();
    orderEvents.emit('o2', null);
    expect(got).toEqual(['o1:order_message']);
    orderEvents.setActiveChat('o1');
    expect(orderEvents.activeChat()).toBe('o1');
    orderEvents.setActiveChat(null);
  });
});

describe('мок: заказ у поставщика', () => {
  const fast = () => createMockApi({ latencyMs: 0, designMs: 60_000 });

  it('демо-заказы во всех новых статусах; поставщик, конструктор, история', async () => {
    const api = fast();
    const list = await api.listOrders();
    const by = (n: string) => list.find((x) => x.number === n)!;
    expect(by('1236').status).toBe('returned');
    expect(by('1238').status).toBe('awaiting_approval');
    expect(by('1231').status).toBe('rejected');
    expect(by('1242')).toMatchObject({ status: 'accepted', invoice_total: 4_420_000, payment: { status: 'waiting' } });
    expect(by('1234').unread_count).toBe(1);
    const card = await api.getOrder('o-1');
    expect(card.supplier_name).toBe('EMAN');
    expect(card.assignee?.name).toContain('конструктор');
    expect(card.events?.map((e) => e.status)).toEqual(['created', 'accepted', 'paid', 'cutting']);
  });

  it('вернули на правку → отправить заново; повторно — 409', async () => {
    const api = fast();
    const r = await api.resubmitOrder('o-3');
    expect(r.status).toBe('created');
    expect(r.vendor_status_note).toBeNull();
    expect(r.events?.some((e) => e.type === 'resubmitted')).toBe(true);
    await expect(api.resubmitOrder('o-3')).rejects.toMatchObject({ status: 409, code: 'illegal_transition' });
  });

  it('исправление: подтвердить → принят с новой суммой; повторное решение — 409', async () => {
    const api = fast();
    const [c] = await api.listOrderCorrections('o-4');
    expect(c.status).toBe('pending');
    expect(c.total_after! - c.total_before!).toBe(746_000);
    const o = await api.approveOrderCorrection('o-4', c.id);
    expect(o).toMatchObject({ status: 'accepted', total: 5_126_000, invoice_total: 5_126_000 });
    expect(o.items.some((i) => i.name.includes('Blum'))).toBe(true);
    expect(canPay(o)).toBe(true);
    await expect(api.declineOrderCorrection('o-4', c.id)).rejects.toMatchObject({ code: 'correction_decided' });
  });

  it('исправление: отклонить с комментарием → снова у конструктора, комментарий в переписке', async () => {
    const api = fast();
    const [c] = await api.listOrderCorrections('o-4');
    const o = await api.declineOrderCorrection('o-4', c.id, 'Blum дорого, ищите аналог');
    expect(o.status).toBe('created');
    expect((await api.listOrderCorrections('o-4'))[0]).toMatchObject({ status: 'declined', master_comment: 'Blum дорого, ищите аналог' });
    expect((await api.listOrderMessages('o-4')).pop()?.text).toBe('Blum дорого, ищите аналог');
  });

  it('переписка: отправка текста и фото, пустое — 422, прочитано обнуляет счётчик', async () => {
    const api = fast();
    await expect(api.sendOrderMessage('o-1', { text: '  ' })).rejects.toMatchObject({ status: 422 });
    const m = await api.sendOrderMessage('o-1', { text: 'Когда привезут?', files: [{ uri: 'file:///a.jpg', name: 'chat_1.jpg', type: 'image/jpeg' }] });
    expect(m).toMatchObject({ author_type: 'master', text: 'Когда привезут?' });
    expect(m.attachments[0]).toMatchObject({ url: 'file:///a.jpg', content_type: 'image/jpeg' });
    expect((await api.getOrder('o-1')).unread_count).toBe(1);
    await api.markOrderMessagesRead('o-1');
    expect((await api.getOrder('o-1')).unread_count).toBe(0);
    const msgs = await api.listOrderMessages('o-1');
    expect(msgs.map((x) => x.author_type)).toContain('platform');
    await expect(api.listOrderMessages('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('рекламация: только по оплаченному, нужен тип и описание; список — новые сверху', async () => {
    const api = fast();
    await expect(api.createOrderReturn('o-6', { type: 'defect', description: 'Скол' })).rejects.toMatchObject({ code: 'order_not_paid' });
    await expect(api.createOrderReturn('o-1', { type: 'defect', description: ' ' })).rejects.toMatchObject({ status: 422 });
    const r = await api.createOrderReturn('o-1', {
      type: 'cut_error', description: 'Боковина короче на 5 мм', lines: [{ key: 'sheet:x', name: 'Боковина', qty: 1 }],
      files: [{ uri: 'file:///b.jpg', name: 'return_1.jpg', type: 'image/jpeg' }],
    });
    expect(r).toMatchObject({ status: 'open', decision: null, type: 'cut_error', lines: [{ name: 'Боковина' }] });
    expect(r.photos).toHaveLength(1);
    const list = await api.listOrderReturns('o-1');
    expect(list[0].id).toBe(r.id);
    expect((await api.getOrder('o-1')).returns_count).toBe(3);
  });

  it('спор: по решённой рекламации и по отклонению; второй — 409; без решения — 409', async () => {
    const api = fast();
    const returns = await api.listOrderReturns('o-1');
    const redo = returns.find((x) => x.decision === 'redo')!;
    const d = await api.openOrderDispute('o-1', { subject: 'return', return_id: redo.id, reason: 'decision_unfair', comment: 'Петли так и не привезли' });
    expect(d).toMatchObject({ status: 'open', subject: 'return', return_id: redo.id });
    await expect(api.openOrderDispute('o-1', { subject: 'return', return_id: redo.id, reason: 'other', comment: 'ещё' })).rejects.toMatchObject({ code: 'dispute_exists' });
    const fresh = await api.createOrderReturn('o-1', { type: 'other', description: 'Не тот цвет кромки' });
    await expect(api.openOrderDispute('o-1', { subject: 'return', return_id: fresh.id, reason: 'other', comment: 'x' })).rejects.toMatchObject({ code: 'return_not_decided' });
    await expect(api.openOrderDispute('o-5', { subject: 'rejection', reason: 'can_be_done', comment: '' })).rejects.toMatchObject({ status: 422 });
    const rej = await api.openOrderDispute('o-5', { subject: 'rejection', reason: 'can_be_done', comment: 'Есть аналог U999 у другого бренда' });
    expect(rej.status).toBe('open');
    await expect(api.openOrderDispute('o-3', { subject: 'rejection', reason: 'other', comment: 'x' })).rejects.toMatchObject({ code: 'illegal_transition' });
    expect((await api.listOrderDisputes('o-5'))).toHaveLength(1);
  });

  it('отмена: до оплаты можно и после возврата на правку', async () => {
    const api = fast();
    expect((await api.cancelOrder('o-3')).status).toBe('cancelled');
    expect((await api.cancelOrder('o-6')).status).toBe('cancelled');
    await expect(api.cancelOrder('o-1')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('HTTP: ручки мастера по контракту §5.6', () => {
  type Call = { url: string; init: RequestInit };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const tokens: TokenStore = { get: async () => ({ access: 'A', refresh: 'R' }), set: async () => undefined };
  const setup = (bodies: unknown[]) => {
    const calls: Call[] = [];
    let i = 0;
    const fetch = async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return json(200, bodies[Math.min(i++, bodies.length - 1)]); };
    return { api: createHttpApi(new Http({ baseUrl: 'http://api', tokens, fetch })), calls };
  };

  it('пути, методы и тела', async () => {
    const { api, calls } = setup([{ id: 'o1', status: 'created' }, { items: [{ id: 'm1' }] }, [{ id: 'm2' }], {}, [{ id: 'c1' }], { id: 'o1' }, { id: 'o1' }, { items: [] }, []]);
    await api.resubmitOrder('o1');
    expect(await api.listOrderMessages('o1')).toEqual([{ id: 'm1' }]);
    expect(await api.listOrderMessages('o1')).toEqual([{ id: 'm2' }]);
    await api.markOrderMessagesRead('o1');
    await api.listOrderCorrections('o1');
    await api.approveOrderCorrection('o1', 'c1');
    await api.declineOrderCorrection('o1', 'c1', 'дорого');
    expect(await api.listOrderReturns('o1')).toEqual([]);
    await api.listOrderDisputes('o1');
    expect(calls.map((c) => [c.init.method, c.url, c.init.body ?? null])).toEqual([
      ['POST', 'http://api/orders/o1/resubmit', '{}'],
      ['GET', 'http://api/orders/o1/messages', null],
      ['GET', 'http://api/orders/o1/messages', null],
      ['POST', 'http://api/orders/o1/messages/read', '{}'],
      ['GET', 'http://api/orders/o1/corrections', null],
      ['POST', 'http://api/orders/o1/corrections/c1/approve', '{}'],
      ['POST', 'http://api/orders/o1/corrections/c1/decline', '{"comment":"дорого"}'],
      ['GET', 'http://api/orders/o1/returns', null],
      ['GET', 'http://api/orders/o1/disputes', null],
    ]);
  });

  it('сообщение, рекламация и спор — multipart', async () => {
    const { api, calls } = setup([{ id: 'm1' }, { id: 'r1' }, { id: 'd1' }]);
    await api.sendOrderMessage('o1', { text: 'Привет' });
    await api.createOrderReturn('o1', { type: 'defect', description: 'Скол', lines: [{ name: 'Фасад', qty: 1 }] });
    await api.openOrderDispute('o1', { subject: 'return', return_id: 'r1', reason: 'decision_unfair', comment: 'Не согласен' });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', 'http://api/orders/o1/messages'], ['POST', 'http://api/orders/o1/returns'], ['POST', 'http://api/orders/o1/disputes'],
    ]);
    const forms = calls.map((c) => c.init.body as FormData);
    expect(forms.every((f) => f instanceof FormData)).toBe(true);
    expect(forms[0].get('text')).toBe('Привет');
    expect(forms[1].get('type')).toBe('defect');
    expect(JSON.parse(String(forms[1].get('lines')))).toEqual([{ name: 'Фасад', qty: 1 }]);
    expect([forms[2].get('subject'), forms[2].get('return_id'), forms[2].get('reason'), forms[2].get('comment')]).toEqual(['return', 'r1', 'decision_unfair', 'Не согласен']);
    // multipart: Content-Type ставит fetch (с boundary), не мы
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});
