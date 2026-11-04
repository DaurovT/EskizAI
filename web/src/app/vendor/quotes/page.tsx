'use client';

/** Позиции без цены (§5.2 vendor.quotes): разовая цена для конкретной сметы, в общий каталог не пишется. */
import { useState } from 'react';
import { Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { dt, sum } from '@/lib/admin/format';
import { itemsOf, qs } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';
import { parseNum } from '@/lib/vendor/format';

interface Req {
  id: string;
  name: string;
  unit: string;
  qty: number;
  status: string;
  price: number | null;
  total?: number | null;
  estimate_price?: number | null;
  lead_days?: number | null;
  note?: string | null;
  project_title?: string | null;
  workshop_name?: string | null;
  valid_until?: string | null;
  expired?: boolean;
  created_at: string;
}

const STATUS: [string, string][] = [
  ['pending', 'Ждут цены'],
  ['priced', 'Цена дана'],
  ['accepted', 'Мастер принял'],
  ['declined', 'Мастер отказался'],
];
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUS);

function Row({ r, onDone }: { r: Req; onDone: () => void }) {
  const client = useClient();
  const act = useAction();
  const [price, setPrice] = useState(r.price != null ? String(r.price) : '');
  const [days, setDays] = useState(r.lead_days != null ? String(r.lead_days) : '');
  const [note, setNote] = useState(r.note ?? '');
  const p = parseNum(price);
  const editable = r.status === 'pending' || r.status === 'priced';
  return (
    <tr>
      <td>
        <b>{r.name}</b>
        <div className="muted">
          {r.qty} {r.unit}
          {r.estimate_price ? ` · в смете ${sum(r.estimate_price)}` : ''}
        </div>
      </td>
      <td>
        {r.project_title ?? '—'}
        <div className="muted">{r.workshop_name ?? ''}</div>
      </td>
      <td>
        <Tag color={r.status === 'pending' ? 'yellow' : r.status === 'declined' ? 'red' : 'green'}>
          {STATUS_LABEL[r.status] ?? r.status}
        </Tag>
        {r.expired && <Tag color="red">срок цены истёк</Tag>}
        <div className="muted">{dt(r.created_at)}</div>
      </td>
      <td className="edit-cell">
        {editable ? (
          <div className="row-actions">
            <input inputMode="numeric" placeholder="Цена за ед." value={price} onChange={(e) => setPrice(e.target.value)} />
            <input className="xs" inputMode="numeric" placeholder="дней" value={days} onChange={(e) => setDays(e.target.value)} />
            <input placeholder="Примечание" value={note} onChange={(e) => setNote(e.target.value)} />
            <button
              type="button"
              className="b primary"
              disabled={act.busy || !p || p <= 0}
              onClick={() =>
                void act
                  .run(
                    () =>
                      client.post(`/vendor/price-requests/${r.id}/price`, {
                        price: Math.round(p ?? 0),
                        lead_days: parseNum(days),
                        note: note.trim() || null,
                      }),
                    'Цена отправлена мастеру',
                  )
                  .then((ok) => ok && onDone())
              }
            >
              Отправить
            </button>
          </div>
        ) : (
          <span>
            {sum(r.price)} {r.lead_days != null && <span className="muted">· {r.lead_days} дн.</span>}
          </span>
        )}
        {p && r.qty ? <div className="muted">итого {sum(Math.round(p * r.qty))}</div> : null}
        <Msg message={act.message} />
      </td>
    </tr>
  );
}

export default function VendorQuotes() {
  const [status, setStatus] = useState('pending');
  const { data, error, loading, reload } = useApi<Req[] | { items: Req[] }>(`/vendor/price-requests${qs({ status })}`);
  const rows = itemsOf(data);
  return (
    <>
      <h1>Позиции без цены</h1>
      <p className="muted">
        Цена для конкретной сметы — разовая: мастер получит push и примет её в приложении. Общий прайс меняет только владелец
        в разделе «Прайс».
      </p>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Все</option>
          {STATUS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>Нет позиций</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Позиция</th>
                  <th>Проект</th>
                  <th>Статус</th>
                  <th>Цена и срок</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.id} r={r} onDone={reload} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}
