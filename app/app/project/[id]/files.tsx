/**
 * SCR-21 Файлы проекта (Files.dc.html): пакет мастера по группам (клиенту · закупка и распил · производство и сборка),
 * закрытые — с замком. До оплаты: «Заказать в EMAN — файлы 0 сум» и «Скачать без заказа»; открыто — номер заказа,
 * версия и «Поделиться всем архивом» (файлы уходят файлами через системное меню).
 */
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { FileItem } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { mimeOf, utiOf } from '../../../src/lib/files';
import { formatMoney } from '../../../src/lib/format';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Banner, BigTitle, Button, Card, Loading, Press, Screen, T } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

type GroupKey = 'client' | 'buy' | 'make';
const groupOf = (k: string): GroupKey =>
  /offer|proposal|kp/.test(k) ? 'client' : /spec|cut|csv|hardware|estimate|nesting/.test(k) ? 'buy' : 'make';
/** Метка формата в плашке .ft: PDF, XLS, CSV, DXF… */
const badgeOf = (f: FileItem) => (/dxf/.test(f.kind) ? 'DXF' : (f.format ?? f.kind.split('_').pop() ?? '').replace(/^xlsx?$/i, 'xls').slice(0, 4).toUpperCase());

export default function Files() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  // весь ответ: файлы + цена «Скачать без заказа» (purchase, с учётом скидки Pro)
  const files = useResource(() => api.filesInfo(id), [id]);
  const orders = useResource(() => api.listOrders().then((all) => all.filter((o) => o.project_id === id && o.status !== 'cancelled')), [id]);
  const versions = useResource(() => api.listVersions(id), [id]);
  const [sharing, setSharing] = useState(false);

  if (files.loading && !files.data) return <Loading />;
  if (!files.data) return <ErrorState error={files.error} onRetry={files.reload} />;
  const list = files.data.files;
  const purchase = files.data.purchase;
  const locked = list.some((f) => !f.available);
  const groups = (['client', 'buy', 'make'] as GroupKey[]).map((g) => ({ g, items: list.filter((f) => groupOf(f.kind) === g) })).filter((x) => x.items.length);
  const order = orders.data?.[0];
  const vNum = versions.data?.find((v) => v.is_current)?.number ?? versions.data?.[0]?.number;

  const open = (f: FileItem) => (f.available
    ? router.push({ pathname: '/project/[id]/file/[kind]', params: { id, kind: f.kind, title: f.title ?? f.name ?? f.kind } })
    : Alert.alert(t('files_locked_title'), f.reason ?? ''));

  // весь пакет: архив, если сервер его отдаёт, иначе — файлы по очереди через системное меню
  const shareAll = async () => {
    try {
      if (!(await Sharing.isAvailableAsync())) return Alert.alert(t('fv_share_unavailable'));
      setSharing(true);
      const avail = list.filter((f) => f.available);
      const archive = avail.find((f) => /archive|zip_all|package/.test(f.kind));
      for (const f of archive ? [archive] : avail) {
        const d = await api.downloadFile(id, f.kind);
        const mime = mimeOf(d.mimeType, d.name);
        await Sharing.shareAsync(d.uri, { mimeType: mime, dialogTitle: d.name, UTI: utiOf(mime) });
      }
    } catch (e) { showError(e, lang); } finally { setSharing(false); }
  };

  const footer = locked ? (
    <>
      <T v="cap" style={{ fontSize: 13, lineHeight: 18 }}>{t('files_lock_note')}</T>
      <Button title={t('files_order')} value={t('files_order_val')} onPress={() => router.push(`/project/${id}/order`)} />
      <Press onPress={() => Alert.alert(t('files_locked_title'), list.find((f) => !f.available)?.reason ?? '')} accessibilityRole="button" style={st.buy}>
        <T style={st.buyT}>{t('files_buy')}</T>
        <T num style={st.buyV}>{purchase ? t('files_buy_val', { sum: formatMoney(purchase.price, lang) }) : t('files_by_plan')}</T>
      </Press>
    </>
  ) : (
    <>
      <Banner tone="ok" textStyle={BAN15} icon="checkmark" style={{ alignItems: 'center', paddingVertical: 12 }}
        text={order ? t('files_open_order', { n: order.number, v: vNum ?? '—' }) : t('files_open_paid', { v: vNum ?? '—' })} />
      <Button title={t('files_share_all')} icon="share-outline" loading={sharing} onPress={shareAll} />
    </>
  );

  return (
    <Screen gap={6} contentStyle={{ paddingTop: 0 }} footerBar={locked} footer={footer}>
      <Stack.Screen options={{ title: '' }} />
      <BigTitle style={{ paddingTop: 0, paddingBottom: 2 }}>{t('files_proj_title')}</BigTitle>
      {list.length === 0 ? <T v="sub" style={{ paddingHorizontal: 8 }}>{t('files_none')}</T> : null}
      {groups.map(({ g, items }) => (
        <View key={g} style={{ gap: 6 }}>
          <T style={st.sh2}>{t(`files_g_${g}` as 'files_g_client')}</T>
          <Card padded={false}>
            {items.map((f, i) => (
              <Press key={f.kind} feedback="row" onPress={() => open(f)} accessibilityRole="button"
                accessibilityLabel={`${f.title ?? f.kind}, ${f.available ? t('files_open') : t('files_locked')}`} style={[st.fr2, i > 0 && st.sep]}>
                <View style={st.ft}><T style={st.ftT}>{badgeOf(f)}</T></View>
                <T style={st.fn} numberOfLines={1}>{f.title ?? f.name ?? f.kind}</T>
                <Ionicons name={f.available ? 'chevron-forward' : 'lock-closed-outline'} size={18} color="#A3A09A" />
              </Press>
            ))}
          </Card>
        </View>
      ))}
    </Screen>
  );
}

const BAN15 = { fontSize: 15, lineHeight: 20 };
const st = StyleSheet.create({
  sh2: { fontSize: 17, lineHeight: 22, fontWeight: '700', paddingTop: 4, paddingHorizontal: 8 },
  fr2: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 46, paddingVertical: 4, paddingLeft: 12, paddingRight: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  ft: { width: 44, height: 32, borderRadius: 10, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  ftT: { fontSize: 13, lineHeight: 16, fontWeight: '700', color: palette.muted2, letterSpacing: 0.26 },
  fn: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21, fontWeight: '500' },
  buy: { height: 50, borderRadius: 16, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  buyT: { fontSize: 17, lineHeight: 22, fontWeight: '500' },
  buyV: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: palette.muted },
});
