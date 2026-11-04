/**
 * SCR-13 Замер (Measure.dc.html): «Ниша в 5 точках» — схема где мерить, ширина вверху / посередине / внизу, высота
 * слева / справа, глубина; самая узкая точка — синей рамкой, расхождение с эскизом — янтарём; «считаю по узкой точке,
 * перекос уйдёт в добор». «Фото и заметки» — плинтус, фото замера, заметки для цеха. «Зафиксировать и пересчитать»;
 * у встроенного шкафа замер уходит как `niche` (корпус по самому узкому месту, перекос — в доборы), ссылка на «Встройку».
 * Кухня — свой замер (SCR-13b, MeasureKitchen). Без сети замер сохраняется в телефоне и уходит при связи (NFR-07).
 */
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, TextInput, View, type TextInputInstance } from 'react-native';
import { api } from '../../../src/api';
import type { NicheMeasure } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { builtinOf, nicheHeights, nicheWidths } from '../../../src/lib/decorStyle';
import { formatDate } from '../../../src/lib/format';
import { MeasureKitchen } from '../../../src/screens/MeasureKitchen';
import { updateMeta } from '../../../src/state/projectMeta';
import { useOffline } from '../../../src/state/net';
import { showError } from '../../../src/ui/dialogs';
import { FitSegmented } from '../../../src/ui/Gradient';
import { Banner, Button, Card, Field, Press, Screen, T, resolveFont } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

/** «в 14:20» сегодня, иначе дата. */
export function agreedWhen(iso: string, t: ReturnType<typeof useT>['t'], lang: 'ru' | 'uz') {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  return today ? t('ms_at', { time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }) : t('ms_on', { date: formatDate(iso, lang) });
}

type P = 'width_top' | 'width_middle' | 'width_bottom' | 'height_left' | 'height_right' | 'depth';

