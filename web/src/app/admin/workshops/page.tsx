'use client';

/** Цеха и мастера (ADM-02): поиск, фильтры, сортировка по любому показателю, постранично, выгрузка CSV.
 *  Фильтры живут в адресе страницы — ссылку на выборку можно отправить, «Назад» из карточки возвращает к ней. */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense } from 'react';
import { ago, PLAN_LABEL, Pills, SearchInput, SortTh, useUrlState } from '@/components/admin/ops';
import { Empty, Loading, Msg, Pager, Tag } from '@/components/admin/ui';
import { dt, num, sum, usd } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

interface Row {
  id: string;
  name: string;
  city: string | null;
  phone: string | null;
  owner_name: string | null;
  plan: string;
  pro_until: string | null;
  pro_active: boolean;
  blocked: boolean;
  deleted: boolean;
  free_left: number;
  free_limit: number;
  pack_left: number;
  unlimited: boolean;
  projects: number;
  orders: number;
  turnover: number;
  ai_spend_usd: number;
  members: number;
  last_activity: string | null;
  created_at: string;
}

interface List {
  items: Row[];
  total: number;
  cities: string[];
}

const LIMIT = 50;
const DEFAULTS = { q: '', city: '', plan: '', activity: '', blocked: '', orders: '', sort: 'created_at', order: 'desc', offset: '0' };

/** Активность: за 7 / 30 дней или «уснувшие» — нет активности дольше 30 дней. */
const ACTIVITY: [string, string][] = [
  ['', 'Любая активность'],
  ['7', 'Активны за 7 дней'],
  ['30', 'Активны за 30 дней'],
  ['-30', 'Нет активности > 30 дней'],
];

