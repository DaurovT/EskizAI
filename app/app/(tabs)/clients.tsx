/** SCR-17 Клиенты (Clients.dc.html): поиск, список с районом, числом проектов и суммой; звонок и Telegram в один тап. */
import { Ionicons } from '@expo/vector-icons';
import { Tabs, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { callPhone, openTelegramPhone } from '../../src/lib/contact';
import { formatRange, plural } from '../../src/lib/format';
import { ErrorState } from '../../src/ui/ErrorState';
import { Avatar, Button, Card, EmptyState, Loading, OfflineBanner, Press, Search, T } from '../../src/ui/kit';
import { palette } from '../../src/ui/theme';

export default function Clients() {
  const { t, lang } = useT();
  const [q, setQ] = useState('');
  const { data, error, loading, refreshing, reload, refresh } = useResource(() => api.listClients(q.trim() || undefined), [q]);
  const projects = useResource(() => api.listProjects({ limit: 200 }).then((p) => p.items).catch(() => []), []);
  // по клиенту: число проектов и сумма цен (нижняя граница диапазона)
  const stats = useMemo(() => {
    const m = new Map<string, { n: number; sum: number }>();
    for (const p of projects.data ?? []) {
      if (!p.client?.id || p.status === 'cancelled') continue;
      const s = m.get(p.client.id) ?? { n: 0, sum: 0 };
      s.n += 1; s.sum += p.price?.from ?? 0;
      m.set(p.client.id, s);
    }
    return m;
  }, [projects.data]);

  const add = () => router.push('/client/new');
  const header = (
    <Tabs.Screen options={{
      headerRight: () => (
        <Press onPress={add} accessibilityRole="button" accessibilityLabel={t('clients_add')} style={st.addb}>
          <Ionicons name="add" size={20} color={palette.ink} />
          <T style={st.addT}>{t('cls_add')}</T>
        </Press>
      ),
    }} />
  );
  const items = data?.items ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      {header}
      <OfflineBanner />
      <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        <Search value={q} onChangeText={setQ} placeholder={t('cls_search')} />
        {loading && !data ? <Loading /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : !items.length ? (
          <EmptyState icon="people-outline" title={t('clients_empty_title')} actions={<Button title={t('clients_add')} icon="person-add-outline" onPress={add} />} />
        ) : (
          <Card padded={false}>
            {items.map((c, i) => {
              const s = stats.get(c.id);
              const area = c.address?.split(',')[0]?.trim();
              const sub = [area, s ? `${s.n} ${plural(s.n, t('cls_projects_n'))}` : null].filter(Boolean).join(' · ');
              const sum = s?.sum ? formatRange({ from: s.sum, to: s.sum }, lang) : null;
              const cur = sum?.match(/\s(сум|so‘m)$/)?.[1];
              const first = c.name.split(' ')[0];
              return (
                <View key={c.id} style={[st.cl, i > 0 && st.sep]}>
                  <Press feedback="none" onPress={() => router.push(`/client/${c.id}`)} accessibilityRole="button" accessibilityLabel={c.name} style={st.main}>
                    <Avatar name={c.name} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T v="rt" numberOfLines={1}>{c.name}</T>
                      {sub ? <T v="rs" numberOfLines={1}>{sub}</T> : null}
                      {sum ? <T num style={st.sum}>{sum.replace(/\s(сум|so‘m)$/, '')}<T style={st.cur}>{cur ? ` ${cur}` : ''}</T></T> : null}
                    </View>
                  </Press>
                  {c.phone ? (
                    <>
                      <Press onPress={() => callPhone(c.phone!)} accessibilityRole="button" accessibilityLabel={t('cls_call', { name: first })} style={st.act}>
                        <Ionicons name="call-outline" size={19} color={palette.ink} />
                      </Press>
                      <Press onPress={() => openTelegramPhone(c.phone!)} accessibilityRole="button" accessibilityLabel={t('cls_tg', { name: first })} style={st.act}>
                        <Ionicons name="paper-plane-outline" size={19} color={palette.ink} />
                      </Press>
                    </>
                  ) : null}
                </View>
              );
            })}
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  body: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 24, gap: 10, flexGrow: 1 },
  addb: { height: 44, borderRadius: 22, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 16 },
  addT: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  cl: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 12, paddingLeft: 20, paddingRight: 14 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14, minWidth: 0 },
  sum: { fontSize: 15, lineHeight: 20, fontWeight: '600', marginTop: 2 },
  cur: { fontWeight: '400', color: palette.muted },
  act: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
});
