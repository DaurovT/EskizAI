/**
 * SCR-37 / SCR-37b Редактор кухни (KitchenEditor / KitchenCorner.dc.html) — вид для editor.tsx, когда tree.type === 'kitchen'.
 * Сверху «Схема / 3D». Схема — фасад рядов по реальным ширинам (мм → pt): верхние (с антресолями), полки на
 * столешнице, столешница, нижние; оба ряда от левого края, как в ядре. Угловая кухня — «План» (вид сверху) и фасады
 * стен А и Б. Тап по модулю — его свойства: вид, ширина, двери, петли, ящики, полки, подъёмные фасады, ниша техники,
 * антресоль; «← →», «Дублировать», «Удалить»; «+» в конце ряда. Сумма не сходится со стеной — подогнать соседний
 * модуль или добор одним тапом. Вкладки «Модуль / Столешница / Техника (/ Угол) / Кухня» (высоты, глубины).
 * 3D — тот же канвас, что у шкафа: вращение, двери, размеры; тап по модулю — «Изменить» в схеме.
 * Внизу — ввод правки словами и переписка с ИИ (сворачивается, схема остаётся рабочей).
 * Все правки дерева — onField(pointer, value): ряд модулей заменяется целиком (/base, /wall, /mid …).
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import type { ViewerModel } from '@mebel/viewer';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type ScrollViewInstance, type StyleProp, type TextStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';
import type { KitchenSite, ModelStateOut, ProductTree } from '../api/types';
import { groupDigits } from '../lib/format';
import { moduleLengths, wallDiffs } from '../lib/kitchenMeasure';
import {
  BASE_KINDS, KDEF, KLIM, WALL_KINDS, clamp, doorCount, drawerLines, duplicateAt, fridgeSpans, hasOpenBottom, hasTier, insertAt, isUpper, labelCode, moveAt, newModule,
  nicheHeight, num, removeAt, replaceAt, rowMods, schemeLayout, wallOverFridge, selFromPartKey, sumFixes, wallKindOf, wallModHeight, withKind,
  type KLayout, type KMod, type KRow, type KSel, type SumFix,
} from '../lib/kitchenScheme';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { ProductCanvas, type CanvasHandle } from '../three/ProductCanvas';
import { IconButton, Press, SurfaceProvider, T, Toggle, resolveFont } from '../ui/kit';
import { KitchenChat, type KitchenChatProps } from './KitchenChat';
import { DecorMenu } from './DecorMenu';
import { palette, type as ty } from '../ui/theme';

type Tab = 'mod' | 'top' | 'app' | 'corner' | 'kit';
type View3 = 'scheme' | '3d';
/** Угловая кухня: план сверху или фасад стены А (ряд 1) / Б (ряд 2). */
type RunView = 'plan' | 1 | 2;

/** Вертикальная раскладка экрана от верхней безопасной зоны: шапка, строка «размер · Схема/3D», схема, вкладки, панель. */
const ROW2 = 72;
const AREA = 118;
const AREA_H = 214;
const TABS = AREA + AREA_H + 4;
const PANEL = TABS + 50;

export type KitchenViewProps = {
  id: string; tree: ProductTree; title: string; sub?: string;
  /** Цена «до замера»; null — не показывать (цену пока убрали из редактора, как у шкафа). */
  price?: string | null;
  /** Название материала по id из 3D-модели (МДФ под покраску и т. п. — не декоры EMAN). */
  materialName?: (id: string) => string | undefined;
  busy: boolean; disabled: boolean;
  /** Правка дерева: значение — любой JSON (null — снять значение, ряд модулей — массив целиком). */
  onField: (pointer: string, value: unknown) => void;
  /** Замена наполнения угла (фурнитура corner_fill) вернула новую версию модели. */
  onModel: (s: ModelStateOut) => void; onError: (e: unknown) => void;
  /** 3D-модель текущей версии (тот же канвас, что у шкафа). */
  viewer: ViewerModel;
  /** С чего открыть: схема (по умолчанию) или 3D («Открыть 3D» в карточке проекта). */
  initialView?: View3;
  /** Переписка с ИИ — данные и действия редактора (те же, что у шкафа). */
  chat: Omit<KitchenChatProps, 'onSend'>;
  onSend: (text: string) => void;
};

