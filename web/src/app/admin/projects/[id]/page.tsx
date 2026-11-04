'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ViewerModel } from '@mebel/viewer';
import { AdminViewer } from '@/components/admin/AdminViewer';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { api, post } from '@/lib/admin/api';
import { dt, num, ORDER_STATUS_LABEL, range, sum, usd } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';

interface VersionBrief {
  id: string;
  number: number;
  source: string;
  label: string | null;
  ok: boolean;
  frozen: boolean;
  is_current: boolean;
  summary: { parts_count?: number; errors?: number; warnings?: number; size_mm?: number[] };
  created_at: string;
}
interface VersionFull extends VersionBrief {
  viewer: ViewerModel;
  issues: { level: string; message: string }[];
  tree: Record<string, unknown>;
}
interface PriceRange {
  from: number;
  to: number;
}
interface Estimate {
  exact: boolean;
  total: PriceRange;
  materials_client: PriceRange;
  work: PriceRange;
  cost_materials: PriceRange;
  has_requests: boolean;
  sheets: Record<string, number>;
  markup_percent: Record<string, number>;
  lines: { key: string; group: string; name: string; unit: string; qty: number; unit_price: number; cost: number; status: string; source: string; priced_at: string }[];
}
interface AiRow {
  id: string;
  purpose: string;
  model: string;
  served_by: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  validation_result: string;
  duration_ms: number | null;
  created_at: string;
}
interface Card {
  id: string;
  title: string;
  status_label: string;
  product_type: string | null;
  is_example: boolean;
  workshop_id: string;
  workshop_name?: string;
  charged: boolean;
  archived: boolean;
  deleted: boolean;
  source_text: string | null;
  created_at: string;
  updated_at: string;
  client: { name: string; phone: string | null; address: string | null } | null;
  frozen_version_id: string | null;
  current_version: VersionFull | null;
  versions: VersionBrief[];
  estimate: Estimate | null;
  ai_requests: AiRow[];
  ai_budget: { spent_usd: number; limit_usd: number; percent: number; extra_projects: number; warning: boolean; exceeded: boolean };
  chat: { id: string; author: string; text: string; options?: string[] | null; version_id?: string | null; price_delta?: PriceRange | null; undone: boolean; created_at: string }[];
  orders: { id: string; status: string; estimate_total: number | null; invoice_total: number | null; created_at: string }[];
  share_links: number;
  files_access: { production: boolean; basis: string | null };
}

const SOURCE_LABEL: Record<string, string> = { manual: 'мастер', ai: 'ИИ', restore: 'возврат', fix: 'исправление' };
const STATUS_LINE: Record<string, string> = { catalog: '', analog: 'аналог', request: 'под запрос', nonstandard: 'нестандарт' };

