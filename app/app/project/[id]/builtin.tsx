/**
 * SCR-50 Встройка в нишу (NicheFit.dc.html) и SCR-50b Встройка кухни (KitchenFit.dc.html).
 * Шкаф: «Отдельно / В нишу» в шапке, «по замеру»/«оценка», схема ниши (3 ширины, 2 высоты, глубина; добор зелёным,
 * завал стены — красным), «Стена справа завалена … · Добор клином» (`builtin.wedge`, `niche.lean`), доборы с видимой
 * шириной и заготовкой, фальш-панели, цоколь, задняя стенка. Кухня: схема стены А спереди, торцевые панели, добор
 * до потолка, фасад ПММ, холодильник слева/справа/нет и шкаф над ним, решётки в цоколе.
 * «К смете» — строки доборов и панелей текущей сметы; «Применить» — новая версия (корпус подгоняется под замер).
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { isMasterEstimate, type KitchenSite, type NicheMeasure, type ProductTree } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { builtinOf, fitToNiche, nicheLayout, sidePanels, thicknessOf, BUILTIN_DEFAULTS, type Builtin, type Gap } from '../../../src/lib/decorStyle';
import { groupDigits } from '../../../src/lib/format';
import { setAt } from '../../../src/lib/jsonPatch';
import { useOffline } from '../../../src/state/net';
import { useSession } from '../../../src/state/session';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Button, Loading, Press, Screen, T, Toggle, toast } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

type Mod = { kind: string; width?: number; dw?: boolean; hob?: boolean; fridge_height?: number; top_panel?: boolean; [k: string]: unknown };
const GREEN = '#A9CDB5', RED_F = '#F4A69F', BLUE = '#1F4FBF';
const mmv = (v: number) => String(Math.round(v));

export default function BuiltinScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const offline = useOffline();
  const { seesCost } = useSession();
  const model = useResource(() => api.getModel(id), [id]);
  const card = useResource(() => api.getProject(id).catch(() => null), [id]);
  const est = useResource(() => (seesCost ? api.getEstimate(id).catch(() => null) : Promise.resolve(null)), [id, seesCost]);
  const [draft, setDraft] = useState<ProductTree | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (model.data) setDraft(model.data.version.tree); }, [model.data?.version.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (model.loading && !draft) return <Loading />;
  if (!draft) return <ErrorState error={model.error} onRetry={model.reload} />;
  const base = model.data!.version.tree;
  const kitchen = draft.type === 'kitchen';
  const niche = !kitchen && (draft.installation === 'niche' || !!draft.builtin);
  const b = builtinOf(draft);
  const measured = !!(b.niche && Object.entries(b.niche).some(([k, v]) => k !== 'lean' && typeof v === 'number'));
  const out = niche && measured ? fitToNiche(draft) : draft;
  const dirty = JSON.stringify(out) !== JSON.stringify(base);
  const set = (ptr: string, v: unknown) => setDraft(setAt(draft, ptr, v));
  const setB = (p: Partial<Builtin>) => setDraft({ ...draft, builtin: { ...((draft.builtin as Builtin | undefined) ?? {}), ...p } });

  // «К смете»: доборы, панели, клин, крепёж к стене — из строк текущей сметы
  const lines = isMasterEstimate(est.data) ? est.data.lines.filter((l) => /^fill:|wedge|filler|false_panel|side_panel|anchor|dw_front|vent|plinth/.test(l.key) || l.group === 'Доборы и панели') : [];
  const toEst = lines.reduce((a, l) => a + l.cost, 0);
  const apply = async () => {
    if (!dirty) return router.back();
    setSaving(true);
    try {
      await api.saveModel(id, { tree: out, source: 'manual', label: t('bi_applied') });
      toast.show({ text: t('bi_applied'), tone: 'success' });
      router.back();
    } catch (e) { showError(e, lang); } finally { setSaving(false); }
  };
  const title = [card.data?.title, card.data?.client?.name].filter(Boolean).join(' · ');

  const footer = (
    <>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <T v="cap" style={{ fontSize: 15 }}>{t('nf_to_est')}</T>
        {seesCost ? (dirty ? <T v="cap" style={{ fontSize: 15 }}>{t('nf_after')}</T> : (
          <T num style={s.sum}>{toEst ? `+ ${groupDigits(toEst)}` : '0'} <T style={{ fontSize: 15, fontWeight: '400', color: palette.muted }}>{lang === 'uz' ? 'so‘m' : 'сум'}</T></T>
        )) : null}
      </View>
      <Button title={t('bi_apply')} onPress={apply} loading={saving} disabled={dirty && offline} />
    </>
  );

  if (kitchen) {
    return (
      <Screen gap={8} contentStyle={{ paddingTop: 0 }} footerBar footerStyle={s.foot} footer={footer}>
        <Stack.Screen options={{ title: '', headerRight: title ? () => <View style={s.st}><T style={[s.stT, { color: '#275C3A' }]} numberOfLines={1}>{title}</T></View> : undefined }} />
        <T style={s.h1}>{t('kf_title')}</T>
        <KitchenFit tree={draft} set={set} setTree={setDraft} />
      </Screen>
    );
  }

  return (
    <Screen gap={8} contentStyle={{ paddingTop: 0 }} footerBar footerStyle={s.foot} footer={footer}>
      <Stack.Screen options={{ title: '', headerRight: () => (
        <Mini light options={[['free', t('nf_free')], ['niche', t('nf_niche')]]} value={niche ? 'niche' : 'free'} onChange={(v) => {
          if (v === 'niche') setDraft({ ...draft, installation: 'niche', builtin: draft.builtin ?? { fillers: [...BUILTIN_DEFAULTS.fillers] } });
          else { const { builtin: _b, ...rest } = draft; setDraft({ ...rest, installation: 'freestanding' }); }
        }} />
      ) }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8 }}>
        <T style={[s.h1, { flex: 1, paddingHorizontal: 0 }]} numberOfLines={1}>{niche ? t('nf_title_niche') : t('nf_title_free')}</T>
        {niche ? <View style={[s.tag, { backgroundColor: measured ? palette.greenSoft : palette.amberSoft }]}><T style={[s.tagT, { color: measured ? '#275C3A' : '#8A4B00' }]}>{measured ? t('nf_measured') : t('nf_est')}</T></View> : null}
      </View>
      {niche ? <NicheFit tree={draft} out={out} b={b} setB={setB} set={set} /> : <FreeFit tree={draft} set={set} />}
    </Screen>
  );
}

// ---------- шкаф в нишу ----------

function NicheFit({ tree, out, b, setB, set }: { tree: ProductTree; out: ProductTree; b: ReturnType<typeof builtinOf>; setB: (p: Partial<Builtin>) => void; set: (p: string, v: unknown) => void }) {
  const { t } = useT();
  const n = b.niche ?? {};
  const lay = nicheLayout(out);
  const widths = lay.widths;
  const lean = n.lean ?? null;
  const diffW = widths.length > 1 ? Math.max(...widths) - Math.min(...widths) : 0;
  const plumb = diffW > 15;
  const leanSides = (lean ? [lean] : ['left', 'right']) as ('left' | 'right')[];
  const wedged = plumb && leanSides.every((sd) => b.wedge.includes(sd));
  const gapDown = (n.width_bottom ?? 0) > (n.width_top ?? 0);
  const side = (sd: string) => t(sd === 'left' ? 'bi_side_left' : sd === 'right' ? 'bi_side_right' : 'bi_side_top');
  const toggleWedge = () => setB(wedged
    ? { wedge: b.wedge.filter((x) => !leanSides.includes(x as 'left')) }
    : { wedge: [...new Set([...b.wedge, ...leanSides])], fillers: [...new Set([...b.fillers, ...leanSides])] });
  const scribe = b.scribe;
  const sub = (g: Gap) => (!g.filler ? t('nf_f_none', { v: mmv(g.min) })
    : b.wedge.includes(g.side) && g.max - g.min >= 1 ? t('nf_f_wedge', { a: mmv(g.min), b: mmv(g.max), c: mmv(g.max + scribe) })
      : t('nf_f_sub', { v: mmv(g.min), b: mmv(g.max + scribe) }));
  const toggleFiller = (sd: Gap['side']) => setB({ fillers: b.fillers.includes(sd) ? b.fillers.filter((x) => x !== sd) : [...b.fillers, sd] });
  const panels = sidePanels(tree);
  const hasPanel = (sd: 'left' | 'right') => panels.some((p) => p.side === sd);
  const togglePanel = (sd: 'left' | 'right') => set('/side_panels', hasPanel(sd) ? panels.filter((p) => p.side !== sd) : [...panels, { side: sd, to_floor: true }]);
  return (
    <>
      <NicheSketch n={n} lay={lay} wedged={wedged} plumb={plumb} leanRight={lean !== 'left'} depth={n.depth ?? tree.depth} t={t} />
      {plumb && !wedged ? (
        <View style={[s.ban, { backgroundColor: palette.redSoft }]}>
          <Ionicons name="warning-outline" size={20} color="#8A1D16" />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={{ fontSize: 15, lineHeight: 19, fontWeight: '600', color: '#8A1D16' }} numberOfLines={1}>{lean ? t('nf_lean_t', { side: side(lean) }) : t('nf_lean_both')}</T>
            <T style={{ fontSize: 14, lineHeight: 19, color: '#8A1D16' }} numberOfLines={1}>{t('nf_lean_d', { v: mmv(diffW), where: gapDown ? t('nf_down') : t('nf_up') })}</T>
          </View>
          <Press onPress={toggleWedge} accessibilityRole="button" style={s.fixb}><T style={{ fontSize: 14, fontWeight: '600', color: '#8A1D16' }}>{t('nf_wedge')}</T></Press>
        </View>
      ) : null}
      {wedged ? (
        <View style={[s.ban, { backgroundColor: palette.greenSoft }]}>
          <Ionicons name="checkmark" size={20} color="#1F4A2F" />
          <T style={{ flex: 1, fontSize: 14, lineHeight: 19, color: '#1F4A2F' }} numberOfLines={2}>
            {leanSides.map((sd) => t('nf_wedge_ok', { side: t(sd === 'left' ? 'nf_left' : 'nf_right'), a: mmv(lay[sd].min), b: mmv(lay[sd].max) })).join('; ')}
          </T>
          <Press feedback="opacity" onPress={toggleWedge} accessibilityRole="button" style={{ minHeight: 32, justifyContent: 'center' }}><T style={{ fontSize: 14, fontWeight: '500', color: '#275C3A' }}>{t('nf_undo')}</T></Press>
        </View>
      ) : null}
      <View style={s.sheet}>
        {(['left', 'right', 'top'] as const).map((sd) => (
          <Row key={sd} title={t(sd === 'left' ? 'nf_f_left' : sd === 'right' ? 'nf_f_right' : 'nf_f_top')} sub={sub(lay[sd])}>
            <Toggle value={b.fillers.includes(sd)} onValueChange={() => toggleFiller(sd)} />
          </Row>
        ))}
        <Row title={t('nf_panels')} sub={t('nf_panels_sub')}>
          <Pill on={hasPanel('left')} label={t('nf_left')} onPress={() => togglePanel('left')} />
          <Pill on={hasPanel('right')} label={t('nf_right')} onPress={() => togglePanel('right')} />
        </Row>
      </View>
      <PlinthBack tree={tree} set={set} label="nf_plinth" />
    </>
  );
}

/** Цоколь (ножки / сплошной) и задняя стенка — у встроенного и у отдельно стоящего. */
function PlinthBack({ tree, set, label }: { tree: ProductTree; set: (p: string, v: unknown) => void; label: 'nf_plinth' | 'nf_support' }) {
  const { t } = useT();
  const plinth = (tree.body?.plinth ?? null) as { height?: number; legs?: boolean; floor_allowance?: number } | null;
  const backNone = (tree.body?.back as { kind?: string } | undefined)?.kind === 'none';
  return (
    <View style={s.sheet}>
      <Row title={label === 'nf_plinth' ? <>{t('nf_plinth')} <T num style={{ fontSize: 15, color: palette.muted }}>{mmv(plinth?.height ?? 70)} {t('mm')}</T></> : t('nf_support')}
        sub={plinth?.legs ? t('nf_legs_sub') : t('nf_solid_sub')}>
        <Mini options={[['legs', t('nf_legs')], ['solid', t('nf_solid')]]} value={plinth?.legs ? 'legs' : 'solid'}
          onChange={(v) => set('/body/plinth', { ...(plinth ?? { height: 80 }), legs: v === 'legs', ...(v === 'legs' ? { floor_allowance: plinth?.floor_allowance ?? 5 } : {}) })} />
      </Row>
      <Row title={t('nf_back')} sub={backNone ? t('nf_back_off') : t('nf_back_on')}>
        <Toggle value={!backNone} onValueChange={(v) => set('/body/back', { ...((tree.body?.back as object) ?? {}), kind: v ? 'nailed' : 'none' })} accessibilityLabel={t('nf_back')} />
      </Row>
    </View>
  );
}