export function KitchenView({ id, tree, title, sub, price, materialName, onField, busy, disabled, onModel, onError, viewer, initialView, chat, onSend }: KitchenViewProps) {
  const { t, td, lang } = useT();
  const insets = useSafeAreaInsets();
  const { width: W } = useWindowDimensions();
  const decors = useResource(() => api.listDecors().catch(() => []), []);
  const base = rowMods(tree, 'base');
  const wall = rowMods(tree, 'wall');
  const base2 = rowMods(tree, 'base2');
  const mids = rowMods(tree, 'mid');
  // угловая кухня (core): layout 'corner', угловой модуль — в первом ряду base (corner_shape, corner_fill), второй ряд — base2/wall2
  const corner = tree.layout === 'corner' || base2.length > 0;
  const cornerIdx = base.findIndex((m) => m.kind === 'corner');
  const [mode, setMode] = useState<View3>(initialView ?? 'scheme');
  const [runView, setRunView] = useState<RunView>(corner ? 'plan' : 1);
  const [tab, setTab] = useState<Tab>(corner && cornerIdx >= 0 ? 'corner' : 'mod');
  const [sel, setSel] = useState<KSel>(corner && cornerIdx >= 0 ? { row: 'base', i: cornerIdx } : { row: 'base', i: Math.min(1, base.length - 1) });
  const [chatOpen, setChatOpen] = useState(false);
  const [seen, setSeen] = useState(chat.messages.length);
  const [pick3d, setPick3d] = useState<KSel | 'top' | null>(null);
  const [openAll, setOpenAll] = useState(false);
  const [dims, setDims] = useState(true);
  const canvas = useRef<CanvasHandle>(null);
  const panelScroll = useRef<ScrollViewInstance>(null);
  const [panelH, setPanelH] = useState(260);
  const hw = useResource(() => (corner ? api.getHardware(id).catch(() => null) : Promise.resolve(null)), [id, corner, tree]);
  const cornerGroup = hw.data?.groups.find((g) => g.key === 'corner_fill') ?? null;
  const [applying, setApplying] = useState<string | null>(null);
  // дерево сменилось с прямой на угловую (новая версия) — открыть «Угол»
  useEffect(() => {
    if (corner && cornerIdx >= 0) { setTab('corner'); setSel({ row: 'base', i: cornerIdx }); setRunView('plan'); }
  }, [corner, cornerIdx]);
  useEffect(() => { if (initialView) setMode(initialView); }, [initialView]);
  // другой модуль / вкладка — панель с начала
  useEffect(() => { panelScroll.current?.scrollTo({ y: 0, animated: false }); }, [tab, sel.row, sel.i, sel.tier]);
  // открыта переписка — всё прочитано
  useEffect(() => { if (chatOpen) setSeen(chat.messages.length); }, [chatOpen, chat.messages.length]);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const rows: Record<KRow, KMod[]> = { base, wall, base2, wall2: rowMods(tree, 'wall2'), mid: mids };
  const cur = rows[sel.row][sel.i] as KMod | undefined;
  const lock = disabled || busy;

  const lbl = (m: KMod, row: KRow) => td(`kit_k_${labelCode(m, row)}`, m.kind);
  const shortLbl = (m: KMod, row: KRow) => td(`kit_ks_${labelCode(m, row)}`, lbl(m, row));
  const lens = moduleLengths(tree);
  const sumA = lens.a;
  const sumB = lens.b ?? 0;
  const site = tree.site as KitchenSite | undefined;
  const diffs = site && typeof site.wall_a === 'number' ? wallDiffs(tree, site) : null;
  const wallA = site && typeof site.wall_a === 'number' ? site.wall_a : null;
  const ctDepth = num((tree.countertop as { depth?: number } | undefined)?.depth, KDEF.ct_depth);
  // декор EMAN по id; не декор (МДФ, столешница из каталога) — имя материала из 3D-модели; нет — сам id
  const decorName = (mid?: string | null) => {
    if (!mid) return '—';
    const d = (decors.data ?? []).find((x) => x.id === mid);
    return (d && (lang === 'uz' ? d.name_uz || d.name : d.name)) || materialName?.(mid) || mid;
  };
  const paintCode = (tree.fronts as { style?: { paint?: { code?: string | null } | null } | null } | undefined)?.style?.paint?.code;
  const tabs: Tab[] = corner ? ['mod', 'top', 'app', 'corner', 'kit'] : ['mod', 'top', 'app', 'kit'];
  const tabLabel: Record<Tab, string> = { mod: t('kit_tab_mod'), top: t('kit_tab_top'), app: t('kit_tab_app'), corner: t('kit_tab_corner'), kit: t('kit_tab_kit') };
  const pick = (s: KSel) => {
    setSel(s);
    setTab(!s.tier && rows[s.row][s.i]?.kind === 'corner' ? 'corner' : 'mod');
    setChatOpen(false);
    Keyboard.dismiss();
  };
  const top = insets.top;
  const cornerMod = cornerIdx >= 0 ? base[cornerIdx] : null;
  const applyFill = async (value: string) => {
    setApplying(value);
    try { onModel(await api.applyHardware(id, 'corner_fill', value)); hw.reload(); } catch (e) { onError(e); } finally { setApplying(null); }
  };
  // как в макете — цена относительно глухого угла
  const blindDelta = cornerGroup?.options.find((o) => o.value === 'blind')?.delta;
  const send = () => { if (text.trim()) { onSend(text.trim()); setText(''); setChatOpen(true); Keyboard.dismiss(); } };

  // ----- правки дерева: ряд модулей целиком (несколько полей за раз не теряются) -----
  const setRow = (row: KRow, list: KMod[]) => onField(`/${row}`, list);
  /** Поля модуля; null — снять (у ядра это значение по умолчанию). */
  const patchMod = (row: KRow, i: number, patch: Record<string, unknown>) => {
    const m = rows[row][i];
    if (!m) return;
    const next: KMod = { ...m, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    setRow(row, replaceAt(rows[row], i, next));
  };
  const patchTier = (i: number, patch: Record<string, unknown>) => {
    const m = wall[i] ?? null;
    if (!m) return;
    const t0 = (m.top as Record<string, unknown> | null) ?? {};
    const next = { ...t0, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    patchMod(sel.row, i, { top: next });
  };
  const addModule = (row: KRow) => {
    const list = rows[row];
    const m = newModule(row, tree);
    setRow(row, [...list, m]);
    pick({ row, i: list.length });
  };
  const applyFix = (row: KRow, f: SumFix) => {
    const list = rows[row];
    if (f.kind === 'neighbour') setRow(row, replaceAt(list, f.i, { ...list[f.i], width: f.to }));
    else setRow(row, insertAt(list, list.length, newModule(row, tree, f.width)));
  };

  // dev: снимки без тапов (eval в scripts/shot.sh)
  useEffect(() => {
    if (!__DEV__) return;
    (globalThis as Record<string, unknown>).__kitchen = {
      pick: (row: KRow, i: number, tier?: boolean) => { setMode('scheme'); pick({ row, i, tier }); },
      tab: (k: Tab) => { setChatOpen(false); setTab(k); },
      mode: (m: View3) => setMode(m),
      run: (r: RunView) => setRunView(r),
      chat: (on: boolean) => setChatOpen(on),
      pick3d: (key: string) => setPick3d(selFromPartKey(key, tree)),
      scroll: (y: number) => panelScroll.current?.scrollTo({ y, animated: false }),
      fix: (n: number) => { if (sumRow && fixes[n]) applyFix(sumRow, fixes[n]); },
      add: (row: KRow) => addModule(row),
      send: (x: string) => { onSend(x); setChatOpen(true); },
      edit3d: () => { if (pick3d) editPick(pick3d); },
      kind: (k: string) => { if (cur) setRow(sel.row, replaceAt(rows[sel.row], sel.i, withKind(cur, sel.row, k))); },
    };
  });

  // ----- сумма модулей по стене и подгонка -----
  const sumRow: KRow | null = !corner ? (wallA != null && sumA !== wallA ? 'base' : null)
    : diffs && diffs.length ? (diffs.find((d) => (d.wall === 'b') === (sel.row === 'base2' || sel.row === 'wall2')) ?? diffs[0]).wall === 'a' ? 'base' : 'base2' : null;
  const sumDiff = sumRow === 'base' ? (wallA ?? sumA) - sumA : sumRow === 'base2' ? (diffs?.find((d) => d.wall === 'b')?.diff ?? 0) : 0;
  const fixes = sumRow ? sumFixes(rows[sumRow], sumDiff, sel.row === sumRow && !sel.tier ? sel.i : null) : [];
  const overFridge = [...wallOverFridge(tree, 1).map((i) => i + 1), ...(corner ? wallOverFridge(tree, 2).map((i) => `${t('kit_b')}${i + 1}`) : [])];
  const sumBanner = (
    <>
      {overFridge.length ? (
        <View style={[s.ban, { backgroundColor: palette.amberSoft, alignItems: 'flex-start' }]}>
          <Ionicons name="warning-outline" size={20} color={palette.amberDeep} style={{ marginTop: 1 }} />
          <T style={{ flex: 1, fontSize: 15, lineHeight: 20, color: palette.amberDeep }}>{t('kit_fridge_over', { n: overFridge.join(', ') })}</T>
        </View>
      ) : null}
      {!corner ? (
        wallA != null && sumA !== wallA ? (
          <View style={[s.ban, { backgroundColor: palette.redSoft, alignItems: 'flex-start' }]}>
            <Ionicons name="warning-outline" size={20} color="#8A1D16" style={{ marginTop: 1 }} />
            <T style={{ flex: 1, fontSize: 15, lineHeight: 20, color: '#8A1D16' }}>{t('kit_sum_bad', { sum: sumA, wall: wallA })}</T>
          </View>
        ) : (
          <View style={[s.ban, { backgroundColor: palette.greenSoft }]}>
            <Ionicons name="checkmark" size={20} color="#1F4A2F" />
            <T style={{ flex: 1, fontSize: 15, color: '#1F4A2F' }}>{wallA != null ? t('kit_sum_ok', { sum: sumA }) : t('kit_sum_len', { sum: sumA })}</T>
          </View>
        )
      ) : diffs && diffs.length ? (
        <View style={[s.ban, { backgroundColor: palette.redSoft, alignItems: 'flex-start' }]}>
          <Ionicons name="warning-outline" size={20} color="#8A1D16" style={{ marginTop: 1 }} />
          <T style={{ flex: 1, fontSize: 15, lineHeight: 20, color: '#8A1D16' }}>
            {diffs.map((d) => t('kit_wall_diff', { w: d.wall === 'a' ? t('kit_a') : t('kit_b'), d: `${d.diff > 0 ? '+' : '−'}${Math.abs(d.diff)}` })).join(' · ')}
          </T>
        </View>
      ) : (
        <View style={[s.ban, { backgroundColor: palette.greenSoft }]}>
          <Ionicons name="checkmark" size={20} color="#1F4A2F" />
          <T style={{ flex: 1, fontSize: 15, color: '#1F4A2F' }}>{t(diffs ? 'kit_walls_ok' : 'kit_walls_len', { a: sumA, b: sumB })}</T>
        </View>
      )}
      {sumRow && fixes.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {fixes.map((f) => (
            <Press key={f.kind} onPress={() => applyFix(sumRow, f)} disabled={lock} accessibilityRole="button" style={s.fix}>
              <Ionicons name={f.kind === 'neighbour' ? 'swap-horizontal' : 'add'} size={16} color={palette.blue} />
              <T num style={{ fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.blue }} numberOfLines={1}>
                {f.kind === 'neighbour' ? t('kit_fix_nb', { name: lbl(rows[sumRow][f.i], sumRow), from: f.from, to: f.to }) : t('kit_fix_add', { n: f.width })}
              </T>
            </Press>
          ))}
        </View>
      ) : null}
    </>
  );

  // ----- панель модуля -----
  const modPanel = () => {
    if (!cur) return null;
    const row = sel.row;
    const up = isUpper(row);
    const i = sel.i;
    const where = corner && row !== 'mid' ? `${row === 'base' || row === 'wall' ? t('kit_wall_a') : t('kit_wall_b')} · ` : '';
    const head = sel.tier ? t('kit_k_tier') : row === 'mid' ? t('kit_k_mid') : `${where}${up ? t('kit_upper') : t('kit_lower')} · ${lbl(cur, row)}`;
    const moveBtns = row !== 'mid' && !sel.tier;
    const actions = (
      <View style={{ flexDirection: 'row', gap: 8, paddingTop: 4 }}>
        {moveBtns ? (
          <>
            <Press onPress={() => { setRow(row, moveAt(rows[row], i, -1)); setSel({ row, i: Math.max(0, i - 1) }); }} disabled={lock || i === 0} style={[s.act, { width: 48 }]} accessibilityRole="button" accessibilityLabel={t('kit_move_l')}>
              <Ionicons name="arrow-back" size={18} color={palette.ink} />
            </Press>
            <Press onPress={() => { setRow(row, moveAt(rows[row], i, 1)); setSel({ row, i: Math.min(rows[row].length - 1, i + 1) }); }} disabled={lock || i >= rows[row].length - 1} style={[s.act, { width: 48 }]} accessibilityRole="button" accessibilityLabel={t('kit_move_r')}>
              <Ionicons name="arrow-forward" size={18} color={palette.ink} />
            </Press>
          </>
        ) : null}
        {sel.tier ? (
          <Press onPress={() => { patchMod(row, i, { top: null }); setSel({ row, i }); }} disabled={lock} style={[s.act, { flex: 1 }]} accessibilityRole="button">
            <Ionicons name="trash-outline" size={17} color={palette.redText} />
            <T style={[s.actT, { color: palette.redText }]}>{t('kit_tier_remove')}</T>
          </Press>
        ) : (
          <>
            <Press onPress={() => {
              if (row === 'mid') setRow(row, [...mids, { ...cur, x: num(cur.x, 0) + num(cur.width, 300) }]);
              else setRow(row, duplicateAt(rows[row], i));
              setSel({ row, i: row === 'mid' ? mids.length : i + 1 });
            }} disabled={lock} style={[s.act, { flex: 1 }]} accessibilityRole="button">
              <Ionicons name="copy-outline" size={17} color={palette.ink} />
              <T style={s.actT}>{t('kit_dup')}</T>
            </Press>
            <Press onPress={() => { setRow(row, removeAt(rows[row], i)); setSel({ row, i: Math.max(0, Math.min(i, rows[row].length - 2)) }); }}
              disabled={lock || ((row === 'base') && base.length <= 1) || cur.kind === 'corner'} style={[s.act, { flex: 1 }]} accessibilityRole="button">
              <Ionicons name="trash-outline" size={17} color={palette.redText} />
              <T style={[s.actT, { color: palette.redText }]}>{t('delete')}</T>
            </Press>
          </>
        )}
      </View>
    );
    // антресольный ярус верхнего модуля
    if (sel.tier) {
      const tp = (cur.top as { height?: number | null; doors?: number | null; opening?: string } | null) ?? {};
      return (
        <>
          <T style={s.shx}>{`${head} · ${t('kit_upper')} ${i + 1}`}</T>
          <View>
            <FRow label={t('kit_f_height')}>
              <Stepper value={tp.height ?? KDEF.tier_auto} auto={tp.height == null} step={50} lim={KLIM.tier_height} disabled={lock} autoLabel={t('kit_f_auto')}
                onChange={(v) => patchTier(i, { height: v })} />
            </FRow>
            <FRow label={t('kit_f_opening')} line>
              <MiniSeg value={tp.opening === 'lift' ? 'lift' : 'hinged'} disabled={lock} onChange={(v) => patchTier(i, { opening: v === 'lift' ? 'lift' : null })}
                options={[{ v: 'hinged', l: t('kit_f_hinged') }, { v: 'lift', l: t('kit_f_lift') }]} />
            </FRow>
            {tp.opening !== 'lift' ? (
              <FRow label={t('kit_f_doors')} line>
                <MiniSeg value={String(tp.doors ?? (num(cur.width, 600) <= 600 ? 1 : 2))} disabled={lock} onChange={(v) => patchTier(i, { doors: Number(v) })}
                  options={[{ v: '1', l: '1' }, { v: '2', l: '2' }]} />
              </FRow>
            ) : null}
          </View>
          {actions}
        </>
      );
    }
    const widthLim = row === 'mid' ? KLIM.mid_width : cur.kind === 'cargo' ? KLIM.cargo_width : KLIM.width;
    const sumErr = !!sumRow && sumRow === row;
    const kindChips = row === 'mid' || cur.kind === 'corner' ? null : (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginHorizontal: -16 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }} keyboardShouldPersistTaps="handled">
        {(up ? WALL_KINDS : BASE_KINDS).map((k) => {
          const on = (up ? wallKindOf(cur) : cur.kind) === k;
          return (
            <Press key={k} onPress={() => !on && setRow(row, replaceAt(rows[row], i, withKind(cur, row, k)))} disabled={lock} accessibilityRole="radio" accessibilityState={{ selected: on }}
              style={[s.kc, on && { backgroundColor: palette.ink }]}>
              <T style={{ fontSize: 14, fontWeight: '500', color: on ? palette.white : palette.ink }}>{td(`kit_c_${up && k === 'appliance' ? 'wapp' : k}`, k)}</T>
            </Press>
          );
        })}
      </ScrollView>
    );
    const doorsRow = (line = true) => (
      <FRow label={t('kit_f_doors')} line={line}>
        <MiniSeg value={String(doorCount(cur))} disabled={lock} onChange={(v) => patchMod(row, i, { doors: Number(v) })} options={[{ v: '1', l: '1' }, { v: '2', l: '2' }]} />
      </FRow>
    );
    const hingeRow = doorCount(cur) === 1 ? (
      <FRow label={t('kit_f_hinge')} line>
        <MiniSeg value={cur.hinge === 'right' ? 'right' : 'left'} disabled={lock} onChange={(v) => patchMod(row, i, { hinge: v === 'right' ? 'right' : null })}
          options={[{ v: 'left', l: t('kit_f_left') }, { v: 'right', l: t('kit_f_right') }]} />
      </FRow>
    ) : null;
    const openingRows = (
      <>
        <FRow label={t('kit_f_opening')} line>
          <MiniSeg value={cur.opening === 'lift' ? 'lift' : 'hinged'} disabled={lock} onChange={(v) => patchMod(row, i, v === 'lift' ? { opening: 'lift' } : { opening: null, flaps: null })}
            options={[{ v: 'hinged', l: t('kit_f_hinged') }, { v: 'lift', l: t('kit_f_lift') }]} />
        </FRow>
        {cur.opening === 'lift' ? (
          <FRow label={t('kit_f_flaps')} line>
            <MiniSeg value={cur.flaps === 2 ? '2' : '1'} disabled={lock} onChange={(v) => patchMod(row, i, { flaps: v === '2' ? 2 : null })} options={[{ v: '1', l: '1' }, { v: '2', l: '2' }]} />
          </FRow>
        ) : <>{doorsRow()}{hingeRow}</>}
        {cur.opening !== 'lift' && cur.kind === 'doors' && !hasOpenBottom(cur) ? (
          <FRow label={t('kit_f_rows')} line>
            <MiniSeg value={cur.rows === 2 ? '2' : '1'} disabled={lock} onChange={(v) => patchMod(row, i, { rows: v === '2' ? 2 : null })} options={[{ v: '1', l: '1' }, { v: '2', l: '2' }]} />
          </FRow>
        ) : null}
      </>
    );
    // открытая ниша без фасада внизу (банки, специи), фасады — над ней
    const openBottomRows = (
      <>
        <FRow label={t('kit_f_open_bottom')} line>
          <Toggle value={hasOpenBottom(cur)} disabled={lock} accessibilityLabel={t('kit_f_open_bottom')}
            onValueChange={(on) => patchMod(row, i, on ? { open_bottom: 400, rows: null } : { open_bottom: null })} />
        </FRow>
        {hasOpenBottom(cur) ? (
          <FRow label={t('kit_f_niche')} line>
            <Stepper value={num(cur.open_bottom, 400)} step={10} lim={KLIM.open_bottom} disabled={lock} onChange={(v) => patchMod(row, i, { open_bottom: v ?? 400 })} />
          </FRow>
        ) : null}
      </>
    );
    const shelvesRow = (
      <FRow label={t('kit_f_shelves')} line>
        <Stepper value={num(cur.shelves, 1)} step={1} lim={KLIM.shelves} disabled={lock} onChange={(v) => patchMod(row, i, { shelves: v ?? 1 })} />
      </FRow>
    );
    const heightRow = (
      <FRow label={t('kit_f_height')} line>
        <Stepper value={wallModHeight(cur, tree)} auto={typeof cur.height !== 'number'} step={10} lim={KLIM.mod_height} disabled={lock} autoLabel={t('kit_f_auto')}
          onChange={(v) => patchMod(row, i, { height: v })} />
      </FRow>
    );
    const tierRow = (
      <FRow label={t('kit_f_tier')} line>
        <Toggle value={hasTier(cur)} disabled={lock} accessibilityLabel={t('kit_f_tier')} onValueChange={(on) => { patchMod(row, i, { top: on ? { opening: 'hinged' } : null }); if (on) setSel({ row, i, tier: true }); }} />
      </FRow>
    );
    let fields: ReactNode = null;
    if (row === 'mid') {
      fields = (
        <>
          <FRow label={t('kit_f_x')}>
            <Stepper value={num(cur.x, 0)} step={50} lim={[0, Math.max(0, sumA - num(cur.width, 300))]} disabled={lock} onChange={(v) => patchMod(row, i, { x: v ?? 0 })} />
          </FRow>
          <FRow label={t('kit_f_height')} line>
            <Stepper value={num(cur.height, num(tree.wall_bottom, KDEF.wall_bottom) - num(tree.legs_height, KDEF.legs_height) - num(tree.base_height, KDEF.base_height) - 38)} auto={typeof cur.height !== 'number'}
              step={10} lim={KLIM.mid_height} disabled={lock} autoLabel={t('kit_f_auto')} onChange={(v) => patchMod(row, i, { height: v })} />
          </FRow>
          {shelvesRow}
        </>
      );
    } else if (up) {
      const wk = wallKindOf(cur);
      if (wk === 'doors' || wk === 'lift') fields = <>{openingRows}{openBottomRows}{shelvesRow}{heightRow}{tierRow}</>;
      else if (wk === 'open') fields = <>{shelvesRow}{heightRow}{tierRow}</>;
      else if (wk === 'hood') fields = <>{openingRows}{heightRow}{tierRow}</>;
      else if (wk === 'appliance') {
        fields = (
          <>
            <FRow label={t('kit_f_appliance')} line>
              <MiniSeg value={cur.appliance === 'oven' ? 'oven' : 'microwave'} disabled={lock} onChange={(v) => patchMod(row, i, { appliance: v, niche_height: null })}
                options={[{ v: 'microwave', l: t('kit_k_micro') }, { v: 'oven', l: t('kit_k_oven') }]} />
            </FRow>
            <FRow label={t('kit_f_niche')} line>
              <Stepper value={nicheHeight(cur)} auto={typeof cur.niche_height !== 'number'} step={10} lim={KLIM.niche_height} disabled={lock} autoLabel={t('kit_f_auto')}
                onChange={(v) => patchMod(row, i, { niche_height: v })} />
            </FRow>
            <FRow label={t('kit_f_above')} line>
              <MiniSeg value={typeof cur.above === 'string' ? cur.above : 'door'} disabled={lock} onChange={(v) => patchMod(row, i, { above: v === 'door' ? null : v })}
                options={(['door', 'lift', 'open', 'none'] as const).map((v) => ({ v, l: t(`kit_f_above_${v}`) }))} />
            </FRow>
            <FRow label={t('kit_f_niche_frame')} line>
              <Toggle value={cur.niche_frame === true} disabled={lock} accessibilityLabel={t('kit_f_niche_frame')} onValueChange={(on) => patchMod(row, i, { niche_frame: on ? true : null })} />
            </FRow>
            {tierRow}
          </>
        );
      } else fields = <T v="cap" style={{ paddingVertical: 8 }}>{t('kit_gap_note')}</T>;
    } else {
      const k = cur.kind;
      if (k === 'doors') {
        fields = (
          <>
            {doorsRow()}{hingeRow}
            <FRow label={t('kit_f_shelf')} line><Toggle value={cur.shelf !== false} disabled={lock} accessibilityLabel={t('kit_f_shelf')} onValueChange={(on) => patchMod(row, i, { shelf: on ? null : false })} /></FRow>
          </>
        );
      } else if (k === 'drawers') {
        fields = (
          <>
            <FRow label={t('kit_f_drawers')} line><Stepper value={num(cur.drawers, 3)} step={1} lim={KLIM.drawers} disabled={lock} onChange={(v) => patchMod(row, i, { drawers: v ?? 3 })} /></FRow>
            {num(cur.drawers, 3) >= 2 ? (
              <FRow label={t('kit_f_drawer_layout')} line>
                <MiniSeg value={cur.drawer_layout === 'small_top' ? 'small_top' : 'equal'} disabled={lock} onChange={(v) => patchMod(row, i, { drawer_layout: v === 'small_top' ? 'small_top' : null })}
                  options={[{ v: 'equal', l: t('kit_f_dl_equal') }, { v: 'small_top', l: t('kit_f_dl_small_top') }]} />
              </FRow>
            ) : null}
          </>
        );
      } else if (k === 'sink') fields = <>{doorsRow()}{hingeRow}</>;
      else if (k === 'cargo') fields = <T v="cap" style={{ paddingVertical: 8 }}>{t('kit_cargo_note')}</T>;
      else if (k === 'appliance') {
        fields = (
          <>
            <FRow label={t('kit_f_hob')} line><Toggle value={!!cur.hob} disabled={lock} accessibilityLabel={t('kit_f_hob')} onValueChange={(on) => patchMod(row, i, { hob: on ? true : null })} /></FRow>
            <FRow label={t('kit_f_dw')} line><Toggle value={!!cur.dw} disabled={lock} accessibilityLabel={t('kit_f_dw')} onValueChange={(on) => patchMod(row, i, { dw: on ? true : null })} /></FRow>
          </>
        );
      } else if (k === 'fridge') {
        fields = (
          <FRow label={t('kit_f_fridge_h')} line>
            <Stepper value={num(cur.fridge_height, KDEF.fridge_height)} step={50} lim={KLIM.fridge_height} disabled={lock} onChange={(v) => patchMod(row, i, { fridge_height: v })} />
          </FRow>
        );
      } else if (k === 'corner') {
        fields = <KV k={t('kit_f_corner_go')} v={t('kit_tab_corner')} onPress={() => setTab('corner')} line />;
      }
    }
    return (
      <>
        <T style={s.shx} numberOfLines={2}>{row === 'mid' ? `${head} ${i + 1}` : head}</T>
        {kindChips}
        <WidthBox label={t('p_width')} value={num(cur.width, 0)} unit={t('mm')} disabled={lock} err={sumErr} lim={widthLim}
          onChange={(v) => patchMod(row, i, { width: v })} />
        <View>
          {fields}
          {row !== 'mid' && cur.kind !== 'gap' ? (
            <KV k={t('kit_front')} v={[decorName(tree.fronts?.material), paintCode].filter(Boolean).join(' · ')} onPress={() => router.push({ pathname: '/project/[id]/materials', params: { id } })} line />
          ) : null}
        </View>
        {row !== 'mid' ? sumBanner : null}
        {actions}
      </>
    );
  };

  // ----- «Кухня»: высоты и глубины -----
  const P = (k: string, d: number) => num(tree[k], d);
  const kitPanel = (
    <>
      <View>
        <FRow label={t('kit_p_legs')}><Stepper value={P('legs_height', KDEF.legs_height)} step={10} lim={KLIM.legs_height} disabled={lock} onChange={(v) => onField('/legs_height', v)} /></FRow>
        <FRow label={t('kit_p_base_h')} line><Stepper value={P('base_height', KDEF.base_height)} step={10} lim={KLIM.base_height} disabled={lock} onChange={(v) => onField('/base_height', v)} /></FRow>
        <FRow label={t('kit_p_base_d')} line><Stepper value={P('base_depth', KDEF.base_depth)} step={10} lim={KLIM.base_depth} disabled={lock} onChange={(v) => onField('/base_depth', v)} /></FRow>
        <FRow label={t('kit_p_ct_d')} line><Stepper value={ctDepth} step={10} lim={KLIM.ct_depth} disabled={lock} onChange={(v) => onField('/countertop/depth', v)} /></FRow>
        <FRow label={t('kit_p_wall_bottom')} line><Stepper value={P('wall_bottom', KDEF.wall_bottom)} step={10} lim={KLIM.wall_bottom} disabled={lock} onChange={(v) => onField('/wall_bottom', v)} /></FRow>
        <FRow label={t('kit_p_ceiling')} line><Toggle value={tree.wall_to_ceiling === true} disabled={lock} accessibilityLabel={t('kit_p_ceiling')} onValueChange={(on) => onField('/wall_to_ceiling', on)} /></FRow>
        {tree.wall_to_ceiling === true ? (
          <T v="cap" style={{ fontSize: 13, paddingBottom: 8 }}>{t('kit_p_ceiling_note')}</T>
        ) : (
          <FRow label={t('kit_p_wall_h')} line><Stepper value={P('wall_height', KDEF.wall_height)} step={10} lim={KLIM.wall_height} disabled={lock} onChange={(v) => onField('/wall_height', v)} /></FRow>
        )}
        <FRow label={t('kit_p_wall_d')} line><Stepper value={P('wall_depth', KDEF.wall_depth)} step={10} lim={KLIM.wall_depth} disabled={lock} onChange={(v) => onField('/wall_depth', v)} /></FRow>
      </View>
      <T v="cap" num style={{ fontSize: 13 }}>{t('kit_p_total', { n: P('legs_height', KDEF.legs_height) + P('base_height', KDEF.base_height) })}</T>
    </>
  );

  // ----- техника: иконки по виду -----
  type Apl = { m: KMod; row: KRow; i: number; icon: keyof typeof MaterialCommunityIcons.glyphMap };
  const aplIcon = (m: KMod, row: KRow): Apl['icon'] | null => {
    if (isUpper(row)) return m.kind === 'hood' ? 'fan' : m.kind === 'appliance' ? (m.appliance === 'oven' ? 'toaster-oven' : 'microwave') : null;
    if (m.kind === 'sink') return 'faucet';
    if (m.kind === 'fridge') return 'fridge-outline';
    if (m.kind === 'appliance') return m.hob ? 'stove' : labelCode(m, row) === 'dw' ? 'dishwasher' : 'toaster-oven';
    return null;
  };
  const appliances: Apl[] = (['base', 'wall', 'base2', 'wall2'] as const).flatMap((row) => rows[row].flatMap((m, i) => {
    const icon = aplIcon(m, row);
    return icon ? [{ m, row: row as KRow, i, icon }] : [];
  }));

  // ----- 3D: деталь → модуль -----
  const pickLabel = (p: KSel | 'top') => p === 'top' ? t('kit_top')
    : p.tier ? `${t('kit_k_tier')} · ${t('kit_upper')} ${p.i + 1}`
      : p.row === 'mid' ? `${t('kit_k_mid')} ${p.i + 1}` : `${isUpper(p.row) ? t('kit_upper') : t('kit_lower')} ${p.i + 1} · ${rows[p.row][p.i] ? lbl(rows[p.row][p.i], p.row) : ''}`;
  const editPick = (p: KSel | 'top') => {
    setMode('scheme');
    setPick3d(null);
    if (p === 'top') { setTab('top'); return; }
    if (corner) setRunView(p.row === 'base2' || p.row === 'wall2' ? 2 : rows[p.row][p.i]?.kind === 'corner' ? 'plan' : 1);
    pick(p);
  };

  const scheme = mode === 'scheme';
  const chatBadge = chat.messages.length > seen;
  // панель: в схеме — от вкладок до низа; в 3D — по содержимому (с перепиской — выше)
  const panelTop = scheme ? top + (chatOpen ? TABS : PANEL) : chatOpen ? top + 250 : undefined;
  const layout = runView === 'plan' ? null : schemeLayout(tree, runView);
  const lenPill = layout ? (wallA != null && runView === 1 ? wallA : runView === 2 && site?.wall_b ? site.wall_b : layout.baseLen) : null;

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      {/* 3D: тот же канвас, что у шкафа; модель — между строкой «Схема/3D» и панелью */}
      {!scheme ? (
        <View style={StyleSheet.absoluteFill}>
          <ProductCanvas ref={canvas} model={viewer} transparent busy={busy} fallbackText={t('ed_3d_unavailable')}
            freeArea={{ top: top + AREA, bottom: panelTop != null ? 0 : panelH }} freeAreaPadding={20} dimensionLines={dims} dimensions={dims ? undefined : []}
            onPartTap={(p) => setPick3d(p ? selFromPartKey(p.key, tree) : null)} />
        </View>
      ) : null}
      {/* схема */}
      {scheme ? (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: top + AREA + AREA_H }}>
          {layout ? (
            <Facade tree={tree} layout={layout} run={runView === 2 ? 2 : 1} sel={tab === 'mod' || tab === 'corner' ? sel : null} onPick={pick} onAdd={lock ? undefined : addModule}
              lbl={lbl} shortLbl={shortLbl} W={W} y0={top + AREA} addLabels={{ base: t('kit_add_base'), wall: t('kit_add_wall'), mid: t('kit_add_mid') }} cornerLabel={t('kit_k_corner')}
              tierLabel={[t('kit_k_tier'), t('kit_ks_tier')]} />
          ) : (
            <CornerPlan tree={tree} base={base} base2={base2} sel={tab === 'mod' || tab === 'corner' ? sel : null} onPick={pick} lbl={(m) => shortLbl(m, 'base')} y0={top + AREA} />
          )}
        </View>
      ) : null}
      {/* шапка */}
      <View style={[s.hdr, { marginTop: top }]} pointerEvents="box-none">
        <IconButton icon="chevron-back" label={t('ed_to_project')} onPress={() => (router.canGoBack() ? router.back() : router.replace(`/project/${id}`))} style={s.lift} />
        <View style={[s.tpill, s.lift]}>
          <T style={{ fontSize: 15, lineHeight: 19, fontWeight: '600' }} numberOfLines={1}>{title}</T>
          <T style={{ fontSize: 13, lineHeight: 16, color: palette.muted }} numberOfLines={1}>
            {sub ?? (corner ? t('kit_sub_corner', { n: base.length + base2.length }) : t('kit_sub_straight', { a: base.length, b: wall.length }))}
          </T>
        </View>
        <IconButton icon="color-palette-outline" label={t('ed2_kitchen_tools')} onPress={() => setMenu(true)} style={s.lift} />
      </View>
      {/* размер · план/стены · Схема / 3D */}
      <View style={[s.row2, { top: top + ROW2 }]} pointerEvents="box-none">
        {scheme && corner ? (
          <View style={[s.pills, s.lift]}>
            {(['plan', 1, 2] as RunView[]).map((r) => (
              <Press key={String(r)} feedback="opacity" onPress={() => setRunView(r)} accessibilityRole="tab" accessibilityState={{ selected: runView === r }} style={[s.pill, runView === r && s.pillOn]}>
                <T style={[s.pillT, runView === r && { color: palette.white }]}>{r === 'plan' ? t('kit_v_plan') : r === 1 ? t('kit_a') : t('kit_b')}</T>
              </Press>
            ))}
          </View>
        ) : scheme && lenPill != null ? (
          <View style={[s.dimc, s.lift]}><T num style={s.dimT}>{lenPill}</T><T style={s.dimS}>{t('mm')}</T></View>
        ) : <View />}
        {corner && scheme && layout && lenPill != null ? (
          <View style={[s.dimc, s.lift, { marginLeft: 8 }]}><T num style={s.dimT}>{lenPill}</T><T style={s.dimS}>{t('mm')}</T></View>
        ) : null}
        <View style={{ flex: 1 }} />
        <View style={[s.pills, s.lift]}>
          {(['scheme', '3d'] as View3[]).map((v) => (
            <Press key={v} feedback="opacity" onPress={() => { setMode(v); setPick3d(null); Keyboard.dismiss(); }} accessibilityRole="tab" accessibilityState={{ selected: mode === v }} style={[s.pill, mode === v && s.pillOn]}>
              <T style={[s.pillT, mode === v && { color: palette.white }]}>{v === 'scheme' ? t('kit_v_scheme') : t('kit_v_3d')}</T>
            </Press>
          ))}
        </View>
      </View>
      <DecorMenu id={id} tree={tree} visible={menu} onClose={() => setMenu(false)} withHardware />
      {/* вкладки (открытый чат их закрывает) */}
      {scheme && !chatOpen ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.tabs, { top: top + TABS }]} contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingBottom: 8 }}>
          {tabs.map((k) => {
            const on = tab === k && !chatOpen;
            return (
              <Press key={k} onPress={() => { setChatOpen(false); setTab(k); if (k === 'corner' && cornerIdx >= 0) setSel({ row: 'base', i: cornerIdx }); }} accessibilityRole="tab" accessibilityState={{ selected: on }}
                style={[s.tab, on && { backgroundColor: palette.ink }]}>
                <T style={{ fontSize: 15, fontWeight: '500', color: on ? palette.white : palette.ink }}>{tabLabel[k]}</T>
              </Press>
            );
          })}
        </ScrollView>
      ) : null}
      {/* панель */}
      <View style={[s.es, panelTop != null ? { top: panelTop } : null]} onLayout={(e) => { if (panelTop == null) setPanelH(e.nativeEvent.layout.height); }}>
        <SurfaceProvider value="white">
          {chatOpen ? (
            <View style={{ flex: 1 }}>
              <View style={s.chatHdr}>
                <Ionicons name="chatbubbles-outline" size={18} color={palette.ink} />
                <T style={{ flex: 1, fontSize: 17, lineHeight: 22, fontWeight: '700' }}>{t('ed_side_chat')}</T>
                <IconButton icon="chevron-down" label={t('kit_chat_close')} onPress={() => setChatOpen(false)} />
              </View>
              <KitchenChat {...chat} busy={chat.busy || busy} disabled={disabled} onSend={(x) => onSend(x)} />
            </View>
          ) : !scheme ? (
            <View style={{ paddingTop: 16, paddingHorizontal: 16, gap: 10 }}>
              {pick3d ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={s.ap}><Ionicons name="cube-outline" size={20} color={palette.blue} /></View>
                  <T style={{ flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600' }} numberOfLines={2}>{pickLabel(pick3d)}</T>
                  <Press onPress={() => editPick(pick3d)} style={s.edit} accessibilityRole="button">
                    <Ionicons name="create-outline" size={17} color={palette.white} />
                    <T style={{ fontSize: 15, fontWeight: '600', color: palette.white }}>{t('kit_3d_edit')}</T>
                  </Press>
                </View>
              ) : <T v="cap" style={{ fontSize: 13, lineHeight: 18 }}>{t('kit_3d_hint')}</T>}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Press onPress={() => { if (openAll) canvas.current?.closeAll(); else canvas.current?.openAll(); setOpenAll(!openAll); }} style={s.tl} accessibilityRole="button">
                  <Ionicons name={openAll ? 'eye-off-outline' : 'eye-outline'} size={16} color={palette.ink} />
                  <T style={s.tlT}>{t(openAll ? 'ed_view_close' : 'ed_view_open')}</T>
                </Press>
                <Press onPress={() => setDims(!dims)} style={[s.tl, dims && { backgroundColor: palette.blueSoft }]} accessibilityRole="switch" accessibilityState={{ checked: dims }}>
                  <Ionicons name="resize-outline" size={16} color={dims ? palette.blue : palette.ink} />
                  <T style={[s.tlT, dims && { color: palette.blue }]}>{t('ed_dims')}</T>
                </Press>
              </View>
            </View>
          ) : (
            <ScrollView ref={panelScroll} style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 18, paddingHorizontal: 16, paddingBottom: 12, gap: 10 }} keyboardShouldPersistTaps="handled">
              {tab === 'mod' ? modPanel() : null}
              {tab === 'top' ? (
                <>
                  <View>
                    <KV k={t('kit_top')} v={decorName((tree.countertop as { material?: string } | undefined)?.material)} onPress={() => setMenu(true)} />
                    <KV k={corner ? t('kit_lengths') : t('kit_len_depth')} v={corner ? `${sumA} + ${sumB} × ${ctDepth}` : `${sumA} × ${ctDepth}`} num line />
                    <FRow label={t('kit_p_ct_d')} line><Stepper value={ctDepth} step={10} lim={KLIM.ct_depth} disabled={lock} onChange={(v) => onField('/countertop/depth', v)} /></FRow>
                    {corner ? <KV k={t('kit_joint')} v={t('kit_joint_v')} line /> : null}
                    {(['base', 'base2'] as const).flatMap((row) => rows[row].map((m, i) => (m.kind === 'sink'
                      ? <KV key={`s${row}${i}`} k={t('kit_cut_sink')} v={corner ? `${row === 'base' ? t('kit_wall_a') : t('kit_wall_b')}, ${t('kit_module_n', { n: i + 1 })}` : t('kit_module_n', { n: i + 1 })} line /> : null)))}
                    {(['base', 'base2'] as const).flatMap((row) => rows[row].map((m, i) => (m.kind === 'appliance' && m.hob
                      ? <KV key={`h${row}${i}`} k={t('kit_cut_hob')} v={corner ? `${row === 'base' ? t('kit_wall_a') : t('kit_wall_b')}, ${t('kit_module_n', { n: i + 1 })}` : t('kit_module_n', { n: i + 1 })} line /> : null)))}
                  </View>
                  <T v="cap">{t('kit_top_note')}</T>
                </>
              ) : null}
              {tab === 'app' ? (
                <>
                  <View>
                    {appliances.length ? appliances.map((x, j) => (
                      <Press feedback="row" key={`${x.row}${x.i}`} onPress={() => { if (corner) setRunView(x.row === 'base2' || x.row === 'wall2' ? 2 : 1); pick({ row: x.row, i: x.i }); }} style={[s.apl, j > 0 && s.line]} accessibilityRole="button">
                        <View style={s.ap}><MaterialCommunityIcons name={x.icon} size={22} color={palette.blue} /></View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T v="rt">{`${lbl(x.m, x.row)} ${x.m.width ?? ''}`.trim()}</T>
                          <T v="rs">{`${isUpper(x.row) ? t('kit_upper_short') : ''}${t('kit_module_n', { n: x.i + 1 })}${corner ? ` · ${x.row.endsWith('2') ? t('kit_wall_b') : t('kit_wall_a')}` : ''}`}</T>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={palette.chev} />
                      </Press>
                    )) : <T v="sub">—</T>}
                  </View>
                  <T v="cap">{t('kit_app_note')}</T>
                </>
              ) : null}
              {tab === 'corner' && cornerMod ? (
                <>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <T style={s.shx}>{t('kit_corner_mod')}</T>
                    <T v="rs" num>{cornerMod.corner_shape === 'square' ? `${cornerMod.width ?? 900} × ${cornerMod.width ?? 900} ${t('mm')}` : `${cornerMod.width ?? ''} ${t('mm')}`}</T>
                  </View>
                  {(cornerGroup?.options ?? []).map((o) => {
                    const on = applying ? applying === o.value : o.current;
                    const d = o.delta == null ? null : blindDelta != null ? o.delta - blindDelta : o.delta;
                    return (
                      <Press key={o.value} onPress={() => !o.current && applyFill(o.value)} disabled={lock || !!applying || !o.available}
                        accessibilityRole="radio" accessibilityState={{ selected: on, disabled: !o.available }} style={[s.op, on && { backgroundColor: palette.ink }, !o.available && { opacity: 0.45 }]}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T v="rt" color={on ? palette.white : undefined}>{o.label.replace(/\s*\(.*\)$/, '')}</T>
                          <T v="rs" style={{ fontSize: 13, lineHeight: 17 }} color={on ? palette.chev : undefined}>{o.note || t(`kit_fill_note_${o.value}` as 'kit_fill_note_blind')}</T>
                        </View>
                        {d != null ? <T num style={{ fontSize: 15, fontWeight: '600', color: on ? palette.white : palette.ink }}>{d === 0 ? '0' : `${d > 0 ? '+' : '−'}${groupDigits(Math.abs(d))}`}</T> : null}
                      </Press>
                    );
                  })}
                  {cornerMod.corner_shape === 'square' ? (
                    <MiniSeg value={String(cornerMod.width ?? 900)} disabled={lock} onChange={(v) => patchMod('base', cornerIdx, { width: Number(v) })} wide
                      options={[{ v: '900', l: '900 × 900' }, { v: '1000', l: '1000 × 1000' }]} />
                  ) : (
                    <WidthBox label={t('p_width')} value={num(cornerMod.width, 1000)} unit={t('mm')} disabled={lock} err={false} lim={KLIM.width} onChange={(v) => patchMod('base', cornerIdx, { width: v })} />
                  )}
                  {sumBanner}
                </>
              ) : null}
              {tab === 'kit' ? kitPanel : null}
            </ScrollView>
          )}
          <View style={s.inpWrap}>
            <View style={s.inp}>
              <Pressable onPress={() => setChatOpen(!chatOpen)} accessibilityRole="button" accessibilityLabel={chatOpen ? t('kit_chat_close') : t('kit_chat_open')} hitSlop={6} style={[s.chatBtn, chatOpen && { backgroundColor: palette.ink }]}>
                {chat.running && !chatOpen ? <ActivityIndicator size="small" color={palette.green} />
                  : <Ionicons name={chatOpen ? 'chevron-down' : 'chatbubbles-outline'} size={18} color={chatOpen ? palette.white : palette.ink} />}
                {chatBadge && !chatOpen ? <View style={s.badge} /> : null}
              </Pressable>
              <TextInput value={text} onChangeText={setText} placeholder={chat.aiLimited ? t('ail_input') : disabled ? t('ed_offline') : corner ? t('kit_ph_corner') : t('kit_ph')} placeholderTextColor={palette.muted}
                editable={!disabled && !chat.running && !chat.aiLimited} onSubmitEditing={send} returnKeyType="send" accessibilityLabel={t('ed_say')}
                style={resolveFont([ty.body, { flex: 1, fontSize: 14, color: palette.ink, paddingVertical: 0 }])} />
              <Pressable onPress={send} disabled={!text.trim() || disabled || chat.running} accessibilityLabel={t('ed_send')} style={[s.go, (!text.trim() || chat.running) && { opacity: 0.4 }]}>
                <Ionicons name="arrow-up" size={18} color={palette.white} />
              </Pressable>
            </View>
          </View>
          <View style={[s.cbar, { paddingBottom: Math.max(insets.bottom - 10, 24) }]}>
            {price && price !== '—' ? (
              <Press onPress={() => router.push({ pathname: '/project/[id]/estimate', params: { id } })} style={s.pr} accessibilityRole="button">
                <T v="cap" style={{ fontSize: 13, lineHeight: 16 }}>{t('ed_before_measure')}</T>
                <T num style={{ fontSize: 16, lineHeight: 20, fontWeight: '700' }}>{price}</T>
              </Press>
            ) : null}
            <Press onPress={() => router.push({ pathname: '/project/[id]/send', params: { id } })} style={s.cta} accessibilityRole="button">
              <T style={{ fontSize: 17, fontWeight: '600', color: palette.white }}>{t('ed_to_client')}</T>
              <Ionicons name="paper-plane-outline" size={18} color={palette.white} />
            </Press>
          </View>
        </SurfaceProvider>
      </View>
    </View>
  );
}

