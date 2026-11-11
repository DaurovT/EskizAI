'use client';

/**
 * Сводка — рабочий стол суперадмина (ADM-01, §4a).
 * GET /admin/insights/dashboard?from&to — показатели за период со сравнением с предыдущим периодом той же длины,
 * графики по дням, лидеры, поставщики; блоки — по правам (деньги — finance, ИИ — ai.log/finance).
 * «Требует внимания» — общий запрос шапки (/admin/insights/alerts). «Сейчас» — GET /admin/dashboard.
 */
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAlerts } from '@/components/admin/AdminChrome';
import { DayBars, Meter } from '@/components/admin/charts';
import { compact, delta, periodDay, SEVERITY_LABEL, type InsightsDashboard, type Kpi } from '@/lib/admin/insights';
import { daysAgo, isoDay, num, sum, usd } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';

type Preset = 'today' | '7d' | '30d' | 'custom';

const PRESETS: [Preset, string][] = [
  ['today', 'Сегодня'],
  ['7d', '7 дней'],
  ['30d', '30 дней'],
  ['custom', 'Свой период'],
];

const STORE_KEY = 'adm_dash_period';

function rangeOf(p: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const today = isoDay(new Date());
  if (p === 'today') return { from: today, to: today };
  if (p === '7d') return { from: daysAgo(6), to: today };
  if (p === '30d') return { from: daysAgo(29), to: today };
  return custom;
}

interface Counted {
  status: string;
  label: string;
  count: number;
}

interface BaseDashboard {
  workshops: { total: number; active_30d: number; blocked: number };
  projects: { total: number; by_status: Counted[] };
  orders: { total: number; by_status: Counted[]; awaiting_hand_over: number };
}

export default function DashboardPage() {
  const [preset, setPreset] = useState<Preset>('7d');
  const [custom, setCustom] = useState({ from: daysAgo(13), to: isoDay(new Date()) });

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORE_KEY) as Preset | null;
      if (saved && saved !== 'custom' && PRESETS.some(([p]) => p === saved)) setPreset(saved);
    } catch {
      /* хранилище недоступно — период по умолчанию */
    }
  }, []);

  function choose(p: Preset) {
    setPreset(p);
    try {
      localStorage.setItem(STORE_KEY, p);
    } catch {
      /* не важно */
    }
  }

  const range = rangeOf(preset, custom);
  const valid = range.from && range.to && range.from <= range.to;
  const { data, error, loading, reload } = useApi<InsightsDashboard>(
    valid ? `/admin/insights/dashboard${qs(range)}` : null,
  );
  const base = useApi<BaseDashboard>('/admin/dashboard');

  return (
    <>
      <div className="page-head">
        <h1>Сводка</h1>
        <div className="seg" role="group" aria-label="Период">
          {PRESETS.map(([p, label]) => (
            <button key={p} type="button" className={preset === p ? 'on' : ''} onClick={() => choose(p)}>
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <span className="custom-range">
            <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            —
            <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </span>
        )}
        {data && (
          <span className="sub">
            {periodDay(data.from)}–{periodDay(data.to, true)} против {periodDay(data.prev_from)}–
            {periodDay(data.prev_to, true)}
            {preset === 'today' ? ' (на это же время)' : ''}
          </span>
        )}
      </div>

      <AlertsBlock />

      {!valid && <div className="state error">Начало периода позже конца</div>}
      {error && (
        <div className="state error">
          {error}{' '}
          <button type="button" className="b" onClick={reload}>
            Повторить
          </button>
        </div>
      )}
      {!data && loading && <KpiSkeleton />}
      {data && (
        <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
          <Kpis d={data} />
          <Charts d={data} />
          <Leaders d={data} />
          {data.suppliers && <Suppliers d={data} />}
        </div>
      )}
      <Now base={base.data} error={base.error} />
    </>
  );
}

