/**
 * SCR-15 Заказы (Orders.dc.html): заказы в EMAN и у партнёров — номер и проект, сумма, клиент и срок, полоса прогресса,
 * статус; фильтр «Активные / Готовы / Все»; у готовых — «Повторить» (новый заказ по проекту).
 */
import { Ionicons } from '@expo/vector-icons';
import { Tabs, router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import { ORDER_FLOW, type OrderOut } from '../../src/api/types';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { formatDayMonth, groupDigits } from '../../src/lib/format';
import { useSession } from '../../src/state/session';
import { ErrorState } from '../../src/ui/ErrorState';
import { Avatar, Badge, Button, Card, Chip, ChipRow, EmptyState, IconButton, Loading, OfflineBanner, Press, T } from '../../src/ui/kit';
import { palette, type Tone } from '../../src/ui/theme';

type Filter = 'active' | 'ready' | 'all';
const isReady = (o: OrderOut) => o.status === 'ready';
const isActive = (o: OrderOut) => !['ready', 'issued', 'cancelled'].includes(o.status);

export default function Orders() {
  const { t, td, lang } = useT();
  const { workshop, user } = useSession();
  const [filter, setFilter] = useState<Filter>('active');
  const { data, error, loading, refreshing, reload, refresh } = useResource(() => api.listOrders(), []);
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

  const status = (o: OrderOut): { label: string; tone: Tone } => {
    if (o.status === 'created' && o.payment?.status !== 'paid') return { label: t('ol_unpaid'), tone: 'red' };
    if (o.status === 'ready') return { label: td('os_ready', 'Готов'), tone: 'green' };
    if (o.status === 'cutting') return { label: td('os_cutting', 'В распиле'), tone: 'amber' };
    if (o.status === 'cancelled') return { label: td('os_cancelled', 'Отменён'), tone: 'gray' };
    if (o.status === 'issued') return { label: td('os_issued', 'Выдан'), tone: 'gray' };
    return { label: td(`os_${o.status}`, o.status), tone: 'blue' };
  };
  const note = (o: OrderOut) => {
    if (o.status === 'created' && o.payment?.status !== 'paid') return t('ol_wait_pay');
    if (o.status === 'ready') return t('ol_pickup');
    if (o.status === 'issued') return t('ol_issued');
    if (o.status === 'cancelled') return t('ol_cancelled');
    return o.ready_date ? t('ol_ready_by', { date: formatDayMonth(o.ready_date, lang) }) : null;
  };
  const progress = (o: OrderOut) => (o.status === 'ready' || o.status === 'issued' ? 1 : o.status === 'cancelled' ? 0 : (ORDER_FLOW.indexOf(o.status) + 1) / ORDER_FLOW.length);

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
                return (
                  <Press key={o.id} feedback="row" onPress={() => router.push(`/order/${o.id}`)} accessibilityRole="button" style={[st.or, i > 0 && st.sep]}>
                    <View style={st.l1}>
                      <T v="rt" style={{ fontWeight: '600', flex: 1 }} numberOfLines={1}>{`№ ${o.number}${o.project_title ? ` · ${o.project_title}` : ''}`}</T>
                      {o.total != null ? <T v="rv" num>{groupDigits(o.total)}</T> : null}
                    </View>
                    {sub ? <T v="rs" numberOfLines={1}>{sub}</T> : null}
                    <View style={st.bar}><View style={[st.fill, { width: `${Math.round(progress(o) * 100)}%` }]} /></View>
                    <View style={st.l3}>
                      <Badge tone={s.tone} label={s.label} />
                      {o.status === 'ready' ? (
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
});