export default function Measure() {
  const { id, devCorner, devTab } = useLocalSearchParams<{ id: string; devCorner?: string; devTab?: string }>();
  const { t, lang } = useT();
  const offline = useOffline();
  const model = useResource(() => api.getModel(id), [id]);
  const card = useResource(() => api.getProject(id), [id]);
  const history = useResource(() => api.listMeasurements(id).catch(() => []), [id]);
  const pending = useResource(() => api.pendingMeasurements(id), [id]);
  const [n, setN] = useState<NicheMeasure>({});
  const [plinth, setPlinth] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [inited, setInited] = useState(false);
  const [tab, setTab] = useState<'niche' | 'photo'>(devTab === 'photo' ? 'photo' : 'niche');

  let tree = model.data?.version.tree;
  // dev: угловая кухня как в макете (?devCorner=1): стена Б на 5 мм короче шкафов, окно, выводы — без сервера
  if (__DEV__ && devCorner && tree?.type === 'kitchen') {
    const a = ((tree.base as { width?: number }[] | undefined) ?? []).reduce((x, c) => x + (c.width ?? 0), 0);
    tree = { ...tree, layout: 'corner', base2: [{ kind: 'drawers', width: 600 }, { kind: 'door', width: 600 }], site: {
      wall_a: a, wall_b: 1795, ceiling: 2700, window: { wall: 'a', from_corner: 1200, width: 1200, sill: 900 },
      utilities: [
        { kind: 'water', wall: 'a', from_corner: 1650, height: 500 }, { kind: 'sewer', wall: 'a', from_corner: 1700, height: 300 },
        { kind: 'gas', wall: 'a', from_corner: 600, height: 900 }, { kind: 'socket', wall: 'a', from_corner: 300, height: 1100 },
        { kind: 'vent', wall: 'b', from_corner: 200, size: '200 × 150' },
      ] } };
  }
  const builtin = !!tree && (tree.installation === 'niche' || !!tree.builtin);
  useEffect(() => {
    if (tree && !inited) {
      // начальные значения: замер ниши из модели, иначе размеры эскиза в каждой точке
      const nm = builtin ? builtinOf(tree).niche ?? {} : {};
      const w = tree.width ?? null, h = tree.height ?? null;
      setN({ width_top: nm.width_top ?? nm.width ?? w, width_middle: nm.width_middle ?? nm.width ?? w, width_bottom: nm.width_bottom ?? nm.width ?? w,
        height_left: nm.height_left ?? nm.height ?? h, height_right: nm.height_right ?? nm.height ?? h, depth: nm.depth ?? tree.depth ?? null, lean: nm.lean ?? null });
      const pl = (tree as { plinth_height?: number | null }).plinth_height ?? (tree.body?.plinth as { height?: number } | undefined)?.height;
      setPlinth(typeof pl === 'number' ? pl : null);
      setInited(true);
    }
  }, [tree, inited, builtin]);

  // Кухня — свой замер: стены, окно, коммуникации (SCR-13b)
  if (tree?.type === 'kitchen') {
    return <MeasureKitchen id={id} tree={tree} card={card.data} offline={offline} history={history.data ?? []} pending={pending.data?.length ?? 0} initialTab={__DEV__ && (devTab === 'walls' || devTab === 'utils') ? devTab : 'walls'} />;
  }

  const widths = nicheWidths(n), heights = nicheHeights(n);
  const wMin = widths.length ? Math.min(...widths) : null;
  const skew = widths.length > 1 ? Math.max(...widths) - Math.min(...widths) : 0;
  const hMin = heights.length ? Math.min(...heights) : null;
  const prevN = builtin && tree ? builtinOf(tree).niche ?? null : null;
  const ref = (k: 'height_left' | 'height_right') => (builtin ? prevN?.[k] ?? prevN?.height ?? null : tree?.height ?? null);
  const dH = builtin ? 0 : hMin != null && tree?.height ? Math.round(hMin - tree.height) : 0;
  const minKey: P | null = wMin == null ? null : (['width_top', 'width_middle', 'width_bottom'] as P[]).find((k) => n[k] === wMin) ?? null;
  const set = (k: P) => (v: number | null) => setN((x) => ({ ...x, [k]: v }));
  const p = card.data;
  const clientName = p?.client?.name?.split(' ')[0];

  const addPhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      const r = perm.granted
        ? await ImagePicker.launchCameraAsync({ quality: 0.7 }).catch(() => ImagePicker.launchImageLibraryAsync({ quality: 0.7 }))
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
      if (!r.canceled) setPhotos((ps) => [...ps, r.assets[0].uri]);
    } catch {
      Alert.alert(t('new_permission_camera'));
    }
  };

  const fix = async () => {
    setBusy(true);
    try {
      // Встроенный шкаф: замер ниши (корпус по узкой точке, перекос — в доборы); иначе — габариты по узким точкам
      const data = { ...(plinth != null ? { plinth } : {}), ...(builtin ? {} : { points: n }) };
      const m = await api.addMeasurement(id, {
        width: wMin, height: hMin, depth: n.depth ?? null, notes: notes.trim() || null, data, apply_to_model: !offline,
        ...(builtin ? { niche: { ...n, lean: n.lean ?? undefined } } : {}),
      });
      const queued = m.id.startsWith('pending-');
      let message = queued ? t('ms_queued') : t('ms_saved');
      if (!queued) {
        for (const [i, uri] of photos.entries()) {
          await api.uploadPhoto(id, { uri, name: `measure-${i + 1}.jpg`, type: 'image/jpeg' }, 'measurement').catch(() => undefined);
        }
        updateMeta(id, (mm) => ({ estimated: mm.estimated.filter((x) => !['/width', '/height', '/depth'].includes(x)) }));
        if (m.applied_version_id) message = `${message}\n${t('ms_applied')}`;
        else if (m.apply_error) message = `${message}\n${t('ms_apply_error', { e: m.apply_error })}`;
      }
      Alert.alert(message);
      router.back();
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(false);
    }
  };

  const f = (k: P, label: string, extra?: { est?: number }) => (
    <MF key={k} label={label} value={n[k] ?? null} onChange={set(k)} min={k === 'depth' ? 100 : 200} max={10000} unit={t('mm')}
      state={extra?.est ? 'est' : minKey === k ? 'min' : null} badge={extra?.est ? `${extra.est > 0 ? '+' : '−'}${Math.abs(extra.est)}` : null} />
  );

  return (
    <Screen gap={8} contentStyle={{ paddingTop: 0 }} footerStyle={{ paddingTop: 6, gap: 2 }} footer={
      <>
        <Button title={t('ms_fix_recalc')} onPress={fix} loading={busy} disabled={!wMin && !hMin} />
        <Button v="ghost" title={t('ms2_builtin')} onPress={() => router.push(`/project/${id}/builtin`)} style={{ minHeight: 36 }} />
      </>
    }>
      <Stack.Screen options={{ title: '' }} />
      <T style={st.h1}>{t('ms_title')}</T>
      {p?.client_agreed_at && clientName ? (
        <Banner tone="ok" textStyle={BAN14} icon="checkmark" style={{ alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14 }}
          text={t('ms_agreed', { name: clientName, when: agreedWhen(p.client_agreed_at, t, lang) })} />
      ) : null}
      <FitSegmented value={tab} onChange={setTab} options={[{ value: 'niche', label: t('ms2_tab_niche') }, { value: 'photo', label: t('ms2_tab_photo') }]} />
      {tab === 'niche' ? (
        <>
          <NicheScheme n={n} />
          <View style={st.g3}>{[f('width_top', t('ms2_top')), f('width_middle', t('ms2_mid')), f('width_bottom', t('ms2_bot'))]}</View>
          <View style={st.g3}>
            {f('height_left', t('ms2_left'), { est: n.height_left != null && ref('height_left') ? Math.round(n.height_left - ref('height_left')!) : 0 })}
            {f('height_right', t('ms2_right'), { est: n.height_right != null && ref('height_right') ? Math.round(n.height_right - ref('height_right')!) : 0 })}
            {f('depth', t('ms2_depth'))}
          </View>
          {wMin ? (
            <Banner tone="info" icon="information-circle-outline" textStyle={BAN14} style={{ alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14 }}
              text={skew ? t('ms2_narrow', { w: wMin, d: skew }) : t('ms2_narrow0', { w: wMin })} />
          ) : null}
          {dH ? (
            <Banner tone="est" icon="warning-outline" textStyle={BAN14} style={{ alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14 }}
              text={t(dH > 0 ? 'ms2_h_more' : 'ms2_h_less', { v: Math.abs(dH) })} />
          ) : null}
        </>
      ) : (
        <>
          <View style={st.g2}>
            <MF label={t('ms2_plinth')} value={plinth} onChange={setPlinth} min={0} max={300} unit={t('mm')} nullable />
          </View>
          <T style={st.hd}>{t('ms2_photo_h')}</T>
          <View style={st.photos}>
            {photos.map((uri, i) => (
              <Press key={uri} feedback="scale" onLongPress={() => setPhotos((ps) => ps.filter((x) => x !== uri))} accessibilityLabel={t('ms_photo_n', { n: i + 1 })}>
                <Image source={{ uri }} style={st.ph} />
              </Press>
            ))}
            <Press onPress={addPhoto} accessibilityRole="button" accessibilityLabel={t('ms_add_photo')} style={[st.ph, st.add]}>
              <Ionicons name="camera-outline" size={26} color={palette.ink} />
            </Press>
          </View>
          <Field label={t('ms_notes_shop')} value={notes} onChangeText={setNotes} multiline multilineMinHeight={68} style={{ fontSize: 16 }} />
          {history.data?.length ? (
            <Card>
              <T v="lbl">{t('ms_history')}</T>
              {history.data.map((m) => <T key={m.id} v="rs" num style={{ marginTop: 4 }}>{formatDate(m.created_at, lang)}: {m.width ?? '—'} × {m.height ?? '—'} × {m.depth ?? '—'}{m.notes ? ` · ${m.notes}` : ''}</T>)}
            </Card>
          ) : null}
        </>
      )}
      {offline ? <Banner tone="est" textStyle={BAN14} icon="cloud-offline-outline" text={t('ms_queued')} /> : null}
      {pending.data?.length ? <T v="cap" color={palette.amberDeep} style={{ paddingHorizontal: 8 }}>{t('ms_pending', { n: pending.data.length })}</T> : null}
    </Screen>
  );
}

