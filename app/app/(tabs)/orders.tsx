/**
 * SCR-15 Заказы (Orders.dc.html): заказы в EMAN и у партнёров — номер и проект, сумма, клиент и срок, полоса прогресса,
 * статус; фильтр «Активные / Готовы / Все»; у готовых — «Повторить» (новый заказ по проекту).
 */
import { Ionicons } from '@expo/vector-icons';
import { Tabs, router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import type { OrderOut } from '../../src/api/types';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import type { DictKey } from '../../src/i18n/ru';
import { formatDayMonth, groupDigits } from '../../src/lib/format';
import { invoiceTotal, isActiveOrder, needsMaster, orderBadge, orderNote, orderProgress } from '../../src/lib/orders';
import { useOrderPush } from '../../src/state/orderEvents';
import { useSession } from '../../src/state/session';
import { ErrorState } from '../../src/ui/ErrorState';
import { Avatar, Badge, Button, Card, Chip, ChipRow, EmptyState, IconButton, Loading, OfflineBanner, Press, T } from '../../src/ui/kit';
import { palette, type Tone } from '../../src/ui/theme';

type Filter = 'active' | 'ready' | 'all';
const isReady = (o: OrderOut) => o.status === 'ready';
const isActive = isActiveOrder;

export default function Orders() {
  const { t, td, lang } = useT();
  const { workshop, user, canOrder } = useSession();
  const [filter, setFilter] = useState<Filter>('active');
  const { data, error, loading, refreshing, reload, refresh } = useResource(() => api.listOrders(), []);
  // push по любому заказу (сообщение, решение поставщика) — тихо обновить список
  useOrderPush(null, () => reload());
  const projects = useResource(() => api.listProjects({ limit: 200 }).then((p) => p.items).catch(() => []), []);
  const clientOf = (pid: string) => projects.data?.find((p) => p.id === pid)?.client?.name ?? null;
  const all = data ?? [];
  const counts = { active: all.filter(isActive).length, ready: all.filter(isReady).length };
  const items = all.filter((o) => (filter === 'active' ? isActive(o) : filter === 'ready' ? isReady(o) : true));

  const header = (
    <Tabs.Screen options={{
      headerLeft: () => (
        <IconButton dark label={t('pl_profile')} onPress={() => router.push('/profile')}>
          <Avatar dark name={workshop?.name || user?.name} />
        </IconButton>
      ),
    }} />
  );

  // метка и подпись — по контракту поставщика (src/lib/orders): на проверке, вернули, ждёт подтверждения, отклонён…
  const status = (o: OrderOut): { label: string; tone: Tone } => {
    const b = orderBadge(o);
    return { label: b.label === 'os_created' ? t('os_in_review') : td(b.label, o.status_label ?? o.status), tone: b.tone };
  };
  const note = (o: OrderOut) => {
    const n = orderNote(o);
    return n ? t(n.key as DictKey, n.date ? { date: formatDayMonth(n.date, lang) } : undefined) : null;
  };
  const progress = orderProgress;

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      {header}
      <OfflineBanner />
      {loading && !data ? <Loading /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : (
        <ScrollView contentContainerStyle={st.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
          <T v="cap" style={{ paddingHorizontal: 8, marginTop: -9 }}>{t('ol_sub')}</T>
          {all.length ? (
            <ChipRow>
              <Chip label={t('ol_active')} count={counts.active || undefined} selected={filter === 'active'} onPress={() => setFilter('active')} />
              <Chip label={t('ol_ready')} count={counts.ready || undefined} selected={filter === 'ready'} onPress={() => setFilter('ready')} />
              <Chip label={t('ol_all')} selected={filter === 'all'} onPress={() => setFilter('all')} />
            </ChipRow>
          ) : null}
          {!all.length ? (
            <EmptyState icon="cube-outline" title={t('orders_empty_title')} text={t('orders_empty_text')}
              actions={<Button v="secondary" title={t('orders_open_projects')} onPress={() => router.navigate('/')} />} />
          ) : items.length ? (
            <Card padded={false}>
              {items.map((o, i) => {
                const s = status(o);
                const sub = [clientOf(o.project_id), note(o)].filter(Boolean).join(' · ');
                const unread = canOrder ? o.unread_count ?? 0 : 0; // переписка — только с правом заказа
                const total = invoiceTotal(o);
                return (
                  <Press key={o.id} feedback="row" onPress={() => router.push(`/order/${o.id}`)} accessibilityRole="button" style={[st.or, i > 0 && st.sep]}>
                    <View style={st.l1}>
                      <T v="rt" style={{ fontWeight: '600', flex: 1 }} numberOfLines={1}>{`№ ${o.number}${o.project_title ? ` · ${o.project_title}` : ''}`}</T>
                      {total != null ? <T v="rv" num>{groupDigits(total)}</T> : null}
                    </View>
                    {sub ? <T v="rs" numberOfLines={1}>{sub}</T> : null}
                    <View style={st.bar}><View style={[st.fill, { width: `${Math.round(progress(o) * 100)}%` }]} /></View>
                    <View style={st.l3}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
                        <Badge tone={s.tone} label={s.label} />
                        {needsMaster(o) ? <View style={st.attn} accessibilityLabel={t('ol_needs_you')} /> : null}
                      </View>
                      {unread ? (
                        <Press onPress={() => router.push(`/order/chat/${o.id}`)} accessibilityRole="button" accessibilityLabel={t('ol_unread', { n: unread })} style={st.msg}>
                          <Ionicons name="chatbubble" size={14} color={palette.white} />
                          <T style={st.msgT} num>{unread}</T>
                        </Press>
                      ) : o.status === 'ready' ? (
                        <Press onPress={() => router.push(`/project/${o.project_id}/order`)} accessibilityRole="button" style={st.repeat}>
                          <Ionicons name="refresh" size={16} color={palette.ink} />
                          <T style={st.repeatT}>{t('ol_repeat')}</T>
                        </Press>
                      ) : null}
                    </View>
                  </Press>
                );
              })}
            </Card>
          ) : <T v="sub" style={{ paddingHorizontal: 8 }}>{t('orders_empty_title')}</T>}
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  body: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24, gap: 10, flexGrow: 1 },
  or: { gap: 4, paddingVertical: 16, paddingHorizontal: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  l1: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  bar: { height: 6, borderRadius: 3, backgroundColor: palette.segOnWhite, overflow: 'hidden', marginTop: 4 },
  fill: { height: 6, borderRadius: 3, backgroundColor: palette.green },
  l3: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 24, marginTop: 4 },
  repeat: { height: 36, borderRadius: 18, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14 },
  repeatT: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  msg: { height: 28, minWidth: 44, borderRadius: 14, backgroundColor: palette.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 10 },
  msgT: { fontSize: 13, lineHeight: 17, fontWeight: '700', color: palette.white },
  attn: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.amber },
});
