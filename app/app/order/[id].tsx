/**
 * SCR-16 Карточка заказа (OrderCard.dc.html): шаги создан → оплачен → принят → в распиле → готов → выдан, сумма,
 * счёт EMAN, файлы распила, состав заказа; оплата — SCR-31 (/order/pay/[id]), отмена — SCR-40 (/order/cancel/[id]).
 */
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import { ORDER_FLOW } from '../../src/api/types';
import { SUPPORT_TG } from '../../src/config';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { mimeOf, utiOf } from '../../src/lib/files';
import { formatDayMonth, formatDayTime, groupDigits, plural } from '../../src/lib/format';
import { showError } from '../../src/ui/dialogs';
import { ErrorState } from '../../src/ui/ErrorState';
import { Badge, Button, ButtonRow, Card, Loading, Press, Screen, T, Tile } from '../../src/ui/kit';
import { palette } from '../../src/ui/theme';

export default function OrderCard() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, td, lang } = useT();
  const { data: o, error, loading, reload } = useResource(() => api.getOrder(id), [id]);
  const project = useResource(() => (o ? api.getProject(o.project_id).catch(() => null) : Promise.resolve(null)), [o?.project_id]);
  const files = useResource(() => (o ? api.listFiles(o.project_id).catch(() => []) : Promise.resolve([])), [o?.project_id]);
  const [items, setItems] = useState(false);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  if (loading && !o) return <Loading />;
  if (!o) return <ErrorState error={error} onRetry={reload} />;

  const steps = o.steps ?? ORDER_FLOW.map((s, i) => ({ status: s, label: s, done: ORDER_FLOW.indexOf(o.status) >= i, current: o.status === s, at: null }));
  const cancelled = o.status === 'cancelled';
  const pay = o.payment;
  const sum = lang === 'uz' ? 'so‘m' : 'сум';
  const client = project.data?.client?.name?.split(' ')[0];
  const manager = () => Linking.openURL(`https://t.me/${SUPPORT_TG}?text=${encodeURIComponent(`Заказ №${o.number}`)}`);
  const filesOpen = (files.data ?? []).some((f) => f.available && !f.free);
  const invoice = o.documents.find((d) => d.kind === 'invoice');
  // «Счёт EMAN · PDF»: скачать и отдать файлом через системное меню, как файлы проекта
  const openInvoice = async () => {
    if (invoiceBusy) return;
    setInvoiceBusy(true);
    try {
      if (!(await Sharing.isAvailableAsync())) return Alert.alert(t('fv_share_unavailable'));
      const f = await api.downloadOrderInvoice(o.id);
      const mime = mimeOf(f.mimeType, f.name);
      await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: f.name, UTI: utiOf(mime) });
    } catch (e) { showError(e, lang); } finally { setInvoiceBusy(false); }
  };
  const sub = (s: typeof steps[number]) => {
    if (s.current && !cancelled) return null;
    if (s.status === 'paid' && s.done) return [formatDayTime(s.at ?? pay?.paid_at ?? o.paid_at, lang).replace(/^—$/, ''), t('ocd_direct')].filter(Boolean).join(' · ');
    if (s.at) return formatDayTime(s.at, lang);
    if (s.status === 'ready' && !s.done && o.ready_date) return t('ocd_expected', { date: formatDayMonth(o.ready_date, lang) });
    return null;
  };

  return (
    <Screen gap={10} contentStyle={{ paddingTop: 0 }} footerStyle={{ paddingTop: 6, gap: 4 }} footer={
      <>
        <ButtonRow>
          <Button v="secondary" icon="call-outline" title={t('pay_manager')} onPress={manager} style={st.soft} textStyle={{ fontSize: 16 }} numberOfLines={1} />
          <Button v="secondary" icon="cube-outline" title={t('ocd_to_project')} onPress={() => router.push(`/project/${o.project_id}`)} style={st.soft} textStyle={{ fontSize: 16 }} numberOfLines={1} />
        </ButtonRow>
        {!cancelled ? (
          <Press feedback="opacity" onPress={() => router.push(`/order/cancel/${o.id}`)} accessibilityRole="button" style={st.cancel}>
            {o.cancellable ? <T v="cap" color={palette.redText}>{t('ocd_cancel_link')}</T> : (
              <>
                <Ionicons name="lock-closed-outline" size={14} color={palette.muted} />
                <T v="cap">{t('ocd_cancel_locked')}</T>
              </>
            )}
          </Press>
        ) : null}
      </>
    }>
      <Stack.Screen options={{ title: '' }} />
      <View style={{ paddingHorizontal: 8 }}>
        <T v="bigPush" style={{ letterSpacing: -0.56 }}>{t('ocd_title', { n: o.number })}</T>
        <View style={st.subRow}>
          <T v="sub" style={{ flex: 1 }} numberOfLines={1}>{[o.project_title, client].filter(Boolean).join(' · ')}</T>
          {o.total != null ? <T num style={st.total}>{groupDigits(o.total)}<T style={st.cur}>{` ${sum}`}</T></T> : null}
        </View>
      </View>

      <Card padded={false} style={st.tl}>
        {cancelled ? (
          <View style={st.s}>
            <View style={st.dt}><View style={[st.c, { backgroundColor: palette.red }]}><Ionicons name="close" size={14} color={palette.white} /></View></View>
            <View><T style={st.t}>{td('os_cancelled', 'Отменён')}</T></View>
          </View>
        ) : steps.map((s, i) => {
          const last = i === steps.length - 1;
          const fut = !s.done && !s.current;
          const sb = sub(s);
          return (
            <View key={s.status} style={[st.s, last && { minHeight: 32 }]}>
              <View style={st.dt}>
                <View style={[st.c, s.current ? st.cCur : s.done ? st.cDone : st.cFut]}>
                  {s.done && !s.current ? <Ionicons name="checkmark" size={14} color={palette.white} /> : null}
                </View>
                {!last ? <View style={[st.ln, s.done && !s.current && { backgroundColor: palette.green }]} /> : null}
              </View>
              <View style={{ flex: 1, paddingBottom: last ? 0 : 8 }}>
                <T style={[st.t, fut && st.tFut]}>{td(`os_${s.status}`, s.label)}</T>
                {s.current ? <Badge tone="amber" label={t('ocd_now')} style={{ marginTop: 4 }} /> : sb ? <T v="cap">{sb}</T> : null}
              </View>
            </View>
          );
        })}
      </Card>

      <Card padded={false}>
        {pay && pay.status !== 'paid' && !cancelled ? (
          <Row icon="card-outline" title={t('ocd_pay_row')} onPress={() => router.push(`/order/pay/${o.id}`)}
            right={<Badge tone={pay.status === 'failed' ? 'red' : 'amber'} label={pay.status === 'failed' ? t('pay_fail_t') : t('pay_wait_t')} style={{ alignSelf: 'center' }} />} />
        ) : null}
        {invoice ? <Row icon="document-outline" title={t('ocd_invoice')} right={invoiceBusy ? <ActivityIndicator color={palette.chev} /> : <T v="rs">PDF</T>} onPress={openInvoice} sep={!!pay && pay.status !== 'paid' && !cancelled} /> : null}
        <Row icon="cut-outline" title={t('ocd_files')} onPress={() => router.push(`/project/${o.project_id}/files`)} sep={!!invoice || (!!pay && pay.status !== 'paid' && !cancelled)}
          right={filesOpen ? <Badge tone="green" label={t('ocd_files_open')} style={{ alignSelf: 'center' }} /> : undefined} />
        <Row icon="list-outline" title={t('ocd_items')} sep onPress={() => setItems(!items)} chevron={items ? 'chevron-up' : 'chevron-down'}
          right={<T v="rs">{`${o.items.length} ${plural(o.items.length, t('est_u_pos'))}`}</T>} />
        {items ? o.items.map((it, i) => (
          <View key={i} style={st.item}>
            <T style={[st.itemT, it.excluded && { color: palette.muted }]} numberOfLines={2}>{`${it.name}${it.qty != null ? ` · ${String(it.qty).replace('.', ',')} ${it.unit ?? ''}` : ''}`}</T>
            <T num style={st.itemV}>{it.excluded || it.amount == null ? '—' : groupDigits(it.amount)}</T>
          </View>
        )) : null}
        {items ? <View style={{ height: 10 }} /> : null}
      </Card>
    </Screen>
  );
}

