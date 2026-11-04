/**
 * Возвраты и рекламации по заказу (docs/staff_vendor_contract.md §5.2, §5.6): что случилось, позиции, фото, статус
 * и решение поставщика (переделать / вернуть деньги / отказ с объяснением). Не согласен с решением — «Открыть спор»
 * (§4a): статус спора и решение платформы — здесь же. «Сообщить о проблеме» — по оплаченному заказу.
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { OrderReturn } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDayTime, formatMoney } from '../../../src/lib/format';
import { canDisputeReturn, canReport, disputeFor } from '../../../src/lib/orders';
import { useOrderPush } from '../../../src/state/orderEvents';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Badge, Button, Card, EmptyState, Loading, Screen, T } from '../../../src/ui/kit';
import { Attachments, DisputeBlock, Quote, returnBadge } from '../../../src/ui/OrderParts';
import { palette } from '../../../src/ui/theme';

export default function OrderReturns() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, td, lang } = useT();
  const order = useResource(() => api.getOrder(id), [id]);
  const list = useResource(() => api.listOrderReturns(id), [id]);
  const disputes = useResource(() => api.listOrderDisputes(id).catch(() => []), [id]);
  useOrderPush(id, () => { list.reload(); disputes.reload(); });
  if (list.loading && !list.data) return <Loading />;
  if (!list.data) return <ErrorState error={list.error} onRetry={list.reload} />;

  const o = order.data;
  const can = !!o && canReport(o);
  const refresh = () => { list.refresh(); disputes.reload(); order.reload(); };
  const decisionText = (r: OrderReturn) =>
    r.decision === 'refund' && r.refund_amount != null ? t('or_dec_refund_sum', { sum: formatMoney(r.refund_amount, lang) }) : td(`or_dec_${r.decision}_t`, r.decision ?? '');

  return (
    <Screen gap={10} contentStyle={{ paddingTop: 0 }} refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={refresh} />}
      footer={can ? <Button icon="alert-circle-outline" title={t('or_report')} onPress={() => router.push(`/order/return/${id}`)} /> : undefined}>
      <Stack.Screen options={{ title: '' }} />
      <View style={{ paddingHorizontal: 8 }}>
        <T v="bigPush" style={{ letterSpacing: -0.56 }}>{t('or_title')}</T>
        {o ? <T v="sub" style={{ marginTop: 4 }} numberOfLines={1}>{[t('ocd_title', { n: o.number }), o.supplier_name].filter(Boolean).join(' · ')}</T> : null}
      </View>
      {!list.data.length ? (
        <EmptyState compact icon="shield-checkmark-outline" title={t('or_empty')} text={can ? t('or_empty_text') : t('or_empty_unpaid')} />
      ) : null}
      {list.data.map((r) => {
        const b = returnBadge(r);
        const d = disputeFor(disputes.data ?? [], 'return', r.id);
        return (
          <Card key={r.id} style={st.card}>
            <View style={st.head}>
              <View style={{ flex: 1 }}>
                <T v="h3">{td(`or_type_${r.type}`, r.type)}</T>
                <T v="cap">{[r.number ? `№ ${r.number}` : null, formatDayTime(r.created_at, lang)].filter(Boolean).join(' · ')}</T>
              </View>
              <Badge tone={b.tone} label={r.decision === 'refund' && r.refund_amount != null ? t('or_dec_refund') : t(b.key)} />
            </View>
            {r.description ? <T style={st.desc}>{r.description}</T> : null}
            {r.lines.length ? (
              <View style={{ gap: 2 }}>
                {r.lines.map((l, i) => (
                  <T key={`${l.key ?? l.name}-${i}`} v="rs" num>{`• ${l.name}${l.qty != null ? ` · ${String(l.qty).replace('.', ',')} ${l.unit ?? ''}` : ''}`}</T>
                ))}
              </View>
            ) : null}
            {r.amount ? <T v="rs">{t('or_amount', { sum: formatMoney(r.amount, lang) })}</T> : null}
            <Attachments items={r.photos} size={64} />
            {r.decision ? (
              <View style={{ gap: 6 }}>
                <T style={st.decT}>{t('or_decision', { d: decisionText(r) })}</T>
                {r.decision_comment ? <Quote text={r.decision_comment} by={formatDayTime(r.decided_at, lang).replace(/^—$/, '') || null} /> : null}
              </View>
            ) : (
              <T v="cap">{r.status === 'awaiting_owner' ? t('or_wait_owner') : t('or_wait')}</T>
            )}
            {d ? <DisputeBlock d={d} /> : canDisputeReturn(r, disputes.data ?? []) && !disputes.loading ? (
              <Button v="ghost" icon="shield-outline" title={t('or_dispute')} onPress={() => router.push({ pathname: '/order/dispute/[id]', params: { id, subject: 'return', return: r.id } })}
                style={{ alignSelf: 'flex-start', minHeight: 40 }} />
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

const st = StyleSheet.create({
  card: { gap: 10, paddingVertical: 18, paddingHorizontal: 20 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  desc: { fontSize: 16, lineHeight: 22 },
  decT: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: palette.ink },
});
