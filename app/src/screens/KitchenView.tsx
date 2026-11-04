/**
 * SCR-37 / SCR-37b Редактор кухни (KitchenEditor / KitchenCorner.dc.html) — вид для editor.tsx, когда tree.type === 'kitchen'.
 * Прямая: фасадная схема (верхние модули, столешница, нижние), угловая (base2/wall2): план «вид сверху» по стенам А и Б.
 * Вкладки «Модуль / Столешница / Техника» (+ «Угол»), ширина модуля ±50, проверка суммы по стене, ввод правки словами,
 * цена и «Клиенту». Ширину сохраняет редактор (onWidth), правку словами — ИИ (onSend).
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';
import type { KitchenSite, ModelStateOut, ProductTree } from '../api/types';
import { groupDigits } from '../lib/format';
import { moduleLengths, rowOffsetB, wallDiffs } from '../lib/kitchenMeasure';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { IconButton, Press, Segmented, SurfaceProvider, T, resolveFont } from '../ui/kit';
import { DecorMenu } from './DecorMenu';
import { palette, type as ty } from '../ui/theme';

type Mod = { kind: string; width?: number; drawers?: number; shelves?: number; corner_shape?: string; corner_fill?: string; [k: string]: unknown };
type Tab = 'mod' | 'top' | 'app' | 'corner';
type Sel = { row: 'base' | 'wall' | 'base2' | 'wall2'; i: number };

const LABEL: Record<string, { ru: string; uz: string }> = {
  drawers: { ru: 'Ящики', uz: 'Tortma' }, doors: { ru: 'Двери', uz: 'Eshik' }, appliance: { ru: 'Варка', uz: 'Plita' },
  oven: { ru: 'Варка', uz: 'Plita' }, hob: { ru: 'Варка', uz: 'Plita' }, sink: { ru: 'Мойка', uz: 'Rakovina' },
  dishwasher: { ru: 'ПММ', uz: 'IYM' }, bottle: { ru: 'Бутыл.', uz: 'Shisha' }, filler: { ru: 'Добор', uz: 'Qoʻshimcha' },
  hood: { ru: 'Вытяжка', uz: 'Soʻrgich' }, open: { ru: 'Открытая', uz: 'Ochiq' }, dryer: { ru: 'Сушка', uz: 'Quritgich' },
  corner: { ru: 'Угол', uz: 'Burchak' }, fridge: { ru: 'Холод.', uz: 'Muzlatgich' }, gap: { ru: '—', uz: '—' },
};
const isAppliance = (k: string) => /appliance|oven|hob|sink|dishwasher|hood|fridge/.test(k);

export function KitchenView({ id, tree, title, sub, price, onWidth, onSend, busy, disabled, onCornerSize, onModel, onError }: {
  id: string; tree: ProductTree; title: string; sub?: string; price: string; busy: boolean; disabled: boolean;
  onWidth: (pointer: string, value: number) => void; onSend: (text: string) => void; onCornerSize: (pointer: string, mm: number) => void;
  /** Замена наполнения угла (фурнитура corner_fill) вернула новую версию модели. */
  onModel: (s: ModelStateOut) => void; onError: (e: unknown) => void;
}) {
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const decors = useResource(() => api.listDecors().catch(() => []), []);
  const base = (tree.base as Mod[] | undefined) ?? [];
  const wall = (tree.wall as Mod[] | undefined) ?? [];
  const base2 = (tree.base2 as Mod[] | undefined) ?? [];
  const wall2 = (tree.wall2 as Mod[] | undefined) ?? [];
  // угловая кухня (core): layout 'corner', угловой модуль — в первом ряду base (corner_shape, corner_fill), второй ряд — base2/wall2
  const corner = tree.layout === 'corner' || base2.length > 0;
  const cornerIdx = base.findIndex((m) => m.kind === 'corner');
  const [tab, setTab] = useState<Tab>(corner && cornerIdx >= 0 ? 'corner' : 'mod');
  const [sel, setSel] = useState<Sel>(corner && cornerIdx >= 0 ? { row: 'base', i: cornerIdx } : { row: 'base', i: Math.min(1, base.length - 1) });
  const hw = useResource(() => (corner ? api.getHardware(id).catch(() => null) : Promise.resolve(null)), [id, corner, tree]);
  const cornerGroup = hw.data?.groups.find((g) => g.key === 'corner_fill') ?? null;
  const [applying, setApplying] = useState<string | null>(null);
  // дерево сменилось с прямой на угловую (новая версия) — открыть «Угол»
  useEffect(() => {
    if (corner && cornerIdx >= 0) { setTab('corner'); setSel({ row: 'base', i: cornerIdx }); }
  }, [corner, cornerIdx]);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const rows: Record<Sel['row'], Mod[]> = { base, wall, base2, wall2 };
  const cur = rows[sel.row][sel.i];
  // ниша под технику (core appliance): над ней варка (hob) → «Варка», узкая 450 → посудомойка, иначе — «Техника»
  const lbl = (m: Mod, upper: boolean) => (upper && m.kind === 'doors' ? (lang === 'uz' ? 'Javon' : 'Полки')
    : m.kind === 'appliance' ? (m.hob ? LABEL.hob[lang] : (m.width ?? 600) <= 450 ? LABEL.dishwasher[lang] : (lang === 'uz' ? 'Texnika' : 'Техника'))
      : LABEL[m.kind]?.[lang] ?? m.kind);
  const lens = moduleLengths(tree);
  const sumA = lens.a;
  const sumB = lens.b ?? 0;
  const site = tree.site as KitchenSite | undefined;
  const diffs = site && typeof site.wall_a === 'number' ? wallDiffs(tree, site) : null;
  const wallA = typeof tree.wall_a === 'number' ? tree.wall_a : typeof tree.width === 'number' ? tree.width : null;
  const decorName = (id?: string | null) => (id ? (decors.data ?? []).find((d) => d.id === id)?.[lang === 'uz' ? 'name_uz' : 'name'] ?? id : '—');
  const fillOf = (m: Mod, upper: boolean) =>
    m.kind === 'drawers' ? t('kit_fill_drawers', { n: m.drawers ?? 3 })
      : m.kind === 'doors' ? (upper ? t('kit_fill_shelves', { n: m.shelves ?? 2 }) : t('kit_fill_door'))
        : m.kind === 'open' ? t('kit_fill_open') : `${lbl(m, upper).toLowerCase()} ${m.width ?? ''}`.trim();
  const tabs: Tab[] = corner ? ['mod', 'top', 'app', 'corner'] : ['mod', 'top', 'app'];
  const tabLabel: Record<Tab, string> = { mod: t('kit_tab_mod'), top: t('kit_tab_top'), app: t('kit_tab_app'), corner: t('kit_tab_corner') };
  const pick = (s: Sel) => { setSel(s); setTab(rows[s.row][s.i]?.kind === 'corner' ? 'corner' : 'mod'); };
  const top = insets.top;
  const appliances = [...base.map((m, i) => ({ m, i, row: 'base' as const })), ...wall.map((m, i) => ({ m, i, row: 'wall' as const })), ...base2.map((m, i) => ({ m, i, row: 'base2' as const }))].filter((x) => isAppliance(x.m.kind));
  const cornerMod = cornerIdx >= 0 ? base[cornerIdx] : null;
  const applyFill = async (value: string) => {
    setApplying(value);
    try { onModel(await api.applyHardware(id, 'corner_fill', value)); hw.reload(); } catch (e) { onError(e); } finally { setApplying(null); }
  };
  // как в макете — цена относительно глухого угла
  const blindDelta = cornerGroup?.options.find((o) => o.value === 'blind')?.delta;
  const send = () => { if (text.trim()) { onSend(text.trim()); setText(''); } };

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      {/* схема */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: top + 380 }}>
        {corner ? (
          <CornerPlan tree={tree} base={base} base2={base2} sel={tab === 'mod' || tab === 'corner' ? sel : null} onPick={pick} lbl={(m) => lbl(m, false)} top={top} />
        ) : (
          <>
            <View style={[s.dimc, { left: 12, top: top + 68 }]}><T num style={s.dimT}>{wallA ?? sumA}</T><T style={s.dimS}>{t('mm')}</T></View>
            <View style={[s.kit, { top: top + 112 }]}>
              <View style={[s.mods, { height: 72 }]}>
                {wall.map((m, i) => {
                  const on = tab === 'mod' && sel.row === 'wall' && sel.i === i;
                  return <Pressable key={i} onPress={() => pick({ row: 'wall', i })} accessibilityRole="button" accessibilityLabel={lbl(m, true)} style={[s.mod, { backgroundColor: '#F7F7F5' }, on && s.modOn]}><T style={[s.modT, on && { color: palette.blue }]} numberOfLines={1}>{lbl(m, true)}</T></Pressable>;
                })}
              </View>
              <View style={[s.ct, tab === 'top' && { backgroundColor: '#DCE6FF', borderColor: palette.blue }]} />
              <View style={[s.mods, { height: 84 }]}>
                {base.map((m, i) => {
                  const on = tab === 'mod' && sel.row === 'base' && sel.i === i;
                  return <Pressable key={i} onPress={() => pick({ row: 'base', i })} accessibilityRole="button" accessibilityLabel={lbl(m, false)} style={[s.mod, { backgroundColor: '#F4F2EC' }, on && s.modOn]}><T style={[s.modT, on && { color: palette.blue }]} numberOfLines={1}>{lbl(m, false)}</T></Pressable>;
                })}
              </View>
            </View>
          </>
        )}
      </View>
      {/* шапка */}
      <View style={[s.hdr, { marginTop: top }]}>
        <IconButton icon="chevron-back" label={t('ed_to_project')} onPress={() => router.back()} style={s.lift} />
        <View style={[s.tpill, s.lift]}>
          <T style={{ fontSize: 15, lineHeight: 19, fontWeight: '600' }} numberOfLines={1}>{title}</T>
          <T style={{ fontSize: 13, lineHeight: 16, color: palette.muted }} numberOfLines={1}>
            {sub ?? (corner ? t('kit_sub_corner', { n: base.length + base2.length }) : t('kit_sub_straight', { a: base.length, b: wall.length }))}
          </T>
        </View>
        <IconButton icon="color-palette-outline" label={t('ed2_kitchen_tools')} onPress={() => setMenu(true)} style={s.lift} />
      </View>
      <DecorMenu id={id} tree={tree} visible={menu} onClose={() => setMenu(false)} withHardware />
      {/* вкладки */}
      <View style={[s.tabs, { top: top + (corner ? 326 : 322), gap: corner ? 6 : 8 }]}>
        {tabs.map((k) => (
          <Press key={k} onPress={() => { setTab(k); if (k === 'corner' && cornerIdx >= 0) setSel({ row: 'base2', i: cornerIdx }); }} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}
            style={[s.tab, { paddingHorizontal: corner ? 14 : 16 }, tab === k && { backgroundColor: palette.ink }]}>
            <T style={{ fontSize: 15, fontWeight: '500', color: tab === k ? palette.white : palette.ink }}>{tabLabel[k]}</T>
          </Press>
        ))}
      </View>
      {/* панель */}
      <View style={[s.es, { top: top + 382 }]}>
        <SurfaceProvider value="white">
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 18, paddingHorizontal: 16, paddingBottom: 8, gap: 10 }}>
            {tab === 'mod' && cur ? (
              <>
                <T style={s.shx}>{corner ? `${sel.row === 'base' || sel.row === 'wall' ? t('kit_wall_a') : t('kit_wall_b')} · ${lbl(cur, sel.row === 'wall' || sel.row === 'wall2')}` : `${sel.row === 'wall' ? t('kit_upper') : t('kit_lower')} · ${fillOf(cur, sel.row === 'wall')}`}</T>
                <WidthBox label={t('p_width')} value={cur.width ?? 0} unit={t('mm')} disabled={disabled || busy}
                  err={!corner && wallA != null && sel.row === 'base' && sumA !== wallA}
                  onChange={(v) => onWidth(`/${sel.row}/${sel.i}/width`, v)} />
                <View>
                  {corner ? <KV k={t('kit_wall')} v={sel.row === 'base' || sel.row === 'wall' ? `${t('kit_a')}, ${sumA} ${t('mm')}` : `${t('kit_b')}, ${sumB} ${t('mm')}`} /> : <KV k={t('kit_fill')} v={fillOf(cur, sel.row === 'wall')} />}
                  <KV k={t('kit_front')} v={decorName(tree.fronts?.material)} onPress={() => router.push({ pathname: '/project/[id]/materials', params: { id: id } })} line />
                </View>
                {!corner ? (
                  wallA != null && sumA !== wallA ? (
                    <View style={[s.ban, { backgroundColor: palette.redSoft, alignItems: 'flex-start' }]}>
                      <Ionicons name="warning-outline" size={20} color="#8A1D16" style={{ marginTop: 1 }} />
                      <T style={{ flex: 1, fontSize: 15, lineHeight: 20, color: '#8A1D16' }}>{t('kit_sum_bad', { sum: sumA, wall: wallA })}</T>
                    </View>
                  ) : (
                    <View style={[s.ban, { backgroundColor: palette.greenSoft }]}>
                      <Ionicons name="checkmark" size={20} color="#1F4A2F" />
                      <T style={{ flex: 1, fontSize: 15, color: '#1F4A2F' }}>{wallA != null ? t('kit_sum_ok', { sum: sumA }) : t('kit_sum_len', { sum: sumA })}</T>
                    </View>
                  )
                ) : diffs && diffs.length ? (
                  <View style={[s.ban, { backgroundColor: palette.redSoft, alignItems: 'flex-start' }]}>
                    <Ionicons name="warning-outline" size={20} color="#8A1D16" style={{ marginTop: 1 }} />
                    <T style={{ flex: 1, fontSize: 15, lineHeight: 20, color: '#8A1D16' }}>
                      {diffs.map((d) => t('kit_wall_diff', { w: d.wall === 'a' ? t('kit_a') : t('kit_b'), d: `${d.diff > 0 ? '+' : '−'}${Math.abs(d.diff)}` })).join(' · ')}
                    </T>
                  </View>
                ) : (
                  <View style={[s.ban, { backgroundColor: palette.greenSoft }]}>
                    <Ionicons name="checkmark" size={20} color="#1F4A2F" />
                    <T style={{ flex: 1, fontSize: 15, color: '#1F4A2F' }}>{t(diffs ? 'kit_walls_ok' : 'kit_walls_len', { a: sumA, b: sumB })}</T>
                  </View>
                )}
              </>
            ) : null}
            {tab === 'top' ? (
              <>
                <View>
                  <KV k={t('kit_top')} v={decorName((tree.countertop as { material?: string } | undefined)?.material)} />
                  <KV k={corner ? t('kit_lengths') : t('kit_len_depth')} v={corner ? `${sumA} + ${sumB}` : `${sumA} × 600`} num line />
                  {corner ? <KV k={t('kit_joint')} v={t('kit_joint_v')} line /> : null}
                  {base.map((m, i) => (m.kind === 'sink' ? <KV key={`s${i}`} k={t('kit_cut_sink')} v={corner ? t('kit_wall_a') : t('kit_module_n', { n: i + 1 })} line /> : null))}
                  {base.map((m, i) => (/appliance|hob/.test(m.kind) ? <KV key={`h${i}`} k={t('kit_cut_hob')} v={t('kit_module_n', { n: i + 1 })} line /> : null))}
                </View>
                <T v="cap">{t('kit_top_note')}</T>
              </>
            ) : null}
            {tab === 'app' ? (
              <>
                <View>
                  {appliances.length ? appliances.map((x, j) => (
                    <View key={`${x.row}${x.i}`} style={[s.apl, j > 0 && s.line]}>
                      <View style={s.ap}><T style={{ fontSize: 13, fontWeight: '600', color: palette.blue }}>{lbl(x.m, x.row === 'wall').slice(0, 3).toLowerCase()}</T></View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T v="rt">{`${lbl(x.m, x.row === 'wall')} ${x.m.width ?? ''}`.trim()}</T>
                        <T v="rs">{`${x.row === 'wall' ? t('kit_upper_short') : ''}${t('kit_module_n', { n: x.i + 1 })}`}</T>
                      </View>
                    </View>
                  )) : <T v="sub">—</T>}
                </View>
                <T v="cap">{t('kit_app_note')}</T>
              </>
            ) : null}
            {tab === 'corner' && cornerMod ? (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <T style={s.shx}>{t('kit_corner_mod')}</T>
                  <T v="rs" num>{cornerMod.corner_shape === 'square' ? `${cornerMod.width ?? 900} × ${cornerMod.width ?? 900} ${t('mm')}` : `${cornerMod.width ?? ''} ${t('mm')}`}</T>
                </View>
                {(cornerGroup?.options ?? []).map((o) => {
                  const on = applying ? applying === o.value : o.current;
                  const d = o.delta == null ? null : blindDelta != null ? o.delta - blindDelta : o.delta;
                  return (
                    <Press key={o.value} onPress={() => !o.current && applyFill(o.value)} disabled={disabled || busy || !!applying || !o.available}
                      accessibilityRole="radio" accessibilityState={{ selected: on, disabled: !o.available }} style={[s.op, on && { backgroundColor: palette.ink }, !o.available && { opacity: 0.45 }]}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T v="rt" color={on ? palette.white : undefined}>{o.label.replace(/\s*\(.*\)$/, '')}</T>
                        <T v="rs" style={{ fontSize: 13, lineHeight: 17 }} color={on ? palette.chev : undefined}>{o.note || t(`kit_fill_note_${o.value}` as 'kit_fill_note_blind')}</T>
                      </View>
                      {d != null ? <T num style={{ fontSize: 15, fontWeight: '600', color: on ? palette.white : palette.ink }}>{d === 0 ? '0' : `${d > 0 ? '+' : '−'}${groupDigits(Math.abs(d))}`}</T> : null}
                    </Press>
                  );
                })}
                {cornerMod.corner_shape === 'square' ? (
                  <Segmented value={String(cornerMod.width ?? 900)} onChange={(v) => onCornerSize(`/base/${cornerIdx}/width`, Number(v))}
                    options={[{ value: '900', label: '900 × 900' }, { value: '1000', label: '1000 × 1000' }]} />
                ) : null}
              </>
            ) : null}
          </ScrollView>
          <View style={s.inpWrap}>
            <View style={s.inp}>
              <TextInput value={text} onChangeText={setText} placeholder={corner ? t('kit_ph_corner') : t('kit_ph')} placeholderTextColor={palette.muted}
                editable={!disabled && !busy} onSubmitEditing={send} returnKeyType="send"
                style={resolveFont([ty.body, { flex: 1, fontSize: 14, color: palette.ink, paddingVertical: 0 }])} />
              <Pressable onPress={send} disabled={!text.trim() || disabled || busy} accessibilityLabel={t('ed_send')} style={s.go}>
                <Ionicons name="arrow-up" size={18} color={palette.white} />
              </Pressable>
            </View>
          </View>
          <View style={[s.cbar, { paddingBottom: Math.max(insets.bottom - 10, 24) }]}>
            <Press onPress={() => router.push({ pathname: '/project/[id]/estimate', params: { id: id } })} style={s.pr} accessibilityRole="button">
              <T v="cap" style={{ fontSize: 13, lineHeight: 16 }}>{t('ed_before_measure')}</T>
              <T num style={{ fontSize: 16, lineHeight: 20, fontWeight: '700' }}>{price}</T>
            </Press>
            <Press onPress={() => router.push({ pathname: '/project/[id]/send', params: { id: id } })} style={s.cta} accessibilityRole="button">
              <T style={{ fontSize: 17, fontWeight: '600', color: palette.white }}>{t('ed_to_client')}</T>
              <Ionicons name="paper-plane-outline" size={18} color={palette.white} />
            </Press>
          </View>
        </SurfaceProvider>
      </View>
    </View>
  );
}

