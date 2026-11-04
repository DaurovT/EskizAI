/**
 * SCR-51 Комната (RoomColor.dc.html): модель на фоне стены и пола; «Стены» — показать/скрыть (`walls_visible`),
 * «Только для вида» — комната не влияет на детали, смету и AR. Шторка: цвет стен — «С фото клиента · авто»
 * (`room_colors.source: photo`), палитра и свой HEX; пол — пресеты `floor_material` (дуб, орех, плитка, бетон, ковролин).
 * «Готово» — сохраняет `room_colors` новой версией (если что-то поменяли).
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ImageBackground, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../../src/api';
import { FLOORS } from '../../../src/api/mock/decorMock';
import type { FloorMaterial, ProductTree } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { ProductCanvas, type CanvasHandle } from '../../../src/three/ProductCanvas';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { SmallToggle } from '../../../src/ui/Gradient';
import { Button, IconButton, Loading, Press, SurfaceProvider, T, resolveFont, toast } from '../../../src/ui/kit';
import { palette, type as ty } from '../../../src/ui/theme';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const DOTS = require('../../../assets/dots.png');
/** Палитра стен — как в макете. */
const PAL = ['#F6F4EF', '#EFE8DA', '#E6D9C3', '#DCD3C2', '#D3CFC8', '#CDD2D4', '#C9D3C2', '#CBD8E2', '#E7D3CC'];
type RC = { wall?: string; floor?: string; floor_material?: string; walls_visible?: boolean; source?: 'photo' | 'manual' };