function FreeFit({ tree, set }: { tree: ProductTree; set: (p: string, v: unknown) => void }) {
  const { t } = useT();
  return (
    <>
      <View style={[s.sch, { height: 190 }]}>
        <View style={[s.abs, { left: 40, top: 175, width: 286, height: 2.5, backgroundColor: palette.ink }]} />
        <View style={[s.abs, { left: 118, top: 24, width: 130, height: 140, backgroundColor: '#E6D3B1', borderWidth: 3, borderColor: palette.ink }]} />
        <View style={[s.abs, { left: 182, top: 24, width: 2, height: 140, backgroundColor: palette.ink }]} />
        <View style={[s.abs, { left: 124, top: 164, width: 4, height: 12, backgroundColor: palette.ink }]} />
        <View style={[s.abs, { left: 238, top: 164, width: 4, height: 12, backgroundColor: palette.ink }]} />
        <T num style={[s.dl, { left: 0, right: 0, top: 4, textAlign: 'center' }]}>{`${mmv(tree.width ?? 0)} × ${mmv(tree.depth ?? 0)} × ${mmv(tree.height ?? 0)}`}</T>
      </View>
      <View style={[s.ban, { backgroundColor: palette.blueSoft, paddingVertical: 12 }]}>
        <Ionicons name="information-circle-outline" size={20} color="#1A3F99" />
        <T style={{ flex: 1, fontSize: 14, lineHeight: 19, color: '#1A3F99' }}>{t('nf_free_info')}</T>
      </View>
      <PlinthBack tree={tree} set={set} label="nf_support" />
    </>
  );
}

