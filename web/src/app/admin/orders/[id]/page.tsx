'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LogTable, type LogEntry } from '@/components/admin/LogTable';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { OrderChat } from '@/components/staff/OrderChat';
import { useReason } from '@/components/staff/reason';
import { download, post } from '@/lib/admin/api';
import { dt, ORDER_STATUS_LABEL, orderStatusColor, sum } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';
import { useCan } from '@/lib/staff/hooks';
import { CommissionBox, Intervene } from './intervene';

interface Card {
  id: string;
  project_id: string;
  project_title: string | null;
  workshop_id: string | null;
  workshop_name: string | null;
  workshop_phone: string | null;
  version_number: number | null;
  number?: number | null;
  supplier: string;
  supplier_id?: string | null;
  supplier_name?: string | null;
  group_id?: string | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  due_date?: string | null;
  reject_reason?: string | null;
  vendor_status_note?: string | null;
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
  const can = useCan();
  const [reasonDialog, askReason] = useReason();

  if (!o) return <Loading error={error} loading={loading} />;

  const canPay = o.status === 'created';

  return (
    <>
      <h1>
        Заказ №{o.number ?? o.id.slice(0, 8)} <Tag color={orderStatusColor(o.status)}>{o.status_label}</Tag>
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
            <dd>
              {o.supplier_name ?? o.supplier}
              {o.assignee_name && <span className="muted"> · конструктор {o.assignee_name}</span>}
            </dd>
            {o.due_date && (
              <>
                <dt>Срок готовности</dt>
                <dd>{dt(o.due_date, false)}</dd>
              </>
            )}
            {(o.reject_reason || o.vendor_status_note) && (
              <>
                <dt>Комментарий поставщика</dt>
                <dd>{o.reject_reason ?? o.vendor_status_note}</dd>
              </>
            )}
            <dt>По смете</dt>
            <dd>{sum(o.estimate_total)}</dd>
            <dt>По счёту поставщика</dt>
            <dd>{sum(o.invoice_total)}</dd>
            <dt>Оплата</dt>
            <dd>
              {o.paid_at ? `${dt(o.paid_at)} · ${o.payment_provider ?? ''} ${o.payment_reference ?? ''}` : 'не оплачен'}
            </dd>
            <dt>Комиссия</dt>
            <dd>{o.commission_status === 'accrued' ? 'начислена' : o.commission_status === 'reversed' ? 'сторнирована' : '—'}</dd>
            <dt>Передан поставщику вручную</dt>
            <dd>{o.handed_over_at ? `${dt(o.handed_over_at)} (${o.handed_over_by ?? ''})` : <Tag color="yellow">нет</Tag>}</dd>
            <dt>Заметки</dt>
            <dd>{o.notes ?? '—'}</dd>
            <dt>Создан</dt>
            <dd>{dt(o.created_at)}</dd>
          </dl>
        </Box>
        <Box title="Действия менеджера">
          <h3>1. Ручная передача поставщику (если он не работает в кабинете)</h3>
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
          <h3>2. Оплата на мерчант поставщика</h3>
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
                  onClick={() =>
                    void (async () => {
                      let reason: string | null = null;
                      if (s === 'cancelled' && o.paid_at) {
                        // Отмена оплаченного заказа — опасное действие (§4a): только с причиной
                        reason = await askReason('Отменить ОПЛАЧЕННЫЙ заказ', {
                          hint: 'Комиссия будет сторнирована, мастеру нужно вернуть деньги.',
                          confirm: 'Отменить заказ',
                        });
                        if (!reason) return;
                      } else if (s === 'cancelled' && !window.confirm('Отменить заказ?')) return;
                      await act
                        .run(
                          () => post(`/admin/orders/${o.id}/status`, { status: s, ...(reason ? { reason } : {}) }),
                          `Статус: ${ORDER_STATUS_LABEL[s] ?? s}`,
                        )
                        .then(reload);
                    })()
                  }
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
      {reasonDialog}
      <div className="grid2">
        <Intervene order={o} onDone={reload} />
        <CommissionBox orderId={o.id} />
      </div>
      <Timeline orderId={o.id} />
      <Box title="Переписка мастера и поставщика">
        <OrderChat basePath={`/admin/orders/${o.id}/messages`} self="platform" canWrite={can('*')} />
      </Box>
      <Box title="История">
        <LogTable rows={o.history ?? []} />
      </Box>
    </>
  );
}

interface TimelineEvent {
  id: string;
  type?: string;
  kind?: string;
  status?: string | null;
  from_status?: string | null;
  to_status?: string | null;
  actor_type?: string | null;
  actor_name?: string | null;
  comment?: string | null;
  created_at: string;
}

