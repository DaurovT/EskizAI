'use client';

/** Действия конструктора по заказу (§5.2): взять / назначить, принять со счётом, вернуть мастеру, отклонить, производство. */
import { useEffect, useState } from 'react';
import { Msg } from '@/components/admin/ui';
import { sum } from '@/lib/admin/format';
import { itemsOf, roleLabel } from '@/lib/staff/client';
import { useAction, useApi, useCan, useClient, useSession } from '@/lib/staff/hooks';
import { dueDateIso, parseNum, PRODUCTION_LABEL, PRODUCTION_NEXT, REJECT_REASONS } from '@/lib/vendor/format';
import type { StaffUser } from '@/components/staff/StaffManager';
import type { VOrder } from './types';

export function useOrderRights(o: VOrder) {
  const can = useCan();
  const session = useSession();
  const owner = can('vendor.orders.all');
  const work = can('vendor.orders.work');
  const mine = Boolean(o.assignee_id && o.assignee_id === session?.me.id);
  // Переходы считает сервер (allowed_statuses); без него — по контракту §5.3
  const next = o.allowed_statuses ?? (o.status === 'created' ? ['accepted', 'returned', 'rejected'] : PRODUCTION_NEXT[o.status] ? [PRODUCTION_NEXT[o.status]!] : []);
  const free = !o.assignee_id;
  const actor = work && (mine || owner || free);
  return {
    owner,
    mine,
    take: work && free && !['issued', 'rejected', 'cancelled'].includes(o.status),
    assign: owner && !['issued', 'rejected', 'cancelled'].includes(o.status),
    review: actor && next.includes('accepted'),
    returnToMaster: actor && next.includes('returned'),
    reject: actor && next.includes('rejected'),
    productionNext: actor ? next.filter((s) => s in PRODUCTION_LABEL) : [],
    production: actor && next.some((s) => s in PRODUCTION_LABEL),
    correct: can('vendor.corrections') && (mine || owner || free) && !o.paid_at && ['created', 'accepted'].includes(o.status),
    chat: can('vendor.chat'),
    returns: can('vendor.returns'),
  };
}

export function Assignment({ o, onDone }: { o: VOrder; onDone: () => void }) {
  const client = useClient();
  const rights = useOrderRights(o);
  const act = useAction();
  const staff = useApi<StaffUser[] | { items: StaffUser[] }>(rights.assign ? '/staff/users' : null);
  const [assignee, setAssignee] = useState(o.assignee_id ?? '');
  useEffect(() => setAssignee(o.assignee_id ?? ''), [o.assignee_id]);
  const people = itemsOf(staff.data).filter((u) => u.is_active);

  return (
    <div className="toolbar" style={{ marginBottom: 0 }}>
      <span>
        Конструктор: <b>{o.assignee_name ?? (o.assignee_id ? '—' : 'не назначен')}</b>
        {rights.mine && <span className="muted"> (вы)</span>}
      </span>
      {rights.take && (
        <button
          type="button"
          className="b primary"
          disabled={act.busy}
          onClick={() => void act.run(() => client.post(`/vendor/orders/${o.id}/take`), 'Заказ ваш').then((ok) => ok && onDone())}
        >
          Взять в работу
        </button>
      )}
      {rights.assign && people.length > 0 && (
        <>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">— назначить —</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({roleLabel(u.role)})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="b"
            disabled={act.busy || !assignee || assignee === o.assignee_id}
            onClick={() =>
              void act
                .run(() => client.post(`/vendor/orders/${o.id}/assign`, { assignee_id: assignee }), 'Конструктор назначен')
                .then((ok) => ok && onDone())
            }
          >
            Назначить
          </button>
        </>
      )}
      <Msg message={act.message} />
    </div>
  );
}

