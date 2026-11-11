'use client';

/**
 * Журнал действий (§4a, §6): только чтение — ни удалить, ни изменить нельзя.
 * GET /admin/insights/audit — фильтры (кто, тип, объект, действие, период, текст, IP), IP и причина отдельными
 * колонками, «было → стало» по полям; CSV — те же фильтры (выгрузка сама попадает в журнал).
 * Фильтры живут в адресе страницы: ссылки из тревог (?entity=limits&action=cap_hit, ?ip=…) открывают готовую выборку.
 */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useMemo, useState } from 'react';
import { Pager } from '@/components/admin/ui';
import { daysAgo, dt, isoDay, num } from '@/lib/admin/format';
import type { AuditEntry, AuditFacets } from '@/lib/admin/insights';
import { ApiError, qs } from '@/lib/staff/client';
import { useApi, useClient } from '@/lib/staff/hooks';

const PAGE = 50;

const ENTITY: Record<string, string> = {
  workshop: 'Цех',
  workshop_plan: 'Тариф цеха',
  workshop_limits: 'Лимиты цеха',
  workshop_pricing: 'Цены цеха',
  order: 'Заказ',
  order_return: 'Возврат',
  order_dispute: 'Спор',
  project: 'Проект',
  supplier: 'Поставщик',
  supplier_routes: 'Маршруты поставщиков',
  staff_user: 'Сотрудник',
  staff_auth: 'Вход сотрудника',
  limits: 'Лимиты расходов',
  settings: 'Настройки',
  maintenance: 'Обслуживание',
  impersonation: '«Глазами мастера»',
  broadcast: 'Рассылка',
  audit: 'Журнал',
  catalog_item: 'Позиция каталога',
  raw_price_record: 'Изменение цены',
  parser_run: 'Загрузка прайса',
  price_request: 'Цена по запросу',
  nonstandard: 'Нестандарт',
  payment: 'Платёж',
  user: 'Мастер',
  invite: 'Приглашение',
  account: 'Аккаунт',
  file_access: 'Файлы',
};

const ACTION: Record<string, string> = {
  create: 'создание',
  update: 'изменение',
  delete: 'удаление',
  block: 'блокировка',
  unblock: 'разблокировка',
  login: 'вход',
  login_failed: 'неудачный вход',
  login_locked: 'вход заблокирован',
  login_while_locked: 'вход при блокировке',
  mfa_failed: 'неверный код 2FA',
  mfa_enable: '2FA включена',
  mfa_disable: '2FA выключена',
  mfa_reset: 'сброс 2FA',
  password_change: 'смена пароля',
  reset_password: 'сброс пароля',
  sessions_revoke: 'завершение сессий',
  cap_hit: 'лимит сработал',
  export: 'выгрузка',
  status: 'смена статуса',
  cancel: 'отмена',
  refund: 'возврат денег',
  request: 'запрос',
  denied: 'отказ',
  resolve: 'решение',
  intervene: 'вмешательство',
  mark_paid: 'отмечен оплаченным',
  hand_over: 'передан поставщику',
  grant: 'начисление',
  publish: 'публикация',
  review: 'проверка',
};

const ACTOR_TYPE: Record<string, string> = {
  staff: 'Сотрудники',
  user: 'Мастера',
  master: 'Мастера (заказы)',
  system: 'Система',
  platform: 'Платформа',
  admin: 'Админ',
};

type Filters = Record<'actor' | 'actor_type' | 'entity' | 'action' | 'q' | 'ip' | 'from' | 'to' | 'workshop_id', string>;
const KEYS: (keyof Filters)[] = ['actor', 'actor_type', 'entity', 'action', 'q', 'ip', 'from', 'to', 'workshop_id'];

