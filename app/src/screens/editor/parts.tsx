/**
 * Общее для группы «редактор / комплектация / замены»: мелкие детали макета (.tag, .ban, .optc, .ck, .soft, .cv),
 * лист поверх экрана для маршрутов-листов, кэш позиции между экранами группы, справочники, подписи и
 * отправка команд с обработкой конфликта версий (409).
 */
import { router, useFocusEffect } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, ScrollView, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Pattern, Rect } from 'react-native-svg';

import { api, ApiError, errorText } from '@/api/http';
import type { Calc, Cell, Command, Conflict, Doc, OrderFull, PositionOut, Setup, Shape, Violation } from '@/api/types';
import { lamination } from '@/lib/decors';
import { num } from '@/lib/format';
import { apply, cells, layout, nodeAt, parentOf } from '@/lib/tree';
import { offline } from '@/offline/store';
import { C, TAG } from '@/theme';
import { Icon, IconName } from '@/ui/Icon';
import { IconButton, Txt } from '@/ui/kit';

// ---------------------------------------------------------------- детали макета
/** .tag est/info/ok/n/err */
export function Tag({ kind = 'est', title }: { kind?: keyof typeof TAG; title: string }) {
  const t = TAG[kind] ?? TAG.n;
  return (
    <View style={[st.tag, { backgroundColor: t.bg }]}>
      <Txt size={13} w={600} color={t.fg}>{title}</Txt>
    </View>
  );
}

/** .st c-red / c-amber / c-gray — плашка статуса (короткая) */
export function Pill({ kind = 'n', title }: { kind?: keyof typeof TAG; title: string }) {
  const t = TAG[kind] ?? TAG.n;
  return (
    <View style={[st.pill, { backgroundColor: t.bg }]}>
      <Txt size={13} w={600} color={t.fg}>{title}</Txt>
    </View>
  );
}

const BAN = {
  err: { bg: C.errBg, fg: C.errFg }, est: { bg: C.estBg, fg: C.estFg }, info: { bg: C.accentSoft, fg: C.accentDeep },
  ok: { bg: C.okBg, fg: C.okFg },
} as const;
/** .ban err/est/info/ok: иконка, заголовок .bt, текст .bd */
export function Ban({ kind, title, text, icon = 'warn', style, children }: {
  kind: keyof typeof BAN; title: string; text?: string; icon?: IconName; style?: StyleProp<ViewStyle>; children?: ReactNode;
}) {
  const c = BAN[kind];
  return (
    <View style={[st.ban, { backgroundColor: c.bg }, style]}>
      <View style={{ marginTop: 1 }}><Icon name={icon} size={20} color={c.fg} stroke={2.3} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt size={16} w={600} color={c.fg}>{title}</Txt>
        {text ? <Txt size={14} color={c.fg}>{text}</Txt> : null}
        {children}
      </View>
    </View>
  );
}

/** .optc — карточка выбора (комплектация, версия) */
export function OptCard({ on, onPress, children, style, disabled }: {
  on?: boolean; onPress?: () => void; children: ReactNode; style?: StyleProp<ViewStyle>; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on, disabled: !!disabled }} disabled={disabled || !onPress} onPress={onPress}
      style={({ pressed }) => [st.optc, on && st.optcOn, { transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}>
      {children}
    </Pressable>
  );
}

/** .ck — квадратная отметка выбора */
export function Ck({ on }: { on?: boolean }) {
  return (
    <View style={[st.ck, on && st.ckOn]}>
      {on ? <Icon name="check" size={16} color="#fff" stroke={2.6} /> : null}
    </View>
  );
}

