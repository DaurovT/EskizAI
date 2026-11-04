/**
 * SCR-04 Новый проект (NewProject.dc.html): «Снять фото» / «Из галереи» (до 5 фото), описание с подсказками
 * «+ Размеры / + Бюджет / + Клиент», приём фото из «Поделиться» (Telegram).
 * SCR-04a «Как снять» (PhotoTips.dc.html) — перед съёмкой, пока не включено «Больше не показывать».
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Modal, Pressable, StyleSheet, TextInput, View, type TextInputInstance, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../src/api';
import type { ClientOut } from '../../src/api/types';
import { MAX_PHOTO_BYTES, MAX_PHOTOS } from '../../src/config';
import { useT } from '../../src/i18n';
import { pendingDesign } from '../../src/services/design';
import { updateMeta } from '../../src/state/projectMeta';
import { takeShared } from '../../src/state/shareIntent';
import { useOffline } from '../../src/state/net';
import { showError } from '../../src/ui/dialogs';
import { Badge, BigTitle, Button, Card, Chip, Group, Header, ListItem, Press, Screen, Sheet, T, Toggle, resolveFont } from '../../src/ui/kit';
import { colors, palette, type as ty } from '../../src/ui/theme';

interface Photo { uri: string; width?: number | null; height?: number | null; size?: number | null; mimeType?: string | null; fromShare?: boolean; tint?: string }

const TIPS_OFF = 'mebel.photoTips.off';

/** Сжимаем до 1600 px по длинной стороне: 3G и NFR-06. */
async function prepare(p: Photo): Promise<Photo> {
  try {
    const big = (p.width ?? 0) > 1600 || (p.height ?? 0) > 1600 || (p.size ?? 0) > 2_000_000;
    if (!big) return p;
    const r = await ImageManipulator.manipulateAsync(p.uri, [{ resize: (p.width ?? 0) >= (p.height ?? 0) ? { width: 1600 } : { height: 1600 } }], { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
    return { ...p, uri: r.uri, width: r.width, height: r.height, mimeType: 'image/jpeg' };
  } catch {
    return p;
  }
}

export default function NewProject() {
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const offline = useOffline();
  const params = useLocalSearchParams<{ client?: string; shot?: string }>();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [client, setClient] = useState<ClientOut | null>(null);
  const [clients, setClients] = useState<ClientOut[] | null>(null);
  const [tips, setTips] = useState(false);
  const textRef = useRef<TextInputInstance>(null);

  useEffect(() => {
    const s = takeShared();
    if (s) {
      setShared(true);
      setPhotos(s.images.map((i) => ({ uri: i.uri, width: i.width, height: i.height, size: i.size, mimeType: i.mimeType, fromShare: true })));
      if (s.text) setText(s.text);
    }
    api.limits().then((l) => setLeft(l.unlimited ? null : l.free_left + l.pack_left)).catch(() => undefined);
    if (params.client) api.getClient(params.client).then(setClient).catch(() => undefined);
    // dev: состояние как в макете (?shot=1 — два фото и описание; ?shot=tips — «Как снять»)
    if (__DEV__ && params.shot) {
      setPhotos([{ uri: '', tint: '#CDBFA8' }, { uri: '', tint: '#DCD3C1' }]);
      setText('Шкаф-купе в нишу 1500 на 2400, глубина 600. Три двери, зеркало посередине, антресоль.');
      if (params.shot === 'tips') setTips(true);
    }
  }, [params.client, params.shot]);

  const add = (list: Photo[]) => {
    const warn: string[] = [];
    const ok = list.filter((p) => {
      if ((p.size ?? 0) > MAX_PHOTO_BYTES) { warn.push(t('new_photo_too_big')); return false; }
      if (p.width && p.height && Math.max(p.width, p.height) < 400) warn.push(t('new_photo_small', { w: p.width, h: p.height }));
      return true;
    });
    setPhotos((cur) => {
      const next = [...cur, ...ok];
      if (next.length > MAX_PHOTOS) warn.push(t('new_max_photos', { max: MAX_PHOTOS }));
      return next.slice(0, MAX_PHOTOS);
    });
    if (warn.length) Alert.alert([...new Set(warn)].join('\n'));
  };

  const shoot = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert(t('new_permission_camera'));
    if (photos.length >= MAX_PHOTOS) return Alert.alert(t('new_max_photos', { max: MAX_PHOTOS }));
    const r = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!r.canceled) add(r.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, size: a.fileSize, mimeType: a.mimeType })));
  };
  /** SCR-04a: перед съёмкой — «Как снять», пока мастер не выключил подсказку. */
  const camera = async () => {
    const off = await AsyncStorage.getItem(TIPS_OFF).catch(() => null);
    if (off === '1') return shoot();
    setTips(true);
  };
  const gallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return Alert.alert(t('new_permission_gallery'));
    const rest = MAX_PHOTOS - photos.length;
    if (rest <= 0) return Alert.alert(t('new_max_photos', { max: MAX_PHOTOS }));
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: rest, quality: 0.8 });
    if (!r.canceled) add(r.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, size: a.fileSize, mimeType: a.mimeType })));
  };

  /** «+ Размеры» / «+ Бюджет» — подставляем начало строки в описание и ставим курсор. */
  const hint = (prefix: string) => {
    setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n${prefix}` : prefix));
    setTimeout(() => textRef.current?.focus(), 50);
  };
  const pickClient = () => {
    setClients([]);
    api.listClients().then((p) => setClients(p.items)).catch((e) => { setClients(null); showError(e, lang); });
  };

  const start = async (textOnly = false) => {
    const use = textOnly ? [] : photos;
    if (textOnly && !text.trim()) { textRef.current?.focus(); return; }
    if (!use.length && !text.trim()) return Alert.alert(t('new_need_input'));
    setBusy(true);
    try {
      // без даты в названии: описание, иначе «Эскиз · клиент»; тип и габарит («Пенал 820×450×1800») ставит сервер после распознавания
      const clientName = client?.name ?? null;
      const title = text.trim() ? text.trim().split(/[.,\n]/)[0].slice(0, 60) : [t('new_title_sketch'), clientName].filter(Boolean).join(' · ');
      const p = await api.createProject({ title, client_id: client?.id ?? params.client ?? null, source_text: text.trim() || null });
      const prepared = await Promise.all(use.filter((x) => x.uri).map(prepare));
      const ids: string[] = [];
      for (const [i, ph] of prepared.entries()) {
        const up = await api.uploadPhoto(p.id, { uri: ph.uri, name: `photo_${i + 1}.jpg`, type: ph.mimeType ?? 'image/jpeg' });
        ids.push(up.id);
      }
      updateMeta(p.id, { photos: prepared.map((x) => x.uri), answers: {}, design: null });
      pendingDesign.set((s) => ({ ...s, [p.id]: { text: text.trim() || null, photo_ids: ids } }));
      router.replace(`/project/${p.id}/breakdown`);
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(false);
    }
  };

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const empty = !photos.length && !text.trim();

  return (
    <Screen
      edges={[]}
      header={<Header back backIcon="close" onBack={close} topInset={insets.top + 2} />}
      contentStyle={{ paddingTop: 4 }}
      footerStyle={{ gap: 2, paddingTop: 6, paddingBottom: insets.bottom ? Math.max(30, insets.bottom - 4) : 16 }}
      footer={
        <>
          <Button title={busy ? t('new_uploading') : t('new_start')} value={left != null && !busy ? t('new_left', { n: left }) : undefined}
            onPress={() => start()} loading={busy} disabled={offline || empty} />
          <Button v="ghost" title={t('new_text_only')} onPress={() => start(true)} disabled={busy || offline} />
        </>
      }
    >
      <Stack.Screen options={{ headerShown: false }} />
      <BigTitle sub={t('new_sub')} style={{ paddingBottom: 4, paddingTop: 0 }}>{t('new_title')}</BigTitle>
      {shared ? <Badge label={t('new_from_telegram')} fg={colors.tg} bg="#e3f4fc" style={{ alignSelf: 'flex-start', marginLeft: 8 }} /> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Service icon="camera-outline" label={t('new_shoot')} onPress={camera} primary />
        <Service icon="image-outline" label={t('new_from_gallery')} onPress={gallery} />
      </View>
      {photos.length ? (
        <Card style={{ gap: 12 }}>
          <View style={s.cardHead}>
            <T v="h3">{t('new_photos')}</T>
            <T v="rs" num>{t('new_photos_of', { n: photos.length, max: MAX_PHOTOS })}</T>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {photos.map((p, i) => (
              <View key={p.uri + i} style={[s.ph, { backgroundColor: p.tint ?? palette.wood }]} accessibilityRole="image" accessibilityLabel={`${t('new_photos')} ${i + 1}`}>
                {p.uri ? <Image source={{ uri: p.uri }} style={StyleSheet.absoluteFill} /> : null}
                <Pressable accessibilityLabel={t('delete')} onPress={() => setPhotos((c) => c.filter((_, j) => j !== i))} hitSlop={8} style={s.phX}>
                  <Ionicons name="close" size={14} color={palette.white} />
                </Pressable>
              </View>
            ))}
            {photos.length < MAX_PHOTOS ? (
              <Press accessibilityRole="button" accessibilityLabel={t('new_add_photo')} onPress={gallery} style={[s.ph, s.phAdd]}>
                <Ionicons name="add" size={26} color={palette.muted} />
              </Press>
            ) : null}
          </View>
        </Card>
      ) : null}
      <Card style={{ gap: 10 }}>
        <T v="h3">{t('new_desc')}</T>
        <TextInput ref={textRef} value={text} onChangeText={setText} placeholder={t('new_desc_ph')} placeholderTextColor={palette.faint}
          multiline scrollEnabled={false} accessibilityLabel={t('new_desc')}
          style={resolveFont([ty.body, { color: palette.ink, minHeight: 66, padding: 0, textAlignVertical: 'top' }])} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Chip icon="add" label={t('new_add_dims')} onPress={() => hint(t('new_dims_prefix'))} />
          <Chip icon="add" label={t('new_add_budget')} onPress={() => hint(t('new_budget_prefix'))} />
          <Chip icon={client ? 'person' : 'add'} label={client ? client.name : t('new_add_client')} selected={!!client} onPress={pickClient} />
        </View>
      </Card>
      <T v="cap" style={{ paddingHorizontal: 8 }}>{t('new_share_tg')}</T>

      <Sheet visible={clients != null} onClose={() => setClients(null)} title={t('new_pick_client')} variant="gray">
        <Group>
          <ListItem compact icon="close-outline" title={t('new_no_client')} chevron={false} onPress={() => { setClient(null); setClients(null); }} />
          {(clients ?? []).map((c) => (
            <ListItem key={c.id} compact icon="person-outline" title={c.name} subtitle={c.phone || null} chevron={false}
              right={client?.id === c.id ? <Ionicons name="checkmark" size={22} color={palette.green} /> : undefined}
              onPress={() => { setClient(c); setClients(null); }} />
          ))}
        </Group>
      </Sheet>
      <PhotoTips visible={tips} onClose={() => setTips(false)} onShoot={() => { setTips(false); setTimeout(shoot, 350); }} />
    </Screen>
  );
}

/** .svc — плитка действия 118 r24: иконка 40 r14 сверху, подпись 16/600 снизу; основная — зелёная. */
function Service({ icon, label, onPress, primary }: { icon: 'camera-outline' | 'image-outline'; label: string; onPress: () => void; primary?: boolean }) {
  const fg = primary ? palette.white : palette.ink;
  return (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[s.svc, primary && { backgroundColor: palette.green }]}>
      <View style={[s.svcIco, primary && { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
        <Ionicons name={icon} size={22} color={fg} />
      </View>
      <T style={{ fontSize: 16, lineHeight: 20, fontWeight: '600', color: fg }}>{label}</T>
    </Press>
  );
}

// ---------- SCR-04a «Как снять» ----------

/** Шкаф-схема .cab: тёмная рамка, две створки «дерево». */
function Cab({ w, h, style }: { w: number; h: number; style?: ViewStyle }) {
  return (
    <View style={[{ width: w, height: h, backgroundColor: palette.ink, padding: 4, flexDirection: 'row', gap: 2 }, style]}>
      <View style={{ flex: 1, backgroundColor: '#E6D3B1' }} />
      <View style={{ flex: 1, backgroundColor: '#E6D3B1' }} />
    </View>
  );
}

function Tip({ title, sub, bg, children }: { title: string; sub: string; bg?: string; children: React.ReactNode }) {
  return (
    <View style={s.tp}>
      <View style={[s.il, bg ? { backgroundColor: bg } : null]}>{children}</View>
      <T style={{ fontSize: 15, lineHeight: 19, fontWeight: '600' }}>{title}</T>
      <T style={{ fontSize: 13, lineHeight: 17, color: palette.muted }}>{sub}</T>
    </View>
  );
}

function PhotoTips({ visible, onClose, onShoot }: { visible: boolean; onClose: () => void; onShoot: () => void }) {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (visible) AsyncStorage.getItem(TIPS_OFF).then((v) => setOff(v === '1')).catch(() => undefined);
  }, [visible]);
  const toggle = (v: boolean) => {
    setOff(v);
    AsyncStorage.setItem(TIPS_OFF, v ? '1' : '0').catch(() => undefined);
  };
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <Screen edges={[]} scroll header={<TipsHeader onClose={onClose} />} contentStyle={{ paddingTop: 0 }}
        footerStyle={{ paddingBottom: insets.bottom ? Math.max(30, insets.bottom - 4) : 16 }}
        footer={<Button icon="camera-outline" title={t('tips_go')} onPress={onShoot} />}>
        <T style={{ fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.7, paddingHorizontal: 8 }}>{t('tips_title')}</T>
        <View style={s.grid}>
          <View style={s.gridRow}>
          <Tip title={t('tips_1')} sub={t('tips_1s')}>
            <View style={s.frame} />
            <Cab w={40} h={52} />
          </Tip>
          <Tip title={t('tips_2')} sub={t('tips_2s')}>
            <Cab w={46} h={52} />
            <Ionicons name="camera-outline" size={18} color={palette.green} style={{ position: 'absolute', bottom: 8, right: 12 }} />
          </Tip>
          </View>
          <View style={s.gridRow}>
          <Tip title={t('tips_3')} sub={t('tips_3s')} bg="#FFF6E4">
            <MaterialCommunityIcons name="star-four-points-outline" size={22} color={palette.amber} style={{ position: 'absolute', left: 12, top: 8 }} />
            <Cab w={40} h={52} />
          </Tip>
          <Tip title={t('tips_4')} sub={t('tips_4s')}>
            <Cab w={30} h={44} style={{ transform: [{ skewY: '-10deg' }], marginRight: 6 }} />
            <Cab w={38} h={48} />
            <Cab w={30} h={44} style={{ transform: [{ skewY: '10deg' }], marginLeft: 6 }} />
          </Tip>
          </View>
        </View>
        <View style={s.gridRow}>
          <View style={s.cm}>
            <View style={[s.cmPh, { backgroundColor: palette.wood }]}><Cab w={52} h={70} /></View>
            <View style={s.lb}>
              <View style={[s.lbIco, { backgroundColor: palette.greenSoft }]}><Ionicons name="checkmark" size={15} color={palette.greenDeep} /></View>
              <T style={{ fontSize: 14, fontWeight: '600', color: palette.greenDeep }}>{t('tips_good')}</T>
            </View>
          </View>
          <View style={s.cm}>
            <View style={[s.cmPh, { backgroundColor: '#D9D2C6' }]}>
              <Cab w={80} h={104} style={{ transform: [{ rotate: '-14deg' }, { translateX: 18 }, { translateY: 26 }], opacity: 0.75 }} />
            </View>
            <View style={s.lb}>
              <View style={[s.lbIco, { backgroundColor: palette.redSoft }]}><Ionicons name="close" size={15} color={palette.redDeep} /></View>
              <T style={{ fontSize: 14, fontWeight: '600', color: palette.redDeep }}>{t('tips_bad')}</T>
            </View>
          </View>
        </View>
        <Group>
          <ListItem title={t('tips_dont_show')} onPress={() => toggle(!off)} chevron={false} style={{ minHeight: 54 }}
            right={<Toggle value={off} onValueChange={toggle} accessibilityLabel={t('tips_dont_show')} />} />
        </Group>
      </Screen>
    </Modal>
  );
}

function TipsHeader({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return <Header back backIcon="close" onBack={onClose} topInset={insets.top} />;
}

const s = StyleSheet.create({
  svc: { flex: 1, height: 118, borderRadius: 24, backgroundColor: palette.white, padding: 14, justifyContent: 'space-between' },
  svcIco: { width: 40, height: 40, borderRadius: 14, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  ph: { width: 72, height: 72, borderRadius: 16, overflow: 'hidden' },
  phX: { position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(33,32,31,0.7)', alignItems: 'center', justifyContent: 'center' },
  phAdd: { backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  grid: { gap: 8 },
  gridRow: { flexDirection: 'row', gap: 8 },
  tp: { flex: 1, backgroundColor: palette.white, borderRadius: 22, padding: 12, gap: 8 },
  il: { height: 78, borderRadius: 14, backgroundColor: palette.wood, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  frame: { position: 'absolute', top: 10, bottom: 10, left: 18, right: 18, borderWidth: 2, borderStyle: 'dashed', borderColor: palette.green, borderRadius: 8 },
  cm: { flex: 1, backgroundColor: palette.white, borderRadius: 22, padding: 10, gap: 8 },
  cmPh: { height: 96, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  lb: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lbIco: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
