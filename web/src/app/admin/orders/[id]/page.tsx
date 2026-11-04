'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LogTable, type LogEntry } from '@/components/admin/LogTable';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { download, post } from '@/lib/admin/api';
import { dt, ORDER_STATUS_LABEL, sum } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';

interface Card {
  id: string;
  project_id: string;
  project_title: string | null;
  workshop_id: string | null;
  workshop_name: string | null;
  workshop_phone: string | null;
  version_number: number | null;
  supplier: string;
  status: string;
  status_label: string;
  estimate_total: number | null;
  invoice_total: number | null;
  payment_provider: string | null;
  payment_reference: string | null;
  paid_at: string | null;
  handed_over_at: string | null;
  handed_over_by: string | null;
  commission_status: string | null;
  notes: string | null;
  created_at: string;
  distance_km: number | null;
  /** mebel_core.supplier_order(): состав заказа поставщику по себестоимости */
  supplier_order: {
    lines: { key: string; name: string; unit: string; qty: number; price: number; total: number }[];
    excluded: string[];
    goods_total: number;
    delivery: { weight_kg: number; distance_km: number; cost: number; breakdown: Record<string, number> } | null;
    total: number;
    weight_kg: number;
  } | null;
  lines: { key: string; name: string; unit: string; qty: number; price: number; total: number }[];
  cost_total: number | null;
  allowed_statuses: string[];
  history: LogEntry[];
}

