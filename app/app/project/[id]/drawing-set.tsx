/**
 * SCR-57 Комплект чертежей (DrawingSet.dc.html): разделы комплекта чипами (обложка · общий вид · сборка · детали ·
 * спецификация · раскрой) с числом листов, лист с рамкой и штампом «Лист N / M», лента листов. Оглавление — с сервера
 * (GET /projects/{id}/drawing-set, номера листов как в штампе PDF); на листе — то, что на нём в PDF: титул с составом,
 * эскиз изделия, детали листа с присадкой, спецификация, карта раскроя. Нажатие на лист — просмотр файла на этом месте
 * (чертёж детали, спецификация, раскрой), остальное — PDF через системное меню. До оплаты — как в «Файлах»: оглавление
 * видно, открыть и поделиться — после заказа в EMAN или оплаты файлов.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ViewerPart } from '@mebel/viewer';
import * as Sharing from 'expo-sharing';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, PanResponder, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { api } from '../../../src/api';
import type { DrawingSection, DrawingSheet, ModelStateOut } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { whdToWdh } from '../../../src/lib/ar';
import { nestingSheets } from '../../../src/lib/cutting';
import { mimeOf, utiOf } from '../../../src/lib/files';
import { formatDate, formatMoney, plural } from '../../../src/lib/format';
import { sketchFromTree } from '../../../src/lib/sketch';
import { useSession } from '../../../src/state/session';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Button, IconButton, Loading, Press, Screen, T } from '../../../src/ui/kit';
import { SketchDrawing } from '../../../src/ui/ProductSketch';
import { CutBoard } from '../../../src/ui/SheetLayout';
import { TitleHeader } from '../../../src/ui/TitleHeader';
import { palette } from '../../../src/ui/theme';

const BLUE = palette.blue;
const PAGE_H = 400;

const initials = (n?: string | null) => (n ?? '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '·';
const range = (a: number, n: number) => (n > 1 ? `${a}–${a + n - 1}` : `${a}`);

/** Деталь листа: контур прямоугольником в масштабе, отверстия в пласти — точки, размеры — синим. */
function MiniPart({ part, w, h }: { part: ViewerPart; w: number; h: number }) {
  const pad = 18;
  const k = Math.min((w - pad * 2) / part.length, (h - pad * 2 - 12) / part.width);
  const pw = part.length * k, ph = part.width * k;
  const x0 = (w - pw) / 2, y0 = 12 + (h - 12 - ph) / 2;
  const holes = part.holes.filter((hl) => hl.face === 'A' || hl.face === 'B').slice(0, 80);
  return (
    <View style={{ width: w, height: h }}>
      <T num style={st.partNo} numberOfLines={1}>{`№ ${part.number} · ${part.name}`}</T>
      <View style={[st.partBody, { left: x0, top: y0, width: pw, height: ph }]} />
      {holes.map((hl, i) => {
        const d = Math.max(2.4, Math.min(hl.diameter * k, 12));
        return <View key={i} style={[st.hole, { left: x0 + hl.x * k - d / 2, top: y0 + ph - hl.y * k - d / 2, width: d, height: d, borderRadius: d / 2 }, d > 5 && st.holeBig]} />;
      })}
      <View style={[st.dim, { left: x0, top: y0 + ph + 5, width: pw, height: 1 }]} />
      <T num style={[st.dimT, { left: x0, top: y0 + ph + 6, width: pw }]}>{String(Math.round(part.length))}</T>
      <View style={[st.dim, { left: x0 + pw + 5, top: y0, width: 1, height: ph }]} />
      <T num style={[st.dimT, { left: x0 + pw + 7, top: y0 + ph / 2 - 7, textAlign: 'left' }]}>{String(Math.round(part.width))}</T>
    </View>
  );
}

