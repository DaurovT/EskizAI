/** «Входящие чертежи» из Eskiz DWG (SCR-52…55): клиент API (пути, полные ссылки), мок, помощники экранов. */
import { Http, type TokenStore } from '../http';
import { createHttpApi } from '../httpApi';
import { createMockApi } from '../mock/mockApi';
import type { InboxDrawing } from '../types';
import {
  DWG_SCHEME, absUrl, drawingKind, drawingLine, drawingTitle, dwgOpenUrl, expiryDate, inboxSections, relDay, sheetsLabel, withAbsUrls,
} from '../../lib/inbox';

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokens: TokenStore = { async get() { return { access: 'A1', refresh: 'R1' }; }, async set() { /* — */ } };

const ITEM: InboxDrawing = {
  id: 'd1', title: 'Кухня_Юнусабад', filename: 'Кухня_Юнусабад.eskiz', size: 312000, sha256: 'a'.repeat(64),
  created_at: '2026-11-16T10:00:00Z', last_opened_at: null, expires_at: '2027-02-14T10:00:00Z', preview_url: '/signed-files/p1',
  sheet_count: 2, units_guessed: false, units_note: null, package_created_at: null, source_kind: 'dxf', project_id: null,
};

function setup(res: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => { const c = { url, init }; calls.push(c); return res(c); };
  return { api: createHttpApi(new Http({ baseUrl: 'https://api.eskizai.uz/', tokens, fetch })), calls };
}

describe('клиент API: /inbox/drawings', () => {
  it('список: limit=200, ссылки превью становятся полными', async () => {
    const { api, calls } = setup(() => json(200, { items: [ITEM, { ...ITEM, id: 'd2', preview_url: null }], total: 2, limit: 200, offset: 0 }));
    const page = await api.listInbox();
    expect(calls[0].url).toBe('https://api.eskizai.uz/inbox/drawings?limit=200');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer A1');
    expect(page.items[0].preview_url).toBe('https://api.eskizai.uz/signed-files/p1');
    expect(page.items[1].preview_url).toBeNull();
    expect(page.total).toBe(2);
  });

  it('открыть: листы и ссылка на пакет — полные; удалить — DELETE', async () => {
    const { api, calls } = setup((c) => (c.init.method === 'DELETE' ? json(200, { ok: true }) : json(200, {
      ...ITEM, download_url: '/signed-files/pkg',
      sheets: [{ id: 's1', number: '1', name: 'План', selected: true, preview_url: '/signed-files/p1' }, { id: 's2', number: '2', name: 'Развёртка', selected: false, preview_url: null }],
      manifest: { units: { code: 'mm' } },
    })));
    const d = await api.getInboxDrawing('d 1');
    expect(calls[0].url).toBe('https://api.eskizai.uz/inbox/drawings/d%201');
    expect(d.download_url).toBe('https://api.eskizai.uz/signed-files/pkg');
    expect(d.sheets.map((s) => s.preview_url)).toEqual(['https://api.eskizai.uz/signed-files/p1', null]);
    await api.deleteInboxDrawing('d1');
    expect(calls[1]).toMatchObject({ url: 'https://api.eskizai.uz/inbox/drawings/d1', init: { method: 'DELETE' } });
  });

  it('проект по листу: POST с sheet; фото — полной ссылкой; исходный чертёж проекта', async () => {
    const { api, calls } = setup((c) => (c.url.endsWith('/project')
      ? json(201, { project_id: 'p1', created: true, sheet: { id: 's2', number: '2', name: 'Развёртка' }, text: 'Чертёж…', photo_id: 'ph1', photo_url: 'https://media/x.webp' })
      : json(200, { id: 'd1', title: 'Кухня', filename: 'k.eskiz', size: 1, source_kind: 'dxf', download_url: '/signed-files/pkg' })));
    const r = await api.projectFromDrawing('d1', 's2');
    expect(calls[0].url).toBe('https://api.eskizai.uz/inbox/drawings/d1/project');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ sheet: 's2' });
    expect(r.photo_url).toBe('https://media/x.webp');
    await api.projectFromDrawing('d1');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ sheet: null });
    const src = await api.getSourceDrawing('p1');
    expect(calls[2].url).toBe('https://api.eskizai.uz/projects/p1/source-drawing');
    expect(src.download_url).toBe('https://api.eskizai.uz/signed-files/pkg');
  });
});

