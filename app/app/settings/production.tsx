/**
 * SCR-56 Производство цеха (ShopProduction.dc.html, владелец): крепёж корпуса (конфирмат / шкант), глубина
 * конфирмата в торец, марка петель со схемой планки и чашки, сетка 32 мм полкодержателей. Значения уходят
 * на сервер (PATCH /workshops/me/production) и попадают в присадку новых версий, чертежи, комплект, DXF и смету.
 * Сохраняется кнопкой «Сохранить»; уйти с несохранёнными правками — спросить.
 */
import { Stack, router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import type { ConfirmatDepth, HingeBrandInfo, ProductionOut, ProductionSettings } from '../../src/api/types';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { showError } from '../../src/ui/dialogs';
import { ErrorState } from '../../src/ui/ErrorState';
import { Button, Loading, Press, Screen, Segmented, SurfaceProvider, T, Toggle, toast } from '../../src/ui/kit';
import { TitleHeader } from '../../src/ui/TitleHeader';
import { fonts, palette } from '../../src/ui/theme';

const DEPTHS: ConfirmatDepth[] = [35, 40, 45, 50];
const pick = (p: ProductionOut): ProductionSettings => ({
  fastener: p.fastener, confirmat_depth: p.confirmat_depth, hinge_brand: p.hinge_brand, shelf_pin_grid: p.shelf_pin_grid,
});
const same = (a: ProductionSettings, b: ProductionSettings) =>
  a.fastener === b.fastener && a.confirmat_depth === b.confirmat_depth && a.hinge_brand === b.hinge_brand && a.shelf_pin_grid === b.shelf_pin_grid;

/** Кнопка ряда .cs: h40 r12, выбранная — чёрная. */
function Cell({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Press onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={label} style={[st.c, on && st.cOn]}>
      <T num style={[st.cT, on && { color: palette.white }]}>{label}</T>
    </Press>
  );
}

const fmt = (n: number, lang: string) => String(n).replace('.', lang === 'uz' ? '.' : ',');

/**
 * Схема планки и чашки (.sch 96 pt, как SVG макета, но из View): край двери, чашка Ø35 с размером до края,
 * справа — монтажная планка марки: along — 2 отверстия вдоль кромки двери, across — поперёк (37 и 69 от края).
 */
export function HingeScheme({ brand }: { brand: HingeBrandInfo }) {
  const { t, lang } = useT();
  const k = 1.1; // pt на мм у чашки
  const edgeX = 24;
  const cup = brand.cup_diameter_mm * k;
  const cx = edgeX + brand.cup_from_edge_mm * k;
  const along = brand.plate_pattern === 'along';
  const s = brand.plate_spacing_mm; // планка — 1 pt на мм
  const label = t('prod_scheme', {
    brand: brand.name, cup: fmt(brand.cup_diameter_mm, lang), edge: fmt(brand.cup_from_edge_mm, lang),
    s: fmt(s, lang), line: fmt(brand.plate_line_mm, lang),
  });
  return (
    <View style={st.sch} accessible accessibilityRole="image" accessibilityLabel={label}>
      {/* край двери */}
      <View style={[st.ink, { left: edgeX - 1, top: 8, width: 2, height: 80 }]} />
      <T style={[st.edgeT, { left: -14, top: 41 }]}>{t('prod_edge')}</T>
      {/* чашка */}
      <View style={[st.cup, { left: cx - cup / 2, top: 48 - cup / 2, width: cup, height: cup, borderRadius: cup / 2 }]}>
        <T num style={st.small}>{`Ø${fmt(brand.cup_diameter_mm, lang)}`}</T>
      </View>
      {/* размер от края до центра чашки */}
      <View style={[st.dim, { left: edgeX, top: 86, width: cx - edgeX, height: 1.4 }]} />
      <View style={[st.dim, { left: cx - 0.7, top: 82, width: 1.4, height: 8 }]} />
      <T num style={[st.dimT, { left: cx + 4, top: 79, textAlign: 'left' }]}>{fmt(brand.cup_from_edge_mm, lang)}</T>
      {/* планка */}
      <View style={st.plate}>
        {along ? (
          <>
            <View style={[st.hole, { left: 52 - 3.5, top: 22 - s / 2 - 3.5 }]} />
            <View style={[st.hole, { left: 52 - 3.5, top: 22 + s / 2 - 3.5 }]} />
          </>
        ) : (
          <>
            <View style={[st.hole, { left: 36 - 3.5, top: 22 - 3.5 }]} />
            <View style={[st.hole, { left: 36 + s - 3.5, top: 22 - 3.5 }]} />
          </>
        )}
      </View>
      {along ? (
        <>
          <View style={[st.dim, { right: 30 + 104 + 10, top: 48 - s / 2, width: 1.4, height: s }]} />
          <View style={[st.dim, { right: 30 + 104 + 6, top: 48 - s / 2, width: 9, height: 1.4 }]} />
          <View style={[st.dim, { right: 30 + 104 + 6, top: 48 + s / 2, width: 9, height: 1.4 }]} />
          <T num style={[st.dimT, { right: 30 + 104 + 14, top: 40, textAlign: 'right' }]}>{fmt(s, lang)}</T>
        </>
      ) : (
        <>
          <View style={[st.dim, { right: 30 + 104 - 36 - s, top: 16, width: s, height: 1.4 }]} />
          <View style={[st.dim, { right: 30 + 104 - 36 - 0.7, top: 12, width: 1.4, height: 9 }]} />
          <View style={[st.dim, { right: 30 + 104 - 36 - s - 0.7, top: 12, width: 1.4, height: 9 }]} />
          <T num style={[st.dimT, { right: 30 + 104 - 36 - s, top: 0, width: s }]}>{fmt(s, lang)}</T>
        </>
      )}
      <T style={[st.small, st.plateT]} numberOfLines={1}>{`${t('prod_plate', { brand: brand.name })} · ${t('prod_line', { n: fmt(brand.plate_line_mm, lang) })}`}</T>
    </View>
  );
}

export default function Production() {
  const { t, lang } = useT();
  const res = useResource(() => api.getProduction(), [], { refetchOnFocus: false });
  const [saved, setSaved] = useState<ProductionSettings | null>(null);
  const [v, setV] = useState<ProductionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  // dev-снимки (scripts/shot.sh): ?fastener=dowel&brand=gtv — черновик сразу с этими значениями
  const demo = useLocalSearchParams<{ fastener?: string; brand?: string }>();
  useEffect(() => {
    if (!res.data) return;
    setSaved(pick(res.data));
    const d = __DEV__ ? { ...(demo.fastener === 'dowel' ? { fastener: 'dowel' as const } : {}), ...(demo.brand ? { hinge_brand: demo.brand as HingeBrandInfo['id'] } : {}) } : {};
    setV({ ...pick(res.data), ...d });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.data]);
  const dirty = !!v && !!saved && !same(v, saved);

  const save = async (): Promise<boolean> => {
    if (!v) return false;
    setBusy(true);
    try {
      const out = await api.updateProduction(v);
      setSaved(pick(out));
      setV(pick(out));
      toast.show({ text: t('prod_saved'), tone: 'success' });
      return true;
    } catch (e) {
      showError(e, lang);
      return false;
    } finally { setBusy(false); }
  };

  // Уйти с несохранёнными правками — «Сохранить / Не сохранять / Отмена»
  usePreventRemove(dirty && !busy, ({ repeat }) => {
    Alert.alert(t('prod_unsaved_title'), t('prod_unsaved_text'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('prod_discard'), style: 'destructive', onPress: () => { setV(saved); setTimeout(repeat, 0); } },
      { text: t('save'), onPress: async () => { if (await save()) setTimeout(repeat, 0); } },
    ]);
  });

  if (res.loading && !v) return <Loading />;
  if (!v || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const brands = res.data.hinge_brands;
  const brand = brands.find((b) => b.id === v.hinge_brand) ?? brands[0];
  const set = (patch: Partial<ProductionSettings>) => setV({ ...v, ...patch });
  const onSave = async () => {
    if (!dirty) return router.back();
    if (await save()) setTimeout(() => router.back(), 0);
  };

  return (
    <Screen gap={8} contentStyle={{ paddingTop: 2 }} footerStyle={{ paddingTop: 6 }}
      footer={<Button title={t('save')} onPress={onSave} loading={busy} haptic="success" />}>
      <Stack.Screen options={{ header: () => <TitleHeader title={t('prod_title')} /> }} />
      <T v="cap" style={{ paddingHorizontal: 8 }}>{t('prod_note')}</T>

      <T style={st.sec}>{t('prod_fastener')}</T>
      <View style={st.box}>
        <SurfaceProvider value="white">
          <Segmented value={v.fastener} onChange={(f) => set({ fastener: f })} style={{ backgroundColor: palette.ground }}
            options={[{ value: 'confirmat', label: t('prod_confirmat') }, { value: 'dowel', label: t('prod_dowel') }]} />
        </SurfaceProvider>
        {v.fastener === 'confirmat' ? (
          <>
            <View style={st.kt}>
              <View style={{ flex: 1 }}>
                <T style={st.k}>{t('prod_depth')}</T>
                <T style={st.s}>{t('prod_depth_sub')}</T>
              </View>
              <T num style={st.val}>{t('prod_mm', { n: v.confirmat_depth })}</T>
            </View>
            <View style={st.cs} accessibilityRole="radiogroup" accessibilityLabel={t('prod_depth')}>
              {DEPTHS.map((d) => <Cell key={d} label={String(d)} on={v.confirmat_depth === d} onPress={() => set({ confirmat_depth: d })} />)}
            </View>
          </>
        ) : <T v="cap">{t('prod_dowel_note')}</T>}
      </View>

      <T style={st.sec}>{t('prod_hinges')}</T>
      <View style={st.box}>
        <View style={st.cs} accessibilityRole="radiogroup" accessibilityLabel={t('prod_hinges')}>
          {brands.map((b) => <Cell key={b.id} label={b.name} on={v.hinge_brand === b.id} onPress={() => set({ hinge_brand: b.id })} />)}
        </View>
        {brand ? <HingeScheme brand={brand} /> : null}
        <T v="cap">{t('prod_hinge_note', { brand: brand?.name ?? '' })}</T>
      </View>

      <T style={st.sec}>{t('prod_pins')}</T>
      <View style={st.box}>
        <View style={st.kt}>
          <View style={{ flex: 1 }}>
            <T style={st.k}>{t('prod_grid')}</T>
            <T style={st.s}>{t(v.shelf_pin_grid ? 'prod_grid_on' : 'prod_grid_off')}</T>
          </View>
          <Toggle value={v.shelf_pin_grid} onValueChange={(g) => set({ shelf_pin_grid: g })} accessibilityLabel={t('prod_grid')} />
        </View>
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  sec: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: palette.muted, paddingTop: 6, paddingHorizontal: 8 },
  box: { backgroundColor: palette.white, borderRadius: 22, paddingVertical: 14, paddingHorizontal: 16, gap: 12 },
  cs: { flexDirection: 'row', gap: 6 },
  c: { flex: 1, height: 40, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  cOn: { backgroundColor: palette.ink },
  cT: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  kt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  k: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  s: { fontSize: 13, lineHeight: 17, color: palette.muted },
  val: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  sch: { height: 96, borderRadius: 14, backgroundColor: '#F7F6F3', overflow: 'hidden' },
  ink: { position: 'absolute', backgroundColor: palette.ink },
  edgeT: { position: 'absolute', width: 40, textAlign: 'center', fontSize: 10, lineHeight: 13, color: palette.muted, transform: [{ rotate: '-90deg' }] },
  cup: { position: 'absolute', backgroundColor: palette.white, borderWidth: 1.6, borderColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  small: { fontSize: 10, lineHeight: 13, color: palette.muted, fontFamily: fonts.regular },
  dim: { position: 'absolute', backgroundColor: palette.blue },
  dimT: { position: 'absolute', fontSize: 11, lineHeight: 14, fontWeight: '600', color: palette.blue, textAlign: 'center' },
  plate: { position: 'absolute', right: 30, top: 26, width: 104, height: 44, borderRadius: 6, borderWidth: 1.6, borderColor: palette.ink, backgroundColor: palette.white },
  hole: { position: 'absolute', width: 7, height: 7, borderRadius: 3.5, backgroundColor: palette.ink },
  plateT: { position: 'absolute', right: 8, bottom: 6, left: 150, textAlign: 'center' },
});
