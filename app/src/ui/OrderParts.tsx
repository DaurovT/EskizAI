/**
 * Общие блоки экранов заказа (карточка, переписка, рекламации, спор): цитата поставщика, вложения с просмотром фото,
 * выбор варианта (радио), прикрепление фото с камеры/из галереи, статус спора. Язык — как у SCR-16/SCR-34.
 */
import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { Alert, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { OrderAttachment, OrderDispute, OrderReturn } from '../api/types';
import { API_URL } from '../config';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/ru';
import { formatDayTime, formatMoney } from '../lib/format';
import { attachmentUrl } from '../lib/orders';
import { pickPhotos, type Photo } from '../services/photos';
import { Badge, Button, Group, MenuItem, Press, Sheet, T } from './kit';
import { palette, tones, type Tone } from './theme';

export const fileUrl = (a: Pick<OrderAttachment, 'url'>) => attachmentUrl(a.url, API_URL);
export const isImage = (a: Pick<OrderAttachment, 'content_type' | 'name'>) =>
  (a.content_type ?? '').startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(a.name ?? '');

/** Цитата поставщика / платформы: серый блок r16 (как «оценка конструктора» в SCR-34). */
export function Quote({ text, by, style }: { text: string; by?: string | null; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[st.quote, style]}>
      <T style={st.quoteT} selectable>{`«${text}»`}</T>
      {by ? <T v="cap" style={{ marginTop: 4 }}>{by}</T> : null}
    </View>
  );
}

/** Просмотр фото на весь экран (тап / «закрыть»). */
export function ImageViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={st.viewer} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('close')}>
        {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : null}
        <View style={[st.viewerClose, { top: insets.top + 8 }]}><Ionicons name="close" size={24} color={palette.white} /></View>
      </Pressable>
    </Modal>
  );
}

/** Вложения: фото — плитками (тап — на весь экран), остальные файлы — строками (тап — открыть ссылку). */
export function Attachments({ items, size = 72, style }: { items: OrderAttachment[]; size?: number; style?: StyleProp<ViewStyle> }) {
  const { t } = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return null;
  const photos = items.filter(isImage);
  const files = items.filter((a) => !isImage(a));
  const openFile = (a: OrderAttachment) => {
    const u = fileUrl(a);
    if (u) Linking.openURL(u).catch(() => Alert.alert(t('oa_file_unavailable')));
    else Alert.alert(t('oa_file_unavailable'));
  };
  return (
    <View style={[{ gap: 8 }, style]}>
      {photos.length ? (
        <View style={st.thumbs}>
          {photos.map((a) => {
            const u = fileUrl(a);
            return (
              <Press key={a.key} feedback="opacity" onPress={() => (u ? setOpen(u) : undefined)} accessibilityRole="imagebutton" accessibilityLabel={a.name ?? t('oa_photo')}
                style={[st.thumb, { width: size, height: size }]}>
                {u ? <Image source={{ uri: u }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Ionicons name="image-outline" size={24} color={palette.muted} />}
              </Press>
            );
          })}
        </View>
      ) : null}
      {files.map((a) => (
        <Press key={a.key} feedback="opacity" onPress={() => openFile(a)} accessibilityRole="button" style={st.file}>
          <Ionicons name="document-attach-outline" size={20} color={palette.ink} />
          <T style={{ flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '500' }} numberOfLines={1}>{a.name ?? a.key}</T>
          {a.size ? <T v="cap">{`${Math.max(1, Math.round(a.size / 1024))} ${t('oa_kb')}`}</T> : null}
        </Press>
      ))}
      <ImageViewer uri={open} onClose={() => setOpen(null)} />
    </View>
  );
}

/** Выбор одного варианта (радио-строки в белой карточке, как причины отмены SCR-40). */
export function RadioList<K extends string>({ items, value, onChange }: { items: { key: K; label: string; sub?: string }[]; value: K | null; onChange: (k: K) => void }) {
  return (
    <View style={st.card}>
      {items.map((it, i) => {
        const on = value === it.key;
        return (
          <Press key={it.key} feedback="row" onPress={() => onChange(it.key)} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[st.ro, i > 0 && st.sep]}>
            <View style={[st.rd, on ? st.rdOn : st.rdOff]} />
            <View style={{ flex: 1 }}>
              <T v="rt">{it.label}</T>
              {it.sub ? <T v="rs">{it.sub}</T> : null}
            </View>
          </Press>
        );
      })}
    </View>
  );
}

