/**
 * S06 Редактор позиции — макеты «Ядро v3» (../docs/design_v3): X5Editor, X5Cell, X5Dim, X5Err, X5Many;
 * список нарушений и без сети — EditorIssues, EditorOffline (docs/design).
 * Цена всегда наверху листа; размеры — нажимаемые плашки на схеме (лист DimSheet: ширина части, «Створки поровну»,
 * «Стёкла поровну»); разделы Комплектация · Окно · Добивки; главная кнопка «В заказ». Шапка: назад, помещение, 3D, «Ещё».
 * Каждое изменение — список команд (как в ядре). Онлайн — POST …/positions/{pos}/commands {commands, base_rev}:
 * ответ — позиция с нарушениями и ценой; 409 — лист «две версии». Без сети — те же команды на телефоне
 * (src/lib/tree.ts) + offline.savePosition, цена — «посчитаем, когда появится интернет».
 * Отмена/повтор — история документов на телефоне; откат уходит на сервер целым документом (PUT).
 */
import NetInfo from '@react-native-community/netinfo';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ComponentRef, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError, errorText } from '@/api/http';
import type {
  Addon, Cell, Command, Doc, Frame, Grille, Guillotine, Loggia, Muntins, PositionOut, Shape, ShapeParams, Shutter, Sliding, Violation,
} from '@/api/types';
import { profileHex } from '@/lib/decors';
import { num } from '@/lib/format';
import {
  apply, asmFrames, asmJoints, frameShape, framePrefix, guillotineSpec, indexOf, isAssembly, joinPath, layout, nodeAt, openCaps, partAt,
  slidingSpec, splitPath,
} from '@/lib/tree';
import { offline, uuid } from '@/offline/store';
import { C } from '@/theme';
import { Icon } from '@/ui/Icon';
import {
  Act, Body, Button, Card, Empty, Field, IconButton, LoadError, Loading, Note, Row, Screen, Seg, Sheet, Stepper, Switch, TopBar, Txt,
} from '@/ui/kit';
import { Schema } from '@/ui/Schema';
import { Opt2Grid, PriceLine, Tabs, Tile2Grid, TxtLink } from '@/ui/v3';
import type { DimTarget } from '@/lib/dims';
import { ExtrasPanel } from '../measure/Extras';
import { DimSheet } from './DimSheet';
import { SchemaDims } from './SchemaDims';
import {
  Ban, calcDoc, DragArea, Tiles, cellAt, cellSize, cellTitle, Choice, Decor, DotCanvas, fetchPosition, FittingSet, fittingLabel, fixAction, FixAction, FormSheet,
  GLASS_DECOR_TITLE, glassDecorLabel, glassLabel, GlassPreset, lamLabel, OPEN_TITLE, openConflict, parentPath, Pill, plural, posStore,
  profileColorLabel, refs, SHAPE_TITLE, shortDate, Soft, st, SystemRow, Tag, TextLink, TINT_TITLE, TYPE_TITLE, useToast,
} from './parts';
import { glassDecorCommand } from './Alternatives';
import { Window3D } from '@/ui/Window3D';

type Op = { commands?: Command[]; doc?: Doc };

const isErr = (v: Violation) => v.severity === 'block' || v.severity === 'lock';

