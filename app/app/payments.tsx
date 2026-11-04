/**
 * PayHistory.dc.html («История», SCR-42): платежи нам — пакеты, Pro, файлы; возврат — красная метка и зачёркнутая сумма,
 * чек — ссылкой. Оплаты материалов здесь не показываем — их получает EMAN.
 */
import { Stack } from 'expo-router';
import { Linking, RefreshControl, StyleSheet, View } from 'react-native';
import { api } from '../src/api';
import type { PaymentOut } from '../src/api/types';
import { useResource } from '../src/hooks/useResource';
import { useT } from '../src/i18n';
import { formatDayMonth, groupDigits } from '../src/lib/format';
import { ErrorState } from '../src/ui/ErrorState';
import { Badge, Card, EmptyState, Hairline, Loading, Screen, T, Tile, type IconName } from '../src/ui/kit';
import { palette } from '../src/ui/theme';

const ICON: Record<string, IconName> = { pack: 'folder-outline', files: 'document-outline', pro: 'star-outline' };

export default function Payments() {
  const { t, lang } = useT();
  const { data, error, loading, refreshing, reload, refresh } = useResource(() => api.listPayments(), []);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const row = (p: PaymentOut) => {
    const refunded = p.status === 'refunded';
    const meta = [formatDayMonth(p.paid_at, lang), p.method_label].filter(Boolean).join(' · ');
    return (
      <View style={s.row}>
        <Tile icon={ICON[p.kind] ?? 'card-outline'} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="rt" numberOfLines={2}>{p.title}</T>
          {refunded ? (
            <Badge tone="red" label={t('ph_refund', { date: formatDayMonth(p.refunded_at, lang) })} style={{ marginTop: 4, alignSelf: 'flex-start' }} />
          ) : (
            <T v="rs">
              {meta}
              {p.receipt_url ? <T v="rs">{' · '}<T v="rs" color={palette.greenPress} style={{ fontWeight: '500' }} onPress={() => Linking.openURL(p.receipt_url!)}>{t('ph_receipt')}</T></T> : null}
            </T>
          )}
        </View>
        {p.amount != null ? (
          <T v="rv" num color={refunded ? palette.muted : undefined} style={refunded ? s.struck : undefined}>{groupDigits(p.amount)}</T>
        ) : null}
      </View>
    );
  };

  return (
    <Screen contentStyle={{ paddingTop: 6, gap: 10 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Stack.Screen options={{ title: t('ph_title') }} />
      {data.length ? (
        <Card padded={false}>
          {data.map((p, i) => <View key={p.id}>{i ? <Hairline /> : null}{row(p)}</View>)}
        </Card>
      ) : <EmptyState icon="card-outline" title={t('ph_empty')} />}
      <T v="cap" style={{ paddingHorizontal: 4 }}>{t('ph_note')}</T>
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingVertical: 12, paddingHorizontal: 20 },
  struck: { textDecorationLine: 'line-through' },
});