interface ReturnRow { id: string; number?: number | null; type: string; status: string; description?: string; decision_comment?: string | null; refund_amount?: number | null }
interface DisputeRow { id: string; subject: string; status: string; comment?: string }
const RETURN_TYPE: Record<string, string> = { defect: 'брак', cut_error: 'ошибка раскроя', shortage: 'недовложение', cancel_after_pay: 'отмена после оплаты', other: 'другое' };
const RETURN_STATUS: Record<string, string> = { open: 'ждёт решения', awaiting_owner: 'ждёт владельца поставщика', resolved: 'решён' };
const ACTOR_LABEL: Record<string, string> = { master: 'мастер', vendor: 'поставщик', platform: 'платформа', system: 'система' };
const EVENT_LABEL: Record<string, string> = {
  take: 'Конструктор взял заказ',
  assign: 'Назначен конструктор',
  message: 'Сообщение',
  correction_created: 'Предложено исправление',
  correction_approved: 'Мастер подтвердил исправление',
  correction_declined: 'Мастер отклонил исправление',
  resubmitted: 'Мастер отправил заказ заново',
  return_opened: 'Открыт возврат',
  return_decided: 'Решение по возврату',
  refund_approved: 'Владелец подтвердил возврат денег',
  dispute_opened: 'Открыт спор',
  dispute_resolved: 'Спор решён',
  intervene: 'Вмешательство платформы',
  change_supplier: 'Сменён поставщик',
  update: 'Изменены данные заказа (счёт, ссылка, заметки)',
  paid: 'Оплата отмечена',
};

/** Лента заказа (order_events): статусы и действия мастера, поставщика, платформы. */
function Timeline({ orderId }: { orderId: string }) {
  const { data, error } = useApi<{ events: TimelineEvent[]; corrections?: unknown[]; returns?: ReturnRow[]; disputes?: DisputeRow[] }>(
    `/admin/orders/${orderId}/timeline`,
  );
  if (!data) {
    return error ? (
      <Box title="Лента заказа">
        <Loading error={error} loading={false} />
      </Box>
    ) : null;
  }
  return (
    <Box
      title="Лента заказа"
      extra={
        <span className="muted">
          исправлений: {data.corrections?.length ?? 0} · возвратов: {data.returns?.length ?? 0} · споров: {data.disputes?.length ?? 0}
        </span>
      }
    >
      {(data.returns?.length ?? 0) + (data.disputes?.length ?? 0) > 0 && (
        <div style={{ marginBottom: 12 }}>
          {data.returns?.map((r) => (
            <div key={r.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line, #eee)' }}>
              <b>Возврат №{r.number ?? '—'}</b> · {RETURN_TYPE[r.type] ?? r.type} · <Tag color={r.status === 'resolved' ? 'green' : 'yellow'}>{RETURN_STATUS[r.status] ?? r.status}</Tag>
              {r.refund_amount ? ` · к возврату ${sum(r.refund_amount)}` : ''}
              <div className="muted">{r.description}{r.decision_comment ? ` — ответ: ${r.decision_comment}` : ''}</div>
            </div>
          ))}
          {data.disputes?.map((d) => (
            <div key={d.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line, #eee)' }}>
              <Link href={`/admin/disputes/${d.id}`}><b>Спор</b></Link> · {d.subject === 'rejection' ? 'по отклонению' : 'по возврату'} ·{' '}
              <Tag color={d.status === 'resolved' ? 'green' : 'yellow'}>{d.status === 'resolved' ? 'решён' : 'открыт'}</Tag>
              <div className="muted">{d.comment}</div>
            </div>
          ))}
        </div>
      )}
      {data.events.length === 0 ? (
        <Empty>Событий пока нет</Empty>
      ) : (
        <div className="scroll">
          <table>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dt(e.created_at)}</td>
                  <td>{e.actor_name || ACTOR_LABEL[e.actor_type ?? ''] || e.actor_type || '—'}</td>
                  <td>
                    {(e.to_status ?? e.status) ? (
                      <>
                        {e.from_status ? `${ORDER_STATUS_LABEL[e.from_status] ?? e.from_status} → ` : ''}
                        <b>{ORDER_STATUS_LABEL[(e.to_status ?? e.status) as string] ?? e.to_status ?? e.status}</b>
                      </>
                    ) : (
                      EVENT_LABEL[e.type ?? e.kind ?? ''] ?? e.type ?? e.kind
                    )}
                    {e.comment && <div className="muted">{e.comment}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Box>
  );
}