/** Схема ниши спереди (как SVG макета 366×146): стены, корпус, доборы, размеры в точках замера. */
function NicheSketch({ n, lay, wedged, plumb, leanRight, depth, t }: {
  n: NicheMeasure; lay: ReturnType<typeof nicheLayout>; wedged: boolean; plumb: boolean; leanRight: boolean; depth?: number | null; t: ReturnType<typeof useT>['t'];
}) {
  const y = (v: number) => (v * 146) / 156;
  const top = y(14), bot = y(142), H = bot - top;
  const lean = plumb ? 18 : 0; // завал стены — нагляднее, чем в масштабе
  const wallX = 262 + (leanRight ? lean : 0);
  const cabL = lay.left.filler ? 116 : 106, cabR = lay.right.filler ? 250 : 260, cabT = lay.top.filler ? y(26) : y(16);
  const rFill = plumb && !wedged ? RED_F : GREEN;
  const bad = plumb && !wedged;
  const v = (x?: number | null) => (x ? mmv(x) : '—');
  return (
    <View style={s.sch} accessibilityRole="image">
      {/* ниша и завал справа */}
      <View style={[s.abs, { left: 104, top, width: 158, height: H, backgroundColor: '#EAE9E5' }]} />
      {lean ? <Tri left={262} top={top} w={wallX - 262} h={H} color="#EAE9E5" /> : null}
      <View style={[s.abs, { left: cabL, top: cabT, width: cabR - cabL, height: bot - cabT, backgroundColor: '#E6D3B1', borderWidth: 3, borderColor: palette.ink }]} />
      <View style={[s.abs, { left: Math.round((cabL + cabR) / 2) - 1, top: cabT, width: 2, height: bot - cabT, backgroundColor: palette.ink }]} />
      {lay.left.filler ? <View style={[s.abs, { left: 104, top: cabT, width: cabL - 104, height: bot - cabT, backgroundColor: GREEN }]} /> : null}
      {lay.right.filler ? (
        <>
          <View style={[s.abs, { left: cabR, top: cabT, width: 262 - cabR, height: bot - cabT, backgroundColor: rFill }]} />
          {lean ? <Tri left={262} top={cabT} w={(wallX - 262) * ((bot - cabT) / H)} h={bot - cabT} color={rFill} /> : null}
        </>
      ) : null}
      {lay.top.filler ? <View style={[s.abs, { left: 104, top, width: 158, height: cabT - top, backgroundColor: GREEN }]} /> : null}
      {/* контур ниши */}
      <View style={[s.abs, { left: 103, top: top - 1, width: 160, height: 2.5, backgroundColor: palette.ink }]} />
      <View style={[s.abs, { left: 103, top, width: 2.5, height: H, backgroundColor: palette.ink }]} />
      <View style={[s.abs, { left: 103, top: bot - 1, width: wallX - 102, height: 2.5, backgroundColor: palette.ink }]} />
      <Seg x1={262} y1={top} x2={wallX} y2={bot} w={2.5} color={palette.ink} />
      <View style={[s.abs, { left: 92, top, width: 1.4, height: H, backgroundColor: BLUE }]} />
      <View style={[s.abs, { left: 262 + (leanRight ? lean : 0) - 6, top, width: 1.4, height: H, backgroundColor: BLUE }]} />
      <T num style={[s.dl, { left: 150, top: 0 }]}>{t('nf_top', { v: v(n.width_top ?? n.width) })}</T>
      <T num style={[s.dl, { left: 132, top: 58, color: palette.ink, borderRadius: 6, overflow: 'hidden' }]}>{t('nf_mid', { v: v(n.width_middle) })}</T>
      <T num style={[s.dl, { left: 150, top: 130 }, bad && gapDown(n) && { color: '#A1221A' }]}>{t('nf_bot', { v: v(n.width_bottom ?? n.width) })}</T>
      <T num style={[s.dl, { left: 30, top: 64 }]}>{v(n.height_left ?? n.height)}</T>
      <T num style={[s.dl, { left: 296, top: 64 }, bad && { color: '#A1221A' }]}>{v(n.height_right ?? n.height)}</T>
      <T num style={[s.dl, { right: 12, top: 10, color: palette.muted2 }]}>{t('nf_depth', { v: v(depth) })}</T>
    </View>
  );
}
const gapDown = (n: NicheMeasure) => (n.width_bottom ?? 0) > (n.width_top ?? 0);

