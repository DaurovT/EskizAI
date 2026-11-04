/**
 * SCR-16 Карточка заказа (OrderCard.dc.html): шаги создан → принят → оплачен → в распиле → готов → выдан, сумма,
 * счёт EMAN, файлы распила, состав заказа; оплата — SCR-31 (/order/pay/[id]), отмена — SCR-40 (/order/cancel/[id]).
 * Кабинет поставщика (docs/staff_vendor_contract.md §5.3/§5.6): вернули на правку (комментарий, «Исправить и отправить
 * заново»), отклонён (причина, спор), исправление ждёт подтверждения (было → стало, подтвердить / отклонить),
 * принят (счёт, срок, конструктор, оплата); переписка с поставщиком, рекламации, история заказа.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import type { OrderCorrection, OrderEvent, OrderOut, OrderStatus } from '../../src/api/types';
import { SUPPORT_TG } from '../../src/config';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { mimeOf, utiOf } from '../../src/lib/files';
import { formatDayMonth, formatDayTime, formatMoney, groupDigits, plural } from '../../src/lib/format';
import {
  assigneeName, canDisputeRejection, canPay, canReport, canResubmit, diffLines, disputeFor, dueDate, invoiceTotal, orderAccess, orderSteps,
} from '../../src/lib/orders';
import { useSession } from '../../src/state/session';
import { useOrderPush } from '../../src/state/orderEvents';
import { confirm, showError } from '../../src/ui/dialogs';
import { ErrorState } from '../../src/ui/ErrorState';
import { Badge, Banner, Button, ButtonRow, Card, Field, Loading, Press, Screen, Sheet, T, Tile, toast } from '../../src/ui/kit';
import { Attachments, DisputeBlock, KV, Quote } from '../../src/ui/OrderParts';
import { palette, tones, type Tone } from '../../src/ui/theme';

/** Последнее событие с этим статусом (кто и когда вернул / отклонил). */
const lastEvent = (o: OrderOut, status: OrderStatus): OrderEvent | null =>
  [...(o.events ?? [])].reverse().find((e) => e.status === status) ?? null;

