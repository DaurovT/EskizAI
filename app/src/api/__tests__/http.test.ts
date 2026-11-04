import { ApiError } from '../errors';
import { Http, buildQuery, type TokenStore } from '../http';
import { createHttpApi } from '../httpApi';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: ((c: Call) => Response | Promise<Response> | Error)[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = async (url: string, init: RequestInit = {}) => {
    const c = { url, init };
    calls.push(c);
    const r = responses[Math.min(i++, responses.length - 1)](c);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function memTokens(initial: { access: string; refresh: string } | null = { access: 'A1', refresh: 'R1' }): TokenStore & { value: unknown } {
  const s = { value: initial as unknown, async get() { return s.value as never; }, async set(t: unknown) { s.value = t; } };
  return s;
}

describe('Http', () => {
  it('строит query с массивами и пропускает пустые', () => {
    expect(buildQuery({ status: ['draft', 'sent'], q: 'Азиза', archived: false, x: undefined, y: '' })).toBe(
      '?status=draft&status=sent&q=%D0%90%D0%B7%D0%B8%D0%B7%D0%B0&archived=false',
    );
  });

  it('ставит Bearer и шлёт JSON', async () => {
    const f = fakeFetch([() => json(200, { ok: true })]);
    const http = new Http({ baseUrl: 'http://api/', tokens: memTokens(), fetch: f.fn });
    await http.request('/projects', { method: 'POST', body: { title: 'x' } });
    expect(f.calls[0].url).toBe('http://api/projects');
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer A1');
    expect(f.calls[0].init.body).toBe('{"title":"x"}');
  });

  it('ошибка сервера → ApiError с кодом и сообщением', async () => {
    const f = fakeFetch([() => json(409, { error: { code: 'illegal_transition', message: 'Нельзя', details: { from: 'draft' } } })]);
    const http = new Http({ baseUrl: 'http://api', tokens: memTokens(), fetch: f.fn });
    await expect(http.request('/x')).rejects.toEqual(new ApiError(409, 'illegal_transition', 'Нельзя', { from: 'draft' }));
  });

  it('нет сети → ApiError status 0', async () => {
    const f = fakeFetch([() => new TypeError('Network request failed')]);
    const http = new Http({ baseUrl: 'http://api', tokens: memTokens(), fetch: f.fn });
    const e = (await http.request('/x').catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.isNetwork).toBe(true);
  });

  it('401 → refresh → повтор с новым токеном', async () => {
    const tokens = memTokens();
    const f = fakeFetch([
      () => json(401, { error: { code: 'token_expired', message: 'x' } }),
      (c) => { expect(c.url).toBe('http://api/auth/refresh'); return json(200, { access_token: 'A2', refresh_token: 'R2', user: {} }); },
      (c) => { expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer A2'); return json(200, [1]); },
    ]);
    const http = new Http({ baseUrl: 'http://api', tokens, fetch: f.fn });
    await expect(http.request('/projects')).resolves.toEqual([1]);
    expect(tokens.value).toEqual({ access: 'A2', refresh: 'R2' });
  });

  it('refresh не прошёл → токены стёрты, onUnauthorized', async () => {
    const tokens = memTokens();
    const onUnauthorized = jest.fn();
    const f = fakeFetch([
      () => json(401, { error: { code: 'token_expired', message: 'x' } }),
      () => json(401, { error: { code: 'refresh_invalid', message: 'Сессия завершена' } }),
    ]);
    const http = new Http({ baseUrl: 'http://api', tokens, fetch: f.fn, onUnauthorized });
    await expect(http.request('/projects')).rejects.toMatchObject({ status: 401 });
    expect(tokens.value).toBeNull();
    expect(onUnauthorized).toHaveBeenCalled();
  });
});

describe('createHttpApi: пути и тела по контракту', () => {
  const setup = (responses: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(responses);
    const api = createHttpApi(new Http({ baseUrl: 'http://api', tokens: memTokens(), fetch: f.fn }));
    return { api, calls: f.calls };
  };

  it('ИИ: design / answer / choose-type / edit → 202 {task_id}', async () => {
    const { api, calls } = setup([() => json(202, { task_id: 't1' })]);
    await api.aiDesign('p1', { text: 'шкаф', photo_ids: ['ph1'], language: 'ru' });
    await api.aiAnswer('p1', { q1: 'не знаю' });
    await api.aiChooseType('p1', 'wardrobe');
    await api.aiEdit('p1', 'ширина 2000');
    await api.aiEdit('p1', 'ширина 2000', true);
    expect(calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ['POST', 'http://api/projects/p1/ai/design', '{"text":"шкаф","photo_ids":["ph1"],"language":"ru"}'],
      ['POST', 'http://api/projects/p1/ai/answer', '{"answers":[{"question_id":"q1","value":"не знаю"}]}'],
      ['POST', 'http://api/projects/p1/ai/choose-type', '{"product_kind":"wardrobe"}'],
      ['POST', 'http://api/projects/p1/ai/edit', '{"instruction":"ширина 2000"}'],
      ['POST', 'http://api/projects/p1/ai/edit', '{"instruction":"ширина 2000","confirm_extra_project":true}'],
    ]);
  });

  it('ИИ: choose-objects → 202 {projects, charged}', async () => {
    const out = { projects: [{ project_id: 'p1', task_id: 't1', object_index: 1, label: 'комод', title: 'o', created: false }], charged: 0 };
    const { api, calls } = setup([() => json(202, out)]);
    expect(await api.aiChooseObjects('p1', [1, 0])).toEqual(out);
    await api.aiChooseObjects('p1', [2], true);
    expect(calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ['POST', 'http://api/projects/p1/ai/choose-objects', '{"objects":[1,0]}'],
      ['POST', 'http://api/projects/p1/ai/choose-objects', '{"objects":[2],"confirm_extra_project":true}'],
    ]);
  });

  it('402 от ИИ доходит до вызывающего как ApiError', async () => {
    const { api } = setup([() => json(402, { error: { code: 'ai_budget_exhausted', message: 'Бюджет' } })]);
    await expect(api.aiEdit('p1', 'x')).rejects.toMatchObject({ status: 402, isPaymentRequired: true });
  });

  it('файлы: список и в виде массива, и {files}', async () => {
    const { api } = setup([() => json(200, [{ kind: 'offer_pdf', available: true }]), () => json(200, { files: [{ kind: 'dxf', available: false, reason: 'оплата' }] })]);
    expect(await api.listFiles('p1')).toHaveLength(1);
    expect((await api.listFiles('p1'))[0]).toMatchObject({ kind: 'dxf', available: false });
  });

  it('заказы, нестандарт, push — настоящие эндпоинты', async () => {
    const { api, calls } = setup([
      () => json(200, { items: [{ id: 'o1', number: '1001' }], total: 1, limit: 200, offset: 0 }),
      () => json(200, { lines: [], excluded: ['ХДФ 3 Белый'], goods_total: 10, delivery: null, total: 10, weight_kg: 5 }),
      () => json(201, { id: 'o2', number: '1002' }),
      () => json(200, { id: 'o2', status: 'cancelled' }),
      () => json(201, { id: 'ns1', status: 'sent' }),
      () => json(200, { id: 'ns1', status: 'in_work' }),
      () => json(200, { id: 'd1', has_push: true }),
      () => json(200, { ok: true }),
    ]);
    expect(await api.listOrders()).toEqual([{ id: 'o1', number: '1001' }]);
    expect((await api.orderPreview('p1', 12.5)).excluded).toEqual(['ХДФ 3 Белый']);
    await api.createOrder('p1', null);
    await api.cancelOrder('o2');
    await api.sendNonstandard('p1', { description: 'Радиусные двери', photo_ids: ['ph1'], path: 'eman' });
    await api.acceptNonstandard('p1', 'ns1');
    await expect(api.registerPushToken('ExponentPushToken[x]', 'android', 'dev-1')).resolves.toEqual({ stored: 'api' });
    await api.unregisterPush('dev-1');
    expect(calls.map((c) => [c.init.method, c.url, c.init.body ?? null])).toEqual([
      ['GET', 'http://api/orders?limit=200', null],
      ['GET', 'http://api/projects/p1/orders/preview?distance_km=12.5', null],
      ['POST', 'http://api/projects/p1/orders', '{"distance_km":null}'],
      ['POST', 'http://api/orders/o2/cancel', '{"reason":null}'],
      ['POST', 'http://api/projects/p1/nonstandard', '{"description":"Радиусные двери","photo_ids":["ph1"],"path":"eman"}'],
      ['POST', 'http://api/projects/p1/nonstandard/ns1/accept', '{}'],
      ['POST', 'http://api/devices', '{"push_token":"ExponentPushToken[x]","platform":"android","device_id":"dev-1"}'],
      ['DELETE', 'http://api/devices?device_id=dev-1', null],
    ]);
  });

  it('оценка, фурнитура, раскрой, «под запрос», декоры', async () => {
    const { api, calls } = setup([
      () => json(200, { version_id: 'v1', estimated: ['/height'] }),
      () => json(200, { groups: [] }),
      () => json(201, { version: {} }),
      () => json(200, { materials: [] }),
      () => json(200, []),
      () => json(200, { id: 'r1', status: 'accepted' }),
      () => json(200, { id: 'r1', status: 'declined' }),
      () => json(200, { items: [{ id: 'ldsp_16_oak' }], total: 1 }),
    ]);
    expect(await api.confirmEstimated('p1', 'v1', ['/width'])).toEqual({ version_id: 'v1', estimated: ['/height'] });
    await api.getHardware('p1');
    await api.applyHardware('p1', 'hinge', 'push');
    await api.getNesting('p1');
    await api.listPriceRequests('p1');
    await api.decidePriceRequest('p1', 'r1', true);
    await api.decidePriceRequest('p1', 'r1', false);
    expect(await api.listDecors()).toEqual([{ id: 'ldsp_16_oak' }]);
    expect(calls.map((c) => `${c.init.method} ${c.url} ${c.init.body ?? ''}`.trim())).toEqual([
      'POST http://api/projects/p1/versions/v1/confirm {"pointers":["/width"]}',
      'GET http://api/projects/p1/hardware',
      'POST http://api/projects/p1/hardware {"key":"hinge","value":"push"}',
      'GET http://api/projects/p1/nesting',
      'GET http://api/projects/p1/price-requests',
      'POST http://api/projects/p1/price-requests/r1/accept {}',
      'POST http://api/projects/p1/price-requests/r1/decline {}',
      'GET http://api/catalog/decors',
    ]);
  });

  it('404 «нет сущности» доходит до экрана', async () => {
    const { api } = setup([() => json(404, { error: { code: 'not_found', message: 'Проект не найден' } })]);
    await expect(api.sendNonstandard('p1', { description: 'x' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('модель: fixes и restore', async () => {
    const { api, calls } = setup([() => json(201, { version: {} })]);
    await api.applyFix('p1', 2, 0);
    await api.restoreVersion('p1', 'v3');
    expect(calls[0].url).toBe('http://api/projects/p1/model/fixes');
    expect(calls[0].init.body).toBe('{"issue_index":2,"fix_index":0}');
    expect(calls[1].url).toBe('http://api/projects/p1/versions/v3/restore');
  });

  it('смета клиента с видом и список проектов с фильтром', async () => {
    const { api, calls } = setup([() => json(200, {})]);
    await api.getClientEstimate('p1', 'detailed');
    await api.listProjects({ status: ['sent'], q: 'Аз' });
    expect(calls[0].url).toBe('http://api/projects/p1/estimate/client?view=detailed');
    expect(calls[1].url).toContain('/projects?status=sent&q=');
  });
});
