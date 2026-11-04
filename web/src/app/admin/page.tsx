'use client';

import Link from 'next/link';
import { Box, Loading } from '@/components/admin/ui';
import { num, sum, usd } from '@/lib/admin/format';
import { useApi } from '@/lib/admin/useApi';

interface Counted {
  status: string;
  label: string;
  count: number;
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
}

const PERIODS: [string, string][] = [
  ['today', 'Сегодня'],
  ['week', '7 дней'],
  ['month', 'Месяц'],
];

export default function DashboardPage() {
  const { data, error, loading } = useApi<Dashboard>('/admin/dashboard');
  return (
    <>
      <h1>Дашборд</h1>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <>
          <div className="grid">
            <Box title="Цеха">
              <div className="kpi">{num(data.workshops.total)}</div>
              <div className="muted">
                активны за 30 дней: {data.workshops.active_30d} · заблокированы: {data.workshops.blocked}
              </div>
            </Box>
            <Box title="Проекты">
              <div className="kpi">{num(data.projects.total)}</div>
              <div className="muted">создано сегодня: {data.projects.created_today}</div>
            </Box>
            <Box title="Заказы">
              <div className="kpi">{num(data.orders.total)}</div>
              <div className="muted">
                ждут передачи в EMAN:{' '}
                <Link href="/admin/orders?status=created&status=paid">{data.orders.awaiting_hand_over}</Link>
              </div>
            </Box>
            <Box title="Нестандарт (ADM-09)">
              <Link href="/admin/nonstandard">Очередь заявок →</Link>
            </Box>
          </div>
          <div className="grid2">
            <Box title="Оборот заказов и комиссия EMAN">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th className="num">Оборот</th>
                    <th className="num">Комиссия ({data.orders.commission_percent}%)</th>
                  </tr>
                </thead>
                <tbody>
                  {PERIODS.map(([k, label]) => (
                    <tr key={k}>
                      <td>{label}</td>
                      <td className="num">{sum(data.orders.turnover[k])}</td>
                      <td className="num">{sum(data.orders.commission[k])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
            <Box title="Расходы на ИИ">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th className="num">Запросов</th>
                    <th className="num">Стоимость</th>
                  </tr>
                </thead>
                <tbody>
                  {PERIODS.map(([k, label]) => (
                    <tr key={k}>
                      <td>{label}</td>
                      <td className="num">{num(data.ai[k]?.requests)}</td>
                      <td className="num">{usd(data.ai[k]?.cost_usd, 2)}</td>
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