// ---------- кухня ----------

function KitchenFit({ tree, set, setTree }: { tree: ProductTree; set: (p: string, v: unknown) => void; setTree: (t: ProductTree) => void }) {
  const { t } = useT();
  const baseRow = (tree.base as Mod[] | undefined) ?? [];
  const wallRow = (tree.wall as Mod[] | undefined) ?? [];
  const panels = sidePanels(tree) as { side: 'left' | 'right'; row?: string }[];
  const has = (sd: 'left' | 'right') => panels.some((p) => p.side === sd);
  const togglePanel = (sd: 'left' | 'right') => set('/side_panels', has(sd) ? panels.filter((p) => p.side !== sd) : [...panels, { side: sd, row: 'base' }]);
  const site = tree.site as KitchenSite | undefined;
  const topFiller = tree.top_filler as { ceiling?: number } | null | undefined;
  const ceiling = topFiller?.ceiling ?? site?.ceiling ?? 2700;
  const wallTop = ((tree.wall_bottom as number | undefined) ?? 1400) + ((tree.wall_height as number | undefined) ?? 720);
  const gap = Math.max(0, ceiling - wallTop);
  const dwIdx = baseRow.findIndex((m) => m.kind === 'appliance' && !m.hob && (m.width ?? 600) <= 600);
  const dw = dwIdx >= 0 ? baseRow[dwIdx] : null;
  const frIdx = baseRow.findIndex((m) => m.kind === 'fridge');
  const frSide = frIdx < 0 ? 'none' : frIdx === 0 && baseRow.length > 1 ? 'left' : 'right';
  const setFridge = (v: string) => {
    const rest = baseRow.filter((m) => m.kind !== 'fridge');
    const fr: Mod = frIdx >= 0 ? baseRow[frIdx] : { kind: 'fridge', width: 600, fridge_height: 1850, top_panel: true };
    setTree({ ...tree, base: v === 'none' ? rest : v === 'left' ? [fr, ...rest] : [...rest, fr] });
  };
  const plinth = (tree.plinth ?? {}) as { grilles?: string[] };
  const grille = (g: string) => (plinth.grilles ?? []).includes(g);
  const toggleGrille = (g: string) => set('/plinth', { ...plinth, grilles: grille(g) ? (plinth.grilles ?? []).filter((x) => x !== g) : [...(plinth.grilles ?? []), g] });
  const fr = frIdx >= 0 ? baseRow[frIdx] : null;
  const panelT = thicknessOf(tree.fronts?.material ?? tree.body?.material);
  return (
    <>
      <KitchenSketch tree={tree} ceiling={ceiling} t={t} />
      <View style={s.sheet}>
        <Row title={t('kf_ends')} sub={t('kf_ends_sub', { t: panelT })}>
          <Pill on={has('left')} label={t('nf_left')} onPress={() => togglePanel('left')} />
          <Pill on={has('right')} label={t('nf_right')} onPress={() => togglePanel('right')} />
        </Row>
        <Row title={t('kf_top')} sub={topFiller ? t('kf_top_sub', { c: mmv(ceiling), v: mmv(gap) }) : t('kf_top_off', { v: mmv(gap) })}>
          <Toggle value={!!topFiller} onValueChange={(v) => set('/top_filler', v ? { scribe: 15, ...(site?.ceiling ? {} : { ceiling }) } : null)} accessibilityLabel={t('kf_top')} />
        </Row>
        {dw ? (
          <Row title={t('kf_dw', { w: dw.width ?? 600 })} sub={dw.dw ? t('kf_dw_sub', { v: (dw.width ?? 600) - 2 }) : t('kf_dw_off')}>
            <Toggle value={!!dw.dw} onValueChange={(v) => set(`/base/${dwIdx}/dw`, v)} />
          </Row>
        ) : null}
      </View>
      <View style={s.sheet}>
        <Row title={t('kf_fridge')} sub={fr ? t('kf_fridge_sub', { w: fr.width ?? 600 }) : t('kf_fridge_none')}>
          <Mini options={[['left', t('nf_left')], ['right', t('nf_right')], ['none', t('kf_none')]]} value={frSide} onChange={setFridge} pad={10} />
        </Row>
        {fr ? (
          <Row title={t('kf_fridge_top')} sub={t('kf_fridge_top_sub', { w: fr.width ?? 600, h: mmv(Math.max(0, ceiling - (fr.fridge_height ?? 1850) - 100)) })}>
            <Toggle value={fr.top_panel !== false} onValueChange={(v) => set(`/base/${frIdx}/top_panel`, v)} />
          </Row>
        ) : null}
        <Row title={t('kf_grilles')} sub={t('kf_grilles_sub')}>
          <Pill on={grille('sink')} label={t('kf_sink')} onPress={() => toggleGrille('sink')} />
          <Pill on={grille('oven')} label={t('kf_oven')} onPress={() => toggleGrille('oven')} />
        </Row>
      </View>
      {wallRow.length === 0 ? null : null}
    </>
  );
}