function readFilters(p: URLSearchParams): Filters {
  const f = Object.fromEntries(KEYS.map((k) => [k, p.get(k) ?? ''])) as Filters;
  // По умолчанию — неделя; ссылка с фильтром без дат (из тревоги) — 30 дней
  if (!p.has('from') && !p.has('to') && !p.has('all')) {
    f.from = daysAgo(KEYS.some((k) => p.get(k)) ? 29 : 6);
    f.to = isoDay(new Date());
  }
  return f;
}

export default function AuditPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Audit />
    </Suspense>
  );
}

function Audit() {
  const router = useRouter();
  const pathname = usePathname() ?? '/admin/audit';
  const params = useSearchParams();
  const filters = useMemo(() => readFilters(new URLSearchParams(params.toString())), [params]);
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const [text, setText] = useState({ q: filters.q, ip: filters.ip });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const client = useClient();
  const [exporting, setExporting] = useState<string | null>(null);

  const facets = useApi<AuditFacets>('/admin/insights/audit/facets');
  const query = { ...filters, page, page_size: PAGE };
  const { data, error, loading, reload } = useApi<{ items: AuditEntry[]; total: number; page: number }>(
    `/admin/insights/audit${qs(query)}`,
  );

  function apply(next: Partial<Filters>, keepPage = false) {
    const merged = { ...filters, ...next };
    if (next.entity !== undefined && next.entity !== filters.entity && next.action === undefined) merged.action = '';
    const all = !merged.from && !merged.to;
    router.replace(`${pathname}${qs({ ...merged, ...(all ? { all: '1' } : {}), page: keepPage ? page : undefined })}`);
  }

  function setPage(p: number) {
    const all = !filters.from && !filters.to;
    router.replace(`${pathname}${qs({ ...filters, ...(all ? { all: '1' } : {}), page: p > 1 ? p : undefined })}`);
  }

  async function exportCsv() {
    setExporting(null);
    try {
      await client.download(`/admin/insights/audit/export.csv${qs(filters)}`, 'audit.csv');
    } catch (e) {
      setExporting(e instanceof ApiError ? e.message : String(e));
    }
  }

  const today = isoDay(new Date());
  const quick: [string, string, string][] = [
    ['Сегодня', today, today],
    ['7 дней', daysAgo(6), today],
    ['30 дней', daysAgo(29), today],
    ['Всё время', '', ''],
  ];
  const actions = useMemo(() => {
    const a = facets.data?.actions ?? {};
    if (filters.entity) return a[filters.entity] ?? [];
    return [...new Set(Object.values(a).flat())].sort();
  }, [facets.data, filters.entity]);
  const staffName = (id: string) => facets.data?.staff.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  const chips: [keyof Filters, string][] = (
    [
      ['actor', filters.actor && `Кто: ${staffName(filters.actor)}`],
      ['actor_type', filters.actor_type && `Тип: ${ACTOR_TYPE[filters.actor_type] ?? filters.actor_type}`],
      ['entity', filters.entity && `Объект: ${ENTITY[filters.entity] ?? filters.entity}`],
      ['action', filters.action && `Действие: ${ACTION[filters.action] ?? filters.action}`],
      ['q', filters.q && `Текст: «${filters.q}»`],
      ['ip', filters.ip && `IP: ${filters.ip}`],
      ['workshop_id', filters.workshop_id && `Цех: ${filters.workshop_id.slice(0, 8)}`],
    ] as [keyof Filters, string][]
  ).filter(([, v]) => v);

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <>
      <div className="page-head">
        <h1>Журнал действий</h1>
        <span className="sub">только чтение · записи нельзя изменить или удалить</span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="b" onClick={() => void exportCsv()} disabled={!total}>
          Выгрузить CSV{total ? ` (${num(Math.min(total, 20000))})` : ''}
        </button>
      </div>
      {exporting && <div className="msg error">{exporting}</div>}

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Период">
          {quick.map(([label, from, to]) => (
            <button
              key={label}
              type="button"
              className={filters.from === from && filters.to === to ? 'on' : ''}
              onClick={() => apply({ from, to })}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="custom-range">
          <input type="date" value={filters.from} onChange={(e) => apply({ from: e.target.value })} aria-label="С" />—
          <input type="date" value={filters.to} onChange={(e) => apply({ to: e.target.value })} aria-label="По" />
        </span>
      </div>

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q: text.q.trim(), ip: text.ip.trim() });
        }}
      >
        <label className="wide">
          Текст: причина, имя или почта сотрудника, id
          <input value={text.q} onChange={(e) => setText({ ...text, q: e.target.value })} placeholder="например, мошенничество" />
        </label>
        <label>
          Кто
          <select value={filters.actor} onChange={(e) => apply({ actor: e.target.value })}>
            <option value="">все</option>
            {(facets.data?.staff ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.email ? ` · ${s.email}` : ''}
                {s.supplier ? ' (поставщик)' : ''}
                {s.is_active ? '' : ' — отключён'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Тип
          <select value={filters.actor_type} onChange={(e) => apply({ actor_type: e.target.value })}>
            <option value="">все</option>
            {(facets.data?.actor_types ?? []).map((t) => (
              <option key={t} value={t}>
                {ACTOR_TYPE[t] ?? t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Объект
          <select value={filters.entity} onChange={(e) => apply({ entity: e.target.value })}>
            <option value="">все</option>
            {(facets.data?.entities ?? []).map((x) => (
              <option key={x.value} value={x.value}>
                {ENTITY[x.value] ?? x.value} ({num(x.count)})
              </option>
            ))}
          </select>
        </label>
        <label>
          Действие
          <select value={filters.action} onChange={(e) => apply({ action: e.target.value })}>
            <option value="">все</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {ACTION[a] ? `${ACTION[a]} (${a})` : a}
              </option>
            ))}
          </select>
        </label>
        <label>
          IP
          <input value={text.ip} onChange={(e) => setText({ ...text, ip: e.target.value })} placeholder="10.0.0.1" />
        </label>
        <div>
          <button className="b primary" type="submit">
            Найти
          </button>
        </div>
      </form>

      {chips.length > 0 && (
        <div className="chips">
          {chips.map(([k, label]) => (
            <span key={k} className="chip">
              {label}
              <button
                type="button"
                aria-label="Убрать фильтр"
                onClick={() => {
                  if (k === 'q' || k === 'ip') setText({ ...text, [k]: '' });
                  apply({ [k]: '' } as Partial<Filters>);
                }}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            className="b"
            style={{ padding: '1px 10px', fontSize: 12 }}
            onClick={() => {
              setText({ q: '', ip: '' });
              router.replace(pathname);
            }}
          >
            Сбросить всё
          </button>
        </div>
      )}

      {error && (
        <div className="state error">
          {error}{' '}
          <button type="button" className="b" onClick={reload}>
            Повторить
          </button>
        </div>
      )}
      {!data && loading && <div className="skeleton" style={{ height: 240 }} />}
      {data &&
        (rows.length === 0 ? (
          <div className="state">Записей по этим условиям нет — попробуйте расширить период или убрать фильтры</div>
        ) : (
          <div className="scroll" style={{ opacity: loading ? 0.6 : 1 }}>
            <table className="audit">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>IP</th>
                  <th>Объект</th>
                  <th>Действие</th>
                  <th>Причина</th>
                  <th>Цех</th>
                  <th aria-label="Подробнее" />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const isOpen = open.has(e.id);
                  const toggle = () =>
                    setOpen((s) => {
                      const n = new Set(s);
                      if (n.has(e.id)) n.delete(e.id);
                      else n.add(e.id);
                      return n;
                    });
                  return (
                    <Fragment key={e.id}>
                      <tr className={`clickable ${isOpen ? 'open' : ''}`} onClick={toggle}>
                        <td style={{ whiteSpace: 'nowrap' }}>{dt(e.created_at)}</td>
                        <td>
                          {e.actor_name ?? (e.actor_type === 'system' ? 'Система' : (e.actor_id?.slice(0, 8) ?? '—'))}
                          <div className="muted small">{e.actor_role ?? ACTOR_TYPE[e.actor_type] ?? e.actor_type}</div>
                        </td>
                        <td className="mono">
                          {e.ip ? (
                            <a
                              href="#"
                              onClick={(ev) => {
                                ev.preventDefault();
                                ev.stopPropagation();
                                setText({ ...text, ip: e.ip ?? '' });
                                apply({ ip: e.ip ?? '' });
                              }}
                              title="Все действия с этого IP"
                            >
                              {e.ip}
                            </a>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {ENTITY[e.entity] ?? e.entity}
                          {e.entity_id && (
                            <div className="muted small mono">
                              {e.href ? (
                                <Link href={e.href} onClick={(ev) => ev.stopPropagation()}>
                                  {e.entity_id.slice(0, 8)}
                                </Link>
                              ) : (
                                e.entity_id.slice(0, 24)
                              )}
                            </div>
                          )}
                        </td>
                        <td>
                          <b>{ACTION[e.action] ?? e.action}</b>
                          {ACTION[e.action] && <div className="muted small mono">{e.action}</div>}
                        </td>
                        <td style={{ maxWidth: 260 }}>{e.reason ?? <span className="muted">—</span>}</td>
                        <td>
                          {e.workshop_id ? (
                            <Link href={`/admin/workshops/${e.workshop_id}`} onClick={(ev) => ev.stopPropagation()}>
                              {e.workshop_name ?? e.workshop_id.slice(0, 8)}
                            </Link>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="muted">{isOpen ? '▾' : '▸'}</td>
                      </tr>
                      {isOpen && (
                        <tr className="open">
                          <td colSpan={8}>
                            <EntryDetails e={e} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <Pager total={total} limit={PAGE} offset={(page - 1) * PAGE} onChange={(off) => setPage(off / PAGE + 1)} />
          </div>
        ))}
    </>
  );
}

function show(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 1);
}

/** «Было → стало» по полям: изменённые подсвечены; поля только в «стало» (новые данные) — без «было». */
function EntryDetails({ e }: { e: AuditEntry }) {
  const [raw, setRaw] = useState(false);
  const keys = [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])].filter(
    (k) => k !== 'reason',
  );
  const hasBefore = e.before !== null && Object.keys(e.before ?? {}).length > 0;
  return (
    <div>
      <div className="entry-meta">
        <span>Время: {dt(e.created_at)}</span>
        {e.actor_email && <span>Почта: {e.actor_email}</span>}
        {e.actor_id && (
          <span>
            ID: <span className="mono">{e.actor_id}</span>
          </span>
        )}
        {e.entity_id && (
          <span>
            Объект: <span className="mono">{e.entity_id}</span>
          </span>
        )}
        {e.href && <Link href={e.href}>Открыть →</Link>}
      </div>
      {e.reason && (
        <div className="msg warn" style={{ margin: '4px 0 8px' }}>
          Причина: {e.reason}
        </div>
      )}
      {keys.length === 0 ? (
        <div className="muted small">Без подробностей</div>
      ) : raw ? (
        <pre>{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>
      ) : (
        <table className="diff">
          <thead>
            <tr>
              <th>Поле</th>
              {hasBefore && <th>Было</th>}
              <th>{hasBefore ? 'Стало' : 'Данные'}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const b = e.before?.[k];
              const a = e.after?.[k];
              const changed = hasBefore && JSON.stringify(b) !== JSON.stringify(a);
              return (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  {hasBefore && (
                    <td className={changed ? 'was' : 'same'}>
                      <code>{show(b)}</code>
                    </td>
                  )}
                  <td className={changed ? 'now' : hasBefore ? 'same' : ''}>
                    <code>{show(a)}</code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <button type="button" className="b" style={{ fontSize: 12, padding: '2px 10px' }} onClick={() => setRaw(!raw)}>
        {raw ? 'Таблицей' : 'Как JSON'}
      </button>
    </div>
  );
}
