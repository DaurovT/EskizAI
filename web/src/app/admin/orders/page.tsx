'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Loading, Pager, Tag } from '@/components/admin/ui';
import { qs } from '@/lib/admin/api';
import { dt, ORDER_STATUSES, orderStatusColor, sum } from '@/lib/admin/format';
import { useApi } from '@/lib/admin/useApi';

interface Row {
  id: string;
  project_id: string;
  project_title: string | null;
  workshop_name: string | null;
  supplier?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  assignee_name?: string | null;
  status: string;
  status_label: string;
  estimate_total: number | null;
  invoice_total: number | null;
  paid_at: string | null;
  handed_over_at: string | null;
  created_at: string;
}

const LIMIT = 50;

function Orders() {
  const router = useRouter();
  const params = useSearchParams();
  const [statuses, setStatuses] = useState<string[]>(params.getAll('status'));
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [supplierId, setSupplierId] = useState(params.get('supplier_id') ?? '');
  const suppliers = useApi<{ id: string; name: string }[] | { items: { id: string; name: string }[] }>('/admin/suppliers');
  const supplierList = suppliers.data ? (Array.isArray(suppliers.data) ? suppliers.data : (suppliers.data.items ?? [])) : [];
  const { data, error, loading } = useApi<{ items: Row[]; total: number }>(
    `/admin/orders${qs({ status: statuses, q: query, supplier_id: supplierId, limit: LIMIT, offset })}`,
  );
  return (
    <>
      <h1>Заказы поставщикам</h1>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQuery(q);
        }}
      >
        <input placeholder="Проект или цех" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          value={statuses.length === 1 ? statuses[0] : statuses.length ? '__many' : ''}
          onChange={(e) => {
            setOffset(0);
            setStatuses(e.target.value ? [e.target.value] : []);
          }}
        >
          <option value="">Все статусы</option>
          {statuses.length > 1 && <option value="__many" disabled>Несколько</option>}
          {ORDER_STATUSES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {supplierList.length > 1 && (
          <select
            value={supplierId}
            onChange={(e) => {
              setOffset(0);
              setSupplierId(e.target.value);
            }}
          >
            <option value="">Все поставщики</option>
            {supplierList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button className="b" type="submit">
          Найти
        </button>
      </form>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Цех</th>
                <th>Поставщик</th>
                <th>Статус</th>
                <th className="num">По смете</th>
                <th className="num">По счёту</th>
                <th>Передан поставщику</th>
                <th>Создан</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => router.push(`/admin/orders/${o.id}`)}>
                  <td>
                    {o.project_title ?? '—'} <span className="muted">#{o.id.slice(0, 8)}</span>
                  </td>
                  <td>{o.workshop_name ?? '—'}</td>
                  <td>
                    {o.supplier_name ?? o.supplier ?? '—'}
                    {o.assignee_name && <div className="muted">{o.assignee_name}</div>}
                  </td>
                  <td>
                    <Tag color={orderStatusColor(o.status)}>{o.status_label}</Tag>
                  </td>
                  <td className="num">{sum(o.estimate_total)}</td>
                  <td className="num">{sum(o.invoice_total)}</td>
                  <td>{o.handed_over_at ? dt(o.handed_over_at) : <Tag color="yellow">нет</Tag>}</td>
                  <td>{dt(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
        </div>
      )}
    </>
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Orders />
    </Suspense>
  );
}
