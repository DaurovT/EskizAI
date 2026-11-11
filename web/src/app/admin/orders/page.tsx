'use client';

/** Заказы всех поставщиков (ADM-08): фильтры (поставщик, статус, цех, период, просрочка), SLA — сколько заказ
 *  в текущем статусе и кто должен действовать; просроченные — красным. Фильтры — в адресе страницы. */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense } from 'react';
import { hoursLabel, SearchInput, SortTh, Stat, useUrlState, WAITING_LABEL } from '@/components/admin/ops';
import { Empty, Loading, Pager, Tag } from '@/components/admin/ui';
import { dt, num, ORDER_STATUSES, ORDER_STATUS_LABEL, orderStatusColor, sum } from '@/lib/admin/format';
import { itemsOf, qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';

interface Row {
  id: string;
  number: number | null;
  project_id: string;
  project_title: string | null;
  workshop_id: string | null;
  workshop_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  assignee_name?: string | null;
  status: string;
  status_label: string;
  total: number | null;
  paid_at: string | null;
  due_date: string | null;
  commission_amount: number | null;
  created_at: string;
  sla: { since: string | null; hours_in_status: number | null; waiting_on: string | null; overdue: boolean; late: boolean; no_supplier: boolean };
}

interface List {
  items: Row[];
  total: number;
  overdue_hours: number;
  counters: { overdue: number; late: number; platform_queue: number };
}

const LIMIT = 50;
const DEFAULTS = {
  q: '',
  status: '',
  supplier_id: '',
  workshop_id: '',
  overdue: '',
  late: '',
  hours: '',
  from: '',
  to: '',
  sort: 'created_at',
  order: 'desc',
  offset: '0',
};

/** Группы статусов для быстрого выбора. */
const GROUPS: [string, string, string[]][] = [
  ['', 'Все', []],
  ['open', 'В работе', ['created', 'accepted', 'paid', 'cutting', 'ready', 'returned', 'awaiting_approval']],
  ['done', 'Выданы', ['issued']],
  ['closed', 'Отменены и отклонены', ['cancelled', 'rejected']],
];

function Orders() {
  const router = useRouter();
  const [f, set, reset] = useUrlState(DEFAULTS);
  const offset = Number(f.offset) || 0;
  const group = GROUPS.find(([k]) => k === f.status);
  const status = group ? group[2] : f.status ? [f.status] : [];
  const suppliers = useApi<{ id: string; name: string }[] | { items: { id: string; name: string }[] }>('/admin/suppliers');
  const workshop = useApi<{ name: string }>(f.workshop_id ? `/admin/workshops/${f.workshop_id}/summary` : null);
  const { data, error, loading } = useApi<List>(
    `/admin/orders${qs({
      q: f.q,
      status,
      supplier_id: f.supplier_id,
      workshop_id: f.workshop_id,
      overdue: f.overdue || null,
      late: f.late || null,
      overdue_hours: f.hours || null,
      from: f.from,
      to: f.to,
      sort: f.sort,
      order: f.order,
      limit: LIMIT,
      offset,
    })}`,
  );
  const filtered = Object.entries(f).some(([k, v]) => !['sort', 'order', 'offset'].includes(k) && v !== '');
  const sortProps = { sort: f.sort, order: f.order, onSort: (k: string, o: 'asc' | 'desc') => set({ sort: k, order: o }) };
  const c = data?.counters;

  return (
    <>
      <div className="ops-head">
        <div>
          <h1>Заказы поставщикам</h1>
          <div className="ops-sub">
            Просрочен — заказ в «Создан» дольше {data?.overdue_hours ?? '…'} ч без ответа поставщика. Срок вышел — прошла дата
            готовности, а заказ ещё не готов.
          </div>
        </div>
      </div>
      <div className="ops-stats">
        <Stat
          label={`Просрочены (> ${data?.overdue_hours ?? '…'} ч без ответа)`}
          value={c ? num(c.overdue) : '…'}
          tone={c?.overdue ? 'bad' : undefined}
          on={f.overdue === 'true'}
          onClick={() => set({ overdue: f.overdue === 'true' ? '' : 'true', late: '', sort: 'status_age', order: 'desc' })}
        />
        <Stat
          label="Срок готовности вышел"
          value={c ? num(c.late) : '…'}
          tone={c?.late ? 'warn' : undefined}
          on={f.late === 'true'}
          onClick={() => set({ late: f.late === 'true' ? '' : 'true', overdue: '' })}
        />
        <Stat
          label="Без поставщика (очередь платформы)"
          value={c ? num(c.platform_queue) : '…'}
          tone={c?.platform_queue ? 'warn' : undefined}
          on={f.supplier_id === 'none'}
          onClick={() => set({ supplier_id: f.supplier_id === 'none' ? '' : 'none' })}
        />
        <Stat label="Найдено по фильтрам" value={data ? num(data.total) : '…'} />
      </div>
      <div className="ops-filters">
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="№ заказа, проект или цех" />
        <select value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="Статус">
          {GROUPS.map(([k, l]) => (
            <option key={k} value={k}>
              {k ? l : 'Все статусы'}
            </option>
          ))}
          <optgroup label="Статус">
            {ORDER_STATUSES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </optgroup>
        </select>
        <select value={f.supplier_id} onChange={(e) => set({ supplier_id: e.target.value })} aria-label="Поставщик">
          <option value="">Все поставщики</option>
          <option value="none">Без поставщика</option>
          {itemsOf(suppliers.data).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="chk">
          создан с <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="chk">
          по <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        {f.overdue === 'true' && (
          <label className="chk" title="Порог просрочки для этого списка">
            дольше
            <input className="xs" type="number" min={1} value={f.hours || String(data?.overdue_hours ?? '')} onChange={(e) => set({ hours: e.target.value })} />
            ч
          </label>
        )}
        {f.workshop_id && (
          <span className="tag green">
            Цех: {workshop.data?.name ?? '…'}{' '}
            <button type="button" className="ops-clear" style={{ padding: 0 }} onClick={() => set({ workshop_id: '' })} aria-label="Убрать фильтр по цеху">
              ✕
            </button>
          </span>
        )}
        {filtered && (
          <button type="button" className="ops-clear" onClick={reset}>
            Сбросить фильтры
          </button>
        )}
      </div>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (data.items.length === 0 ? (
          <Empty>{filtered ? 'Под фильтры заказов нет' : 'Заказов пока нет'}</Empty>
        ) : (
          <div className="scroll" style={{ opacity: loading ? 0.6 : 1 }}>
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Цех</th>
                  <th>Поставщик</th>
                  <th>Статус</th>
                  <SortTh k="status_age" label="В статусе (SLA)" {...sortProps} title="Сколько заказ в текущем статусе" />
                  <SortTh k="total" label="Сумма" num {...sortProps} />
                  <th className="num">Комиссия</th>
                  <SortTh k="created_at" label="Создан" {...sortProps} />
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr
                    key={o.id}
                    className={`clickable ${o.sla.overdue ? 'ops-overdue' : o.sla.late ? 'ops-late' : ''}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a')) return;
                      router.push(`/admin/orders/${o.id}`);
                    }}
                  >
                    <td>
                      <Link href={`/admin/orders/${o.id}`}>№{o.number ?? o.id.slice(0, 8)}</Link>
                      <div className="sub">{o.project_title ?? '—'}</div>
                    </td>
                    <td>{o.workshop_id ? <Link href={`/admin/workshops/${o.workshop_id}`}>{o.workshop_name}</Link> : '—'}</td>
                    <td>
                      {o.supplier_name ?? <Tag color="yellow">нет — очередь платформы</Tag>}
                      {o.assignee_name && <div className="sub">{o.assignee_name}</div>}
                    </td>
                    <td>
                      <Tag color={orderStatusColor(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status_label}</Tag>
                    </td>
                    <td>
                      <span className={`ops-sla ${o.sla.overdue ? 'overdue' : o.sla.late ? 'late' : ''}`} title={o.sla.since ? `с ${dt(o.sla.since)}` : undefined}>
                        {['issued', 'cancelled', 'rejected'].includes(o.status) ? '—' : hoursLabel(o.sla.hours_in_status)}
                        {o.sla.overdue && ' · просрочен'}
                        {o.sla.late && ' · срок вышел'}
                      </span>
                      {o.sla.waiting_on && <div className="ops-who">{WAITING_LABEL[o.sla.waiting_on]}</div>}
                    </td>
                    <td className="num">
                      {sum(o.total)}
                      {o.paid_at && <div className="sub">оплачен</div>}
                    </td>
                    <td className="num">{o.commission_amount != null ? sum(o.commission_amount) : <span className="muted">—</span>}</td>
                    <td>{dt(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={data.total} limit={LIMIT} offset={offset} onChange={(o) => set({ offset: String(o) })} />
          </div>
        ))}
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