/** Полосы схемы по высоте (pt): антресоль, верхние, промежуток с полками на столешнице, столешница, нижние. */
const B = { tier: 20, wall: 66, gap: 40, ct: 10, base: 74 };
const PAD = 12;
const PLUS = 36;

/**
 * Фасад ряда по реальным ширинам: мм → pt одним масштабом для всех рядов; рамки 3 pt внахлёст, как в макете.
 * Верхние висят от общей линии верха (вытяжка короче), ярус — коробом над модулем, холодильник — от пола до верха
 * верхних, пустое место — пунктиром. Ширина модуля — мелко сверху, вид — снизу.
 */
function Facade({ tree, layout, run, sel, onPick, onAdd, lbl, shortLbl, W, y0, addLabels, cornerLabel, tierLabel }: {
  tree: ProductTree; layout: KLayout; run: 1 | 2; sel: KSel | null; onPick: (s: KSel) => void; onAdd?: (row: KRow) => void;
  lbl: (m: KMod, row: KRow) => string; shortLbl: (m: KMod, row: KRow) => string; W: number; y0: number;
  addLabels: Record<'base' | 'wall' | 'mid', string>; cornerLabel: string;
  /** «Антресоль» полностью и коротко. */
  tierLabel: [string, string];
}) {
  const plusLeft = run === 2 && tree.corner_side === 'left';
  const avail = W - 2 * PAD - PLUS;
  const k = avail / layout.len;
  const X0 = PAD + (plusLeft ? PLUS : 0);
  const px = (mm: number) => Math.round(mm * k);
  const anyTier = layout.wall.some((b) => hasTier(b.m));
  const yWall = y0 + (anyTier ? B.tier : 8);
  const yCt = yWall + B.wall + B.gap;
  const yBase = yCt + B.ct;
  const yBot = yBase + B.base;
  const wh = num(tree.wall_height, KDEF.wall_height);
  const ctTop = num(tree.legs_height, KDEF.legs_height) + num(tree.base_height, KDEF.base_height) + 38;
  const gapMm = Math.max(1, num(tree.wall_bottom, KDEF.wall_bottom) - ctTop);
  const isOn = (b: KSel, tier = false) => !!sel && sel.row === b.row && sel.i === b.i && !!sel.tier === tier;
  const boxStyle = (x: number, w: number) => ({ left: X0 + px(x), width: Math.max(8, px(x + w) - px(x) + 3) });
  // пустое место над холодильником не рисуем отдельно — холодильник и так до верха верхних
  const fridges = fridgeSpans(layout);
  // столешница — над нижними и угловой зоной, без холодильников с краёв
  const spans = [...layout.base, ...(layout.corner ? [layout.corner] : [])];
  let ctLo = spans.length ? Math.min(...spans.map((b) => b.x)) : 0;
  let ctHi = spans.length ? Math.max(...spans.map((b) => b.x + b.w)) : 0;
  for (const f of fridges) {
    if (f.x <= ctLo + 1) ctLo = Math.max(ctLo, f.x + f.w);
    else if (f.x + f.w >= ctHi - 1) ctHi = Math.min(ctHi, f.x);
  }
  const plusX = plusLeft ? PAD - 2 : X0 + px(layout.len) + 8;
  const cell = (b: { sel: KSel; x: number; w: number; m: KMod }, row: KRow, top: number, h: number, bg: string, extra?: ReactNode, wTop?: number) => {
    const on = isOn(b.sel);
    const wpx = px(b.x + b.w) - px(b.x);
    const gap = b.m.kind === 'gap';
    return (
      <Pressable key={`${row}${b.sel.i}`} onPress={() => onPick(b.sel)} accessibilityRole="button" accessibilityLabel={`${lbl(b.m, row)} ${b.w}`}
        style={[s.mod, boxStyle(b.x, b.w), { top, height: h, backgroundColor: bg }, gap && s.gapBox, on && s.modOn]}>
        {extra}
        {/* низкий модуль (вытяжка) — ширина в той же строке */}
        {h >= 44 ? <T num style={[s.modW, wTop != null && { top: wTop }, on && { color: palette.blue }]} numberOfLines={1}>{b.w}</T> : null}
        <Fit style={[s.modT, wpx < 64 && { fontSize: 11 }, on && { color: palette.blue }]}>{`${wpx >= 84 ? lbl(b.m, row) : shortLbl(b.m, row)}${h < 44 ? ` ${b.w}` : ''}`}</Fit>
      </Pressable>
    );
  };
  const wallRow: KRow = run === 2 ? 'wall2' : 'wall';
  const baseRow: KRow = run === 2 ? 'base2' : 'base';
  return (
    <>
      {/* холодильник — от пола до верха верхних, под рядами */}
      {layout.base.filter((b) => b.m.kind === 'fridge').map((b) => cell(b, baseRow, yWall, yBot - yWall, '#ECEBE6', null, yBase - yWall + 2))}
      {/* верхние */}
      {layout.wall.filter((b) => !(b.m.kind === 'gap' && fridges.some((f) => b.x >= f.x - 1 && b.x + b.w <= f.x + f.w + 1))).map((b) => {
        const m = b.m;
        const h = m.kind === 'gap' ? B.wall : clamp(Math.round((wallModHeight(m, tree) / wh) * B.wall), [22, B.wall + B.gap - 8]);
        const wpx = px(b.x + b.w) - px(b.x);
        const lines: ReactNode[] = [];
        if (m.kind === 'doors' || m.kind === 'hood') {
          // открытая ниша внизу (полка внутри), фасады — над ней
          const ob = hasOpenBottom(m) ? Math.min(h - 14, Math.round((num(m.open_bottom, 400) / wallModHeight(m, tree)) * (h - 6))) : 0;
          if (ob) {
            lines.push(<View key="ob" style={[s.niche, { height: ob, backgroundColor: '#FBFAF8', borderWidth: 1, borderColor: palette.chev }]} />);
            lines.push(<View key="obs" style={[s.hl, { top: h - 6 - 3 - ob / 2, left: 6, right: 6, backgroundColor: palette.handle }]} />);
          }
          const fh = h - 6 - (ob ? ob + 3 : 0); // высота фасадной части
          if (m.opening === 'lift' && m.flaps === 2) lines.push(<View key="f" style={[s.hl, { top: fh / 2 }]} />);
          else if (m.opening !== 'lift' && m.rows === 2 && !ob) lines.push(<View key="r" style={[s.hl, { top: fh / 2 }]} />);
          if (m.opening !== 'lift' && doorCount(m) === 2) lines.push(<View key="d" style={[s.vl, ob ? { top: 3, bottom: ob + 6 } : null, { left: wpx / 2 - 1 }]} />);
          if (m.opening === 'lift') lines.push(<Ionicons key="u" name="chevron-up" size={11} color={palette.chev} style={{ position: 'absolute', right: 3, top: 2 }} />);
        } else if (m.kind === 'appliance') {
          const nh = m.above === 'none' ? h - 6 : Math.min(h - 10, Math.round((nicheHeight(m) / wallModHeight(m, tree)) * (h - 6)));
          // в рамке — проём меньше, вокруг — полоса цвета фасадов
          lines.push(<View key="n" style={[s.niche, { height: nh }, m.niche_frame === true && [s.nicheFramed, { height: Math.max(6, nh - 8) }]]} />);
        } else if (m.kind === 'open') {
          const n = num(m.shelves, 2);
          for (let j = 1; j <= n; j++) lines.push(<View key={`s${j}`} style={[s.hl, { top: ((h - 6) * j) / (n + 1), backgroundColor: palette.handle }]} />);
        }
        return (
          <View key={`w${b.sel.i}`}>
            {hasTier(m) ? (
              <Pressable onPress={() => onPick({ ...b.sel, tier: true })} accessibilityRole="button" accessibilityLabel={tierLabel[0]}
                style={[s.mod, boxStyle(b.x, b.w), { top: yWall - B.tier + 1, height: B.tier + 2, backgroundColor: '#EFEEEA', justifyContent: 'center', paddingBottom: 0 }, isOn(b.sel, true) && s.modOn]}>
                <Fit style={[s.tierT, isOn(b.sel, true) && { color: palette.blue }]}>{wpx >= 70 ? tierLabel[0] : tierLabel[1]}</Fit>
              </Pressable>
            ) : null}
            {cell(b, wallRow, yWall, h, m.kind === 'gap' ? 'transparent' : m.kind === 'open' ? '#FBFAF8' : '#F7F7F5', <>{lines}</>)}
          </View>
        );
      })}
      {/* полки на столешнице */}
      {layout.mid.map((b) => {
        const hmm = typeof b.m.height === 'number' ? b.m.height : gapMm;
        const h = clamp(Math.round((hmm / gapMm) * B.gap), [14, B.gap]);
        const on = isOn(b.sel);
        return (
          <Pressable key={`m${b.sel.i}`} onPress={() => onPick(b.sel)} accessibilityRole="button" accessibilityLabel={`${lbl(b.m, 'mid')} ${b.w}`}
            style={[s.midBox, boxStyle(b.x, b.w), { top: yCt - h + 2, height: h }, on && s.modOn]}>
            <Fit style={[s.tierT, on && { color: palette.blue }]}>{shortLbl(b.m, 'mid')}</Fit>
          </Pressable>
        );
      })}
      {/* столешница */}
      {ctHi > ctLo ? <View style={[s.ct, { top: yCt, left: X0 + px(ctLo) - 4, width: px(ctHi) - px(ctLo) + 11 }]} /> : null}
      {/* угловая зона ряда 2 */}
      {layout.corner ? (
        <Pressable onPress={() => layout.corner?.sel && onPick(layout.corner.sel)} accessibilityRole="button" accessibilityLabel={cornerLabel}
          style={[s.mod, boxStyle(layout.corner.x, layout.corner.w), { top: yBase, height: B.base, backgroundColor: '#ECE6DA' }, layout.corner.sel && isOn(layout.corner.sel) && s.modOn]}>
          {!(layout.corner.sel && isOn(layout.corner.sel)) ? <Hatch /> : null}
          <T style={s.modT} numberOfLines={1}>{cornerLabel}</T>
        </Pressable>
      ) : null}
      {/* нижние */}
      {layout.base.filter((b) => b.m.kind !== 'fridge').map((b) => {
        const m = b.m;
        const wpx = px(b.x + b.w) - px(b.x);
        const lines: ReactNode[] = [];
        if (m.kind === 'drawers') {
          drawerLines(m).forEach((f, j) => lines.push(<View key={`d${j}`} style={[s.hl, { top: (B.base - 6) * f }]} />));
        } else if (m.kind === 'cargo') {
          lines.push(<View key="c" style={[s.cargoH, { left: wpx / 2 - 3 }]} />); // вертикальная ручка
        } else if ((m.kind === 'doors' || m.kind === 'sink') && doorCount(m) === 2) lines.push(<View key="v" style={[s.vl, { left: wpx / 2 - 1 }]} />);
        else if (m.kind === 'corner') lines.push(<Hatch key="h" />);
        return cell(b, baseRow, yBase, B.base, m.kind === 'corner' ? '#ECE6DA' : '#F4F2EC', <>{lines}</>);
      })}
      {/* «+» в конце рядов */}
      {onAdd ? (
        <>
          <PlusBtn x={plusX} y={yWall + B.wall / 2 - 14} label={addLabels.wall} onPress={() => onAdd(wallRow)} />
          {run === 1 ? <PlusBtn x={plusX} y={yCt - B.gap / 2 - 12} small label={addLabels.mid} onPress={() => onAdd('mid')} /> : null}
          <PlusBtn x={plusX} y={yBase + B.base / 2 - 14} label={addLabels.base} onPress={() => onAdd(baseRow)} />
        </>
      ) : null}
    </>
  );
}

