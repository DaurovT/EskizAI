/**
 * Чертёж детали для просмотра файлов (FileViewer.dc.html, .dwg): контур (с дугами), размеры синим, присадка на пласти
 * кружками, легенда справа (отверстия по диаметрам, текстура, размер распила), кнопки масштаба.
 * Без SVG: линии контура — тонкие повёрнутые View.
 */
import type { ViewerPart } from '@mebel/viewer';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useT } from '../i18n';
import { Press } from './base';
import { fonts, palette } from './theme';

const BLUE = '#1F4FBF';
const LEFT = 52; // от края карточки (в макете 64 от .dwg при отступе экрана 12)
const TOP = 74;
const LEGEND_W = 128;

type Pt = [number, number];

/** Точки контура в локальных мм (x — длина, y — ширина); дуги — по 16 точек. */
function contourPoints(p: ViewerPart): { pts: Pt[]; arc: { r: number; mid: Pt } | null } {
  if (!p.contour) return { pts: [[0, 0], [p.length, 0], [p.length, p.width], [0, p.width], [0, 0]], arc: null };
  const pts: Pt[] = [p.contour.start];
  let arc: { r: number; mid: Pt } | null = null;
  let cur = p.contour.start;
  for (const s of p.contour.segments) {
    if (s.kind === 'line') { pts.push([s.x, s.y]); cur = [s.x, s.y]; continue; }
    const r = Math.hypot(cur[0] - s.cx, cur[1] - s.cy);
    let a0 = Math.atan2(cur[1] - s.cy, cur[0] - s.cx);
    let a1 = Math.atan2(s.y - s.cy, s.x - s.cx);
    if (s.clockwise && a1 > a0) a1 -= 2 * Math.PI;
    if (!s.clockwise && a1 < a0) a1 += 2 * Math.PI;
    for (let i = 1; i <= 16; i++) {
      const a = a0 + ((a1 - a0) * i) / 16;
      pts.push([s.cx + r * Math.cos(a), s.cy + r * Math.sin(a)]);
    }
    if (!arc) { const am = (a0 + a1) / 2; arc = { r: Math.round(r), mid: [s.cx + r * Math.cos(am), s.cy + r * Math.sin(am)] }; }
    cur = [s.x, s.y];
  }
  return { pts, arc };
}

