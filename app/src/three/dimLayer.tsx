/**
 * Слой размеров поверх 3D (линии 1 pt и плашки — RN-виды) без перерисовки React на каждый кадр.
 *
 * Виды смонтированы всегда; их положение — Animated.Value на нативном драйвере, которые канвас выставляет из
 * кадра GL (setValue → сразу в нативный вид, без рендера React и без коммита дерева). Линия — тонкий вид с
 * transform: сдвиг в середину, поворот, растяжение по длине. React перерисовывает слой только когда меняется
 * содержимое: режим (изделие / деталь / ничего), вводимый размер, значения, цвета, набор размеров.
 * Прячем размеры только по смыслу (выключены, «взрыв», выбрана деталь) — коротким растворением, не на время движения камеры.
 */
import { memo, useEffect, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import type { DimensionAnchor, DimensionAnchors, DimensionKey, PartDimensionAnchors, PartDimensionKey } from '@mebel/viewer';

type Line = readonly [number, number, number, number];
/** Куда уводим скрытые виды (без лишних касаний по невидимым плашкам). */
const OFF = -10000;
const FADE_MS = 150;
const native = () => new Animated.Value(0, { useNativeDriver: true });

/** Отрезок: середина, угол, длина — 4 нативных значения; ставятся, только если изменились. */
export class LineNode {
  readonly x = native();
  readonly y = native();
  readonly deg = native();
  readonly len = native();
  readonly rotate = this.deg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'], extrapolate: 'extend' });
  private last = [NaN, NaN, NaN, NaN];

  constructor() {
    this.x.setValue(OFF);
    this.y.setValue(OFF);
  }

  set(l: Line | null): void {
    const len = l ? Math.hypot(l[2] - l[0], l[3] - l[1]) : 0;
    if (!l || len < 0.5 || !Number.isFinite(len)) {
      this.put(0, OFF);
      this.put(1, OFF);
      return;
    }
    this.put(0, (l[0] + l[2]) / 2);
    this.put(1, (l[1] + l[3]) / 2);
    this.put(2, (Math.atan2(l[3] - l[1], l[2] - l[0]) * 180) / Math.PI);
    this.put(3, len);
  }

  private put(i: number, v: number): void {
    if (Math.abs(this.last[i]! - v) < 0.01) return;
    this.last[i] = v;
    [this.x, this.y, this.deg, this.len][i]!.setValue(v);
  }
}

/** Плашка: центр в точке. */
export class LabelNode {
  readonly x = native();
  readonly y = native();
  private lx = NaN;
  private ly = NaN;

  constructor() {
    this.x.setValue(OFF);
    this.y.setValue(OFF);
  }

  set(p: readonly [number, number] | null): void {
    const [x, y] = p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : [OFF, OFF];
    if (!(Math.abs(this.lx - x) < 0.01)) { this.lx = x; this.x.setValue(x); }
    if (!(Math.abs(this.ly - y) < 0.01)) { this.ly = y; this.y.setValue(y); }
  }
}

export interface DimNode {
  edge: LineNode;
  ext0: LineNode;
  ext1: LineNode;
  main: LineNode;
  tick0: LineNode;
  tick1: LineNode;
  label: LabelNode;
}

const dimNode = (): DimNode => ({
  edge: new LineNode(), ext0: new LineNode(), ext1: new LineNode(), main: new LineNode(),
  tick0: new LineNode(), tick1: new LineNode(), label: new LabelNode(),
});

function setDim(n: DimNode, d: DimensionAnchor<string> | null, focused: boolean): void {
  const on = !!d && d.visible;
  n.edge.set(on && focused ? [...d.edgeA, ...d.edgeB] : null);
  n.ext0.set(on ? d.ext[0] : null);
  n.ext1.set(on ? d.ext[1] : null);
  n.main.set(on ? [...d.a, ...d.b] : null);
  n.tick0.set(on ? d.ticks[0] : null);
  n.tick1.set(on ? d.ticks[1] : null);
  n.label.set(on ? d.label : null);
}

export const ALL_DIMS: DimensionKey[] = ['width', 'height', 'depth'];
export const PART_KEYS: PartDimensionKey[] = ['length', 'width', 'thickness'];

export type DimMode = 'dims' | 'part' | 'none';

/** Смысловое состояние слоя (меняется редко — по нему рендерит React). */
export interface DimSemantic {
  mode: DimMode;
  focused: DimensionKey | null;
  /** Размеры детали в фокусе, мм; версия — новая деталь. */
  partValues: Record<PartDimensionKey, number>;
  partVersion: number;
}

/** Нативные значения слоя + подписчики на смену смысла. Живёт столько же, сколько канвас. */
export class DimLayer {
  readonly dims: Record<DimensionKey, DimNode> = { width: dimNode(), height: dimNode(), depth: dimNode() };
  readonly part: Record<PartDimensionKey, DimNode> = { length: dimNode(), width: dimNode(), thickness: dimNode() };
  readonly dimsOpacity = native();
  readonly partOpacity = native();
  readonly keyOpacity: Record<DimensionKey, Animated.Value> = { width: native(), height: native(), depth: native() };
  state: DimSemantic = { mode: 'none', focused: null, partValues: { length: 0, width: 0, thickness: 0 }, partVersion: 0 };
  /** Последние точки (для аргумента renderDimensionLabel и onDimensionAnchors). */
  anchors: DimensionAnchors | null = null;
  partAnchors: PartDimensionAnchors | null = null;
  readonly listeners = new Set<() => void>();

  /** Положения за кадр: только нативные значения. Смысл сменился — сообщить React. */
  sync(a: DimensionAnchors | null, p: PartDimensionAnchors | null, focused: DimensionKey | null): void {
    // габарит при «взрыве» не двигаем — он растворяется на месте
    if (a) for (const k of ALL_DIMS) setDim(this.dims[k], a[k], focused === k);
    if (p) for (const k of PART_KEYS) setDim(this.part[k], p[k], false);
    this.anchors = a;
    this.partAnchors = p;
    const mode: DimMode = p ? 'part' : a ? 'dims' : 'none';
    if (mode !== this.state.mode || focused !== this.state.focused) this.setState({ mode, focused });
  }

  setPartValues(v: Record<PartDimensionKey, number>): void {
    this.setState({ partValues: v, partVersion: this.state.partVersion + 1 });
  }

  private setState(patch: Partial<DimSemantic>): void {
    this.state = { ...this.state, ...patch };
    for (const f of this.listeners) f();
  }
}

/** '#rrggbb' + прозрачность → rgba(). */
export function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function fade(v: Animated.Value, on: boolean, instantIn = false): void {
  if (on && instantIn) { v.stopAnimation(); v.setValue(1); return; }
  Animated.timing(v, { toValue: on ? 1 : 0, duration: FADE_MS, useNativeDriver: true }).start();
}

const LineView = memo(function LineView({ n, w, color }: { n: LineNode; w: number; color: string }) {
  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', left: -0.5, top: -w / 2, width: 1, height: w, backgroundColor: color, borderRadius: w / 2,
      transform: [{ translateX: n.x }, { translateY: n.y }, { rotate: n.rotate }, { scaleX: n.len }],
    }} />
  );
});

