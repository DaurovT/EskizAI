/**
 * Схема кухни (KitchenEditor.dc.html .kit / TKitchen2.dc.html .kit): ряды модулей по реальным ширинам на точечном
 * поле .cv. Модуль — ячейка с рамкой 3 pt (стыки ink, как сетка .row6) и рисунком фасада (.m i: стыки, ручки,
 * механизм подъёмника, ниша, стекло техники, бутылки карго); выбранный — #DCE6FF с синей рамкой внутри.
 * Подписей в ячейках нет: выбранный модуль подписан под схемой (.mlab), на планшете — размеры под рядами (.dimr).
 * Верхние висят от общей линии верха (вытяжка короче), ярус — коробом над модулем, холодильник — от пола до верха
 * верхних, пустое место — пунктиром, полки на столешнице — коробами на ней; «+» в конце рядов.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';
import type { ProductTree } from '../../api/types';
import { useT } from '../../i18n';
import { moduleLengths } from '../../lib/kitchenMeasure';
import {
  KDEF, baseParts, clamp, fridgeSpans, hasTier, midParts, num, schemeLayout, tierParts, wallModHeight, wallParts,
  type KLayout, type KMod, type KPart, type KPartKind, type KRow, type KSel,
} from '../../lib/kitchenScheme';
import { Press, T } from '../../ui/kit';
import { palette } from '../../ui/theme';

/** Полосы схемы по высоте (pt): ярус, верхние, промежуток до столешницы, столешница, нижние. */
export type FacadeMetrics = { wall: number; gap: number; ct: number; base: number; tier: number; pad: number; plus: number; dims?: boolean };
/** Телефон: .row6 96 / 104, столешница 9 через 22 (макет). */
export const PHONE_M: FacadeMetrics = { wall: 96, gap: 22, ct: 9, base: 104, tier: 22, pad: 10, plus: 30 };
/** Планшет: 150 / 176, размеры под рядами, столешница 12 через 44 после размеров; поля 44. */
export const TABLET_M: FacadeMetrics = { wall: 150, gap: 44, ct: 12, base: 176, tier: 30, pad: 44, plus: 0, dims: true };
const DIMS = 33; // .dimr: отступ 10 + строка 23

/** Высота схемы при этих полосах (для подгонки под экран). */
export function facadeHeight(layout: KLayout, M: FacadeMetrics): number {
  const anyTier = layout.wall.some((b) => hasTier(b.m));
  return (anyTier ? M.tier : 0) + M.wall + gapOf(layout, M) + M.ct + 3 + M.base + (M.dims ? DIMS : 0);
}
const gapOf = (layout: KLayout, M: FacadeMetrics) => Math.max(M.gap, layout.mid.length && !M.dims ? 40 : 0) + (M.dims ? DIMS : 0);
export const scaleMetrics = (M: FacadeMetrics, k: number): FacadeMetrics =>
  k >= 1 ? M : { ...M, wall: Math.round(M.wall * k), gap: Math.round(M.gap * k), base: Math.round(M.base * k), tier: Math.round(M.tier * k) };

/** .cv — точечное поле 16 × 16 (radial-gradient #D5D3CE 1.1px). */
export function Dots({ style }: { style?: ViewStyle }) {
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, s.dots, style]} />;
}

const PART: Record<KPartKind, ViewStyle> = {
  ln: { backgroundColor: '#8E8B85' },
  hd: { backgroundColor: palette.ink, borderRadius: 2 },
  dk: { backgroundColor: '#3A3936' },
  op: { backgroundColor: '#E9E4D8', boxShadow: 'inset 0px 3px 4px rgba(0,0,0,0.14)' },
  gl: { backgroundColor: '#CBDDF3' },
  mw: { backgroundColor: '#2B2A28', borderRadius: 2 },
  bt: { backgroundColor: '#7FA88C', borderTopLeftRadius: 3, borderTopRightRadius: 3, borderBottomLeftRadius: 1, borderBottomRightRadius: 1 },
};

