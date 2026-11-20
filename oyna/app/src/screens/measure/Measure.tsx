/**
 * S05 мастер замера по макетам «Ядро v3» (docs/design_v3): X2Measure, X3Size / X3Size3, X4Split — 3 шага.
 * 1 — где и что: помещение, «Что ставим» (Окно / Балкон / Дверь / Глухое), четверть, стена;
 * 2 — размеры: 1 или 3 точки, проверка опечаток (1.2, 1.6, 1.7, «× 10»), «Рама выйдет …»;
 * 3 — деление: готовые варианты, схема с нажимаемыми размерами, открывание, петли, «Добивки» листом, «Готово · цена».
 * Раздвижная, гильотина, лоджия, форма рамы и редкие открывания — «Ещё…» на шаге 3 (в карточки шага 1 не ложатся).
 * Каждый шаг сразу пишется на телефон (offline.savePosition) и работает без сети; цена на «Готово» — с сервера, когда есть сеть.
 * Правки — только командами ядра (apply из src/lib/tree.ts), чтобы документ был таким же, как на сервере.
 * «Готово» → редактор этого окна (X5Editor), оттуда «В заказ».
 * Маршрут: /order/[id]/measure?pos=&step= (1–3).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import type { Calc, Cell, Command, Doc, Measure as MeasureRes, Node, OrderFull, Shape } from '@/api/types';
import { rescaleParts, type DimTarget } from '@/lib/dims';
import { num } from '@/lib/format';
import {
  apply, asmFrames, cells, frameShape, guillotineDoc, isAssembly, layout, loggiaDoc, scaleAssembly, slidingDoc, slidingSpec,
} from '@/lib/tree';
import { offline, uuid } from '@/offline/store';
import { C } from '@/theme';
import { Icon } from '@/ui/Icon';
import { Button, Dock, Field, IconButton, Loading, Screen, Seg, Sheet, Switch, Txt } from '@/ui/kit';
import { BigValue, Caret, OptC, Opt2Grid } from '@/ui/v3';
import { DimSheet } from '../editor/DimSheet';
import { SchemaDims } from '../editor/SchemaDims';
import { ExtrasPanel } from './Extras';
import {
  Ban, checkValue, frameLocal, frameValue, Issue, issueBanner, isOpening, KIND_WORD, Keypad, MiniSchema, PRESETS, presetDoc, Progress, st,
  tryApi, useToast,
} from './parts';

const ROOMS = ['Кухня', 'Зал', 'Спальня', 'Детская', 'Балкон', 'Санузел'];
const STEPS = 3;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
/** черновики прошлой версии мастера (5 шагов) открываются на ближайшем шаге */
const clampStep = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 1 ? Math.min(STEPS, Math.round(n)) : 0; };
const preset = (id: string) => PRESETS.find((p) => p.id === id)!;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function freshDoc(): Doc {
  const d = presetDoc(preset('T03'), 1400, 1300);
  d.extras = { sill: { depth_cm: 30 }, drip: true };
  return d;
}

export default function Measure() {
  const params = useLocalSearchParams<{ id: string; pos?: string; step?: string }>();
  const [gen] = useState(() => uuid());
  const pos = params.pos || gen;
  useEffect(() => { if (!params.pos) router.setParams({ pos: gen }); }, [params.pos, gen]);
  return <Wizard key={pos} orderId={String(params.id)} pos={pos} stepParam={clampStep(params.step)} />;
}

