/**
 * Превью фасада по SVG-путям API (viewBox 0 0 400 700) без react-native-svg: каждый отрезок ломаной —
 * повёрнутый View со скруглёнными концами. Фрезеровка — тёмная канавка со светлым краем, молдинг — широкая
 * светлая полоса с тенью, вставка — полоса цвета металла.
 */
import { memo, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { parseSvgPath } from '../lib/decorStyle';

export const METAL: Record<string, string> = { brass: '#C9A45C', gold: '#D4AF37', black: '#2A2A2A', chrome: '#D3D7DB', steel: '#B8BCC0' };

export interface DecorLayer { kind: 'milling' | 'overlay' | 'inlay' | 'line'; paths: string[]; finish?: string; color?: string; width?: number }

/** Светлый ли цвет (для контраста канавки). */
const light = (hex: string) => {
  const h = hex.replace('#', '');
  if (h.length < 6) return true;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
};

function Strokes({ paths, scale, sy, width, color, dy = 0, dx = 0 }: { paths: string[]; scale: number; sy?: number; width: number; color: string; dx?: number; dy?: number }) {
  const segs = useMemo(() => {
    const out: { l: number; t: number; w: number; a: number }[] = [];
    for (const d of paths) {
      for (const pl of parseSvgPath(d, 18)) {
        for (let i = 1; i < pl.pts.length; i++) {
          const [x1, y1] = pl.pts[i - 1], [x2, y2] = pl.pts[i];
          const ky = sy ?? scale;
          const len = Math.hypot((x2 - x1) * scale, (y2 - y1) * ky);
          if (len < 0.2) continue;
          const w = len + width; // перекрытие концов — без щелей на изгибах
          out.push({ l: ((x1 + x2) / 2) * scale - w / 2 + dx, t: ((y1 + y2) / 2) * ky - width / 2 + dy, w, a: Math.atan2((y2 - y1) * ky, (x2 - x1) * scale) });
        }
      }
    }
    return out;
  }, [paths, scale, sy, width, dx, dy]);
  return (
    <>
      {segs.map((s, i) => (
        <View key={i} pointerEvents="none" style={{ position: 'absolute', left: s.l, top: s.t, width: s.w, height: width, borderRadius: width / 2, backgroundColor: color, transform: [{ rotate: `${s.a}rad` }] }} />
      ))}
    </>
  );
}

/** Дверь шириной `width` (высота — по пропорции 400×700 или `height`), слои декора поверх цвета фасада. */
export const DoorPreview = memo(function DoorPreview({ width, height, color = '#E9E5DA', layers = [], radius = 0, style, selected, stretch }: {
  width: number; height?: number; color?: string; layers?: DecorLayer[]; radius?: number; style?: StyleProp<ViewStyle>; selected?: boolean;
  /** Растянуть рисунок на всю плитку (как preserveAspectRatio="none" у превью макета). */
  stretch?: boolean;
}) {
  const h = height ?? width * 1.75;
  const k = Math.min(width / 400, h / 700);
  const ox = (width - 400 * k) / 2, oy = (h - 700 * k) / 2;
  const lt = light(color);
  return (
    <View style={[{ width, height: h, borderRadius: Math.max(3, radius * k * 4), backgroundColor: color, overflow: 'hidden' }, st.edge, selected && st.sel, style]}>
      {layers.map((ly, i) => {
        if (!ly.paths.length) return null;
        if (ly.kind === 'line') {
          // линия цвета ly.color: превью-плитки (растянуты по плитке)
          const kx = stretch ? width / 400 : k, ky = stretch ? h / 700 : k;
          return (
            <View key={i} style={StyleSheet.absoluteFill} pointerEvents="none">
              <Strokes paths={ly.paths} scale={kx} sy={ky} width={ly.width ?? 2} color={ly.color ?? '#A88A5E'} dx={stretch ? 0 : ox} dy={stretch ? 0 : oy} />
            </View>
          );
        }
        if (ly.kind === 'milling') {
          const w = Math.max(1.4, 8 * k);
          return (
            <View key={i} style={StyleSheet.absoluteFill} pointerEvents="none">
              <Strokes paths={ly.paths} scale={k} width={w} color={lt ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.18)'} dx={ox + 0.6} dy={oy + 0.8} />
              <Strokes paths={ly.paths} scale={k} width={w} color={lt ? 'rgba(60,48,32,0.28)' : 'rgba(0,0,0,0.4)'} dx={ox} dy={oy} />
            </View>
          );
        }
        if (ly.kind === 'overlay') {
          const w = Math.max(2.4, 20 * k);
          return (
            <View key={i} style={StyleSheet.absoluteFill} pointerEvents="none">
              <Strokes paths={ly.paths} scale={k} width={w} color="rgba(0,0,0,0.16)" dx={ox + 0.8} dy={oy + 1.2} />
              <Strokes paths={ly.paths} scale={k} width={w} color={lt ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.22)'} dx={ox} dy={oy} />
            </View>
          );
        }
        return (
          <View key={i} style={StyleSheet.absoluteFill} pointerEvents="none">
            <Strokes paths={ly.paths} scale={k} width={Math.max(1.6, 6 * k)} color={METAL[ly.finish ?? 'brass'] ?? METAL.brass} dx={ox} dy={oy} />
          </View>
        );
      })}
    </View>
  );
});

const st = StyleSheet.create({
  edge: { borderWidth: 1, borderColor: 'rgba(33,32,31,0.10)' },
  sel: { borderColor: 'rgba(33,32,31,0.25)' },
});