/** Поле замера .mf макета: подпись 13, число 22/28 и «мм» 13; min — синяя рамка (узкая точка), est — янтарь и метка. */
function MF({ label, value, onChange, unit, min, max, state, badge, nullable }: {
  label: string; value: number | null; onChange: (v: number | null) => void; unit: string; min: number; max: number;
  state?: 'min' | 'est' | null; badge?: string | null; nullable?: boolean;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const [focus, setFocus] = useState(false);
  const ref = useRef<TextInputInstance>(null);
  useEffect(() => { if (!focus) setText(value == null ? '' : String(value)); }, [value, focus]);
  const commit = () => {
    setFocus(false);
    const v = parseInt(text.replace(/\D/g, ''), 10);
    if (Number.isNaN(v)) { if (nullable) onChange(null); else setText(value == null ? '' : String(value)); return; }
    const c = Math.max(min, Math.min(max, v));
    setText(String(c));
    onChange(c);
  };
  return (
    <Pressable onPress={() => ref.current?.focus()} accessibilityLabel={label} style={[st.mf, state === 'min' && st.mfMin, state === 'est' && st.mfEst, focus && st.mfFocus]}>
      <View style={st.ml}>
        <T style={st.mlT} numberOfLines={1}>{label}</T>
        {badge ? <View style={st.badge}><T num style={{ fontSize: 12, fontWeight: '600', color: '#8A4B00' }}>{badge}</T></View> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 1 }}>
        <TextInput ref={ref} value={text} onChangeText={(s) => setText(s.replace(/[^\d]/g, '').slice(0, 5))} onFocus={() => setFocus(true)} onBlur={commit} onSubmitEditing={commit}
          keyboardType="number-pad" returnKeyType="done" selectTextOnFocus placeholder="—" placeholderTextColor={palette.faint}
          style={resolveFont([st.mv, { fontWeight: '700' }])} accessibilityLabel={label} />
        <T style={st.unit}>{unit}</T>
      </View>
    </Pressable>
  );
}

