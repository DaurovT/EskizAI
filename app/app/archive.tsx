/**
 * SCR-39 Архив (Archive.dc.html): чипы «Сданные / В архиве / Отменённые» с количеством,
 * строки «Изделие · Клиент» с пояснением и кнопкой «Вернуть» (для архивных), подпись про хранение.
 */
import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../src/api';
import type { ProjectListItem } from '../src/api/types';
import { useResource } from '../src/hooks/useResource';
import { useT } from '../src/i18n';
import { formatDayMonth } from '../src/lib/format';
import { showError } from '../src/ui/dialogs';
import { ErrorState } from '../src/ui/ErrorState';
import { Banner, Button, Card, Chip, ChipRow, EmptyState, Hairline, Loading, Press, Screen, T } from '../src/ui/kit';
import { bannerTones } from '../src/ui/theme';

type Tab = 'delivered' | 'archived' | 'cancelled';

export default function Archive() {
  const { t, lang } = useT();
  const { data, error, loading, reload } = useResource(async () => {
    const [arch, done, canc, orders] = await Promise.all([
      api.listProjects({ archived: true }),
      api.listProjects({ status: ['delivered'] }),
      api.listProjects({ status: ['cancelled'] }),
      api.listOrders().catch(() => []),
    ]);
    return { archived: arch.items, delivered: done.items, cancelled: canc.items, orders };
  }, []);
  const [tab, setTab] = useState<Tab>('archived');
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // по умолчанию — первая непустая вкладка из «В архиве», «Сданные», «Отменённые»
  useEffect(() => {
    if (!data) return;
    if (!data.archived.length) setTab(data.delivered.length ? 'delivered' : data.cancelled.length ? 'cancelled' : 'archived');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const items = data[tab];
  const orderNo = (p: ProjectListItem) => data.orders.find((o) => o.project_id === p.id)?.number;
  const name = (p: ProjectListItem) => (p.client ? `${p.title} · ${p.client.name}` : p.title);
  const sub = (p: ProjectListItem) => {
    if (p.is_example) return t('arc_example');
    if (tab === 'archived') {
      const n = orderNo(p);
      return [t('arc_since', { date: formatDayMonth(p.archived_at, lang) }), n ? t('arc_had_order', { n }) : null].filter(Boolean).join(' · ');
    }
    return tab === 'delivered' ? t('arc_delivered_on', { date: formatDayMonth(p.updated_at, lang) }) : t('arc_cancelled_on', { date: formatDayMonth(p.updated_at, lang) });
  };
  const restore = async (p: ProjectListItem) => {
    setBusy(p.id);
    try {
      await api.unarchiveProject(p.id);
      setRestored(true);
      reload();
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(null);
    }
  };

  const tabs: { k: Tab; l: string }[] = [
    { k: 'delivered', l: t('arc_delivered') }, { k: 'archived', l: t('arc_archived') }, { k: 'cancelled', l: t('arc_cancelled') },
  ];
  return (
    <Screen contentStyle={{ paddingTop: 10 }}>
      <Stack.Screen options={{ title: t('projects_archive') }} />
      <ChipRow style={{ marginTop: 0 }}>
        {tabs.map((x) => <Chip key={x.k} label={x.l} count={data[x.k].length} selected={tab === x.k} onPress={() => setTab(x.k)} style={{ paddingHorizontal: 12 }} />)}
      </ChipRow>
      {restored ? (
        <Banner tone="ok" icon="checkmark" style={{ alignItems: 'center' }}>
          <T style={{ fontSize: 15, lineHeight: 21, fontWeight: '500' }} color={bannerTones.ok.fg}>{t('arc_restored')}</T>
        </Banner>
      ) : null}
      {items.length ? (
        <Card padded={false}>
          {items.map((p, i) => (
            <View key={p.id}>
              {i ? <Hairline /> : null}
              <Press feedback="row" onPress={() => router.push(`/project/${p.id}`)} style={s.row} accessibilityRole="button" accessibilityLabel={name(p)}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="rt" numberOfLines={1}>{name(p)}</T>
                  <T v="rs" numberOfLines={1}>{sub(p)}</T>
                </View>
                {tab === 'archived' && !p.is_example ? (
                  <Button v="secondary" small title={t('arc_restore')} onPress={() => restore(p)} loading={busy === p.id} style={{ minHeight: 40, height: 40, borderRadius: 20 }} />
                ) : null}
              </Press>
            </View>
          ))}
        </Card>
      ) : <EmptyState icon="archive-outline" title={t('arc_empty')} />}
      <T v="cap" style={{ paddingHorizontal: 8 }}>{t('arc_note')}</T>
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingVertical: 10, paddingLeft: 20, paddingRight: 14 },
});
