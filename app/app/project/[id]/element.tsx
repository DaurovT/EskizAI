/**
 * SCR-25 Деталь (Element.dc.html): 3D сверху с подсвеченной деталью и её размером, шапка «назад» + название детали,
 * вкладки «Деталь / Секция N», снизу белая панель: размеры (±10), чистовой размер и распил, кромка по сторонам,
 * присадка и фурнитура секции, габарит изделия (GET /parts/{n}), материал → Декор, «Форма детали» (правка словами
 * в чате), исполнитель. Свайп «назад» выключен — горизонтальный жест вращает 3D. Вкладка секции — параметры секции (ширина, полки, ящики, двери) с сохранением как в редакторе.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../../src/api';
import type { ModelStateOut, PartOut, ProductTree } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { getAt, setAt } from '../../../src/lib/jsonPatch';
import { effectiveStyle, frontScope, inlayOn, isMdf, millingOn } from '../../../src/lib/decorStyle';
import { isEstimated, paramFields, sectionFields, sectionOfPart, withoutConfirmed, type ParamField } from '../../../src/lib/tree';
import { confirmPointer, useMeta } from '../../../src/state/projectMeta';
import { useOffline } from '../../../src/state/net';
import { ProductCanvas } from '../../../src/three/ProductCanvas';
import { errorInfo } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { IconButton, Loading, Press, SurfaceProvider, T, resolveFont } from '../../../src/ui/kit';
import { palette, type as ty } from '../../../src/ui/theme';

const SAVE_DEBOUNCE = 700;

export default function Element() {
  const { id, n, shot } = useLocalSearchParams<{ id: string; n?: string; shot?: string }>();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const offline = useOffline();
  const meta = useMeta(id);
  const model = useResource(() => api.getModel(id), [id]);
  const [state, setState] = useState<ModelStateOut | null>(null);
  const [draft, setDraft] = useState<ProductTree | null>(null);
  const [tab, setTab] = useState<'part' | 'section'>('part');
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<ProductTree | null>(null);
  useEffect(() => { if (model.data) { setState(model.data); setDraft(model.data.version.tree); } }, [model.data]);
  // распил, кромка, присадка — по текущей версии (после правки ±10 — заново)
  const [info, setInfo] = useState<PartOut | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const save = useCallback(async (tree: ProductTree) => {
    try {
      const s = await api.saveModel(id, { tree, source: 'manual' });
      setState(s);
      setDraft(s.version.tree);
    } catch (e) {
      const info = errorInfo(e, lang);
      Alert.alert(info.title, info.text);
      if (state) setDraft(state.version.tree);
    }
  }, [id, state, lang]);
  const edit = (f: ParamField, v: number | null) => {
    if (!draft) return;
    const next = setAt(draft, f.pointer, v);
    setDraft(next);
    latest.current = next;
    confirmPointer(id, f.pointer);
    setConfirmed((c) => [...c, f.pointer]);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current && save(latest.current), SAVE_DEBOUNCE);
  };

  const partNo = state ? (state.version.viewer.parts.find((p) => p.number === Number(n)) ?? (shot ? state.version.viewer.parts.find((p) => /side|бок/i.test(`${p.role} ${p.name}`)) : null))?.number ?? null : null;
  useEffect(() => {
    if (partNo == null) return;
    let alive = true;
    api.getPart(id, partNo).then((x) => { if (alive) setInfo(x); }).catch(() => undefined);
    return () => { alive = false; };
  }, [id, partNo, state?.version.id]);

  if (model.loading && !state) return <Loading />;
  if (!state || !draft) return <ErrorState error={model.error} onRetry={model.reload} />;
  const v = state.version;
  const parts = v.viewer.parts;
  const part = parts.find((p) => p.number === Number(n)) ?? (shot ? parts.find((p) => /side|бок/i.test(`${p.role} ${p.name}`)) ?? parts[0] : null);
  if (!part) return <ErrorState error={new Error(t('ed_tap_part'))} onRetry={() => router.back()} />;
  const sec = sectionOfPart(part.key);
  const estimated = withoutConfirmed(v.estimated ?? meta.estimated, confirmed);
  // боковина — её высота и глубина = высота и глубина изделия
  const side = /side|бок/i.test(`${part.role} ${part.name}`) && !/drawer|ящик/i.test(`${part.key} ${part.name}`);
  const own = side ? paramFields(draft).filter((f) => f.pointer === '/height' || f.pointer === '/depth') : [];
  const secFields = sec != null ? sectionFields(draft, sec) : [];
  const mat = v.viewer.materials[part.material]?.name ?? part.material;
  const tabs: { key: 'part' | 'section'; label: string }[] = [{ key: 'part', label: part.name.split(' ')[0] || t('el_part_tab') }];
  if (secFields.length) tabs.push({ key: 'section', label: t('ed_section', { n: (sec ?? 0) + 1 }) });
  const ask = (op: string) => router.navigate({ pathname: '/project/[id]/editor', params: { id, ask: `${t('el_ask_prefix', { n: part.number, name: part.name })}${op.toLowerCase()} ` } });
  const top = insets.top;

  const box = (f: ParamField) => (
    <NumBox key={f.pointer} label={t(f.label)} value={(getAt(draft, f.pointer) as number | null | undefined) ?? null} step={f.step} min={f.min} max={f.max}
      unit={f.step === 10 && !side ? t('mm') : undefined} est={isEstimated(f.pointer, estimated)} disabled={offline} autoLabel={t('el_auto')}
      onChange={(val) => edit(f, val)} />
  );
  const pairs = (fs: ParamField[]) => {
    const rows: ParamField[][] = [];
    for (let i = 0; i < fs.length; i += 2) rows.push(fs.slice(i, i + 2));
    return rows.map((r, i) => <View key={i} style={{ flexDirection: 'row', gap: 8 }}>{r.map(box)}</View>);
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View style={{ position: 'absolute', left: 0, right: 0, top: top + 100, height: 170 }}>
        <ProductCanvas model={v.viewer} selectedPart={part.number} fallbackText={t('ed_3d_unavailable')} background={palette.ground} />
      </View>
      <View style={[s.dimc, { top: top + 70, alignSelf: 'center' }]} pointerEvents="none">
        <T num style={{ fontSize: 15, fontWeight: '600', color: palette.blue }}>{Math.round(part.length)}</T>
        <T style={{ fontSize: 13, color: palette.blue, opacity: 0.7 }}>{t('mm')}</T>
      </View>
      <View style={[s.hdr, { marginTop: top }]}>
        <IconButton icon="chevron-back" label={t('back')} onPress={() => router.back()} style={s.lift} />
        <View style={[s.tpill, s.lift]}>
          <T style={{ fontSize: 15, lineHeight: 19, fontWeight: '600' }} numberOfLines={1}>{tab === 'section' ? t('ed_section', { n: (sec ?? 0) + 1 }) : part.name}</T>
          <T style={{ fontSize: 13, lineHeight: 16, color: palette.muted }} numberOfLines={1}>{tab === 'section' ? t('el_section_sub') : t('el_part_n', { n: part.number })}</T>
        </View>
        <View style={{ width: 44 }} />
      </View>
      <View style={[s.tabs, { top: top + 276 }]}>
        {tabs.map((x) => (
          <Press key={x.key} onPress={() => setTab(x.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === x.key }} style={[s.tab, tab === x.key && { backgroundColor: palette.ink }]}>
            <T style={{ fontSize: 15, fontWeight: '500', color: tab === x.key ? palette.white : palette.ink }}>{x.label}</T>
          </Press>
        ))}
      </View>
      <View style={[s.es, { top: top + 334 }]}>
        <SurfaceProvider value="white">
          <ScrollView contentContainerStyle={{ paddingTop: 12, paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 20), gap: 10 }}>
            {tab === 'part' ? (
              <>
                {own.length ? pairs(own) : (
                  <View style={s.kv}>
                    <T style={s.k}>{t('el_size')}</T>
                    <T num style={s.v}>{`${Math.round(part.length)} × ${Math.round(part.width)} × ${part.thickness} ${t('mm')}`}</T>
                  </View>
                )}
                {own.length ? (
                  <View style={s.kvs}>
                    <T style={s.k}>{t('el_finish')}</T>
                    <T num style={s.v}>{`${mm1(part.length)} × ${mm1(part.width)} × ${mm1(part.thickness)} ${t('mm')}`}</T>
                  </View>
                ) : null}
                {['door', 'drawer_front'].includes(part.role) ? <FrontStyleBlock id={id} tree={draft} partKey={part.key} partNo={part.number} /> : null}
                <View style={s.kvs}>
                  <T style={s.k}>{t('el_cut')}</T>
                  <T num style={s.v}>{info ? `${mm1(info.cut_length_mm)} × ${mm1(info.cut_width_mm)} ${t('mm')}` : '…'}</T>
                </View>
                <View style={s.kvs}>
                  <T style={s.k}>{`${t('el_edges')} · ${t('el_edge_long')}`}</T>
                  <T num style={s.v}>{info ? edgeText(info, ['y0', 'y1'], t('mm')) : '…'}</T>
                </View>
                <View style={s.kvs}>
                  <T style={s.k}>{`${t('el_edges')} · ${t('el_edge_short')}`}</T>
                  <T num style={s.v}>{info ? edgeText(info, ['x0', 'x1'], t('mm')) : '…'}</T>
                </View>
                {info?.holes.length ? (
                  <View style={s.kvs}>
                    <T style={s.k}>{t('el_holes')}</T>
                    <T num style={[s.v, { flexShrink: 1 }]}>{info.holes.map((h) => t('el_holes_n', { n: h.count, d: mm1(h.diameter_mm) })).join(' · ')}</T>
                  </View>
                ) : null}
                {info?.hardware.length ? (
                  <View style={[s.kvs, { alignItems: 'flex-start', paddingVertical: 12 }]}>
                    <T style={s.k}>{t('el_hw')}</T>
                    <View style={{ flexShrink: 1, alignItems: 'flex-end', gap: 2 }}>
                      {info.hardware.slice(0, 6).map((h) => <T key={`${h.kind}${h.name}`} style={{ fontSize: 15, textAlign: 'right' }} numberOfLines={1}>{`${h.name} × ${h.qty}`}</T>)}
                    </View>
                  </View>
                ) : null}
                <View style={s.kvs}>
                  <T style={s.k}>{t('el_product')}</T>
                  <T num style={s.v}>{`${v.viewer.size.slice(0, 3).map(mm1).join(' × ')} ${t('mm')}`}</T>
                </View>
                <Press feedback="row" onPress={() => router.push(`/project/${id}/materials`)} accessibilityRole="button" style={[s.fld, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                  <View style={{ flex: 1 }}>
                    <T v="fl">{t('el_material')}</T>
                    <T v="fv" numberOfLines={1}>{mat}</T>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={palette.chev} />
                </Press>
                <T style={{ fontSize: 17, lineHeight: 22, fontWeight: '700', marginTop: 2 }}>{t('el_shape')}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {t('el_ops').split('|').map((op) => (
                    <Press key={op} onPress={() => ask(op)} accessibilityRole="button" style={s.op}>
                      <Ionicons name="add" size={16} color={palette.ink} />
                      <T style={{ fontSize: 14, fontWeight: '500' }}>{op}</T>
                    </Press>
                  ))}
                </View>
                <View style={s.kv}>
                  <T style={s.k}>{t('el_exec')}</T>
                  <View style={s.exec}><T style={{ fontSize: 15, fontWeight: '600', color: palette.greenDeep }}>{t('el_exec_eman')}</T></View>
                </View>
              </>
            ) : pairs(secFields)}
          </ScrollView>
        </SurfaceProvider>
      </View>
    </View>
  );
}

/** мм с одним знаком: 0,4 / 1 196,5 */
const mm1 = (x: number) => String(Math.round(x * 10) / 10).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function edgeText(info: PartOut, sides: [string, string], unit: string): string {
  const v = sides.map((sd) => info.edges.find((e) => e.side === sd)?.thickness_mm ?? 0);
  if (!v[0] && !v[1]) return '—';
  return `${v.map((x) => (x ? mm1(x) : '—')).join(' / ')} ${unit}`;
}