/** Схема «где мерить» (366×150): ниша, 3 ширины пунктиром с точками, высоты у стен. */
function NicheScheme({ n }: { n: NicheMeasure }) {
  const k = 150 / 176;
  const Y = (v: number) => v * k;
  const v = (x?: number | null) => (x ? String(x) : '—');
  const BL = '#1F4FBF';
  const dashH = (x1: number, x2: number, y: number) => Array.from({ length: Math.floor((x2 - x1) / 7) }, (_, i) => <View key={`${y}-${i}`} style={{ position: 'absolute', left: x1 + i * 7, top: Y(y) - 0.8, width: 4, height: 1.6, backgroundColor: BL }} />);
  const dashV = (x: number) => Array.from({ length: Math.floor((Y(156) - Y(20)) / 7) }, (_, i) => <View key={`v${x}-${i}`} style={{ position: 'absolute', left: x - 0.8, top: Y(20) + i * 7, width: 1.6, height: 4, backgroundColor: BL }} />);
  const dot = (x: number, y: number) => <View key={`d${x}-${y}`} style={{ position: 'absolute', left: x - 3, top: Y(y) - 3, width: 6, height: 6, borderRadius: 3, backgroundColor: BL }} />;
  return (
    <View style={st.sch} accessibilityRole="image">
      <View style={{ position: 'absolute', left: 116, top: Y(18), width: 136, height: Y(158) - Y(18), backgroundColor: palette.wood, borderWidth: 3, borderColor: palette.ink }} />
      {dashH(120, 249, 34)}{dashH(118, 251, 88)}{dashH(116, 253, 142)}{dashV(102)}{dashV(266)}
      {dot(120, 34)}{dot(249, 34)}{dot(118, 88)}{dot(251, 88)}{dot(116, 142)}{dot(253, 142)}
      <T num style={[st.dl, { left: 160, top: 21 }]}>{`1 · ${v(n.width_top)}`}</T>
      <T num style={[st.dl, { left: 160, top: 67 }]}>{`2 · ${v(n.width_middle)}`}</T>
      <T num style={[st.dl, { left: 160, top: 113 }]}>{`3 · ${v(n.width_bottom)}`}</T>
      <T num style={[st.dl, { left: 34, top: 67 }]}>{`4 · ${v(n.height_left)}`}</T>
      <T num style={[st.dl, { left: 274, top: 67 }]}>{`5 · ${v(n.height_right)}`}</T>
    </View>
  );
}

const BAN14 = { fontSize: 14, lineHeight: 19 };
const st = StyleSheet.create({
  h1: { fontSize: 30, lineHeight: 34, fontWeight: '700', letterSpacing: -0.6, paddingHorizontal: 8 },
  hd: { fontSize: 18, lineHeight: 24, fontWeight: '700', paddingHorizontal: 8, marginTop: 4 },
  g2: { flexDirection: 'row', gap: 8 },
  g3: { flexDirection: 'row', gap: 8 },
  sch: { backgroundColor: palette.white, borderRadius: 24, height: 150, overflow: 'hidden' },
  dl: { position: 'absolute', fontSize: 12, lineHeight: 16, fontWeight: '600', color: '#1F4FBF', backgroundColor: palette.white, paddingHorizontal: 4 },
  mf: { flex: 1, minWidth: 0, backgroundColor: palette.white, borderRadius: 18, paddingVertical: 9, paddingHorizontal: 12, borderWidth: 2, borderColor: 'transparent' },
  mfMin: { borderColor: '#1F4FBF' },
  mfEst: { backgroundColor: '#FFF9EE', borderColor: '#F3CF8F' },
  mfFocus: { borderColor: palette.ink },
  ml: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 4, minHeight: 17, marginRight: -8 },
  mlT: { fontSize: 13, lineHeight: 17, color: palette.muted, flexShrink: 0 },
  badge: { height: 20, borderRadius: 9, paddingHorizontal: 6, justifyContent: 'center', backgroundColor: palette.amberSoft },
  mv: { fontSize: 22, lineHeight: 28, color: palette.ink, letterSpacing: -0.4, padding: 0, minWidth: 30 },
  unit: { fontSize: 13, fontWeight: '500', color: palette.muted, marginLeft: 3 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ph: { width: 80, height: 80, borderRadius: 18, backgroundColor: '#E6D3B1' },
  add: { backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
});
