/**
 * SCR-31 Оплата заказа EMAN (Payment.dc.html): сумма, состояние оплаты (ждёт / не прошла / оплачено), способ Click или Payme,
 * счёт EMAN. Деньги идут напрямую на мерчант EMAN по ссылке менеджера — платформа видит только статус.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { OrderPayment } from '../../../src/api/types';
import { SUPPORT_TG } from '../../../src/config';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDayTime, groupDigits } from '../../../src/lib/format';
import { canPay } from '../../../src/lib/orders';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Button, ButtonRow, Card, Loading, Screen, Segmented, T, Tile } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

const STATE = {
  waiting: { bg: palette.amberSoft, dot: palette.amber, fg: palette.amberDeep, icon: 'time-outline' as const },
  failed: { bg: palette.redSoft, dot: palette.red, fg: palette.redDeep, icon: 'warning-outline' as const },
  paid: { bg: palette.greenSoft, dot: palette.green, fg: palette.greenDeep, icon: 'checkmark' as const },
};

export default function Payment() {
  const { id, devPay } = useLocalSearchParams<{ id: string; devPay?: OrderPayment['status'] }>();
  const { t, lang } = useT();
  const { data: o, error, loading, reload } = useResource(() => api.getOrder(id), [id]);
  const [method, setMethod] = useState<'click' | 'payme'>('click');
  if (loading && !o) return <Loading />;
  if (!o) return <ErrorState error={error} onRetry={reload} />;

  const pay: OrderPayment = { status: 'waiting', ...o.payment, ...(__DEV__ && devPay ? { status: devPay } : {}) };
  const s = STATE[pay.status];
  const sum = lang === 'uz' ? 'so‘m' : 'сум';
  const amount = o.total ?? 0;
  const manager = () => Linking.openURL(`https://t.me/${SUPPORT_TG}?text=${encodeURIComponent(`Заказ №${o.number}`)}`);
  const open = () => { if (pay.url) Linking.openURL(pay.url); };
  const title = pay.status === 'paid' ? t('pay_ok_t') : pay.status === 'failed' ? t('pay_fail_t') : t('pay_wait_t');
  const text = pay.status === 'paid' ? (pay.paid_at || o.paid_at ? t('pay_ok_d', { when: formatDayTime(pay.paid_at ?? o.paid_at, lang) }) : t('pay_ok_d_nodate'))
    : pay.status === 'failed' ? t('pay_fail_d') : t('pay_wait_d');
  const invoice = o.documents.find((d) => d.kind === 'invoice');

  return (
    <Screen gap={10} contentStyle={{ paddingTop: 0 }} footerStyle={{ paddingTop: 6 }} footer={
      <>
        {pay.status === 'waiting' ? (
          <Button title={t('pay_in', { m: method === 'click' ? 'Click' : 'Payme' })} value={groupDigits(amount)} onPress={open} disabled={!canPay({ ...o, payment: pay })} haptic="success" />
        ) : pay.status === 'failed' ? (
          <Button icon="refresh" title={t('pay_retry')} onPress={open} disabled={!pay.url} />
        ) : (
          <Button title={t('pay_to_status')} onPress={() => (router.canGoBack() ? router.back() : router.replace(`/order/${o.id}`))} />
        )}
        <ButtonRow>
          <Button v="secondary" icon="call-outline" title={t('pay_manager')} onPress={manager} style={{ flex: 1 }} textStyle={{ fontSize: 16 }} />
          <Button v="secondary" icon="document-outline" title={t('pay_files')} onPress={() => router.push(`/project/${o.project_id}/files`)} style={{ paddingHorizontal: 20 }} textStyle={{ fontSize: 16 }} />
        </ButtonRow>
      </>
    }>
      <Stack.Screen options={{ title: '' }} />
      <T v="big" style={st.h1}>{t('pay_h1', { n: o.number })}</T>
      <Card style={{ paddingVertical: 18, paddingHorizontal: 20 }} padded={false}>
        <T v="cap">{t('pay_to')}</T>
        <T num style={st.amount} numberOfLines={1}>{groupDigits(amount)}<T style={st.cur}>{` ${sum}`}</T></T>
        <View style={[st.stc, { backgroundColor: s.bg }]}>
          <View style={[st.si, { backgroundColor: s.dot }]}><Ionicons name={s.icon} size={22} color={palette.white} /></View>
          <View style={{ flex: 1 }}>
            <T style={[st.stT, { color: s.fg }]}>{title}</T>
            <T style={[st.stD, { color: s.fg }]}>{text}</T>
          </View>
        </View>
        {pay.status === 'waiting' ? (
          <>
            <T style={st.mt}>{t('pay_method')}</T>
            <Segmented value={method} onChange={setMethod} options={[{ value: 'click', label: 'Click' }, { value: 'payme', label: 'Payme' }]} style={{ marginTop: 8 }} />
            {!pay.url ? <T v="cap" style={{ marginTop: 8 }}>{t('order_pay_link_wait')}</T> : null}
          </>
        ) : null}
      </Card>
      {pay.status === 'waiting' ? (
        <Card padded={false}>
          <View style={st.row}>
            <Tile icon="document-outline" style={{ width: 40, height: 40 }} />
            <View style={{ flex: 1 }}>
              <T v="rt">{t('pay_invoice')}</T>
              <T v="rs">{t('pay_invoice_n', { n: pay.reference ?? invoice?.title.replace(/\D+/g, '') ?? o.number })}</T>
            </View>
          </View>
          <T v="cap" style={{ paddingHorizontal: 20, paddingBottom: 14, fontSize: 13, lineHeight: 18 }}>{t('pay_cut_note')}</T>
        </Card>
      ) : null}
    </Screen>
  );
}

const st = StyleSheet.create({
  h1: { lineHeight: 34, letterSpacing: -0.6, paddingHorizontal: 8, paddingTop: 2, marginBottom: -2 },
  amount: { fontSize: 40, lineHeight: 46, fontWeight: '700', letterSpacing: -1.2, marginTop: 2 },
  cur: { fontSize: 20, fontWeight: '500', color: palette.muted, letterSpacing: 0 },
  stc: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, marginTop: 14 },
  si: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  stT: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  stD: { fontSize: 14, lineHeight: 19, marginTop: 2 },
  mt: { marginTop: 14, fontSize: 15, lineHeight: 20, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingVertical: 10, paddingHorizontal: 20 },
});
