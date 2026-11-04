/** SCR-33 Карточка клиента (ClientCard.dc.html): звонок, Telegram, новый проект; телефон, адрес, заметки; проекты клиента. */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { callPhone, openTelegramPhone } from '../../src/lib/contact';
import { formatDayMonth, formatPhone, formatRange } from '../../src/lib/format';
import { ErrorState } from '../../src/ui/ErrorState';
import { Carcass } from '../../src/ui/Illus';
import { Avatar, Card, Loading, Press, Screen, StatusBadge, T } from '../../src/ui/kit';
import { palette, tones } from '../../src/ui/theme';

export default function ClientCard() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const { data: c, error, loading, reload } = useResource(() => api.getClient(id), [id]);
  const prices = useResource(() => api.listProjects({ client_id: id, limit: 200 }).then((p) => p.items).catch(() => []), [id]);
  if (loading && !c) return <Loading />;
  if (!c) return <ErrorState error={error} onRetry={reload} />;
  const priceOf = (pid: string) => prices.data?.find((p) => p.id === pid)?.price ?? null;
  const kv: [string, string | null][] = [[t('cc_phone'), c.phone ? formatPhone(c.phone) : null], [t('cc_address'), c.address], [t('cc_notes'), c.notes]];

  return (
    <Screen contentStyle={{ paddingTop: 10 }}>
      <Stack.Screen options={{ title: '' }} />
      <View style={st.hero}>
        <Avatar name={c.name} size={64} style={{ backgroundColor: tones.green.bg }} color={tones.green.fg} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="bigPush" numberOfLines={2}>{c.name}</T>
          <T v="cap">{t('cc_since', { date: formatDayMonth(c.created_at, lang) })}</T>
        </View>
      </View>
      <View style={st.qaRow}>
        <Qa icon="call-outline" label={t('cc_call')} disabled={!c.phone} onPress={() => c.phone && callPhone(c.phone)} />
        <Qa icon="paper-plane-outline" label={t('cc_tg')} disabled={!c.phone} onPress={() => c.phone && openTelegramPhone(c.phone)} />
        <Qa icon="add" label={t('cc_new_project')} green onPress={() => router.push({ pathname: '/project/new', params: { client: c.id } })} />
      </View>
      <Card padded={false}>
        {kv.map(([k, v], i) => (
          <View key={k} style={[st.kv, i > 0 && st.sep]}>
            <T v="rs" style={{ width: 84 }}>{k}</T>
            <T num={i === 0} style={[st.vv, !v && { color: palette.faint }]}>{v ?? '—'}</T>
          </View>
        ))}
      </Card>
      <T style={st.h3}>{t('cc_projects')} <T style={[st.h3, st.count]}>{c.projects.length}</T></T>
      {c.projects.length ? (
        <Card padded={false}>
          {c.projects.map((p, i) => {
            const pr = priceOf(p.id);
            return (
              <Press key={p.id} feedback="row" onPress={() => router.push(`/project/${p.id}`)} accessibilityRole="button" style={[st.row, i > 0 && st.sep]}>
                <View style={st.thumb}><Carcass w={24} h={28} r={8} b={1} /></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="rt" numberOfLines={1}>{p.title}</T>
                  {pr ? <T v="rs" num>{formatRange(pr, lang)}</T> : null}
                </View>
                <StatusBadge status={p.status} style={{ alignSelf: 'center' }} />
                <Ionicons name="chevron-forward" size={18} color={palette.chev} />
              </Press>
            );
          })}
        </Card>
      ) : <T v="sub" style={{ paddingHorizontal: 8 }}>{t('client_no_projects')}</T>}
    </Screen>
  );
}

function Qa({ icon, label, onPress, green, disabled }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; green?: boolean; disabled?: boolean }) {
  return (
    <Press onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} style={[st.qa, disabled && { opacity: 0.45 }]}>
      <View style={[st.qaI, green && { backgroundColor: palette.green }]}><Ionicons name={icon} size={20} color={green ? palette.white : palette.ink} /></View>
      <T style={st.qaT}>{label}</T>
    </Press>
  );
}

const st = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4, paddingHorizontal: 8, paddingBottom: 6 },
  qaRow: { flexDirection: 'row', gap: 8 },
  qa: { flex: 1, height: 76, borderRadius: 22, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center', gap: 6 },
  qaI: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  qaT: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingVertical: 10, paddingHorizontal: 20 },
  vv: { flex: 1, textAlign: 'right', fontSize: 16, lineHeight: 21, fontWeight: '500' },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  h3: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3, paddingTop: 6, paddingHorizontal: 8 },
  count: { color: palette.count, fontWeight: '500', paddingTop: 0, paddingHorizontal: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 10, paddingHorizontal: 20 },
  thumb: { width: 44, height: 44, borderRadius: 14, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
});
