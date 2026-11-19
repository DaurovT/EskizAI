/**
 * S05 мастер замера (FR-M1…M10) — макеты M1Room, M2Opening, M3Size, M3SizeErr, M4Split, M5Extras, M6Next.
 * Один вопрос на экран; каждый шаг сразу пишется на телефон (offline.savePosition) и работает без сети.
 * Правки — только командами ядра (apply из src/lib/tree.ts), чтобы документ был таким же, как на сервере.
 * Маршрут: /order/[id]/measure?pos=&step= (step 6 — лист «Следующее окно» поверх шага 5).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ComponentRef, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import type { Cell, Command, Doc, Measure as MeasureRes, Node, OrderFull, Shape } from '@/api/types';
import { num } from '@/lib/format';
import { apply, cells, frameShape, isAssembly, layout, loggiaDoc, scaleAssembly, simpleWindow } from '@/lib/tree';
import { offline, uuid } from '@/offline/store';
import { Icon } from '@/ui/Icon';
import { Schema } from '@/ui/Schema';
import { Button, Dock, Field, Loading, Note, Row, Screen, Seg, Sheet, Switch, Txt } from '@/ui/kit';
import { C } from '@/theme';
import {
  Ban, checkValue, frameLocal, frameValue, Issue, issueBanner, isOpening, KIND_WORD, Keypad, MiniSchema, OptCard,
  PRESETS, presetDoc, presetsFor, Progress, st, Tag, tryApi, useToast, WizardHeader,
} from './parts';

const ROOMS = ['Кухня', 'Зал', 'Спальня', 'Детская', 'Балкон', 'Санузел'];
const STEPS = 5;
const DEFAULT_PRESET: Partial<Record<Doc['kind'], string>> = { window: 'T03', balcony_block: 'T09', door: 'T11' };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const clampStep = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 1 ? Math.min(6, Math.round(n)) : 0; };

function freshDoc(): Doc {
  const d = presetDoc(PRESETS.find((p) => p.id === 'T03')!, 1400, 1300);
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
  const [savedNote, setSavedNote] = useState('сохранено на телефоне');
  const finished = useRef(false);            // окно уже закончено (или есть на сервере) — правки сразу уходят в синхронизацию
  const baseRev = useRef<number | null | undefined>(undefined);
  const docRef = useRef<Doc | null>(null);
  const [toast, showToast] = useToast();
  const initialStep = useRef(stepParam);

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
        if (!initialStep.current) setStep(local.step ?? 1);
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
    void offline.savePosition(orderId, next, opts);
  }, [orderId, pos]);

  const run = useCallback((commands: Command[], s = step) => {
    const cur = docRef.current;
    if (!cur) return;
    try { persist(apply(cur, commands), s); } catch (e) { showToast(e instanceof Error ? e.message : 'Не получилось'); }
  }, [persist, step, showToast]);

  const goto = useCallback((s: number) => {
    setStep(s);
    router.setParams({ step: String(s) });
    if (docRef.current && s <= STEPS) persist(docRef.current, s);
  }, [persist]);

  const close = () => (router.canGoBack() ? router.back() : router.replace(`/order/${orderId}`));

  if (!doc) return <Screen><Loading /></Screen>;

  const room = doc.room?.trim();
  const kw = KIND_WORD[doc.kind] ?? 'окно';
  const title = room ? `${room} · ${kw} ${n}` : `${kw[0].toUpperCase()}${kw.slice(1)} ${n}`;
  const shown = Math.min(step, STEPS);

  const finish = () => {
    finished.current = true;
    persist(docRef.current!, STEPS);
    setStep(6);
    router.setParams({ step: '6' });
    offline.sync().then((r) => { if (r.sent && !r.conflicts) setSavedNote('сохранено и отправлено'); }).catch(() => { /* отправим позже */ });
  };

  const nextWindow = async () => {
    const nid = uuid();
    const nd: Doc = clone(docRef.current!);
    nd.id = nid; nd.qty = 1; nd.accepted_warnings = [];
    delete nd.room;
    if (nd.opening) { delete nd.opening.width; delete nd.opening.height; }
    await offline.savePosition(orderId, nd, { id: nid, step: 1, base_rev: null });
    router.replace(`/order/${orderId}/measure?pos=${nid}&step=1`);
  };

  return (
    <Screen>
      <WizardHeader title={title} onClose={close} doc={shown > 1 ? doc : null} onSchema={() => goto(4)} />
      <Progress step={shown} onPress={goto} />
      <Txt style={[st.cap, { paddingHorizontal: 20, paddingTop: 14 }]}>Шаг {shown} из {STEPS}</Txt>
      <StepIn step={shown}>
      {shown === 1 ? <RoomStep doc={doc} run={run} goto={goto} showToast={showToast} /> : null}
      {shown === 2 ? <OpeningStep doc={doc} run={run} persist={persist} goto={goto} showToast={showToast} /> : null}
      {shown === 3 ? <SizeStep doc={doc} run={run} persist={persist} goto={goto} showToast={showToast} /> : null}
      {shown === 4 ? <SplitStep doc={doc} run={run} persist={persist} goto={goto} orderId={orderId} pos={pos} /> : null}
      {shown === 5 ? <ExtrasStep doc={doc} run={run} onDone={finish} floorDefault={orderFloor} /> : null}
      </StepIn>
      <Sheet visible={step === 6} onClose={() => { setStep(5); router.setParams({ step: '5' }); }}>
        <View style={{ paddingHorizontal: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8 }}>
            <MiniSchema doc={doc} width={52} height={48} />
            <View style={{ flex: 1 }}>
              <Txt w={600} lines={1}>{room || title} · {num(doc.frame.w)} × {num(doc.frame.h)}</Txt>
              <Note>{savedNote}</Note>
            </View>
          </View>
          <Button title="Следующее окно" icon="plus" onPress={() => void nextWindow()} />
          <View style={[s.softRow]}>
            <Txt size={17} w={500} style={{ flex: 1 }}>Такое же × N</Txt>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Pressable accessibilityLabel="Меньше" onPress={() => run([{ cmd: 'set_qty', qty: Math.max(1, (doc.qty ?? 1) - 1) }])} style={st.stpBtn}>
                <Txt size={20} w={600}>−</Txt>
              </Pressable>
              <Txt size={20} w={600} style={{ width: 28, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{String(doc.qty ?? 1)}</Txt>
              <Pressable accessibilityLabel="Больше" onPress={() => run([{ cmd: 'set_qty', qty: Math.min(99, (doc.qty ?? 1) + 1) }])} style={st.stpBtn}>
                <Txt size={20} w={600}>+</Txt>
              </Pressable>
            </View>
          </View>
          <Button title="Закончить замер" kind="secondary" onPress={() => router.replace(`/order/${orderId}/summary`)} />
        </View>
      </Sheet>
      {toast}
    </Screen>
  );
}

type StepProps = {
  doc: Doc; run: (c: Command[], s?: number) => void; goto: (s: number) => void; showToast?: (t: string) => void;
  persist?: (d: Doc, s: number) => void;
};

const H1 = ({ children }: { children: ReactNode }) => <Txt w={700} style={st.h1}>{children}</Txt>;

// ---------- шаг 1: помещение ----------
function RoomStep({ doc, run, goto, showToast }: StepProps) {
  const [own, setOwn] = useState(false);
  const [name, setName] = useState('');
  const custom = doc.room && !ROOMS.includes(doc.room) ? doc.room : null;
  const pick = (r: string) => { run([{ cmd: 'set_meta', room: r }], 2); goto(2); };
  return (
    <>
      <H1>Где окно?</H1>
      <Txt style={[st.cap, { paddingHorizontal: 20, paddingBottom: 8 }]}>Выбор — сразу дальше</Txt>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', padding: 12, paddingTop: 8, gap: 10 }}>
        <View style={s.grid}>
          {[...ROOMS, ...(custom ? [custom] : [])].map((r) => (
            <OptCard key={r} on={doc.room === r} onPress={() => pick(r)} style={s.roomOpt}>
              <Txt size={17} w={600}>{r}</Txt>
            </OptCard>
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable accessibilityRole="button" onPress={() => { setName(custom ?? ''); setOwn(true); }} style={({ pressed }) => [s.soft, pressed && s.pressed]}>
            <Icon name="plus" size={20} /><Txt size={17} w={500}>Своё</Txt>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => showToast?.('Фото проёма — скоро')} style={({ pressed }) => [s.soft, pressed && s.pressed]}>
            <Icon name="camera" size={20} /><Txt size={17} w={500}>Фото проёма</Txt>
          </Pressable>
        </View>
      </ScrollView>
      <Sheet visible={own} onClose={() => setOwn(false)} title="Своё название">
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          <Field label="Помещение" value={name} onChangeText={setName} autoFocus placeholder="Например, Кабинет" returnKeyType="done"
            onSubmitEditing={() => { if (name.trim()) { setOwn(false); pick(name.trim()); } }} />
          <Button title="Готово" disabled={!name.trim()} onPress={() => { setOwn(false); pick(name.trim()); }} />
        </View>
      </Sheet>
    </>
  );
}

// ---------- шаг 2: проём ----------
const KINDS: { kind: Doc['kind'] | 'loggia'; title: string; sub: string }[] = [
  { kind: 'window', title: 'Окно', sub: 'створки и глухие' },
  { kind: 'balcony_block', title: 'Балконный блок', sub: 'дверь + окно' },
  { kind: 'door', title: 'Дверь', sub: 'входная, балконная' },
  { kind: 'loggia', title: 'Лоджия', sub: 'П-образная, 3 рамы' },
];
const KIND_ICON: Record<string, Doc> = {
  window: simpleWindow(1300, 1200, 2),
  balcony_block: presetDoc(PRESETS.find((p) => p.id === 'T09')!, 1800, 1400),
  door: presetDoc(PRESETS.find((p) => p.id === 'T11')!, 700, 1400),
  loggia: loggiaDoc(3000, 1400, 700, 1, 2),   // иконка: боковые глухие, фронт — 2 части
};
const WALLS = [{ value: 'brick', title: 'Кирпич' }, { value: 'concrete', title: 'Бетон' }, { value: 'aerated', title: 'Газоблок' }, { value: 'wood', title: 'Дерево' }];
const SLOPES = [100, 150, 200, 250, 300, 400];
const NEARBY = ['Батарея', 'Кондиционер', 'Решётка', 'Розетка', 'Карниз', 'Труба'];

function OpeningStep({ doc, run, persist, goto, showToast }: StepProps) {
  const [more, setMore] = useState(false);
  const o = doc.opening ?? {};
  const measured = Array.isArray(o.width) ? o.width.length > 0 : typeof o.width === 'number';
  const chooseKind = (k: Doc['kind'] | 'loggia') => {
    if (k === 'loggia') {
      // лоджия — сборка из трёх рам (§9.5); вынос, крыша, обшивка — в редакторе: Ещё → Лоджия
      if (doc.kind === 'assembly') return;
      const base = loggiaDoc(measured ? Math.max(2400, doc.frame.w) : 4200, measured ? doc.frame.h : 1400);
      persist?.({ ...base, id: doc.id, room: doc.room, opening: doc.opening, setup: doc.setup, extras: doc.extras ?? {} }, 2);
      return;
    }
    if (k === doc.kind) return;
    const p = PRESETS.find((x) => x.id === DEFAULT_PRESET[k]);
    let next = apply(doc, [{ cmd: 'set_meta', kind: k }]);
    if (p) next = { ...next, frame: { ...next.frame, w: measured ? next.frame.w : p.w, h: measured ? next.frame.h : p.h, root: clone(p.root) } };
    persist?.(next, 2);
  };
  const nearby = o.nearby ?? [];
  const moreSub = [o.slope_depth_mm ? `откос ${o.slope_depth_mm} мм` : '', nearby.join(', ').toLowerCase()].filter(Boolean).join(' · ');
  return (
    <>
      <H1>Что за проём?</H1>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingTop: 8, gap: 10 }}>
        <View style={s.grid}>
          {KINDS.map((k) => (
            <OptCard key={k.kind} on={k.kind === doc.kind || (k.kind === 'loggia' && doc.kind === 'assembly')} onPress={() => chooseKind(k.kind)} style={s.kindOpt}>
              <View style={{ height: 58, justifyContent: 'center' }}><MiniSchema doc={KIND_ICON[k.kind]} width={72} height={58} /></View>
              <View style={{ gap: 2 }}>
                <Txt size={16} w={600} style={{ lineHeight: 20 }}>{k.title}</Txt>
                <Txt size={13} color={C.muted} style={{ lineHeight: 17 }}>{k.sub}</Txt>
              </View>
            </OptCard>
          ))}
        </View>
        <View style={st.sheet}>
          <Row first label="Четверть" sub="выступ кладки снаружи"
            right={<Switch value={!!o.quarter_mm} onChange={(v) => run([{ cmd: 'set_meta', opening: { quarter_mm: v ? 50 : 0 } }])} />} />
          <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16, gap: 8 }}>
            <Txt w={500}>Стена</Txt>
            <Seg items={WALLS} value={o.wall ?? ''} onChange={(v) => run([{ cmd: 'set_meta', opening: { wall: v } }])} style={s.segIn} />
          </View>
          <Row label="Глубина откоса, что рядом" sub={moreSub || 'не обязательно'} onPress={() => setMore(true)} />
        </View>
      </ScrollView>
      <Dock><Button title="Далее" onPress={() => goto(3)} /></Dock>
      <Sheet visible={more} onClose={() => setMore(false)} title="Проём подробнее">
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, gap: 10, paddingBottom: 8 }}>
          <Txt w={500}>Глубина откоса, мм</Txt>
          <View style={s.wrap}>
            {SLOPES.map((v) => (
              <SheetChip key={v} title={String(v)} on={o.slope_depth_mm === v} white
                onPress={() => run([{ cmd: 'set_meta', opening: { slope_depth_mm: o.slope_depth_mm === v ? 0 : v } }])} />
            ))}
          </View>
          {o.quarter_mm ? (
            <>
              <Txt w={500}>Четверть, мм</Txt>
              <View style={s.wrap}>
                {[30, 50, 65, 80].map((v) => (
                  <SheetChip key={v} title={String(v)} on={o.quarter_mm === v} white onPress={() => run([{ cmd: 'set_meta', opening: { quarter_mm: v } }])} />
                ))}
              </View>
            </>
          ) : null}
          <Txt w={500}>Что рядом</Txt>
          <View style={s.wrap}>
            {NEARBY.map((v) => (
              <SheetChip key={v} title={v} on={nearby.includes(v)} white
                onPress={() => run([{ cmd: 'set_meta', opening: { nearby: nearby.includes(v) ? nearby.filter((x) => x !== v) : [...nearby, v] } }])} />
            ))}
          </View>
          <Button title="Готово" onPress={() => setMore(false)} style={{ marginTop: 6 }} />
        </ScrollView>
      </Sheet>
    </>
  );
}

