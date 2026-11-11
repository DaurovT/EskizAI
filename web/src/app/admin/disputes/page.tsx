'use client';

/** Споры (§4a): мастер не согласен с решением поставщика по возврату или с отклонением заказа.
 *  Вкладки «Открытые» (старые сверху — кто ждёт дольше), «Решённые», «Все»; фильтры по поставщику, предмету, поиску. */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense } from 'react';
import { ago, hoursLabel, SearchInput, useUrlState } from '@/components/admin/ops';
import { Empty, Loading, Pager, Tag } from '@/components/admin/ui';
import { dt, sum } from '@/lib/admin/format';
import { itemsOf, qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';
import { DECISION_LABEL, DISPUTE_REASON_LABEL, SUBJECT_LABEL, type DisputeRow } from './shared';

const LIMIT = 50;
const DEFAULTS = { status: 'open', supplier_id: '', subject: '', q: '', offset: '0' };

function Disputes() {
  const router = useRouter();
  const [f, set] = useUrlState(DEFAULTS);
  const offset = Number(f.offset) || 0;
  const suppliers = useApi<{ id: string; name: string }[] | { items: { id: string; name: string }[] }>('/admin/suppliers');
  const { data, error, loading } = useApi<{ items: DisputeRow[]; counts?: { open: number; resolved: number; all: number } }>(
    `/admin/disputes${qs({ status: f.status, supplier_id: f.supplier_id, subject: f.subject, q: f.q })}`,
  );
  const all = itemsOf(data);
  const rows = all.slice(offset, offset + LIMIT); // API отдаёт до 500 споров — листаем на клиенте
  const counts = data?.counts;
  const filtered = Boolean(f.supplier_id || f.subject || f.q);

  return (
    <>
      <div className="ops-head">
        <div>
          <h1>Споры</h1>
          <div className="ops-sub">Решение видят мастер и поставщик; возврат мастеру сторнирует комиссию платформы пропорционально.</div>
        </div>
      </div>
      <div className="tabs">
        {(
          [
            ['open', 'Открытые', counts?.open],
            ['resolved', 'Решённые', counts?.resolved],
            ['all', 'Все', counts?.all],
          ] as [string, string, number | undefined][]
        ).map(([k, l, n]) => (
          <button key={k} type="button" className={f.status === k ? 'on' : ''} onClick={() => set({ status: k })}>
            {l}
            {n !== undefined && <span className={`ops-n ${k === 'open' && n > 0 ? 'hot' : ''}`}>{n}</span>}
          </button>
        ))}
      </div>
      <div className="ops-filters">
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="№ заказа или цех" />
        <select value={f.supplier_id} onChange={(e) => set({ supplier_id: e.target.value })} aria-label="Поставщик">
          <option value="">Все поставщики</option>
          {itemsOf(suppliers.data).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={f.subject} onChange={(e) => set({ subject: e.target.value })} aria-label="Предмет спора">
          <option value="">Любой предмет</option>
          <option value="return">Решение по возврату</option>
          <option value="rejection">Отклонение заказа</option>
        </select>
        {filtered && (
          <button type="button" className="ops-clear" onClick={() => set({ supplier_id: '', subject: '', q: '' })}>
            Сбросить фильтры
          </button>
        )}
      </div>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>{f.status === 'open' && !filtered ? 'Открытых споров нет — всё решено 👌' : 'Под фильтры споров нет'}</Empty>
        ) : (
          <div className="scroll" style={{ opacity: loading ? 0.6 : 1 }}>
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Спор</th>
                  <th>Цех → поставщик</th>
                  <th>Предмет</th>
                  <th className="num">Просит / решено</th>
                  <th>Статус</th>
                  <th>{f.status === 'open' ? 'Ждёт' : 'Открыт'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const waitH = (Date.now() - new Date(d.created_at).getTime()) / 3600_000;
                  return (
                    <tr
                      key={d.id}
                      className={`clickable ${d.status === 'open' && waitH > 48 ? 'ops-overdue' : ''}`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('a')) return;
                        router.push(`/admin/disputes/${d.id}`);
                      }}
                    >
                      <td>
                        <Link href={`/admin/disputes/${d.id}`}>Заказ №{d.order_number ?? d.order_id.slice(0, 8)}</Link>
                        <div className="sub" style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {DISPUTE_REASON_LABEL[d.reason] ?? d.reason}
                          {d.comment ? ` — ${d.comment}` : ''}
                        </div>
                      </td>
                      <td>
                        {d.workshop_name ?? '—'}
                        <div className="sub">→ {d.supplier_name ?? 'без поставщика'}</div>
                      </td>
                      <td>{SUBJECT_LABEL[d.subject] ?? d.subject}</td>
                      <td className="num">
                        {sum(d.requested_amount ?? null)}
                        {d.status !== 'open' && <div className="sub">решено: {sum(d.amount ?? 0)}</div>}
                      </td>
                      <td>
                        {d.status === 'open' ? (
                          <Tag color="yellow">открыт</Tag>
                        ) : (
                          <Tag color={d.decision === 'supplier' ? undefined : 'green'}>{DECISION_LABEL[d.decision ?? ''] ?? 'решён'}</Tag>
                        )}
                      </td>
                      <td title={dt(d.created_at)}>
                        {d.status === 'open' ? (
                          <span className={`ops-sla ${waitH > 48 ? 'overdue' : waitH > 24 ? 'late' : ''}`}>{hoursLabel(waitH)}</span>
                        ) : (
                          <>
                            {dt(d.created_at, false)}
                            <div className="sub">решён {ago(d.resolved_at)}</div>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pager total={all.length} limit={LIMIT} offset={offset} onChange={(o) => set({ offset: String(o) })} />
          </div>
        ))}
    </>
  );
}

export default function DisputesPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Disputes />
    </Suspense>
  );
}