/** Стена А спереди (KitchenFit: 366×214): потолок пунктиром, добор, верхние, столешница, нижние, цоколь с решётками, холодильник, торцы. */
function KitchenSketch({ tree, ceiling, t }: { tree: ProductTree; ceiling: number; t: ReturnType<typeof useT>['t'] }) {
  const Y = (v: number) => v + 18;
  const baseRow = (tree.base as Mod[] | undefined) ?? [];
  const wallRow = (tree.wall as Mod[] | undefined) ?? [];
  const total = baseRow.reduce((a, m) => a + (m.width ?? 600), 0) || 1;
  const k = 330 / total;
  let x = 22;
  const mods = baseRow.map((m) => { const w = (m.width ?? 600) * k; const r = { m, x, w }; x += w; return r; });
  const end = x;
  let wx = 22;
  const walls = wallRow.map((m) => { const w = (m.width ?? 600) * k; const r = { m, x: wx, w }; wx += w; return r; }).filter((r) => r.m.kind !== 'gap');
  const fr = mods.find((r) => r.m.kind === 'fridge');
  const topOn = !!tree.top_filler;
  const panels = sidePanels(tree);
  const grilles = ((tree.plinth as { grilles?: string[] } | undefined)?.grilles) ?? [];
  const label = (m: Mod) => (m.kind === 'sink' ? t('kf_m_sink') : m.kind === 'appliance' ? (m.hob ? t('kf_m_oven') : m.dw || (m.width ?? 600) <= 450 ? t('kf_m_dw') : t('kf_m_tech')) : '');
  const lower = mods.filter((r) => r.m.kind !== 'fridge');
  const lX = lower[0]?.x ?? 22, lEnd = lower.length ? lower[lower.length - 1].x + lower[lower.length - 1].w : end;
  return (
    <View style={[s.sch, { height: 214 }]} accessibilityRole="image">
      <Dashed x={14} y={Y(12)} w={338} />
      {walls.map((r, i) => (
        <View key={i}>
          <View style={[s.abs, { left: r.x, top: Y(12), width: r.w, height: 20, backgroundColor: topOn ? GREEN : palette.white, borderWidth: 1.5, borderColor: topOn ? palette.green : palette.chev, borderStyle: topOn ? 'solid' : 'dashed' }]} />
          <View style={[s.abs, { left: r.x, top: Y(32), width: r.w, height: 52, backgroundColor: '#F4F1EA', borderWidth: 2.5, borderColor: palette.ink }]} />
        </View>
      ))}
      <View style={[s.abs, { left: lX, top: Y(106), width: lEnd - lX, height: 5, backgroundColor: palette.ink }]} />
      {lower.map((r, i) => (
        <View key={i} style={[s.abs, { left: r.x, top: Y(112), width: r.w, height: 44, backgroundColor: r.m.dw ? GREEN : r.m.kind === 'appliance' && r.m.hob ? '#EDE8DF' : '#F4F1EA', borderWidth: 2.5, borderColor: palette.ink, alignItems: 'center', justifyContent: 'center' }]}>
          {label(r.m) ? <T style={s.lb} numberOfLines={1}>{label(r.m)}</T> : null}
        </View>
      ))}
      <View style={[s.abs, { left: lX, top: Y(156), width: lEnd - lX, height: 12, backgroundColor: '#D6D4CF' }]} />
      {lower.map((r, i) => ((r.m.kind === 'sink' && grilles.includes('sink')) || (r.m.kind === 'appliance' && r.m.hob && grilles.includes('oven')) ? <Grille key={i} x={r.x + 8} y={Y(157)} w={Math.max(20, r.w - 16)} /> : null))}
      {fr ? (
        <>
          <View style={[s.abs, { left: fr.x, top: Y(12), width: fr.w, height: 20, backgroundColor: fr.m.top_panel !== false ? GREEN : palette.white, borderWidth: 1.5, borderColor: fr.m.top_panel !== false ? palette.green : palette.chev, borderStyle: fr.m.top_panel !== false ? 'solid' : 'dashed' }]} />
          <View style={[s.abs, { left: fr.x, top: Y(32), width: fr.w, height: 136, backgroundColor: '#F4F1EA', borderWidth: 2.5, borderColor: palette.ink, alignItems: 'center', justifyContent: 'center' }]}>
            <T style={s.lb}>{t('kf_m_fridge')}</T>
          </View>
        </>
      ) : null}
      {panels.some((p) => p.side === 'left') ? <View style={[s.abs, { left: 15, top: Y(12), width: 7, height: 156, backgroundColor: palette.green }]} /> : null}
      {panels.some((p) => p.side === 'right') ? <View style={[s.abs, { left: end, top: Y(12), width: 7, height: 156, backgroundColor: palette.green }]} /> : null}
      <View style={[s.abs, { left: 14, top: Y(167), width: 338, height: 2.5, backgroundColor: palette.ink }]} />
      <T style={[s.lb, { position: 'absolute', left: 16, top: 6 }]}>{t('kf_wall')}</T>
      <T num style={[s.lb, { position: 'absolute', right: 14, top: 8, color: BLUE, backgroundColor: palette.white, paddingHorizontal: 4 }]}>{t('kf_ceiling', { v: mmv(ceiling) })}</T>
    </View>
  );
}

