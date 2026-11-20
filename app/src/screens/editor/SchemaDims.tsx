/**
 * Схема с нажимаемыми размерными плашками (v3: X5Editor, X5Dim, X5Many, X5Err, X4Split).
 * Плашка части — ширина створки/глухой под окном (или высота слева у горизонтального деления), общая ширина ниже,
 * высота справа. Нажатие — onDim(цель) → лист ввода размера (DimSheet).
 * Состояния плашки (.dim): обычная · on (вводят сейчас, ✎) · chg (пересчиталась) · ro (не меняется) · err (нарушение).
 * Много частей (X5Many): размер показываем только у выбранной — иначе плашки налезают друг на друга.
 */
import type { ReactElement } from 'react';
import { Pressable, View } from 'react-native';

import type { Doc, Violation } from '@/api/types';
import type { DimTarget } from '@/lib/dims';
import { num } from '@/lib/format';
import { frameShape, isAssembly, joinPath, layout, nodeAt } from '@/lib/tree';
import { C } from '@/theme';
import { Txt } from '@/ui/kit';
import { hlFromViolations, Schema, schemaGeometry } from '@/ui/Schema';

export type DimEdit = { target: DimTarget; changed: number[] } | null;
type PlateState = 'on' | 'chg' | 'ro' | 'err' | undefined;

const PLATE_H = 40;
const PLATE_S = 30;                 // компактная плашка, когда частей много
/** ширина плашки по тексту (для раскладки в два ряда) */
const plateW = (t: string, small: boolean) => (small ? 16 : 28) + t.length * (small ? 8 : 10);
const ROW_GAP = 8;
/** уже этого (px на схеме) плашки частей налезают — показываем только выбранную */
const MIN_PX_W = 70, MIN_PX_H = 46;

