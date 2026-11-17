/**
 * «Входящие чертежи» на широком планшете (TInbox.dc.html): боковая панель, строка инструментов «Открыть в Eskiz DWG» /
 * «Создать проект по чертежу», три колонки — список (новые и просмотренные), листы выбранного чертежа (превью, галочка
 * «по этому листу собрать проект»), холст с листом и масштабом; под холстом — файл, версия, когда удалится.
 * Долгое нажатие на строку — удалить. Телефон и портрет — app/inbox/index.tsx и [id].tsx (MInbox / MInboxItem).
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import type { InboxDrawing, InboxSheet } from '../api/types';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { drawingKind, drawingLine, drawingTitle, expiryDate, inboxSections } from '../lib/inbox';
import { makeProjectFromDrawing, sheetKey } from '../services/inboxProject';
import { useOffline } from '../state/net';
import { showError } from '../ui/dialogs';
import { DrawingImage } from '../ui/Drawing';
import { Cap2, DBtn, DesktopShell, GridBg, ListRow, PaneHead, Toolbar, desk, dk } from '../ui/Desktop';
import { ErrorState } from '../ui/ErrorState';
import { EmptyState, Loading, Press, dialog, resolveFont, toast } from '../ui/kit';
import { useLayout } from '../ui/layout';
import { palette } from '../ui/theme';
import { OpenInDwgSheet } from './OpenInDwg';

const UNITS: Record<string, [string, string]> = { mm: ['мм', 'mm'], cm: ['см', 'sm'], m: ['м', 'm'], in: ['дюйм', 'dyuym'], ft: ['фут', 'fut'] };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const ZOOMS = [0.5, 0.75, 1, 1.5, 2];

export function InboxWide({ selected }: { selected?: string }) {
  const { t, lang } = useT();
  const offline = useOffline();
  // уже доски 1194 (iPad 13" в портрете) — колонки списка и листов уже
  const compact = useLayout().width < 1150;
  const list = useResource(() => api.listInbox(), []);
  const [sel, setSel] = useState<string | null>(selected ?? null);
  const items = list.data?.items ?? [];
  const cur = items.find((d) => d.id === sel) ?? items[0] ?? null;
  const det = useResource(() => (cur ? api.getInboxDrawing(cur.id) : Promise.resolve(null)), [cur?.id], { refetchOnFocus: false });
  const d = det.data && det.data.id === cur?.id ? det.data : null;
  // лист на холсте и лист для проекта (сервер собирает проект по одному листу — галочка одна)
  const [view, setView] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [zoom, setZoom] = useState(2);
  const [busy, setBusy] = useState(false);
  const [openDwg, setOpenDwg] = useState(false);
  useEffect(() => {
    if (!d) return;
    const first = d.sheets.find((s) => s.selected) ?? d.sheets[0];
    setView(first ? sheetKey(first) : null);
    setPick(first ? sheetKey(first) : null);
    setZoom(2);
  }, [d]);

  const remove = async (x: InboxDrawing) => {
    const name = drawingTitle(x);
    if (!(await dialog.confirm({ title: t('inb_delete_q', { name }), text: t('inb_delete_text'), confirmLabel: t('delete'), cancelLabel: t('cancel'), destructive: true }))) return;
    try {
      await api.deleteInboxDrawing(x.id);
      if (list.data) list.setData({ ...list.data, items: list.data.items.filter((y) => y.id !== x.id), total: list.data.total - 1 });
      if (sel === x.id) setSel(null);
      toast.show(t('inb_deleted'));
    } catch (e) { showError(e, lang); }
  };
  const sheetOf = (k: string | null) => d?.sheets.find((s) => sheetKey(s) === k) ?? null;
  const make = async () => {
    if (!d) return;
    setBusy(true);
    try { await makeProjectFromDrawing(d, sheetOf(pick) ?? d.sheets[0] ?? null); } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };

  const shown = sheetOf(view) ?? d?.sheets[0] ?? null;
  const m = obj(d?.manifest);
  const code = typeof obj(m.units).code === 'string' ? String(obj(m.units).code) : 'mm';
  const unit = UNITS[code]?.[lang === 'uz' ? 1 : 0] ?? code;
  const kind = d ? drawingKind(d) : null;
  const release = typeof obj(m.source).release === 'string' ? String(obj(m.source).release) : null;
  const exp = d ? expiryDate(d, lang) : null;

  let body: React.ReactNode;
  if (list.loading && !list.data) body = <Loading />;
  else if (!list.data) body = <ErrorState error={list.error} onRetry={list.reload} />;
  else if (!items.length) {
    body = <View style={{ flex: 1, justifyContent: 'center' }}><EmptyState align="center" icon="file-tray-outline" title={t('inb_empty_title')} text={t('inb_empty_text')} /></View>;
  } else {
    const { fresh, seen } = inboxSections(items);
    const row = (x: InboxDrawing, isNew: boolean) => {
      const k = drawingKind(x);
      const dxf = k === 'DXF';
      return (
        <ListRow key={x.id} on={cur?.id === x.id} onPress={() => setSel(x.id)} onLongPress={() => remove(x)}
          label={`${drawingTitle(x)}. ${drawingLine(x, lang, t('inb_from_you'))}`}>
          <View style={[s.kind, dxf ? { backgroundColor: palette.blueSoft } : null]}>
            <Text style={resolveFont([s.kindT, dxf ? { color: palette.blue } : null])}>{k ?? '—'}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={resolveFont(desk.t)} numberOfLines={1}>{drawingTitle(x)}</Text>
            <Text style={resolveFont(desk.s)} numberOfLines={1}>{drawingLine(x, lang, t('inb_from_you')).replace(/ · (DXF|DWG)/, '')}</Text>
          </View>
          {isNew ? <View style={s.dot} /> : null}
        </ListRow>
      );
    };
    const marked = pick ? 1 : 0;
    body = (
      <View style={desk.panes}>
        <View style={[s.pane, { width: compact ? 220 : 250 }]}>
          <ScrollView>
            {fresh.length ? <><PaneHead>{t('inb_new', { n: fresh.length })}</PaneHead>{fresh.map((x) => row(x, true))}</> : null}
            {seen.length ? <><PaneHead>{t('inb_seen')}</PaneHead>{seen.map((x) => row(x, false))}</> : null}
          </ScrollView>
        </View>
        <View style={[s.pane, { width: compact ? 180 : 210, backgroundColor: dk.tb }]}>
          <PaneHead>{t('tab_inb_sheets', { n: marked })}</PaneHead>
          {d ? (
            <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>
              {d.sheets.map((x, i) => (
                <SheetCard key={`${x.number}-${i}`} x={x} i={i} on={shown != null && sheetKey(x) === sheetKey(shown)} checked={sheetKey(x) === pick}
                  onView={() => setView(sheetKey(x))} onCheck={() => setPick(sheetKey(x) === pick ? null : sheetKey(x))} />
              ))}
              <Cap2>{t('tab_inb_pick_hint', { u: d.units_guessed ? t('inb_units_guessed', { u: unit }) : t('inb_units_file', { u: unit }) })}</Cap2>
              {d.units_guessed && d.units_note ? <Cap2 style={{ color: palette.amberDeep }}>{d.units_note}</Cap2> : null}
            </ScrollView>
          ) : det.loading ? <Loading /> : null}
        </View>
        <View style={s.view}>
          <View style={desk.canvas}>
            <GridBg />
            {shown ? (
              <View style={{ width: `${Math.round(ZOOMS[zoom] * 88)}%`, aspectRatio: 1.45 }}>
                <DrawingImage uri={shown.preview_url} style={{ flex: 1, backgroundColor: 'transparent' }} />
              </View>
            ) : null}
            <View style={s.zoom}>
              <DBtn icon="remove" label={t('tab_zoom_out')} onPress={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0} />
              <DBtn title={`${Math.round(ZOOMS[zoom] * 100)}%`} label={t('tab_zoom_fit')} onPress={() => setZoom(2)} style={{ width: 56, paddingHorizontal: 0 }} />
              <DBtn icon="add" label={t('tab_zoom_in')} onPress={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoom === ZOOMS.length - 1} />
            </View>
          </View>
          {d ? (
            <View style={s.meta}>
              <Meta k={t('tab_inb_file')} v={d.filename} />
              <Meta k={t('inb_version')} v={[kind, release].filter(Boolean).join(' · ') || '—'} />
              <Meta k={exp ? t('tab_inb_deletes') : t('tab_inb_kept')} v={exp ?? ''} />
            </View>
          ) : <View style={{ height: 28 }} />}
        </View>
      </View>
    );
  }

  return (
    <DesktopShell active="inbox">
      <Stack.Screen options={{ headerShown: false }} />
      <Toolbar title={t('inb_title')} sub={t('tab_inb_sub')}>
        {d?.project_id ? <DBtn title={t('inb_to_project')} onPress={() => router.push(`/project/${d.project_id}`)} /> : null}
        <DBtn title={t('inb_open_dwg')} onPress={() => setOpenDwg(true)} disabled={!d} />
        <DBtn primary title={busy ? t('inb_making') : t('inb_make_project')} onPress={make} disabled={!d || busy || offline} />
      </Toolbar>
      {body}
      {d ? (
        <OpenInDwgSheet visible={openDwg} onClose={() => setOpenDwg(false)}
          source={{ title: drawingTitle(d), note: t('odw_source', { kind: kind ?? 'DWG' }), preview: d.preview_url }}
          getLink={async () => {
            // ссылка на пакет живёт 30 минут — перед открытием берём свежую
            const f = await api.getInboxDrawing(d.id).catch(() => d);
            return { src: f.download_url, name: d.filename };
          }} />
      ) : null}
    </DesktopShell>
  );
}

/** .sht — лист: превью 120, галочка и название; на холсте — с зелёной рамкой. */
function SheetCard({ x, i, on, checked, onView, onCheck }: { x: InboxSheet; i: number; on: boolean; checked: boolean; onView: () => void; onCheck: () => void }) {
  const { t } = useT();
  const name = [x.number ?? String(i + 1), x.name].filter(Boolean).join(' ');
  return (
    <Press feedback="opacity" onPress={onView} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={name}
      style={[s.sht, on && s.shtOn]}>
      <View style={s.pv}><DrawingImage uri={x.preview_url} style={StyleSheet.absoluteFill} /></View>
      <View style={s.nm}>
        <Press feedback="opacity" onPress={onCheck} hitSlop={8} accessibilityRole="checkbox" accessibilityState={{ checked }}
          accessibilityLabel={t('tab_inb_use_sheet', { name })} style={[s.chk, checked && s.chkOn]}>
          {checked ? <Ionicons name="checkmark" size={12} color={palette.white} /> : null}
        </Press>
        <Text style={resolveFont(s.nmT)} numberOfLines={1}>{x.name || name}</Text>
      </View>
    </Press>
  );
}

