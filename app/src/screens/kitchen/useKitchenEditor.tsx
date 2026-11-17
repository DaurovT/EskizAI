/**
 * Состояние и правки редактора кухни (SCR-37 / SCR-37b) — общие для телефона (KitchenEditor.dc.html) и планшета
 * (TKitchen2.dc.html): выбранный модуль, вкладка, вид «Схема / 3D», ввод правки словами, типы модуля, поля модуля,
 * подгонка суммы к стене, «Столешница», «Техника», «Кухня» (высоты и глубины), наполнение угла.
 * Все правки дерева — onField(pointer, value): ряд модулей заменяется целиком (/base, /wall, /mid …).
 */
import { Ionicons } from '@expo/vector-icons';
import type { ViewerModel } from '@mebel/viewer';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { api } from '../../api';
import type { KitchenSite, ModelStateOut, ProductTree } from '../../api/types';
import { useResource } from '../../hooks/useResource';
import { useT } from '../../i18n';
import { groupDigits } from '../../lib/format';
import { moduleLengths, wallDiffs } from '../../lib/kitchenMeasure';
import {
  BASE_PRESETS, KDEF, KLIM, NEW_PRESETS, WALL_PRESETS, applyPreset, doorCount, duplicateAt, hasLift, hasOpenBottom, hasTier, insertAt, isFold, isUpper, labelCode,
  moveAt, newModule, nicheHeight, num, presetOf, presetParts, removeAt, replaceAt, rowMods, schemeLayout, selFromPartKey, sumFixes, wallKindOf, wallModHeight, wallOverFridge,
  type KMod, type KPart, type KRow, type KSel, type SumFix,
} from '../../lib/kitchenScheme';
import type { CanvasHandle } from '../../three/ProductCanvas';
import { Press, T, Toggle } from '../../ui/kit';
import { palette } from '../../ui/theme';
import type { KitchenChatProps } from '../KitchenChat';
import { FRow, KV, MiniSeg, Stepper, WidthRow, desk } from './KitchenControls';

export type KTab = 'mod' | 'top' | 'app' | 'kit' | 'chat';
export type View3 = 'scheme' | '3d';
/** Угловая кухня: план сверху или фасад стены А (ряд 1) / Б (ряд 2). */
export type RunView = 'plan' | 1 | 2;

