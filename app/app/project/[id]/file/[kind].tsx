/**
 * SCR-36 Просмотр файлов (FileViewer.dc.html): вкладки «Чертежи · Спецификация · Раскрой · Сборка», чертёж детали
 * с размерами и присадкой (листание по деталям, масштаб), таблица спецификации, карты раскроя.
 * Файл скачивается в кэш и отправляется ФАЙЛОМ через системное меню «Поделиться» (expo-sharing), не ссылкой.
 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, PanResponder, StyleSheet, View } from 'react-native';
import { api } from '../../../../src/api';
import { useResource } from '../../../../src/hooks/useResource';
import { useT } from '../../../../src/i18n';
import { decorById } from '../../../../src/lib/catalog';
import { nestingSheets, parseCsv } from '../../../../src/lib/cutting';
import { mimeOf, utiOf } from '../../../../src/lib/files';
import { showError } from '../../../../src/ui/dialogs';
import { ErrorState } from '../../../../src/ui/ErrorState';
import { PartDrawing } from '../../../../src/ui/PartDrawing';
import { CutBoard } from '../../../../src/ui/SheetLayout';
import { BigTitle, Button, ButtonRow, Card, Chip, ChipRow, Loading, Press, Screen, T } from '../../../../src/ui/kit';
import { palette } from '../../../../src/ui/theme';

type Tab = 'drawings' | 'spec' | 'cut' | 'assembly';
const TABS: { key: Tab; re: RegExp }[] = [
  { key: 'drawings', re: /drawing|dxf/ }, { key: 'spec', re: /spec/ }, { key: 'cut', re: /cut|nesting/ }, { key: 'assembly', re: /assembl/ },
];
const tabOf = (kind: string): Tab | null => TABS.find((x) => x.re.test(kind))?.key ?? null;

export default function FileViewer() {
  const { id, kind, title } = useLocalSearchParams<{ id: string; kind: string; title?: string }>();
  const { t, lang } = useT();
  const file = useResource(() => api.downloadFile(id, kind), [id, kind]);
  const files = useResource(() => api.listFiles(id), [id]);
  const model = useResource(() => api.getModel(id), [id]);
  const tab = tabOf(kind);
  const nesting = useResource(() => (tab === 'cut' ? api.getNesting(id) : Promise.resolve(null)), [id, tab]);
  const [csv, setCsv] = useState<string[][] | null>(null);
  const [partIdx, setPartIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const isCsv = file.data?.mimeType === 'text/csv' || kind.endsWith('csv');

  useEffect(() => {
    if (isCsv && file.data?.uri && !file.data.uri.startsWith('data:')) {
      FileSystem.readAsStringAsync(file.data.uri).then((s) => setCsv(parseCsv(s))).catch(() => undefined);
    }
  }, [isCsv, file.data]);

  const share = async () => {
    if (!file.data) return;
    try {
      if (!(await Sharing.isAvailableAsync())) return Alert.alert(t('fv_share_unavailable'));
      // Файл уже лежит в кэше под именем с сервера («Шкаф_Азиза_спецификация_v3.pdf») — оно и уйдёт в Telegram
      const mime = mimeOf(file.data.mimeType, file.data.name);
      await Sharing.shareAsync(file.data.uri, { mimeType: mime, dialogTitle: file.data.name, UTI: utiOf(mime) });
    } catch (e) { showError(e, lang); }
  };

  // вкладки — только по доступным файлам пакета
  const tabs = useMemo(() => TABS.map((x) => ({ ...x, file: (files.data ?? []).find((f) => f.available && x.re.test(f.kind)) }))
    .filter((x) => x.file || x.key === tab), [files.data, tab]);

  const viewer = model.data?.version.viewer;
  const parts = viewer?.parts ?? [];
  const pi = Math.min(partIdx, Math.max(0, parts.length - 1));
  const part = parts[pi];
  const go = (d: number) => { setPartIdx(Math.max(0, Math.min(parts.length - 1, pi + d))); setZoom(1); };
  const goRef = useRef(go);
  goRef.current = go;
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_, g) => { if (g.dx < -50) goRef.current(1); else if (g.dx > 50) goRef.current(-1); },
  })).current;

  // спецификация: одинаковые детали одной строкой
  const spec = useMemo(() => {
    const m = new Map<string, { n: number; name: string; size: string; q: number }>();
    for (const p of parts) {
      const size = `${Math.round(p.length)}×${Math.round(p.width)}`;
      const key = `${p.name}|${size}|${p.material}`;
      const cur = m.get(key);
      if (cur) cur.q += 1; else m.set(key, { n: p.number, name: p.name, size, q: 1 });
    }
    return [...m.values()];
  }, [parts]);

  const heading = tab ? t(`fv_tab_${tab}` as 'fv_tab_drawings') : title ?? t('fv_title');
  const matName = (m: string) => (lang === 'uz' ? decorById(m)?.name_uz : null) ?? viewer?.materials[m]?.name ?? m;

  let body: React.ReactNode = null;
  if (file.error && !file.data) body = <ErrorState error={file.error} onRetry={file.reload} />;
  else if (!viewer) body = model.error ? <ErrorState error={model.error} onRetry={model.reload} /> : <Loading label={t('fv_downloading')} />;
  else if (tab === 'drawings' && part) {
    body = (
      <>
        <View style={{ flex: 1 }} {...pan.panHandlers}>
          <PartDrawing part={part} zoom={zoom} onZoom={setZoom} title={`№ ${part.number} · ${part.name} · ${matName(part.material)}`} />
        </View>
        <View style={st.pager}>
          <T v="cap" num>{t('fv_part_n', { i: pi + 1, n: parts.length })}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <T v="cap">{`${t('fv_swipe')} `}</T>
            <Press feedback="opacity" onPress={() => go(-1)} accessibilityRole="button" accessibilityLabel={t('fv_prev_part')} hitSlop={10}><T v="cap">‹</T></Press>
            <T v="cap"> </T>
            <Press feedback="opacity" onPress={() => go(1)} accessibilityRole="button" accessibilityLabel={t('fv_next_part')} hitSlop={10}><T v="cap">›</T></Press>
          </View>
        </View>
      </>
    );
  } else if (tab === 'spec' || isCsv) {
    const rows = tab === 'spec' || !csv
      ? spec.map((r) => [String(r.n), r.name, r.size, String(r.q)])
      : csv.slice(1).map((r) => [r[0] ?? '', r[1] ?? '', `${r[3] ?? ''}×${r[4] ?? ''}`, '1']);
    body = (
      <Card padded={false}>
        <View style={[st.sr, { minHeight: 40 }]}>
          {[t('fv_col_n'), t('fv_col_part'), t('fv_col_size'), t('fv_col_qty')].map((h, i) => <T key={i} v="lbl" style={COLS[i]}>{h}</T>)}
        </View>
        {rows.map((r, i) => (
          <View key={i} style={[st.sr, st.sep]}>
            <T num style={[COLS[0], st.mono]}>{r[0]}</T>
            <T style={[COLS[1], { fontSize: 15, lineHeight: 20, fontWeight: '500' }]} numberOfLines={2}>{r[1]}</T>
            <T num style={[COLS[2], st.mono]}>{r[2]}</T>
            <T num style={[COLS[3], st.mono]}>{r[3]}</T>
          </View>
        ))}
      </Card>
    );
  } else if (tab === 'cut') {
    const sheets = nesting.data ? nestingSheets(nesting.data) : [];
    body = nesting.loading && !nesting.data ? <Loading /> : sheets.map((s, i) => (
      <Card key={i} style={{ paddingTop: 14, paddingHorizontal: 12, paddingBottom: 12 }} padded={false}>
        <View style={{ paddingLeft: 8, paddingBottom: 12 }}>
          <T v="rt" style={{ fontWeight: '600' }}>{t('cut_sheet', { i: i + 1, n: sheets.length })}</T>
          <T v="rs" num>{`${s.materialName} · ${s.length ?? 2800}×${s.width ?? 2070}`}</T>
        </View>
        <CutBoard sheet={s} accessibilityLabel={t('cut_board', { l: s.length ?? 2800, w: s.width ?? 2070 })} />
      </Card>
    ));
  } else {
    body = (
      <Card>
        <T v="rt" style={{ fontWeight: '600' }}>{file.data?.name ?? title ?? kind}</T>
        <T v="rs" style={{ marginTop: 4 }}>{t('fv_no_preview')}</T>
        <T v="cap" style={{ marginTop: 8 }}>{t('fv_share_note')}</T>
      </Card>
    );
  }

  return (
    <Screen gap={0} contentStyle={{ paddingTop: 0 }} footer={
      <ButtonRow>
        <Button v="secondary" title={t('fv_download')} iconNode={<MaterialCommunityIcons name="arrow-collapse-down" size={20} color={palette.ink} />}
          onPress={share} disabled={!file.data} style={{ paddingHorizontal: 18 }} />
        <Button title={t('fv_tg')} icon="paper-plane-outline" onPress={share} disabled={!file.data} loading={file.loading && !file.data} style={{ flex: 1 }} />
      </ButtonRow>
    }>
      <Stack.Screen options={{
        title: '',
        headerRight: () => <Button v="secondary" small icon="share-outline" title={t('fv_share_short')} onPress={share} disabled={!file.data} style={{ borderRadius: 22 }} />,
      }} />
      <BigTitle style={{ paddingTop: 0, paddingBottom: 8 }}>{heading}</BigTitle>
      {tabs.length > 1 ? (
        <ChipRow>
          {tabs.map((x) => (
            <Chip key={x.key} label={t(`fv_tab_${x.key}` as 'fv_tab_drawings')} selected={x.key === tab}
              onPress={() => x.file && x.key !== tab && router.setParams({ kind: x.file.kind, title: x.file.title ?? x.file.kind })} />
          ))}
        </ChipRow>
      ) : null}
      <View style={{ flex: 1, gap: 8, paddingTop: 10 }}>{body}</View>
    </Screen>
  );
}

const COLS = [{ width: 24 }, { flex: 1, minWidth: 0 }, { width: 96 }, { width: 24 }] as const;
const st = StyleSheet.create({
  pager: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  sr: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 18 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  mono: { fontSize: 13, lineHeight: 18 },
});
