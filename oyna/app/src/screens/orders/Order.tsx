/**
 * S04 «Заказ» в стиле «Ядро v3» (своего макета нет — собран по X1Orders, X6Calc, X7Quote).
 * Принципы: одно главное действие («Отправить КП · сумма» внизу), цена всегда на виду, размеры нажимаются.
 * Шапка: назад · клиент (нажатие — «Клиент и адрес») и «адрес · статус» · «Ещё».
 * Сверху — карточка «Клиенту · N м²» (владельцу — себестоимость и маржа), одна строка «что мешает КП» с переходом к окну,
 * «Комплектация: … ›» (лист выбора, применяется ко всему заказу). Окна — крупные карточки (схема, размер, цена, одна строка
 * состояния); нажатие — редактор, долгое — копировать / удалить. «Добавить»: Замерить, Шаблон, Как прошлое, Товар.
 * GET /oyna/orders/{id}: клиент, комплектация, позиции со схемой, сопутствующие товары, итоги (владельцу — себестоимость и маржа).
 * Заказ, который пока есть только на телефоне (404 / нет сети), показывается из offline.snapshot().
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError, errorText } from '@/api/http';
import type { Doc, Extra, OrderFull, PositionOut, QuoteBrief, Variant, Violation } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { date, m2, money, num, phone as fmtPhone, STATUS_TITLE } from '@/lib/format';
import { blankCopy, lastOfOrder, pickLast } from '@/lib/measureCopy';
import { useLoad } from '@/lib/useLoad';
import { LocalOrder, LocalPosition, offline, uuid } from '@/offline/store';
import { C, STATUS_BADGE } from '@/theme';
import { Icon } from '@/ui/Icon';
import { Body, Button, Card, ErrorText, Field, IconButton, LoadError, Loading, Row, Screen, Sheet, Txt } from '@/ui/kit';
import { PriceLine } from '@/ui/v3';
import { AddTile, Ban, CompanyOut, dims, ExtraSheet, KbSheet, nItems, OptCard, PIcon, plural, PosTile, st, Tag } from './parts';

type Loaded =
  | { kind: 'server'; full: OrderFull; local: LocalPosition[]; conflicts?: string[] }
  | { kind: 'local'; order: LocalOrder | null; local: LocalPosition[]; offline: boolean };

/** Строка состояния: окно, КП внизу */
type Tone = 'red' | 'amber' | 'blue' | 'green' | 'gray';
type State = { tone: Tone; text: string; cloud?: boolean };
const TONE_FG: Record<Tone, string> = { red: '#A1221A', amber: '#8A4B00', blue: '#154A99', green: '#275C3A', gray: C.muted };
const TONE_DOT: Record<Tone, string> = { red: C.dangerLine, amber: C.amber, blue: C.accent, green: C.ok, gray: C.gray };

/** Долгое нажатие на окно: что копировать / удалять */
type PosAct = { id: string; title: string; doc: Doc; server?: PositionOut; local?: LocalPosition; draft?: boolean };

/** Комплектации цеха для листа «Комплектация» — один раз за запуск. */
let kitsCache: string[] | null = null;

const tnum = { fontVariant: ['tabular-nums' as const] };
const dd = (iso?: string | null) => date(iso).slice(0, 5);
const isBlock = (v: Violation) => (v.severity === 'block' || v.severity === 'lock') && !v.accepted;