export default function Editor() {
  const { id, pos } = useLocalSearchParams<{ id: string; pos?: string }>();
  const posId = typeof pos === 'string' ? pos : '';
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadErr, setLoadErr] = useState('');
  const [doc, setDocState] = useState<Doc | null>(null);
  const docRef = useRef<Doc | null>(null);
  const setDoc = useCallback((d: Doc) => { docRef.current = d; setDocState(d); }, []);
  const [server, setServerState] = useState<PositionOut | null>(null);
  const serverRef = useRef<PositionOut | null>(null);
  const setServer = useCallback((p: PositionOut | null) => { serverRef.current = p; setServerState(p); if (p) posStore.set(id, p); }, [id]);
  const [isOffline, setOffline] = useState(false);
  /** позиция живёт на телефоне (правки без сети или черновик замера): проверки и цена — расчётом без сохранения */
  const [isLocal, setIsLocal] = useState(false);
  const [localCalc, setLocalCalc] = useState<{ violations: Violation[]; total: number | null; demo: boolean } | null>(null);
  const [kitName, setKitName] = useState<string | null>(posStore.kitName(id));
  const [saving, setSaving] = useState(false);

  const eng = useRef({ rev: null as number | null, unsynced: false, pending: 0, halted: false, chain: Promise.resolve() as Promise<void>, loaded: false });
  const hist = useRef<{ past: Doc[]; future: Doc[] }>({ past: [], future: [] });
  const [, setTick] = useState(0);
  const tick = () => setTick((x) => x + 1);

  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'inside' | 'outside'>('inside');
  const [is3d, setIs3d] = useState(false);          // 3D-вид вместо схемы (сторона — view)
  const [open3d, setOpen3d] = useState<'closed' | 'turn' | 'tilt'>('closed');   // 3D: закрыто → повернуть → откинуть
  const [reset3d, setReset3d] = useState(0);        // «к исходному виду»
  const [depth, setDepth] = useState<number | undefined>(undefined);
  const [mode, setMode] = useState<'edit' | 'issues'>('edit');
  const [menu, setMenu] = useState(false);
  const [splitFor, setSplitFor] = useState<string | null>(null);
  /** составное изделие: выбранная рама или стык (табы над схемой) */
  const [asmSel, setAsmSel] = useState<{ kind: 'frame' | 'joint'; index: number } | null>(null);
  /** лист «Форма рамы»: префикс рамы ('' — окно, «A1/» — рама сборки) */
  const [shapeFor, setShapeFor] = useState<string | null>(null);
  const [docSheet, setDocSheet] = useState<'addons' | 'shutter' | 'loggia' | 'tpl' | null>(null);
  const [qtyOpen, setQtyOpen] = useState(false);
  const [winTab, setWinTab] = useState<WinTab>('kit');
  /** нажатая размерная плашка (X5Dim) и схема с новыми размерами, пока вводят */
  const [dimTarget, setDimTarget] = useState<DimTarget | null>(null);
  const [dimPreview, setDimPreview] = useState<{ doc: Doc; changed: number[] } | null>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [presets, setPresets] = useState<GlassPreset[] | null>(null);
  const [toast, showToast] = useToast();

  // ---------------------------------------------------------------- загрузка
  const adopt = useCallback((p: PositionOut, keepHistory = false) => {
    const cur = docRef.current;
    if (keepHistory && cur && JSON.stringify(cur) !== JSON.stringify(p.doc)) { hist.current.past.push(cur); hist.current.future = []; tick(); }
    eng.current.rev = p.rev; eng.current.unsynced = false; eng.current.halted = false;
    setServer(p); setDoc(p.doc); setOffline(false); setIsLocal(false); setLocalCalc(null);
  }, [setDoc, setServer]);

  const conflictRoute = `/order/${id}/conflict?pos=${posId}`;

  const load = useCallback(async () => {
    if (!posId) { setLoadErr('Не выбрана позиция'); setPhase('error'); return; }
    if (!eng.current.loaded) setPhase('loading');
    let snap = await offline.snapshot();
    let local = snap.positions[posId];
    if (local?.dirty) {                               // правки без сети — сначала отправить
      const r = await offline.sync().catch(() => null);
      if (r && !r.offline) { snap = await offline.snapshot(); local = snap.positions[posId]; }
    }
    if (snap.conflicts[posId]) { eng.current.halted = true; router.push(conflictRoute); }
    try {
      const r = await fetchPosition(id, posId);
      setKitName(posStore.kitName(id));
      if (r.pos && !local?.dirty) { adopt(r.pos, eng.current.loaded); eng.current.loaded = true; setPhase('ready'); return; }
      if (local) { takeLocal(local.doc, local.base_rev); return; }
      setLoadErr('Позиция не найдена'); setPhase('error');
    } catch (e) {
      if (local) { takeLocal(local.doc, local.base_rev); return; }
      setLoadErr(errorText(e)); setPhase('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, posId]);

  function takeLocal(d: Doc, baseRev: number | null) {
    eng.current.rev = baseRev; eng.current.unsynced = true; eng.current.loaded = true;
    setServer(null); setDoc(d); setIsLocal(true); setPhase('ready');
    enqueue(() => syncLocal(false));
  }

  // возврат на экран: после листа конфликта — перечитать; после комплектации/замены — взять новую версию из кэша
  useFocusEffect(useCallback(() => {
    const e = eng.current;
    if (!e.loaded || posStore.takeStale(id, posId)) { void load(); return () => flushTimers(); }
    setKitName(posStore.kitName(id));
    const c = posStore.get(id, posId);
    if (c && e.rev !== null && c.rev > e.rev && e.pending === 0 && !e.unsynced) adopt(c, true);
    return () => flushTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, posId, load, adopt]));

  useEffect(() => { refs.glass(doc?.setup?.system).then(setPresets).catch(() => {}); }, [doc?.setup?.system]);
  // глубина профиля для 3D — из паспорта системы
  useEffect(() => {
    refs.systems().then((ss) => setDepth(ss.find((x) => x.code === doc?.setup?.system)?.depth_mm ?? undefined)).catch(() => {});
  }, [doc?.setup?.system]);

  // сеть вернулась — отправить правки, сделанные без неё
  useEffect(() => NetInfo.addEventListener((s) => {
    if (!s.isConnected || s.isInternetReachable === false || !eng.current.unsynced) return;
    setTimeout(() => { if (eng.current.unsynced && eng.current.pending === 0) enqueue(() => syncLocal(false)); }, 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // ---------------------------------------------------------------- отправка
  function enqueue(fn: () => Promise<void>) {
    const e = eng.current;
    e.pending++; setSaving(true);
    e.chain = e.chain.then(fn).catch(() => {}).finally(() => { e.pending--; if (!e.pending) setSaving(false); });
  }

  async function saveLocal() {
    const d = docRef.current;
    if (!d) return;
    const cur = (await offline.snapshot()).positions[posId];
    // черновик мастера замера остаётся черновиком (step), иначе его подхватит синхронизация
    await offline.savePosition(id, d, cur ? { id: posId, step: cur.step } : { id: posId, base_rev: eng.current.rev });
    setIsLocal(true);
  }

  /** Позиция на телефоне → offline.sync → свежая версия с сервера; не ушла — проверки и цена расчётом (без сохранения). */
  async function syncLocal(save = true) {
    const e = eng.current;
    if (save) await saveLocal();
    const cur = (await offline.snapshot()).positions[posId];
    if (!cur || cur.step === undefined) {
      let r: Awaited<ReturnType<typeof offline.sync>> | null = null;
      try { r = await offline.sync(); } catch (err) { showToast(errorText(err)); }
      if (r?.offline) { setOffline(true); setLocalCalc(null); return; }
      if (r) {
        const snap = await offline.snapshot();
        if (snap.conflicts[posId]) { e.halted = true; router.push(conflictRoute); return; }
        if (!snap.positions[posId]?.dirty) {
          try {
            const res = await fetchPosition(id, posId);
            if (res.pos) {
              e.unsynced = false; e.rev = res.pos.rev;
              setServer(res.pos); setOffline(false); setIsLocal(false); setLocalCalc(null);
              if (e.pending <= 1) setDoc(res.pos.doc);
              return;
            }
          } catch { /* сеть пропала снова */ }
        }
      }
    }
    const d = docRef.current;
    if (!d) return;
    try {
      const c = await calcDoc(d);
      setLocalCalc({ violations: c.violations, total: c.price?.total ?? null, demo: !!c.price?.demo });
      setOffline(false);
    } catch (err) {
      if (err instanceof ApiError && err.isNetwork) { setOffline(true); setLocalCalc(null); }
    }
  }

  async function sendOp(op: Op) {
    const e = eng.current;
    if (e.halted) return;
    if (e.unsynced) { await syncLocal(); return; }
    try {
      const out = op.commands
        ? await api.post<PositionOut>(`/oyna/orders/${id}/positions/${posId}/commands`, { commands: op.commands, base_rev: e.rev })
        : await api.put<PositionOut>(`/oyna/orders/${id}/positions/${posId}`, { doc: op.doc, base_rev: e.rev });
      e.rev = out.rev;
      setServer(out); setOffline(false);
      if (e.pending <= 1) setDoc(out.doc);
    } catch (err) {
      if (err instanceof ApiError && err.isNetwork) { e.unsynced = true; setOffline(true); setLocalCalc(null); await saveLocal(); return; }
      if (err instanceof ApiError && err.isConflict) { e.halted = true; openConflict(id, posId, err, docRef.current ?? op.doc!); return; }
      showToast(errorText(err));
      if (e.pending <= 1 && serverRef.current) setDoc(serverRef.current.doc);   // сервер не принял — его версия
    }
  }

  const commit = useCallback((commands: Command[]) => {
    const cur = docRef.current;
    if (!cur) return;
    let next: Doc;
    try { next = apply(cur, commands); } catch (err) { showToast(err instanceof Error ? err.message : 'Не получилось'); return; }
    const h = hist.current;
    h.past.push(cur); if (h.past.length > 60) h.past.shift(); h.future = []; tick();
    setDoc(next);
    enqueue(() => sendOp({ commands }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, posId]);

  /** Поля изделия без своей команды (доп. профили, рольставни, решётка, лоджия — §9.3–9.5): документ целиком (PUT), как откат. */
  const commitDoc = useCallback((patch: Partial<Doc>) => {
    const cur = docRef.current;
    if (!cur) return;
    const next: Doc = { ...cur, ...patch };
    for (const k of Object.keys(patch) as (keyof Doc)[]) {
      const v = next[k];
      if (v === null || (Array.isArray(v) && !v.length)) delete next[k];
    }
    const h = hist.current;
    h.past.push(cur); if (h.past.length > 60) h.past.shift(); h.future = []; tick();
    setDoc(next);
    enqueue(() => sendOp({ doc: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, posId]);

  // ввод с клавиатуры и шаги ± — одна команда через 0,5 с после последнего нажатия
  const timers = useRef<Record<string, { t: ReturnType<typeof setTimeout>; run: () => void }>>({});
  const commitLater = useCallback((k: string, commands: Command[]) => {
    const old = timers.current[k];
    if (old) clearTimeout(old.t);
    const run = () => { delete timers.current[k]; commit(commands); };
    timers.current[k] = { t: setTimeout(run, 500), run };
  }, [commit]);
  function flushTimers() {
    for (const k of Object.keys(timers.current)) { const x = timers.current[k]; clearTimeout(x.t); x.run(); }
  }

  const undo = () => {
    flushTimers();
    const h = hist.current, cur = docRef.current;
    const prev = h.past.pop();
    if (!prev || !cur) return;
    h.future.push(cur); tick(); setDoc(prev); setSelected(null);
    enqueue(() => sendOp({ doc: prev }));
  };
  const redo = () => {
    const h = hist.current, cur = docRef.current;
    const next = h.future.pop();
    if (!next || !cur) return;
    h.past.push(cur); tick(); setDoc(next); setSelected(null);
    enqueue(() => sendOp({ doc: next }));
  };

  const copyPosition = async () => {
    setMenu(false);
    const d = docRef.current;
    if (!d) return;
    const nid = uuid();
    const copy: Doc = { ...d, id: nid };
    try {
      const out = await api.put<PositionOut>(`/oyna/orders/${id}/positions/${nid}`, { doc: copy, base_rev: null });
      posStore.set(id, out);
    } catch (e) {
      if (!(e instanceof ApiError && e.isNetwork)) { showToast(errorText(e)); return; }
      await offline.savePosition(id, copy, { id: nid, base_rev: null });
    }
    router.replace(`/order/${id}/editor?pos=${nid}`);
  };

  const goBack = () => { flushTimers(); if (router.canGoBack()) router.back(); else router.replace(`/order/${id}`); };
  const goKit = (path?: string) => router.push(`/order/${id}/kit?pos=${posId}${path !== undefined ? `&path=${path}` : ''}`);

  // ---------------------------------------------------------------- разметка
  const setupChips = useSetupChips(doc ?? null, presets, server?.label?.split(' · ')[0]);   // хук — до ранних return
  if (phase === 'loading' || (phase === 'ready' && !doc)) return <Screen><Loading /></Screen>;
  if (phase === 'error' || !doc) {
    return (
      <Screen>
        <TopBar onBack={goBack} title="Позиция" />
        <LoadError message={loadErr} onRetry={() => void load()} />
      </Screen>
    );
  }

  const info = isLocal ? localCalc : server;
  const vs = isOffline || !info ? [] : info.violations;
  const errors = vs.filter(isErr);
  const warns = vs.filter((v) => v.severity === 'warn' && !v.accepted && v.scope !== 'price');
  const room = doc.room || 'Окно';
  const qty = doc.qty ?? 1;

  const doFix = (fx: FixAction) => {
    if (fx.route) { router.push(fx.route); return; }
    if (fx.commands) commit(fx.commands);
  };

  if (mode === 'issues') {
    return (
      <Issues doc={doc} vs={vs} offline={isOffline || (isLocal && !localCalc)} room={room} order={id} pos={posId}
        onBack={() => setMode('edit')}
        onPick={(p) => { setMode('edit'); if (p !== undefined && cellAt(doc, p)) setSelected(p); }}
        onFix={(fx) => { setMode('edit'); doFix(fx); }}
        onCommand={commit} />
    );
  }

  const sel = selected !== null && cellAt(doc, selected) ? selected : null;
  const firstErr = errors[0];
  const fx = firstErr ? fixAction(firstErr, doc, id, posId) : null;
  const canUndo = hist.current.past.length > 0, canRedo = hist.current.future.length > 0;
  const asm = isAssembly(doc);
  const frames = asm ? asmFrames(doc) : [];
  const aSel = asm && asmSel && (asmSel.kind === 'frame' ? asmSel.index < frames.length : asmSel.index < frames.length - 1) ? asmSel : null;
  // раздвижная (§11.1): тап по полотну — подвижное ⇄ глухое (полотна — не ячейки дерева)
  const leafOf = (p: string) => {
    const { frame, sub } = splitPath(p);
    const f = frame === null ? doc.frame : frames[frame];
    const sp = f ? slidingSpec(f) : null;
    return sp && /^\d+$/.test(sub) && Number(sub) < sp.n ? { sp, i: Number(sub), prefix: frame === null ? '' : framePrefix(frame) } : null;
  };
  const pickCell = (p: string) => {
    const lf = leafOf(p);
    if (lf) {
      const moving = lf.sp.moving.map((m, i) => (i === lf.i ? !m : m));
      commit([{ cmd: 'set_sliding', ...(lf.prefix ? { path: lf.prefix } : {}), moving }]);
      showToast(`Полотно ${lf.i + 1}: ${moving[lf.i] ? 'подвижное' : 'глухое'}`);
      return;
    }
    setAsmSel(null); setSelected(p === sel ? null : p);
  };
  const prod = asm ? null : doc.frame.root.sliding ? 'sliding' : doc.frame.root.guillotine ? 'guillotine' : null;
  // кнопка 3D: раздвижные и гильотины «Открыть», створки «Повернуть»; «Откинуть» — только если есть что откидывать
  const caps = openCaps(doc);
  const next3d = open3d === 'closed' ? 'turn' : open3d === 'turn' && caps.tilt ? 'tilt' : 'closed';
  const label3d = open3d === 'closed' ? (caps.turn ? 'Повернуть' : 'Открыть') : open3d === 'turn' && caps.tilt ? 'Откинуть' : 'Закрыть';
  const splitPress = () => {
    if (sel !== null) { setSplitFor(sel); return; }
    if (aSel?.kind === 'frame' && frames[aSel.index].root.cell) { setSplitFor(framePrefix(aSel.index)); return; }
    if (doc.frame.root.cell) { setSplitFor(''); return; }
    showToast('Выберите ячейку на схеме');
  };

  const online = !isOffline && !isLocal;
  const issuesCount = vs.filter((v) => !v.accepted && v.severity !== 'hint' && v.severity !== 'auto_add' && v.scope !== 'price').length;
  const shown = dimPreview?.doc ?? doc;
  const toOrder = () => { flushTimers(); router.dismissTo(`/order/${id}`); };

  // цена всегда наверху листа (X5Editor); ошибка — «—» и «цена после исправления» (X5Err); без сети — посчитаем позже
  const priceNode = (tags: boolean) => (
    <PriceLine
      value={isOffline || firstErr || info?.total == null ? null : num(info.total)}
      muted={saving}
      unit={isOffline ? 'посчитаем, когда появится интернет' : firstErr ? 'цена после исправления' : info?.total != null ? 'сум' : saving ? 'считаем…' : 'нет цены'}
      right={!tags ? undefined :
        <>
          {info?.demo && !isOffline && !firstErr ? <Tag kind="est" title="ДЕМО" /> : null}
          {warns.length > 0 && !firstErr ? (
            <Pressable onPress={() => setMode('issues')} hitSlop={6}><Pill kind="est" title={`${warns.length} предупр.`} /></Pressable>
          ) : null}
        </>
      } />
  );
  const priceLine = priceNode(true);

  const kitTiles = (['system', 'glass', 'profile_color', 'fittings', 'lam_out', 'lam_in'] as const)
    .map((w) => setupChips.find((c) => c.what === w)!)
    .filter(Boolean)
    .map((c) => ({ key: c.what, value: c.value, label: KIT_LABEL[c.what] ?? c.label.toLowerCase(), dim: !online }));
  const winTiles = [
    ...(!prod ? [{ key: 'split', title: 'Разделить', sub: 'створки, импосты', onPress: splitPress }] : []),
    ...(!asm && !prod ? [{ key: 'shape', title: 'Форма рамы', sub: SHAPE_TITLE[frameShape(doc.frame).shape], onPress: () => setShapeFor('') }] : []),
    { key: 'addons', title: 'Доп. профили', sub: doc.addons?.length ? String(doc.addons.length) : 'нет', onPress: () => setDocSheet('addons') },
    { key: 'shutter', title: 'Рольставни, решётка', sub: shutterText(doc), onPress: () => setDocSheet('shutter') },
    ...(asm ? [{ key: 'loggia', title: 'Лоджия', sub: loggiaText(doc.loggia), onPress: () => setDocSheet('loggia') }] : []),
    ...(prod !== 'guillotine' ? [{ key: 'mirror', title: 'Зеркально', sub: prod === 'sliding' ? 'полотна наоборот' : 'петли наоборот', onPress: () => commit([{ cmd: 'mirror' }]) }] : []),
    { key: 'qty', title: `Количество: ${qty}`, sub: 'изменить', onPress: () => setQtyOpen(true) },
  ];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <DotCanvas />
        {/* .hdr: назад, помещение, 3D, «Ещё» */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, minHeight: 56 }}>
          <IconButton name="back" label="Назад" onPress={goBack} />
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Txt w={600} size={18} lines={1} style={{ flexShrink: 1 }}>{room}</Txt>
            {qty > 1 ? <Txt size={14} color={C.muted}>× {qty}</Txt> : null}
            {view === 'outside' && !is3d ? <Txt size={14} color={C.muted}>· снаружи</Txt> : null}
          </View>
          <IconButton name="cube" label="3D" onPress={() => setIs3d(!is3d)} bg={is3d ? C.accentSoft : undefined} color={is3d ? C.accentDeep : C.ink} />
          <IconButton name="more" label="Ещё" onPress={() => setMenu(true)} />
        </View>
        {isOffline ? (
          <View style={{ marginHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.dark }}>
            <Icon name="cloud_off" size={18} color="#fff" />
            <Txt size={13} w={500} color="#fff" style={{ flex: 1 }}>Нет интернета — всё сохраняется на телефоне</Txt>
          </View>
        ) : null}
        {asm ? (
          <AsmTabs doc={doc} sel={aSel} onPick={(x) => { setSelected(null); setAsmSel(x); }}
            onAdd={() => {
              const after = aSel?.kind === 'frame' ? aSel.index : frames.length - 1;
              commit([{ cmd: 'add_frame', after, w: 1000 }]);
              setSelected(null); setAsmSel({ kind: 'frame', index: after + 1 });
            }} />
        ) : null}

        {/* поле схемы / 3D */}
        {is3d ? (
          <View style={{ flex: 1 }}>
            {/* кнопки строкой над моделью — поверх они закрывали низ окна */}
            <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 10 }}>
              <Soft small title={view === 'inside' ? 'Снаружи' : 'Изнутри'} icon="layers" onPress={() => setView(view === 'inside' ? 'outside' : 'inside')} />
              <Soft small title={label3d} icon="window" onPress={() => setOpen3d(next3d)} />
              <Soft small title="Вид" icon="undo" onPress={() => setReset3d((n) => n + 1)} />
            </View>
            <Window3D doc={doc} colorOut={profileHex(doc.setup, 'outside')}
              colorIn={profileHex(doc.setup, 'inside')} depthMm={depth} side={view} open={open3d} resetKey={reset3d} style={{ marginBottom: 36 }} />
          </View>
        ) : null}
        <Pressable style={{ flex: 1, display: is3d ? 'none' : 'flex' }} onPress={() => { if (!dimTarget) { setSelected(null); setAsmSel(null); } }} accessible={false}
          onLayout={(e) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          {area.w > 0 && area.h > 0 ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 72 }}>
              <SchemaDims doc={shown} width={Math.max(120, area.w - 150)} maxHeight={Math.max(80, area.h - 130)} view={view}
                selected={sel} violations={dimPreview ? [] : vs} onCellPress={dimTarget ? undefined : pickCell}
                onShape={(prefix) => setShapeFor(prefix)} onDim={(t) => { flushTimers(); setDimTarget(t); }}
                edit={dimTarget ? { target: dimTarget, changed: dimPreview?.changed ?? [] } : null} />
            </View>
          ) : null}
        </Pressable>

        {/* .bs — нижний лист */}
        <View style={[st.bs, { paddingBottom: Math.max(insets.bottom, 12) + 12 }]}>
          {sel === null && aSel ? <View style={st.hdl}><View style={st.hdlBar} /></View> : null}
          {sel !== null ? (
            <CellPanel key={sel} doc={doc} path={sel} presets={presets} price={priceNode(false)}
                snaps={[96, Math.round(win.height * 0.42), Math.round(win.height * 0.78)]}
                commit={commit}
                onFill={() => (isLocal ? showToast('Стекло ячейки — когда позиция уйдёт на сервер') : goKit(sel))}
                onOption={isOffline || isLocal ? undefined : (g) => router.push(`/order/${id}/alternatives?pos=${posId}&what=${encodeURIComponent(`option:${g}`)}&path=${encodeURIComponent(sel)}`)}
                onSplit={() => setSplitFor(sel)}
                onSize={() => setDimTarget({ kind: 'part', path: sel })}
                onMerge={() => { const pp = parentPath(sel); commit([{ cmd: 'merge', path: pp }]); setSelected(pp); }} />
          ) : aSel ? (
            <ScrollView style={{ maxHeight: win.height * 0.4 }} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              {aSel.kind === 'frame' ? (
                <FramePanel doc={doc} index={aSel.index} commit={commit} commitLater={commitLater} onClose={() => setAsmSel(null)}
                  onShape={() => setShapeFor(framePrefix(aSel.index))} onSplit={splitPress}
                  onRemove={() => { commit([{ cmd: 'remove_frame', index: aSel.index }]); setAsmSel(null); }} />
              ) : (
                <JointPanel doc={doc} index={aSel.index} commit={commit} commitLater={commitLater} onClose={() => setAsmSel(null)} />
              )}
            </ScrollView>
          ) : (
            <>
              <WindowPanel key={firstErr ? 'err' : 'ok'} tab={winTab} onTab={setWinTab}
                snaps={[94, Math.min(Math.round(win.height * 0.5), firstErr ? 250 : 330), Math.round(win.height * 0.72)]}
                header={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingBottom: 8 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>{priceLine}</View>
                    {/* отмена/повтор — внизу, под большим пальцем, а не в верхнем углу */}
                    <View style={{ opacity: canUndo ? 1 : 0.35 }}><IconButton name="undo" label="Отменить" onPress={canUndo ? undo : undefined} bg={C.soft} /></View>
                    <View style={{ opacity: canRedo ? 1 : 0.35 }}><IconButton name="redo" label="Повторить" onPress={canRedo ? redo : undefined} bg={C.soft} /></View>
                  </View>
                }
                err={firstErr ? (
                  <>
                    {/* X5Err: одна строка — что не так и почему; решение — главной кнопкой; «Другое» — все нарушения */}
                    <View style={[st.ban, { backgroundColor: C.errBg, alignItems: 'center' }]}>
                      <Icon name="warn" size={20} color={C.errFg} stroke={2.3} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Txt size={16} w={600} color={C.errFg} lines={1}>{firstErr.title}</Txt>
                        {firstErr.msg || firstErr.fix ? <Txt size={14} color={C.errFg} lines={1}>{firstErr.msg || firstErr.fix}</Txt> : null}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Soft title="Другое" onPress={() => setMode('issues')} />
                      {fx ? <Button title={fx.title} icon={fx.icon} onPress={() => doFix(fx)} style={{ flex: 1 }} /> : null}
                    </View>
                  </>
                ) : null}
                kit={
                  <>
                    <Tile2Grid items={kitTiles}
                      onPress={(what) => (online ? router.push(`/order/${id}/alternatives?pos=${posId}&what=${what}`) : showToast('Комплектацию поменяем, когда появится интернет'))} />
                    {online ? <TxtLink title={`Комплектация заказа${kitName ? `: ${kitName}` : ''}`} onPress={() => goKit()} style={{ paddingHorizontal: 4 }} /> : null}
                  </>
                }
                win={
                  <>
                    {prod === 'sliding' ? <SlidingTiles doc={doc} path="" commit={commit} /> : prod === 'guillotine' ? <GuillotineTiles doc={doc} path="" commit={commit} /> : null}
                    {prod ? <Lbl>Ещё</Lbl> : null}
                    <Tiles<string> value={null} onChange={(k) => winTiles.find((x) => x.key === k)?.onPress()} items={winTiles.map((t) => ({ value: t.key, title: t.title, sub: t.sub }))} />
                  </>
                }
                extras={<ExtrasPanel doc={doc} run={commit} inSheet />} />
              {!firstErr ? <Button title="В заказ" onPress={toOrder} /> : null}
            </>
          )}
        </View>
        {dimTarget ? (
          <DimSheet key={JSON.stringify(dimTarget)} doc={doc} target={dimTarget} onClose={() => { setDimTarget(null); setDimPreview(null); }}
            onPreview={(d, changed) => setDimPreview(d ? { doc: d, changed } : null)}
            onApply={(c) => { setDimTarget(null); setDimPreview(null); commit(c); }} />
        ) : null}
        {toast}
      </View>

      <SplitSheet path={splitFor} onClose={() => setSplitFor(null)}
        onSplit={(p, dir, n) => { setSplitFor(null); commit([{ cmd: 'split', path: p, dir, n }]); setAsmSel(null); setSelected(joinPath(p, 0)); }} />
      <AddonsSheet visible={docSheet === 'addons'} doc={doc} onClose={() => setDocSheet(null)} onChange={(addons) => commitDoc({ addons })} />
      <ShutterSheet visible={docSheet === 'shutter'} doc={doc} onClose={() => setDocSheet(null)} onChange={commitDoc} />
      {docSheet === 'loggia' ? <LoggiaSheet doc={doc} onClose={() => setDocSheet(null)} onSave={(loggia) => { setDocSheet(null); commitDoc({ loggia }); }} /> : null}
      {docSheet === 'tpl' ? <SaveTemplateSheet doc={doc} onClose={() => setDocSheet(null)} onSaved={() => { setDocSheet(null); showToast('Шаблон сохранён — в «Шаблоны → Мои»'); }} /> : null}
      <ShapeSheet doc={doc} prefix={shapeFor} onClose={() => setShapeFor(null)}
        onApply={(c) => { setShapeFor(null); commit(c); }} />
      <QtySheet visible={qtyOpen} qty={qty} onClose={() => setQtyOpen(false)} onQty={(n) => commitLater('qty', [{ cmd: 'set_qty', qty: n }])} />
      <MoreSheet visible={menu} onClose={() => setMenu(false)} issues={issuesCount} online={online} view={view}
        onView={() => { setMenu(false); setView(view === 'inside' ? 'outside' : 'inside'); }}
        onIssues={() => { setMenu(false); setMode('issues'); }}
        onKit={() => { setMenu(false); goKit(); }}
        onCalc={() => { setMenu(false); router.push(`/order/${id}/calc`); }}
        onCopy={() => void copyPosition()}
        onTpl={() => { setMenu(false); setDocSheet('tpl'); }}
        onSummary={() => { setMenu(false); flushTimers(); router.push(`/order/${id}/summary`); }}
        onNext={() => { setMenu(false); flushTimers(); router.push(`/order/${id}/measure`); }} />
    </KeyboardAvoidingView>
  );
}

/** подписи плиток «Комплектация» (X5Editor: «профиль», «стекло», «цвет», «фурнитура») */
const KIT_LABEL: Record<string, string> = {
  system: 'профиль', glass: 'стекло', profile_color: 'цвет', fittings: 'фурнитура', lam_out: 'ламинация снаружи', lam_in: 'ламинация внутри',
};

// ---------------------------------------------------------------- панель ячейки (X5Cell)
/** Выбрана створка: окно остаётся видно над панелью; «Створка 1 · 700 × 1 300 · цена»; разделы Открывание · Стекло · Сетка;
 * редкое — «Ещё: дверная, панель, PSK, HS» (тип, все открывания, размер части, разделить, объединить). */
function CellPanel({ doc, path, presets, price, commit, onFill, onSplit, onMerge, onOption, onSize, snaps }: {
  doc: Doc; path: string; presets: GlassPreset[] | null; price: ReactNode;
  commit: (c: Command[]) => void;
  onFill: () => void; onSplit: () => void; onMerge: () => void; onSize: () => void;
  /** вариант детали створки — лист замен (/alternatives), только онлайн */
  onOption?: (group: string) => void;
  snaps: [number, number, number];
}) {
  const [sheet, setSheet] = useState<'muntins' | 'decor' | 'more' | null>(null);
  const [tab, setTab] = useState<'open' | 'glass' | 'extra'>('open');
  const cell = cellAt(doc, path);
  if (!cell) return null;
  const open = cell.type === 'sash' || cell.type === 'door_sash';
  const hasGlass = cell.type !== 'panel' || cell.fill?.kind === 'glass';
  const set = (props: Partial<Cell>) => commit([{ cmd: 'set_cell', path, ...props }]);
  const own = cell.fill?.kind === 'glass' ? cell.fill.glass : null;
  const fillText = cell.type === 'panel' && cell.fill?.kind !== 'glass'
    ? 'панель'
    : own ? `своё · ${glassLabel(own, presets)}` : `как у изделия${doc.setup?.glass ? ` · ${glassLabel(doc.setup.glass, presets)}` : ''}`;
  const sub = splitPath(path).sub !== '';
  // гильотинное окно (§11.2): часть узла split 'vslide'
  let inVslide = false;
  try { inVslide = sub && nodeAt(doc, parentPath(path)).split === 'vslide'; } catch { /* корень */ }
  const vs = open && cell.open === 'vslide';
  const top = inVslide && indexOf(path) === 0;
  const tabs: { value: typeof tab; title: string }[] = [
    { value: 'open', title: 'Открывание' },
    ...(hasGlass ? [{ value: 'glass' as const, title: 'Стекло' }] : []),
    { value: 'extra', title: open ? 'Сетка' : 'Клапан' },
  ];
  const cur = tabs.some((t) => t.value === tab) ? tab : 'open';
  // 4 главных открывания (X5Cell); у двери вместо откидной — PSK
  const main = [{ value: 'fixed', title: 'Глухая' }, { value: 'turn', title: 'Поворотная' }, { value: 'tilt_turn', title: 'П-О' },
    cell.type === 'door_sash' ? { value: 'psk', title: 'PSK' } : { value: 'tilt', title: 'Откидная' }];
  const pickOpen = (v: string) => {
    if (v === 'fixed') { set({ type: 'fixed' }); return; }
    const base: Partial<Cell> = open ? {} : { type: doc.kind === 'door' ? 'door_sash' : 'sash', handle: true };
    if (v === 'tilt') set({ ...base, open: 'tilt', hinge: 'bottom' });
    else if (v === 'psk' || v === 'hs') set({ ...base, open: v as Cell['open'] });
    else set({ ...base, open: v as Cell['open'], hinge: cell.hinge === 'right' ? 'right' : 'left' });
  };

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 8, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', flexShrink: 1, minWidth: 0 }}>
        <Txt w={700} size={20} lines={1} style={{ flexShrink: 1 }}>{cellTitle(doc, path)}</Txt>
        <Txt size={14} color="#5F5C57" style={{ marginLeft: 8, fontVariant: ['tabular-nums'] }}>{cellSize(doc, path)}</Txt>
      </View>
      <View style={{ flex: 1 }} />
      {price}
    </View>
  );

  return (
    <DragArea snaps={snaps} header={header}>
      <Tabs<typeof tab> items={tabs} value={cur} onChange={setTab} />

      {cur === 'open' && vs ? (
        <>
          <Lbl>Полотно</Lbl>
          <Tiles<string> value={cell.slide ?? 'moving'} onChange={(v) => set({ slide: v as Cell['slide'] })}
            items={[{ value: 'moving', title: 'Подвижное', sub: top ? 'едет вниз' : 'едет вверх' }, { value: 'fixed', title: 'Неподвижное', sub: 'глухое полотно' }]} />
          <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 4 }}>
            <View style={{ flex: 1 }}>
              <Txt w={500}>Откидывание для мытья</Txt>
              <Note>полотно наклоняется внутрь</Note>
            </View>
            <Switch value={!!cell.tilt_clean} onChange={(v) => set({ tilt_clean: v })} />
          </View>
          <Lbl>Как открывается</Lbl>
          <Tiles<string> value="vslide" onChange={(o) => { if (o !== 'vslide') set({ open: o as Cell['open'], hinge: 'left' }); }}
            items={[{ value: 'vslide', title: 'Гильотинное' }, { value: 'tilt_turn', title: 'Поворотно-откидная' }]} />
        </>
      ) : null}

      {cur === 'open' && !vs ? (
        <>
          <Opt2Grid items={main.map((o) => ({ ...o, on: o.value === 'fixed' ? cell.type === 'fixed' : open && cell.open === o.value }))} onChange={pickOpen} />
          {open && !NO_SIDE_HINGE.includes(cell.open ?? 'turn') ? (
            <Opt2Grid value={cell.hinge === 'right' ? 'right' : 'left'} onChange={(h) => set({ hinge: h as Cell['hinge'] })}
              items={[{ value: 'left', title: 'Петли слева' }, { value: 'right', title: 'справа' }]} />
          ) : null}
          {cell.type === 'door_sash' ? (
            <>
              <Lbl>Дверь открывается</Lbl>
              <Opt2Grid value={cell.open_dir ?? 'in'} onChange={(d) => set({ open_dir: d as Cell['open_dir'] })}
                items={[{ value: 'in', title: 'Внутрь' }, { value: 'out', title: 'Наружу' }]} />
              <Lbl>Порог</Lbl>
              <Tiles<string> cols={3} value={cell.threshold ?? 'standard'} onChange={(t) => set({ threshold: t as Cell['threshold'] })}
                items={[{ value: 'standard', title: 'Рамный' }, { value: 'low_alu', title: 'Низкий алюм.' }, { value: 'none', title: 'Без порога' }]} />
            </>
          ) : null}
          <TxtLink title="Ещё: дверная, панель, PSK, HS" onPress={() => setSheet('more')} style={{ paddingHorizontal: 6 }} />
        </>
      ) : null}

      {cur === 'glass' ? (
        <>
          <Pressable accessibilityRole="button" onPress={onFill} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingVertical: 6, paddingHorizontal: 4, gap: 10 }, pressed && { opacity: 0.7 }]}>
            <View style={{ flex: 1 }}>
              <Txt size={14} color={C.muted}>{cell.type === 'panel' ? 'Заполнение' : 'Стеклопакет'}</Txt>
              <Txt w={500} lines={1}>{fillText}</Txt>
            </View>
            <Icon name="chevron" size={20} color="#B4B1AB" />
          </Pressable>
          <PanelLink label="Раскладка" value={muntinsLabel(cell.muntins)} onPress={() => setSheet('muntins')} />
          <PanelLink label="Декор стекла" value={glassDecorLabel(cell)} onPress={() => setSheet('decor')} />
        </>
      ) : null}

      {cur === 'extra' ? (
        <>
          {open ? (
            <>
              <Lbl>Москитная сетка</Lbl>
              <Tiles<string> cols={3} value={cell.mosquito ? mosqType(cell.mosquito, cell) : 'none'}
                onChange={(t) => set({ mosquito: t === 'none' ? false : { type: t as MosqT } })}
                items={[{ value: 'none', title: 'Нет' }, ...(Object.keys(MOSQ_SHORT) as MosqT[]).map((k) => ({ value: k, title: MOSQ_SHORT[k][0].toUpperCase() + MOSQ_SHORT[k].slice(1) }))]} />
              <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 4 }}>
                <Txt w={500} style={{ flex: 1 }}>Ручка</Txt>
                <Switch value={cell.handle !== false} onChange={(v) => set({ handle: v })} />
              </View>
            </>
          ) : null}
          {cell.type !== 'panel' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 4 }}>
              <View style={{ flex: 1 }}>
                <Txt w={500}>Приточный клапан</Txt>
                <Note>в верхний профиль</Note>
              </View>
              <Switch value={!!cell.vent} onChange={(v) => set({ vent: v ? { type: 'supply_valve' } : null })} />
            </View>
          ) : null}
          {open && onOption ? (
            <>
              <Lbl>Фурнитура створки</Lbl>
              <Tiles<string> value={null} onChange={onOption} items={CELL_OPTIONS.map((o) => ({ value: o.group, title: optLabel(cell, o) }))} />
            </>
          ) : null}
        </>
      ) : null}

      <MuntinsSheet visible={sheet === 'muntins'} doc={doc} path={path} cell={cell} onClose={() => setSheet(null)} commit={commit} />
      <GlassDecorSheet visible={sheet === 'decor'} doc={doc} path={path} cell={cell} onClose={() => setSheet(null)} commit={commit} />
      <FormSheet visible={sheet === 'more'} onClose={() => setSheet(null)} title={cellTitle(doc, path)}>
        <Lbl>Что это</Lbl>
        <Tiles<Cell['type']> value={cell.type} onChange={(t) => set({ type: t })}
          items={(['fixed', 'sash', 'door_sash', 'panel'] as const).map((t) => ({ value: t, title: TYPE_TITLE[t] }))} />
        {open ? (
          <>
            <Lbl>Как открывается</Lbl>
            <Tiles<string> value={cell.open ?? 'turn'}
              onChange={(o) => set(o === 'tilt' ? { open: 'tilt', hinge: 'bottom' } : o === 'top_hung' ? { open: 'top_hung', hinge: 'top' }
                : { open: o as Cell['open'], ...(cell.hinge === 'bottom' || cell.hinge === 'top' ? { hinge: 'left' } : {}) })}
              items={[...OPENS_OF(cell), ...(inVslide && cell.type === 'sash' ? ['vslide'] : []),
                ...(cell.open && !OPENS_OF(cell).includes(cell.open) && !(inVslide && cell.open === 'vslide') ? [cell.open] : [])]
                .map((o) => ({ value: o, title: OPEN_FULL[o] ?? OPEN_TITLE[o] ?? o }))} />
          </>
        ) : null}
        <Lbl>Деление</Lbl>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {sub ? <Soft title="Размер" icon="ruler" onPress={() => { setSheet(null); onSize(); }} style={{ flex: 1 }} /> : null}
          <Soft title="Разделить" icon="window" onPress={() => { setSheet(null); onSplit(); }} style={{ flex: 1 }} />
          {sub ? <Soft title="Объединить" onPress={() => { setSheet(null); onMerge(); }} style={{ flex: 1 }} /> : null}
        </View>
      </FormSheet>
    </DragArea>
  );
}

