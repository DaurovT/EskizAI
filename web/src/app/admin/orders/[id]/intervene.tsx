'use client';

/**
 * Комиссия платформы по заказу и вмешательство (§4a): три явных действия — передать другому поставщику,
 * назначить статус, отменить заказ. У каждого — что произойдёт, обязательная причина (в журнал) и необязательное
 * сообщение мастеру и поставщику от имени платформы.
 */
import { useState } from 'react';
import { Dialog, ReasonField, reasonOk } from '@/components/admin/ops';
import { Box, Loading, Msg, Tag } from '@/components/admin/ui';
import { ORDER_STATUSES, ORDER_STATUS_LABEL, sum } from '@/lib/admin/format';
import { itemsOf } from '@/lib/staff/client';
import { useAction, useApi, useCan, useClient } from '@/lib/staff/hooks';

export interface OrderLite {
  id: string;
  number?: number | null;
  status: string;
  paid_at: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  supplier?: string;
}

interface Commission {
  status: string | null;
  order_total: number;
  accrued: number | null;
  reversed: number;
  net: number | null;
  expected: number | null;
  rate_percent: number | null;
  supplier_rate_percent: number | null;
  supplier_name: string | null;
  paid_at: string | null;
}

export function CommissionBox({ orderId }: { orderId: string }) {
  const { data: c, error, loading } = useApi<Commission>(`/admin/orders/${orderId}/commission`);
  return (
    <Box title="Комиссия платформы">
      <Loading error={error} loading={loading && !c} />
      {c && (
        <dl className="kv">
          <dt>Сумма заказа</dt>
          <dd>{sum(c.order_total)}</dd>
          {c.accrued != null ? (
            <>
              <dt>Начислена при оплате</dt>
              <dd>
                <b>{sum(c.accrued)}</b>
                {c.rate_percent != null && <span className="muted"> · {c.rate_percent}% от суммы</span>}
              </dd>
              <dt>Сторно</dt>
              <dd>{c.reversed ? <span className="ops-sla late">−{sum(c.reversed)}</span> : '—'}</dd>
              <dt>Итого платформе</dt>
              <dd>
                <b>{sum(c.net)}</b> {c.status === 'reversed' && <Tag color="red">сторнирована полностью</Tag>}
              </dd>
            </>
          ) : c.expected != null ? (
            <>
              <dt>Ожидается при оплате</dt>
              <dd>
                {sum(c.expected)}
                {c.rate_percent != null && <span className="muted"> · {c.rate_percent}%</span>}
              </dd>
            </>
          ) : (
            <>
              <dt>Комиссия</dt>
              <dd className="muted">не начисляется (заказ закрыт или без поставщика)</dd>
            </>
          )}
          {c.supplier_rate_percent != null && (
            <>
              <dt>Ставка поставщика сейчас</dt>
              <dd>
                {c.supplier_rate_percent}% <span className="muted">(общая; по категориям строк может отличаться)</span>
              </dd>
            </>
          )}
        </dl>
      )}
    </Box>
  );
}

type Kind = 'change_supplier' | 'set_status' | 'cancel';

const CLOSED = ['cancelled', 'issued', 'rejected'];

export function Intervene({ order, onDone }: { order: OrderLite; onDone: () => void }) {
  const can = useCan();
  const [open, setOpen] = useState<Kind | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!can('orders.manage')) return null;
  const closed = CLOSED.includes(order.status);
  return (
    <Box title="Вмешательство платформы">
      <p className="muted" style={{ marginTop: 0 }}>
        Когда поставщик не отвечает, ошибся статусом или заказ нужно снять. Каждое действие — с причиной в журнал; мастер
        и поставщик видят событие в ленте заказа.
      </p>
      {done && <div className="msg ok">{done}</div>}
      <div className="ops-actions">
        <button type="button" className="b" onClick={() => setOpen('change_supplier')} disabled={Boolean(order.paid_at) || closed}
          title={order.paid_at ? 'Оплаченный заказ к другому поставщику не переносится' : undefined}>
          Передать другому поставщику
        </button>
        <button type="button" className="b" onClick={() => setOpen('set_status')}>
          Назначить статус
        </button>
        <button type="button" className="b danger" onClick={() => setOpen('cancel')} disabled={closed && order.status !== 'rejected'}>
          Отменить заказ
        </button>
      </div>
      {open && (
        <InterveneDialog
          kind={open}
          order={order}
          onClose={() => setOpen(null)}
          onDone={(text) => {
            setOpen(null);
            setDone(text);
            onDone();
          }}
        />
      )}
    </Box>
  );
}

