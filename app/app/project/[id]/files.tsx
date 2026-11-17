/**
 * SCR-21 Файлы проекта (Files.dc.html): пакет мастера по группам (клиенту · закупка и распил · производство и сборка),
 * закрытые — с замком. До оплаты: «Заказать в EMAN — файлы 0 сум» и «Скачать без заказа»; открыто — номер заказа,
 * версия и «Поделиться всем архивом» (файлы уходят файлами через системное меню). «Комплект чертежей · N листов» —
 * один PDF со всеми листами (титул, виды, развёртки, взрыв-схема, детали, спецификация, раскрой): строка открывает
 * SCR-57 (оглавление видно и до оплаты). Чертежи деталей и общий вид отдельными строками не показываются — они
 * в комплекте (просмотр детали — с листа комплекта); архив — кнопкой «Поделиться всем архивом».
 */
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { FileItem } from '../../../src/api/types';
import type { DictKey } from '../../../src/i18n';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { mimeOf, utiOf } from '../../../src/lib/files';
import { formatMoney, plural } from '../../../src/lib/format';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Banner, BigTitle, Button, Card, Loading, Press, Screen, T } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';
import { DrawingThumb, DwgAppIcon } from '../../../src/ui/Drawing';
import { drawingTitle } from '../../../src/lib/inbox';
import { ProjectDwgSheet } from '../../../src/screens/OpenInDwg';

type GroupKey = 'client' | 'buy' | 'make';
/** Порядок и подписи строк по макету (kind сервера и мока); группа — по `group` сервера, иначе отсюда. */
const ROWS: { re: RegExp; g: GroupKey; label: DictKey }[] = [
  { re: /offer|proposal|kp/, g: 'client', label: 'prod_fk_kp' },
  { re: /glb_closed/, g: 'client', label: 'prod_fk_glb_closed' },
  { re: /glb_open/, g: 'client', label: 'prod_fk_glb_open' },
  { re: /glb/, g: 'client', label: 'prod_fk_glb' },
  { re: /^spec_xlsx/, g: 'buy', label: 'prod_fk_spec_xlsx' },
  { re: /spec/, g: 'buy', label: 'prod_fk_spec' },
  { re: /cut|nesting/, g: 'buy', label: 'prod_fk_cut' },
  { re: /csv/, g: 'buy', label: 'prod_fk_csv' },
  { re: /hardware/, g: 'buy', label: 'prod_fk_hardware' },
  { re: /estimate/, g: 'buy', label: 'prod_fk_estimate' },
  { re: /dxf/, g: 'make', label: 'prod_fk_dxf' },
  { re: /production_set/, g: 'make', label: 'prod_fk_set' },
  { re: /assembl/, g: 'make', label: 'prod_fk_assembly' },
];
/** Не строками: архив — кнопка внизу, чертежи деталей и общий вид — листы комплекта. */
const HIDDEN = /^(archive|drawings_pdf|general_view_pdf)$/;
const SERVER_GROUP: Record<string, GroupKey> = { client: 'client', model3d: 'client', purchase: 'buy', production: 'make', assembly: 'make' };
const rowOf = (f: FileItem) => ROWS.findIndex((r) => r.re.test(f.kind));
const groupOf = (f: FileItem): GroupKey => (f.group && SERVER_GROUP[f.group]) || ROWS[rowOf(f)]?.g || 'make';
const isSet = (f: FileItem) => /production_set/.test(f.kind);
/** Метка формата в плашке .ft: PDF, XLS, CSV, DXF… */
const badgeOf = (f: FileItem) => (/dxf/.test(f.kind) ? 'DXF' : (f.format ?? f.kind.split('_').pop() ?? '').replace(/^xlsx?$/i, 'xls').slice(0, 4).toUpperCase());

