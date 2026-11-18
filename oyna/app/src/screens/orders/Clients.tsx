/**
 * Клиенты (вкладка, концепт Main «Заказы · Клиенты · + · Каталог · Профиль»): список клиентов из GET /oyna/orders —
 * группировка по телефону, иначе по Telegram, иначе по имени. У клиента — сколько заказов, последний заказ и его статус.
 * Нажатие → последний заказ (/order/[id]). Заказы, ещё не ушедшие с телефона, тоже попадают в список.
 */
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, View } from 'react-native';

import { api, ApiError } from '@/api/http';
import type { OrderRow, OrderStatus } from '@/api/types';
import { ago, initials, money, phone as fmtPhone, STATUS_TITLE } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { offline } from '@/offline/store';
import { C } from '@/theme';
import { Body, Button, Card, Empty, Item, Loading, LoadError, Screen, Txt } from '@/ui/kit';
import { MainHeader } from '@/ui/MainHeader';
import { TAB_BAR_SPACE } from '@/ui/TabBar';
import { Ban, plural, SearchBox, Tag } from '../profile/parts';

type Client = {
  key: string; name: string | null; phone: string | null; telegram: string | null;
  orders: number; total: number; last: { id: string; status: OrderStatus | 'local'; at: string; address: string | null; total: number; demo: boolean };
};

const norm = (s?: string | null) => (s ?? '').trim();
function clientKey(name?: string | null, phone?: string | null, tg?: string | null): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length >= 7) return `p:${d.slice(-9)}`;
  const t = norm(tg).replace(/^@/, '').toLowerCase();
  if (t) return `t:${t}`;
  const n = norm(name).toLowerCase().replace(/\s+/g, ' ');
  return n ? `n:${n}` : null;
}

type Row = { id: string; name: string | null; phone: string | null; telegram: string | null; status: OrderStatus | 'local'; at: string; address: string | null; total: number; demo: boolean };

function group(rows: Row[]): Client[] {
  const map = new Map<string, Client>();
  for (const r of rows) {
    const key = clientKey(r.name, r.phone, r.telegram);
    if (!key) continue;
    const c = map.get(key);
    if (!c) {
      map.set(key, { key, name: norm(r.name) || null, phone: r.phone, telegram: r.telegram, orders: 1, total: r.total, last: { id: r.id, status: r.status, at: r.at, address: r.address, total: r.total, demo: r.demo } });
      continue;
    }
    c.orders += 1;
    c.total += r.total;
    c.name = c.name || norm(r.name) || null;
    c.phone = c.phone || r.phone;
    c.telegram = c.telegram || r.telegram;
    if (r.at > c.last.at) c.last = { id: r.id, status: r.status, at: r.at, address: r.address, total: r.total, demo: r.demo };
  }
  return [...map.values()].sort((a, b) => (a.last.at < b.last.at ? 1 : -1));
}

