/**
 * SCR-37 / SCR-37b Редактор кухни (KitchenEditor.dc.html, KitchenCorner.dc.html) — вид для editor.tsx, когда
 * tree.type === 'kitchen'; на широком планшете — TKitchen2.dc.html (KitchenWide).
 * Шапка: «назад», плашка «название · прямая 2800 · 5 + 6 модулей», «Схема / 3D». Поле .cv с точками: схема рядов по
 * реальным ширинам (рисунок фасадов, тап — модуль), под ней — выбранный модуль и его ширина (.mlab); угловая кухня —
 * «План / А / Б». 3D — тот же канвас, что у шкафа, тап по модулю выбирает его.
 * Панель снизу (.es): «Модуль / Столешница / Техника / Кухня / Чат». Модуль — типы (.types, «новое»), ширина «−50 / +50»,
 * сумма ≠ стене (+ подгонка), свойства вида, фасад, «← → · Дублировать · Удалить»; угловой модуль — наполнение угла.
 * Внизу всегда — ввод правки словами (ответ — во вкладке «Чат»), цена «до замера» и «Клиенту».
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { num } from '../lib/kitchenScheme';
import { ProductCanvas } from '../three/ProductCanvas';
import { GlassPress, IconButton, Press, SurfaceProvider, T, glass, resolveFont } from '../ui/kit';
import { useLayout } from '../ui/layout';
import { palette, type as ty } from '../ui/theme';
import { DecorMenu } from './DecorMenu';
import { KitchenChat } from './KitchenChat';
import { KitchenWide } from './kitchen/KitchenWide';
import { CornerPlan, Dots, Facade, PHONE_M, facadeHeight, scaleMetrics, schemeStyles } from './kitchen/KitchenScheme';
import { useKitchenEditor, type KitchenViewProps, type RunView, type View3 } from './kitchen/useKitchenEditor';

export type { KitchenViewProps } from './kitchen/useKitchenEditor';

/** Высота панели не меньше (pt): вкладки, 3–4 строки свойств, ввод, цена и «Клиенту». */
const PANEL_MIN = 420;
/** От верхней безопасной зоны (макет 390×844): плашка размера, схема, панель. */
const DIM_Y = 64;
const KIT_Y = 104;
const PANEL_Y = 398;

export function KitchenView(props: KitchenViewProps) {
  if (useLayout().wide) return <KitchenWide {...props} />;
  return <KitchenPhone {...props} />;
}

