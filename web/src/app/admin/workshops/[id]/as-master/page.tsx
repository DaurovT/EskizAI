'use client';

/**
 * «Глазами мастера» (§4a): приложение мастера на чтение — список проектов, карточка проекта с 3D и сметой,
 * заказы, профиль и лимиты. Запросы идут в API мастера (/projects, /orders…) с коротким токеном только на чтение;
 * API отвечает 403 на любое изменение и пишет каждый запрос в журнал цеха. Через 15 минут токен истекает —
 * страница гаснет и предлагает открыть просмотр заново (с новой причиной).
 */
import type { ViewerModel } from '@mebel/viewer';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminViewer } from '@/components/admin/AdminViewer';
import '@/app/admin/ops.css';
import { Box, Empty, Loading, Tag } from '@/components/admin/ui';
import { dt, ORDER_STATUS_LABEL, orderStatusColor, range, sum } from '@/lib/admin/format';
import { API_URL, apiUrl } from '@/lib/staff/client';
import { clearImp, loadImp, type Impersonation } from '../imp';

class ImpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function useImpApi(imp: Impersonation | null, onExpired: () => void) {
  return useCallback(
    async <T,>(path: string): Promise<T> => {
      if (!imp?.access_token) throw new ImpError(401, 'Срок просмотра истёк');
      let res: Response;
      try {
        res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${imp.access_token}` } });
      } catch {
        throw new ImpError(0, `API недоступен (${API_URL})`);
      }
      if (res.status === 401) {
        onExpired();
        throw new ImpError(401, 'Срок просмотра истёк');
      }
      if (!res.ok) {
        let msg = `Ошибка ${res.status}`;
        try {
          const b = (await res.json()) as { error?: { message?: string } };
          msg = b.error?.message ?? msg;
        } catch {
          /* не JSON */
        }
        throw new ImpError(res.status, msg);
      }
      return (await res.json()) as T;
    },
    [imp, onExpired],
  );
}

function useLoad<T>(fetcher: (<R>(p: string) => Promise<R>) | null, path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!fetcher || !path) return;
    let alive = true;
    setLoading(true);
    setData(null);
    fetcher<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [fetcher, path]);
  return { data, error, loading };
}

interface ProjectItem {
  id: string;
  title: string;
  status: string;
  status_label: string;
  short_date?: string;
  product_type: string | null;
  is_example: boolean;
  client: { name: string; phone: string | null } | null;
  price: { from: number; to: number } | null;
  activity: { text: string; tone: string } | null;
  updated_at: string;
}

interface ProjectCard extends ProjectItem {
  source_text: string | null;
  charged: boolean;
  charge_period: string | null;
  has_order: boolean;
  photos: { id: string; url: string; kind: string }[];
  model_summary: Record<string, unknown> | null;
  estimate: {
    exact: boolean;
    total: { from: number; to: number };
    materials_client: { from: number; to: number };
    work: { from: number; to: number };
    cost_materials?: { from: number; to: number };
    has_requests: boolean;
  } | null;
  next_step: string;
  actions: { code: string; label: string }[];
}

interface MasterOrder {
  id: string;
  number: string;
  project_id: string;
  project_title: string | null;
  supplier_name: string | null;
  status: string;
  status_label: string;
  total: number | null;
  payment: { status: string };
  steps: { status: string; label: string; done: boolean; current: boolean; at: string | null }[];
  ready_date: string | null;
  vendor_status_note: string | null;
  created_at: string;
}

type View = 'projects' | 'orders' | 'workshop';

function left(expiresAt: string | undefined, now: number): number {
  return expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000)) : 0;
}

export default function AsMasterPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [imp, setImp] = useState<Impersonation | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<View>('projects');
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => setImp(loadImp(id)), [id]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secs = left(imp?.expires_at, now);
  const expired = imp !== undefined && (!imp?.access_token || secs <= 0);
  const live = expired ? null : (imp ?? null);
  const markExpired = useCallback(() => setImp((x) => (x ? { ...x, access_token: '' } : x)), []);
  const api = useImpApi(live, markExpired);
  const fetcher = live ? api : null;

  const projects = useLoad<{ items: ProjectItem[]; total: number }>(fetcher, '/projects?limit=200');
  const orders = useLoad<{ items: MasterOrder[]; total: number }>(fetcher, view === 'orders' ? '/orders?limit=200' : null);
  const profile = useLoad<Record<string, unknown>>(fetcher, view === 'workshop' ? '/workshops/me' : null);
  const limits = useLoad<Record<string, unknown>>(fetcher, view === 'workshop' ? '/billing/limits' : null);

  const list = useMemo(() => {
    const all = projects.data?.items ?? [];
    const s = q.trim().toLowerCase();
    return s ? all.filter((p) => `${p.title} ${p.client?.name ?? ''}`.toLowerCase().includes(s)) : all;
  }, [projects.data, q]);
  useEffect(() => {
    if (!selected && list[0]) setSelected(list[0].id);
  }, [list, selected]);

  function end() {
    clearImp(id);
    router.push(`/admin/workshops/${id}`);
  }

  if (imp === undefined) return <div className="muted">Загрузка…</div>;

  const who = imp ? `${imp.user_name || imp.user_phone || 'мастер'}${imp.user_role === 'owner' ? ' (владелец)' : imp.user_role ? ' (сотрудник)' : ''}` : '';
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');

  return (
    <>
      <div className="ops-imp-banner" role="status">
        <b>Режим просмотра — только чтение</b>
        <span>
          Глазами: {who || '—'}
          {imp?.workshop_name ? ` · ${imp.workshop_name}` : ''}
        </span>
        <span className="grow" />
        {!expired && (
          <span>
            осталось <span className="timer">{mm}:{ss}</span>
          </span>
        )}
        <button type="button" onClick={end}>
          Завершить просмотр
        </button>
      </div>
      {expired ? (
        <Box>
          <div className="ops-expired">
            <h2>{imp ? 'Срок просмотра истёк' : 'Просмотр не открыт'}</h2>
            <p className="muted">
              Доступ «глазами мастера» действует 15 минут и только в этой вкладке. Чтобы посмотреть ещё раз, откройте его из
              карточки цеха — с новой причиной для журнала.
            </p>
            <Link href={`/admin/workshops/${id}`} className="b primary" style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 8, background: 'var(--a-accent)', color: '#fff' }}>
              ← В карточку цеха
            </Link>
          </div>
        </Box>
      ) : (
        <>
          {imp?.reason && <p className="muted" style={{ marginTop: 0 }}>Причина просмотра: «{imp.reason}». Каждый запрос пишется в журнал цеха.</p>}
          <div className="tabs">
            {(
              [
                ['projects', `Проекты${projects.data ? ` · ${projects.data.total}` : ''}`],
                ['orders', 'Заказы'],
                ['workshop', 'Цех и лимит'],
              ] as [View, string][]
            ).map(([k, l]) => (
              <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => setView(k)}>
                {l}
              </button>
            ))}
          </div>
          {view === 'projects' && (
            <>
              <Loading error={projects.error} loading={projects.loading && !projects.data} />
              {projects.data &&
                (projects.data.items.length === 0 ? (
                  <Empty>У мастера нет проектов</Empty>
                ) : (
                  <div className="ops-imp-layout">
                    <div>
                      <input type="search" placeholder="Поиск по проектам" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }} />
                      <div className="ops-imp-list">
                        {list.map((p) => (
                          <button key={p.id} type="button" className={selected === p.id ? 'on' : ''} onClick={() => setSelected(p.id)}>
                            <b>{p.title}</b> {p.is_example && <Tag>пример</Tag>}
                            <div className="sub">
                              {p.status_label}
                              {p.client ? ` · ${p.client.name}` : ''}
                              {p.short_date ? ` · ${p.short_date}` : ''}
                            </div>
                            {p.price && <div className="sub">{range(p.price)}</div>}
                            {p.activity && <div className="sub">{p.activity.text}</div>}
                          </button>
                        ))}
                      </div>
                    </div>
                    {selected && <ProjectView key={selected} api={api} pid={selected} />}
                  </div>
                ))}
            </>
          )}
          {view === 'orders' && (
            <Box>
              <Loading error={orders.error} loading={orders.loading && !orders.data} />
              {orders.data && (orders.data.items.length === 0 ? <Empty>Заказов нет</Empty> : <OrdersTable rows={orders.data.items} />)}
            </Box>
          )}
          {view === 'workshop' && (
            <div className="grid2">
              <Box title="Профиль цеха (как видит мастер)">
                <Loading error={profile.error} loading={profile.loading && !profile.data} />
                {profile.data && <Kv data={profile.data} skip={['id', 'logo_key', 'pricing', 'employee_estimate_views']} />}
              </Box>
              <Box title="Лимит проектов">
                <Loading error={limits.error} loading={limits.loading && !limits.data} />
                {limits.data && <Kv data={limits.data} />}
              </Box>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Kv({ data, skip = [] }: { data: Record<string, unknown>; skip?: string[] }) {
  return (
    <dl className="kv">
      {Object.entries(data)
        .filter(([k, v]) => !skip.includes(k) && v !== null && typeof v !== 'object')
        .map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{typeof v === 'boolean' ? (v ? 'да' : 'нет') : String(v)}</dd>
          </div>
        ))}
    </dl>
  );
}

function ProjectView({ api, pid }: { api: <T>(p: string) => Promise<T>; pid: string }) {
  const card = useLoad<ProjectCard>(api, `/projects/${pid}`);
  const model = useLoad<{ version: { number: number; viewer: ViewerModel; ok: boolean } }>(api, `/projects/${pid}/model`);
  const orders = useLoad<MasterOrder[]>(api, `/projects/${pid}/orders`);
  const p = card.data;
  if (!p) return <Loading error={card.error} loading />;
  const e = p.estimate;
  return (
    <div style={{ minWidth: 0 }}>
      <Box
        title={p.title}
        extra={
          <Link href={`/admin/projects/${p.id}`} className="muted">
            открыть в админке →
          </Link>
        }
      >
        <div className="toolbar">
          <Tag color="green">{p.status_label}</Tag>
          {p.client && (
            <span>
              Клиент: {p.client.name}
              {p.client.phone ? ` · ${p.client.phone}` : ''}
            </span>
          )}
          {p.charged && <Tag>списан из лимита {p.charge_period}</Tag>}
        </div>
        {p.next_step && <div className="msg warn">Подсказка мастеру: {p.next_step}</div>}
        {p.actions.length > 0 && (
          <div className="ops-actions" style={{ marginBottom: 10 }}>
            {p.actions.map((a) => (
              <button key={a.code} type="button" className="b" disabled title="Только чтение">
                {a.label}
              </button>
            ))}
          </div>
        )}
        {model.data?.version?.viewer ? (
          <AdminViewer model={model.data.version.viewer} />
        ) : model.error ? (
          <Empty>{model.error}</Empty>
        ) : (
          <div className="muted">Загрузка 3D…</div>
        )}
        {model.data && <div className="muted" style={{ marginTop: 6 }}>Версия модели {model.data.version.number}{model.data.version.ok ? '' : ' · есть замечания'}</div>}
      </Box>
      <div className="grid2">
        <Box title="Смета (как видит мастер)">
          {e ? (
            <dl className="kv">
              <dt>Цена клиенту</dt>
              <dd>
                <b>{range(e.total)}</b> {e.exact ? <Tag color="green">точная</Tag> : <Tag color="yellow">до замера</Tag>}
              </dd>
              <dt>Материалы</dt>
              <dd>{range(e.materials_client)}</dd>
              <dt>Работа</dt>
              <dd>{range(e.work)}</dd>
              {e.cost_materials && (
                <>
                  <dt>Себестоимость</dt>
                  <dd>{range(e.cost_materials)}</dd>
                </>
              )}
              {e.has_requests && (
                <>
                  <dt />
                  <dd>
                    <Tag color="yellow">есть позиции «под запрос»</Tag>
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <Empty>Сметы нет — модель не построена или с ошибками</Empty>
          )}
        </Box>
        <Box title="Описание и фото">
          {p.source_text ? <div className="ops-quote">{p.source_text}</div> : <div className="muted">Описания нет</div>}
          {p.photos.length > 0 && (
            <div className="photos" style={{ marginTop: 8 }}>
              {p.photos.map((ph) => (
                <a key={ph.id} href={apiUrl(ph.url)} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={apiUrl(ph.url)} alt="" />
                </a>
              ))}
            </div>
          )}
        </Box>
      </div>
      <Box title="Заказы по проекту">
        <Loading error={orders.error} loading={orders.loading && !orders.data} />
        {orders.data && (orders.data.length === 0 ? <Empty>Заказов нет</Empty> : <OrdersTable rows={orders.data} />)}
      </Box>
    </div>
  );
}

function OrdersTable({ rows }: { rows: MasterOrder[] }) {
  return (
    <div className="scroll">
      <table className="ops-table">
        <thead>
          <tr>
            <th>Заказ</th>
            <th>Поставщик</th>
            <th>Статус</th>
            <th>Шаги</th>
            <th className="num">Сумма</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td>
                <Link href={`/admin/orders/${o.id}`}>№{o.number}</Link>
                <div className="sub">
                  {o.project_title ?? '—'} · {dt(o.created_at, false)}
                </div>
              </td>
              <td>{o.supplier_name ?? '—'}</td>
              <td>
                <Tag color={orderStatusColor(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status_label}</Tag>
                {o.vendor_status_note && <div className="sub">{o.vendor_status_note}</div>}
              </td>
              <td className="sub">
                {o.steps.map((s) => (
                  <span key={s.status} style={{ marginRight: 6, fontWeight: s.current ? 700 : 400, opacity: s.done ? 1 : 0.45 }}>
                    {s.done ? '●' : '○'} {s.label}
                  </span>
                ))}
              </td>
              <td className="num">{sum(o.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