function LabelView({ n, children }: { n: LabelNode; children: ReactNode }) {
  // центр плашки — в точке label (рамка 200×64 с выравниванием по центру)
  return (
    <Animated.View pointerEvents="box-none" style={[s.label, { transform: [{ translateX: n.x }, { translateY: n.y }] }]}>
      {children}
    </Animated.View>
  );
}

export interface LabelState {
  focused: boolean;
  muted: boolean;
  valueMm: number;
  color: string;
  part: boolean;
}

export type RenderLabel = (key: DimensionKey | PartDimensionKey, anchor: DimensionAnchor<DimensionKey | PartDimensionKey>, state: LabelState) => ReactNode;

/** Пустая точка для renderDimensionLabel, пока точек ещё нет. */
const NO_ANCHOR = { a: [0, 0], b: [0, 0], ext: [[0, 0, 0, 0], [0, 0, 0, 0]], ticks: [[0, 0, 0, 0], [0, 0, 0, 0]], edgeA: [0, 0], edgeB: [0, 0], label: [0, 0], visible: false, length: 0 } as unknown as DimensionAnchor<DimensionKey | PartDimensionKey>;

/**
 * Слой: рендер — по смыслу (useState из DimLayer), положения — нативно. `pill` — плашка по умолчанию.
 */
