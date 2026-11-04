'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Empty, Loading, Tag } from '@/components/admin/ui';
import { dt, sum } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useApi, useCan } from '@/lib/staff/hooks';
import { ORDER_STATUS, ORDER_STATUS_LABEL, statusColor } from '@/lib/vendor/format';

export interface VOrderRow {
  id: string;
  number?: number | null;
  project_title?: string | null;
  workshop_name?: string | null;
  status: string;
  status_label?: string;
  assignee_id?: string | null;
  assignee_name?: string | null;
  assignee?: { id: string; name: string } | null;
  waiting_hours?: number | null;
  estimate_total?: number | null;
  invoice_total?: number | null;
  due_date?: string | null;
  unread?: number;
  unread_messages?: number;
  created_at: string;
  status_changed_at?: string | null;
}

interface Page {
  items: VOrderRow[];
  total?: number;
  page?: number;
  pages?: number;
  limit?: number;
  page_size?: number;
}

type Scope = 'queue' | 'mine' | 'all';

function Orders() {
  const router = useRouter();
  const params = useSearchParams();
  const can = useCan();
  const owner = can('vendor.orders.all');
  const initialScope = (params.get('scope') as Scope | null) ?? (params.get('status') ? (owner ? 'all' : 'mine') : 'queue');
  const [scope, setScope] = useState<Scope>(initialScope === 'all' && !owner ? 'mine' : initialScope);
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi<Page | VOrderRow[]>(`/vendor/orders${qs({ scope, status, q: query, page })}`);
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  const meta = Array.isArray(data) ? null : data;
  const limit = meta?.page_size ?? meta?.limit ?? 50;
  const pages = meta?.pages ?? (meta?.total !== undefined ? Math.max(1, Math.ceil(meta.total / limit)) : 1);

  const tabs: [Scope, string][] = [
    ['queue', 'Очередь'],
    ['mine', 'Мои заказы'],
    ...(owner ? ([['all', 'Все заказы']] as [Scope, string][]) : []),
  ];

  return (
    <>
      <h1>Заказы</h1>
      <div className="tabs">
        {tabs.map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={scope === k ? 'on' : ''}
            onClick={() => {
              setScope(k);
              setPage(1);
            }}
          >
            {l}
          </button>
        ))}
      </div>
      {scope === 'queue' && (
        <p className="muted">Новые заказы без конструктора видят все конструкторы. «Взять в работу» — в карточке заказа.</p>
      )}
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q);
        }}
      >
        <input placeholder="Номер, проект или цех" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
        >
          <option value="">Все статусы</option>
          {ORDER_STATUS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button className="b" type="submit">
          Найти
        </button>
      </form>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>{scope === 'queue' ? 'Очередь пуста — новых заказов нет' : 'Заказов нет'}</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Цех</th>
                  <th>Статус</th>
                  <th>Конструктор</th>
                  <th className="num">Сумма</th>
                  <th>Срок</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const unread = o.unread_messages ?? o.unread ?? 0;
                  return (
                    <tr key={o.id} className="clickable" onClick={() => router.push(`/vendor/orders/${o.id}`)}>
                      <td>
                        <b>№{o.number ?? o.id.slice(0, 8)}</b> {o.project_title ?? ''}
                        {unread > 0 && <span className="badge" title="Непрочитанные сообщения">{unread}</span>}
                      </td>
                      <td>{o.workshop_name ?? '—'}</td>
                      <td>
                        <Tag color={statusColor(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status_label ?? o.status}</Tag>
                      </td>
                      <td>
                        {o.assignee?.name ?? o.assignee_name ?? (o.assignee_id ? '—' : <span className="muted">не назначен</span>)}
                        {o.waiting_hours != null && (
                          <div className={o.waiting_hours > 24 ? 'big-change' : 'muted'}>ждёт {Math.round(o.waiting_hours)} ч</div>
                        )}
                      </td>
                      <td className="num">{sum(o.invoice_total ?? o.estimate_total)}</td>
                      <td>{o.due_date ? dt(o.due_date, false) : '—'}</td>
                      <td>{dt(o.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      {pages > 1 && (
        <div className="pager">
          <button className="b" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ←
          </button>
          <span className="muted">
            стр. {page} из {pages}
            {meta?.total !== undefined ? ` · всего ${meta.total}` : ''}
          </span>
          <button className="b" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            →
          </button>
        </div>
      )}
    </>
  );
}

export default function VendorOrdersPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Orders />
    </Suspense>
  );
}