/** .soft — светлая кнопка-пилюля; inside — внутри белого листа (фон #F2F1EE) */
export function Soft({ title, icon, onPress, disabled, style, small, inside = true }: {
  title: string; icon?: IconName; onPress?: () => void; disabled?: boolean; style?: StyleProp<ViewStyle>; small?: boolean; inside?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [st.soft, { height: small ? 44 : 56, paddingHorizontal: small ? 14 : 18, backgroundColor: inside ? C.soft : C.card,
        opacity: disabled ? 0.45 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}>
      {icon ? <Icon name={icon} size={20} /> : null}
      <Txt size={small ? 15 : 17} w={500} lines={1}>{title}</Txt>
    </Pressable>
  );
}

/** .txt — текстовая ссылка-кнопка */
export function TextLink({ title, onPress, color = C.accentText }: { title: string; onPress?: () => void; color?: string }) {
  return (
    <Pressable accessibilityRole="link" onPress={onPress} hitSlop={6} style={({ pressed }) => [{ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.6 : 1 }]}>
      <Txt size={16} w={500} color={color}>{title}</Txt>
    </Pressable>
  );
}

/** Выбор одного из вариантов — строка светлых пилюль (выбранная тёмная), листается вбок. */
/** Варианты плиткой в N колонок — всё видно сразу, без листания вбок (на телефоне листание прятало половину вариантов). */
/** on — несколько выбранных сразу (например, подвижные полотна раздвижной); иначе выбран value. */
export function Tiles<T extends string>({ items, value, onChange, cols = 2, on: isOn }: {
  items: { value: T; title: string; sub?: string }[]; value: T | null; onChange: (v: T) => void; cols?: 2 | 3; on?: (v: T) => boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map((it) => {
        const on = isOn ? isOn(it.value) : it.value === value;
        return (
          <Pressable key={it.value} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(it.value)}
            style={({ pressed }) => ({
              flexBasis: cols === 3 ? '31%' : '48%', flexGrow: 1, minHeight: 52, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8,
              justifyContent: 'center', alignItems: 'center', backgroundColor: on ? C.dark : C.soft, opacity: pressed ? 0.8 : 1,
            })}>
            <Txt size={15} w={600} color={on ? '#fff' : C.ink} center lines={2}>{it.title}</Txt>
            {it.sub ? <Txt size={12} color={on ? '#E8E6E1' : C.muted} center lines={1}>{it.sub}</Txt> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Нижняя панель, которую тянут пальцем за шапку: свёрнута (только шапка) · половина · почти весь экран.
 * Тап по шапке — свернуть/развернуть. Под панелью — схема, она сжимается/растёт вместе с панелью.
 */
export function DragArea({ snaps, start = 1, header, children }: { snaps: [number, number, number]; start?: 0 | 1 | 2; header: ReactNode; children: ReactNode }) {
  const h = useRef(new Animated.Value(snaps[start])).current;
  const cur = useRef(snaps[start]);
  const from = useRef(0);
  useEffect(() => { const id = h.addListener(({ value }) => { cur.current = value; }); return () => h.removeListener(id); }, [h]);
  const go = (to: number) => Animated.spring(h, { toValue: to, useNativeDriver: false, speed: 20, bounciness: 0 }).start();
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => { h.stopAnimation(); from.current = cur.current; },
    onPanResponderMove: (_, g) => h.setValue(Math.max(snaps[0], Math.min(snaps[2], from.current - g.dy))),
    onPanResponderRelease: (_, g) => {
      const v = cur.current;
      let i = snaps.reduce((b, s, k) => (Math.abs(s - v) < Math.abs(snaps[b] - v) ? k : b), 0);
      if (g.vy < -0.6) i = Math.min(2, snaps.findIndex((s) => s > v + 4) === -1 ? 2 : snaps.findIndex((s) => s > v + 4));
      if (g.vy > 0.6) { const below = [...snaps].reverse().find((s) => s < v - 4); i = below === undefined ? 0 : snaps.indexOf(below); }
      go(snaps[i]);
    },
  })).current;
  const toggle = () => go(cur.current <= snaps[0] + 8 ? snaps[1] : snaps[0]);
  return (
    <Animated.View style={{ height: h, overflow: 'hidden' }}>
      <View {...pan.panHandlers}>
        <Pressable accessibilityRole="button" accessibilityLabel="Свернуть или развернуть панель" onPress={toggle}>
          <View style={st.hdl}><View style={st.hdlBar} /></View>
          {header}
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 16 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    </Animated.View>
  );
}

export function Choice<T extends string>({ items, value, onChange, style }: {
  items: { value: T; title: string }[]; value: T | null; onChange: (v: T) => void; style?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[{ flexGrow: 0 }, style]} contentContainerStyle={{ gap: 6 }}
      keyboardShouldPersistTaps="handled">
      {items.map((it) => {
        const on = it.value === value;
        return (
          <Pressable key={it.value} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(it.value)}
            style={({ pressed }) => [st.choice, { backgroundColor: on ? C.dark : C.soft, opacity: pressed ? 0.8 : 1 }]}>
            <Txt size={15} w={500} color={on ? '#fff' : C.ink}>{it.title}</Txt>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Нижний лист с полями ввода: поднимается над клавиатурой. */
export function FormSheet({ visible, onClose, children, title }: { visible: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable accessibilityLabel="Закрыть" style={{ flex: 1, backgroundColor: C.scrim }} onPress={onClose} />
        <View style={[st.bs, { paddingBottom: Math.max(insets.bottom, 16) + 4, maxHeight: '88%' }]}>
          <View style={st.hdl}><View style={st.hdlBar} /></View>
          {title ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4, paddingBottom: 4 }}>
              <Txt w={700} size={20} style={{ flex: 1 }} lines={1}>{title}</Txt>
              <IconButton name="close" label="Закрыть" onPress={onClose} bg={C.soft} />
            </View>
          ) : null}
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 10, paddingBottom: 4 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** .cv — поле схемы: серый фон с точками 18 px */
export function DotCanvas() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="cvdots" width={18} height={18} patternUnits="userSpaceOnUse">
            <Circle cx={9} cy={9} r={1.1} fill={C.canvasDot} />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill={C.canvas} />
        <Rect width="100%" height="100%" fill="url(#cvdots)" />
      </Svg>
    </View>
  );
}

/** Лист поверх предыдущего экрана (маршруты alternatives / swap / conflict — transparentModal): .scrim + .bs */
export function RouteSheet({ children, title, onClose, footer, full }: {
  children: ReactNode; title?: string; onClose?: () => void; footer?: ReactNode; full?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const close = onClose ?? (() => router.back());
  return (
    <View style={{ flex: 1 }}>
      <Pressable accessibilityLabel="Закрыть" style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]} onPress={close} />
      <View style={{ flex: 1 }} pointerEvents="box-none" />
      <View style={[st.bs, { paddingBottom: Math.max(insets.bottom, 16) + 8, maxHeight: '90%' }, full && { height: '88%' }]}>
        <View style={st.hdl}><View style={st.hdlBar} /></View>
        {title ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4, paddingBottom: 6 }}>
            <IconButton name="back" label="Назад" onPress={close} bg={C.soft} />
            <Txt w={600} size={18} lines={1} style={{ flex: 1 }}>{title}</Txt>
          </View>
        ) : null}
        <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 4 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
        {footer ? <View style={{ paddingTop: 10 }}>{footer}</View> : null}
      </View>
    </View>
  );
}