export type KitchenViewProps = {
  id: string; tree: ProductTree; title: string; sub?: string;
  /** Номер версии (планшет: «… · версия 3» в строке инструментов). */
  version?: number;
  /** Цена «до замера»; null — не показывать. */
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

export type TypeItem = { key: string; label: string; isNew: boolean; on: boolean; parts: KPart[]; pick: () => void };

export function useKitchenEditor(p: KitchenViewProps, dense: boolean) {
  const { id, tree, materialName, onField, busy, disabled, onModel, onError, initialView, chat, onSend } = p;
  const { t, td, lang } = useT();
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
  const [tab, setTab] = useState<KTab>('mod');
  const [sel, setSel] = useState<KSel>(corner && cornerIdx >= 0 ? { row: 'base', i: cornerIdx } : { row: 'base', i: 0 });
  const [seen, setSeen] = useState(chat.messages.length);
  const [openAll, setOpenAll] = useState(false);
  const [dims, setDims] = useState(true);
  const canvas = useRef<CanvasHandle>(null);
  const panelScroll = useRef<ScrollViewInstance>(null);
  const hw = useResource(() => (corner ? api.getHardware(id).catch(() => null) : Promise.resolve(null)), [id, corner, tree]);
  const cornerGroup = hw.data?.groups.find((g) => g.key === 'corner_fill') ?? null;
  const [applying, setApplying] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  // дерево сменилось с прямой на угловую (новая версия) — выбрать угол
  useEffect(() => {
    if (corner && cornerIdx >= 0) { setTab('mod'); setSel({ row: 'base', i: cornerIdx }); setRunView('plan'); }
  }, [corner, cornerIdx]);
  useEffect(() => { if (initialView) setMode(initialView); }, [initialView]);
  // другой модуль / вкладка — панель с начала
  useEffect(() => { panelScroll.current?.scrollTo({ y: 0, animated: false }); }, [tab, sel.row, sel.i, sel.tier]);
  // открыта переписка — всё прочитано
  useEffect(() => { if (tab === 'chat') setSeen(chat.messages.length); }, [tab, chat.messages.length]);
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
  const decorName = (mid?: string | null) => {
    if (!mid) return '—';
    const d = (decors.data ?? []).find((x) => x.id === mid);
    return (d && (lang === 'uz' ? d.name_uz || d.name : d.name)) || materialName?.(mid) || mid;
  };
  const paintCode = (tree.fronts as { style?: { paint?: { code?: string | null } | null } | null } | undefined)?.style?.paint?.code;
  const tabs: KTab[] = ['mod', 'top', 'app', 'kit', 'chat'];
  const tabLabel: Record<KTab, string> = { mod: t('kit_tab_mod'), top: t('kit_tab_top'), app: t('kit_tab_app'), kit: t('kit_tab_kit'), chat: t('kit_tab_chat') };
  const pick = (s: KSel) => {
    setSel(s);
    setTab('mod');
    Keyboard.dismiss();
  };
  const cornerMod = cornerIdx >= 0 ? base[cornerIdx] : null;
  const applyFill = async (value: string) => {
    setApplying(value);
    try { onModel(await api.applyHardware(id, 'corner_fill', value)); hw.reload(); } catch (e) { onError(e); } finally { setApplying(null); }
  };
  const blindDelta = cornerGroup?.options.find((o) => o.value === 'blind')?.delta;
  const send = () => { if (text.trim()) { onSend(text.trim()); setText(''); setTab('chat'); Keyboard.dismiss(); } };

  // ----- правки дерева: ряд модулей целиком (несколько полей за раз не теряются) -----
  const setRow = (row: KRow, list: KMod[]) => onField(`/${row}`, list);
  const patchMod = (row: KRow, i: number, patch: Record<string, unknown>) => {
    const m = rows[row][i];
    if (!m) return;
    const next: KMod = { ...m, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    setRow(row, replaceAt(rows[row], i, next));
  };
  const patchTier = (i: number, patch: Record<string, unknown>) => {
    const m = rows[sel.row][i] ?? null;
    if (!m) return;
    const t0 = (m.top as Record<string, unknown> | null) ?? {};
    const next = { ...t0, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    patchMod(sel.row, i, { top: next });
  };
  const addModule = (row: KRow) => {
    const list = rows[row];
    setRow(row, [...list, newModule(row, tree)]);
    pick({ row, i: list.length });
  };
  const applyFix = (row: KRow, f: SumFix) => {
    const list = rows[row];
    if (f.kind === 'neighbour') setRow(row, replaceAt(list, f.i, { ...list[f.i], width: f.to }));
    else setRow(row, insertAt(list, list.length, newModule(row, tree, f.width)));
  };
  const setPreset = (key: string) => { if (cur) setRow(sel.row, replaceAt(rows[sel.row], sel.i, applyPreset(cur, sel.row, key))); };

  // ----- сумма модулей по стене и подгонка -----
  const sumRow: KRow | null = !corner ? (wallA != null && sumA !== wallA ? 'base' : null)
    : diffs && diffs.length ? (diffs.find((d) => (d.wall === 'b') === (sel.row === 'base2' || sel.row === 'wall2')) ?? diffs[0]).wall === 'a' ? 'base' : 'base2' : null;
  const sumDiff = sumRow === 'base' ? (wallA ?? sumA) - sumA : sumRow === 'base2' ? (diffs?.find((d) => d.wall === 'b')?.diff ?? 0) : 0;
  const fixes = sumRow ? sumFixes(rows[sumRow], sumDiff, sel.row === sumRow && !sel.tier ? sel.i : null) : [];
  const overFridge = [...wallOverFridge(tree, 1).map((i) => i + 1), ...(corner ? wallOverFridge(tree, 2).map((i) => `${t('kit_b')}${i + 1}`) : [])];

  // dev: снимки без тапов (eval в scripts/shot.sh)
  useEffect(() => {
    if (!__DEV__) return;
    (globalThis as Record<string, unknown>).__kitchen = {
      pick: (row: KRow, i: number, tier?: boolean) => pick({ row, i, tier }),
      tab: (k: KTab) => setTab(k),
      mode: (m: View3) => setMode(m),
      run: (r: RunView) => setRunView(r),
      chat: (on: boolean) => setTab(on ? 'chat' : 'mod'),
      pick3d: (key: string) => { const s = selFromPartKey(key, tree); if (s === 'top') setTab('top'); else if (s) pick(s); },
      scroll: (y: number) => panelScroll.current?.scrollTo({ y, animated: false }),
      fix: (n: number) => { if (sumRow && fixes[n]) applyFix(sumRow, fixes[n]); },
      add: (row: KRow) => addModule(row),
      send: (x: string) => { onSend(x); setTab('chat'); },
      kind: (k: string) => setPreset(k),
      preset: (k: string) => setPreset(k),
      rows: (r: Partial<Record<KRow, KMod[]>>) => { for (const [k, v] of Object.entries(r)) onField(`/${k}`, v); },
      field: (ptr: string, v: unknown) => onField(ptr, v),
    };
  });

  // ----- подписи выбранного -----
  const rowPrefix = (row: KRow) => (row === 'base2' || row === 'wall2' ? t('kit_b') : '');
  const selName = (s: KSel): string => {
    const m = rows[s.row][s.i];
    if (!m) return '';
    if (s.tier) return `${t('kit_k_tier')} · ${t('kit_up_n', { n: `${rowPrefix(s.row)}${s.i + 1}` })}`;
    if (s.row === 'mid') return `${t('kit_k_mid')} ${s.i + 1}`;
    if (m.kind === 'corner') return t('kit_corner_mod');
    const n = `${rowPrefix(s.row)}${s.i + 1}`;
    // тип модуля как в списке типов («Ящики 1+2», «Подъёмник складной»), пусто/угол — подпись вида
    const pk = presetOf(m, s.row);
    const name = td(`kit_pr_${isUpper(s.row) ? 'w' : 'b'}_${pk}`, lbl(m, s.row));
    return `${isUpper(s.row) ? t('kit_up_n', { n }) : t('kit_lo_n', { n })} · ${name}`;
  };
  const rowName = sel.row === 'mid' ? t('kit_row_mid') : isUpper(sel.row) ? t('kit_row_up') : t('kit_row_lo');
  const selLabel = cur ? selName(sel) : '';

  // ----- типы модуля -----
  const typeItems: TypeItem[] = !cur || sel.tier || sel.row === 'mid' || cur.kind === 'corner' ? [] : (isUpper(sel.row) ? WALL_PRESETS : BASE_PRESETS).map((key) => {
    const on = presetOf(cur, sel.row) === key;
    return { key, label: td(`kit_pr_${isUpper(sel.row) ? 'w' : 'b'}_${key}`, key), isNew: NEW_PRESETS.has(key), on, parts: presetParts(sel.row, key, tree), pick: () => { if (!on && !lock) setPreset(key); } };
  });

  // ----- баннеры суммы (компактные .ban.err, как в макете) -----
  const banner = (tone: 'err' | 'est', body: string) => {
    const c = tone === 'err' ? (dense ? palette.redDeep : '#8A1D16') : palette.amberDeep;
    return (
      <View style={[dense ? sx.err2 : sx.ban, { backgroundColor: tone === 'err' ? (dense ? desk.errBg : palette.redSoft) : palette.amberSoft }]}>
        <Ionicons name="warning-outline" size={dense ? 16 : 18} color={c} style={{ marginTop: 1 }} />
        <T style={{ flex: 1, fontSize: dense ? 13 : 14, lineHeight: dense ? 17 : 19, color: c }}>{body}</T>
      </View>
    );
  };
  const sumBanner = (
    <>
      {overFridge.length ? banner('est', t('kit_fridge_over', { n: overFridge.join(', ') })) : null}
      {!corner ? (wallA != null && sumA !== wallA ? banner('err', t(dense ? 'kit_sum_bad_lo' : 'kit_sum_bad2', { sum: sumA, wall: wallA })) : null)
        : diffs && diffs.length ? banner('err', diffs.map((d) => t('kit_wall_diff', { w: d.wall === 'a' ? t('kit_a') : t('kit_b'), d: `${d.diff > 0 ? '+' : '−'}${Math.abs(d.diff)}` })).join(' · ')) : null}
      {sumRow && fixes.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: dense ? 6 : 8 }}>
          {fixes.map((f) => (
            <Press key={f.kind} onPress={() => applyFix(sumRow, f)} disabled={lock} accessibilityRole="button" style={dense ? sx.fix2 : sx.fix}>
              <Ionicons name={f.kind === 'neighbour' ? 'swap-horizontal' : 'add'} size={dense ? 14 : 16} color={palette.blue} />
              <T num style={{ fontSize: dense ? 12.5 : 14, lineHeight: 18, fontWeight: '600', color: palette.blue }} numberOfLines={1}>
                {f.kind === 'neighbour' ? t('kit_fix_nb', { name: lbl(rows[sumRow][f.i], sumRow), from: f.from, to: f.to }) : t('kit_fix_add', { n: f.width })}
              </T>
            </Press>
          ))}
        </View>
      ) : null}
    </>
  );

  // ----- поля модуля -----
  const modFields = (): ReactNode => {
    if (!cur) return null;
    const row = sel.row;
    const up = isUpper(row);
    const i = sel.i;
    if (sel.tier) {
      const tp = (cur.top as { height?: number | null; doors?: number | null; opening?: string } | null) ?? {};
      return (
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
      );
    }
    const doorsRow = (
      <FRow label={t('kit_f_doors')} line>
        <MiniSeg value={String(doorCount(cur))} disabled={lock} onChange={(v) => patchMod(row, i, { doors: Number(v) })} options={[{ v: '1', l: '1' }, { v: '2', l: '2' }]} />
      </FRow>
    );
    const hingeRow = doorCount(cur) === 1 ? (
      <FRow label={t('kit_f_hinge')} line>
        <MiniSeg value={cur.hinge === 'right' ? 'right' : 'left'} disabled={lock} onChange={(v) => patchMod(row, i, { hinge: v === 'right' ? 'right' : null })}
          options={[{ v: 'left', l: t('kit_f_left') }, { v: 'right', l: t('kit_f_right') }]} />
      </FRow>
    ) : null;
    // механизм подъёмных фасадов: отдельные (газлифт на каждый) или складной подъёмник (два фасада на петлях)
    const mechRow = hasLift(cur) ? (
      <FRow label={t('kit_f_mech')} line>
        <MiniSeg value={isFold(cur) ? 'fold' : 'flap'} disabled={lock} onChange={(v) => patchMod(row, i, v === 'fold' ? { lift_type: 'fold', flaps: null } : { lift_type: null })}
          options={[{ v: 'flap', l: t('kit_f_mech_flap') }, { v: 'fold', l: t('kit_f_mech_fold') }]} />
      </FRow>
    ) : null;
    const openingRows = (
      <>
        <FRow label={t('kit_f_opening')} line>
          <MiniSeg value={cur.opening === 'lift' ? 'lift' : 'hinged'} disabled={lock} onChange={(v) => patchMod(row, i, v === 'lift' ? { opening: 'lift' } : { opening: null, flaps: null, lift_type: null })}
            options={[{ v: 'hinged', l: t('kit_f_hinged') }, { v: 'lift', l: t('kit_f_lift') }]} />
        </FRow>
        {cur.opening === 'lift' ? (
          <>
            {mechRow}
            {!isFold(cur) ? (
              <FRow label={t('kit_f_flaps')} line>
                <MiniSeg value={cur.flaps === 2 ? '2' : '1'} disabled={lock} onChange={(v) => patchMod(row, i, { flaps: v === '2' ? 2 : null })} options={[{ v: '1', l: '1' }, { v: '2', l: '2' }]} />
              </FRow>
            ) : null}
          </>
        ) : <>{doorsRow}{hingeRow}</>}
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
    if (row === 'mid') {
      return (
        <View>
          <FRow label={t('kit_f_x')}>
            <Stepper value={num(cur.x, 0)} step={50} lim={[0, Math.max(0, sumA - num(cur.width, 300))]} disabled={lock} onChange={(v) => patchMod(row, i, { x: v ?? 0 })} />
          </FRow>
          <FRow label={t('kit_f_height')} line>
            <Stepper value={num(cur.height, num(tree.wall_bottom, KDEF.wall_bottom) - num(tree.legs_height, KDEF.legs_height) - num(tree.base_height, KDEF.base_height) - 38)} auto={typeof cur.height !== 'number'}
              step={10} lim={KLIM.mid_height} disabled={lock} autoLabel={t('kit_f_auto')} onChange={(v) => patchMod(row, i, { height: v })} />
          </FRow>
          {shelvesRow}
        </View>
      );
    }
    let fields: ReactNode = null;
    if (up) {
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
              <MiniSeg value={typeof cur.above === 'string' ? cur.above : 'door'} disabled={lock} onChange={(v) => patchMod(row, i, v === 'lift' ? { above: v } : { above: v === 'door' ? null : v, lift_type: null })}
                options={(['door', 'lift', 'open', 'none'] as const).map((v) => ({ v, l: t(`kit_f_above_${v}`) }))} />
            </FRow>
            {mechRow}
            <FRow label={t('kit_f_niche_frame')} line>
              <Toggle value={cur.niche_frame === true} disabled={lock} accessibilityLabel={t('kit_f_niche_frame')} onValueChange={(on) => patchMod(row, i, { niche_frame: on ? true : null })} />
            </FRow>
            {tierRow}
          </>
        );
      } else fields = <T v="cap" style={{ paddingVertical: 8, fontSize: dense ? 12 : 14 }}>{t('kit_gap_note')}</T>;
    } else {
      const k = cur.kind;
      if (k === 'doors') {
        fields = (
          <>
            {doorsRow}{hingeRow}
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
      } else if (k === 'sink') fields = <>{doorsRow}{hingeRow}</>;
      else if (k === 'cargo') fields = <T v="cap" style={{ paddingVertical: 8, fontSize: dense ? 12 : 14, lineHeight: dense ? 16 : 19 }}>{t('kit_cargo_note')}</T>;
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
      }
    }
    return <View>{fields}</View>;
  };

  /** ← → · Дублировать · Удалить (у яруса — «Убрать антресоль»). */
  const actions = (): ReactNode => {
    if (!cur) return null;
    const row = sel.row;
    const i = sel.i;
    const st = dense ? sx.act2 : sx.act;
    const ic = dense ? 15 : 17;
    const tx = dense ? sx.actT2 : sx.actT;
    if (sel.tier) {
      return (
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 4 }}>
          <Press onPress={() => { patchMod(row, i, { top: null }); setSel({ row, i }); }} disabled={lock} style={[st, { flex: 1 }]} accessibilityRole="button">
            <Ionicons name="trash-outline" size={ic} color={palette.redText} />
            <T style={[tx, { color: palette.redText }]}>{t('kit_tier_remove')}</T>
          </Press>
        </View>
      );
    }
    const moveBtns = row !== 'mid' && cur.kind !== 'corner';
    return (
      <View style={{ flexDirection: 'row', gap: dense ? 6 : 8, paddingTop: 4 }}>
        {moveBtns ? (
          <>
            <Press onPress={() => { setRow(row, moveAt(rows[row], i, -1)); setSel({ row, i: Math.max(0, i - 1) }); }} disabled={lock || i === 0} style={[st, { width: dense ? 34 : 48 }]} accessibilityRole="button" accessibilityLabel={t('kit_move_l')}>
              <Ionicons name="arrow-back" size={ic + 1} color={palette.ink} />
            </Press>
            <Press onPress={() => { setRow(row, moveAt(rows[row], i, 1)); setSel({ row, i: Math.min(rows[row].length - 1, i + 1) }); }} disabled={lock || i >= rows[row].length - 1} style={[st, { width: dense ? 34 : 48 }]} accessibilityRole="button" accessibilityLabel={t('kit_move_r')}>
              <Ionicons name="arrow-forward" size={ic + 1} color={palette.ink} />
            </Press>
          </>
        ) : null}
        <Press onPress={() => {
          if (row === 'mid') setRow(row, [...mids, { ...cur, x: num(cur.x, 0) + num(cur.width, 300) }]);
          else setRow(row, duplicateAt(rows[row], i));
          setSel({ row, i: row === 'mid' ? mids.length : i + 1 });
        }} disabled={lock || cur.kind === 'corner'} style={[st, { flex: 1 }]} accessibilityRole="button">
          <Ionicons name="copy-outline" size={ic} color={palette.ink} />
          <T style={tx}>{t('kit_dup')}</T>
        </Press>
        <Press onPress={() => { setRow(row, removeAt(rows[row], i)); setSel({ row, i: Math.max(0, Math.min(i, rows[row].length - 2)) }); }}
          disabled={lock || (row === 'base' && base.length <= 1) || cur.kind === 'corner'} style={[st, { flex: 1 }]} accessibilityRole="button">
          <Ionicons name="trash-outline" size={ic} color={palette.redText} />
          <T style={[tx, { color: palette.redText }]}>{t('delete')}</T>
        </Press>
      </View>
    );
  };

  /** Угловой модуль: наполнение (карусель / поворотная / глухой), размер. */
  const cornerPanel = (): ReactNode => {
    if (!cornerMod) return null;
    return (
      <>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <T style={dense ? sx.sel2 : sx.shx}>{t('kit_corner_mod')}</T>
          <T v="rs" num style={dense ? { fontSize: 12 } : null}>{cornerMod.corner_shape === 'square' ? `${cornerMod.width ?? 900} × ${cornerMod.width ?? 900} ${t('mm')}` : `${cornerMod.width ?? ''} ${t('mm')}`}</T>
        </View>
        {(cornerGroup?.options ?? []).map((o) => {
          const on = applying ? applying === o.value : o.current;
          const d = o.delta == null ? null : blindDelta != null ? o.delta - blindDelta : o.delta;
          return (
            <Press key={o.value} onPress={() => !o.current && applyFill(o.value)} disabled={lock || !!applying || !o.available}
              accessibilityRole="radio" accessibilityState={{ selected: on, disabled: !o.available }} style={[dense ? sx.op2 : sx.op, on && { backgroundColor: palette.ink }, !o.available && { opacity: 0.45 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T v="rt" style={dense ? { fontSize: 13, lineHeight: 17, fontWeight: '600' } : null} color={on ? palette.white : undefined}>{o.label.replace(/\s*\(.*\)$/, '')}</T>
                <T v="rs" style={{ fontSize: dense ? 11.5 : 13, lineHeight: dense ? 15 : 17 }} color={on ? palette.chev : undefined}>{o.note || t(`kit_fill_note_${o.value}` as 'kit_fill_note_blind')}</T>
              </View>
              {d != null ? <T num style={{ fontSize: dense ? 13 : 15, fontWeight: '600', color: on ? palette.white : palette.ink }}>{d === 0 ? '0' : `${d > 0 ? '+' : '−'}${groupDigits(Math.abs(d))}`}</T> : null}
            </Press>
          );
        })}
        {cornerMod.corner_shape === 'square' ? (
          <MiniSeg value={String(cornerMod.width ?? 900)} disabled={lock} onChange={(v) => patchMod('base', cornerIdx, { width: Number(v) })} wide
            options={[{ v: '900', l: '900 × 900' }, { v: '1000', l: '1000 × 1000' }]} />
        ) : (
          <WidthRow label={t('p_width')} value={num(cornerMod.width, 1000)} unit={t('mm')} disabled={lock} err={false} lim={KLIM.width} onChange={(v) => patchMod('base', cornerIdx, { width: v })} />
        )}
        {sumBanner}
      </>
    );
  };

  const widthRow = (): ReactNode => {
    if (!cur || sel.tier) return null;
    const lim = sel.row === 'mid' ? KLIM.mid_width : cur.kind === 'cargo' ? KLIM.cargo_width : KLIM.width;
    return <WidthRow label={t('p_width')} value={num(cur.width, 0)} unit={t('mm')} disabled={lock} err={!!sumRow && sumRow === sel.row} lim={lim} onChange={(v) => patchMod(sel.row, sel.i, { width: v })} />;
  };
  const frontRow = (): ReactNode => (cur && sel.row !== 'mid' && cur.kind !== 'gap' && !sel.tier
    ? <KV k={t('kit_front')} v={[decorName(tree.fronts?.material), paintCode].filter(Boolean).join(' · ')} onPress={dense ? undefined : () => router.push({ pathname: '/project/[id]/materials', params: { id } })} line />
    : null);

  // ----- «Столешница» -----
  const topPanel = (): ReactNode => (
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
      <T v="cap" style={dense ? { fontSize: 12, lineHeight: 16 } : null}>{t('kit_top_note')}</T>
    </>
  );

  // ----- «Техника»: строки «Духовка 600 — низ 2» -----
  const appliances = (['base', 'wall', 'base2', 'wall2'] as const).flatMap((row) => rows[row].flatMap((m, i) => {
    const is = isUpper(row) ? m.kind === 'hood' || m.kind === 'appliance' : m.kind === 'sink' || m.kind === 'fridge' || m.kind === 'appliance';
    return is ? [{ m, row: row as KRow, i }] : [];
  }));
  const appPanel = (): ReactNode => (
    <>
      <View>
        {appliances.length ? appliances.map((x, j) => {
          const n = `${rowPrefix(x.row)}${x.i + 1}`;
          const where = isUpper(x.row) ? t('kit_up_n', { n }) : t('kit_lo_n', { n });
          const name = x.row !== 'base' && x.row !== 'base2' && x.m.kind === 'appliance' && x.m.niche_frame === true ? t('kit_app_framed', { name: lbl(x.m, x.row) }) : lbl(x.m, x.row);
          return <KV key={`${x.row}${x.i}`} k={`${name} ${x.m.width ?? ''}`.trim()} v={where.toLowerCase()} line={j > 0} onPress={() => { if (corner) setRunView(x.row === 'base2' || x.row === 'wall2' ? 2 : 1); setMode('scheme'); pick({ row: x.row, i: x.i }); }} />;
        }) : <T v="sub">—</T>}
      </View>
      <T v="cap" style={dense ? { fontSize: 12, lineHeight: 16 } : null}>{t('kit_app_note')}</T>
    </>
  );

  // ----- «Кухня»: высоты и глубины -----
  const P = (k: string, d: number) => num(tree[k], d);
  const kitPanel = (): ReactNode => (
    <>
      <View>
        <FRow label={t('kit_p_legs')}><Stepper value={P('legs_height', KDEF.legs_height)} step={10} lim={KLIM.legs_height} disabled={lock} onChange={(v) => onField('/legs_height', v)} /></FRow>
        <FRow label={t('kit_p_base_h')} line><Stepper value={P('base_height', KDEF.base_height)} step={10} lim={KLIM.base_height} disabled={lock} onChange={(v) => onField('/base_height', v)} /></FRow>
        <FRow label={t('kit_p_base_d')} line><Stepper value={P('base_depth', KDEF.base_depth)} step={10} lim={KLIM.base_depth} disabled={lock} onChange={(v) => onField('/base_depth', v)} /></FRow>
        <FRow label={t('kit_p_ct_d')} line><Stepper value={ctDepth} step={10} lim={KLIM.ct_depth} disabled={lock} onChange={(v) => onField('/countertop/depth', v)} /></FRow>
        <FRow label={t('kit_p_wall_bottom')} line><Stepper value={P('wall_bottom', KDEF.wall_bottom)} step={10} lim={KLIM.wall_bottom} disabled={lock} onChange={(v) => onField('/wall_bottom', v)} /></FRow>
        <FRow label={t('kit_p_ceiling')} line><Toggle value={tree.wall_to_ceiling === true} disabled={lock} accessibilityLabel={t('kit_p_ceiling')} onValueChange={(on) => onField('/wall_to_ceiling', on)} /></FRow>
        {tree.wall_to_ceiling === true ? (
          <T v="cap" style={{ fontSize: dense ? 12 : 13, paddingBottom: 8 }}>{t('kit_p_ceiling_note')}</T>
        ) : (
          <FRow label={t('kit_p_wall_h')} line><Stepper value={P('wall_height', KDEF.wall_height)} step={10} lim={KLIM.wall_height} disabled={lock} onChange={(v) => onField('/wall_height', v)} /></FRow>
        )}
        <FRow label={t('kit_p_wall_d')} line><Stepper value={P('wall_depth', KDEF.wall_depth)} step={10} lim={KLIM.wall_depth} disabled={lock} onChange={(v) => onField('/wall_depth', v)} /></FRow>
      </View>
      <T v="cap" num style={{ fontSize: dense ? 12 : 13 }}>{t('kit_p_total', { n: P('legs_height', KDEF.legs_height) + P('base_height', KDEF.base_height) })}</T>
    </>
  );

  /** Высота и глубина выбранного модуля для «десктопной» панели (TKitchen2 .kv2). */
  const selHD = (): { h: number; d: number } | null => {
    if (!cur || sel.tier) return null;
    if (sel.row === 'mid') return { h: num(cur.height, num(tree.wall_bottom, KDEF.wall_bottom) - num(tree.legs_height, KDEF.legs_height) - num(tree.base_height, KDEF.base_height) - 38), d: num(cur.depth, P('wall_depth', KDEF.wall_depth)) };
    if (isUpper(sel.row)) return { h: wallModHeight(cur, tree), d: P('wall_depth', KDEF.wall_depth) };
    if (cur.kind === 'fridge') return { h: num(cur.fridge_height, KDEF.fridge_height), d: P('base_depth', KDEF.base_depth) };
    return { h: P('base_height', KDEF.base_height), d: P('base_depth', KDEF.base_depth) };
  };

  // ----- 3D: тап по детали — выбрать модуль (и его свойства в панели) -----
  const onPart3d = (key: string | null) => {
    if (!key) return;
    const s = selFromPartKey(key, tree);
    if (s === 'top') { setTab('top'); return; }
    if (!s) return;
    if (corner) setRunView(s.row === 'base2' || s.row === 'wall2' ? 2 : rows[s.row][s.i]?.kind === 'corner' ? 'plan' : 1);
    pick(s);
  };
  const toggleOpen = () => { if (openAll) canvas.current?.closeAll(); else canvas.current?.openAll(); setOpenAll(!openAll); };

  const layout = runView === 'plan' ? null : schemeLayout(tree, runView);
  const lenPill = layout ? (wallA != null && runView === 1 ? wallA : runView === 2 && site?.wall_b ? site.wall_b : layout.baseLen) : null;
  const chatBadge = chat.messages.length > seen && tab !== 'chat';
  const placeholder = chat.aiLimited ? t('ail_input') : disabled ? t('ed_offline') : corner ? t('kit_ph_corner') : t('kit_ph2');
  const subLine = corner ? t('kit_sub_corner', { n: base.length + base2.length }) : t('kit_sub_straight2', { len: wallA ?? sumA, a: base.length, b: wall.length });

  return {
    t, td, lang, tree, rows, base, wall, base2, mids, corner, cornerIdx, cornerMod, cur, sel, setSel, pick, tab, setTab, tabs, tabLabel,
    mode, setMode, runView, setRunView, layout, lenPill, lock, text, setText, send, menu, setMenu, chatBadge, placeholder, subLine,
    lbl, shortLbl, selLabel, rowName, typeItems, sumBanner, sumRow, modFields, actions, cornerPanel, widthRow, frontRow, topPanel, appPanel, kitPanel,
    selHD, decorName, addModule, canvas, panelScroll, openAll, toggleOpen, dims, setDims, onPart3d,
  };
}

export type KitchenEditor = ReturnType<typeof useKitchenEditor>;

const sx = StyleSheet.create({
  ban: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 14 },
  err2: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10 },
  fix: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, borderRadius: 13, paddingHorizontal: 12, backgroundColor: palette.blueSoft, maxWidth: '100%' },
  fix2: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, borderRadius: 8, paddingHorizontal: 9, backgroundColor: palette.blueSoft, maxWidth: '100%' },
  act: { height: 44, borderRadius: 14, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 10 },
  act2: { height: 32, borderRadius: 8, backgroundColor: palette.white, borderWidth: 1, borderColor: desk.ring, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 8 },
  actT: { fontSize: 15, fontWeight: '500' },
  actT2: { fontSize: 13, fontWeight: '600' },
  shx: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  sel2: { fontSize: 15, lineHeight: 19, fontWeight: '700' },
  op: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 16, backgroundColor: palette.ground },
  op2: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: palette.ground },
});