/** подпись группы в панели */
function Lbl({ children }: { children: string }) {
  return <Txt size={14} w={600} color={C.muted} style={{ paddingHorizontal: 4, paddingTop: 4 }}>{children}</Txt>;
}
/** открывание полными словами (мастер говорит «поворотно-откидная», а не «П-О») */
const OPEN_FULL: Record<string, string> = {
  turn: 'Поворотная', tilt_turn: 'Поворотно-откидная', tilt: 'Откидная', top_hung: 'Подвесная', pivot: 'Среднеподвесная',
  psk: 'PSK, параллельно-сдвижная', hs: 'HS, подъёмно-сдвижная', sliding: 'Раздвижная', folding: 'Гармошка', vslide: 'Гильотинное',
};
const st0 = { seg: { marginHorizontal: 0, backgroundColor: '#EDECE9' } };

/** Открывания по типу ячейки (§3, §9.1); гармошка — только у листьев узла «гармошка». */
const OPENS_OF = (c: Cell): string[] => (c.type === 'door_sash'
  ? ['turn', 'tilt_turn', 'psk', 'hs']
  : ['turn', 'tilt_turn', 'tilt', 'top_hung', 'pivot', 'psk', 'hs']);
const NO_SIDE_HINGE = ['tilt', 'top_hung', 'pivot', 'psk', 'hs', 'sliding', 'vslide'];

