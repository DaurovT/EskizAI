/**
 * SCR-59 «Заказ у поставщика: чат, правки, возврат, спор» (OrderChat.dc.html). Шапка «Заказ № … · поставщик» и строкой ниже
 * изделие и статус; вкладки-капсулы «Чат · Правки · Возврат · Спор» (на «Правках» — красная цифра ждущих ответа).
 *
 * Чат — одна лента по времени (src/lib/orderFeed.ts): сообщения конструктора (слева, белые, имя синим), мастера (справа,
 * тёмные), платформы (по центру), смены статуса строкой («Заказ оплачен · 15 нояб»), правки конструктора карточкой
 * с «Отклонить / Принять», рекламации и споры — карточками (тап — их вкладка). Вложения — фото и файлы.
 * Правки — список с метками «ждёт ответа / принято / отклонено». Возврат — какие детали, причина, фото, заявка
 * (POST /orders/{id}/returns) и прежние рекламации. Спор — статус, шаги (отказ → спор → решение менеджера),
 * «Написать менеджеру». Обновление: опрос раз в 10 с на экране, при возврате в приложение и по push.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, Linking, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';
import { RETURN_TYPES, type OrderCorrection, type OrderDispute, type OrderMessage, type OrderOut, type OrderReturn, type OrderReturnType } from '../api/types';
import { SUPPORT_TG } from '../config';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { formatDayMonth, formatMoney } from '../lib/format';
import { disputeSteps, orderFeed, pendingFixes, type FeedItem } from '../lib/orderFeed';
import { assigneeName, canDisputeReturn, canReport, diffLines, orderAccess, statusTone } from '../lib/orders';
import { toUpload } from '../services/photos';
import { useOffline } from '../state/net';
import { orderEvents, useOrderPush } from '../state/orderEvents';
import { useSession } from '../state/session';
import { showError } from '../ui/dialogs';
import { ErrorState } from '../ui/ErrorState';
import { Badge, Banner, Button, Card, EmptyState, Field, IconButton, Loading, Press, Screen, SurfaceProvider, T, dialog, resolveFont, toast } from '../ui/kit';
import { Attachments, CheckRow, PhotoStrip, Quote, returnBadge, usePhotoAttach } from '../ui/OrderParts';
import { HeaderColumn } from '../ui/layout';
import { palette, tones, type as ty } from '../ui/theme';

const POLL_MS = 10_000;
const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const dayKey = (iso: string) => new Date(iso).toDateString();
type Tab = 'chat' | 'fix' | 'return' | 'dispute';
const TABS: Tab[] = ['chat', 'fix', 'return', 'dispute'];

export function OrderChatScreen() {
  const { id, tab: tabParam } = useLocalSearchParams<{ id: string; tab?: string }>();
  const { t } = useT();
  const offline = useOffline();
  const { canOrder, seesCost } = useSession();
  const can = orderAccess({ canOrder, seesCost });
  const order = useResource(() => api.getOrder(id), [id]);
  const msgs = useResource(() => api.listOrderMessages(id), [id]);
  const fixes = useResource(() => api.listOrderCorrections(id).catch(() => [] as OrderCorrection[]), [id]);
  const rets = useResource(() => api.listOrderReturns(id).catch(() => [] as OrderReturn[]), [id]);
  const disps = useResource(() => api.listOrderDisputes(id).catch(() => [] as OrderDispute[]), [id]);
  const [tab, setTab] = useState<Tab>(TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'chat');
  const reloadAll = useRef(() => undefined as void);
  reloadAll.current = () => { msgs.reload(); fixes.reload(); rets.reload(); disps.reload(); order.reload(); };

  // на экране: опрос, обновление при возврате в приложение; push этого чата без баннера (services/push)
  useFocusEffect(useCallback(() => {
    orderEvents.setActiveChat(id);
    const timer = setInterval(() => reloadAll.current(), POLL_MS);
    const app = AppState.addEventListener('change', (s) => { if (s === 'active') reloadAll.current(); });
    return () => { orderEvents.setActiveChat(null); clearInterval(timer); app.remove(); };
  }, [id]));
  useOrderPush(id, () => reloadAll.current());

  // прочитано: есть входящие без отметки мастера
  const unreadKey = (msgs.data ?? []).filter((m) => m.author_type !== 'master' && !m.read_by_master_at).map((m) => m.id).join(',');
  useEffect(() => { if (unreadKey) api.markOrderMessagesRead(id).catch(() => undefined); }, [unreadKey, id]);

  if (msgs.loading && !msgs.data) return <Loading />;
  if (!msgs.data) return <ErrorState error={msgs.error} onRetry={msgs.reload} />;

  const o = order.data;
  const pending = pendingFixes(fixes.data ?? []);
  const manager = () => Linking.openURL(`https://t.me/${SUPPORT_TG}?text=${encodeURIComponent(o ? `Заказ №${o.number}` : '')}`).catch(() => undefined);
  const header = (
    <Stack.Screen options={{ headerShown: true, header: () => <ChatHeader o={o} onCall={manager} /> }} />
  );
  const tabs = (
    <View style={st.otabs} accessibilityRole="tablist">
      {TABS.map((k) => {
        const on = k === tab;
        const n = k === 'fix' ? pending : 0;
        return (
          <Press key={k} feedback="opacity" onPress={() => setTab(k)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            accessibilityLabel={n ? `${t(`och_tab_${k}`)}, ${n}` : t(`och_tab_${k}`)} style={[st.ot, on && st.otOn]}>
            <T style={[st.otT, on && { color: palette.white }]}>{t(`och_tab_${k}`)}</T>
            {n ? <View style={st.otN}><T style={st.otNT} num>{n}</T></View> : null}
          </Press>
        );
      })}
    </View>
  );

  const body = { order: o, fixes: fixes.data ?? [], returns: rets.data ?? [], disputes: disps.data ?? [], can, offline };
  if (tab === 'chat') {
    return (
      <ChatTab {...body} messages={msgs.data} header={header} tabs={tabs} onTab={setTab}
        onSent={() => msgs.reload()} onDecided={(fresh) => { order.setData(fresh); fixes.reload(); msgs.reload(); }} />
    );
  }
  return (
    <Screen gap={10} contentStyle={{ paddingTop: 2 }} footerStyle={{ gap: 8 }} footer={tab === 'dispute' && body.disputes.length ? (
      <Button v="secondary" icon="chatbubble-ellipses-outline" title={t('och_write_manager')} onPress={manager} />
    ) : undefined}>
      {header}
      {tabs}
      {tab === 'fix' ? <FixesTab {...body} onDecided={(fresh) => { order.setData(fresh); fixes.reload(); msgs.reload(); }} /> : null}
      {tab === 'return' ? <ReturnTab {...body} onSent={() => { rets.reload(); msgs.reload(); }} /> : null}
      {tab === 'dispute' ? <DisputeTab {...body} /> : null}
    </Screen>
  );
}

type TabProps = {
  order: OrderOut | null; fixes: OrderCorrection[]; returns: OrderReturn[]; disputes: OrderDispute[];
  can: ReturnType<typeof orderAccess>; offline: boolean;
};

// ---------- шапка ----------

/** .hdr: «назад», «Заказ № 1042 · EMAN» и ниже «изделие · статус» (статус цветом), справа — позвонить менеджеру. */
function ChatHeader({ o, onCall }: { o: OrderOut | null; onCall: () => void }) {
  const insets = useSafeAreaInsets();
  const { t, td } = useT();
  const title = o ? [t('chat_title', { n: o.number }), o.supplier_name].filter(Boolean).join(' · ') : t('ocd_chat');
  const status = o ? td(`os_${o.status}`, o.status_label ?? o.status).toLowerCase() : null;
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: palette.ground }}>
      <HeaderColumn bg={palette.ground}>
        <View style={st.hdr}>
          <IconButton icon="chevron-back" label={t('back')} onPress={() => (router.canGoBack() ? router.back() : router.replace(o ? `/order/${o.id}` : '/orders'))} />
          <View style={{ flex: 1, minWidth: 0 }} accessibilityRole="header">
            <T v="ht" numberOfLines={1}>{title}</T>
            {o ? (
              <T style={st.hsub} numberOfLines={1}>
                {o.project_title ? `${o.project_title} · ` : ''}
                <T style={[st.hsub, { color: tones[statusTone(o.status)].fg, fontWeight: '600' }]}>{status}</T>
              </T>
            ) : null}
          </View>
          <IconButton icon="call-outline" label={t('och_call_manager')} onPress={onCall} />
        </View>
      </HeaderColumn>
    </View>
  );
}

