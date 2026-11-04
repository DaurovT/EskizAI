/** @jest-environment node */
/**
 * Заказ мастера против НАСТОЯЩЕГО API (docs/staff_vendor_contract.md §5.3, §5.5, §5.6, §8, §9).
 * Включается только с INTEGRATION_API_URL, иначе пропускается:
 *
 *   cd api && DATABASE_URL=sqlite:////tmp/int.db ENV=dev AUTH_CODE_PROVIDER=dev .venv/bin/alembic upgrade head
 *   .venv/bin/python scripts/import_eman_decors.py --database-url sqlite:////tmp/int.db
 *   DATABASE_URL=sqlite:////tmp/int.db ENV=dev AUTH_CODE_PROVIDER=dev .venv/bin/uvicorn mebel_api.main:app --port 8011
 *   cd app && INTEGRATION_API_URL=http://127.0.0.1:8011 npx jest orders.integration
 *
 * Мастер ходит через настоящие функции приложения (createHttpApi), поставщик и суперадмин — сырыми запросами
 * (/vendor/*, /admin/* — в приложении их нет). Нужен ENV=dev: код входа 00000, X-Admin-Token = dev-admin-token.
 */
import { readFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { resolve } from 'path';

import type { Api } from '../client';
import { ApiError } from '../errors';
import { Http, type TokenStore } from '../http';
import { createHttpApi } from '../httpApi';
import type * as T from '../types';
import { attachmentUrl, canDisputeRejection, canDisputeReturn, canReport, canResubmit } from '../../lib/orders';
import { routeForPush } from '../../lib/pushRoute';

// 1×1 PNG: в приложении фото — File из expo-file-system (это Blob); здесь — Blob с теми же байтами.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
jest.mock('expo-file-system', () => ({
  File: class {
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bytes = require('buffer').Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      return new Blob([bytes], { type: 'image/png' });
    }
  },
}));

/**
 * Глобальный fetch в jest-expo — заглушка expo/fetch (без сети). Настоящий запрос — через node:http;
 * тело (JSON или FormData с boundary) сериализует Request из undici, как это сделал бы fetch.
 */
async function nodeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(url, init);
  const body = init.body == null ? null : Buffer.from(await req.arrayBuffer());
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  if (body) headers['content-length'] = String(body.length);
  return new Promise((ok, fail) => {
    const r = httpRequest(url, { method: req.method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
        const status = res.statusCode ?? 0;
        ok(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: h }));
      });
    });
    r.on('error', fail);
    if (body) r.write(body);
    r.end();
  });
}

const BASE = process.env.INTEGRATION_API_URL?.replace(/\/$/, '');
const ADMIN_TOKEN = process.env.INTEGRATION_ADMIN_TOKEN ?? 'dev-admin-token';
const DEV_CODE = process.env.INTEGRATION_DEV_CODE ?? '00000';
const suite = BASE ? describe : describe.skip;
const TREE = JSON.parse(readFileSync(resolve(__dirname, '../../../../core/tests/fixtures/wardrobe_2sec.json'), 'utf8'));
const photo = (n: string) => ({ uri: `file:///tmp/${n}.png`, name: `${n}.png`, type: 'image/png' });