/** Опции створки (§9.6) — option groups; вариант выбирается листом замен. */
const CELL_OPTIONS: { group: string; title: string }[] = [
  { group: 'handle', title: 'Ручка' }, { group: 'child_lock', title: 'Детский замок' }, { group: 'micro_vent', title: 'Микропроветривание' },
  { group: 'limiter', title: 'Ограничитель' }, { group: 'comb', title: 'Гребёнка' },
];
const optLabel = (c: Cell, o: { group: string; title: string }) => (c.options?.[o.group] ? `${o.title} ✓` : o.title);

// ---------------------------------------------------------------- москитные сетки (§9.2)
type MosqT = 'frame' | 'sliding' | 'pleated' | 'door' | 'antipet';
const MOSQ_TITLE: Record<MosqT, string> = { frame: 'Рамочная', sliding: 'Раздвижная', pleated: 'Плиссе', door: 'Дверная на петлях', antipet: 'Антикошка' };
const MOSQ_SHORT: Record<MosqT, string> = { frame: 'рамочная', sliding: 'раздвижная', pleated: 'плиссе', door: 'дверная', antipet: 'антикошка' };
const mosqType = (m: Cell['mosquito'], cell?: Cell): MosqT => (m && typeof m === 'object' ? m.type : cell?.type === 'door_sash' ? 'door' : 'frame');

function MosquitoSheet({ visible, cell, onClose, onPick }: { visible: boolean; cell: Cell; onClose: () => void; onPick: (m: Cell['mosquito']) => void }) {
  const cur = cell.mosquito ? mosqType(cell.mosquito, cell) : 'none';
  const wide = cell.type === 'door_sash';
  return (
    <FormSheet visible={visible} onClose={onClose} title="Москитная сетка">
      <Choice<string> value={cur} onChange={(v) => onPick(v === 'none' ? null : { type: v as MosqT })}
        items={[{ value: 'none', title: 'Нет' }, ...(Object.keys(MOSQ_TITLE) as MosqT[]).map((k) => ({ value: k, title: MOSQ_TITLE[k] }))]} />
      {!wide && (cur === 'pleated' || cur === 'door') ? <Note style={{ paddingHorizontal: 4 }}>Плиссе и дверная — для двери или широкого проёма</Note> : null}
      <Note style={{ paddingHorizontal: 4 }}>Считается за м² сетки, дверная — за штуку</Note>
    </FormSheet>
  );
}

// ---------------------------------------------------------------- разделить на N
type SplitDir = 'v' | 'h' | 'shtulp' | 'folding' | 'vslide';
const SPLIT_DIRS: { value: SplitDir; title: string; sub: string }[] = [
  { value: 'v', title: 'Вертикально', sub: 'импост' }, { value: 'h', title: 'Горизонтально', sub: 'импост' },
  { value: 'shtulp', title: 'Штульп', sub: '2 створки без импоста' }, { value: 'folding', title: 'Гармошка', sub: 'складываются книжкой' },
  { value: 'vslide', title: 'Гильотинное (вверх)', sub: 'нижнее полотно едет вверх' },
];
function SplitSheet({ path, onClose, onSplit }: { path: string | null; onClose: () => void; onSplit: (path: string, dir: SplitDir, n: number) => void }) {
  const [dir, setDir] = useState<SplitDir>('v');
  const [n, setN] = useState(2);
  const two = dir === 'shtulp' || dir === 'vslide';           // всегда две части
  return (
    <FormSheet visible={path !== null} onClose={onClose} title="Разделить ячейку">
      <Tiles<SplitDir> value={dir} onChange={setDir} items={SPLIT_DIRS} />
      {two ? null : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[2, 3, 4].map((x) => (
            <Pressable key={x} onPress={() => setN(x)} style={{ flex: 1, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: n === x ? C.dark : C.soft }}>
              <Txt w={600} color={n === x ? '#fff' : C.ink}>на {x}</Txt>
            </Pressable>
          ))}
        </View>
      )}
      {two ? null : (
        <Card style={{ marginHorizontal: 0, backgroundColor: C.soft }}>
          <Row first label="Частей" right={<Stepper value={n} onChange={setN} min={2} max={8} />} />
        </Card>
      )}
      <Button title={dir === 'vslide' ? 'Гильотинное окно' : dir === 'shtulp' ? 'Штульп на 2 створки' : dir === 'folding' ? `Гармошка на ${n}` : `Разделить на ${n}`}
        icon="window" onPress={() => path !== null && onSplit(path, dir, two ? 2 : n)} />
    </FormSheet>
  );
}

