/**
 * S06 Редактор позиции — макеты: Editor, EditorCell, EditorBlock, EditorIssues, EditorOffline (docs/design).
 * Каждое изменение — список команд (как в ядре). Онлайн — POST …/positions/{pos}/commands {commands, base_rev}:
 * ответ — позиция с нарушениями и ценой; 409 — лист «две версии». Без сети — те же команды на телефоне
 * (src/lib/tree.ts) + offline.savePosition, цена — «посчитаем, когда появится интернет».
 * Отмена/повтор — история документов на телефоне; откат уходит на сервер целым документом (PUT).
 */
import NetInfo from '@react-native-community/netinfo';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ComponentRef, useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError, errorText } from '@/api/http';
import type { Cell, Command, Doc, PositionOut, Violation } from '@/api/types';
import { num } from '@/lib/format';
import { apply, layout, partAt } from '@/lib/tree';
import { offline, uuid } from '@/offline/store';
import { C } from '@/theme';
import { Icon } from '@/ui/Icon';
import {
  Act, Body, Button, Card, Empty, Field, IconButton, LoadError, Loading, Note, Row, Screen, Seg, Sheet, Stepper, Switch, TopBar, Txt,
} from '@/ui/kit';
import { hlFromViolations, Schema } from '@/ui/Schema';
import {
  Ban, calcDoc, cellAt, cellSize, cellTitle, DotCanvas, fetchPosition, fixAction, FixAction, glassLabel, GlassPreset, OPEN_TITLE, openConflict,
  parentPath, Pill, plural, posStore, refs, shortDate, Soft, st, Tag, TextLink, TYPE_TITLE, useToast,
} from './parts';