export default function OrderCard() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, td, lang } = useT();
  // сотрудник без права заказа не видит переписку, возвраты, споры и решения; без «видит себестоимость» — сумм и «Подтвердить»
  const { canOrder, seesCost } = useSession();
  const can = orderAccess({ canOrder, seesCost });
  const { data: o, setData, error, loading, reload } = useResource(() => api.getOrder(id), [id]);
  const project = useResource(() => (o ? api.getProject(o.project_id).catch(() => null) : Promise.resolve(null)), [o?.project_id]);
  const files = useResource(() => (o ? api.listFiles(o.project_id).catch(() => []) : Promise.resolve([])), [o?.project_id]);
  const corrections = useResource(() => (o?.status === 'awaiting_approval' && can.corrections ? api.listOrderCorrections(id).catch(() => []) : Promise.resolve([] as OrderCorrection[])), [id, o?.status, can.corrections]);
  const disputes = useResource(() => (o?.status === 'rejected' && can.disputes ? api.listOrderDisputes(id).catch(() => []) : Promise.resolve([])), [id, o?.status, can.disputes]);
  // push по этому заказу (сообщение, решение поставщика) — тихо обновить
  useOrderPush(id, () => { reload(); corrections.reload(); disputes.reload(); });
  const [items, setItems] = useState(false);
  const [history, setHistory] = useState(false);
  const [allLines, setAllLines] = useState(false);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineText, setDeclineText] = useState('');
  if (loading && !o) return <Loading />;
  if (!o) return <ErrorState error={error} onRetry={reload} />;

  const steps = orderSteps(o);
  const closed = o.status === 'cancelled' || o.status === 'rejected';
  const pay = o.payment;
  const payPending = !!pay && pay.status !== 'paid' && canPay(o);
  const sum = lang === 'uz' ? 'so‘m' : 'сум';
  const total = invoiceTotal(o);
  const client = project.data?.client?.name?.split(' ')[0];
  const designer = assigneeName(o);
  const due = dueDate(o);
  const unread = can.chat ? o.unread_count ?? 0 : 0;
  const correction = (corrections.data ?? []).find((c) => c.status === 'pending') ?? null;
  const dispute = disputeFor(disputes.data ?? [], 'rejection');
  const manager = () => Linking.openURL(`https://t.me/${SUPPORT_TG}?text=${encodeURIComponent(`Заказ №${o.number}`)}`);
  const toProject = () => router.push(`/project/${o.project_id}`);
  const filesOpen = (files.data ?? []).some((f) => f.available && !f.free);
  const invoice = o.documents.find((d) => d.kind === 'invoice');
  // разделитель у строки — если над ней в карточке уже есть строка
  const firstSep = (payPending && o.status !== 'accepted') || can.chat || (can.returns && (canReport(o) || (o.returns_count ?? 0) > 0));
  // «Счёт EMAN · PDF»: скачать и отдать файлом через системное меню, как файлы проекта
  const openInvoice = async () => {
    if (invoiceBusy) return;
    setInvoiceBusy(true);
    try {
      if (!(await Sharing.isAvailableAsync())) return Alert.alert(t('fv_share_unavailable'));
      const f = await api.downloadOrderInvoice(o.id);
      const mime = mimeOf(f.mimeType, f.name);
      await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: f.name, UTI: utiOf(mime) });
    } catch (e) { showError(e, lang); } finally { setInvoiceBusy(false); }
  };
  const act = async (key: string, fn: () => Promise<OrderOut>, done?: string) => {
    setBusy(key);
    try {
      setData(await fn());
      corrections.reload();
      if (done) toast.show({ text: done, tone: 'success' });
    } catch (e) { showError(e, lang); } finally { setBusy(null); }
  };
  const resubmit = async () => {
    if (!(await confirm(t('ocd_resubmit_q'), t('ocd_resubmit_text'), t('ocd_resubmit_do'), t('cancel')))) return;
    act('resubmit', () => api.resubmitOrder(o.id), t('ocd_resubmitted'));
  };
  const approve = () => correction && act('approve', () => api.approveOrderCorrection(o.id, correction.id), t('ocd_cor_approved'));
  const decline = async () => {
    if (!correction) return;
    setDeclineOpen(false);
    await act('decline', () => api.declineOrderCorrection(o.id, correction.id, declineText.trim() || null), t('ocd_cor_declined'));
    setDeclineText('');
  };
  const sub = (s: typeof steps[number]) => {
    if (s.current) return null;
    if (s.status === 'paid' && s.done) return [formatDayTime(s.at ?? pay?.paid_at ?? o.paid_at, lang).replace(/^—$/, ''), t('ocd_direct')].filter(Boolean).join(' · ');
    if (s.at) return formatDayTime(s.at, lang);
    if (s.status === 'ready' && !s.done && due) return t('ocd_expected', { date: formatDayMonth(due, lang) });
    return null;
  };
  const nowBadge = o.status === 'returned' ? { tone: 'amber' as Tone, label: t('ocd_now_returned') }
    : o.status === 'awaiting_approval' ? { tone: 'amber' as Tone, label: t('ocd_now_you') } : { tone: 'amber' as Tone, label: t('ocd_now') };

  // ---------- футер: главное действие по статусу ----------
  const smallRow = (
    <ButtonRow>
      <Button v="secondary" icon="call-outline" title={t('pay_manager')} onPress={manager} style={st.soft} textStyle={{ fontSize: 16 }} numberOfLines={1} />
      <Button v="secondary" icon="cube-outline" title={t('ocd_to_project')} onPress={toProject} style={st.soft} textStyle={{ fontSize: 16 }} numberOfLines={1} />
    </ButtonRow>
  );
  const cancelLink = !closed && o.status !== 'awaiting_approval' && can.cancel ? (
    <Press feedback="opacity" onPress={() => router.push(`/order/cancel/${o.id}`)} accessibilityRole="button" style={st.cancel}>
      {o.cancellable ? <T v="cap" color={palette.redText}>{t('ocd_cancel_link')}</T> : (
        <>
          <Ionicons name="lock-closed-outline" size={14} color={palette.muted} />
          <T v="cap">{t('ocd_cancel_locked')}</T>
        </>
      )}
    </Press>
  ) : null;
  const noRight = <T v="cap" style={st.note}>{t('ocd_no_order_right')}</T>;
  let footer: React.ReactNode;
  if (canResubmit(o) && !can.resubmit) {
    footer = <>{noRight}{smallRow}</>;
  } else if (o.status === 'awaiting_approval' && !can.corrections) {
    footer = smallRow; // причина — в баннере над шагами
  } else if (canResubmit(o)) {
    footer = (
      <>
        <Button icon="create-outline" title={t('ocd_fix_resend')} onPress={toProject} />
        <Button v="ghost" title={t('ocd_resubmit_now')} onPress={resubmit} loading={busy === 'resubmit'} />
      </>
    );
  } else if (o.status === 'awaiting_approval') {
    footer = (
      <>
        {can.approveCorrection ? (
          <Button title={t('ocd_cor_approve')} onPress={approve} loading={busy === 'approve'} disabled={!correction || !!busy} haptic="success" />
        ) : <T v="cap" style={st.note}>{t('ocd_cor_cost_only')}</T>}
        <Button v="secondary" title={t('ocd_cor_decline')} onPress={() => setDeclineOpen(true)} disabled={!correction || !!busy} loading={busy === 'decline'} />
      </>
    );
  } else if (payPending && o.status === 'accepted') {
    footer = (
      <>
        <Button title={t('ocd_pay')} value={total != null ? groupDigits(total) : undefined} onPress={() => router.push(`/order/pay/${o.id}`)} haptic="success" />
        {smallRow}
        {cancelLink}
      </>
    );
  } else {
    footer = <>{smallRow}{cancelLink}</>;
  }

  return (
    <Screen gap={10} contentStyle={{ paddingTop: 0 }} footerStyle={{ paddingTop: 6, gap: 4 }} footer={footer}>
      <Stack.Screen options={{ title: '' }} />
      <View style={{ paddingHorizontal: 8 }}>
        <T v="bigPush" style={{ letterSpacing: -0.56 }}>{t('ocd_title', { n: o.number })}</T>
        <View style={st.subRow}>
          <T v="sub" style={{ flex: 1 }} numberOfLines={1}>{[o.project_title, client].filter(Boolean).join(' · ')}</T>
          {total != null ? <T num style={st.total}>{groupDigits(total)}<T style={st.cur}>{` ${sum}`}</T></T> : null}
        </View>
      </View>

      {/* ---------- решение поставщика ---------- */}
      {o.status === 'returned' ? (
        <Card style={st.blk}>
          <BlockHead icon="arrow-undo-outline" tone="amber" title={t('ocd_returned_t')}
            sub={[designer ?? o.supplier_name, formatDayTime(lastEvent(o, 'returned')?.created_at, lang).replace(/^—$/, '')].filter(Boolean).join(' · ')} />
          {o.vendor_status_note ? <Quote text={o.vendor_status_note} /> : null}
          <T v="cap">{t('ocd_returned_hint')}</T>
        </Card>
      ) : null}

      {o.status === 'rejected' ? (
        <Card style={st.blk}>
          <BlockHead icon="close-circle-outline" tone="red" title={t('ocd_rejected_t')}
            sub={[o.supplier_name, formatDayTime(lastEvent(o, 'rejected')?.created_at, lang).replace(/^—$/, '')].filter(Boolean).join(' · ')} />
          {o.reject_reason ? <KV k={t('ocd_reason')} v={td(`orr_${o.reject_reason}`, o.reject_reason)} /> : null}
          {o.vendor_status_note ? <Quote text={o.vendor_status_note} /> : null}
          {!can.disputes ? null : dispute ? <DisputeBlock d={dispute} /> : canDisputeRejection(o, disputes.data ?? []) && !disputes.loading ? (
            <Button v="secondary" small icon="shield-outline" title={t('ocd_dispute')} onPress={() => router.push({ pathname: '/order/dispute/[id]', params: { id: o.id, subject: 'rejection' } })} />
          ) : null}
        </Card>
      ) : null}

      {o.status === 'awaiting_approval' ? (
        !can.corrections ? (
          <Banner tone="est" icon="lock-closed-outline" text={t('ocd_no_order_right')} />
        ) : correction ? (
          <CorrectionCard c={correction} all={allLines} money={can.amounts} onToggle={() => setAllLines(!allLines)} />
        ) : corrections.loading ? <Card><ActivityIndicator color={palette.chev} /></Card> : (
          <Banner tone="est" icon="time-outline" text={t('ocd_cor_missing')} />
        )
      ) : null}

      {o.status === 'accepted' ? (
        <Card style={st.blk}>
          <BlockHead icon="receipt-outline" tone="green" title={payPending ? t('ocd_invoice_t') : t('os_accepted')}
            sub={formatDayTime(lastEvent(o, 'accepted')?.created_at, lang).replace(/^—$/, '') || undefined} />
          {total != null ? <KV k={t('ocd_invoice_total')} v={formatMoney(total, lang)} strong /> : null}
          {o.invoice_total != null && o.total != null && o.invoice_total !== o.total ? <T v="cap">{t('ocd_invoice_diff', { sum: formatMoney(o.total, lang) })}</T> : null}
          {due ? <KV k={t('ocd_due')} v={formatDayMonth(due, lang)} /> : null}
          {designer ? <KV k={t('ocd_designer')} v={designer} /> : null}
        </Card>
      ) : null}

      {o.status === 'created' ? <Banner tone="info" icon="time-outline" text={t('ocd_in_review')} /> : null}

      {/* ---------- шаги ---------- */}
      <Card padded={false} style={st.tl}>
        {closed ? (
          <View style={st.s}>
            <View style={st.dt}><View style={[st.c, { backgroundColor: palette.red }]}><Ionicons name="close" size={14} color={palette.white} /></View></View>
            <View style={{ flex: 1 }}>
              <T style={st.t}>{td(`os_${o.status}`, o.status_label ?? o.status)}</T>
              <T v="cap">{formatDayTime(lastEvent(o, o.status)?.created_at, lang).replace(/^—$/, '')}</T>
            </View>
          </View>
        ) : steps.map((s, i) => {
          const last = i === steps.length - 1;
          const fut = !s.done && !s.current;
          const sb = sub(s);
          return (
            <View key={s.status} style={[st.s, last && { minHeight: 32 }]}>
              <View style={st.dt}>
                <View style={[st.c, s.current ? st.cCur : s.done ? st.cDone : st.cFut]}>
                  {s.done && !s.current ? <Ionicons name="checkmark" size={14} color={palette.white} /> : null}
                </View>
                {!last ? <View style={[st.ln, s.done && !s.current && { backgroundColor: palette.green }]} /> : null}
              </View>
              <View style={{ flex: 1, paddingBottom: last ? 0 : 8 }}>
                <T style={[st.t, fut && st.tFut]}>{td(`os_${s.status}`, s.label)}</T>
                {s.current ? <Badge tone={nowBadge.tone} label={nowBadge.label} style={{ marginTop: 4 }} /> : sb ? <T v="cap">{sb}</T> : null}
              </View>
            </View>
          );
        })}
      </Card>

      {/* поставщик, конструктор и срок — кроме статусов, где они уже показаны выше */}
      {!['accepted', 'rejected', 'cancelled'].includes(o.status) && (o.supplier_name || designer || due) ? (
        <Card style={{ gap: 8 }}>
          {o.supplier_name ? <KV k={t('ocd_supplier')} v={o.supplier_name} /> : null}
          {designer ? <KV k={t('ocd_designer')} v={designer} /> : null}
          {due && o.status !== 'issued' ? <KV k={t('ocd_due')} v={formatDayMonth(due, lang)} /> : null}
        </Card>
      ) : null}

      <Card padded={false}>
        {payPending && o.status !== 'accepted' ? (
          <Row icon="card-outline" title={t('ocd_pay_row')} onPress={() => router.push(`/order/pay/${o.id}`)}
            right={<Badge tone={pay?.status === 'failed' ? 'red' : 'amber'} label={pay?.status === 'failed' ? t('pay_fail_t') : t('pay_wait_t')} style={{ alignSelf: 'center' }} />} />
        ) : null}
        {can.chat ? (
          <Row icon="chatbubbles-outline" title={t('ocd_chat')} onPress={() => router.push(`/order/chat/${o.id}`)} sep={payPending && o.status !== 'accepted'}
            right={unread ? <View style={st.unread} accessibilityLabel={t('ol_unread', { n: unread })}><T style={st.unreadT} num>{unread}</T></View> : undefined} />
        ) : null}
        {can.returns && (canReport(o) || (o.returns_count ?? 0) > 0) ? (
          <Row icon="alert-circle-outline" title={t('ocd_returns')} onPress={() => router.push(`/order/returns/${o.id}`)} sep={can.chat || (payPending && o.status !== 'accepted')}
            right={o.returns_count ? <T v="rs">{String(o.returns_count)}</T> : undefined} />
        ) : null}
        {invoice ? <Row icon="document-outline" title={t('ocd_invoice')} right={invoiceBusy ? <ActivityIndicator color={palette.chev} /> : <T v="rs">PDF</T>} onPress={openInvoice} sep={firstSep} /> : null}
        <Row icon="cut-outline" title={t('ocd_files')} onPress={() => router.push(`/project/${o.project_id}/files`)} sep={firstSep || !!invoice}
          right={filesOpen ? <Badge tone="green" label={t('ocd_files_open')} style={{ alignSelf: 'center' }} /> : undefined} />
        <Row icon="list-outline" title={t('ocd_items')} sep onPress={() => setItems(!items)} chevron={items ? 'chevron-up' : 'chevron-down'}
          right={<T v="rs">{`${o.items.length} ${plural(o.items.length, t('est_u_pos'))}`}</T>} />
        {items ? o.items.map((it, i) => (
          <View key={i} style={st.item}>
            <T style={[st.itemT, it.excluded && { color: palette.muted }]} numberOfLines={2}>{`${it.name}${it.qty != null ? ` · ${String(it.qty).replace('.', ',')} ${it.unit ?? ''}` : ''}`}</T>
            {can.amounts ? <T num style={st.itemV}>{it.excluded || it.amount == null ? '—' : groupDigits(it.amount)}</T> : null}
          </View>
        )) : null}
        {items ? <View style={{ height: 10 }} /> : null}
      </Card>

      {/* ---------- история (order_events) ---------- */}
      {o.events?.length ? (
        <Card padded={false}>
          <Row icon="time-outline" title={t('ocd_history')} onPress={() => setHistory(!history)} chevron={history ? 'chevron-up' : 'chevron-down'}
            right={<T v="rs">{String(o.events.length)}</T>} />
          {history ? [...o.events].reverse().map((e) => (
            <View key={e.id} style={st.ev}>
              <View style={[st.evDot, { backgroundColor: tones[eventTone(e)].dot }]} />
              <View style={{ flex: 1 }}>
                <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '600' }}>{e.type === 'status_changed' && e.status ? td(`os_${e.status}`, e.status) : td(`oe_${e.type}`, e.type)}</T>
                <T v="cap">{[e.actor_name ?? (e.actor_type ? td(`oe_by_${e.actor_type}`, '') : ''), formatDayTime(e.created_at, lang)].filter(Boolean).join(' · ')}</T>
                {e.comment ? <T style={{ fontSize: 14, lineHeight: 19, marginTop: 2 }} color={palette.muted2}>{e.comment}</T> : null}
              </View>
            </View>
          )) : null}
          {history ? <View style={{ height: 8 }} /> : null}
        </Card>
      ) : null}

      <Sheet visible={declineOpen} onClose={() => setDeclineOpen(false)} title={t('ocd_cor_decline_t')}
        footer={<Button v="danger" title={t('ocd_cor_decline')} onPress={decline} loading={busy === 'decline'} />}>
        <T v="sub">{t('ocd_cor_decline_text')}</T>
        <Field label={t('ocd_cor_decline_comment')} value={declineText} onChangeText={setDeclineText} multiline multilineMinHeight={96} maxLength={1000}
          style={{ fontSize: 16, lineHeight: 22, fontWeight: '400' }} />
      </Sheet>
    </Screen>
  );
}

