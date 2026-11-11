'use client';

/**
 * Карточка цеха (ADM-02, §4a): шапка с главными цифрами, вкладки (обзор, сотрудники цеха, проекты, заказы,
 * платежи, ИИ, журнал) и действия с обязательной причиной: блокировка, начисление проектов, продление Pro,
 * сброс лимита месяца, просмотр «глазами мастера» (только чтение).
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ago, Dialog, PLAN_LABEL, ReasonField, reasonOk, Stat, useUrlState, WAITING_LABEL, hoursLabel, parseSum } from '@/components/admin/ops';
import { Box, Empty, Loading, Msg, Pager, Tag } from '@/components/admin/ui';
import { dt, num, ORDER_STATUS_LABEL, orderStatusColor, sum, usd, sumShort } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useAction, useApi, useCan, useClient } from '@/lib/staff/hooks';
import { saveImp, type Impersonation } from './imp';

interface Member {
  id: string;
  name: string;
  phone: string;
  role: string;
  title: string | null;
  is_active: boolean;
  deleted: boolean;
  can_order: boolean;
  can_see_cost: boolean;
  last_login_at: string | null;
  created_at: string;
}

interface Summary {
  id: string;
  name: string;
  city: string | null;
  phone: string | null;
  created_at: string;
  deleted: boolean;
  owner: { id: string; name: string; phone: string } | null;
  plan: string;
  pro_until: string | null;
  pro_active: boolean;
  blocked: boolean;
  block: { action: string; reason: string | null; at: string; by: string | null } | null;
  limits: { period: string; free_limit: number; free_used: number; free_left: number; pack_left: number; unlimited: boolean };
  pricing: { labor_mode: string; labor_percent: number; labor_fixed: number; markup: Record<string, number> };
  stats: {
    projects: number;
    projects_active: number;
    orders: number;
    orders_open: number;
    turnover: number;
    ai_spend_usd: number;
    ai_spend_30d_usd: number;
    payments_total: number;
    payments_refunded: number;
    last_activity: string | null;
  };
  members: Member[];
}

type Tab = 'overview' | 'members' | 'projects' | 'orders' | 'payments' | 'ai' | 'log';
type ActionKind = 'block' | 'grant' | 'pro' | 'reset' | 'imp';

function Card() {
  const { id } = useParams<{ id: string }>();
  const { data: w, error, loading, reload } = useApi<Summary>(`/admin/workshops/${id}/summary`);
  const [f, set] = useUrlState({ tab: 'overview' });
  const tab = f.tab as Tab;
  const can = useCan();
  const [action, setAction] = useState<ActionKind | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!w) return <Loading error={error} loading={loading} />;
  const s = w.stats;
  const tabs: [Tab, string, number | null][] = [
    ['overview', 'Обзор', null],
    ['members', 'Мастера', w.members.length],
    ['projects', 'Проекты', s.projects],
    ['orders', 'Заказы', s.orders],
    ['payments', 'Платежи', null],
    ['ai', 'ИИ', null],
    ['log', 'Журнал', null],
  ];

  return (
    <>
      <Link href="/admin/workshops" className="ops-back" onClick={(e) => {
        if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
      }}>
        ← Цеха
      </Link>
      <div className="ops-head">
        <div>
          <h1>
            {w.name} {w.blocked && <Tag color="red">заблокирован</Tag>} {w.deleted && <Tag>аккаунт удалён</Tag>}
            <Tag color={w.plan === 'pro' && w.pro_active ? 'green' : undefined}>
              {PLAN_LABEL[w.plan] ?? w.plan}
              {w.plan === 'pro' && w.pro_until ? ` до ${dt(w.pro_until, false)}` : ''}
              {w.plan === 'pro' && !w.pro_active ? ' (истёк)' : ''}
            </Tag>
          </h1>
          <div className="ops-sub">
            {w.city || '—'} · {w.owner ? `${w.owner.name || 'владелец'} ${w.owner.phone}` : 'владельца нет'} · с нами с{' '}
            {dt(w.created_at, false)} · активность: {ago(s.last_activity)}
          </div>
        </div>
        <div className="ops-actions">
          {can('impersonate') && (
            <button type="button" className="b primary" onClick={() => setAction('imp')} disabled={w.members.every((m) => !m.is_active)}>
              👁 Глазами мастера
            </button>
          )}
          {can('workshops.grant') && (
            <>
              <button type="button" className="b" onClick={() => setAction('grant')}>
                Начислить проекты
              </button>
              <button type="button" className="b" onClick={() => setAction('pro')}>
                Продлить Pro
              </button>
              <button type="button" className="b" onClick={() => setAction('reset')}>
                Сбросить лимит
              </button>
              <button type="button" className={`b ${w.blocked ? '' : 'danger'}`} onClick={() => setAction('block')}>
                {w.blocked ? 'Разблокировать' : 'Заблокировать'}
              </button>
            </>
          )}
        </div>
      </div>
      {w.blocked && w.block?.action === 'block' && (
        <div className="msg error">
          Заблокирован {dt(w.block.at)}
          {w.block.by ? ` · ${w.block.by}` : ''}
          {w.block.reason ? ` · причина: ${w.block.reason}` : ''}
        </div>
      )}
      {done && <div className="msg ok">{done}</div>}
      <div className="ops-stats">
        <Stat label="Проекты" value={num(s.projects)} hint={`в работе ${s.projects_active}`} onClick={() => set({ tab: 'projects' })} />
        <Stat label="Заказы" value={num(s.orders)} hint={`открыто ${s.orders_open}`} onClick={() => set({ tab: 'orders' })} />
        <Stat label="Оборот заказов" value={sumShort(s.turnover)} hint="оплаченные поставщикам" />
        <Stat label="Платежи платформе" value={sumShort(s.payments_total)} hint={s.payments_refunded ? `возвраты ${sum(s.payments_refunded)}` : 'за всё время'} onClick={() => set({ tab: 'payments' })} />
        <Stat label="ИИ за 30 дней" value={usd(s.ai_spend_30d_usd, 2)} hint={`всего ${usd(s.ai_spend_usd, 2)}`} onClick={() => set({ tab: 'ai' })} />
        <Stat
          label={`Лимит · ${w.limits.period}`}
          value={w.limits.unlimited ? '∞' : `${w.limits.free_left} из ${w.limits.free_limit}`}
          hint={w.limits.pack_left ? `+ пакет ${w.limits.pack_left}` : 'пакета нет'}
          tone={!w.limits.unlimited && w.limits.free_left === 0 && w.limits.pack_left === 0 ? 'warn' : undefined}
        />
      </div>
      <div className="tabs">
        {tabs.map(([k, l, n]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => set({ tab: k })}>
            {l}
            {n !== null && <span className="ops-n">{n}</span>}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview w={w} />}
      {tab === 'members' && <Members w={w} />}
      {tab === 'projects' && <Projects wid={w.id} />}
      {tab === 'orders' && <Orders wid={w.id} />}
      {tab === 'payments' && <Payments wid={w.id} onChanged={reload} />}
      {tab === 'ai' && <AiUsage wid={w.id} />}
      {tab === 'log' && <Activity wid={w.id} />}
      {action && action !== 'imp' && (
        <ActionDialog
          kind={action}
          w={w}
          onClose={() => setAction(null)}
          onDone={(text) => {
            setAction(null);
            setDone(text);
            reload();
          }}
        />
      )}
      {action === 'imp' && <ImpersonateDialog w={w} onClose={() => setAction(null)} />}
    </>
  );
}

function Overview({ w }: { w: Summary }) {
  const p = w.pricing;
  return (
    <div className="grid2">
      <Box title="Цех">
        <dl className="kv">
          <dt>Владелец</dt>
          <dd>{w.owner ? `${w.owner.name || '—'} · ${w.owner.phone}` : '—'}</dd>
          <dt>Телефон цеха</dt>
          <dd>{w.phone ?? '—'}</dd>
          <dt>Город</dt>
          <dd>{w.city ?? '—'}</dd>
          <dt>Регистрация</dt>
          <dd>{dt(w.created_at)}</dd>
          <dt>Последняя активность</dt>
          <dd>{w.stats.last_activity ? `${dt(w.stats.last_activity)} (${ago(w.stats.last_activity)})` : '—'}</dd>
          <dt>Работа мастера</dt>
          <dd>{p.labor_mode === 'fixed' ? sum(p.labor_fixed) : `${p.labor_percent}% от материалов`}</dd>
          <dt>Наценки</dt>
          <dd>
            корпус {p.markup.body}%, фасады {p.markup.fronts}%, фурнитура {p.markup.hardware}%, услуги {p.markup.services}%
          </dd>
        </dl>
      </Box>
      <Box title="Тариф и лимиты">
        <dl className="kv">
          <dt>Тариф</dt>
          <dd>
            {PLAN_LABEL[w.plan] ?? w.plan}
            {w.plan === 'pro' && (
              <span className={w.pro_active ? 'muted' : 'ops-sla late'}>
                {' '}
                {w.pro_until ? `до ${dt(w.pro_until, false)}` : 'бессрочно'}
                {!w.pro_active && ' — истёк'}
              </span>
            )}
          </dd>
          <dt>Месяц лимита</dt>
          <dd>{w.limits.period}</dd>
          <dt>Бесплатные проекты</dt>
          <dd>
            {w.limits.unlimited
              ? 'без лимита (Pro)'
              : `использовано ${w.limits.free_used} из ${w.limits.free_limit}, осталось ${w.limits.free_left}`}
          </dd>
          <dt>Пакет</dt>
          <dd>{w.limits.pack_left ? `осталось ${w.limits.pack_left}` : 'нет'}</dd>
        </dl>
        <p className="muted" style={{ marginBottom: 0 }}>
          Начисление, продление Pro и сброс лимита — кнопками вверху, с причиной в журнал.
        </p>
      </Box>
    </div>
  );
}

function Members({ w }: { w: Summary }) {
  return (
    <Box>
      {w.members.length === 0 ? (
        <Empty>Пользователей нет</Empty>
      ) : (
        <div className="scroll">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Мастер</th>
                <th>Роль</th>
                <th>Заказ поставщику</th>
                <th>Видит себестоимость</th>
                <th>Последний вход</th>
                <th>Добавлен</th>
              </tr>
            </thead>
            <tbody>
              {w.members.map((m) => (
                <tr key={m.id} className={m.is_active ? '' : 'inactive'}>
                  <td>
                    <b>{m.name || '—'}</b> {!m.is_active && <Tag color="red">отключён</Tag>} {m.deleted && <Tag>удалён</Tag>}
                    <div className="sub">{m.phone}</div>
                  </td>
                  <td>
                    {m.role === 'owner' ? 'Владелец' : 'Сотрудник'}
                    {m.title && <div className="sub">{m.title}</div>}
                  </td>
                  <td>{m.can_order ? <Tag color="green">может</Tag> : <span className="muted">нет</span>}</td>
                  <td>{m.can_see_cost ? <Tag color="green">видит</Tag> : <span className="muted">нет</span>}</td>
                  <td title={m.last_login_at ? dt(m.last_login_at) : undefined}>{m.last_login_at ? ago(m.last_login_at) : 'не входил'}</td>
                  <td>{dt(m.created_at, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Box>
  );
}

interface ProjectRow {
  id: string;
  title: string;
  status_label: string;
  product_type: string | null;
  is_example: boolean;
  archived: boolean;
  charged: boolean;
  client_name?: string | null;
  created_at: string;
  updated_at: string;
}

function Projects({ wid }: { wid: string }) {
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<{ items: ProjectRow[]; total: number }>(
    `/admin/projects${qs({ workshop_id: wid, limit: 50, offset })}`,
  );
  return (
    <Box>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (data.items.length === 0 ? (
          <Empty>Проектов нет</Empty>
        ) : (
          <div className="scroll">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Проект</th>
                  <th>Статус</th>
                  <th>Клиент</th>
                  <th>Создан</th>
                  <th>Изменён</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/admin/projects/${p.id}`}>{p.title}</Link> {p.is_example && <Tag>пример</Tag>}{' '}
                      {p.archived && <Tag>архив</Tag>}
                      <div className="sub">
                        {p.product_type ?? '—'}
                        {p.charged ? ' · списан из лимита' : ''}
                      </div>
                    </td>
                    <td>{p.status_label}</td>
                    <td>{p.client_name ?? '—'}</td>
                    <td>{dt(p.created_at, false)}</td>
                    <td>{ago(p.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={data.total} limit={50} offset={offset} onChange={setOffset} />
          </div>
        ))}
    </Box>
  );
}

interface OrderRow {
  id: string;
  number: number | null;
  project_title: string | null;
  supplier_name: string | null;
  status: string;
  status_label: string;
  total: number | null;
  created_at: string;
  sla: { hours_in_status: number | null; waiting_on: string | null; overdue: boolean; late: boolean };
}

function Orders({ wid }: { wid: string }) {
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<{ items: OrderRow[]; total: number }>(
    `/admin/orders${qs({ workshop_id: wid, limit: 50, offset })}`,
  );
  return (
    <Box extra={<Link href={`/admin/orders?workshop_id=${wid}`}>Открыть в разделе «Заказы» →</Link>}>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (data.items.length === 0 ? (
          <Empty>Заказов нет</Empty>
        ) : (
          <div className="scroll">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Поставщик</th>
                  <th>Статус</th>
                  <th className="num">Сумма</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o.id} className={o.sla.overdue ? 'ops-overdue' : o.sla.late ? 'ops-late' : ''}>
                    <td>
                      <Link href={`/admin/orders/${o.id}`}>№{o.number ?? o.id.slice(0, 8)}</Link>
                      <div className="sub">{o.project_title ?? '—'}</div>
                    </td>
                    <td>{o.supplier_name ?? <span className="muted">очередь платформы</span>}</td>
                    <td>
                      <Tag color={orderStatusColor(o.status)}>{ORDER_STATUS_LABEL[o.status] ?? o.status_label}</Tag>
                      <div className={`sub ${o.sla.overdue ? 'ops-sla overdue' : ''}`}>
                        {hoursLabel(o.sla.hours_in_status)} {o.sla.waiting_on ? `· ${WAITING_LABEL[o.sla.waiting_on]}` : ''}
                      </div>
                    </td>
                    <td className="num">{sum(o.total)}</td>
                    <td>{dt(o.created_at, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={data.total} limit={50} offset={offset} onChange={setOffset} />
          </div>
        ))}
    </Box>
  );
}

interface PaymentRow {
  id: string;
  kind: string;
  title: string | null;
  amount: number;
  method: string;
  status: string;
  reference: string | null;
  project_id: string | null;
  project_title: string | null;
  paid_at: string;
  refunded_at: string | null;
}

const KIND_LABEL: Record<string, string> = { pack: 'Пакет проектов', pro: 'Pro', files: 'Файлы для станка' };
const METHOD_LABEL: Record<string, string> = {
  app_store: 'App Store',
  google_play: 'Google Play',
  click: 'Click',
  payme: 'Payme',
  manual: 'вручную',
};

function Payments({ wid, onChanged }: { wid: string; onChanged: () => void }) {
  const client = useClient();
  const can = useCan();
  const { data, error, loading, reload } = useApi<{
    items: PaymentRow[];
    totals: { paid: number; refunded: number; net: number; count: number };
  }>(`/admin/workshops/${wid}/payments`);
  const act = useAction();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('pack');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('click');
  const [reference, setReference] = useState('');
  const [refund, setRefund] = useState<PaymentRow | null>(null);
  const finance = can('finance');

  return (
    <>
      <Box
        title={data ? `Платежи: ${sum(data.totals.net)} ${data.totals.refunded ? `(возвраты ${sum(data.totals.refunded)})` : ''}` : 'Платежи'}
        extra={
          finance && (
            <button type="button" className="b" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Скрыть' : '+ Записать платёж'}
            </button>
          )
        }
      >
        <p className="muted" style={{ marginTop: 0 }}>
          Платежи цеха платформе (пакеты, Pro, файлы). Оплаты материалов получают поставщики — они в «Заказах».
        </p>
        {adding && (
          <div className="form-grid">
            <label>
              Что оплачено
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(KIND_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сумма, сум
              <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label>
              Способ
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {Object.entries(METHOD_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              № транзакции
              <input value={reference} onChange={(e) => setReference(e.target.value)} />
            </label>
            <div>
              <button
                type="button"
                className="b primary"
                disabled={act.busy || !parseSum(amount)}
                onClick={() =>
                  void act
                    .run(
                      () =>
                        client.post(`/admin/workshops/${wid}/payments`, {
                          kind,
                          amount: parseSum(amount),
                          method,
                          reference: reference.trim() || null,
                        }),
                      'Платёж записан. Начисление (пакет, Pro) — отдельно, кнопками в шапке.',
                    )
                    .then((ok) => {
                      if (!ok) return;
                      setAmount('');
                      setReference('');
                      setAdding(false);
                      reload();
                      onChanged();
                    })
                }
              >
                Записать
              </button>
            </div>
          </div>
        )}
        <Msg message={act.message} />
        <Loading error={error} loading={loading && !data} />
        {data &&
          (data.items.length === 0 ? (
            <Empty>Платежей нет</Empty>
          ) : (
            <div className="scroll">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Что</th>
                    <th>Способ</th>
                    <th className="num">Сумма</th>
                    <th>Статус</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id} className={p.status === 'refunded' ? 'inactive' : ''}>
                      <td>{dt(p.paid_at)}</td>
                      <td>
                        {p.title || KIND_LABEL[p.kind] || p.kind}
                        {p.project_id && (
                          <div className="sub">
                            <Link href={`/admin/projects/${p.project_id}`}>{p.project_title ?? 'проект'}</Link>
                          </div>
                        )}
                      </td>
                      <td>
                        {METHOD_LABEL[p.method] ?? p.method}
                        {p.reference && <div className="sub">{p.reference}</div>}
                      </td>
                      <td className="num">{sum(p.amount)}</td>
                      <td>{p.status === 'refunded' ? <Tag color="red">возврат {dt(p.refunded_at, false)}</Tag> : <Tag color="green">оплачен</Tag>}</td>
                      <td>
                        {finance && p.status !== 'refunded' && (
                          <button type="button" className="b danger" onClick={() => setRefund(p)}>
                            Возврат
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Box>
      {refund && (
        <Dialog title="Отметить возврат платежа" onClose={() => setRefund(null)} wide={false}>
          <div>
            {refund.title || KIND_LABEL[refund.kind]} · <b>{sum(refund.amount)}</b> от {dt(refund.paid_at, false)}
          </div>
          <div className="ops-consequence">
            Деньги мастеру возвращаются через платёжную систему отдельно — здесь только отметка в истории. Начисленный
            пакет или Pro не снимается автоматически.
          </div>
          <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
            <button type="button" className="b" onClick={() => setRefund(null)}>
              Отмена
            </button>
            <button
              type="button"
              className="b danger"
              disabled={act.busy}
              onClick={() =>
                void act.run(() => client.post(`/admin/payments/${refund.id}/refund`), 'Возврат отмечен').then((ok) => {
                  if (!ok) return;
                  setRefund(null);
                  reload();
                  onChanged();
                })
              }
            >
              Отметить возврат
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

interface AiUsageData {
  days: number;
  by_day: { date: string; requests: number; cost_usd: number }[];
  by_project: { project_id: string | null; title: string | null; requests: number; cost_usd: number; last_at: string }[];
  by_purpose: { purpose: string; requests: number; cost_usd: number }[];
  period: { requests: number; cost_usd: number; errors: number };
  all_time: { requests: number; cost_usd: number };
}

const PURPOSE_LABEL: Record<string, string> = {
  design: 'Проектирование',
  recognize_photo: 'Распознавание фото',
  recognize_text: 'Распознавание текста',
  edit: 'Правки словами',
  chat: 'Чат',
  clarify: 'Уточнения',
};

function AiUsage({ wid }: { wid: string }) {
  const [days, setDays] = useState(30);
  const { data, error, loading } = useApi<AiUsageData>(`/admin/workshops/${wid}/ai-usage?days=${days}`);
  const max = Math.max(...(data?.by_day.map((d) => d.cost_usd) ?? [0]), 0.0001);
  return (
    <>
      <div className="ops-filters">
        {[7, 30, 90].map((d) => (
          <button key={d} type="button" className={`b ${days === d ? 'primary' : ''}`} onClick={() => setDays(d)}>
            {d} дней
          </button>
        ))}
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <>
          <div className="ops-stats">
            <Stat label={`Расход за ${data.days} дн`} value={usd(data.period.cost_usd, 2)} hint={`${num(data.period.requests)} запросов`} />
            <Stat label="Ошибки ИИ" value={num(data.period.errors)} tone={data.period.errors ? 'warn' : undefined} />
            <Stat label="За всё время" value={usd(data.all_time.cost_usd, 2)} hint={`${num(data.all_time.requests)} запросов`} />
            <Stat label="В среднем на проект" value={data.by_project.length ? usd(data.period.cost_usd / data.by_project.length, 3) : '—'} />
          </div>
          <Box title="По дням">
            <div className="ops-bars">
              {data.by_day.map((d) => (
                <div
                  key={d.date}
                  className={d.cost_usd ? '' : 'zero'}
                  style={{ height: `${Math.max(1, (d.cost_usd / max) * 100)}%` }}
                  title={`${d.date}: ${usd(d.cost_usd, 3)}, ${d.requests} запр.`}
                />
              ))}
            </div>
            <div className="ops-axis">
              <span>{data.by_day[0]?.date}</span>
              <span>{data.by_day[data.by_day.length - 1]?.date}</span>
            </div>
          </Box>
          <div className="grid2">
            <Box title="По проектам">
              {data.by_project.length === 0 ? (
                <Empty>Запросов не было</Empty>
              ) : (
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Проект</th>
                      <th className="num">Запросов</th>
                      <th className="num">Расход</th>
                      <th>Последний</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_project.map((p) => (
                      <tr key={p.project_id ?? 'none'}>
                        <td>{p.project_id ? <Link href={`/admin/projects/${p.project_id}`}>{p.title ?? p.project_id.slice(0, 8)}</Link> : <span className="muted">без проекта</span>}</td>
                        <td className="num">{p.requests}</td>
                        <td className="num">{usd(p.cost_usd, 3)}</td>
                        <td>{ago(p.last_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Box>
            <Box title="По назначению" extra={<Link href={`/admin/ai?workshop_id=${wid}`}>ИИ-журнал →</Link>}>
              {data.by_purpose.length === 0 ? (
                <Empty>—</Empty>
              ) : (
                <table className="ops-table">
                  <tbody>
                    {data.by_purpose.map((p) => (
                      <tr key={p.purpose}>
                        <td>{PURPOSE_LABEL[p.purpose] ?? p.purpose}</td>
                        <td className="num">{p.requests}</td>
                        <td className="num">{usd(p.cost_usd, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Box>
          </div>
        </>
      )}
    </>
  );
}

interface LogRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

const ENTITY_LABEL: Record<string, string> = {
  workshop: 'Цех',
  workshop_plan: 'Тариф',
  workshop_limits: 'Лимит',
  impersonation: 'Глазами мастера',
  payment: 'Платёж',
  order: 'Заказ',
  order_dispute: 'Спор',
  file_access: 'Доступ к файлам',
  pricing: 'Цены',
  project: 'Проект',
};
const ACTION_LABEL: Record<string, string> = {
  block: 'заблокирован',
  unblock: 'разблокирован',
  update: 'изменение',
  reset: 'сброс',
  start: 'начат просмотр',
  request: 'запрос',
  denied: 'попытка изменить (запрещено)',
  create: 'создан',
  refund: 'возврат',
  status: 'статус',
  grant: 'открыт',
  resolve: 'решён',
};
const ACTOR_LABEL: Record<string, string> = { staff: 'Платформа', user: 'Мастер', system: 'Система' };

function brief(v: Record<string, unknown> | null): string {
  if (!v) return '';
  return Object.entries(v)
    .filter(([k]) => k !== 'reason')
    .map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`)
    .join(', ');
}

function Activity({ wid }: { wid: string }) {
  const [actor, setActor] = useState('all');
  const [requests, setRequests] = useState(false);
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi<{ items: LogRow[]; total: number; page_size: number }>(
    `/admin/workshops/${wid}/activity${qs({ actor, hide_requests: !requests, page, page_size: 50 })}`,
  );
  return (
    <Box>
      <div className="ops-filters">
        <select value={actor} onChange={(e) => { setActor(e.target.value); setPage(1); }} aria-label="Кто">
          <option value="all">Все</option>
          <option value="staff">Сотрудники платформы</option>
          <option value="user">Мастера</option>
          <option value="system">Система</option>
        </select>
        <label className="chk">
          <input type="checkbox" checked={requests} onChange={(e) => { setRequests(e.target.checked); setPage(1); }} /> показывать
          каждый запрос «глазами мастера»
        </label>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (data.items.length === 0 ? (
          <Empty>Записей нет</Empty>
        ) : (
          <div className="scroll">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Что</th>
                  <th>Подробности</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => {
                  const reason = (e.after?.reason as string | undefined) ?? null;
                  return (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{dt(e.created_at)}</td>
                      <td>
                        {e.actor_name ?? ACTOR_LABEL[e.actor_type] ?? e.actor_type}
                        <div className="sub">{ACTOR_LABEL[e.actor_type] ?? e.actor_type}</div>
                      </td>
                      <td>
                        {ENTITY_LABEL[e.entity] ?? e.entity} · {ACTION_LABEL[e.action] ?? e.action}
                      </td>
                      <td>
                        {reason && <div>Причина: «{reason}»</div>}
                        <code className="sub" style={{ wordBreak: 'break-word' }}>
                          {e.before ? `${brief(e.before)} → ` : ''}
                          {brief(e.after)}
                        </code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pager total={data.total} limit={50} offset={(page - 1) * 50} onChange={(o) => setPage(o / 50 + 1)} />
          </div>
        ))}
    </Box>
  );
}

/** Действия с цехом: у каждого — свои поля и обязательная причина в журнал. */
function ActionDialog({ kind, w, onClose, onDone }: { kind: Exclude<ActionKind, 'imp'>; w: Summary; onClose: () => void; onDone: (text: string) => void }) {
  const client = useClient();
  const act = useAction();
  const [reason, setReason] = useState('');
  const [count, setCount] = useState('5');
  const base = w.pro_until && new Date(w.pro_until) > new Date() ? new Date(w.pro_until) : new Date();
  const plus = (months: number) => {
    const d = new Date(base);
    d.setMonth(d.getMonth() + months);
    return d.toISOString().slice(0, 10);
  };
  const [until, setUntil] = useState(plus(1));

  let title = '';
  let body: React.ReactNode = null;
  let confirm = '';
  let danger = false;
  let ready = reasonOk(reason);
  let run: () => Promise<unknown> = async () => undefined;
  let ok = '';

  if (kind === 'block') {
    const blocking = !w.blocked;
    title = blocking ? `Заблокировать цех «${w.name}»` : `Разблокировать цех «${w.name}»`;
    danger = blocking;
    confirm = blocking ? 'Заблокировать' : 'Разблокировать';
    body = blocking ? (
      <div className="ops-consequence red">
        Все мастера цеха ({w.members.filter((m) => m.is_active).length}) сразу потеряют доступ к приложению: проекты, сметы и
        заказы будут недоступны до разблокировки. Данные не удаляются.
      </div>
    ) : (
      <div className="ops-consequence">Мастера цеха снова смогут войти и работать.</div>
    );
    run = () => client.post(`/admin/workshops/${w.id}/block`, { blocked: blocking, reason: reason.trim() });
    ok = blocking ? 'Цех заблокирован' : 'Цех разблокирован';
  } else if (kind === 'grant') {
    const n = Number(count);
    title = 'Начислить проекты в пакет';
    confirm = `Начислить ${Number.isFinite(n) ? n : ''}`;
    ready = ready && Number.isInteger(n) && n > 0 && n <= 1000;
    body = (
      <>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          {[1, 5, 10, 20].map((x) => (
            <button key={x} type="button" className={`b ${count === String(x) ? 'primary' : ''}`} onClick={() => setCount(String(x))}>
              +{x}
            </button>
          ))}
          <input type="number" min={1} max={1000} className="xs" value={count} onChange={(e) => setCount(e.target.value)} aria-label="Сколько проектов" />
        </div>
        <div className="muted">
          Сейчас в пакете: {w.limits.pack_left}. Станет: {w.limits.pack_left + (Number.isFinite(n) ? n : 0)}. Пакет тратится после
          бесплатных проектов месяца.
        </div>
      </>
    );
    run = () => client.post(`/admin/workshops/${w.id}/plan`, { add_pack_projects: n, reason: reason.trim() });
    ok = `Начислено проектов: ${n}`;
  } else if (kind === 'pro') {
    title = w.plan === 'pro' && w.pro_active ? 'Продлить Pro' : 'Включить Pro';
    confirm = 'Сохранить';
    ready = ready && Boolean(until) && new Date(`${until}T23:59:59+05:00`) > new Date();
    body = (
      <>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          {[
            [1, '+1 мес'],
            [3, '+3 мес'],
            [12, '+1 год'],
          ].map(([m, l]) => (
            <button key={m} type="button" className={`b ${until === plus(m as number) ? 'primary' : ''}`} onClick={() => setUntil(plus(m as number))}>
              {l}
            </button>
          ))}
          <label className="chk">
            до <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        </div>
        <div className="muted">
          Сейчас: {PLAN_LABEL[w.plan] ?? w.plan}
          {w.pro_until ? `, Pro до ${dt(w.pro_until, false)}` : ''}. Pro — проекты без лимита. Платёж (если был) запишите во
          вкладке «Платежи».
        </div>
      </>
    );
    run = () =>
      client.post(`/admin/workshops/${w.id}/plan`, {
        plan: 'pro',
        pro_until: new Date(`${until}T23:59:59+05:00`).toISOString(),
        reason: reason.trim(),
      });
    ok = `Pro до ${until.split('-').reverse().join('.')}`;
  } else {
    title = `Сбросить лимит за ${w.limits.period}`;
    confirm = 'Сбросить лимит';
    ready = ready && !w.limits.unlimited;
    body = (
      <div className="ops-consequence">
        {w.limits.unlimited
          ? 'У цеха Pro — лимита нет, сбрасывать нечего.'
          : `Использовано ${w.limits.free_used} из ${w.limits.free_limit}. Проекты, списанные из бесплатного лимита в этом месяце, вернутся в лимит — у мастера снова будет ${w.limits.free_limit} бесплатных. Пакет и Pro не меняются.`}
      </div>
    );
    run = () => client.post(`/admin/workshops/${w.id}/reset-limits`, { reason: reason.trim() });
    ok = 'Лимит месяца сброшен';
  }

  return (
    <Dialog title={title} onClose={onClose}>
      {body}
      <ReasonField value={reason} onChange={setReason} />
      <Msg message={act.message} />
      <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
        <button type="button" className="b" onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className={`b ${danger ? 'danger' : 'primary'}`}
          disabled={act.busy || !ready}
          onClick={() => void act.run(run).then((r) => r && onDone(ok))}
        >
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** «Глазами мастера»: выбрать, чьими глазами, причина → короткий токен только на чтение → страница просмотра. */
function ImpersonateDialog({ w, onClose }: { w: Summary; onClose: () => void }) {
  const client = useClient();
  const router = useRouter();
  const act = useAction();
  const active = w.members.filter((m) => m.is_active && !m.deleted);
  const [userId, setUserId] = useState(active.find((m) => m.role === 'owner')?.id ?? active[0]?.id ?? '');
  const [reason, setReason] = useState('');
  return (
    <Dialog title="Глазами мастера" onClose={onClose}>
      <div className="ops-consequence">
        Откроется приложение так, как его видит мастер: проекты, карточки, 3D, заказы. <b>Только чтение</b> — изменить ничего
        нельзя. Доступ — 15 минут, каждый запрос пишется в журнал цеха.
      </div>
      <label className="f">
        Чьими глазами
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          {active.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.phone} — {m.role === 'owner' ? 'владелец' : 'сотрудник'}
              {m.role !== 'owner' && !m.can_see_cost ? ' (без себестоимости)' : ''}
            </option>
          ))}
        </select>
      </label>
      <ReasonField value={reason} onChange={setReason} label="Зачем смотрите (обязательно, попадёт в журнал) — например, номер обращения" />
      <Msg message={act.message} />
      <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
        <button type="button" className="b" onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className="b primary"
          disabled={act.busy || !reasonOk(reason) || !userId}
          onClick={() =>
            void act.run(async () => {
              const r = await client.post<Impersonation>(`/admin/workshops/${w.id}/impersonate`, {
                reason: reason.trim(),
                user_id: userId,
              });
              const expires_at = r.expires_at ?? new Date(Date.now() + (r.expires_in ?? 900) * 1000).toISOString();
              saveImp(w.id, { ...r, expires_at, reason: reason.trim() });
              router.push(`/admin/workshops/${w.id}/as-master`);
            })
          }
        >
          Открыть просмотр
        </button>
      </div>
    </Dialog>
  );
}

export default function WorkshopCardPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Card />
    </Suspense>
  );
}