type View3 = 'inside' | 'outside' | '3d';
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
  const [mode, setMode] = useState<'edit' | 'issues'>('edit');
  const [menu, setMenu] = useState(false);
  const [splitFor, setSplitFor] = useState<string | null>(null);
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
  const warns = vs.filter((v) => v.severity === 'warn' && !v.accepted);
  const room = doc.room || 'Позиция';
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
  const splitPress = () => {
    if (sel !== null) { setSplitFor(sel); return; }
    if (doc.frame.root.cell) { setSplitFor(''); return; }
    showToast('Выберите ячейку на схеме');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <DotCanvas />
        {/* .hdr */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, minHeight: 56 }}>
          <IconButton name="back" label="Назад" onPress={goBack} />
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Txt w={600} size={18} lines={1} style={{ flexShrink: 1 }}>{room}</Txt>
            {qty > 1 ? <Txt size={14} color={C.muted}>× {qty}</Txt> : null}
          </View>
          <View style={{ opacity: canUndo ? 1 : 0.4 }}><IconButton name="undo" label="Отменить" onPress={canUndo ? undo : undefined} /></View>
          <View style={{ opacity: canRedo ? 1 : 0.4 }}><IconButton name="redo" label="Повторить" onPress={canRedo ? redo : undefined} /></View>
          <IconButton name="more" label="Ещё" onPress={() => setMenu(true)} />
        </View>
        {isOffline ? (
          <View style={{ marginHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.dark }}>
            <Icon name="cloud_off" size={18} color="#fff" />
            <Txt size={13} w={500} color="#fff" style={{ flex: 1 }}>Нет интернета — всё сохраняется на телефоне</Txt>
          </View>
        ) : null}
        <View style={{ paddingTop: 4 }}>
          <Seg<View3> items={[{ value: 'inside', title: 'Схема' }, { value: 'outside', title: 'Снаружи' }, { value: '3d', title: '3D' }]}
            value={view} onChange={(v) => (v === '3d' ? showToast('3D — скоро') : setView(v))} style={{ width: 240 }} />
        </View>
        {errors.length || warns.length ? (
          <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingTop: 10 }}>
            {errors.length ? (
              <Pressable onPress={() => setMode('issues')}><Pill kind="err" title={`${errors.length} ${plural(errors.length, 'ошибка', 'ошибки', 'ошибок')}`} /></Pressable>
            ) : null}
            {warns.length ? (
              <Pressable onPress={() => setMode('issues')}><Pill kind="est" title={`${warns.length} ${plural(warns.length, 'предупреждение', 'предупреждения', 'предупреждений')}`} /></Pressable>
            ) : null}
          </View>
        ) : null}

        {/* поле схемы */}
        <Pressable style={{ flex: 1 }} onPress={() => setSelected(null)} accessible={false}
          onLayout={(e) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          {area.w > 0 && area.h > 0 ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 40 }}>
              <SchemaDims doc={doc} width={Math.max(120, area.w - 150)} maxHeight={Math.max(80, area.h - 110)} view={view}
                selected={sel} violations={vs} onCellPress={(p) => setSelected(p === sel ? null : p)} />
            </View>
          ) : null}
        </Pressable>

        {/* .bs — нижний лист */}
        <View style={[st.bs, { paddingBottom: Math.max(insets.bottom, 12) + 12 }]}>
          <View style={st.hdl}><View style={st.hdlBar} /></View>
          {sel !== null ? (
            <ScrollView style={{ maxHeight: win.height * 0.52 }} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              <CellPanel doc={doc} path={sel} presets={presets} onClose={() => setSelected(null)}
                commit={commit} commitLater={commitLater}
                onFill={() => (isLocal ? showToast('Стекло ячейки — когда позиция уйдёт на сервер') : goKit(sel))}
                onSplit={() => setSplitFor(sel)}
                onMerge={() => { const pp = parentPath(sel); commit([{ cmd: 'merge', path: pp }]); setSelected(pp); }} />
            </ScrollView>
          ) : firstErr ? (
            <>
              <Ban kind="err" title={`${firstErr.code} · ${firstErr.title}`} text={[firstErr.msg, firstErr.fix].filter(Boolean).join('. ')} style={{ marginBottom: 4 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 4 }}>
                <Txt size={14} color={C.muted}>Цена</Txt>
                {info?.total != null ? <Txt w={600} color={C.faint} style={{ textDecorationLine: 'line-through' }}>{num(info.total)}</Txt> : <Txt size={14} color={C.faint}>нет цены</Txt>}
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {fx ? (
                  <>
                    <Soft title="Подробнее" onPress={() => setMode('issues')} />
                    <Button title={fx.title} icon={fx.icon} onPress={() => doFix(fx)} style={{ flex: 1 }} />
                  </>
                ) : <Button title="Подробнее" onPress={() => setMode('issues')} style={{ flex: 1 }} />}
              </View>
            </>
          ) : (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 4, paddingTop: 4, paddingBottom: 10 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt size={14} color={C.muted} lines={1}>{room} · {num(doc.frame.w)} × {num(doc.frame.h)}{qty > 1 ? ` · × ${qty}` : ''}</Txt>
                  {isOffline ? (
                    <Txt w={500} color={C.muted}>посчитаем, когда появится интернет</Txt>
                  ) : info?.total != null ? (
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                      <Txt w={700} size={20} color={saving ? C.faint : C.ink} style={{ fontVariant: ['tabular-nums'] }}>{num(info.total)}</Txt>
                      <Txt size={14} color={C.muted}>сум{kitName ? ` · ${kitName}` : ''}</Txt>
                      {info.demo ? <Tag kind="est" title="ДЕМО" /> : null}
                    </View>
                  ) : (
                    <Txt w={500} color={C.muted}>{saving ? 'считаем…' : 'нет цены — проверьте прайс'}</Txt>
                  )}
                </View>
                {!isOffline && !isLocal ? <TextLink title="Комплектация" onPress={() => goKit()} /> : null}
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Soft title="Разделить" icon="window" onPress={splitPress} style={{ flex: 1 }} />
                <Soft title="3D" icon="layers" disabled={isOffline} onPress={() => showToast('3D — скоро')} style={{ flex: 1 }} />
              </View>
              <Button title="Расчёт" disabled={isOffline || isLocal} onPress={() => router.push(`/order/${id}/calc`)} />
            </>
          )}
        </View>
        {toast}
      </View>

      <SplitSheet path={splitFor} onClose={() => setSplitFor(null)}
        onSplit={(p, dir, n) => { setSplitFor(null); commit([{ cmd: 'split', path: p, dir, n }]); setSelected(p ? `${p}.0` : '0'); }} />
      <MoreSheet visible={menu} onClose={() => setMenu(false)} qty={qty} issues={vs.filter((v) => !v.accepted && v.severity !== 'hint' && v.severity !== 'auto_add').length}
        offline={isOffline || isLocal}
        onMirror={() => { setMenu(false); commit([{ cmd: 'mirror' }]); }}
        onQty={(n) => commitLater('qty', [{ cmd: 'set_qty', qty: n }])}
        onIssues={() => { setMenu(false); setMode('issues'); }}
        onKit={() => { setMenu(false); goKit(); }}
        onCalc={() => { setMenu(false); router.push(`/order/${id}/calc`); }}
        onCopy={() => void copyPosition()} />
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------- схема с размерными плашками (.dim)
function SchemaDims({ doc, width, maxHeight, view, selected, violations, onCellPress }: {
  doc: Doc; width: number; maxHeight: number; view: 'inside' | 'outside'; selected: string | null; violations: Violation[];
  onCellPress: (path: string) => void;
}) {
  const W = doc.frame.w, H = doc.frame.h, pad = 4;
  const k = Math.max(0.01, Math.min((width - 2 * pad) / W, (maxHeight - 2 * pad) / H));
  const vw = W * k + 2 * pad, vh = H * k + 2 * pad;
  const mirror = view === 'outside';
  const X = (x: number) => pad + (mirror ? W - x : x) * k;
  const Y = (y: number) => pad + y * k;
  const L = layout(doc);
  const hl = hlFromViolations(violations);
  const root = doc.frame.root;
  const sizes = root.parts ? L.sizes[''] ?? [] : [];
  const vertical = root.split !== 'h';
  const bad = (i: number) => Object.entries(hl).some(([p, s]) => s === 'block' && (p === String(i) || p.startsWith(`${i}.`)));
  const press = (i: number) => {
    const p = String(i);
    const c = L.cells.find((x) => x.path === p || x.path.startsWith(`${p}.`));
    if (c) onCellPress(c.path);
  };
  let acc = 0;
  return (
    <View style={{ width: vw, height: vh }}>
      <Schema doc={doc} width={vw} maxHeight={vh} dims={false} view={view} selected={selected} violations={violations} onCellPress={onCellPress} />
      {sizes.length > 1 && vertical ? sizes.map((s, i) => {
        const cx = (X(acc) + X(acc + s)) / 2; acc += s;
        return <Dim key={i} text={num(Math.round(s))} style={{ left: cx - 60, top: vh + 8 }} red={bad(i)} onPress={() => press(i)} />;
      }) : null}
      {sizes.length > 1 && !vertical ? sizes.map((s, i) => {
        const cy = (Y(acc) + Y(acc + s)) / 2; acc += s;
        return <Dim key={i} text={num(Math.round(s))} style={{ right: vw + 4, top: cy - 16, width: undefined, alignItems: 'flex-end' }} red={bad(i)} onPress={() => press(i)} />;
      }) : null}
      <Dim text={num(W)} style={{ left: vw / 2 - 60, top: vh + (sizes.length > 1 && vertical ? 48 : 8) }} />
      <Dim text={num(H)} style={{ left: vw + 6, top: vh / 2 - 16, width: undefined, alignItems: 'flex-start' }} />
    </View>
  );
}

