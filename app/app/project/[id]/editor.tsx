/**
 * SCR-08 Редактор (Editor / EditorMin / EditorChat.dc.html, упрощённая раскладка после ревью 04.11): 3D — главное;
 * сверху «назад», название с меткой «оценка» и версией, «отменить»; ниже только «Вид» (меню: двери, разобрать, вечер,
 * стены) и AR; размеры — мелкие подписи у модели (янтарные — оценка, синие — замер), тап — клавиатура цифр с границами;
 * снизу белая шторка: инструменты «Деталь / Декор / Фурнитура / Раскрой» чипами, ввод и «Клиенту» (без суммы).
 * Три положения шторки (перетаскивание с пружиной, положение помнится по проекту): свёрнута — инструменты и ввод;
 * половина и полная — переписка (новое внизу), последняя правка с «Отменить» и вопрос ИИ последними; пустая половина —
 * низкая, с подсказками-чипами по типу изделия.
 * Вопросы ИИ: несколько — выбрать ответы (тап только выделяет) и «Отправить ответы» разом; один — тап отправляет.
 * Тап по детали (и в разобранном виде) — камера на неё, её длина / ширина / толщина линиями прямо на ней, остальные
 * «рентгеном», габарит изделия скрыт; в шторке — коротко: имя, номер, материал, кромка, распил. По фурнитуре — её
 * название. Тап по пустому месту 3D или «Собрать» — снять выбор (назад к габариту) / свернуть шторку.
 * «Вид → Размеры» — габаритные размеры вкл/выкл (помнится по пользователю); выключены — ввод размера всё равно
 * показывает свой размер.
 * Свайп «назад» на этом экране выключен: горизонтальный жест вращает модель (назад — кнопкой).
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PickResult, ViewerModel } from '@mebel/viewer';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Profiler, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { perfCount, perfProfiler } from '../../../src/dev/perf';
import { ActivityIndicator, Alert, Animated, Easing, ImageBackground, Keyboard, PanResponder, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions, type ScrollViewInstance, type TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../../src/api';
import { ApiError } from '../../../src/api/errors';
import { BudgetDeclinedError } from '../../../src/api/tasks';
import type { ChatMessage, ChatOut, DesignOut, DesignQuestion, EditOut, ModelStateOut, PartOut, PriceRange, ProductTree } from '../../../src/api/types';
import { checkDim, dimLimits, furnitureKind, quickValues, type DimKey, type Reason } from '../../../src/lib/dims';
import { displayTitle, sizeTitle } from '../../../src/lib/projectTitle';
import { useAiTask } from '../../../src/hooks/useAiTask';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDelta, formatRange, groupDigits, noCurrency, plural } from '../../../src/lib/format';
import { getAt, setAt } from '../../../src/lib/jsonPatch';
import { isEstimated, paramFields, withoutConfirmed, type ParamField } from '../../../src/lib/tree';
import { confirmPointer, loadMeta, useMeta } from '../../../src/state/projectMeta';
import { takeEvening } from '../../../src/state/evening';
import { useSession } from '../../../src/state/session';
import { frontScope } from '../../../src/lib/decorStyle';
import { isMasterEstimate, type LightingItem } from '../../../src/api/types';
import { useOffline } from '../../../src/state/net';
import { KitchenView } from '../../../src/screens/KitchenView';
import { DIM_ESTIMATED_COLOR, ProductCanvas, type AnyDimensionKey, type CanvasHandle, type DimensionLabelState, type HardwarePick } from '../../../src/three/ProductCanvas';
import { confirm, errorInfo, showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { haptics } from '../../../src/ui/haptics';
import { Button, IconButton, Loading, OfflineBanner, Press, SurfaceProvider, T, Tag, Toggle, resolveFont, toast, useReduceMotion } from '../../../src/ui/kit';
import { palette, type as ty } from '../../../src/ui/theme';

const SAVE_DEBOUNCE = 700;
/** SCR-08e: тёмный фон и точки «вечера». */
const NIGHT_BG = '#2A2B2C';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DOTS = require('../../../assets/dots.png');
type Snap = 'min' | 'half' | 'full';
/**
 * Высоты шторки (с нижним отступом 28 — его заменяет безопасная зона). Свёрнута: ручка 22 + инструменты 36 + 8 +
 * ввод 52 + 10 + «Клиенту» 52 + 28 + 6. Пустая половина — плюс строка подсказок.
 */
const SNAPS: Record<Snap, number> = { min: 214, half: 470, full: 660 };
const HALF_EMPTY = 214 + 52;
/** Половина с выбранной деталью / фурнитурой — низкая (коротко о детали), 3D крупнее; + строка кнопок фасада. */
const HALF_PICK = 214 + 8 + 104;
const PICK_BTNS = 48;
const KEYS_H = 540;
/** Шапка (72) и строка «Вид · AR» (40 + 4) от верхней безопасной зоны. */
const HDR_H = 72;
const ROW_TOP = 66;
const ROW_H = 40;
const SHEET_KEY = (id: string) => `editor.sheet.${id}`;
const HINT_KEY = (user: string) => `editor.hint.${user}`;
const DIMS_KEY = (user: string) => `editor.dims.${user}`;
/** Фасады — «Стиль фасада»; доборы и фальш-панели — «Встройка». */
const STYLE_ROLES = ['door', 'drawer_front', 'sliding_fill'];
const BUILTIN_ROLES = ['niche_filler', 'false_panel', 'filler_strip', 'plinth_side'];
const DONT_KNOW = 'не знаю';
/** мм: 0,4 / 16 / 1 196,5 */
const mmText = (n: number) => { const r = Math.round(n * 10) / 10; const [i, f] = String(r).split('.'); return groupDigits(Number(i)) + (f ? `,${f}` : ''); };
/** мм у линий на 3D — без разрядов, как габарит: 1800 / 447,8 */
const mmPlain = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** dev (?shot=half|min|full|keys): чат как в макете. */
const shotChat = (): ChatMessage[] => {
  const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  return [
    { id: 's1', author: 'ai', text: 'Собрано по фото', version_id: 'v1', undone: false, created_at: at(14, 31) },
    { id: 's2', author: 'ai', text: 'Фасады — «Дуб Сонома»', version_id: 'v2', undone: false, created_at: at(14, 33) },
    { id: 's3', author: 'master', text: 'Левую секцию шире на 100', undone: false, created_at: at(14, 35) },
    { id: 's4', author: 'ai', text: 'Левая секция шире', kind: '500 → 600 мм', version_id: 'v3', price_delta: { from: 0, to: 286_000 }, undone: false, created_at: at(14, 35) },
    { id: 's5', author: 'ai', text: 'Ручек на фото нет. Как открываем?', kind: 'Фасады шире 530 мм — поставил по 4 петли', options: ['Push-to-open', 'Gola', 'Скоба 128'], option_deltas: [0, 412_000, -96_000], undone: false, created_at: at(14, 36) },
  ];
};

/** dev (?shot=qs): два вопроса распознавания без ответа — карточка «выбрать и отправить разом». */
const SHOT_QS: DesignQuestion[] = [
  { id: 'q_ends', text: 'Торцы шкафа открытые (видно сбоку)?', options: ['Да, оба', 'Один открыт', 'Нет, в нише'], default: 'Да, оба' },
  { id: 'q_fronts', text: 'Какой материал фасадов?', options: ['Дуб сонома', 'Белый', 'Серый'], default: 'Дуб сонома' },
];

