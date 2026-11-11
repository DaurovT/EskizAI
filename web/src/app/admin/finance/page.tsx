'use client';

/** Взаиморасчёты (ADM-10, §4a): по каждому поставщику — оборот, комиссия, выплаты, долг; платежи мастеров. */
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { defaultPeriod, PeriodFilter, type Period } from '@/components/admin/Period';
import { Box, Empty, Loading, Msg } from '@/components/admin/ui';
import { Dialog, parseSum, Stat } from '@/components/admin/ops';
import { isoDay, num, sum, sumShort } from '@/lib/admin/format';
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
  const { data, error, loading, reload } = useApi<Finance>(`/admin/finance${query}`);
  const rows = data?.suppliers ?? [];
  const [paying, setPaying] = useState<SupplierRow | null>(null);
  const mp = data?.platform_payments;

  function actCsv(r: SupplierRow) {
    const path = `/admin/finance/act.csv${qs({ supplier_id: r.supplier.id, from: period.from, to: period.to })}`;
    void act.run(() => client.download(path, `act_${r.supplier.code}_${period.from}_${period.to}.csv`));
  }

  return (
    <>
      <div className="ops-head">
        <div>
          <h1>Взаиморасчёты</h1>
          <div className="ops-sub">Оборот и комиссия — по дате оплаты заказа. Долг за период = комиссия − сторно − выплачено за период.</div>
        </div>
        <button
          type="button"
          className="b"
          disabled={act.busy}
          onClick={() =>
            void act.run(() =>
              client.download(`/admin/finance/report.csv${qs({ from: period.from, to: period.to })}`, `finance_${period.from}_${period.to}.csv`),
            )
          }
        >
          Отчёт за период CSV
        </button>
      </div>
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
            <div className="ops-stats">
              {Object.entries(data.totals).map(([k, v]) => (
                <Stat key={k} label={TOTAL_LABEL[k] ?? k} value={sumShort(v)} tone={k === 'debt' && v > 0 ? 'warn' : undefined} />
              ))}
              {mp && <Stat label="Выручка от мастеров" value={sumShort(mp.total)} hint="пакеты, Pro, файлы минус возвраты" />}
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
                          <div className="row-actions">
                            <button type="button" className="b primary" onClick={() => setPaying(r)}>
                              Внести выплату
                            </button>
                            <button type="button" className="b" disabled={act.busy} onClick={() => actCsv(r)}>
                              Акт сверки CSV
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">Те же цифры видит владелец поставщика в своём кабинете. История выплат — в карточке поставщика.</p>
          </Box>
          {paying && (
            <SettlementDialog
              row={paying}
              period={period}
              onClose={() => setPaying(null)}
              onDone={() => {
                setPaying(null);
                act.setMessage({ kind: 'ok', text: `Выплата ${paying.supplier.name} внесена` });
                reload();
              }}
            />
          )}
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

/** Выплата поставщика платформе: сумма (по умолчанию — долг на сегодня), дата, период, комментарий. */
function SettlementDialog({ row, period, onClose, onDone }: { row: SupplierRow; period: Period; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const act = useAction();
  const debt = row.balance?.debt ?? row.debt;
  const [amount, setAmount] = useState(debt > 0 ? String(debt) : '');
  const [paidAt, setPaidAt] = useState(isoDay(new Date()));
  const [comment, setComment] = useState('');
  const [usePeriod, setUsePeriod] = useState(true);
  const value = parseSum(amount);
  return (
    <Dialog title={`Выплата от ${row.supplier.name}`} onClose={onClose}>
      <div className="muted">
        Долг на сегодня: <b>{sum(debt)}</b> · за период {period.from} — {period.to}: {sum(row.debt)}
      </div>
      <div className="form-grid">
        <label>
          Сумма, сум
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </label>
        <label>
          Дата оплаты
          <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </label>
      </div>
      <label className="chk">
        <input type="checkbox" checked={usePeriod} onChange={(e) => setUsePeriod(e.target.checked)} /> за период {period.from} — {period.to}
      </label>
      <label className="f">
        Комментарий (платёжка №…)
        <input value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      {value !== null && value > debt && debt >= 0 && <div className="ops-consequence">Сумма больше долга — останется переплата {sum(value - debt)}.</div>}
      <Msg message={act.message} />
      <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
        <button type="button" className="b" onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className="b primary"
          disabled={act.busy || !value || value <= 0}
          onClick={() =>
            void act
              .run(() =>
                client.post(`/admin/suppliers/${row.supplier.id}/settlements`, {
                  amount: value,
                  paid_at: `${paidAt}T12:00:00+05:00`,
                  period_from: usePeriod ? `${period.from}T00:00:00+05:00` : null,
                  period_to: usePeriod ? `${period.to}T23:59:59+05:00` : null,
                  comment: comment.trim() || null,
                }),
              )
              .then((ok) => ok && onDone())
          }
        >
          Внести {value ? sum(value) : ''}
        </button>
      </div>
    </Dialog>
  );
}

export default function FinancePage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <FinanceInner />
    </Suspense>
  );
}
