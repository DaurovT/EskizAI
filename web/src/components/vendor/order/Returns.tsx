'use client';

/**
 * Возвраты и рекламации (§5.2, §5.4 order_returns): открыть по оплаченному заказу, решить
 * (переделать / вернуть деньги / отказать), владелец подтверждает сумму возврата.
 */
import Link from 'next/link';
import { useState } from 'react';
import { Msg, Tag } from '@/components/admin/ui';
import { dt, sum } from '@/lib/admin/format';
import { useAction, useCan, useClient } from '@/lib/staff/hooks';
import {
  parseNum,
  RETURN_DECISION_LABEL,
  RETURN_DECISIONS,
  RETURN_KIND_LABEL,
  RETURN_KINDS,
  RETURN_STATUS_LABEL,
} from '@/lib/vendor/format';
import { Photos } from './Facts';
import type { OrderReturn, VOrder } from './types';

export function ReturnCard({ r, onDone, showOrder }: { r: OrderReturn; onDone: () => void; showOrder?: boolean }) {
  const client = useClient();
  const can = useCan();
  const act = useAction();
  const [decision, setDecision] = useState('');
  const [comment, setComment] = useState('');
  const [refund, setRefund] = useState(r.amount != null ? String(r.amount) : '');
  const [approve, setApprove] = useState(r.refund_amount != null ? String(r.refund_amount) : r.amount != null ? String(r.amount) : '');
  const canDecide = can('vendor.returns') && r.status === 'open';
  const canApprove = can('vendor.refunds.approve') && r.status === 'awaiting_owner';
  const refundNum = parseNum(refund);
  const approveNum = parseNum(approve);

  return (
    <div className="box">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <b>
          {r.number ? `№${r.number} · ` : ''}
          {RETURN_KIND_LABEL[r.type ?? r.kind ?? ''] ?? r.type ?? r.kind}
        </b>
        <Tag color={r.status === 'resolved' ? 'green' : 'yellow'}>{RETURN_STATUS_LABEL[r.status] ?? r.status}</Tag>
        {r.amount != null && <span>на {sum(r.amount)}</span>}
        <span className="muted">
          {dt(r.created_at)} · открыл {(r.created_by ?? r.opened_by_type) === 'master' ? 'мастер' : 'поставщик'}
        </span>
        {showOrder && (
          <Link href={`/vendor/orders/${r.order_id}`}>
            Заказ №{r.order_number ?? r.order_id.slice(0, 8)}
            {r.project_title ? ` · ${r.project_title}` : ''}
          </Link>
        )}
        {showOrder && r.workshop_name && <span className="muted">{r.workshop_name}</span>}
      </div>
      {r.description && <p style={{ whiteSpace: 'pre-wrap' }}>{r.description}</p>}
      {(r.lines ?? []).length > 0 && (
        <ul style={{ margin: '4px 0' }}>
          {(r.lines ?? []).map((l, i) => (
            <li key={l.key ?? i}>
              {l.name ?? l.key} {l.qty != null && `× ${l.qty}`} {l.amount != null && `— ${sum(l.amount)}`}
            </li>
          ))}
        </ul>
      )}
      {(r.photos ?? []).length > 0 && <Photos items={r.photos} />}
      {r.decision && (
        <p>
          Решение: <b>{RETURN_DECISION_LABEL[r.decision] ?? r.decision}</b>
          {r.refund_amount != null && ` · возврат ${sum(r.refund_amount)}`}
          {r.decision_comment && <span className="muted"> — {r.decision_comment}</span>}
          {r.resolved_at && <span className="muted"> · {dt(r.resolved_at)}</span>}
        </p>
      )}
      <Msg message={act.message} />
      {canDecide && (
        <div className="form-grid">
          <label>
            Решение
            <select value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="">— выберите —</option>
              {RETURN_DECISIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {decision === 'refund' && (
            <label>
              Сумма возврата, сум
              <input inputMode="numeric" value={refund} onChange={(e) => setRefund(e.target.value)} />
            </label>
          )}
          <label style={{ gridColumn: 'span 2' }}>
            Комментарий мастеру (обязательно)
            <input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div>
            <button
              type="button"
              className="b primary"
              disabled={
                act.busy ||
                !decision ||
                comment.trim().length < 3 ||
                (decision === 'refund' && (!refundNum || refundNum <= 0))
              }
              onClick={() =>
                void act
                  .run(
                    () =>
                      client.patch(`/vendor/returns/${r.id}`, {
                        decision,
                        comment: comment.trim(),
                        ...(decision === 'refund' ? { refund_amount: Math.round(refundNum ?? 0) } : {}),
                      }),
                    decision === 'refund' ? 'Сумма возврата отправлена владельцу на подтверждение' : 'Решение сохранено',
                  )
                  .then((ok) => ok && onDone())
              }
            >
              Сохранить решение
            </button>
          </div>
        </div>
      )}
      {decision === 'refund' && canDecide && (
        <div className="muted">Деньги вернутся после подтверждения суммы владельцем; комиссия по заказу сторнируется на эту сумму.</div>
      )}
      {canApprove && (
        <div className="toolbar">
          <span>Подтвердить возврат:</span>
          <input className="sm" inputMode="numeric" value={approve} onChange={(e) => setApprove(e.target.value)} />
          <button
            type="button"
            className="b primary"
            disabled={act.busy || !approveNum || approveNum <= 0}
            onClick={() => {
              if (!window.confirm(`Подтвердить возврат ${sum(approveNum)}? Комиссия по заказу будет сторнирована на эту сумму.`)) return;
              void act
                .run(
                  () => client.post(`/vendor/returns/${r.id}/approve-refund`, { amount: Math.round(approveNum ?? 0) }),
                  'Возврат подтверждён',
                )
                .then((ok) => ok && onDone());
            }}
          >
            Подтвердить сумму
          </button>
        </div>
      )}
    </div>
  );
}

export function OpenReturnForm({ o, onDone, onCancel }: { o: VOrder; onDone: () => void; onCancel: () => void }) {
  const client = useClient();
  const act = useAction();
  const [kind, setKind] = useState('defect');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [amount, setAmount] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const lines = o.lines ?? [];
  const pickedLines = lines.filter((l) => picked[l.key]);
  const autoAmount = pickedLines.reduce((s, l) => s + l.total, 0);
  const amountNum = amount ? parseNum(amount) : autoAmount || null;

  async function submit() {
    const form = new FormData();
    form.append('type', kind);
    form.append('description', description.trim());
    if (amountNum) form.append('amount', String(Math.round(amountNum)));
    if (pickedLines.length)
      form.append('lines', JSON.stringify(pickedLines.map((l) => ({ key: l.key, name: l.name, qty: l.qty, amount: l.total }))));
    files.forEach((f) => form.append('files', f));
    await client.api(`/vendor/orders/${o.id}/returns`, { method: 'POST', body: form });
  }

  return (
    <div className="box">
      <h3 style={{ marginTop: 0 }}>Новая рекламация</h3>
      <div className="form-grid">
        <label>
          Тип
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {RETURN_KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Сумма, сум {autoAmount > 0 && !amount && <span>(по строкам {sum(autoAmount)})</span>}
          <input inputMode="numeric" value={amount} placeholder={autoAmount ? String(autoAmount) : ''} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          Фото
          <input type="file" accept="image/*" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
      </div>
      <label className="f">
        Описание (что случилось)
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {lines.length > 0 && (
        <details style={{ margin: '8px 0' }}>
          <summary>Строки заказа ({pickedLines.length} выбрано)</summary>
          {lines.map((l) => (
            <label key={l.key} className="chk" style={{ display: 'flex' }}>
              <input type="checkbox" checked={Boolean(picked[l.key])} onChange={(e) => setPicked((p) => ({ ...p, [l.key]: e.target.checked }))} />
              {l.name} — {l.qty} {l.unit}, {sum(l.total)}
            </label>
          ))}
        </details>
      )}
      <Msg message={act.message} />
      <div className="toolbar">
        <button
          type="button"
          className="b primary"
          disabled={act.busy || description.trim().length < 3}
          onClick={() => void act.run(submit, 'Рекламация открыта').then((ok) => ok && onDone())}
        >
          Открыть
        </button>
        <button type="button" className="b" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}