function AlertsBlock() {
  const { data, error, loading } = useAlerts();
  if (error) return <div className="state error" style={{ marginBottom: 16 }}>Не удалось загрузить тревоги: {error}</div>;
  if (!data) return loading ? <div className="skeleton" style={{ height: 72, marginBottom: 16 }} /> : null;
  if (data.items.length === 0)
    return <div className="calm">✓ Всё спокойно: просрочек, споров и срочных дел нет</div>;
  return (
    <section aria-label="Требует внимания">
      <h2>Требует внимания</h2>
      <div className="alerts">
        {data.items.map((a) => (
          <div key={a.key} className={`alert-card sev-${a.severity}`}>
            <span className="sev-label">{SEVERITY_LABEL[a.severity]}</span>
            <div className="top">
              <Link href={a.href}>{a.title}</Link>
              <span className="cnt">{a.count}</span>
            </div>
            {a.detail && <div className="muted small">{a.detail}</div>}
            {a.items.length > 0 && (
              <ul>
                {a.items.slice(0, 3).map((it, i) => (
                  <li key={i}>
                    <Link href={it.href}>{it.label}</Link>
                    {it.sub && <span className="muted">{it.sub}</span>}
                  </li>
                ))}
                {a.items.length > 3 && (
                  <li>
                    <Link href={a.href}>ещё {a.count - 3} →</Link>
                  </li>
                )}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function KpiSkeleton() {
  return (
    <div className="kpis">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="kpi-tile">
          <div className="skeleton" style={{ height: 12, width: '50%' }} />
          <div className="skeleton" style={{ height: 26, width: '70%' }} />
          <div className="skeleton" style={{ height: 12, width: '40%' }} />
        </div>
      ))}
    </div>
  );
}

/** Изменение к прошлому периоду. tone: good — рост хорош (зелёный), neutral — без оценки (расходы, SMS). */
function Delta({ k, tone = 'good' }: { k: Kpi | undefined; tone?: 'good' | 'neutral' }) {
  const { pct, isNew } = delta(k);
  if (isNew) return <span className={`delta ${tone === 'good' ? 'up' : ''}`}>новое</span>;
  if (pct === null) return null;
  const r = Math.round(pct);
  const cls = tone === 'neutral' || r === 0 ? '' : r > 0 ? 'up' : 'down';
  return (
    <span className={`delta ${cls}`} title="К предыдущему периоду">
      {r > 0 ? '▲' : r < 0 ? '▼' : ''} {Math.abs(r)}%
    </span>
  );
}

function Tile({
  label,
  href,
  k,
  value,
  unit,
  prev,
  tone,
  children,
}: {
  label: string;
  href?: string;
  k: Kpi | undefined;
  value: ReactNode;
  unit?: string;
  prev: string;
  tone?: 'good' | 'neutral';
  children?: ReactNode;
}) {
  return (
    <div className="kpi-tile">
      {href ? (
        <Link href={href} className="lbl">
          {label} →
        </Link>
      ) : (
        <span className="lbl">{label}</span>
      )}
      <div className="val">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="row">
        <Delta k={k} tone={tone} />
        <span>было {prev}</span>
      </div>
      {children && <div className="det">{children}</div>}
    </div>
  );
}

function Kpis({ d }: { d: InsightsDashboard }) {
  const k = d.kpis;
  const v = (key: string) => k[key]?.value ?? 0;
  const p = (key: string) => k[key]?.prev ?? 0;
  return (
    <div className="kpis">
      <Tile label="Активные цеха" href="/admin/workshops" k={k.workshops_active} value={num(v('workshops_active'))} prev={num(p('workshops_active'))}>
        работали с проектами или ИИ
      </Tile>
      <Tile label="Новые цеха" k={k.registrations} value={num(v('registrations'))} prev={num(p('registrations'))}>
        регистрации
      </Tile>
      <Tile label="Проекты созданы" href="/admin/projects" k={k.projects_created} value={num(v('projects_created'))} prev={num(p('projects_created'))}>
        без примеров
      </Tile>
      <Tile label="Заказы оформлены" href="/admin/orders" k={k.orders} value={num(v('orders'))} prev={num(p('orders'))}>
        {k.orders_paid ? `оплачено: ${num(v('orders_paid'))} (было ${num(p('orders_paid'))})` : 'поставщикам'}
      </Tile>
      {d.sections.money && (
        <>
          <Tile label="Оборот заказов" href="/admin/finance" k={k.turnover} value={compact(v('turnover'))} unit="сум" prev={compact(p('turnover'))}>
            оплаченные заказы поставщикам
          </Tile>
          <Tile label="Комиссия платформы" href="/admin/finance" k={k.commission_accrued} value={compact(v('commission_accrued'))} unit="сум" prev={compact(p('commission_accrued'))}>
            начислено · сторно {compact(v('commission_reversed'))} · получено {compact(v('commission_received'))}
          </Tile>
          <Tile label="Выручка от мастеров" k={k.revenue_net} value={compact(v('revenue_net'))} unit="сум" prev={compact(p('revenue_net'))}>
            пакеты {compact(v('revenue_pack'))} · Pro {compact(v('revenue_pro'))} · файлы {compact(v('revenue_files'))}
            {v('revenue_refunds') ? ` · возвраты −${compact(v('revenue_refunds'))}` : ''}
          </Tile>
        </>
      )}
      {d.sections.ai && (
        <Tile label="Расходы на ИИ" href="/admin/ai" k={k.ai_usd} value={usd(v('ai_usd'), 2)} prev={usd(p('ai_usd'), 2)} tone="neutral">
          запросов: {num(v('ai_requests'))}
          {v('ai_requests') ? ` · в среднем ${usd(v('ai_usd') / v('ai_requests'), 3)}` : ''}
        </Tile>
      )}
      <Tile label="Коды входа (SMS)" k={k.sms_sent} value={num(v('sms_sent'))} prev={num(p('sms_sent'))} tone="neutral">
        отправлено кодов
      </Tile>
    </div>
  );
}

function ChartBox({ title, total, children }: { title: string; total: string; children: ReactNode }) {
  return (
    <section className="box">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2>{title}</h2>
        <span className="chart-total">{total}</span>
      </div>
      {children}
    </section>
  );
}

function Charts({ d }: { d: InsightsDashboard }) {
  const s = d.series;
  const pick = (key: 'orders' | 'registrations' | 'turnover' | 'ai_usd' | 'projects') =>
    s.map((r) => ({ date: r.date, value: Number(r[key] ?? 0) }));
  const total = (key: 'orders' | 'registrations' | 'turnover' | 'ai_usd' | 'projects') =>
    s.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
  return (
    <div className="charts">
      <ChartBox title="Заказы по дням" total={num(total('orders'))}>
        <DayBars data={pick('orders')} format={(v) => `${num(v)} заказов`} axisFormat={(v) => num(v)} label="Заказы по дням" />
      </ChartBox>
      {d.sections.money && (
        <ChartBox title="Оборот по дням" total={sum(total('turnover'))}>
          <DayBars data={pick('turnover')} format={(v) => sum(v)} axisFormat={compact} label="Оборот по дням" />
        </ChartBox>
      )}
      <ChartBox title="Регистрации цехов" total={num(total('registrations'))}>
        <DayBars
          data={pick('registrations')}
          format={(v) => `${num(v)} новых цехов`}
          axisFormat={(v) => num(v)}
          label="Регистрации по дням"
        />
      </ChartBox>
      {d.sections.ai ? (
        <ChartBox title="Расходы на ИИ" total={usd(total('ai_usd'), 2)}>
          <DayBars data={pick('ai_usd')} format={(v) => usd(v, 2)} axisFormat={(v) => `$${v < 10 ? v.toFixed(1) : num(v)}`} label="Расходы на ИИ по дням" />
        </ChartBox>
      ) : (
        <ChartBox title="Проекты по дням" total={num(total('projects'))}>
          <DayBars data={pick('projects')} format={(v) => `${num(v)} проектов`} axisFormat={(v) => num(v)} label="Проекты по дням" />
        </ChartBox>
      )}
    </div>
  );
}

function Leaders({ d }: { d: InsightsDashboard }) {
  if (!d.top_turnover && !d.top_ai) return null;
  const maxT = Math.max(1, ...(d.top_turnover ?? []).map((r) => r.turnover));
  const maxA = Math.max(0.0001, ...(d.top_ai ?? []).map((r) => r.cost_usd));
  return (
    <div className="grid2">
      {d.top_turnover && (
        <section className="box">
          <h2>Цеха с наибольшим оборотом</h2>
          {d.top_turnover.length === 0 ? (
            <div className="state">Оплаченных заказов за период нет</div>
          ) : (
            <table>
              <tbody>
                {d.top_turnover.map((r) => (
                  <tr key={r.workshop_id}>
                    <td>
                      <Link href={`/admin/workshops/${r.workshop_id}`}>{r.name}</Link>
                      <span className="muted"> · {r.city}</span>
                      <Meter value={r.turnover} max={maxT} />
                    </td>
                    <td className="num">
                      {sum(r.turnover)}
                      <div className="muted small">заказов: {r.orders}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {d.top_ai && (
        <section className="box">
          <h2>Цеха с наибольшим расходом ИИ</h2>
          {d.top_ai.length === 0 ? (
            <div className="state">Запросов к ИИ за период нет</div>
          ) : (
            <table>
              <tbody>
                {d.top_ai.map((r) => (
                  <tr key={r.workshop_id}>
                    <td>
                      <Link href={`/admin/workshops/${r.workshop_id}`}>{r.name}</Link>
                      <span className="muted"> · {r.city}</span>
                      <Meter value={r.cost_usd} max={maxA} />
                    </td>
                    <td className="num">
                      {usd(r.cost_usd, 2)}
                      <div className="muted small">запросов: {num(r.requests)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function hours(h: number | null): string {
  if (h === null) return '—';
  if (h < 1) return `${Math.round(h * 60)} мин`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0).replace('.', ',')} ч`;
  return `${Math.round(h / 24)} дн`;
}

function Suppliers({ d }: { d: InsightsDashboard }) {
  const rows = d.suppliers ?? [];
  return (
    <section className="box">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2>Поставщики</h2>
        <span className="muted small">
          очередь и просрочки — сейчас (просрочка — дольше {d.overdue_hours} ч без ответа); скорость и возвраты — за период
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="state">Поставщиков пока нет</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Поставщик</th>
                <th className="num">В очереди</th>
                <th className="num">Просрочено</th>
                <th className="num">Ждёт дольше всех</th>
                <th className="num">Медиана принятия</th>
                <th className="num">Заказов за период</th>
                <th className="num">Отклонено</th>
                <th className="num">Возвраты</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ordersHref = `/admin/orders${qs({ supplier_id: r.supplier_id ?? 'none' })}`;
                return (
                  <tr key={r.supplier_id ?? 'none'} className={r.overdue ? 'bad' : r.queue ? 'warn' : ''}>
                    <td>
                      {r.supplier_id ? <Link href={`/admin/suppliers/${r.supplier_id}`}>{r.name}</Link> : r.name}
                      {!r.active && <span className="tag red" style={{ marginLeft: 6 }}>заблокирован</span>}
                    </td>
                    <td className="num">
                      {r.queue ? <Link href={`${ordersHref}&status=created`}>{r.queue}</Link> : 0}
                    </td>
                    <td className="num">
                      {r.overdue ? <Link href={`${ordersHref}&status=created&overdue=1`}><b>{r.overdue}</b></Link> : 0}
                    </td>
                    <td className="num">{r.queue ? hours(r.oldest_hours) : '—'}</td>
                    <td className="num">{hours(r.median_accept_hours)}</td>
                    <td className="num">{r.orders}</td>
                    <td className="num">{r.rejected || '—'}</td>
                    <td className="num">
                      {r.return_rate === null ? '—' : `${Math.round(r.return_rate * 100)}%`}
                      {r.paid ? <span className="muted small"> из {r.paid}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Now({ base, error }: { base: BaseDashboard | null; error: string | null }) {
  const maxP = useMemo(() => Math.max(1, ...(base?.projects.by_status ?? []).map((s) => s.count)), [base]);
  const maxO = useMemo(() => Math.max(1, ...(base?.orders.by_status ?? []).map((s) => s.count)), [base]);
  if (error) return null;
  if (!base) return null;
  return (
    <>
      <h2 style={{ marginTop: 8 }}>Сейчас</h2>
      <div className="grid2">
        <section className="box">
          <h2>Проекты по статусам · {num(base.projects.total)}</h2>
          <table>
            <tbody>
              {base.projects.by_status.map((s) => (
                <tr key={s.status}>
                  <td style={{ width: '45%' }}>
                    <Link href={`/admin/projects?status=${s.status}`}>{s.label}</Link>
                  </td>
                  <td>
                    <Meter value={s.count} max={maxP} />
                  </td>
                  <td className="num">{num(s.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Цехов: {num(base.workshops.total)} · активны за 30 дней: {num(base.workshops.active_30d)} · заблокированы:{' '}
            {num(base.workshops.blocked)}
          </p>
        </section>
        <section className="box">
          <h2>Заказы по статусам · {num(base.orders.total)}</h2>
          <table>
            <tbody>
              {base.orders.by_status.map((s) => (
                <tr key={s.status}>
                  <td style={{ width: '45%' }}>
                    <Link href={`/admin/orders?status=${s.status}`}>{s.label}</Link>
                  </td>
                  <td>
                    <Meter value={s.count} max={maxO} tone={s.status === 'rejected' ? 'bad' : undefined} />
                  </td>
                  <td className="num">{num(s.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
