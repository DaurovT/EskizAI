import { ApiError } from '../errors';
import { Http, type TokenStore } from '../http';
import { createHttpApi } from '../httpApi';
import { MOCK_AR_GLB, MOCK_AR_USDZ, createMockApi } from '../mock/mockApi';
import { withOfflineCache } from '../offline';
import { errorInfo } from '../../ui/dialogs';

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokens: TokenStore = { async get() { return { access: 'A1', refresh: 'R1' }; }, async set() { /* — */ } };

const AR = {
  version_id: 'v4', version_number: 4, size_mm: [1600, 600, 2400], placement: 'floor',
  glb_url: 'https://api/ar-files/s1.glb', usdz_url: 'https://api/ar-files/s1.usdz', expires_at: '2026-11-11T11:00:00Z',
};

function setup(res: () => Response | Error) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = res();
    if (r instanceof Error) throw r;
    return r;
  };
  return { api: createHttpApi(new Http({ baseUrl: 'http://api', tokens, fetch })), calls };
}

describe('GET /projects/{id}/ar (docs/ar_contract.md)', () => {
  it('путь, метод и токен мастера; ответ — как есть', async () => {
    const { api, calls } = setup(() => json(200, AR));
    const ar = await api.getProjectAr('p 1');
    expect(calls[0].url).toBe('http://api/projects/p%201/ar');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer A1');
    expect(ar).toEqual(AR);
  });

  it('409 no_model → понятная ошибка ru/uz', async () => {
    const { api } = setup(() => json(409, { error: { code: 'no_model', message: 'Нет модели' } }));
    const e = (await api.getProjectAr('p1').catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ status: 409, code: 'no_model' });
    expect(errorInfo(e, 'ru')).toMatchObject({ kind: 'ar', title: 'Модели ещё нет' });
    expect(errorInfo(e, 'uz').title).toBe('Model hali yo‘q');
  });

  it('нет сети → «нет связи»; ссылки AR не кэшируются (подписаны на час)', async () => {
    const { api } = setup(() => new TypeError('Network request failed'));
    const kv = new Map<string, string>();
    const off = withOfflineCache(api, {
      getItem: async (k) => kv.get(k) ?? null, setItem: async (k, v) => { kv.set(k, v); }, removeItem: async (k) => { kv.delete(k); },
    });
    const e = await off.getProjectAr('p1').catch((x: unknown) => x);
    expect(errorInfo(e, 'ru').kind).toBe('offline');
    expect([...kv.keys()].some((k) => k.includes('getProjectAr'))).toBe(false);
  });

  it('AR не поддерживается и файл не скачался — свои тексты', () => {
    expect(errorInfo(new ApiError(422, 'ar_unsupported', ''), 'ru').title).toBe('AR не поддерживается');
    expect(errorInfo(new ApiError(422, 'ar_unsupported', ''), 'uz').title).toBe('AR qo‘llab-quvvatlanmaydi');
    expect(errorInfo(new ApiError(403, 'ar_download_failed', 'HTTP 403'), 'ru').title).toBe('Модель не загрузилась');
  });
});

describe('мок: getProjectAr', () => {
  const fast = () => createMockApi({ latencyMs: 0, designMs: 0, editMs: 0 });

  it('текущая версия, габарит [Ш, Г, В], размещение и стабильные ссылки образцов', async () => {
    const api = fast();
    const ar = await api.getProjectAr('p-aziza');
    const m = await api.getModel('p-aziza');
    expect(ar.version_id).toBe(m.version.id);
    expect(ar.version_number).toBe(m.version.number);
    expect(ar.size_mm).toEqual([1800, 600, 2400]);
    expect(ar.placement).toBe('floor');
    expect(ar.glb_url).toBe(MOCK_AR_GLB);
    expect(ar.usdz_url).toBe(MOCK_AR_USDZ);
    expect(ar.glb_url.endsWith('.glb') && ar.usdz_url.endsWith('.usdz')).toBe(true);
    expect(Date.parse(ar.expires_at)).toBeGreaterThan(Date.now());
  });

  it('проект без модели → 409 no_model', async () => {
    const api = fast();
    const p = await api.createProject({ title: 'Пусто' });
    await expect(api.getProjectAr(p.id)).rejects.toMatchObject({ status: 409, code: 'no_model' });
  });
});