function Wizard({ orderId, pos, stepParam }: { orderId: string; pos: string; stepParam: number }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [step, setStep] = useState(stepParam || 1);
  const [n, setN] = useState(1);
  const [orderFloor, setOrderFloor] = useState<number | undefined>();
  const finished = useRef(false);            // окно уже закончено (или есть на сервере) — правки сразу уходят в синхронизацию
  const baseRev = useRef<number | null | undefined>(undefined);
  const docRef = useRef<Doc | null>(null);
  const [toast, showToast] = useToast();
  const initialStep = useRef(stepParam);
  const leaving = useRef(false);             // «Готово» уже нажали — второй тап не открывает редактор дважды

  // ---------- загрузка: телефон → сервер → новое окно ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      const snap = await offline.snapshot();
      const local = snap.positions[pos];
      const localIds = Object.values(snap.positions).filter((p) => p.order_id === orderId && !p.deleted).map((p) => p.id);
      setOrderFloor(snap.orders[orderId]?.floor ?? undefined);
      let d: Doc | null = null;
      if (local && !local.deleted) {
        d = local.doc;
        finished.current = local.step === undefined;
        if (!initialStep.current) setStep(clampStep(local.step) || 1);
      }
      if (d && alive) { docRef.current = d; setDoc(d); }
      let full: OrderFull | null = null;
      try { full = await tryApi<OrderFull>(`/oyna/orders/${orderId}`); } catch { full = null; }
      if (!alive) return;
      let ids = localIds;
      if (full) {
        const srv = full.positions.filter((p) => !p.deleted).map((p) => p.id);
        ids = [...srv, ...localIds.filter((i) => !srv.includes(i))];
        if (full.order.floor) setOrderFloor((f) => f ?? full!.order.floor ?? undefined);
        const sp = full.positions.find((p) => p.id === pos && !p.deleted);
        if (!d && sp) { d = { ...sp.doc, id: pos }; baseRev.current = sp.rev; finished.current = true; }
      }
      const i = ids.indexOf(pos);
      setN(i >= 0 ? i + 1 : ids.length + 1);
      if (!d) d = { ...freshDoc(), id: pos };
      if (!docRef.current) { docRef.current = d; setDoc(d); }
    })();
    return () => { alive = false; };
  }, [orderId, pos]);

  // ---------- сохранение каждого шага ----------
  const persist = useCallback((next: Doc, s: number) => {
    docRef.current = next;
    setDoc(next);
    const opts: { id: string; step?: number; base_rev?: number | null } = { id: pos, step: finished.current ? undefined : s };
    if (baseRev.current !== undefined) opts.base_rev = baseRev.current;
    return offline.savePosition(orderId, next, opts);
  }, [orderId, pos]);

  const run = useCallback((commands: Command[], s = step) => {
    const cur = docRef.current;
    if (!cur) return;
    try { void persist(apply(cur, commands), s); } catch (e) { showToast(e instanceof Error ? e.message : 'Не получилось'); }
  }, [persist, step, showToast]);

  const goto = useCallback((s: number) => {
    setStep(s);
    router.setParams({ step: String(s) });
    if (docRef.current) void persist(docRef.current, s);
  }, [persist]);

  const close = () => (router.canGoBack() ? router.back() : router.replace(`/order/${orderId}`));

  // «Готово»: окно закончено → редактор (X5Editor). Отправку на сервер делает редактор при открытии.
  const finish = useCallback(async () => {
    if (leaving.current || !docRef.current) return;
    leaving.current = true;
    finished.current = true;
    await persist(docRef.current, STEPS);
    router.replace(`/order/${orderId}/editor?pos=${pos}`);
  }, [persist, orderId, pos]);

  const openEditor = useCallback(async () => {
    if (!docRef.current) return;
    await persist(docRef.current, STEPS);
    router.push(`/order/${orderId}/editor?pos=${pos}`);
  }, [persist, orderId, pos]);

  if (!doc) return <Screen><Loading /></Screen>;

  const kw = KIND_WORD[doc.kind] ?? 'окно';
  const title = n > 1 ? `${cap(kw)} ${n}` : kw === 'окно' ? 'Новое окно' : cap(kw);
  const shown = Math.min(step, STEPS);

  return (
    <Screen>
      <View style={st.hdr}>
        <IconButton name="close" label="Закрыть" onPress={close} />
        <Txt w={600} size={18} lines={1} style={{ flex: 1, minWidth: 0 }}>{title}</Txt>
        <Txt size={14} color="#5F5C57" style={{ paddingRight: 8 }}>{shown} из {STEPS}</Txt>
      </View>
      <Progress step={shown} total={STEPS} onPress={goto} />
      <StepIn step={shown}>
        {shown === 1 ? <PlaceStep doc={doc} run={run} persist={persist} goto={goto} /> : null}
        {shown === 2 ? <SizeStep doc={doc} run={run} persist={persist} goto={goto} showToast={showToast} /> : null}
        {shown === 3 ? (
          <SplitStep doc={doc} run={run} persist={persist} onDone={() => void finish()} onEditor={() => void openEditor()} floorDefault={orderFloor} showToast={showToast} />
        ) : null}
      </StepIn>
      {toast}
    </Screen>
  );
}

type StepProps = {
  doc: Doc; run: (c: Command[], s?: number) => void; persist: (d: Doc, s: number) => Promise<unknown>;
  goto?: (s: number) => void; showToast?: (t: string) => void;
};

// ---------- общее ----------
/** Габарит рамы по уже снятому проёму (или null, если размеров ещё нет). */
function measuredFrame(doc: Doc): { w: number; h: number } | null {
  const o = doc.opening ?? {};
  const arr = (v?: number | number[]) => (Array.isArray(v) ? v : typeof v === 'number' ? [v] : []).filter((x) => x > 0);
  const ws = arr(o.width), hs = arr(o.height);
  if (!ws.length || !hs.length) return null;
  if (isAssembly(doc)) return { w: asmFrames(doc).reduce((a, f) => a + f.w, 0), h: Math.max(...asmFrames(doc).map((f) => f.h)) };
  return { w: doc.frame.w, h: doc.frame.h };
}
/** То же изделие с новой конструкцией: помещение, проём, комплектация и добивки остаются. */
function withStructure(doc: Doc, next: Doc): Doc {
  return { ...next, id: doc.id, room: doc.room, opening: doc.opening, setup: doc.setup, extras: doc.extras ?? {}, qty: doc.qty ?? 1, accepted_warnings: [] };
}
/** Дерево шаблона в чужом габарите: числовые части шаблона (дверь 750, окно 1400), которые не влезли, — пропорционально. */
function fitTree(next: Doc, w0: number, h0: number): Doc {
  if (isAssembly(next) || (next.frame.w === w0 && next.frame.h === h0)) return next;
  const fit = rescaleParts({ ...next, frame: { ...next.frame, w: w0, h: h0 } }, next);
  return fit.length ? apply(next, fit) : next;
}
const isSpecial = (doc: Doc) => isAssembly(doc) || !!doc.frame.root.sliding || !!doc.frame.root.guillotine;

