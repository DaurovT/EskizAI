/**
 * Сквозной прогон НАСТОЯЩЕГО API-клиента приложения (src/api/httpApi.ts + http.ts) против локального FastAPI.
 *
 *   cd api && ENV=dev DATABASE_URL=sqlite:///./e2e.db uv run alembic upgrade head
 *   ENV=dev DATABASE_URL=sqlite:///./e2e.db uv run uvicorn mebel_api.main:app --port 8765
 *   cd app && E2E_API_URL=http://127.0.0.1:8765 npm run e2e
 *
 * Вход по коду 0000 (только ENV=dev) → цех → проект → дерево модулей (core/tests/fixtures/wardrobe_full.json) →
 * эскиз → смета → ссылка клиенту (клиент открыл — push) → замер → договор → заказ с доставкой → менеджер
 * ставит ссылку на оплату и отмечает оплату (X-Admin-Token) → файлы открыты → скачан PDF с UTF-8 именем;
 * нестандарт: заявка → оценка → принять → файл → готово → скачать. Плюс раскрой, фурнитура, декоры, «под запрос».
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { DownloadedFile } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import { Http, type TokenStore } from '../src/api/http';
import { createHttpApi } from '../src/api/httpApi';
import { fileNameFromDisposition, mimeOf, safeFileName } from '../src/lib/files';
import { groupLines, previewCheck } from '../src/lib/orders';
import { nestingSheets } from '../src/lib/cutting';

const BASE = (process.env.E2E_API_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const ADMIN = process.env.E2E_ADMIN_TOKEN ?? 'dev-admin-token';
const OUT = resolve(process.env.E2E_OUT_DIR ?? join(__dirname, '..', '..', '.e2e-build', 'downloads'));
const FIXTURE = resolve(__dirname, '..', '..', '..', 'core', 'tests', 'fixtures', 'wardrobe_full.json');
const PHONE = process.env.E2E_PHONE ?? `+99890${String(Date.now()).slice(-7)}`;

let step = 0;
const log = (title: string, detail = '') => console.log(`${String(++step).padStart(2, '0')}. ✓ ${title}${detail ? ` — ${detail}` : ''}`);
function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`Проверка не прошла: ${message}`);
}
const money = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ')} сум`);

let tokens: { access: string; refresh: string } | null = null;
const tokenStore: TokenStore = { get: async () => tokens, set: async (t) => { tokens = t; } };

/** Скачивание файла в Node: как download.ts в приложении — имя из Content-Disposition, тип из заголовка. */
async function nodeDownload(url: string, headers: Record<string, string>, fallback: string): Promise<DownloadedFile> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? `HTTP ${res.status}`);
  }
  const name = safeFileName(fileNameFromDisposition(res.headers.get('content-disposition')) ?? fallback);
  const mimeType = mimeOf(res.headers.get('content-type'), name);
  mkdirSync(OUT, { recursive: true });
  const uri = join(OUT, name);
  writeFileSync(uri, Buffer.from(await res.arrayBuffer()));
  return { uri, mimeType, name };
}