/** Подпись модуля в одну строку, мельче, если не влезает. */
function Fit({ style, children }: { style?: StyleProp<TextStyle>; children: ReactNode }) {
  return <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={resolveFont([ty.body, style])}>{children}</Text>;
}

function PlusBtn({ x, y, label, onPress, small }: { x: number; y: number; label: string; onPress: () => void; small?: boolean }) {
  const d = small ? 24 : 28;
  return (
    <Press feedback="scale" onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={label}
      style={[s.plus, { left: x + (28 - d) / 2, top: y, width: d, height: d, borderRadius: d / 2 }]}>
      <Ionicons name="add" size={small ? 16 : 18} color={palette.ink} />
    </Press>
  );
}

/**
 * План угловой кухни «вид сверху»: стена А (верх) — ряд base с угловым модулем, стена Б — ряд base2 от угла вниз.
 * Г-образный (square) угол — квадрат в стыке, «длинный» — модуль вдоль А, ряд Б начинается за глубиной столешницы.
 * corner_side: 'right' — зеркально (угол справа).
 */
function CornerPlan({ tree, base, base2, sel, onPick, lbl, y0 }: { tree: ProductTree; base: KMod[]; base2: KMod[]; sel: KSel | null; onPick: (s: KSel) => void; lbl: (m: KMod) => string; y0: number }) {
  const { t } = useT();
  const { width: SW } = useWindowDimensions();
  const lens = moduleLengths(tree);
  const l2 = schemeLayout(tree, 2);
  const offB = l2.corner?.w ?? 600;
  const lenA = lens.a;
  const lenB = lens.b ?? offB;
  const right = tree.corner_side === 'right';
  const X0 = 40, Y0 = y0 + 14, DP = 64;
  const k = Math.min((SW - 2 * X0 - 4) / Math.max(lenA, 1), (210 - DP * 0) / Math.max(lenB, 1));
  const W = Math.round(lenA * k);
  const mx = (x: number, w: number) => (right ? 2 * X0 + W - x - w : x);
  const items: { s: KSel; x: number; y: number; w: number; h: number; m: KMod }[] = [];
  // ряд А в порядке base, считая от угла: у corner_side=left угол — первый, у right — последний
  const order = base.map((m, i) => ({ m, i }));
  if (right) order.reverse();
  let x = X0;
  order.forEach(({ m, i }) => {
    const w = Math.round((m.width ?? 0) * k);
    const sq = m.kind === 'corner' && m.corner_shape === 'square';
    items.push({ s: { row: 'base', i }, x: mx(x === X0 ? x : x - 2, x === X0 ? w : w + 2), y: Y0, w: x === X0 ? w : w + 2, h: sq ? w : DP, m });
    x += w;
  });
  let y = Y0 + Math.round(offB * k);
  // ряд Б — от угла: у угла слева ядро строит base2 в обратном порядке, но список в дереве всегда «от угла»
  base2.forEach((m, i) => { const h = Math.round((m.width ?? 0) * k); items.push({ s: { row: 'base2', i }, x: mx(X0, DP), y: y - 2, w: DP, h: h + 2, m }); y += h; });
  const wallX = right ? X0 + W : 34;
  // подписи длин — во внутреннем углу «Г»: правее ряда Б (и Г-модуля), ниже ряда А
  const sqPx = Math.max(DP, Math.round(offB * k));
  const innerL = right ? X0 + 12 : X0 + sqPx + 14;
  return (
    <>
      <View style={[s.wall, { left: 34, top: Y0 - 6, width: W + 12, height: 6 }]} />
      <View style={[s.wall, { left: wallX, top: Y0 - 6, width: 6, height: Math.round(lenB * k) + 6 }]} />
      {items.map((it) => {
        const on = !!sel && sel.row === it.s.row && sel.i === it.s.i && !sel.tier;
        const cor = it.m.kind === 'corner';
        return (
          <Pressable key={`${it.s.row}${it.s.i}`} onPress={() => onPick(it.s)} accessibilityRole="button" accessibilityLabel={lbl(it.m)}
            style={[s.m, { left: it.x, top: it.y, width: it.w, height: it.h }, cor && { backgroundColor: '#ECE6DA' }, on && s.mOn]}>
            {cor && !on ? <Hatch /> : null}
            <T style={[s.modT, { paddingBottom: 0 }, on && { color: palette.blue }]} numberOfLines={1}>{lbl(it.m)}</T>
            <T num style={[s.modW, { position: 'relative', top: 0 }, on && { color: palette.blue }]} numberOfLines={1}>{it.m.width ?? ''}</T>
          </Pressable>
        );
      })}
      <View style={{ position: 'absolute', left: innerL, top: Y0 + DP + 12, gap: 8, alignItems: 'flex-start' }} pointerEvents="none">
        <View style={[s.dimc, s.lift]}><T num style={s.dimT}>{`${t('kit_a')} ${lenA}`}</T><T style={s.dimS}>{t('mm')}</T></View>
        <View style={[s.dimc, s.lift]}><T num style={s.dimT}>{`${t('kit_b')} ${lenB}`}</T><T style={s.dimS}>{t('mm')}</T></View>
        <T v="cap" style={{ fontSize: 13 }}>{t('kit_top_view')}</T>
      </View>
    </>
  );
}