/**
 * План угловой кухни «вид сверху»: стена А (верх) — ряд base с угловым модулем, стена Б — ряд base2 от угла вниз.
 * Г-образный (square) угол — квадрат в стыке, «длинный» — модуль вдоль А, ряд Б начинается за глубиной столешницы.
 * corner_side: 'right' — зеркально (угол справа).
 */
function CornerPlan({ tree, base, base2, sel, onPick, lbl, top }: { tree: ProductTree; base: Mod[]; base2: Mod[]; sel: Sel | null; onPick: (s: Sel) => void; lbl: (m: Mod) => string; top: number }) {
  const { t } = useT();
  const lens = moduleLengths(tree);
  const offB = rowOffsetB(tree);
  const lenA = lens.a;
  const lenB = lens.b ?? offB;
  const k = Math.min(309 / Math.max(lenA, 1), 202 / Math.max(lenB, 1));
  const right = tree.corner_side === 'right';
  const X0 = 40, Y0 = top + 122, DP = 64;
  const W = Math.round(lenA * k);
  const mx = (x: number, w: number) => (right ? 2 * X0 + W - x - w : x);
  const items: { s: Sel; x: number; y: number; w: number; h: number; m: Mod }[] = [];
  // ряд А в порядке base, считая от угла: у corner_side=left угол — первый, у right — последний
  const order = base.map((m, i) => ({ m, i }));
  if (right) order.reverse();
  let x = X0;
  order.forEach(({ m, i }) => {
    const w = Math.round((m.width ?? 0) * k);
    const sq = m.kind === 'corner' && m.corner_shape === 'square';
    items.push({ s: { row: 'base', i }, x: mx(x === X0 ? x : x - 2, x === X0 ? w : w + 2), y: Y0, w: x === X0 ? w : w + 2, h: sq ? w : DP, m });
    x += w;
  });
  let y = Y0 + Math.round(offB * k);
  base2.forEach((m, i) => { const h = Math.round((m.width ?? 0) * k); items.push({ s: { row: 'base2', i }, x: mx(X0, DP), y: y - 2, w: DP, h: h + 2, m }); y += h; });
  const wallX = right ? X0 + W : 34;
  return (
    <>
      <View style={[s.dimc, { left: 170, top: top + 76 }]}><T num style={s.dimT}>{`${t('kit_a')} ${lenA}`}</T><T style={s.dimS}>{t('mm')}</T></View>
      <View style={[s.dimc, { left: 150, top: top + 252 }]}><T num style={s.dimT}>{`${t('kit_b')} ${lenB}`}</T><T style={s.dimS}>{t('mm')}</T></View>
      <View style={[s.wall, { left: 34, top: top + 116, width: W + 12, height: 6 }]} />
      <View style={[s.wall, { left: wallX, top: top + 116, width: 6, height: Math.round(lenB * k) + 6 }]} />
      {items.map((it) => {
        const on = !!sel && sel.row === it.s.row && sel.i === it.s.i;
        const cor = it.m.kind === 'corner';
        return (
          <Pressable key={`${it.s.row}${it.s.i}`} onPress={() => onPick(it.s)} accessibilityRole="button" accessibilityLabel={lbl(it.m)}
            style={[s.m, { left: it.x, top: it.y, width: it.w, height: it.h }, cor && { backgroundColor: '#ECE6DA' }, on && s.mOn]}>
            {cor && !on ? <Hatch /> : null}
            <T style={[s.modT, { paddingBottom: 0 }, on && { color: palette.blue }]} numberOfLines={1}>{lbl(it.m)}</T>
          </Pressable>
        );
      })}
      <T v="cap" style={{ position: 'absolute', left: 150, top: top + 198, fontSize: 13 }}>{t('kit_top_view')}</T>
    </>
  );
}

