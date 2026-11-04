'use client';

/**
 * Сводка (ADM-01, §4a). GET /admin/dashboard?from&to → базовая сводка (цеха, проекты, заказы, ИИ по периодам)
 * + `period` — расширенная сводка за период (только при праве finance: суперадмин).
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { defaultPeriod, PeriodFilter, type Period } from '@/components/admin/Period';
import { Box, Loading, Tag } from '@/components/admin/ui';
import { num, ORDER_STATUS_LABEL, sum, usd } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';

interface Counted {
  status: string;
  label: string;
  count: number;
}

interface PeriodStats {
  from: string;
  to: string;
  workshops_new: number;
  masters_active: number;
  workshops_active: number;
  projects_new: number;
  orders_by_supplier: { supplier_id: string | null; supplier_name: string | null; status: string; count: number }[];
  turnover: number;
  paid_orders: number;
  commission: { accrued: number; reversed: number; received: number };
  platform_revenue: Record<string, number>;
  ai: { requests: number; cost_usd: number; errors: number };
  sms: { codes_sent: number };
  overdue_orders: number;
  overdue_hours: number;
  open_disputes: number;
  open_returns: number;
}

interface Dashboard {
  workshops: { total: number; active_30d: number; blocked: number };
  projects: { total: number; by_status: Counted[]; created_today: number };
  orders: {
    total: number;
    by_status: Counted[];
    awaiting_hand_over: number;
    turnover: Record<string, number>;
    commission_percent: number;
    commission: Record<string, number>;
  };
  ai: Record<string, { requests: number; cost_usd: number }>;
  period?: PeriodStats;
}

const PERIODS: [string, string][] = [
  ['today', 'Сегодня'],
  ['week', '7 дней'],
  ['month', 'Месяц'],
];

const REVENUE: Record<string, string> = { pack: 'Пакеты проектов', pro: 'Pro', files: 'Файлы для станка' };

export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>(defaultPeriod(29));
  const { data, error, loading } = useApi<Dashboard>(`/admin/dashboard${qs({ from: period.from, to: period.to })}`);
  const p = data?.period;

  // Заказы за период по поставщикам: строки API — (поставщик × статус)
  const bySupplier = useMemo(() => {
    const m = new Map<string, { id: string | null; name: string; total: number; statuses: Record<string, number> }>();
    for (const r of p?.orders_by_supplier ?? []) {
      const key = r.supplier_id ?? 'none';
      const row = m.get(key) ?? { id: r.supplier_id, name: r.supplier_name ?? 'очередь платформы', total: 0, statuses: {} };
      row.total += r.count;
      row.statuses[r.status] = (row.statuses[r.status] ?? 0) + r.count;
      m.set(key, row);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [p]);

  const revenueTotal = p ? Object.entries(p.platform_revenue).reduce((s, [k, v]) => (k === 'refunds' ? s - v : s + v), 0) : 0;

  return (
    <>
      <h1>Сводка</h1>
      {data?.period !== undefined || !data ? <PeriodFilter value={period} onChange={setPeriod} /> : null}
      <Loading error={error} loading={loading && !data} />
      {data && (
        <>
          {p && (
            <div className="grid">
              <Box title="Цеха и мастера за период">
                <div className="kpi">{num(p.workshops_active)}</div>
                <div className="muted">
                  активных цехов · новых: {p.workshops_new} · мастеров заходили: {p.masters_active}
                </div>
              </Box>
              <Box title="Проекты и заказы за период">
                <div className="kpi">{num(p.projects_new)}</div>
                <div className="muted">
                  новых проектов · оплачено заказов: {p.paid_orders} на {sum(p.turnover)}
                </div>
              </Box>
              <Box title="Требуют внимания">
                <div className="toolbar" style={{ marginBottom: 0 }}>
                  <Link href="/admin/orders?status=created">
                    <Tag color={p.overdue_orders ? 'red' : 'green'}>
                      просрочено у поставщиков (&gt; {p.overdue_hours} ч): {p.overdue_orders}
                    </Tag>
                  </Link>
                  <Link href="/admin/disputes">
                    <Tag color={p.open_disputes ? 'yellow' : 'green'}>споры: {p.open_disputes}</Tag>
                  </Link>
                  <Tag color={p.open_returns ? 'yellow' : 'green'}>возвраты: {p.open_returns}</Tag>
                  <Link href="/admin/ai">
                    <Tag color={p.ai.errors ? 'yellow' : 'green'}>ошибки ИИ: {p.ai.errors}</Tag>
                  </Link>
                </div>
              </Box>
              <Box title="ИИ и SMS за период">
                <div className="kpi">{usd(p.ai.cost_usd, 2)}</div>
                <div className="muted">
                  запросов ИИ: {num(p.ai.requests)} · SMS-кодов: {num(p.sms.codes_sent)}
                </div>
              </Box>
            </div>
          )}
          <div className="grid2">
            {p && (
              <Box title="Деньги платформы за период">
                <table>
                  <tbody>
                    <Row label="Комиссия начислена" v={sum(p.commission.accrued)} />
                    <Row label="Комиссия сторно" v={sum(p.commission.reversed)} />
                    <Row label="Получено от поставщиков" v={sum(p.commission.received)} />
                    {Object.entries(p.platform_revenue)
                      .filter(([k]) => k !== 'refunds')
                      .map(([k, v]) => (
                        <Row key={k} label={REVENUE[k] ?? k} v={sum(v)} />
                      ))}
                    {p.platform_revenue.refunds ? <Row label="Возвраты мастерам" v={sum(-p.platform_revenue.refunds)} /> : null}
                    <Row label="Выручка от мастеров" v={<b>{sum(revenueTotal)}</b>} />
                  </tbody>
                </table>
                <p className="muted">
                  <Link href="/admin/finance">Взаиморасчёты с поставщиками →</Link>
                </p>
              </Box>
            )}
            {p && (
              <Box title="Заказы по поставщикам за период">
                {bySupplier.length === 0 ? (
                  <div className="muted">Заказов за период нет</div>
                ) : (
                  <table>
                    <tbody>
                      {bySupplier.map((r) => (
                        <tr key={r.id ?? 'none'}>
                          <td>
                            {r.id ? <Link href={`/admin/orders?supplier_id=${r.id}`}>{r.name}</Link> : r.name}
                            <div className="muted">
                              {Object.entries(r.statuses)
                                .map(([st, n]) => `${ORDER_STATUS_LABEL[st] ?? st}: ${n}`)
                                .join(' · ')}
                            </div>
                          </td>
                          <td className="num">{r.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Box>
            )}
            <Box title="Цеха и проекты (всего)">
              <table>
                <tbody>
                  <Row label="Цехов" v={num(data.workshops.total)} />
                  <Row label="Активны за 30 дней" v={num(data.workshops.active_30d)} />
                  <Row label="Заблокированы" v={num(data.workshops.blocked)} />
                  <Row label="Проектов" v={num(data.projects.total)} />
                  <Row label="Создано сегодня" v={num(data.projects.created_today)} />
                  <Row label="Заказов" v={num(data.orders.total)} />
                  <Row
                    label="Ждут передачи поставщику"
                    v={<Link href="/admin/orders?status=created&status=paid">{data.orders.awaiting_hand_over}</Link>}
                  />
                </tbody>
              </table>
            </Box>
            <Box title="Оборот заказов и расходы на ИИ">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th className="num">Оборот</th>
                    <th className="num">Комиссия</th>
                    <th className="num">ИИ</th>
                  </tr>
                </thead>
                <tbody>
                  {PERIODS.map(([k, label]) => (
                    <tr key={k}>
                      <td>{label}</td>
                      <td className="num">{sum(data.orders.turnover[k])}</td>
                      <td className="num">{sum(data.orders.commission[k])}</td>
                      <td className="num">
                        {usd(data.ai[k]?.cost_usd, 2)} <span className="muted">({num(data.ai[k]?.requests)})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
            <Box title="Проекты по статусам">
              <table>
                <tbody>
                  {data.projects.by_status.map((s) => (
                    <tr key={s.status}>
                      <td>
                        <Link href={`/admin/projects?status=${s.status}`}>{s.label}</Link>
                      </td>
                      <td className="num">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
            <Box title="Заказы по статусам">
              <table>
                <tbody>
                  {data.orders.by_status.map((s) => (
                    <tr key={s.status}>
                      <td>
                        <Link href={`/admin/orders?status=${s.status}`}>{s.label}</Link>
                      </td>
                      <td className="num">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
          </div>
        </>
      )}
    </>
  );
}

function Row({ label, v }: { label: string; v: React.ReactNode }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{v}</td>
    </tr>
  );
}