/** .fld.g + .numf: серое поле с подписью, «−10 / +10» белыми кнопками (у счётчиков «− / +»), значение 24/600 по центру. */
function NumBox({ label, value, step, min, max, unit, est, disabled, autoLabel, onChange }: {
  label: string; value: number | null; step: number; min: number; max: number; unit?: string; est: boolean; disabled: boolean; autoLabel: string;
  onChange: (v: number | null) => void;
}) {
  const big = step >= 10;
  const set = (d: number) => onChange(Math.min(max, Math.max(min, (value ?? (d > 0 ? min : max)) + d)));
  return (
    <View style={[s.fld, { flex: 1, minWidth: 0, paddingHorizontal: 8 }]}>
      {est ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 16, borderWidth: 2, borderColor: '#F3CF8F' }]} /> : null}
      <T v="fl" style={{ paddingHorizontal: 8 }}>{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
        <Press onPress={() => set(-step)} disabled={disabled} accessibilityRole="button" accessibilityLabel={`${label} −${step}`} style={s.pm}>
          <T style={{ fontSize: big ? 15 : 20, fontWeight: '500' }}>{big ? `−${step}` : '−'}</T>
        </Press>
        <Text style={resolveFont([ty.num, { flex: 1, fontSize: 24, lineHeight: 28, fontWeight: '600', textAlign: 'center', color: palette.ink }])} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{value == null ? autoLabel : `${value}`}</Text>
        {unit ? <T v="cap">{unit}</T> : null}
        <Press onPress={() => set(step)} disabled={disabled} accessibilityRole="button" accessibilityLabel={`${label} +${step}`} style={s.pm}>
          <T style={{ fontSize: big ? 15 : 20, fontWeight: '500' }}>{big ? `+${step}` : '+'}</T>
        </Press>
      </View>
    </View>
  );
}

