/**
 * SCR-38 Смета глазами сотрудника без доступа к себестоимости (StaffView.dc.html):
 * суммы по группам скрыты, видно, что можно и нельзя, цена клиенту в футере.
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Stack, router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { ProjectEstimate } from '../api/types';
import { useT } from '../i18n';
import { decorById } from '../lib/catalog';
import { formatRange, plural } from '../lib/format';
import { useSession } from '../state/session';
import { Banner, Button, ButtonRow, Card, Screen, T } from '../ui/kit';
import { palette, tones } from '../ui/theme';

export function StaffEstimateView({ id, estimate: e }: { id: string; estimate: ProjectEstimate }) {
  const { t, td, lang } = useT();
  const { user, workshop, canOrder } = useSession();
  const sheets = Object.entries(e.sheets ?? {}).map(([m, n]) => {
    const d = decorById(m);
    return `${(lang === 'uz' ? d?.name_uz : d?.name) ?? m} · ${n} ${plural(n, t('est_u_sheet'))}`;
  });
  const rows = [...sheets, t('est_row_services'), td('est_cat_fronts', 'Фасады'), td('est_cat_hardware', 'Фурнитура'), t('est_staff_work')];
  const views = (workshop?.employee_estimate_views ?? ['total']).map((v) => `«${td(`view_${v}`, v)}»`).join(', ');
  const [num, cur] = splitCurrency(formatRange(e.total, lang));

  return (
    <Screen
      gap={8}
      contentStyle={{ paddingTop: 0 }}
      footerBar
      footer={
        <>
          <View style={st.totalRow}>
            <T v="cap">{t('est_staff_price')}</T>
            <T v="bigN" style={{ fontSize: 24, flexShrink: 1 }} numberOfLines={1}>
              {num}{cur ? <T style={st.cur}>{` ${cur}`}</T> : null}
            </T>
          </View>
          <ButtonRow>
            <Button v="secondary" icon="paper-plane-outline" title={t('est_staff_send')} onPress={() => router.push(`/project/${id}/send`)} style={{ paddingHorizontal: 18 }} />
            <Button title={t('est_staff_measure')} iconNode={<MaterialCommunityIcons name="ruler" size={20} color={palette.white} />}
              onPress={() => router.push(`/project/${id}/measure`)} style={{ flex: 1 }} />
          </ButtonRow>
          <Button small icon={canOrder ? 'cube-outline' : 'lock-closed-outline'} title={canOrder ? t('est_staff_order') : t('est_staff_order_off')} disabled={!canOrder}
            onPress={() => router.push(`/project/${id}/order`)} style={{ width: '100%' }} />
        </>
      }
    >
      <Stack.Screen options={{ title: '' }} />
      <View style={st.head}>
        <T v="bigPush">{t('est_title')}</T>
        <T v="sub" style={{ marginTop: 2 }}>{t('est_staff_sub')}</T>
      </View>
      <Banner tone="info" icon="eye-outline" text={t('est_staff_banner', { name: user?.name ?? '' })} style={{ alignItems: 'center' }} />
      <Card padded={false}>
        {rows.map((r, i) => (
          <View key={`${i}-${r}`} style={[st.r50, i > 0 && st.sep]}>
            <T style={st.r50t} numberOfLines={1}>{r}</T>
            <View style={st.hid}>
              <Ionicons name="lock-closed-outline" size={14} color={palette.muted} />
              <T style={st.hidT}>{t('est_hidden')}</T>
            </View>
          </View>
        ))}
      </Card>
      <Card style={{ gap: 12, paddingVertical: 16, paddingHorizontal: 20 }}>
        <View style={st.cn}>
          <View style={[st.tile, { backgroundColor: tones.green.bg }]}><Ionicons name="checkmark" size={18} color={tones.green.fg} /></View>
          <T style={st.cnT}><T style={[st.cnT, { fontWeight: '600' }]}>{t('est_staff_can')}</T>{` ${t('est_staff_can_text', { views })}`}</T>
        </View>
        <View style={st.cn}>
          <View style={[st.tile, { backgroundColor: tones.red.bg }]}><Ionicons name="close" size={18} color={tones.red.fg} /></View>
          <T style={st.cnT}><T style={[st.cnT, { fontWeight: '600' }]}>{t('est_staff_cant')}</T>{` ${canOrder ? t('est_staff_cant_text_order') : t('est_staff_cant_text')}`}</T>
        </View>
      </Card>
    </Screen>
  );
}

/** «9,2–10,5 млн сум» → [«9,2–10,5 млн», «сум»]. */
function splitCurrency(s: string): [string, string] {
  const m = s.match(/^(.*)\s(сум|so‘m)$/);
  return m ? [m[1], m[2]] : [s, ''];
}

const st = StyleSheet.create({
  head: { paddingHorizontal: 8, paddingTop: 4 },
  r50: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 48, paddingVertical: 6, paddingLeft: 20, paddingRight: 16 },
  r50t: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '500' },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  hid: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: palette.ground },
  hidT: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: palette.muted },
  cn: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  tile: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cnT: { flex: 1, fontSize: 14, lineHeight: 20 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  cur: { fontSize: 17, fontWeight: '500', color: palette.muted },
});
