/**
 * Миниатюра проекта .pi (Projects.dc.html): плитка 86 r18 «миллиметровка» (#FCFBF8, клетка 12 линиями #EEF0F3, рамка
 * #ECEAE5) и изометрический эскиз изделия 78 × 78 по центру (lib/sketch.ts).
 * Без SVG: грани — View-параллелограммы (rotate · skewX · scale), линии — тонкие повёрнутые View, как в PartDrawing.
 */
import { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ProductSketch } from '../api/types';
import { SKETCH_COLORS, defaultSketch, sketchGeometry, type Pt, type SketchLine } from '../lib/sketch';

const BASE = 10; // сторона исходного квадрата грани до преобразования
const WIDTH: Record<SketchLine['kind'], number> = { edge: 0.8, line: 0.7, handle: 1.3, faint: 0.6 };

/** Эскиз изделия в квадрате size × size (вписан с сохранением пропорций). */
export const SketchDrawing = memo(function SketchDrawing({ sketch, size, style }: { sketch: ProductSketch; size: number; style?: StyleProp<ViewStyle> }) {
  const els = useMemo(() => {
    const g = sketchGeometry(sketch);
    const pad = 1.5;
    const k = Math.min((size - pad * 2) / g.box.w, (size - pad * 2) / g.box.h);
    const ox = (size - g.box.w * k) / 2 - g.box.x * k;
    const oy = (size - g.box.h * k) / 2 - g.box.y * k;
    const P = ([x, y]: Pt): Pt => [x * k + ox, y * k + oy];
    const out: ReactNode[] = [];
    const seg = (key: string, a: Pt, b: Pt, w: number, opacity = 1) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.2) return;
      out.push(
        <View key={key} style={{
          position: 'absolute', left: (a[0] + b[0]) / 2 - (len + w) / 2, top: (a[1] + b[1]) / 2 - w / 2,
          width: len + w, height: w, borderRadius: w / 2, backgroundColor: SKETCH_COLORS.ink, opacity,
          transform: [{ rotate: `${Math.atan2(b[1] - a[1], b[0] - a[0])}rad` }],
        }} />,
      );
    };
    // по порядку: дальние коробки раньше, у коробки грани под её линиями
    g.shapes.forEach((sh, i) => {
      if (sh.type === 'face') {
        const o = P(sh.o);
        const u: Pt = [sh.u[0] * k, sh.u[1] * k];
        const v: Pt = [sh.v[0] * k, sh.v[1] * k];
        const th = Math.atan2(u[1], u[0]);
        const lu = Math.hypot(u[0], u[1]);
        // v в осях, повёрнутых на th: a — сдвиг (skewX), b — высота (scaleY)
        const a = v[0] * Math.cos(th) + v[1] * Math.sin(th);
        const b = -v[0] * Math.sin(th) + v[1] * Math.cos(th);
        if (lu < 0.05 || Math.abs(b) < 0.05) return;
        const cx = o[0] + (u[0] + v[0]) / 2;
        const cy = o[1] + (u[1] + v[1]) / 2;
        out.push(
          <View key={i} style={{
            position: 'absolute', left: cx - BASE / 2, top: cy - BASE / 2, width: BASE, height: BASE, backgroundColor: sh.fill,
            transform: [{ rotate: `${th}rad` }, { skewX: `${Math.atan(a / b)}rad` }, { scaleX: lu / BASE }, { scaleY: b / BASE }],
          }} />,
        );
        return;
      }
      const a = P(sh.a), b = P(sh.b);
      const w = WIDTH[sh.kind];
      seg(`${i}`, a, b, w, sh.kind === 'faint' ? 0.5 : 1);
      // «карандаш» макета: второй тонкий штрих рядом с основным, чуть сдвинут
      if (sh.kind === 'edge' || sh.kind === 'line') {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const sh2 = i % 2 ? 0.4 : -0.4;
        const nx = (-(b[1] - a[1]) / len) * sh2, ny = ((b[0] - a[0]) / len) * sh2;
        const j = ((i * 7) % 5) / 10 - 0.2;
        seg(`${i}p`, [a[0] + nx + j, a[1] + ny], [b[0] + nx - j, b[1] + ny], w * 0.6, 0.35);
      }
    });
    return out;
  }, [sketch, size]);
  return <View style={[{ width: size, height: size }, style]} pointerEvents="none">{els}</View>;
});

const GRID = [12, 24, 36, 48, 60, 72, 84];

/**
 * .pi — плитка 86 × 86 r18 с эскизом 78. Нет описания с сервера (черновик без модели, старый сервер) — заглушка
 * по типу изделия, бледнее.
 */
export function SketchThumb({ sketch, kind, size = 86 }: { sketch?: ProductSketch | null; kind?: string | null; size?: number }) {
  const sk = sketch ?? defaultSketch(kind);
  const scale = size / 86;
  return (
    <View style={[s.pi, { width: size, height: size, borderRadius: 18 * scale }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {GRID.map((g) => <View key={`h${g}`} style={[s.gh, { top: g * scale }]} />)}
      {GRID.map((g) => <View key={`v${g}`} style={[s.gv, { left: g * scale }]} />)}
      <SketchDrawing sketch={sk} size={78 * scale} style={!sketch && { opacity: 0.4 }} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 18 * scale, borderWidth: 1, borderColor: '#ECEAE5' }]} />
    </View>
  );
}

const s = StyleSheet.create({
  pi: { backgroundColor: SKETCH_COLORS.paper, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  gh: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#EEF0F3' },
  gv: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: '#EEF0F3' },
});