const lift = { shadowColor: palette.ink, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 };
const s = StyleSheet.create({
  lift,
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, minHeight: 72 },
  tpill: { flex: 1, minWidth: 0, height: 44, borderRadius: 22, backgroundColor: palette.white, justifyContent: 'center', paddingHorizontal: 16 },
  dimc: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 3, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: palette.white, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  tabs: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', gap: 8 },
  tab: { height: 40, borderRadius: 20, backgroundColor: palette.white, paddingHorizontal: 16, justifyContent: 'center', shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  es: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: palette.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: -4 }, elevation: 8 },
  fld: { backgroundColor: palette.ground, borderRadius: 16, minHeight: 60, paddingVertical: 9, paddingHorizontal: 16, justifyContent: 'center' },
  pm: { width: 46, height: 40, borderRadius: 12, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  op: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 12, borderRadius: 20, backgroundColor: palette.ground },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  kvs: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 32 },
  k: { flex: 1, fontSize: 16, color: palette.muted },
  v: { fontSize: 16, fontWeight: '500', textAlign: 'right' },
  exec: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 26, paddingHorizontal: 10, borderRadius: 9, backgroundColor: palette.greenSoft },
});

/** Element.dc.html, дверь: «Стиль этого фасада» — фрезеровка, рамка, цвет, углы, ручка; «Изменить» → SCR-48 / материалы / SCR-26. */
function FrontStyleBlock({ id, tree, partKey, partNo }: { id: string; tree: ProductTree; partKey: string; partNo: number }) {
  const { t, td } = useT();
  const sc = frontScope(partKey);
  const st = effectiveStyle(tree, sc?.pointer);
  const mdf = isMdf(tree.fronts?.material);
  const toStyle = () => router.push({ pathname: '/project/[id]/front-style', params: { id, ...(sc ? { part: String(partNo) } : {}) } });
  const h = tree.fronts?.handles;
  const rows: { icon: ReactNode; k: string; v: string; go: () => void }[] = [
    { icon: <View style={fs.ic}><View style={fs.icIn} /></View>, k: t('dc_tab_milling'), v: millingOn(st) ? td(`dc_m_${st.milling!.pattern}`, st.milling!.pattern) : t('dc_no'), go: toStyle },
    { icon: <View style={[fs.ic, { borderColor: '#B9923F', borderWidth: 2.4 }]} />, k: t('dc_frame').split(' ')[0], v: inlayOn(st) ? `${t(`dc_f_${(st.inlay!.finish ?? 'brass') as 'brass'}`)}, ${td(`dc_in_${st.inlay!.kind}`, st.inlay!.kind).toLowerCase()}` : t('dc_no'), go: toStyle },
    { icon: <View style={[fs.dot, { backgroundColor: st.paint?.color ?? '#F1ECE1' }]} />, k: t('dc_tab_color'), v: st.paint && mdf ? `${st.paint.code}` : t('dc_paint_none').split(' — ')[0], go: () => router.push({ pathname: '/project/[id]/materials', params: { id, tab: 'color' } }) },
    { icon: <View style={fs.corner} />, k: t('dc_rad'), v: st.corners?.radius ? `R${st.corners.radius}` : t('dc_no'), go: toStyle },
    { icon: <Ionicons name="reorder-two-outline" size={18} color={palette.ink} style={{ transform: [{ rotate: '90deg' }] }} />, k: t('ed2_m_hw'), v: h?.kind === 'none' ? 'Push' : td(`hw3_h_${h?.kind === 'bar' || !h?.kind ? `bar_${h?.spacing ?? 128}` : h.kind}`, h?.kind ?? ''), go: () => router.push(`/project/${id}/hardware`) },
  ];
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <T style={{ fontSize: 17, lineHeight: 22, fontWeight: '700' }}>{t('dc_this_front')}</T>
        <View style={[fs.tag, { backgroundColor: mdf ? palette.amberSoft : palette.ground }]}><T style={{ fontSize: 13, fontWeight: '600', color: mdf ? '#8A4B00' : palette.muted2 }}>{mdf ? t('dc_mdf_label') : (tree.fronts?.material ?? '')}</T></View>
      </View>
      <View>
        {rows.map((r, i) => (
          <Press key={r.k} feedback="row" onPress={r.go} accessibilityRole="button" style={[s.kv, i > 0 && { borderTopWidth: 1, borderTopColor: palette.hair }]}>
            <View style={{ width: 28, alignItems: 'center' }}>{r.icon}</View>
            <T style={s.k} numberOfLines={1}>{r.k}</T>
            <T style={[s.v, { flexShrink: 1 }]} numberOfLines={1}>{r.v}</T>
            <T style={{ fontSize: 14, fontWeight: '600', color: palette.greenPress, marginLeft: 4 }}>{t('ed3_change')}</T>
          </Press>
        ))}
      </View>
    </>
  );
}
const fs = StyleSheet.create({
  ic: { width: 20, height: 24, borderRadius: 2, borderWidth: 1.6, borderColor: palette.ink, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  icIn: { width: 12, height: 16, borderRadius: 1, borderWidth: 1.4, borderColor: palette.ink },
  dot: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: 'rgba(33,32,31,0.2)' },
  corner: { width: 18, height: 22, borderTopLeftRadius: 8, borderTopWidth: 1.8, borderLeftWidth: 1.8, borderColor: palette.ink },
  tag: { height: 26, borderRadius: 9, paddingHorizontal: 10, justifyContent: 'center' },
});
