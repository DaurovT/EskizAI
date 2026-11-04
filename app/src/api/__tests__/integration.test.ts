/** Логика новых экранов без React: имена файлов, раскрой, заказ, push, «оценка», фурнитура, декоры. */
import { fileNameFromDisposition, mimeOf, safeFileName, utiOf } from '../../lib/files';
import { nestingFromViewer, nestingSheets, sheetFromNesting } from '../../lib/cutting';
import { canPay, groupLines, groupOf, methodLabel, parseKm, previewCheck } from '../../lib/orders';
import { routeForPush } from '../../lib/pushRoute';
import { withoutConfirmed } from '../../lib/tree';
import { deltaText } from '../../lib/hardware';
import { boardDecorsOf, toneOf } from '../../lib/decors';
import { createMockApi } from '../mock/mockApi';
import { SAMPLES } from '../mock/data';
import type { DecorOut, NestingOut } from '../types';

describe('файлы: Content-Disposition и тип', () => {
  it('берёт UTF-8 имя из filename*, иначе filename', () => {
    const cd = `attachment; filename="project_spec_pdf_v3.pdf"; filename*=UTF-8''${encodeURIComponent('Шкаф_Азиза_спецификация_v3.pdf')}`;
    expect(fileNameFromDisposition(cd)).toBe('Шкаф_Азиза_спецификация_v3.pdf');
    expect(fileNameFromDisposition('attachment; filename="order_1.csv"')).toBe('order_1.csv');
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A; filename=\"x.pdf\"")).toBe('x.pdf');
    expect(fileNameFromDisposition(null)).toBeNull();
  });
  it('безопасное имя сохраняет кириллицу', () => {
    expect(safeFileName('Шкаф/Азиза: спец?.pdf')).toBe('Шкаф_Азиза_спец_.pdf');
    expect(safeFileName('..')).toBe('file');
  });
  it('тип для «Поделиться»', () => {
    expect(mimeOf('text/csv; charset=utf-8', 'a.csv')).toBe('text/csv');
    expect(mimeOf('application/octet-stream', 'Шкаф.pdf')).toBe('application/pdf');
    expect(mimeOf(undefined, 'x.dxf')).toBe('application/dxf');
    expect(utiOf('application/pdf')).toBe('com.adobe.pdf');
  });
});

describe('раскрой ядра → схема', () => {
  const n: NestingOut = {
    version_id: 'v', version_number: 1, trim: 10, kerf: 4, sheets_total: 1, unplaced: [],
    materials: [{ material: 'ldsp_16_white', material_name: 'ЛДСП 16 Белый', has_grain: false, sheets_count: 1, waste_percent: 30, parts_area_m2: 4,
      sheets: [{ index: 1, length: 2800, width: 2070, usage: 0.7, parts: [{ number: 1, name: 'Боковина', x: 10, y: 10, length: 2400, width: 600, rotated: false }] }] }],
  };
  it('переворачивает y (у ядра — от низа листа)', () => {
    const s = sheetFromNesting(n.materials[0], n.materials[0].sheets[0]);
    expect(s.parts[0]).toEqual({ number: 1, name: 'Боковина', x: 10, y: 2070 - 10 - 600, l: 2400, w: 600, rotated: false });
    expect(s.length).toBe(2800);
    expect(Math.round(s.waste * 100)).toBe(30);
    expect(nestingSheets(n)).toHaveLength(1);
  });
  it('мок отдаёт раскрой в формате API', () => {
    const out = nestingFromViewer(SAMPLES.wardrobe_full.viewer);
    expect(out.sheets_total).toBeGreaterThan(0);
    const back = nestingSheets(out)[0];
    expect(back.parts[0].y).toBeGreaterThanOrEqual(0);
  });
});

describe('заказ SCR-14 / оплата SCR-31', () => {
  const lines = [
    { key: 'sheet:ldsp_16_white', name: 'ЛДСП', unit: 'лист', qty: 3, price: 500, total: 1500 },
    { key: 'service:cut:ldsp', name: 'Распил', unit: 'лист', qty: 3, price: 50, total: 150 },
    { key: 'edge:pvc_2:body', name: 'Кромка', unit: 'м', qty: 10, price: 6, total: 60 },
    { key: 'hw:hinge:Петля', name: 'Петля', unit: 'шт', qty: 4, price: 24, total: 96 },
    { key: 'hw:slide:550:ball:standard', name: 'Направляющие', unit: 'пара', qty: 2, price: 51, total: 102 },
  ];
  it('группы состава в порядке экрана', () => {
    expect(groupOf('countertop:base[0]')).toBe('sheets');
    const g = groupLines(lines);
    expect(g.map((x) => x.key)).toEqual(['sheets', 'cutting', 'edging', 'hardware']);
    expect(g[3].total).toBe(198);
  });
  it('расстояние: запятая, пусто, отрицательное', () => {
    expect(parseKm('12,5')).toBe(12.5);
    expect(parseKm('')).toBeNull();
    expect(parseKm('-1')).toBeNull();
    expect(parseKm('0')).toBe(0);
  });
  it('итог = товары + доставка; кнопка оплаты только со ссылкой', () => {
    expect(previewCheck({ lines, excluded: [], goods_total: 1908, delivery: { weight_kg: 100, distance_km: 5, cost: 92, breakdown: {} }, total: 2000, weight_kg: 100 })).toBe(true);
    expect(canPay({ status: 'created', payment: { status: 'waiting', url: 'https://pay' } })).toBe(true);
    expect(canPay({ status: 'created', payment: { status: 'waiting', url: null } })).toBe(false);
    expect(canPay({ status: 'paid', payment: { status: 'paid', url: 'https://pay' } })).toBe(false);
    expect(canPay({ status: 'created', payment: { status: 'failed', url: 'https://pay' } })).toBe(true);
    expect(methodLabel('payme')).toBe('Payme');
  });
});