/** Части рисунка (проценты) → pt внутри ячейки w × h; линии не тоньше 1, ручки — 2. */
export function Parts({ parts, w, h, small }: { parts: KPart[]; w: number; h: number; small?: boolean }) {
  return (
    <>
      {parts.map((p, i) => {
        const min = p.c === 'hd' && !small ? 2 : 1;
        return (
          <View key={i} pointerEvents="none" style={[{
            position: 'absolute', left: (p.l / 100) * w, top: (p.t / 100) * h,
            width: Math.max(min, (p.w / 100) * w), height: Math.max(min, (p.h / 100) * h),
          }, PART[p.c], small && p.c === 'bt' && { borderTopLeftRadius: 1, borderTopRightRadius: 1 }]} />
        );
      })}
    </>
  );
}

export function Facade({ tree, layout, run, sel, ctOn, onPick, onAdd, lbl, x0, width, y0, M, addLabels, cornerLabel, tierLabel, badRow }: {
  tree: ProductTree; layout: KLayout; run: 1 | 2; sel: KSel | null; ctOn?: boolean; onPick: (s: KSel) => void; onAdd?: (row: KRow) => void;
  lbl: (m: KMod, row: KRow) => string; x0: number; width: number; y0: number; M: FacadeMetrics;
  addLabels: Record<'base' | 'wall' | 'mid', string>; cornerLabel: string; tierLabel: string;
  /** Ряд, сумма которого не сходится со стеной: размер выбранного модуля — красным (планшет). */
  badRow?: KRow | null;
}) {
  const plusLeft = run === 2 && tree.corner_side === 'left';
  const avail = width - 2 * M.pad - M.plus;
  const k = avail / layout.len;
  const X0 = x0 + M.pad + (plusLeft ? M.plus : 0);
  const px = (mm: number) => Math.round(mm * k);
  const anyTier = layout.wall.some((b) => hasTier(b.m));
  const yWall = y0 + (anyTier ? M.tier : 0);
  const yCt = yWall + M.wall + gapOf(layout, M);
  const yBase = yCt + M.ct + 3;
  const yBot = yBase + M.base;
  const wh = num(tree.wall_height, KDEF.wall_height);
  const ctTop = num(tree.legs_height, KDEF.legs_height) + num(tree.base_height, KDEF.base_height) + 38;
  const gapMm = Math.max(1, num(tree.wall_bottom, KDEF.wall_bottom) - ctTop);
  const isOn = (b: KSel, tier = false) => !!sel && sel.row === b.row && sel.i === b.i && !!sel.tier === tier;
  // ячейки внахлёст рамками 3 pt — стыки как gap:3 у .row6
  const box = (x: number, w: number) => ({ left: X0 + px(x), width: Math.max(9, px(x + w) - px(x) + 3) });
  const fridges = fridgeSpans(layout);
  const spans = [...layout.base, ...(layout.corner ? [layout.corner] : [])];
  let ctLo = spans.length ? Math.min(...spans.map((b) => b.x)) : 0;
  let ctHi = spans.length ? Math.max(...spans.map((b) => b.x + b.w)) : 0;
  for (const f of fridges) {
    if (f.x <= ctLo + 1) ctLo = Math.max(ctLo, f.x + f.w);
    else if (f.x + f.w >= ctHi - 1) ctHi = Math.min(ctHi, f.x);
  }
  const plusX = plusLeft ? X0 - M.plus + 2 : X0 + px(layout.len) + (M.plus ? 6 : 10);
  const wallRow: KRow = run === 2 ? 'wall2' : 'wall';
  const baseRow: KRow = run === 2 ? 'base2' : 'base';

  const cell = (b: { sel: KSel; x: number; w: number; m: KMod }, row: KRow, top: number, h: number, bg: string, parts: KPart[], extra?: ReactNode) => {
    const on = isOn(b.sel);
    const bx = box(b.x, b.w);
    const gap = b.m.kind === 'gap';
    return (
      <Pressable key={`${row}${b.sel.i}`} onPress={() => onPick(b.sel)} accessibilityRole="button" accessibilityLabel={`${lbl(b.m, row)} ${b.w}`} accessibilityState={{ selected: on }}
        style={[s.mod, bx, { top, height: h, backgroundColor: bg }, gap && s.gapBox, on && s.modOn]}>
        <Parts parts={parts} w={bx.width - 6} h={h - 6} />
        {extra}
        {on ? <View pointerEvents="none" style={[s.onRing, gap && { top: -1.5, left: -1.5, right: -1.5, bottom: -1.5 }]} /> : null}
      </Pressable>
    );
  };
  const dimRow = (boxes: { sel: KSel; x: number; w: number }[], top: number) => boxes.map((b) => {
    const bad = !!badRow && !!sel && sel.row === b.sel.row && sel.i === b.sel.i && badRow === b.sel.row;
    const c = bad ? palette.red : palette.blue;
    const bx = box(b.x, b.w);
    return (
      <View key={`d${b.sel.row}${b.sel.i}`} pointerEvents="none" style={[s.dim, { left: bx.left + 3, width: bx.width - 6, top }]}>
        <View style={[s.dimTick, { left: 0, backgroundColor: c }]} /><View style={[s.dimTick, { right: 0, backgroundColor: c }]} />
        <View style={[s.dimLine, { backgroundColor: c }]} />
        <T num style={[s.dimT, { color: c }]}>{b.w}</T>
      </View>
    );
  });

  const walls = layout.wall.filter((b) => !(b.m.kind === 'gap' && fridges.some((f) => b.x >= f.x - 1 && b.x + b.w <= f.x + f.w + 1)));
  return (
    <>
      {/* холодильник — от пола до верха верхних, под рядами */}
      {layout.base.filter((b) => b.m.kind === 'fridge').map((b) => cell(b, baseRow, yWall, yBot - yWall, '#ECEBE6', baseParts(b.m)))}
      {/* верхние */}
      {walls.map((b) => {
        const m = b.m;
        const h = m.kind === 'gap' ? M.wall : clamp(Math.round((wallModHeight(m, tree) / wh) * M.wall), [22, M.wall + gapOf(layout, M) - 8]);
        const bx = box(b.x, b.w);
        return (
          <View key={`w${b.sel.i}`}>
            {hasTier(m) ? (
              <Pressable onPress={() => onPick({ ...b.sel, tier: true })} accessibilityRole="button" accessibilityLabel={`${tierLabel} ${b.sel.i + 1}`} accessibilityState={{ selected: isOn(b.sel, true) }}
                style={[s.mod, bx, { top: yWall - M.tier + 3, height: M.tier, backgroundColor: '#F7F7F5' }, isOn(b.sel, true) && s.modOn]}>
                <Parts parts={tierParts(m)} w={bx.width - 6} h={M.tier - 6} />
                {isOn(b.sel, true) ? <View pointerEvents="none" style={s.onRing} /> : null}
              </Pressable>
            ) : null}
            {cell(b, wallRow, yWall, h, m.kind === 'gap' ? 'transparent' : '#F7F7F5', wallParts(m, tree))}
          </View>
        );
      })}
      {M.dims ? dimRow(walls, yWall + M.wall + 10) : null}
      {/* полки на столешнице */}
      {layout.mid.map((b) => {
        const hmm = typeof b.m.height === 'number' ? b.m.height : gapMm;
        const maxH = gapOf(layout, M) - (M.dims ? DIMS : 0);
        const h = clamp(Math.round((hmm / gapMm) * maxH), [14, maxH]);
        const on = isOn(b.sel);
        const bx = box(b.x, b.w);
        return (
          <Pressable key={`m${b.sel.i}`} onPress={() => onPick(b.sel)} accessibilityRole="button" accessibilityLabel={`${lbl(b.m, 'mid')} ${b.w}`} accessibilityState={{ selected: on }}
            style={[s.midBox, bx, { top: yCt - h + 2, height: h }, on && s.modOn]}>
            <Parts parts={midParts(b.m)} w={bx.width - 4} h={h - 4} />
            {on ? <View pointerEvents="none" style={[s.onRing, { borderWidth: 2 }]} /> : null}
          </Pressable>
        );
      })}
      {/* столешница (.ct; вкладка «Столешница» — синяя) */}
      {ctHi > ctLo ? <View style={[s.ct, { top: yCt, height: M.ct + 3, left: X0 + px(ctLo) - 4, width: px(ctHi) - px(ctLo) + 11 }, ctOn && s.ctOn]} /> : null}
      {/* угловая зона ряда 2 */}
      {layout.corner ? (
        <Pressable onPress={() => layout.corner?.sel && onPick(layout.corner.sel)} accessibilityRole="button" accessibilityLabel={cornerLabel}
          style={[s.mod, box(layout.corner.x, layout.corner.w), { top: yBase, height: M.base, backgroundColor: '#ECE6DA' }, layout.corner.sel && isOn(layout.corner.sel) && s.modOn]}>
          {!(layout.corner.sel && isOn(layout.corner.sel)) ? <Hatch /> : <View pointerEvents="none" style={s.onRing} />}
        </Pressable>
      ) : null}
      {/* нижние */}
      {layout.base.filter((b) => b.m.kind !== 'fridge').map((b) => cell(b, baseRow, yBase, M.base, b.m.kind === 'corner' ? '#ECE6DA' : '#F4F2EC', baseParts(b.m),
        b.m.kind === 'corner' && !isOn(b.sel) ? <Hatch /> : null))}
      {M.dims ? dimRow(layout.base, yBot + 10) : null}
      {/* «+» в конце рядов */}
      {onAdd ? (
        <>
          <PlusBtn x={plusX} y={yWall + M.wall / 2 - 13} label={addLabels.wall} onPress={() => onAdd(wallRow)} />
          {run === 1 ? <PlusBtn x={plusX} y={yCt - Math.min(gapOf(layout, M) - (M.dims ? DIMS : 0), 30) / 2 - 11} small label={addLabels.mid} onPress={() => onAdd('mid')} /> : null}
          <PlusBtn x={plusX} y={yBase + M.base / 2 - 13} label={addLabels.base} onPress={() => onAdd(baseRow)} />
        </>
      ) : null}
    </>
  );
}