describe('помощники «Входящих»', () => {
  it('absUrl / withAbsUrls: путь → полный, полный и пустой — как есть', () => {
    expect(absUrl('https://a/', '/x')).toBe('https://a/x');
    expect(absUrl('https://a', 'x')).toBe('https://a/x');
    expect(absUrl('https://a', 'https://b/y')).toBe('https://b/y');
    expect(absUrl('https://a', 'mock:dwg_kupe')).toBe('mock:dwg_kupe');
    expect(absUrl('https://a', null)).toBeNull();
    expect(withAbsUrls('https://a', ITEM).preview_url).toBe('https://a/signed-files/p1');
  });

  it('ссылка eskizdwg://open — src и name закодированы', () => {
    expect(dwgOpenUrl('https://api.eskizai.uz/signed-files/t?x=1&y=2', 'Кухня 1.eskiz'))
      .toBe('eskizdwg://open?src=https%3A%2F%2Fapi.eskizai.uz%2Fsigned-files%2Ft%3Fx%3D1%26y%3D2&name=%D0%9A%D1%83%D1%85%D0%BD%D1%8F%201.eskiz');
    expect(DWG_SCHEME).toBe('eskizdwg://');
  });

  it('новые / просмотренные, название, вид файла, подписи', () => {
    const seen = { ...ITEM, id: 'd2', last_opened_at: '2026-11-15T10:00:00Z' };
    expect(inboxSections([ITEM, seen])).toEqual({ fresh: [ITEM], seen: [seen] });
    expect(drawingTitle(ITEM)).toBe('Кухня Юнусабад');
    expect(drawingTitle({ title: null, filename: 'Шкаф_купе.eskiz' })).toBe('Шкаф купе');
    expect(drawingKind(ITEM)).toBe('DXF');
    expect(drawingKind({ source_kind: null, filename: 'a.dwg' })).toBe('DWG');
    expect([1, 2, 5, 21].map((n) => sheetsLabel(n, 'ru'))).toEqual(['1 лист', '2 листа', '5 листов', '21 лист']);
    expect(sheetsLabel(3, 'uz')).toBe('3 varaq');
    const now = new Date(2026, 10, 16, 18, 0);
    expect(relDay(new Date(2026, 10, 16, 9, 0).toISOString(), 'ru', now)).toBe('сегодня');
    expect(relDay(new Date(2026, 10, 15, 23, 0).toISOString(), 'uz', now)).toBe('kecha');
    expect(relDay(new Date(2026, 10, 3, 12, 0).toISOString(), 'ru', now)).toBe('3 ноября');
    expect(drawingLine({ ...ITEM, created_at: new Date(2026, 10, 16, 9).toISOString() }, 'ru', 'от вас', now)).toBe('от вас · DXF · 2 листа · сегодня');
    expect(expiryDate(ITEM, 'ru')).toMatch(/^\d{2}\.\d{2}\.2027$/);
    expect(expiryDate({ ...ITEM, project_id: 'p1' }, 'ru')).toBeNull();
  });
});

describe('мок: входящие → проект → распознавание', () => {
  const fast = () => createMockApi({ latencyMs: 0, designMs: 0, editMs: 0 });

  it('три чертежа, новый — один; открыть отмечает просмотр; удалить убирает', async () => {
    const api = fast();
    const page = await api.listInbox();
    expect(page.items.map((d) => d.id)).toEqual(['dwg-kitchen', 'dwg-kupe', 'dwg-hall']);
    expect(inboxSections(page.items).fresh.map((d) => d.id)).toEqual(['dwg-kitchen']);
    expect(page.items.find((d) => d.id === 'dwg-hall')?.units_guessed).toBe(true);
    const d = await api.getInboxDrawing('dwg-kitchen');
    expect(d.sheets.map((s) => [s.id, s.selected])).toEqual([['s1', true], ['s2', false]]);
    expect(d.download_url).toMatch(/^https:\/\//);
    expect((await api.listInbox()).items[0].last_opened_at).not.toBeNull();
    await api.deleteInboxDrawing('dwg-hall');
    expect((await api.listInbox()).total).toBe(2);
    await expect(api.getInboxDrawing('dwg-hall')).rejects.toMatchObject({ status: 404 });
  });

  it('проект по листу: тот же черновик при другом листе, источник в карточке, разбор угловой кухни', async () => {
    const api = fast();
    const r = await api.projectFromDrawing('dwg-kitchen');
    expect(r).toMatchObject({ created: true, sheet: { id: 's1', name: 'Кухня — план' }, photo_url: 'mock:dwg_kitchen_plan' });
    const again = await api.projectFromDrawing('dwg-kitchen', 's2');
    expect(again).toMatchObject({ project_id: r.project_id, created: false, photo_url: 'mock:dwg_kitchen_elev' });
    await expect(api.projectFromDrawing('dwg-kitchen', '9')).rejects.toMatchObject({ code: 'sheet_not_found' });
    const card = await api.getProject(r.project_id);
    expect(card.source_drawing).toMatchObject({ id: 'dwg-kitchen', source_kind: 'dxf' });
    expect((await api.getSourceDrawing(r.project_id)).download_url).toMatch(/dwg-kitchen$/);
    const first = await api.projectFromDrawing('dwg-kitchen', 's1');
    const task = await api.aiDesign(r.project_id, { text: first.text, photo_ids: first.photo_id ? [first.photo_id] : [] });
    const out = await api.getTask<import('../types').DesignOut>(task.task_id);
    expect(out.result?.product_kind).toBe('kitchen_corner');
    expect(out.result?.elements[0].name).toBe('Кухня угловая, стены 3200 и 2400');
    expect(out.result?.questions.map((q) => q.id)).toEqual(['q_upper']);
  });
});
