/** Схема раскладки деталей на листе (превью для SCR-11 / SCR-36). */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SHEET, type Sheet } from '../lib/cutting';
import { colors, fonts, palette } from './theme';
import { T } from './kit';

export function SheetLayout({ sheet }: { sheet: Sheet }) {
  const [w, setW] = useState(0);
  const L = sheet.length ?? SHEET.length;
  const W = sheet.width ?? SHEET.width;
  const k = w / L;
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ width: '100%', height: w ? W * k : 160, backgroundColor: '#f3ede2', borderWidth: 1, borderColor: colors.border }}>
      {w > 0 && sheet.parts.map((p, i) => (
        <View key={`${p.number}-${i}`} style={{ position: 'absolute', left: p.x * k, top: p.y * k, width: p.l * k, height: p.w * k, backgroundColor: '#fff', borderWidth: 1, borderColor: '#9a7b55', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {p.l * k > 18 && p.w * k > 12 ? <T v="caption" style={{ fontSize: 10, color: '#5a3d1e' }}>{p.number}</T> : null}
        </View>
      ))}
    </View>
  );
}

/**
 * Карта раскроя V3 (Cutting.dc.html, .brd): тёмная подложка, детали «деревом» с подписью и размером,
 * свободное место — штриховка «отход». Масштаб по осям раздельный: высота фиксирована (в макете 244).
 */
export function CutBoard({ sheet, height = 244, accessibilityLabel }: { sheet: Sheet; height?: number; accessibilityLabel?: string }) {
  const [w, setW] = useState(0);
  const L = sheet.length ?? SHEET.length;
  const W = sheet.width ?? SHEET.width;
  const pad = 3;
  const iw = w - 2 * pad, ih = height - 2 * pad;
  const kx = iw / L, ky = ih / W;
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} accessibilityRole="image" accessibilityLabel={accessibilityLabel}
      style={{ height, backgroundColor: palette.ink, borderRadius: 4, padding: pad, overflow: 'hidden' }}>
      {w > 0 ? (
        <View style={{ flex: 1, overflow: 'hidden' }}>
          <Hatch width={iw} height={ih} />
          {sheet.parts.map((p, i) => {
            // соседние детали делят тёмную линию 3 px: у каждой рамка 1.5 px
            const left = Math.max(0, p.x * kx - 1.5), top = Math.max(0, p.y * ky - 1.5);
            const right = Math.min(iw, (p.x + p.l) * kx + 1.5), bottom = Math.min(ih, (p.y + p.w) * ky + 1.5);
            const bw = right - left, bh = bottom - top;
            const label = bw > 44 && bh > 18;
            const dims = bw > 72 && bh > 36;
            return (
              <View key={`${p.number}-${i}`} style={{ position: 'absolute', left, top, width: bw, height: bh, borderWidth: 1.5, borderColor: palette.ink, overflow: 'hidden' }}>
                <Wood width={bw} />
                {label ? (
                  <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 }]}>
                    <Text style={[st.pc, { fontFamily: fonts.semibold }]} numberOfLines={1}>{p.name}</Text>
                    {dims ? <Text style={[st.pc, { fontFamily: fonts.medium }]} numberOfLines={1}>{`${Math.round(p.l)}×${Math.round(p.w)}`}</Text> : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** Полосы «дерева»: 7 px светлая + 2 px тёмная (repeating-linear-gradient 90deg #E6D3B1 0 7px, #DCC59F 7px 9px). */
function Wood({ width }: { width: number }) {
  const n = Math.ceil(width / 9) + 1;
  return (
    <View style={[StyleSheet.absoluteFill, { flexDirection: 'row', backgroundColor: '#E6D3B1' }]}>
      {Array.from({ length: n }, (_, i) => <View key={i} style={{ width: 9, paddingLeft: 7 }}><View style={{ flex: 1, backgroundColor: '#DCC59F' }} /></View>)}
    </View>
  );
}

/** Штриховка отхода: 45° полосы #CFC8B9 5 px / #F4EBDD 5 px. */
function Hatch({ width, height }: { width: number; height: number }) {
  const d = Math.ceil(Math.hypot(width, height)) + 20;
  const n = Math.ceil(d / 10.0) + 1;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: '#F4EBDD', overflow: 'hidden' }]}>
      <View style={{ position: 'absolute', width: d, height: d, left: (width - d) / 2, top: (height - d) / 2, flexDirection: 'row', transform: [{ rotate: '45deg' }] }}>
        {Array.from({ length: n }, (_, i) => <View key={i} style={{ width: 5, height: d, marginRight: 5, backgroundColor: '#CFC8B9' }} />)}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  pc: { fontSize: 13, lineHeight: 16, color: '#3F3522', textAlign: 'center', fontVariant: ['tabular-nums'] },
});
