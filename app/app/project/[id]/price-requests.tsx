/**
 * SCR-30 Цена под запрос (QuoteAccept.dc.html): позиция, цена и срок от EMAN или партнёра, сравнение со сметой;
 * «Принять и добавить в заказ», «Найти замену», «Отказаться». Несколько позиций — переключатель сверху.
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { PriceRequestOut } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDate, groupDigits, plural } from '../../../src/lib/format';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Badge, Banner, Button, ButtonRow, Card, Chip, ChipRow, EmptyState, Loading, Screen, Segmented, T } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

const isEman = (r: PriceRequestOut) => !r.supplier_name || /eman/i.test(r.supplier_name);

export default function PriceRequests() {
  const { id, request } = useLocalSearchParams<{ id: string; request?: string }>();
  const { t, lang } = useT();
  const { data, setData, error, loading, reload } = useResource(() => api.listPriceRequests(id), [id]);
  const [sel, setSel] = useState<string | null>(request ?? null);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;
  if (!data.length) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        <EmptyState icon="pricetag-outline" title={t('pr_empty')} text={t('pr_note')} />
      </Screen>
    );
  }

  const r = data.find((x) => x.id === sel) ?? data.find((x) => x.status === 'priced') ?? data[0];
  const decide = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'decline');
    try {
      const out = await api.decidePriceRequest(id, r.id, accept);
      setData(data.map((x) => (x.id === r.id ? out : x)));
    } catch (e) { showError(e, lang); } finally { setBusy(null); }
  };

  const label = (x: PriceRequestOut) => (x.supplier_name ? `${x.supplier_name} · ${x.name}` : x.name);
  const total = r.total ?? (r.price != null ? Math.round(r.price * r.qty) : null);
  const was = Math.round(r.estimate_price * r.qty);
  const delta = r.delta ?? (total != null ? total - was : null);
  const sum = lang === 'uz' ? 'so‘m' : 'сум';
  const fmtDelta = (d: number) => `${d > 0 ? '+' : '−'}${groupDigits(Math.abs(d))}`;
  const priced = r.status === 'priced';
  const expired = priced && !!r.expired;

  return (
    <Screen gap={10} contentStyle={{ paddingTop: 0 }} footerStyle={{ paddingTop: 6 }} footer={
      <>
        <Button title={t('qa_accept')} haptic="success" onPress={() => decide(true)} loading={busy === 'accept'} disabled={!priced || expired} />
        <ButtonRow>
          <Button v="secondary" title={t('qa_replace')} onPress={() => router.push(`/project/${id}/editor`)} style={{ flex: 1 }} disabled={r.status === 'accepted'} />
          <Button v="secondary" title={t('qa_decline')} onPress={() => decide(false)} loading={busy === 'decline'} style={{ flex: 1 }} disabled={!priced} />
        </ButtonRow>
        <T v="cap" center>{isEman(r) ? t('qa_pay_eman') : t('qa_pay_partner')}</T>
      </>
    }>
      <Stack.Screen options={{ title: '' }} />
      <T v="big" style={st.h1}>{r.price != null ? t('qa_title') : t('qa_title_wait')}</T>
      {data.length > 1 && data.length <= 3 ? (
        <Segmented value={r.id} onChange={setSel} options={data.map((x) => ({ value: x.id, label: x.name }))} />
      ) : data.length > 3 ? (
        <ChipRow>{data.map((x) => <Chip key={x.id} label={label(x)} selected={x.id === r.id} onPress={() => setSel(x.id)} />)}</ChipRow>
      ) : null}

      <Card style={{ paddingTop: 18, paddingHorizontal: 20, paddingBottom: 16 }} padded={false}>
        <T v="cap">{isEman(r) ? t('qa_eman') : `${t('qa_partner')} · ${r.supplier_name}`}</T>
        <T style={st.item}>{`${r.name}, ${String(r.qty).replace('.', ',')} ${r.unit}`}</T>
        <View style={st.priceBox}>
          {total != null ? <T num style={st.price} numberOfLines={1}>{`${groupDigits(total)} ${sum}`}</T> : <T v="sub">{t('pr_pending')}</T>}
          {delta != null && total != null ? (
            <Badge tone={delta > 0 ? 'amber' : 'green'} label={delta === 0 ? t('qa_in_range') : t('qa_delta', { d: fmtDelta(delta) })} />
          ) : null}
        </View>
        <View style={[st.kv, st.sep]}><T style={st.k}>{t('qa_was')}</T><T num style={st.v}>{groupDigits(was)}</T></View>
        {r.lead_days != null ? <View style={[st.kv, st.sep]}><T style={st.k}>{t('qa_lead')}</T><T style={st.v}>{`${r.lead_days} ${plural(r.lead_days, t('qa_days'))}`}</T></View> : null}
        {r.priced_at ? <View style={[st.kv, st.sep]}><T style={st.k}>{t('qa_priced_at')}</T><T style={st.v}>{formatDate(r.priced_at, lang)}</T></View> : null}
        {r.valid_until && r.status !== 'accepted' ? (
          <View style={[st.kv, st.sep]}><T style={st.k}>{t('qa_valid_until')}</T><T style={st.v} color={expired ? palette.redText : undefined}>{formatDate(r.valid_until, lang)}</T></View>
        ) : null}
        {r.note ? <T v="cap" style={{ marginTop: 6 }}>{r.note}</T> : null}
      </Card>
      {r.status === 'accepted' ? <Banner tone="ok" icon="checkmark" text={t('qa_accepted')} textStyle={{ fontSize: 15, lineHeight: 20, fontWeight: '500' }} /> : null}
      {r.status === 'declined' ? <Banner tone="n" icon="close" text={t('qa_declined')} /> : null}
      {expired ? <Banner tone="err" icon="time-outline" text={t('qa_expired')} /> : null}
      {total == null ? <T v="cap" style={{ paddingHorizontal: 8 }}>{t('pr_note')}</T> : null}
    </Screen>
  );
}

const st = StyleSheet.create({
  h1: { lineHeight: 34, letterSpacing: -0.6, paddingHorizontal: 8, paddingTop: 2, marginBottom: -2 },
  item: { fontSize: 19, lineHeight: 25, fontWeight: '700', marginTop: 4, marginBottom: 12 },
  priceBox: { alignItems: 'flex-start', gap: 8, paddingBottom: 14 },
  price: { fontSize: 32, lineHeight: 38, fontWeight: '700', letterSpacing: -0.8 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, paddingVertical: 10 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  k: { fontSize: 16, lineHeight: 21, color: palette.muted },
  v: { fontSize: 16, lineHeight: 21, fontWeight: '500' },
});
