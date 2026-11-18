/**
 * S10 КП — макеты Quote (предпросмотр), QuoteBlocked (нельзя отправить), QuoteSent (отправлено · версия N).
 * Варианты — GET /oyna/orders/{id}/variants (до 3 комплектаций), язык RU/UZ, кому — Telegram клиента из заказа,
 * «С логотипом цеха» — только в подписке (plan pro). Отправка — POST /oyna/orders/{id}/quotes {lang, kits, discount_pct};
 * 409 → причины по вариантам с «Исправить». Прошлые версии — GET /oyna/orders/{id} quotes[], отзыв — POST …/quotes/{v}/revoke.
 */
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { api, ApiError, errorText } from '@/api/http';
import type { OrderFull, QuoteBrief } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { date, money, num } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { Act, Button, ErrorText, LoadError, Loading, Note, Screen, Seg, Sheet, TopBar, Txt } from '@/ui/kit';
import { Icon } from '@/ui/Icon';
import { Schema } from '@/ui/Schema';
import { C } from '@/theme';
import {
  Banner, Blocking, CompanyOut, DownloadIcon, FootBar, LockIcon, Pill, QuoteBlockedBody, QuoteCreated, SoftButton, Tag, Toast,
  VariantFull, plural, sharePdf,
} from './parts';

type Lang = 'ru' | 'uz';
type Data = { order: OrderFull; variants: VariantFull[]; company: CompanyOut | null };

