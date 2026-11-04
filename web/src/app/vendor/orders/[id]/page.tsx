'use client';

/** Карточка заказа поставщика (§5.2): проверка, решение, исправления, переписка, производство, возвраты. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { OrderChat } from '@/components/staff/OrderChat';
import { CorrectionEditor, CorrectionsList } from '@/components/vendor/order/Corrections';
import { Assignment, Production, Review, useOrderRights } from '@/components/vendor/order/Decision';
import { Facts, Photos } from '@/components/vendor/order/Facts';
import { OpenReturnForm, ReturnCard } from '@/components/vendor/order/Returns';
import { normalizeOrder, type OrderEvent, type VOrder } from '@/components/vendor/order/types';
import { AdminViewer } from '@/components/admin/AdminViewer';
import type { ViewerModel } from '@mebel/viewer';
import { dt, sum } from '@/lib/admin/format';
import { apiUrl } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';
import { ORDER_STATUS_LABEL, REJECT_REASONS, statusColor } from '@/lib/vendor/format';

const REJECT_LABEL: Record<string, string> = Object.fromEntries(REJECT_REASONS);

const EVENT_LABEL: Record<string, string> = {
  status_changed: 'Статус',
  correction_created: 'Исправление отправлено мастеру',
  correction_approved: 'Мастер подтвердил исправление',
  correction_declined: 'Мастер отказался от исправления',
  resubmitted: 'Мастер отправил заново',
  return_opened: 'Открыта рекламация',
  return_decided: 'Решение по рекламации',
  dispute_opened: 'Мастер открыл спор',
  dispute_resolved: 'Спор решён платформой',
  update: 'Изменены данные заказа',
  return_decision: 'Решение по рекламации',
  created: 'Заказ отправлен',
  take: 'Взят в работу',
  assign: 'Назначен конструктор',
  accept: 'Принят, счёт выставлен',
  return: 'Возвращён мастеру',
  reject: 'Отклонён',
  status: 'Статус',
  paid: 'Оплачен',
  resubmit: 'Отправлен заново',
  correction: 'Исправление',
  return_resolved: 'Рекламация решена',
  refund_approved: 'Возврат подтверждён',
  message: 'Сообщение',
  cancel: 'Отменён',
};

function EventRow({ e }: { e: OrderEvent }) {
  const kind = e.kind ?? e.type ?? e.action ?? '';
  const to = e.to_status ?? e.status;
  return (
    <tr>
      <td>{dt(e.created_at)}</td>
      <td>
        {e.actor_name ??
          (e.actor_type === 'master' ? 'Мастер' : e.actor_type === 'platform' ? 'Платформа' : (e.actor_type ?? '—'))}
      </td>
      <td>
        {EVENT_LABEL[kind] ?? kind}
        {to && <> → {ORDER_STATUS_LABEL[to] ?? to}</>}
      </td>
      <td style={{ whiteSpace: 'pre-wrap' }}>{e.comment ?? ''}</td>
    </tr>
  );
}

export default function VendorOrderCard() {
  const { id } = useParams<{ id: string }>();
  const { data: o, error, loading, reload } = useApi<VOrder>(`/vendor/orders/${id}`);
  if (!o) return <Loading error={error} loading={loading} />;
  return <Card o={normalizeOrder(o)} reload={reload} />;
}

function Card({ o, reload }: { o: VOrder; reload: () => void }) {
  const client = useClient();
  const files = useAction();
  const [correcting, setCorrecting] = useState(false);
  const [openingReturn, setOpeningReturn] = useState(false);
  const [model, setModel] = useState<ViewerModel | null>(null);
  const rights = useOrderRights(o);
  const project = o.project ?? null;
  const measurements = project?.measurements ?? o.measurements;
  const dimensions = project?.dimensions ?? o.dimensions;
  const photos = project?.photos ?? o.photos;
  const viewer = project?.viewer_url ?? o.viewer_url ?? project?.share_url ?? null;
  const events = o.events ?? o.history ?? [];
  const lines = o.lines ?? [];
  const linesTotal = o.cost_total ?? lines.reduce((s, l) => s + l.total, 0);
  const csv = o.csv_url ?? `/vendor/orders/${o.id}/csv`;
  // Сервер отдаёт CSV дважды (файл «csv» и короткая ссылка) — показываем один раз
  const fileList = (o.files ?? []).filter((f) => f.kind !== 'csv_short');
  const paid = ['paid', 'cutting', 'ready', 'issued'].includes(o.status);

  return (
    <>
      <p className="muted">
        <Link href="/vendor/orders">← Заказы</Link>
      </p>
      <h1>
        Заказ №{o.number ?? o.id.slice(0, 8)}{' '}
        {(project?.title ?? o.project_title) ? `· ${project?.title ?? o.project_title}` : ''}{' '}
        <Tag color={statusColor(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status_label ?? o.status}</Tag>
      </h1>
      {o.status === 'returned' && o.return_comment && (
        <div className="msg warn">Возвращён мастеру: {o.return_comment}</div>
      )}
      {o.status === 'rejected' && (
        <div className="msg error">
          Отклонён: {REJECT_LABEL[o.reject_reason ?? ''] ?? o.reject_reason ?? '—'}
          {(o.reject_comment ?? o.vendor_status_note) ? ` — ${o.reject_comment ?? o.vendor_status_note}` : ''}
        </div>
      )}
      {o.status === 'awaiting_approval' && (
        <div className="msg warn">Ждёт, пока мастер подтвердит исправление в приложении.</div>
      )}

      <div className="grid2">
        <Box title="Заказ">
          <dl className="kv">
            <dt>Цех</dt>
            <dd>
              {o.workshop_name ?? '—'}
              {o.workshop_phone && (
                <>
                  {' '}
                  · <a href={`tel:${o.workshop_phone}`}>{o.workshop_phone}</a>
                </>
              )}
            </dd>
            {(o.master_name || o.master_phone) && (
              <>
                <dt>Мастер</dt>
                <dd>
                  {o.master_name ?? ''}
                  {o.master_phone && (
                    <>
                      {' '}
                      · <a href={`tel:${o.master_phone}`}>{o.master_phone}</a>
                    </>
                  )}
                </dd>
              </>
            )}
            <dt>По смете</dt>
            <dd>{sum(o.estimate_total)}</dd>
            <dt>Счёт</dt>
            <dd>{sum(o.invoice_total)}</dd>
            <dt>Оплата</dt>
            <dd>
              {o.paid_at ? (
                `оплачен ${dt(o.paid_at)}`
              ) : o.status === 'accepted' ? (
                <Tag color="yellow">ждёт оплаты</Tag>
              ) : (
                '—'
              )}
            </dd>
            <dt>Срок готовности</dt>
            <dd>{o.due_date ? dt(o.due_date, false) : '—'}</dd>
            <dt>Версия модели</dt>
            <dd>
              {project?.version_number ?? o.version_number ?? '—'}
              {viewer && (
                <>
                  {' '}
                  ·{' '}
                  <a href={apiUrl(viewer)} target="_blank" rel="noreferrer">
                    открыть 3D →
                  </a>
                </>
              )}
            </dd>
            <dt>Создан</dt>
            <dd>{dt(o.created_at)}</dd>
            {o.notes && (
              <>
                <dt>Заметки</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{o.notes}</dd>
              </>
            )}
          </dl>
        </Box>
        <Box title="Работа с заказом">
          <Assignment o={o} onDone={reload} />
          <div style={{ height: 10 }} />
          <Review o={o} onDone={reload} />
          <Production o={o} onDone={reload} />
          {!rights.review && !rights.production && !rights.take && !rights.assign && (
            <div className="muted">
              {o.assignee_id && !rights.mine && !rights.owner
                ? 'Заказ ведёт другой конструктор.'
                : 'Сейчас действий по заказу нет.'}
            </div>
          )}
        </Box>
      </div>

      {model && (
        <Box title="3D-модель версии" extra={<button type="button" className="b" onClick={() => setModel(null)}>Скрыть</button>}>
          <AdminViewer model={model} />
        </Box>
      )}

      <div className="grid2">
        <Box title="Замеры и размеры">
          {measurements == null && dimensions == null ? (
            <Empty>Замеры не переданы</Empty>
          ) : (
            <>
              {dimensions != null && (
                <>
                  <h3>Габариты</h3>
                  <Facts value={dimensions} />
                </>
              )}
              {measurements != null && (
                <>
                  <h3>Замеры</h3>
                  <Facts value={measurements} />
                </>
              )}
            </>
          )}
          {project?.comment && <p style={{ whiteSpace: 'pre-wrap' }}>{project.comment}</p>}
        </Box>
        <Box title="Фото">
          <Photos items={photos} />
        </Box>
      </div>

      <Box
        title="Состав заказа"
        extra={
          <span>
            <b>{sum(linesTotal)}</b>
            {rights.correct && !correcting && (
              <button type="button" className="b" style={{ marginLeft: 10 }} onClick={() => setCorrecting(true)}>
                Исправить заказ…
              </button>
            )}
          </span>
        }
      >
        {correcting ? (
          <CorrectionEditor
            o={o}
            onCancel={() => setCorrecting(false)}
            onDone={() => {
              setCorrecting(false);
              reload();
            }}
          />
        ) : lines.length === 0 ? (
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
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td>
                      {l.name}
                      {l.sku && <span className="muted"> · {l.sku}</span>}
                    </td>
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
        {o.supplier_order && !correcting && (
          <div className="muted" style={{ marginTop: 8 }}>
            {o.supplier_order.weight_kg != null && <>вес ≈ {Math.round(o.supplier_order.weight_kg)} кг · </>}
            {o.supplier_order.delivery
              ? `доставка ${o.supplier_order.delivery.distance_km} км: ${sum(o.supplier_order.delivery.cost)}`
              : 'самовывоз'}
            {(o.supplier_order.excluded ?? []).length > 0 && (
              <div>
                <Tag color="yellow">под запрос</Tag> не входят: {(o.supplier_order.excluded ?? []).join(', ')}
              </div>
            )}
          </div>
        )}
      </Box>

      <Box title="Файлы">
        <div className="toolbar">
          {!fileList.some((f) => f.kind === 'csv') && (
            <button
              type="button"
              className="b"
              disabled={files.busy}
              onClick={() => void files.run(() => client.download(csv, `order_${o.number ?? o.id.slice(0, 8)}.csv`))}
            >
              CSV онлайн-кроя
            </button>
          )}
          {fileList.map((f, i) => (
            <button
              key={f.id ?? f.url ?? i}
              type="button"
              className="b"
              disabled={files.busy || !f.url}
              onClick={() => f.url && void files.run(() => client.download(f.url!, f.name ?? f.kind ?? 'file'))}
            >
              {f.title ?? f.label ?? f.name ?? f.kind ?? 'файл'}
            </button>
          ))}
        </div>
        <Msg message={files.message} />
      </Box>

      {rights.chat && (
        <Box title="Переписка с мастером">
          <OrderChat basePath={`/vendor/orders/${o.id}/messages`} self="vendor" markRead />
        </Box>
      )}

      {(o.corrections ?? []).length > 0 && (
        <Box title="Исправления">
          <CorrectionsList items={o.corrections ?? []} />
        </Box>
      )}

      {(paid || (o.returns ?? []).length > 0) && (
        <Box
          title="Возвраты и рекламации"
          extra={
            rights.returns && paid && !openingReturn ? (
              <button type="button" className="b" onClick={() => setOpeningReturn(true)}>
                + Рекламация
              </button>
            ) : null
          }
        >
          {openingReturn && (
            <OpenReturnForm
              o={o}
              onCancel={() => setOpeningReturn(false)}
              onDone={() => {
                setOpeningReturn(false);
                reload();
              }}
            />
          )}
          {(o.returns ?? []).length === 0 && !openingReturn ? (
            <Empty>Рекламаций нет</Empty>
          ) : (
            (o.returns ?? []).map((r) => <ReturnCard key={r.id} r={r} onDone={reload} />)
          )}
        </Box>
      )}

      <Box title="История">
        {events.length === 0 ? (
          <Empty />
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Что</th>
                  <th>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <EventRow key={e.id ?? i} e={e} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>
    </>
  );
}
