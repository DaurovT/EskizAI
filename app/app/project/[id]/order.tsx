/**
 * SCR-14 Заказ материалов (Order.dc.html): часть 1 — EMAN (листы, распил и кромка, фурнитура из GET /projects/{id}/orders/preview),
 * самовывоз или доставка с расстоянием; часть 2 — позиции «под запрос» (цену пришлёт менеджер или партнёр).
 * «К оплате EMAN» оформляет заказ и открывает его карточку с оплатой (SCR-16/31): оплата — на мерчант EMAN.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { OrderLine } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatMoney, groupDigits, plural } from '../../../src/lib/format';
import { groupLines, parseKm } from '../../../src/lib/orders';
import { useOffline } from '../../../src/state/net';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Badge, Button, Card, Field, Loading, Press, Screen, Segmented, T } from '../../../src/ui/kit';
import { palette, tones } from '../../../src/ui/theme';

interface Ln { key: string; title: string; cap?: string; value: string }

export default function OrderCompose() {
  const { id, devContract } = useLocalSearchParams<{ id: string; devContract?: string }>();
  const { t, lang } = useT();
  const offline = useOffline();
  const [mode, setMode] = useState<'pickup' | 'delivery'>('pickup');
  const [kmText, setKmText] = useState('10');
  const [km, setKm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Пересчёт доставки — после паузы в наборе
  useEffect(() => {
    const h = setTimeout(() => setKm(mode === 'delivery' ? parseKm(kmText) : null), 500);
    return () => clearTimeout(h);
  }, [mode, kmText]);
  const prev = useResource(async () => {
    // dev: перевести проект мока в «Договор», чтобы открыть заказ для сверки (?devContract=1)
    if (__DEV__ && devContract) await api.toContract(id).catch(() => undefined);
    return api.orderPreview(id, km);
  }, [id, km]);
  const reqs = useResource(() => api.listPriceRequests(id).catch(() => []), [id]);
  const p = prev.data;

  const submit = async () => {
    setBusy(true);
    try {
      const o = await api.createOrder(id, km);
      router.replace(`/order/pay/${o.id}`);
    } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };

  if (prev.loading && !p) return <Loading />;
  if (!p) return <ErrorState error={prev.error} onRetry={prev.reload} />;

  // строки части 1: листы по одному, распил и кромка вместе, фурнитура одной строкой
  const lines: Ln[] = [];
  const sum = (ls: OrderLine[]) => ls.reduce((a, l) => a + l.total, 0);
  const names = (ls: OrderLine[]) => ls.map((l) => l.name.toLowerCase()).slice(0, 3).join(', ');
  const groups = groupLines(p.lines);
  for (const g of groups) {
    if (g.key === 'sheets' || g.key === 'other') {
      for (const l of g.lines) lines.push({ key: l.key, title: `${l.name}, ${String(l.qty).replace('.', ',')} ${l.unit === 'лист' && Number.isInteger(l.qty) ? plural(l.qty, t('est_u_sheet')) : l.unit}`, value: groupDigits(l.total) });
    }
  }
  const cut = groups.filter((g) => g.key === 'cutting' || g.key === 'edging').flatMap((g) => g.lines);
  if (cut.length) lines.splice(groups.find((g) => g.key === 'sheets')?.lines.length ?? 0, 0, { key: 'cut', title: t('oc_cut_edge'), cap: names(cut), value: groupDigits(sum(cut)) });
  const hw = groups.find((g) => g.key === 'hardware')?.lines ?? [];
  if (hw.length) lines.push({ key: 'hw', title: t('oc_hw_n', { n: hw.length, pos: plural(hw.length, t('est_u_pos')) }), cap: names(hw), value: groupDigits(sum(hw)) });

  const priced = (reqs.data ?? []).some((r) => r.status === 'priced');
  const totalStr = formatMoney(p.total, lang);

  return (
    <Screen gap={8} contentStyle={{ paddingTop: 0 }} footerStyle={{ paddingTop: 6 }} footer={
      <>
        <Button title={t('oc_to_pay')} value={totalStr} haptic="success" onPress={submit} loading={busy}
          disabled={offline || prev.loading || (mode === 'delivery' && km == null)} />
        <T v="cap" center>{t('oc_methods')}</T>
      </>
    }>
      <Stack.Screen options={{ title: '' }} />
      <T v="big" style={st.h1}>{t('oc_h1')}</T>

      <Card padded={false} style={{ paddingBottom: 14 }}>
        <View style={st.ph}>
          <View style={[st.tile, { backgroundColor: tones.green.bg }]}><Ionicons name="cube-outline" size={20} color={tones.green.fg} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={st.k}>{t('oc_part', { n: 1 })}</T>
            <T style={st.t}>EMAN</T>
          </View>
          <T num style={st.sum}>{totalStr}</T>
        </View>
        {lines.map((l) => (
          <View key={l.key} style={st.ln}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={st.lnT} numberOfLines={2}>{l.title}</T>
              {l.cap ? <T v="cap" style={st.lnCap} numberOfLines={1}>{l.cap}</T> : null}
            </View>
            <T num style={st.lnV}>{l.value}</T>
          </View>
        ))}
        {p.delivery ? (
          <View style={st.ln}>
            <T style={[st.lnT, { flex: 1 }]}>{t('oc_delivery')}</T>
            <T num style={st.lnV}>{groupDigits(p.delivery.cost)}</T>
          </View>
        ) : null}
        <View style={{ paddingTop: 10, paddingHorizontal: 20 }}>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'pickup', label: t('oc_pickup') }, { value: 'delivery', label: t('oc_delivery') }]} />
          {mode === 'delivery' ? (
            <Field label={t('oc_distance')} keyboardType="decimal-pad" value={kmText} onChangeText={setKmText} containerStyle={{ marginTop: 8 }} />
          ) : null}
          <T v="cap" style={{ marginTop: 8 }}>
            {mode === 'pickup' ? t('oc_pickup_hint', { kg: Math.round(p.weight_kg) })
              : p.delivery ? t('oc_delivery_line', { km: p.delivery.distance_km, kg: Math.round(p.delivery.weight_kg), cost: formatMoney(p.delivery.cost, lang) })
                : t('oc_distance_hint')}
          </T>
        </View>
      </Card>

      {p.excluded.length ? (
        <Card padded={false}>
          <View style={st.ph}>
            <View style={[st.tile, { backgroundColor: palette.ground }]}><Ionicons name="hammer-outline" size={20} color={palette.ink} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={st.k}>{t('oc_part', { n: 2 })}</T>
              <T style={st.t}>{t('oc_req')}</T>
            </View>
            <Badge tone="blue" label={t('oc_req_badge')} />
          </View>
          {p.excluded.map((x) => (
            <View key={x} style={st.ln}><T style={[st.lnT, { flex: 1 }]}>{x}</T><T num style={[st.lnV, { color: palette.muted }]}>—</T></View>
          ))}
          <T v="cap" style={{ paddingTop: 4, paddingHorizontal: 20, fontSize: 13, lineHeight: 18 }}>{t('oc_excluded_hint')}</T>
          <Press feedback="row" onPress={() => router.push(`/project/${id}/price-requests`)} accessibilityRole="button" style={st.link}>
            <T style={st.linkT}>{priced ? t('oc_price_came') : t('oc_req_link')}</T>
            <Ionicons name="chevron-forward" size={18} color={palette.chev} />
          </Press>
        </Card>
      ) : null}
      <T v="cap" style={{ paddingHorizontal: 8, fontSize: 13, lineHeight: 18 }}>{t('oc_eman_note')}</T>
    </Screen>
  );
}

const st = StyleSheet.create({
  h1: { lineHeight: 34, letterSpacing: -0.6, paddingHorizontal: 8, paddingTop: 2 },
  ph: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 16, paddingHorizontal: 20, paddingBottom: 8 },
  tile: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  k: { fontSize: 13, lineHeight: 17, color: palette.muted },
  t: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  sum: { fontSize: 18, lineHeight: 24, fontWeight: '700', letterSpacing: -0.27 },
  ln: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingVertical: 5, paddingHorizontal: 20 },
  lnT: { fontSize: 15, lineHeight: 20 },
  lnCap: { fontSize: 13, lineHeight: 17 },
  lnV: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  link: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 20, marginTop: 8, borderTopWidth: 1, borderTopColor: palette.hair },
  linkT: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600', color: palette.greenPress },
});
