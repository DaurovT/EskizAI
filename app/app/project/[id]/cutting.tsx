/**
 * SCR-11 Раскрой (Cutting.dc.html): точный раскрой ядра (GET /projects/{id}/nesting) — лист за листом со схемой,
 * общий % отхода в шапке, список деталей (одинаковые сгруппированы), переход к файлам для распила (SCR-21).
 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { decorById } from '../../../src/lib/catalog';
import { nestingSheets } from '../../../src/lib/cutting';
import { ErrorState } from '../../../src/ui/ErrorState';
import { CutBoard } from '../../../src/ui/SheetLayout';
import { BigTitle, Button, Card, IconButton, Loading, Screen, T } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

export default function Cutting() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const model = useResource(() => api.getModel(id), [id]);
  const nesting = useResource(() => api.getNesting(id), [id]);
  const sheets = useMemo(() => (nesting.data ? nestingSheets(nesting.data) : []), [nesting.data]);
  const [idx, setIdx] = useState(0);

  // общий отход по всем листам
  const waste = useMemo(() => {
    const area = sheets.reduce((s, x) => s + (x.length ?? 2800) * (x.width ?? 2070), 0);
    const used = sheets.reduce((s, x) => s + x.usedArea, 0);
    return area ? Math.round((1 - used / area) * 100) : null;
  }, [sheets]);

  // детали: одинаковые (название + размер + материал) — одной строкой «×N»
  const parts = useMemo(() => {
    const v = model.data?.version.viewer;
    if (!v) return [];
    const m = new Map<string, { name: string; l: number; w: number; mat: string; n: number }>();
    for (const p of v.parts) {
      const l = Math.round(p.length), w = Math.round(p.width);
      const mat = (lang === 'uz' ? decorById(p.material)?.name_uz : null) ?? v.materials[p.material]?.name ?? p.material;
      const k = `${p.name}|${l}|${w}|${p.material}`;
      const cur = m.get(k);
      if (cur) cur.n += 1; else m.set(k, { name: p.name, l, w, mat, n: 1 });
    }
    return [...m.values()];
  }, [model.data, lang]);
  const total = model.data?.version.viewer.parts.length ?? 0;

  if ((nesting.loading && !nesting.data) || (model.loading && !model.data)) return <Loading />;
  if (!nesting.data) return <ErrorState error={nesting.error} onRetry={nesting.reload} />;
  const i = Math.min(idx, Math.max(0, sheets.length - 1));
  const s = sheets[i];

  return (
    <Screen gap={8} contentStyle={{ paddingTop: 0 }} footer={
      <Button title={t('cut_files')} iconNode={<MaterialCommunityIcons name="arrow-collapse-down" size={20} color={palette.white} />} onPress={() => router.push(`/project/${id}/files`)} />
    }>
      <Stack.Screen options={{
        title: '',
        headerRight: waste != null ? () => (
          <View style={st.waste}><T num style={st.wasteT}>{t('files_waste', { p: waste })}</T></View>
        ) : undefined,
      }} />
      <BigTitle style={{ paddingTop: 0 }}>{t('cut_title')}</BigTitle>

      {s ? (
        <Card style={{ paddingTop: 14, paddingHorizontal: 12, paddingBottom: 12 }} padded={false}>
          <View style={st.sheetHead}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T v="rt" style={{ fontWeight: '600' }}>{t('cut_sheet', { i: i + 1, n: sheets.length })}</T>
              <T v="rs" num numberOfLines={1}>{`${s.materialName} · ${s.length ?? 2800}×${s.width ?? 2070}`}</T>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <IconButton icon="chevron-back" iconSize={20} label={t('cut_prev')} disabled={i === 0} onPress={() => setIdx(i - 1)} />
              <IconButton icon="chevron-forward" iconSize={20} label={t('cut_next')} disabled={i >= sheets.length - 1} onPress={() => setIdx(i + 1)} />
            </View>
          </View>
          <CutBoard sheet={s} accessibilityLabel={t('cut_board', { l: s.length ?? 2800, w: s.width ?? 2070 })} />
          <T v="cap" style={{ paddingTop: 10, paddingHorizontal: 8 }}>{t('cut_note', { kerf: nesting.data.kerf })}</T>
          {nesting.data.unplaced.length ? (
            <T v="cap" color={palette.redText} style={{ paddingTop: 4, paddingHorizontal: 8 }}>
              {t('files_unplaced', { list: nesting.data.unplaced.map((u) => u.number).join(', ') })}
            </T>
          ) : null}
        </Card>
      ) : null}

      {parts.length ? (
        <>
          <T style={st.sh}>{t('cut_parts')} <T style={[st.sh, st.sum]}>{t('cut_pcs', { n: total })}</T></T>
          <Card padded={false}>
            {parts.map((p, k) => (
              <View key={`${p.name}-${p.l}-${p.w}-${p.mat}`} style={[st.ln, k > 0 && st.sep]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="rt" numberOfLines={1}>{p.name}</T>
                  <T v="rs" numberOfLines={1}>{p.mat}</T>
                </View>
                <T v="rv" num>{`${p.l}×${p.w}`}{p.n > 1 ? <T v="rv" num style={st.sum}>{` ×${p.n}`}</T> : null}</T>
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const st = StyleSheet.create({
  waste: { height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: palette.white, justifyContent: 'center' },
  wasteT: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.muted2 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 8, paddingRight: 4, paddingBottom: 12 },
  sh: { fontSize: 19, lineHeight: 24, fontWeight: '700', letterSpacing: -0.29, paddingTop: 6, paddingHorizontal: 8 },
  sum: { fontWeight: '500', color: palette.muted, paddingTop: 0, paddingHorizontal: 0 },
  ln: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 54, paddingVertical: 8, paddingHorizontal: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
});