// ---------------------------------------------------------------- «Ещё» в шапке (X5Editor)
/** Редкое: вид снаружи, нарушения, комплектация заказа, расчёт, копия, шаблон, итог замера, следующее окно.
 * Количество, форма, доп. профили, рольставни, лоджия, зеркально — в разделе «Окно». */
function MoreSheet({ visible, onClose, issues, online, view, onView, onIssues, onKit, onCalc, onCopy, onTpl, onSummary, onNext }: {
  visible: boolean; onClose: () => void; issues: number; online: boolean; view: 'inside' | 'outside';
  onView: () => void; onIssues: () => void; onKit: () => void; onCalc: () => void; onCopy: () => void; onTpl: () => void;
  onSummary: () => void; onNext: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Card style={{ marginBottom: 8 }}>
        <Row first label={view === 'inside' ? 'Вид снаружи' : 'Вид изнутри'} left={<Icon name="mirror" />} onPress={onView} chevron={false} />
        <Row label="Нарушения" left={<Icon name="warn" />} value={issues ? String(issues) : 'нет'} onPress={onIssues} />
        {online ? <Row label="Комплектация заказа" sub="Эконом · Стандарт · Тёплый" left={<Icon name="layers" />} onPress={onKit} /> : null}
        {online ? <Row label="Расчёт" left={<Icon name="calc" />} onPress={onCalc} /> : null}
        <Row label="Копировать окно" left={<Icon name="copy" />} onPress={onCopy} chevron={false} />
        {online ? <Row label="Сохранить как шаблон" left={<Icon name="folder" />} onPress={onTpl} /> : null}
        <Row label="Итог замера" left={<Icon name="doc" />} onPress={onSummary} />
        <Row label="Следующее окно" left={<Icon name="plus" />} onPress={onNext} />
      </Card>
    </Sheet>
  );
}

function QtySheet({ visible, qty, onClose, onQty }: { visible: boolean; qty: number; onClose: () => void; onQty: (n: number) => void }) {
  const [q, setQ] = useState(qty);
  useEffect(() => { if (visible) setQ(qty); }, [visible, qty]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Количество">
      <View style={{ paddingHorizontal: 12, gap: 10, paddingBottom: 8 }}>
        <Card style={{ marginHorizontal: 0 }}>
          <Row first label="Таких же окон" right={<Stepper value={q} min={1} max={99} onChange={(v) => { setQ(v); onQty(v); }} />} />
        </Card>
        <Button title="Готово" onPress={onClose} />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- EditorIssues
function Issues({ doc, vs, offline: off, room, order, pos, onBack, onPick, onFix, onCommand }: {
  doc: Doc; vs: Violation[]; offline: boolean; room: string; order: string; pos: string;
  onBack: () => void; onPick: (path?: string) => void; onFix: (fx: FixAction) => void; onCommand: (c: Command[]) => void;
}) {
  const errors = vs.filter(isErr);
  const warns = vs.filter((v) => v.severity === 'warn' && !v.accepted && v.scope !== 'price');
  const accepted = vs.filter((v) => v.severity === 'warn' && v.accepted);
  const hints = vs.filter((v) => v.severity === 'hint' || v.severity === 'auto_add');
  const group = (title: string, list: Violation[], kind: 'err' | 'est' | 'n' | 'info') => list.length ? (
    <>
      <Txt size={15} w={600} color={C.muted} style={st.lbl}>{title}</Txt>
      <View style={st.sheetBox}>
        {list.map((v, i) => <IssueRow key={`${v.code}:${v.path ?? ''}`} v={v} first={i === 0} kind={kind} doc={doc} order={order} pos={pos}
          onPick={onPick} onFix={onFix} onCommand={onCommand} />)}
      </View>
    </>
  ) : null;
  return (
    <Screen>
      <TopBar onBack={onBack} title={`Нарушения · ${room}`} />
      <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10 }}>
        {off ? <Ban kind="info" icon="cloud_off" title="Проверки считает сервер" text="Покажем, когда появится интернет" /> : null}
        {!off && !vs.length ? <Empty title="Нарушений нет" text="Позицию можно отправлять в КП" /> : null}
        {group('Ошибки — КП не отправится', errors, 'err')}
        {group('Предупреждения', warns, 'est')}
        {group('Принято', accepted, 'n')}
        {group('К сведению', hints, 'info')}
      </Body>
    </Screen>
  );
}

const CODE_BG = { err: ['#FFE7E4', '#A1221A'], est: ['#FFF0D4', '#8A4B00'], n: ['#F2F1EE', '#55524D'], info: ['#E3EEFC', '#154A99'] } as const;

function IssueRow({ v, first, kind, doc, order, pos, onPick, onFix, onCommand }: {
  v: Violation; first: boolean; kind: keyof typeof CODE_BG; doc: Doc; order: string; pos: string;
  onPick: (path?: string) => void; onFix: (fx: FixAction) => void; onCommand: (c: Command[]) => void;
}) {
  const [bg, fg] = CODE_BG[kind];
  const fx = kind === 'err' || kind === 'est' ? fixAction(v, doc, order, pos) : null;
  const where = v.path !== undefined && cellAt(doc, v.path) ? `${cellTitle(doc, v.path)}: ` : '';
  const sub = [v.msg, v.fix].filter(Boolean).join('. ');
  return (
    <Pressable onPress={() => onPick(v.path)} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'flex-start', gap: 14, minHeight: 60, paddingHorizontal: 20, paddingVertical: 12 },
      !first && { borderTopWidth: 1, borderTopColor: C.line }, pressed && { backgroundColor: '#F7F7F5' }]}>
      <View style={{ height: 26, minWidth: 40, paddingHorizontal: 8, borderRadius: 9, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Txt size={13} w={600} color={fg}>{v.code}</Txt>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Txt w={500}>{v.title}</Txt>
        {sub || where ? <Note>{where}{sub}</Note> : null}
        {kind === 'n' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
            <Txt size={14} color={C.muted}>принято: {v.accepted_by_name ?? v.accepted_by ?? '—'}{v.accepted_at ? `, ${shortDate(v.accepted_at)}` : ''} · </Txt>
            <Pressable hitSlop={8} onPress={() => onCommand([{ cmd: 'unaccept_warning', rule: v.code, path: v.path ?? '' }])}>
              <Txt size={14} w={500} color={C.accentText}>отменить</Txt>
            </Pressable>
          </View>
        ) : null}
        {fx || kind === 'est' ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {fx ? <Soft small title={fx.title} onPress={() => onFix(fx)} /> : null}
            {kind === 'est' ? <Soft small title="Принять" onPress={() => onCommand([{ cmd: 'accept_warning', rule: v.code, path: v.path ?? '' }])} /> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}


// ---------------------------------------------------------------- комплектация на виду: профиль, декор, стекло, фурнитура

/** Строка чипов под переключателем вида — каждое касание открывает лист замен (/alternatives) для этого пункта.
 * Профиль · Цвет профиля · Ламинация снаружи · Ламинация внутри · Стекло · Фурнитура (shapes_contract §8). */
/** sysFallback — система, которую сервер подставил по комплектации (в doc её может не быть) */
function useSetupChips(doc: Doc | null, presets: GlassPreset[] | null, sysFallback?: string) {
  const s = doc?.setup ?? {};
  const [names, setNames] = useState<{ systems: SystemRow[]; decors: Decor[]; fittings: FittingSet[] } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([refs.systems(), refs.decors(), refs.fittings(s.system)])
      .then(([systems, decors, fittings]) => { if (alive) setNames({ systems, decors, fittings }); })
      .catch(() => { /* без справочников покажем коды */ });
    return () => { alive = false; };
  }, [s.system]);
  const sys = names?.systems.find((x) => x.code === s.system);
  const fit = fittingLabel(names?.fittings.find((f) => f.code === s.fittings), s.fittings)[0];
  const lamOut = lamLabel(s, 'outside', names?.decors), lamIn = lamLabel(s, 'inside', names?.decors);
  return [
    { what: 'system', label: 'Профиль', value: sys ? `${sys.brand} ${sys.series}` : s.system ?? sysFallback ?? 'по комплектации' },
    { what: 'profile_color', label: 'Цвет профиля', value: profileColorLabel(s.profile_color) },
    { what: 'lam_out', label: 'Ламинация снаружи', value: lamOut },
    { what: 'lam_in', label: 'Ламинация внутри', value: lamIn },
    { what: 'glass', label: 'Стекло', value: glassLabel(s.glass, presets) || 'по системе' },
    { what: 'fittings', label: 'Фурнитура', value: fit || 'по системе' },
  ];
}

/** Нижняя панель окна (ничего не выбрано, X5Editor): тянется пальцем; шапка — цена, отмена/повтор;
 * ошибка (X5Err) — над разделами; разделы Комплектация · Окно · Добивки. */
type WinTab = 'kit' | 'win' | 'ext';
function WindowPanel({ snaps, header, err, tab, onTab, kit, win, extras }: {
  snaps: [number, number, number]; header: ReactNode; err: ReactNode; tab: WinTab; onTab: (t: WinTab) => void;
  kit: ReactNode; win: ReactNode; extras: ReactNode;
}) {
  return (
    <DragArea snaps={snaps} start={1} header={header}>
      {err}
      <Tabs<WinTab> value={tab} onChange={onTab}
        items={[{ value: 'kit', title: 'Комплектация' }, { value: 'win', title: 'Окно' }, { value: 'ext', title: 'Добивки' }]} />
      {tab === 'kit' ? kit : tab === 'win' ? win : extras}
    </DragArea>
  );
}

// ---------------------------------------------------------------- раскладка и декор стекла (панель ячейки)
function PanelLink({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: 6, paddingHorizontal: 4, gap: 10 }, pressed && { opacity: 0.7 }]}>
      <View style={{ flex: 1 }}>
        <Txt size={14} color={C.muted}>{label}</Txt>
        <Txt w={500} lines={1}>{value}</Txt>
      </View>
      <Icon name="chevron" size={20} color="#B4B1AB" />
    </Pressable>
  );
}

type MPreset = 'none' | 'g22' | 'g32' | 'cross' | 'sun' | 'decor' | 'own';
const M_TITLE: Record<MPreset, string> = { none: 'Нет', g22: '2×2', g32: '3×2', cross: 'Крест', sun: 'Солнышко', decor: 'Декор', own: 'Своя' };
const M_COLOR: Record<string, string> = { white: 'Белая', decor: 'Как профиль', gold: 'Золото' };
const M_WIDTHS = { inner: [8, 18, 26], overlay: [18, 26, 45] } as const;

function presetOf(m?: Muntins | null): MPreset {
  if (!m) return 'none';
  if (m.pattern !== 'grid') return m.pattern === 'cross' ? 'cross' : m.pattern;
  if (m.v === 1 && m.h === 1) return 'g22';
  if (m.v === 2 && m.h === 1) return 'g32';
  return 'own';
}
function muntinsLabel(m?: Muntins | null): string {
  if (!m) return 'нет';
  const p = presetOf(m);
  const what = p === 'own' ? `${(m.v ?? 0) + 1}×${(m.h ?? 0) + 1}` : M_TITLE[p];
  return `${what} · ${m.kind === 'overlay' ? 'накладная' : 'в стеклопакете'} ${m.width_mm ?? ''} мм · ${(M_COLOR[m.color ?? 'white'] ?? '').toLowerCase()}`;
}