export default function Quote() {
  const p = useLocalSearchParams<{ id: string }>();
  const id = String(p.id);
  const { language } = useAuth();
  const load = useLoad<Data>(async () => {
    const [order, variants, company] = await Promise.all([
      api.get<OrderFull>(`/oyna/orders/${id}`),
      api.get<VariantFull[]>(`/oyna/orders/${id}/variants`),
      api.get<CompanyOut>('/oyna/company').catch(() => null),
    ]);
    return { order, variants, company };
  }, [id]);

  const [kitsSel, setKitsSel] = useState<string[] | null>(null);
  const [lang, setLang] = useState<Lang | null>(null);
  const [kitsOpen, setKitsOpen] = useState(false);
  const [sent, setSent] = useState<(QuoteCreated & { key: string }) | null>(null);
  const [blocked, setBlocked] = useState<QuoteBlockedBody['variants'] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; action?: string; onAction?: () => void } | null>(null);
  const hideToast = useCallback(() => setToast(null), []);

  const d = load.data;
  const order = d?.order;
  const variants = useMemo(() => d?.variants ?? [], [d]);

  // по умолчанию: комплектация заказа, иначе до трёх первых (как на сервере)
  const kits = useMemo(() => {
    if (kitsSel) return kitsSel;
    const cur = order?.kit_name && variants.some((v) => v.kit === order.kit_name) ? [order.kit_name] : null;
    return cur ?? variants.slice(0, 3).map((v) => v.kit);
  }, [kitsSel, order, variants]);
  const qLang: Lang = lang ?? (order?.client?.lang === 'uz' || order?.client?.lang === 'ru' ? order.client.lang : d?.company?.company.lang_default ?? language);
  const key = JSON.stringify([kits, qLang, order?.discount_pct ?? 0]);
  const current = sent && sent.key === key ? sent : null;

  /** номер позиции и id для редактора — по id позиции или id документа */
  const posIndex = useMemo(() => {
    const m = new Map<string, { n: number; id: string; room: string | null }>();
    (order?.positions ?? []).filter((x) => !x.deleted).forEach((x, i) => {
      const v = { n: i + 1, id: x.id, room: x.room };
      m.set(x.id, v);
      if (x.doc.id) m.set(x.doc.id, v);
    });
    return m;
  }, [order]);

  const head = <TopBar title={`КП · ${order?.client?.name || order?.order.client_name || 'клиент'}`} onBack={() => router.back()} />;
  if (load.error && !d) return <Screen>{head}<LoadError message={load.error} onRetry={load.reload} /></Screen>;
  if (!d || !order) return <Screen>{head}<Loading /></Screen>;

  const selected = variants.filter((v) => kits.includes(v.kit));
  // причины блока: ответ 409 или заранее из расчёта вариантов
  const blocks: { kit: string; blocking: Blocking[] }[] = blocked
    ?? selected.filter((v) => !v.can_quote && v.blocking.length).map((v) => ({ kit: v.kit, blocking: v.blocking }));
  const noPositions = !order.positions.filter((x) => !x.deleted).length;
  const isBlocked = blocks.length > 0 || noPositions;
  const pro = d.company?.company.plan === 'pro';
  const tg = order.client?.telegram || order.order.client_telegram;

  const send = async (): Promise<QuoteCreated | null> => {
    if (current) return current;
    setErr(null);
    try {
      const q = await api.post<QuoteCreated>(`/oyna/orders/${id}/quotes`, {
        lang: qLang, kits: variants.length ? kits : null, discount_pct: order.discount_pct ?? 0,
      });
      setSent({ ...q, key });
      setBlocked(null);
      setToast({ text: `КП отправлено · версия ${q.version}`, action: 'Ссылка', onAction: () => void copy(q) });
      void load.reload();
      return q;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.details as Partial<QuoteBlockedBody> | undefined;
        if (body?.variants?.length) setBlocked(body.variants);
        else setErr(e.message);
      } else setErr(errorText(e));
      return null;
    }
  };
  const run = async (what: string, fn: (q: QuoteCreated) => Promise<unknown>) => {
    setBusy(what);
    try {
      const q = await send();
      if (q) await fn(q);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const copy = async (q: { public_url: string }) => {
    await Clipboard.setStringAsync(q.public_url);
    setToast({ text: 'Ссылка скопирована' });
  };
  const telegram = (q: QuoteCreated) => Linking.openURL(q.telegram_share);
  const pdf = async (q: { version: number; pdf_url: string }) => {
    try {
      await sharePdf(`/oyna/orders/${id}/documents/quote.pdf?version=${q.version}`, `kp-${q.version}.pdf`, 'КП (PDF)');
    } catch {
      await Linking.openURL(q.pdf_url);              // запасной путь — публичная ссылка на PDF
    }
  };
  const revoke = (v: number) => {
    Alert.alert(`Отозвать ссылку на версию ${v}?`, 'Клиент увидит, что предложение отозвано, и контакты цеха.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Отозвать', style: 'destructive', onPress: async () => {
        try {
          await api.post(`/oyna/orders/${id}/quotes/${v}/revoke`);
          if (sent?.version === v) setSent(null);
          setToast({ text: `Ссылка версии ${v} отозвана` });
          void load.reload();
        } catch (e) { setErr(errorText(e)); }
      } },
    ]);
  };

  const toggleKit = (k: string) => {
    const cur = kits.includes(k) ? kits.filter((x) => x !== k) : [...kits, k];
    if (!cur.length) return;
    if (cur.length > 3) { setErr('В КП — не больше трёх вариантов'); return; }
    setErr(null);
    setBlocked(null);
    setKitsSel(variants.map((v) => v.kit).filter((x) => cur.includes(x)));
  };

  const fix = (b: Blocking, kit: string) => {
    const pos = b.position ? posIndex.get(b.position) : undefined;
    if (b.code === 'P.1') router.push({ pathname: '/order/[id]/calc', params: { id, kit } });
    else if (pos) router.push({ pathname: '/order/[id]/editor', params: { id, pos: pos.id } });
    else router.push({ pathname: '/order/[id]', params: { id } });
  };
  const reasonText = (b: Blocking) => {
    const pos = b.position ? posIndex.get(b.position) : undefined;
    const what = (b.code === 'P.1' ? 'нет цены' : b.msg || b.title).replace(/^нет цены:.*/, 'нет цены');
    return pos ? `у позиции ${pos.n} ${b.code === 'P.1' ? what : `— ${what}`}` : what;
  };
  const uniq = [...new Map(blocks.flatMap((v) => v.blocking).map((b) => [`${b.position}|${b.code}`, b])).values()];
  const summary = uniq.slice(0, 2).map(reasonText).join(', ') + (uniq.length > 2 ? ` и ещё ${uniq.length - 2}` : '');

  const units = order.units;
  const itemsCap = `${units} ${plural(units, 'изделие', 'изделия', 'изделий')}${order.extras.length ? ' + товар' : ''}`;
  const lines = selected.length ? selected.map((v) => ({ kit: v.kit, total: v.total, demo: v.demo }))
    : [{ kit: order.kit_name ?? 'Как в позициях', total: order.total, demo: order.demo }];
  const sendable = !isBlocked && !busy;

  return (
    <Screen>
      {head}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 16, gap: 10 }}>
        {isBlocked ? (
          <Banner kind="err" title="КП нельзя отправить"
            text={noPositions ? 'В заказе нет позиций' : summary.charAt(0).toUpperCase() + summary.slice(1)}
            action={uniq.length ? 'Исправить' : undefined} actionStyle="link" onAction={() => uniq[0] && fix(uniq[0], blocks[0].kit)} />
        ) : order.quote_outdated && order.quotes.length ? (
          <Banner kind="info" title="Заказ изменился после КП" text="Клиент видит старую версию — отправьте новую" />
        ) : null}

        {/* предпросмотр КП */}
        <Preview order={order} company={d.company} lines={lines} cap={itemsCap} />

        {isBlocked && uniq.length ? (
          <View style={{ backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' }}>
            {blocks.map((v) => v.blocking.map((b, i) => (
              <View key={`${v.kit}${i}`} style={[rowS, { borderTopWidth: 1, borderTopColor: C.line }, v === blocks[0] && i === 0 && { borderTopWidth: 0 }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt w={500}>{(() => { const t = reasonText(b); return t.charAt(0).toUpperCase() + t.slice(1); })()}</Txt>
                  <Note>{[blocks.length > 1 || variants.length > 1 ? v.kit : '', b.room, b.code].filter(Boolean).join(' · ')}</Note>
                </View>
                <Act title="Исправить" onPress={() => fix(b, v.kit)} />
              </View>
            )))}
          </View>
        ) : null}

        {!isBlocked || !uniq.length ? (
          <View style={{ backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' }}>
            <Pressable accessibilityRole="button" disabled={variants.length < 2} onPress={() => setKitsOpen(true)}
              style={({ pressed }) => [rowS, pressed && { backgroundColor: '#F7F6F3' }]}>
              <Txt w={500} style={{ flex: 1 }}>Варианты в КП</Txt>
              <Txt size={14} color={C.muted} lines={1} style={{ flexShrink: 1, textAlign: 'right' }}>{kits.join(', ') || 'как в позициях'}</Txt>
              {variants.length > 1 ? <Icon name="chevron" size={18} color={C.heroMuted} /> : null}
            </Pressable>
            <View style={[rowS, sep]}>
              <Txt w={500} style={{ flex: 1 }}>Язык</Txt>
              <View style={{ width: 150 }}>
                <Seg style={{ marginHorizontal: 0 }} items={[{ value: 'ru', title: 'RU' }, { value: 'uz', title: 'UZ' }]} value={qLang}
                  onChange={(v) => { setLang(v as Lang); setBlocked(null); }} />
              </View>
            </View>
            <View style={[rowS, sep]}>
              <Txt w={500} style={{ flex: 1 }}>Кому</Txt>
              <Txt size={14} color={C.muted} lines={1} style={{ flexShrink: 1 }}>
                {tg ? `${tg.startsWith('@') ? tg : `@${tg}`} · Telegram` : 'Telegram не указан · ссылкой'}
              </Txt>
            </View>
            <View style={[rowS, sep]} accessible accessibilityLabel={pro ? 'С логотипом цеха: включено' : 'С логотипом цеха: в подписке цеха'}>
              <View style={{ flex: 1 }}>
                <Txt w={500}>С логотипом цеха</Txt>
                <Txt size={14} color={C.muted}>{pro ? 'включено в подписке' : 'в подписке цеха'}</Txt>
              </View>
              {pro ? <Icon name="check" size={20} color={C.ok} /> : <LockIcon />}
            </View>
          </View>
        ) : null}

        {current ? (
          <View style={{ backgroundColor: C.card, borderRadius: 28, padding: 16, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Txt w={600} style={{ flex: 1 }}>Отправлено · версия {current.version}</Txt>
              {current.demo ? <Tag kind="est" title="ДЕМО" /> : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Скопировать ссылку" onPress={() => void copy(current)}
              style={{ backgroundColor: C.soft, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="link" size={18} color={C.accentText} />
              <Txt size={15} color={C.accentText} lines={1} style={{ flex: 1 }}>{current.public_url}</Txt>
            </Pressable>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Act title="Отправить в Telegram" onPress={() => void telegram(current)} />
              <Act title="Поделиться PDF" onPress={() => void run('pdf', pdf)} />
              <Act title="Отозвать ссылку" color={C.danger} onPress={() => revoke(current.version)} />
            </View>
          </View>
        ) : null}

        <ErrorText>{err}</ErrorText>

        {order.quotes.length ? <Versions quotes={order.quotes} onCopy={(q) => void copy({ public_url: q.url })}
          onPdf={(q) => void run('pdf', () => pdf({ version: q.version, pdf_url: `${q.url}/pdf` }))} onRevoke={revoke} /> : null}
      </ScrollView>

      <FootBar white={false}>
        <SoftButton square label="Скопировать ссылку" icon={<Icon name="link" size={22} />} disabled={!sendable && !current}
          onPress={() => void run('copy', copy)} />
        <SoftButton square label="PDF" icon={<DownloadIcon />} disabled={!sendable && !current} onPress={() => void run('pdf', pdf)} />
        <Button title="В Telegram" icon="send" style={{ flex: 1 }} disabled={!sendable && !current} loading={busy === 'tg'}
          onPress={() => void run('tg', telegram)} />
      </FootBar>

      {toast ? <Toast text={toast.text} action={toast.action} onAction={() => { toast.onAction?.(); hideToast(); }} onHide={hideToast} /> : null}

      <Sheet visible={kitsOpen} onClose={() => setKitsOpen(false)} title="Варианты в КП">
        <View style={{ paddingHorizontal: 12, gap: 10, paddingBottom: 8 }}>
          <Note style={{ paddingHorizontal: 8 }}>До трёх комплектаций — клиент выберет на странице КП.</Note>
          <View style={{ backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' }}>
            {variants.map((v, i) => {
              const on = kits.includes(v.kit);
              return (
                <Pressable key={v.kit} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => toggleKit(v.kit)}
                  style={({ pressed }) => [rowS, i > 0 && sep, pressed && { backgroundColor: '#F7F6F3' }]}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                      <Txt w={500}>{v.kit}</Txt>
                      {v.demo ? <Tag kind="est" title="ДЕМО" /> : null}
                      {!v.can_quote ? <Pill kind="red" title="есть блок" small /> : null}
                    </View>
                    <Txt size={14} color={C.muted}>{[money(v.total) + ' сум', v.current ? 'в заказе' : ''].filter(Boolean).join(' · ')}</Txt>
                  </View>
                  <View style={[box, on && { backgroundColor: C.accent, borderColor: C.accent }]}>
                    {on ? <Icon name="check" size={16} color="#fff" stroke={2.6} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
          <Button title="Готово" onPress={() => setKitsOpen(false)} />
        </View>
      </Sheet>
    </Screen>
  );
}

const rowS = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 14, minHeight: 52, paddingHorizontal: 20, paddingVertical: 10 };
const sep = { borderTopWidth: 1, borderTopColor: C.line };
const box = { width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: '#D3D1CB', alignItems: 'center' as const, justifyContent: 'center' as const };

/** Карточка-превью КП: цех, дата, до трёх схем, итог по вариантам */
function Preview({ order, company, lines, cap }: { order: OrderFull; company: CompanyOut | null; lines: { kit: string; total: number; demo: boolean }[]; cap: string }) {
  const [w, setW] = useState(0);
  const docs = order.positions.filter((x) => !x.deleted).slice(0, 3);
  const thumbW = w ? (w - 20) / 3 : 0;
  return (
    <View style={{ backgroundColor: C.card, borderRadius: 28, padding: 14, gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Txt w={700} lines={1} style={{ flexShrink: 1 }}>{company?.company.name ?? 'Цех'}</Txt>
        <Txt size={14} color={C.muted}>КП · {date(new Date().toISOString())}</Txt>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ flex: 1, height: 70, borderRadius: 12, backgroundColor: '#F7F7F5', alignItems: 'center', justifyContent: 'center' }}>
            {docs[i] && thumbW ? <Schema doc={docs[i].doc} width={Math.min(thumbW - 16, 70)} maxHeight={56} dims={false} /> : null}
          </View>
        ))}
      </View>
      {lines.map((l) => (
        <View key={l.kit} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
            <Txt size={14} color={C.muted} lines={1} style={{ flexShrink: 1 }}>{l.kit} · {cap}</Txt>
            {l.demo ? <Tag kind="est" title="ДЕМО" /> : null}
          </View>
          <Txt w={700} style={{ fontVariant: ['tabular-nums'] }}>{num(l.total)} сум</Txt>
        </View>
      ))}
    </View>
  );
}

/** Отправленные версии: согласовано / отозвано; ссылка, PDF, отзыв */
function Versions({ quotes, onCopy, onPdf, onRevoke }: { quotes: QuoteBrief[]; onCopy: (q: QuoteBrief) => void; onPdf: (q: QuoteBrief) => void; onRevoke: (v: number) => void }) {
  return (
    <>
      <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 8, paddingTop: 6 }}>Отправленные версии</Txt>
      <View style={{ backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' }}>
        {quotes.map((q, i) => (
          <View key={q.version} style={[{ paddingHorizontal: 20, paddingVertical: 12, gap: 8 }, i > 0 && sep]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Txt w={600} style={{ flex: 1 }}>Версия {q.version} · {date(q.sent_at)}</Txt>
              {q.demo ? <Tag kind="est" title="ДЕМО" /> : null}
              {q.accepted_at ? <Pill kind="green" title="согласовано" /> : q.revoked ? <Pill kind="gray" title="отозвана" /> : <Pill kind="blue" title="у клиента" />}
            </View>
            <Txt size={14} color={C.muted}>
              {q.variants.map((v) => `${v.kit} ${money(v.total)}`).join(' · ')}{` · ${q.lang.toUpperCase()}`}
              {q.accepted_at ? `\nВыбран «${q.accepted_kit ?? ''}» ${date(q.accepted_at)}${q.accepted_total ? ` · ${num(q.accepted_total)} сум` : ''}` : ''}
            </Txt>
            {!q.revoked ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Act title="Ссылка" onPress={() => onCopy(q)} />
                <Act title="PDF" onPress={() => onPdf(q)} />
                <Act title="Отозвать" color={C.danger} onPress={() => onRevoke(q.version)} />
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </>
  );
}