const eventTone = (e: OrderEvent): Tone =>
  e.status === 'rejected' || e.status === 'cancelled' ? 'red'
    : e.status === 'returned' || e.status === 'awaiting_approval' || e.type.startsWith('return') || e.type.startsWith('dispute') ? 'amber'
      : e.status ? 'green' : 'gray';

/** Заголовок блока решения: круглая иконка цвета статуса, заголовок и подпись (кто, когда). */
function BlockHead({ icon, tone, title, sub }: { icon: React.ComponentProps<typeof Ionicons>['name']; tone: Tone; title: string; sub?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={[st.ic, { backgroundColor: tones[tone].bg }]}><Ionicons name={icon} size={22} color={tones[tone].fg} /></View>
      <View style={{ flex: 1 }}>
        <T v="h3">{title}</T>
        {sub ? <T v="cap" numberOfLines={1}>{sub}</T> : null}
      </View>
    </View>
  );
}

/** Исправление поставщика: комментарий, было → стало по сумме, изменённые строки (все — по кнопке), файлы. */
function CorrectionCard({ c, all, money, onToggle }: { c: OrderCorrection; all: boolean; money: boolean; onToggle: () => void }) {
  const { t, lang } = useT();
  const diff = diffLines(c.lines_before, c.lines_after);
  const changed = diff.filter((d) => d.kind !== 'same');
  const shown = all ? diff : changed;
  // без права «видит себестоимость» сервер не отдаёт ни суммы, ни цены строк — показываем только количества
  const delta = !money ? null : c.delta ?? (c.total_after != null && c.total_before != null ? c.total_after - c.total_before : null);
  const qty = (v: number | null | undefined) => (v == null ? '—' : String(v).replace('.', ','));
  return (
    <Card style={st.blk}>
      <BlockHead icon="create-outline" tone="amber" title={t('ocd_cor_t')} sub={[c.author_name, formatDayTime(c.created_at, lang)].filter(Boolean).join(' · ')} />
      {c.comment ? <Quote text={c.comment} /> : null}
      {money && c.total_before != null && c.total_after != null ? (
        <View style={st.totals}>
          <View style={{ flex: 1 }}>
            <T v="cap">{t('ocd_cor_was')}</T>
            <T num style={st.was}>{groupDigits(c.total_before)}</T>
          </View>
          <Ionicons name="arrow-forward" size={18} color={palette.muted} />
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <T v="cap">{t('ocd_cor_now')}</T>
            <T num style={st.now}>{groupDigits(c.total_after)}</T>
          </View>
        </View>
      ) : null}
      {delta ? <Badge tone={delta > 0 ? 'red' : 'green'} label={`${delta > 0 ? '+' : '−'}${formatMoney(Math.abs(delta), lang)}`} style={{ alignSelf: 'flex-start' }} /> : null}
      {shown.length ? (
        <View style={{ gap: 2 }}>
          {shown.map((d) => (
            <View key={d.key} style={st.dl}>
              <View style={{ flex: 1 }}>
                <T style={[st.dlT, d.kind === 'removed' && st.strike]} numberOfLines={2}>{d.name}</T>
                <T v="cap" num>
                  {d.kind === 'added' ? `${t('ocd_cor_added')} · ${qty(d.after?.qty)} ${d.unit ?? ''}`
                    : d.kind === 'removed' ? `${t('ocd_cor_removed')} · ${qty(d.before?.qty)} ${d.unit ?? ''}`
                      : `${qty(d.before?.qty)} → ${qty(d.after?.qty)} ${d.unit ?? ''}`}
                </T>
              </View>
              {money ? (
                <T num style={[st.dlV, d.kind === 'added' && { color: tones.red.fg }, d.kind === 'removed' && { color: tones.green.fg }]}>
                  {d.after?.total != null ? groupDigits(d.after.total) : d.before?.total != null ? `−${groupDigits(d.before.total)}` : '—'}
                </T>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {diff.length > changed.length ? (
        <T v="link" onPress={onToggle} style={{ fontSize: 15 }}>{all ? t('ocd_cor_changed_only') : t('ocd_cor_all', { n: diff.length })}</T>
      ) : null}
      <Attachments items={c.files} />
    </Card>
  );
}

function Row({ icon, title, right, onPress, sep, chevron = 'chevron-forward' }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; title: string; right?: React.ReactNode; onPress?: () => void; sep?: boolean;
  chevron?: React.ComponentProps<typeof Ionicons>['name'];
}) {
  return (
    <Press feedback="row" onPress={onPress} accessibilityRole="button" style={[st.row, sep && st.sep]}>
      <Tile icon={icon} style={{ width: 40, height: 40 }} />
      <T v="rt" style={{ flex: 1 }} numberOfLines={1}>{title}</T>
      {right}
      <Ionicons name={chevron} size={18} color={palette.chev} />
    </Press>
  );
}

const st = StyleSheet.create({
  subRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4, gap: 8 },
  total: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.33 },
  cur: { fontSize: 15, fontWeight: '500', color: palette.muted, letterSpacing: 0 },
  blk: { gap: 12, paddingVertical: 18, paddingHorizontal: 20 },
  ic: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  totals: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: palette.ground, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 },
  was: { fontSize: 18, lineHeight: 24, fontWeight: '600', color: palette.muted, textDecorationLine: 'line-through' },
  now: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  dl: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 6 },
  dlT: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  dlV: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  strike: { textDecorationLine: 'line-through', color: palette.muted },
  tl: { paddingTop: 14, paddingHorizontal: 20, paddingBottom: 10 },
  s: { flexDirection: 'row', gap: 14, minHeight: 56 },
  dt: { width: 24, alignItems: 'center' },
  c: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cDone: { backgroundColor: palette.green },
  cCur: { backgroundColor: palette.white, borderWidth: 7, borderColor: palette.amber },
  cFut: { borderWidth: 2, borderColor: '#DEDCD8' },
  ln: { flex: 1, width: 2, backgroundColor: palette.off, marginVertical: 2 },
  t: { fontSize: 16, lineHeight: 22, fontWeight: '600', marginTop: 1 },
  tFut: { color: palette.faint, fontWeight: '500' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 10, paddingHorizontal: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  item: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4, paddingLeft: 74, paddingRight: 20 },
  itemT: { flex: 1, fontSize: 14, lineHeight: 19 },
  itemV: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  ev: { flexDirection: 'row', gap: 14, paddingVertical: 8, paddingLeft: 34, paddingRight: 20 },
  evDot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  unread: { minWidth: 24, height: 24, borderRadius: 12, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  unreadT: { fontSize: 13, lineHeight: 17, fontWeight: '700', color: palette.white },
  soft: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', paddingHorizontal: 14 },
  note: { textAlign: 'center', paddingHorizontal: 12, paddingBottom: 4 },
  cancel: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
});
