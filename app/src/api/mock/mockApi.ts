/**
 * Мок API: всё в памяти процесса, данные — образцы ядра. Нужен, чтобы показать каждый экран без сервера.
 * Поведение повторяет FastAPI (статусы, ошибки по-русски, 402 бюджета ИИ, задачи с опросом).
 */
import type { ViewerModel } from '@mebel/viewer';
import type { Api, DownloadedFile } from '../client';
import { ApiError } from '../errors';
import type * as T from '../types';
import { MOCK_STATUS, SHARE_URL } from '../../config';
import { applyPatch, getAt } from '../../lib/jsonPatch';
import { recolorViewer, scaleViewer } from '../../lib/viewerEdit';
import { nestingFromViewer, partsCsv } from '../../lib/cutting';
import { DECORS } from '../../lib/catalog';
import { MOCK_EMAN_DECORS } from './emanSamples';
import { formatRange } from '../../lib/format';
import { SAMPLES, kindToSample, sampleFor, type SampleKey } from './data';
import { builtinOptions, decorateViewer, decorIssues, frontStyles, hasBuiltin, hasDecor, lightingZones, withNiche } from './decorMock';
import { fitToNiche, nicheHeights, nicheWidths } from '../../lib/decorStyle';
import { clientEstimate, masterEstimate, pricingK, staffEstimate } from './estimate';

export interface MockOptions {
  /** Задержка ответов, мс (имитация 4G). */
  latencyMs?: number;
  /** Сколько «работает» ИИ-задача, мс. */
  designMs?: number;
  editMs?: number;
  /** Сколько ИИ-правок до 402 (бюджет проекта). */
  aiBudget?: number;
  /** Сохранение файла для «Поделиться» (в приложении — expo-file-system). */
  writeFile?: (name: string, content: string, mimeType: string) => Promise<string>;
  role?: T.Role;
  now?: () => number;
  /** Демо SCR-45: какой ответ даёт /app/status. */
  appStatus?: 'none' | 'optional' | 'required' | 'maintenance';
}

const STATUS_LABELS: Record<T.ProjectStatus, string> = {
  draft: 'Черновик', sketch: 'Эскиз', sent: 'Отправлен', measured: 'Замер', contract: 'Договор',
  in_work: 'В работе', delivered: 'Сдан', cancelled: 'Отменён',
};
const NEXT_STEP: Record<T.ProjectStatus, string> = {
  draft: 'постройте модель и переведите проект в «Эскиз»',
  sketch: 'отправьте ссылку клиенту или внесите замер',
  sent: 'внесите замер',
  measured: 'отметьте договор с клиентом',
  contract: 'оформите заказ в EMAN или отметьте «материалы куплены сам»',
  in_work: 'отметьте сдачу, когда заказ выдан',
  delivered: 'проект сдан',
  cancelled: 'проект отменён',
};
const TRANSITIONS: Record<T.ProjectStatus, T.ProjectStatus[]> = {
  draft: ['sketch', 'cancelled'], sketch: ['sent', 'measured', 'cancelled'], sent: ['measured', 'cancelled'],
  measured: ['contract', 'cancelled'], contract: ['in_work', 'delivered', 'cancelled'], in_work: ['delivered'],
  delivered: [], cancelled: [],
};
const ACTIONS: Record<T.ProjectStatus, T.ActionOut[]> = {
  draft: [{ code: 'sketch', label: 'Сделать эскиз', to_status: 'sketch' }],
  sketch: [{ code: 'share', label: 'Отправить клиенту', to_status: 'sent' }, { code: 'measure', label: 'Внести замер', to_status: 'measured' }],
  sent: [{ code: 'share', label: 'Отправить ссылку ещё раз', to_status: null }, { code: 'measure', label: 'Внести замер', to_status: 'measured' }],
  measured: [{ code: 'measure', label: 'Изменить замер', to_status: null }, { code: 'contract', label: 'Договор подписан', to_status: 'contract' }],
  contract: [{ code: 'order', label: 'Заказать в EMAN', to_status: 'in_work' }, { code: 'deliver_self_bought', label: 'Материалы куплены сам — сдать', to_status: 'delivered' }],
  in_work: [{ code: 'deliver', label: 'Отметить сдачу', to_status: 'delivered' }],
  delivered: [], cancelled: [],
};

interface MProject {
  id: string; title: string; status: T.ProjectStatus; is_example: boolean; client_id: string | null;
  sample: SampleKey | null; source_text: string | null; created_at: string; updated_at: string;
  archived_at: string | null; client_agreed_at: string | null; frozen_version_id: string | null;
  contract_at: string | null; delivered_at: string | null; materials_self_bought: boolean;
  cancelled_at: string | null; cancel_reason: string | null; charged: boolean;
  photos: T.PhotoOut[]; measurements: T.MeasurementOut[];
  versions: T.VersionOut[]; current: string | null; undo: string[]; redo: string[];
  chat: T.ChatMessage[]; links: T.ShareLinkOut[]; aiEdits: number; filesPaid: boolean;
  /** последний DesignOut — чтобы ответы на вопросы знали контекст */
  design: { sample: SampleKey; tree: T.ProductTree; estimated: string[]; questions: T.DesignQuestion[]; objects?: T.DesignObject[] } | null;
  /** все ответы мастера в сессии распознавания (повторно не спрашиваем) */
  aiAnswers?: Record<string, string>;
}