export function SchemaDims({ doc, width, maxHeight, view = 'inside', selected, violations, onCellPress, onShape, onDim, edit, frameDims = true }: {
  doc: Doc; width: number; maxHeight: number; view?: 'inside' | 'outside'; selected: string | null; violations?: Violation[];
  onCellPress?: (path: string) => void; onShape?: (prefix: string) => void; onDim?: (t: DimTarget) => void; edit?: DimEdit;
  /** false — без общей ширины/высоты и плашек формы (шаг деления: габарит только что сняли) */
  frameDims?: boolean;
}) {
  const G = schemaGeometry(doc, width, maxHeight, false, view);
  const roomy = G.vw >= 200;
  const { vw, vh, k } = G;
  const schema = <Schema doc={doc} width={vw} maxHeight={vh} dims={false} view={view} selected={selected} violations={violations} onCellPress={onCellPress} />;
  const partEdit = edit?.target.kind === 'part' ? edit.target.path : null;
  const frameEdit = edit?.target.kind === 'frame' ? edit.target : null;
  const frameState = (axis: 'w' | 'h', prefix: string): PlateState =>
    frameEdit ? (frameEdit.axis === axis && frameEdit.prefix === prefix ? 'on' : 'ro') : partEdit !== null ? 'ro' : undefined;

  if (isAssembly(doc)) {
    if (!frameDims) return <View style={{ width: vw, height: vh }}>{schema}</View>;
    // сборка: ширина каждой рамы под ней, общая высота справа
    const H = G.frames.reduce((m, f) => Math.max(m, f.frame.h), 0);
    return (
      <View style={{ width: vw, height: vh }}>
        {schema}
        {G.frames.map((f) => (
          <Plate key={f.index} text={`${num(f.frame.w)}${frameShape(f.frame).shape !== 'rect' ? ' ⌒' : ''}`} left={f.x + f.w / 2} top={vh + ROW_GAP}
            state={frameState('w', `A${f.index}/`)} onPress={onDim ? () => onDim({ kind: 'frame', axis: 'w', prefix: `A${f.index}/` }) : undefined} />
        ))}
        <Plate text={num(H)} side="right" left={vw + 4} top={vh / 2 - PLATE_H / 2} state={frameState('h', '')}
          onPress={onDim ? () => onDim({ kind: 'frame', axis: 'h', prefix: '' }) : undefined} />
      </View>
    );
  }

  const W = doc.frame.w, H = doc.frame.h, fg = G.frames[0];
  const mirror = view === 'outside';
  const X = (x: number) => fg.x + (mirror ? W - x : x) * k;
  const Y = (y: number) => fg.y + y * k;
  const L = layout(doc);
  const hl = hlFromViolations(violations);
  const root = doc.frame.root;
  const bad = (p: string) => Object.entries(hl).some(([q, sv]) => sv === 'block' && (q === p || q.startsWith(`${p}.`)));
  const selectIn = (p: string) => {
    const c = L.cells.find((x) => x.path === p || x.path.startsWith(`${p}.`));
    if (c) onCellPress?.(c.path);
  };

  // ряд ширин под окном: части корня (деление по вертикали) или нижний узел фрамуги (корень по горизонтали, внизу — деление по вертикали)
  const vertical = (split?: string) => !!split && split !== 'h' && split !== 'vslide' && split !== 'none';
  let rowParent: string | null = null;
  if (root.parts && vertical(root.split)) rowParent = '';
  else if (root.parts && !vertical(root.split) && root.split !== 'none') {
    const last = root.parts.length - 1;
    try { if (vertical(nodeAt(doc, joinPath('', last)).split)) rowParent = joinPath('', last); } catch { /* нет узла */ }
  }
  const colParent = root.parts && (root.split === 'h' || root.split === 'vslide') ? '' : null;
  const sizesOf = (p: string | null) => (p === null ? [] : L.sizes[p] ?? []);
  const row = sizesOf(rowParent), col = sizesOf(colParent);

  const stateOf = (parent: string, i: number, axis: 'w' | 'h'): PlateState => {
    const p = joinPath(parent, i);
    if (partEdit === p) return 'on';
    if (partEdit !== null && edit && edit.target.kind === 'part' && parentOfPart(partEdit) === parent && edit.changed.includes(i)) return 'chg';
    if (frameEdit && frameEdit.prefix === '' && frameEdit.axis === axis) return 'chg';
    if (bad(p)) return 'err';
    return undefined;
  };
  /** много частей: все размеры видны — плашки меньше, а если и так тесно — в шахматном порядке (два ряда / две колонки).
   * У выбранной (X5Many) плашка «on» — её и правят. */
  const visible = (parent: string, sizes: number[], pxMin: number, horizontal: boolean) => {
    const crowded = sizes.length > 3 || sizes.some((s) => s * k < pxMin);
    const inSel = (i: number) => { const p = joinPath(parent, i); return selected !== null && (selected === p || selected.startsWith(`${p}.`)); };
    const extent = (i: number) => (horizontal ? plateW(num(Math.round(sizes[i])), crowded) : (crowded ? PLATE_S : PLATE_H));
    // шахматка: если соседние плашки не помещаются над своими частями
    const stagger = crowded && sizes.some((s, i) => i > 0 && (sizes[i - 1] * k + s * k) / 2 < (extent(i - 1) + extent(i)) / 2 + 4);
    return {
      show: (_i: number) => true,
      small: crowded,
      shift: (i: number) => (stagger && i % 2 === 1 ? 1 : 0),
      stagger,
      state: (i: number, axis: 'w' | 'h'): PlateState => (crowded && !edit && inSel(i) ? 'on' : stateOf(parent, i, axis)),
    };
  };

  const plates: ReactElement[] = [];
  let rowSmall = false, rowStagger = false;
  if (rowParent !== null && row.length > 1) {
    const v = visible(rowParent, row, MIN_PX_W, true);
    rowSmall = v.small; rowStagger = v.stagger;
    let acc = 0;
    row.forEach((s, i) => {
      const cx = (X(acc) + X(acc + s)) / 2; acc += s;
      if (!v.show(i)) return;
      const p = joinPath(rowParent!, i);
      const ph = v.small ? PLATE_S : PLATE_H;
      plates.push(<Plate key={`r${i}`} small={v.small} text={num(Math.round(s))} left={cx} top={vh + ROW_GAP + v.shift(i) * (ph + 4)} state={v.state(i, 'w')}
        onPress={onDim ? () => onDim({ kind: 'part', path: p }) : () => selectIn(p)} />);
    });
  }
  if (colParent !== null && col.length > 1) {
    const v = visible(colParent, col, MIN_PX_H, false);
    let acc = 0;
    col.forEach((s, i) => {
      const cy = (Y(acc) + Y(acc + s)) / 2; acc += s;
      if (!v.show(i)) return;
      const p = joinPath(colParent, i);
      const ph = v.small ? PLATE_S : PLATE_H;
      plates.push(<Plate key={`c${i}`} small={v.small} text={num(Math.round(s))} side="left" left={-4 - v.shift(i) * (plateW(num(Math.round(s)), v.small) + 4)} top={cy - ph / 2} state={v.state(i, 'h')}
        onPress={onDim ? () => onDim({ kind: 'part', path: p }) : () => selectIn(p)} />);
    });
  }
  const { shape, params } = frameShape(doc.frame);
  const rowShown = rowParent !== null && row.length > 1;
  const rowH = rowSmall ? PLATE_S : PLATE_H;
  const totalTop = vh + ROW_GAP + (rowShown ? rowH + ROW_GAP + (rowStagger ? rowH + 4 : 0) : 0);
  const leftBusy = colParent !== null && col.length > 1;
  const sh = onShape ? () => onShape('') : undefined;
  if (!frameDims) return <View style={{ width: vw, height: vh }}>{schema}{plates}</View>;
  return (
    <View style={{ width: vw, height: vh }}>
      {schema}
      {plates}
      <Plate text={shape === 'circle' ? `Ø ${num(W)}` : num(W)} left={fg.x + fg.w / 2} top={totalTop} state={frameState('w', '')}
        onPress={shape === 'circle' ? sh : onDim ? () => onDim({ kind: 'frame', axis: 'w', prefix: '' }) : undefined} />
      {shape === 'trapezoid' && roomy ? (
        <>
          <Plate text={num(mirror ? params.h_left! : params.h_right!)} side="right" left={vw + 4} top={Y(H - (mirror ? params.h_left! : params.h_right!) / 2) - PLATE_H / 2} onPress={sh} />
          {leftBusy
            ? <Plate text={num(mirror ? params.h_right! : params.h_left!)} left={vw / 2} top={-PLATE_H - 4} onPress={sh} />
            : <Plate text={num(mirror ? params.h_right! : params.h_left!)} side="left" left={-4} top={Y(H - (mirror ? params.h_right! : params.h_left!) / 2) - PLATE_H / 2} onPress={sh} />}
        </>
      ) : shape !== 'circle' ? (
        <Plate text={num(H)} side="right" left={vw + 4} top={fg.y + fg.h / 2 - PLATE_H / 2} state={frameState('h', '')}
          onPress={onDim ? () => onDim({ kind: 'frame', axis: 'h', prefix: '' }) : undefined} />
      ) : null}
      {shape === 'arch' && roomy ? <Plate text={`подъём ${num(params.rise!)}`} side="right" left={vw + 4} top={Y(0)} onPress={sh} /> : null}
      {shape === 'bevel' && roomy ? <Plate text={`срез ${num(params.dx!)}×${num(params.dy!)}`} left={vw / 2} top={-PLATE_H - 4} onPress={sh} /> : null}
    </View>
  );
}

