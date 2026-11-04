'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Box, Loading, Tag } from '@/components/admin/ui';
import { qs } from '@/lib/admin/api';
import { dt, num, usd } from '@/lib/admin/format';
import { useApi } from '@/lib/admin/useApi';

interface Stats {
  totals: Record<string, { requests: number; cost_usd: number; tokens: number }>;
  by_purpose: { purpose: string; requests: number; cost_usd: number }[];
  by_validation: Record<string, number>;
  by_workshop: { workshop_id: string | null; workshop_name: string | null; requests: number; cost_usd: number }[];
  accuracy: {
    design_requests: number;
    design_valid_first_try_share: number | null;
    ai_projects: number;
    corrected_by_master: number;
    corrected_share: number | null;
  };
  avg_cost_per_project_usd: number;
  chat_messages: number;
}
interface Req {
  id: string;
  workshop_id: string | null;
  project_id: string | null;
  purpose: string;
  model: string;
  served_by: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_microusd: number;
  validation_result: string;
  validation_errors: unknown[] | null;
  stop_reason: string | null;
  duration_ms: number | null;
  created_at: string;
}

const PERIODS: [string, string][] = [
  ['today', 'Сегодня'],
  ['week', '7 дней'],
  ['month', 'Месяц'],
];
const PURPOSES = ['design', 'answer', 'choose_type', 'edit'];
const VALIDATIONS = ['ok', 'schema_error', 'build_error', 'refusal', 'error', 'retried', 'failed'];
const LIMIT = 100;

function share(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

export default function AiPage() {
  const stats = useApi<Stats>('/admin/ai-stats');
  const [purpose, setPurpose] = useState('');
  const [validation, setValidation] = useState('');
  const [offset, setOffset] = useState(0);
  const log = useApi<Req[]>(`/admin/ai-requests${qs({ purpose, validation, limit: LIMIT, offset })}`);
  const s = stats.data;

  return (
    <>
      <h1>ИИ-журнал</h1>
      <Loading error={stats.error} loading={stats.loading && !s} />
      {s && (
        <div className="grid2">
          <Box title="Расход">
            <table>
              <thead>
                <tr>
                  <th />
                  <th className="num">Запросов</th>
                  <th className="num">Токенов</th>
                  <th className="num">Стоимость</th>
                </tr>
              </thead>
              <tbody>
                {PERIODS.map(([k, l]) => (
                  <tr key={k}>
                    <td>{l}</td>
                    <td className="num">{num(s.totals[k]?.requests)}</td>
                    <td className="num">{num(s.totals[k]?.tokens)}</td>
                    <td className="num">{usd(s.totals[k]?.cost_usd, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ marginTop: 8 }}>
              В среднем на проект: {usd(s.avg_cost_per_project_usd, 3)} (цель ≤ $0,30) · сообщений в чатах: {s.chat_messages}
            </div>
          </Box>
          <Box title="Точность">
            <dl className="kv">
              <dt>Распознаваний</dt>
              <dd>{s.accuracy.design_requests}</dd>
              <dt>Схема и сборка с первого раза</dt>
              <dd>{share(s.accuracy.design_valid_first_try_share)}</dd>
              <dt>Проектов с ИИ-деревом</dt>
              <dd>{s.accuracy.ai_projects}</dd>
              <dt>Мастер исправил дерево</dt>
              <dd>
                {s.accuracy.corrected_by_master} ({share(s.accuracy.corrected_share)})
              </dd>
              <dt>Результаты проверки</dt>
              <dd>
                {Object.entries(s.by_validation).map(([k, v]) => (
                  <span key={k} style={{ marginRight: 6 }}>
                    <Tag color={k === 'ok' ? 'green' : 'red'}>{k}</Tag> {v}
                  </span>
                ))}
              </dd>
            </dl>
          </Box>
          <Box title="По задачам">
            <table>
              <tbody>
                {s.by_purpose.map((p) => (
                  <tr key={p.purpose}>
                    <td>{p.purpose}</td>
                    <td className="num">{p.requests}</td>
                    <td className="num">{usd(p.cost_usd, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
          <Box title="По цехам (топ-20)">
            <table>
              <tbody>
                {s.by_workshop.map((w) => (
                  <tr key={w.workshop_id ?? 'none'}>
                    <td>{w.workshop_id ? <Link href={`/admin/workshops/${w.workshop_id}`}>{w.workshop_name}</Link> : '—'}</td>
                    <td className="num">{w.requests}</td>
                    <td className="num">{usd(w.cost_usd, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
        </div>
      )}

      <Box
        title="Запросы"
        extra={
          <div className="toolbar" style={{ margin: 0 }}>
            <select value={purpose} onChange={(e) => (setOffset(0), setPurpose(e.target.value))}>
              <option value="">Все задачи</option>
              {PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select value={validation} onChange={(e) => (setOffset(0), setValidation(e.target.value))}>
              <option value="">Любая проверка</option>
              {VALIDATIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        }
      >
        <Loading error={log.error} loading={log.loading && !log.data} />
        {log.data && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Проект</th>
                  <th>Задача</th>
                  <th>Модель</th>
                  <th className="num">Вход</th>
                  <th className="num">Выход</th>
                  <th className="num">Кэш чт/зап</th>
                  <th className="num">$</th>
                  <th className="num">мс</th>
                  <th>Проверка</th>
                </tr>
              </thead>
              <tbody>
                {log.data.map((r) => (
                  <tr key={r.id}>
                    <td>{dt(r.created_at)}</td>
                    <td>{r.project_id ? <Link href={`/admin/projects/${r.project_id}`}>{r.project_id.slice(0, 8)}</Link> : '—'}</td>
                    <td>{r.purpose}</td>
                    <td>
                      {r.served_by ?? r.model}
                      {r.stop_reason && <div className="muted">{r.stop_reason}</div>}
                    </td>
                    <td className="num">{num(r.tokens_in)}</td>
                    <td className="num">{num(r.tokens_out)}</td>
                    <td className="num">
                      {num(r.cache_read_tokens)} / {num(r.cache_write_tokens)}
                    </td>
                    <td className="num">{usd(r.cost_microusd / 1_000_000)}</td>
                    <td className="num">{r.duration_ms ?? '—'}</td>
                    <td>
                      <Tag color={r.validation_result === 'ok' ? 'green' : 'red'}>{r.validation_result}</Tag>
                      {r.validation_errors && r.validation_errors.length > 0 && (
                        <div className="muted" style={{ maxWidth: 260 }}>
                          {JSON.stringify(r.validation_errors).slice(0, 200)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <button className="b" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
                ←
              </button>
              <span className="muted">с {offset + 1}</span>
              <button className="b" type="button" disabled={log.data.length < LIMIT} onClick={() => setOffset(offset + LIMIT)}>
                →
              </button>
            </div>
          </div>
        )}
      </Box>
    </>
  );
}
