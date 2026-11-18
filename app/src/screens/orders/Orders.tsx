/**
 * S03 «Заказы» (вкладка) — макеты Orders, OrdersEmpty, OrdersOffline.
 * Быстрые действия, поиск, фильтр по статусам со счётчиками, «Донастроить цех», список заказов.
 * Без сети: последний загруженный список + заказы и замеры, которые есть только на телефоне («не отправлен»).
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, TextInput, View } from 'react-native';

import { api, ApiError } from '@/api/http';
import type { Counts, OrderRow, OrderStatus, Template } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { date, m2, money, STATUS_TITLE } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { LocalOrder, LocalPosition, offline } from '@/offline/store';
import { C, F } from '@/theme';
import { Icon } from '@/ui/Icon';
import { Body, Button, Card, LoadError, Loading, Screen, Seg, StatusPill, Txt } from '@/ui/kit';
import { MainHeader } from '@/ui/MainHeader';
import { TAB_BAR_SPACE } from '@/ui/TabBar';
import { Ban, CompanyOut, NotSent, nItems, PIcon, PosTile, Pill, st, Svc, Tag, WindowThumb } from './parts';

type Filter = 'all' | OrderStatus;
type Snap = Awaited<ReturnType<typeof offline.snapshot>>;
type Loaded = { rows: OrderRow[]; counts: Counts; offline: boolean; snap: Snap; pending: number };

/** Последний список с сервера — показываем его без сети (в пределах запуска приложения). */
let lastList: { rows: OrderRow[]; counts: Counts } | null = null;
/** Сколько шаблонов готово («Шаблон · 11 готовых») — один раз за запуск. */
let readyTemplates: number | null = null;

const MAIN_CHIPS: OrderStatus[] = ['measure', 'quoted', 'agreed'];
const MORE_CHIPS: OrderStatus[] = ['production', 'ready', 'installed', 'closed', 'cancelled'];