function KitchenPhone(props: KitchenViewProps) {
  const { id, title, sub, price, busy, disabled, viewer, chat, onSend } = props;
  const k = useKitchenEditor(props, false);
  const { t, tree, cur, sel, tab, mode, layout, lenPill, corner } = k;
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const top = insets.top;
  // панель — как в макете (398 от верха), на низком экране выше, чтобы в ней было место
  const panelTop = Math.max(top + 330, Math.min(top + PANEL_Y, H - PANEL_MIN));
  const mlabY = panelTop - 46;
  const kitY = top + KIT_Y;
  const M = layout ? scaleMetrics(PHONE_M, Math.min(1, (mlabY - 12 - kitY) / facadeHeight(layout, PHONE_M))) : PHONE_M;
  const scheme = mode === 'scheme';
  // клавиатура (iOS): ввод — над ней, цена и «Клиенту» уходят под неё
  const [kb, setKb] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKb(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKb(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const typeChips = k.typeItems.length ? (
    <View style={s.types}>
      {k.typeItems.map((it) => (
        <Press key={it.key} onPress={it.pick} disabled={k.lock} accessibilityRole="radio" accessibilityState={{ selected: it.on }} style={[s.ty, it.on && s.tyOn]}>
          <T style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: it.on ? palette.white : palette.ink }}>{it.label}</T>
          {it.isNew ? <View style={[s.nw, it.on && { backgroundColor: palette.green }]}><T style={[s.nwT, it.on && { color: palette.white }]}>{t('kit_new')}</T></View> : null}
        </Press>
      ))}
    </View>
  ) : null;
  const modPanel = cur ? (
    cur.kind === 'corner' && !sel.tier ? k.cornerPanel() : (
      <>
        {sel.tier || sel.row === 'mid' ? <T style={s.shx} numberOfLines={2}>{k.selLabel}</T> : null}
        {typeChips}
        {k.widthRow()}
        {sel.row !== 'mid' ? k.sumBanner : null}
        {k.modFields()}
        {k.frontRow()}
        {k.actions()}
      </>
    )
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      {/* .cv — точечное поле под схемой / 3D */}
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: panelTop + 30 }}><Dots /></View>
      {!scheme ? (
        <View style={StyleSheet.absoluteFill}>
          <ProductCanvas ref={k.canvas} model={viewer} transparent busy={busy} fallbackText={t('ed_3d_unavailable')}
            freeArea={{ top: top + 80, bottom: H - mlabY + 4 }} freeAreaPadding={16} dimensionLines={k.dims} dimensions={k.dims ? undefined : []}
            onPartTap={(p) => k.onPart3d(p?.key ?? null)} />
        </View>
      ) : (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: mlabY }}>
          {layout ? (
            <Facade tree={tree} layout={layout} run={k.runView === 2 ? 2 : 1} sel={tab === 'mod' ? sel : null} ctOn={tab === 'top'} onPick={k.pick} onAdd={k.lock ? undefined : k.addModule}
              lbl={k.lbl} x0={0} width={W} y0={kitY} M={M} addLabels={{ base: t('kit_add_base'), wall: t('kit_add_wall'), mid: t('kit_add_mid') }} cornerLabel={t('kit_k_corner')} tierLabel={t('kit_k_tier')} />
          ) : (
            <CornerPlan tree={tree} base={k.base} base2={k.base2} sel={tab === 'mod' ? sel : null} onPick={k.pick} lbl={(m) => k.shortLbl(m, 'base')} y0={top + 100} maxH={mlabY - top - 130} />
          )}
        </View>
      )}
      {/* шапка: назад · название · Схема / 3D */}
      <View style={[s.hdr, { marginTop: top }]} pointerEvents="box-none">
        <IconButton icon="chevron-back" label={t('ed_to_project')} onPress={() => (router.canGoBack() ? router.back() : router.replace(`/project/${id}`))} />
        <View style={[s.tpill, s.lift]}>
          <T style={{ fontSize: 15, lineHeight: 19, fontWeight: '600' }} numberOfLines={1}>{title}</T>
          <T style={{ fontSize: 13, lineHeight: 16, color: palette.muted }} numberOfLines={1}>{sub ?? k.subLine}</T>
        </View>
        <View style={[s.vsw, s.lift]} accessibilityRole="tablist">
          {(['scheme', '3d'] as View3[]).map((v) => (
            <Press key={v} feedback="opacity" onPress={() => { k.setMode(v); Keyboard.dismiss(); }} accessibilityRole="tab" accessibilityState={{ selected: mode === v }} style={[s.vb, mode === v && s.vbOn]}>
              <T style={[s.vbT, mode === v && { color: palette.white }]}>{v === 'scheme' ? t('kit_v_scheme') : t('kit_v_3d')}</T>
            </Press>
          ))}
        </View>
      </View>
      {/* размер стены (угловая — План / А / Б) · материалы */}
      <View style={[s.row2, { top: top + DIM_Y }]} pointerEvents="box-none">
        {scheme && corner ? (
          <View style={[s.pills, s.lift]}>
            {(['plan', 1, 2] as RunView[]).map((r) => (
              <Press key={String(r)} feedback="opacity" onPress={() => k.setRunView(r)} accessibilityRole="tab" accessibilityState={{ selected: k.runView === r }} style={[s.pill, k.runView === r && s.vbOn]}>
                <T style={[s.pillT, k.runView === r && { color: palette.white }]}>{r === 'plan' ? t('kit_v_plan') : r === 1 ? t('kit_a') : t('kit_b')}</T>
              </Press>
            ))}
          </View>
        ) : null}
        {scheme && lenPill != null ? (
          <View style={[schemeStyles.dimc, corner && { marginLeft: 8 }]}><T num style={schemeStyles.dimcT}>{lenPill}</T><T style={schemeStyles.dimcS}>{t('mm')}</T></View>
        ) : null}
        <View style={{ flex: 1 }} />
        <Press onPress={() => k.setMenu(true)} style={[s.tool, s.lift]} accessibilityRole="button" accessibilityLabel={t('ed2_kitchen_tools')}>
          <Ionicons name="color-palette-outline" size={18} color={palette.ink} />
        </Press>
      </View>
      {/* .mlab: выбранный модуль и его ширина; в 3D — подсказка и «двери / размеры» */}
      <View style={[s.mlab, { top: mlabY }]} pointerEvents="box-none">
        {scheme ? (
          <>
            {cur && tab === 'mod' ? <View style={[s.ml, s.lift]}><T style={s.mlT} numberOfLines={1}>{k.selLabel}</T></View> : <View />}
            {cur && tab === 'mod' && !sel.tier ? (
              <View style={schemeStyles.dimc}><T num style={schemeStyles.dimcT}>{num(cur.width, 0)}</T><T style={schemeStyles.dimcS}>{t('mm')}</T></View>
            ) : null}
          </>
        ) : (
          <>
            <View style={[s.ml, s.lift, { flexShrink: 1 }]}><T style={s.mlT} numberOfLines={1}>{cur && tab === 'mod' ? k.selLabel : t('kit_3d_hint2')}</T></View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Press onPress={k.toggleOpen} style={[s.tool, s.lift]} accessibilityRole="button" accessibilityLabel={t(k.openAll ? 'ed_view_close' : 'ed_view_open')}>
                <Ionicons name={k.openAll ? 'eye-off-outline' : 'eye-outline'} size={18} color={palette.ink} />
              </Press>
              <Press onPress={() => k.setDims(!k.dims)} style={[s.tool, s.lift, k.dims && { backgroundColor: palette.blueSoft }]} accessibilityRole="switch" accessibilityState={{ checked: k.dims }} accessibilityLabel={t('ed_dims')}>
                <Ionicons name="resize-outline" size={18} color={k.dims ? palette.blue : palette.ink} />
              </Press>
            </View>
          </>
        )}
      </View>
      <DecorMenu id={id} tree={tree} visible={k.menu} onClose={() => k.setMenu(false)} withHardware />
      {/* .es — панель */}
      <View style={[s.es, { top: panelTop }]}>
        <SurfaceProvider value="white">
          <View style={s.est}>
            <View style={s.seg} accessibilityRole="tablist">
              {k.tabs.map((x) => {
                const on = tab === x;
                return (
                  <Press key={x} feedback="opacity" onPress={() => { k.setTab(x); Keyboard.dismiss(); }} accessibilityRole="tab" accessibilityState={{ selected: on }} style={[s.sg, on && s.sgOn]}>
                    <T style={{ fontSize: 14, lineHeight: 18, fontWeight: '500' }} numberOfLines={1}>{k.tabLabel[x]}</T>
                    {x === 'chat' && k.chatBadge ? <View style={s.badge} /> : null}
                  </Press>
                );
              })}
            </View>
          </View>
          {tab === 'chat' ? (
            <View style={{ flex: 1 }}>
              <KitchenChat {...chat} busy={chat.busy || busy} disabled={disabled} onSend={onSend} />
            </View>
          ) : (
            <ScrollView ref={k.panelScroll} style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 8, paddingHorizontal: 16, paddingBottom: 10, gap: 10 }} keyboardShouldPersistTaps="handled">
              {tab === 'mod' ? modPanel : null}
              {tab === 'top' ? k.topPanel() : null}
              {tab === 'app' ? k.appPanel() : null}
              {tab === 'kit' ? k.kitPanel() : null}
            </ScrollView>
          )}
          {/* ввод правки словами */}
          <View style={[s.inpWrap, kb ? { paddingBottom: kb - Math.max(insets.bottom - 10, 24) + 8 } : null]}>
            <View style={s.inp}>
              <TextInput value={k.text} onChangeText={k.setText} placeholder={k.placeholder} placeholderTextColor={palette.muted}
                editable={!disabled && !chat.running && !chat.aiLimited} onSubmitEditing={k.send} returnKeyType="send" accessibilityLabel={t('ed_say')}
                style={resolveFont([ty.body, { flex: 1, fontSize: 14, color: palette.ink, paddingVertical: 0 }])} />
              <Pressable onPress={k.send} disabled={!k.text.trim() || disabled || chat.running} accessibilityLabel={t('ed_send')} style={[s.go, !k.text.trim() && !chat.running && { opacity: 0.4 }]}>
                {chat.running ? <ActivityIndicator size="small" color={palette.white} /> : <Ionicons name="arrow-up" size={18} color={palette.white} />}
              </Pressable>
            </View>
          </View>
          {!kb ? (
            <View style={[s.cbar, { paddingBottom: Math.max(insets.bottom - 10, 24) }]}>
              {price && price !== '—' ? (
                <Press onPress={() => router.push({ pathname: '/project/[id]/estimate', params: { id } })} style={s.pr} accessibilityRole="button">
                  <T v="cap" style={{ fontSize: 12, lineHeight: 15 }}>{t('ed_before_measure')}</T>
                  <T num style={{ fontSize: 15, lineHeight: 19, fontWeight: '700' }}>{price}</T>
                </Press>
              ) : null}
              <GlassPress onPress={() => router.push({ pathname: '/project/[id]/send', params: { id } })} style={s.cta} accessibilityRole="button">
                <T style={[{ fontSize: 17, fontWeight: '600', color: glass.fg }, glass.text]}>{t('ed_to_client')}</T>
                <Ionicons name="paper-plane-outline" size={18} color={glass.fg} />
              </GlassPress>
            </View>
          ) : null}
        </SurfaceProvider>
      </View>
    </View>
  );
}