function Row({ icon, title, right, onPress, sep, chevron = 'chevron-forward' }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; title: string; right?: React.ReactNode; onPress?: () => void; sep?: boolean;
  chevron?: React.ComponentProps<typeof Ionicons>['name'];
}) {
  return (
    <Press feedback="row" onPress={onPress} accessibilityRole="button" style={[st.row, sep && st.sep]}>
      <Tile icon={icon} style={{ width: 40, height: 40 }} />
      <T v="rt" style={{ flex: 1 }} numberOfLines={1}>{title}</T>
      {right}
      <Ionicons name={chevron} size={18} color={palette.chev} />
    </Press>
  );
}

const st = StyleSheet.create({
  subRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4, gap: 8 },
  total: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.33 },
  cur: { fontSize: 15, fontWeight: '500', color: palette.muted, letterSpacing: 0 },
  tl: { paddingTop: 14, paddingHorizontal: 20, paddingBottom: 10 },
  s: { flexDirection: 'row', gap: 14, minHeight: 56 },
  dt: { width: 24, alignItems: 'center' },
  c: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cDone: { backgroundColor: palette.green },
  cCur: { backgroundColor: palette.white, borderWidth: 7, borderColor: palette.amber },
  cFut: { borderWidth: 2, borderColor: '#DEDCD8' },
  ln: { flex: 1, width: 2, backgroundColor: palette.off, marginVertical: 2 },
  t: { fontSize: 16, lineHeight: 22, fontWeight: '600', marginTop: 1 },
  tFut: { color: palette.faint, fontWeight: '500' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 10, paddingHorizontal: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  item: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4, paddingLeft: 74, paddingRight: 20 },
  itemT: { flex: 1, fontSize: 14, lineHeight: 19 },
  itemV: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  soft: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', paddingHorizontal: 14 },
  cancel: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
});