export default function Files() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, td, lang } = useT();
  // комплект чертежей: число листов (оглавление строится на сервере один раз на версию)
  const set = useResource(() => api.getDrawingSet(id).catch(() => null), [id]);
  // название файла по макету («Карты раскроя · 4 листа»), иначе — перевод по kind / как прислал сервер
  const titleOf = (f: FileItem) => {
    const row = ROWS[rowOf(f)];
    const base = row ? t(row.label) : td(`files_k_${f.kind}`, f.title ?? f.name ?? f.kind);
    const n = f.sheets ?? (isSet(f) ? set.data?.pages : /cut/.test(f.kind) ? set.data?.sections.find((x) => x.key === 'cutting')?.count : null);
    return n ? t('prod_fk_n', { title: base, n, w: plural(n, t('ds_sheet_forms')) }) : base;
  };
  // весь ответ: файлы + цена «Скачать без заказа» (purchase, с учётом скидки Pro)
  const files = useResource(() => api.filesInfo(id), [id]);
  const orders = useResource(() => api.listOrders().then((all) => all.filter((o) => o.project_id === id && o.status !== 'cancelled')), [id]);
  const versions = useResource(() => api.listVersions(id), [id]);
  const [sharing, setSharing] = useState(false);
  // SCR-54 (MOpenDwg.dc.html): «Исходные» — чертёж из «Входящих», по которому создан проект
  const card = useResource(() => api.getProject(id), [id]);
  const [dwgOpen, setDwgOpen] = useState(false);
  const srcDwg = card.data?.source_drawing ?? null;
  const srcPreview = card.data?.photos.find((ph) => ph.kind === 'source')?.url ?? null;

  if (files.loading && !files.data) return <Loading />;
  if (!files.data) return <ErrorState error={files.error} onRetry={files.reload} />;
  const list = files.data.files;
  const purchase = files.data.purchase;
  const locked = list.some((f) => !f.available);
  const rank = (f: FileItem) => { const i = rowOf(f); return i < 0 ? ROWS.length : i; };
  const shown = list.filter((f) => !HIDDEN.test(f.kind)).sort((a, b) => rank(a) - rank(b));
  const groups = (['client', 'buy', 'make'] as GroupKey[]).map((g) => ({ g, items: shown.filter((f) => groupOf(f) === g) })).filter((x) => x.items.length);
  const order = orders.data?.[0];
  const vNum = versions.data?.find((v) => v.is_current)?.number ?? versions.data?.[0]?.number;

  // комплект — SCR-57 и до оплаты (оглавление, там же «Заказать»); остальное закрытое — причина
  const open = (f: FileItem) => (isSet(f) && (f.available || set.data)
    ? router.push(`/project/${id}/drawing-set`)
    : f.available
      ? router.push({ pathname: '/project/[id]/file/[kind]', params: { id, kind: f.kind, title: titleOf(f) } })
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
      {srcDwg ? (
        <View style={{ gap: 6 }}>
          <T style={st.sh2}>{t('files_source')}</T>
          <Card padded={false}>
            <Press feedback="row" onPress={() => setDwgOpen(true)} accessibilityRole="button" accessibilityLabel={`${drawingTitle(srcDwg)}. ${t('odw_title')}`} style={st.src}>
              <DrawingThumb uri={srcPreview} width={52} height={38} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T v="rt" numberOfLines={1}>{drawingTitle(srcDwg)}</T>
                <T v="rs" num>{[(srcDwg.source_kind ?? 'dwg').toUpperCase(), `${(srcDwg.size / 1048576).toFixed(1).replace('.', lang === 'uz' ? '.' : ',')} ${lang === 'uz' ? 'MB' : 'МБ'}`].join(' · ')}</T>
              </View>
              <DwgAppIcon size={28} radius={7} />
            </Press>
          </Card>
          <ProjectDwgSheet projectId={id} drawing={srcDwg} preview={srcPreview} visible={dwgOpen} onClose={() => setDwgOpen(false)} />
        </View>
      ) : null}
      {list.length === 0 ? <T v="sub" style={{ paddingHorizontal: 8 }}>{t('files_none')}</T> : null}
      {groups.map(({ g, items }) => (
        <View key={g} style={{ gap: 6 }}>
          <T style={st.sh2}>{t(`files_g_${g}` as 'files_g_client')}</T>
          <Card padded={false}>
            {items.map((f, i) => (
              <Press key={f.kind} feedback="row" onPress={() => open(f)} accessibilityRole="button"
                accessibilityLabel={`${titleOf(f)}, ${f.available ? t('files_open') : t('files_locked')}`} style={[st.fr2, i > 0 && st.sep]}>
                <View style={st.ft}><T style={st.ftT}>{badgeOf(f)}</T></View>
                <T style={st.fn} numberOfLines={1}>{titleOf(f)}</T>
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
  src: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 10, paddingHorizontal: 20 },
  fn: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21, fontWeight: '500' },
  buy: { height: 50, borderRadius: 16, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  buyT: { fontSize: 17, lineHeight: 22, fontWeight: '500' },
  buyV: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: palette.muted },
});