/** родитель пути части без импорта tree (для сравнения) */
function parentOfPart(p: string): string {
  const m = /^(A\d+\/)?(.*)$/.exec(p)!;
  const pre = m[1] ?? '', sub = m[2];
  const i = sub.lastIndexOf('.');
  return pre + (i < 0 ? '' : sub.slice(0, i));
}

/** .dim v3: 40 px, белая с тенью; on — голубая с ✎; chg — светло-голубая; ro — без подложки; err — красное кольцо.
 * left — центр плашки (side center), левый край (right) или правый край (left). */
function Plate({ text, left, top, side = 'center', state, onPress, small }: {
  text: string; left: number; top: number; side?: 'center' | 'left' | 'right'; state?: PlateState; onPress?: () => void; small?: boolean;
}) {
  const box = 140;
  const pos = side === 'center' ? { left: left - box / 2, alignItems: 'center' as const }
    : side === 'right' ? { left, alignItems: 'flex-start' as const } : { left: left - box, alignItems: 'flex-end' as const };
  const on = state === 'on', chg = state === 'chg', ro = state === 'ro', err = state === 'err';
  return (
    <View pointerEvents="box-none" style={[{ position: 'absolute', top, width: box }, pos]}>
      <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={`Размер ${text}`} hitSlop={4}
        style={({ pressed }) => [{
          height: small ? PLATE_S : PLATE_H, borderRadius: small ? 15 : 20, paddingHorizontal: small ? 8 : 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
          backgroundColor: on ? C.accent : chg ? C.accentSoft : ro ? 'transparent' : C.card,
          shadowColor: on ? C.accent : '#21201F', shadowOpacity: ro || chg ? 0 : on ? 0.5 : 0.12, shadowRadius: on ? 8 : 7, shadowOffset: { width: 0, height: 4 },
          elevation: ro || chg ? 0 : 3, transform: [{ scale: pressed ? 0.96 : 1 }],
        }, chg && { borderWidth: 1.5, borderColor: C.accent }, err && { borderWidth: 2, borderColor: C.dangerLine },
        !on && !chg && !ro && !err && { borderWidth: 1, borderColor: 'rgba(33,32,31,0.10)' }]}>
        <Txt size={small ? 13 : 16} w={600} color={on ? '#fff' : chg ? C.accentDeep : ro ? C.muted : err ? '#A1221A' : C.ink} lines={1}
          style={{ fontVariant: ['tabular-nums'] }}>{text}{on ? '  ✎' : ''}</Txt>
      </Pressable>
    </View>
  );
}