export default function Orders() {
  const router = useRouter();
  const { isOwner } = useAuth();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [starting, setStarting] = useState<'measure' | 'template' | null>(null);
  const [tplCount, setTplCount] = useState<number | null>(readyTemplates);

  // поиск — с задержкой, чтобы не дёргать сервер на каждую букву
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const status = filter === 'all' ? undefined : filter;
  const { data, error, loading, reload } = useLoad<Loaded>(async () => {
    const snap = await offline.snapshot();
    const pending = await offline.pendingCount();
    try {
      const [rows, counts] = await Promise.all([
        api.get<OrderRow[]>('/oyna/orders', { status, q }),
        api.get<Counts>('/oyna/orders/counts'),
      ]);
      if (!status && !q) lastList = { rows, counts };
      return { rows, counts, offline: false, snap, pending };
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork) {
        const rows = (lastList?.rows ?? []).filter((r) => (!status || r.status === status) && matches(q, r.client_name, r.address, r.client_phone));
        return { rows, counts: lastList?.counts ?? {}, offline: true, snap, pending };
      }
      throw e;
    }
  }, [status, q]);

  // «Донастроить цех» — только владельцу (настройки меняет он)
  const company = useLoad<CompanyOut | null>(async () => (isOwner ? api.get<CompanyOut>('/oyna/company').catch(() => null) : null), [isOwner]);

  useEffect(() => {
    if (readyTemplates !== null) return;
    api.get<Template[]>('/oyna/templates').then((t) => {
      readyTemplates = t.filter((x) => x.ready).length;
      setTplCount(readyTemplates);
    }).catch(() => { /* без сети — «готовые» без числа */ });
  }, []);

  // изменения офлайн-хранилища (синхронизация прошла) — перечитать, пока экран на виду
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useFocusEffect(useCallback(() => offline.subscribe(() => { void reloadRef.current(); }), []));

  const start = useCallback(async (what: 'measure' | 'template') => {
    setStarting(what);
    try {
      const o = await offline.createOrder();
      router.push(what === 'measure' ? `/order/${o.id}/measure` : `/order/${o.id}/templates`);
    } finally {
      setStarting(null);
    }
  }, [router]);

  const sync = async () => {
    setSyncing(true);
    try {
      await offline.sync();
    } catch { /* ошибка — останется в «не отправлено» */ }
    setSyncing(false);
    void reload();
  };

  const view = useMemo(() => (data ? build(data, status, q) : null), [data, status, q]);

  if (!data && loading) return <Screen><MainHeader title="Заказы" /><Loading /></Screen>;
  if (!data || !view) return <Screen><MainHeader title="Заказы" /><LoadError message={error ?? ''} onRetry={reload} /></Screen>;

  const off = data.offline;
  const counts = data.counts;
  const allCount = (counts.all ?? 0) + view.localOnly.length;

  // ---------- пусто (OrdersEmpty) ----------
  if (!off && filter === 'all' && !q && allCount === 0 && !view.local.length) {
    return (
      <Screen>
        <MainHeader title="Заказы" />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32, paddingBottom: TAB_BAR_SPACE + 10 }}>
          <View style={{ width: 140, height: 140, borderRadius: 40, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
            <WindowThumb width={96} height={84} />
          </View>
          <Txt size={22} w={700} center style={{ lineHeight: 28, letterSpacing: -0.4 }}>Здесь будут ваши замеры</Txt>
          <Txt color={C.muted} center>Окно с размерами и ценой — за 2 минуты, даже без интернета</Txt>
          <Button title="Начать первый замер" onPress={() => start('measure')} loading={starting === 'measure'} style={{ alignSelf: 'stretch', marginTop: 4 }} />
        </View>
      </Screen>
    );
  }

  const chips: { value: Filter; title: string; count?: number }[] = [
    { value: 'all', title: 'Все', count: allCount },
    ...MAIN_CHIPS.map((s) => ({ value: s as Filter, title: off && s === 'quoted' ? 'КП' : STATUS_TITLE[s], count: (counts[s] ?? 0) + (s === 'measure' ? view.localOnly.length : 0) })),
    ...MORE_CHIPS.filter((s) => (counts[s] ?? 0) > 0 || filter === s).map((s) => ({ value: s as Filter, title: STATUS_TITLE[s], count: counts[s] ?? 0 })),
  ];
  const ob = company.data?.onboarding;
  const obSteps = ob ? (ob.works_missing.length ? 1 : 0) + (ob.glass_missing ? 1 : 0) : 0;
  const obWhat = ob ? [ob.works_missing.length ? 'работы' : null, ob.glass_missing ? 'стекло' : null].filter(Boolean).join(' и ') : '';

  return (
    <Screen>
      <MainHeader title="Заказы" />
      {off ? (
        <View style={{ marginHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.dark }}>
          <PIcon name="wifi_off" size={18} color="#fff" />
          <Txt size={13} w={500} color="#fff" style={{ flex: 1 }}>Нет интернета — всё сохраняется на телефоне</Txt>
        </View>
      ) : null}
      <Body style={{ paddingTop: off ? 10 : 6, paddingHorizontal: 12, gap: 10, paddingBottom: TAB_BAR_SPACE }}
        refresh={<RefreshControl refreshing={loading && !!data} onRefresh={reload} tintColor={C.accent} />}>
        {/* быстрые действия */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Svc pri flex={1.25} title={'Новый\nзамер'} sub="окно за 2 мин" onPress={() => start('measure')} disabled={!!starting} />
          <Svc icon="grid" title="Шаблон" sub={tplCount !== null ? `${tplCount} готовых` : 'готовые'} onPress={() => start('template')} disabled={!!starting} />
          <Svc icon="camera2" title="По фото" sub="через ИИ · скоро" disabled />
        </View>

        {!off ? (
          <View style={{ height: 48, borderRadius: 16, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 }}>
            <Icon name="search" size={20} color={C.faint} />
            <TextInput value={query} onChangeText={setQuery} placeholder="Клиент, телефон, адрес" placeholderTextColor={C.faint}
              returnKeyType="search" autoCorrect={false} clearButtonMode="while-editing"
              style={{ flex: 1, fontFamily: F.regular, fontSize: 16, color: C.ink, paddingVertical: 0 }} />
          </View>
        ) : null}

        <Seg chips items={chips} value={filter} onChange={setFilter} style={{ marginHorizontal: -12 }} />

        {!off && obSteps > 0 ? (
          <Ban kind="est" title={`Донастроить цех: ${obSteps} ${obSteps === 1 ? 'шаг' : 'шага'}`} text={`${obWhat} — пока ДЕМО`}
            onPress={() => router.push('/profile')} />
        ) : null}

        {!off && data.pending > 0 ? (
          <Ban kind="info" icon="sync" title={`Не отправлено: ${data.pending}`} text="Замеры с телефона ждут отправки"
            action={
              <Pressable accessibilityRole="button" disabled={syncing} onPress={sync} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'center' }}>
                <Txt size={15} w={600} color={C.accentDeep}>{syncing ? 'Отправляем…' : 'Отправить'}</Txt>
              </Pressable>
            } />
        ) : null}

        {view.local.length || view.rows.length ? (
          <Card style={{ marginHorizontal: 0 }}>
            {view.local.map((o, i) => <LocalRow key={o.id} order={o} positions={view.localPos[o.id] ?? []} first={i === 0} onPress={() => router.push(`/order/${o.id}`)} />)}
            {view.rows.map((r, i) => (
              <ServerRow key={r.id} row={r} first={i === 0 && !view.local.length} pending={view.pendingIds.has(r.id)} onPress={() => router.push(`/order/${r.id}`)} />
            ))}
          </Card>
        ) : (
          <View style={{ paddingVertical: 32, alignItems: 'center', gap: 4 }}>
            <Txt w={600} center>{q ? 'Ничего не нашли' : 'Заказов нет'}</Txt>
            <Txt size={14} color={C.muted} center>{q ? 'Попробуйте другое имя, телефон или адрес' : 'В этом статусе пока пусто'}</Txt>
          </View>
        )}

        {off ? <Txt size={14} color={C.muted} center style={{ paddingHorizontal: 20, paddingVertical: 4 }}>Замер и редактор работают. Расчёт и КП — когда появится сеть</Txt> : null}
      </Body>
    </Screen>
  );
}