function PlusBtn({ x, y, label, onPress, small }: { x: number; y: number; label: string; onPress: () => void; small?: boolean }) {
  const d = small ? 22 : 26;
  return (
    <Press feedback="scale" onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={label}
      style={[s.plus, { left: x + (26 - d) / 2, top: y, width: d, height: d, borderRadius: d / 2 }]}>
      <Ionicons name="add" size={small ? 15 : 17} color={palette.ink} />
    </Press>
  );
}

/**
 * План угловой кухни «вид сверху»: стена А (верх) — ряд base с угловым модулем, стена Б — ряд base2 от угла вниз.
 * Г-образный (square) угол — квадрат в стыке, «длинный» — модуль вдоль А, ряд Б начинается за глубиной столешницы.
 * corner_side: 'right' — зеркально (угол справа).
 */
export function CornerPlan({ tree, base, base2, sel, onPick, lbl, x0 = 0, width, y0, maxH = 210 }: {
  tree: ProductTree; base: KMod[]; base2: KMod[]; sel: KSel | null; onPick: (s: KSel) => void; lbl: (m: KMod) => string; x0?: number; width?: number; y0: number; maxH?: number;
}) {
  const { t } = useT();
  const { width: SW } = useWindowDimensions();
  const AW = width ?? SW;
  const lens = moduleLengths(tree);
  const l2 = schemeLayout(tree, 2);
  const offB = l2.corner?.w ?? 600;
  const lenA = lens.a;
  const lenB = lens.b ?? offB;
  const right = tree.corner_side === 'right';
  const X0 = x0 + 40, Y0 = y0 + 14, DP = 64;
  const k = Math.min((AW - 80 - 4) / Math.max(lenA, 1), maxH / Math.max(lenB, 1));
  const W = Math.round(lenA * k);
  const mx = (x: number, w: number) => (right ? 2 * X0 + W - x - w : x);
  const items: { s: KSel; x: number; y: number; w: number; h: number; m: KMod }[] = [];
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
  base2.forEach((m, i) => { const h = Math.round((m.width ?? 0) * k); items.push({ s: { row: 'base2', i }, x: mx(X0, DP), y: y - 2, w: DP, h: h + 2, m }); y += h; });
  const wallX = right ? X0 + W : X0 - 6;
  const sqPx = Math.max(DP, Math.round(offB * k));
  const innerL = right ? X0 + 12 : X0 + sqPx + 14;
  return (
    <>
      <View style={[s.wall, { left: X0 - 6, top: Y0 - 6, width: W + 12, height: 6 }]} />
      <View style={[s.wall, { left: wallX, top: Y0 - 6, width: 6, height: Math.round(lenB * k) + 6 }]} />
      {items.map((it) => {
        const on = !!sel && sel.row === it.s.row && sel.i === it.s.i && !sel.tier;
        const cor = it.m.kind === 'corner';
        return (
          <Pressable key={`${it.s.row}${it.s.i}`} onPress={() => onPick(it.s)} accessibilityRole="button" accessibilityLabel={lbl(it.m)} accessibilityState={{ selected: on }}
            style={[s.m, { left: it.x, top: it.y, width: it.w, height: it.h }, cor && { backgroundColor: '#ECE6DA' }, on && s.mOn]}>
            {cor && !on ? <Hatch /> : null}
            <T style={[s.planT, on && { color: palette.blue }]} numberOfLines={1}>{lbl(it.m)}</T>
            <T num style={[s.planW, on && { color: palette.blue }]} numberOfLines={1}>{it.m.width ?? ''}</T>
          </Pressable>
        );
      })}
      <View style={{ position: 'absolute', left: innerL, top: Y0 + DP + 12, gap: 8, alignItems: 'flex-start' }} pointerEvents="none">
        <View style={[s.dimc, s.lift]}><T num style={s.dimcT}>{`${t('kit_a')} ${lenA}`}</T><T style={s.dimcS}>{t('mm')}</T></View>
        <View style={[s.dimc, s.lift]}><T num style={s.dimcT}>{`${t('kit_b')} ${lenB}`}</T><T style={s.dimcS}>{t('mm')}</T></View>
        <T v="cap" style={{ fontSize: 13 }}>{t('kit_top_view')}</T>
      </View>
    </>
  );
}