function Dim({ text, style, red, onPress }: { text: string; style: object; red?: boolean; onPress?: () => void }) {
  return (
    <View pointerEvents="box-none" style={[{ position: 'absolute', width: 120, alignItems: 'center' }, style]}>
      <Pressable disabled={!onPress} onPress={onPress} style={[st.dim, red && { borderWidth: 2, borderColor: C.dangerLine }]}>
        <Txt size={15} w={600} color={red ? '#A1221A' : C.dim} style={{ fontVariant: ['tabular-nums'] }}>{text}</Txt>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------- панель ячейки (EditorCell)
function CellPanel({ doc, path, presets, onClose, commit, commitLater, onFill, onSplit, onMerge }: {
  doc: Doc; path: string; presets: GlassPreset[] | null; onClose: () => void;
  commit: (c: Command[]) => void; commitLater: (k: string, c: Command[]) => void;
  onFill: () => void; onSplit: () => void; onMerge: () => void;
}) {
  const cell = cellAt(doc, path);
  if (!cell) return null;
  const open = cell.type === 'sash' || cell.type === 'door_sash';
  const set = (props: Partial<Cell>) => commit([{ cmd: 'set_cell', path, ...props }]);
  const own = cell.fill?.kind === 'glass' ? cell.fill.glass : null;
  const fillText = cell.type === 'panel' && cell.fill?.kind !== 'glass'
    ? 'панель'
    : own ? `своё · ${glassLabel(own, presets)}` : `как у изделия${doc.setup?.glass ? ` · ${glassLabel(doc.setup.glass, presets)}` : ''}`;
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4, paddingBottom: 8 }}>
        <Txt w={700} size={20} style={{ flex: 1 }} lines={1}>{cellTitle(doc, path)}</Txt>
        <Txt size={14} color={C.muted} style={{ fontVariant: ['tabular-nums'] }}>{cellSize(doc, path)}</Txt>
        <IconButton name="close" label="Закрыть" onPress={onClose} bg={C.soft} />
      </View>
      <Seg<Cell['type']> style={st0.seg} value={cell.type} onChange={(t) => set({ type: t })}
        items={(['fixed', 'sash', 'door_sash', 'panel'] as const).map((t) => ({ value: t, title: TYPE_TITLE[t] }))} />
      {open ? (
        <>
          <Seg<string> style={st0.seg} value={cell.open ?? 'turn'}
            onChange={(o) => set(o === 'tilt' ? { open: 'tilt', hinge: 'bottom' } : { open: o as Cell['open'], ...(cell.hinge === 'bottom' || cell.hinge === 'top' ? { hinge: 'left' } : {}) })}
            items={['turn', 'tilt_turn', 'tilt'].map((o) => ({ value: o, title: OPEN_TITLE[o] }))} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {cell.open !== 'tilt' ? (
              <Seg<string> style={[st0.seg, { flex: 1 }]} value={cell.hinge === 'right' ? 'right' : 'left'} onChange={(h) => set({ hinge: h as Cell['hinge'] })}
                items={[{ value: 'left', title: 'Петли слева' }, { value: 'right', title: 'справа' }]} />
            ) : <View style={{ flex: 1 }} />}
            <Pressable accessibilityRole="button" accessibilityState={{ selected: !!cell.mosquito }} onPress={() => set({ mosquito: !cell.mosquito })}
              style={{ height: 46, borderRadius: 14, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: cell.mosquito ? C.dark : C.soft }}>
              <Txt size={15} w={500} color={cell.mosquito ? '#fff' : C.ink}>Москитка</Txt>
            </Pressable>
          </View>
        </>
      ) : null}
      <Pressable accessibilityRole="button" onPress={onFill} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: 6, paddingHorizontal: 4, gap: 10 }, pressed && { opacity: 0.7 }]}>
        <View style={{ flex: 1 }}>
          <Txt size={14} color={C.muted}>{cell.type === 'panel' ? 'Заполнение' : 'Стекло'}</Txt>
          <Txt w={500} lines={1}>{fillText}</Txt>
        </View>
        <Icon name="chevron" size={20} color="#B4B1AB" />
      </Pressable>
      {open ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 4 }}>
          <Txt w={500} style={{ flex: 1 }}>Ручка</Txt>
          <Switch value={cell.handle !== false} onChange={(v) => set({ handle: v })} />
        </View>
      ) : null}
      {path !== '' ? <PartSize doc={doc} path={path} commit={commit} commitLater={commitLater} /> : null}
      <View style={{ flexDirection: 'row', gap: 8, paddingTop: 4 }}>
        <Soft title="Разделить" icon="window" onPress={onSplit} style={{ flex: 1 }} small />
        {path !== '' ? <Soft title="Объединить" onPress={onMerge} style={{ flex: 1 }} small /> : null}
      </View>
    </>
  );
}
const st0 = { seg: { marginHorizontal: 0, backgroundColor: '#EDECE9' } };

