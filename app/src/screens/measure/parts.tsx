/**
 * Общее для мастера замера (M1…M6, MSummary, MResume): мини-схема, прогресс, плашки, клавиатура .kp,
 * проверки ввода и габарит рамы без сети (та же логика, что oyna_core/measure.py), шаблоны T01…T11.
 */
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { G, Path, Rect } from 'react-native-svg';

import { ApiError, request } from '@/api/http';
import type { Cell, Doc, Measure, Node } from '@/api/types';
import { num } from '@/lib/format';
import { cells, isAssembly, isGuillotine, isShaped, isSliding, layout } from '@/lib/tree';
import { Schema } from '@/ui/Schema';
import { Icon, IconName } from '@/ui/Icon';
import { Button, IconButton, Txt } from '@/ui/kit';
import { C, TAG } from '@/theme';

// ---------- сеть: быстрый запрос с откатом на локальную логику ----------
let offlineUntil = 0;
/** Запрос к API с коротким таймаутом; нет сети → null (и 30 с больше не пробуем). Ошибки сервера пробрасываются. */
export async function tryApi<T>(path: string, o: { method?: string; body?: unknown; query?: Record<string, string | number> } = {}): Promise<T | null> {
  if (Date.now() < offlineUntil) return null;
  try {
    return await request<T>(path, { ...o, timeoutMs: 4000 });
  } catch (e) {
    if (e instanceof ApiError && e.isNetwork) { offlineUntil = Date.now() + 30_000; return null; }
    throw e;
  }
}

// ---------- проверки ввода (правила 1.1, 1.2, 1.6, 1.7) ----------
export type Issue = { code: string; severity: string; msg: string; fix?: string; field?: string };
const MAX = 3000, MIN = 300, GAP = 20, SKEW = 10;

export function checkLocal(v: number): Issue[] {
  if (!Number.isInteger(v) || v <= 0) return [{ code: '1.1', severity: 'block', msg: 'целое положительное число в мм' }];
  if (v > MAX) {
    const g = Math.floor(v / 10);
    return [{ code: '1.2', severity: 'block', msg: `${v} мм больше ${MAX} мм`, fix: g <= MAX ? `лишний ноль? ${g} мм` : 'проверьте число' }];
  }
  if (v < MIN) return [{ code: '1.7', severity: 'hint', msg: `${v} — похоже на сантиметры`, fix: `${v * 10} мм?` }];
  if (v % 5) return [{ code: '1.6', severity: 'warn', msg: `${v} не кратно 5 мм` }];
  return [];
}

/** GET /oyna/measure/check?value= ; без сети — та же логика на телефоне. */
export async function checkValue(v: number): Promise<Issue[]> {
  try {
    const r = await tryApi<{ value: number; issues: Issue[] }>('/oyna/measure/check', { query: { value: v } });
    if (r) return r.issues;
  } catch { /* 422 и пр. — считаем на телефоне */ }
  return checkLocal(v);
}

/** Рама = минимум замеров − 2 × зазор, вниз до 5 мм; перекос — разница замеров > порога. */
export function frameLocal(widths: number[], heights: number[], gap = GAP, skew = SKEW): Measure {
  const issues: Measure['issues'] = [];
  const w = Math.min(...widths) - 2 * gap, h = Math.min(...heights) - 2 * gap;
  for (const [name, arr] of [['ширине', widths], ['высоте', heights]] as const) {
    const d = Math.max(...arr) - Math.min(...arr);
    if (d > skew) issues.push({ code: 'M.skew', severity: 'warn', field: name, msg: `перекос проёма по ${name}: разница замеров ${d} мм (порог ${skew})`, fix: 'проверьте замер; рама считается по наименьшему' });
  }
  return { ok: true, frame_w: w - (w % 5), frame_h: h - (h % 5), opening_w: Math.min(...widths), opening_h: Math.min(...heights), gap_mm: gap, issues };
}

/** POST /oyna/measure/frame (зазор и порог перекоса цеха); без сети — frameLocal с зазором 20. */
export async function frameValue(widths: number[], heights: number[]): Promise<Measure> {
  try {
    const r = await tryApi<Measure>('/oyna/measure/frame', { method: 'POST', body: { widths, heights } });
    if (r && r.ok) return r;
  } catch { /* посчитаем на телефоне */ }
  return frameLocal(widths, heights);
}