export function PartDrawing({ part, title, zoom, onZoom }: {
  part: ViewerPart; title: string; zoom: number; onZoom: (z: number) => void;
}) {
  const { t } = useT();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const { pts, arc } = useMemo(() => contourPoints(part), [part]);

  // деталь стоит длиной вертикально: экранный x = y·k, экранный y = (L − x)·k
  const availW = box.w - LEFT - 16 - LEGEND_W - 14;
  const availH = box.h - TOP - 12 - 40 - 44;
  const k = box.w ? Math.max(0.01, Math.min(availW / part.width, availH / part.length)) * zoom : 0;
  const pw = part.width * k, ph = part.length * k;
  const sx = (x: number, y: number): Pt => [LEFT + y * k, TOP + (part.length - x) * k];

  // отверстия: на пласти — кружки на чертеже, в торец — только в легенде
  const face = part.holes.filter((h) => /^[ab]$/i.test(h.face));
  const groups = new Map<string, { d: number; edge: boolean; n: number }>();
  for (const h of part.holes) {
    const edge = !/^[ab]$/i.test(h.face);
    const d = Math.round(h.diameter);
    const key = `${edge}-${d}`;
    const g = groups.get(key);
    if (g) g.n += 1; else groups.set(key, { d, edge, n: 1 });
  }
  const holeName = (d: number, edge: boolean) => (edge ? t('fv_h_edge')
    : d >= 30 ? t('fv_h_hinge') : d >= 12 ? t('fv_h_cam') : d === 8 ? t('fv_h_dowel') : d === 7 ? t('fv_h_confirmat') : d <= 5 ? t('fv_h_shelf') : t('fv_h_hole'));

  return (
    <View style={st.dwg} onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      accessibilityRole="image" accessibilityLabel={t('fv_drawing')}>
      <Text style={st.cap} numberOfLines={1}>{title}</Text>
      {k > 0 ? (
        <>
          {/* контур */}
          {pts.slice(1).map((b, i) => {
            const [x1, y1] = sx(pts[i][0], pts[i][1]);
            const [x2, y2] = sx(b[0], b[1]);
            const len = Math.hypot(x2 - x1, y2 - y1);
            if (len < 0.1) return null;
            return <View key={i} style={{ position: 'absolute', left: (x1 + x2) / 2 - len / 2 - 1, top: (y1 + y2) / 2 - 1, width: len + 2, height: 2,
              backgroundColor: palette.ink, transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }] }} />;
          })}
          {/* отверстия на пласти */}
          {face.map((h, i) => {
            const [x, y] = sx(h.x, h.y);
            const s = h.diameter >= 7 ? 14 : 10;
            return <View key={`h${i}`} style={{ position: 'absolute', left: x - s / 2, top: y - s / 2, width: s, height: s, borderRadius: s / 2, borderWidth: 2, borderColor: BLUE }} />;
          })}
          {/* размеры */}
          <View style={{ position: 'absolute', left: LEFT - 20, top: TOP, height: ph, width: 1.5, backgroundColor: BLUE }} />
          <View style={{ position: 'absolute', left: LEFT - 20 - 40, top: TOP + ph / 2 - 9, width: 80, height: 18, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-90deg' }] }}>
            <Text style={st.dl}>{Math.round(part.length)}</Text>
          </View>
          <View style={{ position: 'absolute', left: LEFT, top: TOP + ph + 16, width: pw, height: 1.5, backgroundColor: BLUE }} />
          <View style={{ position: 'absolute', left: LEFT, top: TOP + ph + 16 - 9, width: pw, height: 18, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={st.dl}>{Math.round(part.width)}</Text>
          </View>
          {arc ? (() => { const [x, y] = sx(arc.mid[0], arc.mid[1]); return <Text style={[st.dl, { position: 'absolute', left: x + 6, top: y - 30 }]}>{`R${arc.r}`}</Text>; })() : null}
        </>
      ) : null}
      {/* легенда */}
      <View style={st.leg}>
        {[...groups.values()].sort((a, b) => Number(a.edge) - Number(b.edge) || a.d - b.d).map((g) => (
          <Text key={`${g.edge}-${g.d}`} style={st.legT}><Text style={st.legB}>{`○${g.d}`}</Text>{` ${holeName(g.d, g.edge)} ×${g.n}`}</Text>
        ))}
        {part.grain !== 'none' ? <Text style={st.legT}>{`${t('fv_grain')} ${part.grain === 'length' ? '↕' : '↔'}`}</Text> : null}
        <Text style={st.legT}>{`${t('fv_cut_size')} `}<Text style={{ fontVariant: ['tabular-nums'] }}>{`${Math.round(part.length)}×${Math.round(part.width)}`}</Text></Text>
      </View>
      {/* масштаб */}
      <View style={st.zm}>
        <Press onPress={() => onZoom(Math.max(0.5, zoom / 1.25))} accessibilityRole="button" accessibilityLabel={t('fv_zoom_out')} style={st.pm}><Text style={st.pmT}>−</Text></Press>
        <Press onPress={() => onZoom(Math.min(4, zoom * 1.25))} accessibilityRole="button" accessibilityLabel={t('fv_zoom_in')} style={st.pm}><Text style={st.pmT}>+</Text></Press>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  dwg: { flex: 1, minHeight: 360, backgroundColor: palette.white, borderRadius: 28, overflow: 'hidden' },
  cap: { position: 'absolute', left: 20, top: 16, right: 16, fontFamily: fonts.regular, fontSize: 14, lineHeight: 19, color: palette.muted },
  dl: { fontFamily: fonts.bold, fontSize: 13, lineHeight: 18, color: BLUE, backgroundColor: palette.white, paddingHorizontal: 3, fontVariant: ['tabular-nums'] },
  leg: { position: 'absolute', right: 14, top: 74, width: LEGEND_W, gap: 8 },
  legT: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 17, color: palette.muted2 },
  legB: { fontFamily: fonts.bold, color: BLUE, fontVariant: ['tabular-nums'] },
  zm: { position: 'absolute', right: 12, bottom: 12, flexDirection: 'row', gap: 6 },
  pm: { width: 40, height: 40, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  pmT: { fontFamily: fonts.medium, fontSize: 20, lineHeight: 24, color: palette.ink },
});