export default function ProjectCard() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, loading, reload } = useApi<Card>(`/admin/projects/${id}`);
  const [shown, setShown] = useState<VersionFull | null>(null);
  const [showTree, setShowTree] = useState(false);
  const act = useAction();

  useEffect(() => {
    if (p?.current_version) setShown(p.current_version);
  }, [p]);

  if (!p) return <Loading error={error} loading={loading} />;

  async function openVersion(vid: string) {
    await act.run(async () => setShown(await api<VersionFull>(`/admin/projects/${id}/versions/${vid}`)));
  }

  return (
    <>
      <h1>
        {p.title} <Tag>{p.status_label}</Tag> {p.is_example && <Tag>пример</Tag>} {p.deleted && <Tag color="red">удалён</Tag>}
      </h1>
      <Msg message={act.message} />
      <div className="grid2">
        <Box title={shown ? `3D · версия ${shown.number}${shown.is_current ? ' (текущая)' : ''}` : '3D'}>
          {shown ? <AdminViewer key={shown.id} model={shown.viewer} /> : <Empty>Модель ещё не построена</Empty>}
          {shown && shown.issues.length > 0 && (
            <ul>
              {shown.issues.map((i, n) => (
                <li key={n}>
                  <Tag color={i.level === 'error' ? 'red' : 'yellow'}>{i.level}</Tag> {i.message}
                </li>
              ))}
            </ul>
          )}
          {shown && (
            <>
              <button className="b" type="button" onClick={() => setShowTree(!showTree)} style={{ marginTop: 8 }}>
                {showTree ? 'Скрыть дерево модулей' : 'Дерево модулей (JSON)'}
              </button>
              {showTree && <pre>{JSON.stringify(shown.tree, null, 2)}</pre>}
            </>
          )}
        </Box>
        <div>
          <Box title="Проект">
            <dl className="kv">
              <dt>Цех</dt>
              <dd>
                <Link href={`/admin/workshops/${p.workshop_id}`}>{p.workshop_name ?? p.workshop_id}</Link>
              </dd>
              <dt>Клиент</dt>
              <dd>{p.client ? `${p.client.name}${p.client.phone ? `, ${p.client.phone}` : ''}` : '—'}</dd>
              <dt>Тип</dt>
              <dd>{p.product_type ?? '—'}</dd>
              <dt>Списан из лимита</dt>
              <dd>{p.charged ? 'да' : 'нет'}</dd>
              <dt>Ссылок клиенту</dt>
              <dd>{p.share_links}</dd>
              <dt>Описание</dt>
              <dd>{p.source_text || '—'}</dd>
              <dt>Создан / изменён</dt>
              <dd>
                {dt(p.created_at)} / {dt(p.updated_at)}
              </dd>
              <dt>Производственные файлы</dt>
              <dd>
                {p.files_access.production ? (
                  <Tag color="green">открыты ({p.files_access.basis})</Tag>
                ) : (
                  <>
                    <Tag>закрыты</Tag>{' '}
                    <button
                      className="b"
                      type="button"
                      disabled={act.busy}
                      onClick={() => {
                        const note = window.prompt('Основание (например, «оплата файлов, чек №…»)');
                        if (note === null) return;
                        void act
                          .run(() => post(`/admin/projects/${id}/file-access`, { basis: 'payment', note }), 'Файлы открыты')
                          .then(reload);
                      }}
                    >
                      Открыть (оплата вручную)
                    </button>
                  </>
                )}
              </dd>
            </dl>
          </Box>
          <Box title="Версии модели">
            {p.versions.length === 0 ? (
              <Empty />
            ) : (
              <table>
                <tbody>
                  {p.versions.map((v) => (
                    <tr key={v.id} className="clickable" onClick={() => void openVersion(v.id)}>
                      <td>
                        №{v.number} {v.is_current && <Tag color="green">текущая</Tag>} {v.frozen && <Tag color="yellow">договор</Tag>}{' '}
                        {!v.ok && <Tag color="red">ошибки</Tag>}
                      </td>
                      <td>{SOURCE_LABEL[v.source] ?? v.source}</td>
                      <td>{v.label ?? ''}</td>
                      <td className="muted">{v.summary.parts_count ?? '—'} дет.</td>
                      <td>{dt(v.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Box>
        </div>
      </div>

      <Box title="Смета мастера (текущая версия)">
        {!p.estimate ? (
          <Empty>Смета недоступна (нет модели или в ней ошибки)</Empty>
        ) : (
          <>
            <dl className="kv">
              <dt>Итог клиенту</dt>
              <dd>
                <b>{range(p.estimate.total)}</b> {p.estimate.exact ? <Tag color="green">точно</Tag> : <Tag>до замера</Tag>}
              </dd>
              <dt>Материалы для клиента</dt>
              <dd>{range(p.estimate.materials_client)}</dd>
              <dt>Работа мастера</dt>
              <dd>{range(p.estimate.work)}</dd>
              <dt>Себестоимость</dt>
              <dd>{range(p.estimate.cost_materials)}</dd>
              <dt>Листы</dt>
              <dd>
                {Object.entries(p.estimate.sheets)
                  .map(([m, n]) => `${m}: ${n}`)
                  .join(', ') || '—'}
              </dd>
            </dl>
            <div className="scroll" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th>Группа</th>
                    <th>Позиция</th>
                    <th className="num">Кол-во</th>
                    <th className="num">Цена</th>
                    <th className="num">Сумма</th>
                    <th>Статус</th>
                    <th>Источник цены</th>
                  </tr>
                </thead>
                <tbody>
                  {p.estimate.lines.map((l) => (
                    <tr key={l.key}>
                      <td>{l.group}</td>
                      <td>{l.name}</td>
                      <td className="num">
                        {l.qty} {l.unit}
                      </td>
                      <td className="num">{sum(l.unit_price)}</td>
                      <td className="num">{sum(l.cost)}</td>
                      <td>{STATUS_LINE[l.status] ? <Tag color="yellow">{STATUS_LINE[l.status]}</Tag> : ''}</td>
                      <td className="muted">
                        {l.source}, {l.priced_at}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Box>

      <div className="grid2">
        <Box
          title="ИИ-журнал проекта"
          extra={
            <span className="muted">
              бюджет: {usd(p.ai_budget.spent_usd, 3)} из {usd(p.ai_budget.limit_usd, 2)} ({p.ai_budget.percent}%)
              {p.ai_budget.exceeded && <Tag color="red">исчерпан</Tag>}
              {p.ai_budget.warning && <Tag color="yellow">80%</Tag>}
            </span>
          }
        >
          {p.ai_requests.length === 0 ? (
            <Empty />
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Задача</th>
                    <th>Модель</th>
                    <th className="num">Токены вх/вых/кэш</th>
                    <th className="num">$</th>
                    <th>Проверка</th>
                  </tr>
                </thead>
                <tbody>
                  {p.ai_requests.map((r) => (
                    <tr key={r.id}>
                      <td>{dt(r.created_at)}</td>
                      <td>{r.purpose}</td>
                      <td>{r.served_by ?? r.model}</td>
                      <td className="num">
                        {num(r.tokens_in)} / {num(r.tokens_out)} / {num(r.cache_read_tokens + r.cache_write_tokens)}
                      </td>
                      <td className="num">{usd(r.cost_usd)}</td>
                      <td>
                        <Tag color={r.validation_result === 'ok' ? 'green' : 'red'}>{r.validation_result}</Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Box>
        <Box title="Чат редактора">
          {p.chat.length === 0 ? (
            <Empty />
          ) : (
            <div className="chat">
              {p.chat.map((m) => (
                <div key={m.id} className={`m ${m.author} ${m.undone ? 'undone' : ''}`}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                  {m.options && m.options.length > 0 && <div className="muted">варианты: {m.options.join(' / ')}</div>}
                  {m.price_delta && (
                    <div className="muted">
                      цена: {sum(m.price_delta.from)} → {sum(m.price_delta.to)}
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {dt(m.created_at)}
                    {m.undone ? ' · отменено' : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Box>
      </div>

      <Box title="Заказы">
        {p.orders.length === 0 ? (
          <Empty />
        ) : (
          <table>
            <tbody>
              {p.orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/admin/orders/${o.id}`}>{o.id.slice(0, 8)}</Link>
                  </td>
                  <td>{ORDER_STATUS_LABEL[o.status] ?? o.status}</td>
                  <td className="num">по смете {sum(o.estimate_total)}</td>
                  <td className="num">по счёту {sum(o.invoice_total)}</td>
                  <td>{dt(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Box>
    </>
  );
}
