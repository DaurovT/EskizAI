/**
 * SCR-48 Стиль фасада (FacadeStyle.dc.html): справа в шапке — материал фасадов; схема фасадов изделия (выбранные — синей
 * рамкой); «Все фасады · N / Этот фасад» (стиль только этих дверей/ящиков/модуля — поле style у них); фрезеровка лентой
 * плиток с превью из API и ценой за фасад; «только по МДФ» — замена в одно касание; накладной декор, рамка или кант
 * с отделкой металла, скругление углов. Снизу — сколько фасадов и сумма по подсказкам цен API, «Применить» — новая версия.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { FrontStylesOut, FrontsStyle, MetalFinish, PriceHint, ProductTree, StylePattern } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { decorById } from '../../../src/lib/catalog';
import { effectiveStyle, frameLen, frontRects, frontScope, inlayOn, isMdf, mdfNeeds, millingOn, needsMdfFix, overlayOn, type FrontRect } from '../../../src/lib/decorStyle';
import { groupDigits, plural } from '../../../src/lib/format';
import { getAt, setAt } from '../../../src/lib/jsonPatch';
import { useOffline } from '../../../src/state/net';
import { useSession } from '../../../src/state/session';
import { showError } from '../../../src/ui/dialogs';
import { DoorPreview, METAL } from '../../../src/ui/DoorPreview';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Button, Loading, Press, Screen, Segmented, T, toast } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

const FINISHES: MetalFinish[] = ['brass', 'gold', 'black', 'chrome'];
const RADII = [0, 4, 12, 30];
const PAINT_DEFAULT = { color: '#F4F4F4', code: 'RAL 9003', system: 'RAL' as const, gloss: 'matte' as const };
const BLUE = '#1F4FBF';

export default function FrontStyle() {
  const { id, part } = useLocalSearchParams<{ id: string; part?: string }>();
  const { t, td, lang } = useT();
  const offline = useOffline();
  const { seesCost } = useSession();
  const model = useResource(() => api.getModel(id), [id]);
  const cat = useResource(() => api.getFrontStyles(), [], { refetchOnFocus: false });
  const [draft, setDraft] = useState<ProductTree | null>(null);
  const [scoped, setScoped] = useState(!!part);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (model.data) setDraft(model.data.version.tree); }, [model.data?.version.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewer = model.data?.version.viewer;
  const rects = useMemo(() => (viewer ? frontRects(viewer.parts) : []), [viewer]);
  // фасад для «Этот фасад»: из 3D (?part=N) или первый, у которого есть свой стиль
  const vp = viewer ? viewer.parts.find((x) => x.number === Number(part)) ?? viewer.parts.find((x) => frontScope(x.key) && (x.role === 'door' || x.role === 'drawer_front')) ?? null : null;
  const scope = vp ? frontScope(vp.key) : null;

  if ((model.loading && !draft) || (cat.loading && !cat.data)) return <Loading />;
  if (!draft || !cat.data) return <ErrorState error={model.error ?? cat.error} onRetry={() => { model.reload(); cat.reload(); }} />;
  const c = cat.data;
  const base = model.data!.version.tree;
  const ptr = scoped && scope ? scope.pointer : null;
  const style = effectiveStyle(draft, ptr);
  const own = ptr ? ((getAt(draft, ptr) as FrontsStyle | null | undefined) ?? null) : null;
  const mat = draft.fronts?.material ?? draft.body?.material ?? null;
  const mdf = isMdf(mat);
  const switchedMdf = mdf && !isMdf(base.fronts?.material ?? base.body?.material);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const inScope = (r: FrontRect) => !ptr || frontScope(r.key)?.pointer === ptr;
  const sel = rects.filter(inScope);
  const n = sel.length;
  const matLabel = mdf ? t('dc_mdf_label') : decorById(mat)?.[lang === 'uz' ? 'name_uz' : 'name'] ?? viewer?.materials[mat ?? '']?.name ?? mat ?? '';
  const doorColor = style.paint && mdf ? style.paint.color : viewer?.materials[mat ?? '']?.color ?? decorById(mat)?.color ?? '#E6D3B1';
  const finish = (style.inlay?.finish ?? 'brass') as MetalFinish;
  const needs = mdfNeeds(style).filter(() => !mdf);
  const needFix = needsMdfFix(draft);

  /** Поле стиля: у всех фасадов — в fronts.style (выкл. — убираем), у «этого фасада» — целиком в его style. */
  const setField = (field: keyof FrontsStyle, value: unknown | null) => {
    if (ptr) {
      const next: Record<string, unknown> = { ...(own ?? {}) };
      const globalOn = !!(draft.fronts?.style as Record<string, unknown> | undefined)?.[field];
      if (value == null && !globalOn) delete next[field];
      else next[field] = value ?? (field === 'inlay' ? { kind: 'none' } : field === 'corners' ? { radius: 0 } : { pattern: 'none' });
      setDraft(setAt(draft, ptr, Object.keys(next).length ? next : null));
    } else {
      const next: Record<string, unknown> = { ...(draft.fronts?.style ?? {}) };
      if (value == null) delete next[field]; else next[field] = value;
      setDraft(setAt(draft, '/fronts/style', next));
    }
  };
  const toMdf = () => {
    let next = setAt(draft, '/fronts/material', c.paint_material);
    if (!next.fronts?.style?.paint) next = setAt(next, '/fronts/style/paint', PAINT_DEFAULT);
    setDraft(next);
  };
  const apply = async () => {
    if (!dirty) return router.back();
    setSaving(true);
    try {
      await api.saveModel(id, { tree: draft, source: 'manual', label: t('dc_applied'), reject_on_errors: true });
      toast.show({ text: t('dc_applied'), tone: 'success' });
      router.back();
    } catch (e) { showError(e, lang); } finally { setSaving(false); }
  };

  // цены — подсказки API (себестоимость за единицу); их видит только тот, кто видит себестоимость
  const hintOf = (h: StylePattern['price_hint'], fin?: string): PriceHint | null =>
    !seesCost || !h ? null : ('price' in h ? (h as PriceHint) : fin ? (h as Record<string, PriceHint | null>)[fin] ?? null : null);
  const kLabel = (h: PriceHint | null) => (!h ? '' : t(h.unit === 'м²' ? 'dc_k_m2' : h.unit === 'м' ? 'dc_k_m' : 'dc_k', { v: groupDigits(Math.round(h.price / 1000)) }));
  const total = seesCost ? styleCost(c, style, sel, finish) : null;
  const pick = <K extends keyof FrontsStyle>(field: K, v: FrontsStyle[K] | null) => setField(field, v);

  const mills: (StylePattern | null)[] = [null, ...c.milling];
  const overlays: (StylePattern | null)[] = [null, ...c.overlay];
  const inlays: (StylePattern | null)[] = [null, ...c.inlay];
  const inlayHint = inlayOn(style) ? hintOf(c.inlay.find((p) => p.id === style.inlay?.kind)?.price_hint ?? null, finish) : null;

  return (
    <Screen gap={8} contentStyle={{ paddingTop: 2 }} footerBar footerStyle={s.bbar}
      footer={
        <>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="cap" style={{ fontSize: 13, lineHeight: 16 }} numberOfLines={1}>{[`${n} ${plural(n, t('dc_fronts'))}`, switchedMdf ? t('dc_with_mdf') : null].filter(Boolean).join(' · ')}</T>
            {total != null ? (
              <T num style={s.total} numberOfLines={1}>{total ? `+ ${groupDigits(total)}` : '0'} <T style={{ fontSize: 15, fontWeight: '400', color: palette.muted }}>{lang === 'uz' ? 'so‘m' : 'сум'}</T></T>
            ) : null}
          </View>
          <Button title={t('bi_apply')} onPress={apply} loading={saving} disabled={dirty && (offline || needFix)} style={{ paddingHorizontal: 26, flexGrow: 0 }} />
        </>
      }>
      <Stack.Screen options={{ title: '', headerRight: () => <View style={s.mat}><T style={s.matT} numberOfLines={1}>{matLabel}</T></View> }} />
      <T style={s.ttl}>{t('dc_title')}</T>

      {/* схема фасадов: выбранные — синей рамкой */}
      <View style={s.hero} accessibilityLabel={t('dc_title')}>
        <FrontsSketch rects={rects} inScope={inScope} color={doorColor} paths={millingOn(style) ? c.milling.find((p) => p.id === style.milling?.pattern)?.preview ?? [] : []} />
        <View style={s.heroTag}><T style={s.heroTagT}>{ptr && scope ? t(scope.kind === 'doors' ? 'dc_scope_doors' : scope.kind === 'drawers' ? 'dc_scope_drawers' : 'dc_scope_module', { n: scope.n }) : t('dc_hero_all', { n, w: plural(n, t('dc_fronts')) })}</T></View>
      </View>
      <Segmented value={scoped && scope ? 'one' : 'all'} onChange={(v) => { if (v === 'one' && !scope) return; setScoped(v === 'one'); }}
        options={[{ value: 'all', label: t('dc_all_n', { n: rects.length }) }, { value: 'one', label: t('dc_one') }]} />

      <View style={s.sh}><T style={s.shT}>{t('dc_tab_milling')}</T>{seesCost ? <T style={s.shS}>{t('dc_per_front')}</T> : null}</View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -12, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
        {mills.map((p) => {
          const on = p ? style.milling?.pattern === p.id : !millingOn(style);
          const h = p ? hintOf(p.price_hint) : null;
          return (
            <Press key={p?.id ?? 'none'} onPress={() => pick('milling', p ? { pattern: p.id, inset: style.milling?.inset ?? p.defaults?.inset ?? 60, width: p.defaults?.width ?? 8, depth: p.defaults?.depth ?? 3, ...(/grooves|waves/.test(p.id) ? { pitch: p.defaults?.pitch ?? 40 } : {}) } : null)}
              accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={p ? td(`dc_m_${p.id}`, p.name) : t('dc_none')} style={[s.tl2, on && s.tl2on]}>
              <View style={s.pv}>{p ? <DoorPreview width={64} height={44} stretch color="#EEE2CC" layers={[{ kind: 'line', paths: p.preview, width: 1.6 }]} style={{ borderWidth: 0, borderRadius: 0 }} /> : null}</View>
              <T style={s.tlB} numberOfLines={1}>{p ? td(`dc_m_${p.id}`, lang === 'uz' ? p.name_uz : p.name) : t('dc_none')}</T>
              <T num style={[s.tlI, { width: 84 }]} numberOfLines={1}>{p ? (h ? kLabel(h) : p.requires.includes('mdf') && !mdf ? t('dc_mdf_tag') : ' ') : t('dc_free')}</T>
            </Press>
          );
        })}
      </ScrollView>

      {needs.length ? (
        <View style={s.ban}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="warning-outline" size={18} color="#6E3C00" />
            <T style={s.banT} numberOfLines={1}>{t('dc_mdf_only', { what: t(needs[0] === 'milling' ? 'dc_what_Milling' : needs[0] === 'paint' ? 'dc_what_Paint' : 'dc_what_Inlay') })}</T>
            <T style={s.banD} numberOfLines={1}>{t('dc_mdf_not')}</T>
          </View>
          <Press onPress={toMdf} accessibilityRole="button" style={s.banBtn}><T style={{ fontSize: 14, fontWeight: '500' }}>{t('dc_mdf_btn')}</T></Press>
        </View>
      ) : null}

      <View style={s.sh}><T style={s.shT}>{t('dc_overlay')}</T></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -12, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
        {overlays.map((p) => {
          const on = p ? style.overlay?.pattern === p.id : !overlayOn(style);
          return (
            <Press key={p?.id ?? 'none'} onPress={() => pick('overlay', p ? { pattern: p.id, profile: style.overlay?.profile ?? p.profiles?.[0] ?? 'flat_20', inset: 50 } : null)}
              accessibilityRole="radio" accessibilityState={{ selected: on }} style={[s.pill, on && s.pillOn]}>
              <T style={[s.pillT, on && { color: palette.white }]}>{p ? td(`dc_ov_${p.id}`, lang === 'uz' ? p.name_uz : p.name) : t('dc_none')}</T>
            </Press>
          );
        })}
      </ScrollView>

      <View style={s.box}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '700' }}>{t('dc_frame')}</T>
          <T v="cap" style={{ fontSize: 13 }}>{!inlayOn(style) ? t('dc_no_frame') : inlayHint ? kLabel(inlayHint) : ''}</T>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -12, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 6 }}>
          {inlays.map((p) => {
            const on = p ? style.inlay?.kind === p.id : !inlayOn(style);
            return (
              <Press key={p?.id ?? 'none'} onPress={() => pick('inlay', p ? { kind: p.id, finish, width: p.id === 'edge' ? 4 : 6, inset: 40 } : null)}
                accessibilityRole="radio" accessibilityState={{ selected: on }} style={[s.pill, { backgroundColor: palette.ground, paddingHorizontal: 12 }, on && s.pillOn]}>
                <T style={[s.pillT, { fontSize: 13 }, on && { color: palette.white }]}>{p ? td(`dc_in_${p.id}`, lang === 'uz' ? p.name_uz : p.name) : t('dc_none')}</T>
              </Press>
            );
          })}
        </ScrollView>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <T v="cap" style={{ fontSize: 13, width: 62 }}>{t('dc_fin')}</T>
          {FINISHES.map((f) => {
            const on = finish === f;
            return (
              <Press key={f} feedback="opacity" onPress={() => (inlayOn(style) ? pick('inlay', { ...style.inlay!, finish: f }) : pick('inlay', { kind: 'frame', finish: f, width: 6, inset: 40 }))}
                accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={t(`dc_f_${f}`)} style={[s.swRing, on && s.swRingOn]}>
                <View style={[s.sw, { backgroundColor: SW[f] }]} />
              </Press>
            );
          })}
          <T style={{ fontSize: 13, fontWeight: '600' }}>{t(`dc_f_${finish}`)}</T>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
        <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '700', flex: 1 }} numberOfLines={1}>{t('dc_rad')}</T>
        {RADII.map((r) => {
          const on = (style.corners?.radius ?? 0) === r;
          return (
            <Press key={r} onPress={() => pick('corners', r ? { radius: r } : null)} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[s.pill, { paddingHorizontal: 11 }, on && s.pillOn]}>
              <T style={[s.pillT, { fontSize: 13 }, on && { color: palette.white }]}>{r ? `R${r}` : t('dc_none')}</T>
            </Press>
          );
        })}
      </View>
    </Screen>
  );
}