/** .m.cor — диагональная штриховка углового модуля (45°, 6/6 px). */
function Hatch() {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      {Array.from({ length: 24 }, (_, i) => (
        <View key={i} style={{ position: 'absolute', left: -120 + i * 17, top: -40, width: 6, height: 260, backgroundColor: '#F4F2EC', transform: [{ rotate: '45deg' }] }} />
      ))}
    </View>
  );
}

function KV({ k, v, onPress, line, num: isNum }: { k: string; v: string; onPress?: () => void; line?: boolean; num?: boolean }) {
  const body = (
    <>
      <T style={{ flex: 1, fontSize: 16, color: palette.muted }}>{k}</T>
      <T num={isNum} style={{ fontSize: isNum ? 14 : 16, fontWeight: '500', textAlign: 'right', flexShrink: 1 }} numberOfLines={1}>{v}</T>
      {onPress ? <Ionicons name="chevron-forward" size={18} color={palette.chev} /> : null}
    </>
  );
  return onPress
    ? <Press feedback="row" onPress={onPress} style={[s.kv, line && s.line]} accessibilityRole="button">{body}</Press>
    : <View style={[s.kv, line && s.line]}>{body}</View>;
}

/** Строка свойства: подпись слева, переключатель / счётчик справа. */
function FRow({ label, children, line }: { label: string; children: ReactNode; line?: boolean }) {
  return (
    <View style={[s.kv, { minHeight: 52 }, line && s.line]}>
      <T style={{ flex: 1, fontSize: 15, lineHeight: 20, color: palette.muted }} numberOfLines={2}>{label}</T>
      {children}
    </View>
  );
}