function matches(q: string, ...fields: (string | null | undefined)[]) {
  if (!q) return true;
  const s = q.toLowerCase();
  return fields.some((f) => (f ?? '').toLowerCase().includes(s));
}

/** Список: сначала заказы только с телефона, потом с сервера; «не отправлен» — есть несинхронизированные правки. */
function build(d: Loaded, status: OrderStatus | undefined, q: string) {
  const serverIds = new Set(d.rows.map((r) => r.id));
  const allServer = new Set((lastList?.rows ?? []).map((r) => r.id));
  const localPos: Record<string, LocalPosition[]> = {};
  const pendingIds = new Set<string>();
  for (const p of Object.values(d.snap.positions)) {
    if (p.deleted) continue;
    (localPos[p.order_id] ??= []).push(p);
    if (p.dirty) pendingIds.add(p.order_id);
  }
  for (const o of Object.values(d.snap.orders)) if (!o.synced) pendingIds.add(o.id);
  // заказ создан на телефоне и ещё не ушёл на сервер (или ушёл, но список с сервера старый)
  const localOnly = Object.values(d.snap.orders).filter((o) => !o.synced && !serverIds.has(o.id) && !allServer.has(o.id));
  const local = (!status || status === 'measure')
    ? localOnly.filter((o) => matches(q, o.client?.name, o.address, o.client?.phone)).sort((a, b) => b.created_at.localeCompare(a.created_at))
    : [];
  return { rows: d.rows, local, localOnly, localPos, pendingIds };
}

function RowShell({ first, onPress, children, doc }: { first: boolean; onPress: () => void; children: ReactNode; doc?: LocalPosition['doc'] }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => [{ flexDirection: 'row', gap: 14, alignItems: 'flex-start', paddingHorizontal: 20, paddingVertical: 12, minHeight: 60 },
        pressed && { backgroundColor: '#F7F7F5' }]}>
      {!first ? <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, backgroundColor: C.line }} /> : null}
      <PosTile doc={doc} />
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </Pressable>
  );
}

function ServerRow({ row, first, pending, onPress }: { row: OrderRow; first: boolean; pending: boolean; onPress: () => void }) {
  const sub = [row.address, row.units ? nItems(row.units) : null, row.area_m2 ? m2(row.area_m2) : null].filter(Boolean).join(' · ');
  return (
    <RowShell first={first} onPress={onPress}>
      <View style={st.rowTop}>
        <Txt w={600} lines={1} style={{ flex: 1 }}>{row.client_name || 'Без клиента'}</Txt>
        <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{row.total > 0 ? money(row.total) : '—'}</Txt>
      </View>
      {sub ? <Txt size={14} color={C.muted} lines={2}>{sub}</Txt> : null}
      <View style={st.pills}>
        <StatusPill code={row.status} title={STATUS_TITLE[row.status] ?? row.status} />
        {row.status === 'quoted' && row.quote_sent_at ? <Txt size={13} color={C.muted}>{date(row.quote_sent_at).slice(0, 5)}</Txt> : null}
        {row.missing_price_positions > 0 ? <Pill color="red" title={`нет цены: ${row.missing_price_positions}`} /> : null}
        {row.demo ? <Tag title="ДЕМО" /> : null}
        {pending ? <NotSent /> : null}
      </View>
    </RowShell>
  );
}

function LocalRow({ order, positions, first, onPress }: { order: LocalOrder; positions: LocalPosition[]; first: boolean; onPress: () => void }) {
  const rooms = [...new Set(positions.map((p) => p.doc.room).filter(Boolean))] as string[];
  const units = positions.reduce((s, p) => s + (p.doc.qty ?? 1), 0);
  const sub = [order.address, rooms.length ? rooms.join(', ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : null, units ? nItems(units) : null]
    .filter(Boolean).join(' · ');
  return (
    <RowShell first={first} onPress={onPress} doc={positions[0]?.doc}>
      <View style={st.rowTop}>
        <Txt w={600} lines={1} style={{ flex: 1 }}>{order.client?.name || 'Без клиента'}</Txt>
      </View>
      <Txt size={14} color={C.muted} lines={2}>{sub || 'Пока без изделий'}</Txt>
      <View style={st.pills}>
        {units ? <Txt size={13} color={C.muted}>посчитаем при сети</Txt> : <StatusPill code="measure" title={STATUS_TITLE.measure} />}
        <NotSent />
      </View>
    </RowShell>
  );
}