/** Человеческий текст плашки по проверке ввода (M3SizeErr). */
export function issueBanner(i: Issue, v: number): { kind: 'err' | 'est'; title: string; body: string; action?: string; fixValue?: number } {
  switch (i.code) {
    case '1.2': {
      const g = Math.floor(v / 10);
      return g <= MAX
        ? { kind: 'err', title: 'Лишний ноль?', body: `${num(v)} мм — больше ${num(MAX)} мм (1.2)`, action: num(g), fixValue: g }
        : { kind: 'err', title: 'Слишком большое число', body: `Окон больше ${num(MAX)} мм не бывает (1.2)` };
    }
    case '1.7':
      return { kind: 'err', title: 'Похоже на сантиметры', body: `Окон уже ${MIN} мм не бывает (1.7)`, action: '× 10', fixValue: v * 10 };
    case '1.6':
      return { kind: 'est', title: 'Не кратно 5 мм', body: `${num(v)} — возможна опечатка (1.6)`, action: 'Оставить' };
    default:
      return { kind: 'err', title: 'Введите размер в мм', body: i.msg };
  }
}

// ---------- шаблоны (oyna_data/templates.json) — для деления без сети ----------
const TT = (open: Cell['open'], hinge: Cell['hinge'], mosquito: boolean): Cell => ({ type: 'sash', open, hinge, handle: true, mosquito });
export type Preset = { id: string; kind: Doc['kind']; w: number; h: number; root: Node };
export const PRESETS: Preset[] = [
  { id: 'T01', kind: 'window', w: 700, h: 1300, root: { cell: TT('tilt_turn', 'left', true) } },
  { id: 'T03', kind: 'window', w: 1400, h: 1300, root: { split: 'v', parts: [{ size: 'eq', cell: TT('tilt_turn', 'left', true) }, { size: 'eq', cell: { type: 'fixed' } }] } },
  { id: 'T04', kind: 'window', w: 1400, h: 1300, root: { split: 'v', parts: [{ size: 'eq', cell: TT('tilt_turn', 'left', true) }, { size: 'eq', cell: TT('turn', 'right', false) }] } },
  { id: 'T05', kind: 'window', w: 2100, h: 1400, root: { split: 'v', parts: [{ size: 'eq', cell: TT('tilt_turn', 'left', true) }, { size: 'eq', cell: { type: 'fixed' } }, { size: 'eq', cell: TT('turn', 'right', false) }] } },
  { id: 'T07', kind: 'window', w: 1400, h: 1900, root: { split: 'h', parts: [
    { size: 500, cell: { type: 'sash', open: 'tilt', hinge: 'bottom', handle: true, mosquito: false } },
    { size: 'eq', node: { split: 'v', parts: [{ size: 'eq', cell: TT('tilt_turn', 'left', true) }, { size: 'eq', cell: { type: 'fixed' } }] } }] } },
  { id: 'T09', kind: 'balcony_block', w: 2100, h: 2150, root: { split: 'v', parts: [
    { size: 750, cell: { type: 'door_sash', open: 'tilt_turn', hinge: 'left', handle: true, mosquito: true } },
    { size: 'eq', node: { split: 'h', parts: [{ size: 1400, cell: TT('tilt_turn', 'left', true) }, { size: 'eq', cell: { type: 'panel' } }] } }] } },
  { id: 'T10', kind: 'balcony_block', w: 2100, h: 2150, root: { split: 'v', parts: [
    { size: 'eq', node: { split: 'h', parts: [{ size: 1400, cell: TT('tilt_turn', 'right', true) }, { size: 'eq', cell: { type: 'panel' } }] } },
    { size: 750, cell: { type: 'door_sash', open: 'tilt_turn', hinge: 'right', handle: true, mosquito: true } }] } },
  { id: 'T11', kind: 'door', w: 900, h: 2100, root: { cell: { type: 'door_sash', open: 'turn', hinge: 'left', handle: true, mosquito: false } } },
];
export const presetsFor = (kind: Doc['kind']) => PRESETS.filter((p) => p.kind === kind);
export const presetDoc = (p: Preset, w = p.w, h = p.h): Doc => ({ kind: p.kind, qty: 1, frame: { w, h, shape: 'rect', root: JSON.parse(JSON.stringify(p.root)) }, extras: {}, accepted_warnings: [] });