export default function DrawingSet() {
  const { id, page } = useLocalSearchParams<{ id: string; page?: string }>();
  const { t, lang } = useT();
  const { workshop } = useSession();
  const set = useResource(() => api.getDrawingSet(id), [id]);
  const model = useResource<ModelStateOut | null>(() => api.getModel(id).catch(() => null), [id]);
  const card = useResource(() => api.getProject(id), [id]);
  const files = useResource(() => api.filesInfo(id), [id]);
  const [pg, setPg] = useState(() => Math.max(1, Number(page) || 1)); // page — открыть сразу на листе
  const [sharing, setSharing] = useState(false);
  const data = set.data;
  const sheet = data?.sheets.find((s) => s.n === pg) ?? (pg > 1 ? data?.sheets[data.sheets.length - 1] : data?.sheets[0]);
  const needNesting = !!data?.sheets.some((s) => s.section === 'cutting');
  const nesting = useResource(() => (needNesting ? api.getNesting(id) : Promise.resolve(null)), [id, needNesting]);
  const strip = useRef<ScrollViewInstance>(null);
  const pgRef = useRef(pg);
  pgRef.current = pg;
  const total = data?.pages ?? 0;
  const go = (d: number) => setPg((p) => Math.max(1, Math.min(total || 1, p + d)));
  const goRef = useRef(go);
  goRef.current = go;
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_, g) => { if (g.dx < -50) goRef.current(1); else if (g.dx > 50) goRef.current(-1); },
  })).current;
  const chips = useRef<ScrollViewInstance>(null);
  const chipX = useRef<Record<number, number>>({});
  const ready = !!set.data;
  // выбранный лист и его раздел — в поле зрения лент (и при открытии сразу на листе ?page=N)
  useEffect(() => {
    if (!ready) return;
    if (set.data && pg > set.data.pages) { setPg(set.data.pages); return; }
    const id2 = setTimeout(() => {
      strip.current?.scrollTo({ x: Math.max(0, (pg - 3) * 74), animated: true });
      const firsts = (set.data?.sections ?? []).filter((x) => x.first <= pg).map((x) => x.first);
      const x = chipX.current[firsts[firsts.length - 1] ?? 1];
      if (x != null) chips.current?.scrollTo({ x: Math.max(0, x - 60), animated: true });
    }, 60);
    return () => clearTimeout(id2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pg, ready]);

  const viewer = model.data?.version.viewer;
  const partsByNo = useMemo(() => new Map((viewer?.parts ?? []).map((p) => [p.number, p])), [viewer]);
  const sketch = useMemo(() => card.data?.model_summary?.sketch ?? sketchFromTree(model.data?.version.tree), [card.data, model.data]);
  const cutSheets = useMemo(() => (nesting.data ? nestingSheets(nesting.data) : []), [nesting.data]);

  if (set.loading && !data) return <Loading />;
  if (!data) return <ErrorState error={set.error} onRetry={set.reload} />;
  if (!sheet) return <Screen><T v="sub" style={{ paddingHorizontal: 8 }}>{t('ds_none')}</T></Screen>;

  const locked = data.locked;
  const secName = (k: DrawingSection) => t(`ds_sec_${k}` as 'ds_sec_cover');
  const sheetsWord = plural(total, t('ds_sheet_forms'));
  const avail = (files.data?.files ?? []).filter((f) => f.available);
  const purchase = files.data?.purchase;
  const order = () => router.push(`/project/${id}/order`);

  const sharePdf = async () => {
    if (locked) return Alert.alert(t('files_locked_title'), data.reason ?? t('ds_locked'));
    try {
      if (!(await Sharing.isAvailableAsync())) return Alert.alert(t('fv_share_unavailable'));
      setSharing(true);
      const d = await api.downloadFile(id, data.kind);
      const mime = mimeOf(d.mimeType, d.name);
      await Sharing.shareAsync(d.uri, { mimeType: mime, dialogTitle: d.name, UTI: utiOf(mime) });
    } catch (e) { showError(e, lang); } finally { setSharing(false); }
  };

  // Лист → просмотр файла на этом месте; виды, сборка, титул — сам PDF (системное меню показывает его целиком)
  const open = (s: DrawingSheet) => {
    if (locked) return Alert.alert(t('files_locked_title'), data.reason ?? t('ds_locked'));
    const find = (re: RegExp) => avail.find((f) => re.test(f.kind) && !/production_set|archive/.test(f.kind));
    const target = s.section === 'parts' ? find(/drawing/) : s.section === 'spec' ? find(/spec_pdf/) ?? find(/spec/)
      : s.section === 'cutting' ? find(/cut|nesting/) : undefined;
    if (!target) return sharePdf();
    router.push({ pathname: '/project/[id]/file/[kind]', params: { id, kind: target.kind, title: secName(s.section), ...(s.parts[0] ? { part: String(s.parts[0]) } : {}) } });
  };

  const secs = data.sections;
  const curSec = secs.reduce((a, s, i) => (sheet.n >= s.first ? i : a), 0);
  const size = whdToWdh(viewer?.size);
  const title = card.data?.title ?? '';

  // --- содержимое листа ---
  let content: React.ReactNode = null;
  if (sheet.section === 'cover') {
    content = (
      <View style={st.cover}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={st.av}><T style={st.avT} color={palette.white}>{initials(workshop?.name)}</T></View>
          <T style={st.c11} numberOfLines={1}>{[workshop?.name, workshop?.city].filter(Boolean).join(' · ')}</T>
        </View>
        <T style={st.coverTitle} numberOfLines={3}>{size ? `${title}\n${size.map(Math.round).join(' × ')}` : title}</T>
        <T style={st.c11} numberOfLines={2}>{[card.data?.client?.name ? t('ds_cover_client', { name: card.data.client.name }) : null,
          t('ds_cover_version', { v: data.version_number }), formatDate(new Date().toISOString(), lang)].filter(Boolean).join(' · ')}</T>
        <View>
          {secs.filter((s) => s.key !== 'cover').map((s) => (
            <View key={s.key + s.first} style={st.tocRow}>
              <T style={st.toc}>{secName(s.key)}</T>
              <T num style={st.toc}>{range(s.first, s.count)}</T>
            </View>
          ))}
        </View>
      </View>
    );
  } else if (sheet.section === 'parts') {
    const parts = sheet.parts.map((n) => partsByNo.get(n)).filter((p): p is ViewerPart => !!p);
    const seen = new Set<string>();
    const shown = parts.filter((p) => { const k = `${p.name}|${Math.round(p.length)}|${Math.round(p.width)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
    content = (
      <View style={st.partsGrid}>
        {shown.map((p) => <MiniPart key={p.number} part={p} w={shown.length > 1 ? 152 : 300} h={shown.length > 2 ? 140 : 280} />)}
      </View>
    );
  } else if (sheet.section === 'cutting') {
    const first = secs.find((s) => s.key === 'cutting')?.first ?? sheet.n;
    const cs = cutSheets[sheet.n - first];
    content = cs ? (
      <View style={{ position: 'absolute', left: 24, right: 24, top: 40 }}>
        <T style={[st.c11, { marginBottom: 8 }]} numberOfLines={1}>{`${cs.materialName} · ${cs.length ?? 2800}×${cs.width ?? 2070}`}</T>
        <CutBoard sheet={cs} height={230} accessibilityLabel={sheet.title} />
      </View>
    ) : null;
  } else if (sheet.section === 'spec') {
    const rows = (viewer?.parts ?? []).slice(0, 14);
    content = (
      <View style={{ position: 'absolute', left: 24, right: 24, top: 30 }}>
        {rows.map((p) => (
          <View key={p.number} style={st.specRow}>
            <T num style={[st.spec, { width: 22 }]}>{String(p.number)}</T>
            <T style={[st.spec, { flex: 1 }]} numberOfLines={1}>{p.name}</T>
            <T num style={st.spec}>{`${Math.round(p.length)}×${Math.round(p.width)}`}</T>
          </View>
        ))}
      </View>
    );
  } else if (sketch) {
    content = <View style={st.sketch}><SketchDrawing sketch={sketch} size={250} /></View>;
  }

  const label = t('ds_page', { n: sheet.n, total, title: sheet.title });
  const footer = locked ? (
    <>
      <T v="cap" style={{ fontSize: 13, lineHeight: 18 }}>{t('files_lock_note')}</T>
      <Button title={t('files_order')} value={t('files_order_val')} onPress={order} />
      <Press onPress={() => Alert.alert(t('files_locked_title'), data.reason ?? '')} accessibilityRole="button" style={st.buy}>
        <T style={st.buyT}>{t('files_buy')}</T>
        <T num style={st.buyV}>{purchase ? t('files_buy_val', { sum: formatMoney(purchase.price, lang) }) : t('files_by_plan')}</T>
      </Press>
    </>
  ) : <Button title={t('ds_share')} icon="share-outline" loading={sharing} onPress={sharePdf} />;

  return (
    <Screen gap={10} contentStyle={{ paddingTop: 4 }} footerBar={locked} footer={footer} footerStyle={locked ? undefined : { paddingTop: 4 }}>
      <Stack.Screen options={{
        header: () => (
          <TitleHeader title={t('ds_title')} compact sub={t('ds_sub', { n: total, w: sheetsWord, v: data.version_number })}
            right={locked ? undefined : <IconButton icon="share-outline" label={t('ds_share_short')} onPress={sharePdf} />} />
        ),
      }} />
      <ScrollView ref={chips} horizontal showsHorizontalScrollIndicator={false} style={st.rowScroll} contentContainerStyle={st.secs}>
        {secs.map((s, i) => (
          <View key={s.key + s.first} onLayout={(e) => { chipX.current[s.first] = e.nativeEvent.layout.x; }}>
            <Press onPress={() => setPg(s.first)} accessibilityRole="button" accessibilityState={{ selected: i === curSec }}
              accessibilityLabel={`${secName(s.key)} ${s.count}`} style={[st.sc, i === curSec && st.scOn]}>
              <T style={[st.scT, i === curSec && { color: palette.white }]}>{secName(s.key)}</T>
              <T num style={[st.scN, i === curSec && { color: '#A9A6A0' }]}>{String(s.count)}</T>
            </Press>
          </View>
        ))}
      </ScrollView>

      <View {...pan.panHandlers}>
        <Press feedback="none" onPress={() => open(sheet)} accessibilityRole="button" accessibilityLabel={label} style={st.page}>
          {content}
          {locked ? <View style={st.lock}><Ionicons name="lock-closed" size={14} color={palette.muted2} /></View> : null}
          <View style={st.stamp}>
            <View style={[st.sc1, st.sb]}><T style={st.st} numberOfLines={2}>{sheet.section === 'cover' ? t('ds_title') : sheet.title}</T></View>
            <View style={[st.sc2, st.sb]}><T style={st.st}>{t('ds_stamp_sheet')}</T></View>
            <View style={[st.sc1]}><T style={st.st} numberOfLines={1}>{workshop?.name ?? 'Eskiz Mebel'}</T></View>
            <View style={[st.sc2]}><T num style={st.st}>{`${sheet.n} / ${total}`}</T></View>
          </View>
          <View pointerEvents="none" style={st.frame} />
        </Press>
      </View>

      <ScrollView ref={strip} horizontal showsHorizontalScrollIndicator={false} style={st.rowScroll} contentContainerStyle={st.strip}>
        {data.sheets.map((s) => {
          const on = s.n === sheet.n;
          return (
            <Press key={s.n} onPress={() => setPg(s.n)} accessibilityRole="button" accessibilityState={{ selected: on }}
              accessibilityLabel={`${t('ds_stamp_sheet')} ${s.n}: ${secName(s.section)}`} style={st.th}>
              <View style={[st.thB, on && st.thOn]}>
                <View style={st.thA} />
                <View style={st.thS} />
              </View>
              <T num style={[st.thT, on && { color: palette.ink, fontWeight: '600' }]}>{String(s.n)}</T>
            </Press>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  rowScroll: { flexGrow: 0, marginHorizontal: -12 },
  secs: { gap: 6, paddingHorizontal: 16 },
  sc: { height: 34, borderRadius: 17, backgroundColor: palette.white, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 5 },
  scOn: { backgroundColor: palette.ink },
  scT: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  scN: { fontSize: 13, lineHeight: 17, color: palette.count },
  page: { height: PAGE_H, borderRadius: 18, backgroundColor: palette.white, marginHorizontal: 2, overflow: 'hidden',
    shadowColor: '#21201F', shadowOpacity: 0.1, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 3 },
  frame: { position: 'absolute', left: 10, right: 10, top: 10, bottom: 10, borderWidth: 1.4, borderColor: palette.ink },
  lock: { position: 'absolute', right: 18, top: 18, width: 26, height: 26, borderRadius: 13, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  stamp: { position: 'absolute', right: 10, bottom: 10, width: 176, height: 56, borderTopWidth: 1.4, borderLeftWidth: 1.4, borderColor: palette.ink,
    flexDirection: 'row', flexWrap: 'wrap', backgroundColor: palette.white },
  sc1: { width: 130, height: 27, borderRightWidth: 1, borderColor: palette.ink, paddingHorizontal: 4, paddingVertical: 3, justifyContent: 'center' },
  sc2: { width: 44.6, height: 27, paddingHorizontal: 4, paddingVertical: 3, justifyContent: 'center' },
  sb: { borderBottomWidth: 1, borderColor: palette.ink },
  st: { fontSize: 9, lineHeight: 11 },
  cover: { position: 'absolute', left: 26, right: 26, top: 30, gap: 14 },
  av: { width: 26, height: 26, borderRadius: 13, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  avT: { fontSize: 10, lineHeight: 12, fontWeight: '700' },
  c11: { fontSize: 11, lineHeight: 15, color: palette.muted },
  coverTitle: { fontSize: 20, lineHeight: 24, fontWeight: '700', letterSpacing: -0.4 },
  tocRow: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderStyle: 'dashed', borderColor: '#E3E0DA', paddingVertical: 2 },
  toc: { fontSize: 12, lineHeight: 17 },
  partsGrid: { position: 'absolute', left: 16, right: 16, top: 18, bottom: 70, flexDirection: 'row', flexWrap: 'wrap', alignContent: 'flex-start', justifyContent: 'center' },
  partNo: { fontSize: 9, lineHeight: 12, color: palette.muted, paddingHorizontal: 6 },
  partBody: { position: 'absolute', backgroundColor: '#F7F2E8', borderWidth: 1.2, borderColor: palette.ink },
  hole: { position: 'absolute', backgroundColor: palette.ink },
  holeBig: { backgroundColor: palette.white, borderWidth: 1, borderColor: palette.ink },
  dim: { position: 'absolute', backgroundColor: BLUE },
  dimT: { position: 'absolute', fontSize: 9, lineHeight: 12, color: BLUE, textAlign: 'center' },
  specRow: { flexDirection: 'row', gap: 6, borderBottomWidth: 1, borderColor: '#EEECE8', paddingVertical: 2 },
  spec: { fontSize: 10, lineHeight: 14 },
  sketch: { position: 'absolute', left: 0, right: 0, top: 36, alignItems: 'center' },
  strip: { gap: 8, paddingHorizontal: 16 },
  th: { width: 66, alignItems: 'center', gap: 4 },
  thB: { width: 66, height: 46, borderRadius: 8, backgroundColor: palette.white, borderWidth: 1.5, borderColor: '#E3E0DA' },
  thOn: { borderWidth: 2.5, borderColor: palette.ink },
  thA: { position: 'absolute', left: 11, right: 11, top: 9, height: 18, borderWidth: 1.5, borderColor: '#C9C6BF', borderRadius: 2 },
  thS: { position: 'absolute', right: 5, bottom: 5, width: 22, height: 8, borderWidth: 1, borderColor: '#C9C6BF' },
  thT: { fontSize: 12, lineHeight: 15, color: palette.muted },
  buy: { height: 50, borderRadius: 16, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  buyT: { fontSize: 17, lineHeight: 22, fontWeight: '500' },
  buyV: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: palette.muted },
});
