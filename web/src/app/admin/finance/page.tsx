'use client';

/** Взаиморасчёты (ADM-10, §4a): по каждому поставщику — оборот, комиссия, выплаты, долг; платежи мастеров. */
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { defaultPeriod, PeriodFilter, type Period } from '@/components/admin/Period';
import { Box, Empty, Loading, Msg } from '@/components/admin/ui';
import { num, sum } from '@/lib/admin/format';
import { itemsOf, qs } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

/** finance.supplier_finance() — те же цифры, что у владельца поставщика (/vendor/finance). */
interface SupplierRow {
  supplier: { id: string; code: string; name: string };
  orders: number;
  turnover: number;
  avg_check?: number;
  commission: { accrued: number; reversed: number; due: number };
  refunds?: number;
  settled: number;
  debt: number;
  /** За всё время: долг на сегодня. */
  balance?: { due: number; settled: number; debt: number };
}

interface Finance {
  from: string;
  to: string;
  suppliers: SupplierRow[];
  totals?: { turnover: number; commission_accrued: number; commission_reversed: number; settled: number; debt: number };
  platform_payments?: { by_kind: Record<string, { count: number; amount: number; refunded: number }>; total: number };
}

const KIND: Record<string, string> = { pack: 'Пакеты проектов', pro: 'Pro', files: 'Файлы для станка' };
const TOTAL_LABEL: Record<string, string> = {
  turnover: 'Оборот заказов',
  commission_accrued: 'Комиссия начислена',
  commission_reversed: 'Сторно',
  settled: 'Выплачено поставщиками',
  debt: 'Долг за период',
};

function FinanceInner() {
  const params = useSearchParams();
  const client = useClient();
  const act = useAction();
  const [period, setPeriod] = useState<Period>(defaultPeriod(29));
  const [supplierId, setSupplierId] = useState(params.get('supplier_id') ?? '');
  const suppliers = useApi<{ id: string; name: string }[] | { items: { id: string; name: string }[] }>('/admin/suppliers');
  const query = qs({ from: period.from, to: period.to, supplier_id: supplierId });
  const { data, error, loading } = useApi<Finance>(`/admin/finance${query}`);
  const rows = data?.suppliers ?? [];
  const mp = data?.platform_payments;

  function actCsv(r: SupplierRow) {
    const path = `/admin/finance/act.csv${qs({ supplier_id: r.supplier.id, from: period.from, to: period.to })}`;
    void act.run(() => client.download(path, `act_${r.supplier.code}_${period.from}_${period.to}.csv`));
  }

  return (
    <>
      <h1>Взаиморасчёты</h1>
      <PeriodFilter value={period} onChange={setPeriod} />
      <div className="toolbar">
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">Все поставщики</option>
          {itemsOf(suppliers.data).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <Msg message={act.message} />
      <Loading error={error} loading={loading && !data} />
      {data && (
        <>
          {data.totals && (
            <div className="grid">
              {Object.entries(data.totals).map(([k, v]) => (
                <Box key={k} title={TOTAL_LABEL[k] ?? k}>
                  <div className="kpi">{sum(v)}</div>
                </Box>
              ))}
            </div>
          )}
          <Box title="Поставщики">
            {rows.length === 0 ? (
              <Empty>За период нет оплаченных заказов</Empty>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Поставщик</th>
                      <th className="num">Заказов</th>
                      <th className="num">Оборот</th>
                      <th className="num">Комиссия</th>
                      <th className="num">Сторно</th>
                      <th className="num">Выплачено</th>
                      <th className="num">Долг за период</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.supplier.id} className={r.debt > 0 ? 'warn' : ''}>
                        <td>
                          <Link href={`/admin/suppliers/${r.supplier.id}`}>{r.supplier.name}</Link>
                        </td>
                        <td className="num">{num(r.orders)}</td>
                        <td className="num">{sum(r.turnover)}</td>
                        <td className="num">{sum(r.commission.accrued)}</td>
                        <td className="num">{sum(r.commission.reversed)}</td>
                        <td className="num">{sum(r.settled)}</td>
                        <td className="num">
                          <b>{sum(r.debt)}</b>
                          {r.balance && <div className="muted">всего: {sum(r.balance.debt)}</div>}
                        </td>
                        <td>
                          <button type="button" className="b" disabled={act.busy} onClick={() => actCsv(r)}>
                            Акт сверки CSV
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">Выплаты поставщиков вносятся в карточке поставщика → «Взаиморасчёты». Те же цифры видит владелец поставщика.</p>
          </Box>
          {mp && (
            <Box title="Платежи мастеров платформе" extra={<b>{sum(mp.total)}</b>}>
              {Object.keys(mp.by_kind).length === 0 ? (
                <Empty>За период платежей нет</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Что</th>
                      <th className="num">Платежей</th>
                      <th className="num">Сумма</th>
                      <th className="num">Возвраты</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(mp.by_kind).map(([k, v]) => (
                      <tr key={k}>
                        <td>{KIND[k] ?? k}</td>
                        <td className="num">{num(v.count)}</td>
                        <td className="num">{sum(v.amount)}</td>
                        <td className="num">{v.refunded ? sum(v.refunded) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted">Итого — за вычетом возвратов.</p>
            </Box>
          )}
        </>
      )}
    </>
  );
}

export default function FinancePage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <FinanceInner />
    </Suspense>
  );
}
