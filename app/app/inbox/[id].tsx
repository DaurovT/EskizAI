/**
 * SCR-53 «Входящий чертёж» (MInboxItem.dc.html): листы сеткой по два (выбранный — зелёная рамка; тап выбирает лист
 * для проекта), единицы и версия файла, предупреждение «проверьте размеры», когда удалится.
 * «Создать проект по чертежу» → POST /inbox/drawings/{id}/project → разбор чертежа (SCR-55, экран разбора проекта);
 * «Открыть в Eskiz DWG» → SCR-54. Удалённый/истёкший (404) — «Чертёж удалён» (состояние макета).
 * dev: `?state=gone` — удалённый; `?dwg=1|0` — шторка SCR-54 открыта (DWG установлен / нет).
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { api } from '../../src/api';
import { ApiError } from '../../src/api/errors';
import type { InboxDrawingDetail, InboxSheet } from '../../src/api/types';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { drawingKind, drawingTitle, expiryDate } from '../../src/lib/inbox';
import { InboxWide } from '../../src/screens/InboxWide';
import { OpenInDwgSheet } from '../../src/screens/OpenInDwg';
import { makeProjectFromDrawing, sheetKey } from '../../src/services/inboxProject';
import { useOffline } from '../../src/state/net';
import { showError } from '../../src/ui/dialogs';
import { DrawingThumb, DwgAppIcon } from '../../src/ui/Drawing';
import { ErrorState } from '../../src/ui/ErrorState';
import { Banner, Button, Group, IconButton, ListItem, Loading, Press, Screen, T, dialog, toast } from '../../src/ui/kit';
import { tablet, useLayout } from '../../src/ui/layout';
import { palette } from '../../src/ui/theme';
import { TitleHeader } from '../../src/ui/TitleHeader';
import { Ionicons } from '@expo/vector-icons';

const UNITS: Record<string, [string, string]> = { mm: ['мм', 'mm'], cm: ['см', 'sm'], m: ['м', 'm'], in: ['дюйм', 'dyuym'], ft: ['фут', 'fut'] };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

export default function InboxItemRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // широкий планшет (TInbox.dc.html): список, листы и холст на одном экране — с выбранным чертежом
  const { wide } = useLayout();
  return wide ? <InboxWide selected={id} /> : <InboxItem />;
}

function InboxItem() {
  const { id, state, dwg } = useLocalSearchParams<{ id: string; state?: string; dwg?: string }>();
  const { t, lang } = useT();
  const offline = useOffline();
  const { width } = useWindowDimensions();
  const { tablet: tab } = useLayout();
  const gone = __DEV__ && state === 'gone';
  const { data: d, error, loading, reload } = useResource(() => api.getInboxDrawing(id), [id], { refetchOnFocus: false });
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openDwg, setOpenDwg] = useState(__DEV__ && dwg != null);
  useEffect(() => {
    if (d && pick == null) setPick(sheetKey(d.sheets.find((s) => s.selected) ?? d.sheets[0] ?? { number: null, name: null, selected: false, preview_url: null }));
  }, [d, pick]);

  const notFound = gone || (error instanceof ApiError && error.status === 404);
  const title = d ? drawingTitle(d) : '';
  const header = <Stack.Screen options={{
    headerShown: true,
    header: () => (
      <TitleHeader title={notFound ? t('inb_title') : title} sub={notFound ? null : t('inb_item_sub')}
        right={d && !notFound ? <IconButton flat icon="trash-outline" label={t('inb_delete')} onPress={() => remove(d)} /> : undefined} />
    ),
  }} />;

  if (notFound) {
    return (
      <Screen scroll={false} contentStyle={{ justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 10 }}
        footer={<Button title={t('inb_gone_ok')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/inbox'))} />}>
        {header}
        <View style={s.goneIco}><Ionicons name="time-outline" size={28} color={palette.ink} /></View>
        <T style={{ fontSize: 22, lineHeight: 28, fontWeight: '700', marginTop: 6 }} center>{t('inb_gone_title')}</T>
        <T style={{ lineHeight: 21 }} color={palette.muted} center>{t('inb_gone_text')}</T>
      </Screen>
    );
  }
  if (loading && !d) return <>{header}<Loading /></>;
  if (!d) return <>{header}<ErrorState error={error} onRetry={reload} /></>;

  async function remove(x: InboxDrawingDetail) {
    if (!(await dialog.confirm({ title: t('inb_delete_q', { name: drawingTitle(x) }), text: t('inb_delete_text'), confirmLabel: t('delete'), cancelLabel: t('cancel'), destructive: true }))) return;
    try {
      await api.deleteInboxDrawing(x.id);
      toast.show(t('inb_deleted'));
      if (router.canGoBack()) router.back(); else router.replace('/inbox');
    } catch (e) { showError(e, lang); }
  }

  const sheet = d.sheets.find((x) => sheetKey(x) === pick) ?? d.sheets.find((x) => x.selected) ?? d.sheets[0] ?? null;
  const kind = drawingKind(d);
  const m = obj(d.manifest);
  const units = obj(m.units);
  const src = obj(m.source);
  const code = typeof units.code === 'string' ? units.code : 'mm';
  const unitLabel = UNITS[code]?.[lang === 'uz' ? 1 : 0] ?? code;
  const version = [kind, typeof src.release === 'string' ? src.release : null].filter(Boolean).join(' · ') || '—';
  const exp = expiryDate(d, lang);
  const marked = d.sheets.filter((x) => x.selected).length;

  const make = async () => {
    setBusy(true);
    try {
      await makeProjectFromDrawing(d, sheet);
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(false);
    }
  };

  // две колонки (.grid 1fr 1fr, gap 12) по ширине колонки экрана; превью 166×104
  const colW = Math.floor((Math.min(width, tab ? tablet.column : width) - 24 - 12) / 2);
  return (
    <Screen gap={0} contentStyle={{ paddingTop: 0 }} footerStyle={{ gap: 8 }}
      footer={<>
        <Button title={busy ? t('inb_making') : t('inb_make_project')} onPress={make} loading={busy} disabled={offline} />
        <Button v="secondary" title={t('inb_open_dwg')} iconNode={<DwgAppIcon size={24} radius={6} />} onPress={() => setOpenDwg(true)} />
        {d.project_id ? <Button v="ghost" title={t('inb_to_project')} onPress={() => router.push(`/project/${d.project_id}`)} /> : null}
      </>}>
      {header}
      <T style={s.h}>{marked ? t('inb_sheets_marked', { n: marked }) : t('inb_sheets_marked', { n: d.sheets.length })}</T>
      <View style={s.grid}>
        {d.sheets.map((x, i) => {
          const on = sheet != null && sheetKey(x) === sheetKey(sheet);
          return (
            <Press key={`${x.number}-${i}`} feedback="opacity" onPress={() => setPick(sheetKey(x))} accessibilityRole="radio"
              accessibilityState={{ selected: on }} accessibilityLabel={[x.number, x.name].filter(Boolean).join(' ')} style={{ width: colW, gap: 6 }}>
              <DrawingThumb uri={x.preview_url} width={colW} height={Math.round(colW * 104 / 166)} selected={on} />
              <T style={{ fontSize: 13, lineHeight: 17 }} numberOfLines={2}>
                <T style={{ fontSize: 13, lineHeight: 17, fontWeight: '700' }}>{x.number ?? i + 1}</T>
                {x.name ? <T style={{ fontSize: 13, lineHeight: 17 }} color={palette.muted}>{` ${x.name}`}</T> : null}
              </T>
            </Press>
          );
        })}
      </View>
      {d.sheets.length > 1 ? <T v="cap" style={{ paddingHorizontal: 8, paddingTop: 8 }}>{t('inb_pick_sheet')}</T> : null}
      {d.units_guessed ? (
        <Banner tone="est" icon="warning-outline" title={cap(t('inb_check_dims'))} text={d.units_note ?? undefined} style={{ marginTop: 14 }} />
      ) : null}
      <Group style={{ marginTop: 14 }}>
        <ListItem title={t('inb_units')} value={d.units_guessed ? t('inb_units_guessed', { u: unitLabel }) : t('inb_units_file', { u: unitLabel })} valueMuted chevron={false} />
        <ListItem title={t('inb_version')} value={version} valueMuted chevron={false} />
      </Group>
      <View style={s.exp}>
        <Ionicons name="time-outline" size={16} color={palette.muted} />
        <T v="cap" style={{ flex: 1 }}>{exp ? t('inb_expires', { date: exp }) : t('inb_kept')}</T>
      </View>
      <OpenInDwgSheet visible={openDwg} onClose={() => setOpenDwg(false)}
        source={{ title, note: t('odw_source', { kind: kind ?? 'DWG' }), preview: d.preview_url }}
        force={__DEV__ && dwg != null ? dwg === '1' : undefined}
        getLink={async () => {
          // ссылка на пакет живёт 30 минут — перед открытием берём свежую
          const fresh = await api.getInboxDrawing(d.id).catch(() => d);
          return { src: fresh.download_url, name: d.filename };
        }} />
    </Screen>
  );
}

const s = StyleSheet.create({
  h: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: palette.muted, paddingTop: 18, paddingHorizontal: 8, paddingBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  exp: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12, paddingHorizontal: 8 },
  goneIco: { width: 56, height: 56, borderRadius: 18, backgroundColor: palette.segOnWhite, alignItems: 'center', justifyContent: 'center' },
});