/** Короткое тёмное сообщение снизу (.toast) */
export function useToast(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((t: string) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 2600);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const node = text ? (
    <View pointerEvents="none" style={st.toastWrap}>
      <View style={st.toast}><Txt size={15} color="#fff">{text}</Txt></View>
    </View>
  ) : null;
  return [node, show];
}

// ---------------------------------------------------------------- кэш позиции между экранами группы
const key = (order: string, pos: string) => `${order}:${pos}`;
const cache = new Map<string, PositionOut>();
const kitNames = new Map<string, string | null>();
/** конфликт версий: тело 409 для листа «две версии» */
const conflicts = new Map<string, { server: Conflict['server']; mine: Doc; at: string }>();
/** позиции, которые редактору надо перечитать с сервера при возврате (после листа конфликта) */
const stale = new Set<string>();

export const posStore = {
  get: (order: string, pos: string) => cache.get(key(order, pos)),
  set: (order: string, p: PositionOut) => { cache.set(key(order, p.id), p); },
  kitName: (order: string) => kitNames.get(order) ?? null,
  setKitName: (order: string, name: string | null) => { kitNames.set(order, name); },
  conflict: (pos: string) => conflicts.get(pos),
  setConflict: (pos: string, server: Conflict['server'], mine: Doc) => { conflicts.set(pos, { server, mine, at: new Date().toISOString() }); },
  clearConflict: (pos: string) => { conflicts.delete(pos); },
  markStale: (order: string, pos: string) => { stale.add(key(order, pos)); },
  takeStale: (order: string, pos: string) => stale.delete(key(order, pos)),
};