export default function OrderCard() {
  const { id } = useParams<{ id: string }>();
  const { data: o, error, loading, reload } = useApi<Card>(`/admin/orders/${id}`);
  const act = useAction();
  const [invoice, setInvoice] = useState('');
  const [provider, setProvider] = useState('invoice');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  if (!o) return <Loading error={error} loading={loading} />;

  const canPay = o.status === 'created';

  return (
    <>
      <h1>
        Заказ #{o.id.slice(0, 8)} <Tag color={o.status === 'cancelled' ? 'red' : 'green'}>{o.status_label}</Tag>
      </h1>
      <Msg message={act.message} />
      <div className="grid2">
        <Box title="Заказ">
          <dl className="kv">
            <dt>Проект</dt>
            <dd>
              <Link href={`/admin/projects/${o.project_id}`}>{o.project_title ?? o.project_id}</Link>
              {o.version_number !== null && <span className="muted"> · версия {o.version_number}</span>}
            </dd>
            <dt>Цех</dt>
            <dd>
              {o.workshop_id ? <Link href={`/admin/workshops/${o.workshop_id}`}>{o.workshop_name}</Link> : '—'}
              {o.workshop_phone && <span className="muted"> · {o.workshop_phone}</span>}
            </dd>
            <dt>Поставщик</dt>
            <dd>{o.supplier}</dd>
            <dt>По смете</dt>
            <dd>{sum(o.estimate_total)}</dd>
            <dt>По счёту EMAN</dt>
            <dd>{sum(o.invoice_total)}</dd>
            <dt>Оплата</dt>
            <dd>
              {o.paid_at ? `${dt(o.paid_at)} · ${o.payment_provider ?? ''} ${o.payment_reference ?? ''}` : 'не оплачен'}
            </dd>
            <dt>Комиссия</dt>
            <dd>{o.commission_status === 'accrued' ? 'начислена' : o.commission_status === 'reversed' ? 'сторнирована' : '—'}</dd>
            <dt>Передан в EMAN</dt>
            <dd>{o.handed_over_at ? `${dt(o.handed_over_at)} (${o.handed_over_by ?? ''})` : <Tag color="yellow">нет</Tag>}</dd>
            <dt>Заметки</dt>
            <dd>{o.notes ?? '—'}</dd>
            <dt>Создан</dt>
            <dd>{dt(o.created_at)}</dd>
          </dl>
        </Box>
        <Box title="Действия менеджера">
          <h3>1. Ручная передача в EMAN</h3>
          <div className="toolbar">
            <button
              className="b"
              type="button"
              disabled={act.busy}
              onClick={() => void act.run(() => download(`/admin/orders/${o.id}/csv`, `order_${o.id.slice(0, 8)}.csv`))}
            >
              Скачать CSV онлайн-кроя
            </button>
            <input placeholder="Заметка (кому, как передан)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button
              className="b primary"
              type="button"
              disabled={act.busy || o.status === 'cancelled'}
              onClick={() =>
                void act.run(() => post(`/admin/orders/${o.id}/hand-over`, { note: note || null }), 'Отмечено: передан в EMAN').then(reload)
              }
            >
              Отметить «передан»
            </button>
          </div>
          <h3>2. Оплата на мерчант EMAN</h3>
          {canPay ? (
            <div className="toolbar">
              <input type="number" placeholder="Сумма по счёту, сум" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="invoice">счёт EMAN</option>
                <option value="click">Click</option>
                <option value="payme">Payme</option>
              </select>
              <input placeholder="Номер счёта / транзакции" value={reference} onChange={(e) => setReference(e.target.value)} />
              <button
                className="b primary"
                type="button"
                disabled={act.busy}
                onClick={() =>
                  void act
                    .run(
                      () =>
                        post(`/admin/projects/${o.project_id}/order-paid`, {
                          invoice_total: invoice ? Number(invoice) : null,
                          estimate_total: o.estimate_total,
                          payment_provider: provider,
                          payment_reference: reference || null,
                        }),
                      'Оплата отмечена: проект «В работе», лимит возвращён',
                    )
                    .then(reload)
                }
              >
                Отметить оплату
              </button>
            </div>
          ) : (
            <div className="muted">{o.paid_at ? 'Оплата уже отмечена' : 'Недоступно в этом статусе'}</div>
          )}
          <h3>3. Статус заказа</h3>
          {o.allowed_statuses.length === 0 ? (
            <div className="muted">Дальше статус не меняется</div>
          ) : (
            <div className="toolbar">
              {o.allowed_statuses.map((s) => (
                <button
                  key={s}
                  className={`b ${s === 'cancelled' ? 'danger' : ''}`}
                  type="button"
                  disabled={act.busy}
                  onClick={() => {
                    if (s === 'cancelled' && !window.confirm('Отменить заказ? Комиссия будет сторнирована')) return;
                    void act
                      .run(() => post(`/admin/orders/${o.id}/status`, { status: s }), `Статус: ${ORDER_STATUS_LABEL[s] ?? s}`)
                      .then(reload);
                  }}
                >
                  → {ORDER_STATUS_LABEL[s] ?? s}
                </button>
              ))}
            </div>
          )}
        </Box>
      </div>
      <Box title="Состав заказа поставщику (себестоимость)" extra={<b>{sum(o.cost_total)}</b>}>
        {o.lines.length === 0 ? (
          <Empty>Состав недоступен</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Позиция</th>
                  <th className="num">Кол-во</th>
                  <th className="num">Цена</th>
                  <th className="num">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.key}>
                    <td>{l.name}</td>
                    <td className="num">
                      {l.qty} {l.unit}
                    </td>
                    <td className="num">{sum(l.price)}</td>
                    <td className="num">{sum(l.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {o.supplier_order && (
          <div className="muted" style={{ marginTop: 8 }}>
            Товары: {sum(o.supplier_order.goods_total)} · вес ≈ {Math.round(o.supplier_order.weight_kg)} кг ·{' '}
            {o.supplier_order.delivery
              ? `доставка ${o.supplier_order.delivery.distance_km} км: ${sum(o.supplier_order.delivery.cost)}`
              : 'самовывоз'}
            {o.supplier_order.excluded.length > 0 && (
              <div>
                <Tag color="yellow">под запрос</Tag> не входят в заказ: {o.supplier_order.excluded.join(', ')}
              </div>
            )}
          </div>
        )}
      </Box>
      <Box title="История">
        <LogTable rows={o.history} />
      </Box>
    </>
  );
}