// ---------- шаг 1: где и что (X2Measure) ----------
type Kind1 = 'window' | 'balcony_block' | 'door' | 'fixed';
const fixedDoc = (w = 1000, h = 1000): Doc => ({ kind: 'window', qty: 1, frame: { w, h, shape: 'rect', root: { cell: { type: 'fixed' } } }, extras: {}, accepted_warnings: [] });
const KIND_CARDS: { value: Kind1; title: string; icon: Doc }[] = [
  { value: 'window', title: 'Окно', icon: presetDoc(preset('T03'), 1300, 1200) },
  { value: 'balcony_block', title: 'Балкон', icon: presetDoc(preset('T09'), 1800, 1500) },
  { value: 'door', title: 'Дверь', icon: presetDoc(preset('T11'), 800, 1500) },
  { value: 'fixed', title: 'Глухое', icon: fixedDoc(1100, 1200) },
];
const KIND_PRESET: Record<Kind1, string | null> = { window: 'T03', balcony_block: 'T09', door: 'T11', fixed: null };
function kindOf(doc: Doc): Kind1 | null {
  if (isSpecial(doc)) return null;
  if (doc.kind === 'window') return doc.frame.root.cell?.type === 'fixed' ? 'fixed' : 'window';
  return doc.kind === 'balcony_block' || doc.kind === 'door' ? doc.kind : null;
}
const WALLS = [{ value: 'brick', title: 'Кирпич' }, { value: 'concrete', title: 'Бетон' }, { value: 'aerated', title: 'Газоблок' }];

function PlaceStep({ doc, run, persist, goto }: StepProps) {
  const [own, setOwn] = useState(false);
  const [name, setName] = useState('');
  const custom = doc.room && !ROOMS.includes(doc.room) ? doc.room : null;
  const o = doc.opening ?? {};
  const cur = kindOf(doc);

  const chooseKind = (k: Kind1) => {
    if (k === cur) return;
    const m = measuredFrame(doc);
    const p = KIND_PRESET[k];
    const base = p ? presetDoc(preset(p)) : fixedDoc();
    const kind: Doc['kind'] = k === 'fixed' ? 'window' : k;
    const next = withStructure(doc, { ...base, kind, frame: { ...base.frame, w: m?.w ?? base.frame.w, h: m?.h ?? base.frame.h } });
    void persist(fitTree(next, base.frame.w, base.frame.h), 1);
  };

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 12, gap: 14 }}>
        <View>
          <Txt size={15} w={600} color={C.muted} style={s.lbl}>Помещение</Txt>
          <View style={s.wrap}>
            {[...ROOMS, ...(custom ? [custom] : [])].map((r) => (
              <Chip key={r} title={r} on={doc.room === r} onPress={() => { if (doc.room !== r) run([{ cmd: 'set_meta', room: r }], 1); }} />
            ))}
            <Pressable accessibilityRole="button" accessibilityLabel="Своё помещение" onPress={() => { setName(custom ?? ''); setOwn(true); }}
              style={({ pressed }) => [s.chip, pressed && s.pressed]}>
              <Icon name="plus" size={16} />
            </Pressable>
          </View>
        </View>
        <View>
          <Txt size={15} w={600} color={C.muted} style={s.lbl}>Что ставим</Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {KIND_CARDS.map((k) => (
              <OptC key={k.value} on={cur === k.value} onPress={() => chooseKind(k.value)} label={k.title} style={s.kindOpt}>
                <View style={{ height: 44, justifyContent: 'center' }}><MiniSchema doc={k.icon} width={46} height={44} /></View>
                <Txt size={14} w={600} lines={1}>{k.title}</Txt>
              </OptC>
            ))}
          </View>
          {!cur ? (
            <Txt size={14} color="#5F5C57" style={{ paddingHorizontal: 8, paddingTop: 8 }}>
              {`Сейчас: ${KIND_WORD[doc.kind] ?? 'изделие'} — выбрано на шаге 3 в «Ещё»`}
            </Txt>
          ) : null}
        </View>
        <View style={[st.sheet, { paddingVertical: 6 }]}>
          <View style={s.row}>
            <Txt w={500} style={{ flex: 1 }}>Четверть</Txt>
            <Switch value={!!o.quarter_mm} onChange={(v) => run([{ cmd: 'set_meta', opening: { quarter_mm: v ? 50 : 0 } }], 1)} />
          </View>
          <View style={[s.row, s.rowSep]}>
            <Txt w={500} style={{ flex: 1 }}>Стена</Txt>
            <Seg items={WALLS} value={o.wall ?? ''} onChange={(v) => run([{ cmd: 'set_meta', opening: { wall: v } }], 1)} style={s.wallSeg} />
          </View>
        </View>
      </ScrollView>
      <Dock><Button title="Дальше" onPress={() => goto?.(2)} /></Dock>
      <Sheet visible={own} onClose={() => setOwn(false)} title="Своё помещение">
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          <Field label="Помещение" value={name} onChangeText={setName} autoFocus placeholder="Например, Кабинет" returnKeyType="done"
            onSubmitEditing={() => { if (name.trim()) { setOwn(false); run([{ cmd: 'set_meta', room: name.trim() }], 1); } }} />
          <Button title="Готово" disabled={!name.trim()} onPress={() => { setOwn(false); run([{ cmd: 'set_meta', room: name.trim() }], 1); }} />
        </View>
      </Sheet>
    </>
  );
}