const lift = schemeStyles.lift;
const s = StyleSheet.create({
  lift,
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, minHeight: 60 },
  tpill: { flex: 1, minWidth: 0, height: 44, borderRadius: 22, backgroundColor: palette.white, justifyContent: 'center', paddingHorizontal: 16 },
  vsw: { flexDirection: 'row', borderRadius: 22, backgroundColor: palette.white, padding: 3 },
  vb: { height: 38, borderRadius: 19, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' },
  vbOn: { backgroundColor: palette.ink },
  vbT: { fontSize: 14, fontWeight: '600', color: palette.muted },
  row2: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', height: 36 },
  pills: { flexDirection: 'row', height: 36, borderRadius: 18, backgroundColor: palette.white, padding: 3, gap: 2 },
  pill: { height: 30, borderRadius: 15, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' },
  pillT: { fontSize: 14, fontWeight: '600', color: palette.ink },
  tool: { width: 36, height: 36, borderRadius: 18, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  mlab: { position: 'absolute', left: 12, right: 12, height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  ml: { height: 32, borderRadius: 16, paddingHorizontal: 12, backgroundColor: palette.white, justifyContent: 'center', maxWidth: '78%' },
  mlT: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.blue },
  es: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: palette.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: -4 }, elevation: 8 },
  est: { paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4 },
  seg: { flexDirection: 'row', borderRadius: 14, padding: 3, gap: 2, backgroundColor: palette.ground },
  sg: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  sgOn: { backgroundColor: palette.white, boxShadow: '0px 1px 3px rgba(33,32,31,0.10)' },
  badge: { position: 'absolute', top: 6, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: palette.red },
  shx: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  types: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  ty: { height: 36, borderRadius: 12, paddingHorizontal: 11, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 6 },
  tyOn: { backgroundColor: palette.ink },
  nw: { borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: palette.greenSoft },
  nwT: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: palette.greenDeep },
  inpWrap: { paddingTop: 6, paddingHorizontal: 16 },
  inp: { height: 46, borderRadius: 23, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 5 },
  go: { width: 36, height: 36, borderRadius: 18, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  cbar: { flexDirection: 'row', gap: 8, paddingTop: 6, paddingHorizontal: 16, alignItems: 'center' },
  pr: { height: 50, paddingHorizontal: 13, borderRadius: 16, backgroundColor: palette.ground, justifyContent: 'center' },
  cta: { flex: 1, height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
});