/** Маленький сегментный выбор (двери 1/2, петли, открывание…). */
function MiniSeg({ value, options, onChange, disabled, wide }: { value: string; options: { v: string; l: string }[]; onChange: (v: string) => void; disabled?: boolean; wide?: boolean }) {
  return (
    <View style={[s.seg, wide && { flex: 1 }, disabled && { opacity: 0.5 }]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.v === value;
        return (
          <Press key={o.v} feedback="opacity" disabled={disabled} onPress={() => { if (!on) onChange(o.v); }} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={[s.segB, wide && { flex: 1 }, on && s.segOn]}>
            <T style={{ fontSize: 14, fontWeight: on ? '600' : '500', color: on ? palette.white : palette.ink }} numberOfLines={1}>{o.l}</T>
          </Press>
        );
      })}
    </View>
  );
}

/** Число с «− / +» и вводом с клавиатуры; auto — значение по умолчанию ядра (null), «авто» сбрасывает к нему. */
function Stepper({ value, step, lim, onChange, disabled, auto, autoLabel }: {
  value: number; step: number; lim: readonly [number, number]; onChange: (v: number | null) => void; disabled?: boolean; auto?: boolean; autoLabel?: string;
}) {
  const [txt, setTxt] = useState(String(Math.round(value)));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(String(Math.round(value))); }, [value, focus]);
  const set = (v: number) => { const c = clamp(v, lim); if (c !== value || auto) onChange(c); };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {autoLabel ? (
        <Press onPress={() => !auto && onChange(null)} disabled={disabled || auto} style={[s.auto, auto && { backgroundColor: palette.blueSoft }]} accessibilityRole="button" accessibilityState={{ selected: !!auto }}>
          <T style={{ fontSize: 12, fontWeight: '600', color: auto ? palette.blue : palette.muted }}>{autoLabel}</T>
        </Press>
      ) : null}
      <Press onPress={() => set(value - step)} disabled={disabled || value <= lim[0]} style={s.sb} accessibilityRole="button" accessibilityLabel={`−${step}`}>
        <Ionicons name="remove" size={18} color={palette.ink} />
      </Press>
      <TextInput value={txt} onChangeText={(x) => setTxt(x.replace(/\D/g, '').slice(0, 5))} editable={!disabled} keyboardType="number-pad" returnKeyType="done"
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} selectTextOnFocus
        onEndEditing={() => { const n = Number(txt); if (txt && Number.isFinite(n)) set(n); else setTxt(String(Math.round(value))); }}
        style={resolveFont([ty.body, s.sv, auto && { color: palette.muted }])} />
      <Press onPress={() => set(value + step)} disabled={disabled || value >= lim[1]} style={s.sb} accessibilityRole="button" accessibilityLabel={`+${step}`}>
        <Ionicons name="add" size={18} color={palette.ink} />
      </Press>
    </View>
  );
}