/** Позиция с сервера (GET /oyna/orders/{id}) → в кэш. Возвращает и весь заказ. */
export async function fetchPosition(order: string, pos: string): Promise<{ pos: PositionOut | null; order: OrderFull }> {
  const o = await api.get<OrderFull>(`/oyna/orders/${order}`);
  posStore.setKitName(order, o.kit_name ?? o.order.kit_name ?? null);
  for (const p of o.positions) posStore.set(order, p);
  return { pos: o.positions.find((p) => p.id === pos) ?? null, order: o };
}

/** Позиция для листов и комплектации: из кэша редактора, иначе с сервера. */
export function usePosition(order: string, pos?: string) {
  const [p, setP] = useState<PositionOut | null>(pos ? posStore.get(order, pos) ?? null : null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!p);
  const reload = useCallback(async (force = false) => {
    if (!pos) { setLoading(false); return; }
    const c = posStore.get(order, pos);
    if (c && !force) { setP(c); setLoading(false); return; }
    setLoading(true);
    try {
      const r = await fetchPosition(order, pos);
      if (!r.pos) throw new ApiError(404, 'error', 'Позиция не найдена');
      setP(r.pos); setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [order, pos]);
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));
  const update = useCallback((np: PositionOut) => { posStore.set(order, np); setP(np); }, [order]);
  return { pos: p, error, loading, reload, update };
}

export class ConflictError extends Error {
  constructor() { super('Позицию изменили на другом устройстве'); }
}

/** 409 → запомнить обе версии и открыть лист «две версии». */
export function openConflict(order: string, pos: string, e: ApiError, mine: Doc) {
  const body = e.details as Partial<Conflict> | undefined;
  // «моя» — то, что видел человек на телефоне (сервер присылает свои данные + мои команды)
  if (body?.server) posStore.setConflict(pos, body.server, mine ?? (body.client as Doc));
  router.push(`/order/${order}/conflict?pos=${pos}`);
}

/** Команды позиции на сервер; ответ — новая позиция (нарушения, цена) → кэш. 409 → лист конфликта. */
export async function sendCommands(order: string, p: PositionOut, commands: Command[]): Promise<PositionOut> {
  try {
    const out = await api.post<PositionOut>(`/oyna/orders/${order}/positions/${p.id}/commands`, { commands, base_rev: p.rev });
    posStore.set(order, out);
    return out;
  } catch (e) {
    if (e instanceof ApiError && e.isConflict) {
      let mine = p.doc;
      try { mine = apply(p.doc, commands); } catch { /* команды не легли на телефоне — покажем исходную */ }
      openConflict(order, p.id, e, mine);
      throw new ConflictError();
    }
    throw e;
  }
}

/** Расчёт изделия без сохранения (POST /oyna/positions/calc). */
export const calcDoc = (doc: Doc) => api.post<Calc>('/oyna/positions/calc', { doc });

// ---------------------------------------------------------------- справочники (память на время работы приложения)
export type SystemRow = {
  code: string; brand: string; series: string; material: string; depth_mm?: number; chambers?: number; demo_passport?: boolean;
  glass_range_mm?: [number, number][]; fittings?: string[]; colors?: string[];
};
export type GlassPreset = { code: string; formula: string; thickness_mm: number; price_sum_m2: number | null; price_status: string; fits_system: boolean };
export type FittingSet = { code: string; title: string; openings?: string[]; max_sash_kg?: number };
export type Decor = { id: string; name_ru: string; hex?: string; kind?: string; available?: boolean };
export type GlassParse = {
  ok: boolean; formula?: string; thickness_mm?: number; glass_mm_total?: number; weight_kg_m2?: number; chambers?: number;
  price_sum_m2?: number | null; price_status?: string; how?: string; preset?: string | null; fits_system?: boolean; code?: string; error?: string;
};
export type AltOption = {
  value: string; label: string; total?: number | null; delta?: number | null; blocking?: string[]; demo?: boolean; complete?: boolean;
  current: boolean; is_default?: boolean; thickness_mm?: number; price_status?: string; material?: string; hex?: string;
};
export type AltResult = { what: string; path: string | null; base_total: number | null; options: AltOption[]; locked: AltOption[] };

