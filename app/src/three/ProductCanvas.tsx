/**
 * 3D изделия в приложении: @react-three/fiber/native + expo-gl + ProductObject из @mebel/viewer/react.
 *
 * Камера — ViewRig из viewer: изделие вписывается в свободную от плашек область (fitToFreeArea / freeArea),
 * центр проекции — в её центре, поэтому при вращении модель не уезжает под инструменты. Перспектива FOV 28°
 * (без «широкоугольного» искажения), при вводе размера — ортогональ (плавный «долли-зум»).
 * Вращение / зум / тап — свои, через PanResponder поверх Canvas (OrbitControls из drei в RN нет):
 * один палец — вращение, два — зум щипком, короткий тап (сдвиг < TAP_SLOP) — scene.pickAt(): деталь или фурнитура
 * (kind 'hardware') → открыть дверь/ящик и выбрать. Вращение тапом не считается.
 * Размерные линии (1 pt, RN-оверлей, dimLayer.tsx) и места плашек — по экранным точкам viewer (dimensionAnchors), каждый
 * кадр нативно (без рендера React), в том числе пока камера движется сама. Поля под них
 * симметричные — изделие по центру свободной области. partDimensions: выбранная деталь — камера на неё (rig.focusPart),
 * её длина / ширина / толщина синими линиями прямо на ней (partAnchors), габарит изделия скрыт.
 * frameloop="demand": кадры рисуются только при движении камеры или анимации узлов — бережём батарею.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber/native';
import { ProductObject, type ProductHandle } from '@mebel/viewer/react';
import {
  DIMENSION_MARGINS, ViewRig, detectQuality,
  type DimensionAnchor, type DimensionAnchors, type DimensionKey, type PartDimensionAnchors, type PartDimensionKey, type PickResult,
  type ProductScene, type Projection, type QualityLevel, type ViewInsets, type ViewerModel,
} from '@mebel/viewer';
import * as Device from 'expo-device';
import { Component, Profiler, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, PixelRatio, Platform, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { Box3, Vector3 } from 'three';
import { DIAG, diagLastError, diagLog } from '../diag';
import { T } from '../ui/kit';
import { colors, palette } from '../ui/theme';
import { shotLog } from '../dev/shot';
import { perfCount, perfDrainOn, perfFrame, perfMs, perfOn, perfProfiler } from '../dev/perf';
import { loadExpoTexture } from './textures';
import { DimLayer, DimensionLayer, withAlpha } from './dimLayer';

export type { DimensionAnchor, DimensionAnchors, DimensionKey, PartDimensionAnchors, PartDimensionKey, Projection, ViewInsets };
/** Размер изделия (ширина, высота, глубина) или детали (длина, ширина, толщина — у детали ключ 'width' тоже есть). */
export type AnyDimensionKey = DimensionKey | PartDimensionKey;

/** Отступы свободной области от краёв канваса, pt (сколько закрыто плашками интерфейса). */
export type FreeAreaInsets = Partial<ViewInsets>;

export interface FitAreaOptions {
  /** Отступ изделия от плашек, pt. По умолчанию 28. */
  padding?: number;
  /** Плавно (≈300 мс). По умолчанию true. */
  animate?: boolean;
}

export interface CanvasHandle {
  openAll(): void;
  closeAll(): void;
  toggleNode(id: string): void;
  explode(on: boolean): void;
  /** Вписать изделие заново (текущий угол, текущая свободная область). */
  resetView(): void;
  /**
   * Свободная от плашек область канваса: отступы от краёв канваса в pt. Изделие вписывается в неё с отступом
   * `padding` (28) от каждой плашки; если канвас сам рисует размеры (dimensionLines / renderDimensionLabel) —
   * плюс поля под размерные линии и плашки. Плавно (300 мс). Запоминается: после правки размеров модель
   * перевписывается в эту же область сама.
   */
  fitToFreeArea(insets: FreeAreaInsets, options?: FitAreaOptions): void;
  /** Перспектива (FOV 28°) или ортогональ (чертёж); переход плавный ≈450 мс. */
  setProjection(p: Projection): void;
  /**
   * Вид для ввода размера: 'width' / 'height' — строго спереди, 'depth' — сбоку в три четверти; всё в ортогонали.
   * Линия этого размера и мерное ребро — синие, остальные приглушены. null — вернуться к прежнему виду и проекции.
   */
  focusDimension(d: DimensionKey | null): void;
  /** Экранные точки размеров (pt канваса, y вниз) для текущей камеры; null — модели ещё нет. */
  getDimensionAnchors(): DimensionAnchors | null;
  /**
   * Деталь (номер или ключ) — камера на неё (видны длина, ширина и толщина), её размеры линиями на ней; null — назад
   * к прежнему виду. Декларативно — пропсы selectedPart + partDimensions.
   */
  focusPart(part: number | string | null): void;
  /** Экранные точки размеров детали в фокусе; null — фокуса нет. */
  getPartAnchors(): PartDimensionAnchors | null;
  /** LED-подсветка вкл/выкл (кнопка «Подсветка»): профили светятся, свет и фон сцены приглушаются («вечер»). */
  setLightsOn(on: boolean): void;
  /** Комната встроенной мебели (стены, пол, потолок) — показать/скрыть; по умолчанию показана. */
  setRoomVisible(on: boolean): void;
  /** dev: тап в точке канваса (pt) — как пальцем; результат выбора. */
  tapAt(x: number, y: number): PickResult | HardwarePick | null;
  /** dev: состояние сцены (разобрана ли, прогресс анимации) */
  debug(): Record<string, unknown>;
}

