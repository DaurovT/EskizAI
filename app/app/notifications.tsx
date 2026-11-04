/**
 * Уведомления мастера (Notifications.dc.html): события по дням («Сегодня», «Вчера», дата), иконка по виду события,
 * время и зелёная точка у непрочитанных. Тап — открыть проект / заказ и отметить прочитанным.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router } from 'expo-router';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { api } from '../src/api';
import type { NotificationOut } from '../src/api/types';
import { useResource } from '../src/hooks/useResource';
import { useT } from '../src/i18n';
import { formatDayMonth } from '../src/lib/format';
import { routeForPush } from '../src/lib/pushRoute';
import { ErrorState } from '../src/ui/ErrorState';
import { Card, EmptyState, Hairline, IconButton, Loading, Press, Screen, T, type IconName } from '../src/ui/kit';
import { palette, tones, type Tone } from '../src/ui/theme';

/** Вид события → иконка и цвет кружка. */
function look(n: NotificationOut): [IconName, Tone] {
  switch (n.kind) {
    case 'client_agreed': return ['checkmark', 'green'];
    case 'share_opened': case 'ar_started': return ['eye-outline', 'blue'];
    case 'order_status': {
      // статус заказа — в data.status (n.status на сервере — статус отправки push)
      const st = (n.data?.status as string | undefined) ?? n.status;
      return st === 'ready' || st === 'issued' ? ['cube-outline', 'green'] : st === 'cutting' ? ['cut-outline', 'amber'] : ['cube-outline', 'blue'];
    }
    case 'price_request_priced': case 'nonstandard_estimated': case 'nonstandard_done': return ['information-circle-outline', 'blue'];
    case 'prices_stale': case 'limit_one_left': return ['alert-circle-outline', 'amber'];
    case 'model_ready': return ['sparkles-outline', 'green'];
    default: return ['notifications-outline', 'gray'];
  }
}
const dayKey = (iso: string) => new Date(iso).toDateString();

export default function Notifications() {
  const { t, lang } = useT();
  const { data, setData, error, loading, refreshing, reload, refresh } = useResource(() => api.listNotifications(), []);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  const groups: { title: string; items: NotificationOut[] }[] = [];
  for (const n of data) {
    const k = dayKey(n.created_at);
    const title = k === today.toDateString() ? t('nt_today') : k === yest.toDateString() ? t('nt_yesterday') : formatDayMonth(n.created_at, lang);
    const g = groups[groups.length - 1];
    if (g && g.title === title) g.items.push(n); else groups.push({ title, items: [n] });
  }
  const open = (n: NotificationOut) => {
    if (!n.read) {
      api.markNotificationRead(n.id).catch(() => undefined);
      setData(data.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    }
    const to = routeForPush({ ...(n.data ?? {}), kind: n.kind, project_id: n.project_id ?? undefined });
    if (to) router.push(to as never);
  };

  return (
    <Screen contentStyle={{ paddingTop: 8, gap: 8 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{
        title: t('nt_title'),
        headerRight: () => <IconButton icon="settings-outline" label={t('nts_open')} onPress={() => router.push('/settings/notifications')} />,
      }} />
      {!data.length ? <EmptyState icon="notifications-outline" title={t('nt_empty')} text={t('nt_empty_text')} /> : null}
      {groups.map((g, gi) => (
        <View key={g.title + gi} style={{ gap: 8 }}>
          <T style={[s.h3, gi > 0 && { paddingTop: 10 }]}>{g.title}</T>
          <Card padded={false}>
            {g.items.map((n, i) => {
              const [icon, tone] = look(n);
              return (
                <View key={n.id}>
                  {i ? <Hairline /> : null}
                  <Press feedback="row" onPress={() => open(n)} style={s.row} accessibilityRole="button" accessibilityLabel={`${n.title}. ${n.body ?? ''}${n.read ? '' : `. ${t('nt_new')}`}`}>
                    <View style={[s.ni, { backgroundColor: tones[tone].bg }]}><Ionicons name={icon} size={20} color={tones[tone].fg} /></View>
                    <View style={{ flex: 1 }}>
                      <T v="rt">{n.title}</T>
                      {n.body ? <T v="rs" style={{ marginTop: 2 }}>{n.body}</T> : null}
                    </View>
                    <View style={s.tm}>
                      <T num style={s.tmText}>{new Date(n.created_at).toTimeString().slice(0, 5)}</T>
                      {!n.read ? <View style={s.dot} /> : null}
                    </View>
                  </Press>
                </View>
              );
            })}
          </Card>
        </View>
      ))}
    </Screen>
  );
}

const s = StyleSheet.create({
  h3: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3, paddingTop: 6, paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 14, paddingLeft: 16, paddingRight: 20 },
  ni: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  tm: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 21 },
  tmText: { fontSize: 13, lineHeight: 21, fontWeight: '500', color: palette.faint },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.green },
});