// ---------- шаг 3: размер (3 точки ширины, 3 точки высоты) ----------
type Dim = 'w' | 'h';
const LABELS: Record<Dim, string[]> = { w: ['Верх', 'Середина', 'Низ'], h: ['Лево', 'Центр', 'Право'] };
const ORDER: [Dim, number][] = [['w', 0], ['w', 1], ['w', 2], ['h', 0], ['h', 1], ['h', 2]];
const initVals = (v?: number | number[]) => {
  const a = Array.isArray(v) ? v : typeof v === 'number' ? [v] : [];
  return [0, 1, 2].map((i) => (a[i] ? String(a[i]) : ''));
};
const nums = (a: string[]) => a.filter(Boolean).map((x) => parseInt(x, 10));

function SizeStep({ doc, run, persist, goto, showToast }: StepProps) {
  const [vals, setVals] = useState<Record<Dim, string[]>>(() => ({ w: initVals(doc.opening?.width), h: initVals(doc.opening?.height) }));
  const firstEmpty = ORDER.find(([d, i]) => !vals[d][i]) ?? ORDER[ORDER.length - 1];
  const [dim, setDim] = useState<Dim>(firstEmpty[0]);
  const [idx, setIdx] = useState(firstEmpty[1]);
  const [issue, setIssue] = useState<{ dim: Dim; idx: number; value: number; issue: Issue } | null>(null);
  const [frame, setFrame] = useState<MeasureRes | null>(null);
  const [skewSeen, setSkewSeen] = useState(false);
  const busy = useRef(false);
  const valsRef = useRef(vals);
  valsRef.current = vals;

  // живой расчёт рамы на телефоне; с сервера — после каждого принятого значения
  const local = useMemo(() => {
    const ws = nums(vals.w), hs = nums(vals.h);
    return ws.length && hs.length ? frameLocal(ws, hs) : null;
  }, [vals]);
  const refreshFrame = useCallback(async (v: Record<Dim, string[]>) => {
    const ws = nums(v.w), hs = nums(v.h);
    if (!ws.length || !hs.length) { setFrame(null); return null; }
    const r = await frameValue(ws, hs);
    setFrame(r);
    return r;
  }, []);
  useEffect(() => { void refreshFrame(valsRef.current); }, [refreshFrame]);
  const fr = frame ?? local;

  const cur = vals[dim][idx];
  const hint = vals[dim].slice(0, idx).filter(Boolean).pop() ?? vals[dim].find(Boolean) ?? '';

  const setCur = (v: string) => setVals((p) => ({ ...p, [dim]: p[dim].map((x, i) => (i === idx ? v : x)) }));
  const focus = (d: Dim, i: number) => { setDim(d); setIdx(i); setIssue(null); };

  const done = async (v: Record<Dim, string[]>) => {
    const ws = nums(v.w), hs = nums(v.h);
    const r = (await refreshFrame(v)) ?? frameLocal(ws, hs);
    if (!r.ok || !r.frame_w || !r.frame_h) { showToast?.('Проверьте размеры'); return; }
    if (r.issues.some((x) => x.code === 'M.skew') && !skewSeen) { setSkewSeen(true); return; }
    if (isAssembly(doc)) {
      // лоджия: длина — по рамам пропорционально, высота — всем рамам
      persist?.(apply(scaleAssembly(doc, r.frame_w, r.frame_h), [{ cmd: 'set_meta', opening: { width: ws, height: hs } }]), 4);
    } else {
      run([{ cmd: 'set_size', w: r.frame_w, h: r.frame_h }, { cmd: 'set_meta', opening: { width: ws, height: hs } }], 4);
    }
    goto(4);
  };

  const commit = async (str: string, manual: boolean) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const v = parseInt(str, 10);
      const iss = await checkValue(v);
      const top = iss.find((x) => x.severity === 'block') ?? iss[0];
      if (top) {
        // «похоже на сантиметры» (1.7) повторным «Далее» не принимаем: на объекте жмут быстро — 145 вместо 1450
        // уходило в заказ. Только кнопка «× 10» или исправить число.
        const again = manual && top.severity !== 'block' && top.code !== '1.7' && issue && issue.dim === dim && issue.idx === idx && issue.value === v;
        if (!again) { setIssue({ dim, idx, value: v, issue: top }); return; }
      }
      setIssue(null);
      const next = { ...valsRef.current, [dim]: valsRef.current[dim].map((x, i) => (i === idx ? String(v) : x)) };
      setVals(next);
      run([{ cmd: 'set_meta', opening: { width: nums(next.w), height: nums(next.h) } }], 3);
      void refreshFrame(next);
      const at = ORDER.findIndex(([d, i]) => d === dim && i === idx);
      const after = [...ORDER.slice(at + 1), ...ORDER.slice(0, at)];
      const empty = after.find(([d, i]) => !next[d][i]);
      if (empty) { setDim(empty[0]); setIdx(empty[1]); return; }
      if (at === ORDER.length - 1) { await done(next); return; }
      const [nd, ni] = ORDER[at + 1];
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
    if (!v) { showToast?.('Введите размер в мм'); return; }
    if (!cur) setCur(v);
    void commit(v, true);
  };

  const ban = issue ? issueBanner(issue.issue, issue.value) : null;
  const skews = fr?.issues.filter((x) => x.code === 'M.skew') ?? [];
  const lineColor = (i: number) => (i === idx ? (ban ? (ban.kind === 'err' ? C.dangerLine : '#F2B705') : C.accent) : C.accentMid);

  return (
    <>
      <H1>{dim === 'w' ? 'Ширина проёма' : 'Высота проёма'}</H1>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingTop: 8, paddingBottom: 8, gap: 8 }}>
        <Seg items={[{ value: 'w', title: 'Ширина · 3 точки' }, { value: 'h', title: 'Высота · 3 точки' }]} value={dim}
          onChange={(d) => { const e = vals[d].findIndex((x) => !x); focus(d, e < 0 ? 0 : e); }} style={{ marginHorizontal: 0 }} />
        <View style={[st.sheet, { paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', gap: 12, alignItems: 'center' }]}>
          <Svg width={96} height={110} accessibilityLabel={dim === 'w' ? 'Три точки замера ширины' : 'Три точки замера высоты'}>
            <Rect x={12} y={6} width={72} height={98} fill="#EDECE9" stroke="#B4B1AB" strokeWidth={1.5} />
            {(dim === 'w' ? [20, 55, 90] : [24, 48, 72]).map((p, i) => (
              <Path key={i} d={dim === 'w' ? `M12 ${p}h72` : `M${p} 6v98`} stroke={lineColor(i)} strokeWidth={i === idx ? 3.5 : 2} />
            ))}
          </Svg>
          <View style={{ flex: 1, gap: 6 }}>
            {LABELS[dim].map((label, i) => {
              const v = vals[dim][i];
              const on = i === idx;
              const err = on && ban;
              return (
                <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label}: ${v || 'пусто'}`} onPress={() => focus(dim, i)}
                  style={[s.fld, on && s.fldFocus, err && (ban!.kind === 'err' ? s.fldErr : s.fldEst)]}>
                  <Txt size={13} color={C.muted} style={{ lineHeight: 17 }}>{label}</Txt>
                  <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 23 }}>
                    <Txt size={17} w={500} color={v ? C.ink : '#9C9993'} style={{ fontVariant: ['tabular-nums'], lineHeight: 23 }}>
                      {v ? num(parseInt(v, 10)) : on ? '' : hint ? num(parseInt(hint, 10)) : '—'}
                    </Txt>
                    {on ? <View style={s.caret} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
        {ban ? (
          <Ban kind={ban.kind} icon="warn" title={ban.title} body={ban.body} action={ban.action} actionSoft
            onAction={() => {
              if (ban.fixValue) { setCur(String(ban.fixValue)); setIssue(null); void commit(String(ban.fixValue), false); }
              else void commit(String(issue!.value), true);
            }} />
        ) : fr && fr.frame_w && fr.frame_h ? (
          <Ban kind="info" icon="check" title={`Рама: ${num(fr.frame_w)} × ${num(fr.frame_h)}`}
            body={`минимум из точек минус зазор 2 × ${fr.gap_mm ?? 20} мм`} />
        ) : null}
        {!ban ? skews.map((x) => <Ban key={x.field} kind="est" icon="warn" title="Перекос проёма" body={`${x.msg}${x.fix ? ` — ${x.fix}` : ''}`} />) : null}
      </ScrollView>
      <Keypad onDigit={onDigit} onErase={onErase} onNext={onNext} />
    </>
  );
}

// ---------- шаг 4: деление ----------
function splitOf(root: Node): { leaves: number; transom: boolean } {
  let r = root, transom = false;
  if (r.split === 'h' && r.parts?.length === 2 && r.parts[0].cell?.open === 'tilt' && typeof r.parts[0].size === 'number') {
    transom = true;
    r = r.parts[1].node ?? { cell: r.parts[1].cell };
  }
  const ok = r.cell || (r.split === 'v' && (r.parts ?? []).every((p) => p.cell));
  return { leaves: ok ? (r.cell ? 1 : r.parts!.length) : 0, transom };
}

/** Тап по ячейке: глухая → поворотно-откидная → поворотная → откидная → глухая. */
function cycle(c: Cell): Partial<Cell> {
  if (c.type === 'panel') return { type: 'fixed' };
  if (c.type === 'door_sash') return { open: c.open === 'turn' ? 'tilt_turn' : 'turn' };
  if (c.type === 'fixed') return { type: 'sash', open: 'tilt_turn', hinge: 'left', handle: true };
  if (c.open === 'tilt_turn') return { open: 'turn', hinge: c.hinge === 'right' ? 'right' : 'left' };
  if (c.open === 'turn') return { open: 'tilt', hinge: 'bottom' };
  return { type: 'fixed' };
}
const OPEN_TITLE: Record<string, string> = {
  fixed: 'глухая', tilt_turn: 'поворотно-откидная', turn: 'поворотная', tilt: 'откидная', panel: 'панель', top_hung: 'подвесная', pivot: 'среднеподвесная',
  sliding: 'раздвижная',
};

/** Быстрый выбор формы рамы на шаге деления (подробно — в редакторе: Ещё → Форма рамы). */
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

function SplitStep({ doc, run, persist, goto, orderId, pos }: StepProps & { orderId: string; pos: string }) {
  const { width } = useWindowDimensions();
  const sw = Math.min(width - 24 - 24, 340);
  const [sel, setSel] = useState<string | null>(null);
  const { leaves, transom } = splitOf(doc.frame.root);
  const L = useMemo(() => { try { return layout(doc); } catch { return null; } }, [doc]);
  const selCell = sel !== null ? L?.cells.find((c) => c.path === sel)?.cell : undefined;

  const setSplit = (nl: number, tr: boolean) => {
    const f = simpleWindow(doc.frame.w, doc.frame.h, nl, tr).frame;
    persist?.({ ...doc, frame: { ...doc.frame, root: f.root } }, 4);
    setSel(null);
  };
  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    persist?.({ ...doc, frame: { ...doc.frame, root: clone(p.root) } }, 4);
    setSel(null);
  };
  const tap = (path: string) => {
    const c = L?.cells.find((x) => x.path === path)?.cell;
    if (!c) return;
    setSel(path);
    run([{ cmd: 'set_cell', path, ...cycle(c) }], 4);
  };
  const flipHinge = (path: string, to?: 'left' | 'right') => {
    const c = L?.cells.find((x) => x.path === path)?.cell;
    if (!c || !isOpening(c) || c.open === 'tilt') return;
    const h = to ?? (c.hinge === 'right' ? 'left' : 'right');
    if (h !== c.hinge) run([{ cmd: 'set_cell', path, hinge: h }], 4);
    setSel(path);
  };

  // свайп по ячейке — сторона петель
  const box = useRef<ComponentRef<typeof View>>(null);
  const origin = useRef({ x: 0, y: 0 });
  const geo = useRef({ pad: 34, k: 1 });
  geo.current = (() => {
    const pad = 34;
    let k = (sw - 2 * pad) / doc.frame.w;
    k = Math.min(k, (300 - 2 * pad) / doc.frame.h);
    return { pad, k };
  })();
  const cellAt = (px: number, py: number) => {
    const { pad, k } = geo.current;
    const x = (px - origin.current.x - pad) / k, y = (py - origin.current.y - pad) / k;
    return L?.cells.find((c) => x >= c.box.x0 && x <= c.box.x1 && y >= c.box.y0 && y <= c.box.y1)?.path ?? null;
  };
  const flipRef = useRef(flipHinge);
  flipRef.current = flipHinge;
  const cellAtRef = useRef(cellAt);
  cellAtRef.current = cellAt;
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { box.current?.measureInWindow((x, y) => { origin.current = { x, y }; }); },
    onPanResponderRelease: (_, g) => {
      if (Math.abs(g.dx) < 30) return;
      const p = cellAtRef.current(g.x0, g.y0);
      if (p !== null) flipRef.current(p, g.dx > 0 ? 'right' : 'left');
    },
  }), []);

  const presets = presetsFor(doc.kind);
  const rootJson = JSON.stringify(doc.frame.root);
  const isWindow = doc.kind === 'window';

  return (
    <>
      <H1>Как делится?</H1>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingTop: 8, paddingBottom: 8, gap: 10 }}>
        {isWindow ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[1, 2, 3, 4].map((v) => (
              <Pressable key={v} accessibilityRole="button" accessibilityState={{ selected: leaves === v }} onPress={() => setSplit(v, transom)}
                style={[s.chip, { width: 48, paddingHorizontal: 0 }, leaves === v && s.chipOn]}>
                <Txt size={15} w={500} color={leaves === v ? '#fff' : C.ink}>{String(v)}</Txt>
              </Pressable>
            ))}
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: transom }} onPress={() => setSplit(leaves || 2, !transom)}
              style={[s.chip, transom && s.chipOn]}>
              <Icon name="plus" size={16} color={transom ? '#fff' : C.ink} />
              <Txt size={15} w={500} color={transom ? '#fff' : C.ink}>Фрамуга</Txt>
            </Pressable>
          </View>
        ) : null}
        {isWindow ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {QUICK_SHAPES.map((q) => {
              const on = quickShape(doc) === q.value;
              return (
                <Pressable key={q.value} accessibilityRole="button" accessibilityState={{ selected: on }}
                  onPress={() => { if (!on) { setSel(null); run(quickShapeCommands(doc, q.value), 4); } }}
                  style={[s.chip, on && s.chipOn]}>
                  <Txt size={15} w={500} color={on ? '#fff' : C.ink}>{q.title}</Txt>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
        <View style={[st.sheet, { paddingTop: 18, paddingBottom: 12, alignItems: 'center', gap: 8 }]}>
          <View ref={box} {...pan.panHandlers} onLayout={() => box.current?.measureInWindow((x, y) => { origin.current = { x, y }; })}>
            <Schema doc={doc} width={sw} maxHeight={300} selected={sel} onCellPress={tap} />
          </View>
          <Txt style={st.cap}>Тап — тип по кругу · свайп — сторона петель</Txt>
          {selCell ? (
            <View style={{ alignSelf: 'stretch', paddingHorizontal: 16, gap: 8, paddingTop: 4 }}>
              <Txt size={14} w={500} color={C.muted} center>
                {selCell.type === 'door_sash' ? 'дверь' : 'створка'}: {OPEN_TITLE[selCell.type === 'sash' || selCell.type === 'door_sash' ? selCell.open ?? 'turn' : selCell.type]}
              </Txt>
              {isOpening(selCell) && selCell.open !== 'tilt' ? (
                <Seg items={[{ value: 'left', title: 'Петли слева' }, { value: 'right', title: 'Петли справа' }]} value={selCell.hinge === 'right' ? 'right' : 'left'}
                  onChange={(v) => flipHinge(sel!, v as 'left' | 'right')} style={s.segIn} />
              ) : null}
            </View>
          ) : null}
        </View>
        {presets.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {presets.map((p) => {
              const on = JSON.stringify(p.root) === rootJson;
              return (
                <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`Шаблон ${p.id}`} onPress={() => applyPreset(p.id)}
                  style={({ pressed }) => [s.tpl, on && { borderWidth: 2, borderColor: C.accent }, pressed && s.pressed]}>
                  <MiniSchema doc={presetDoc(p)} width={34} height={30} />
                  <Txt size={11} w={600} color={C.muted} style={{ lineHeight: 13 }}>{p.id}</Txt>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </ScrollView>
      <Dock>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title="В редактор" kind="secondary" style={{ flex: 1 }}
            onPress={() => { persist?.(doc, 4); router.push(`/order/${orderId}/editor?pos=${pos}`); }} />
          <Button title="Далее" style={{ flex: 1 }} onPress={() => goto(5)} />
        </View>
      </Dock>
    </>
  );
}

// ---------- шаг 5: добивки и работы ----------
const SILL = [15, 25, 30, 40, 60];
const DISMANTLE = [{ value: 'none', title: 'Нет' }, { value: 'wood', title: 'Дерево' }, { value: 'pvc', title: 'ПВХ' }, { value: 'metal', title: 'Металл' }];
const DISMANTLE_OF: Record<string, string> = { wood: 'деревянного', pvc: 'пластикового', metal: 'металлического', alu: 'алюминиевого' };

function ExtrasStep({ doc, run, onDone, floorDefault }: { doc: Doc; run: StepProps['run']; onDone: () => void; floorDefault?: number }) {
  const ex = doc.extras ?? {};
  const set = (a: Record<string, unknown>) => run([{ cmd: 'set_extras', ...a }], 5);
  const openCells = cells(doc).filter((c) => isOpening(c.cell));
  const mosquito = openCells.some((c) => c.cell.mosquito);
  const setMosquito = (v: boolean) => {
    const target = v ? openCells.filter((c) => c.cell.type === 'sash' && c.cell.open !== 'tilt') : openCells;
    const list = target.length ? target : openCells;
    if (list.length) run(list.map((c) => ({ cmd: 'set_cell', path: c.path, mosquito: v })), 5);
  };
  const sill = ex.sill || null;
  const dismantle = ex.dismantle || 'none';
  const floor = ex.floor ?? floorDefault ?? 1;
  return (
    <>
      <H1>Добивки и работы</H1>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingTop: 8, paddingBottom: 8, gap: 10 }}>
        <View style={st.sheet}>
          <Row first label="Подоконник" sub="глубина, см" right={<Switch value={!!sill} onChange={(v) => set({ sill: v ? { depth_cm: 30 } : false })} />} />
          {sill ? (
            <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 20, paddingBottom: 14 }}>
              {SILL.map((v) => (
                <SheetChip key={v} title={String(v)} on={sill.depth_cm === v} flex onPress={() => set({ sill: { depth_cm: v } })} />
              ))}
            </View>
          ) : null}
          <Row label="Отлив" right={<Switch value={!!ex.drip} onChange={(v) => set({ drip: v })} />} />
          <Row label="Откосы" right={<Switch value={!!ex.slopes} onChange={(v) => set({ slopes: v })} />} />
          {openCells.length ? (
            <Row label="Москитка" sub="на открывающуюся створку" right={<Switch value={mosquito} onChange={setMosquito} />} />
          ) : null}
          <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14, gap: 8, borderTopWidth: 1, borderTopColor: C.line }}>
            <Txt w={500}>Демонтаж</Txt>
            <Seg items={DISMANTLE} value={dismantle} onChange={(v) => set({ dismantle: v === 'none' ? false : v })} style={s.segIn} />
          </View>
          <Row label="Этаж" right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Pressable accessibilityLabel="Ниже" onPress={() => set({ floor: Math.max(1, floor - 1) })} style={st.stpBtn}><Txt size={20} w={600}>−</Txt></Pressable>
              <Txt size={17} w={600} style={{ minWidth: 28, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{String(floor)}</Txt>
              <Pressable accessibilityLabel="Выше" onPress={() => set({ floor: Math.min(60, floor + 1) })} style={st.stpBtn}><Txt size={20} w={600}>+</Txt></Pressable>
            </View>
          } />
          <Row label="Работа снаружи" sub="без балкона, с улицы" right={<Switch value={!!ex.outside} onChange={(v) => set({ outside: v })} />} />
        </View>
        {ex.dismantle && !ex.slopes ? (
          <Ban kind="est" icon="warn" title="Откосы не отмечены" body={`После демонтажа ${DISMANTLE_OF[ex.dismantle] ?? 'старого'} окна обычно нужны (9.3)`}
            action="Добавить" onAction={() => set({ slopes: true })} />
        ) : null}
      </ScrollView>
      <Dock><Button title="Готово" onPress={onDone} /></Dock>
    </>
  );
}

/** .chip внутри белого листа (серый) / в листе .bs на сером фоне (белый) */
function SheetChip({ title, on, onPress, flex, white }: { title: string; on?: boolean; onPress: () => void; flex?: boolean; white?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on }} onPress={onPress}
      style={[s.chip, { backgroundColor: on ? C.dark : white ? C.card : C.soft }, flex && { flex: 1, paddingHorizontal: 0 }]}>
      <Txt size={15} w={500} color={on ? '#fff' : C.ink}>{title}</Txt>
    </Pressable>
  );
}

const s = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  roomOpt: { width: '48.8%', minHeight: 64, justifyContent: 'center', flexGrow: 1, flexBasis: '45%' },
  kindOpt: { height: 146, flexBasis: '45%', flexGrow: 1, justifyContent: 'space-between' },
  soft: { flex: 1, height: 56, borderRadius: 999, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18 },
  softRow: { height: 56, borderRadius: 999, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
  segIn: { marginHorizontal: 0, backgroundColor: '#EDECE9' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 40, borderRadius: 20, backgroundColor: C.card, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  chipOn: { backgroundColor: C.dark },
  tpl: { width: 62, height: 62, borderRadius: 16, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', gap: 2 },
  fld: { backgroundColor: C.soft, borderRadius: 16, minHeight: 50, paddingVertical: 5, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  fldFocus: { backgroundColor: C.card, borderColor: C.accent },
  fldErr: { backgroundColor: C.dangerBg, borderColor: C.dangerLine },
  fldEst: { backgroundColor: C.estField, borderColor: C.estLine },
  caret: { width: 2, height: 20, backgroundColor: C.accent, marginLeft: 1 },
});

/** Лёгкий въезд шага (180 мс): вперёд — справа, назад — слева. Видно, что экран сменился, и не тормозит ввод. */
function StepIn({ step, children }: { step: number; children: ReactNode }) {
  const a = useRef(new Animated.Value(1)).current;
  const prev = useRef(step);
  const dir = useRef(1);
  if (prev.current !== step) { dir.current = step > prev.current ? 1 : -1; prev.current = step; a.setValue(0); }
  // 0,65 с после смены шага нажатия не принимаем: «Далее» на клавиатуре и «Далее» следующего шага стоят
  // в одном месте — быстрый двойной тап проскакивал шаг (деление)
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    setLocked(true);
    const t = setTimeout(() => setLocked(false), 650);
    Animated.timing(a, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    return () => clearTimeout(t);
  }, [step, a]);
  const tx = a.interpolate({ inputRange: [0, 1], outputRange: [dir.current * 28, 0] });
  return <Animated.View pointerEvents={locked ? 'none' : 'auto'} style={{ flex: 1, opacity: a, transform: [{ translateX: tx }] }}>{children}</Animated.View>;
}
