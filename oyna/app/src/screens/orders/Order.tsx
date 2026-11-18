/**
 * S04 «Заказ» — макеты Order, OrderBlock, OrderAgreed; пустой заказ — OrderNew.
 * GET /oyna/orders/{id}: клиент, комплектация, позиции со схемой, сопутствующие товары, итоги (владельцу — себестоимость и маржа).
 * Заказ, который пока есть только на телефоне (404 / нет сети), показывается из offline.snapshot().
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, RefreshControl, View } from 'react-native';

import { api, ApiError, errorText } from '@/api/http';
import type { Extra, OrderFull, PositionOut, QuoteBrief } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { date, money, m2, num, phone as fmtPhone, STATUS_TITLE, sum } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { LocalOrder, LocalPosition, offline } from '@/offline/store';
import { C } from '@/theme';
import { Icon } from '@/ui/Icon';
import {
  Body, Button, Card, Dock, ErrorText, Field, IconButton, LoadError, Loading, Row, Screen, Seg, Sheet, StatusPill, Txt,
} from '@/ui/kit';
import { Ban, CompanyOut, dims, ExtraSheet, KbSheet, NotSent, nItems, OptCard, PIcon, Pill, PosTile, SoftSm, st, Tag } from './parts';

type Loaded =
  | { kind: 'server'; full: OrderFull; local: LocalPosition[] }
  | { kind: 'local'; order: LocalOrder | null; local: LocalPosition[]; offline: boolean };

/** Комплектации цеха для переключателя «Эконом / Стандарт / Тёплый» — один раз за запуск. */
let kitsCache: string[] | null = null;

