'use client';

/**
 * Спор (§4a): доводы обеих сторон рядом — мастер (причина, фото, возврат, его сообщения) и поставщик (решение по
 * возврату или причина отклонения, его сообщения и файлы); выдержка из переписки; решение — в пользу мастера,
 * поставщика или частично, сумма возврата не больше предела (сумма заказа минус уже обещанные возвраты), комментарий
 * сторонам и отдельная причина в журнал.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Dialog, hoursLabel, parseSum, ReasonField, reasonOk } from '@/components/admin/ops';
import { Box, Loading, Msg, Tag } from '@/components/admin/ui';
import { OrderChat } from '@/components/staff/OrderChat';
import { dt, ORDER_STATUS_LABEL, sum } from '@/lib/admin/format';
import { apiUrl } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';
import {
  DECISION_LABEL,
  DISPUTE_REASON_LABEL,
  REJECT_REASON_LABEL,
  RETURN_DECISION,
  RETURN_KIND_LABEL,
  SUBJECT_LABEL,
  type Attachment,
  type DisputeCard as Card,
  type DisputeMessage,
} from '../shared';

function Files({ items }: { items?: Attachment[] }) {
  if (!items?.length) return null;
  const images = items.filter((a) => (a.content_type ?? '').startsWith('image/'));
  const other = items.filter((a) => !(a.content_type ?? '').startsWith('image/'));
  return (
    <>
      {images.length > 0 && (
        <div className="photos" style={{ marginTop: 6 }}>
          {images.map((p, i) => (
            <a key={p.key ?? i} href={apiUrl(p.url)} target="_blank" rel="noreferrer" title={p.name ?? ''}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={apiUrl(p.url)} alt={p.name ?? 'фото'} />
            </a>
          ))}
        </div>
      )}
      {other.length > 0 && (
        <div className="ops-files">
          {other.map((p, i) => (
            <a key={p.key ?? i} className="file" href={apiUrl(p.url)} target="_blank" rel="noreferrer">
              📎 {p.name ?? 'файл'}
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function Messages({ items, empty }: { items: DisputeMessage[]; empty: string }) {
  if (!items.length) return <div className="muted">{empty}</div>;
  return (
    <div className="ops-msgs">
      {items.map((m) => (
        <div key={m.id} className={`m ${m.author_type}`}>
          <div className="meta">
            {m.author_name ?? m.author_type} · {dt(m.created_at)}
          </div>
          {m.text && <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>}
          <Files items={m.attachments} />
        </div>
      ))}
    </div>
  );
}

export default function DisputeCardPage() {
  const { id } = useParams<{ id: string }>();
  const { data: d, error, loading, reload } = useApi<Card>(`/admin/disputes/${id}`);
  const [confirming, setConfirming] = useState(false);
  const [resolution, setResolution] = useState<'master' | 'supplier' | 'partial'>('master');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [done, setDone] = useState<string | null>(null);

  if (!d) return <Loading error={error} loading={loading} />;
  const open = d.status === 'open';
  const ret = d.return;
  const msgs = d.messages ?? [];
  const masterMsgs = msgs.filter((m) => m.author_type === 'master');
  const vendorMsgs = msgs.filter((m) => m.author_type === 'vendor');
  const cap = d.max_refund ?? d.order_total ?? 0;
  const requested = d.requested_amount ?? null;
  const refund = resolution === 'supplier' ? null : parseSum(amount);
  const overCap = refund !== null && refund > cap;
  const partialNeedsSum = resolution === 'partial' && !refund;
  const ready = comment.trim().length >= 3 && !overCap && !partialNeedsSum && (refund === null || refund >= 0);
  const waitH = (Date.now() - new Date(d.created_at).getTime()) / 3600_000;

  return (
    <>
      <Link href="/admin/disputes" className="ops-back">
        ← Споры
      </Link>
      <div className="ops-head">
        <div>
          <h1>
            Спор по заказу №{d.order_number ?? d.order_id.slice(0, 8)}{' '}
            {open ? <Tag color="yellow">открыт · ждёт {hoursLabel(waitH)}</Tag> : <Tag color="green">{DECISION_LABEL[d.decision ?? ''] ?? 'решён'}</Tag>}
          </h1>
          <div className="ops-sub">
            {SUBJECT_LABEL[d.subject] ?? d.subject} · {d.workshop_name ?? '—'} → {d.supplier_name ?? 'без поставщика'} · открыт {dt(d.created_at)}
          </div>
        </div>
        <Link href={`/admin/orders/${d.order_id}`} className="b" style={{ border: '1px solid var(--a-line)', borderRadius: 6, padding: '6px 12px', background: '#fff' }}>
          Карточка заказа →
        </Link>
      </div>
      {done && <div className="msg ok">{done}</div>}
      <div className="ops-stats">
        <div className="ops-stat">
          <div className="l">Сумма заказа</div>
          <div className="v">{sum(d.order_total)}</div>
          <div className="h">{d.order_status ? (ORDER_STATUS_LABEL[d.order_status] ?? d.order_status) : ''}{d.order_paid_at ? ' · оплачен' : ' · не оплачен'}</div>
        </div>
        <div className="ops-stat warn">
          <div className="l">Мастер просит</div>
          <div className="v">{requested != null ? sum(requested) : '—'}</div>
        </div>
        <div className="ops-stat">
          <div className="l">Уже обещано вернуть</div>
          <div className="v">{sum(d.refunds_committed ?? 0)}</div>
          <div className="h">возвраты и другие споры</div>
        </div>
        <div className="ops-stat">
          <div className="l">Можно вернуть не больше</div>
          <div className="v">{sum(cap)}</div>
        </div>
        {d.commission?.accrued != null && (
          <div className="ops-stat">
            <div className="l">Комиссия платформы</div>
            <div className="v">{sum(d.commission.accrued - (d.commission.reversed ?? 0))}</div>
            <div className="h">сторно пропорционально возврату</div>
          </div>
        )}
      </div>

      <div className="ops-sides">
        <section className="box ops-side master">
          <h2>Мастер</h2>
          <dl className="kv">
            <dt>Цех</dt>
            <dd>{d.workshop_name ?? '—'}</dd>
            <dt>С чем не согласен</dt>
            <dd>
              <b>{DISPUTE_REASON_LABEL[d.reason] ?? d.reason}</b>
            </dd>
          </dl>
          {d.comment && <div className="ops-quote">{d.comment}</div>}
          <Files items={d.photos} />
          {ret && ret.created_by !== 'vendor' && (
            <>
              <h3>Рекламация мастера{ret.created_at ? ` · ${dt(ret.created_at, false)}` : ''}</h3>
              <dl className="kv">
                <dt>Тип</dt>
                <dd>{RETURN_KIND_LABEL[ret.type ?? ''] ?? ret.type ?? '—'}</dd>
                <dt>Заявлено</dt>
                <dd>{sum(ret.amount)}</dd>
              </dl>
              {ret.description && <div className="ops-quote">{ret.description}</div>}
              {ret.lines && ret.lines.length > 0 && (
                <table className="ops-table">
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
              )}
              <Files items={ret.photos} />
            </>
          )}
          <h3>Сообщения мастера ({masterMsgs.length})</h3>
          <Messages items={masterMsgs.slice(-5)} empty="Мастер в переписке не писал" />
        </section>
        <section className="box ops-side vendor">
          <h2>Поставщик</h2>
          <dl className="kv">
            <dt>Поставщик</dt>
            <dd>{d.supplier_name ?? '—'}</dd>
            {d.subject === 'rejection' ? (
              <>
                <dt>Отклонил заказ</dt>
                <dd>
                  <b>{REJECT_REASON_LABEL[d.reject_reason ?? ''] ?? d.reject_reason ?? '—'}</b>
                </dd>
              </>
            ) : (
              <>
                <dt>Решение по возврату</dt>
                <dd>
                  <b>{ret?.decision ? (RETURN_DECISION[ret.decision] ?? ret.decision) : 'нет решения'}</b>
                  {ret?.refund_amount != null && ` · ${sum(ret.refund_amount)}`}
                  {ret?.decided_at && <div className="sub">{dt(ret.decided_at)}</div>}
                </dd>
              </>
            )}
          </dl>
          {ret?.decision_comment && <div className="ops-quote">{ret.decision_comment}</div>}
          {ret && ret.created_by === 'vendor' && (
            <>
              <h3>Возврат открыл поставщик</h3>
              {ret.description && <div className="ops-quote">{ret.description}</div>}
              <Files items={ret.photos} />
            </>
          )}
          <h3>Сообщения поставщика ({vendorMsgs.length})</h3>
          <Messages items={vendorMsgs.slice(-5)} empty="Поставщик в переписке не писал" />
        </section>
      </div>

      <Box title={open ? 'Решение' : 'Итог'}>
        {open ? (
          <>
            <div className="ops-choice" role="radiogroup" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              {(
                [
                  ['master', 'В пользу мастера', 'Возврат или переделка за счёт поставщика'],
                  ['partial', 'Частично', 'Часть суммы — мастеру'],
                  ['supplier', 'В пользу поставщика', 'Поставщик прав, возврата нет'],
                ] as ['master' | 'partial' | 'supplier', string, string][]
              ).map(([k, t, h]) => (
                <label key={k} className={resolution === k ? 'on' : ''}>
                  <input type="radio" name="res" checked={resolution === k} onChange={() => setResolution(k)} />
                  <span>
                    <b>{t}</b>
                    <span className="muted">{h}</span>
                  </span>
                </label>
              ))}
            </div>
            {resolution !== 'supplier' && (
              <div style={{ marginTop: 10 }}>
                <div className="form-grid" style={{ marginBottom: 0 }}>
                  <label>
                    Возврат мастеру за счёт поставщика, сум{resolution === 'partial' ? ' (обязательно)' : ''}
                    <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={resolution === 'master' ? 'пусто — переделка без денег' : ''} />
                  </label>
                  <div className="toolbar" style={{ marginBottom: 0 }}>
                    {requested != null && requested > 0 && (
                      <button type="button" className="b" onClick={() => setAmount(String(Math.min(requested, cap)))}>
                        Как просит: {sum(Math.min(requested, cap))}
                      </button>
                    )}
                    {requested != null && requested > 1 && (
                      <button type="button" className="b" onClick={() => setAmount(String(Math.min(Math.round(requested / 2), cap)))}>
                        Половина
                      </button>
                    )}
                  </div>
                </div>
                <div className={`ops-cap ${overCap ? 'err' : ''}`}>
                  {overCap
                    ? `Больше предела: можно вернуть не больше ${sum(cap)} (сумма заказа минус уже обещанные возвраты)`
                    : `Не больше ${sum(cap)}. Комиссия платформы сторнируется пропорционально сумме.`}
                </div>
              </div>
            )}
            <label className="f" style={{ marginTop: 10 }}>
              Решение для сторон (видят мастер и поставщик, от 3 символов)
              <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Например: «По фото видно заводской скол — поставщик возвращает стоимость фасада»" />
            </label>
            <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
              <button type="button" className="b primary" disabled={!ready} onClick={() => setConfirming(true)}>
                Принять решение…
              </button>
            </div>
          </>
        ) : (
          <dl className="kv">
            <dt>Решение</dt>
            <dd>
              <b>{DECISION_LABEL[d.decision ?? ''] ?? d.decision ?? '—'}</b>
            </dd>
            <dt>Возврат мастеру</dt>
            <dd>{sum(d.amount ?? 0)}</dd>
            <dt>Комментарий сторонам</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{d.decision_comment ?? '—'}</dd>
            <dt>Решён</dt>
            <dd>{dt(d.resolved_at)}</dd>
          </dl>
        )}
      </Box>

      <Box title={`Переписка по заказу (${msgs.length})`}>
        <OrderChat basePath={`/admin/orders/${d.order_id}/messages`} self="platform" />
      </Box>

      {confirming && (
        <ResolveDialog
          id={id}
          resolution={resolution}
          refund={refund}
          comment={comment.trim()}
          onClose={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false);
            setDone('Спор решён — мастер и поставщик получили уведомление');
            reload();
          }}
        />
      )}
    </>
  );
}

function ResolveDialog({
  id,
  resolution,
  refund,
  comment,
  onClose,
  onDone,
}: {
  id: string;
  resolution: 'master' | 'supplier' | 'partial';
  refund: number | null;
  comment: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const act = useAction();
  const [reason, setReason] = useState('');
  return (
    <Dialog title={`Решение: ${DECISION_LABEL[resolution]}`} onClose={onClose}>
      <div className="ops-consequence">
        {resolution === 'supplier'
          ? 'Возврата нет. Спор закроется в пользу поставщика.'
          : refund
            ? `Мастеру возвращается ${sum(refund)} за счёт поставщика; комиссия платформы сторнируется пропорционально.`
            : 'Без возврата денег (переделка за счёт поставщика).'}{' '}
        Решение увидят обе стороны:
        <div className="ops-quote" style={{ background: '#fff' }}>{comment}</div>
      </div>
      <ReasonField value={reason} onChange={setReason} label="Причина для журнала (обязательно; сторонам не показывается)" />
      <Msg message={act.message} />
      <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
        <button type="button" className="b" onClick={onClose}>
          Назад
        </button>
        <button
          type="button"
          className="b primary"
          disabled={act.busy || !reasonOk(reason)}
          onClick={() =>
            void act
              .run(() =>
                client.post(`/admin/disputes/${id}/resolve`, {
                  resolution,
                  refund_amount: resolution === 'supplier' ? null : refund,
                  comment,
                  reason: reason.trim(),
                }),
              )
              .then((ok) => ok && onDone())
          }
        >
          Принять решение
        </button>
      </div>
    </Dialog>
  );
}