function MuntinsSheet({ visible, doc, path, cell, onClose, commit }: {
  visible: boolean; doc: Doc; path: string; cell: Cell; onClose: () => void; commit: (c: Command[]) => void;
}) {
  const m = cell.muntins ?? null;
  // «солнышко» — только у ячейки, которую обрезает дуга арки
  const lc = layout(doc).cells.find((c) => c.path === path);
  const { frame: fi } = splitPath(path);
  const fr = fi === null ? doc.frame : asmFrames(doc)[fi];
  const arched = !!lc?.shaped && !!fr && ['arch', 'circle'].includes(frameShape(fr).shape);
  const preset = presetOf(m);
  const kind = m?.kind ?? 'inner';
  const put = (next: Muntins | null) => commit([{ cmd: 'set_muntins', path, muntins: next }]);
  const base = (over: Partial<Muntins>): Muntins => ({
    kind, width_mm: m?.width_mm ?? 18, color: m?.color ?? 'white', pattern: 'grid', ...over,
  });
  const pick = (p: MPreset) => {
    if (p === 'none') put(null);
    else if (p === 'g22') put(base({ pattern: 'grid', v: 1, h: 1 }));
    else if (p === 'g32') put(base({ pattern: 'grid', v: 2, h: 1 }));
    else if (p === 'cross') put(base({ pattern: 'cross' }));
    else if (p === 'sun') put(base({ pattern: 'sun', v: 5, h: 1 }));
    else if (p === 'decor') put(base({ pattern: 'decor' }));
    else put(base({ pattern: 'grid', v: m?.v ?? 2, h: m?.h ?? 2 }));
  };
  const presets = (['none', 'g22', 'g32', 'cross', 'sun', 'decor', 'own'] as MPreset[]).filter((p) => p !== 'sun' || arched || preset === 'sun');
  return (
    <FormSheet visible={visible} onClose={onClose} title="Раскладка">
      <Choice<MPreset> value={preset} onChange={pick} items={presets.map((p) => ({ value: p, title: M_TITLE[p] }))} />
      {m ? (
        <>
          {m.pattern === 'grid' || m.pattern === 'sun' ? (
            <Card style={{ marginHorizontal: 0, backgroundColor: C.soft }}>
              <Row first label={m.pattern === 'sun' ? 'Лучей' : 'Вертикальных'} right={<Stepper value={m.v ?? 0} min={m.pattern === 'sun' ? 1 : 0} max={9} onChange={(v) => put({ ...m, v })} />} />
              <Row label={m.pattern === 'sun' ? 'Колец' : 'Горизонтальных'} right={<Stepper value={m.h ?? 0} min={0} max={m.pattern === 'sun' ? 3 : 9} onChange={(h) => put({ ...m, h })} />} />
            </Card>
          ) : null}
          <Seg<'inner' | 'overlay'> style={st0.seg} value={kind}
            onChange={(k) => put({ ...m, kind: k, width_mm: (M_WIDTHS[k] as readonly number[]).includes(m.width_mm ?? 0) ? m.width_mm : 26 })}
            items={[{ value: 'inner', title: 'В стеклопакете' }, { value: 'overlay', title: 'Накладная' }]} />
          <Txt size={14} color={C.muted} style={{ paddingHorizontal: 4 }}>Ширина, мм</Txt>
          <Choice<string> value={String(m.width_mm ?? '')} onChange={(w) => put({ ...m, width_mm: Number(w) })}
            items={M_WIDTHS[kind].map((w) => ({ value: String(w), title: String(w) }))} />
          <Txt size={14} color={C.muted} style={{ paddingHorizontal: 4 }}>Цвет</Txt>
          <Choice<string> value={m.color ?? 'white'} onChange={(c) => put({ ...m, color: c as Muntins['color'] })}
            items={Object.entries(M_COLOR).map(([value, title]) => ({ value, title }))} />
          {kind === 'inner' ? <Note style={{ paddingHorizontal: 4 }}>Внутри стеклопакета нужна камера от 12 мм</Note> : null}
        </>
      ) : <Note style={{ paddingHorizontal: 4 }}>Полоски на стекле: внутри стеклопакета или накладные с двух сторон</Note>}
    </FormSheet>
  );
}

function GlassDecorSheet({ visible, doc, path, cell, onClose, commit }: {
  visible: boolean; doc: Doc; path: string; cell: Cell; onClose: () => void; commit: (c: Command[]) => void;
}) {
  const f = cell.fill?.kind === 'glass' ? cell.fill : null;
  const cur = f?.decor ?? 'none';
  const put = (v: string) => commit([glassDecorCommand(doc, path, v)]);
  return (
    <FormSheet visible={visible} onClose={onClose} title="Декор стекла">
      <Choice<string> value={cur} onChange={(v) => put(v === 'tinted' ? `tinted:${f?.tint ?? 'bronze'}` : v)}
        items={Object.entries(GLASS_DECOR_TITLE).map(([value, title]) => ({ value, title }))} />
      {cur === 'tinted' ? (
        <Choice<string> value={f?.tint ?? 'bronze'} onChange={(t) => put(`tinted:${t}`)}
          items={Object.entries(TINT_TITLE).map(([value, title]) => ({ value, title: title[0].toUpperCase() + title.slice(1) }))} />
      ) : null}
      <Note style={{ paddingHorizontal: 4 }}>Считается за м² стекла этой ячейки</Note>
    </FormSheet>
  );
}

// ---------------------------------------------------------------- составное изделие: табы рам и стыков
const JOINT_TITLE: Record<string, string> = { straight: 'Прямой', angle: 'Угловой', post: 'Стойка', corner_free: 'Без стойки' };
const jointText = (j: { joint: string; angle: number }) => (j.joint === 'angle' ? `Стык ${j.angle}°` : j.joint === 'post' ? 'Стойка'
  : j.joint === 'corner_free' ? `Без стойки ${j.angle}°` : 'Стык 180°');

function AsmTabs({ doc, sel, onPick, onAdd }: {
  doc: Doc; sel: { kind: 'frame' | 'joint'; index: number } | null; onPick: (x: { kind: 'frame' | 'joint'; index: number }) => void; onAdd: () => void;
}) {
  const frames = asmFrames(doc), joints = asmJoints(doc);
  const items: { key: string; title: string; on: boolean; press: () => void }[] = [];
  frames.forEach((_, i) => {
    items.push({ key: `f${i}`, title: `Рама ${i + 1}`, on: sel?.kind === 'frame' && sel.index === i, press: () => onPick({ kind: 'frame', index: i }) });
    if (i < frames.length - 1) {
      const j = joints[i] ?? { joint: 'straight' as const, angle: 180 };
      items.push({ key: `j${i}`, title: jointText(j), on: sel?.kind === 'joint' && sel.index === i, press: () => onPick({ kind: 'joint', index: i }) });
    }
  });
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 10 }}>
      {items.map((it) => (
        <Pressable key={it.key} accessibilityRole="tab" accessibilityState={{ selected: it.on }} onPress={it.press}
          style={({ pressed }) => [{ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center',
            backgroundColor: it.on ? C.dark : '#FFFFFF', borderWidth: 1, borderColor: it.on ? C.dark : C.line, opacity: pressed ? 0.8 : 1 },
          it.key.startsWith('j') && !it.on && { backgroundColor: C.soft }]}>
          <Txt size={14} w={600} color={it.on ? '#fff' : it.key.startsWith('j') ? C.muted : C.ink}>{it.title}</Txt>
        </Pressable>
      ))}
      <Pressable accessibilityRole="button" onPress={onAdd} style={({ pressed }) => [{ height: 36, paddingHorizontal: 12, borderRadius: 18, flexDirection: 'row',
        alignItems: 'center', gap: 4, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, opacity: pressed ? 0.8 : 1 }]}>
        <Icon name="plus" size={16} />
        <Txt size={14} w={600}>Рама</Txt>
      </Pressable>
    </ScrollView>
  );
}

function NumField({ label, value, onValue, style }: { label: string; value: number; onValue: (n: number) => void; style?: object }) {
  const [text, setText] = useState(String(Math.round(value)));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(Math.round(value))); }, [value]);
  return (
    <Field label={label} value={text} keyboardType="number-pad" maxLength={5} style={[{ flex: 1, backgroundColor: C.soft }, style]}
      onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}
      onChangeText={(t) => { const v = t.replace(/[^0-9]/g, ''); setText(v); if (Number(v) > 0) onValue(Number(v)); }} />
  );
}

function FramePanel({ doc, index, commit, commitLater, onClose, onShape, onSplit, onRemove }: {
  doc: Doc; index: number; commit: (c: Command[]) => void; commitLater: (k: string, c: Command[]) => void; onClose: () => void;
  onShape: () => void; onSplit: () => void; onRemove: () => void;
}) {
  const frames = asmFrames(doc);
  const f = frames[index];
  if (!f) return null;
  const p = framePrefix(index);
  const sh = frameShape(f).shape;
  const special = !!(f.root.sliding || f.root.guillotine);
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4, paddingBottom: 8 }}>
        <Txt w={700} size={20} style={{ flex: 1 }} lines={1}>Рама {index + 1}</Txt>
        <Txt size={14} color={C.muted} style={{ fontVariant: ['tabular-nums'] }}>{num(f.w)} × {num(f.h)}</Txt>
        <IconButton name="close" label="Закрыть" onPress={onClose} bg={C.soft} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <NumField label="Ширина, мм" value={f.w} onValue={(w) => commitLater(`fw${index}`, [{ cmd: 'set_size', path: p, w }])} />
        <NumField label="Высота, мм" value={f.h} onValue={(h) => commitLater(`fh${index}`, [{ cmd: 'set_size', path: p, h }])} />
      </View>
      {f.root.sliding ? <SlidingTiles doc={doc} path={p} commit={commit} /> : f.root.guillotine ? <GuillotineTiles doc={doc} path={p} commit={commit} />
        : <PanelLink label="Форма рамы" value={SHAPE_TITLE[sh]} onPress={onShape} />}
      <View style={{ flexDirection: 'row', gap: 8, paddingTop: 4 }}>
        {f.root.cell ? <Soft title="Разделить" icon="window" onPress={onSplit} style={{ flex: 1 }} small /> : null}
        <Soft title="Удалить раму" onPress={onRemove} disabled={frames.length <= 2} style={{ flex: 1 }} small />
      </View>
      {!f.root.cell && !special ? <Note style={{ paddingHorizontal: 4 }}>Створки и деление — нажмите на ячейку рамы на схеме</Note> : null}
    </>
  );
}

function JointPanel({ doc, index, commit, commitLater, onClose }: {
  doc: Doc; index: number; commit: (c: Command[]) => void; commitLater: (k: string, c: Command[]) => void; onClose: () => void;
}) {
  const j = asmJoints(doc)[index];
  const angled = j?.joint === 'angle' || j?.joint === 'corner_free';
  const [angle, setAngle] = useState(angled ? j!.angle : 135);
  useEffect(() => { if (angled) setAngle(j!.angle); }, [angled, j?.angle]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!j) return null;
  const setA = (a: number) => { setAngle(a); commitLater(`joint${index}`, [{ cmd: 'set_joint', index, joint: j.joint, angle: a }]); };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4, paddingBottom: 8 }}>
        <Txt w={700} size={20} style={{ flex: 1 }} lines={1}>Стык {index + 1}–{index + 2}</Txt>
        <IconButton name="close" label="Закрыть" onPress={onClose} bg={C.soft} />
      </View>
      <Tiles<string> value={j.joint} onChange={(k) => commit([{ cmd: 'set_joint', index, joint: k, ...(k === 'angle' ? { angle } : k === 'corner_free' ? { angle: 90 } : {}) }])}
        items={Object.entries(JOINT_TITLE).map(([value, title]) => ({ value, title }))} />
      {j.joint === 'corner_free' ? <Note style={{ paddingHorizontal: 4 }}>Стекло к стеклу, без стойки — только алюминиевые и раздвижные системы</Note> : null}
      {angled ? (
        <>
          <Card style={{ marginHorizontal: 0, backgroundColor: C.soft }}>
            <Row first label="Угол" right={<Stepper value={angle} min={90} max={179} step={1} format={(v) => `${v}°`} onChange={setA} />} />
          </Card>
          <Choice<string> value={String(angle)} onChange={(v) => setA(Number(v))}
            items={[90, 120, 135, 150, 154, 160].map((a) => ({ value: String(a), title: `${a}°` }))} />
          {j.joint === 'angle' ? <Note style={{ paddingHorizontal: 4 }}>90° — угловое окно, 91–179° — эркер</Note> : null}
        </>
      ) : j.joint === 'post' ? <Note style={{ paddingHorizontal: 4 }}>Несущая стойка между рамами</Note>
        : <Note style={{ paddingHorizontal: 4 }}>Соединитель 180° — рамы в одну линию</Note>}
    </>
  );
}

