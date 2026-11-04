/**
 * «Открыть спор» (docs/staff_vendor_contract.md §4a, POST /orders/{id}/disputes): мастер не согласен с решением
 * поставщика по рекламации (?subject=return&return=<id>) или с отклонением заказа (?subject=rejection).
 * Причина, комментарий, фото → очередь споров платформы; решение увидят обе стороны.
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { DISPUTE_REASONS, type DisputeReason, type DisputeSubject } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDayTime } from '../../../src/lib/format';
import { toUpload } from '../../../src/services/photos';
import { useOffline } from '../../../src/state/net';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Banner, Button, Card, Field, Loading, Screen, T, toast } from '../../../src/ui/kit';
import { KV, PhotoStrip, Quote, RadioList, returnBadge, usePhotoAttach } from '../../../src/ui/OrderParts';

export default function OrderDisputeNew() {
  const { id, subject: subjectParam, return: returnId } = useLocalSearchParams<{ id: string; subject?: DisputeSubject; return?: string }>();
  const subject: DisputeSubject = subjectParam === 'rejection' ? 'rejection' : 'return';
  const { t, td, lang } = useT();
  const offline = useOffline();
  const order = useResource(() => api.getOrder(id), [id]);
  const ret = useResource(() => (subject === 'return' && returnId ? api.listOrderReturns(id).then((l) => l.find((r) => r.id === returnId) ?? null) : Promise.resolve(null)), [id, subject, returnId]);
  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const att = usePhotoAttach(5);
  if ((order.loading && !order.data) || (ret.loading && !ret.data && subject === 'return')) return <Loading />;
  if (!order.data) return <ErrorState error={order.error} onRetry={order.reload} />;
  const o = order.data;
  const r = ret.data;

  const submit = async () => {
    if (!reason) return setErr(t('dsp_need_reason'));
    if (text.trim().length < 3) return setErr(t('dsp_need_text'));
    setErr(null);
    setBusy(true);
    try {
      await api.openOrderDispute(o.id, {
        subject, return_id: subject === 'return' ? returnId ?? null : null, reason, comment: text.trim(),
        files: att.photos.map((p, i) => toUpload(p, i, 'dispute')),
      });
      toast.show({ text: t('dsp_sent'), tone: 'success' });
      if (router.canGoBack()) router.back(); else router.replace(`/order/${o.id}`);
    } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };

  return (
    <Screen gap={12} contentStyle={{ paddingTop: 0 }} footerStyle={{ gap: 4 }} footer={
      <>
        <Button icon="shield-outline" title={t('dsp_send')} onPress={submit} loading={busy} disabled={offline} haptic="light" />
        <Button v="ghost" title={t('cancel')} onPress={() => router.back()} />
      </>
    }>
      <Stack.Screen options={{ title: '' }} />
      <View style={{ paddingHorizontal: 8 }}>
        <T v="bigPush" style={{ letterSpacing: -0.56 }}>{t('dsp_title')}</T>
        <T v="sub" style={{ marginTop: 4 }}>{t('ort_sub', { n: o.number })}</T>
      </View>
      <Banner tone="info" icon="shield-checkmark-outline" text={t('dsp_info')} />
      {/* о чём спор: решение поставщика */}
      <Card style={st.ctx}>
        {subject === 'rejection' ? (
          <>
            <T v="lbl">{t('dsp_about_rejection')}</T>
            {o.reject_reason ? <KV k={t('ocd_reason')} v={td(`orr_${o.reject_reason}`, o.reject_reason)} /> : null}
            {o.vendor_status_note ? <Quote text={o.vendor_status_note} /> : null}
          </>
        ) : r ? (
          <>
            <T v="lbl">{t('dsp_about_return', { type: td(`or_type_${r.type}`, r.type) })}</T>
            <KV k={t('dsp_vendor_decision')} v={t(returnBadge(r).key)} />
            {r.decision_comment ? <Quote text={r.decision_comment} by={formatDayTime(r.decided_at, lang).replace(/^—$/, '') || null} /> : null}
          </>
        ) : <T v="cap">{t('dsp_about_unknown')}</T>}
      </Card>
      <T v="h3" style={st.h}>{t('dsp_reason')}</T>
      <RadioList items={DISPUTE_REASONS[subject].map((k) => ({ key: k, label: td(`dsp_r_${k}`, k) }))} value={reason} onChange={(k) => { setReason(k); setErr(null); }} />
      <Field label={t('dsp_comment')} placeholder={t('dsp_comment_ph')} value={text} onChangeText={(v) => { setText(v); setErr(null); }} multiline multilineMinHeight={112}
        maxLength={2000} style={{ fontSize: 16, lineHeight: 22, fontWeight: '400' }} />
      <T v="h3" style={st.h}>{t('ort_photos')}</T>
      <PhotoStrip photos={att.photos} onAdd={att.open} onRemove={att.remove} max={att.max} size={72} addLabel={att.photos.length ? undefined : t('oa_add_photo')} />
      {err ? <Banner tone="err" icon="alert-circle-outline" text={err} /> : null}
      {att.sheet}
    </Screen>
  );
}

const st = StyleSheet.create({
  h: { paddingTop: 4, paddingHorizontal: 8 },
  ctx: { gap: 10, paddingVertical: 16, paddingHorizontal: 20 },
});