/** Цвета плашек отделки — как в макете. */
const SW: Record<string, string> = { brass: '#C9A45C', gold: '#D9B44A', black: '#24231F', chrome: '#C9CDD1', steel: METAL.steel };

/** Сумма по подсказкам цен API: фасад × шт, м² × площадь, м × длина рамки (молдинг — отступ 50, вставка — 40). */
function styleCost(c: FrontStylesOut, st: FrontsStyle, fronts: FrontRect[], finish: string): number {
  const one = (h: StylePattern['price_hint'] | undefined, fin?: string): PriceHint | null =>
    !h ? null : 'price' in h ? (h as PriceHint) : fin ? (h as Record<string, PriceHint | null>)[fin] ?? null : null;
  let sum = 0;
  for (const f of fronts) {
    if (millingOn(st)) {
      const h = one(c.milling.find((p) => p.id === st.milling?.pattern)?.price_hint);
      if (h) sum += h.unit === 'м²' ? (h.price * f.w * f.h) / 1e6 : h.price;
    }
    if (overlayOn(st)) { const h = one(c.overlay.find((p) => p.id === st.overlay?.pattern)?.price_hint); if (h) sum += h.price * frameLen(f.w, f.h, 50); }
    if (inlayOn(st)) {
      const h = one(c.inlay.find((p) => p.id === st.inlay?.kind)?.price_hint, finish);
      const len = st.inlay?.kind === 'line_h' ? f.w / 1000 : st.inlay?.kind === 'line_v' ? f.h / 1000 : frameLen(f.w, f.h, st.inlay?.kind === 'edge' ? 3 : 40);
      if (h) sum += h.price * len;
    }
  }
  return Math.round(sum / 1000) * 1000;
}