export default function Order() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isOwner, user } = useAuth();
  const [kits, setKits] = useState<string[]>(kitsCache ?? []);
  const [kitBusy, setKitBusy] = useState<string | null>(null);
  const [kitErr, setKitErr] = useState<string | null>(null);
  const [kitOpen, setKitOpen] = useState(false);
  const [extraEdit, setExtraEdit] = useState<Extra | null | undefined>(undefined); // undefined — лист закрыт, null — новый
  const [clientOpen, setClientOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [act, setAct] = useState<PosAct | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'like' | 'copy' | 'del' | 'sync' | null>(null);

  const { data, setData, error, loading, reload } = useLoad<Loaded>(async () => {
    const snap = await offline.snapshot();
    const local = Object.values(snap.positions).filter((p) => p.order_id === id && !p.deleted);
    const get = () => api.get<OrderFull>(`/oyna/orders/${id}`);
    try {
      return { kind: 'server', full: await get(), local, conflicts: Object.keys(snap.conflicts).filter((k) => snap.conflicts[k].order_id === id) };
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
  const call = (ph: string) => { void Linking.openURL(`tel:${ph.replace(/[^\d+]/g, '')}`); };

  /** «Как прошлое» в заказе: последнее окно ЭТОГО заказа (телефон или сервер; у сервера — то, что правил этот мастер). */
  const likeSource = (d: Loaded): Doc | null => {
    const ph = pickLast(d.local, []);
    const srv = d.kind === 'server' ? lastOfOrder(d.full, user?.id) : null;
    if (!srv) return ph?.doc ?? null;
    if (!ph) return srv;
    const at = d.kind === 'server' ? d.full.positions.find((p) => p.doc === srv)?.updated_at ?? '' : '';
    return ph.at > at ? ph.doc : srv;
  };
  /** Новое окно в этот заказ — копия без размеров проёма → мастер замера с шага 1. */
  const startLike = async () => {
    const src = data ? likeSource(data) : null;
    if (!src) return;
    setBusy('like');
    try {
      const pid = uuid();
      await offline.savePosition(id, blankCopy(src, pid), { id: pid, step: 1, base_rev: null });
      router.push(`/order/${id}/measure?pos=${pid}&step=1`);
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy('sync');
    try { await offline.sync(); } catch { /* останется «не отправлен» */ }
    setBusy(null);
    void reload();
  };

  /** Копия окна целиком (как «Копировать окно» в редакторе): на сервер, без сети — на телефон. */
  const copyPos = async (a: PosAct) => {
    setBusy('copy'); setActErr(null);
    const nid = uuid();
    const doc: Doc = { ...a.doc, id: nid };
    try {
      if (data?.kind === 'server') {
        try {
          await api.put(`/oyna/orders/${id}/positions/${nid}`, { doc, base_rev: null });
        } catch (e) {
          if (!(e instanceof ApiError && e.isNetwork)) throw e;
          await offline.savePosition(id, doc, { id: nid, base_rev: null });
        }
      } else {
        await offline.savePosition(id, doc, { id: nid, base_rev: null });
      }
      setAct(null);
      await reload();
    } catch (e) {
      setActErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /** Удалить окно: есть запись на телефоне — удаление уходит синхронизацией (иначе она всплывёт «не отправленной»). */
  const doRemove = async (a: PosAct) => {
    setBusy('del'); setActErr(null);
    try {
      if (a.local) {
        await offline.deletePosition(a.id);
        if (a.local.base_rev !== null) void offline.sync().catch(() => null);
      } else if (a.server) {
        try {
          await api.put(`/oyna/orders/${id}/positions/${a.id}`, { doc: a.server.doc, base_rev: a.server.rev, deleted: true });
        } catch (e) {
          if (!(e instanceof ApiError && e.isNetwork)) throw e;
          await offline.savePosition(id, a.server.doc, { id: a.id, base_rev: a.server.rev });
          await offline.deletePosition(a.id);
        }
      }
      setAct(null);
      await reload();
    } catch (e) {
      const conflict = e instanceof ApiError && e.isConflict;
      setActErr(conflict ? 'Окно только что изменили — обновили заказ, посмотрите ещё раз' : errorText(e));
      if (conflict) void reload();
    } finally {
      setBusy(null);
    }
  };
  const removePos = (a: PosAct) => Alert.alert(`Удалить «${a.title}»?`, a.draft ? 'Незаконченный замер пропадёт' : 'Окно уберём из заказа', [
    { text: 'Отмена', style: 'cancel' },
    { text: 'Удалить', style: 'destructive', onPress: () => { void doRemove(a); } },
  ]);

  const actSheet = (
    <Sheet visible={!!act} onClose={() => { setAct(null); setActErr(null); }} title={act?.title}>
      {act ? (
        <View style={{ paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>
          <Card style={{ marginHorizontal: 0 }}>
            <Row first label={act.draft ? 'Продолжить замер' : 'Открыть'} left={<Icon name="window" />}
              onPress={() => { const a = act; setAct(null); openPos(a.id, a.local?.step); }} />
            {!act.draft ? (
              <Row label={busy === 'copy' ? 'Копируем…' : 'Копировать окно'} left={<Icon name="copy" />} chevron={false}
                onPress={busy ? undefined : () => void copyPos(act)} />
            ) : null}
            <Row label={busy === 'del' ? 'Удаляем…' : 'Удалить'} danger left={<Icon name="close" color={C.danger} />} chevron={false}
              onPress={busy ? undefined : () => removePos(act)} />
          </Card>
          <ErrorText>{actErr}</ErrorText>
        </View>
      ) : null}
    </Sheet>
  );

  if (!data && loading) return <Screen><Header onBack={back} title="" /><Loading /></Screen>;
  if (!data) return <Screen><Header onBack={back} title="Заказ" /><LoadError message={error ?? ''} onRetry={reload} /></Screen>;

  const likeOk = !!likeSource(data);
  const addRow = (extraOk: boolean) => (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <AddTile pri icon="ruler" title="Замерить" onPress={measure} disabled={!!busy} />
      <AddTile icon="grid" title="Шаблон" onPress={templates} disabled={!!busy} />
      <AddTile icon="copy" title="Как прошлое" onPress={() => void startLike()} disabled={!likeOk || (!!busy && busy !== 'like')} loading={busy === 'like'} />
      <AddTile icon="tag" title="Товар" onPress={extraOk ? () => setExtraEdit(null) : undefined} disabled={!extraOk || !!busy} />
    </View>
  );

  // ---------- заказ только на телефоне ----------
  if (data.kind === 'local') {
    const o = data.order;
    const units = data.local.reduce((s, p) => s + (p.doc.qty ?? 1), 0);
    const ph = o?.client?.phone;
    return (
      <Screen>
        <Header onBack={back} title={o?.client?.name || 'Без клиента'} sub={[o?.address, o?.floor ? `${o.floor} этаж` : null]}
          status={{ text: 'не отправлен', color: C.muted }} onMore={ph ? () => setMoreOpen(true) : undefined} />
        {data.offline ? <OfflineStrip /> : null}
        <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10 }} refresh={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.accent} />}>
          {!data.offline ? (
            <Ban kind="info" icon="cloud_up" title="Заказ ещё не отправлен" text="Всё сохранено на телефоне"
              action={
                <Pressable accessibilityRole="button" disabled={busy === 'sync'} onPress={() => void syncNow()} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'center' }}>
                  <Txt size={15} w={600} color={C.accentDeep}>{busy === 'sync' ? 'Отправляем…' : 'Отправить'}</Txt>
                </Pressable>
              } />
          ) : null}
          {units ? (
            <View style={s.priceCard}>
              <Txt size={14} color="#5F5C57">Клиенту · {nItems(units)}</Txt>
              <PriceLine value={null} />
              <Txt size={14} color="#5F5C57">посчитаем, когда появится интернет</Txt>
            </View>
          ) : null}
          {data.local.length ? (
            <>
              <Label>Окна</Label>
              {data.local.map((p, i) => (
                <LocalCard key={p.id} p={p} n={i + 1} onPress={() => openPos(p.id, p.step)}
                  onLong={() => setAct({ id: p.id, title: p.doc.room || `Окно ${i + 1}`, doc: p.doc, local: p, draft: p.step !== undefined })} />
              ))}
              <Label>Добавить</Label>
              {addRow(false)}
            </>
          ) : <EmptyWays onMeasure={measure} onTemplate={templates} extraDisabled />}
        </Body>
        {units ? (
          <Foot line={<FootLine tone="gray" text="Цена и КП — когда заказ уйдёт на сервер" cloud />}>
            <Button kind="secondary" title="Расчёт" disabled style={[s.calcBtn, { opacity: 0.45 }]} />
            <Button title="Отправить КП" disabled style={{ flex: 1 }} />
          </Foot>
        ) : null}
        {actSheet}
        {ph ? (
          <Sheet visible={moreOpen} onClose={() => setMoreOpen(false)} title={o?.client?.name || 'Заказ'}>
            <Card style={{ marginBottom: 8 }}>
              <Row first label="Позвонить" sub={fmtPhone(ph)} left={<Icon name="phone" />} onPress={() => { setMoreOpen(false); call(ph); }} />
            </Card>
          </Sheet>
        ) : null}
      </Screen>
    );
  }

  // ---------- заказ с сервера ----------
  const f = data.full;
  const o = f.order;
  const positions = f.positions.filter((p) => !p.deleted);
  const serverIds = new Set(positions.map((p) => p.id));
  const localById = new Map(data.local.map((p) => [p.id, p]));
  const dirty = new Set(data.local.filter((p) => p.dirty).map((p) => p.id));
  const conflicts = new Set(data.conflicts ?? []);
  const localOnly = data.local.filter((p) => !serverIds.has(p.id));
  const empty = !positions.length && !f.extras.length && !localOnly.length;
  const blockedNos = f.blocked_positions.map((pid) => positions.findIndex((p) => p.id === pid) + 1).filter((n) => n > 0);
  const lastQuote: QuoteBrief | undefined = f.quotes.find((q) => !q.revoked) ?? f.quotes[0];
  const agreed = o.status === 'agreed' && !!lastQuote?.accepted_at;
  const clientName = f.client?.name || 'Без клиента';
  const ph = f.client?.phone;
  const units = positions.reduce((s, p) => s + (p.qty || 1), 0) + localOnly.reduce((s, p) => s + (p.doc.qty ?? 1), 0);
  const titleOf = (room: string | null | undefined, n: number) => room || `Окно ${n}`;

  // что мешает отправить КП — одна строка с переходом к первому такому окну
  let block: { text: string; more: number; pos?: string } | null = null;
  if (!empty && !f.can_quote) {
    const pid = f.blocked_positions.find((x) => serverIds.has(x));
    if (pid) {
      const i = positions.findIndex((p) => p.id === pid);
      const p = positions[i];
      const v = p.violations.find(isBlock);
      const why = v ? (v.msg || v.title) : !p.complete ? 'нет цены' : 'есть ошибка';
      block = { text: `КП нельзя: ${titleOf(p.room, i + 1)} — ${why}`, more: Math.max(0, blockedNos.length - 1), pos: pid };
    } else if (!positions.length) {
      block = { text: localOnly.length ? 'КП — когда окна уйдут на сервер' : 'Добавьте окно — без окон КП не отправить', more: 0 };
    }
  }

  // состояние КП внизу (отправлено / устарело / согласовано)
  let quoteLine: State | null = null;
  if (agreed && lastQuote) {
    quoteLine = f.quote_outdated
      ? { tone: 'amber', text: `Согласовано ${dd(lastQuote.accepted_at)} · окна изменены — отправьте новую версию КП` }
      : { tone: 'green', text: `Согласовано ${dd(lastQuote.accepted_at)} · «${lastQuote.accepted_kit ?? ''}» · ${money(lastQuote.accepted_total)}` };
  } else if (lastQuote && !lastQuote.revoked) {
    quoteLine = f.quote_outdated
      ? { tone: 'amber', text: `КП v${lastQuote.version} устарело — изменения уйдут новой версией` }
      : { tone: 'blue', text: `КП v${lastQuote.version} отправлено ${dd(lastQuote.sent_at)}` };
  } else if (f.quote_outdated) {
    quoteLine = { tone: 'amber', text: 'КП устарело — изменения создадут новую версию' };
  }

  const applyKit = async (kit: string) => {
    setKitOpen(false);
    if (kit === f.kit_name) return;
    setKitBusy(kit); setKitErr(null);
    try {
      await api.post(`/oyna/orders/${id}/apply-kit`, { kit_name: kit, base_revs: Object.fromEntries(positions.map((p) => [p.id, p.rev])) });
      await reload();
    } catch (e) {
      setKitErr(e instanceof ApiError && e.isConflict ? 'Окна только что изменили — обновили заказ, выберите ещё раз' : errorText(e));
      if (e instanceof ApiError && e.isConflict) void reload();
    } finally {
      setKitBusy(null);
    }
  };

  const go = (path: string) => () => { setMoreOpen(false); router.push(`/order/${id}/${path}`); };
  const sendTitle = f.total > 0 ? `Отправить КП · ${money(f.total)}` : 'Отправить КП';

  return (
    <Screen>
      <Header onBack={back} title={clientName} sub={[o.address, o.floor ? `${o.floor} этаж` : null]}
        status={{ text: STATUS_TITLE[o.status] ?? o.status, color: (STATUS_BADGE[o.status] ?? STATUS_BADGE.measure).fg }}
        onTitle={() => setClientOpen(true)} onMore={() => setMoreOpen(true)} />
      <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10, paddingBottom: 24 }}
        refresh={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.accent} />}>
        {empty ? (
          <EmptyWays onMeasure={measure} onTemplate={templates} onExtra={() => setExtraEdit(null)} />
        ) : (
          <>
            {/* цена — сверху */}
            <PriceCard f={f} owner={isOwner} blockedNos={blockedNos} />
            {block ? <BlockLine text={block.text} more={block.more} onPress={block.pos ? () => openPos(block!.pos!) : undefined} /> : null}

            {/* комплектация на весь заказ — одной строкой */}
            {positions.length && (kits.length || f.kit_name) ? (
              <View style={{ gap: 4 }}>
                <Pressable accessibilityRole="button" accessibilityHint="Выбрать комплектацию для всего заказа" disabled={!!kitBusy} onPress={() => setKitOpen(true)}
                  style={({ pressed }) => [s.kitRow, pressed && { backgroundColor: '#F7F7F5' }]}>
                  <Txt size={16} color="#5F5C57" lines={1} style={{ flex: 1 }}>
                    Комплектация: <Txt size={16} w={600}>{kitBusy ? `${kitBusy}…` : f.kit_name ?? 'у окон своя'}</Txt>
                  </Txt>
                  <Icon name="chevron" size={20} color="#B4B1AB" />
                </Pressable>
                {kitErr ? <View style={{ paddingHorizontal: 8 }}><ErrorText>{kitErr}</ErrorText></View> : null}
              </View>
            ) : null}

            {/* окна */}
            {positions.length || localOnly.length ? <Label>{`Окна · ${nItems(units)}`}</Label> : null}
            {positions.map((p, i) => {
              const lp = localById.get(p.id);
              const conflict = conflicts.has(p.id);
              const title = titleOf(p.room, i + 1);
              const doc = lp?.dirty ? lp.doc : p.doc;   // правка с телефона ещё не ушла — показываем её
              return (
                <WinCard key={p.id} doc={doc} title={title} qty={p.qty} size={dims(doc.frame?.w, doc.frame?.h)}
                  price={p.total !== null && p.can_quote ? money(p.total) : null}
                  state={posState(p, { dirty: dirty.has(p.id), conflict, agreed })}
                  onPress={() => (conflict ? router.push(`/order/${id}/conflict?pos=${p.id}`) : openPos(p.id))}
                  onLong={conflict ? undefined : () => { setActErr(null); setAct({ id: p.id, title, doc, server: p, local: lp }); }} />
              );
            })}
            {localOnly.map((p, i) => {
              const n = positions.length + i + 1;
              return (
                <LocalCard key={p.id} p={p} n={n} onPress={() => openPos(p.id, p.step)}
                  onLong={() => { setActErr(null); setAct({ id: p.id, title: p.doc.room || `Окно ${n}`, doc: p.doc, local: p, draft: p.step !== undefined }); }} />
              );
            })}

            {/* добавить */}
            <Label>Добавить</Label>
            {addRow(true)}

            {/* сопутствующие товары */}
            {f.extras.length ? (
              <>
                <Label>Товары</Label>
                <Card style={{ marginHorizontal: 0 }}>
                  {f.extras.map((e, i) => <ExtraRow key={e.id} e={e} first={i === 0} onPress={() => setExtraEdit(e)} />)}
                </Card>
              </>
            ) : null}
          </>
        )}
      </Body>

      {!empty ? (
        <Foot line={quoteLine ? <FootLine tone={quoteLine.tone} text={quoteLine.text} onPress={() => router.push(`/order/${id}/quote`)} /> : undefined}>
          <Button kind="secondary" title="Расчёт" onPress={() => router.push(`/order/${id}/calc`)} style={s.calcBtn} />
          {agreed ? (
            <Button title="Документы" onPress={() => router.push(`/order/${id}/docs`)} style={{ flex: 1 }} />
          ) : (
            <Button title={sendTitle} onPress={() => router.push(`/order/${id}/quote`)} disabled={!f.can_quote} style={{ flex: 1 }} />
          )}
        </Foot>
      ) : null}

      {extraEdit !== undefined ? (
        <ExtraSheet orderId={id} extra={extraEdit} visible onClose={() => setExtraEdit(undefined)}
          onSaved={() => { void reload(); }} />
      ) : null}
      <ClientSheet visible={clientOpen} onClose={() => setClientOpen(false)} f={f} orderId={id}
        onSaved={(nf) => setData((d) => (d && d.kind === 'server' ? { ...d, full: nf } : d))} reload={reload} />
      <KitSheet visible={kitOpen} onClose={() => setKitOpen(false)} orderId={id} kits={kits} current={f.kit_name}
        onApply={(k) => void applyKit(k)} onSetup={() => { setKitOpen(false); router.push(`/order/${id}/kit`); }} />
      {actSheet}
      <Sheet visible={moreOpen} onClose={() => setMoreOpen(false)} title={clientName}>
        <Card style={{ marginBottom: 8 }}>
          {ph ? <Row first label="Позвонить" sub={fmtPhone(ph)} left={<Icon name="phone" />} onPress={() => { setMoreOpen(false); call(ph); }} /> : null}
          <Row first={!ph} label="Клиент и адрес" left={<Icon name="person" />} onPress={() => { setMoreOpen(false); setClientOpen(true); }} />
          <Row label="Комплектация" value={f.kit_name ?? ''} left={<Icon name="layers" />} onPress={() => { setMoreOpen(false); setKitOpen(true); }} />
          <Row label="Итог замера" left={<Icon name="doc" />} onPress={go('summary')} />
          <Row label="Расчёт" left={<Icon name="calc" />} onPress={go('calc')} />
          <Row label="КП" left={<Icon name="send" />} sub={lastQuote ? `версия ${lastQuote.version} · ${date(lastQuote.sent_at)}` : undefined} onPress={go('quote')} />
          <Row label="Документы" left={<Icon name="file" />} onPress={go('docs')} />
        </Card>
      </Sheet>
    </Screen>
  );
}

