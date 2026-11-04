'use client';

/** Спор (§4a): заказ, причина мастера, возврат, переписка; решение с комментарием (видят обе стороны) и причиной. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Box, Loading, Msg, Tag } from '@/components/admin/ui';
import { OrderChat } from '@/components/staff/OrderChat';
import { useReason } from '@/components/staff/reason';
import { dt, ORDER_STATUS_LABEL, sum } from '@/lib/admin/format';
import { apiUrl } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';
import { DECISION_LABEL, RETURN_DECISION, SUBJECT_LABEL, type Attachment, type DisputeRow } from '../shared';

function Photos({ items }: { items?: Attachment[] }) {
  if (!items?.length) return null;
  return (
    <div className="photos">
      {items.map((p, i) => (
        <a key={p.key ?? i} href={apiUrl(p.url)} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={apiUrl(p.url)} alt={p.name ?? ''} />
        </a>
      ))}
    </div>
  );
}

export default function DisputeCard() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const { data: d, error, loading, reload } = useApi<DisputeRow>(`/admin/disputes/${id}`);
  const act = useAction();
  const [reasonDialog, askReason] = useReason();
  const [resolution, setResolution] = useState<'master' | 'supplier' | 'partial'>('master');
  const [comment, setComment] = useState('');
  const [amount, setAmount] = useState('');

  if (!d) return <Loading error={error} loading={loading} />;
  const open = d.status === 'open';
  const ret = d.return;

  async function resolve() {
    const reason = await askReason(`Решение по спору: ${DECISION_LABEL[resolution]}`, {
      hint: 'Решение и комментарий увидят мастер и поставщик; комиссия по заказу будет пересчитана на сумму возврата.',
      confirm: 'Принять решение',
      danger: false,
    });
    if (!reason) return;
    const refund = resolution !== 'supplier' && amount.trim() ? Number(amount.replace(/\s/g, '')) : null;
    const ok = await act.run(
      () =>
        client.post(`/admin/disputes/${id}/resolve`, {
          resolution,
          refund_amount: refund,
          comment: comment.trim(),
          reason,
        }),
      'Спор решён',
    );
    if (ok) reload();
  }

  return (
    <>
      {reasonDialog}
      <p className="muted">
        <Link href="/admin/disputes">← Споры</Link>
      </p>
      <h1>
        Спор по заказу №{d.order_number ?? d.order_id.slice(0, 8)}{' '}
        {open ? <Tag color="yellow">открыт</Tag> : <Tag color="green">{DECISION_LABEL[d.decision ?? ''] ?? 'решён'}</Tag>}
      </h1>
      <Msg message={act.message} />
      <div className="grid2">
        <Box title="Суть">
          <dl className="kv">
            <dt>Заказ</dt>
            <dd>
              <Link href={`/admin/orders/${d.order_id}`}>№{d.order_number ?? d.order_id.slice(0, 8)}</Link>
              {d.order_status && <span className="muted"> · {ORDER_STATUS_LABEL[d.order_status] ?? d.order_status}</span>}
              {d.order_total != null && <span className="muted"> · {sum(d.order_total)}</span>}
            </dd>
            <dt>Цех</dt>
            <dd>{d.workshop_name ?? '—'}</dd>
            <dt>Поставщик</dt>
            <dd>{d.supplier_name ?? '—'}</dd>
            <dt>Предмет</dt>
            <dd>{SUBJECT_LABEL[d.subject] ?? d.subject}</dd>
            {d.subject === 'rejection' && d.reject_reason && (
              <>
                <dt>Причина отклонения</dt>
                <dd>{d.reject_reason}</dd>
              </>
            )}
            <dt>Мастер просит</dt>
            <dd>{sum(d.requested_amount ?? d.amount)}</dd>
            <dt>Открыт</dt>
            <dd>{dt(d.created_at)}</dd>
          </dl>
          <h3>Причина мастера</h3>
          <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{d.reason}</p>
          {d.comment && open && <p style={{ whiteSpace: 'pre-wrap' }} className="muted">{d.comment}</p>}
          <Photos items={d.photos} />
        </Box>
        <Box title={open ? 'Решение' : 'Итог'}>
          {open ? (
            <>
              <div className="form-grid">
                <label>
                  Решение
                  <select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
                    <option value="master">В пользу мастера (возврат / переделка за счёт поставщика)</option>
                    <option value="supplier">В пользу поставщика</option>
                    <option value="partial">Частично</option>
                  </select>
                </label>
                {resolution !== 'supplier' && (
                  <label>
                    Возврат мастеру, сум
                    <input
                      inputMode="numeric"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={d.requested_amount ? String(d.requested_amount) : 'без возврата'}
                    />
                  </label>
                )}
              </div>
              <label className="f">
                Комментарий (видят мастер и поставщик, от 3 символов)
                <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
              </label>
              <div className="toolbar" style={{ marginTop: 10 }}>
                <button type="button" className="b primary" disabled={act.busy || comment.trim().length < 3} onClick={() => void resolve()}>
                  Принять решение
                </button>
              </div>
            </>
          ) : (
            <dl className="kv">
              <dt>Решение</dt>
              <dd>{DECISION_LABEL[d.decision ?? ''] ?? d.decision ?? '—'}</dd>
              <dt>Возврат мастеру</dt>
              <dd>{sum(d.amount)}</dd>
              <dt>Комментарий</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{d.decision_comment ?? d.comment ?? '—'}</dd>
              <dt>Решён</dt>
              <dd>{dt(d.resolved_at)}</dd>
            </dl>
          )}
        </Box>
      </div>
      {ret && (
        <Box title="Возврат, по которому спор">
          <dl className="kv">
            <dt>Тип</dt>
            <dd>{ret.type ?? '—'}</dd>
            <dt>Описание</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{ret.description ?? '—'}</dd>
            <dt>Сумма</dt>
            <dd>{sum(ret.amount)}</dd>
            <dt>Решение поставщика</dt>
            <dd>
              {ret.decision ? (RETURN_DECISION[ret.decision] ?? ret.decision) : '—'}
              {ret.refund_amount != null && ` · ${sum(ret.refund_amount)}`}
              {ret.decision_comment && <div className="muted">{ret.decision_comment}</div>}
            </dd>
          </dl>
          {ret.lines && ret.lines.length > 0 && (
            <div className="scroll">
              <table>
                <tbody>
                  {ret.lines.map((l, i) => (
                    <tr key={l.key ?? i}>
                      <td>{l.name ?? l.key ?? '—'}</td>
                      <td className="num">
                        {l.qty ?? ''} {l.unit ?? ''}
                      </td>
                      <td className="num">{sum(l.total ?? l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Photos items={ret.photos} />
        </Box>
      )}
      <Box title="Переписка по заказу">
        <OrderChat basePath={`/admin/orders/${d.order_id}/messages`} self="platform" />
      </Box>
    </>
  );
}
