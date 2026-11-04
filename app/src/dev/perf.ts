/**
 * dev: замер плавности автоматических движений камеры (только __DEV__).
 * globalThis.__eskizPerf.start('label') → … → stop() — сводка в Documents/shots/log.txt:
 * кадры (сред/p95/макс мс), «зависания» JS-потока, рендеры React по Profiler-id, счётчики (перезапуски анимаций, ресайзы канваса).
 */
import type { ProfilerOnRenderCallback } from 'react';
import { shotLog } from './shot';

interface Run {
  label: string;
  t0: number;
  last: number;
  frames: number[];
  /** Начало кадра от старта замера, мс. */
  at: number[];
  counts: Record<string, number>;
  ms: Record<string, number>;
  lagMax: number;
  lagSum: number;
  timer: ReturnType<typeof setInterval> | null;
}

let run: Run | null = null;
/** Мерить очередь GL-потока в конце анимации (синхронный readPixels сам держит JS-поток — по умолчанию выкл.). */
let drain = false;
export const perfDrainOn = (): boolean => run !== null && drain;
const LAG_TICK = 10;

export const perfOn = (): boolean => __DEV__ && run !== null;

export function perfCount(name: string, n = 1): void {
  if (!run) return;
  run.counts[name] = (run.counts[name] ?? 0) + n;
}

export function perfMs(name: string, ms: number): void {
  if (!run) return;
  run.ms[name] = (run.ms[name] ?? 0) + ms;
}

/** Кадр GL (из useFrame): интервал от прошлого кадра, если тот был кадром анимации (простой demand-цикла не в счёт). */
export function perfFrame(animating: boolean): void {
  if (!run) return;
  const now = performance.now();
  if (run.last) { run.frames.push(now - run.last); run.at.push(now - run.t0); }
  run.last = animating ? now : 0;
}

/** Profiler: число рендеров и время React по id. */
export const perfProfiler: ProfilerOnRenderCallback = (id, _phase, actual) => {
  if (!run) return;
  perfCount(`render.${id}`);
  perfMs(`react.${id}`, actual);
};

export function perfStart(label: string): void {
  if (!__DEV__) return;
  perfStop(true);
  const r: Run = { label, t0: performance.now(), last: 0, frames: [], at: [], counts: {}, ms: {}, lagMax: 0, lagSum: 0, timer: null };
  // «зависание» JS-потока: насколько опоздал таймер на 10 мс
  let prev = performance.now();
  r.timer = setInterval(() => {
    const now = performance.now();
    const late = now - prev - LAG_TICK;
    prev = now;
    if (late > r.lagMax) r.lagMax = late;
    if (late > 30) r.lagSum += late;
  }, LAG_TICK);
  run = r;
}

const q = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]! : 0);

export function perfStop(silent = false): string {
  const r = run;
  if (!r) return '';
  run = null;
  if (r.timer) clearInterval(r.timer);
  const f = r.frames;
  const avg = f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0;
  const med = q(f, 0.5);
  // пропуск — кадр дольше 1,5 медианы (на симуляторе GL медленный, считаем относительно)
  const dropped = f.filter((x) => x > med * 1.5).length;
  const n = (x: number) => Math.round(x * 10) / 10;
  const counts = Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ');
  const ms = Object.entries(r.ms).map(([k, v]) => `${k}=${n(v)}ms`).join(' ');
  const slowList = f.map((x, i) => (x > med * 1.5 ? `@${Math.round(r.at[i]!)}:${Math.round(x)}` : '')).filter(Boolean).join(',');
  const line = `PERF ${r.label}: ${n(performance.now() - r.t0)}ms frames=${f.length} avg=${n(avg)} p50=${n(med)} p95=${n(q(f, 0.95))} max=${n(q(f, 1))} slow=${dropped}[${slowList}] `
    + `jsLagMax=${n(r.lagMax)} jsLagSum=${n(r.lagSum)} | ${counts} | ${ms}`;
  if (!silent) shotLog(line);
  return line;
}

if (__DEV__) (globalThis as Record<string, unknown>).__eskizPerf = { start: perfStart, stop: perfStop, count: perfCount, drain: (on: boolean) => { drain = on; } };