/** Фурнитура на модели (меш с userData.kind = 'hardware'). */
export interface HardwarePick { hardware: true; name: string; type: string; distance: number }

/** Состояние подписи размера для renderDimensionLabel. */
export interface DimensionLabelState {
  /** Этот размер сейчас вводится (focusDimension). */
  focused: boolean;
  /** Вводится другой размер — подпись приглушить. */
  muted: boolean;
  /** Значение из модели, мм (габарит model.size). */
  valueMm: number;
  /** Цвет линии этого размера сейчас (вводимый — синий, иначе из dimensionColors; деталь — синий). */
  color: string;
  /** Размер детали в фокусе (partDimensions), а не изделия: ключ — length / width / thickness. */
  part: boolean;
}

/** Цвет размера «оценка» (не замерен) — для dimensionColors. */
export const DIM_ESTIMATED_COLOR = '#E08A00';

interface Props {
  model: ViewerModel;
  onPartTap?: (p: PickResult | null) => void;
  /** Тап по фурнитуре (ручка, петля…) — показать её название; без обработчика — как тап по детали за ней. */
  onHardwareTap?: (h: HardwarePick) => void;
  selectedPart?: number | null;
  /** Размеры штриховым шрифтом внутри 3D (старый режим). Для редактора — dimensionLines. */
  showDims?: boolean;
  /** затемнение на время пересборки (прежняя модель остаётся на экране) */
  busy?: boolean;
  fallbackText: string;
  /** Фон сцены (по умолчанию #eeece7); редактор V3 — фон экрана #F2F1EE. */
  background?: string;
  /** Прозрачный фон (под канвасом — свой фон экрана, например точки редактора V3). */
  transparent?: boolean;
  /** Свободная область (декларативно, как fitToFreeArea): отступы от краёв канваса, pt. */
  freeArea?: FreeAreaInsets;
  /** Отступ изделия от плашек, pt. По умолчанию 28. */
  freeAreaPadding?: number;
  /** Проекция (декларативно, как setProjection). */
  projection?: Projection;
  /** Размер, который вводится (декларативно, как focusDimension). */
  focusDimension?: DimensionKey | null;
  /** Рисовать размерные линии (1 pt, синие): ширина над изделием, высота справа, глубина по нижнему ребру боковины. */
  dimensionLines?: boolean;
  /** Какие размеры изделия показывать. По умолчанию все три; [] — ни одного (и без полей под них). */
  dimensions?: DimensionKey[];
  /**
   * Размеры выбранной детали (selectedPart) на ней самой: камера на деталь с отступом в свободной области, длина,
   * ширина и толщина синими линиями по её осям, остальные детали «рентгеном», габарит изделия скрыт.
   * Не действует, пока вводится размер (focusDimension).
   */
  partDimensions?: boolean;
  /**
   * Цвет линий по размерам ('#rrggbb'): например оценённый с фото — DIM_ESTIMATED_COLOR (янтарный), замеренный — синий
   * (по умолчанию). Вводимый сейчас (focusDimension) — всегда синий.
   */
  dimensionColors?: Partial<Record<DimensionKey, string>>;
  /**
   * Плашка размера: стоит центром в точке `anchor.label` (pt канваса) поверх линий. Положение ведётся нативно каждый
   * кадр (без рендера); сама плашка рендерится заново только при смене содержимого (значение, цвет, ввод, режим). Без неё при dimensionLines — простая плашка «820».
   */
  renderDimensionLabel?: (key: AnyDimensionKey, anchor: DimensionAnchor<AnyDimensionKey>, state: DimensionLabelState) => ReactNode;
  /**
   * Точки размеров после каждого изменения камеры (не чаще кадра). Тяжёлый setState в экране — лучше renderDimensionLabel.
   */
  onDimensionAnchors?: (a: DimensionAnchors | null) => void;
  /** Первое вращение или щипок пользователя (один раз за жизнь канваса) — спрятать подсказку «Крутите модель…». */
  onFirstGesture?: () => void;
}

const FOV = 28;
const TAP_SLOP = 8;
/**
 * Качество по устройству (пресеты viewer): бюджетный Android (≤ 4 ГБ) → low (без рёбер, Lambert, слияние мешей),
 * остальные телефоны → medium. dpr задать нельзя: R3F native всегда рендерит в PixelRatio.get() (ограничение expo-gl).
 */
