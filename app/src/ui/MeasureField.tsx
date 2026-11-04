/**
 * Поле замера .mf (Measure.dc.html / MeasureKitchen.dc.html): белая плитка r20, подпись 14 серым, число 26 (кухня — 24) жирным
 * с «мм» рядом; справа в подписи — метка (+180, −5, «было 2700»). Состояния: est (янтарная рамка — расходится с моделью),
 * err (красная — не сходится), фокус — чёрная рамка. Ввод — цифровая клавиатура, границы min/max — при уходе с поля.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputInstance, type ViewStyle } from 'react-native';
import { T, resolveFont } from './base';
import { Badge } from './kit';
import { palette, type Tone } from './theme';

export function MeasureField({ label, value, onChange, unit, badge, state, size = 'l', min = 0, max = 100000, nullable, style, accessibilityLabel }: {
  label: string; value: number | null; onChange: (v: number | null) => void; unit?: string;
  badge?: { label: string; tone: Tone } | null;
  state?: 'est' | 'err' | null;
  /** l — 26/32 (замер), m — 24/30 (замер кухни, плотнее). */
  size?: 'l' | 'm';
  min?: number; max?: number; nullable?: boolean; style?: StyleProp<ViewStyle>; accessibilityLabel?: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const [focus, setFocus] = useState(false);
  const ref = useRef<TextInputInstance>(null);
  useEffect(() => { if (!focus) setText(value == null ? '' : String(value)); }, [value, focus]);

  const commit = () => {
    setFocus(false);
    const n = parseInt(text.replace(/\D/g, ''), 10);
    if (Number.isNaN(n)) { if (nullable) onChange(null); else setText(value == null ? '' : String(value)); return; }
    const v = Math.max(min, Math.min(max, n));
    setText(String(v));
    onChange(v);
  };
  const box = state === 'err' ? st.err : state === 'est' ? st.est : null;
  const m = size === 'm';
  return (
    <Pressable onPress={() => ref.current?.focus()} accessibilityLabel={accessibilityLabel ?? label}
      style={[st.mf, m ? st.mfM : null, box, focus && st.focus, style]}>
      <View style={st.ml}>
        <T style={st.mlT} numberOfLines={1}>{label}</T>
        {badge ? <Badge label={badge.label} tone={badge.tone} style={st.badge} /> : null}
      </View>
      <View style={[st.mvRow, { marginTop: m ? 1 : 2 }]}>
        <TextInput
          ref={ref}
          value={text}
          onChangeText={(s) => setText(s.replace(/[^\d]/g, '').slice(0, 6))}
          onFocus={() => setFocus(true)}
          onBlur={commit}
          onSubmitEditing={commit}
          keyboardType="number-pad"
          returnKeyType="done"
          selectTextOnFocus
          placeholder="—"
          placeholderTextColor={palette.faint}
          style={resolveFont([st.mv, m ? st.mvM : null, { fontWeight: '700' }])}
          accessibilityLabel={label}
        />
        {unit ? <T style={[st.unit, m ? { fontSize: 14 } : null]}>{unit}</T> : null}
      </View>
    </Pressable>
  );
}

const st = StyleSheet.create({
  mf: { backgroundColor: palette.white, borderRadius: 20, paddingTop: 10, paddingBottom: 14, paddingHorizontal: 14, borderWidth: 2, borderColor: 'transparent' },
  mfM: { paddingTop: 8, paddingBottom: 12, paddingHorizontal: 12 },
  est: { backgroundColor: '#FFF9EE', borderColor: '#F3CF8F' },
  err: { backgroundColor: '#FFF5F4', borderColor: palette.red },
  focus: { borderColor: palette.ink },
  ml: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 6, minHeight: 19 },
  mlT: { flexShrink: 1, fontSize: 14, lineHeight: 19, color: palette.muted },
  badge: { height: 22, paddingHorizontal: 8, alignSelf: 'center' },
  mvRow: { flexDirection: 'row', alignItems: 'baseline' },
  mv: { minWidth: 24, padding: 0, fontSize: 26, lineHeight: 32, height: 32, letterSpacing: -0.52, color: palette.ink, fontVariant: ['tabular-nums'] },
  mvM: { fontSize: 24, lineHeight: 30, height: 30, letterSpacing: -0.48 },
  unit: { marginLeft: 4, fontSize: 15, lineHeight: 20, fontWeight: '500', color: palette.muted },
});