// --- проверка формы ответа по §9 (типы TS во время выполнения не проверяются) ---
type Kind = 'string' | 'number' | 'boolean' | 'array' | 'object';
type Spec = Record<string, Kind | `${Kind}?`>;
function shape(what: string, obj: unknown, spec: Spec) {
  const o = obj as Record<string, unknown>;
  const errors: string[] = [];
  for (const [k, kind] of Object.entries(spec)) {
    const optional = kind.endsWith('?');
    const base = kind.replace('?', '') as Kind;
    if (!(k in o)) { if (!optional) errors.push(`${k}: нет поля`); continue; }
    const v = o[k];
    if (v === null || v === undefined) { if (!optional) errors.push(`${k}: null`); continue; }
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== base) errors.push(`${k}: ${actual}, ждали ${base}`);
  }
  if (errors.length) throw new Error(`${what}: ${errors.join('; ')}\n${JSON.stringify(obj, null, 1).slice(0, 1500)}`);
}
const ATTACHMENT: Spec = { key: 'string', url: 'string', name: 'string?', content_type: 'string?', size: 'number?' };
const EVENT: Spec = { id: 'string', type: 'string', status: 'string?', actor_type: 'string', actor_name: 'string?', comment: 'string?', data: 'object?', created_at: 'string' };
const ORDER: Spec = {
  id: 'string', number: 'string', project_id: 'string', project_title: 'string?', status: 'string', status_label: 'string?',
  total: 'number?', ready_date: 'string?', created_at: 'string', payment: 'object', items: 'array', documents: 'array',
  steps: 'array?', cancellable: 'boolean?',
  supplier_id: 'string?', supplier_name: 'string?', group_id: 'string?', invoice_total: 'number?', due_date: 'string?',
  assignee: 'object?', vendor_status_note: 'string?', reject_reason: 'string?', unread_count: 'number',
  returns_count: 'number', disputes_count: 'number', events: 'array',
};
const MESSAGE: Spec = {
  id: 'string', order_id: 'string', author_type: 'string', author_id: 'string?', author_name: 'string?', text: 'string?',
  attachments: 'array', created_at: 'string', read_by_master_at: 'string?', read_by_vendor_at: 'string?',
};
const LINE: Spec = { key: 'string?', name: 'string', unit: 'string?', qty: 'number', price: 'number?', total: 'number?' };
const CORRECTION: Spec = {
  id: 'string', order_id: 'string', author_name: 'string?', comment: 'string?', lines_before: 'array', lines_after: 'array',
  total_before: 'number', total_after: 'number', files: 'array', status: 'string', master_comment: 'string?',
  decided_at: 'string?', created_at: 'string',
};
const RETURN: Spec = {
  id: 'string', order_id: 'string', number: 'number?', type: 'string', description: 'string?', lines: 'array',
  amount: 'number?', photos: 'array', status: 'string', decision: 'string?', decision_comment: 'string?',
  refund_amount: 'number?', created_by: 'string?', created_at: 'string', decided_at: 'string?',
};
const DISPUTE: Spec = {
  id: 'string', order_id: 'string', subject: 'string', return_id: 'string?', reason: 'string', comment: 'string?',
  photos: 'array', status: 'string', decision: 'string?', decision_comment: 'string?', amount: 'number?',
  created_at: 'string', resolved_at: 'string?',
};
const checkOrder = (o: T.OrderOut) => {
  shape('OrderOut', o, ORDER);
  (o.events ?? []).forEach((e) => shape('OrderEvent', e, EVENT));
  expect((o.events ?? []).every((e) => ['master', 'vendor', 'platform', 'system'].includes(e.actor_type ?? ''))).toBe(true);
  const types = ['status_changed', 'correction_created', 'correction_approved', 'correction_declined', 'resubmitted',
    'return_opened', 'return_decided', 'dispute_opened', 'dispute_resolved'];
  expect((o.events ?? []).filter((e) => !types.includes(e.type))).toEqual([]);
  if (o.assignee) shape('OrderOut.assignee', o.assignee, { id: 'string', name: 'string' });
  return o;
};
const checkAttachments = (list: T.OrderAttachment[]) => list.forEach((a) => shape('Attachment', a, ATTACHMENT));

// --- сырые запросы поставщика и платформы ---
type Raw = { token?: string; admin?: boolean; json?: unknown; form?: FormData };
async function raw<R = any>(method: string, path: string, o: Raw = {}): Promise<R> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.admin) headers['X-Admin-Token'] = ADMIN_TOKEN;
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
  const res = await nodeFetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as R;
}

async function staffLogin(email: string, password: string): Promise<string> {
  let r = await raw('POST', '/staff/auth/login', { json: { email, password } });
  if (r.staff?.password_change_required || r.staff?.must_change_password) {
    await raw('POST', '/staff/me/password', { token: r.access_token, json: { current_password: password, new_password: 'integration-pass-1234' } });
    r = await raw('POST', '/staff/auth/login', { json: { email, password: 'integration-pass-1234' } });
  }
  return r.access_token as string;
}

