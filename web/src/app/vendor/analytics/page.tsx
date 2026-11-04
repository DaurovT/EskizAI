'use client';

/** Сводка владельца (§5.1 vendor.analytics): заказы по статусам и дням, оборот, топ цехов, очередь, работа конструкторов. */
import { useState } from 'react';
import { Box, Empty, Loading, Tag } from '@/components/admin/ui';
import { defaultPeriod, PeriodFilter, type Period } from '@/components/admin/Period';
import { num, sum } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';
import { ORDER_STATUS_LABEL, statusColor } from '@/lib/vendor/format';

interface Designer {
  id?: string;
  name: string;
  role?: string;
  is_active?: boolean;
  accepted?: number;
  returned?: number;
  rejected?: number;
  open_orders?: number;
  avg_hours_to_accept?: number | null;
  avg_hours_to_ready?: number | null;
}

interface Analytics {
  turnover?: number;
  paid_orders?: number;
  orders?: {
    total?: number;
    by_status?: Record<string, number>;
    by_day?: { date: string; count: number }[];
  };
  top_workshops?: { name: string; workshop_id?: string; orders?: number; turnover?: number }[];
  queue?: { count?: number; oldest_hours?: number | null };
  designers?: Designer[];
}

function hours(h: number | null | undefined): string {
  if (h === null || h === undefined) return '—';
  return h < 48 ? `${Math.round(h)} ч` : `${(h / 24).toFixed(1)} дн`;
}

export default function VendorAnalytics() {
  const [period, setPeriod] = useState<Period>(defaultPeriod(30));
  const { data: d, error, loading } = useApi<Analytics>(`/vendor/analytics${qs({ from: period.from, to: period.to })}`);
  const byStatus = Object.entries(d?.orders?.by_status ?? {});
  const days = d?.orders?.by_day ?? [];
  const maxDay = Math.max(1, ...days.map((x) => x.count));

  return (
    <>
      <h1>Аналитика</h1>
      <PeriodFilter value={period} onChange={setPeriod} />
      <Loading error={error} loading={loading && !d} />
      {d && (
        <>
          <div className="counters">
            {d.turnover !== undefined && (
              <div className="box">
                <div className="kpi">{sum(d.turnover)}</div>
                <div className="muted">Оборот оплаченных за период{d.paid_orders !== undefined ? ` (${d.paid_orders} заказов)` : ''}</div>
              </div>
            )}
            {d.orders?.total !== undefined && (
              <div className="box">
                <div className="kpi">{num(d.orders.total)}</div>
                <div className="muted">Новых заказов за период</div>
              </div>
            )}
            {d.queue && (
              <div className="box">
                <div className={`kpi ${d.queue.count ? 'warn' : ''}`}>{num(d.queue.count ?? 0)}</div>
                <div className="muted">
                  В очереди сейчас{d.queue.oldest_hours != null ? ` · старейший ждёт ${hours(d.queue.oldest_hours)}` : ''}
                </div>
              </div>
            )}
          </div>
          <div className="grid2">
            <Box title="Заказы по дням">
              {days.length === 0 ? (
                <Empty />
              ) : (
                <>
                  <div className="bars" aria-label="Заказы по дням">
                    {days.map((x) => (
                      <div key={x.date} style={{ height: `${(x.count / maxDay) * 100}%` }} title={`${x.date}: ${x.count} заказов`} />
                    ))}
                  </div>
                  <div className="muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span>{days[0]?.date}</span>
                    <span>{days[days.length - 1]?.date}</span>
                  </div>
                </>
              )}
            </Box>
            <Box title="По статусам">
              {byStatus.length === 0 ? (
                <Empty />
              ) : (
                <table>
                  <tbody>
                    {byStatus.map(([s, c]) => (
                      <tr key={s}>
                        <td>
                          <Tag color={statusColor(s)}>{ORDER_STATUS_LABEL[s] ?? s}</Tag>
                        </td>
                        <td className="num">{c}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Box>
          </div>
          <Box title="Работа конструкторов">
            {(d.designers ?? []).length === 0 ? (
              <Empty />
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Конструктор</th>
                      <th className="num">Принято</th>
                      <th className="num">Возвращено</th>
                      <th className="num">Отклонено</th>
                      <th className="num">До принятия</th>
                      <th className="num">До «готово»</th>
                      <th className="num">Открытых</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(d.designers ?? []).map((x, i) => (
                      <tr key={x.id ?? i}>
                        <td className={x.is_active === false ? 'muted' : ''}>
                          {x.name}
                          {x.role === 'vendor_owner' && <span className="muted"> · владелец</span>}
                        </td>
                        <td className="num">{num(x.accepted ?? 0)}</td>
                        <td className="num">{num(x.returned ?? 0)}</td>
                        <td className="num">{num(x.rejected ?? 0)}</td>
                        <td className="num">{hours(x.avg_hours_to_accept)}</td>
                        <td className="num">{hours(x.avg_hours_to_ready)}</td>
                        <td className="num">{num(x.open_orders ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Box>
          <Box title="Топ цехов">
            {(d.top_workshops ?? []).length === 0 ? (
              <Empty />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Цех</th>
                    <th className="num">Заказов</th>
                    <th className="num">Оборот</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.top_workshops ?? []).map((w, i) => (
                    <tr key={w.workshop_id ?? i}>
                      <td>{w.name}</td>
                      <td className="num">{num(w.orders ?? 0)}</td>
                      <td className="num">{sum(w.turnover)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Box>
        </>
      )}
    </>
  );
}