export const QUALITY: QualityLevel = detectQuality({
  userAgent: Platform.OS === 'ios' ? 'iPhone' : 'Android Mobile',
  deviceMemory: Device.totalMemory ? Device.totalMemory / 1024 ** 3 : undefined,
  pixelRatio: PixelRatio.get(),
});
const LOW_END = QUALITY === 'low';
const ALL_DIMS: DimensionKey[] = ['width', 'height', 'depth'];

/** Внутри Canvas: размер канваса → штатив; шаг анимации камеры; смена активной камеры (перспектива ↔ ортогональ). */
function RigDriver({ rig, onSize, onFrame }: { rig: ViewRig; onSize: (w: number, h: number) => void; onFrame: () => void }) {
  const set = useThree((s) => s.set);
  const invalidate = useThree((s) => s.invalidate);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const current = useThree((s) => s.camera);
  useEffect(() => { onSize(width, height); invalidate(); }, [width, height, onSize, invalidate]);
  const gl = useThree((s) => s.gl);
  const wasAnimating = useRef(false);
  useFrame((_, delta) => {
    if (__DEV__) {
      perfFrame(rig.animating);
      if (rig.animating) perfCount('frame.anim');
      // dev-замер: сколько GL-поток expo-gl ещё дорисовывает очередь кадров анимации (синхронный readPixels ждёт её)
      if (wasAnimating.current && !rig.animating && perfDrainOn()) {
        const ctx = gl.getContext() as WebGL2RenderingContext;
        const t0 = performance.now();
        ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, new Uint8Array(4));
        perfMs('gl.drain', performance.now() - t0);
      }
      wasAnimating.current = rig.animating;
    }
    const moving = rig.update(Math.min(delta, 1 / 30));
    // размеры — по той же камере, что и этот кадр
    onFrame();
    if (current !== rig.camera) set({ camera: rig.camera });
    if (moving || current !== rig.camera) invalidate();
  });
  return null;
}

class GlBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { diagLog(`ERROR 3D boundary: ${String((e as Error)?.stack ?? e).slice(0, 500)}`); /* expo-gl недоступен (например, web без WebGL) */ }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// ---------- размерные линии: слой dimLayer.tsx (нативные положения, без рендера React на кадр) ----------

function DefaultPill({ text, st }: { text: string; st: DimensionLabelState }) {
  return (
    <View style={[s.pill, { borderColor: withAlpha(st.color, 0.35) }, st.focused && { backgroundColor: palette.blue, borderColor: palette.blue }, st.muted && { opacity: 0.45 }]}>
      <T num style={{ fontSize: 13, fontWeight: '700', color: st.focused ? palette.white : st.color }}>{text}</T>
    </View>
  );
}

// ---------- диагностика (EXPO_PUBLIC_DIAG=1) ----------
interface DiagInfo { gl: string; size: string; calls: number; tris: number; frames: number; getters: string }

/** Что отвечает GL-контекст expo-gl: версия, буфер, геттеры по первой программе three. */
function glSummary(raw: WebGL2RenderingContext): { gl: string; size: string } {
  const v = (p: number) => { try { return String(raw.getParameter(p)); } catch (e) { return `throw:${(e as Error).message}`; } };
  return {
    gl: `${v(raw.VERSION)} | ${v(raw.SHADING_LANGUAGE_VERSION)} | ${v(raw.VENDOR)} | ${v(raw.RENDERER)}`,
    size: `${raw.drawingBufferWidth}x${raw.drawingBufferHeight}`,
  };
}

function probePrograms(gl: import('three').WebGLRenderer): string {
  const raw = gl.getContext() as WebGL2RenderingContext;
  const progs = (gl.info.programs ?? []) as unknown as { program: WebGLProgram; name?: string; getAttributes(): Record<string, unknown>; getUniforms(): unknown }[];
  const first = progs[0];
  if (!first) return `programs=0 getError=${raw.getError()}`;
  const p = first.program;
  const log = raw.getProgramInfoLog(p);
  return [
    `programs=${progs.length}`,
    `LINK_STATUS=${String(raw.getProgramParameter(p, raw.LINK_STATUS))}`,
    `ACTIVE_ATTRIBUTES=${String(raw.getProgramParameter(p, raw.ACTIVE_ATTRIBUTES))}`,
    `ACTIVE_UNIFORMS=${String(raw.getProgramParameter(p, raw.ACTIVE_UNIFORMS))}`,
    `attrs=${Object.keys(first.getAttributes()).length}`,
    `infoLog=${typeof log}`,
    `getError=${String(raw.getError())}`,
    `MAX_TEXTURE_SIZE=${String(raw.getParameter(raw.MAX_TEXTURE_SIZE))}`,
  ].join(' ');
}