const Meta = ({ k, v }: { k: string; v: string }) => (
  <Text style={resolveFont(s.metaT)}>{`${k} `}<Text style={{ color: palette.ink, fontWeight: '600' }}>{v}</Text></Text>
);

const s = StyleSheet.create({
  pane: { backgroundColor: dk.pane, borderRightWidth: 1, borderRightColor: dk.line },
  kind: { width: 34, height: 34, borderRadius: 8, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  kindT: { fontSize: 10, lineHeight: 13, fontWeight: '800', color: palette.muted2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.green },
  sht: { borderRadius: 10, backgroundColor: palette.white, borderWidth: 1, borderColor: dk.cardLine, padding: 6, gap: 6 },
  shtOn: { borderColor: palette.green, borderWidth: 2, padding: 5 },
  pv: { height: 120, borderRadius: 6, backgroundColor: '#FBFBFC', overflow: 'hidden' },
  nm: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nmT: { flex: 1, fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.ink },
  chk: { width: 16, height: 16, borderRadius: 4, backgroundColor: palette.off, alignItems: 'center', justifyContent: 'center' },
  chkOn: { backgroundColor: palette.green },
  view: { flex: 1, minWidth: 0, backgroundColor: palette.ground },
  zoom: { position: 'absolute', right: 10, bottom: 10, flexDirection: 'row', gap: 4 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 2, columnGap: 16, paddingHorizontal: 14, paddingBottom: 12, alignItems: 'center' },
  metaT: { fontSize: 12, lineHeight: 16, color: palette.muted, flexShrink: 1 },
});