export default function Clients() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const load = useLoad(async () => {
    const snap = await offline.snapshot().catch(() => null);
    const local: Row[] = Object.values(snap?.orders ?? {}).filter((o) => !o.synced).map((o) => ({
      id: o.id, name: o.client?.name ?? null, phone: o.client?.phone ?? null, telegram: o.client?.telegram ?? null,
      status: 'local', at: o.created_at, address: o.address ?? null, total: 0, demo: false,
    }));
    try {
      const orders = await api.get<OrderRow[]>('/oyna/orders');
      const ids = new Set(orders.map((o) => o.id));
      const rows: Row[] = orders.map((o) => ({
        id: o.id, name: o.client_name, phone: o.client_phone, telegram: o.client_telegram, status: o.status,
        at: o.updated_at || o.created_at, address: o.address, total: o.accepted_total ?? o.total ?? 0, demo: o.demo,
      }));
      return { clients: group([...rows, ...local.filter((l) => !ids.has(l.id))]), offline: false };
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork && local.length) return { clients: group(local), offline: true };
      throw e;
    }
  });

  const shown = useMemo(() => {
    const list = load.data?.clients ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    const dq = needle.replace(/\D/g, '');
    return list.filter((c) => (c.name ?? '').toLowerCase().includes(needle) || (c.telegram ?? '').toLowerCase().includes(needle.replace(/^@/, ''))
      || (dq.length >= 2 && (c.phone ?? '').replace(/\D/g, '').includes(dq)) || (c.last.address ?? '').toLowerCase().includes(needle));
  }, [load.data, q]);

  const total = load.data?.clients.length ?? 0;
  return (
    <Screen>
      <MainHeader title="Клиенты" />
      {!load.data && load.loading ? <Loading /> : !load.data && load.error ? <LoadError message={load.error} onRetry={load.reload} /> : total === 0 ? (
        <Empty title="Клиентов пока нет" text="Клиент появится здесь, когда в заказе будет его имя, телефон или Telegram"
          action={<Button title="Новый заказ" icon="plus" onPress={() => router.push('/new')} />} />
      ) : (
        <Body style={{ paddingTop: 4, gap: 10, paddingBottom: TAB_BAR_SPACE }} refresh={<RefreshControl refreshing={load.loading} onRefresh={load.reload} />}>
          <View style={{ paddingHorizontal: 12 }}><SearchBox value={q} onChange={setQ} placeholder="Имя, телефон, Telegram" /></View>
          {load.data?.offline ? <View style={{ paddingHorizontal: 12 }}><Ban kind="info" title="Нет связи" text="Показаны только заказы с этого телефона" /></View> : null}
          {load.error && load.data ? <View style={{ paddingHorizontal: 12 }}><Ban kind="err" title="Не обновилось" text={load.error} /></View> : null}
          <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 20 }}>{`${total} ${plural(total, 'клиент', 'клиента', 'клиентов')}`}</Txt>
          {shown.length === 0 ? <Empty title="Никого не нашли" text="Поиск — по имени, телефону, Telegram и адресу" /> : (
            <Card>
              {shown.map((c, i) => {
                const title = c.name || fmtPhone(c.phone) || (c.telegram ? `@${c.telegram.replace(/^@/, '')}` : 'Без имени');
                const contact = c.name ? fmtPhone(c.phone) || (c.telegram ? `@${c.telegram.replace(/^@/, '')}` : '') : '';
                const sub = [contact, `${c.orders} ${plural(c.orders, 'заказ', 'заказа', 'заказов')}`, c.last.address ?? ''].filter(Boolean).join(' · ');
                return (
                  <Item key={c.key} first={i === 0} onPress={() => router.push({ pathname: '/order/[id]', params: { id: c.last.id } })}
                    thumb={<View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: '#EEF3F8', alignItems: 'center', justifyContent: 'center' }}><Txt size={17} w={700} color={C.accentDeep}>{initials(c.name || '?')}</Txt></View>}
                    title={
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Txt w={500} lines={1} style={{ flex: 1 }}>{title}</Txt>
                        <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{c.last.total ? money(c.last.total) : '—'}</Txt>
                      </View>
                    }
                    sub={
                      <View>
                        {sub ? <Txt size={14} color={C.muted} lines={1}>{sub}</Txt> : null}
                        <LastOrderLine status={c.last.status} at={c.last.at} demo={c.last.demo} />
                      </View>
                    } />
                );
              })}
            </Card>
          )}
        </Body>
      )}
    </Screen>
  );
}

/** Статус последнего заказа и когда — под строкой клиента */
function LastOrderLine({ status, at, demo }: { status: OrderStatus | 'local'; at: string; demo: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <Tag kind={status === 'local' ? 'n' : status === 'quoted' ? 'info' : ['agreed', 'ready', 'installed'].includes(status) ? 'ok' : status === 'cancelled' ? 'err' : status === 'production' ? 'est' : 'n'}>
        {status === 'local' ? 'не отправлен' : STATUS_TITLE[status] ?? status}
      </Tag>
      <Txt size={14} color={C.muted}>{ago(at)}</Txt>
      {demo ? <Tag kind="est">ДЕМО</Tag> : null}
    </View>
  );
}