function InterveneDialog({ kind: initial, order, onClose, onDone }: { kind: Kind; order: OrderLite; onClose: () => void; onDone: (t: string) => void }) {
  const client = useClient();
  const act = useAction();
  const [kind, setKind] = useState<Kind>(initial);
  const [supplierId, setSupplierId] = useState('');
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const suppliers = useApi<{ id: string; name: string; active?: boolean }[] | { items: { id: string; name: string; active?: boolean }[] }>(
    '/admin/suppliers',
  );
  const list = itemsOf(suppliers.data).filter((s) => s.id !== order.supplier_id);
  const paid = Boolean(order.paid_at);
  const label = (s: string) => ORDER_STATUS_LABEL[s] ?? s;

  const choices: [Kind, string, string, boolean][] = [
    ['change_supplier', 'Передать другому поставщику', paid ? 'Недоступно: заказ уже оплачен этому поставщику' : 'Заказ уйдёт в очередь нового поставщика, конструктор снимется', paid],
    ['set_status', 'Назначить статус', 'Поправить статус вручную, если поставщик ошибся или не отметил', false],
    ['cancel', 'Отменить заказ', paid ? 'Оплачен: комиссия сторнируется, мастеру нужно вернуть деньги' : 'Заказ закроется, мастер получит уведомление', false],
  ];

  let consequence: React.ReactNode = null;
  let ready = reasonOk(reason);
  if (kind === 'change_supplier') {
    ready = ready && Boolean(supplierId) && !paid;
    const to = list.find((s) => s.id === supplierId);
    consequence = to && (
      <div className="ops-consequence">
        {order.supplier_name ?? 'Без поставщика'} → <b>{to.name}</b>. Заказ получит новый поставщик в статусе «{label(order.status)}»;
        прежний перестанет его видеть.
      </div>
    );
  } else if (kind === 'set_status') {
    ready = ready && Boolean(status) && status !== order.status;
    consequence = status && (
      <div className={`ops-consequence ${status === 'cancelled' && paid ? 'red' : ''}`}>
        «{label(order.status)}» → <b>«{label(status)}»</b>.{' '}
        {status === 'paid' && !paid && 'Отметка оплаты: начислится комиссия, проект мастера перейдёт «В работу». '}
        {status === 'cancelled' && paid && 'Заказ оплачен — комиссия сторнируется. '}
        Мастер получит push о смене статуса.
      </div>
    );
  } else {
    consequence = (
      <div className={`ops-consequence ${paid ? 'red' : ''}`}>
        {paid
          ? `Заказ оплачен${order.supplier_name ? ` поставщику ${order.supplier_name}` : ''}: комиссия платформы сторнируется целиком, деньги мастеру возвращает поставщик.`
          : 'Заказ будет отменён. Мастер сможет оформить новый заказ по проекту.'}
      </div>
    );
  }

  return (
    <Dialog title={`Заказ №${order.number ?? order.id.slice(0, 8)}: вмешательство`} onClose={onClose}>
      <div className="ops-choice" role="radiogroup">
        {choices.map(([k, title, hint, disabled]) => (
          <label key={k} className={`${kind === k ? 'on' : ''} ${disabled ? 'dis' : ''}`}>
            <input type="radio" name="kind" checked={kind === k} disabled={disabled} onChange={() => setKind(k)} />
            <span>
              <b>{title}</b>
              <span className="muted">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      {kind === 'change_supplier' && (
        <label className="f">
          Новый поставщик
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">— выберите —</option>
            {list.map((s) => (
              <option key={s.id} value={s.id} disabled={s.active === false}>
                {s.name}
                {s.active === false ? ' (заблокирован)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'set_status' && (
        <label className="f">
          Новый статус
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">— выберите —</option>
            {ORDER_STATUSES.filter(([v]) => v !== order.status).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      )}
      {consequence}
      <ReasonField value={reason} onChange={setReason} autoFocus={false} />
      <label className="f">
        Сообщение мастеру и поставщику в переписку заказа (необязательно)
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Например: «Поставщик не ответил за сутки — передали в Металлоцех»" />
      </label>
      <Msg message={act.message} />
      <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
        <button type="button" className="b" onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className={`b ${kind === 'cancel' || (kind === 'set_status' && status === 'cancelled') ? 'danger' : 'primary'}`}
          disabled={act.busy || !ready}
          onClick={() =>
            void act
              .run(() =>
                client.post(`/admin/orders/${order.id}/intervene`, {
                  action: kind,
                  reason: reason.trim(),
                  ...(kind === 'change_supplier' ? { supplier_id: supplierId } : {}),
                  ...(kind === 'set_status' ? { status } : {}),
                  comment: comment.trim() || null,
                }),
              )
              .then((ok) =>
                ok &&
                onDone(
                  kind === 'cancel'
                    ? 'Заказ отменён'
                    : kind === 'set_status'
                      ? `Статус: ${label(status)}`
                      : `Заказ передан: ${list.find((s) => s.id === supplierId)?.name ?? ''}`,
                ),
              )
          }
        >
          {kind === 'cancel' ? 'Отменить заказ' : kind === 'set_status' ? 'Назначить статус' : 'Передать'}
        </button>
      </div>
    </Dialog>
  );
}