/** Размер части: число мм, шаг ±5, «поровну» (FR-E4). Ввод уходит через 0,5 с после последней цифры. */
function PartSize({ doc, path, commit, commitLater }: { doc: Doc; path: string; commit: (c: Command[]) => void; commitLater: (k: string, c: Command[]) => void }) {
  const part = partAt(doc, path);
  const parent = parentPath(path);
  const idx = Number(path.slice(path.lastIndexOf('.') + 1));
  const L = layout(doc);
  const resolved = Math.round(L.sizes[parent]?.[idx] ?? 0);
  const fixed = typeof part?.size === 'number';
  let horizontal = false;
  try { horizontal = (parent === '' ? doc.frame.root : (partAt(doc, parent)?.node ?? doc.frame.root)).split === 'h'; } catch { /* корень */ }
  const [text, setText] = useState(String(resolved));
  const focused = useRef(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => { if (!focused.current) setText(String(resolved)); }, [resolved, path]);
  const key = `size:${path}`;
  const step = (d: number) => {
    const v = Math.max(5, (Number(text) || resolved) + d);
    setText(String(v));
    commitLater(key, [{ cmd: 'set_part_size', path, size: v }]);
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Field ref={input} label={`${horizontal ? 'Высота' : 'Ширина'} части, мм`} value={text} keyboardType="number-pad" maxLength={5}
          style={{ flex: 1, backgroundColor: C.soft }}
          onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}
          onChangeText={(t) => {
            const v = t.replace(/[^0-9]/g, '');
            setText(v);
            const n = Number(v);
            if (n > 0) commitLater(key, [{ cmd: 'set_part_size', path, size: n }]);
          }}
          right={!fixed ? <Txt size={13} color={C.faint}>поровну</Txt> : undefined} />
        <Act title="−5" onPress={() => step(-5)} />
        <Act title="+5" onPress={() => step(5)} />
      </View>
      {fixed ? (
        <View style={{ flexDirection: 'row' }}>
          <Act title="Поровну" onPress={() => { input.current?.blur(); commit([{ cmd: 'set_part_size', path, size: 'eq' }]); }} />
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- разделить на N
function SplitSheet({ path, onClose, onSplit }: { path: string | null; onClose: () => void; onSplit: (path: string, dir: 'v' | 'h', n: number) => void }) {
  const [dir, setDir] = useState<'v' | 'h'>('v');
  const [n, setN] = useState(2);
  return (
    <Sheet visible={path !== null} onClose={onClose} title="Разделить ячейку">
      <View style={{ paddingHorizontal: 12, gap: 12 }}>
        <Seg<'v' | 'h'> style={{ marginHorizontal: 0 }} value={dir} onChange={setDir}
          items={[{ value: 'v', title: 'Вертикально' }, { value: 'h', title: 'Горизонтально' }]} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[2, 3, 4].map((x) => (
            <Pressable key={x} onPress={() => setN(x)} style={{ flex: 1, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: n === x ? C.dark : C.card }}>
              <Txt w={600} color={n === x ? '#fff' : C.ink}>на {x}</Txt>
            </Pressable>
          ))}
        </View>
        <Card style={{ marginHorizontal: 0 }}>
          <Row first label="Частей" right={<Stepper value={n} onChange={setN} min={2} max={8} />} />
        </Card>
        <Button title={`Разделить на ${n}`} icon="window" onPress={() => path !== null && onSplit(path, dir, n)} />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- «Ещё»
function MoreSheet({ visible, onClose, qty, issues, offline: off, onMirror, onQty, onIssues, onKit, onCalc, onCopy }: {
  visible: boolean; onClose: () => void; qty: number; issues: number; offline: boolean;
  onMirror: () => void; onQty: (n: number) => void; onIssues: () => void; onKit: () => void; onCalc: () => void; onCopy: () => void;
}) {
  const [q, setQ] = useState(qty);
  useEffect(() => { if (visible) setQ(qty); }, [visible, qty]);
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Card>
        <Row first label="Количество" right={<Stepper value={q} min={1} max={99} onChange={(v) => { setQ(v); onQty(v); }} />} />
        <Row label="Зеркально" left={<Icon name="mirror" />} onPress={onMirror} chevron={false} />
        <Row label="Нарушения" left={<Icon name="warn" />} value={issues ? String(issues) : 'нет'} onPress={onIssues} />
        {!off ? <Row label="Комплектация" left={<Icon name="layers" />} onPress={onKit} /> : null}
        {!off ? <Row label="Расчёт" left={<Icon name="calc" />} onPress={onCalc} /> : null}
        <Row label="Копировать позицию" left={<Icon name="plus" />} onPress={onCopy} chevron={false} />
      </Card>
    </Sheet>
  );
}

// ---------------------------------------------------------------- EditorIssues
function Issues({ doc, vs, offline: off, room, order, pos, onBack, onPick, onFix, onCommand }: {
  doc: Doc; vs: Violation[]; offline: boolean; room: string; order: string; pos: string;
  onBack: () => void; onPick: (path?: string) => void; onFix: (fx: FixAction) => void; onCommand: (c: Command[]) => void;
}) {
  const errors = vs.filter(isErr);
  const warns = vs.filter((v) => v.severity === 'warn' && !v.accepted);
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