// ---------- мини-схема (миниатюры макета: рама, створка, стекло, ручка, знак открывания) ----------
export function MiniSchema({ doc, width, height }: { doc: Doc; width: number; height: number }) {
  // фигурная рама, составное, раздвижное, гильотина и гильотинное окно (§11) — общей схемой без размеров
  if (doc.frame?.root && (isAssembly(doc) || isShaped(doc.frame) || isSliding(doc.frame) || isGuillotine(doc.frame)
    || cells(doc).some((c) => c.cell.open === 'vslide'))) return <Schema doc={doc} width={width} maxHeight={height} dims={false} />;
  const W = doc.frame.w || 1, H = doc.frame.h || 1;
  const k = Math.min((width - 4) / W, (height - 4) / H);
  const dw = W * k + 4, dh = H * k + 4;
  const fi = Math.max(3, Math.min(5, dw * 0.08)); // ширина рамы на рисунке
  const ix = 2 + fi, iy = 2 + fi, iw = dw - 4 - 2 * fi, ih = dh - 4 - 2 * fi;
  let L: ReturnType<typeof layout> | null = null;
  try { L = layout(doc); } catch { L = null; }
  const sw = (n: number) => Math.max(0.8, n * Math.min(1, dw / 52));
  return (
    <Svg width={dw} height={dh}>
      <Rect x={2} y={2} width={dw - 4} height={dh - 4} fill="#fff" stroke={C.ink} strokeWidth={sw(2.5)} />
      <Rect x={ix} y={iy} width={iw} height={ih} fill="none" stroke={C.ink} strokeWidth={sw(1.5)} />
      {(L?.cells ?? []).map(({ path, cell, box }) => {
        const x0 = ix + (box.x0 / W) * iw + 2, x1 = ix + (box.x1 / W) * iw - 2;
        const y0 = iy + (box.y0 / H) * ih + 2, y1 = iy + (box.y1 / H) * ih - 2;
        if (x1 - x0 < 2 || y1 - y0 < 2) return null;
        const open = cell.type === 'sash' || cell.type === 'door_sash';
        if (!open) {
          return <Rect key={path || 'r'} x={x0 + 1} y={y0 + 1} width={Math.max(0, x1 - x0 - 2)} height={Math.max(0, y1 - y0 - 2)}
            fill={cell.type === 'panel' ? '#D9D9D9' : '#DCE9F1'} stroke={C.ink} strokeWidth={sw(1)} />;
        }
        const gi = Math.min(4.5, (x1 - x0) / 4, (y1 - y0) / 4);
        const g = { x0: x0 + gi, y0: y0 + gi, x1: x1 - gi, y1: y1 - gi };
        const my = (g.y0 + g.y1) / 2, mx = (g.x0 + g.x1) / 2;
        const op = cell.open ?? 'turn', hinge = cell.hinge ?? 'left';
        const turn = (op === 'turn' || op === 'tilt_turn') && (hinge === 'left' || hinge === 'right');
        const tilt = op === 'tilt' || op === 'tilt_turn';
        const hh = Math.min(16, (y1 - y0) * 0.45);
        const hx = hinge === 'right' ? x0 - 1.5 : x1 - 1.5;
        return (
          <G key={path || 'r'}>
            <Rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="#fff" stroke={C.ink} strokeWidth={sw(1.5)} />
            <Rect x={g.x0} y={g.y0} width={Math.max(0, g.x1 - g.x0)} height={Math.max(0, g.y1 - g.y0)} fill="#DCE9F1" stroke={C.ink} strokeWidth={sw(1)} />
            {turn && g.x1 - g.x0 > 3 ? (
              <Path d={hinge === 'left' ? `M${g.x1} ${g.y0}L${g.x0} ${my}L${g.x1} ${g.y1}` : `M${g.x0} ${g.y0}L${g.x1} ${my}L${g.x0} ${g.y1}`}
                fill="none" stroke="#55524D" strokeWidth={sw(1.3)} strokeDasharray={op === 'tilt_turn' ? '5 4' : undefined} />
            ) : null}
            {tilt && g.x1 - g.x0 > 3 ? (
              <Path d={`M${g.x0} ${g.y0}L${mx} ${g.y1}L${g.x1} ${g.y0}`} fill="none" stroke="#55524D" strokeWidth={sw(1.3)} strokeDasharray="5 4" />
            ) : null}
            {cell.handle !== false && turn ? <Rect x={hx} y={my - hh / 2} width={3} height={hh} rx={1.5} fill={C.ink} /> : null}
            {cell.handle !== false && !turn && op === 'tilt' ? <Rect x={mx - hh / 2} y={y0 - 1.5} width={hh} height={3} rx={1.5} fill={C.ink} /> : null}
          </G>
        );
      })}
    </Svg>
  );
}

