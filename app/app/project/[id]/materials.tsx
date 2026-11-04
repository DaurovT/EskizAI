/**
 * SCR-09 Материалы (Materials.dc.html): вкладки «Корпус / Фасады / Цвет / Кромка / Ручки», плитки декоров 3 в ряд
 * (текстура EMAN или цвет, название, код · бренд, цена листа; «нет в наличии» — бледно и красным),
 * фильтры: семейство цвета, бренд, поиск. «Цвет» — МДФ под покраску: палитра RAL/NCS и блеск → fronts.style.paint.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { ColorFamily, DecorOut, PaintColor, PaintGlossId, ProductTree } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { boardDecorsOf, decorTitle, FAM_DOT, FAMILIES, isPaintMaterial, paintOf, textureSource } from '../../../src/lib/decors';
import { groupDigits } from '../../../src/lib/format';
import { setAt } from '../../../src/lib/jsonPatch';
import { useOffline } from '../../../src/state/net';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Banner, Button, Chip, ChipRow, Loading, Press, Screen, Search, Segmented, T, Toggle, toast } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

type Target = 'body' | 'fronts' | 'color' | 'edge';
const SPACINGS = [96, 128, 160, 192, 256, 320];
const KIND: Record<string, string> = { ldsp: 'ЛДСП', mdf: 'МДФ', hdf: 'ХДФ' };
const PAGE = 60;

export default function Materials() {
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const { t, lang } = useT();
  const offline = useOffline();
  const { data, error, loading, reload } = useResource(() => api.getModel(id), [id]);
  const [tree, setTree] = useState<ProductTree | null>(null);
  // ?tab=color|fronts|edge — открыть сразу нужную вкладку (из «Стиля фасада» и «Выбран элемент»)
  const [target, setTarget] = useState<Target>(tab === 'color' || tab === 'fronts' || tab === 'edge' ? tab : 'body');
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [family, setFamily] = useState<ColorFamily | 'all'>('all');
  const [brand, setBrand] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const [search, setSearch] = useState(false);
  const [pick, setPick] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [gw, setGw] = useState(0);
  const [stockOnly, setStockOnly] = useState(true);
  // Краска: система палитры, цвет, блеск, основа (МДФ под покраску)
  const [system, setSystem] = useState<'all' | 'RAL' | 'NCS'>('all');
  const [paintPick, setPaintPick] = useState<PaintColor | null>(null);
  const [gloss, setGloss] = useState<PaintGlossId | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const col = gw ? (gw - 8) / 2 : undefined;
  const board = target === 'body' || target === 'fronts';
  const known = useRef<Record<string, DecorOut>>({});

  useEffect(() => { if (data) setTree(data.version.tree); }, [data]);
  useEffect(() => { setPick(undefined); }, [target]);
  useEffect(() => { const h = setTimeout(() => setQd(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  useEffect(() => { setLimit(PAGE); }, [family, brand, qd, stockOnly]);

  const list = useResource(
    () => api.searchDecors({ kind: 'ldsp,mdf', min_thickness: 16, available: stockOnly ? true : undefined, limit, family: family === 'all' ? undefined : family, brand: brand === 'all' ? undefined : brand, q: qd || undefined }),
    [limit, family, brand, qd, stockOnly], { refetchOnFocus: false, enabled: board });
  const palettes = useResource(() => api.listPaintColors(), [], { refetchOnFocus: false, enabled: target === 'color' });
  const facets = useRef<{ brands: string[]; families: ColorFamily[] }>({ brands: [], families: [] });
  if (list.data) {
    for (const d of list.data.items) known.current[d.id] = d;
    facets.current = { brands: list.data.brands, families: list.data.families };
  }

  if (loading && !tree) return <Loading />;
  if (!tree) return <ErrorState error={error} onRetry={reload} />;

  const save = async (next: ProductTree) => {
    setTree(next);
    setSaving(true);
    try {
      setTree((await api.saveModel(id, { tree: next, source: 'manual', label: t('ed_save_material') })).version.tree);
      setPick(undefined);
      toast.show({ text: t('ed_save_material'), tone: 'success' });
    } catch (e) { showError(e, lang); setTree(data?.version.tree ?? next); }
    finally { setSaving(false); }
  };

  /** Фасады без краски: убираем fronts.style.paint, остальной стиль (фрезеровка) не трогаем. */
  const withoutPaint = (next: ProductTree): ProductTree => {
    const style: Record<string, unknown> = { ...(next.fronts?.style ?? {}) };
    if (!('paint' in style)) return next;
    delete style.paint;
    const { style: _old, ...rest } = next.fronts ?? {};
    return { ...next, fronts: Object.keys(style).length ? { ...rest, style } : rest };
  };

  const decors = boardDecorsOf(list.data?.items ?? []).filter((d) => !isPaintMaterial(d.id));
  const current = target === 'body' ? tree.body?.material ?? null : target === 'fronts' ? tree.fronts?.material ?? null : null;
  const sel = pick === undefined ? current : pick;
  const selDecor = (sel ? known.current[sel] : undefined) ?? null;
  const name = (d: DecorOut) => (lang === 'uz' ? d.name_uz : d.name);
  const hasFronts = !!tree.fronts;
  const tabs: Target[] = hasFronts ? ['body', 'fronts', 'edge', 'color'] : ['body', 'edge'];
  const tabLabel: Record<Target, string> = { body: t('mat_body'), fronts: t('mat_fronts'), color: t('mat_color'), edge: t('mat_edge') };
  const dirty = board && pick !== undefined && pick !== current;
  const ref = selDecor ?? decors[0];

  // --- краска ---
  const pal = palettes.data;
  const curPaint = tree.fronts?.style?.paint ?? null;
  const baseId = base ?? (isPaintMaterial(tree.fronts?.material) ? tree.fronts?.material : null) ?? pal?.materials.find((m) => m.thickness === 19)?.id ?? pal?.materials[0]?.id ?? 'mdf_19_paint';
  const glossId: PaintGlossId = gloss ?? curPaint?.gloss ?? 'matte';
  const chosen = paintPick ?? (curPaint ? pal?.colors.find((c) => c.code === curPaint.code) ?? null : null);
  const colors = (pal?.colors ?? []).filter((c) => (system === 'all' || c.system === system)
    && (!qd || `${c.code} ${c.name_ru} ${c.name_uz}`.toLowerCase().includes(qd.toLowerCase())));
  const glossSel = pal?.gloss.find((g) => g.id === glossId);
  const paintDirty = !!chosen && (curPaint?.code !== chosen.code || curPaint?.gloss !== glossId || tree.fronts?.material !== baseId);
  const applyPaint = () => chosen && save({ ...tree, fronts: { ...tree.fronts, material: baseId, style: { ...(tree.fronts?.style ?? {}), paint: paintOf(chosen, glossId) } } });

  const famLabel = (f: ColorFamily | 'all') => (f === 'all' ? t('mat_fam_all') : t(FAMILIES.find((x) => x.id === f)!.key as 'mat_fam_white'));
  const unit = lang === 'uz' ? 'so‘m' : 'сум';
  const total = list.data?.total ?? 0;

  const ctaTitle = target === 'body' ? t('mat_apply_body') : target === 'fronts' ? t('mat_apply_fronts') : t('mat_paint_apply');
  const ctaSub = target === 'color'
    ? (chosen ? `${chosen.code} · ${(lang === 'uz' ? glossSel?.name_uz : glossSel?.name_ru)?.toLowerCase() ?? ''}` : '')
    : selDecor ? [selDecor.decor, name(selDecor)].filter(Boolean).join(' · ') : sel ? sel : target === 'fronts' ? t('mat_same_as_body') : '';
  const ctaVal = target === 'color' ? (glossSel?.price_m2 ? `${groupDigits(glossSel.price_m2)} / м²` : null) : selDecor?.price ? groupDigits(selDecor.price) : null;
  const ctaOff = target === 'color' ? !paintDirty || offline || saving : (dirty && offline) || saving;
  const footer = target === 'body' || target === 'fronts' || target === 'color' ? (
    <Press disabled={ctaOff} onPress={() => {
      if (target === 'color') return applyPaint();
      if (!dirty) return router.back();
      const next = setAt(tree, target === 'body' ? '/body/material' : '/fronts/material', pick ?? null);
      save(target === 'fronts' ? withoutPaint(next) : next);
    }} accessibilityRole="button" style={[s.cta, ctaOff && (target === 'color' || dirty) && { backgroundColor: palette.off }]}>
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: 17, lineHeight: 19, fontWeight: '600', color: ctaOff && (target === 'color' || dirty) ? palette.faint : palette.white }}>{ctaTitle}</T>
        <T style={{ fontSize: 13, lineHeight: 19, color: palette.white, opacity: 0.85 }} numberOfLines={1}>{ctaSub}</T>
      </View>
      {ctaVal ? <View style={s.v}><T num style={{ fontSize: 15, fontWeight: '600', color: palette.white }}>{ctaVal}</T></View> : null}
    </Press>
  ) : undefined;

  const FChip = ({ label, on, onPress, dot }: { label: string; on: boolean; onPress: () => void; dot?: string }) => (
    <Press onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} style={[s.fchip, on && { backgroundColor: palette.ink }]}>
      {dot ? <View style={[s.cd, { backgroundColor: dot }]} /> : null}
      <T style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: on ? palette.white : palette.ink }} numberOfLines={1}>{label}</T>
    </Press>
  );
  const SearchBox = (
    <Search value={q} onChangeText={setQ} placeholder={target === 'color' ? t('mat_paint_search_ph') : t('mat_search_ph')} />
  );

  return (
    <Screen contentStyle={{ paddingTop: 2, gap: 8 }} footerStyle={{ paddingTop: 6 }} footer={footer}>
      <Stack.Screen options={{ title: '', headerRight: () => (board ? <T v="cap" style={{ paddingRight: 6 }}>{`EMAN · ${t('mat_count', { n: groupDigits(total) })}`}</T> : null) }} />
      <T style={{ fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.75, paddingHorizontal: 8 }}>{t('mat_title2')}</T>
      <Segmented value={target} onChange={(k) => setTarget(k)} options={tabs.map((k) => ({ value: k, label: tabLabel[k] }))} />
      {saving ? <T v="cap" color={palette.green} style={{ paddingHorizontal: 8 }}>{t('ed_rebuilding')}</T> : null}
      {target === 'fronts' ? (
        <Button v="secondary" small icon="color-wand-outline" title={t('dc_title')} onPress={() => router.push(`/project/${id}/front-style` as never)} />
      ) : null}
      {target === 'edge' ? (
        <Banner tone="n" icon="information-circle-outline" text={t('mat_edge_soon')} />
      ) : target === 'color' ? (
        <>
          <T v="cap" style={{ paddingHorizontal: 8 }}>{t('mat_paint_note')}</T>
          {palettes.loading && !pal ? <Loading /> : null}
          {palettes.error && !pal ? <ErrorState error={palettes.error} onRetry={palettes.reload} /> : null}
          {pal ? (
            <>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Segmented value={system} onChange={setSystem} style={{ width: 150 }} options={[{ value: 'all', label: t('mat_paint_all') }, { value: 'RAL', label: 'RAL' }, { value: 'NCS', label: 'NCS' }]} />
                <View style={{ flex: 1, minWidth: 0 }}>{SearchBox}</View>
              </View>
              <View style={s.pal} onLayout={(e) => setGw(e.nativeEvent.layout.width)}>
                {colors.map((c) => {
                  const on = chosen?.code === c.code;
                  const w = (gw - 28 - 8 * 5) / 6;
                  return (
                    <Press key={c.code} onPress={() => setPaintPick(c)} accessibilityRole="radio" accessibilityState={{ selected: on }}
                      accessibilityLabel={`${c.code} ${lang === 'uz' ? c.name_uz : c.name_ru}`} style={{ width: gw ? w : undefined, alignItems: 'center', gap: 5 }}>
                      <View style={[s.pcDot, { backgroundColor: c.hex }, on && s.pcOn]} />
                      <T num style={{ fontSize: 12, lineHeight: 14, color: on ? palette.ink : palette.muted, fontWeight: on ? '600' : '400' }} numberOfLines={1}>{c.code.replace(/^(RAL|NCS) (S )?/, '')}</T>
                    </Press>
                  );
                })}
              </View>
              {colors.length === 0 ? <T v="cap" style={{ paddingHorizontal: 8 }}>{t('mat_empty')}</T> : null}
              <T style={{ fontSize: 17, lineHeight: 22, fontWeight: '700', paddingHorizontal: 8, paddingTop: 4 }}>{t('mat_paint_gloss')}</T>
              <Segmented value={glossId} onChange={setGloss} options={pal.gloss.map((g) => ({ value: g.id, label: lang === 'uz' ? g.name_uz : g.name_ru }))} />
              {glossSel?.price_m2 ? (
                <View style={s.cnt}>
                  <T v="cap" style={{ flex: 1 }}>{t('mat_paint_price_m2')}</T>
                  <T num style={{ fontSize: 17, fontWeight: '700' }}>{groupDigits(glossSel.price_m2)} <T style={{ fontSize: 14, fontWeight: '500', color: palette.muted }}>{unit}</T></T>
                </View>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <>
          {SearchBox}
          {facets.current.brands.length > 1 ? (
            <ChipRow style={s.chips}>
              {['all', ...facets.current.brands].map((b) => <FChip key={b} label={b === 'all' ? t('mat_brand_all') : b} on={brand === b} onPress={() => setBrand(b)} />)}
            </ChipRow>
          ) : null}
          <ChipRow style={s.chips}>
            {(['all', ...FAMILIES.map((f) => f.id)] as const).filter((f) => f === 'all' || facets.current.families.includes(f)).map((f) => (
              <FChip key={f} label={famLabel(f)} on={family === f} dot={FAM_DOT[f]} onPress={() => setFamily(f)} />
            ))}
          </ChipRow>
          <View style={s.cnt}>
            <T v="cap" style={{ flex: 1 }}>{`${t(stockOnly ? 'mat_in_stock_n' : 'mat_found', { n: groupDigits(total) })}${ref ? ' · ' + t('mat_sheet_size', { kind: KIND[ref.kind] ?? ref.kind.toUpperCase(), mm: ref.thickness, size: (ref.sheet_mm ?? [2800, 2070]).join('×') }) : ''}`}</T>
            <T style={{ fontSize: 14, fontWeight: '500' }}>{t('mat_in_stock')}</T>
            <View style={{ transform: [{ scale: 0.82 }] }}><Toggle value={stockOnly} onValueChange={setStockOnly} accessibilityLabel={t('mat_in_stock')} /></View>
          </View>
          {target === 'fronts' ? (
            <ChipRow>
              <Chip label={t('mat_handles_none')} selected={tree.fronts?.handles?.kind === 'none'} onPress={() => !offline && save(setAt(tree, '/fronts/handles', { kind: 'none' }))} />
              {SPACINGS.map((mm) => (
                <Chip key={mm} label={t('mat_handles_bar', { mm })} selected={tree.fronts?.handles?.kind !== 'none' && (tree.fronts?.handles?.spacing ?? 128) === mm}
                  onPress={() => !offline && save(setAt(tree, '/fronts/handles', { kind: 'bar', spacing: mm }))} />
              ))}
            </ChipRow>
          ) : null}
          {list.loading && !list.data ? <Loading /> : null}
          {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
          <View style={s.grid} onLayout={(e) => setGw(e.nativeEvent.layout.width)}>
            {target === 'fronts' ? (
              <Press onPress={() => setPick(null)} accessibilityRole="radio" accessibilityState={{ selected: sel == null }} style={[s.card, { width: col }, sel == null && s.cardOn]}>
                <View style={[s.tx2, { backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="copy-outline" size={24} color={palette.muted} /></View>
                <T style={s.nm} numberOfLines={1}>{t('mat_same_as_body')}</T>
              </Press>
            ) : null}
            {decors.map((d) => {
              const on = sel === d.id;
              const src = textureSource(d.texture);
              return (
                <Press key={d.id} disabled={!d.available} onPress={() => setPick(d.id)} accessibilityRole="radio" accessibilityState={{ selected: on, disabled: !d.available }}
                  accessibilityLabel={name(d)} style={[s.card, { width: col }, on && s.cardOn]}>
                  <View style={[s.tx2, { backgroundColor: d.color }, !d.available && { opacity: 0.4 }]}>
                    {src ? <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" accessible={false} /> : d.has_grain ? <View style={s.grain} /> : null}
                  </View>
                  <T num style={s.code} numberOfLines={1}>{[d.brand, d.decor].filter(Boolean).join(' ')}</T>
                  <T style={s.nm} numberOfLines={1}>{decorTitle(d, lang)}</T>
                  {!d.available ? <T style={[s.pr, { color: palette.redDeep }]} numberOfLines={1}>{t('mat_out_of_stock')}</T>
                    : d.price ? <T num style={s.pr} numberOfLines={1}>{groupDigits(d.price)} <T style={{ fontWeight: '400', color: palette.muted }}>{unit}</T></T> : null}
                  {on ? <View style={s.ck}><Ionicons name="checkmark" size={16} color={palette.white} /></View> : null}
                </Press>
              );
            })}
          </View>
          {list.data && decors.length === 0 ? <T v="cap" style={{ paddingHorizontal: 8 }}>{t('mat_empty')}</T> : null}
          {list.data && list.data.total > list.data.items.length ? <Button v="secondary" title={t('mat_more')} loading={list.loading} onPress={() => setLimit((l) => l + PAGE)} /> : null}
          <T v="cap" style={{ paddingHorizontal: 8 }}>{t('mat_tex_note')}</T>
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { backgroundColor: palette.white, borderRadius: 22, paddingTop: 6, paddingHorizontal: 6, paddingBottom: 10 },
  cardOn: { borderWidth: 3, borderColor: palette.ink, paddingTop: 3, paddingHorizontal: 3, paddingBottom: 7 },
  tx2: { height: 78, borderRadius: 17, overflow: 'hidden' },
  code: { fontSize: 12, lineHeight: 16, color: palette.muted, paddingTop: 8, paddingHorizontal: 6 },
  nm: { fontSize: 15, lineHeight: 19, fontWeight: '600', paddingTop: 2, paddingHorizontal: 6 },
  pr: { fontSize: 14, lineHeight: 18, fontWeight: '500', paddingTop: 4, paddingHorizontal: 6 },
  ck: { position: 'absolute', right: 9, top: 9, width: 26, height: 26, borderRadius: 13, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  grain: { position: 'absolute', top: 0, bottom: 0, left: 10, right: 18, borderLeftWidth: 6, borderRightWidth: 10, borderColor: 'rgba(90,61,30,0.12)' },
  chips: { gap: 6 },
  fchip: { height: 36, borderRadius: 18, backgroundColor: palette.white, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  cd: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(33,32,31,0.15)' },
  cnt: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8 },
  pal: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10, columnGap: 8, backgroundColor: palette.white, borderRadius: 24, paddingVertical: 16, paddingHorizontal: 14 },
  pcDot: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: 'rgba(33,32,31,0.12)' },
  pcOn: { borderWidth: 3, borderColor: palette.white, shadowColor: palette.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, outlineWidth: 0 },
  cta: { height: 56, borderRadius: 16, backgroundColor: palette.green, flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8, gap: 10 },
  v: { height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.16)', justifyContent: 'center', paddingHorizontal: 12 },
});
