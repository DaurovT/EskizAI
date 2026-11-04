/**
 * «Сообщить о проблеме» по оплаченному заказу (docs/staff_vendor_contract.md §5.6, POST /orders/{id}/returns):
 * тип (брак, ошибка раскроя, недовложение, отмена после оплаты, другое), описание, фото и — по желанию — позиции.
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { RETURN_TYPES, type OrderReturnType } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { toUpload } from '../../../src/services/photos';
import { useOffline } from '../../../src/state/net';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Banner, Button, Card, Field, Loading, Screen, T, toast } from '../../../src/ui/kit';
import { CheckRow, PhotoStrip, RadioList, usePhotoAttach } from '../../../src/ui/OrderParts';

export default function OrderReturnNew() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, td, lang } = useT();
  const offline = useOffline();
  const order = useResource(() => api.getOrder(id), [id]);
  const [type, setType] = useState<OrderReturnType | null>(null);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const att = usePhotoAttach(5);
  if (order.loading && !order.data) return <Loading />;
  if (!order.data) return <ErrorState error={order.error} onRetry={order.reload} />;
  const o = order.data;
  const lines = o.items.filter((it) => !it.excluded);

  const submit = async () => {
    if (!type) return setErr(t('ort_need_type'));
    if (text.trim().length < 3) return setErr(t('ort_need_text'));
    setErr(null);
    setBusy(true);
    try {
      await api.createOrderReturn(o.id, {
        type, description: text.trim(),
        lines: picked.map((i) => ({ key: lines[i].key ?? null, name: lines[i].name, unit: lines[i].unit, qty: lines[i].qty })),
        files: att.photos.map((p, i) => toUpload(p, i, 'return')),
      });
      toast.show({ text: t('ort_sent'), tone: 'success' });
      if (router.canGoBack()) router.back(); else router.replace(`/order/returns/${o.id}`);
    } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };

  return (
    <Screen gap={12} contentStyle={{ paddingTop: 0 }} footerStyle={{ gap: 4 }} footer={
      <>
        <Button title={t('ort_send')} onPress={submit} loading={busy} disabled={offline} haptic="light" />
        <Button v="ghost" title={t('cancel')} onPress={() => router.back()} />
      </>
    }>
      <Stack.Screen options={{ title: '' }} />
      <View style={{ paddingHorizontal: 8 }}>
        <T v="bigPush" style={{ letterSpacing: -0.56 }}>{t('or_report')}</T>
        <T v="sub" style={{ marginTop: 4 }}>{t('ort_sub', { n: o.number })}</T>
      </View>
      <T v="h3" style={st.h}>{t('ort_what')}</T>
      <RadioList items={RETURN_TYPES.map((k) => ({ key: k, label: td(`or_type_${k}`, k), sub: td(`or_type_${k}_d`, '') || undefined }))} value={type} onChange={(k) => { setType(k); setErr(null); }} />
      <Field label={t('ort_desc')} placeholder={t('ort_desc_ph')} value={text} onChangeText={(v) => { setText(v); setErr(null); }} multiline multilineMinHeight={112}
        maxLength={2000} style={{ fontSize: 16, lineHeight: 22, fontWeight: '400' }} />
      <T v="h3" style={st.h}>{t('ort_photos')}</T>
      <PhotoStrip photos={att.photos} onAdd={att.open} onRemove={att.remove} max={att.max} size={72} addLabel={att.photos.length ? undefined : t('oa_add_photo')} />
      {lines.length ? (
        <>
          <T v="h3" style={st.h}>{t('ort_lines')}</T>
          <Card padded={false}>
            {lines.map((l, i) => (
              <CheckRow key={`${l.key ?? l.name}-${i}`} title={l.name} sub={l.qty != null ? `${String(l.qty).replace('.', ',')} ${l.unit ?? ''}` : null}
                on={picked.includes(i)} sep={i > 0} onPress={() => setPicked((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))} />
            ))}
          </Card>
        </>
      ) : null}
      {err ? <Banner tone="err" icon="alert-circle-outline" text={err} /> : null}
      <T v="cap" style={{ paddingHorizontal: 8 }}>{t('ort_note')}</T>
      {att.sheet}
    </Screen>
  );
}

const st = StyleSheet.create({
  h: { paddingTop: 4, paddingHorizontal: 8 },
});