/** Галочка в строке (выбор позиций рекламации). */
export function CheckRow({ title, sub, on, onPress, sep }: { title: string; sub?: string | null; on: boolean; onPress: () => void; sep?: boolean }) {
  return (
    <Press feedback="row" onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={[st.ro, sep && st.sep]}>
      <View style={[st.cb, on && st.cbOn]}>{on ? <Ionicons name="checkmark" size={16} color={palette.white} /> : null}</View>
      <View style={{ flex: 1 }}>
        <T v="rt" numberOfLines={2}>{title}</T>
        {sub ? <T v="rs">{sub}</T> : null}
      </View>
    </Press>
  );
}

/**
 * Фото к сообщению / рекламации / спору: «＋» открывает шторку «Снять фото / Из галереи»; превью с крестиком.
 * Шторка закрывается до системного окна выбора (два модальных окна iOS одновременно не показывает).
 */
export function usePhotoAttach(max = 5) {
  const { t } = useT();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [chooser, setChooser] = useState(false);
  const pick = (source: 'camera' | 'gallery') => {
    setChooser(false);
    setTimeout(async () => {
      try {
        const r = await pickPhotos(source, max - photos.length);
        if (r.denied) return Alert.alert(t(r.denied === 'camera' ? 'new_permission_camera' : 'new_permission_gallery'));
        if (r.photos.length) setPhotos((cur) => [...cur, ...r.photos].slice(0, max));
      } catch {
        Alert.alert(t(source === 'camera' ? 'new_permission_camera' : 'new_permission_gallery'));
      }
    }, 450);
  };
  const open = () => (photos.length >= max ? Alert.alert(t('new_max_photos', { max })) : setChooser(true));
  const sheet = (
    <Sheet variant="gray" visible={chooser} onClose={() => setChooser(false)}>
      <Group>
        <MenuItem icon="camera-outline" title={t('oa_camera')} onPress={() => pick('camera')} />
        <MenuItem icon="images-outline" title={t('oa_gallery')} onPress={() => pick('gallery')} />
      </Group>
      <Button v="secondary" title={t('close')} onPress={() => setChooser(false)} />
    </Sheet>
  );
  return { photos, setPhotos, open, remove: (i: number) => setPhotos((cur) => cur.filter((_, j) => j !== i)), clear: () => setPhotos([]), sheet, max };
}

/** Превью прикреплённых фото: плитки с крестиком и «＋ Фото» (addLabel) в конце. */
export function PhotoStrip({ photos, onAdd, onRemove, max, size = 64, addLabel, style }: {
  photos: Photo[]; onAdd?: () => void; onRemove: (i: number) => void; max: number; size?: number; addLabel?: string; style?: StyleProp<ViewStyle>;
}) {
  const { t } = useT();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[{ flexGrow: 0 }, style]} contentContainerStyle={{ gap: 8, paddingRight: 4, paddingTop: 6 }} keyboardShouldPersistTaps="handled">
      {photos.map((p, i) => (
        <View key={`${p.uri}-${i}`} style={[st.thumb, { width: size, height: size }]}>
          <Image source={{ uri: p.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <Pressable onPress={() => onRemove(i)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('oa_remove_photo')} style={st.rm}>
            <Ionicons name="close" size={14} color={palette.white} />
          </Pressable>
        </View>
      ))}
      {onAdd && photos.length < max ? (
        <Press feedback="opacity" onPress={onAdd} accessibilityRole="button" accessibilityLabel={addLabel ?? t('oa_add_photo')} style={[st.add, { width: addLabel ? undefined : size, height: size }, addLabel ? { paddingHorizontal: 16 } : null]}>
          <Ionicons name="camera-outline" size={22} color={palette.ink} />
          {addLabel ? <T style={{ fontSize: 15, fontWeight: '600' }}>{addLabel}</T> : null}
        </Press>
      ) : null}
    </ScrollView>
  );
}