/** Схема фасадов спереди (в масштабе): чёрный корпус, фасады цветом плиты, выбранные — синей рамкой, остальные бледные. */
function FrontsSketch({ rects, inScope, color, paths }: { rects: FrontRect[]; inScope: (r: FrontRect) => boolean; color: string; paths: string[] }) {
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map((r) => r.x)), x1 = Math.max(...rects.map((r) => r.x + r.w));
  const z0 = Math.min(...rects.map((r) => r.z)), z1 = Math.max(...rects.map((r) => r.z + r.h));
  const k = Math.min(220 / (x1 - x0), 80 / (z1 - z0));
  const W = (x1 - x0) * k, H = (z1 - z0) * k;
  return (
    <View style={{ width: W + 6, height: H + 6, backgroundColor: palette.ink, padding: 3 }}>
      {rects.map((r) => {
        const on = inScope(r);
        const w = r.w * k - 2, h = r.h * k - 2;
        return (
          <View key={r.key} style={{ position: 'absolute', left: 3 + (r.x - x0) * k + 1, top: 3 + (z1 - r.z - r.h) * k + 1, width: w, height: h, backgroundColor: on ? color : '#EFE8DC', overflow: 'hidden' }}>
            {on && paths.length && w > 8 && h > 8 ? <DoorPreview width={w} height={h} color={color} layers={[{ kind: 'milling', paths }]} style={{ borderWidth: 0, borderRadius: 0 }} /> : null}
            {on ? <View style={[StyleSheet.absoluteFill, { borderWidth: Math.min(w, h) < 24 ? 2 : 3, borderColor: BLUE }]} /> : null}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  mat: { height: 32, borderRadius: 9, backgroundColor: palette.white, paddingHorizontal: 10, justifyContent: 'center', maxWidth: 240 },
  matT: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.muted2 },
  ttl: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.65, paddingHorizontal: 4 },
  hero: { height: 104, borderRadius: 24, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
  heroTag: { position: 'absolute', left: 12, bottom: 12, height: 26, borderRadius: 9, backgroundColor: palette.white, paddingHorizontal: 10, justifyContent: 'center' },
  heroTagT: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: BLUE },
  sh: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 4 },
  shT: { fontSize: 17, lineHeight: 22, fontWeight: '700', letterSpacing: -0.17 },
  shS: { fontSize: 13, fontWeight: '500', color: palette.muted },
  tl2: { width: 76, borderRadius: 16, backgroundColor: palette.white, paddingTop: 6, paddingHorizontal: 6, paddingBottom: 8, gap: 5 },
  tl2on: { borderWidth: 2, borderColor: palette.ink, paddingTop: 4, paddingHorizontal: 4, paddingBottom: 6 },
  pv: { height: 44, borderRadius: 10, backgroundColor: '#EEE2CC', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  tlB: { fontSize: 13, lineHeight: 16, fontWeight: '600' },
  tlI: { fontSize: 12, lineHeight: 14, color: palette.muted },
  ban: { borderRadius: 20, backgroundColor: palette.amberSoft, paddingVertical: 10, paddingRight: 10, paddingLeft: 14, gap: 8, marginTop: -2 },
  banT: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: '#6E3C00', flexShrink: 1 },
  banD: { fontSize: 13, lineHeight: 19, color: '#6E3C00', marginLeft: 'auto' },
  banBtn: { height: 36, borderRadius: 14, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  pill: { height: 36, borderRadius: 19, backgroundColor: palette.white, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: palette.ink },
  pillT: { fontSize: 14, fontWeight: '500' },
  box: { backgroundColor: palette.white, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 12, gap: 8, overflow: 'hidden' },
  swRing: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', margin: -4 },
  swRingOn: { borderWidth: 2, borderColor: palette.ink },
  sw: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)' },
  bbar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 14, paddingHorizontal: 16 },
  total: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 },
});