// ---------------------------------------------------------------- раздвижные и гильотина (§11): плитки параметров
const SL_KIND_TITLE: Record<string, string> = { window: 'Окно', door: 'Дверь', panoramic: 'Панорамная' };
const SL_THR_TITLE: Record<string, string> = { standard: 'Обычный', low: 'Низкий', flush: 'В уровень пола' };
const GL_DRIVE_TITLE: Record<string, string> = { manual: 'Ручной', electric: 'Электро', remote: 'С пультом' };
const GL_GLASS_TITLE: Record<string, string> = { g8t: '8 закалённое', g10t: '10 закалённое', g4t_14_4t: 'Стеклопакет' };
const frameAt = (doc: Doc, path: string): Frame | undefined => {
  const { frame } = splitPath(path);
  return frame === null ? doc.frame : asmFrames(doc)[frame];
};
const nums = (list: number[], cur: number) => [...new Set([...list, cur])].sort((a, b) => a - b);

/** Раздвижная (§11.1): полотна, направляющие, подвижные (плитка на каждое полотно), вид, порог. path — '' или «A<i>/». */
function SlidingTiles({ doc, path, commit }: { doc: Doc; path: string; commit: (c: Command[]) => void }) {
  const f = frameAt(doc, path);
  const sp = f ? slidingSpec(f) : null;
  if (!f || !sp) return null;
  const set = (p: Partial<Sliding>) => commit([{ cmd: 'set_sliding', ...(path ? { path } : {}), ...p }]);
  const door = sp.kind !== 'window';
  return (
    <>
      <Lbl>Полотен</Lbl>
      <Tiles<string> value={String(sp.n)} onChange={(v) => set({ leaves: Number(v) })}
        items={nums([2, 3, 4, 6], sp.n).map((n) => ({ value: String(n), title: String(n) }))} />
      <Lbl>Направляющих</Lbl>
      <Tiles<string> value={String(sp.rails)} onChange={(v) => set({ rails: Number(v) })}
        items={[{ value: '2', title: '2', sub: 'полотна парами' }, { value: '3', title: '3', sub: 'каждому своя' }]} />
      <Lbl>Подвижные полотна</Lbl>
      <Tiles<string> cols={sp.n % 3 === 0 ? 3 : 2} value={null} on={(v) => sp.moving[Number(v)]}
        onChange={(v) => set({ moving: sp.moving.map((m, i) => (i === Number(v) ? !m : m)) })}
        items={sp.moving.map((m, i) => ({ value: String(i), title: `Полотно ${i + 1}`, sub: m ? 'подвижное' : 'глухое' }))} />
      <Lbl>Вид</Lbl>
      <Tiles<string> cols={3} value={sp.kind} onChange={(v) => set({ kind: v as Sliding['kind'] })}
        items={Object.entries(SL_KIND_TITLE).map(([value, title]) => ({ value, title }))} />
      {door ? (
        <>
          <Lbl>Порог</Lbl>
          <Tiles<string> cols={3} value={sp.threshold} onChange={(v) => set({ threshold: v as Sliding['threshold'] })}
            items={Object.entries(SL_THR_TITLE).map(([value, title]) => ({ value, title }))} />
        </>
      ) : null}
      <Note style={{ paddingHorizontal: 4 }}>{`Полотно ${num(Math.round(sp.lw))} мм · перехлёст ${sp.overlap} мм · тап по полотну на схеме — подвижное / глухое`}</Note>
    </>
  );
}

/** Гильотина (§11.3): модули, полотна, сколько поднимаются, привод, стекло, стойки. */
function GuillotineTiles({ doc, path, commit }: { doc: Doc; path: string; commit: (c: Command[]) => void }) {
  const f = frameAt(doc, path);
  const g = f ? guillotineSpec(f) : null;
  if (!f || !g) return null;
  const set = (p: Partial<Guillotine>) => commit([{ cmd: 'set_guillotine', ...(path ? { path } : {}), ...p }]);
  const up = Array.from({ length: g.panels - 1 }, (_, i) => i + 1);
  return (
    <>
      <Lbl>Модулей</Lbl>
      <Tiles<string> cols={3} value={String(g.modules)} onChange={(v) => set({ modules: Number(v) })}
        items={nums([1, 2, 3, 4, 5, 6], g.modules).map((n) => ({ value: String(n), title: String(n), sub: `по ${num(Math.round(f.w / n))}` }))} />
      <Lbl>Полотен в модуле</Lbl>
      <Tiles<string> cols={3} value={String(g.panels)} onChange={(v) => set({ panels: Number(v) })}
        items={nums([2, 3, 4], g.panels).map((n) => ({ value: String(n), title: String(n) }))} />
      <Lbl>Поднимаются</Lbl>
      <Tiles<string> cols={up.length >= 3 ? 3 : 2} value={String(g.moving)} onChange={(v) => set({ moving: Number(v) })}
        items={up.map((n) => ({ value: String(n), title: `${n} нижн.`, sub: n === g.panels - 1 ? 'все, кроме верхнего' : undefined }))} />
      <Lbl>Привод</Lbl>
      <Tiles<string> cols={3} value={g.drive} onChange={(v) => set({ drive: v as Guillotine['drive'] })}
        items={Object.entries(GL_DRIVE_TITLE).map(([value, title]) => ({ value, title }))} />
      <Lbl>Стекло</Lbl>
      <Tiles<string> cols={3} value={g.glass} onChange={(v) => set({ glass: v as Guillotine['glass'] })}
        items={Object.entries(GL_GLASS_TITLE).map(([value, title]) => ({ value, title }))} />
      <Lbl>Стойки</Lbl>
      <Tiles<string> value={g.posts} onChange={(v) => set({ posts: v as Guillotine['posts'] })}
        items={[{ value: 'between', title: 'Между модулями' }, { value: 'none', title: 'Без стоек' }]} />
    </>
  );
}

// ---------------------------------------------------------------- форма рамы
type ShapePick = Shape | 'semi';
const SHAPE_PICKS: { value: ShapePick; title: string }[] = [
  { value: 'rect', title: 'Обычная' }, { value: 'arch', title: 'Арка' }, { value: 'semi', title: 'Полукруг' }, { value: 'circle', title: 'Круг' },
  { value: 'trapezoid', title: 'Трапеция' }, { value: 'bevel', title: 'Скос угла' }, { value: 'triangle', title: 'Треугольник' },
];
const sampleDoc = (shape: Shape, shape_params?: ShapeParams, w = 1000, h = 1000): Doc =>
  ({ kind: 'window', frame: { w, h, shape, shape_params, root: { cell: { type: 'fixed' } } } });
const SAMPLES: Record<ShapePick, Doc> = {
  rect: sampleDoc('rect', undefined, 800, 1000), arch: sampleDoc('arch', { rise: 260 }, 800, 1000), semi: sampleDoc('arch', { rise: 500 }, 1000, 500),
  circle: sampleDoc('circle'), trapezoid: sampleDoc('trapezoid', { h_left: 1000, h_right: 650 }, 900, 1000),
  bevel: sampleDoc('bevel', { corner: 'tl', dx: 300, dy: 300 }, 900, 1000), triangle: sampleDoc('triangle', { apex: 500 }, 1000, 800),
};

function ShapeSheet({ doc, prefix, onClose, onApply }: { doc: Doc; prefix: string | null; onClose: () => void; onApply: (c: Command[]) => void }) {
  const fi = prefix ? splitPath(prefix).frame : null;
  const frame: Frame | undefined = prefix === null ? undefined : fi === null ? doc.frame : asmFrames(doc)[fi];
  const cur = frame ? frameShape(frame) : null;
  const curPick: ShapePick = cur ? (cur.shape === 'arch' && frame && Math.abs(cur.params.rise! - frame.w / 2) < 2 && Math.abs(frame.h - frame.w / 2) < 2 ? 'semi' : cur.shape) : 'rect';
  const [pick, setPick] = useState<ShapePick>(curPick);
  const [rise, setRise] = useState(0);
  const [hiSide, setHiSide] = useState<'left' | 'right'>('left');
  const [low, setLow] = useState(0);
  const [corner, setCorner] = useState<'tl' | 'tr' | 'both'>('tl');
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [apex, setApex] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!frame || !cur) return;
    const p = cur.params, w = frame.w, h = frame.h;
    setPick(curPick); setErr(null);
    setRise(Math.round(cur.shape === 'arch' ? p.rise! : Math.min(w / 2, h) / 2));
    const hl = p.h_left ?? h, hr = p.h_right ?? Math.round(h * 0.7);
    setHiSide(hl >= hr ? 'left' : 'right'); setLow(Math.round(Math.min(hl, hr)));
    setCorner(p.corner ?? 'tl'); setDx(Math.round(p.dx ?? Math.min(w, h) / 4)); setDy(Math.round(p.dy ?? Math.min(w, h) / 4));
    setApex(Math.round(p.apex ?? w / 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix]);
  if (prefix === null || !frame) return <FormSheet visible={false} onClose={onClose}><View /></FormSheet>;
  const w = frame.w, h = frame.h;
  const path = prefix;
  const commands = (): Command[] => {
    const sz = (o: { w?: number; h?: number }): Command => ({ cmd: 'set_size', ...(path ? { path } : {}), ...o });
    const sh = (shape: Shape, params?: ShapeParams): Command => ({ cmd: 'set_shape', shape, ...(params ? { params } : {}), ...(path ? { path } : {}) });
    switch (pick) {
      case 'rect': return [sh('rect')];
      case 'arch': return [sh('arch', { rise })];
      // сначала прямоугольник: новая высота не должна спорить со старой формой
      case 'semi': return [sh('rect'), sz({ h: Math.floor(w / 2) }), sh('arch', { rise: Math.floor(w / 2) })];
      case 'circle': return [sh('rect'), ...(h !== w ? [sz({ h: w })] : []), sh('circle')];
      case 'trapezoid': return [sh('trapezoid', hiSide === 'left' ? { h_left: h, h_right: low } : { h_left: low, h_right: h })];
      case 'bevel': return [sh('bevel', { corner, dx, dy })];
      case 'triangle': return [sh('triangle', { apex })];
    }
  };
  const apply1 = () => {
    const c = commands();
    try { apply(doc, c); } catch (e) { setErr(e instanceof Error ? e.message : 'Не получилось'); return; }
    onApply(c);
  };
  const hint = pick === 'semi' ? `Высота станет ${num(Math.round(w / 2))} — половина ширины`
    : pick === 'circle' && h !== w ? `Высота станет ${num(w)} — как ширина` : pick === 'arch' ? `Подъём от 50 до ${num(Math.round(Math.min(w / 2, h)))} мм` : '';
  return (
    <FormSheet visible onClose={onClose} title={fi !== null ? `Форма рамы ${fi + 1}` : 'Форма рамы'}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
        {SHAPE_PICKS.map((it) => {
          const on = pick === it.value;
          return (
            <Pressable key={it.value} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => { setPick(it.value); setErr(null); }}
              style={({ pressed }) => [{ width: 92, borderRadius: 18, padding: 8, gap: 4, alignItems: 'center', backgroundColor: C.soft },
                on && { borderWidth: 2, borderColor: C.accent, padding: 6 }, pressed && { opacity: 0.8 }]}>
              <View style={{ height: 52, justifyContent: 'center' }}><Schema doc={SAMPLES[it.value]} width={56} maxHeight={50} dims={false} /></View>
              <Txt size={12} w={600} center lines={1}>{it.title}</Txt>
            </Pressable>
          );
        })}
      </ScrollView>
      {pick === 'arch' ? <NumField label="Подъём арки, мм" value={rise} onValue={setRise} /> : null}
      {pick === 'trapezoid' ? (
        <>
          <Seg<'left' | 'right'> style={st0.seg} value={hiSide} onChange={setHiSide} items={[{ value: 'left', title: 'Выше слева' }, { value: 'right', title: 'Выше справа' }]} />
          <NumField label={`Низкая сторона, мм (высокая — ${num(h)})`} value={low} onValue={setLow} />
        </>
      ) : null}
      {pick === 'bevel' ? (
        <>
          <Seg<'tl' | 'tr' | 'both'> style={st0.seg} value={corner} onChange={setCorner}
            items={[{ value: 'tl', title: 'Слева' }, { value: 'tr', title: 'Справа' }, { value: 'both', title: 'Оба — «дом»' }]} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <NumField label="Срез по ширине, мм" value={dx} onValue={setDx} />
            <NumField label="по высоте, мм" value={dy} onValue={setDy} />
          </View>
        </>
      ) : null}
      {pick === 'triangle' ? (
        <>
          <NumField label="Вершина от левого края, мм" value={apex} onValue={setApex} />
          <Choice<string> value={apex === 0 ? 'l' : apex === w ? 'r' : apex === Math.round(w / 2) ? 'c' : ''}
            onChange={(v) => setApex(v === 'l' ? 0 : v === 'r' ? w : Math.round(w / 2))}
            items={[{ value: 'l', title: 'Слева' }, { value: 'c', title: 'По центру' }, { value: 'r', title: 'Справа' }]} />
        </>
      ) : null}
      {hint ? <Note style={{ paddingHorizontal: 4 }}>{hint}</Note> : null}
      {err ? <Txt size={14} w={500} color={C.danger} style={{ paddingHorizontal: 4 }}>{err}</Txt> : null}
      <Button title="Применить" onPress={apply1} />
    </FormSheet>
  );
}

