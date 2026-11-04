/** Горизонтальный градиент без нативных модулей: полосы с промежуточными цветами (для коротких плашек цвета). */
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Press, T, Toggle } from './kit';
import { palette } from './theme';

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a: number[], b: number[], t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

export function HGradient({ stops, style, steps = 16 }: { stops: string[]; style?: StyleProp<ViewStyle>; steps?: number }) {
  const cs = stops.map(rgb);
  return (
    <View style={[{ flexDirection: 'row', overflow: 'hidden' }, style]}>
      {Array.from({ length: steps }, (_, i) => {
        const t = (i / (steps - 1)) * (cs.length - 1);
        const j = Math.min(cs.length - 2, Math.floor(t));
        return <View key={i} style={{ flex: 1, backgroundColor: mix(cs[j], cs[j + 1], t - j) }} />;
      })}
    </View>
  );
}

/** Переключатель .tg 46×28 (уменьшенный .tog). */
export function SmallToggle(p: { value: boolean; onValueChange?: (v: boolean) => void; disabled?: boolean; accessibilityLabel?: string }) {
  return (
    <View style={{ width: 46, height: 28, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ transform: [{ scale: 0.9 }] }}><Toggle {...p} /></View>
    </View>
  );
}

/**
 * .seg как в CSS (flex:1, но не уже текста): сегмент с длинной подписью шире — «Движение» не обрезается.
 * Ширина текста — оценкой по числу символов (15 px Onest ≈ 8,6 pt на букву).
 */
export function FitSegmented<V extends string>({ value, options, onChange, style }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', backgroundColor: palette.off, borderRadius: 14, padding: 3, gap: 2 }, style]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Press key={o.value} feedback="opacity" onPress={() => !on && onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={[{ flexGrow: 1, flexBasis: 0, minWidth: o.label.length * 8.6 + 16, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
              on && { backgroundColor: palette.white, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 }]}>
            <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '500' }} numberOfLines={1}>{o.label}</T>
          </Press>
        );
      })}
    </View>
  );
}
