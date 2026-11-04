import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, type } from './theme';
import { EstimateBadge, Press, T, resolveFont, useControlBg } from './kit';
import { useT } from '../i18n';

/**
 * Числовое поле .fld + .numf: подпись внутри, кнопки ±шаг (.pm), крупное значение с табличными цифрами (решение PRD: без слайдеров).
 * Значение уходит на сервер по «Готово» на клавиатуре, по уходу из поля или по кнопкам.
 * estimated — янтарная рамка (.fld.est) и метка «оценка» (тап — подтвердить); highlight — рамка фокуса.
 */
export function NumberField({
  label, value, step = 10, min, max, unit, estimated, onChange, onConfirm, disabled, nullable, highlight,
}: {
  label: string; value: number | null; step?: number; min: number; max: number; unit?: string;
  estimated?: boolean; onChange: (v: number | null) => void; onConfirm?: () => void; disabled?: boolean; nullable?: boolean; highlight?: boolean;
}) {
  const { t } = useT();
  const ctrl = useControlBg();
  const [text, setText] = useState(value == null ? '' : String(Math.round(value)));
  const [focus, setFocus] = useState(false);
  useEffect(() => { setText(value == null ? '' : String(Math.round(value))); }, [value]);

  const commit = (raw: string) => {
    const n = parseInt(raw.replace(/\D/g, ''), 10);
    if (Number.isNaN(n)) {
      if (nullable) onChange(null);
      else setText(value == null ? '' : String(Math.round(value)));
      return;
    }
    const v = Math.min(max, Math.max(min, n));
    setText(String(v));
    if (v !== value) onChange(v);
  };
  const bump = (d: number) => {
    const base = value ?? min;
    const v = Math.min(max, Math.max(min, base + d));
    if (v !== value) onChange(v);
  };
  const stepLabel = String(step);
  // на кнопке шаг виден, если он короткий (−10, −50); крупные шаги — просто «−» / «+»
  const showStep = step !== 1 && stepLabel.length <= 3;
  const ring = focus || highlight ? palette.ink : estimated ? '#F3CF8F' : 'transparent';
  const bg = focus ? palette.white : estimated ? '#FFF9EE' : ctrl;
  const pmBg = bg === palette.ground ? palette.white : palette.ground;

  const pm = (sign: -1 | 1) => (
    <Press accessibilityRole="button" accessibilityLabel={`${sign < 0 ? '−' : '+'}${stepLabel}`} disabled={disabled} onPress={() => bump(sign * step)}
      style={[st.pm, { backgroundColor: pmBg }, showStep && { minWidth: 52, paddingHorizontal: 8 }, disabled && st.off]}>
      {showStep
        ? <Text style={resolveFont([type.btnSm, type.num])}>{sign < 0 ? '−' : '+'}{stepLabel}</Text>
        : <Ionicons name={sign < 0 ? 'remove' : 'add'} size={22} color={palette.ink} />}
    </Press>
  );

  return (
    <View style={[st.fld, { backgroundColor: bg, borderColor: ring }]}>
      <View style={st.head}>
        <T v="fl" style={{ flex: 1 }} numberOfLines={1}>{label}</T>
        {estimated ? (
          <Press feedback="opacity" onPress={onConfirm} disabled={!onConfirm} accessibilityRole="button" accessibilityLabel={t('ed_confirm_value')} style={st.est}>
            <EstimateBadge />
            {onConfirm ? <Ionicons name="checkmark-circle-outline" size={22} color={palette.amberDeep} /> : null}
          </Press>
        ) : null}
      </View>
      <View style={st.row}>
        {pm(-1)}
        <View style={st.inputWrap}>
          <TextInput
            value={text}
            editable={!disabled}
            onChangeText={setText}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onEndEditing={(e) => commit(e.nativeEvent.text)}
            onSubmitEditing={(e) => commit(e.nativeEvent.text)}
            keyboardType="number-pad"
            returnKeyType="done"
            placeholder={nullable ? t('ed_auto') : ''}
            placeholderTextColor={palette.faint}
            style={resolveFont([type.nval, st.input, estimated && { color: palette.amberDeep }])}
            accessibilityLabel={label}
            selectTextOnFocus
          />
          {unit ? <T v="cap">{unit}</T> : null}
        </View>
        {pm(1)}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  fld: { borderRadius: radius.field, borderWidth: 2, paddingTop: 7, paddingBottom: 10, paddingHorizontal: 14, marginBottom: 8, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  est: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pm: { minWidth: 40, height: 40, borderRadius: radius.pm, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: 0.4 },
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 4 },
  input: { flexShrink: 1, minWidth: 48, textAlign: 'center', paddingVertical: 0 },
});