async function expectApiError(p: Promise<unknown>, status: number, code: string) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect({ status: (e as ApiError).status, code: (e as ApiError).code }).toEqual({ status, code });
}

suite('настоящий API: заказ мастера от создания до спора', () => {
  jest.setTimeout(60_000);
  let store: { access: string; refresh: string } | null = null;
  const tokens: TokenStore = { get: async () => store, set: async (t) => { store = t; } };
  const api: Api = createHttpApi(new Http({ baseUrl: BASE ?? 'http://none', tokens, fetch: nodeFetch }));
  const run = Date.now().toString(36);
  let designer = '';
  let owner = '';
  let projectId = '';
  let order: T.OrderOut;

  const project = async (title: string) => {
    const p = await api.createProject({ title } as T.ProjectIn);
    await api.saveModel(p.id, { tree: TREE } as T.ModelIn);
    await api.toSketch(p.id);
    await api.createShareLink(p.id, { language: 'ru', show_price: true });
    await api.addMeasurement(p.id, { width: 1200 });
    await api.toContract(p.id);
    return p.id;
  };

  it('мастер входит (dev-код), проект доходит до «Договора», заказ оформлен', async () => {
    const phone = `+99890${String(Date.now()).slice(-7)}`;
    await api.requestCode(phone, 'sms');
    const t = await api.verifyCode({ phone, code: DEV_CODE } as T.VerifyCodeIn);
    store = { access: t.access_token, refresh: t.refresh_token };
    projectId = await project(`Интеграция ${run}`);
    const preview = await api.orderPreview(projectId);
    expect(preview.lines.length).toBeGreaterThan(0);
    order = checkOrder(await api.createOrder(projectId));
    expect(order).toMatchObject({ status: 'created', supplier_name: expect.any(String), unread_count: 0, assignee: null });
    expect(order.events?.[0]).toMatchObject({ type: 'status_changed', status: 'created', actor_type: 'master' });
    expect((await api.listOrders()).some((x) => x.id === order.id)).toBe(true);
  });

  it('поставщик: сотрудники через суперадмина, конструктор берёт заказ', async () => {
    const sup = await raw('GET', '/admin/suppliers', { admin: true });
    const eman = (Array.isArray(sup) ? sup : sup.items).find((s: { code: string }) => s.code === 'eman');
    expect(eman).toBeTruthy();
    const mk = async (role: string, email: string) => {
      const r = await raw('POST', '/staff/users', { admin: true, json: { email, name: `${role} ${run}`, role, supplier_id: eman.id } });
      return staffLogin(email, r.temp_password);
    };
    designer = await mk('vendor_designer', `designer-${run}@int.test`);
    owner = await mk('vendor_owner', `owner-${run}@int.test`);
    const queue = await raw('GET', '/vendor/orders?scope=queue', { token: designer });
    expect(queue.items.some((x: { id: string }) => x.id === order.id)).toBe(true);
    await raw('POST', `/vendor/orders/${order.id}/take`, { token: designer });
    order = checkOrder(await api.getOrder(order.id));
    expect(order.assignee?.name).toBe(`vendor_designer ${run}`);
  });

  it('переписка в обе стороны с фото; подписанная ссылка открывается без токена', async () => {
    const m = await api.sendOrderMessage(order.id, { text: 'Здравствуйте, фото стены', files: [photo('chat_1')] });
    shape('OrderMessage', m, MESSAGE);
    expect(m).toMatchObject({ author_type: 'master', text: 'Здравствуйте, фото стены' });
    expect(m.attachments).toHaveLength(1);
    checkAttachments(m.attachments);
    expect(m.attachments[0]).toMatchObject({ name: 'chat_1.png', content_type: 'image/png', size: PNG.length });
    const url = attachmentUrl(m.attachments[0].url, BASE!)!;
    const file = await nodeFetch(url); // без Authorization
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await nodeFetch(url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).status).toBe(404); // подделка

    const vend = await raw('GET', `/vendor/orders/${order.id}/messages`, { token: designer });
    expect(vend.unread_count).toBe(1);
    const form = new FormData();
    form.append('text', 'Получили, посмотрим');
    form.append('files', new Blob([PNG], { type: 'image/png' }), 'vendor.png');
    await raw('POST', `/vendor/orders/${order.id}/messages`, { token: designer, form });
    expect((await api.getOrder(order.id)).unread_count).toBe(1);
    const list = await api.listOrderMessages(order.id);
    list.forEach((x) => shape('OrderMessage', x, MESSAGE));
    expect(list.map((x) => x.author_type)).toEqual(['master', 'vendor']);
    expect(list[1].author_name).toBe(`vendor_designer ${run}`);
    expect((await nodeFetch(attachmentUrl(list[1].attachments[0].url, BASE!)!)).status).toBe(200);
    await api.markOrderMessagesRead(order.id);
    expect((await api.getOrder(order.id)).unread_count).toBe(0);
    await expectApiError(api.sendOrderMessage(order.id, { text: '   ' }), 422, 'empty_message');
  });

  const correct = async (qtyDelta: number, comment: string) => {
    const lines = (order.items ?? []).filter((i) => !i.excluded).map((i, n) => ({
      key: i.key, name: i.name, unit: i.unit, qty: n === 0 ? (i.qty ?? 0) + qtyDelta : i.qty, price: i.price,
    }));
    const form = new FormData();
    form.append('lines_after', JSON.stringify(lines));
    form.append('comment', comment);
    form.append('files', new Blob([PNG], { type: 'image/png' }), 'cut.png');
    return raw('POST', `/vendor/orders/${order.id}/corrections`, { token: designer, form });
  };

  it('исправление поставщика: мастер отклоняет, потом подтверждает', async () => {
    const c1 = await correct(1, 'Не хватит листа — добавили');
    order = checkOrder(await api.getOrder(order.id));
    expect(order.status).toBe('awaiting_approval');
    expect(order.pending_correction_id).toBe(c1.id);
    const list = await api.listOrderCorrections(order.id);
    list.forEach((c) => {
      shape('OrderCorrection', c, CORRECTION);
      c.lines_after.forEach((l) => shape('OrderCorrection.lines_after', l, LINE));
      checkAttachments(c.files);
    });
    expect(list[0]).toMatchObject({ id: c1.id, status: 'pending', author_name: `vendor_designer ${run}` });
    order = checkOrder(await api.declineOrderCorrection(order.id, c1.id, 'Лист есть у меня'));
    expect(order.status).toBe('created');
    expect(order.events?.some((e) => e.type === 'correction_declined')).toBe(true);
    expect((await api.listOrderCorrections(order.id))[0]).toMatchObject({ status: 'declined', master_comment: 'Лист есть у меня' });
    await expectApiError(api.approveOrderCorrection(order.id, c1.id), 409, 'correction_decided');

    const c2 = await correct(2, 'Всё же добавили два листа');
    order = checkOrder(await api.approveOrderCorrection(order.id, c2.id));
    expect(order.status).toBe('accepted');
    expect(order.invoice_total).toBe(c2.total_after);
    expect(order.events?.some((e) => e.type === 'correction_approved')).toBe(true);
  });

  it('вернули мастеру → мастер правит модель → отправляет заново (берётся новая версия)', async () => {
    await raw('POST', `/vendor/orders/${order.id}/return`, { token: designer, json: { comment: 'Проверьте глубину шкафа' } });
    order = checkOrder(await api.getOrder(order.id));
    expect(order).toMatchObject({ status: 'returned', vendor_status_note: 'Проверьте глубину шкафа' });
    expect(canResubmit(order)).toBe(true);
    expect((await api.listOrderMessages(order.id)).pop()?.text).toContain('Проверьте глубину шкафа');
    const before = order.version_id;
    await api.saveModel(projectId, { tree: { ...TREE, depth: 550 } } as T.ModelIn);
    order = checkOrder(await api.resubmitOrder(order.id));
    expect(order.status).toBe('created');
    expect(order.events?.some((e) => e.type === 'resubmitted')).toBe(true);
    expect(order.version_id).not.toBe(before);
    await expectApiError(api.resubmitOrder(order.id), 409, 'illegal_transition');
  });

  it('принят со счётом и сроком → оплачен → раскрой → готов → выдан', async () => {
    await raw('POST', `/vendor/orders/${order.id}/accept`, {
      token: designer, json: { invoice_total: 1_234_000, due_date: '2026-12-01T18:00:00+05:00', payment_url: 'https://pay.example/1', comment: 'Счёт выставлен' },
    });
    order = checkOrder(await api.getOrder(order.id));
    expect(order).toMatchObject({ status: 'accepted', invoice_total: 1_234_000, total: 1_234_000, payment: { status: 'waiting', url: 'https://pay.example/1' } });
    expect(order.due_date).toMatch(/^2026-12-01/);
    expect(canReport(order)).toBe(false);
    await expectApiError(api.createOrderReturn(order.id, { type: 'defect', description: 'Ещё не оплачен' }), 409, 'order_not_paid');
    for (const status of ['paid', 'cutting', 'ready', 'issued'] as const) {
      await raw('POST', `/vendor/orders/${order.id}/status`, { token: designer, json: { status } });
      order = checkOrder(await api.getOrder(order.id));
      expect(order.status).toBe(status);
    }
    expect(order.payment).toMatchObject({ status: 'paid' });
    expect(order.steps?.map((s) => s.status)).toEqual(['created', 'accepted', 'paid', 'cutting', 'ready', 'issued']);
    expect(order.steps?.every((s) => s.done)).toBe(true);
    expect(canReport(order)).toBe(true);
  });

  let returnId = '';
  it('рекламация мастера с фото → конструктор: вернуть деньги → владелец подтверждает', async () => {
    const r = await api.createOrderReturn(order.id, {
      type: 'defect', description: 'Скол на фасаде', lines: [{ key: order.items[0].key, name: order.items[0].name, qty: 1 }],
      files: [photo('return_1'), photo('return_2')],
    });
    shape('OrderReturn', r, RETURN);
    checkAttachments(r.photos);
    expect(r).toMatchObject({ status: 'open', decision: null, type: 'defect', created_by: 'master', number: 1 });
    expect(r.photos).toHaveLength(2);
    expect((await nodeFetch(attachmentUrl(r.photos[0].url, BASE!)!)).status).toBe(200);
    returnId = r.id;
    await expectApiError(api.openOrderDispute(order.id, { subject: 'return', return_id: r.id, reason: 'other', comment: 'рано' }), 409, 'return_not_decided');

    await raw('PATCH', `/vendor/returns/${r.id}`, { token: designer, json: { decision: 'refund', comment: 'Вернём за фасад', refund_amount: 200_000 } });
    let [mine] = await api.listOrderReturns(order.id);
    expect(mine).toMatchObject({ status: 'awaiting_owner', decision: 'refund', refund_amount: 200_000 });
    expect(canDisputeReturn(mine, [])).toBe(false);
    await raw('POST', `/vendor/returns/${r.id}/approve-refund`, { token: owner, json: {} });
    [mine] = await api.listOrderReturns(order.id);
    shape('OrderReturn', mine, RETURN);
    expect(mine).toMatchObject({ status: 'resolved', decision: 'refund', refund_amount: 200_000, decision_comment: 'Вернём за фасад' });
    order = checkOrder(await api.getOrder(order.id));
    expect(order.returns_count).toBe(1);
    expect(order.events?.filter((e) => e.type === 'return_decided')).toHaveLength(2);
  });

  it('спор по рекламации → суперадмин решает частично', async () => {
    const disputes0 = await api.listOrderDisputes(order.id);
    const [ret] = await api.listOrderReturns(order.id);
    expect(canDisputeReturn(ret, disputes0)).toBe(true);
    const d = await api.openOrderDispute(order.id, {
      subject: 'return', return_id: returnId, reason: 'amount_wrong', comment: 'Фасад стоит дороже', files: [photo('dispute_1')],
    });
    shape('OrderDispute', d, DISPUTE);
    checkAttachments(d.photos);
    expect(d).toMatchObject({ status: 'open', subject: 'return', return_id: returnId, decision: null });
    await expectApiError(api.openOrderDispute(order.id, { subject: 'return', return_id: returnId, reason: 'other', comment: 'ещё' }), 409, 'dispute_exists');
    await raw('POST', `/admin/disputes/${d.id}/resolve`, { admin: true, json: { resolution: 'partial', refund_amount: 300_000, comment: 'Доплатить 300 000', reason: 'проверили фото' } });
    const [solved] = await api.listOrderDisputes(order.id);
    shape('OrderDispute', solved, DISPUTE);
    expect(solved).toMatchObject({ status: 'resolved', decision: 'partial', decision_comment: 'Доплатить 300 000', amount: 300_000 });
    order = checkOrder(await api.getOrder(order.id));
    expect(order.disputes_count).toBe(1);
    expect(order.events?.map((e) => e.type)).toEqual(expect.arrayContaining(['dispute_opened', 'dispute_resolved']));
  });

  it('отклонение → спор по отклонению → решение в пользу поставщика', async () => {
    const pid = await project(`Интеграция отклонение ${run}`);
    const o = await api.createOrder(pid);
    await raw('POST', `/vendor/orders/${o.id}/reject`, { token: designer, json: { reason: 'no_material', comment: 'Декора нет до весны' } });
    const card = checkOrder(await api.getOrder(o.id));
    expect(card).toMatchObject({ status: 'rejected', reject_reason: 'no_material', vendor_status_note: 'Декора нет до весны', cancellable: false });
    expect(canDisputeRejection(card, await api.listOrderDisputes(o.id))).toBe(true);
    await expectApiError(api.openOrderDispute(o.id, { subject: 'rejection', reason: 'bogus' as T.DisputeReason, comment: 'x' }), 422, 'validation_error');
    const d = await api.openOrderDispute(o.id, { subject: 'rejection', reason: 'can_be_done', comment: 'Есть аналог' });
    shape('OrderDispute', d, DISPUTE);
    await expectApiError(api.openOrderDispute(o.id, { subject: 'rejection', reason: 'other', comment: 'ещё' }), 409, 'dispute_exists');
    await expectApiError(api.openOrderDispute(order.id, { subject: 'rejection', reason: 'other', comment: 'не отклонён' }), 409, 'illegal_transition');
    await raw('POST', `/admin/disputes/${d.id}/resolve`, { admin: true, json: { resolution: 'supplier', comment: 'Поставщик прав', reason: 'нет декора' } });
    const [solved] = await api.listOrderDisputes(o.id);
    expect(solved).toMatchObject({ status: 'resolved', decision: 'supplier', decision_comment: 'Поставщик прав', amount: null });
    // По проекту с отклонённым заказом можно оформить новый
    expect((await api.createOrder(pid)).status).toBe('created');
  });

  it('уведомления: kind и data ведут на нужный экран приложения', async () => {
    const list = await api.listNotifications();
    const mine = list.filter((n) => n.data && (n.data as { order_id?: string }).order_id === order.id);
    const kinds = new Set(mine.map((n) => n.kind));
    for (const k of ['order_message', 'order_status', 'order_correction', 'order_return', 'order_dispute']) expect(kinds).toContain(k);
    const route = (kind: string, extra: (d: Record<string, unknown>) => boolean = () => true) => {
      const n = mine.find((x) => x.kind === kind && extra(x.data as Record<string, unknown>));
      expect(n).toBeTruthy();
      return routeForPush(n!.data as Record<string, unknown>);
    };
    expect(route('order_message')).toBe(`/order/chat/${order.id}`);
    expect(route('order_status')).toBe(`/order/${order.id}`);
    expect(route('order_correction')).toBe(`/order/${order.id}`);
    expect(route('order_return')).toBe(`/order/returns/${order.id}`);
    // спор по рекламации — к рекламациям (решение видно у рекламации)
    expect(route('order_dispute', (d) => !!d.return_id)).toBe(`/order/returns/${order.id}`);
    for (const n of mine) {
      expect(n.data).toMatchObject({ kind: n.kind, order_id: order.id });
      if (n.kind === 'order_status') expect(typeof (n.data as { status?: string }).status).toBe('string');
    }
  });
});