/** Плитка с мини-схемой (.tile в шапке мастера, 40×40, белая) */
export function SchemaTile({ doc, size = 40, onPress, bg = '#fff', radius = 14 }: { doc: Doc; size?: number; onPress?: () => void; bg?: string; radius?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Схема окна" disabled={!onPress} onPress={onPress}
      style={({ pressed }) => [{ width: size, height: size, borderRadius: radius, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 }]}>
      <MiniSchema doc={doc} width={size * 0.78} height={size * 0.72} />
    </Pressable>
  );
}

// ---------- прогресс .prog ----------
export function Progress({ step, total = 5, onPress }: { step: number; total?: number; onPress?: (i: number) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 20, paddingTop: 2 }} accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: total, now: step }}>
      {Array.from({ length: total }, (_, i) => (
        <Pressable key={i} accessibilityRole="button" accessibilityLabel={`Шаг ${i + 1}`} disabled={!onPress} onPress={() => onPress?.(i + 1)}
          hitSlop={{ top: 14, bottom: 14 }} style={{ flex: 1 }}>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: i + 1 < step ? C.accent : i + 1 === step ? C.accentMid : C.seg }} />
        </Pressable>
      ))}
    </View>
  );
}

// ---------- плашка .ban ----------
const BAN = {
  info: { bg: C.accentSoft, fg: '#154A99' }, err: { bg: C.errBg, fg: C.errFg }, est: { bg: C.estBg, fg: C.estFg },
  ok: { bg: C.okBg, fg: C.okFg }, n: { bg: C.card, fg: C.ink },
} as const;
export function Ban({ kind, icon, title, body, action, onAction, actionSoft, style }: {
  kind: keyof typeof BAN; icon?: IconName; title: ReactNode; body?: ReactNode; action?: string; onAction?: () => void; actionSoft?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const c = BAN[kind];
  return (
    <View style={[{ borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12, alignItems: actionSoft ? 'center' : 'flex-start', backgroundColor: c.bg }, style]}>
      {icon ? <View style={{ paddingTop: actionSoft ? 0 : 1 }}><Icon name={icon} size={20} color={c.fg} stroke={2.4} /></View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof title === 'string' ? <Txt size={16} w={600} color={c.fg} style={{ lineHeight: 21 }}>{title}</Txt> : title}
        {body ? (typeof body === 'string' ? <Txt size={14} color={c.fg} style={{ lineHeight: 19 }}>{body}</Txt> : body) : null}
      </View>
      {action ? (actionSoft ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={({ pressed }) => [st.softSm, { opacity: pressed ? 0.7 : 1 }]}>
          <Txt size={15} w={500}>{action}</Txt>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={8} style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center' }}>
          <Txt size={15} w={600} color={c.fg}>{action}</Txt>
        </Pressable>
      )) : null}
    </View>
  );
}