let seq = 1000;
const uid = (p: string) => `${p}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;
const T_ORDER_FLOW: T.OrderStatus[] = ['created', 'paid', 'accepted', 'cutting', 'ready', 'issued'];
const ORDER_LABELS: Record<T.OrderStatus, string> = { created: 'Создан', paid: 'Оплачен', accepted: 'Принят EMAN', cutting: 'В распиле', ready: 'Готов', issued: 'Выдан', cancelled: 'Отменён' };

export function createMockApi(opts: MockOptions = {}): Api {
  const latency = opts.latencyMs ?? 250;
  const designMs = opts.designMs ?? 4000;
  const editMs = opts.editMs ?? 1500;
  const aiBudget = opts.aiBudget ?? 5;
  const now = opts.now ?? Date.now;
  const role: T.Role = opts.role ?? 'owner';
  const wait = <R>(v: R | (() => R)): Promise<R> =>
    new Promise((res, rej) => setTimeout(() => {
      try { res(typeof v === 'function' ? (v as () => R)() : v); } catch (e) { rej(e); }
    }, latency));

  // ----- состояние -----
  let userIsNew = true;
  const user: T.UserOut = { id: 'u-1', phone: '+998901234567', name: 'Рустам', role, language: 'ru', workshop_id: 'w-1' };
  let pricing: T.PricingOut = {
    labor_mode: 'percent', labor_percent: 50, labor_fixed: 0, markup_body: 20, markup_fronts: 20,
    markup_hardware: 15, markup_services: 0, default_estimate_view: 'short', employee_estimate_views: ['total', 'short'],
  };
  let workshop: T.WorkshopOut = {
    id: 'w-1', name: 'Мебель Плюс', city: 'Ташкент', logo_url: null, phone: '+998901234567', plan: 'free',
    kp_lead: '14 рабочих дней', kp_payment: 'Предоплата 50%, остаток после сборки', kp_warranty: '12 месяцев на корпус и фурнитуру',
    default_estimate_view: 'short', employee_estimate_views: ['total', 'short'], created_at: iso(30 * DAY),
  };
  const limits: T.LimitsOut = { plan: 'free', period: new Date().toISOString().slice(0, 7), free_limit: 3, free_used: 1, free_left: 2, pack_left: 0, unlimited: false, can_create_sketch: true };
  const employees: T.EmployeeOut[] = [
    { id: 'u-1', phone: '+998901234567', name: 'Рустам', role: 'owner', is_active: true, last_login_at: iso() },
    { id: 'u-2', phone: '+998935550011', name: 'Жасур', role: 'employee', is_active: true, last_login_at: iso(2 * DAY), title: 'Замерщик', can_see_cost: false, can_order: false },
  ];
  const clients: T.ClientOut[] = [
    { id: 'c-1', name: 'Азиза', phone: '+998901112233', address: 'Юнусабад, 4-й квартал, д. 12', notes: 'Ниша в спальне 1800', created_at: iso(10 * DAY), updated_at: iso(DAY) },
    { id: 'c-2', name: 'Бахтиёр', phone: '+998977778899', address: 'Чиланзар, 9', notes: null, created_at: iso(20 * DAY), updated_at: iso(3 * DAY) },
    { id: 'c-3', name: 'Нигора', phone: '+998946660000', address: null, notes: 'Кухня, сдана', created_at: iso(40 * DAY), updated_at: iso(7 * DAY) },
  ];
  const projects: MProject[] = [];
  // приглашения (SCR-38a): демо — номер на …0000 приглашён, на …0001 — приглашение устарело
  const invites: T.InviteOut[] = [];
  let myInvite: T.InviteOut | null = null;
  const makeInvite = (phone: string, body: Partial<T.InviteIn> = {}, expired = false): T.InviteOut => {
    const sent = now() - (expired ? 8 * DAY : 0);
    return {
      id: uid('inv'), status: expired ? 'expired' : 'pending', phone, name: body.name ?? '', title: body.title ?? null,
      can_see_cost: !!body.can_see_cost, can_order: !!body.can_order, estimate_views: [...workshop.employee_estimate_views],
      sent_at: new Date(sent).toISOString(), expires_at: new Date(sent + 7 * DAY).toISOString(), created_at: new Date(sent).toISOString(),
      workshop: { id: 'w-2', name: workshop.name || 'Мебель Плюс', city: workshop.city }, owner: { name: 'Тимур', phone: '+998909530000' },
    };
  };
  const tasks = new Map<string, { readyAt: number; run: () => unknown; done?: { result?: unknown; error?: string } }>();

  const baseProject = (p: Partial<MProject> & { title: string }): MProject => ({
    id: uid('p'), status: 'draft', is_example: false, client_id: null, sample: null, source_text: null,
    created_at: iso(), updated_at: iso(), archived_at: null, client_agreed_at: null, frozen_version_id: null,
    contract_at: null, delivered_at: null, materials_self_bought: false, cancelled_at: null, cancel_reason: null,
    charged: false, photos: [], measurements: [], versions: [], current: null, undo: [], redo: [], chat: [],
    links: [], aiEdits: 0, filesPaid: false, design: null, ...p,
  });

  // ----- модель -----
  /** Образец, по которому рисуем и считаем это дерево (декор/встройка — похожий образец ядра). */
  const srcOf = (sample: SampleKey, tree: T.ProductTree): SampleKey => sampleFor(sample, tree, hasDecor(tree), hasBuiltin(tree));
  const viewerFor = (sample0: SampleKey, tree: T.ProductTree): ViewerModel => {
    const sample = srcOf(sample0, tree);
    const s = SAMPLES[sample];
    const t0 = s.tree;
    let m = s.viewer;
    if (typeof tree.width === 'number' && typeof t0.width === 'number') {
      m = scaleViewer(m, [tree.width / t0.width, (tree.depth ?? t0.depth ?? 1) / (t0.depth ?? 1), (tree.height ?? t0.height ?? 1) / (t0.height ?? 1)]);
    }
    if (tree.body?.material && tree.body.material !== t0.body?.material) m = recolorViewer(m, 'body', tree.body.material);
    if (tree.fronts?.material && tree.fronts.material !== t0.fronts?.material) m = recolorViewer(m, 'fronts', tree.fronts.material);
    return { ...decorateViewer(m, tree), issues: [] };
  };

  const issuesFor = (tree: T.ProductTree): T.IssueOut[] => {
    const out: T.IssueOut[] = decorIssues(tree);
    if ((tree.height ?? 0) > 2780) {
      out.push({ level: 'error', code: 'part_exceeds_sheet', message: `Боковина ${tree.height} мм не помещается на лист 2800×2070 мм`, path: 'body',
        fixes: [{ description: 'Высота 2750 мм', patch: [{ op: 'replace', path: '/height', value: 2750 }] }, { description: 'Добавить антресоль', patch: [{ op: 'replace', path: '/height', value: 2400 }, { op: 'add', path: '/mezzanine', value: { height: Math.min(900, (tree.height ?? 2800) - 2400) } }] }] });
    }
    const secs = tree.sections ?? [];
    const fixedW = secs.reduce((s, x) => s + (x.width ?? 0), 0);
    const auto = secs.filter((x) => x.width == null).length;
    const inner = (tree.width ?? 0) - 16 * (secs.length + 1);
    secs.forEach((s, i) => {
      const w = s.width ?? (auto ? (inner - fixedW) / auto : 0);
      const doors = s.doors?.count ?? 0;
      if (doors === 1 && w > 600) {
        out.push({ level: 'error', code: 'door_too_wide', message: `Дверь в секции ${i + 1} шире 600 мм (${Math.round(w)} мм)`, path: `sections[${i}].doors`,
          fixes: [{ description: 'Поставить две двери', patch: [{ op: 'replace', path: `/sections/${i}/doors`, value: { count: 2 } }] }] });
      }
    });
    if (!tree.sliding_doors && fixedW > inner && secs.length) {
      out.push({ level: 'error', code: 'sections_mismatch', message: `Сумма ширин секций ${fixedW} мм больше ширины в свету ${inner} мм`, path: 'sections',
        fixes: [{ description: 'Делить секции поровну', patch: secs.map((_, i) => ({ op: 'replace', path: `/sections/${i}/width`, value: null })) }] });
    }
    if ((tree.width ?? 0) > 2800 && !tree.sliding_doors) {
      out.push({ level: 'warning', code: 'wide_body', message: 'Ширина больше 2800 мм — крышу придётся стыковать', path: 'width', fixes: [] });
    }
    return out;
  };

  const summaryFor = (tree: T.ProductTree, viewer: ViewerModel, issues: T.IssueOut[]): T.ModelSummary => ({
    product_type: tree.type ?? 'wardrobe', size_mm: viewer.size, sections: tree.sections?.length ?? 0, parts_count: viewer.parts.length,
    materials: Object.entries(viewer.materials).map(([id, m]) => ({ id, name: m.name, parts: viewer.parts.filter((p) => p.material === id).length })),
    hardware: [], moving_nodes: viewer.nodes.length,
    errors: issues.filter((i) => i.level === 'error').length, warnings: issues.filter((i) => i.level !== 'error').length,
  });

  const curVersion = (p: MProject) => p.versions.find((v) => v.id === p.current) ?? null;

  const createVersion = (p: MProject, tree: T.ProductTree, source: T.VersionBrief['source'], label: string | null, rejectOnErrors = false, estimated?: string[]): T.VersionOut => {
    if (!p.sample) p.sample = kindToSample(tree.type === 'kitchen' ? 'kitchen' : tree.sliding_doors ? 'wardrobe_sliding' : 'wardrobe');
    const issues = issuesFor(tree);
    const ok = !issues.some((i) => i.level === 'error');
    if (rejectOnErrors && !ok) throw new ApiError(422, 'model_invalid', `Правка не применена: ${issues[0].message}`, { issues });
    const viewer = viewerFor(p.sample, tree);
    const v: T.VersionOut = {
      id: uid('v'), number: p.versions.length + 1, parent_id: p.current, source, label, ok, frozen: false, is_current: true,
      rules_version: '2026.11-draft', summary: summaryFor(tree, viewer, issues), build_ms: 40 + Math.round(Math.random() * 60),
      created_at: iso(), tree: JSON.parse(JSON.stringify(tree)), schema_version: '0.2', module_versions: {}, issues, viewer,
      // «оценка» переходит в новую версию, кроме изменённых значений (как на сервере)
      estimated: estimated ?? (curVersion(p)?.estimated ?? []).filter((ptr) => JSON.stringify(getAt(curVersion(p)!.tree, ptr)) === JSON.stringify(getAt(tree, ptr))),
    };
    p.versions.forEach((x) => (x.is_current = false));
    if (p.current) p.undo.push(p.current);
    p.redo = [];
    p.versions.push(v);
    p.current = v.id;
    p.updated_at = iso();
    return v;
  };

  const modelState = (p: MProject): T.ModelStateOut => {
    const v = curVersion(p);
    if (!v) throw new ApiError(404, 'model_missing', 'Модель ещё не построена');
    p.versions.forEach((x) => { x.is_current = x.id === v.id; x.frozen = x.id === p.frozen_version_id; });
    return { version: JSON.parse(JSON.stringify(v)), can_undo: p.undo.length > 0, can_redo: p.redo.length > 0, frozen_version_id: p.frozen_version_id };
  };

  const measured = (p: MProject) => p.measurements.length > 0 && ['measured', 'contract', 'in_work', 'delivered'].includes(p.status);

  const estimateOf = (p: MProject): T.ProjectEstimate | null => {
    const v = curVersion(p);
    if (!v || !v.ok || !p.sample) return null;
    const sm = SAMPLES[srcOf(p.sample, v.tree)];
    return role === 'owner' ? masterEstimate(sm, v.viewer, measured(p), pricing) : staffEstimate(sm, v.viewer, measured(p), pricingK(pricing));
  };
  const totalOf = (p: MProject): T.PriceRange | null => {
    const v = curVersion(p);
    if (!v || !v.ok || !p.sample) return null;
    return clientEstimate(SAMPLES[srcOf(p.sample, v.tree)], v.viewer, 'total', measured(p), pricingK(pricing)).total;
  };

  const getP = (id: string): MProject => {
    const p = projects.find((x) => x.id === id);
    if (!p) throw new ApiError(404, 'not_found', 'Проект не найден');
    return p;
  };
  const clientBrief = (id: string | null): T.ClientBrief | null => {
    const c = clients.find((x) => x.id === id);
    return c ? { id: c.id, name: c.name, phone: c.phone } : null;
  };
  /** Подсказка строки списка: заказ EMAN готов / ссылку открыли / не открывали. */
  const activityOf = (p: MProject): T.ProjectListItem['activity'] => {
    const o = orders.find((x) => x.project_id === p.id && x.status !== 'cancelled' && x.status !== 'issued');
    if (o) return o.status === 'ready' ? { text: 'готов — забрать в EMAN', tone: 'green' } : { text: `заказ EMAN №${o.number}`, tone: 'gray' };
    const l = p.links.filter((x) => !x.revoked_at).slice(-1)[0];
    if (!l || p.status !== 'sent') return null;
    if (l.views > 0) return { text: `открыл ${l.views} ${l.views % 10 >= 2 && l.views % 10 <= 4 && (l.views % 100 < 12 || l.views % 100 > 14) ? 'раза' : 'раз'}`, tone: 'green' };
    const days = Math.floor((now() - Date.parse(l.created_at)) / DAY);
    return days >= 1 ? { text: `не открыл ${days} дн.`, tone: 'amber' } : null;
  };
  const listItem = (p: MProject): T.ProjectListItem => ({
    id: p.id, title: p.title, status: p.status, status_label: STATUS_LABELS[p.status], product_type: p.sample ? SAMPLES[p.sample].productKind : null,
    is_example: p.is_example, client: clientBrief(p.client_id), current_version_id: p.current, client_agreed_at: p.client_agreed_at,
    archived_at: p.archived_at, created_at: p.created_at, updated_at: p.updated_at, price: totalOf(p), activity: activityOf(p),
  });
  const card = (p: MProject): T.ProjectCardOut => {
    const actions = p.archived_at ? [{ code: 'unarchive', label: 'Вернуть из архива', to_status: null }] : [...ACTIONS[p.status]];
    if (!p.archived_at && TRANSITIONS[p.status].includes('cancelled')) actions.push({ code: 'cancel', label: 'Отменить проект', to_status: 'cancelled' });
    return {
      ...listItem(p), source_text: p.source_text, frozen_version_id: p.frozen_version_id, charged: p.charged,
      charge_period: p.charged ? limits.period : null, returned_to_limit: p.status === 'in_work', contract_at: p.contract_at,
      delivered_at: p.delivered_at, materials_self_bought: p.materials_self_bought, cancelled_at: p.cancelled_at,
      cancel_reason: p.cancel_reason, has_order: orders.some((o) => o.project_id === p.id), photos: p.photos,
      model_summary: curVersion(p)?.summary ?? null, estimate: estimateOf(p), next_step: NEXT_STEP[p.status], actions,
    };
  };
  const setStatus = (p: MProject, to: T.ProjectStatus) => {
    if (p.archived_at) throw new ApiError(409, 'project_archived', 'Проект в архиве — сначала верните его из архива');
    if (!TRANSITIONS[p.status].includes(to)) {
      throw new ApiError(409, 'illegal_transition', `Нельзя перейти из «${STATUS_LABELS[p.status]}» в «${STATUS_LABELS[to]}». Сейчас: ${NEXT_STEP[p.status]}`);
    }
    p.status = to;
    p.updated_at = iso();
  };
  const requireValid = (p: MProject, to: T.ProjectStatus) => {
    const v = curVersion(p);
    if (!v) throw new ApiError(409, 'model_missing', `Нельзя перевести в «${STATUS_LABELS[to]}»: модель ещё не построена`);
    if (!v.ok) throw new ApiError(409, 'model_invalid', `Нельзя перевести в «${STATUS_LABELS[to]}»: в модели есть ошибки — ${v.issues.filter((i) => i.level === 'error').map((i) => i.message).slice(0, 3).join('; ')}`);
    return v;
  };

  // ----- заказы, нестандарт, «под запрос» -----
  const orders: T.OrderOut[] = [];
  const nonstandard: (T.NonstandardOut & { project_id: string })[] = [];
  const priceRequests: T.PriceRequestOut[] = [];
  let orderSeq = 1250;
  const NS_LABELS: Record<T.NonstandardStatus, string> = { sent: 'Отправлена', estimated: 'Оценена', in_work: 'В работе', done: 'Готово', cancelled: 'Отменена' };
  const nsSteps = (st: T.NonstandardStatus) => (['sent', 'estimated', 'in_work', 'done'] as T.NonstandardStatus[]).map((x, i, all) => ({ status: x, label: NS_LABELS[x], done: st !== 'cancelled' && all.indexOf(st) >= i }));
  const preview = (p: MProject, km: number | null | undefined): T.OrderPreview => {
    const v = curVersion(p);
    const e = estimateOf(p);
    if (!v || !e) throw new ApiError(409, 'model_invalid', 'Нужна модель без ошибок');
    const sheets = Object.entries(e.sheets);
    const lines: T.OrderLine[] = sheets.map(([m, n], i) => ({ key: `sheet:${m}`, name: DECORS.find((d) => d.id === m)?.name ?? m, unit: 'лист', qty: n, price: 520_000 + i * 150_000, total: n * (520_000 + i * 150_000) }));
    const nSheets = sheets.reduce((a, [, n]) => a + n, 0);
    lines.push({ key: 'service:cut:ldsp', name: 'Распил ЛДСП (пакетный)', unit: 'лист', qty: nSheets, price: 50_000, total: nSheets * 50_000 });
    lines.push({ key: 'edge:pvc_2:body', name: 'Кромкование ПВХ 2 мм', unit: 'м', qty: 38.5, price: 6_000, total: 231_000 });
    lines.push({ key: 'hw:hinge', name: 'Петля 110° с доводчиком', unit: 'шт', qty: 8, price: 24_000, total: 192_000 });
    const pending = priceRequests.filter((r) => r.project_id === p.id && r.status !== 'accepted');
    const goods = lines.reduce((a, l) => a + l.total, 0);
    const weight = Math.round(nSheets * 63);
    const delivery = km == null ? null : { weight_kg: weight, distance_km: km, cost: 60_000 + Math.max(0, Math.ceil(km - 4)) * 8_000 + Math.ceil(weight / 50) * 5_000, breakdown: { 'Базовая доставка': 60_000 } };
    return { lines, excluded: ['ХДФ 3 Белый', ...pending.map((r) => r.name)].filter((x, i, a) => a.indexOf(x) === i), goods_total: goods, delivery, total: goods + (delivery?.cost ?? 0), weight_kg: weight };
  };
  const orderSteps = (o: T.OrderOut): T.OrderStep[] => T_ORDER_FLOW.map((st, i) => ({ status: st, label: ORDER_LABELS[st], done: o.status !== 'cancelled' && T_ORDER_FLOW.indexOf(o.status) >= i, current: o.status === st, at: st === 'created' ? o.created_at : o.status !== 'cancelled' && T_ORDER_FLOW.indexOf(o.status) > i ? new Date(new Date(o.created_at).getTime() + i * 5.3 * 3600_000).toISOString() : null }));

  // ----- начальные проекты -----
  const seed = (title: string, sample: SampleKey | null, status: T.ProjectStatus, client: string | null, ago: number, extra: Partial<MProject> = {}) => {
    const p = baseProject({ title, status: 'draft', client_id: client, created_at: iso(ago), updated_at: iso(ago / 2), ...extra });
    if (sample) {
      p.sample = sample;
      createVersion(p, SAMPLES[sample].tree, 'ai', 'Эскиз по фото', false, ['/height', '/depth']);
      p.chat.push({ id: uid('m'), author: 'ai', text: `Готово: ${SAMPLES[sample].title.ru.toLowerCase()}. Размеры с фото помечены «оценка» — проверьте их.`, version_id: p.current, undone: false, created_at: iso(ago) });
    }
    p.status = status;
    p.charged = status !== 'draft';
    if (['measured', 'contract', 'in_work', 'delivered'].includes(status)) {
      p.measurements.push({ id: uid('ms'), version_id: p.current, width: SAMPLES[sample!].tree.width ?? null, height: SAMPLES[sample!].tree.height ?? null, depth: SAMPLES[sample!].tree.depth ?? null, data: {}, notes: null, created_at: iso(ago / 3) });
    }
    if (['contract', 'in_work', 'delivered'].includes(status)) { p.frozen_version_id = p.current; p.contract_at = iso(ago / 4); p.client_agreed_at = iso(ago / 4); }
    if (['sent', 'measured', 'contract', 'in_work', 'delivered'].includes(status)) {
      p.links.push({ id: uid('l'), token: 'demo', url: `${SHARE_URL}/demo`, version_id: p.current!, language: 'ru', estimate_view: 'short', show_price: true, expires_at: iso(-29 * DAY), revoked_at: null, views: 3, ar_starts: 1, ar_failures: 0, first_opened_at: iso(ago / 3), agreed_at: null, created_at: iso(ago / 2) });
    }
    projects.push(p);
    return p;
  };
  // декор фасадов, подсветка, встройка — сидят первыми, чтобы прежние проекты оставались сверху списка (образцы ядра schemas/samples/*_decor, *_builtin)
  seed('Шкаф с латунной рамкой', 'wardrobe_decor', 'sketch', 'c-1', 6 * 3600_000, { id: 'p-decor' });
  seed('Кухня зелёная, Gola', 'kitchen_decor', 'sketch', 'c-2', 8 * 3600_000, { id: 'p-kitchen-decor' });
  seed('Встроенный шкаф в нишу', 'wardrobe_builtin', 'sent', 'c-1', 10 * 3600_000, { id: 'p-builtin' });
  seed('Кухня до потолка', 'kitchen_builtin', 'sketch', null, 12 * 3600_000, { id: 'p-kitchen-builtin' });
  seed('Шкаф для Азизы', 'wardrobe_full', 'sent', 'c-1', 2 * DAY, { id: 'p-aziza' });
  const kupe = seed('Купе в прихожую', 'kupe_3doors', 'measured', 'c-2', 5 * DAY, { id: 'p-kupe', client_agreed_at: iso(3 * 3600_000) });
  priceRequests.push(
    { id: 'pr-1', project_id: kupe.id, line_key: 'hw:profile', name: 'Профиль купе бронза', unit: 'м', qty: 14.4, status: 'priced', price: 52_000, total: 748_800, estimate_price: 48_000, delta: 57_600, lead_days: 3, supplier_name: 'EMAN', note: null, priced_at: iso(DAY), valid_until: iso(-6 * DAY), expired: false },
    { id: 'pr-2', project_id: kupe.id, line_key: 'sheet:hdf_3_white', name: 'ХДФ 3 Белый', unit: 'лист', qty: 2, status: 'pending', price: null, total: null, estimate_price: 165_000, delta: null, lead_days: null, supplier_name: null, note: null, priced_at: null },
  );
  seed('Шкаф в нишу, спальня', 'wardrobe_3sec_niche', 'sketch', null, DAY, { id: 'p-niche' });
  // пенал 820×450×1800, размеры — оценка, чат пуст: быстрые значения и границы по типу, подсказки в шторке
  const pencil = seed('Пенал · Азиза', null, 'draft', 'c-1', 3600_000, { id: 'p-pencil', sample: 'wardrobe_2sec' });
  createVersion(pencil, {
    schema_version: '0.2', type: 'wardrobe', width: 820, height: 1800, depth: 450, body: { material: 'ldsp_16_white' },
    sections: [{ fill: [{ kind: 'drawers', count: 2, height: 400 }, { kind: 'shelves', count: 3 }], doors: { count: 2 } }],
  }, 'ai', 'Эскиз по фото', false, ['/width', '/height', '/depth']);
  pencil.status = 'sketch'; pencil.charged = true;
  const kitchen = seed('Кухня Нигоры', 'kitchen_straight', 'in_work', 'c-3', 14 * DAY, { id: 'p-kitchen', filesPaid: true });
  seed('Стеллаж в кабинет', null, 'draft', null, 3 * 3600_000, { id: 'p-shelf', source_text: 'стеллаж 1,2 м, две секции, полки' });
  // архив (Archive.dc.html): сданные и убранные в архив — в основной список не попадают
  seed('Кухня угловая', 'kitchen_straight', 'delivered', null, 30 * DAY, { id: 'p-arch-1', archived_at: iso(22 * DAY) });
  seed('Тумба ТВ', 'wardrobe_2sec', 'delivered', null, 40 * DAY, { id: 'p-arch-2', archived_at: iso(31 * DAY) });
  orders.push(
    { id: 'o-1', number: '1234', project_id: kitchen.id, project_title: kitchen.title, total: 14_850_000, status: 'cutting', ready_date: iso(-2 * DAY), created_at: iso(6 * DAY),
      payment: { status: 'paid', method: 'click', url: null },
      items: [{ name: 'ЛДСП 16 Белый', qty: 6, unit: 'лист', amount: 2_520_000 }, { name: 'ЛДСП 18 Дуб сонома', qty: 3, unit: 'лист', amount: 1_680_000 }, { name: 'Распил и кромкование', qty: 1, unit: 'усл.', amount: 1_450_000 }, { name: 'Фурнитура', qty: 1, unit: 'компл.', amount: 3_900_000 }, { name: 'Столешница 38 мм', qty: 1, unit: 'шт', amount: 5_300_000 }, { name: 'Мойка врезная (под запрос)', qty: 1, unit: 'шт', amount: 0, excluded: true }],
      documents: [{ kind: 'invoice', title: 'Счёт EMAN №1234' }] },
    { id: 'o-2', number: '1240', project_id: kitchen.id, project_title: `${kitchen.title} (доп.)`, total: 820_000, status: 'created', ready_date: null, created_at: iso(DAY),
      payment: { status: 'waiting', method: 'payme', url: 'https://eman.uz/pay/demo-1240' },
      items: [{ name: 'Ручка-скоба 128 мм', qty: 14, unit: 'шт', amount: 308_000 }, { name: 'Доводчик', qty: 8, unit: 'шт', amount: 512_000 }], documents: [] },
  );

  // ----- уведомления мастера (Notifications.dc.html) -----
  const notifications: T.NotificationOut[] = [
    { id: 'n-1', kind: 'share_opened', title: 'Азиза открыла ссылку', body: 'Смотрела 3D 4 минуты · Шкаф для Азизы', data: null, status: null, project_id: 'p-aziza', read: false, created_at: iso(12 * 60_000) },
    { id: 'n-2', kind: 'order_status', title: 'EMAN: заказ № 1234 в распиле', body: 'Готов 5 ноября · Кухня Нигоры', data: { order_id: 'o-1' }, status: 'cutting', project_id: 'p-kitchen', read: false, created_at: iso(2 * 3600_000) },
    { id: 'n-3', kind: 'price_request_priced', title: 'Пришла цена под запрос', body: 'Профиль купе бронза: 52 000 сум за м · Купе в прихожую', data: null, status: null, project_id: 'p-kupe', read: true, created_at: iso(DAY) },
    { id: 'n-4', kind: 'model_ready', title: 'Модель готова', body: 'Шкаф в нишу, спальня', data: null, status: null, project_id: 'p-niche', read: true, created_at: iso(DAY + 3 * 3600_000) },
    { id: 'n-5', kind: 'client_agreed', title: 'Клиент согласовал эскиз', body: 'Кухня Нигоры', data: null, status: null, project_id: 'p-kitchen', read: true, created_at: iso(9 * DAY) },
  ];

  // ----- настройки уведомлений (Misc.dc.html) и платежи (PayHistory.dc.html) -----
  const NOTIF_TYPES: [T.NotificationTypeKey, string, string][] = [
    ['client_opened', 'Клиент открыл ссылку', 'и запустил AR'], ['client_agreed', 'Клиент согласовал', 'с выбранным вариантом'],
    ['model_ready', 'Модель готова', 'если собиралась долго'], ['order_status', 'Заказ EMAN', 'оплата, распил, готов'],
    ['prices_stale', 'Цены изменились', 'в отправленных сметах'], ['price_request', 'Пришла цена под запрос', 'от EMAN или партнёра'],
    ['nonstandard', 'Нестандарт', 'оценка и готовые файлы'],
  ];
  const notifSettings: T.NotificationSettingsOut = {
    types: NOTIF_TYPES.map(([key, title, subtitle]) => ({ key, title, subtitle, enabled: true })),
    quiet: { enabled: true, from: '22:00', to: '08:00', timezone: 'Asia/Tashkent', silent: true },
  };
  const payments: T.PaymentOut[] = [
    { id: 'pay-1', kind: 'pack', title: 'Пакет 10 проектов', amount: 125_000, currency: 'UZS', method: 'app_store', method_label: 'App Store', status: 'paid', paid_at: iso(DAY), refunded_at: null, receipt_url: null, project_id: null, project_title: null },
    { id: 'pay-2', kind: 'files', title: 'Файлы проекта «Стеллаж»', amount: 45_000, currency: 'UZS', method: 'payme', method_label: 'Payme', status: 'paid', paid_at: iso(6 * DAY), refunded_at: null, receipt_url: 'https://payme.uz', project_id: 'p-shelf', project_title: 'Стеллаж в кабинет' },
    { id: 'pay-3', kind: 'pro', title: 'Pro · октябрь', amount: 150_000, currency: 'UZS', method: 'click', method_label: 'Click', status: 'refunded', paid_at: iso(33 * DAY), refunded_at: iso(31 * DAY), receipt_url: null, project_id: null, project_title: null },
  ];

  // ----- ИИ -----
  const enqueue = (ms: number, run: () => unknown): T.TaskAccepted => {
    const id = uid('t');
    tasks.set(id, { readyAt: now() + ms, run });
    return { task_id: id };
  };

  const elementsFromTree = (tree: T.ProductTree, sure: boolean): T.DesignElement[] => {
    const els: T.DesignElement[] = [{ name: 'Корпус', kind: 'body', count: 1, sure: true }];
    const secs = tree.sections ?? [];
    if (secs.length) els.push({ name: 'Секции', kind: 'section', count: secs.length, sure });
    const doors = secs.reduce((s, x) => s + (x.doors?.count ?? 0), 0);
    if (doors) els.push({ name: 'Двери распашные', kind: 'door', count: doors, sure: true });
    if (tree.sliding_doors) els.push({ name: 'Двери-купе', kind: 'sliding_door', count: tree.sliding_doors.count ?? 2, sure: true, note: tree.sliding_doors.fills?.includes('mirror') ? 'зеркало посередине' : null });
    const drawers = secs.reduce((s, x) => s + (x.fill ?? []).reduce((a, z) => a + (z.kind === 'drawers' ? Number((z as { count?: number }).count ?? 1) : 0), 0), 0);
    if (drawers) els.push({ name: 'Ящики', kind: 'drawer', count: drawers, sure: false, note: 'может быть полкой' });
    const shelves = secs.reduce((s, x) => s + (x.fill ?? []).reduce((a, z) => a + (z.kind === 'shelves' ? Number((z as { count?: number }).count ?? 1) : 0), 0), 0);
    if (shelves) els.push({ name: 'Полки', kind: 'shelf', count: shelves, sure });
    if (secs.some((x) => (x.fill ?? []).some((z) => z.kind === 'rod'))) els.push({ name: 'Штанга', kind: 'rod', count: 1, sure: false });
    if (tree.mezzanine) els.push({ name: 'Антресоль', kind: 'mezzanine', count: 1, sure: true });
    if (tree.type === 'kitchen') els.push({ name: 'Модули кухни', kind: 'module', count: 10, sure: false }, { name: 'Столешница', kind: 'countertop', count: 1, sure: true });
    return els;
  };

  const parseNumbers = (text: string) => {
    const t = text.toLowerCase().replace(',', '.');
    const m = /(\d+(?:\.\d+)?)\s*(м\b|метр|metr|m\b)/.exec(t);
    const mm = /(\d{3,4})\s*(мм|mm)/.exec(t);
    const width = m ? Math.round(parseFloat(m[1]) * 1000) : mm ? Number(mm[1]) : null;
    const doorsWord = /(три|3|uch)\s*(двер|eshik)/.test(t) ? 3 : /(две|два|2|ikki)\s*(двер|eshik)/.test(t) ? 2 : null;
    return { width, doors: doorsWord, mirror: /зеркал|oyna/.test(t) };
  };

  const finishDesign = (p: MProject, sample: SampleKey, tree: T.ProductTree, estimated: string[], extra: Partial<T.DesignOut> = {}): T.DesignOut => {
    p.sample = sample;
    const v = createVersion(p, tree, 'ai', 'Эскиз ИИ', false, estimated);
    const total = totalOf(p);
    p.chat.push({ id: uid('m'), author: 'ai', text: `Готово: ${SAMPLES[sample].title.ru.toLowerCase()} ${tree.width ?? ''}×${tree.height ?? ''}×${tree.depth ?? ''} мм. Цена ${formatRange(total, 'ru')}. Размеры с пометкой «оценка» проверьте.`, version_id: v.id, undone: false, created_at: iso() });
    p.design = null;
    return {
      status: 'ready', product_kind: SAMPLES[sample].productKind, confidence: 0.86, alternatives: [],
      elements: elementsFromTree(tree, estimated.length === 0), understood: [], unclear: [], estimated, questions: [], differences: [],
      message: null, version_id: v.id, issues: v.issues, error: null, ...extra,
    };
  };

  const design = (p: MProject, body: T.DesignIn): T.DesignOut => {
    const text = (body.text ?? '').trim();
    const photos = body.photo_ids?.length ?? 0;
    const tl = text.toLowerCase();
    if (/ошибк|не мебель|xato/.test(tl)) {
      return { status: 'failed', product_kind: null, confidence: 0, alternatives: [], elements: [], understood: [], unclear: [], estimated: [], questions: [], differences: [], message: 'Не вижу мебель на фото', version_id: null, issues: [], error: 'not_furniture' };
    }
    const sample: SampleKey = /купе|kupe/.test(tl) ? 'kupe_3doors' : /кухн|oshxona/.test(tl) ? 'kitchen_straight' : /стеллаж|stellaj/.test(tl) ? 'wardrobe_2sec' : /ниш|nisha/.test(tl) ? 'wardrobe_3sec_niche' : 'wardrobe_full';
    if (!photos && text && text.length < 8) {
      return { status: 'choose_type', product_kind: null, confidence: 0.35, alternatives: [{ product_kind: 'wardrobe', confidence: 0.35 }, { product_kind: 'wardrobe_sliding', confidence: 0.3 }, { product_kind: 'rack', confidence: 0.2 }], elements: [], understood: [], unclear: [text], estimated: [], questions: [], differences: [], message: 'Не уверен, какое это изделие', version_id: null, issues: [], error: null };
    }
    let tree: T.ProductTree = JSON.parse(JSON.stringify(SAMPLES[sample].tree));
    const n = parseNumbers(text);
    const understood: string[] = [];
    const estimated = new Set(['/width', '/height', '/depth']);
    if (text) understood.push(`Изделие: ${SAMPLES[sample].title.ru.toLowerCase()}`);
    if (n.width && tree.width) { tree = applyPatch(tree, [{ op: 'replace', path: '/width', value: n.width }]); estimated.delete('/width'); understood.push(`Ширина ${n.width} мм`); }
    if (n.doors && tree.sliding_doors) understood.push(`Дверей: ${n.doors}`);
    if (n.mirror) understood.push('Зеркало на средней двери');
    const unclear = text ? ['Высота — взял типовую 2400 мм', 'Глубина — взял типовую 600 мм', 'Наполнение секций — по умолчанию'] : [];
    if (photos) {
      const questions: T.DesignQuestion[] = [
        { id: 'q_width', text: 'Какая ширина ниши или места?', options: ['1800 мм', '2000 мм', '2400 мм'], default: `${tree.width} мм`, affects: ['/width'] },
        { id: 'q_ends', text: 'Торцы шкафа открытые (видно сбоку)?', options: ['Да, оба', 'Один открыт', 'Нет, в нише'], default: 'Да, оба', affects: ['/installation'] },
        { id: 'q_fronts', text: 'Какой материал фасадов?', options: ['Дуб сонома', 'Белый', 'Серый'], default: 'Дуб сонома', affects: ['/fronts/material'] },
      ];
      // Несколько фото → на первом «несколько предметов»: рамки и вопрос `object` (всего ≤ 3 вопросов).
      const objects: T.DesignObject[] = photos >= 2
        ? [{ label: 'Шкаф слева', photo: 0, box: [0.04, 0.08, 0.52, 0.95], chosen: true, size: [1200, 600, 2200], summary: '2 двери' },
          { label: 'Комод справа', photo: 0, box: [0.58, 0.5, 0.96, 0.92], chosen: false, size: [800, 450, 900], summary: '3 ящика' }]
        : [];
      if (objects.length) {
        questions.splice(1, 1);
        questions.unshift({ id: 'object', text: 'На фото несколько предметов. Какой нужен?', options: objects.map((o) => o.label), default: objects[0].label, affects: [] });
      }
      p.design = { sample, tree, estimated: [...estimated], questions, objects };
      p.aiAnswers = {};
      for (const q of questions) p.chat.push({ id: uid('m'), author: 'ai', kind: 'question', text: q.text, options: q.options, undone: false, created_at: iso() });
      return { objects, status: 'questions', product_kind: SAMPLES[sample].productKind, confidence: 0.82, alternatives: [], elements: elementsFromTree(tree, false), understood, unclear, estimated: [...estimated], questions, differences: sample === 'wardrobe_full' ? ['Радиусный торец на фото — в модели прямой (скругление добавьте в редакторе)'] : [], message: null, version_id: null, issues: [], error: null };
    }
    return finishDesign(p, sample, tree, [...estimated], { understood, unclear });
  };

  const answer = (p: MProject, given: Record<string, string>): T.DesignOut => {
    const d = p.design ?? { sample: 'wardrobe_full' as SampleKey, tree: SAMPLES.wardrobe_full.tree, estimated: ['/width', '/height', '/depth'], questions: [] };
    // реплика мастера — «вопрос — ответ»; ответы копятся за всю сессию
    const asked = Object.fromEntries(d.questions.map((q) => [q.id, q]));
    p.chat.push({ id: uid('m'), author: 'master', kind: 'answer', undone: false, created_at: iso(),
      text: Object.entries(given).map(([k, v]) => `${asked[k]?.text ?? k} — ${v === 'не знаю' ? `по умолчанию (${asked[k]?.default ?? '—'})` : v}`).join('\n') });
    const answers = { ...(p.aiAnswers ?? {}), ...given };
    p.aiAnswers = answers;
    // в нише — второй раунд: высота ниши (как настоящий ИИ, только если ещё не спрашивали)
    if (/ниш|nisha|нет/i.test(answers.q_ends ?? '') && !answers.q_niche_h) {
      const q: T.DesignQuestion = { id: 'q_niche_h', text: 'Ниша до потолка — какая высота?', options: ['2400 мм', '2600 мм', '2700 мм'], default: '2600 мм', affects: ['/height'] };
      p.design = { ...d, questions: [q] };
      p.chat.push({ id: uid('m'), author: 'ai', kind: 'question', text: q.text, options: q.options, undone: false, created_at: iso() });
      return { status: 'questions', product_kind: SAMPLES[d.sample].productKind, confidence: 0.84, alternatives: [], elements: elementsFromTree(d.tree, false), understood: [], unclear: [], estimated: d.estimated, questions: [q], differences: [], message: null, version_id: null, issues: [], error: null, answers };
    }
    let tree = d.tree;
    const est = new Set(d.estimated);
    const w = answers.q_width && /(\d{3,4})/.exec(answers.q_width);
    if (w) { tree = applyPatch(tree, [{ op: 'replace', path: '/width', value: Number(w[1]) }]); est.delete('/width'); }
    else est.add('/width');
    if (answers.q_ends) tree = applyPatch(tree, [{ op: 'replace', path: '/installation', value: /ниш|nisha|нет/i.test(answers.q_ends) ? 'niche' : 'freestanding' }]);
    else est.add('/installation');
    const f = answers.q_fronts ?? '';
    const mat = /бел|oq/i.test(f) ? 'ldsp_18_white' : /сер|kul/i.test(f) ? 'ldsp_16_grey' : /дуб|eman/i.test(f) ? 'ldsp_18_oak' : null;
    if (mat && tree.fronts) tree = applyPatch(tree, [{ op: 'replace', path: '/fronts/material', value: mat }]);
    else if (tree.fronts) est.add('/fronts/material');
    const nh = answers.q_niche_h && /(\d{4})/.exec(answers.q_niche_h);
    if (nh && tree.height) { tree = applyPatch(tree, [{ op: 'replace', path: '/height', value: Number(nh[1]) }]); est.delete('/height'); }
    return finishDesign(p, d.sample, tree, [...est], { answers });
  };

  const edit = (p: MProject, instruction: string): T.EditOut => {
    const v = curVersion(p);
    if (!v) return { ok: false, summary: null, question: 'Сначала нужна модель — опишите изделие или пришлите фото', version_id: null, price_delta: null, issues: [], error: null };
    const t = instruction.toLowerCase();
    const before = totalOf(p);
    let tree = v.tree;
    const changes: string[] = [];
    const num = (re: RegExp) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
    const w = num(/(?:шир\S*|kengl\S*)\D{0,12}(\d{3,4})/); if (w && tree.width) { tree = applyPatch(tree, [{ op: 'replace', path: '/width', value: w }]); changes.push(`ширина ${w} мм`); }
    const h = num(/(?:выс\S*|baland\S*)\D{0,12}(\d{3,4})/); if (h && tree.height) { tree = applyPatch(tree, [{ op: 'replace', path: '/height', value: h }]); changes.push(`высота ${h} мм`); }
    const d = num(/(?:глуб\S*|chuqur\S*)\D{0,12}(\d{3,4})/); if (d && tree.depth) { tree = applyPatch(tree, [{ op: 'replace', path: '/depth', value: d }]); changes.push(`глубина ${d} мм`); }
    if (/антресол|antresol/.test(t) && !tree.mezzanine && tree.type !== 'kitchen') { tree = applyPatch(tree, [{ op: 'add', path: '/mezzanine', value: { height: 400 } }]); changes.push('добавлена антресоль'); }
    if (/(ящик|tortma)/.test(t) && tree.sections?.length) {
      const i = tree.sections.findIndex((s) => !(s.fill ?? []).some((z) => z.kind === 'drawers'));
      if (i >= 0) { tree = applyPatch(tree, [{ op: 'add', path: `/sections/${i}/fill/0`, value: { kind: 'drawers', count: 2, height: 400 } }]); changes.push(`2 ящика в секции ${i + 1}`); }
    }
    if (/без ручек|ruchkasiz|push/.test(t) && tree.fronts) { tree = applyPatch(tree, [{ op: 'replace', path: '/fronts/handles', value: { kind: 'none' } }]); changes.push('фасады без ручек'); }
    if (/бел|oq rang/.test(t) && /фасад|fasad/.test(t) && tree.fronts) { tree = applyPatch(tree, [{ op: 'replace', path: '/fronts/material', value: 'ldsp_18_white' }]); changes.push('белые фасады'); }
    if (!changes.length) {
      return { ok: false, summary: null, question: 'Уточните, что изменить: размеры (например «ширина 2000»), наполнение («добавь ящики») или фасады («белые фасады»)?', version_id: null, price_delta: null, issues: [], error: null };
    }
    try {
      const nv = createVersion(p, tree, 'ai', changes.join(', '), true);
      const after = totalOf(p);
      const delta = before && after ? { from: Math.round((before.from + before.to) / 2), to: Math.round((after.from + after.to) / 2) } : null;
      return { ok: true, summary: `Сделал: ${changes.join(', ')}`, question: null, version_id: nv.id, price_delta: delta, issues: nv.issues, error: null };
    } catch (e) {
      return { ok: false, summary: null, question: null, version_id: null, price_delta: null, issues: [], error: (e as Error).message };
    }
  };

  const startAi = (p: MProject, ms: number, confirmExtra: boolean | undefined, billable: boolean, run: () => unknown) => {
    if (billable) {
      if (p.aiEdits >= aiBudget && !confirmExtra) {
        throw new ApiError(402, 'ai_budget_exhausted', 'Бюджет ИИ-правок в этом проекте исчерпан. Следующая правка спишет ещё один проект из лимита', { free_left: limits.free_left });
      }
      if (p.aiEdits >= aiBudget && confirmExtra) {
        p.aiEdits = 0;
        limits.free_used += 1;
        limits.free_left = Math.max(0, limits.free_left - 1);
      }
      p.aiEdits += 1;
    }
    return enqueue(ms, run);
  };

  // ----- файлы -----
  const FILES: { kind: string; title: string; format: string; free?: boolean }[] = [
    { kind: 'offer_pdf', title: 'Коммерческое предложение', format: 'pdf', free: true },
    { kind: 'spec_xlsx', title: 'Спецификация деталей', format: 'xlsx' },
    { kind: 'cut_pdf', title: 'Карты раскроя', format: 'pdf' },
    { kind: 'parts_csv', title: 'Онлайн-крой EMAN', format: 'csv' },
    { kind: 'parts_dxf', title: 'Детали: контур, отв., R, пазы', format: 'zip' },
    { kind: 'drawings_pdf', title: 'Чертежи, присадка, вид', format: 'pdf' },
    { kind: 'hardware_xlsx', title: 'Ведомость фурнитуры', format: 'xlsx' },
    { kind: 'assembly_pdf', title: 'Схема сборки', format: 'pdf' },
    { kind: 'estimate_xlsx', title: 'Смета мастера (Excel)', format: 'xlsx' },
    { kind: 'model_glb', title: '3D-модель (GLB)', format: 'glb' },
  ];
  const fileOpen = (p: MProject, f: { free?: boolean }) => f.free || p.filesPaid || p.status === 'in_work' || p.status === 'delivered';
  const tinyPdf = (title: string) => {
    const txt = title.replace(/[^\x20-\x7e]/g, '?');
    const stream = `BT /F1 18 Tf 60 760 Td (Eskiz AI demo) Tj 0 -30 Td (${txt}) Tj ET`;
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let out = '%PDF-1.4\n';
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return out;
  };

  const translitKind = (p: MProject) => (p.sample ?? 'project');

  const api: Api = {
    mode: 'mock',
    requestCode: (phone) => wait(() => {
      if (phone.replace(/\D/g, '').length < 12) throw new ApiError(422, 'invalid_phone', 'Введите номер полностью: +998 XX XXX XX XX');
      return { phone, channel: 'telegram', expires_in: 300, resend_in: 60, code_length: 5 };
    }),
    verifyCode: (body) => wait(() => {
      if (body.code !== '00000') throw new ApiError(400, 'code_invalid', 'Неверный код. Осталось попыток: 4', { attempts_left: 4 });
      user.phone = body.phone;
      const isNew = userIsNew;
      userIsNew = false;
      const digits = body.phone.replace(/\D/g, '');
      if (isNew && (digits.endsWith('0000') || digits.endsWith('0001'))) {
        myInvite = { ...makeInvite(body.phone, { name: '', title: 'Замерщик' }, digits.endsWith('0001')), workshop: { id: 'w-2', name: 'Мебель Плюс', city: 'Ташкент' } };
      }
      return { access_token: 'mock-access', refresh_token: 'mock-refresh', token_type: 'bearer', expires_in: 3600, user: { ...user }, is_new_user: isNew, invite: myInvite };
    }),
    me: () => wait(() => ({ ...user })),
    updateMe: (body) => wait(() => { Object.assign(user, Object.fromEntries(Object.entries(body).filter(([, v]) => v != null))); return { ...user }; }),
    logout: () => wait(undefined),
    myInvite: () => wait(() => myInvite),
    acceptInvite: (id) => wait(() => {
      if (!myInvite || myInvite.id !== id) throw new ApiError(404, 'not_found', 'Приглашение не найдено');
      if (myInvite.status === 'expired') throw new ApiError(410, 'invite_expired', 'Приглашение устарело. Попросите владельца цеха отправить его заново');
      Object.assign(user, { role: 'employee', title: myInvite.title, can_see_cost: myInvite.can_see_cost, can_order: myInvite.can_order, workshop_id: myInvite.workshop.id });
      workshop = { ...workshop, id: myInvite.workshop.id, name: myInvite.workshop.name, city: myInvite.workshop.city };
      myInvite = null;
      return { access_token: 'mock-access', refresh_token: 'mock-refresh', token_type: 'bearer', expires_in: 3600, user: { ...user }, is_new_user: false, invite: null };
    }),
    declineInvite: (id) => wait(() => { if (myInvite?.id === id) myInvite = null; }),
    requestDeleteCode: (channel = 'sms') => wait(() => ({ phone: user.phone, channel, expires_in: 300, resend_in: 60, code_length: 5 })),
    deleteAccount: (code) => wait(() => {
      if (code !== '00000') throw new ApiError(400, 'code_invalid', 'Неверный код. Осталось попыток: 4', { attempts_left: 4 });
      projects.splice(0); clients.splice(0); invites.splice(0); userIsNew = true;
      return { ok: true, scope: user.role === 'employee' ? 'user' as const : 'workshop' as const };
    }),
    appStatus: (platform, version) => wait(() => {
      const mode = opts.appStatus ?? MOCK_STATUS;
      const notes = { ru: ['Угловые кухни в редакторе', 'Замер кухни по стенам'], uz: ['Tahrirlovchida burchakli oshxonalar', 'Oshxonani devorlar bo‘yicha o‘lchash'] };
      const until = new Date(now() + 40 * 60_000).toISOString();
      return {
        platform, version, min_version: mode === 'required' ? '99.0.0' : '0.0.0', latest_version: mode === 'optional' ? '99.0.0' : version,
        update: mode === 'required' ? 'required' : mode === 'optional' ? 'optional' : 'none',
        store_url: platform === 'android' ? 'https://play.google.com/store/apps/details?id=uz.mebel.master' : 'https://apps.apple.com/app/id0000000000',
        store_urls: { ios: 'https://apps.apple.com/app/id0000000000', android: 'https://play.google.com/store/apps/details?id=uz.mebel.master' },
        release_notes: mode === 'optional' ? notes : { ru: [], uz: [] },
        maintenance: { on: mode === 'maintenance', until: mode === 'maintenance' ? until : null, message: { ru: '', uz: '' } },
      };
    }),

    getWorkshop: () => wait(() => ({ ...workshop, ...(role === 'owner' ? { pricing } : {}) })),
    updateWorkshop: (body) => wait(() => { workshop = { ...workshop, ...body } as T.WorkshopOut; return { ...workshop, pricing }; }),
    getPricing: () => wait(() => {
      if (role !== 'owner') throw new ApiError(403, 'forbidden', 'Цены цеха видит только владелец');
      return { ...pricing };
    }),
    updatePricing: (body) => wait(() => {
      pricing = { ...pricing, ...body };
      workshop.default_estimate_view = pricing.default_estimate_view;
      workshop.employee_estimate_views = pricing.employee_estimate_views;
      return { ...pricing };
    }),
    listEmployees: () => wait(() => [...employees]),
    addEmployee: (phone, name) => api.inviteEmployee({ phone, name }),
    inviteEmployee: (body) => wait(() => {
      if (employees.some((e) => e.phone === body.phone)) throw new ApiError(409, 'phone_taken', 'Этот номер уже в вашем цехе');
      const old = invites.findIndex((i) => i.phone === body.phone);
      const inv = makeInvite(body.phone, body);
      if (old >= 0) invites.splice(old, 1, { ...inv, id: invites[old].id }); else invites.unshift(inv);
      return { ...invites[old >= 0 ? old : 0] };
    }),
    listInvites: () => wait(() => invites.map((i) => ({ ...i, status: Date.parse(i.expires_at) <= now() ? 'expired' as const : i.status }))),
    resendInvite: (id) => wait(() => {
      const i = invites.find((x) => x.id === id);
      if (!i) throw new ApiError(404, 'not_found', 'Приглашение не найдено');
      Object.assign(i, { status: 'pending', sent_at: new Date(now()).toISOString(), expires_at: new Date(now() + 7 * DAY).toISOString() });
      return { ...i };
    }),
    cancelInvite: (id) => wait(() => { const k = invites.findIndex((x) => x.id === id); if (k >= 0) invites.splice(k, 1); }),
    updateEmployee: (id, body) => wait(() => {
      const e = employees.find((x) => x.id === id);
      if (!e) throw new ApiError(404, 'not_found', 'Сотрудник не найден');
      if (e.role === 'owner') throw new ApiError(409, 'cannot_change_owner', 'Владелец видит и может всё');
      Object.assign(e, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
      return { ...e };
    }),
    removeEmployee: (id) => wait(() => {
      const e = employees.find((x) => x.id === id);
      if (!e) throw new ApiError(404, 'not_found', 'Сотрудник не найден');
      if (e.role === 'owner') throw new ApiError(409, 'cannot_remove_owner', 'Владельца цеха отключить нельзя');
      employees.splice(employees.indexOf(e), 1);
    }),
    limits: () => wait(() => ({ ...limits })),
    uploadLogo: (file) => wait(() => { workshop = { ...workshop, logo_url: file.uri }; return { ...workshop, pricing }; }),
    deleteLogo: () => wait(() => { workshop = { ...workshop, logo_url: null }; return { ...workshop, pricing }; }),
    listPayments: () => wait(() => payments.map((x) => ({ ...x }))),

    listClients: (q) => wait(() => {
      const ql = (q ?? '').toLowerCase();
      const items = clients.filter((c) => !ql || c.name.toLowerCase().includes(ql) || (c.phone ?? '').includes(ql.replace(/\D/g, '') || '§'));
      return { items, total: items.length, limit: 200, offset: 0 };
    }),
    createClient: (body) => wait(() => { const c: T.ClientOut = { id: uid('c'), name: body.name, phone: body.phone ?? null, address: body.address ?? null, notes: body.notes ?? null, created_at: iso(), updated_at: iso() }; clients.unshift(c); return c; }),
    getClient: (id) => wait(() => {
      const c = clients.find((x) => x.id === id);
      if (!c) throw new ApiError(404, 'not_found', 'Клиент не найден');
      return { ...c, projects: projects.filter((p) => p.client_id === id).map((p) => ({ id: p.id, title: p.title, status: p.status, status_label: STATUS_LABELS[p.status], created_at: p.created_at })) };
    }),
    updateClient: (id, body) => wait(() => { const c = clients.find((x) => x.id === id); if (!c) throw new ApiError(404, 'not_found', 'Клиент не найден'); Object.assign(c, body, { updated_at: iso() }); return { ...c }; }),

    listProjects: (q = {}) => wait(() => {
      const ql = (q.q ?? '').toLowerCase();
      const items = projects
        .filter((p) => (q.archived ? !!p.archived_at : !p.archived_at))
        .filter((p) => !q.status?.length || q.status.includes(p.status))
        .filter((p) => !q.client_id || p.client_id === q.client_id)
        .filter((p) => !ql || p.title.toLowerCase().includes(ql) || (clientBrief(p.client_id)?.name ?? '').toLowerCase().includes(ql))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(listItem);
      return { items, total: items.length, limit: 100, offset: 0 };
    }),
    createProject: (body) => wait(() => {
      const p = baseProject({ title: body.title, client_id: body.client_id ?? null, source_text: body.source_text ?? null, is_example: !!body.is_example });
      projects.unshift(p);
      return card(p);
    }),
    getProject: (id) => wait(() => card(getP(id))),
    updateProject: (id, body) => wait(() => { const p = getP(id); Object.assign(p, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), { updated_at: iso() }); return card(p); }),
    deleteProject: (id) => wait(() => {
      const p = getP(id);
      if (orders.some((o) => o.project_id === id)) throw new ApiError(409, 'project_has_order', 'Проект с заказом удалить нельзя — его можно только отправить в архив');
      projects.splice(projects.indexOf(p), 1);
    }),
    archiveProject: (id) => wait(() => { const p = getP(id); p.archived_at = iso(); return card(p); }),
    unarchiveProject: (id) => wait(() => { const p = getP(id); p.archived_at = null; return card(p); }),
    duplicateProject: (id) => wait(() => {
      const src = getP(id);
      const p = baseProject({ title: `${src.title} (копия)`, client_id: src.client_id, source_text: src.source_text, sample: src.sample, photos: [...src.photos] });
      const v = curVersion(src);
      if (v) createVersion(p, JSON.parse(JSON.stringify(v.tree)), 'manual', `Копия v${v.number}`, false, [...(v.estimated ?? [])]);
      projects.unshift(p);
      return card(p);
    }),
    uploadPhoto: (id, file, kind = 'source') => wait(() => {
      const p = getP(id);
      if (p.photos.filter((x) => x.kind === kind).length >= 5) throw new ApiError(409, 'too_many_photos', 'Можно загрузить не больше 5 фото');
      const ph: T.PhotoOut = { id: uid('ph'), kind, url: file.uri, content_type: file.type, size_bytes: 0, created_at: iso() };
      p.photos.push(ph);
      return ph;
    }),
    deletePhoto: (id, photoId) => wait(() => { const p = getP(id); p.photos = p.photos.filter((x) => x.id !== photoId); }),

    toSketch: (id) => wait(() => {
      const p = getP(id);
      if (p.status !== 'draft') throw new ApiError(409, 'illegal_transition', `Проект уже в статусе «${STATUS_LABELS[p.status]}»`);
      requireValid(p, 'sketch');
      if (!p.is_example && !p.charged) { // уже списан (новый проект из фото с несколькими предметами) — повторно не списываем
        if (limits.free_left <= 0 && limits.pack_left <= 0) throw new ApiError(402, 'limit_exceeded', 'Бесплатные проекты этого месяца закончились. Купите пакет или закажите материалы по проекту — лимит вернётся');
        limits.free_used += 1; limits.free_left -= 1; p.charged = true;
      }
      setStatus(p, 'sketch');
      return card(p);
    }),
    addMeasurement: (id, body) => wait(() => {
      const p = getP(id);
      if (p.status === 'draft') throw new ApiError(409, 'illegal_transition', 'Сначала сделайте эскиз — замер вносится после него');
      if (!['sketch', 'sent', 'measured'].includes(p.status)) throw new ApiError(409, 'illegal_transition', `Проект в статусе «${STATUS_LABELS[p.status]}» — замер изменить нельзя`);
      const k = body.kitchen ?? null;
      const m: T.MeasurementOut = {
        id: uid('ms'), version_id: p.current, width: body.width ?? k?.wall_a ?? null, height: body.height ?? null, depth: body.depth ?? null,
        data: k ? { ...(body.data ?? {}), kitchen: k } : body.data ?? {}, notes: body.notes ?? null, created_at: iso(), kitchen: k, apply_notes: [],
      };
      p.measurements.push(m);
      if (p.status !== 'measured') setStatus(p, 'measured');
      // Замер кухни: в демо модель не перестраивается — замер сохраняется в дереве (site), расстановку делает сервер
      const cur = curVersion(p);
      if (k && cur && cur.tree.type === 'kitchen' && body.apply_to_model !== false) {
        const v = createVersion(p, { ...cur.tree, site: k }, 'manual', `Замер кухни: стена А ${k.wall_a}${k.wall_b ? `, Б ${k.wall_b}` : ''}`);
        m.version_id = v.id; m.applied_version_id = v.id;
        m.apply_notes = ['Демо-режим: замер сохранён в модели, мойку и варку к выводам ставит сервер'];
      }
      // Замер ниши в 3 точках: шкаф встроенный, корпус по самому узкому месту минус доборы (как core/niche.fit_to_niche)
      const n = body.niche ?? null;
      if (n && cur && cur.tree.type !== 'kitchen') {
        m.niche = n; m.data = { ...(m.data ?? {}), niche: n };
        m.width = Math.min(...nicheWidths(n)) || m.width; m.height = Math.min(...nicheHeights(n)) || m.height; m.depth = n.depth ?? m.depth;
        if (body.apply_to_model !== false) {
          let t: T.ProductTree = { ...cur.tree, installation: 'niche', builtin: withNiche(cur.tree.builtin as never, n) };
          if (n.depth && (t.depth ?? 0) > n.depth) t.depth = n.depth;
          t = fitToNiche(t);
          const v = createVersion(p, t, 'manual', `Замер ниши: ${nicheWidths(n).join(' / ')} мм`);
          m.version_id = v.id; m.applied_version_id = v.id;
        }
      }
      return m;
    }),
    listMeasurements: (id) => wait(() => [...getP(id).measurements]),
    toContract: (id) => wait(() => {
      const p = getP(id);
      if (!TRANSITIONS[p.status].includes('contract')) setStatus(p, 'contract');
      const v = requireValid(p, 'contract');
      p.frozen_version_id = v.id; p.contract_at = iso(); p.client_agreed_at = p.client_agreed_at ?? iso();
      setStatus(p, 'contract');
      return card(p);
    }),
    deliver: (id, selfBought) => wait(() => {
      const p = getP(id);
      if (p.status === 'contract' && !selfBought) throw new ApiError(409, 'order_not_paid', 'Заказ в EMAN ещё не оплачен. Если материалы куплены самостоятельно — отметьте «материалы куплены сам»');
      setStatus(p, 'delivered');
      p.materials_self_bought = selfBought; p.delivered_at = iso();
      return card(p);
    }),
    cancelProject: (id, reason) => wait(() => { const p = getP(id); setStatus(p, 'cancelled'); p.cancelled_at = iso(); p.cancel_reason = reason ?? null; return card(p); }),

    getModel: (id) => wait(() => modelState(getP(id))),
    saveModel: (id, body) => wait(() => {
      const p = getP(id);
      createVersion(p, body.tree, body.source ?? 'manual', body.label ?? null, body.reject_on_errors);
      return modelState(p);
    }),
    undo: (id) => wait(() => {
      const p = getP(id);
      const prev = p.undo.pop();
      if (!prev) throw new ApiError(409, 'nothing_to_undo', 'Отменять нечего');
      p.redo.push(p.current!);
      p.chat.forEach((m) => { if (m.version_id === p.current && m.author === 'ai') m.undone = true; });
      p.current = prev;
      return modelState(p);
    }),
    redo: (id) => wait(() => {
      const p = getP(id);
      const next = p.redo.pop();
      if (!next) throw new ApiError(409, 'nothing_to_redo', 'Повторять нечего');
      p.undo.push(p.current!);
      p.current = next;
      p.chat.forEach((m) => { if (m.version_id === next) m.undone = false; });
      return modelState(p);
    }),
    applyFix: (id, ii, fi) => wait(() => {
      const p = getP(id);
      const v = curVersion(p);
      if (!v) throw new ApiError(404, 'model_missing', 'Модель ещё не построена');
      const fix = v.issues[ii]?.fixes[fi];
      if (!fix) throw new ApiError(404, 'fix_not_found', 'У этого замечания нет такого исправления');
      const redo = p.redo;
      createVersion(p, applyPatch(v.tree, fix.patch as never), 'fix', fix.description);
      void redo;
      return modelState(p);
    }),
    listVersions: (id) => wait(() => {
      const p = getP(id);
      // цена клиенту по каждой версии — для сравнения «Итог клиенту» (Versions.dc.html)
      const priceOf = (v: T.VersionOut) => (v.ok && p.sample ? { ...clientEstimate(SAMPLES[srcOf(p.sample, v.tree)], v.viewer, 'total', measured(p), pricingK(pricing)).total, exact: measured(p) } : null);
      return [...p.versions].reverse().map((v) => {
        const { tree: _t, viewer: _v, issues: _i, schema_version: _s, module_versions: _m, ...b } = v;
        return { ...b, is_current: b.id === p.current, frozen: b.id === p.frozen_version_id, price: priceOf(v) };
      });
    }),
    getVersion: (id, vid) => wait(() => {
      const v = getP(id).versions.find((x) => x.id === vid);
      if (!v) throw new ApiError(404, 'not_found', 'Версия модели не найдена');
      return JSON.parse(JSON.stringify(v));
    }),
    restoreVersion: (id, vid) => wait(() => {
      const p = getP(id);
      const v = p.versions.find((x) => x.id === vid);
      if (!v) throw new ApiError(404, 'not_found', 'Версия модели не найдена');
      createVersion(p, v.tree, 'restore', `Возврат к версии ${v.number}`);
      return modelState(p);
    }),

    getEstimate: (id) => wait(() => {
      const p = getP(id);
      const e = estimateOf(p);
      if (!e) throw new ApiError(409, curVersion(p) ? 'model_invalid' : 'model_missing', curVersion(p) ? 'В модели есть ошибки — исправьте их, чтобы посчитать смету' : 'Смета появится после построения модели');
      return e;
    }),
    getClientEstimate: (id, view) => wait(() => {
      const p = getP(id);
      const v = curVersion(p);
      if (!v || !v.ok || !p.sample) throw new ApiError(409, 'model_invalid', 'Смета появится после построения модели без ошибок');
      return clientEstimate(SAMPLES[srcOf(p.sample, v.tree)], v.viewer, view ?? pricing.default_estimate_view, measured(p), pricingK(pricing));
    }),

    createShareLink: (id, body) => wait(() => {
      const p = getP(id);
      if (p.status === 'draft') throw new ApiError(409, 'illegal_transition', 'Черновик отправить нельзя — сначала сделайте эскиз');
      if (p.status === 'cancelled') throw new ApiError(409, 'illegal_transition', 'Проект отменён — ссылку отправить нельзя');
      const view = body.estimate_view ?? pricing.default_estimate_view;
      if (role !== 'owner' && !pricing.employee_estimate_views.includes(view)) throw new ApiError(403, 'forbidden', 'Сотрудникам этот вид сметы недоступен');
      const v = requireValid(p, 'sent');
      const token = { kupe_3doors: 'kupe', wardrobe_3sec_niche: 'niche', wardrobe_2sec: '2sec' }[p.sample as string] ?? 'demo';
      const link: T.ShareLinkOut = { id: uid('l'), token, url: `${SHARE_URL}/${token}?lang=${body.language}&view=${view}`, version_id: v.id, language: body.language, estimate_view: view, show_price: body.show_price, expires_at: iso(-(body.expires_in_days ?? 30) * DAY), revoked_at: null, views: 0, ar_starts: 0, ar_failures: 0, first_opened_at: null, agreed_at: null, created_at: iso() };
      p.links.unshift(link);
      if (p.status === 'sketch') setStatus(p, 'sent');
      return link;
    }),
    listShareLinks: (id) => wait(() => [...getP(id).links]),

    getTask: <R>(taskId: string) => wait(() => {
      const t = tasks.get(taskId);
      if (!t) throw new ApiError(404, 'not_found', 'Задача не найдена');
      if (now() < t.readyAt) return { id: taskId, status: 'running', result: null, error: null } as T.TaskOut<R>;
      if (!t.done) {
        try { t.done = { result: t.run() }; } catch (e) { t.done = { error: (e as Error).message }; }
      }
      return (t.done.error
        ? { id: taskId, status: 'failed', result: null, error: t.done.error }
        : { id: taskId, status: 'done', result: t.done.result, error: null }) as T.TaskOut<R>;
    }),
    aiDesign: (id, body) => wait(() => { const p = getP(id); return startAi(p, designMs, body.confirm_extra_project, false, () => design(p, body)); }),
    aiAnswer: (id, answers, confirm) => wait(() => { const p = getP(id); return startAi(p, designMs / 2, confirm, false, () => answer(p, answers)); }),
    aiChooseType: (id, kind, confirm) => wait(() => {
      const p = getP(id);
      return startAi(p, designMs / 2, confirm, false, () => finishDesign(p, kindToSample(kind), JSON.parse(JSON.stringify(SAMPLES[kindToSample(kind)].tree)), ['/width', '/height', '/depth']));
    }),
    aiChooseObjects: (id, indices, confirm) => wait(() => {
      const p = getP(id);
      const objs = p.design?.objects ?? [];
      if (!objs.length) throw new ApiError(409, 'no_objects', 'На фото не найдено нескольких предметов — выбирать не из чего');
      if (new Set(indices).size !== indices.length) throw new ApiError(422, 'duplicate_objects', 'Предмет выбран дважды');
      if (!indices.length || indices.some((i) => i < 0 || i >= objs.length)) throw new ApiError(422, 'unknown_object', 'Такого предмета на фото нет — обновите экран');
      // Лимит — на все новые сразу, плюс несписанный текущий (спишется при «Эскизе»)
      const extra = indices.length - 1;
      const needed = extra + (p.charged || p.is_example ? 0 : 1);
      const left = limits.free_left + limits.pack_left;
      if (extra && !p.is_example && !limits.unlimited && left < needed) {
        throw new ApiError(402, 'limit_exhausted', `Не хватает лимита: нужно проектов — ${needed}, осталось — ${left}. Выберите меньше предметов или купите пакет проектов`, { needed, left });
      }
      const ctx = p.design!;
      const out: T.ObjectProjectOut[] = [];
      let charged = 0;
      indices.forEach((i, n) => {
        const o = objs[i];
        let target = p;
        if (n > 0) {
          target = baseProject({ title: o.label.charAt(0).toUpperCase() + o.label.slice(1), client_id: p.client_id, source_text: p.source_text, is_example: p.is_example,
            photos: p.photos.filter((x) => x.kind === 'source').map((x) => ({ ...x, id: uid('ph') })) });
          if (!p.is_example) {
            if (!limits.unlimited) {
              if (limits.free_left > 0) { limits.free_used += 1; limits.free_left -= 1; } else limits.pack_left -= 1;
            }
            target.charged = true; charged += 1;
          }
          projects.unshift(target);
        }
        target.design = { ...ctx, questions: [], objects: objs.map((x, k) => ({ ...x, chosen: k === i })) };
        const t = target;
        const { task_id } = n === 0 ? startAi(t, designMs / 2, confirm, false, () => answer(t, {})) : enqueue(designMs / 2, () => answer(t, {}));
        out.push({ project_id: t.id, task_id, object_index: i, label: o.label, title: t.title, created: n > 0 });
      });
      return { projects: out, charged };
    }),
    aiEdit: (id, instruction, confirm) => wait(() => {
      const p = getP(id);
      const accepted = startAi(p, editMs, confirm, true, () => {
        const r = edit(p, instruction);
        p.chat.push({ id: uid('m'), author: 'ai', text: r.summary ?? r.question ?? r.error ?? '', version_id: r.version_id, price_delta: r.price_delta, undone: false, created_at: iso(),
          options: r.question ? ['Ширина 2000', 'Добавь ящики', 'Белые фасады'] : null, option_deltas: r.question ? [412_000, 286_000, 0] : null });
        return r;
      });
      p.chat.push({ id: uid('m'), author: 'master', text: instruction, undone: false, created_at: iso() });
      return accepted;
    }),
    aiBudget: (id) => wait(() => {
      const p = getP(id);
      // эскиз по фото тоже тратит бюджет ИИ — считаем его одной правкой
      const used = p.aiEdits + (p.sample ? 1 : 0);
      const percent = Math.min(100, Math.round((used / aiBudget) * 100));
      return { spent_usd: +(used * 0.04).toFixed(2), limit_usd: +(aiBudget * 0.04).toFixed(2), percent, extra_projects: 0, warning: percent >= 80, exceeded: p.aiEdits >= aiBudget, message: null };
    }),
    getChat: (id) => wait(() => {
      const p = getP(id);
      const answers = p.aiAnswers ?? {};
      return { messages: [...p.chat], questions: (p.design?.questions ?? []).filter((q) => !(q.id in answers)), answers };
    }),
    getPart: (id, n) => wait(() => {
      const v = curVersion(getP(id));
      const part = v?.viewer.parts.find((x) => x.number === n);
      if (!v || !part) throw new ApiError(404, 'not_found', 'Деталь не найдена');
      // кромка в образце: 2 мм по видимым длинным сторонам у корпусных деталей, 0,4 — по остальным
      const visible = !/back|задн|hdf|plinth/i.test(`${part.role} ${part.key}`);
      const e = (side: string, mm: number) => ({ side, edge_id: mm ? (mm === 2 ? 'pvc_2' : 'pvc_04') : null, name: mm ? `Кромка ПВХ ${mm === 2 ? '2' : '0,4'} мм` : null, thickness_mm: mm });
      const edges = visible ? [e('y0', 2), e('y1', 0.4), e('x0', 0.4), e('x1', 0.4)] : [e('y0', 0), e('y1', 0), e('x0', 0), e('x1', 0)];
      const by = Object.fromEntries(edges.map((x) => [x.side, x.thickness_mm]));
      const holes = new Map<string, { purpose: string; diameter_mm: number; count: number }>();
      for (const h of part.holes) {
        const k = `${(h as { purpose?: string }).purpose ?? ''}|${h.diameter}`;
        const cur = holes.get(k) ?? { purpose: (h as { purpose?: string }).purpose ?? '', diameter_mm: h.diameter, count: 0 };
        cur.count += 1;
        holes.set(k, cur);
      }
      return {
        number: part.number, key: part.key, name: part.name, role: part.role, module: part.key.split('.')[0] ?? '', material_id: part.material,
        material: v.viewer.materials[part.material]?.name ?? part.material,
        length_mm: part.length, width_mm: part.width, thickness_mm: part.thickness,
        cut_length_mm: +(part.length - by.x0 - by.x1).toFixed(1), cut_width_mm: +(part.width - by.y0 - by.y1).toFixed(1), grain: part.grain,
        edges, holes: [...holes.values()], grooves: 0, cutouts: part.cutouts?.length ?? 0, hardware: [], product_size_mm: v.viewer.size,
      } satisfies T.PartOut;
    }),

    listFiles: (id) => wait(() => {
      const p = getP(id);
      if (!curVersion(p)) return [];
      return FILES.map((f) => ({ kind: f.kind, title: f.title, format: f.format, free: !!f.free, available: fileOpen(p, f),
        reason: fileOpen(p, f) ? null : 'Бесплатно при заказе материалов в EMAN или после оплаты файлов проекта' }));
    }),
    filesInfo: (id) => api.listFiles(id).then((files) => {
      const p = getP(id);
      const v = curVersion(p);
      const open = p.filesPaid || p.status === 'in_work' || p.status === 'delivered';
      const pro = workshop.plan === 'pro';
      return {
        version_id: v?.id ?? null, version_number: v?.number ?? null, frozen: !!p.frozen_version_id,
        access: { production: open, basis: open ? (p.filesPaid ? 'payment' : 'order') : null, pro_discount: pro },
        purchase: open ? null : { price: pro ? 22_500 : 45_000, full_price: 45_000, discount_pct: pro ? 50 : 0, pro_discount_pct: 50, currency: 'UZS' },
        files,
      };
    }),
    downloadFile: (id, kind) => wait(async (): Promise<DownloadedFile> => {
      const p = getP(id);
      const f = FILES.find((x) => x.kind === kind);
      if (!f) throw new ApiError(404, 'not_found', 'Файл не найден');
      if (!fileOpen(p, f)) throw new ApiError(402, 'files_locked', 'Файлы бесплатны при заказе в EMAN. Без заказа — оплата за проект');
      const v = curVersion(p)!;
      const name = `${translitKind(p)}_${kind}.${f.format === 'csv' ? 'csv' : f.format === 'pdf' ? 'pdf' : 'txt'}`;
      const mime = f.format === 'csv' ? 'text/csv' : f.format === 'pdf' ? 'application/pdf' : 'text/plain';
      const content = f.format === 'csv' ? partsCsv(v.viewer) : f.format === 'pdf' ? tinyPdf(`${f.kind} ${v.tree.width ?? ''}x${v.tree.height ?? ''}`) : `${f.title}\n(демо-файл мока)\n\n${partsCsv(v.viewer)}`;
      const uri = opts.writeFile ? await opts.writeFile(name, content, mime) : `data:${mime},${encodeURIComponent(content)}`;
      return { uri, mimeType: mime, name };
    }).then((x) => x),

    confirmEstimated: (id, vid, pointers) => wait(() => {
      const v = getP(id).versions.find((x) => x.id === vid);
      if (!v) throw new ApiError(404, 'not_found', 'Версия модели не найдена');
      v.estimated = (v.estimated ?? []).filter((p) => !pointers.some((q) => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)));
      return { version_id: v.id, estimated: [...v.estimated] };
    }),
    getHardware: (id) => wait(() => {
      const p = getP(id);
      const v = curVersion(p);
      if (!v) throw new ApiError(404, 'model_missing', 'Модель ещё не построена');
      const hw = (v.tree.hardware ?? {}) as Record<string, string>;
      const hk = v.tree.fronts?.handles?.kind ?? 'bar';
      const handles = hk === 'bar' ? `bar_${v.tree.fronts?.handles?.spacing ?? 128}` : hk;
      const lights = (v.tree.lighting as T.LightingItem[] | undefined) ?? [];
      const lightCur = !lights.length ? 'none' : lights.length === 1 && (lights[0].target ?? 'all') === 'all' ? lights[0].zone : 'custom';
      const lightOpts: [string, string, number][] = v.tree.type === 'kitchen'
        ? [['none', 'Без подсветки', 0], ['under_wall', 'Под навесными шкафами', 420_000], ['plinth', 'По цоколю', 360_000]]
        : [['none', 'Без подсветки', 0], ['niche', 'В открытых нишах', 240_000], ['inside_top', 'Внутри секций, под крышей', 380_000], ['wardrobe_rod', 'Над штангой', 310_000]];
      if (lightCur === 'custom') lightOpts.unshift(['custom', 'Своя подсветка (несколько зон)', 520_000]);
      const g = (key: string, title: string, cur: string, opts: [string, string, number][]): T.HardwareGroup => ({
        key, title, options: opts.map(([value, label, delta]) => ({ value, label, current: value === cur, delta: value === cur ? 0 : delta - (opts.find((o) => o[0] === cur)?.[2] ?? 0), available: true, note: value === 'push' && handles !== 'none' ? 'Push-to-open обычно ставят без ручек' : '' })),
      });
      // угловой модуль кухни (как core/hardware.py): группа corner_fill первой, поле в /base/i/corner_fill
      const cornerIdx = v.tree.type === 'kitchen' ? ((v.tree.base as { kind?: string }[] | undefined) ?? []).findIndex((c) => c.kind === 'corner') : -1;
      const cornerCab = cornerIdx >= 0 ? (v.tree.base as { width?: number; corner_shape?: string; corner_fill?: string }[])[cornerIdx] : null;
      const corner = cornerCab ? [g('corner_fill', `Угловой модуль ${cornerCab.corner_shape === 'square' ? `${cornerCab.width}×${cornerCab.width}` : cornerCab.width} мм`, cornerCab.corner_fill ?? 'blind',
        [['carousel', 'Карусель', 540_000], ['swing', 'Поворотная полка', 320_000], ['blind', 'Глухой угол (полка)', 0]])] : [];
      return {
        version_id: v.id, editable: !['in_work', 'delivered', 'cancelled'].includes(p.status),
        items: [{ kind: 'hinge', name: 'Петля 110°', qty: 8 }, { kind: 'handle', name: 'Ручка-скоба', qty: 4 }],
        groups: [
          ...corner,
          g('hinge', 'Петли', hw.hinge ?? 'soft_close', [['standard', 'Без доводчика', -60_000], ['soft_close', 'С доводчиком', 0], ['push', 'Push-to-open (без ручек)', 70_000]]),
          g('hinge_class', 'Класс петель', hw.hinge_class ?? 'standard', [['econom', 'Эконом', -80_000], ['standard', 'Стандарт', 0], ['premium', 'Премиум', 230_000]]),
          g('handles', 'Ручки', handles, [['bar_128', 'Скоба 128 мм', 0], ['bar_160', 'Скоба 160 мм', 20_000], ['bar_192', 'Скоба 192 мм', 40_000], ['knob', 'Кнопка (грибок)', 38_000], ['gola', 'Профиль Gola (без ручек)', 412_000], ['none', 'Без ручек', -70_000]]),
          ...(handles === 'none' ? [] : [g('handle_finish', 'Отделка ручек', v.tree.fronts?.handles?.finish ?? 'steel',
            [['steel', 'Сталь', 0], ['black', 'Чёрный матовый', 14_000], ['chrome', 'Хром', 9_000], ['brass', 'Латунь', 46_000], ['gold', 'Золото', 72_000]])]),
          g('lighting', 'Подсветка', lightCur, lightOpts),
        ],
      };
    }),
    applyHardware: (id, key, value) => wait(() => {
      const p = getP(id);
      const v = curVersion(p);
      if (!v) throw new ApiError(404, 'model_missing', 'Модель ещё не построена');
      const tree: T.ProductTree = JSON.parse(JSON.stringify(v.tree));
      const fin = tree.fronts?.handles?.finish;
      if (key === 'handles') tree.fronts = { ...(tree.fronts ?? {}), handles: value.startsWith('bar_') ? { kind: 'bar', spacing: Number(value.slice(4)), ...(fin ? { finish: fin } : {}) } : { kind: value as T.HandleKind, ...(fin ? { finish: fin } : {}) } };
      else if (key === 'handle_finish') tree.fronts = { ...(tree.fronts ?? {}), handles: { ...(tree.fronts?.handles ?? { kind: 'bar', spacing: 128 }), finish: value as T.MetalFinish } };
      else if (key === 'lighting') {
        const old = ((tree.lighting as T.LightingItem[] | undefined) ?? [])[0];
        tree.lighting = value === 'none' ? [] : [{ zone: value, target: 'all', temp: old?.temp ?? 4000, sensor: old?.sensor ?? 'none' }];
      }
      else if (key === 'corner_fill') {
        const cab = ((tree.base as { kind?: string; corner_fill?: string }[] | undefined) ?? []).find((c) => c.kind === 'corner');
        if (cab) cab.corner_fill = value;
      } else tree.hardware = { ...((tree.hardware as object) ?? {}), [key]: value };
      createVersion(p, tree, 'manual', `Фурнитура: ${key} → ${value}`);
      return modelState(p);
    }),
    getNesting: (id) => wait(() => {
      const v = curVersion(getP(id));
      if (!v) throw new ApiError(409, 'model_missing', 'Раскрой появится после построения модели');
      return nestingFromViewer(v.viewer, v.id, v.number);
    }),
    listPriceRequests: (id) => wait(() => priceRequests.filter((r) => r.project_id === getP(id).id).map((r) => ({ ...r }))),
    decidePriceRequest: (id, rid, accept) => wait(() => {
      const r = priceRequests.find((x) => x.id === rid && x.project_id === getP(id).id);
      if (!r) throw new ApiError(404, 'not_found', 'Позиция не найдена');
      if (r.status === 'pending') throw new ApiError(409, 'not_priced', 'Цены ещё нет — менеджер EMAN её уточняет');
      r.status = accept ? 'accepted' : 'declined';
      return { ...r };
    }),
    listDecors: () => wait(() => DECORS.filter((d) => ['ldsp', 'hdf'].includes(d.kind)).map((d) => ({
      id: d.id, name: d.name, name_uz: d.name_uz, kind: d.kind, decor: null, color: d.color, has_grain: d.hasGrain, thickness: d.thickness,
      texture: null, available: d.inStock, brand: d.brand, sku: null, source: 'core' as const,
    }))),

    searchDecors: (query) => wait(() => {
      const core: T.DecorOut[] = DECORS.filter((d) => ['ldsp', 'hdf'].includes(d.kind)).map((d) => ({
        id: d.id, name: d.name, name_uz: d.name_uz, kind: d.kind, decor: null, color: d.color, has_grain: d.hasGrain, thickness: d.thickness,
        texture: null, available: d.inStock, brand: d.brand, sku: null, source: 'core' as const,
      }));
      const all = [...MOCK_EMAN_DECORS.map((d) => ({ ...d, name_uz: d.name })), ...core];
      const pool = all.filter((d) => (!query?.kind || query.kind.split(',').some((k) => k === d.kind || k === d.eman_kind)) && (!query?.min_thickness || d.thickness >= query.min_thickness) && (query?.available == null || d.available === query.available) && (!query?.q || `${d.name} ${d.decor ?? ''} ${d.brand}`.toLowerCase().includes(query.q.toLowerCase())));
      const items = pool.filter((d) => (!query?.brand || d.brand === query.brand) && (!query?.family || d.family === query.family));
      const off = query?.offset ?? 0;
      return {
        items: items.slice(off, off + (query?.limit ?? 60)), total: items.length,
        brands: [...new Set(pool.filter((d) => d.source === 'eman').map((d) => d.brand))],
        families: (['white', 'grey', 'beige', 'wood-light', 'wood-dark', 'black', 'colour'] as T.ColorFamily[]).filter((f) => pool.some((d) => d.family === f)),
      };
    }),
    getFrontStyles: () => wait(() => frontStyles(role === 'owner')),
    getLightingZones: () => wait(() => lightingZones(role === 'owner')),
    getBuiltinOptions: () => wait(() => builtinOptions(role === 'owner')),
    listPaintColors: () => wait(() => ({
      colors: [
        { code: 'RAL 9003', system: 'RAL' as const, name_ru: 'Сигнальный белый', name_uz: 'Signal oq', hex: '#F4F4F4' },
        { code: 'RAL 7016', system: 'RAL' as const, name_ru: 'Антрацитово-серый', name_uz: 'Antrasit kulrang', hex: '#383E42' },
        { code: 'NCS S 2005-Y20R', system: 'NCS' as const, name_ru: 'Бежевый', name_uz: 'Bej', hex: '#C4B49C' },
      ],
      gloss: [
        { id: 'matte' as const, name_ru: 'Матовая', name_uz: 'Mat', price_m2: 220_000 },
        { id: 'satin' as const, name_ru: 'Полуматовая', name_uz: 'Yarim mat', price_m2: 260_000 },
        { id: 'gloss' as const, name_ru: 'Глянцевая', name_uz: 'Yaltiroq', price_m2: 380_000 },
      ],
      materials: [{ id: 'mdf_16_paint', name: 'МДФ 16 под покраску', thickness: 16 }, { id: 'mdf_19_paint', name: 'МДФ 19 под покраску', thickness: 19 }, { id: 'mdf_22_paint', name: 'МДФ 22 под покраску', thickness: 22 }],
      back_factor: 0.5,
    })),

    orderPreview: (id, km) => wait(() => {
      const p = getP(id);
      if (p.status !== 'contract') throw new ApiError(409, 'illegal_transition', 'Заказ оформляется из проекта в статусе «Договор»');
      return preview(p, km);
    }),
    createOrder: (id, km) => wait(() => {
      const p = getP(id);
      if (p.status !== 'contract') throw new ApiError(409, 'illegal_transition', 'Заказ оформляется из проекта в статусе «Договор»');
      if (orders.some((o) => o.project_id === p.id && o.status !== 'cancelled')) throw new ApiError(409, 'order_exists', 'По проекту уже есть заказ');
      const pr = preview(p, km);
      const o: T.OrderOut = {
        id: uid('o'), number: String(orderSeq++), project_id: p.id, project_title: p.title, status: 'created', status_label: 'Создан',
        total: pr.total, goods_total: pr.goods_total, delivery: pr.delivery, pickup: km == null, distance_km: km ?? null, weight_kg: pr.weight_kg,
        ready_date: null, created_at: iso(), payment: { status: 'waiting', method: null, url: null }, cancellable: true,
        items: [...pr.lines.map((l) => ({ key: l.key, name: l.name, qty: l.qty, unit: l.unit, price: l.price, amount: l.total })), ...pr.excluded.map((n) => ({ name: n, qty: null, unit: null, excluded: true }))],
        excluded: pr.excluded, documents: [{ kind: 'invoice', title: 'Счёт EMAN', format: 'pdf' }],
      };
      o.steps = orderSteps(o);
      orders.unshift(o);
      return { ...o };
    }),
    listOrders: () => wait(() => orders.map((o) => ({ ...o, steps: o.steps ?? orderSteps(o), cancellable: o.status === 'created' }))),
    getOrder: (id) => wait(() => {
      const o = orders.find((x) => x.id === id);
      if (!o) throw new ApiError(404, 'not_found', 'Заказ не найден');
      return { ...o, steps: o.steps ?? orderSteps(o), cancellable: o.status === 'created' };
    }),
    cancelOrder: (id) => wait(() => {
      const o = orders.find((x) => x.id === id);
      if (!o) throw new ApiError(404, 'not_found', 'Заказ не найден');
      if (o.status !== 'created') throw new ApiError(409, 'order_not_cancellable', 'Оплаченный заказ отменяет менеджер EMAN (до распила, с возвратом по их правилам). Напишите менеджеру');
      o.status = 'cancelled'; o.status_label = 'Отменён'; o.steps = orderSteps(o); o.cancellable = false;
      return { ...o };
    }),
    downloadOrderInvoice: (id) => wait(async (): Promise<DownloadedFile> => {
      const o = orders.find((x) => x.id === id);
      if (!o) throw new ApiError(404, 'not_found', 'Заказ не найден');
      const name = `Счёт_EMAN_${o.number}.pdf`;
      const content = tinyPdf(`EMAN invoice ${o.number}`);
      const uri = opts.writeFile ? await opts.writeFile(name, content, 'application/pdf') : `data:application/pdf,${encodeURIComponent(content)}`;
      return { uri, mimeType: 'application/pdf', name };
    }).then((x) => x),

    sendNonstandard: (id, body) => wait(() => {
      const p = getP(id);
      const r: T.NonstandardOut & { project_id: string } = {
        id: uid('ns'), number: nonstandard.length + 1, project_id: p.id, description: body.description, photo_ids: body.photo_ids ?? [],
        differences: body.differences ?? [], path: body.path ?? 'eman', status: 'sent', status_label: NS_LABELS.sent, steps: nsSteps('sent'),
        price: null, lead_days: null, assignee: null, files: [], can_accept: false, can_cancel: true, created_at: iso(),
      };
      nonstandard.unshift(r);
      // демо: через «работу конструктора» заявка оценена
      setTimeout(() => { if (r.status === 'sent') Object.assign(r, { status: 'estimated', status_label: NS_LABELS.estimated, steps: nsSteps('estimated'), price: 1_500_000, lead_days: 5, assignee: 'Конструктор EMAN', can_accept: true, designer_comment: 'Нишу сделаем из гнутого МДФ R250, остальное из ваших модулей' }); }, designMs);
      return { ...r };
    }),
    listNonstandard: (id) => wait(() => nonstandard.filter((r) => r.project_id === getP(id).id).map((r) => ({ ...r }))),
    acceptNonstandard: (id, rid) => wait(() => {
      const r = nonstandard.find((x) => x.id === rid && x.project_id === getP(id).id);
      if (!r) throw new ApiError(404, 'not_found', 'Заявка не найдена');
      if (r.status !== 'estimated') throw new ApiError(409, 'not_estimated', 'Цену можно принять, когда конструктор её назначит');
      Object.assign(r, { status: 'in_work', status_label: NS_LABELS.in_work, steps: nsSteps('in_work'), can_accept: false, can_cancel: false });
      return { ...r };
    }),
    downloadNonstandardFile: (_id, file) => wait(async (): Promise<DownloadedFile> => {
      const uri = opts.writeFile ? await opts.writeFile(file.name, 'demo', file.content_type) : `data:${file.content_type},demo`;
      return { uri, mimeType: file.content_type, name: file.name };
    }).then((x) => x),
    registerPushToken: () => wait({ stored: 'local' as const }),
    unregisterPush: () => wait(undefined),
    listNotifications: () => wait(() => notifications.map((n) => ({ ...n }))),
    markNotificationRead: (id) => wait(() => { const n = notifications.find((x) => x.id === id); if (n) n.read = true; }),
    getNotificationSettings: () => wait(() => JSON.parse(JSON.stringify(notifSettings))),
    updateNotificationSettings: (body) => wait(() => {
      for (const t of notifSettings.types) { const v = body.types?.[t.key as T.NotificationTypeKey]; if (v != null) t.enabled = v; }
      if (body.quiet) Object.assign(notifSettings.quiet, Object.fromEntries(Object.entries(body.quiet).filter(([, v]) => v != null)));
      return JSON.parse(JSON.stringify(notifSettings));
    }),
  };
  return api;
}

export { getAt };
