/**
 * Планшет · Редактор кухни (TKitchen2.dc.html, 1194×834): «десктопный» вид — строка инструментов 52 (.tb: назад,
 * название · «прямая 2800 · 5 + 6 модулей · версия 3», «Схема / 3D», цена «до замера», «Клиенту»), слева — типы
 * модуля 256 (.pal, мини-рисунки, «новое»), в центре — поле с точками: размер стены сверху (.dtop), ряды 150 / 176
 * с размерами под каждым модулем (.dimr), внизу — строка правки словами (.cmd); справа — инспектор 320 (.ins):
 * «Модуль / Столешница / Техника / Кухня / Чат», плотные строки (.kv2), сегменты .sgm, кнопки .btn 32 r8.
 * Логика — та же, что у телефона (useKitchenEditor).
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProductCanvas } from '../../three/ProductCanvas';
import { Press, SurfaceProvider, T, resolveFont } from '../../ui/kit';
import { palette, type as ty } from '../../ui/theme';
import { DecorMenu } from '../DecorMenu';
import { KitchenChat } from '../KitchenChat';
import { KDense, KV, desk } from './KitchenControls';
import { CornerPlan, Dots, Facade, Parts, TABLET_M, facadeHeight, scaleMetrics } from './KitchenScheme';
import { useKitchenEditor, type KitchenViewProps, type RunView, type View3 } from './useKitchenEditor';

const PAL = 256;
const INS = 320;

export function KitchenWide(props: KitchenViewProps) {
  const { id, title, sub, version, price, busy, disabled, viewer, chat, onSend } = props;
  const k = useKitchenEditor(props, true);
  const { t, tree, cur, sel, tab, mode, layout, corner } = k;
  const insets = useSafeAreaInsets();
  const [cv, setCv] = useState({ w: 0, h: 0 });
  const [kb, setKb] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKb(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKb(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const scheme = mode === 'scheme';
  const KIT_Y = 92;
  const M = layout && cv.h ? scaleMetrics(TABLET_M, Math.min(1, (cv.h - KIT_Y - 80) / facadeHeight(layout, TABLET_M))) : TABLET_M;
  const hd = k.selHD();
  const lenTop = k.lenPill;

  return (
    <KDense.Provider value>
      <View style={{ flex: 1, backgroundColor: palette.ground }}>
        {/* .tb — строка инструментов */}
        <View style={{ backgroundColor: desk.bar, paddingTop: insets.top, borderBottomWidth: 1, borderBottomColor: desk.line }}>
          <View style={s.tb}>
            <Press onPress={() => (router.canGoBack() ? router.back() : router.replace(`/project/${id}`))} style={[s.btn, s.btnIc]} accessibilityRole="button" accessibilityLabel={t('ed_to_project')}>
              <Ionicons name="chevron-back" size={16} color={palette.ink} />
            </Press>
            <T style={s.tt} numberOfLines={1}>{title}</T>
            <T style={s.ts} numberOfLines={1}>{[sub ?? k.subLine, version ? t('kit_version_n', { n: version }) : null].filter(Boolean).join(' · ')}</T>
            <View style={{ flex: 1 }} />
            <View style={s.sgm} accessibilityRole="tablist">
              {(['scheme', '3d'] as View3[]).map((v) => (
                <Press key={v} feedback="opacity" onPress={() => { k.setMode(v); Keyboard.dismiss(); }} accessibilityRole="tab" accessibilityState={{ selected: mode === v }} style={[s.sgmB, mode === v && s.sgmOn]}>
                  <T style={[s.sgmT, mode === v && { color: palette.ink }]}>{v === 'scheme' ? t('kit_v_scheme') : t('kit_v_3d')}</T>
                </Press>
              ))}
            </View>
            <View style={{ flex: 1 }} />
            <Press onPress={() => k.setMenu(true)} style={[s.btn, s.btnIc]} accessibilityRole="button" accessibilityLabel={t('ed2_kitchen_tools')}>
              <Ionicons name="color-palette-outline" size={16} color={palette.ink} />
            </Press>
            {price && price !== '—' ? (
              <Press onPress={() => router.push({ pathname: '/project/[id]/estimate', params: { id } })} style={s.btn} accessibilityRole="button">
                <T style={{ fontSize: 12, lineHeight: 16, color: palette.muted }}>{t('ed_before_measure')}</T>
                <T num style={s.btnT}>{price}</T>
              </Press>
            ) : null}
            <Press onPress={() => router.push({ pathname: '/project/[id]/send', params: { id } })} style={[s.btn, s.pri]} accessibilityRole="button">
              <Ionicons name="paper-plane-outline" size={15} color={palette.white} />
              <T style={[s.btnT, { color: palette.white }]}>{t('ed_to_client')}</T>
            </Press>
          </View>
        </View>
        <View style={s.panes}>
          {/* .pal — типы модуля */}
          <View style={s.pal}>
            <T style={s.ph}>{t('kit_types')}</T>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 2, paddingBottom: 12 }}>
              {k.typeItems.map((it) => (
                <Press key={it.key} feedback="row" onPress={it.pick} disabled={k.lock} accessibilityRole="radio" accessibilityState={{ selected: it.on }} style={[s.pt, it.on && s.ptOn]}>
                  <View style={[s.gl2, it.on && { backgroundColor: '#3A3936' }]}>
                    <View style={{ position: 'absolute', left: 1.5, top: 1.5, right: 1.5, bottom: 1.5 }}><Parts parts={it.parts} w={19} h={19} small /></View>
                  </View>
                  <T style={{ flex: 1, fontSize: 13, lineHeight: 17, fontWeight: '500', color: it.on ? palette.white : palette.ink }} numberOfLines={1}>{it.label}</T>
                  {it.isNew ? <View style={[s.nw, it.on && { backgroundColor: palette.green }]}><T style={[s.nwT, it.on && { color: palette.white }]}>{t('kit_new')}</T></View> : null}
                </Press>
              ))}
              <T style={[s.cap2, { paddingHorizontal: 14, paddingTop: 10 }]}>{k.typeItems.length ? t('kit_types_hint') : t('kit_types_none')}</T>
            </ScrollView>
          </View>
          {/* .cvs — схема / 3D и строка правки */}
          <View style={s.cvs} onLayout={(e) => setCv({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
            <Dots />
            {cv.w ? (
              scheme ? (
                layout ? (
                  <>
                    {lenTop != null ? (
                      <View pointerEvents="none" style={[s.dtop, { left: 44, right: 44 }]}>
                        <View style={s.dtopLine} />
                        <View style={s.dtopLab}><T num style={s.dtopT}>{`${lenTop} ${t('mm')}`}</T></View>
                      </View>
                    ) : null}
                    <Facade tree={tree} layout={layout} run={k.runView === 2 ? 2 : 1} sel={sel} ctOn={tab === 'top'} onPick={k.pick} onAdd={k.lock ? undefined : k.addModule}
                      lbl={k.lbl} x0={0} width={cv.w} y0={KIT_Y} M={M} addLabels={{ base: t('kit_add_base'), wall: t('kit_add_wall'), mid: t('kit_add_mid') }} cornerLabel={t('kit_k_corner')} tierLabel={t('kit_k_tier')}
                      badRow={k.sumRow} />
                  </>
                ) : (
                  <CornerPlan tree={tree} base={k.base} base2={k.base2} sel={tab === 'mod' ? sel : null} onPick={k.pick} lbl={(m) => k.shortLbl(m, 'base')} x0={20} width={cv.w - 40} y0={70} maxH={cv.h - 200} />
                )
              ) : (
                <>
                  <View style={StyleSheet.absoluteFill}>
                    <ProductCanvas ref={k.canvas} model={viewer} transparent busy={busy} fallbackText={t('ed_3d_unavailable')}
                      freeArea={{ top: 44, bottom: 72 }} freeAreaPadding={24} dimensionLines={k.dims} dimensions={k.dims ? undefined : []}
                      onPartTap={(p) => k.onPart3d(p?.key ?? null)} />
                  </View>
                  <T style={[s.cap2, { position: 'absolute', left: 16, top: 14 }]}>{t('kit_3d_hint_t')}</T>
                  <View style={{ position: 'absolute', right: 16, bottom: 72 + insets.bottom, flexDirection: 'row', gap: 6 }}>
                    <Press onPress={k.toggleOpen} style={s.btn} accessibilityRole="button">
                      <Ionicons name={k.openAll ? 'eye-off-outline' : 'eye-outline'} size={15} color={palette.ink} />
                      <T style={s.btnT}>{t(k.openAll ? 'ed_view_close' : 'ed_view_open')}</T>
                    </Press>
                    <Press onPress={() => k.setDims(!k.dims)} style={[s.btn, k.dims && { backgroundColor: palette.blueSoft, borderColor: palette.blueSoft }]} accessibilityRole="switch" accessibilityState={{ checked: k.dims }}>
                      <Ionicons name="resize-outline" size={15} color={k.dims ? palette.blue : palette.ink} />
                      <T style={[s.btnT, k.dims && { color: palette.blue }]}>{t('ed_dims')}</T>
                    </Press>
                  </View>
                </>
              )
            ) : null}
            {scheme && corner ? (
              <View style={[s.sgm, { position: 'absolute', left: 16, top: 12 }]} accessibilityRole="tablist">
                {(['plan', 1, 2] as RunView[]).map((r) => (
                  <Press key={String(r)} feedback="opacity" onPress={() => k.setRunView(r)} accessibilityRole="tab" accessibilityState={{ selected: k.runView === r }} style={[s.sgmB, k.runView === r && s.sgmOn]}>
                    <T style={[s.sgmT, k.runView === r && { color: palette.ink }]}>{r === 'plan' ? t('kit_v_plan') : r === 1 ? t('kit_wall_a') : t('kit_wall_b')}</T>
                  </Press>
                ))}
              </View>
            ) : null}
            {/* .cmd — правка словами */}
            <View style={[s.cmd, { bottom: kb ? kb - insets.bottom + 10 : 14 + insets.bottom }]}>
              <Ionicons name="sparkles-outline" size={16} color={palette.faint} />
              <TextInput value={k.text} onChangeText={k.setText} placeholder={chat.aiLimited || disabled ? k.placeholder : t('kit_cmd', { ex: k.placeholder })} placeholderTextColor={palette.faint}
                editable={!disabled && !chat.running && !chat.aiLimited} onSubmitEditing={k.send} returnKeyType="send" accessibilityLabel={t('ed_say')}
                style={resolveFont([ty.body, { flex: 1, fontSize: 14, color: palette.ink, paddingVertical: 0 }])} />
              <Pressable onPress={k.send} disabled={!k.text.trim() || disabled || chat.running} accessibilityLabel={t('ed_send')} style={[s.go, !k.text.trim() && !chat.running && { opacity: 0.4 }]}>
                {chat.running ? <ActivityIndicator size="small" color={palette.white} /> : <Ionicons name="arrow-up" size={16} color={palette.white} />}
              </Pressable>
            </View>
          </View>
          {/* .ins — инспектор */}
          <View style={s.ins}>
            <SurfaceProvider value="white">
              <View style={s.hd2}>
                <View style={[s.sgm, { flexDirection: 'row' }]} accessibilityRole="tablist">
                  {k.tabs.map((x) => (
                    <Press key={x} feedback="opacity" onPress={() => { k.setTab(x); Keyboard.dismiss(); }} accessibilityRole="tab" accessibilityState={{ selected: tab === x }}
                      style={[s.sgmB, { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', paddingHorizontal: 4 }, tab === x && s.sgmOn]}>
                      <T style={[s.sgmT, { fontSize: 12.5 }, tab === x && { color: palette.ink }]} numberOfLines={1}>{k.tabLabel[x]}</T>
                      {x === 'chat' && k.chatBadge ? <View style={s.badge} /> : null}
                    </Press>
                  ))}
                </View>
              </View>
              {tab === 'chat' ? (
                <View style={{ flex: 1, paddingHorizontal: 14, paddingBottom: Math.max(insets.bottom, 8) }}>
                  <KitchenChat {...chat} dense note={t('kit_chat_note')} busy={chat.busy || busy} disabled={disabled} onSend={onSend} />
                </View>
              ) : (
                <ScrollView ref={k.panelScroll} style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 12, paddingHorizontal: 14, gap: 12, paddingBottom: 12 + insets.bottom }} keyboardShouldPersistTaps="handled">
                  {tab === 'mod' && cur ? (
                    cur.kind === 'corner' && !sel.tier ? k.cornerPanel() : (
                      <>
                        <View style={s.sel2}>
                          <T style={{ flex: 1, fontSize: 15, lineHeight: 19, fontWeight: '700' }} numberOfLines={2}>{k.selLabel}</T>
                          <View style={s.pillB}><T style={s.pillBT}>{k.rowName}</T></View>
                        </View>
                        {!sel.tier ? (
                          <View>
                            <T style={[s.lab2, { marginBottom: 6 }]}>{t('p_width')}</T>
                            {k.widthRow()}
                          </View>
                        ) : null}
                        {sel.row !== 'mid' ? k.sumBanner : null}
                        {!sel.tier ? (
                          <View>
                            {sel.row !== 'mid' && cur.kind !== 'gap' ? k.frontRow() : null}
                            <KV k={t('kit_body')} v={k.decorName(tree.body?.material)} />
                            {hd ? <KV k={t('p_height')} v={`${hd.h} ${t('mm')}`} num /> : null}
                            {hd ? <KV k={t('p_depth')} v={`${hd.d} ${t('mm')}`} num /> : null}
                          </View>
                        ) : null}
                        {k.modFields()}
                        {sel.row !== 'mid' && !sel.tier && cur.kind !== 'gap' ? (
                          <Press onPress={() => router.push({ pathname: '/project/[id]/materials', params: { id } })} style={[s.btn, { alignSelf: 'flex-start' }]} accessibilityRole="button">
                            <T style={s.btnT}>{t('kit_mod_materials')}</T>
                          </Press>
                        ) : null}
                        {k.actions()}
                      </>
                    )
                  ) : null}
                  {tab === 'top' ? k.topPanel() : null}
                  {tab === 'app' ? k.appPanel() : null}
                  {tab === 'kit' ? k.kitPanel() : null}
                </ScrollView>
              )}
            </SurfaceProvider>
          </View>
        </View>
        <DecorMenu id={id} tree={tree} visible={k.menu} onClose={() => k.setMenu(false)} withHardware />
      </View>
    </KDense.Provider>
  );
}

const s = StyleSheet.create({
  tb: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 },
  tt: { fontSize: 16, lineHeight: 20, fontWeight: '700', letterSpacing: -0.16, flexShrink: 1 },
  ts: { fontSize: 13, lineHeight: 17, color: palette.muted, flexShrink: 2 },
  btn: { height: 32, borderRadius: 8, backgroundColor: palette.white, borderWidth: 1, borderColor: desk.ring, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11 },
  btnIc: { width: 32, paddingHorizontal: 0, justifyContent: 'center' },
  btnT: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  pri: { backgroundColor: palette.green, borderColor: palette.green },
  sgm: { flexDirection: 'row', borderRadius: 8, padding: 2, backgroundColor: desk.sgm },
  sgmB: { height: 28, borderRadius: 6, paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center' },
  sgmOn: { backgroundColor: palette.white, boxShadow: '0px 1px 2px rgba(0,0,0,0.08)' },
  sgmT: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.muted2 },
  panes: { flex: 1, minHeight: 0, flexDirection: 'row' },
  pal: { width: PAL, borderRightWidth: 1, borderRightColor: desk.line, backgroundColor: desk.pal },
  ph: { height: 40, lineHeight: 40, paddingHorizontal: 14, fontSize: 12, fontWeight: '700', color: desk.label, textTransform: 'uppercase', letterSpacing: 0.5 },
  pt: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 34, marginHorizontal: 8, paddingHorizontal: 12, borderRadius: 8 },
  ptOn: { backgroundColor: palette.ink },
  gl2: { width: 22, height: 22, borderRadius: 5, backgroundColor: '#F4F2EC', borderWidth: 1.5, borderColor: '#8E8B85', overflow: 'hidden' },
  nw: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: palette.greenSoft },
  nwT: { fontSize: 10, lineHeight: 13, fontWeight: '700', color: palette.greenDeep },
  cap2: { fontSize: 12, lineHeight: 16, color: palette.muted },
  cvs: { flex: 1, minWidth: 0, overflow: 'hidden' },
  dtop: { position: 'absolute', top: 52, height: 20, alignItems: 'center' },
  dtopLine: { position: 'absolute', left: 0, right: 0, top: 9, height: 1, backgroundColor: palette.blue },
  dtopLab: { paddingHorizontal: 8, backgroundColor: palette.ground },
  dtopT: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: palette.blue },
  cmd: { position: 'absolute', left: 16, right: 16, height: 44, borderRadius: 12, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 6, boxShadow: '0px 4px 18px rgba(33,32,31,0.12)' },
  go: { width: 32, height: 32, borderRadius: 8, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  ins: { width: INS, borderLeftWidth: 1, borderLeftColor: desk.line, backgroundColor: palette.white },
  hd2: { paddingTop: 12, paddingHorizontal: 14, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: desk.row },
  badge: { position: 'absolute', top: 4, right: 3, width: 7, height: 7, borderRadius: 4, backgroundColor: palette.red },
  sel2: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pillB: { height: 20, borderRadius: 6, paddingHorizontal: 7, backgroundColor: palette.blueSoft, justifyContent: 'center' },
  pillBT: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: palette.blue },
  lab2: { fontSize: 12, lineHeight: 16, fontWeight: '700', color: desk.label, textTransform: 'uppercase', letterSpacing: 0.5 },
});