export default function RoomColor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const model = useResource(() => api.getModel(id), [id]);
  const card = useResource(() => api.getProject(id).catch(() => null), [id]);
  const opts = useResource(() => api.getBuiltinOptions().catch(() => null), [], { refetchOnFocus: false });
  const canvas = useRef<CanvasHandle>(null);
  const [rc, setRc] = useState<RC | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Верх шторки — по нему пол (видно 58 pt пола над шторкой, как в макете). */
  const [sheetTop, setSheetTop] = useState(0);
  const base = (model.data?.version.tree.room_colors ?? null) as RC | null;
  useEffect(() => { if (model.data) setRc({ ...(base ?? {}) }); }, [model.data?.version.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // стены рисуем плоско сами — комнату вьюера прячем
  useEffect(() => { const tm = setTimeout(() => canvas.current?.setRoomVisible(false), 400); return () => clearTimeout(tm); }, [model.data?.version.id]);

  if (model.loading && !rc) return <Loading />;
  if (!model.data || !rc) return <ErrorState error={model.error} onRetry={model.reload} />;
  const floors: FloorMaterial[] = opts.data?.room?.floor_materials ?? FLOORS;
  // цвет с фото: из этой версии, если источник — фото
  const photo = base?.source === 'photo' ? base.wall ?? null : null;
  const fromPhoto = rc.source === 'photo' && !!photo;
  const wall = (fromPhoto ? photo : rc.wall) ?? '#E3D7C6';
  const fl = floors.find((f) => f.id === rc.floor_material) ?? null;
  const floor = rc.floor ?? fl?.color ?? '#D9BF94';
  const wallsOn = rc.walls_visible !== false;
  const palIdx = PAL.findIndex((c) => c.toLowerCase() === (rc.wall ?? '').toLowerCase());
  const dirty = JSON.stringify(rc) !== JSON.stringify(base ?? {});
  const title = [card.data?.title, card.data?.client?.name].filter(Boolean).join(' · ');
  const done = async () => {
    if (!dirty) return router.back();
    setSaving(true);
    try {
      const tree: ProductTree = { ...model.data!.version.tree, room_colors: clean(rc) };
      await api.saveModel(id, { tree, source: 'manual', label: t('rc_saved') });
      toast.show({ text: t('rc_saved'), tone: 'success' });
      router.back();
    } catch (e) { showError(e, lang); } finally { setSaving(false); }
  };
  const pickWall = (hex: string) => setRc({ ...rc, wall: hex.toUpperCase(), source: 'manual' });

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* комната: стена с плинтусом и пол — или точки, если стены выключены */}
      <View style={StyleSheet.absoluteFill}>
        {wallsOn ? (
          <>
            <View style={{ height: Math.max(200, (sheetTop || 480) - 58), backgroundColor: wall }}>
              <View style={s.skirt} />
            </View>
            <FloorSwatch m={fl} color={floor} style={{ height: 90 }} big />
          </>
        ) : (
          <ImageBackground source={DOTS} resizeMode="repeat" style={{ flex: 1, backgroundColor: '#ECEBE7' }} imageStyle={{ resizeMode: 'repeat' }} />
        )}
      </View>
      <View style={[s.shadow, { top: Math.max(200, (sheetTop || 480) - 58) - 8 }]} />
      <View style={{ position: 'absolute', left: 0, right: 0, top: insets.top + 110, height: Math.max(160, (sheetTop || 480) - 58 - insets.top - 110 + 14) }}>
        <ProductCanvas ref={canvas} model={model.data.version.viewer} showDims={false} fallbackText={t('ed_3d_unavailable')} transparent />
      </View>

      <View style={[s.hdr, { paddingTop: insets.top + 12 }]} pointerEvents="box-none">
        <IconButton icon="chevron-back" label={t('back')} onPress={() => router.back()} style={s.lift} />
        <View style={[s.tpill, s.lift]}>
          <T style={{ fontSize: 15, lineHeight: 19, fontWeight: '600' }} numberOfLines={1}>{title || t('ed_title')}</T>
          <T style={{ fontSize: 13, lineHeight: 16, color: palette.muted }} numberOfLines={1}>{t('rc_sub')}</T>
        </View>
      </View>
      <View style={s.pills} pointerEvents="box-none">
        <View style={[s.pillb, { paddingRight: 6 }]}>
          <T style={{ fontSize: 15, fontWeight: '500' }}>{t('rc_walls')}</T>
          <SmallToggle value={wallsOn} onValueChange={(v) => setRc({ ...rc, walls_visible: v })} accessibilityLabel={t('rc_walls')} />
        </View>
        <View style={s.pillb}><T style={{ fontSize: 15, fontWeight: '500', color: palette.muted }}>{t('rc_view_only')}</T></View>
      </View>

      {/* шторка: цвет стен и пол */}
      <View style={[s.cs, { paddingBottom: Math.max(insets.bottom, 16) }]} onLayout={(e) => setSheetTop(e.nativeEvent.layout.y)}>
        <SurfaceProvider value="white">
          <View style={s.hdl}><View style={s.hdlBar} /></View>
          <View style={s.headRow}>
            <T style={s.h18}>{t('rc_wall_color')}</T>
            <T style={s.lab}>{fromPhoto ? t('rc_from_photo', { hex: photo! }) : palIdx >= 0 ? t(`rc_c${palIdx}` as 'rc_c0') : rc.wall ?? ''}</T>
          </View>
          <Press feedback="scale" disabled={!photo} onPress={() => setRc({ ...rc, wall: photo ?? undefined, source: 'photo' })} accessibilityRole="radio" accessibilityState={{ selected: fromPhoto }}
            style={[s.photo, fromPhoto && { borderColor: palette.ink }, !photo && { opacity: 0.5 }]}>
            <View style={[s.c, { width: 40, height: 40, backgroundColor: photo ?? '#E3D7C6' }]} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '600' }}>{t('rc_photo')}</T>
              <T style={s.lab} numberOfLines={1}>{photo ? t('rc_photo_sub') : t('rc_no_photo_sub')}</T>
            </View>
            {photo ? <View style={s.auto}><T style={{ fontSize: 13, fontWeight: '600', color: '#275C3A' }}>{t('rc_auto')}</T></View> : null}
          </Press>
          {[0, 5].map((r0) => (
          <View key={r0} style={s.sw}>
            {PAL.slice(r0, r0 + 5).map((c, j) => {
              const i = r0 + j;
              const on = !fromPhoto && palIdx === i;
              return (
                <Press key={c} feedback="opacity" onPress={() => pickWall(c)} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={t(`rc_c${i}` as 'rc_c0')} style={[s.ring, on && s.ringOn]}>
                  <View style={[s.c, { backgroundColor: c }]} />
                </Press>
              );
            })}
            {r0 === 5 ? <Press feedback="opacity" onPress={() => setCustom(custom == null ? (rc.wall ?? '#') : null)} accessibilityRole="button" accessibilityLabel={t('rc_custom')} style={s.ring}>
              <View style={[s.c, { backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="add" size={20} color={palette.ink} /></View>
            </Press> : null}
          </View>
          ))}
          {custom != null ? (
            <TextInput value={custom} onChangeText={(v) => { setCustom(v); if (/^#[0-9a-fA-F]{6}$/.test(v)) pickWall(v); }} autoCapitalize="characters" autoFocus placeholder={t('rc_hex')}
              placeholderTextColor={palette.faint} style={resolveFont([ty.body, s.hex])} maxLength={7} />
          ) : null}
          <View style={[s.headRow, { marginTop: 2 }]}>
            <T style={s.h18}>{t('rc_floor')}</T>
            <T style={s.lab}>{fl ? (lang === 'uz' ? fl.name_uz : fl.name) : ''}</T>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {floors.map((f) => {
              const on = f.id === rc.floor_material;
              return (
                <Press key={f.id} feedback="opacity" onPress={() => { const { floor: _f, ...rest } = rc; setRc({ ...rest, floor_material: f.id }); }} accessibilityRole="radio" accessibilityState={{ selected: on }} style={{ flex: 1, alignItems: 'center', gap: 5 }}>
                  <View style={[s.fsRing, on && { borderColor: palette.ink }]}><FloorSwatch m={f} color={f.color} style={{ height: 40, borderRadius: 12 }} /></View>
                  <T style={{ fontSize: 12, lineHeight: 15, color: on ? palette.ink : palette.muted, fontWeight: on ? '600' : '400', width: 96, textAlign: 'center' }} numberOfLines={1}>{lang === 'uz' ? f.name_uz : f.name}</T>
                </Press>
              );
            })}
          </View>
          <Button title={t('done')} onPress={done} loading={saving} style={{ marginTop: 4 }} />
        </SurfaceProvider>
      </View>
    </View>
  );
}

/** В дерево — только поля схемы RoomColors. */
function clean(rc: RC): RC {
  const o: RC = {};
  if (rc.wall) o.wall = rc.wall;
  if (rc.floor) o.floor = rc.floor;
  if (rc.floor_material) o.floor_material = rc.floor_material;
  if (rc.walls_visible === false) o.walls_visible = false;
  o.source = rc.source ?? 'manual';
  return o;
}

/** Плашка пола: доски/плитка — швами, бетон и ковролин — ровным цветом. */
function FloorSwatch({ m, color, style, big }: { m: FloorMaterial | null; color: string; style?: object; big?: boolean }) {
  const step = m?.texture === 'tiles' ? 30 : 28;
  const lines = m && (m.texture === 'planks' || m.texture === 'tiles') ? Array.from({ length: big ? 16 : 6 }, (_, i) => i) : [];
  return (
    <View style={[{ backgroundColor: color, overflow: 'hidden', flexDirection: 'row' }, style]}>
      {lines.map((i) => <View key={i} style={{ position: 'absolute', left: (i + 1) * step - 2, top: 0, bottom: 0, width: 2, backgroundColor: m!.seam }} />)}
      {m?.texture === 'speckle' ? <View style={{ position: 'absolute', left: '30%', top: '40%', width: 2, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.4)' }} /> : null}
    </View>
  );
}

const shadow = { shadowColor: palette.ink, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 };
const s = StyleSheet.create({
  lift: shadow,
  skirt: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 12, backgroundColor: 'rgba(255,255,255,0.55)', borderBottomWidth: 2, borderBottomColor: 'rgba(33,32,31,0.06)' },
  shadow: { position: 'absolute', alignSelf: 'center', width: 210, height: 18, borderRadius: 105, backgroundColor: 'rgba(33,32,31,0.12)' },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  tpill: { flex: 1, minWidth: 0, height: 44, borderRadius: 22, backgroundColor: palette.white, justifyContent: 'center', paddingHorizontal: 16 },
  pills: { flexDirection: 'row', gap: 8, paddingTop: 6, paddingHorizontal: 12 },
  pillb: { height: 40, borderRadius: 20, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  cs: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: palette.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 16, gap: 10, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: -4 } },
  hdl: { height: 22, alignItems: 'center', justifyContent: 'center' },
  hdlBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: palette.handle },
  headRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  h18: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  lab: { fontSize: 13, lineHeight: 16, color: palette.muted },
  photo: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: palette.ground, borderRadius: 18, paddingVertical: 8, paddingLeft: 8, paddingRight: 12, borderWidth: 2, borderColor: 'transparent' },
  auto: { height: 24, borderRadius: 9, paddingHorizontal: 10, justifyContent: 'center', backgroundColor: palette.greenSoft },
  sw: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6 },
  ring: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', margin: -5, borderWidth: 2, borderColor: 'transparent' },
  ringOn: { borderColor: palette.ink },
  c: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(33,32,31,0.14)' },
  hex: { height: 44, borderRadius: 14, backgroundColor: palette.ground, paddingHorizontal: 14, fontSize: 16, color: palette.ink },
  fsRing: { alignSelf: 'stretch', borderRadius: 15, borderWidth: 2, borderColor: 'transparent', padding: 1 },
});