/** Метка рекламации: на рассмотрении / ждёт подтверждения суммы / переделают / вернут деньги / отказано. */
export function returnBadge(r: Pick<OrderReturn, 'status' | 'decision'>): { key: DictKey; tone: Tone } {
  if (r.status === 'awaiting_owner') return { key: 'or_st_awaiting_owner', tone: 'amber' };
  if (!r.decision) return { key: 'or_st_open', tone: 'amber' };
  return r.decision === 'redo' ? { key: 'or_dec_redo', tone: 'green' } : r.decision === 'refund' ? { key: 'or_dec_refund', tone: 'green' } : { key: 'or_dec_declined', tone: 'red' };
}

/** Спор: на рассмотрении платформы или решение (в пользу мастера / поставщика / частично) с комментарием. */
export function DisputeBlock({ d, style }: { d: OrderDispute; style?: StyleProp<ViewStyle> }) {
  const { t, td, lang } = useT();
  const open = d.status !== 'resolved';
  const tone: Tone = open ? 'amber' : d.decision === 'supplier' ? 'gray' : 'green';
  return (
    <View style={[st.dispute, { backgroundColor: tones[tone].bg }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name={open ? 'hourglass-outline' : 'shield-checkmark-outline'} size={18} color={tones[tone].fg} />
        <T style={{ flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '700' }} color={tones[tone].fg}>
          {open ? t('dsp_open_title') : td(`dsp_dec_${d.decision ?? 'none'}`, t('dsp_resolved'))}
        </T>
      </View>
      <T v="cap" color={tones[tone].fg}>
        {open ? t('dsp_open_text', { date: formatDayTime(d.created_at, lang) })
          : [d.amount ? t('dsp_amount', { sum: formatMoney(d.amount, lang) }) : null, formatDayTime(d.resolved_at, lang)].filter(Boolean).join(' · ')}
      </T>
      {!open && d.decision_comment ? <T style={{ fontSize: 15, lineHeight: 21 }}>{d.decision_comment}</T> : null}
    </View>
  );
}

/** Строка «ключ — значение» внутри карточки. */
export function KV({ k, v, strong }: { k: string; v: ReactNode; strong?: boolean }) {
  return (
    <View style={st.kv}>
      <T v="rs" style={{ fontSize: 16 }}>{k}</T>
      {typeof v === 'string' ? <T v={strong ? 'rv' : 'rt'} num style={{ flexShrink: 1, textAlign: 'right' }}>{v}</T> : v}
    </View>
  );
}

/** Метка статуса строкой (для блоков вне списка). */
export const ToneBadge = ({ label, tone }: { label: string; tone: Tone }) => <Badge tone={tone} label={label} style={{ alignSelf: 'flex-start' }} />;

const st = StyleSheet.create({
  quote: { backgroundColor: palette.ground, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 },
  quoteT: { fontSize: 15, lineHeight: 21 },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  viewerClose: { position: 'absolute', right: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumb: { borderRadius: 14, overflow: 'hidden', backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
  file: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, borderRadius: 14, backgroundColor: palette.ground, paddingHorizontal: 14 },
  card: { backgroundColor: palette.white, borderRadius: 28, overflow: 'hidden' },
  ro: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 58, paddingVertical: 8, paddingHorizontal: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  rd: { width: 22, height: 22, borderRadius: 11 },
  rdOn: { borderWidth: 7, borderColor: palette.ink },
  rdOff: { borderWidth: 2, borderColor: palette.chev },
  cb: { width: 24, height: 24, borderRadius: 8, borderWidth: 2, borderColor: palette.chev, alignItems: 'center', justifyContent: 'center' },
  cbOn: { backgroundColor: palette.ink, borderColor: palette.ink },
  rm: { position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(33,32,31,0.7)', alignItems: 'center', justifyContent: 'center' },
  add: { borderRadius: 14, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: palette.off, borderStyle: 'dashed' },
  dispute: { borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14, gap: 4 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
});