describe('push → экран', () => {
  it('заказ, цены под запрос, модель готова, лимит', () => {
    expect(routeForPush({ kind: 'order_status', project_id: 'p', order_id: 'o' })).toBe('/order/o');
    expect(routeForPush({ kind: 'price_request_priced', project_id: 'p', screen: 'price_requests' })).toBe('/project/p/price-requests');
    expect(routeForPush({ kind: 'model_ready', project_id: 'p' })).toBe('/project/p/editor');
    expect(routeForPush({ kind: 'share_opened', project_id: 'p' })).toBe('/project/p');
    expect(routeForPush({ kind: 'limit_one_left', screen: 'profile' })).toBe('/profile');
    expect(routeForPush({})).toBeNull();
  });
});

describe('«оценка», фурнитура, декоры', () => {
  it('подтверждение снимает путь, предков и потомков', () => {
    expect(withoutConfirmed(['/width', '/sections/0/width', '/height'], ['/sections'])).toEqual(['/width', '/height']);
    expect(withoutConfirmed(['/sections'], ['/sections/1/width'])).toEqual([]);
  });
  it('разница цены варианта; сотруднику — только направление', () => {
    const money = (v: number) => `${v} сум`;
    expect(deltaText({ delta: 70000, current: false }, money, true)).toBe('+70000 сум');
    expect(deltaText({ delta: -5, current: false }, money, true)).toBe('−5 сум');
    expect(deltaText({ delta: 70000, current: false }, money, false)).toBe('↑');
    expect(deltaText({ delta: 0, current: true }, money, true)).toBe('');
    expect(deltaText({ delta: null, current: false }, money, true)).toBe('');
  });
  it('плиты 16+ мм, в наличии первыми, поиск по декору', () => {
    const d = (id: string, extra: Partial<DecorOut> = {}): DecorOut => ({ id, name: id, name_uz: id, kind: 'ldsp', decor: null, color: '#f2f0eb', has_grain: false, thickness: 16, texture: null, available: true, brand: 'EMAN', sku: null, source: 'core', ...extra });
    const items = [d('a', { available: false }), d('b', { decor: 'H3395', has_grain: true }), d('c', { thickness: 10 }), d('hdf', { kind: 'hdf', thickness: 3 })];
    expect(boardDecorsOf(items).map((x) => x.id)).toEqual(['b', 'a']);
    expect(boardDecorsOf(items, { q: 'h3395' }).map((x) => x.id)).toEqual(['b']);
    expect(boardDecorsOf(items, { color: 'wood' }).map((x) => x.id)).toEqual(['b']);
    expect(toneOf({ has_grain: false, color: '#333333' })).toBe('dark');
  });
});

describe('мок: новые методы ведут себя как сервер', () => {
  const api = createMockApi({ latencyMs: 0, designMs: 0 });
  it('заказ из «Договора»: предпросмотр, оформление, отмена до оплаты', async () => {
    const list = await api.listProjects();
    const kupe = list.items.find((p) => p.title.startsWith('Купе'))!;
    await expect(api.orderPreview(kupe.id, null)).rejects.toMatchObject({ status: 409 });
    await api.toContract(kupe.id);
    const prev = await api.orderPreview(kupe.id, 12);
    expect(prev.delivery?.distance_km).toBe(12);
    expect(prev.excluded).toContain('Профиль купе бронза'); // оценена, но ещё не принята
    expect(previewCheck(prev)).toBe(true);
    const o = await api.createOrder(kupe.id, 12);
    expect(o.payment?.status).toBe('waiting');
    await expect(api.createOrder(kupe.id, null)).rejects.toMatchObject({ code: 'order_exists' });
    expect((await api.cancelOrder(o.id)).status).toBe('cancelled');
  });
  it('цены под запрос: принять оценённую, нельзя принять без цены', async () => {
    const kupe = (await api.listProjects()).items.find((p) => p.title.startsWith('Купе'))!;
    const reqs = await api.listPriceRequests(kupe.id);
    expect((await api.decidePriceRequest(kupe.id, reqs[0].id, true)).status).toBe('accepted');
    await expect(api.decidePriceRequest(kupe.id, reqs[1].id, true)).rejects.toMatchObject({ code: 'not_priced' });
  });
  it('оценка хранится в версии и подтверждается', async () => {
    const p = (await api.listProjects()).items.find((x) => x.title === 'Шкаф для Азизы')!;
    const m = await api.getModel(p.id);
    expect(m.version.estimated).toEqual(['/height', '/depth']);
    expect((await api.confirmEstimated(p.id, m.version.id, ['/height'])).estimated).toEqual(['/depth']);
  });
  it('нестандарт и фурнитура', async () => {
    const p = (await api.listProjects()).items.find((x) => x.title === 'Шкаф для Азизы')!;
    const ns = await api.sendNonstandard(p.id, { description: 'Гнутые фасады' });
    expect(ns.status).toBe('sent');
    expect(await api.listNonstandard(p.id)).toHaveLength(1);
    const hw = await api.getHardware(p.id);
    const alt = hw.groups[0].options.find((o) => !o.current)!;
    const st = await api.applyHardware(p.id, hw.groups[0].key, alt.value);
    expect((st.version.tree.hardware as Record<string, string>)[hw.groups[0].key]).toBe(alt.value);
  });
});