/** .fld.g + .numf: ширина модуля «−50 / +50», значение 24/600 (можно ввести), «мм»; ошибка суммы — красная рамка. */
function WidthBox({ label, value, unit, err, disabled, lim, onChange }: { label: string; value: number; unit: string; err: boolean; disabled: boolean; lim: readonly [number, number]; onChange: (v: number) => void }) {
  const [txt, setTxt] = useState(String(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(String(value)); }, [value, focus]);
  const set = (v: number) => { const c = clamp(v, lim); if (c !== value) onChange(c); };
  return (
    <View style={s.fld}>
      {err ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 16, borderWidth: 2, borderColor: palette.red }]} /> : null}
      <T v="fl">{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <Press onPress={() => set(value - 50)} disabled={disabled || value <= lim[0]} style={s.pm} accessibilityRole="button" accessibilityLabel={`${label} −50`}><T style={{ fontSize: 15, fontWeight: '500' }}>−50</T></Press>
        <TextInput value={txt} onChangeText={(x) => setTxt(x.replace(/\D/g, '').slice(0, 4))} editable={!disabled} keyboardType="number-pad" returnKeyType="done" selectTextOnFocus
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} accessibilityLabel={label}
          onEndEditing={() => { const n = Number(txt); if (txt && Number.isFinite(n)) set(n); else setTxt(String(value)); }}
          style={resolveFont([ty.body, { flex: 1, fontSize: 24, lineHeight: 28, fontWeight: '600', textAlign: 'center', color: palette.ink, paddingVertical: 0, fontVariant: ['tabular-nums'] }])} />
        <T v="cap">{unit}</T>
        <Press onPress={() => set(value + 50)} disabled={disabled || value >= lim[1]} style={s.pm} accessibilityRole="button" accessibilityLabel={`${label} +50`}><T style={{ fontSize: 15, fontWeight: '500' }}>+50</T></Press>
      </View>
    </View>
  );
}