// ---------- шаг 2: размеры (X3Size — 1 точка, X3Size3 — 3 точки) ----------
type Dim = 'w' | 'h';
type Mode = 1 | 3;
/** выбор «1 точка / 3 точки» помнится до перезапуска приложения */
let lastMode: Mode = 1;
const ORDERS: Record<Mode, [Dim, number][]> = {
  1: [['w', 0], ['h', 0]],
  3: [['w', 0], ['w', 1], ['w', 2], ['h', 0], ['h', 1], ['h', 2]],
};
const POINTS: Record<Dim, string> = { w: 'верх / середина / низ', h: 'лево / центр / право' };
const initVals = (v?: number | number[]) => {
  const a = Array.isArray(v) ? v : typeof v === 'number' ? [v] : [];
  return [0, 1, 2].map((i) => (a[i] ? String(a[i]) : ''));
};
const nums = (a: string[], mode: Mode) => (mode === 1 ? a.slice(0, 1) : a).filter(Boolean).map((x) => parseInt(x, 10));
const floor5 = (v: number) => v - (v % 5);

function SizeStep({ doc, persist, goto, showToast }: StepProps) {
  const [vals, setVals] = useState<Record<Dim, string[]>>(() => ({ w: initVals(doc.opening?.width), h: initVals(doc.opening?.height) }));
  const [mode, setModeState] = useState<Mode>(() => {
    const multi = (v?: number | number[]) => Array.isArray(v) && v.length > 1;
    return multi(doc.opening?.width) || multi(doc.opening?.height) ? 3 : lastMode;
  });
  const order = ORDERS[mode];
  const firstEmpty = order.find(([d, i]) => !vals[d][i]) ?? order[order.length - 1];
  const [dim, setDim] = useState<Dim>(firstEmpty[0]);
  const [idx, setIdx] = useState(firstEmpty[1]);
  const [issue, setIssue] = useState<{ dim: Dim; idx: number; value: number; issue: Issue } | null>(null);
  const [frame, setFrame] = useState<MeasureRes | null>(null);
  const [skewSeen, setSkewSeen] = useState(false);
  const busy = useRef(false);
  const valsRef = useRef(vals);
  valsRef.current = vals;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const docRef = useRef(doc);
  docRef.current = doc;

  const refreshFrame = useCallback(async (v: Record<Dim, string[]>, m: Mode) => {
    const ws = nums(v.w, m), hs = nums(v.h, m);
    if (!ws.length || !hs.length) { setFrame(null); return null; }
    const r = await frameValue(ws, hs);
    setFrame(r);
    return r;
  }, []);
  useEffect(() => { void refreshFrame(valsRef.current, modeRef.current); }, [refreshFrame]);

  const setMode = (m: Mode) => {
    if (m === mode) return;
    lastMode = m;
    setModeState(m);
    setIssue(null);
    const e = ORDERS[m].find(([d, i]) => !vals[d][i]) ?? ORDERS[m][0];
    setDim(e[0]); setIdx(e[1]);
    void refreshFrame(vals, m);
  };

  // «Рама выйдет»: с сервера (зазор цеха), пока не всё введено — на телефоне по введённому
  const gap = frame?.gap_mm ?? 20;
  const ws = nums(vals.w, mode), hs = nums(vals.h, mode);
  const fw = frame?.frame_w ?? (ws.length ? floor5(Math.min(...ws) - 2 * gap) : null);
  const fh = frame?.frame_h ?? (hs.length ? floor5(Math.min(...hs) - 2 * gap) : null);

  const cur = vals[dim][idx] ?? '';
  const hint = mode === 3 ? vals[dim].slice(0, idx).filter(Boolean).pop() ?? vals[dim].find(Boolean) ?? '' : '';
  const setCur = (v: string) => setVals((p) => ({ ...p, [dim]: p[dim].map((x, i) => (i === idx ? v : x)) }));
  const focus = (d: Dim, i: number) => { setDim(d); setIdx(i); setIssue(null); };

  const done = async (v: Record<Dim, string[]>) => {
    const m = modeRef.current;
    const ws2 = nums(v.w, m), hs2 = nums(v.h, m);
    const r = (await refreshFrame(v, m)) ?? frameLocal(ws2, hs2);
    if (!r.ok || !r.frame_w || !r.frame_h) { showToast?.('Проверьте размеры'); return; }
    if (r.issues.some((x) => x.code === 'M.skew') && !skewSeen) { setSkewSeen(true); return; }
    const d0 = docRef.current;
    const meta: Command = { cmd: 'set_meta', opening: { width: ws2, height: hs2 } };
    if (isAssembly(d0)) {
      // лоджия: длина — по рамам пропорционально, высота — всем рамам
      await persist(apply(scaleAssembly(d0, r.frame_w, r.frame_h), [meta]), 3);
    } else {
      const sized = apply(d0, [{ cmd: 'set_size', w: r.frame_w, h: r.frame_h }, meta]);
      // числовые части прошлого окна («как прошлое», фрамуга 500) не влезли — растягиваем пропорционально
      const fit = rescaleParts(d0, sized);
      await persist(fit.length ? apply(sized, fit) : sized, 3);
    }
    goto?.(3);
  };

  const commit = async (str: string, manual: boolean) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const v = parseInt(str, 10);
      const iss = await checkValue(v);
      const top = iss.find((x) => x.severity === 'block') ?? iss[0];
      if (top) {
        // «похоже на сантиметры» (1.7) повторным «Дальше» не принимаем: на объекте жмут быстро — 145 вместо 1450
        // уходило в заказ. Только кнопка «× 10» или исправить число.
        const again = manual && top.severity !== 'block' && top.code !== '1.7' && issue && issue.dim === dim && issue.idx === idx && issue.value === v;
        if (!again) { setIssue({ dim, idx, value: v, issue: top }); return; }
      }
      setIssue(null);
      const m = modeRef.current;
      const ord = ORDERS[m];
      const next = { ...valsRef.current, [dim]: valsRef.current[dim].map((x, i) => (i === idx ? String(v) : x)) };
      setVals(next);
      void persist(apply(docRef.current, [{ cmd: 'set_meta', opening: { width: nums(next.w, m), height: nums(next.h, m) } }]), 2);
      void refreshFrame(next, m);
      const at = ord.findIndex(([d, i]) => d === dim && i === idx);
      const after = [...ord.slice(at + 1), ...ord.slice(0, at)];
      const empty = after.find(([d, i]) => !next[d][i]);
      if (empty) { setDim(empty[0]); setIdx(empty[1]); return; }
      if (at === ord.length - 1) { await done(next); return; }
      const [nd, ni] = ord[at + 1];
      setDim(nd); setIdx(ni);
    } finally {
      busy.current = false;
    }
  };

  const onDigit = (d: string) => {
    if (cur.length >= 4 || (!cur && d === '0')) return;
    const v = cur + d;
    setCur(v);
    setIssue(null);
    if (v.length === 4) void commit(v, false);              // автопереход к следующему полю
  };
  const onErase = () => { setCur(cur.slice(0, -1)); setIssue(null); };
  const onNext = () => {
    const v = cur || hint;
    if (!v) {
      // всё уже введено (вернулись на шаг) — «Дальше» просто идёт дальше
      if (order.every(([d, i]) => vals[d][i])) { void done(vals); return; }
      showToast?.('Введите размер в мм');
      return;
    }
    if (!cur) setCur(v);
    void commit(v, true);
  };

  const ban = issue ? issueBanner(issue.issue, issue.value) : null;
  const skews = frame?.issues.filter((x) => x.code === 'M.skew') ?? [];
  const fmt = (v: string) => (v ? num(parseInt(v, 10)) : '');

  const field = (d: Dim) => {
    const on = dim === d;
    const err = on && ban ? (ban.kind === 'err' ? s.fldErr : s.fldEst) : null;
    const label = mode === 1 ? (d === 'w' ? 'Ширина проёма, мм' : 'Высота проёма, мм') : `${d === 'w' ? 'Ширина' : 'Высота'} · ${POINTS[d]}`;
    if (mode === 1) {
      return (
        <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${vals[d][0] || 'пусто'}`} onPress={() => focus(d, 0)}
          style={[s.fld, { minHeight: 76 }, on && s.fldFocus, err]}>
          <Txt size={13} color={C.muted} style={{ lineHeight: 17 }}>{label}</Txt>
          <BigValue text={fmt(vals[d][0])} focus={on} />
        </Pressable>
      );
    }
    return (
      <View style={[s.fld, { paddingVertical: 10 }, on && s.fldFocus, err]}>
        <Txt size={13} color={C.muted} style={{ lineHeight: 17 }}>{label}</Txt>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
          {[0, 1, 2].map((i) => {
            const v = vals[d][i];
            const f = on && idx === i;
            const h = f ? '' : v ? '' : (d === dim ? hint : '');
            return (
              <Pressable key={i} accessibilityRole="button" accessibilityLabel={`${POINTS[d].split(' / ')[i]}: ${v || 'пусто'}`} onPress={() => focus(d, i)}
                style={[s.point, f && { backgroundColor: C.accentSoft }]}>
                <Txt size={20} w={600} color={v ? C.ink : C.heroMuted} style={{ fontVariant: ['tabular-nums'] }}>{v ? fmt(v) : f ? '' : h ? fmt(h) : '—'}</Txt>
                {f ? <Caret height={22} /> : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  };

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 8, gap: 8 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 8 }}>
          <Txt size={22} w={700} style={{ lineHeight: 28, letterSpacing: -0.4 }}>Размеры</Txt>
          <Seg<string> items={[{ value: '1', title: '1 точка' }, { value: '3', title: '3 точки' }]} value={String(mode)}
            onChange={(v) => setMode(v === '3' ? 3 : 1)} style={{ width: 180, marginHorizontal: 0 }} />
        </View>
        {field('w')}
        {field('h')}
        {ban ? (
          <Ban kind={ban.kind} icon="warn" title={ban.title} body={ban.body} action={ban.action} actionSoft
            onAction={() => {
              if (ban.fixValue) { setCur(String(ban.fixValue)); setIssue(null); void commit(String(ban.fixValue), false); }
              else void commit(String(issue!.value), true);
            }} />
        ) : null}
        {!ban ? skews.map((x) => <Ban key={x.field} kind="est" icon="warn" title="Перекос проёма" body={`${x.msg}${x.fix ? ` — ${x.fix}` : ''}`} />) : null}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4 }}>
          <Txt size={14} color="#5F5C57">Рама выйдет</Txt>
          <Txt size={17} w={700} style={{ fontVariant: ['tabular-nums'] }}>{fw ? num(fw) : '—'} × {fh ? num(fh) : '—'}</Txt>
        </View>
      </ScrollView>
      <Keypad onDigit={onDigit} onErase={onErase} onNext={onNext} nextTitle="Дальше" />
    </>
  );
}

// ---------- шаг 3: деление (X4Split) ----------
const VARIANTS: Partial<Record<Doc['kind'], { title: string; id: string }[]>> = {
  window: [{ title: '1', id: 'T01' }, { title: '2', id: 'T03' }, { title: '2 П-О', id: 'T04' }, { title: '3', id: 'T05' }, { title: 'Фрамуга', id: 'T07' }],
  balcony_block: [{ title: 'Дверь слева', id: 'T09' }, { title: 'Дверь справа', id: 'T10' }],
  door: [{ title: 'Дверь', id: 'T11' }],
};
const OPEN_OPTS = [{ value: 'tilt_turn', title: 'П-О' }, { value: 'turn', title: 'Поворотная' }, { value: 'fixed', title: 'Глухая' }, { value: 'more', title: 'Ещё…' }];
const MORE_OPENS = [{ value: 'tilt', title: 'Откидная' }, { value: 'top_hung', title: 'Подвесная' }, { value: 'pivot', title: 'Среднеподвесная' },
  { value: 'psk', title: 'PSK' }, { value: 'hs', title: 'HS' }];
const TYPES = [{ value: 'sash', title: 'Створка' }, { value: 'door_sash', title: 'Дверная' }, { value: 'panel', title: 'Панель' }, { value: 'fixed', title: 'Глухая' }];
const SIDE_HINGE = ['turn', 'tilt_turn'];

/** Быстрый выбор формы рамы (подробно — в редакторе: «Окно» → «Форма рамы»). */
type QuickShape = 'rect' | 'arch' | 'semi' | 'circle' | 'trapezoid' | 'triangle';
const QUICK_SHAPES: { value: QuickShape; title: string }[] = [
  { value: 'rect', title: 'Обычная' }, { value: 'arch', title: 'Арка' }, { value: 'semi', title: 'Полукруг' },
  { value: 'circle', title: 'Круг' }, { value: 'trapezoid', title: 'Трапеция' }, { value: 'triangle', title: 'Треугольник' },
];
function quickShape(doc: Doc): QuickShape {
  const { shape, params } = frameShape(doc.frame);
  if (shape === 'arch' && Math.abs((params.rise ?? 0) - doc.frame.w / 2) < 2 && Math.abs(doc.frame.h - doc.frame.w / 2) < 2) return 'semi';
  return shape === 'bevel' ? 'rect' : shape;
}
function quickShapeCommands(doc: Doc, q: QuickShape): Command[] {
  const { w, h } = doc.frame;
  const sh = (shape: Shape, params?: object): Command => ({ cmd: 'set_shape', shape, ...(params ? { params } : {}) });
  switch (q) {
    case 'rect': return [sh('rect')];
    case 'arch': return [sh('arch', { rise: Math.max(50, Math.round(Math.min(w / 2, h) / 2)) })];
    case 'semi': return [sh('rect'), { cmd: 'set_size', h: Math.floor(w / 2) }, sh('arch', { rise: Math.floor(w / 2) })];
    case 'circle': return [sh('rect'), { cmd: 'set_size', h: w }, sh('circle')];
    case 'trapezoid': return [sh('trapezoid', { h_left: h, h_right: Math.max(300, Math.round(h * 0.7)) })];
    case 'triangle': return [sh('triangle', { apex: Math.round(w / 2) })];
  }
}
/** Конструкция без числовых размеров частей — чтобы вариант оставался выбранным после подгонки под габарит. */
const treeSig = (root: Node) => JSON.stringify(root, (k, v) => (k === 'size' && typeof v === 'number' ? 'n' : v));
/** Выбранная ячейка по умолчанию — первая створка (как на макете), иначе первая ячейка. */
function defaultSel(doc: Doc): string | null {
  if (isSpecial(doc)) return null;
  const list = cells(doc);
  return (list.find((c) => isOpening(c.cell)) ?? list[0])?.path ?? null;
}

function SplitStep({ doc, run, persist, onDone, onEditor, floorDefault, showToast }: StepProps & {
  onDone: () => void; onEditor: () => void; floorDefault?: number;
}) {
  const { width } = useWindowDimensions();
  const sw = Math.min(width - 24 - 40, 300);
  const [sel, setSel] = useState<string | null>(() => defaultSel(doc));
  const [extras, setExtras] = useState(false);
  const [more, setMore] = useState(false);
  const [dim, setDim] = useState<DimTarget | null>(null);
  const [preview, setPreview] = useState<{ doc: Doc; changed: number[] } | null>(null);
  const L = useMemo(() => { try { return layout(doc); } catch { return null; } }, [doc]);
  const selCell: Cell | undefined = sel !== null ? L?.cells.find((c) => c.path === sel)?.cell : undefined;
  const special = isSpecial(doc);
  const sliding = slidingSpec(doc.frame);
  const variants = special ? [] : VARIANTS[doc.kind] ?? [];
  const rootJson = treeSig(doc.frame.root);

  // цена на «Готово» — расчётом на сервере без сохранения; без сети — просто «Готово»
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await tryApi<Calc>('/oyna/positions/calc', { method: 'POST', body: { doc } });
        if (alive) setPrice(r?.price && r.can_quote && r.price.total > 0 ? r.price.total : null);
      } catch { if (alive) setPrice(null); }
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [doc]);

  const applyVariant = (id: string) => {
    const p = preset(id);
    const next = fitTree({ ...doc, frame: { ...doc.frame, root: clone(p.root) } }, p.w, p.h);
    void persist(next, 3);
    setSel(defaultSel(next));
  };
  const tap = (path: string) => {
    if (sliding) {
      // раздвижная: тап — полотно подвижное ⇄ глухое
      const i = Number(path);
      run([{ cmd: 'set_sliding', moving: sliding.moving.map((m, j) => (j === i ? !m : m)) }], 3);
      return;
    }
    setSel(path);
  };
  const setOpen = (v: string) => {
    if (v === 'more') { setMore(true); return; }
    if (!selCell || sel === null) { showToast?.('Выберите створку на схеме'); return; }
    if (v === 'fixed') { run([{ cmd: 'set_cell', path: sel, type: 'fixed' }], 3); return; }
    const type = selCell.type === 'door_sash' || (selCell.type !== 'sash' && doc.kind === 'door') ? 'door_sash' : 'sash';
    const hinge = v === 'tilt' ? 'bottom' : v === 'top_hung' ? 'top' : selCell.hinge === 'right' ? 'right' : 'left';
    run([{ cmd: 'set_cell', path: sel, type, open: v, ...(v === 'pivot' || v === 'psk' || v === 'hs' ? {} : { hinge }), handle: true }], 3);
  };
  const setType = (t: string) => {
    if (sel === null || !selCell) return;
    if (t === 'fixed' || t === 'panel') run([{ cmd: 'set_cell', path: sel, type: t }], 3);
    else run([{ cmd: 'set_cell', path: sel, type: t, open: selCell.open && selCell.type === t ? selCell.open : 'tilt_turn', hinge: selCell.hinge === 'right' ? 'right' : 'left', handle: true }], 3);
  };
  const special2 = (k: 'sliding' | 'guillotine' | 'loggia' | 'window') => {
    const m = measuredFrame(doc) ?? { w: doc.frame.w || 1400, h: doc.frame.h || 1300 };
    const base = k === 'sliding' ? slidingDoc(m.w, m.h, 2)
      : k === 'guillotine' ? guillotineDoc(m.w, m.h, Math.max(1, Math.round(m.w / 1500)))
        : k === 'loggia' ? loggiaDoc(Math.max(2400, m.w), m.h)
          : presetDoc(preset('T03'), m.w, m.h);
    const next = withStructure(doc, base);
    setMore(false);
    void persist(next, 3);
    setSel(defaultSel(next));
  };

  const shownDoc = preview?.doc ?? doc;
  const hingeShown = !!selCell && isOpening(selCell) && SIDE_HINGE.includes(selCell.open ?? 'turn');
  const openOn = (v: string) => (selCell ? (v === 'fixed' ? selCell.type === 'fixed' : isOpening(selCell) && selCell.open === v) : false);
  const note = sliding ? 'Тап — полотно подвижное или глухое' : doc.frame.root.guillotine ? 'Модули, привод и стекло — в редакторе'
    : isAssembly(doc) ? 'Рамы, стыки и вынос — в редакторе' : null;

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 12, gap: 10 }}>
        {variants.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
            {variants.map((v) => {
              const p = preset(v.id);
              return (
                <OptC key={v.id} on={treeSig(p.root) === rootJson} onPress={() => applyVariant(v.id)} label={`Деление ${v.title}`}
                  style={{ minWidth: 62, height: 76, padding: 6, gap: 4 }}>
                  <MiniSchema doc={presetDoc(p)} width={34} height={30} />
                  <Txt size={13} w={600} lines={1}>{v.title}</Txt>
                </OptC>
              );
            })}
          </ScrollView>
        ) : null}
        <View style={[st.sheet, { paddingTop: 22, paddingBottom: 12 + 48, alignItems: 'center', minHeight: 300 }]}>
          <SchemaDims doc={shownDoc} width={sw} maxHeight={224} selected={special ? null : sel} onCellPress={tap}
            onDim={special ? undefined : (t) => { if (t.kind === 'part') setDim(t); }} frameDims={false}
            edit={dim ? { target: dim, changed: preview?.changed ?? [] } : null} />
          {note ? <Txt size={14} color="#5F5C57" center style={{ position: 'absolute', bottom: 18, left: 16, right: 16 }}>{note}</Txt> : null}
        </View>
        {!special ? (
          <>
            <Opt2Grid white items={OPEN_OPTS.map((o) => ({ ...o, on: openOn(o.value) }))} onChange={setOpen} />
            {hingeShown ? (
              <Opt2Grid white value={selCell!.hinge === 'right' ? 'right' : 'left'}
                items={[{ value: 'left', title: 'Петли слева' }, { value: 'right', title: 'справа' }]}
                onChange={(h) => { if (sel !== null && h !== selCell!.hinge) run([{ cmd: 'set_cell', path: sel, hinge: h }], 3); }} />
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <Dock>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable accessibilityRole="button" onPress={() => setExtras(true)} style={({ pressed }) => [s.soft, pressed && s.pressed]}>
            <Txt size={17} w={500}>Добивки</Txt>
          </Pressable>
          <Button title={price ? `Готово · ${num(price)}` : 'Готово'} onPress={onDone} style={{ flex: 1 }} />
        </View>
      </Dock>

      {dim ? (
        <DimSheet key={JSON.stringify(dim)} doc={doc} target={dim} onClose={() => { setDim(null); setPreview(null); }}
          onPreview={(d, changed) => setPreview(d ? { doc: d, changed } : null)}
          onApply={(c) => { setDim(null); setPreview(null); run(c, 3); }} />
      ) : null}

      <Sheet visible={extras} onClose={() => setExtras(false)} title="Добивки и работы">
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 10, paddingBottom: 8 }}>
          <ExtrasPanel doc={doc} run={(c) => run(c, 3)} floorDefault={floorDefault} />
          <Button title="Готово" onPress={() => setExtras(false)} />
        </ScrollView>
      </Sheet>

      <Sheet visible={more} onClose={() => setMore(false)} title="Ещё">
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 10, paddingBottom: 8 }}>
          {!special && selCell ? (
            <>
              <Lbl>Открывание</Lbl>
              <Opt2Grid white items={MORE_OPENS.filter((o) => selCell.type !== 'door_sash' || ['psk', 'hs'].includes(o.value)).map((o) => ({ ...o, on: openOn(o.value) }))}
                onChange={(v) => { setOpen(v); setMore(false); }} />
              <Lbl>Что это</Lbl>
              <Opt2Grid white value={selCell.type} items={TYPES} onChange={(t) => { setType(t); setMore(false); }} />
            </>
          ) : null}
          {!special && doc.kind === 'window' ? (
            <>
              <Lbl>Форма рамы</Lbl>
              <Opt2Grid white value={quickShape(doc)} items={QUICK_SHAPES}
                onChange={(q) => { if (q !== quickShape(doc)) run(quickShapeCommands(doc, q), 3); setMore(false); }} />
            </>
          ) : null}
          <Lbl>Другое изделие</Lbl>
          <Opt2Grid white items={[
            ...(special ? [{ value: 'window', title: 'Обычное окно' }] : []),
            { value: 'sliding', title: 'Раздвижная', on: !!doc.frame.root.sliding },
            { value: 'guillotine', title: 'Гильотина / терраса', on: !!doc.frame.root.guillotine },
            { value: 'loggia', title: 'Лоджия', on: isAssembly(doc) },
          ]} onChange={(k) => special2(k as 'sliding' | 'guillotine' | 'loggia' | 'window')} />
          <Button title="Все настройки — в редакторе" kind="secondary" onPress={() => { setMore(false); onEditor(); }} />
        </ScrollView>
      </Sheet>
    </>
  );
}

const Lbl = ({ children }: { children: ReactNode }) => <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 8, paddingTop: 4 }}>{children}</Txt>;

/** .chip (на сером фоне — белая, выбранная тёмная) */
function Chip({ title, on, onPress }: { title: string; on?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on }} onPress={onPress}
      style={({ pressed }) => [s.chip, on && s.chipOn, pressed && s.pressed]}>
      <Txt size={15} w={500} color={on ? '#fff' : C.ink}>{title}</Txt>
    </Pressable>
  );
}

const s = StyleSheet.create({
  lbl: { paddingHorizontal: 8, paddingBottom: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 40, borderRadius: 20, backgroundColor: C.card, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  chipOn: { backgroundColor: C.dark },
  kindOpt: { flex: 1, height: 104, paddingVertical: 10, paddingHorizontal: 6, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 20, paddingVertical: 6 },
  rowSep: { borderTopWidth: 1, borderTopColor: C.line },
  wallSeg: { width: 210, marginHorizontal: 0, backgroundColor: '#EDECE9' },
  soft: { height: 56, borderRadius: 999, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
  fld: { backgroundColor: C.card, borderRadius: 16, minHeight: 60, paddingVertical: 9, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  fldFocus: { borderColor: C.accent },
  fldErr: { backgroundColor: C.dangerBg, borderColor: C.dangerLine },
  fldEst: { backgroundColor: C.estField, borderColor: C.estLine },
  point: { flex: 1, height: 40, borderRadius: 12, backgroundColor: C.soft, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});

/** Лёгкий въезд шага (260 мс, как .step в макете): вперёд — справа, назад — слева. */
function StepIn({ step, children }: { step: number; children: ReactNode }) {
  const a = useRef(new Animated.Value(1)).current;
  const prev = useRef(step);
  const dir = useRef(1);
  if (prev.current !== step) { dir.current = step > prev.current ? 1 : -1; prev.current = step; a.setValue(0); }
  // 0,65 с после смены шага нажатия не принимаем: «Дальше» на клавиатуре и «Готово» следующего шага стоят
  // в одном месте — быстрый двойной тап проскакивал шаг
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    setLocked(true);
    const t = setTimeout(() => setLocked(false), 650);
    Animated.timing(a, { toValue: 1, duration: 260, easing: Easing.bezier(0.2, 0, 0, 1), useNativeDriver: true }).start();
    return () => clearTimeout(t);
  }, [step, a]);
  const tx = a.interpolate({ inputRange: [0, 1], outputRange: [dir.current * 24, 0] });
  return <Animated.View pointerEvents={locked ? 'none' : 'auto'} style={{ flex: 1, opacity: a, transform: [{ translateX: tx }] }}>{children}</Animated.View>;
}