// ---------------------------------------------------------------- доп. профили (§9.3)
const ADDON_TITLE: Record<Addon['type'], string> = {
  extender: 'Расширитель', base_profile: 'Подставочный', frame_connector: 'Соединитель', cover_strip: 'Нащельник', canopy: 'Козырёк',
};
const SIDE_TITLE: Record<Addon['side'], string> = { top: 'сверху', bottom: 'снизу', left: 'слева', right: 'справа', all: 'по периметру' };
const ADDON_SIZES: Partial<Record<Addon['type'], number[]>> = { extender: [20, 40, 60, 100], canopy: [200, 300, 400, 500] };
const ADDON_SIDE: Record<Addon['type'], Addon['side']> = { extender: 'top', base_profile: 'bottom', frame_connector: 'left', cover_strip: 'all', canopy: 'top' };

function AddonsSheet({ visible, doc, onClose, onChange }: { visible: boolean; doc: Doc; onClose: () => void; onChange: (a: Addon[]) => void }) {
  const list = doc.addons ?? [];
  const [type, setType] = useState<Addon['type']>('extender');
  const [side, setSide] = useState<Addon['side']>('top');
  const [size, setSize] = useState(40);
  const pickType = (t: Addon['type']) => { setType(t); setSide(ADDON_SIDE[t]); const z = ADDON_SIZES[t]; if (z) setSize(z[1]); };
  const add = () => onChange([...list, { type, side, ...(ADDON_SIZES[type] ? { size_mm: size } : {}) }]);
  return (
    <FormSheet visible={visible} onClose={onClose} title="Доп. профили">
      {list.length ? (
        <View style={{ backgroundColor: C.soft, borderRadius: 18, overflow: 'hidden' }}>
          {list.map((a, i) => (
            <View key={i} style={[{ flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingLeft: 16, paddingRight: 4 }, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
              <Txt w={500} style={{ flex: 1 }}>{`${ADDON_TITLE[a.type]}${a.size_mm ? ` ${a.size_mm} мм` : ''} · ${SIDE_TITLE[a.side]}`}</Txt>
              <IconButton name="close" label="Убрать" onPress={() => onChange(list.filter((_, k) => k !== i))} />
            </View>
          ))}
        </View>
      ) : <Note style={{ paddingHorizontal: 4 }}>Расширители и подставочный увеличивают габарит изделия</Note>}
      <Choice<Addon['type']> value={type} onChange={pickType} items={(Object.keys(ADDON_TITLE) as Addon['type'][]).map((k) => ({ value: k, title: ADDON_TITLE[k] }))} />
      <Choice<Addon['side']> value={side} onChange={setSide} items={(Object.keys(SIDE_TITLE) as Addon['side'][]).map((k) => ({ value: k, title: SIDE_TITLE[k] }))} />
      {ADDON_SIZES[type] ? (
        <Choice<string> value={String(size)} onChange={(v) => setSize(Number(v))}
          items={ADDON_SIZES[type]!.map((v) => ({ value: String(v), title: `${v} мм` }))} />
      ) : null}
      {type === 'extender' && list.length === 0 ? <Note style={{ paddingHorizontal: 4 }}>На стороне со створкой расширитель мешает открыванию — проверьте</Note> : null}
      <Button title={`Добавить: ${ADDON_TITLE[type].toLowerCase()} ${SIDE_TITLE[side]}`} icon="plus" onPress={add} />
    </FormSheet>
  );
}

// ---------------------------------------------------------------- рольставни, жалюзи, решётка (§9.4)
function shutterText(d: Doc): string {
  const a = d.shutter ? (d.shutter.type === 'roller' ? 'рольставни' : 'жалюзи') : '';
  const b = d.grille ? 'решётка' : '';
  return [a, b].filter(Boolean).join(', ') || 'нет';
}
function ShutterSheet({ visible, doc, onClose, onChange }: { visible: boolean; doc: Doc; onClose: () => void; onChange: (p: Partial<Doc>) => void }) {
  const sh = doc.shutter ?? null, gr = doc.grille ?? null;
  return (
    <FormSheet visible={visible} onClose={onClose} title="Рольставни и решётка">
      <Txt size={14} color={C.muted} style={{ paddingHorizontal: 4 }}>Рольставни и жалюзи</Txt>
      <Choice<string> value={sh?.type ?? 'none'} onChange={(v) => onChange({ shutter: v === 'none' ? null : { type: v as Shutter['type'], control: sh?.control ?? 'manual' } })}
        items={[{ value: 'none', title: 'Нет' }, { value: 'roller', title: 'Рольставни' }, { value: 'blinds', title: 'Жалюзи' }]} />
      {sh ? (
        <Seg<Shutter['control']> style={st0.seg} value={sh.control} onChange={(c) => onChange({ shutter: { ...sh, control: c } })}
          items={[{ value: 'manual', title: 'Вручную' }, { value: 'electric', title: 'Электропривод' }]} />
      ) : null}
      <Txt size={14} color={C.muted} style={{ paddingHorizontal: 4, paddingTop: 4 }}>Решётка</Txt>
      <Choice<string> value={gr?.type ?? 'none'} onChange={(v) => onChange({ grille: v === 'none' ? null : { type: v as Grille['type'], pattern: gr?.pattern ?? 'straight' } })}
        items={[{ value: 'none', title: 'Нет' }, { value: 'fixed', title: 'Глухая' }, { value: 'opening', title: 'Распашная' }]} />
      {gr ? (
        <Seg<Grille['pattern']> style={st0.seg} value={gr.pattern} onChange={(p) => onChange({ grille: { ...gr, pattern: p } })}
          items={[{ value: 'straight', title: 'Прямая' }, { value: 'forged', title: 'Кованая' }]} />
      ) : null}
      <Note style={{ paddingHorizontal: 4 }}>Считается за м² изделия; электропривод — за штуку</Note>
    </FormSheet>
  );
}

// ---------------------------------------------------------------- лоджия (§9.5)
const CLADDING: Record<string, string> = { none: 'Нет', outside: 'Снаружи', inside: 'Внутри', both: 'С двух сторон' };
const PARAPET: Record<string, string> = { none: 'Нет', brick: 'Кирпич', metal: 'Металл' };
function loggiaText(l?: Loggia | null): string {
  if (!l) return 'не задано';
  return [l.outrigger_mm ? `вынос ${l.outrigger_mm}` : '', l.roof ? 'крыша' : '', l.cladding ? 'обшивка' : ''].filter(Boolean).join(', ') || 'без выноса';
}
function LoggiaSheet({ doc, onClose, onSave }: { doc: Doc; onClose: () => void; onSave: (l: Loggia) => void }) {
  const l = doc.loggia ?? {};
  const [out, setOut] = useState(l.outrigger_mm ?? 0);
  const [roof, setRoof] = useState(!!l.roof);
  const [clad, setClad] = useState<string>(l.cladding ?? 'none');
  const [parapet, setParapet] = useState<string>(l.parapet ?? 'none');
  return (
    <FormSheet visible onClose={onClose} title="Лоджия">
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <NumField label="Вынос остекления, мм" value={out} onValue={setOut} />
      </View>
      <Choice<string> value={String(out)} onChange={(v) => setOut(Number(v))} items={[0, 200, 300, 400].map((v) => ({ value: String(v), title: v ? `${v} мм` : 'Без выноса' }))} />
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 4 }}>
        <View style={{ flex: 1 }}><Txt w={500}>Крыша</Txt><Note>длина × (вынос + 500 мм)</Note></View>
        <Switch value={roof} onChange={setRoof} />
      </View>
      <Txt size={14} color={C.muted} style={{ paddingHorizontal: 4 }}>Обшивка парапета</Txt>
      <Choice<string> value={clad} onChange={setClad} items={Object.entries(CLADDING).map(([value, title]) => ({ value, title }))} />
      <Txt size={14} color={C.muted} style={{ paddingHorizontal: 4 }}>Парапет</Txt>
      <Choice<string> value={parapet} onChange={setParapet} items={Object.entries(PARAPET).map(([value, title]) => ({ value, title }))} />
      <Button title="Готово" onPress={() => onSave({
        outrigger_mm: out, roof, cladding: clad === 'none' ? null : clad as Loggia['cladding'], parapet: parapet === 'none' ? null : parapet as Loggia['parapet'],
      })} />
    </FormSheet>
  );
}

// ---------------------------------------------------------------- свой шаблон цеха (§9.7)
const TPL_CATS: { value: string; title: string }[] = [
  { value: 'window', title: 'Окна' }, { value: 'door', title: 'Двери' }, { value: 'balcony', title: 'Балкон' }, { value: 'sliding', title: 'Раздвижные' },
  { value: 'shaped', title: 'Фигурные' }, { value: 'muntins', title: 'С раскладкой' }, { value: 'corner', title: 'Угловые и эркеры' }, { value: 'facade', title: 'Витражи' },
  { value: 'guillotine', title: 'Терраса / гильотина' },
];
function guessCategory(d: Doc): string {
  if (d.kind === 'guillotine' || d.frame.root.guillotine || (isAssembly(d) && asmFrames(d).some((f) => f.root.guillotine))) return 'guillotine';
  if (d.kind === 'sliding' || d.frame.root.sliding) return 'sliding';
  if (isAssembly(d)) return 'corner';
  if (frameShape(d.frame).shape !== 'rect') return 'shaped';
  if (layout(d).cells.some((c) => c.cell.muntins)) return 'muntins';
  return d.kind === 'door' ? 'door' : d.kind === 'balcony_block' ? 'balcony' : 'window';
}
function SaveTemplateSheet({ doc, onClose, onSaved }: { doc: Doc; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(doc.room ? `${doc.room} ${doc.frame.w}×${doc.frame.h}` : '');
  const [short, setShort] = useState('');
  const [cat, setCat] = useState(guessCategory(doc));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    // в шаблон — конструкция и комплектация, без помещения, замеров и принятых предупреждений
    const { kind, frame, setup, addons, shutter, grille, loggia } = doc;
    const body = { name: name.trim(), short: short.trim() || undefined, category: cat, doc: { kind, qty: 1, frame, setup, addons, shutter, grille, loggia } };
    try { await api.post('/oyna/company/templates', body); onSaved(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <FormSheet visible onClose={onClose} title="Сохранить как шаблон">
      <Field label="Название" value={name} onChangeText={setName} placeholder="Кухня, 2 створки с фрамугой" style={{ backgroundColor: C.soft }} />
      <Field label="Коротко, на карточке" value={short} onChangeText={setShort} placeholder="не обязательно" maxLength={24} style={{ backgroundColor: C.soft }} />
      <Choice<string> value={cat} onChange={setCat} items={TPL_CATS} />
      {err ? <Txt size={14} w={500} color={C.danger} style={{ paddingHorizontal: 4 }}>{err}</Txt> : null}
      <Button title="Сохранить" onPress={() => void save()} disabled={!name.trim()} loading={busy} />
    </FormSheet>
  );
}