// ---------- примитивы ----------

function Row({ title, sub, children }: { title: ReactNode; sub: string; children: ReactNode }) {
  return (
    <View style={s.rw}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '500' }} numberOfLines={1}>{title}</T>
        <T style={{ fontSize: 13, lineHeight: 17, color: palette.muted }} numberOfLines={1}>{sub}</T>
      </View>
      {children}
    </View>
  );
}
function Pill({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} accessibilityRole="switch" accessibilityState={{ checked: on }} style={[s.pill, on && { backgroundColor: palette.ink }]}>
      <T style={{ fontSize: 14, fontWeight: '500', color: on ? palette.white : palette.ink }}>{label}</T>
    </Press>
  );
}
/** .mini — маленький сегмент; light — белый фон, выбранный чёрный (переключатель в шапке). */
function Mini({ options, value, onChange, light, pad = 12 }: { options: [string, string][]; value: string; onChange: (v: string) => void; light?: boolean; pad?: number }) {
  return (
    <View style={[s.mini, light && { backgroundColor: palette.white }]} accessibilityRole="tablist">
      {options.map(([v, l]) => {
        const on = v === value;
        return (
          <Press key={v} feedback="opacity" onPress={() => !on && onChange(v)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={[s.miniB, { paddingHorizontal: pad }, on && (light ? { backgroundColor: palette.ink } : s.miniOn)]}>
            <T style={{ fontSize: 14, fontWeight: '500', color: on && light ? palette.white : palette.ink }}>{l}</T>
          </Press>
        );
      })}
    </View>
  );
}
function Tri({ left, top, w, h, color }: { left: number; top: number; w: number; h: number; color: string }) {
  return <View style={{ position: 'absolute', left, top, width: 0, height: 0, borderBottomWidth: h, borderBottomColor: color, borderRightWidth: Math.max(0, w), borderRightColor: 'transparent' }} />;
}
function Seg({ x1, y1, x2, y2, w, color }: { x1: number; y1: number; x2: number; y2: number; w: number; color: string }) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  return <View style={{ position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - w / 2, width: len, height: w, backgroundColor: color, transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }] }} />;
}
function Dashed({ x, y, w }: { x: number; y: number; w: number }) {
  return <>{Array.from({ length: Math.floor(w / 9) }, (_, i) => <View key={i} style={{ position: 'absolute', left: x + i * 9, top: y - 1, width: 5, height: 2, backgroundColor: palette.ink }} />)}</>;
}
function Grille({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <View style={{ position: 'absolute', left: x, top: y, width: w, height: 10, backgroundColor: GREEN, flexDirection: 'row', gap: 3, overflow: 'hidden' }}>
      {Array.from({ length: Math.floor(w / 5) }, (_, i) => <View key={i} style={{ width: 2, height: 10, backgroundColor: palette.green }} />)}
    </View>
  );
}