export function DimensionLayer({ layer, lines, keys, values, colors, renderLabel, pill, blue, onRender }: {
  layer: DimLayer;
  lines: boolean;
  keys: DimensionKey[];
  values: Record<DimensionKey, number>;
  colors?: Partial<Record<DimensionKey, string>>;
  renderLabel?: RenderLabel;
  pill: (text: string, st: LabelState) => ReactNode;
  blue: string;
  onRender?: () => void;
}) {
  const [st, setSt] = useState(layer.state);
  useEffect(() => {
    const f = () => setSt(layer.state);
    layer.listeners.add(f);
    f();
    return () => { layer.listeners.delete(f); };
  }, [layer]);
  onRender?.();
  const { mode, focused } = st;
  // видимость — после коммита: содержимое плашек уже новое, положения уже стоят
  useEffect(() => {
    fade(layer.dimsOpacity, mode === 'dims');
    fade(layer.partOpacity, mode === 'part', true);
  }, [layer, mode, st.partVersion]);
  const keysKey = keys.join(',');
  useEffect(() => {
    for (const k of ALL_DIMS) fade(layer.keyOpacity[k], keys.includes(k));
  }, [layer, keysKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // вводимый размер — всегда синий; остальные — свой цвет (оценка — янтарный), при вводе другого — приглушены
  const colorOf = (k: DimensionKey) => (focused === k ? blue : colors?.[k] ?? blue);
  const ext = withAlpha(blue, 0.55);
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View pointerEvents={mode === 'dims' ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, { opacity: layer.dimsOpacity }]}>
        {ALL_DIMS.map((k) => {
          const n = layer.dims[k];
          const on = !focused || focused === k;
          const base = colorOf(k);
          const c = on ? base : withAlpha(base, 0.22);
          const e = on ? withAlpha(base, 0.55) : withAlpha(base, 0.22);
          const shown = keys.includes(k);
          const lst: LabelState = { focused: focused === k, muted: !!focused && focused !== k, valueMm: values[k], color: colorOf(k), part: false };
          const node = renderLabel ? renderLabel(k, layer.anchors?.[k] ?? NO_ANCHOR, lst) : lines ? pill(`${Math.round(values[k])}`, lst) : null;
          return (
            <Animated.View key={k} pointerEvents={shown ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, { opacity: layer.keyOpacity[k] }]}>
              {lines ? (
                <>
                  {focused === k ? <LineView n={n.edge} w={3} color={blue} /> : null}
                  <LineView n={n.ext0} w={1} color={e} />
                  <LineView n={n.ext1} w={1} color={e} />
                  <LineView n={n.main} w={focused === k ? 1.5 : 1} color={c} />
                  <LineView n={n.tick0} w={1.5} color={c} />
                  <LineView n={n.tick1} w={1.5} color={c} />
                </>
              ) : null}
              {node ? <LabelView n={n.label}>{node}</LabelView> : null}
            </Animated.View>
          );
        })}
      </Animated.View>
      <Animated.View pointerEvents={mode === 'part' ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, { opacity: layer.partOpacity }]}>
        {PART_KEYS.map((k) => {
          const n = layer.part[k];
          const lst: LabelState = { focused: false, muted: false, valueMm: st.partValues[k], color: blue, part: true };
          const node = renderLabel ? renderLabel(k, layer.partAnchors?.[k] ?? NO_ANCHOR, lst) : pill(`${Math.round(st.partValues[k] * 10) / 10}`, lst);
          return (
            <View key={k} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
              <LineView n={n.ext0} w={1} color={ext} />
              <LineView n={n.ext1} w={1} color={ext} />
              <LineView n={n.main} w={1} color={blue} />
              <LineView n={n.tick0} w={1.5} color={blue} />
              <LineView n={n.tick1} w={1.5} color={blue} />
              {node ? <LabelView n={n.label}>{node}</LabelView> : null}
            </View>
          );
        })}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  label: { position: 'absolute', left: -100, top: -32, width: 200, height: 64, alignItems: 'center', justifyContent: 'center' },
});