export default function Editor() {
  const { id, shot, ask, part: devPart, evening: devEvening, hint: devHint } = useLocalSearchParams<{ id: string; shot?: string; ask?: string; part?: string; evening?: string; hint?: string }>();
  const { t, td, lang } = useT();
  const offline = useOffline();
  const meta = useMeta(id);
  const canvas = useRef<CanvasHandle>(null);
  /** dev: «Применить» на клавиатуре размера со значением (замер плавности). */
  const devApply = useRef<(v: number) => void>(() => undefined);
  const ai = useAiTask();
  const insets = useSafeAreaInsets();
  const { height: H } = useWindowDimensions();
  const reduce = useReduceMotion();

  const model = useResource(() => api.getModel(id), [id]);
  const card = useResource(() => api.getProject(id), [id]);
  const chat = useResource<ChatOut>(() => api.getChat(id).catch(() => ({ messages: [] as ChatMessage[] })), [id]);
  const budget = useResource(() => api.aiBudget(id).catch(() => null), [id]);
  const [price, setPrice] = useState<PriceRange | null>(null);
  const [state, setState] = useState<ModelStateOut | null>(null);
  const [draft, setDraft] = useState<ProductTree | null>(null);
  const [saving, setSaving] = useState(false);
  const [openAll, setOpenAll] = useState(false);
  const [selected, setSelected] = useState<PickResult | null>(null);
  const [input, setInput] = useState('');
  const [localMsgs, setLocalMsgs] = useState<ChatMessage[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [keys, setKeys] = useState<DimKey | null>(null);
  const [entry, setEntry] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatScroll = useRef<ScrollViewInstance>(null);
  const userScrolled = useRef(false);
  const latestDraft = useRef<ProductTree | null>(null);
  const [exploded, setExploded] = useState(false);
  const [hw, setHw] = useState<HardwarePick | null>(null);
  // SCR-08e «Вечер»: подсветка включена, фон тёмный; приходит и после «Применить» на экране подсветки
  const [evening, setEvening] = useState(false);
  const { seesCost, user } = useSession();
  const [litCost, setLitCost] = useState<number | null>(null);
  useFocusEffect(useCallback(() => { if (takeEvening(id)) setEvening(true); }, [id]));
  useEffect(() => {
    if (!evening) return;
    const tm = setTimeout(() => canvas.current?.setLightsOn(true), 300);
    const tm2 = setTimeout(() => canvas.current?.setLightsOn(true), 1500);
    if (seesCost) api.getEstimate(id).then((e) => setLitCost(isMasterEstimate(e) ? e.lines.filter((l) => l.group === 'Подсветка').reduce((a, l) => a + l.cost, 0) : null)).catch(() => setLitCost(null));
    return () => { clearTimeout(tm); clearTimeout(tm2); };
  }, [evening, id, seesCost, state?.version.id]);
  useEffect(() => { if (__DEV__ && (devEvening === '1')) setEvening(true); }, [devEvening]);
  const [partInfo, setPartInfo] = useState<PartOut | null>(null);
  const selNum = useRef<number | null>(null);
  /** выбранные, но ещё не отправленные ответы на вопросы ИИ (id → вариант) */
  const [qPick, setQPick] = useState<Record<string, string>>({});
  const inputRef = useRef<TextInputInstance>(null);
  const [viewMenu, setViewMenu] = useState(false);
  const [roomOn, setRoomOn] = useState(true);

  // ----- подсказка «крутите модель»: один раз на пользователя, до первого касания 3D (или 8 с) -----
  const hintKey = HINT_KEY(user?.id ?? 'anon');
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (__DEV__ && devHint === '1') { setHint(true); return; }
    AsyncStorage.getItem(hintKey).then((x) => { if (!x) setHint(true); }).catch(() => undefined);
  }, [hintKey, devHint]);
  const hintRef = useRef(false);
  hintRef.current = hint;
  const hideHint = useCallback(() => {
    if (!hintRef.current) return;
    setHint(false);
    AsyncStorage.setItem(hintKey, '1').catch(() => undefined);
  }, [hintKey]);
  useEffect(() => { if (!hint) return; const tm = setTimeout(hideHint, 8000); return () => clearTimeout(tm); }, [hint, hideHint]);

  // ----- «Вид → Размеры»: габаритные размеры вкл/выкл, по пользователю (по умолчанию вкл) -----
  const dimsKey = DIMS_KEY(user?.id ?? 'anon');
  const [dimsOn, setDimsOn] = useState(true);
  useEffect(() => { AsyncStorage.getItem(dimsKey).then((x) => { if (x === '0') setDimsOn(false); }).catch(() => undefined); }, [dimsKey]);
  const toggleDims = useCallback((on: boolean) => {
    setDimsOn(on);
    AsyncStorage.setItem(dimsKey, on ? '1' : '0').catch(() => undefined);
  }, [dimsKey]);

  // пустая шторка (ни переписки, ни вопросов, ни правок) — половина низкая, только подсказки
  // 402 ai_budget_example — бюджет ИИ примеров цеха: пакет/Pro не помогают, это не баннер лимита, а сообщение ниже
  const aiLimited = (__DEV__ && shot === 'limit') || ai.error instanceof BudgetDeclinedError
    || (ai.error instanceof ApiError && ai.error.status === 402 && ai.error.code !== 'ai_budget_example');
  // запрос ИИ отклонён сразу (409 ai_busy, 429 часовой лимит цеха, 503 дневной, бюджет примера…) — в чат он не попал, говорим здесь
  useEffect(() => {
    if (!(ai.error instanceof ApiError) || aiLimited) return;
    const i = errorInfo(ai.error, lang);
    Alert.alert(i.title, i.text || undefined);
  }, [ai.error, aiLimited, lang]);
  const sheetEmpty = chat.data != null && !(chat.data.messages.length + localMsgs.length) && !ai.running && !evening && !aiLimited
    && !(state?.version.issues ?? []).some((i) => i.fixes.length) && !selected && !hw;
  // выбрана деталь / фурнитура — половина низкая; у фасада и добора — ещё строка кнопок
  const pickH = selected ? HALF_PICK + ([...STYLE_ROLES, ...BUILTIN_ROLES].includes(selected.role) ? PICK_BTNS : 0) : hw ? HALF_PICK - 30 : 0;

  // ----- шторка: три положения, пружина, память по проекту -----
  const pb = Math.max(insets.bottom, 16);
  const extra = pb - 28;
  const snapH = useCallback((s: Snap) => (s === 'half' && pickH ? pickH : s === 'half' && sheetEmpty ? HALF_EMPTY : SNAPS[s]) + extra, [extra, sheetEmpty, pickH]);
  const [snap, setSnap] = useState<Snap>('half');
  const [mode, setMode] = useState<Snap>('half');
  const h = useRef(new Animated.Value(SNAPS.half + extra)).current;
  const hNow = useRef(SNAPS.half + extra);
  useEffect(() => { const sub = h.addListener(({ value }) => { hNow.current = value; }); return () => h.removeListener(sub); }, [h]);
  const modeOf = useCallback((v: number) => (v < (snapH('min') + snapH('half')) / 2 ? 'min' : v < (snapH('half') + snapH('full')) / 2 ? 'half' : 'full'), [snapH]);
  const goSnap = useCallback((s: Snap, remember = true) => {
    userScrolled.current = false;
    setSnap(s);
    setMode(s);
    if (remember) AsyncStorage.setItem(SHEET_KEY(id), s).catch(() => undefined);
    const to = snapH(s);
    if (reduce) Animated.timing(h, { toValue: to, duration: 0, useNativeDriver: false }).start();
    else Animated.spring(h, { toValue: to, useNativeDriver: false, damping: 28, stiffness: 260, mass: 1, overshootClamping: false }).start();
  }, [h, id, reduce, snapH]);
  useEffect(() => {
    if (__DEV__ && shot) { const s = shot === 'empty' ? 'half' : (['min', 'half', 'full'] as Snap[]).find((x) => x === shot); if (s) goSnap(s, false); return; }
    AsyncStorage.getItem(SHEET_KEY(id)).then((v) => { if (v === 'min' || v === 'half' || v === 'full') goSnap(v, false); }).catch(() => undefined);
  }, [id, shot, goSnap]);
  const start = useRef(0);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => { h.stopAnimation(); start.current = hNow.current; Keyboard.dismiss(); },
    onPanResponderMove: (_, g) => {
      const v = Math.min(snapH('full') + 24, Math.max(snapH('min') - 24, start.current - g.dy));
      h.setValue(v);
      const m = modeOf(v);
      setMode((cur) => (cur === m ? cur : m));
    },
    onPanResponderRelease: (_, g) => {
      // куда «долетит» с учётом скорости — к ближайшему положению
      const projected = start.current - g.dy - g.vy * 160;
      const order: Snap[] = ['min', 'half', 'full'];
      const best = order.reduce((a, b) => (Math.abs(snapH(b) - projected) < Math.abs(snapH(a) - projected) ? b : a));
      if (best !== snap) haptics.light();
      goSnap(best);
    },
    onPanResponderTerminate: () => goSnap(snap),
  }), [goSnap, h, modeOf, snap, snapH]);
  const toggleSheet = () => goSnap(snap === 'min' ? 'half' : snap === 'half' ? 'full' : 'half');
  const snapRef = useRef(snap);
  snapRef.current = snap;
  // пустая половина и половина с деталью ниже обычной: при смене — к новой высоте
  const halfKey = `${sheetEmpty}|${pickH}`;
  const prevHalf = useRef(halfKey);
  useEffect(() => {
    if (prevHalf.current === halfKey) return;
    prevHalf.current = halfKey;
    if (snapRef.current === 'half') goSnap('half', false);
  }, [halfKey, goSnap]);
  // после первой отправки шторка всё ещё пуста — свернуть
  const collapseCheck = useRef(false);
  useEffect(() => {
    if (!collapseCheck.current || ai.running || chat.loading) return;
    collapseCheck.current = false;
    if (sheetEmpty && snapRef.current === 'half') goSnap('min');
  }, [sheetEmpty, ai.running, chat.loading, goSnap]);

  // ----- клавиатура (iOS): шторка поднимается так, что ввод — сразу над клавиатурой (цена уходит под неё) -----
  const kb = useRef(new Animated.Value(0)).current;
  const [kbH, setKbH] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return; // Android: окно само сжимается (adjustResize)
    const ease = Easing.bezier(0.17, 0.59, 0.4, 0.77);
    const show = Keyboard.addListener('keyboardWillShow', (e) => {
      const off = Math.max(0, e.endCoordinates.height - pb - 56);
      setKbH(off);
      if (snapRef.current === 'min') goSnap('half', false);
      Animated.timing(kb, { toValue: off, duration: e.duration || 250, easing: ease, useNativeDriver: false }).start();
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e) => {
      setKbH(0);
      Animated.timing(kb, { toValue: 0, duration: e.duration || 250, easing: ease, useNativeDriver: false }).start();
    });
    return () => { show.remove(); hide.remove(); };
  }, [kb, pb, goSnap]);

  useEffect(() => { loadMeta(id); }, [id]);
  useEffect(() => { if (model.data) { setState(model.data); setDraft(model.data.version.tree); } }, [model.data]);
  // dev (?shot=…): состояние как в макете — угловая кухня из образца ядра, у шкафа есть что отменить
  const shotPrepared = useRef(false);
  useEffect(() => {
    if (!__DEV__ || !shot || !model.data || shotPrepared.current) return;
    shotPrepared.current = true;
    if (shot === 'corner' && model.data.version.tree.layout !== 'corner') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SAMPLES } = require('../../../src/api/mock/data') as typeof import('../../../src/api/mock/data');
      api.saveModel(id, { tree: SAMPLES.kitchen_corner.tree, source: 'manual' }).then((m) => { setState(m); setDraft(m.version.tree); }).catch(() => undefined);
    } else if (shot !== 'corner' && !model.data.can_undo) {
      api.saveModel(id, { tree: model.data.version.tree, source: 'manual' }).then((m) => { setState(m); setDraft(m.version.tree); }).catch(() => undefined);
    }
  }, [model.data, shot, id]);
  useEffect(() => { setConfirmed([]); }, [state?.version.id]);
  useEffect(() => { if (card.data) setPrice(card.data.estimate?.total ?? null); }, [card.data]);
  useEffect(() => {
    if (!__DEV__ || !shot || shot === 'empty') return;
    const base = shotChat().slice(0, 4);
    setLocalMsgs(shot === 'qs' ? [...base, ...SHOT_QS.map((q, i) => ({ id: `sq${i}`, author: 'ai' as const, kind: 'question', text: q.text, options: q.options, undone: false, created_at: new Date().toISOString() }))] : shotChat());
    if (shot === 'qs') setQPick({ q_ends: 'Нет, в нише' });
  }, [shot]);
  // из «Детали» (SCR-25): «Форма детали» → готовое начало правки в поле чата
  useEffect(() => { if (ask) { setInput(ask); if (snap === 'min') goSnap('half'); setTimeout(() => inputRef.current?.focus(), 450); } }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps
  // dev: ?shot=keys | keys-height | keys-depth — клавиатура размера открыта
  useEffect(() => {
    if (!__DEV__ || !shot?.startsWith('keys') || !draft) return;
    const k = (shot.split('-')[1] ?? 'width') as DimKey;
    setKeys(k); setEntry(String(draft[k] ?? ''));
  }, [shot, draft == null]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshPrice = useCallback(async () => {
    try { setPrice((await api.getClientEstimate(id, 'total')).total); } catch { setPrice(null); }
  }, [id]);

  const applyState = (s: ModelStateOut) => {
    setState(s);
    setDraft(s.version.tree);
    setSelected(null);
    setPartInfo(null);
    selNum.current = null;
    refreshPrice();
  };

  // ----- сохранение правок (размеры с клавиатуры) -----
  const save = useCallback(async (tree: ProductTree) => {
    setSaving(true);
    try {
      try {
        applyState(await api.saveModel(id, { tree, source: 'manual', reject_on_errors: true }));
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'model_invalid' || e.status === 422) && e.code !== 'invalid_tree') {
          const ok = await confirm(t('err_rebuild_title'), `${e.message}\n\n${t('ed_save_with_errors')}`, t('save'), t('cancel'));
          if (ok) applyState(await api.saveModel(id, { tree, source: 'manual' }));
          else if (state) setDraft(state.version.tree);
        } else throw e;
      }
    } catch (e) {
      const info = errorInfo(e, lang);
      Alert.alert(info.title, info.text);
      if (state) setDraft(state.version.tree);
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, lang, state]);

  const editField = (f: ParamField, v: number | null) => {
    if (!draft) return;
    const next = setAt(draft, f.pointer, v);
    setDraft(next);
    latestDraft.current = next;
    confirmPointer(id, f.pointer);
    setConfirmed((c) => [...c, f.pointer]);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latestDraft.current && save(latestDraft.current), SAVE_DEBOUNCE);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // ----- отмена / повтор / исправления -----
  const run = async (fn: () => Promise<ModelStateOut>) => {
    setSaving(true);
    try { applyState(await fn()); chat.reload(); } catch (e) { showError(e, lang); } finally { setSaving(false); }
  };

  // ----- чат -----
  const sendAi = async (text: string) => {
    const instruction = text.trim();
    if (!instruction) return;
    setInput('');
    userScrolled.current = false;
    setSelected(null); setPartInfo(null); setHw(null); selNum.current = null;
    Keyboard.dismiss();
    collapseCheck.current = true;
    setLocalMsgs([{ id: `local-${Date.now()}`, author: 'master', text: instruction, undone: false, created_at: new Date().toISOString() }]);
    const r = await ai.run<EditOut>((c) => api.aiEdit(id, instruction, c));
    setLocalMsgs([]);
    budget.reload();
    await chat.reload();
    if (r?.version_id || r?.ok) {
      const m = await api.getModel(id).catch(() => null);
      if (m) applyState(m);
    }
  };

  // ----- ответы на вопросы ИИ: все разом -----
  const sendAnswers = async (qs: DesignQuestion[], picked: Record<string, string>) => {
    const all = Object.fromEntries(qs.map((q) => [q.id, picked[q.id] ?? DONT_KNOW]));
    setQPick({});
    userScrolled.current = false;
    setLocalMsgs([{ id: `local-${Date.now()}`, author: 'master', kind: 'answer', undone: false, created_at: new Date().toISOString(),
      text: qs.map((q) => `${q.text} — ${all[q.id] === DONT_KNOW ? `${t('q_default_mark')}${q.default ? ` (${q.default})` : ''}` : all[q.id]}`).join('\n') }]);
    const r = await ai.run<DesignOut>((c) => api.aiAnswer(id, all, c));
    setLocalMsgs([]);
    budget.reload();
    await chat.reload();
    if (r?.version_id) {
      const m = await api.getModel(id).catch(() => null);
      if (m) applyState(m);
    }
  };

  // ----- выбор детали / фурнитуры тапом по 3D (дверь/ящик открывает сам канвас) -----
  const clearPick = () => { setSelected(null); setPartInfo(null); setHw(null); selNum.current = null; };
  const tapPart = (p: PickResult | null) => {
    setHw(null);
    if (!p) {
      if (selected || hw) clearPick();
      else if (snap !== 'min' && !keys) goSnap('min');
      return;
    }
    if (selected?.number === p.number) { clearPick(); return; }
    setSelected(p);
    setPartInfo(null);
    selNum.current = p.number;
    if (snap === 'min') goSnap('half');
    api.getPart(id, p.number).then((x) => { if (selNum.current === x.number) setPartInfo(x); }).catch(() => undefined);
  };
  const tapHardware = (h: HardwarePick) => {
    clearPick();
    setHw(h);
    if (snap === 'min') goSnap('half');
  };
  // dev: выбрать деталь параметром ?part=N; хуки для снимков без тапов (eval в shot.sh)
  useEffect(() => {
    if (!__DEV__ || !state) return;
    if (devPart && !selected) {
      const vp = state.version.viewer.parts.find((x) => x.number === Number(devPart));
      if (vp) tapPart({ number: vp.number, key: vp.key, name: vp.name, role: vp.role, node: vp.node, point: [0, 0, 0], distance: 0 });
    }
    (globalThis as Record<string, unknown>).__editor = {
      focus: () => inputRef.current?.focus(),
      blur: () => Keyboard.dismiss(),
      tap: (x: number, y: number) => canvas.current?.tapAt(x, y),
      debug: () => toast.show(JSON.stringify(canvas.current?.debug())),
      openAll: () => canvas.current?.openAll(),
      explode: (on: boolean) => { canvas.current?.explode(on); setExploded(on); if (!on) clearPick(); },
      part: (n: number | null) => {
        const vp = n == null ? null : state.version.viewer.parts.find((x) => x.number === n);
        if (!vp) { clearPick(); return; }
        tapPart({ number: vp.number, key: vp.key, name: vp.name, role: vp.role, node: vp.node, point: [0, 0, 0], distance: 0 });
      },
      dims: (on: boolean) => toggleDims(on),
      snap: (x: Snap) => goSnap(x, false),
      entry: (x: string) => setEntry(x),
      keys: (k: DimKey | null, val?: string) => { setKeys(k); if (val) setEntry(val); },
      apply: (v: number) => devApply.current(v),
      menu: (on: boolean) => setViewMenu(on),
    };
  }, [state == null, devPart]); // eslint-disable-line react-hooks/exhaustive-deps

  if (model.loading && !state) return <Loading />;
  if (!state || !draft) {
    if (model.error instanceof ApiError && model.error.code === 'model_missing') {
      return <ErrorState error={new ApiError(409, 'model_missing', t('card_no_model'))} onRetry={() => router.replace(`/project/${id}/breakdown`)} />;
    }
    return <ErrorState error={model.error} onRetry={model.reload} />;
  }

  const v = state.version;
  // SCR-37/37b: кухня — свой экран (схема модулей вместо 3D-шторки)
  if (draft.type === 'kitchen') {
    const kitchenSend = async (text: string) => {
      const r = await ai.run<EditOut>((c) => api.aiEdit(id, text, c));
      chat.reload();
      if (r?.version_id || r?.ok) { const m = await api.getModel(id).catch(() => null); if (m) applyState(m); }
      const msg = r?.summary ?? r?.question ?? r?.error;
      if (msg) toast.show({ text: msg, tone: r?.ok ? 'success' : 'default' });
    };
    const widthField = (pointer: string): ParamField => ({ pointer, label: 'p_width', value: null, min: 150, max: 1200, step: 50 });
    return (
      <>
        <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
        <KitchenView id={id} tree={draft} busy={saving || ai.running} disabled={offline}
          title={[card.data?.title, card.data?.client?.name].filter(Boolean).join(' · ') || t('ed_title')}
          price={noCurrency(formatRange(price, lang))} onSend={kitchenSend}
          onWidth={(ptr, val) => editField(widthField(ptr), val)} onCornerSize={(ptr, val) => editField(widthField(ptr), val)}
          onModel={(m) => { applyState(m); chat.reload(); }} onError={(e) => showError(e, lang)} />
      </>
    );
  }
  const issues = v.issues ?? [];
  const disabled = offline;
  const estimated = withoutConfirmed(v.estimated ?? meta.estimated, confirmed);
  const messages = [...(chat.data?.messages ?? []), ...localMsgs];
  // последняя правка (с версией) — карточкой с «Отменить»; вопросы ИИ с вариантами — блоком, если они последние
  const lastChangeIdx = messages.map((m) => !!m.version_id && m.author === 'ai').lastIndexOf(true);
  const lastChange = lastChangeIdx >= 0 ? messages[lastChangeIdx] : null;
  const lastMsg = messages[messages.length - 1];
  // хвост переписки из вопросов ИИ (распознавание задаёт до 3 сразу)
  const tail: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].author === 'ai' && messages[i].kind === 'question'; i--) tail.unshift(messages[i]);
  const tailTexts = new Set(tail.map((m) => m.text));
  // вопросы распознавания без ответа (с id) — отвечаются разом через /ai/answer
  const designQs = (__DEV__ && shot === 'qs' ? SHOT_QS : chat.data?.questions ?? []).filter((q) => tailTexts.has(q.text));
  const question = !designQs.length && lastMsg && lastMsg.author === 'ai' && lastMsg.options?.length ? lastMsg : null;
  const inCard = new Set<ChatMessage>([...(designQs.length ? tail.filter((m) => designQs.some((q) => q.text === m.text)) : []), ...(question ? [question] : [])]);
  const issue = issues.find((i) => i.fixes.length) ?? null;
  const history = messages.filter((m) => m !== lastChange && !inCard.has(m));
  const today = new Date().toDateString();
  const editsToday = messages.filter((m) => m.author === 'ai' && m.version_id && new Date(m.created_at).toDateString() === today).length;

  // SCR-08d: ИИ-бюджет проекта исчерпан (мастер не стал списывать ещё проект или лимит кончился) — правки текстом закрыты
  const textOff = disabled || aiLimited;
  // тип изделия — для границ размеров, быстрых значений и подсказок
  const kind = furnitureKind(draft, meta.design?.product_kind);
  const kindLabel = kind === 'other' ? t('ed_title') : td(`pk_${kind}`, t('ed_title'));
  const title = displayTitle(card.data?.title, sizeTitle(kindLabel, [draft.width, draft.depth, draft.height]), card.data?.client?.name);
  const sub = card.data?.is_example ? t('example_badge') : t(saving ? 'ed_saving' : 'ed_saved', { n: v.number });
  const dimVal = (k: DimKey) => getAt(draft, `/${k}`) as number | null | undefined;
  const dimEst = (k: DimKey) => isEstimated(`/${k}`, estimated);
  // линии оценённых размеров — янтарные, как и подписи; замеренные — синие (по умолчанию)
  const dimColors = Object.fromEntries((['width', 'height', 'depth'] as const).filter(dimEst).map((k) => [k, DIM_ESTIMATED_COLOR]));
  const anyEst = (['width', 'height', 'depth'] as DimKey[]).some((k) => dimVal(k) && dimEst(k));
  const sheetH = keys ? KEYS_H + extra : snapH(snap);
  // 3D — от верха экрана до шторки / клавиатуры цифр (под шапкой модель видна при вращении); изделие вписывается
  // в свободную область под строкой «Вид · AR» (в полном чате и при вводе размера — под шапкой).
  // Поля под размерные линии канвас добавляет сам; в тесной области (половина с вопросом, ввод размера) отступ меньше.
  // Высота канваса постоянна (до самой низкой шторки), шторка и клавиатура — отступ снизу свободной области: смена
  // размера GL-канваса пересоздаёт буфер кадра и сбивает анимацию камеры (рывок при открытии клавиатуры / смене шторки).
  const full = mode === 'full' && !keys;
  const showRow = !full && !keys;
  const canvasTop = insets.top + (showRow ? ROW_TOP + ROW_H : HDR_H);
  const canvasH = Math.max(60, H - sheetH - kbH - canvasTop);
  const canvasFullH = Math.max(canvasTop + canvasH, H - snapH('min'));
  const freeArea = { top: canvasTop, bottom: canvasFullH - canvasTop - canvasH, left: 0, right: 0 };
  const freePad = canvasH < 300 ? 12 : 28;
  const showTools = mode !== 'full' && !kbH;
  const fieldFor = (k: DimKey) => paramFields(draft).find((f) => f.pointer === `/${k}`) ?? null;
  const limitsFor = (k: DimKey) => dimLimits(draft, kind, k);
  const openKeys = (k: DimKey) => {
    if (disabled || !fieldFor(k)) return;
    hideHint();
    setKeys(k);
    setEntry(String(dimVal(k) ?? ''));
    Keyboard.dismiss();
  };
  const reasonText = (r: Reason) => t(r.key, r.params);
  // ошибка ввода — сразу при наборе; «мало» — только когда цифр уже не меньше, чем у минимума
  const keyLim = keys ? limitsFor(keys) : null;
  const entryN = Number(entry);
  const entryErr = keyLim && entry ? checkDim(keyLim, entryN) : null;
  const keyErr = entryErr && (entryN > keyLim!.max || entry.length >= String(keyLim!.min).length) ? reasonText(entryErr) : null;
  const applyKeys = () => {
    const f = keys ? fieldFor(keys) : null;
    if (!f || !entryN || keyErr) return;
    if (entryN !== dimVal(keys!)) editField(f, entryN);
    setKeys(null);
  };
  if (__DEV__) devApply.current = (val) => { const f = keys ? fieldFor(keys) : null; if (f && val !== dimVal(keys!)) editField(f, val); setKeys(null); };
  const tools = [
    ['ed_tool_part', () => (selected ? router.push({ pathname: '/project/[id]/element', params: { id, n: String(selected.number) } }) : toast.show(t('ed_tap_part')))],
    ['ed_tool_decor', () => router.push(`/project/${id}/materials`)],
    ['ed_tool_hw', () => router.push(`/project/${id}/hardware`)],
    ['ed_tool_cut', () => router.push(`/project/${id}/cutting`)],
  ] as const;
  // подсказки-чипы: пока мастер ничего не писал и нет вопросов (тап — сразу в чат)
  const suggestions = !messages.some((m) => m.author === 'master') && !designQs.length && !question && !issue && !ai.running && !aiLimited && !evening
    ? t(`ed_sug_${kind}` as 'ed_sug_other').split('|') : [];
  const lights = !!v.viewer.lights?.length;
  const room = !!v.viewer.room;

  // размеры — линии «как на чертеже» рисует канвас; подписи наши: янтарные — оценка, синие — замер;
  // вводимый — крупная синяя плашка, остальные на это время скрыты
  const renderDim = (key: AnyDimensionKey, _a: unknown, st: DimensionLabelState) => {
    if (full) return null;
    // размер выбранной детали — на ней, синий, без ввода (правка детали — словами в чат)
    if (st.part) {
      return (
        <View style={[s.dimL, s.dimPart]} accessible accessibilityLabel={`${t(`ed_part_${key}` as 'ed_part_length')} ${mmPlain(st.valueMm)} ${t('mm')}`}>
          <T num style={{ fontSize: 13, lineHeight: 16, fontWeight: '700', color: palette.blue }}>{mmPlain(st.valueMm)}</T>
        </View>
      );
    }
    const k = key as DimKey;
    const val = dimVal(k) ?? Math.round(st.valueMm);
    if (!val || st.muted) return null;
    if (st.focused) {
      return (
        <View style={[s.dimL, s.dimOn]}>
          <T num style={{ fontSize: 14, fontWeight: '700', color: palette.white }}>{val}</T>
          <T style={{ fontSize: 13, fontWeight: '600', color: palette.white, opacity: 0.75 }}>{t('mm')}</T>
        </View>
      );
    }
    const est = dimEst(k);
    return (
      <Press onPress={() => openKeys(k)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`${t(`ed_kb_${k}`)} ${val}${est ? `, ${t('estimate_mark')}` : ''}`}
        style={[s.dimL, est ? s.dimEst : null]}>
        <T num style={{ fontSize: 13, lineHeight: 16, fontWeight: '700', color: est ? palette.amberDeep : palette.blue }}>{val}</T>
      </Press>
    );
  };

  const viewRow = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress?: () => void, right?: ReactNode) => (
    <Press feedback="row" onPress={onPress} disabled={!onPress} accessibilityRole={right ? undefined : 'button'} style={s.mRow}>
      <Ionicons name={icon} size={20} color={palette.ink} />
      <T style={{ flex: 1, fontSize: 15, fontWeight: '500' }} numberOfLines={1}>{label}</T>
      {right}
    </Press>
  );
  const closeMenu = (fn: () => void) => () => { setViewMenu(false); fn(); };

  if (__DEV__) perfCount('editor.body');
  return (
    <Profiler id="editor" onRender={perfProfiler}>
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      {/* свайп «назад» выключен: горизонтальный жест по 3D вращает модель, назад — кнопкой в шапке */}
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false, fullScreenGestureEnabled: false }} />
      {/* .cv — точки под 3D, приглушённые: спокойный фон */}
      <ImageBackground source={DOTS} resizeMode="repeat" style={StyleSheet.absoluteFill} imageStyle={{ resizeMode: 'repeat', opacity: 0.35 }} />
      {evening ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: NIGHT_BG }]} pointerEvents="none">
          <ImageBackground source={DOTS} resizeMode="repeat" style={StyleSheet.absoluteFill} imageStyle={{ resizeMode: 'repeat', opacity: 0.1 }} />
          {/* тёплое пятно от подсветки: концентрические слои вместо радиального градиента */}
          {[460, 420, 380, 340, 300, 260, 220, 180, 140].map((d) => (
            <View key={d} style={[s.glow, { top: canvasTop + canvasH * 0.38 - d / 2, width: d, height: d, borderRadius: d / 2, marginLeft: -d / 2 }]} />
          ))}
        </View>
      ) : null}
      {/* 3D на весь экран: модель — в свободной области, при вводе размера — чертёж (ортогональ) на этот размер;
          первое вращение / щипок / тап прячет подсказку */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: canvasFullH }}>
        <ProductCanvas ref={canvas} model={v.viewer} onPartTap={(p) => { hideHint(); tapPart(p); }} onHardwareTap={tapHardware} selectedPart={selected?.number ?? null} showDims={false} busy={saving || ai.running}
          fallbackText={t('ed_3d_unavailable')} transparent freeArea={freeArea} freeAreaPadding={freePad} focusDimension={keys} dimensionLines={!full}
          dimensions={dimsOn ? undefined : keys ? [keys] : []} dimensionColors={dimColors} renderDimensionLabel={renderDim} partDimensions onFirstGesture={hideHint} />
      </View>
      {hint && !keys ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: canvasTop + 4, alignItems: 'center' }}>
          <View style={[s.hintPill, s.lift]}>
            <Ionicons name="hand-left-outline" size={15} color={palette.muted} />
            <T v="cap" style={{ fontSize: 13 }}>{t('ed_hint_min')}</T>
          </View>
        </View>
      ) : null}

      {/* шапка */}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: insets.top }}>
        <OfflineBanner />
        <View style={s.hdr} pointerEvents="box-none">
          <IconButton icon="chevron-back" label={t('ed_to_project')} onPress={() => (router.canGoBack() ? router.back() : router.replace(`/project/${id}`))} style={s.lift} />
          <Press feedback="scale" onPress={() => router.push(`/project/${id}/versions`)} accessibilityRole="button" accessibilityLabel={`${title}. ${anyEst ? `${t('estimate_mark')}. ` : ''}${sub}`} style={[s.titlePill, s.lift]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <T style={{ flexShrink: 1, fontSize: 15, lineHeight: 19, fontWeight: '600' }} numberOfLines={1}>{title}</T>
              {anyEst ? <Tag label={t('estimate_mark')} tone="est" style={{ height: 20, paddingHorizontal: 6 }} /> : null}
            </View>
            <T v="cap" style={{ fontSize: 12, lineHeight: 15 }} numberOfLines={1}>{sub}</T>
          </Press>
          <IconButton label={t('ed_undo')} disabled={!state.can_undo || saving || disabled} onPress={() => run(() => api.undo(id))} style={s.lift}>
            <MaterialCommunityIcons name="undo-variant" size={22} color={palette.ink} />
          </IconButton>
        </View>
      </View>
      {showRow ? (
        <View style={[s.viewRow, { top: insets.top + ROW_TOP }]} pointerEvents="box-none">
          <Press onPress={() => { hideHint(); setViewMenu(!viewMenu); }} accessibilityRole="button" accessibilityState={{ expanded: viewMenu }} style={[s.vb, viewMenu && { backgroundColor: palette.ink }]}>
            <Ionicons name={exploded ? 'apps-outline' : evening ? 'moon-outline' : 'eye-outline'} size={17} color={viewMenu ? palette.white : palette.ink} />
            <T style={[s.vbText, viewMenu && { color: palette.white }]}>{t('ed_view')}</T>
            <Ionicons name={viewMenu ? 'chevron-up' : 'chevron-down'} size={14} color={viewMenu ? palette.white : palette.muted} />
          </Press>
          <Press onPress={() => router.push(`/project/${id}/ar`)} accessibilityRole="button" accessibilityLabel="AR" style={s.vb}>
            <Ionicons name="cube-outline" size={17} color={palette.ink} />
            <T style={s.vbText}>AR</T>
          </Press>
        </View>
      ) : null}

      {/* шторка чата */}
      {!keys ? (
        <Animated.View style={[s.chat, { height: h, bottom: kb }, kbH ? { maxHeight: H - insets.top - 80 - kbH } : null]}>
          <SurfaceProvider value="white">
            <View {...pan.panHandlers}>
              <Pressable onPress={toggleSheet} accessibilityRole="button" accessibilityLabel={t('ed_expand_chat')} style={s.hdl}><View style={s.hdlBar} /></Pressable>
            </View>
            {mode !== 'min' && (selected || hw) ? (
              // выбранная деталь / фурнитура — её параметры вместо переписки (тап по пустому месту 3D — назад к чату)
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
                {hw ? (
                  <HardwarePanel hw={hw} title={t('el_hw_title')} onClose={clearPick} closeLabel={t('close')} />
                ) : selected ? (
                  <PartPanel sel={selected} info={partInfo} vp={v.viewer.parts.find((x) => x.number === selected.number) ?? null}
                    materials={v.viewer.materials} t={t} onClose={clearPick}
                    onMore={() => router.push({ pathname: '/project/[id]/element', params: { id, n: String(selected.number) } })}
                    onStyle={STYLE_ROLES.includes(selected.role) ? () => router.push({ pathname: '/project/[id]/front-style', params: { id, ...(frontScope(selected.key) ? { part: String(selected.number) } : {}) } }) : undefined}
                    onBuiltin={BUILTIN_ROLES.includes(selected.role) ? () => router.push(`/project/${id}/builtin`) : undefined} />
                ) : null}
              </ScrollView>
            ) : mode !== 'min' ? (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingBottom: 4 }} keyboardShouldPersistTaps="handled"
                ref={chatScroll} onContentSizeChange={() => { if (!userScrolled.current) chatScroll.current?.scrollToEnd({ animated: false }); }}
                onScrollBeginDrag={() => { userScrolled.current = true; }}>
                {/* переписка: и в половине, и в полной шторке; новое — внизу, прокрутка к последнему */}
                {history.length ? (
                  <View>
                    <T v="lbl" style={{ paddingTop: 4, paddingHorizontal: 16, paddingBottom: 8 }}>{t('ed_today', { n: `${editsToday} ${plural(editsToday, t('ed_edits'))}` })}</T>
                    {history.map((m) => m.author === 'master' ? (
                      <View key={m.id} style={[s.me, m.undone && { opacity: 0.5 }]}><T style={{ fontSize: 15, lineHeight: 20, fontWeight: '600' }}>{m.text}</T></View>
                    ) : (
                      <View key={m.id} style={[s.chg, { minHeight: 40, alignItems: 'flex-start', paddingVertical: 8 }, m.undone && { opacity: 0.5 }]}>
                        <T num style={{ fontSize: 13, lineHeight: 20, width: 48, color: palette.muted }}>{hhmm(m.created_at)}</T>
                        <T style={{ flex: 1, fontSize: 15, lineHeight: 20, color: m.kind === 'question' || m.kind === 'error' ? palette.ink : palette.muted }}>{m.text}</T>
                      </View>
                    ))}
                  </View>
                ) : null}
                {aiLimited ? (
                  <View style={{ paddingTop: 2, paddingHorizontal: 16, gap: 10 }}>
                    <View style={s.limBan}>
                      <MaterialCommunityIcons name="star-four-points-outline" size={20} color="#6E3C00" style={{ marginTop: 1 }} />
                      <View style={{ flex: 1 }}>
                        <T v="bt" color="#6E3C00">{t('ail_title')}</T>
                        <T v="bd" color="#6E3C00" style={{ marginTop: 2 }}>{t('ail_text')}</T>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {t('ail_free').split('|').map((x) => <View key={x} style={s.freeTag}><T style={{ fontSize: 13, fontWeight: '600', color: palette.greenDeep }}>{x}</T></View>)}
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Button title={t('ail_pack')} value={t('ail_pack_price')} onPress={() => router.push('/paywall' as never)} style={{ flex: 1, height: 52, paddingLeft: 16, paddingRight: 6 }} />
                      <Button v="secondary" title="Pro" onPress={() => router.push('/paywall' as never)} style={{ height: 52, paddingHorizontal: 18 }} />
                    </View>
                  </View>
                ) : ai.running ? (
                  <View style={s.chg}>
                    <View style={s.ok28}><ActivityIndicator size="small" color={palette.green} /></View>
                    <T style={{ flex: 1, fontSize: 15, fontWeight: '700' }}>{t('ed_ai_thinking')} {ai.elapsed ? `${ai.elapsed} с` : ''}</T>
                  </View>
                ) : evening ? (
                  <View style={s.lit}>
                    <View style={[s.ok28, { backgroundColor: '#FFF3DF' }]}><MaterialCommunityIcons name="star-four-points-outline" size={16} color="#B86A00" /></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '700' }} numberOfLines={1}>
                        {t('ed3_lit_title', { z: ((draft.lighting as LightingItem[] | undefined) ?? []).map((l) => td(`lt_z_${l.zone}`, l.zone).toLowerCase()).join(', ') || t('lt_off') })}
                      </T>
                      <T num style={{ fontSize: 13, lineHeight: 18, color: palette.muted }} numberOfLines={1}>
                        {[[...new Set(((draft.lighting as LightingItem[] | undefined) ?? []).map((l) => `${l.temp ?? 4000} K`))].join(' / '), litCost ? `+${groupDigits(litCost)}` : null].filter(Boolean).join(' · ')}
                      </T>
                    </View>
                    <Button v="secondary" small title={t('ed3_change')} onPress={() => router.push(`/project/${id}/lighting`)} style={{ height: 40 }} />
                  </View>
                ) : lastChange ? (
                  <View style={s.chg}>
                    <View style={s.ok28}><MaterialCommunityIcons name={lastChange.undone ? 'undo-variant' : 'check-bold'} size={16} color={palette.green} /></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '700' }} numberOfLines={2}>{lastChange.text}</T>
                      {(() => {
                        const line = [lastChange.kind && /\d/.test(lastChange.kind) ? lastChange.kind : null, formatDelta(lastChange.price_delta, lang)].filter(Boolean).join(' · ');
                        return line ? <T num style={{ fontSize: 13, lineHeight: 18, color: palette.muted }}>{noCurrency(line)}</T> : null;
                      })()}
                    </View>
                    <Button v="secondary" small title={lastChange.undone ? t('ed_return') : t('ed_undo')} style={{ height: 40 }}
                      disabled={saving || disabled || (lastChange.undone ? !state.can_redo : !state.can_undo)}
                      onPress={() => run(() => (lastChange.undone ? api.redo(id) : api.undo(id)))} />
                  </View>
                ) : null}
                {!aiLimited && issue ? (
                  <View style={s.q}>
                    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                      <View style={[s.dot, { backgroundColor: issue.level === 'error' ? palette.red : palette.amber }]} />
                      <T style={{ flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '700' }}>{issue.message}</T>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {issue.fixes.slice(0, 3).map((f, fi) => (
                        <Press key={fi} style={s.ans} onPress={() => run(() => api.applyFix(id, issues.indexOf(issue), fi))} accessibilityRole="button">
                          <T style={s.ansT} numberOfLines={2}>{f.description}</T>
                        </Press>
                      ))}
                    </View>
                  </View>
                ) : null}
                {!aiLimited && !ai.running && designQs.length ? (
                  // вопросы распознавания: тап только выделяет ответ; несколько — «Отправить ответы» разом, один — сразу
                  <View style={s.q}>
                    {designQs.length > 1 ? <T v="cap" style={{ fontSize: 13 }}>{t('ed_q_pick')}</T> : null}
                    {designQs.map((q) => (
                      <View key={q.id} style={{ gap: 10 }}>
                        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                          <View style={[s.dot, { backgroundColor: palette.amber }]} />
                          <T style={{ flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '700' }}>{q.text}</T>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 6 }}>
                          {q.options.slice(0, 3).map((o) => {
                            const on = qPick[q.id] === o;
                            return (
                              <Press key={o} style={[s.ans, on && { backgroundColor: palette.ink }]} disabled={disabled} accessibilityRole="radio" accessibilityState={{ selected: on }}
                                onPress={() => {
                                  haptics.selection();
                                  if (designQs.length === 1) sendAnswers(designQs, { [q.id]: o });
                                  else setQPick((cur) => { const n = { ...cur }; if (n[q.id] === o) delete n[q.id]; else n[q.id] = o; return n; });
                                }}>
                                <T style={[s.ansT, on && { color: palette.white }]} numberOfLines={2}>{o}</T>
                              </Press>
                            );
                          })}
                        </View>
                      </View>
                    ))}
                    {designQs.length > 1 ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <T v="cap" style={{ flex: 1, fontSize: 13 }} numberOfLines={2}>
                          {t('ed_answers_left', { i: designQs.filter((q) => qPick[q.id]).length, n: designQs.length })}
                        </T>
                        <Button small title={t('ed_answers_send')} disabled={disabled} onPress={() => sendAnswers(designQs, qPick)} style={{ height: 44, paddingHorizontal: 16 }} />
                      </View>
                    ) : null}
                  </View>
                ) : null}
                {!aiLimited && !issue && question ? (
                  // вопрос правки — один: тап по варианту сразу отвечает
                  <View style={s.q}>
                    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                      <View style={[s.dot, { backgroundColor: palette.amber }]} />
                      <View style={{ flex: 1 }}>
                        <T style={{ fontSize: 15, lineHeight: 21, fontWeight: '700' }}>{question.text}</T>
                        {question.kind && !/^[a-z_]+$/.test(question.kind) ? <T v="cap" style={{ marginTop: 2 }}>{question.kind}</T> : null}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {question.options!.slice(0, 3).map((o, oi) => {
                        const dl = question.option_deltas?.[oi];
                        return (
                          <Press key={o} style={s.ans} onPress={() => sendAi(o)} disabled={ai.running || disabled} accessibilityRole="button">
                            <T style={s.ansT} numberOfLines={2}>{o}</T>
                            {dl != null ? <T num style={{ fontSize: 13, fontWeight: '600', color: palette.muted }}>{dl === 0 ? '0' : `${dl > 0 ? '+' : '−'}${groupDigits(Math.abs(dl))}`}</T> : null}
                          </Press>
                        );
                      })}
                    </View>
                  </View>
                ) : null}
                {suggestions.length ? (
                  // подсказки по типу изделия: тап — сразу в чат
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginTop: sheetEmpty ? 0 : 8 }} contentContainerStyle={s.tools} keyboardShouldPersistTaps="handled">
                    {suggestions.map((x) => (
                      <Press key={x} onPress={() => sendAi(x)} disabled={textOff} accessibilityRole="button" style={[s.tl, s.sug]}>
                        <Ionicons name="sparkles-outline" size={15} color={palette.greenPress} />
                        <T style={[s.tlText, { color: palette.greenDeep }]}>{x}</T>
                      </Press>
                    ))}
                  </ScrollView>
                ) : null}
              </ScrollView>
            ) : <View style={{ flex: 1 }} />}
            {mode !== 'min' && !aiLimited && !sheetEmpty && !selected && !hw && budget.data ? (
              <View style={s.budget}>
                <View style={[s.dot, { marginTop: 0, backgroundColor: budget.data.warning ? palette.red : palette.amber }]} />
                <T v="cap" style={{ flex: 1 }} numberOfLines={1}>{t('ed_budget_line', { p: budget.data.percent })}</T>
                <T onPress={() => router.push('/paywall' as never)} style={{ fontSize: 14, fontWeight: '700', color: palette.greenPress, paddingVertical: 6 }}>{t('pl_tariffs')}</T>
              </View>
            ) : null}
            {/* инструменты — чипами над вводом, слева, через 8 (без иконок: все четыре помещаются в ширину 390 без прокрутки) */}
            {showTools ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginTop: mode === 'min' ? 0 : 8 }} contentContainerStyle={s.tools} keyboardShouldPersistTaps="handled">
                {tools.map(([k, fn]) => (
                  <Press key={k} onPress={fn} accessibilityRole="button" style={s.tl}>
                    <T style={s.tlText}>{t(k)}</T>
                  </Press>
                ))}
              </ScrollView>
            ) : null}
            <View style={{ paddingTop: 8, paddingHorizontal: 16 }}>
              <Pressable style={[s.inp, aiLimited && { opacity: 0.75 }]} disabled={!aiLimited} onPress={() => router.push('/paywall' as never)}>
                <TextInput ref={inputRef} value={input} onChangeText={setInput} onFocus={() => { if (snapRef.current === 'min') goSnap('half'); }} placeholder={aiLimited ? t('ail_input') : disabled ? t('ed_offline') : t('ed_say')} placeholderTextColor={aiLimited ? palette.faint : palette.muted}
                  editable={!textOff && !ai.running} pointerEvents={aiLimited ? 'none' : 'auto'} onSubmitEditing={() => sendAi(input)} returnKeyType="send" accessibilityLabel={t('ed_say')}
                  style={resolveFont([ty.body, { flex: 1, fontSize: 15, color: palette.ink, paddingVertical: Platform.OS === 'android' ? 4 : 0 }])} />
                <Pressable accessibilityLabel={t('ed_send')} onPress={() => sendAi(input)} disabled={!input.trim() || textOff || ai.running}
                  style={[s.snd, aiLimited && { backgroundColor: palette.handle }, (!input.trim() || disabled || ai.running) && !aiLimited && { opacity: input.trim() ? 0.4 : 1 }]}>
                  <Ionicons name={aiLimited ? 'lock-closed-outline' : 'arrow-up'} size={aiLimited ? 18 : 20} color={palette.white} />
                </Pressable>
              </Pressable>
            </View>
            {/* «Клиенту» без суммы: цена — в смете и на экране отправки */}
            <View style={[s.bar2, { paddingBottom: pb }]}>
              <Button v={aiLimited ? 'secondary' : 'primary'} title={t('ed_to_client')} iconRight="paper-plane-outline" onPress={() => router.push(`/project/${id}/send`)} style={{ flex: 1, height: 52 }} />
            </View>
          </SurfaceProvider>
        </Animated.View>
      ) : (
        <Keypad title={t(`ed_kb_${keys}`)} entry={entry} setEntry={setEntry}
          quick={quickValues(kind, keys, dimVal(keys) ?? 0, keyLim!)} unit={t('mm')} pb={pb}
          range={t('dim_range', { min: keyLim!.min, max: keyLim!.max })} error={keyErr} est={dimEst(keys)} estLabel={t('estimate_mark')}
          onCancel={() => setKeys(null)} onApply={applyKeys} cancelLabel={t('cancel')} applyLabel={t('ed_apply')} />
      )}

      {/* меню «Вид»: двери, разобрать, день/вечер, подсветка, стены */}
      {viewMenu && showRow ? (
        <>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewMenu(false)} accessibilityLabel={t('close')} />
          <View style={[s.menu, { top: insets.top + ROW_TOP + ROW_H + 6 }]}>
            <SurfaceProvider value="white">
              {viewRow(openAll ? 'eye-off-outline' : 'eye-outline', t(openAll ? 'ed_view_close' : 'ed_view_open'), closeMenu(() => { if (openAll) canvas.current?.closeAll(); else canvas.current?.openAll(); setOpenAll(!openAll); }))}
              {viewRow('apps-outline', t(exploded ? 'ed_view_assemble' : 'ed_view_explode'), closeMenu(() => { canvas.current?.explode(!exploded); if (exploded) clearPick(); setExploded(!exploded); haptics.light(); }))}
              {viewRow('resize-outline', t('ed_dims'), () => { toggleDims(!dimsOn); haptics.selection(); }, <Toggle value={dimsOn} accessibilityLabel={t('ed_dims')} onValueChange={toggleDims} />)}
              <View style={s.mHair} />
              {lights ? (
                <View style={s.mRow}>
                  <Ionicons name={evening ? 'moon-outline' : 'sunny-outline'} size={20} color={palette.ink} />
                  <View style={s.seg} accessibilityRole="tablist">
                    {([false, true] as const).map((on) => (
                      <Press key={String(on)} feedback="opacity" onPress={() => { if (on !== evening) { setEvening(on); canvas.current?.setLightsOn(on); haptics.selection(); } }}
                        accessibilityRole="tab" accessibilityState={{ selected: on === evening }} style={[s.segB, on === evening && s.segOn]}>
                        <T style={{ fontSize: 14, fontWeight: '600' }}>{on ? t('ed3_evening') : t('ed3_day')}</T>
                      </Press>
                    ))}
                  </View>
                </View>
              ) : null}
              {viewRow('bulb-outline', t('ed_view_lighting'), closeMenu(() => router.push(`/project/${id}/lighting`)), <Ionicons name="chevron-forward" size={18} color={palette.chev} />)}
              {room ? viewRow('home-outline', t('ed_view_walls'), undefined, <Toggle value={roomOn} accessibilityLabel={t('ed_view_walls')} onValueChange={(on) => { setRoomOn(on); canvas.current?.setRoomVisible(on); }} />) : null}
              {viewRow('color-palette-outline', t('ed_view_wall_color'), closeMenu(() => router.push(`/project/${id}/room-color`)), <Ionicons name="chevron-forward" size={18} color={palette.chev} />)}
            </SurfaceProvider>
          </View>
        </>
      ) : null}
    </View>
    </Profiler>
  );
}