function Workshops() {
  const router = useRouter();
  const client = useClient();
  const act = useAction();
  const [f, set, reset] = useUrlState(DEFAULTS);
  const filters = {
    q: f.q,
    city: f.city,
    plan: f.plan,
    active_days: f.activity && !f.activity.startsWith('-') ? f.activity : null,
    inactive_days: f.activity.startsWith('-') ? f.activity.slice(1) : null,
    blocked: f.blocked || null,
    has_orders: f.orders || null,
    sort: f.sort,
    order: f.order,
  };
  const offset = Number(f.offset) || 0;
  const { data, error, loading } = useApi<List>(`/admin/workshops${qs({ ...filters, limit: LIMIT, offset })}`);
  const filtered = Object.entries(f).some(([k, v]) => !['sort', 'order', 'offset'].includes(k) && v !== '');
  const sortProps = { sort: f.sort, order: f.order, onSort: (k: string, o: 'asc' | 'desc') => set({ sort: k, order: o }) };

  return (
    <>
      <div className="ops-head">
        <div>
          <h1>Цеха и мастера</h1>
          <div className="ops-sub">Последняя активность — вход в приложение, изменение проекта или запрос к ИИ.</div>
        </div>
        <button
          type="button"
          className="b"
          disabled={act.busy || !data?.total}
          onClick={() =>
            void act.run(() => client.download(`/admin/workshops.csv${qs(filters)}`, 'workshops.csv'))
          }
        >
          {act.busy ? 'Готовим CSV…' : `Выгрузить CSV${data ? ` (${num(data.total)})` : ''}`}
        </button>
      </div>
      <div className="ops-filters">
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="Название, город, имя или телефон" />
        <select value={f.city} onChange={(e) => set({ city: e.target.value })} aria-label="Город">
          <option value="">Все города</option>
          {(data?.cities ?? (f.city ? [f.city] : [])).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <Pills
          label="Тариф"
          value={f.plan}
          onChange={(plan) => set({ plan })}
          options={[
            ['', 'Все тарифы'],
            ['free', 'Бесплатный'],
            ['pack', 'Пакет'],
            ['pro', 'Pro'],
          ]}
        />
        <select value={f.activity} onChange={(e) => set({ activity: e.target.value })} aria-label="Активность">
          {ACTIVITY.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={f.orders} onChange={(e) => set({ orders: e.target.value })} aria-label="Заказы">
          <option value="">С заказами и без</option>
          <option value="true">Есть заказы</option>
          <option value="false">Без заказов</option>
        </select>
        <select value={f.blocked} onChange={(e) => set({ blocked: e.target.value })} aria-label="Блокировка">
          <option value="">Все</option>
          <option value="false">Работают</option>
          <option value="true">Заблокированы</option>
        </select>
        {filtered && (
          <button type="button" className="ops-clear" onClick={reset}>
            Сбросить фильтры
          </button>
        )}
        <span className="grow" />
        {data && <span className="ops-count">Найдено: {num(data.total)}</span>}
      </div>
      <Msg message={act.message} />
      <Loading error={error} loading={loading && !data} />
      {data &&
        (data.items.length === 0 ? (
          <Empty>{filtered ? 'Под фильтры ни один цех не подходит' : 'Цехов пока нет'}</Empty>
        ) : (
          <div className="scroll" style={{ opacity: loading ? 0.6 : 1 }}>
            <table className="ops-table">
              <thead>
                <tr>
                  <SortTh k="name" label="Цех" firstDesc={false} {...sortProps} />
                  <th>Контакт</th>
                  <SortTh k="plan" label="Тариф" firstDesc={false} {...sortProps} />
                  <th title="Бесплатных проектов осталось в этом месяце">Осталось в месяце</th>
                  <SortTh k="projects" label="Проекты" num {...sortProps} />
                  <SortTh k="orders" label="Заказы" num {...sortProps} />
                  <SortTh k="turnover" label="Оборот" num {...sortProps} title="Оплаченные заказы поставщикам" />
                  <SortTh k="ai_spend" label="ИИ" num {...sortProps} title="Расход на ИИ за всё время" />
                  <SortTh k="last_activity" label="Активность" {...sortProps} />
                  <SortTh k="created_at" label="Регистрация" {...sortProps} />
                </tr>
              </thead>
              <tbody>
                {data.items.map((w) => (
                  <tr
                    key={w.id}
                    className={`clickable ${w.blocked ? 'inactive' : ''}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a')) return;
                      router.push(`/admin/workshops/${w.id}`);
                    }}
                  >
                    <td>
                      <Link href={`/admin/workshops/${w.id}`}>{w.name}</Link>{' '}
                      {w.blocked && <Tag color="red">заблокирован</Tag>} {w.deleted && <Tag>удалён</Tag>}
                      <div className="sub">
                        {w.city || '—'} · {w.members} {w.members === 1 ? 'пользователь' : 'польз.'}
                      </div>
                    </td>
                    <td>
                      {w.owner_name || '—'}
                      <div className="sub">{w.phone ?? '—'}</div>
                    </td>
                    <td>
                      {w.plan === 'pro' ? (
                        <Tag color={w.pro_active ? 'green' : 'yellow'}>{w.pro_active ? 'Pro' : 'Pro истёк'}</Tag>
                      ) : (
                        PLAN_LABEL[w.plan] ?? w.plan
                      )}
                      {w.pro_until && <div className="sub">до {dt(w.pro_until, false)}</div>}
                    </td>
                    <td>
                      {w.unlimited ? (
                        <span className="muted">без лимита</span>
                      ) : (
                        <>
                          <span className={w.free_left === 0 && w.pack_left === 0 ? 'ops-sla late' : ''}>
                            {w.free_left} из {w.free_limit}
                          </span>
                          {w.pack_left > 0 && <div className="sub">+ пакет {w.pack_left}</div>}
                        </>
                      )}
                    </td>
                    <td className="num">{num(w.projects)}</td>
                    <td className="num">{num(w.orders)}</td>
                    <td className="num">{w.turnover ? sum(w.turnover) : '—'}</td>
                    <td className="num">{w.ai_spend_usd ? usd(w.ai_spend_usd, 2) : '—'}</td>
                    <td title={w.last_activity ? dt(w.last_activity) : undefined}>{ago(w.last_activity)}</td>
                    <td>{dt(w.created_at, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={data.total} limit={LIMIT} offset={offset} onChange={(o) => set({ offset: String(o) })} />
          </div>
        ))}
    </>
  );
}

export default function WorkshopsPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Workshops />
    </Suspense>
  );
}