/** Диагональная штриховка углового модуля (45°, 6/6 px). */
export function Hatch() {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      {Array.from({ length: 24 }, (_, i) => (
        <View key={i} style={{ position: 'absolute', left: -120 + i * 17, top: -40, width: 6, height: 300, backgroundColor: '#F4F2EC', transform: [{ rotate: '45deg' }] }} />
      ))}
    </View>
  );
}

const lift = { shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 };
export const schemeStyles = StyleSheet.create({
  /** .dimc — белая плашка размера (синий 14/600, «мм» 12 .7). */
  dimc: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 32, paddingHorizontal: 11, borderRadius: 16, backgroundColor: palette.white, ...lift },
  dimcT: { fontSize: 14, fontWeight: '600', color: palette.blue },
  dimcS: { fontSize: 12, color: palette.blue, opacity: 0.7 },
  lift,
});
const s = StyleSheet.create({
  ...schemeStyles,
  dots: { backgroundColor: palette.ground, backgroundImage: 'radial-gradient(circle, #D5D3CE 1.1px, transparent 1.2px)', backgroundSize: '16px 16px' },
  mod: { position: 'absolute', borderWidth: 3, borderColor: palette.ink, overflow: 'hidden' },
  modOn: { backgroundColor: '#DCE6FF', zIndex: 2 },
  onRing: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderWidth: 3, borderColor: palette.blue },
  gapBox: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: palette.chev },
  midBox: { position: 'absolute', borderWidth: 2, borderColor: palette.ink, backgroundColor: '#FBFAF8', overflow: 'hidden' },
  ct: { position: 'absolute', backgroundColor: '#8D8778', borderWidth: 3, borderBottomWidth: 0, borderColor: palette.ink },
  ctOn: { backgroundColor: '#DCE6FF', borderColor: palette.blue },
  plus: { position: 'absolute', backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center', shadowColor: palette.ink, shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  dim: { position: 'absolute', height: 23, alignItems: 'center' },
  dimTick: { position: 'absolute', top: 0, width: 1, height: 7 },
  dimLine: { position: 'absolute', left: 0, right: 0, top: 3, height: 1 },
  dimT: { position: 'absolute', top: 8, left: -24, right: -24, textAlign: 'center', fontSize: 12, lineHeight: 15, fontWeight: '600' },
  wall: { position: 'absolute', backgroundColor: palette.ink, borderRadius: 3 },
  m: { position: 'absolute', borderWidth: 2, borderColor: palette.ink, backgroundColor: '#F4F2EC', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  mOn: { backgroundColor: '#DCE6FF', borderColor: palette.blue, zIndex: 1 },
  planT: { fontSize: 12, lineHeight: 15, fontWeight: '500', color: palette.muted2, letterSpacing: -0.3, paddingHorizontal: 2 },
  planW: { fontSize: 10, lineHeight: 12, fontWeight: '600', color: palette.faint },
});