type TFn = ReturnType<typeof useT>['t'];
type ViewerModelPart = ViewerModel['parts'][number];

/** Кромка стороной: «2 / 0,4 мм» (две стороны пары), без кромки — «без кромки». */
function edgePair(info: PartOut, sides: [string, string], t: TFn): string {
  const v = sides.map((sd) => info.edges.find((e) => e.side === sd)?.thickness_mm ?? 0);
  if (!v[0] && !v[1]) return t('el_edge_none');
  return v.map((x) => (x ? mmText(x) : '—')).join(' / ');
}

/**
 * SCR-25 в шторке, коротко (размеры детали — линиями на ней в 3D): имя, номер, материал; кромка и распил — мелкой
 * второй строкой; «Подробнее» — полный экран детали.
 */
function PartPanel({ sel, info, vp, materials, t, onClose, onMore, onStyle, onBuiltin }: {
  sel: PickResult; info: PartOut | null; vp: ViewerModelPart | null; materials: Record<string, { name?: string }>;
  t: TFn; onClose: () => void; onMore: () => void;
  /** Фасад — «Стиль фасада» (SCR-48) этого фасада; добор/фальш-панель — «Встройка» (SCR-50). */
  onStyle?: () => void; onBuiltin?: () => void;
}) {
  const mat = info?.material ?? (vp ? materials[vp.material]?.name ?? vp.material : '');
  const edges = info ? `${t('el_edges')}: ${t('el_edge_long')} ${edgePair(info, ['y0', 'y1'], t)} · ${t('el_edge_short')} ${edgePair(info, ['x0', 'x1'], t)}` : null;
  const cut = info ? `${t('el_cut')} ${mmText(info.cut_length_mm)} × ${mmText(info.cut_width_mm)} ${t('mm')}` : null;
  return (
    <View style={{ paddingHorizontal: 16, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={{ fontSize: 17, lineHeight: 22, fontWeight: '700' }} numberOfLines={1}>{sel.name}</T>
          <T v="cap" style={{ fontSize: 13 }} numberOfLines={1}>{[t('el_part_n', { n: sel.number }), sel.kind === 'decor' && sel.decor ? t('dc_inlay_hit', { name: sel.decor.name }) : mat].filter(Boolean).join(' · ')}</T>
        </View>
        <Button v="secondary" small title={t('el_more')} onPress={onMore} style={{ height: 40 }} />
        <IconButton icon="close" label={t('close')} onPress={onClose} />
      </View>
      {info ? (
        <View style={{ gap: 1 }}>
          <T num style={{ fontSize: 13, lineHeight: 18, color: palette.muted }} numberOfLines={1}>{edges}</T>
          <T num style={{ fontSize: 13, lineHeight: 18, color: palette.muted }} numberOfLines={1}>{cut}</T>
        </View>
      ) : (
        <View style={{ gap: 6, paddingVertical: 2 }}><View style={s.pskel} /><View style={[s.pskel, { width: '45%' }]} /></View>
      )}
      {onStyle || onBuiltin ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 2 }}>
          {onStyle ? <Button v="secondary" small icon="brush-outline" title={t('ed3_style_btn')} onPress={onStyle} style={{ flex: 1, height: 40 }} /> : null}
          {onBuiltin ? <Button v="secondary" small icon="scan-outline" title={t('ed3_builtin_btn')} onPress={onBuiltin} style={{ flex: 1, height: 40 }} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Тап по фурнитуре: название и тип. */
function HardwarePanel({ hw, title, onClose, closeLabel }: { hw: HardwarePick; title: string; onClose: () => void; closeLabel: string }) {
  return (
    <View style={{ paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={s.ok28}><MaterialCommunityIcons name="hook" size={18} color={palette.green} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontSize: 17, lineHeight: 22, fontWeight: '700' }} numberOfLines={2}>{hw.name || title}</T>
        <T v="cap" style={{ fontSize: 13 }} numberOfLines={1}>{[title, hw.type].filter(Boolean).join(' · ')}</T>
      </View>
      <IconButton icon="close" label={closeLabel} onPress={onClose} />
    </View>
  );
}

/**
 * Шторка ввода размера: поле с допустимым диапазоном («от 300 до 2700 мм»; ошибка — красным сразу при наборе),
 * быстрые значения по типу изделия, клавиши 1–9, ±10, 0, ⌫ (иконка того же веса, что цифры) и «Применить».
 */
function Keypad({ title, entry, setEntry, quick, unit, pb, range, error, est, estLabel, onCancel, onApply, cancelLabel, applyLabel }: {
  title: string; entry: string; setEntry: (v: string) => void; quick: number[]; unit: string; pb: number;
  range: string; error: string | null; est: boolean; estLabel: string;
  onCancel: () => void; onApply: () => void; cancelLabel: string; applyLabel: string;
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '±10', '0', '⌫'];
  const tap = (k: string) => {
    haptics.selection();
    if (k === '⌫') setEntry(entry.slice(0, -1));
    else if (k === '±10') setEntry(String((Number(entry) || 0) + 10));
    else if (entry.length < 4) setEntry(entry === '0' ? k : entry + k);
  };
  const c = error ? palette.red : palette.blue;
  return (
    <View style={[s.chat, { height: KEYS_H + pb - 28 }]}>
      <SurfaceProvider value="white">
        <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
            <T style={{ fontSize: 18, lineHeight: 24, fontWeight: '700' }} numberOfLines={1}>{title}</T>
            {est ? <Tag label={estLabel} tone="est" /> : null}
          </View>
          <Button v="secondary" small title={cancelLabel} onPress={onCancel} style={{ height: 40 }} />
        </View>
        <View style={[s.kfld, { borderColor: c }, error ? { backgroundColor: '#FFF5F4' } : null]} accessibilityLiveRegion="polite">
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T num style={{ fontSize: 30, lineHeight: 34, fontWeight: '600', color: error ? palette.redText : palette.ink }}>{entry}</T>
              <View style={{ width: 2, height: 28, backgroundColor: c, marginLeft: 2 }} />
            </View>
            <T num style={{ fontSize: 13, lineHeight: 17, color: error ? palette.redText : palette.muted }} numberOfLines={2}>{error ?? range}</T>
          </View>
          <T v="cap" style={{ fontSize: 15 }}>{unit}</T>
        </View>
        <View style={{ flexDirection: 'row', gap: 6, paddingTop: 10, paddingHorizontal: 16 }}>
          {quick.map((q) => (
            <Press key={q} onPress={() => setEntry(String(q))} style={[s.qv, String(q) === entry && { backgroundColor: palette.blue }]} accessibilityRole="button">
              <T num style={{ fontSize: 14, fontWeight: '700', color: String(q) === entry ? palette.white : palette.blue }}>{q}</T>
            </Press>
          ))}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 10, paddingHorizontal: 16 }}>
          {keys.map((k) => (
            <Press key={k} onPress={() => tap(k)} onLongPress={k === '⌫' ? () => setEntry('') : undefined} style={s.key} accessibilityRole="button" accessibilityLabel={k === '⌫' ? 'backspace' : k}>
              {k === '⌫' ? <Ionicons name="backspace-outline" size={28} color={palette.ink} /> : <T num style={{ fontSize: 22, fontWeight: '600' }}>{k}</T>}
            </Press>
          ))}
        </View>
        <View style={{ paddingTop: 12, paddingHorizontal: 16, paddingBottom: pb }}>
          <Button title={applyLabel} onPress={onApply} disabled={!Number(entry) || !!error} />
        </View>
      </SurfaceProvider>
    </View>
  );
}

const shadow = { shadowColor: palette.ink, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 };
const s = StyleSheet.create({
  lift: shadow,
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, minHeight: 72 },
  titlePill: { flex: 1, minWidth: 0, height: 44, borderRadius: 22, backgroundColor: palette.white, justifyContent: 'center', paddingHorizontal: 16 },
  viewRow: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between' },
  dimL: { height: 26, borderRadius: 13, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: palette.white, borderWidth: 1, borderColor: '#D6E2FF' },
  dimEst: { backgroundColor: palette.amberSoft, borderColor: '#F3CF8F' },
  dimOn: { height: 36, borderRadius: 18, paddingHorizontal: 12, backgroundColor: palette.blue, borderWidth: 0 },
  dimPart: { height: 24, borderRadius: 12, paddingHorizontal: 8, borderColor: '#B9CCFA' },
  menu: {
    position: 'absolute', left: 12, width: 286, borderRadius: 20, backgroundColor: palette.white, paddingVertical: 6,
    shadowColor: palette.ink, shadowOpacity: 0.16, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 10,
  },
  mRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 16 },
  mHair: { height: 1, backgroundColor: palette.hair, marginVertical: 4, marginHorizontal: 16 },
  seg: { flex: 1, flexDirection: 'row', height: 36, borderRadius: 12, padding: 3, gap: 2, backgroundColor: palette.segOnWhite },
  segB: { flex: 1, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: palette.white, shadowColor: palette.ink, shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
  vb: { height: 40, borderRadius: 20, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, shadowColor: palette.ink, shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 2 },
  vbText: { fontSize: 13, fontWeight: '700' },
  nt: { height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.12)', flexDirection: 'row', padding: 3, gap: 2 },
  ntB: { height: 34, borderRadius: 17, paddingHorizontal: 12, justifyContent: 'center' },
  ntT: { fontSize: 13, fontWeight: '600', color: '#D6D4CF' },
  glow: { position: 'absolute', left: '50%', backgroundColor: 'rgba(255,190,110,0.02)' },
  lit: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16 },
  hintPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: palette.white, borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 },
  tools: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  tl: { height: 36, borderRadius: 18, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  tlText: { fontSize: 14, lineHeight: 18, fontWeight: '500' },
  sug: { backgroundColor: palette.greenSoft },
  chat: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: palette.white, borderTopLeftRadius: 32, borderTopRightRadius: 32, overflow: 'visible',
    shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 16, shadowOffset: { width: 0, height: -12 }, elevation: 12,
  },
  hdl: { height: 22, alignItems: 'center', justifyContent: 'center' },
  hdlBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: palette.handle },
  chg: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16 },
  ok28: { width: 32, height: 32, borderRadius: 10, backgroundColor: palette.greenSoft, alignItems: 'center', justifyContent: 'center' },
  me: { alignSelf: 'flex-end', maxWidth: '80%', marginHorizontal: 16, marginTop: 8, paddingVertical: 10, paddingHorizontal: 14, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderBottomRightRadius: 6, borderBottomLeftRadius: 18, backgroundColor: palette.segOnWhite },
  q: { marginTop: 4, marginHorizontal: 12, padding: 14, borderRadius: 20, backgroundColor: palette.ground, gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  ans: { flex: 1, minHeight: 56, borderRadius: 14, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 4, shadowColor: palette.ink, shadowOpacity: 0.06, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } },
  ansT: { fontSize: 14, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  limBan: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: palette.amberSoft },
  freeTag: { height: 30, borderRadius: 9, paddingHorizontal: 9, justifyContent: 'center', backgroundColor: palette.greenSoft },
  budget: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingHorizontal: 16, minHeight: 32 },
  inp: { height: 52, borderRadius: 26, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 18, paddingRight: 6 },
  snd: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  bar2: { flexDirection: 'row', gap: 8, paddingTop: 10, paddingHorizontal: 16 },
  pr: { height: 56, paddingHorizontal: 14, borderRadius: 18, backgroundColor: palette.segOnWhite, justifyContent: 'center' },
  kfld: { marginHorizontal: 16, minHeight: 76, borderRadius: 18, borderWidth: 2, borderColor: palette.blue, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 6 },
  qv: { flex: 1, height: 40, borderRadius: 12, backgroundColor: palette.blueSoft, alignItems: 'center', justifyContent: 'center' },
  pskel: { height: 16, width: '70%', borderRadius: 6, backgroundColor: palette.segOnWhite, marginTop: 3 },
  key: { width: '31.6%', flexGrow: 1, height: 52, borderRadius: 14, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
});