/** Одна строка состояния окна — самое важное по порядку. */
function posState(p: PositionOut, o: { dirty: boolean; conflict: boolean; agreed: boolean }): State | null {
  if (o.conflict) return { tone: 'red', text: 'две версии — выбрать' };
  const errors = p.violations.filter(isBlock);
  if (errors.length) {
    const e = errors[0];
    return { tone: 'red', text: `${e.title || e.msg || 'ошибка'}${errors.length > 1 ? ` · ещё ${errors.length - 1}` : ''}` };
  }
  if (!p.complete) return { tone: 'red', text: 'нет цены' };
  if (!p.can_quote) return { tone: 'red', text: 'есть ошибка' };
  if (o.dirty) return { tone: 'gray', text: 'не отправлено', cloud: true };
  if (p.warns) return { tone: 'amber', text: `${p.warns} ${plural(p.warns, ['предупреждение', 'предупреждения', 'предупреждений'])}` };
  if (p.demo) return { tone: 'amber', text: 'ДЕМО-цена' };
  if (o.agreed) {
    const a = p.violations.find((v) => v.severity === 'warn' && v.accepted && v.accepted_by_name);
    if (a) return { tone: 'gray', text: `принято: ${a.accepted_by_name}` };
  }
  return null;
}

// ---------- шапка ----------
function Header({ onBack, title, sub = [], status, onTitle, onMore }: {
  onBack: () => void; title: string; sub?: (string | null | undefined)[]; status?: { text: string; color: string }; onTitle?: () => void; onMore?: () => void;
}) {
  const line = sub.filter(Boolean).join(' · ');
  return (
    <View style={s.top}>
      <IconButton name="back" label="Назад" onPress={onBack} />
      <Pressable disabled={!onTitle} onPress={onTitle} accessibilityRole={onTitle ? 'button' : undefined} accessibilityHint={onTitle ? 'Клиент и адрес' : undefined}
        style={({ pressed }) => ({ flex: 1, minWidth: 0, opacity: pressed ? 0.6 : 1 })}>
        <Txt size={18} w={600} lines={1} style={{ lineHeight: 24 }}>{title}</Txt>
        {line || status ? (
          <Txt size={14} color="#5F5C57" lines={1}>
            {line}{line && status ? ' · ' : ''}{status ? <Txt size={14} w={600} color={status.color}>{status.text}</Txt> : null}
          </Txt>
        ) : null}
      </Pressable>
      {onMore ? <IconButton name="more" label="Ещё" onPress={onMore} /> : null}
    </View>
  );
}