export function Review({ o, onDone }: { o: VOrder; onDone: () => void }) {
  const client = useClient();
  const rights = useOrderRights(o);
  const act = useAction();
  const [invoice, setInvoice] = useState(String(o.invoice_total ?? o.estimate_total ?? o.cost_total ?? ''));
  const [due, setDue] = useState('');
  const [acceptComment, setAcceptComment] = useState('');
  const [returnComment, setReturnComment] = useState('');
  const [reason, setReason] = useState('');
  const [rejectComment, setRejectComment] = useState('');

  if (!rights.review && !rights.returnToMaster && !rights.reject) return null;
  const invoiceNum = parseNum(invoice);

  return (
    <>
      <Msg message={act.message} />
      <div className="actions-grid">
        {rights.review && (
          <div>
            <h3>Принять</h3>
            <div className="muted">Заказ проверен. Мастер получит уведомление и ссылку на оплату.</div>
            <label className="f">
              Сумма счёта, сум {o.estimate_total != null && <span>(по смете {sum(o.estimate_total)})</span>}
              <input inputMode="numeric" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
            </label>
            <label className="f">
              Срок готовности
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="f">
              Комментарий мастеру
              <textarea rows={2} value={acceptComment} onChange={(e) => setAcceptComment(e.target.value)} />
            </label>
            <button
              type="button"
              className="b primary"
              disabled={act.busy || invoiceNum === null || invoiceNum <= 0}
              onClick={() =>
                void act
                  .run(
                    () =>
                      client.post(`/vendor/orders/${o.id}/accept`, {
                        invoice_total: Math.round(invoiceNum ?? 0),
                        due_date: dueDateIso(due),
                        comment: acceptComment.trim() || null,
                      }),
                    'Заказ принят, счёт выставлен',
                  )
                  .then((ok) => ok && onDone())
              }
            >
              Принять со счётом {invoiceNum ? sum(invoiceNum) : ''}
            </button>
          </div>
        )}
        {rights.returnToMaster && (
          <div>
            <h3>Вернуть мастеру</h3>
            <div className="muted">Нужна правка: ошибка в замерах, не тот декор… Мастер исправит проект и отправит заново; комментарий уйдёт ему в переписку.</div>
            <label className="f">
              Что исправить (обязательно)
              <textarea rows={4} value={returnComment} onChange={(e) => setReturnComment(e.target.value)} />
            </label>
            <button
              type="button"
              className="b"
              disabled={act.busy || returnComment.trim().length < 3}
              onClick={() =>
                void act
                  .run(() => client.post(`/vendor/orders/${o.id}/return`, { comment: returnComment.trim() }), 'Заказ возвращён мастеру')
                  .then((ok) => ok && onDone())
              }
            >
              Вернуть на правку
            </button>
          </div>
        )}
        {rights.reject && (
          <div>
            <h3>Отклонить</h3>
            <div className="muted">Выполнить нельзя — заказ будет закрыт.</div>
            <label className="f">
              Причина
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">— выберите —</option>
                {REJECT_REASONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              Пояснение (обязательно)
              <textarea rows={2} value={rejectComment} onChange={(e) => setRejectComment(e.target.value)} />
            </label>
            <button
              type="button"
              className="b danger"
              disabled={act.busy || !reason || rejectComment.trim().length < 3}
              onClick={() => {
                if (!window.confirm('Отклонить заказ? Это окончательно.')) return;
                void act
                  .run(
                    () => client.post(`/vendor/orders/${o.id}/reject`, { reason, comment: rejectComment.trim() }),
                    'Заказ отклонён',
                  )
                  .then((ok) => ok && onDone());
              }}
            >
              Отклонить заказ
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export function Production({ o, onDone }: { o: VOrder; onDone: () => void }) {
  const client = useClient();
  const rights = useOrderRights(o);
  const act = useAction();
  const [comment, setComment] = useState('');
  if (!rights.production) return null;
  const next = rights.productionNext;
  if (!next.length) return null;
  return (
    <>
      <div className="toolbar">
        <input placeholder="Комментарий (необязательно)" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: '1 1 220px' }} />
        {next.map((s) => (
          <button
            key={s}
            type="button"
            className="b primary"
            disabled={act.busy}
            onClick={() =>
              void act
                .run(
                  () => client.post(`/vendor/orders/${o.id}/status`, { status: s, comment: comment.trim() || null }),
                  `Статус: ${PRODUCTION_LABEL[s]}`,
                )
                .then((ok) => {
                  if (ok) {
                    setComment('');
                    onDone();
                  }
                })
            }
          >
            → {PRODUCTION_LABEL[s]}
          </button>
        ))}
      </div>
      <Msg message={act.message} />
    </>
  );
}