export function Tag({ kind = 'n', title }: { kind?: keyof typeof TAG; title: string }) {
  const c = TAG[kind];
  return (
    <View style={{ height: 24, paddingHorizontal: 9, borderRadius: 8, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' }}>
      <Txt size={13} w={600} color={c.fg}>{title}</Txt>
    </View>
  );
}

// ---------- шапка мастера .hdr ----------
export function WizardHeader({ title, onClose, doc, onSchema }: { title: string; onClose: () => void; doc?: Doc | null; onSchema?: () => void }) {
  return (
    <View style={st.hdr}>
      <IconButton name="close" label="Закрыть" onPress={onClose} />
      <Txt w={600} size={18} lines={1} style={{ flex: 1, minWidth: 0 }}>{title}</Txt>
      {doc ? <SchemaTile doc={doc} onPress={onSchema} /> : null}
    </View>
  );
}

// ---------- карточка ответа .optc ----------
export function OptCard({ children, on, onPress, style, disabled }: { children: ReactNode; on?: boolean; onPress?: () => void; style?: StyleProp<ViewStyle>; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on, disabled: !!disabled }} onPress={onPress}
      style={({ pressed }) => [st.optc, on && st.optcOn, disabled && { opacity: 0.55 }, { transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}>
      {children}
    </Pressable>
  );
}

// ---------- цифровая клавиатура .kp ----------
export function Keypad({ onDigit, onErase, onNext, nextTitle = 'Далее' }: { onDigit: (d: string) => void; onErase: () => void; onNext: () => void; nextTitle?: string }) {
  const insets = useSafeAreaInsets();
  const key = (label: string, onPress: () => void, fn = false) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [st.key, fn && { backgroundColor: C.keyFn }, { transform: [{ scale: pressed ? 0.97 : 1 }], opacity: pressed ? 0.85 : 1 }]}>
      <Txt size={fn ? 16 : 24} w={fn ? 600 : 500}>{label}</Txt>
    </Pressable>
  );
  return (
    <View style={[st.kp, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
        <View key={d} style={st.kpCell}>{key(d, () => onDigit(d))}</View>
      ))}
      <View style={st.kpCell}>{key('Стереть', onErase, true)}</View>
      <View style={st.kpCell}>{key('0', () => onDigit('0'))}</View>
      <View style={st.kpCell}><Button title={nextTitle} onPress={onNext} style={{ height: 50 }} /></View>
    </View>
  );
}

// ---------- короткое сообщение .toast ----------
export function useToast(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = useCallback((t: string) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 2200);
  }, []);
  const node = text ? (
    <View pointerEvents="none" style={st.toastWrap}>
      <View style={st.toast}><Txt size={15} color="#fff">{text}</Txt></View>
    </View>
  ) : null;
  return [node, show];
}

/** Ячейки-створки дерева (для «москитка на открывающуюся створку»). */
export const isOpening = (c: Cell) => c.type === 'sash' || c.type === 'door_sash';

/** Слово для заголовка «Кухня · окно 1». */
export const KIND_WORD: Record<Doc['kind'], string> = { window: 'окно', balcony_block: 'балконный блок', door: 'дверь', sliding: 'раздвижное', assembly: 'лоджия', guillotine: 'гильотина' };

export const st = StyleSheet.create({
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, minHeight: 56 },
  cap: { fontSize: 14, lineHeight: 19, color: C.muted },
  h1: { fontSize: 30, lineHeight: 36, letterSpacing: -0.75, paddingHorizontal: 20, paddingTop: 2, paddingBottom: 6 },
  optc: { borderRadius: 22, backgroundColor: C.card, padding: 14, gap: 10 },
  optcOn: { borderWidth: 2.5, borderColor: C.accent, padding: 11.5 },
  softSm: { height: 44, borderRadius: 999, backgroundColor: C.card, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  sheet: { backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' },
  kp: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: 6, paddingHorizontal: 5, backgroundColor: C.keypad },
  kpCell: { width: '33.333%', paddingHorizontal: 3, paddingVertical: 3 },
  key: { height: 50, borderRadius: 12, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', shadowColor: '#21201F', shadowOpacity: 0.18, shadowRadius: 0, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  toastWrap: { position: 'absolute', left: 12, right: 12, bottom: 110, alignItems: 'center' },
  toast: { borderRadius: 18, backgroundColor: C.dark, minHeight: 56, paddingHorizontal: 18, justifyContent: 'center', alignSelf: 'stretch' },
  stpBtn: { width: 44, height: 44, borderRadius: 14, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' },
});
