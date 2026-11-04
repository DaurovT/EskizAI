/**
 * SCR-40 Отмена заказа (OrderCancel.dc.html): до распила — причина и «Отменить заказ»; после отмены — ждём возврат
 * (если платили); в распиле — отменить нельзя, только через менеджера EMAN.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { SUPPORT_TG } from '../../../src/config';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import type { DictKey } from '../../../src/i18n/ru';
import { formatMoney, groupDigits } from '../../../src/lib/format';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Badge, Banner, Button, Card, Loading, Press, Screen, T } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

const REASONS: DictKey[] = ['ocx_r1', 'ocx_r2', 'ocx_r3', 'ocx_r4'];

export default function OrderCancel() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const { data: o, setData, error, loading, reload } = useResource(() => api.getOrder(id), [id]);
  const [reason, setReason] = useState(0);
  const [busy, setBusy] = useState(false);
  if (loading && !o) return <Loading />;
  if (!o) return <ErrorState error={error} onRetry={reload} />;

  const paid = o.payment?.status === 'paid';
  const amount = o.total ?? 0;
  const manager = () => Linking.openURL(`https://t.me/${SUPPORT_TG}?text=${encodeURIComponent(`Заказ №${o.number}`)}`);
  const back = () => (router.canGoBack() ? router.back() : router.replace(`/order/${o.id}`));
  const doCancel = async () => {
    setBusy(true);
    try { setData(await api.cancelOrder(o.id, t(REASONS[reason]))); } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };
  const head = <T v="bigPush" style={st.h1}>{t('ocx_title', { n: o.number })}</T>;
  const headInfo = <T v="bigPush" style={[st.h1, { paddingHorizontal: 0, marginBottom: 10 }]}>{t('ocx_title', { n: o.number })}</T>;

  // отменён: ждём возврат (если платили)
  if (o.status === 'cancelled') {
    return (
      <Screen gap={14} contentStyle={st.info} footer={<Button title={t('ocd_to_project')} onPress={() => router.replace(`/project/${o.project_id}`)} />}>
        <Stack.Screen options={{ title: '' }} />
        {headInfo}
        <View style={[st.ic, { backgroundColor: palette.amberSoft }]}><Ionicons name="time-outline" size={28} color={palette.amber} /></View>
        <T v="title" style={st.t24}>{paid ? t('ocx_done_paid') : t('ocx_done')}</T>
        <T v="sub" color={palette.muted2}>{paid ? t('ocx_done_text_paid') : t('ocx_done_text')}</T>
        {paid ? (
          <Card padded={false}>
            <View style={st.refund}>
              <T v="rt" style={{ flex: 1 }}>{t('ocx_refund')}</T>
              <Badge tone="amber" label={t('ocx_refund_wait')} style={{ alignSelf: 'center' }} />
              <T v="rv" num style={{ fontSize: 18, fontWeight: '700' }}>{groupDigits(amount)}</T>
            </View>
          </Card>
        ) : null}
        <T v="cap">{t('ocx_back_contract')}</T>
      </Screen>
    );
  }

  // в распиле и дальше: отменить нельзя
  if (!o.cancellable) {
    return (
      <Screen gap={14} contentStyle={st.info} footerStyle={{ gap: 4 }} footer={
        <>
          <Button icon="chatbubble-outline" title={t('ocx_write')} onPress={manager} />
          <Button v="ghost" title={t('ocx_to_order')} onPress={back} />
        </>
      }>
        <Stack.Screen options={{ title: '' }} />
        {headInfo}
        <View style={[st.ic, { backgroundColor: palette.amberSoft }]}><Ionicons name="lock-closed-outline" size={28} color={palette.amber} /></View>
        <T v="title" style={st.t24}>{t('ocx_locked')}</T>
        <T v="sub" color={palette.muted2}>{t('ocx_locked_text')}</T>
      </Screen>
    );
  }

  // до распила: причина и отмена
  return (
    <Screen gap={12} contentStyle={{ paddingTop: 0 }} footerStyle={{ gap: 4 }} footer={
      <>
        <Button v="danger" title={t('ocx_do')} onPress={doCancel} loading={busy} haptic="light" />
        <Button v="ghost" title={t('ocx_keep')} onPress={back} />
      </>
    }>
      <Stack.Screen options={{ title: '' }} />
      {head}
      <Banner tone="ok" icon="checkmark" style={{ alignItems: 'center' }} textStyle={{ fontSize: 15, lineHeight: 20 }}
        text={paid ? t('ocx_can_paid', { sum: formatMoney(amount, lang) }) : t('ocx_can_unpaid')} />
      <T v="h3" style={{ paddingTop: 4, paddingHorizontal: 8 }}>{t('ocx_reason')}</T>
      <Card padded={false}>
        {REASONS.map((r, i) => (
          <Press key={r} feedback="row" onPress={() => setReason(i)} accessibilityRole="radio" accessibilityState={{ selected: reason === i }}
            style={[st.ro, i > 0 && st.sep]}>
            <View style={[st.rd, reason === i ? st.rdOn : st.rdOff]} />
            <T v="rt">{t(r)}</T>
          </Press>
        ))}
      </Card>
    </Screen>
  );
}

const st = StyleSheet.create({
  h1: { paddingHorizontal: 8, paddingBottom: 0, letterSpacing: -0.56 },
  info: { paddingTop: 0, paddingHorizontal: 20 },
  ic: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  t24: { fontSize: 24, lineHeight: 30 },
  refund: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingVertical: 10, paddingHorizontal: 20 },
  ro: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 58, paddingHorizontal: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  rd: { width: 22, height: 22, borderRadius: 11 },
  rdOn: { borderWidth: 7, borderColor: palette.ink },
  rdOff: { borderWidth: 2, borderColor: palette.chev },
});