const memo = new Map<string, Promise<unknown>>();
function once<T>(k: string, f: () => Promise<T>): Promise<T> {
  let p = memo.get(k) as Promise<T> | undefined;
  if (!p) { p = f(); memo.set(k, p); p.catch(() => memo.delete(k)); }
  return p;
}
export const refs = {
  systems: () => once('systems', () => api.get<SystemRow[]>('/oyna/systems')),
  glass: (system?: string) => once(`glass:${system ?? ''}`, () => api.get<GlassPreset[]>('/oyna/glass', { system })),
  decors: () => once('decors', () => api.get<Decor[]>('/oyna/decors')),
  fittings: (system?: string) => once(`fit:${system ?? ''}`, () => api.get<FittingSet[]>('/oyna/fitting-sets', { system })),
};

// ---------------------------------------------------------------- подписи
export const TYPE_TITLE: Record<Cell['type'], string> = { fixed: 'Глухая', sash: 'Створка', door_sash: 'Дверная', panel: 'Панель' };
export const OPEN_TITLE: Record<string, string> = {
  turn: 'Поворотная', tilt_turn: 'П-О', tilt: 'Откидная', sliding: 'Раздвижная', top_hung: 'Подвесное', pivot: 'Среднеподвесное',
  psk: 'PSK (параллельно-сдвижная)', hs: 'HS (подъёмно-сдвижная)', folding: 'Гармошка', vslide: 'Гильотинное',
};
export const SHAPE_TITLE: Record<Shape, string> = {
  rect: 'Обычная', arch: 'Арка', circle: 'Круг', trapezoid: 'Трапеция', bevel: 'Скос угла', triangle: 'Треугольник',
};
export const GLASS_DECOR_TITLE: Record<string, string> = {
  none: 'Нет', matte: 'Матовое', tinted: 'Тонированное', mirror: 'Зеркальное', pattern: 'Узорчатое', stained: 'Витраж',
};
export const TINT_TITLE: Record<string, string> = { bronze: 'бронза', grey: 'серый', blue: 'синий' };
/** «Тонированное · бронза» / «нет» */
export function glassDecorLabel(cell: Cell): string {
  const f = cell.fill?.kind === 'glass' ? cell.fill : null;
  if (!f?.decor) return 'нет';
  return `${GLASS_DECOR_TITLE[f.decor] ?? f.decor}${f.decor === 'tinted' ? ` · ${TINT_TITLE[f.tint ?? 'bronze'] ?? f.tint}` : ''}`;
}

// ---------------------------------------------------------------- цвет профиля и ламинация (shapes_contract §8)
export const PROFILE_COLOR_TITLE: Record<string, string> = {
  white: 'Белый', cream: 'Кремовый', brown: 'Коричневый', grey: 'Серый', anthracite: 'Антрацит', anodized: 'Анодированный',
};
export const profileColorLabel = (code?: string) =>
  !code ? 'Белый' : code.startsWith('ral:') ? `RAL ${code.slice(4)}` : PROFILE_COLOR_TITLE[code] ?? code;
/** «Золотой дуб» / «нет» — ламинация стороны (новые lam_* или старые color_*). */
export function lamLabel(setup: Setup | undefined, side: 'inside' | 'outside', decors?: Decor[] | null): string {
  const id = lamination(setup, side);
  if (!id) return 'нет';
  return decors?.find((d) => d.id === id)?.name_ru ?? id;
}

/** «Створка 1», «Глухая 2» — номер ячейки слева направо, сверху вниз (как в дереве). */
export function cellTitle(doc: Doc, path: string): string {
  const list = cells(doc);
  const i = list.findIndex((c) => c.path === path);
  if (i < 0) return 'Ячейка';
  return `${TYPE_TITLE[list[i].cell.type] ?? 'Ячейка'} ${i + 1}`;
}
/** Размер ячейки по осям: «700 × 1 400» */
export function cellSize(doc: Doc, path: string): string {
  const c = layout(doc).cells.find((x) => x.path === path);
  if (!c) return '';
  return `${num(Math.round(c.box.x1 - c.box.x0))} × ${num(Math.round(c.box.y1 - c.box.y0))}`;
}
export function cellAt(doc: Doc, path: string): Cell | null {
  try { return nodeAt(doc, path).cell ?? null; } catch { return null; }
}
/** родитель пути «0.1» → «0»; у частей корня — ''; «A1/0» → «A1/» */
export const parentPath = parentOf;