/** Внутри Canvas: после кадров читает renderer.info и пишет в журнал; первые 12 с подталкивает кадры. */
function DiagProbe({ onInfo }: { onInfo: (d: DiagInfo) => void }) {
  const gl = useThree((st) => st.gl);
  const invalidate = useThree((st) => st.invalidate);
  const frames = useRef(0);
  const base = useRef<{ gl: string; size: string }>({ gl: '', size: '' });
  const getters = useRef('');
  const lastLog = useRef(0);
  useEffect(() => {
    base.current = glSummary(gl.getContext() as WebGL2RenderingContext);
    diagLog(`gl ${base.current.gl} buffer=${base.current.size} webgl2=${gl.capabilities.isWebGL2} maxTextures=${gl.capabilities.maxTextures}`);
    const t0 = Date.now();
    const id = setInterval(() => { if (Date.now() - t0 > 12_000) clearInterval(id); else invalidate(); }, 500);
    return () => clearInterval(id);
  }, [gl, invalidate]);
  useFrame(() => {
    // useFrame идёт перед рендером: в renderer.info — счётчики предыдущего кадра
    frames.current += 1;
    const { calls, triangles } = gl.info.render;
    const n = frames.current;
    const now = Date.now();
    if (!getters.current && (calls > 0 || n >= 3)) {
      try { getters.current = probePrograms(gl); } catch (e) { getters.current = `probe failed: ${(e as Error).message}`; }
      diagLog(`getters ${getters.current}`);
    }
    if (n <= 3 || now - lastLog.current > 3000) {
      lastLog.current = now;
      diagLog(`frame=${n} calls=${calls} triangles=${triangles} geometries=${gl.info.memory.geometries} textures=${gl.info.memory.textures}`);
    }
    onInfo({ gl: base.current.gl, size: base.current.size, calls, tris: triangles, frames: n, getters: getters.current });
  });
  return null;
}

/** dev: счётчики последнего кадра (renderer.info) для devnav eval — замер draw calls на симуляторе. */
function DevFrameInfo({ out }: { out: { current: { calls: number; tris: number; frames: number } } }) {
  const gl = useThree((st) => st.gl);
  useFrame(() => { out.current = { calls: gl.info.render.calls, tris: gl.info.render.triangles, frames: out.current.frames + 1 }; });
  return null;
}

function DiagOverlay({ info, parts }: { info: DiagInfo | null; parts: number }) {
  const err = diagLastError();
  const ver = info?.gl.split(' | ')[0] ?? '—';
  return (
    <View pointerEvents="none" style={s.diag}>
      <T v="caption" style={s.diagText} numberOfLines={3}>
        {`DIAG · ${ver} · ${info?.size ?? '—'} · деталей ${parts} · calls ${info?.calls ?? 0} · tris ${info?.tris ?? 0} · кадр ${info?.frames ?? 0}`}
        {err ? `\nERR ${err}` : ''}
      </T>
    </View>
  );
}

const sizeKey = (b: Box3) => { const v = b.getSize(new Vector3()); return `${v.x.toFixed(4)}|${v.y.toFixed(4)}|${v.z.toFixed(4)}`; };