async function admin<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Admin-Token', ADMIN);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`admin ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function main() {
  const http = new Http({ baseUrl: BASE, tokens: tokenStore, timeoutMs: 60_000 });
  const api = createHttpApi(http, nodeDownload);
  console.log(`API: ${BASE} · телефон ${PHONE}`);
  const health = await fetch(`${BASE}/health`).then((r) => r.json()) as { env: string };
  check(health.env === 'dev', 'API должен быть запущен с ENV=dev (код 0000)');

  // 1. Вход и цех
  await api.requestCode(PHONE, 'sms');
  const t = await api.verifyCode({ phone: PHONE, code: '0000', device_id: 'e2e-phone', platform: 'android' });
  await tokenStore.set({ access: t.access_token, refresh: t.refresh_token });
  log('Вход по коду 0000', `${t.user.phone}, новый: ${t.is_new_user}`);
  const ws = await api.updateWorkshop({ name: 'Цех e2e', city: 'Ташкент' });
  log('Профиль цеха', `${ws.name}, ${ws.city}`);
  const push = await api.registerPushToken('ExponentPushToken[e2e-device-0001]', 'android', 'e2e-phone');
  log('Push-токен устройства (POST /devices)', push.stored);

  // 2. Проект, модель, эскиз, смета
  const client = await api.createClient({ name: 'Азиза', phone: '+998901112233' });
  const project = await api.createProject({ title: 'Шкаф Азиза', client_id: client.id });
  const tree = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const model = await api.saveModel(project.id, { tree, source: 'manual', label: 'wardrobe_full' });
  check(model.version.ok, 'модель без ошибок');
  log('Дерево модулей → модель', `версия ${model.version.number}, деталей ${model.version.summary.parts_count}, размеры ${model.version.summary.size_mm?.join('×')}`);
  const sketch = await api.toSketch(project.id);
  check(sketch.status === 'sketch', 'статус «Эскиз»');
  log('Черновик → Эскиз', sketch.status_label);
  const est = await api.getEstimate(project.id);
  log('Смета мастера', `клиенту ${money(est.total.from)} – ${money(est.total.to)}, листов ${Object.values(est.sheets).reduce((a, b) => a + b, 0)}`);
  const list = await api.listProjects();
  const row = list.items.find((p) => p.id === project.id);
  check(row?.price?.from === est.total.from, 'цена в списке проектов из кэша');
  log('Цена в списке проектов (кэш версии)', `${money(row!.price!.from)} – ${money(row!.price!.to)}`);

  // 3. Раскрой, фурнитура, декоры, «под запрос»
  const nest = await api.getNesting(project.id);
  const sheets = nestingSheets(nest);
  check(sheets.length === nest.sheets_total && nest.unplaced.length === 0, 'раскрой ядра');
  log('Раскрой ядра (GET …/nesting)', nest.materials.map((m) => `${m.material_name}: ${m.sheets_count} л., отход ${m.waste_percent}%`).join('; '));
  const hw = await api.getHardware(project.id);
  const hinge = hw.groups.find((g) => g.key === 'hinge');
  const alt = hinge?.options.find((o) => !o.current && o.available);
  check(alt, 'есть вариант петель');
  const hwState = await api.applyHardware(project.id, hinge!.key, alt!.value);
  log('Фурнитура SCR-26', `${hinge!.title}: «${alt!.label}» ${alt!.delta! >= 0 ? '+' : ''}${money(alt!.delta)} → версия ${hwState.version.number}`);
  await api.undo(project.id);
  log('Отмена замены фурнитуры (undo)');
  const decors = await api.listDecors();
  log('Декоры SCR-09 (GET /catalog/decors)', `${decors.length} шт.: ${decors.slice(0, 3).map((d) => d.id).join(', ')}…`);
  const reqs = await api.listPriceRequests(project.id);
  log('Позиции «под запрос»', reqs.map((r) => `${r.name} (${r.status})`).join(', ') || 'нет');

  // 4. Ссылка клиенту, клиент открыл (push), замер, договор
  const link = await api.createShareLink(project.id, { language: 'ru', show_price: true, estimate_view: 'short' });
  log('Ссылка клиенту', link.url);
  await fetch(`${BASE}/share/${link.token}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'opened' }) });
  await fetch(`${BASE}/share/${link.token}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'ar_started' }) });
  const notes = await http.request<{ kind: string; body: string; status: string }[]>('/notifications');
  check(notes.some((n) => n.kind === 'share_opened'), 'push «клиент смотрит»');
  log('Push мастеру по событиям ссылки', notes.map((n) => `«${n.body}» (${n.status})`).join('; '));
  const m = await api.addMeasurement(project.id, { width: tree.width, height: tree.height - 20, depth: tree.depth });
  log('Замер SCR-13', m.applied_version_id ? `размеры применены, новая версия; «оценка» снята` : `без новой версии${m.apply_error ? `: ${m.apply_error}` : ''}`);
  const contract = await api.toContract(project.id);
  check(contract.status === 'contract', 'статус «Договор»');
  log('Замер → Договор', `заморожена версия ${contract.frozen_version_id?.slice(0, 8)}`);

  // 5. Заказ с доставкой, оплата менеджером, файлы
  const prev = await api.orderPreview(project.id, 15);
  check(previewCheck(prev) && prev.delivery?.distance_km === 15, 'предпросмотр заказа');
  log('Предпросмотр заказа SCR-14', `${groupLines(prev.lines).map((g) => `${g.key} ${money(g.total)}`).join(', ')}; доставка ${money(prev.delivery!.cost)} (${prev.delivery!.weight_kg} кг); исключено: ${prev.excluded.join(', ') || '—'}; итого ${money(prev.total)}`);
  const order = await api.createOrder(project.id, 15);
  check(order.payment?.status === 'waiting', 'оплата ждёт');
  log('Заказ оформлен', `№${order.number}, ${money(order.total)}, оплата: ${order.payment!.status}`);
  const locked = await api.downloadFile(project.id, 'spec_pdf').catch((e: unknown) => e);
  check(locked instanceof ApiError && locked.status === 402, 'до оплаты файлы закрыты');
  log('До оплаты производственные файлы закрыты', `${(locked as ApiError).status} ${(locked as ApiError).message}`);
  await admin(`/admin/orders/${order.id}/payment`, { method: 'POST', body: JSON.stringify({ url: 'https://pay.eman.uz/i/e2e', method: 'click' }) });
  const waiting = await api.getOrder(order.id);
  check(waiting.payment?.url === 'https://pay.eman.uz/i/e2e', 'ссылка на оплату');
  log('Менеджер вставил ссылку EMAN (SCR-31)', `${waiting.payment!.status} · ${waiting.payment!.url}`);
  await admin(`/admin/projects/${project.id}/order-paid`, { method: 'POST', body: JSON.stringify({ payment_provider: 'click', invoice_total: order.total }) });
  const paid = await api.getOrder(order.id);
  check(paid.payment?.status === 'paid' && paid.status === 'paid', 'оплачено');
  log('Менеджер отметил оплату', `заказ: ${paid.status_label}, шаги: ${paid.steps!.filter((s) => s.done).map((s) => s.label).join(' → ')}`);
  const card = await api.getProject(project.id);
  log('Проект', `${card.status_label}, возвращён в лимит: ${card.returned_to_limit}`);
  const files = await api.listFiles(project.id);
  check(files.every((f) => f.available), 'все файлы открыты');
  log('Файлы открыты', `${files.length} шт.`);
  const pdf = await api.downloadFile(project.id, 'spec_pdf');
  const bytes = readFileSync(pdf.uri);
  check(bytes.subarray(0, 4).toString() === '%PDF' && pdf.name.includes('спецификация'), 'PDF с UTF-8 именем');
  log('Скачан PDF', `${pdf.name} (${pdf.mimeType}, ${Math.round(bytes.length / 1024)} КБ) → ${pdf.uri}`);
  const csv = await api.downloadFile(project.id, 'csv');
  log('Скачан CSV', `${csv.name} (${csv.mimeType})`);

  // 6. Нестандарт
  const ns = await api.sendNonstandard(project.id, { description: 'Радиусные двери на левой секции, R=400', differences: ['гнутые фасады'] });
  check(ns.status === 'sent', 'заявка отправлена');
  log('Нестандарт SCR-19', `заявка №${ns.number}: ${ns.status_label}`);
  await admin(`/admin/nonstandard/${ns.id}`, { method: 'PATCH', body: JSON.stringify({ assignee: 'Конструктор EMAN', price: 1_500_000, lead_days: 5 }) });
  let nsNow = (await api.listNonstandard(project.id))[0];
  check(nsNow.status === 'estimated' && nsNow.can_accept, 'оценена');
  log('Админка ADM-09: оценка', `${money(nsNow.price)}, ${nsNow.lead_days} дн.`);
  nsNow = await api.acceptNonstandard(project.id, ns.id);
  log('Мастер принял цену', nsNow.status_label);
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('0\nSECTION\n0\nEOF\n')], { type: 'application/dxf' }), 'Двери_радиус.dxf');
  await admin(`/admin/nonstandard/${ns.id}/files`, { method: 'POST', body: form });
  await admin(`/admin/nonstandard/${ns.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  nsNow = (await api.listNonstandard(project.id))[0];
  check(nsNow.status === 'done' && nsNow.files.length === 1, 'готово с файлом');
  const nsFile = await api.downloadNonstandardFile(project.id, nsNow.files[0]);
  log('Нестандарт готов, файл скачан (SCR-34)', `${nsNow.steps.map((s) => s.label).join(' → ')}; ${nsFile.name}`);

  const finalNotes = await http.request<{ kind: string }[]>('/notifications');
  log('Уведомления мастера', finalNotes.map((n) => n.kind).join(', '));
  console.log(`\nE2E OK: ${step} шагов`);
}

main().catch((e) => {
  console.error(`\nE2E FAILED на шаге ${step + 1}:`, e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : e);
  process.exit(1);
});