const lift = { shadowColor: palette.ink, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 };
const s = StyleSheet.create({
  lift,
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, minHeight: 72 },
  tpill: { flex: 1, minWidth: 0, height: 44, borderRadius: 22, backgroundColor: palette.white, justifyContent: 'center', paddingHorizontal: 16 },
  row2: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', height: 38 },
  pills: { flexDirection: 'row', height: 36, borderRadius: 18, backgroundColor: palette.white, padding: 3, gap: 2 },
  pill: { height: 30, borderRadius: 15, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: palette.ink },
  pillT: { fontSize: 14, fontWeight: '600', color: palette.ink },
  dimc: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: palette.white },
  dimT: { fontSize: 15, fontWeight: '600', color: palette.blue },
  dimS: { fontSize: 13, color: palette.blue, opacity: 0.7 },
  mod: { position: 'absolute', borderWidth: 3, borderColor: palette.ink, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 4, overflow: 'hidden' },
  modOn: { backgroundColor: '#DCE6FF', borderColor: palette.blue, zIndex: 2 },
  gapBox: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: palette.chev },
  modT: { fontSize: 12, lineHeight: 15, fontWeight: '500', color: palette.muted2, letterSpacing: -0.3, paddingHorizontal: 2 },
  modW: { position: 'absolute', top: 2, fontSize: 10, lineHeight: 12, fontWeight: '600', color: palette.faint },
  tierT: { fontSize: 10, lineHeight: 12, fontWeight: '600', color: palette.muted2, paddingHorizontal: 2 },
  midBox: { position: 'absolute', borderWidth: 2, borderColor: palette.ink, backgroundColor: '#FBFAF8', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  hl: { position: 'absolute', left: 3, right: 3, height: 1, backgroundColor: palette.chev },
  vl: { position: 'absolute', top: 16, bottom: 22, width: 1, backgroundColor: palette.chev },
  niche: { position: 'absolute', left: 4, right: 4, bottom: 3, backgroundColor: '#E2E0DA', borderRadius: 2 },
  nicheFramed: { left: 9, right: 9, bottom: 7, borderWidth: 1, borderColor: palette.chev },
  cargoH: { position: 'absolute', top: 14, height: 18, width: 3, borderRadius: 1.5, backgroundColor: palette.chev },
  ct: { position: 'absolute', height: 10, backgroundColor: '#8D8778', borderWidth: 3, borderBottomWidth: 0, borderColor: palette.ink },
  plus: { position: 'absolute', backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center', ...{ shadowColor: palette.ink, shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 } },
  wall: { position: 'absolute', backgroundColor: palette.ink, borderRadius: 3 },
  m: { position: 'absolute', borderWidth: 2, borderColor: palette.ink, backgroundColor: '#F4F2EC', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  mOn: { backgroundColor: '#DCE6FF', borderColor: palette.blue, zIndex: 1 },
  tabs: { position: 'absolute', left: 0, right: 0, flexGrow: 0 },
  tab: { height: 40, borderRadius: 20, backgroundColor: palette.white, justifyContent: 'center', paddingHorizontal: 15, ...{ shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } } },
  es: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: palette.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: -4 }, elevation: 8 },
  shx: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  kc: { height: 36, borderRadius: 18, paddingHorizontal: 14, backgroundColor: palette.ground, justifyContent: 'center' },
  fld: { backgroundColor: palette.ground, borderRadius: 16, minHeight: 60, paddingVertical: 9, paddingHorizontal: 16, justifyContent: 'center' },
  pm: { width: 50, height: 40, borderRadius: 12, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46 },
  line: { borderTopWidth: 1, borderTopColor: palette.hair },
  seg: { flexDirection: 'row', height: 36, borderRadius: 12, padding: 3, gap: 2, backgroundColor: palette.segOnWhite },
  segB: { minWidth: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  segOn: { backgroundColor: palette.ink },
  sb: { width: 36, height: 36, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  sv: { width: 58, fontSize: 17, fontWeight: '600', textAlign: 'center', color: palette.ink, paddingVertical: 0, fontVariant: ['tabular-nums'] },
  auto: { height: 28, borderRadius: 9, paddingHorizontal: 8, justifyContent: 'center', backgroundColor: palette.ground },
  act: { height: 44, borderRadius: 14, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 10 },
  actT: { fontSize: 15, fontWeight: '500' },
  ban: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 16 },
  fix: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, borderRadius: 14, paddingHorizontal: 12, backgroundColor: palette.blueSoft, maxWidth: '100%' },
  apl: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 },
  ap: { width: 40, height: 40, borderRadius: 12, backgroundColor: palette.blueSoft, alignItems: 'center', justifyContent: 'center' },
  op: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 16, backgroundColor: palette.ground },
  edit: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, borderRadius: 14, paddingHorizontal: 14, backgroundColor: palette.ink },
  tl: { height: 36, borderRadius: 18, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  tlT: { fontSize: 14, lineHeight: 18, fontWeight: '500' },
  chatHdr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, paddingLeft: 16, paddingRight: 8 },
  inpWrap: { paddingTop: 8, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: palette.hair },
  inp: { height: 52, borderRadius: 26, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 6, paddingRight: 6 },
  chatBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: 6, right: 6, width: 9, height: 9, borderRadius: 5, backgroundColor: palette.red, borderWidth: 1.5, borderColor: palette.white },
  go: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  cbar: { flexDirection: 'row', gap: 8, paddingTop: 8, paddingHorizontal: 16, alignItems: 'center' },
  pr: { height: 52, paddingHorizontal: 14, borderRadius: 16, backgroundColor: palette.ground, justifyContent: 'center' },
  cta: { flex: 1, height: 52, borderRadius: 16, backgroundColor: palette.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
});