export default function Order() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isOwner } = useAuth();
  const [kits, setKits] = useState<string[]>(kitsCache ?? []);
  const [kitBusy, setKitBusy] = useState<string | null>(null);
  const [kitErr, setKitErr] = useState<string | null>(null);
  const [extraEdit, setExtraEdit] = useState<Extra | null | undefined>(undefined); // undefined — лист закрыт, null — новый
  const [clientOpen, setClientOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const { data, setData, error, loading, reload } = useLoad<Loaded>(async () => {
    const snap = await offline.snapshot();
    const local = Object.values(snap.positions).filter((p) => p.order_id === id && !p.deleted);
    const get = () => api.get<OrderFull>(`/oyna/orders/${id}`);
    try {
      return { kind: 'server', full: await get(), local };
    } catch (e) {
      if (!(e instanceof ApiError) || !(e.status === 404 || e.isNetwork)) throw e;
      // заказ создан на телефоне и ещё не отправлен — пробуем отправить и прочитать снова
      if (e.status === 404 && snap.orders[id] && !snap.orders[id].synced) {
        const r = await offline.sync().catch(() => null);
        if (r && !r.offline) {
          try {
            const s2 = await offline.snapshot();
            return { kind: 'server', full: await get(), local: Object.values(s2.positions).filter((p) => p.order_id === id && !p.deleted) };
          } catch { /* покажем локальный */ }
        }
      }
      if (e.status === 404 && !snap.orders[id] && !local.length) throw e;
      return { kind: 'local', order: snap.orders[id] ?? null, local, offline: e.isNetwork };
    }
  }, [id]);

  useEffect(() => {
    if (kitsCache) return;
    api.get<CompanyOut>('/oyna/company').then((c) => { kitsCache = c.kits.map((k) => k.name); setKits(kitsCache); }).catch(() => { /* без сети */ });
  }, []);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useFocusEffect(useCallback(() => offline.subscribe(() => { void reloadRef.current(); }), []));

  const back = () => (router.canGoBack() ? router.back() : router.replace('/orders'));
  const measure = () => router.push(`/order/${id}/measure`);
  const templates = () => router.push(`/order/${id}/templates`);
  const openPos = (pid: string, step?: number) =>
    router.push(step !== undefined ? `/order/${id}/measure?pos=${pid}&step=${step}` : `/order/${id}/editor?pos=${pid}`);

  if (!data && loading) return <Screen><TopBarRow onBack={back} /><Loading /></Screen>;
  if (!data) return <Screen><TopBarRow onBack={back} /><LoadError message={error ?? ''} onRetry={reload} /></Screen>;

  // ---------- заказ только на телефоне ----------
  if (data.kind === 'local') {
    const o = data.order;
    const units = data.local.reduce((s, p) => s + (p.doc.qty ?? 1), 0);
    return (
      <Screen>
        <TopBarRow onBack={back} phone={o?.client?.phone} />
        <Head title={o?.client?.name || 'Без клиента'} sub={[o?.address, o?.floor ? `${o.floor} этаж` : null, o?.client?.telegram].filter(Boolean).join(' · ')}
          status="measure" extra={<NotSent />} />
        <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10 }} refresh={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.accent} />}>
          <Ban kind="n" icon={data.offline ? 'wifi_off' : 'cloud_up'} title={data.offline ? 'Нет интернета' : 'Заказ ещё не отправлен'}
            text="Всё сохранено на телефоне. Цену посчитаем, когда появится интернет" />
          {data.local.length ? (
            <Card style={{ marginHorizontal: 0 }}>
              {data.local.map((p, i) => <LocalPosRow key={p.id} p={p} first={i === 0} onPress={() => openPos(p.id, p.step)} />)}
            </Card>
          ) : <EmptyWays onMeasure={measure} onTemplate={templates} extraDisabled />}
          {data.local.length ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SoftSm icon="plus" title="Замерить" onPress={measure} style={{ flex: 1 }} />
              <SoftSm icon="grid" title="Шаблон" onPress={templates} style={{ flex: 1 }} />
              <SoftSm icon="tag" title="Товар" disabled style={{ flex: 1 }} />
            </View>
          ) : null}
          {units ? (
            <Card style={{ marginHorizontal: 0, padding: 20, gap: 2 }}>
              <Txt size={14} color={C.muted}>Клиенту · {nItems(units)}</Txt>
              <Txt size={17} w={600}>посчитаем, когда появится интернет</Txt>
            </Card>
          ) : null}
        </Body>
      </Screen>
    );
  }

  // ---------- заказ с сервера ----------
  const f = data.full;
  const o = f.order;
  const positions = f.positions.filter((p) => !p.deleted);
  const serverIds = new Set(positions.map((p) => p.id));
  const dirty = new Set(data.local.filter((p) => p.dirty).map((p) => p.id));
  const localOnly = data.local.filter((p) => !serverIds.has(p.id));
  const empty = !positions.length && !f.extras.length && !localOnly.length;
  const blockedIdx = f.blocked_positions.map((pid) => positions.findIndex((p) => p.id === pid) + 1).filter((n) => n > 0);
  const lastQuote: QuoteBrief | undefined = f.quotes.find((q) => !q.revoked) ?? f.quotes[0];
  const agreed = o.status === 'agreed' && !!lastQuote?.accepted_at;
  const clientName = f.client?.name || 'Без клиента';
  const headSub = [o.address, o.floor ? `${o.floor} этаж` : null, f.client?.telegram].filter(Boolean).join(' · ');

  const applyKit = async (kit: string) => {
    if (kit === f.kit_name) return;
    setKitBusy(kit); setKitErr(null);
    try {
      await api.post(`/oyna/orders/${id}/apply-kit`, { kit_name: kit, base_revs: Object.fromEntries(positions.map((p) => [p.id, p.rev])) });
      await reload();
    } catch (e) {
      setKitErr(e instanceof ApiError && e.isConflict ? 'Позиции только что изменили — обновили заказ, выберите ещё раз' : errorText(e));
      if (e instanceof ApiError && e.isConflict) void reload();
    } finally {
      setKitBusy(null);
    }
  };

  return (
    <Screen>
      <TopBarRow onBack={back} phone={f.client?.phone} onMore={() => setMoreOpen(true)} />
      <Head title={clientName} sub={headSub} status={o.status} onPress={() => setClientOpen(true)} />
      <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10, paddingBottom: 24 }}
        refresh={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.accent} />}>
        {/* согласовано (OrderAgreed) */}
        {agreed && lastQuote ? (
          <Ban kind="ok" icon="check" title={`Клиент согласился ${date(lastQuote.accepted_at).slice(0, 5)}`}
            text={`Вариант «${lastQuote.accepted_kit ?? ''}», ${sum(lastQuote.accepted_total)}. ${f.quote_outdated ? 'Позиции изменены — отправьте новую версию КП' : 'Изменения создадут новую версию КП'}`} />
        ) : f.quote_outdated ? (
          <Ban kind="est" icon="warn" title="КП устарело" text="Изменения создадут новую версию КП" />
        ) : null}

        {/* блокировки (OrderBlock) */}
        {!empty && f.blocked_positions.length ? (
          <Ban kind="err" icon="warn" title="КП нельзя отправить"
            text={
              <View style={{ gap: 2 }}>
                {f.blocked_positions.map((pid) => {
                  const i = positions.findIndex((p) => p.id === pid);
                  const p = positions[i];
                  const v = p?.violations.find((x) => (x.severity === 'block' || x.severity === 'lock') && !x.accepted);
                  return <Txt key={pid} size={14} color={C.errFg}>Позиция {i + 1}{p?.room ? ` (${p.room})` : ''} — {v ? (v.msg || v.title) : 'есть ошибка'}</Txt>;
                })}
              </View>
            } />
        ) : null}

        {empty ? (
          <EmptyWays onMeasure={measure} onTemplate={templates} onExtra={() => setExtraEdit(null)} />
        ) : (
          <>
            {/* комплектация на весь заказ */}
            {kits.length && positions.length ? (
              <View style={{ gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Seg items={kits.map((k) => ({ value: k, title: kitBusy === k ? '…' : k }))} value={kitBusy ?? f.kit_name ?? ''} onChange={applyKit} style={{ marginHorizontal: 0 }} />
                  </View>
                  <Pressable accessibilityRole="button" onPress={() => router.push(`/order/${id}/kit`)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}>
                    <Txt w={500} color={C.accentText}>Настроить</Txt>
                  </Pressable>
                </View>
                {!f.kit_name ? <Txt size={13} color={C.muted} style={{ paddingHorizontal: 8 }}>Комплектация не выбрана — у позиций своя</Txt> : null}
                <ErrorText>{kitErr}</ErrorText>
              </View>
            ) : f.kit_name ? (
              <Card style={{ marginHorizontal: 0 }}><Row label={`Комплектация: ${f.kit_name}`} onPress={() => router.push(`/order/${id}/kit`)} first /></Card>
            ) : null}

            <Card style={{ marginHorizontal: 0 }}>
              {positions.map((p, i) => (
                <PosRow key={p.id} p={p} first={i === 0} dirty={dirty.has(p.id)} agreed={agreed} onPress={() => openPos(p.id)} />
              ))}
              {localOnly.map((p, i) => <LocalPosRow key={p.id} p={p} first={!positions.length && i === 0} onPress={() => openPos(p.id, p.step)} />)}
              {f.extras.map((e, i) => (
                <ExtraRow key={e.id} e={e} first={!positions.length && !localOnly.length && i === 0} onPress={() => setExtraEdit(e)} />
              ))}
            </Card>

            {/* добавить изделие */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SoftSm icon="plus" title="Замерить" onPress={measure} style={{ flex: 1 }} />
              <SoftSm icon="grid" title="Шаблон" onPress={templates} style={{ flex: 1 }} />
              <SoftSm icon="tag" title="Товар" onPress={() => setExtraEdit(null)} style={{ flex: 1 }} />
            </View>

            {/* итог */}
            <Totals f={f} blockedIdx={blockedIdx} owner={isOwner} />

            {agreed ? (
              <Pressable accessibilityRole="button" onPress={() => router.push(`/order/${id}/docs`)}
                style={({ pressed }) => [{ backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' }, pressed && { opacity: 0.85 }]}>
                <Row first left={<View style={st.tile}><Icon name="doc" /></View>} label="Документы" sub="заявка поставщику, лист для цеха, монтаж" chevron />
              </Pressable>
            ) : null}
          </>
        )}
      </Body>

      {!empty ? (
        <Dock>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {agreed ? (
              <>
                <Button kind="secondary" title="Изменить" onPress={() => setMoreOpen(true)} style={{ flex: 1 }} />
                <Button title="Документы" onPress={() => router.push(`/order/${id}/docs`)} style={{ flex: 1 }} />
              </>
            ) : (
              <>
                <Button kind="secondary" title="Расчёт" onPress={() => router.push(`/order/${id}/calc`)} style={{ paddingHorizontal: 22 }} />
                <Button title="Отправить КП" onPress={() => router.push(`/order/${id}/quote`)} disabled={!f.can_quote} style={{ flex: 1 }} />
              </>
            )}
          </View>
        </Dock>
      ) : null}

      {extraEdit !== undefined ? (
        <ExtraSheet orderId={id} extra={extraEdit} visible onClose={() => setExtraEdit(undefined)}
          onSaved={() => { void reload(); }} />
      ) : null}
      <ClientSheet visible={clientOpen} onClose={() => setClientOpen(false)} f={f} orderId={id}
        onSaved={(nf) => setData((d) => (d && d.kind === 'server' ? { ...d, full: nf } : d))} reload={reload} />
      <Sheet visible={moreOpen} onClose={() => setMoreOpen(false)} title={clientName}>
        <Card style={{ marginBottom: 8 }}>
          <Row first label="Клиент и адрес" onPress={() => { setMoreOpen(false); setClientOpen(true); }} />
          <Row label="Комплектация" value={f.kit_name ?? ''} onPress={() => { setMoreOpen(false); router.push(`/order/${id}/kit`); }} />
          <Row label="Расчёт" onPress={() => { setMoreOpen(false); router.push(`/order/${id}/calc`); }} />
          <Row label="КП" sub={lastQuote ? `версия ${lastQuote.version} · ${date(lastQuote.sent_at)}` : undefined} onPress={() => { setMoreOpen(false); router.push(`/order/${id}/quote`); }} />
          <Row label="Документы" onPress={() => { setMoreOpen(false); router.push(`/order/${id}/docs`); }} />
        </Card>
      </Sheet>
    </Screen>
  );
}

// ---------- шапка ----------
function TopBarRow({ onBack, phone, onMore }: { onBack: () => void; phone?: string | null; onMore?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, minHeight: 56 }}>
      <IconButton name="back" label="Назад" onPress={onBack} />
      <View style={{ flex: 1 }} />
      {phone ? <IconButton name="phone" label="Позвонить" onPress={() => { void Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`); }} /> : null}
      {onMore ? <IconButton name="more" label="Ещё" onPress={onMore} /> : null}
    </View>
  );
}

function Head({ title, sub, status, extra, onPress }: { title: string; sub?: string; status: string; extra?: ReactNode; onPress?: () => void }) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityHint={onPress ? 'Изменить клиента' : undefined}>
      <Txt size={22} w={700} lines={1} style={{ paddingHorizontal: 20, paddingBottom: 2, lineHeight: 28, letterSpacing: -0.4 }}>{title}</Txt>
      {sub ? <Txt size={14} color={C.muted} lines={1} style={{ paddingHorizontal: 20, paddingBottom: 6 }}>{sub}</Txt> : null}
      <View style={{ paddingHorizontal: 20, paddingBottom: 4, flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <StatusPill code={status} title={STATUS_TITLE[status] ?? status} />
        {extra}
      </View>
    </Pressable>
  );
}

// ---------- пустой заказ (OrderNew) ----------
function EmptyWays({ onMeasure, onTemplate, onExtra, extraDisabled }: { onMeasure: () => void; onTemplate: () => void; onExtra?: () => void; extraDisabled?: boolean }) {
  return (
    <View style={{ gap: 10 }}>
      <Txt size={14} color={C.muted} style={{ paddingHorizontal: 8, paddingTop: 8 }}>Добавьте первое изделие</Txt>
      <OptCard accent icon="ruler" title="Замерить" text="мастер: проём, размеры, деление" onPress={onMeasure} />
      <OptCard icon="grid" title="Из шаблона" text="шаблон + габарит = изделие" onPress={onTemplate} />
      <OptCard icon="tag" title="Сопутствующий товар" text={extraDisabled ? 'добавим, когда появится интернет' : 'сетка, жалюзи — строкой с ценой'}
        onPress={onExtra} disabled={extraDisabled || !onExtra} />
    </View>
  );
}

// ---------- строки ----------
function RowBox({ first, onPress, left, children }: { first: boolean; onPress?: () => void; left: ReactNode; children: ReactNode }) {
  const inner = (
    <>
      {!first ? <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, backgroundColor: C.line }} /> : null}
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </>
  );
  const style = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 14, minHeight: 60, paddingHorizontal: 20, paddingVertical: 10 };
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [style, pressed && { backgroundColor: '#F7F7F5' }]}>{inner}</Pressable>
  ) : <View style={style}>{inner}</View>;
}

function PosRow({ p, first, dirty, agreed, onPress }: { p: PositionOut; first: boolean; dirty: boolean; agreed: boolean; onPress: () => void }) {
  const errors = p.violations.filter((v) => (v.severity === 'block' || v.severity === 'lock') && !v.accepted);
  const accepted = p.violations.filter((v) => v.severity === 'warn' && v.accepted);
  const firstErr = errors[0];
  const extra = p.qty > 1 ? `× ${p.qty}` : p.label;
  const sub = [dims(p.doc.frame?.w, p.doc.frame?.h), firstErr ? (firstErr.title || firstErr.msg) : extra].filter(Boolean).join(' · ');
  return (
    <RowBox first={first} onPress={onPress} left={<PosTile doc={p.doc} />}>
      <View style={st.rowTop}>
        <Txt w={600} lines={1} style={{ flex: 1 }}>{p.room || 'Изделие'}</Txt>
        <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{p.total !== null && p.can_quote ? money(p.total) : '—'}</Txt>
      </View>
      <Txt size={14} color={C.muted} lines={2} style={{ fontVariant: ['tabular-nums'] }}>{sub}</Txt>
      {p.qty > 1 && !firstErr ? <Txt size={13} color={C.muted} lines={1}>{p.label}</Txt> : null}
      {errors.length || p.warns || (agreed && accepted.length) || p.demo || !p.complete || dirty ? (
        <View style={st.pills}>
          {errors.length ? <Pill color="red" title={`${errors.length} ${errors.length === 1 ? 'ошибка' : errors.length < 5 ? 'ошибки' : 'ошибок'}`} /> : null}
          {p.warns ? <Pill color="amber" title={errors.length ? String(p.warns) : `${p.warns} предупр.`} /> : null}
          {!p.warns && accepted.length && accepted[0].accepted_by_name ? <Pill color="gray" title={`принято: ${accepted[0].accepted_by_name}`} /> : null}
          {!p.complete && !errors.length ? <Pill color="red" title="нет цены" /> : null}
          {p.demo ? <Tag title="ДЕМО" /> : null}
          {dirty ? <NotSent /> : null}
        </View>
      ) : null}
    </RowBox>
  );
}

function LocalPosRow({ p, first, onPress }: { p: LocalPosition; first: boolean; onPress: () => void }) {
  return (
    <RowBox first={first} onPress={onPress} left={<PosTile doc={p.doc} />}>
      <View style={st.rowTop}>
        <Txt w={600} lines={1} style={{ flex: 1 }}>{p.doc.room || 'Изделие'}</Txt>
      </View>
      <Txt size={14} color={C.muted} lines={1} style={{ fontVariant: ['tabular-nums'] }}>
        {[dims(p.doc.frame?.w, p.doc.frame?.h), (p.doc.qty ?? 1) > 1 ? `× ${p.doc.qty}` : null].filter(Boolean).join(' · ')}
      </Txt>
      <View style={st.pills}>
        {p.step !== undefined ? <Pill color="gray" title={`замер: шаг ${p.step} из 6`} /> : <Txt size={13} color={C.muted}>посчитаем при сети</Txt>}
        <NotSent />
      </View>
    </RowBox>
  );
}

function ExtraRow({ e, first, onPress }: { e: Extra; first: boolean; onPress: () => void }) {
  return (
    <RowBox first={first} onPress={onPress} left={<View style={st.tile}><PIcon name="tag" size={22} /></View>}>
      <View style={st.rowTop}>
        <Txt w={500} lines={1} style={{ flex: 1 }}>{e.name}</Txt>
        <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{money(e.total)}</Txt>
      </View>
      <Txt size={14} color={C.muted}>сопутствующий товар · {num(e.qty, 2)} {e.unit}</Txt>
    </RowBox>
  );
}

// ---------- итог ----------
function Totals({ f, blockedIdx, owner }: { f: OrderFull; blockedIdx: number[]; owner: boolean }) {
  const from = f.total_is_from;
  const head = from
    ? `Клиенту · без ${blockedIdx.length === 1 ? 'позиции' : 'позиций'} ${blockedIdx.join(', ')}`
    : ['Клиенту', f.area_m2 ? m2(f.area_m2) : null].filter(Boolean).join(' · ');
  const value = from ? f.total_without_blocked : f.total;
  return (
    <Card style={{ marginHorizontal: 0, paddingHorizontal: 20, paddingVertical: 16, gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt size={14} color={C.muted}>{head}</Txt>
          <Txt size={28} w={700} style={{ lineHeight: 32, letterSpacing: -0.5, fontVariant: ['tabular-nums'] }}>
            {from ? 'от ' : ''}{num(value)} <Txt size={17} w={500} color={C.muted}>сум</Txt>
          </Txt>
        </View>
        {owner && f.margin !== undefined ? (
          <View style={{ alignItems: 'flex-end' }}>
            <Txt size={14} color={C.muted}>маржа</Txt>
            <Txt size={14} w={700}>{money(f.margin)}{f.margin_pct !== null && f.margin_pct !== undefined ? ` · ${String(f.margin_pct).replace('.', ',')}%` : ''}</Txt>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {f.per_m2 ? <Txt size={14} color={C.muted}>{money(f.per_m2)} за м²</Txt> : null}
        {f.discount_pct ? <Txt size={14} color={C.muted}>скидка {String(f.discount_pct).replace('.', ',')}%</Txt> : null}
        {f.extras_total ? <Txt size={14} color={C.muted}>товары {money(f.extras_total)}</Txt> : null}
        {owner && f.cost !== undefined ? <Txt size={14} color={C.muted}>себестоимость {money(f.cost)}</Txt> : null}
        {f.demo ? <Tag title="ДЕМО" /> : null}
      </View>
      {f.demo ? <Txt size={13} color={C.muted}>Часть цен — демо. Уточните прайс цеха перед КП</Txt> : null}
    </Card>
  );
}

// ---------- клиент ----------
function ClientSheet({ visible, onClose, f, orderId, onSaved, reload }: {
  visible: boolean; onClose: () => void; f: OrderFull; orderId: string; onSaved: (f: OrderFull) => void; reload: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [telegram, setTelegram] = useState('');
  const [address, setAddress] = useState('');
  const [floor, setFloor] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setName(f.client?.name ?? ''); setPhone(f.client?.phone ? fmtPhone(f.client.phone) : '+998 ');
    setTelegram(f.client?.telegram ?? ''); setAddress(f.order.address ?? ''); setFloor(f.order.floor ? String(f.order.floor) : '');
    setErr(null);
  }, [visible, f]);
  const save = async () => {
    setBusy(true); setErr(null);
    const d = phone.replace(/\D/g, '');
    const tg = telegram.trim();
    const fl = parseInt(floor, 10);
    try {
      await api.patch(`/oyna/orders/${orderId}`, {
        client: { name: name.trim() || null, phone: d.length > 3 ? `+${d}` : null, telegram: tg ? (tg.startsWith('@') ? tg : `@${tg}`) : null },
        address: address.trim() || undefined, floor: Number.isFinite(fl) ? fl : undefined,
      });
      const nf = await api.get<OrderFull>(`/oyna/orders/${orderId}`).catch(() => null);
      if (nf) onSaved(nf); else void reload();
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <KbSheet visible={visible} onClose={onClose} title="Клиент и адрес">
      <View style={{ paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>
        <Field label="Клиент" value={name} onChangeText={setName} placeholder="Имя" autoCapitalize="words" />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Телефон" value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={{ flex: 1 }} />
          <Field label="Telegram" value={telegram} onChangeText={setTelegram} placeholder="@ник" autoCapitalize="none" autoCorrect={false} style={{ flex: 1 }} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Адрес" value={address} onChangeText={setAddress} style={{ flex: 1 }} />
          <Field label="Этаж" value={floor} onChangeText={(t) => setFloor(t.replace(/\D/g, '').slice(0, 3))} keyboardType="number-pad" style={{ width: 92 }} />
        </View>
        <ErrorText>{err}</ErrorText>
        <Button title="Сохранить" onPress={save} loading={busy} />
      </View>
    </KbSheet>
  );
}