export const WHAT_TITLE: Record<string, string> = {
  system: 'Система', fittings: 'Фурнитура', glass: 'Стеклопакет', decor_out: 'Декор снаружи', decor_in: 'Декор внутри',
  'option:handle': 'Ручка', 'option:hinge': 'Петли', 'option:security': 'Противовзлом', 'option:extra_lock': 'Доп. запор',
  'option:hinge_cap': 'Накладки петель',
  profile_color: 'Цвет профиля', lam_out: 'Ламинация снаружи', lam_in: 'Ламинация внутри', glass_decor: 'Декор стекла',
  'option:child_lock': 'Детский замок', 'option:micro_vent': 'Микропроветривание', 'option:limiter': 'Ограничитель открывания',
  'option:comb': 'Гребёнка', 'supplier:glass': 'Поставщик стекла',
};

export const systemName = (s?: SystemRow | null, code?: string) => (s ? `${s.brand} ${s.series}`.trim() : code ?? '');
/** «60 мм · 4 камеры · штапик до 20 мм» */
export function systemSub(s?: SystemRow | null): string {
  if (!s) return '';
  const beads = (s.glass_range_mm ?? []).map((r) => r[1]).filter((x) => typeof x === 'number');
  return [s.depth_mm ? `${s.depth_mm} мм` : '', s.chambers ? `${s.chambers} ${plural(s.chambers, 'камера', 'камеры', 'камер')}` : '',
    beads.length ? `штапик до ${Math.max(...beads)} мм` : ''].filter(Boolean).join(' · ');
}
/** Код пресета или формула → «4-12-4i» */
export function glassLabel(spec: string | undefined, presets?: GlassPreset[] | null): string {
  if (!spec) return '';
  const p = presets?.find((g) => g.code === spec);
  if (p) return p.formula.split(' ')[0];
  if (/^g\d/.test(spec)) return spec.slice(1).split('_').join('-');
  return spec;
}
/** «Fornax (Yelken Group, Турция) — поворотно-откидная ПВХ» → [«Fornax (Yelken Group, Турция)», «поворотно-откидная ПВХ»] */
export function fittingLabel(f?: FittingSet | null, code?: string): [string, string] {
  if (!f) return [code ?? '', ''];
  const [a, ...b] = f.title.split(' — ');
  return [a, b.join(' — ')];
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
/** Разница в цене: «+38 000», «−1 240 000», «0» */
export function delta(n?: number | null): string {
  if (n === null || n === undefined) return '';
  if (Math.round(n) === 0) return '0';
  return n > 0 ? `+${num(n)}` : num(n);
}
/** 2026-11-18T14:02 → «18.11 · 14:02» */
export function stamp(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const shortDate = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- нарушения → действие исправления
export type FixAction = { title: string; icon?: IconName; commands?: Command[]; route?: string };

/** Кнопка исправления у нарушения (EditorBlock / EditorIssues): по коду правила и тексту fix с сервера. */
export function fixAction(v: Violation, doc: Doc, order: string, pos: string): FixAction | null {
  const path = v.path ?? (doc.frame.root.cell ? '' : undefined);
  const cell = path !== undefined ? cellAt(doc, path) : null;
  const fix = (v.fix ?? '').toLowerCase();
  // своё стекло «например, 6t-12-4» (4.7)
  const m = /например,?\s*([0-9][0-9a-z.\-]*)/i.exec(v.fix ?? '');
  if (m && cell && path !== undefined) {
    return { title: `Поставить ${m[1]}`, commands: [{ cmd: 'set_fill', path, fill: { kind: 'glass', glass: m[1] } }] };
  }
  // узкая откидная створка — ножниц нет: делаем поворотной (без откидывания), это решение на объекте
  if (v.code === '6.6' && cell && path !== undefined && (cell.open === 'tilt_turn' || cell.open === 'tilt')) {
    return { title: 'Сделать поворотной', icon: 'window', commands: [{ cmd: 'set_cell', path, open: 'turn' }] };
  }
  if (v.code === '6.10') {
    const first = cells(doc)[0];
    if (first) return { title: 'Сделать створкой', commands: [{ cmd: 'set_cell', path: first.path, type: 'sash' }] };
  }
  if (v.code === '9.1' && cell && path !== undefined) {
    return { title: 'Убрать сетку', commands: [{ cmd: 'set_cell', path, mosquito: false }] };
  }
  if (v.code === '6.3' && cell && path !== undefined) {
    return { title: 'Исправить петли', commands: [{ cmd: 'set_cell', path, hinge: cell.open === 'tilt' ? 'bottom' : 'left' }] };
  }
  if ((v.code === '4.6' || v.code === '4.9') && path !== undefined) {
    return { title: 'Выбрать стеклопакет', route: `/order/${order}/kit?pos=${pos}&path=${path}` };
  }
  if ((v.code === '3.1' || v.code.startsWith('7.') || v.code === '8.6')) {
    return { title: 'Сменить фурнитуру', route: `/order/${order}/alternatives?pos=${pos}&what=fittings` };
  }
  if ((fix.includes('раздел') || fix.includes('импост') || fix.includes('делени')) && cell && path !== undefined) {
    // «створка 1050×1400 мм …, предел 850×2400» → на сколько частей и в какую сторону
    const sz = /(\d+)×(\d+)\s*мм/.exec(v.msg ?? '');
    const lim = /предел\s*(\d+)×(\d+)/.exec(v.msg ?? '');
    const box = layout(doc).cells.find((c) => c.path === path)?.box;
    let dir: 'v' | 'h' = box && box.y1 - box.y0 > box.x1 - box.x0 ? 'h' : 'v';
    let n = 2;
    if (sz && lim) {
      const [w, h, mw, mh] = [sz[1], sz[2], lim[1], lim[2]].map(Number);
      if (w > mw) { dir = 'v'; n = Math.max(2, Math.ceil(w / mw)); } else if (h > mh) { dir = 'h'; n = Math.max(2, Math.ceil(h / mh)); }
    }
    // на 2 по ширине: не пополам (узкая створка не проходит по ножницам, 6.6), а створка пошире + глухая ≥ 400 мм
    if (n === 2 && dir === 'v' && box && sz && lim) {
      const outerW = box.x1 - box.x0;
      const over = outerW - Number(sz[1]);                       // рама/импост вокруг створки
      const sash = Math.round(Math.max(outerW / 2, Math.min(Number(lim[1]) + over, outerW - 400)) / 5) * 5;
      if (sash > outerW / 2 && outerW - sash >= 300) {
        const sizes: (number | 'eq')[] = [sash, 'eq'];   // створка остаётся первой частью (split), глухая — вторая
        return { title: 'Створка + глухая', icon: 'window', commands: [{ cmd: 'split', path, dir, n: 2, sizes }] };
      }
    }
    return { title: `Разделить на ${n}`, icon: 'window', commands: [{ cmd: 'split', path, dir, n }] };
  }
  return null;
}

/** Разница двух изделий короткими строками (лист «две версии»): «створка 3: П-О». */
export function docDiff(a: Doc, b: Doc): { mine: string[]; theirs: string[] } {
  const mine: string[] = [], theirs: string[] = [];
  const add = (x: string, y: string) => { mine.push(x); theirs.push(y); };
  if (a.frame.w !== b.frame.w || a.frame.h !== b.frame.h) add(`размер ${a.frame.w}×${a.frame.h}`, `размер ${b.frame.w}×${b.frame.h}`);
  if ((a.qty ?? 1) !== (b.qty ?? 1)) add(`× ${a.qty ?? 1}`, `× ${b.qty ?? 1}`);
  const ca = cells(a), cb = cells(b);
  const desc = (c?: Cell) => !c ? '—' : c.type === 'sash' || c.type === 'door_sash'
    ? `${OPEN_TITLE[c.open ?? 'turn'] ?? ''}${c.hinge === 'right' ? ', петли справа' : ''}${c.mosquito ? ', сетка' : ''}`
    : (TYPE_TITLE[c.type] ?? '').toLowerCase();
  if (ca.length !== cb.length) add(`частей: ${ca.length}`, `частей: ${cb.length}`);
  else {
    ca.forEach((x, i) => {
      const y = cb[i];
      const fa = x.cell.fill?.kind === 'glass' ? x.cell.fill.glass : '', fb = y.cell.fill?.kind === 'glass' ? y.cell.fill.glass : '';
      if (desc(x.cell) !== desc(y.cell) || x.cell.type !== y.cell.type) add(`${TYPE_TITLE[x.cell.type].toLowerCase()} ${i + 1}: ${desc(x.cell)}`, `${TYPE_TITLE[y.cell.type].toLowerCase()} ${i + 1}: ${desc(y.cell)}`);
      else if (fa !== fb) add(`часть ${i + 1}: ${fa || 'стекло изделия'}`, `часть ${i + 1}: ${fb || 'стекло изделия'}`);
    });
    const sa = JSON.stringify(layout(a).sizes), sb = JSON.stringify(layout(b).sizes);
    if (sa !== sb && !mine.length) add('другие размеры частей', 'другие размеры частей');
  }
  const ka = a.setup ?? {}, kb = b.setup ?? {};
  (['system', 'glass', 'fittings', 'profile_color', 'lam_out', 'lam_in', 'color_out', 'color_in'] as const).forEach((k) => {
    if ((ka[k] ?? '') !== (kb[k] ?? '')) add(`${SETUP_TITLE[k]}: ${ka[k] ?? 'по умолч.'}`, `${SETUP_TITLE[k]}: ${kb[k] ?? 'по умолч.'}`);
  });
  if ((a.room ?? '') !== (b.room ?? '')) add(a.room ?? '—', b.room ?? '—');
  return { mine, theirs };
}
const SETUP_TITLE = {
  system: 'система', glass: 'стекло', fittings: 'фурнитура', profile_color: 'цвет профиля', lam_out: 'ламинация снаружи', lam_in: 'ламинация внутри',
  color_out: 'снаружи', color_in: 'внутри',
} as const;

/** Офлайн-конфликт (после синхронизации) — из хранилища телефона. */
export async function offlineConflict(pos: string) {
  const snap = await offline.snapshot();
  return snap.conflicts[pos] ?? null;
}

// ---------------------------------------------------------------- стили
export const st = StyleSheet.create({
  tag: { height: 24, paddingHorizontal: 9, borderRadius: 8, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  pill: { height: 26, paddingHorizontal: 10, borderRadius: 9, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  ban: { borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  optc: { borderRadius: 22, backgroundColor: C.card, padding: 14, gap: 10 },
  optcOn: { borderWidth: 2.5, borderColor: C.accent, padding: 11.5 },
  ck: { width: 24, height: 24, borderRadius: 8, borderWidth: 2, borderColor: '#C9C6C0', alignItems: 'center', justifyContent: 'center' },
  ckOn: { backgroundColor: C.accent, borderColor: C.accent },
  soft: { borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  bs: { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 12, gap: 8,
    shadowColor: '#21201F', shadowOpacity: 0.1, shadowRadius: 24, shadowOffset: { width: 0, height: -4 }, elevation: 8 },
  hdl: { height: 22, alignItems: 'center', justifyContent: 'center' },
  hdlBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#D6D4CF' },
  dim: { height: 32, paddingHorizontal: 11, borderRadius: 16, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#21201F', shadowOpacity: 0.1, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  toastWrap: { position: 'absolute', left: 12, right: 12, bottom: 110, alignItems: 'stretch' },
  toast: { borderRadius: 18, backgroundColor: C.dark, minHeight: 56, paddingHorizontal: 18, paddingVertical: 12, justifyContent: 'center' },
  sheetBox: { backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' },
  choice: { height: 40, paddingHorizontal: 14, borderRadius: 20, justifyContent: 'center' },
  lbl: { paddingHorizontal: 8, paddingTop: 6 },
});