function OfflineStrip() {
  return (
    <View style={s.offline}>
      <PIcon name="wifi_off" size={18} color="#fff" />
      <Txt size={13} w={500} color="#fff" style={{ flex: 1 }}>Нет интернета — всё сохраняется на телефоне</Txt>
    </View>
  );
}

function Label({ children }: { children: string }) {
  return <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 8, paddingTop: 6 }}>{children}</Txt>;
}

// ---------- цена ----------
function PriceCard({ f, owner, blockedNos }: { f: OrderFull; owner: boolean; blockedNos: number[] }) {
  const from = f.total_is_from;
  const value = from ? f.total_without_blocked : f.total;
  const notes = [
    from && blockedNos.length ? `без ${blockedNos.length === 1 ? 'окна' : 'окон'} ${blockedNos.join(', ')}` : null,
    f.per_m2 ? `${money(f.per_m2)} за м²` : null,
    f.discount_pct ? `скидка ${num(f.discount_pct, 1)}%` : null,
    f.extras_total ? `товары ${money(f.extras_total)}` : null,
  ].filter(Boolean).join(' · ');
  const showOwner = owner && (f.cost !== undefined || f.margin !== undefined);
  return (
    <View style={s.priceCard}>
      <Txt size={14} color="#5F5C57">{['Клиенту', f.area_m2 ? m2(f.area_m2) : null].filter(Boolean).join(' · ')}</Txt>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <PriceLine value={value > 0 ? `${from ? 'от ' : ''}${num(value)}` : null} />
        {f.demo ? <Tag title="ДЕМО" /> : null}
      </View>
      {notes ? <Txt size={14} color="#5F5C57" lines={2}>{notes}</Txt> : null}
      {showOwner ? (
        <View style={s.ownerRow}>
          {f.cost !== undefined ? (
            <View style={{ flex: 1 }}>
              <Txt size={14} color="#5F5C57">Себестоимость</Txt>
              <Txt w={700} style={tnum}>{money(f.cost)}</Txt>
            </View>
          ) : null}
          {f.margin !== undefined ? (
            <View style={{ flex: 1 }}>
              <Txt size={14} color="#5F5C57">Маржа</Txt>
              <Txt w={700} style={tnum}>{money(f.margin)}{f.margin_pct !== null && f.margin_pct !== undefined ? ` · ${num(f.margin_pct, 1)}%` : ''}</Txt>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Что мешает отправить КП — одна строка вместо баннера, нажатие — к окну. */
function BlockLine({ text, more, onPress }: { text: string; more: number; onPress?: () => void }) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${text}${more ? `, и ещё ${more}` : ''}`}
      style={({ pressed }) => [s.block, pressed && { opacity: 0.85 }]}>
      <Icon name="warn" size={18} color={C.errFg} />
      <Txt size={15} w={500} color={C.errFg} lines={1} style={{ flex: 1 }}>{text}</Txt>
      {more ? <Txt size={14} w={600} color={C.errFg}>+{more}</Txt> : null}
      {onPress ? <Icon name="chevron" size={18} color={C.errFg} /> : null}
    </Pressable>
  );
}

// ---------- окна ----------
function StateLine({ s: x }: { s: State }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
      {x.cloud ? <PIcon name="cloud_up" size={16} color={TONE_FG[x.tone]} stroke={2} /> : <View style={[s.dot, { backgroundColor: TONE_DOT[x.tone] }]} />}
      <Txt size={14} w={500} color={TONE_FG[x.tone]} lines={1} style={{ flex: 1 }}>{x.text}</Txt>
    </View>
  );
}

function WinCard({ doc, title, qty, size, price, state, onPress, onLong }: {
  doc?: Doc | null; title: string; qty: number; size: string; price: string | null; state: State | null; onPress: () => void; onLong?: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} onLongPress={onLong} delayLongPress={350}
      accessibilityLabel={[title, qty > 1 ? `${qty} шт` : null, size, price ? `${price} сум` : 'без цены', state?.text].filter(Boolean).join(', ')}
      accessibilityHint={onLong ? 'Долгое нажатие — копировать или удалить' : undefined}
      style={({ pressed }) => [s.win, { transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
      <PosTile doc={doc} size={88} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={st.rowTop}>
          <Txt size={17} w={600} lines={1} style={{ flex: 1, lineHeight: 22 }}>
            {title}{qty > 1 ? <Txt size={17} w={500} color={C.muted}>{` × ${qty}`}</Txt> : null}
          </Txt>
          <Txt size={17} w={600} color={price ? C.ink : C.heroMuted} style={[tnum, { lineHeight: 22 }]}>{price ?? '—'}</Txt>
        </View>
        <Txt size={15} lines={1} style={[tnum, { marginTop: 2 }]}>{size}</Txt>
        {state ? <StateLine s={state} /> : null}
      </View>
    </Pressable>
  );
}

function LocalCard({ p, n, onPress, onLong }: { p: LocalPosition; n: number; onPress: () => void; onLong: () => void }) {
  const draft = p.step !== undefined;
  return (
    <WinCard doc={p.doc} title={p.doc.room || `Окно ${n}`} qty={p.doc.qty ?? 1} size={dims(p.doc.frame?.w, p.doc.frame?.h)} price={null}
      state={draft ? { tone: 'gray', text: `замер: шаг ${Math.min(3, p.step ?? 1)} из 3` } : { tone: 'gray', text: 'не отправлено · цена при сети', cloud: true }}
      onPress={onPress} onLong={onLong} />
  );
}

// ---------- пустой заказ (OrderNew) ----------
function EmptyWays({ onMeasure, onTemplate, onExtra, extraDisabled }: { onMeasure: () => void; onTemplate: () => void; onExtra?: () => void; extraDisabled?: boolean }) {
  return (
    <View style={{ gap: 10 }}>
      <Label>Добавьте первое изделие</Label>
      <OptCard accent icon="ruler" title="Замерить" text="мастер: проём, размеры, деление" onPress={onMeasure} />
      <OptCard icon="grid" title="Из шаблона" text="шаблон + габарит = изделие" onPress={onTemplate} />
      <OptCard icon="tag" title="Сопутствующий товар" text={extraDisabled ? 'добавим, когда появится интернет' : 'сетка, жалюзи — строкой с ценой'}
        onPress={onExtra} disabled={extraDisabled || !onExtra} />
    </View>
  );
}

// ---------- сопутствующий товар ----------
function ExtraRow({ e, first, onPress }: { e: Extra; first: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.extra, pressed && { backgroundColor: '#F7F7F5' }]}>
      {!first ? <View style={s.sep} /> : null}
      <View style={st.tile}><PIcon name="tag" size={22} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={st.rowTop}>
          <Txt w={500} lines={1} style={{ flex: 1 }}>{e.name}</Txt>
          <Txt w={600} style={tnum}>{money(e.total)}</Txt>
        </View>
        <Txt size={14} color={C.muted}>{num(e.qty, 2)} {e.unit} × {money(e.price_sum)}</Txt>
      </View>
    </Pressable>
  );
}

// ---------- низ: состояние КП + «Расчёт» и главная кнопка ----------
function Foot({ line, children }: { line?: ReactNode; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.foot, { paddingBottom: Math.max(insets.bottom, 14) + 6 }]}>
      {line}
      <View style={{ flexDirection: 'row', gap: 8 }}>{children}</View>
    </View>
  );
}

function FootLine({ tone, text, onPress, cloud }: { tone: Tone; text: string; onPress?: () => void; cloud?: boolean }) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => [s.footLine, pressed && { opacity: 0.6 }]}>
      {cloud ? <PIcon name="cloud_up" size={16} color={TONE_FG[tone]} stroke={2} /> : <View style={[s.dot, { backgroundColor: TONE_DOT[tone] }]} />}
      <Txt size={14} w={500} color={TONE_FG[tone]} lines={1} style={{ flex: 1 }}>{text}</Txt>
      {onPress ? <Icon name="chevron" size={18} color="#B4B1AB" /> : null}
    </Pressable>
  );
}

// ---------- комплектация ----------
/** Выбор комплектации на весь заказ (POST …/apply-kit); цены вариантов — GET …/variants, пока лист открыт. */
function KitSheet({ visible, onClose, orderId, kits, current, onApply, onSetup }: {
  visible: boolean; onClose: () => void; orderId: string; kits: string[]; current: string | null; onApply: (kit: string) => void; onSetup: () => void;
}) {
  const [vars, setVars] = useState<Variant[] | null>(null);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    api.get<Variant[]>(`/oyna/orders/${orderId}/variants`).then((v) => { if (alive) setVars(v); }).catch(() => { /* покажем без цен */ });
    return () => { alive = false; };
  }, [visible, orderId]);
  const list: { kit: string; total?: number; demo?: boolean; bad?: boolean; on: boolean }[] = vars?.length
    ? vars.map((v) => ({ kit: v.kit, total: v.total, demo: v.demo, bad: !v.can_quote, on: v.current || v.kit === current }))
    : kits.map((k) => ({ kit: k, on: k === current }));
  return (
    <Sheet visible={visible} onClose={onClose} title="Комплектация заказа">
      <View style={{ paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>
        <Txt size={14} color={C.muted} style={{ paddingHorizontal: 8 }}>
          {current ? 'Выбранная применится ко всем окнам заказа' : 'Сейчас у окон своя комплектация. Выбранная применится ко всем окнам'}
        </Txt>
        {list.length ? (
          <Card style={{ marginHorizontal: 0 }}>
            {list.map((k, i) => (
              <Row key={k.kit} first={i === 0} label={k.kit} selected={k.on} chevron={false} onPress={() => onApply(k.kit)}
                value={k.total !== undefined || k.demo || k.bad ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {k.demo ? <Tag title="ДЕМО" /> : null}
                    {k.bad ? <Tag kind="err" title="ошибки" /> : null}
                    {k.total !== undefined ? <Txt size={15} w={600} style={tnum}>{money(k.total)}</Txt> : null}
                  </View>
                ) : undefined}
                right={k.on ? <Icon name="check" size={20} color={C.accent} /> : undefined} />
            ))}
          </Card>
        ) : (
          <Txt size={14} color={C.muted} style={{ paddingHorizontal: 8 }}>Комплектаций нет — добавьте их в настройках цеха</Txt>
        )}
        <Card style={{ marginHorizontal: 0 }}>
          <Row first label="Настроить" sub="система, стекло, фурнитура — по вариантам" left={<Icon name="layers" />} onPress={onSetup} />
        </Card>
      </View>
    </Sheet>
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

const s = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, minHeight: 56 },
  offline: { marginHorizontal: 12, marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.dark },
  priceCard: { backgroundColor: C.card, borderRadius: 28, paddingVertical: 16, paddingHorizontal: 20, gap: 2 },
  ownerRow: { flexDirection: 'row', gap: 12, marginTop: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line },
  block: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: C.errBg },
  kitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 52, borderRadius: 20, paddingHorizontal: 20, backgroundColor: C.card },
  win: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 24, backgroundColor: C.card, padding: 12, paddingRight: 16, minHeight: 112 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  extra: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingHorizontal: 20, paddingVertical: 10 },
  sep: { position: 'absolute', left: 0, right: 0, top: 0, height: 1, backgroundColor: C.line },
  foot: { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  footLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, paddingHorizontal: 4 },
  calcBtn: { paddingHorizontal: 22, backgroundColor: C.soft },
});