export const ProductCanvas = forwardRef<CanvasHandle, Props>(function ProductCanvas({
  model: modelProp, onPartTap, onHardwareTap, selectedPart, showDims, busy, fallbackText, background, transparent,
  freeArea, freeAreaPadding, projection, focusDimension, dimensionLines, dimensions, dimensionColors, renderDimensionLabel, onDimensionAnchors, onFirstGesture,
  partDimensions,
}, ref) {
  // dev: подмена модели для сверки декора в симуляторе — globalThis.__eskizSetModel(viewerModel | null); во все канвасы
  const [devModel, setDevModel] = useState<ViewerModel | null>(null);
  useEffect(() => {
    if (!__DEV__) return;
    const g = globalThis as { __eskizModelSetters?: Set<(m: ViewerModel | null) => void>; __eskizSetModel?: (m: ViewerModel | null) => void };
    const set = (g.__eskizModelSetters ??= new Set());
    set.add(setDevModel);
    g.__eskizSetModel = (m) => { for (const f of set) f(m); };
    return () => { set.delete(setDevModel); };
  }, []);
  // dev: размерные линии без правок экрана (сверка в симуляторе)
  const [devLines, setDevLines] = useState(false);
  const [devColors, setDevColors] = useState<Partial<Record<DimensionKey, string>> | undefined>(undefined);
  const model = devModel ?? modelProp;
  if (__DEV__) perfCount('canvas.body');
  const product = useRef<ProductHandle>(null);
  const scene = useRef<ProductScene | null>(null);
  const rig = useMemo(() => new ViewRig({ fov: FOV, padding: freeAreaPadding ?? 28 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const invalidateRef = useRef<() => void>(() => undefined);
  const [layout, setLayout] = useState({ w: 1, h: 1 });
  const options = useMemo(() => ({ quality: QUALITY, loadTexture: loadExpoTexture }), []);
  const [diag, setDiag] = useState<DiagInfo | null>(null);
  const [diagParts, setDiagParts] = useState(0);
  const diagAt = useRef(0);
  const frameInfo = useRef({ calls: 0, tris: 0, frames: 0 });
  const onDiagInfo = useCallback((d: DiagInfo) => {
    const now = Date.now();
    if (now - diagAt.current < 400) return; // плашку обновляем не чаще 2,5 раз/с
    diagAt.current = now;
    setDiag(d);
  }, []);

  const lines = !!dimensionLines || devLines;
  const drawsDims = lines || !!renderDimensionLabel;
  const dimKeys = dimensions ?? ALL_DIMS;
  // поля под размеры изделия — только если их есть что рисовать
  const dimMargins = drawsDims && dimKeys.length > 0;
  const exploded = useRef(false);
  /** Деталь в фокусе (partDimensions / focusPart): номер или ключ. */
  const partTarget = useRef<number | string | null>(null);

  // ----- размеры: положения линий и плашек — из кадра GL, нативно (без рендера React); смысл — через React -----
  const layer = useMemo(() => new DimLayer(), []);
  const anchorsCb = useRef(onDimensionAnchors);
  anchorsCb.current = onDimensionAnchors;
  const wantAnchors = useRef(false);
  wantAnchors.current = drawsDims || !!onDimensionAnchors || !!partDimensions;
  /** Камера или деталь изменились с прошлого кадра — пересчитать точки размеров. */
  const dimsDirty = useRef(true);
  const syncDims = useCallback(() => {
    if (!dimsDirty.current || !wantAnchors.current) return;
    dimsDirty.current = false;
    if (__DEV__) perfCount('dims.sync');
    // деталь в фокусе — её размеры; габарит изделия растворяется (при «взрыве» — тоже)
    const part = rig.partFocused ? rig.partAnchors() : null;
    const a = exploded.current ? null : rig.anchors();
    layer.sync(a, part, rig.focused);
    anchorsCb.current?.(part ? null : a);
  }, [rig, layer]);
  const markDims = useCallback(() => { dimsDirty.current = true; invalidateRef.current(); }, []);
  useEffect(() => {
    rig.onChange = () => { dimsDirty.current = true; invalidateRef.current(); };
    return () => { rig.onChange = null; };
  }, [rig]);

  // ----- камера: вписывание в свободную область -----
  const area = useRef<{ insets: FreeAreaInsets; padding: number }>({ insets: freeArea ?? {}, padding: freeAreaPadding ?? 28 });
  const fitted = useRef(false);
  const lastSize = useRef('');
  /** Габарит, который вписываем: собранное изделие (или разобранное при «взрыве»). */
  const content = useCallback(() => {
    const sc = scene.current;
    if (!sc) return null;
    return exploded.current ? sc.currentBounds() : sc.closedBounds;
  }, []);
  const fit = useCallback((animate: boolean) => {
    const b = content();
    if (!b || b.isEmpty() || rig.width <= 1) return;
    rig.padding = area.current.padding;
    rig.setInsets(area.current.insets);
    rig.setContent(b, dimMargins && !exploded.current ? DIMENSION_MARGINS : {});
    // деталь в фокусе — кадр по ней в её нынешнем положении («взрыв», новая модель)
    if (partTarget.current != null && rig.partFocused) {
      const box = scene.current?.partBox(partTarget.current);
      if (box) rig.setPartCorners(box.corners);
      else { partTarget.current = null; rig.focusPart(null, { animate: false }); }
    }
    if (__DEV__) perfCount('fit');
    rig.fit({ animate: animate && fitted.current });
    fitted.current = true;
    invalidateRef.current();
  }, [rig, content, dimMargins]);
  const fitRef = useRef(fit);
  fitRef.current = fit;

  const onSize = useCallback((w: number, h: number) => {
    if (__DEV__) perfCount('canvas.resize');
    const first = rig.width <= 1;
    rig.setViewport(w, h);
    if (scene.current) fitRef.current(!first);
  }, [rig]);

  const onReady = useCallback((sc: ProductScene) => {
    scene.current = sc;
    sc.onChange = () => invalidateRef.current(); // догрузился скан декора
    if (DIAG) {
      setDiagParts(sc.parts.length);
      const st = sc.stats();
      diagLog(`scene parts=${sc.parts.length} nodes=${model.nodes?.length ?? 0} quality=${QUALITY} sceneDrawCalls=${st.drawCalls} sceneTriangles=${st.triangles}`);
    }
    // после правки — перевписать плавно, только если габарит изменился (иначе ракурс и зум мастера остаются)
    const key = sizeKey(sc.closedBounds);
    if (!fitted.current || key !== lastSize.current) fitRef.current(true);
    else invalidateRef.current();
    lastSize.current = key;
    // деталь выбрали до готовности сцены (или модель пересобрана) — навести камеру
    syncPartRef.current();
  }, [model]);

  // декларативные пропсы → штатив
  const freeKey = JSON.stringify(freeArea ?? null);
  useEffect(() => {
    if (!freeArea) return;
    area.current = { insets: freeArea, padding: freeAreaPadding ?? area.current.padding };
    fitRef.current(true);
  }, [freeKey, freeAreaPadding]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (projection) rig.setProjection(projection); }, [rig, projection]);
  useEffect(() => { if (focusDimension !== undefined) rig.focusDimension(focusDimension); }, [rig, focusDimension]);
  // поля под размеры появились/пропали — перевписать
  useEffect(() => { if (fitted.current) fitRef.current(true); markDims(); }, [dimMargins, drawsDims, markDims]);

  // ----- деталь в фокусе: камера на неё, её размеры на ней -----
  const focusPartNow = useCallback((target: number | string | null, turn = true) => {
    const sc = scene.current;
    const box = target != null && sc ? sc.partBox(target) : null;
    if (!box) {
      partTarget.current = null;
      if (rig.partFocused) rig.focusPart(null, { animate: fitted.current });
    } else {
      const v = layer.state.partValues;
      if (partTarget.current !== target || v.length !== box.size[0] || v.width !== box.size[1] || v.thickness !== box.size[2]) {
        layer.setPartValues({ length: box.size[0], width: box.size[1], thickness: box.size[2] });
      }
      partTarget.current = target;
      rig.focusPart(box.corners, { animate: fitted.current, turn });
    }
    // точки детали — в этом же кадре, где камера начинает движение: линии сразу на месте и едут с ней
    markDims();
  }, [rig, layer, markDims]);
  const wantPart = partDimensions && selectedPart != null && focusDimension == null ? selectedPart : null;
  const syncPart = useCallback(() => {
    if (!partDimensions) return;
    if (wantPart !== partTarget.current || (wantPart != null && !rig.partFocused)) focusPartNow(wantPart);
  }, [partDimensions, wantPart, focusPartNow, rig]);
  const syncPartRef = useRef(syncPart);
  syncPartRef.current = syncPart;
  useEffect(() => { syncPart(); }, [syncPart]);

  // подсветка выбранной детали (SCR-25) — средствами viewer: highlight + «рентген» (работает и со слитыми мешами)
  useEffect(() => { invalidateRef.current(); }, [selectedPart, showDims]);

  // анимация дверей / «взрыва»: кадры подталкиваем сами, пока сцена движется (frameloop="demand" сам может не продолжить)
  const pumpTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pump = useCallback(() => {
    if (pumpTimer.current) clearInterval(pumpTimer.current);
    const t0 = Date.now();
    pumpTimer.current = setInterval(() => {
      invalidateRef.current();
      // деталь в фокусе едет (дверь открывается) — размеры за ней
      const pt = partTarget.current;
      const box = pt != null && rig.partFocused ? scene.current?.partBox(pt) : null;
      if (box) rig.setPartCorners(box.corners);
      if (Date.now() - t0 > 1500 || (Date.now() - t0 > 100 && scene.current && !scene.current.animating)) {
        if (pumpTimer.current) clearInterval(pumpTimer.current);
        pumpTimer.current = null;
        // доехала — довернуть вид и вписать её заново («взрыв» вписывает свой таймер)
        if (box && !exploded.current) focusPartNow(pt);
      }
    }, 16);
  }, [rig, focusPartNow]);
  useEffect(() => () => { if (pumpTimer.current) clearInterval(pumpTimer.current); }, []);

  // разобранная модель шире собранной — после анимации вписать её габарит целиком; размеры при «взрыве» прячем
  const explodeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (explodeTimer.current) clearTimeout(explodeTimer.current); }, []);
  const explode = useCallback((on: boolean) => {
    exploded.current = on;
    product.current?.explode(on);
    pump();
    markDims();
    if (explodeTimer.current) clearTimeout(explodeTimer.current);
    explodeTimer.current = setTimeout(() => fitRef.current(true), on ? 760 : 60);
  }, [pump, markDims]);

  /** Тап в точке (pt внутри канваса): фурнитура ближе детали — она; иначе деталь (дверь/ящик — открыть). */
  const pickPoint = useCallback((x: number, y: number, notify: boolean): PickResult | HardwarePick | null => {
    const sc = scene.current;
    if (!sc) return null;
    const hit = sc.pickAt(rig.camera, (x / layout.w) * 2 - 1, -(y / layout.h) * 2 + 1);
    // фурнитура (viewer: kind 'hardware', деталь — её «родитель»): ручка двери открывает дверь и показывает себя
    if (hit?.kind === 'hardware' && hit.hardware && onHardwareTap) {
      const hw: HardwarePick = { hardware: true, name: hit.hardware.name, type: String(hit.hardware.kind ?? ''), distance: hit.distance };
      if (notify) {
        if (hit.node && !exploded.current) { product.current?.toggleNode(hit.node); pump(); }
        onHardwareTap(hw);
      }
      return hw;
    }
    if (notify) {
      if (hit?.node && !exploded.current) { product.current?.toggleNode(hit.node); pump(); }
      onPartTap?.(hit);
    }
    return hit;
  }, [layout, onHardwareTap, onPartTap, pump, rig]);

  const fitToFreeArea = useCallback((insets: FreeAreaInsets, o?: FitAreaOptions) => {
    area.current = { insets, padding: o?.padding ?? area.current.padding };
    fitRef.current(o?.animate ?? true);
  }, []);

  useImperativeHandle(ref, () => ({
    openAll: () => { product.current?.openAll(); pump(); },
    closeAll: () => { product.current?.closeAll(); pump(); },
    toggleNode: (id) => { product.current?.toggleNode(id); pump(); },
    explode,
    resetView: () => fitRef.current(true),
    fitToFreeArea,
    setProjection: (p) => rig.setProjection(p),
    focusDimension: (d) => rig.focusDimension(d),
    getDimensionAnchors: () => (exploded.current ? null : rig.anchors()),
    focusPart: (p) => focusPartNow(p),
    getPartAnchors: () => rig.partAnchors(),
    setLightsOn: (on) => { product.current?.setLightsOn(on); invalidateRef.current(); },
    setRoomVisible: (on) => { product.current?.setRoomVisible(on); invalidateRef.current(); },
    tapAt: (x, y) => pickPoint(x, y, true),
    debug: () => ({ exploded: scene.current?.exploded ?? null, parts: scene.current?.parts.length ?? 0, progress: (scene.current as unknown as { explodeProgress?: number } | null)?.explodeProgress ?? null }),
  }), [explode, pickPoint, pump, rig, fitToFreeArea, focusPartNow]);

  // dev: ручки для devnav eval (globalThis.__eskizCanvas.setLightsOn(true) и т. п. — во все смонтированные канвасы)
  useEffect(() => {
    if (!__DEV__) return;
    type H = Record<string, (...a: never[]) => unknown>;
    const g = globalThis as { __eskizCanvases?: Set<H>; __eskizCanvas?: Record<string, (...a: unknown[]) => unknown>; __eskizLog?: (x: unknown) => void };
    const all = (g.__eskizCanvases ??= new Set());
    g.__eskizLog = (x) => shotLog(`eval ${JSON.stringify(x)}`);
    const h: H = {
      setLightsOn: (on: boolean) => { product.current?.setLightsOn(on); invalidateRef.current(); },
      setRoomVisible: (on: boolean) => { product.current?.setRoomVisible(on); invalidateRef.current(); },
      explode: (on: boolean) => explode(on), openAll: () => { product.current?.openAll(); pump(); }, closeAll: () => { product.current?.closeAll(); pump(); },
      resetView: () => fitRef.current(true), stats: () => scene.current?.stats(), scene: () => scene.current,
      orbit: (dTheta: number, dPhi: number, k: number) => { rig.orbit(dTheta, dPhi); if (k && k !== 1) rig.zoomTo(rig.pose.span * k); },
      fitToFreeArea: (i: FreeAreaInsets, o?: FitAreaOptions) => fitToFreeArea(i, o),
      setProjection: (p: Projection) => rig.setProjection(p),
      focusDimension: (d: DimensionKey | null) => rig.focusDimension(d),
      anchors: () => rig.anchors(),
      focusPart: (p: number | string | null) => focusPartNow(p),
      partAnchors: () => rig.partAnchors(),
      rig: () => rig,
      dimLines: (on: boolean) => setDevLines(on),
      dimColors: (c?: Partial<Record<DimensionKey, string>>) => setDevColors(c),
      frame: () => ({ ...frameInfo.current, camera: rig.camera.type, animating: rig.animating, pose: { theta: rig.pose.theta, phi: rig.pose.phi, fov: rig.pose.fov, span: rig.pose.span } }),
    };
    all.add(h);
    g.__eskizCanvas = new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => [...all].map((x) => (x[k] as ((...b: unknown[]) => unknown) | undefined)?.(...a)) });
    return () => { all.delete(h); };
  }, [explode, pump, rig, fitToFreeArea, focusPartNow]);

  // жесты
  const g = useRef({ moved: 0, t: 0, pinch: 0, startSpan: 1, lx: 0, ly: 0 });
  const gestured = useRef(false);
  const firstGesture = useRef(onFirstGesture);
  firstGesture.current = onFirstGesture;
  const tapRef = useRef<(e: GestureResponderEvent) => void>(() => undefined);
  tapRef.current = (e) => {
    const { locationX, locationY } = e.nativeEvent;
    pickPoint(locationX, locationY, true);
  };

  const responder = useMemo(() => {
    const dist = (e: GestureResponderEvent) => {
      const [a, b] = e.nativeEvent.touches;
      return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
    };
    const noteGesture = () => {
      if (gestured.current || g.current.moved < TAP_SLOP) return;
      gestured.current = true;
      firstGesture.current?.();
    };
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        g.current = { lx: e.nativeEvent.pageX, ly: e.nativeEvent.pageY, moved: 0, t: Date.now(), pinch: dist(e), startSpan: rig.pose.span };
      },
      onPanResponderMove: (e) => {
        const touches = e.nativeEvent.touches.length;
        if (touches >= 2) {
          const d = dist(e);
          if (!g.current.pinch) { g.current.pinch = d; g.current.startSpan = rig.pose.span; }
          if (d > 0) rig.zoomTo(g.current.startSpan * (g.current.pinch / d));
          g.current.moved += 100;
        } else {
          const { pageX, pageY } = e.nativeEvent;
          const dx = pageX - g.current.lx, dy = pageY - g.current.ly;
          g.current.lx = pageX; g.current.ly = pageY;
          g.current.moved += Math.abs(dx) + Math.abs(dy);
          g.current.pinch = 0;
          if (g.current.moved >= TAP_SLOP) rig.orbit(-dx * 0.008, -dy * 0.008);
        }
        noteGesture();
      },
      onPanResponderRelease: (e) => {
        if (g.current.moved < TAP_SLOP && Date.now() - g.current.t < 400) tapRef.current(e);
      },
    });
  }, [rig]);

  const onLayout = (e: LayoutChangeEvent) => setLayout({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  const fallback = <View style={s.fallback}><T v="muted">{fallbackText}</T></View>;
  const sizeMm = model.size ?? [0, 0, 0];
  const values = useMemo(() => ({ width: sizeMm[0] ?? 0, height: sizeMm[1] ?? 0, depth: sizeMm[2] ?? 0 }), [sizeMm]);

  return (
    <View style={[s.wrap, background ? { backgroundColor: background } : null, transparent ? { backgroundColor: 'transparent' } : null]} onLayout={onLayout}>
      <GlBoundary fallback={fallback}>
        <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
          <Canvas
            frameloop="demand"
            camera={rig.perspective}
            gl={{ antialias: !LOW_END, ...(transparent ? { alpha: true, premultipliedAlpha: false } : null) }}
            // expo-gl не отдаёт журнал компиляции шейдеров (getProgramInfoLog → undefined), а three.js
            // при включённой проверке делает .trim() по нему и падает каждый кадр — проверку выключаем
            onCreated={(st) => {
              st.gl.debug.checkShaderErrors = false;
              invalidateRef.current = () => st.invalidate();
              if (__DEV__) {
                // dev: ошибка отрисовки (кадр не дошёл до endFrameEXP — картинка «замерзает») — в журнал снимков
                const render = st.gl.render.bind(st.gl);
                let logged = 0;
                st.gl.render = (sc, cam) => {
                  const t0 = perfOn() ? performance.now() : 0;
                  try { render(sc, cam); if (t0) { perfMs('gl.render', performance.now() - t0); perfCount('gl.render'); } } catch (e) { if (logged++ < 3) shotLog(`render error: ${String((e as Error)?.stack ?? e).slice(0, 700)}`); throw e; }
                };
              }
              if (transparent) st.gl.setClearColor(0x000000, 0);
              if (DIAG) diagLog(`created size=${st.size.width}x${st.size.height} dpr=${st.viewport.dpr} three=${st.gl.info ? 'ok' : '?'}`);
            }}
            style={{ flex: 1 }}
          >
            {transparent ? null : <color attach="background" args={[background ?? '#eeece7']} />}
            {/* свет: сверху-справа + мягкая заливка спереди — белая ХДФ в нише белая, а не серая */}
            <hemisphereLight args={['#ffffff', '#b9b4aa', 1.5]} />
            <directionalLight position={[2, 4, 3]} intensity={1.5} />
            <directionalLight position={[-3, 2, -2]} intensity={0.4} />
            <directionalLight position={[0.3, 0.6, 3]} intensity={0.6} />
            <ProductObject ref={product} model={model} options={options} toggleOnTap={false} onReady={onReady} dimensions={!!showDims} highlight={selectedPart ?? null} ghost={selectedPart != null} />
            <RigDriver rig={rig} onSize={onSize} onFrame={syncDims} />
            {__DEV__ ? <DevFrameInfo out={frameInfo} /> : null}
            {DIAG ? <DiagProbe onInfo={onDiagInfo} /> : null}
          </Canvas>
        </View>
      </GlBoundary>
      {drawsDims || partDimensions ? (
        <Profiler id="overlay" onRender={perfProfiler}>
          <DimensionLayer layer={layer} lines={lines} keys={dimKeys} values={values} colors={dimensionColors ?? devColors} renderLabel={renderDimensionLabel}
            pill={(text, st) => <DefaultPill text={text} st={st} />} blue={palette.blue} />
        </Profiler>
      ) : null}
      {busy ? <View pointerEvents="none" style={s.busy} /> : null}
      {DIAG ? <DiagOverlay info={diag} parts={diagParts} /> : null}
    </View>
  );
});


const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#eeece7', overflow: 'hidden' },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  diag: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 8, paddingVertical: 4 },
  diagText: { color: '#fff', fontSize: 11, lineHeight: 14 },
  busy: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(245,244,241,0.45)', borderWidth: 0, borderColor: colors.primary },
  pill: { minWidth: 52, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: 'rgba(31,79,191,0.35)', alignItems: 'center', justifyContent: 'center' },
});
