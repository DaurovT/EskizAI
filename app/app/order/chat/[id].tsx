/**
 * Переписка с поставщиком внутри заказа (docs/staff_vendor_contract.md §5.6): сообщения мастера справа (зелёные),
 * конструктора поставщика слева (белые, с именем), платформы — по центру (синие). Текст и фото (камера/галерея),
 * при открытии — «прочитано»; обновление: опрос раз в 10 с на экране, при возврате в приложение и по push.
 * Клавиатура: поле — в футере Screen (useKeyboardOverlap), ровно над клавиатурой, как поля во всём приложении.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type ScrollViewInstance } from 'react-native';
import { api } from '../../../src/api';
import type { OrderMessage } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDayMonth } from '../../../src/lib/format';
import { assigneeName } from '../../../src/lib/orders';
import { toUpload } from '../../../src/services/photos';
import { useOffline } from '../../../src/state/net';
import { orderEvents, useOrderPush } from '../../../src/state/orderEvents';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Loading, Screen, T, resolveFont } from '../../../src/ui/kit';
import { Attachments, PhotoStrip, usePhotoAttach } from '../../../src/ui/OrderParts';
import { palette, type as ty } from '../../../src/ui/theme';

const POLL_MS = 10_000;
const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const dayKey = (iso: string) => new Date(iso).toDateString();

export default function OrderChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const offline = useOffline();
  const order = useResource(() => api.getOrder(id), [id]);
  const msgs = useResource(() => api.listOrderMessages(id), [id]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<OrderMessage[]>([]);
  const [sending, setSending] = useState(false);
  const att = usePhotoAttach(5);
  const scroll = useRef<ScrollViewInstance>(null);
  const userScrolled = useRef(false);
  const reloadRef = useRef(msgs.reload);
  reloadRef.current = msgs.reload;

  // на экране: опрос, обновление при возврате в приложение; push этого чата без баннера (services/push)
  useFocusEffect(useCallback(() => {
    orderEvents.setActiveChat(id);
    const timer = setInterval(() => reloadRef.current(), POLL_MS);
    const app = AppState.addEventListener('change', (s) => { if (s === 'active') reloadRef.current(); });
    return () => { orderEvents.setActiveChat(null); clearInterval(timer); app.remove(); };
  }, [id]));
  useOrderPush(id, () => reloadRef.current());

  // прочитано: есть входящие без отметки мастера
  const unreadKey = (msgs.data ?? []).filter((m) => m.author_type !== 'master' && !m.read_by_master_at).map((m) => m.id).join(',');
  useEffect(() => { if (unreadKey) api.markOrderMessagesRead(id).catch(() => undefined); }, [unreadKey, id]);

  // клавиатура открылась — к последнему сообщению
  useEffect(() => {
    const sub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => {
      userScrolled.current = false;
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 250);
    });
    return () => sub.remove();
  }, []);

  if (msgs.loading && !msgs.data) return <Loading />;
  if (!msgs.data) return <ErrorState error={msgs.error} onRetry={msgs.reload} />;

  const o = order.data;
  const all = [...msgs.data, ...pending];
  const canSend = (!!text.trim() || att.photos.length > 0) && !sending && !offline;

  const send = async () => {
    const body = text.trim();
    if (!canSend) return;
    const photos = att.photos;
    const files = photos.map((p, i) => toUpload(p, i, 'chat'));
    const temp: OrderMessage = {
      id: `pending-${Date.now()}`, order_id: id, author_type: 'master', text: body || null, created_at: new Date().toISOString(),
      attachments: files.map((f, i) => ({ key: `tmp-${i}`, url: f.uri, name: f.name, content_type: f.type })),
    };
    setPending((p) => [...p, temp]);
    setText('');
    att.clear();
    setSending(true);
    userScrolled.current = false;
    try {
      await api.sendOrderMessage(id, { text: body || null, files });
      await msgs.reload();
    } catch (e) {
      showError(e, lang);
      setText(body);
      att.setPhotos(photos);
    } finally {
      setPending((p) => p.filter((x) => x.id !== temp.id));
      setSending(false);
    }
  };

  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 86_400_000).toDateString();
  const dayTitle = (iso: string) => (dayKey(iso) === today ? t('nt_today') : dayKey(iso) === yest ? t('nt_yesterday') : formatDayMonth(iso, lang));
  const who = [o?.supplier_name, o ? assigneeName(o) : null].filter(Boolean).join(' · ');

  const footer = (
    <View style={{ gap: 4 }}>
      {att.photos.length ? <PhotoStrip photos={att.photos} onRemove={att.remove} max={att.max} size={56} /> : null}
      <View style={st.inp}>
        <Pressable onPress={att.open} disabled={offline} hitSlop={6} accessibilityRole="button" accessibilityLabel={t('oa_add_photo')} style={st.clip}>
          <Ionicons name="camera-outline" size={22} color={offline ? palette.faint : palette.ink} />
        </Pressable>
        <TextInput value={text} onChangeText={setText} placeholder={offline ? t('ed_offline') : t('chat_placeholder')} placeholderTextColor={palette.muted}
          multiline maxLength={4000} editable={!offline} accessibilityLabel={t('chat_placeholder')}
          style={resolveFont([ty.body, st.input])} />
        <Pressable onPress={send} disabled={!canSend} accessibilityRole="button" accessibilityLabel={t('ed_send')}
          style={[st.snd, !canSend && { opacity: 0.35 }]}>
          <Ionicons name="arrow-up" size={20} color={palette.white} />
        </Pressable>
      </View>
      {att.sheet}
    </View>
  );

  return (
    <Screen scroll={false} padded={false} footerBar footer={footer} footerStyle={{ paddingTop: 10 }}>
      <Stack.Screen options={{ title: o ? t('chat_title', { n: o.number }) : t('ocd_chat'), headerLargeTitle: false }} />
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={st.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        onContentSizeChange={() => { if (!userScrolled.current) scroll.current?.scrollToEnd({ animated: false }); }}
        onScrollBeginDrag={() => { userScrolled.current = true; }}
        onMomentumScrollEnd={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 40) userScrolled.current = false;
        }}>
        {who ? <T v="cap" center style={{ marginBottom: 4 }}>{who}</T> : null}
        {!all.length ? (
          <View style={st.empty}>
            <View style={st.emptyIc}><Ionicons name="chatbubbles-outline" size={28} color={palette.greenDeep} /></View>
            <T v="h3" center>{t('chat_empty')}</T>
            <T v="sub" center>{t('chat_empty_text')}</T>
          </View>
        ) : null}
        {all.map((m, i) => {
          const prev = all[i - 1];
          const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
          const run = !newDay && prev && prev.author_type === m.author_type;
          const isPending = m.id.startsWith('pending-');
          return (
            <View key={m.id}>
              {newDay ? <View style={st.day}><T style={st.dayT}>{dayTitle(m.created_at)}</T></View> : null}
              {m.author_type === 'platform' ? (
                <View style={st.platform}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="shield-checkmark-outline" size={14} color={palette.blue} />
                    <T style={st.platformBy}>{m.author_name || t('chat_platform')}</T>
                  </View>
                  {m.text ? <T style={st.platformT} center selectable>{m.text}</T> : null}
                  <Attachments items={m.attachments} size={96} />
                  <T style={[st.time, { color: palette.blue, alignSelf: 'center' }]}>{hhmm(m.created_at)}</T>
                </View>
              ) : (
                <View style={[st.bubbleWrap, m.author_type === 'master' ? st.right : st.left, run ? { marginTop: 3 } : { marginTop: 10 }]}>
                  {m.author_type === 'vendor' && !run ? <T v="cap" style={st.by} numberOfLines={1}>{m.author_name || o?.supplier_name || t('chat_vendor')}</T> : null}
                  <View style={[st.bubble, m.author_type === 'master' ? st.me : st.them, isPending && { opacity: 0.6 }]}>
                    {m.attachments.length ? <Attachments items={m.attachments} size={m.text ? 120 : 160} style={{ marginBottom: m.text ? 6 : 0 }} /> : null}
                    {m.text ? <T style={[st.msgT, m.author_type === 'master' && { color: palette.white }]} selectable>{m.text}</T> : null}
                    <View style={st.meta}>
                      <T style={[st.time, m.author_type === 'master' && { color: 'rgba(255,255,255,0.75)' }]} num>{hhmm(m.created_at)}</T>
                      {m.author_type === 'master' ? (
                        <Ionicons name={isPending ? 'time-outline' : m.read_by_vendor_at ? 'checkmark-done' : 'checkmark'} size={14} color="rgba(255,255,255,0.85)"
                          accessibilityLabel={isPending ? t('chat_sending') : m.read_by_vendor_at ? t('chat_read') : t('chat_sent')} />
                      ) : null}
                    </View>
                  </View>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  list: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 32 },
  emptyIc: { width: 64, height: 64, borderRadius: 22, backgroundColor: palette.greenSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  day: { alignSelf: 'center', marginTop: 14, marginBottom: 2, backgroundColor: palette.segOnWhite, borderRadius: 12, paddingHorizontal: 10, height: 24, justifyContent: 'center' },
  dayT: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.muted },
  bubbleWrap: { maxWidth: '82%' },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end' },
  by: { marginLeft: 12, marginBottom: 3, fontSize: 13 },
  bubble: { paddingVertical: 9, paddingHorizontal: 13, borderRadius: 20 },
  me: { backgroundColor: palette.green, borderBottomRightRadius: 6 },
  them: { backgroundColor: palette.white, borderBottomLeftRadius: 6 },
  msgT: { fontSize: 16, lineHeight: 22 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 2 },
  time: { fontSize: 12, lineHeight: 16, color: palette.faint },
  platform: { alignSelf: 'center', maxWidth: '88%', marginTop: 10, backgroundColor: palette.blueSoft, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', gap: 4 },
  platformBy: { fontSize: 13, lineHeight: 17, fontWeight: '700', color: palette.blue },
  platformT: { fontSize: 15, lineHeight: 21, color: '#1A3F99' },
  inp: { minHeight: 52, borderRadius: 26, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingLeft: 6, paddingRight: 6, paddingVertical: 6 },
  clip: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, fontSize: 16, lineHeight: 21, color: palette.ink, maxHeight: 120, paddingTop: Platform.OS === 'ios' ? 10 : 6, paddingBottom: Platform.OS === 'ios' ? 10 : 6 },
  snd: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
});