// ---------- Чат ----------

function ChatTab({ order: o, messages, fixes, returns, disputes, can, offline, header, tabs, onTab, onSent, onDecided }: TabProps & {
  messages: OrderMessage[]; header: React.ReactNode; tabs: React.ReactNode; onTab: (t: Tab) => void;
  onSent: () => Promise<void> | void; onDecided: (o: OrderOut) => void;
}) {
  const { t, lang } = useT();
  const [text, setText] = useState('');
  const [pendingMsgs, setPending] = useState<OrderMessage[]>([]);
  const [sending, setSending] = useState(false);
  const att = usePhotoAttach(5);
  const scroll = useRef<ScrollViewInstance>(null);
  const userScrolled = useRef(false);

  // клавиатура открылась — к последнему сообщению
  useEffect(() => {
    const sub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => {
      userScrolled.current = false;
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 250);
    });
    return () => sub.remove();
  }, []);

  const feed = orderFeed({ messages: [...messages, ...pendingMsgs], corrections: fixes, returns, disputes, events: o?.events });
  const canSend = (!!text.trim() || att.photos.length > 0) && !sending && !offline;
  const send = async () => {
    const body = text.trim();
    if (!canSend || !o) return;
    const photos = att.photos;
    const files = photos.map((p, i) => toUpload(p, i, 'chat'));
    const temp: OrderMessage = {
      id: `pending-${Date.now()}`, order_id: o.id, author_type: 'master', text: body || null, created_at: new Date().toISOString(),
      attachments: files.map((f, i) => ({ key: `tmp-${i}`, url: f.uri, name: f.name, content_type: f.type })),
    };
    setPending((p) => [...p, temp]);
    setText('');
    att.clear();
    setSending(true);
    userScrolled.current = false;
    try {
      await api.sendOrderMessage(o.id, { text: body || null, files });
      await onSent();
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
        <Pressable onPress={att.open} disabled={offline || !can.chat} hitSlop={6} accessibilityRole="button" accessibilityLabel={t('oa_add_photo')} style={st.clip}>
          <Ionicons name="camera-outline" size={22} color={offline ? palette.faint : palette.ink} />
        </Pressable>
        <TextInput value={text} onChangeText={setText} placeholder={offline ? t('ed_offline') : t('och_placeholder')} placeholderTextColor={palette.faint}
          multiline maxLength={4000} editable={!offline && can.chat} accessibilityLabel={t('och_placeholder')}
          style={resolveFont([ty.body, st.input])} />
        <Pressable onPress={send} disabled={!canSend} accessibilityRole="button" accessibilityLabel={t('ed_send')}
          style={[st.go, !canSend && { opacity: 0.35 }]}>
          <Ionicons name="arrow-up" size={20} color={palette.white} />
        </Pressable>
      </View>
      {att.sheet}
    </View>
  );

  return (
    <Screen scroll={false} padded={false} footer={footer} footerStyle={{ paddingTop: 6 }}>
      {header}
      <View style={{ paddingHorizontal: 12, paddingTop: 2 }}>{tabs}</View>
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={st.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        onContentSizeChange={() => { if (!userScrolled.current) scroll.current?.scrollToEnd({ animated: false }); }}
        onScrollBeginDrag={() => { userScrolled.current = true; }}
        onMomentumScrollEnd={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 40) userScrolled.current = false;
        }}>
        {who ? <T v="cap" center style={{ marginBottom: 4 }}>{who}</T> : null}
        {!feed.length ? (
          <View style={st.empty}>
            <View style={st.emptyIc}><Ionicons name="chatbubbles-outline" size={28} color={palette.greenDeep} /></View>
            <T v="h3" center>{t('chat_empty')}</T>
            <T v="sub" center>{t('chat_empty_text')}</T>
          </View>
        ) : null}
        {feed.map((it, i) => {
          const prev = feed[i - 1];
          const newDay = !prev || dayKey(prev.at) !== dayKey(it.at);
          return (
            <View key={it.id}>
              {newDay && it.kind !== 'sys' ? <View style={st.day}><T style={st.dayT}>{dayTitle(it.at)}</T></View> : null}
              <FeedRow it={it} prev={newDay ? null : prev} order={o} can={can} offline={offline} onTab={onTab} onDecided={onDecided} />
            </View>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

function FeedRow({ it, prev, order: o, can, offline, onTab, onDecided }: {
  it: FeedItem; prev: FeedItem | null; order: OrderOut | null; can: TabProps['can']; offline: boolean;
  onTab: (t: Tab) => void; onDecided: (o: OrderOut) => void;
}) {
  const { t, td, lang } = useT();
  if (it.kind === 'sys') {
    return <View style={st.sys}><T style={st.sysT}>{`${t(`och_sys_${it.status}`)} · ${formatDayMonth(it.at, lang)}`}</T></View>;
  }
  if (it.kind === 'fix') return <View style={{ marginTop: 10 }}><FixCard c={it.c} order={o} can={can} offline={offline} onDecided={onDecided} /></View>;
  if (it.kind === 'return') {
    const r = it.r;
    const b = returnBadge(r);
    return (
      <Press feedback="scale" onPress={() => onTab('return')} accessibilityRole="button" style={[st.entry, { marginTop: 10 }]}>
        <View style={[st.tile, { backgroundColor: palette.amberSoft }]}><Ionicons name="arrow-undo-outline" size={17} color={palette.amberDeep} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="rt" style={{ fontWeight: '600' }} numberOfLines={1}>{`${t('och_return_n', { n: r.number ?? '' }).trim()} · ${td(`or_type_${r.type}`, r.type)}`}</T>
          {r.description ? <T v="rs" numberOfLines={2}>{r.description}</T> : null}
        </View>
        <Badge tone={b.tone} label={t(b.key)} />
      </Press>
    );
  }
  if (it.kind === 'dispute') {
    const d = it.d;
    const open = d.status !== 'resolved';
    return (
      <Press feedback="scale" onPress={() => onTab('dispute')} accessibilityRole="button" style={[st.entry, { marginTop: 10 }]}>
        <View style={[st.tile, { backgroundColor: open ? palette.amberSoft : palette.greenSoft }]}>
          <Ionicons name="shield-outline" size={17} color={open ? palette.amberDeep : palette.greenDeep} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="rt" style={{ fontWeight: '600' }} numberOfLines={1}>{open ? t('och_dispute_open') : td(`dsp_dec_${d.decision ?? 'none'}`, t('dsp_resolved'))}</T>
          <T v="rs" numberOfLines={2}>{d.comment || td(`dsp_r_${d.reason}`, String(d.reason))}</T>
        </View>
        <Ionicons name="chevron-forward" size={18} color={palette.chev} />
      </Press>
    );
  }
  const m = it.m;
  if (m.author_type === 'platform') {
    return (
      <View style={st.platform}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name="shield-checkmark-outline" size={14} color={palette.blue} />
          <T style={st.platformBy}>{m.author_name || t('chat_platform')}</T>
        </View>
        {m.text ? <T style={st.platformT} center selectable>{m.text}</T> : null}
        <Attachments items={m.attachments} size={96} />
        <T style={[st.time, { color: palette.blue, alignSelf: 'center' }]}>{hhmm(m.created_at)}</T>
      </View>
    );
  }
  const me = m.author_type === 'master';
  const run = prev?.kind === 'msg' && prev.m.author_type === m.author_type;
  const isPending = m.id.startsWith('pending-');
  const by = m.author_name || o?.supplier_name || t('chat_vendor');
  return (
    <View style={[st.bubbleWrap, me ? st.right : st.left, run ? { marginTop: 3 } : { marginTop: 10 }]}>
      <View style={[st.bubble, me ? st.me : st.them, isPending && { opacity: 0.6 }]}>
        {!me && !run ? <T style={st.who} numberOfLines={1}>{by}</T> : null}
        {m.attachments.length ? <Attachments items={m.attachments} size={m.text ? 120 : 160} style={{ marginBottom: m.text ? 6 : 0 }} /> : null}
        {m.text ? <T style={[st.msgT, me && { color: palette.white }]} selectable>{m.text}</T> : null}
        <View style={st.meta}>
          <T style={[st.time, me && { color: 'rgba(255,255,255,0.6)' }]} num>{hhmm(m.created_at)}</T>
          {me ? (
            <Ionicons name={isPending ? 'time-outline' : m.read_by_vendor_at ? 'checkmark-done' : 'checkmark'} size={14} color="rgba(255,255,255,0.7)"
              accessibilityLabel={isPending ? t('chat_sending') : m.read_by_vendor_at ? t('chat_read') : t('chat_sent')} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * .fix — правка от конструктора: что поменялось по строкам, цена заказа, комментарий и файлы; пока ждёт —
 * «Отклонить» / «Принять» (принять новую сумму может только тот, кто видит цены), после — плашка решения.
 */
function FixCard({ c, order: o, can, offline, onDecided }: { c: OrderCorrection; order: OrderOut | null; can: TabProps['can']; offline: boolean; onDecided: (o: OrderOut) => void }) {
  const { t, lang } = useT();
  const [busy, setBusy] = useState<'ok' | 'no' | null>(null);
  const changes = diffLines(c.lines_before, c.lines_after).filter((d) => d.kind !== 'same');
  const qty = (n: number | null | undefined, u: string | null) => (n == null ? '—' : `${String(n).replace('.', ',')} ${u ?? ''}`.trim());
  const delta = c.delta ?? (c.total_after != null && c.total_before != null ? c.total_after - c.total_before : null);
  const priceText = delta == null ? null : delta === 0 ? t('och_fix_same_price') : `${delta > 0 ? '+' : '−'}${formatMoney(Math.abs(delta), lang)}`;
  const open = c.status === 'pending' && o?.status === 'awaiting_approval';
  const decide = async (ok: boolean) => {
    if (!o) return;
    if (!ok && !(await dialog.confirm({ title: t('ocd_cor_decline_t'), text: t('ocd_cor_decline_text'), confirmLabel: t('ocd_cor_decline'), cancelLabel: t('cancel'), destructive: true }))) return;
    setBusy(ok ? 'ok' : 'no');
    try {
      onDecided(ok ? await api.approveOrderCorrection(o.id, c.id) : await api.declineOrderCorrection(o.id, c.id, null));
      toast.show({ text: ok ? t('ocd_cor_approved') : t('ocd_cor_declined'), tone: ok ? 'success' : undefined });
    } catch (e) { showError(e, lang); } finally { setBusy(null); }
  };
  return (
    <SurfaceProvider value="white">
    <View style={st.fix}>
      <View style={st.fixH}>
        <View style={[st.tile, { width: 30, height: 30, borderRadius: 9, backgroundColor: palette.blueSoft }]}><Ionicons name="create-outline" size={16} color={palette.blue} /></View>
        <T style={st.fixHT} numberOfLines={1}>{t('och_fix_title')}</T>
        <T v="cap" style={{ fontSize: 13 }}>{hhmm(c.created_at)}</T>
      </View>
      {changes.slice(0, 4).map((d) => (
        <View key={d.key} style={st.dif}>
          <T style={st.difK} numberOfLines={1}>{d.name}</T>
          <T style={st.difV} num numberOfLines={1}>
            {d.kind === 'added' ? `${t('ocd_cor_added')} · ${qty(d.after?.qty, d.unit)}` : d.kind === 'removed' ? t('ocd_cor_removed')
              : (d.before?.qty ?? null) !== (d.after?.qty ?? null) ? `${qty(d.before?.qty, d.unit)} → ${qty(d.after?.qty, d.unit)}` : t('och_fix_price_changed')}
          </T>
        </View>
      ))}
      {changes.length > 4 ? <T v="cap">{t('och_fix_more', { n: changes.length - 4 })}</T> : null}
      {can.amounts && priceText ? (
        <View style={st.dif}><T style={st.difK}>{t('och_fix_price')}</T><T style={st.difV} num>{priceText}</T></View>
      ) : null}
      {c.comment ? <Quote text={c.comment} by={c.author_name ?? null} /> : null}
      {c.files.length ? <Attachments items={c.files} size={64} /> : null}
      {open && can.corrections ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button v="secondary" small title={t('ocd_cor_decline')} onPress={() => decide(false)} loading={busy === 'no'} disabled={!!busy || offline} style={{ flex: 1 }} />
            {can.approveCorrection ? (
              <Button small title={t('och_fix_accept')} onPress={() => decide(true)} loading={busy === 'ok'} disabled={!!busy || offline} haptic="success" style={{ flex: 1 }} />
            ) : null}
          </View>
          {!can.approveCorrection ? <T v="cap">{t('ocd_cor_cost_only')}</T> : null}
        </>
      ) : c.status !== 'pending' ? (
        <Banner tone={c.status === 'approved' ? 'ok' : 'n'} icon={c.status === 'approved' ? 'checkmark-circle' : 'close-circle-outline'}
          text={c.status === 'approved' ? t('och_fix_accepted', { date: formatDayMonth(c.decided_at ?? c.created_at, lang) }) : t('och_fix_declined', { date: formatDayMonth(c.decided_at ?? c.created_at, lang) })}
          style={{ paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center' }} />
      ) : null}
    </View>
    </SurfaceProvider>
  );
}

// ---------- Правки ----------

function FixesTab({ order, fixes, can, offline, onDecided }: TabProps & { onDecided: (o: OrderOut) => void }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState<string | null>(fixes.find((c) => c.status === 'pending')?.id ?? null);
  if (!can.corrections) return <Banner tone="info" icon="lock-closed-outline" text={t('ocd_no_order_right')} />;
  if (!fixes.length) return <EmptyState compact icon="create-outline" title={t('och_fix_empty')} text={t('och_fix_empty_text')} />;
  const badge = (c: OrderCorrection) => (c.status === 'pending' ? { tone: 'amber' as const, label: t('och_fix_wait') }
    : c.status === 'approved' ? { tone: 'green' as const, label: t('och_fix_ok') } : { tone: 'gray' as const, label: t('och_fix_no') });
  return (
    <>
      <Card padded={false}>
        {fixes.map((c, i) => {
          const first = diffLines(c.lines_before, c.lines_after).find((d) => d.kind !== 'same');
          const b = badge(c);
          return (
            <Press key={c.id} feedback="row" onPress={() => setOpen(open === c.id ? null : c.id)} accessibilityRole="button" accessibilityState={{ expanded: open === c.id }}
              style={[st.cb, i > 0 && st.sep]}>
              <View style={[st.tile, { width: 34, height: 34, borderRadius: 10, backgroundColor: palette.ground }]}><Ionicons name="create-outline" size={17} color={palette.ink} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T v="rt" numberOfLines={1}>{c.comment?.split(/[.!?\n]/)[0] || first?.name || t('och_fix_title')}</T>
                <T v="rs" numberOfLines={1}>{t('och_fix_from', { date: formatDayMonth(c.created_at, lang) })}</T>
              </View>
              <Badge tone={b.tone} label={b.label} />
            </Press>
          );
        })}
      </Card>
      {open ? (() => {
        const c = fixes.find((x) => x.id === open);
        return c ? <FixCard c={c} order={order} can={can} offline={offline} onDecided={onDecided} /> : null;
      })() : null}
      <T v="cap" style={{ paddingHorizontal: 8 }}>{t('och_fix_note')}</T>
    </>
  );
}

// ---------- Возврат ----------

function ReturnTab({ order: o, returns, disputes, can, offline, onSent }: TabProps & { onSent: () => void }) {
  const { t, td, lang } = useT();
  const [picked, setPicked] = useState<number[]>([]);
  const [why, setWhy] = useState<OrderReturnType | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const att = usePhotoAttach(5);
  if (!can.returns) return <Banner tone="info" icon="lock-closed-outline" text={t('ocd_no_order_right')} />;
  if (!o) return <Loading />;
  const lines = o.items.filter((it) => !it.excluded);
  const report = canReport(o);
  const submit = async () => {
    if (!why) return setErr(t('ort_need_type'));
    if (!picked.length && text.trim().length < 3) return setErr(t('och_ret_need'));
    setErr(null);
    setBusy(true);
    // описание обязательно на сервере: своё или «Причина: детали»
    const names = picked.map((i) => lines[i].name).join(', ');
    const description = text.trim() || `${td(`or_type_${why}`, why)}: ${names}`;
    try {
      await api.createOrderReturn(o.id, {
        type: why, description,
        lines: picked.map((i) => ({ key: lines[i].key ?? null, name: lines[i].name, unit: lines[i].unit, qty: lines[i].qty })),
        files: att.photos.map((p, i) => toUpload(p, i, 'return')),
      });
      toast.show({ text: t('ort_sent'), tone: 'success' });
      setPicked([]); setWhy(null); setText(''); att.clear();
      onSent();
    } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };
  return (
    <>
      {returns.length ? (
        <>
          <T v="lbl" style={st.lbl}>{t('och_ret_list')}</T>
          <Card padded={false}>
            {returns.map((r, i) => {
              const b = returnBadge(r);
              const disputable = canDisputeReturn(r, disputes);
              return (
                <View key={r.id} style={[st.cb, { alignItems: 'flex-start', paddingVertical: 12 }, i > 0 && st.sep]}>
                  <View style={[st.tile, { width: 34, height: 34, borderRadius: 10, backgroundColor: palette.ground }]}><Ionicons name="arrow-undo-outline" size={17} color={palette.ink} /></View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T v="rt" numberOfLines={1}>{`${t('och_return_n', { n: r.number ?? '' }).trim()} · ${td(`or_type_${r.type}`, r.type)}`}</T>
                    {r.description ? <T v="rs" numberOfLines={2}>{r.description}</T> : null}
                    {r.decision_comment ? <T v="rs" numberOfLines={2} style={{ color: palette.ink }}>{`«${r.decision_comment}»`}</T> : null}
                    {disputable ? (
                      <Press feedback="opacity" onPress={() => router.push({ pathname: '/order/dispute/[id]', params: { id: o.id, subject: 'return', return: r.id } })}
                        accessibilityRole="button" style={{ paddingTop: 4 }}>
                        <T v="link" style={{ fontSize: 15 }}>{t('or_dispute')}</T>
                      </Press>
                    ) : null}
                  </View>
                  <Badge tone={b.tone} label={t(b.key)} />
                </View>
              );
            })}
          </Card>
        </>
      ) : null}
      {!report ? (
        <EmptyState compact icon="shield-checkmark-outline" title={returns.length ? t('och_ret_new') : t('or_empty')} text={t('or_empty_unpaid')} />
      ) : (
        <>
          <T v="lbl" style={st.lbl}>{t('och_ret_parts')}</T>
          {lines.length ? (
            <Card padded={false}>
              {lines.map((l, i) => (
                <CheckRow key={`${l.key ?? l.name}-${i}`} title={l.name} sub={l.qty != null ? `${String(l.qty).replace('.', ',')} ${l.unit ?? ''}` : null}
                  on={picked.includes(i)} sep={i > 0} onPress={() => { setErr(null); setPicked((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i])); }} />
              ))}
            </Card>
          ) : null}
          <T v="lbl" style={st.lbl}>{t('och_ret_why')}</T>
          <View style={st.why}>
            {RETURN_TYPES.map((k) => (
              <Press key={k} feedback="scale" onPress={() => { setWhy(k); setErr(null); }} accessibilityRole="radio" accessibilityState={{ selected: why === k }}
                style={[st.wy, why === k && st.wyOn]}>
                <T style={[st.wyT, why === k && { color: palette.white }]}>{td(`or_type_${k}`, k)}</T>
              </Press>
            ))}
          </View>
          <Field placeholder={t('och_ret_comment')} value={text} onChangeText={(v) => { setText(v); setErr(null); }} multiline multilineMinHeight={72}
            maxLength={2000} style={{ fontSize: 16, lineHeight: 22, fontWeight: '400' }} />
          {att.photos.length ? <PhotoStrip photos={att.photos} onAdd={att.open} onRemove={att.remove} max={att.max} size={64} /> : null}
          <Button v="secondary" icon="camera-outline" title={att.photos.length ? t('och_ret_photo_n', { n: att.photos.length }) : t('oa_add_photo')} onPress={att.open} style={{ minHeight: 48 }} />
          {err ? <Banner tone="err" icon="alert-circle-outline" text={err} /> : null}
          <Button title={t('och_ret_send')} onPress={submit} loading={busy} disabled={offline} haptic="light" />
          <T v="cap" style={{ paddingHorizontal: 8 }}>{t('ort_note')}</T>
        </>
      )}
      {att.sheet}
    </>
  );
}

// ---------- Спор ----------

function DisputeTab({ order: o, returns, disputes, can }: TabProps) {
  const { t, td, lang } = useT();
  if (!can.disputes) return <Banner tone="info" icon="lock-closed-outline" text={t('ocd_no_order_right')} />;
  if (!disputes.length) {
    const r = returns.find((x) => canDisputeReturn(x, disputes));
    return (
      <>
        <EmptyState compact icon="shield-outline" title={t('och_dsp_empty')} text={t('och_dsp_empty_text')} />
        {o && r ? (
          <Button v="secondary" icon="shield-outline" title={t('or_dispute')}
            onPress={() => router.push({ pathname: '/order/dispute/[id]', params: { id: o.id, subject: 'return', return: r.id } })} />
        ) : null}
        {o && o.status === 'rejected' ? (
          <Button v="secondary" icon="shield-outline" title={t('ocd_dispute')}
            onPress={() => router.push({ pathname: '/order/dispute/[id]', params: { id: o.id, subject: 'rejection' } })} />
        ) : null}
      </>
    );
  }
  const list = [...disputes].reverse();
  return (
    <>
      {list.map((d) => {
        const r = d.return_id ? returns.find((x) => x.id === d.return_id) ?? null : null;
        const openD = d.status !== 'resolved';
        const steps = disputeSteps(d, r);
        const sub = (k: string) => {
          if (k === 'declined') return [r?.decision_comment ? `«${r.decision_comment}»` : null, r?.decided_at ? formatDayMonth(r.decided_at, lang) : null].filter(Boolean).join(' · ');
          if (k === 'opened') return [d.comment || td(`dsp_r_${d.reason}`, String(d.reason)), d.photos.length ? t('och_dsp_photos', { n: d.photos.length }) : null].filter(Boolean).join(' · ');
          return openD ? t('och_dsp_wait') : [d.decision_comment, d.amount && can.amounts ? t('dsp_amount', { sum: formatMoney(d.amount, lang) }) : null].filter(Boolean).join(' · ');
        };
        const title = (k: string) => (k === 'declined' ? t(r?.decision === 'declined' ? 'och_dsp_declined' : 'och_dsp_decided') : k === 'opened' ? t('och_dsp_opened')
          : openD ? t('och_dsp_decision') : td(`dsp_dec_${d.decision ?? 'none'}`, t('dsp_resolved')));
        return (
          <View key={d.id} style={{ gap: 10 }}>
            <Banner tone={openD ? 'est' : 'ok'} icon={openD ? 'hourglass-outline' : 'shield-checkmark-outline'}
              title={openD ? t('och_dispute_open') : t('dsp_resolved')}
              text={openD ? t('och_dsp_open_text') : formatDayMonth(d.resolved_at ?? d.created_at, lang)} style={{ alignItems: 'center' }} />
            <Card padded={false} style={{ paddingVertical: 6 }}>
              {steps.map((s) => (
                <View key={s.key} style={st.tl}>
                  <View style={[st.tlDot, s.done && { backgroundColor: openD ? palette.amber : palette.green }]} />
                  <View style={{ flex: 1 }}>
                    <T v="rt" style={!s.done ? { color: palette.faint } : null}>{title(s.key)}</T>
                    {sub(s.key) ? <T v="rs">{sub(s.key)}</T> : null}
                  </View>
                </View>
              ))}
            </Card>
            {d.photos.length ? <Attachments items={d.photos} size={64} /> : null}
          </View>
        );
      })}
    </>
  );
}

const st = StyleSheet.create({
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, minHeight: 56 },
  hsub: { fontSize: 13, lineHeight: 16, color: palette.muted },
  otabs: { flexDirection: 'row', gap: 6, paddingHorizontal: 2, paddingBottom: 4 },
  ot: { height: 36, borderRadius: 18, backgroundColor: palette.white, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 5 },
  otOn: { backgroundColor: palette.ink },
  otT: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: palette.ink },
  otN: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: palette.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  otNT: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: palette.white },
  list: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 32 },
  emptyIc: { width: 64, height: 64, borderRadius: 22, backgroundColor: palette.greenSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  day: { alignSelf: 'center', marginTop: 14, marginBottom: 2, backgroundColor: palette.segOnWhite, borderRadius: 12, paddingHorizontal: 10, height: 24, justifyContent: 'center' },
  dayT: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.muted },
  sys: { alignSelf: 'center', marginTop: 10, backgroundColor: '#EAE8E3', borderRadius: 10, paddingVertical: 3, paddingHorizontal: 10 },
  sysT: { fontSize: 12, lineHeight: 16, color: palette.faint },
  bubbleWrap: { maxWidth: '82%' },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end' },
  who: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: palette.blue, marginBottom: 2 },
  bubble: { paddingVertical: 9, paddingHorizontal: 13, borderRadius: 18 },
  me: { backgroundColor: palette.ink, borderBottomRightRadius: 6 },
  them: { backgroundColor: palette.white, borderBottomLeftRadius: 6 },
  msgT: { fontSize: 15, lineHeight: 20 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 2 },
  time: { fontSize: 11, lineHeight: 14, color: palette.faint },
  platform: { alignSelf: 'center', maxWidth: '88%', marginTop: 10, backgroundColor: palette.blueSoft, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', gap: 4 },
  platformBy: { fontSize: 13, lineHeight: 17, fontWeight: '700', color: palette.blue },
  platformT: { fontSize: 15, lineHeight: 21, color: '#1A3F99' },
  fix: { backgroundColor: palette.white, borderRadius: 20, padding: 14, gap: 10, borderWidth: 2, borderColor: '#DCE6FF' },
  fixH: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fixHT: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '700', color: palette.ink },
  dif: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  difK: { flex: 1, fontSize: 14, lineHeight: 19, color: palette.muted2 },
  difV: { fontSize: 14, lineHeight: 19, fontWeight: '600', color: palette.ink, flexShrink: 0, maxWidth: '55%', textAlign: 'right' },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: palette.white, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 14 },
  tile: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  inp: { minHeight: 48, borderRadius: 24, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingLeft: 5, paddingRight: 5, paddingVertical: 5 },
  clip: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, fontSize: 15, lineHeight: 20, color: palette.ink, maxHeight: 120, paddingTop: Platform.OS === 'ios' ? 9 : 5, paddingBottom: Platform.OS === 'ios' ? 9 : 5 },
  go: { width: 38, height: 38, borderRadius: 19, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  cb: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingVertical: 6, paddingHorizontal: 16 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  lbl: { paddingTop: 2, paddingHorizontal: 8 },
  why: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  wy: { height: 36, borderRadius: 12, backgroundColor: palette.white, paddingHorizontal: 12, justifyContent: 'center' },
  wyOn: { backgroundColor: palette.ink },
  wyT: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: palette.ink },
  tl: { flexDirection: 'row', gap: 12, paddingVertical: 10, paddingHorizontal: 16, alignItems: 'flex-start' },
  tlDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.handle, marginTop: 5 },
});
