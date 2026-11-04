'use client';

/** Взаиморасчёты с платформой (§5.1 vendor.finance): оборот, комиссия, выплаты, долг, акт сверки CSV. */
import { useState } from 'react';
import { Box, Empty, Loading, Msg } from '@/components/admin/ui';
import { defaultPeriod, PeriodFilter, type Period } from '@/components/admin/Period';
import { dt, num, sum } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

interface Settlement {
  id?: string;
  period_from?: string | null;
  period_to?: string | null;
  amount: number;
  paid_at?: string | null;
  comment?: string | null;
}

interface Finance {
  orders?: number;
  turnover?: number;
  avg_check?: number;
  commission?: { accrued?: number; reversed?: number; due?: number };
  refunds?: number;
  settled?: number;
  debt?: number;
  balance?: { due?: number; settled?: number; debt?: number };
  settlements?: Settlement[];
}

/** Плитки периода: [значение, подпись, формат]. */
function tiles(d: Finance): [number | undefined, string, 'sum' | 'num', boolean?][] {
  return [
    [d.turnover, 'Оборот оплаченных заказов', 'sum'],
    [d.orders, 'Оплаченных заказов', 'num'],
    [d.avg_check, 'Средний чек', 'sum'],
    [d.commission?.accrued, 'Комиссия платформе начислена', 'sum'],
    [d.commission?.reversed, 'Сторно по возвратам', 'sum'],
    [d.commission?.due, 'К оплате платформе за период', 'sum'],
    [d.refunds, 'Возвраты мастерам', 'sum'],
    [d.settled, 'Оплачено платформе за период', 'sum'],
    [d.debt, 'Долг за период', 'sum', true],
  ];
}

export default function VendorFinance() {
  const client = useClient();
  const [period, setPeriod] = useState<Period>(defaultPeriod(30));
  const { data, error, loading } = useApi<Finance>(`/vendor/finance${qs({ from: period.from, to: period.to })}`);
  const act = useAction();
  const d = data;

  return (
    <>
      <h1>Взаиморасчёты с платформой</h1>
      <PeriodFilter value={period} onChange={setPeriod} />
      <Loading error={error} loading={loading && !data} />
      {d && (
        <>
          <div className="counters">
            {tiles(d)
              .filter(([v]) => v !== undefined)
              .map(([v, l, f, warn]) => (
                <div key={l} className="box">
                  <div className={`kpi ${warn && Number(v) > 0 ? 'warn' : ''}`}>{f === 'sum' ? sum(v) : num(v)}</div>
                  <div className="muted">{l}</div>
                </div>
              ))}
          </div>
          {d.balance && (
            <div className="msg warn" style={{ background: Number(d.balance.debt) > 0 ? undefined : 'var(--a-accent-soft)' }}>
              За всё время: начислено к оплате {sum(d.balance.due)}, оплачено {sum(d.balance.settled)}, долг{' '}
              <b>{sum(d.balance.debt)}</b>
            </div>
          )}
          <div className="toolbar">
            <button
              type="button"
              className="b"
              disabled={act.busy}
              onClick={() =>
                void act.run(() =>
                  client.download(`/vendor/finance/act.csv${qs({ from: period.from, to: period.to })}`, `akt_${period.from}_${period.to}.csv`),
                )
              }
            >
              Скачать акт сверки (CSV)
            </button>
          </div>
          <Msg message={act.message} />
          <Box title="Выплаты платформе">
            {(d.settlements ?? []).length === 0 ? (
              <Empty>Выплат за период нет</Empty>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Период</th>
                      <th className="num">Сумма</th>
                      <th>Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(d.settlements ?? []).map((s, i) => (
                      <tr key={s.id ?? i}>
                        <td>{dt(s.paid_at, false)}</td>
                        <td>
                          {s.period_from ? dt(s.period_from, false) : ''} — {s.period_to ? dt(s.period_to, false) : ''}
                        </td>
                        <td className="num">{sum(s.amount)}</td>
                        <td>{s.comment ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">Выплаты фиксирует платформа; цифры совпадают с теми, что видит администратор платформы.</p>
          </Box>
        </>
      )}
    </>
  );
}