/** .m.cor — диагональная штриховка углового модуля (45°, 6/6 px). */
function Hatch() {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      {Array.from({ length: 24 }, (_, i) => (
        <View key={i} style={{ position: 'absolute', left: -120 + i * 17, top: -40, width: 6, height: 260, backgroundColor: '#F4F2EC', transform: [{ rotate: '45deg' }] }} />
      ))}
    </View>
  );
}

function KV({ k, v, onPress, line, num }: { k: string; v: string; onPress?: () => void; line?: boolean; num?: boolean }) {
  const body = (
    <>
      <T style={{ flex: 1, fontSize: 16, color: palette.muted }}>{k}</T>
      <T num={num} style={{ fontSize: num ? 14 : 16, fontWeight: '500', textAlign: 'right', flexShrink: 1 }} numberOfLines={1}>{v}</T>
      {onPress ? <Ionicons name="chevron-forward" size={18} color={palette.chev} /> : null}
    </>
  );
  return onPress
    ? <Press feedback="row" onPress={onPress} style={[s.kv, line && s.line]} accessibilityRole="button">{body}</Press>
    : <View style={[s.kv, line && s.line]}>{body}</View>;
}

/** .fld.g + .numf: ширина модуля «−50 / +50», значение 24/600, «мм»; ошибка суммы — красная рамка. */
function WidthBox({ label, value, unit, err, disabled, onChange }: { label: string; value: number; unit: string; err: boolean; disabled: boolean; onChange: (v: number) => void }) {
  const set = (d: number) => onChange(Math.max(150, Math.min(1200, value + d)));
  return (
    <View style={s.fld}>
      {err ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 16, borderWidth: 2, borderColor: palette.red }]} /> : null}
      <T v="fl">{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <Press onPress={() => set(-50)} disabled={disabled} style={s.pm} accessibilityRole="button" accessibilityLabel={`${label} −50`}><T style={{ fontSize: 15, fontWeight: '500' }}>−50</T></Press>
        <T num style={{ flex: 1, fontSize: 24, lineHeight: 28, fontWeight: '600', textAlign: 'center' }}>{value}</T>
        <T v="cap">{unit}</T>
        <Press onPress={() => set(50)} disabled={disabled} style={s.pm} accessibilityRole="button" accessibilityLabel={`${label} +50`}><T style={{ fontSize: 15, fontWeight: '500' }}>+50</T></Press>
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
  dimT: { fontSize: 15, fontWeight: '600', color: palette.blue },
  dimS: { fontSize: 13, color: palette.blue, opacity: 0.7 },
  kit: { position: 'absolute', left: 10, right: 10 },
  mods: { flexDirection: 'row', gap: 3, padding: 3, backgroundColor: palette.ink },
  mod: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 5, overflow: 'hidden' },
  modOn: { backgroundColor: '#DCE6FF', borderWidth: 3, borderColor: palette.blue, paddingBottom: 2 },
  modT: { fontSize: 13, lineHeight: 16, fontWeight: '500', color: palette.muted2, letterSpacing: -0.4, paddingBottom: 0 },
  ct: { height: 10, backgroundColor: '#8D8778', marginTop: 24, marginHorizontal: -4, borderWidth: 3, borderBottomWidth: 0, borderColor: palette.ink },
  wall: { position: 'absolute', backgroundColor: palette.ink, borderRadius: 3 },
  m: { position: 'absolute', borderWidth: 2, borderColor: palette.ink, backgroundColor: '#F4F2EC', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  mOn: { backgroundColor: '#DCE6FF', borderColor: palette.blue, zIndex: 1 },
  tabs: { position: 'absolute', left: 12, right: 12, flexDirection: 'row' },
  tab: { height: 40, borderRadius: 20, backgroundColor: palette.white, justifyContent: 'center', ...{ shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } } },
  es: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: palette.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: -4 }, elevation: 8 },
  shx: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  fld: { backgroundColor: palette.ground, borderRadius: 16, minHeight: 60, paddingVertical: 9, paddingHorizontal: 16, justifyContent: 'center' },
  pm: { width: 50, height: 40, borderRadius: 12, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46 },
  line: { borderTopWidth: 1, borderTopColor: palette.hair },
  ban: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 16 },
  apl: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 },
  ap: { width: 40, height: 40, borderRadius: 12, backgroundColor: palette.blueSoft, alignItems: 'center', justifyContent: 'center' },
  op: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 16, backgroundColor: palette.ground },
  inpWrap: { paddingTop: 8, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: palette.hair },
  inp: { height: 52, borderRadius: 26, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 6 },
  go: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  cbar: { flexDirection: 'row', gap: 8, paddingTop: 8, paddingHorizontal: 16, alignItems: 'center' },
  pr: { height: 52, paddingHorizontal: 14, borderRadius: 16, backgroundColor: palette.ground, justifyContent: 'center' },
  cta: { flex: 1, height: 52, borderRadius: 16, backgroundColor: palette.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
});