const s = StyleSheet.create({
  h1: { fontSize: 30, lineHeight: 34, fontWeight: '700', letterSpacing: -0.6, paddingHorizontal: 8 },
  st: { height: 32, borderRadius: 9, backgroundColor: palette.white, paddingHorizontal: 10, justifyContent: 'center', maxWidth: 260 },
  stT: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  tag: { height: 28, borderRadius: 9, paddingHorizontal: 10, justifyContent: 'center' },
  tagT: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  sch: { backgroundColor: palette.white, borderRadius: 24, height: 146, overflow: 'hidden' },
  abs: { position: 'absolute' },
  dl: { position: 'absolute', fontSize: 12, lineHeight: 16, fontWeight: '600', color: BLUE, backgroundColor: palette.white, paddingHorizontal: 4 },
  lb: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: palette.muted2 },
  ban: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 20, paddingVertical: 8, paddingRight: 8, paddingLeft: 14 },
  fixb: { height: 36, borderRadius: 12, backgroundColor: palette.white, paddingHorizontal: 12, justifyContent: 'center' },
  sheet: { backgroundColor: palette.white, borderRadius: 28, overflow: 'hidden' },
  rw: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingVertical: 5, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: palette.hair, marginTop: -1 },
  pill: { height: 34, borderRadius: 17, backgroundColor: palette.ground, paddingHorizontal: 12, justifyContent: 'center' },
  mini: { flexDirection: 'row', backgroundColor: palette.segOnWhite, borderRadius: 12, padding: 3, gap: 2 },
  miniB: { height: 34, borderRadius: 9, justifyContent: 'center' },
  miniOn: { backgroundColor: palette.white, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  foot: { paddingTop: 10, gap: 6 },
  sum: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.4 },
});
