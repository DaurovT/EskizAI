/**
 * Контролы панелей редактора кухни: строки свойств (.kv), сегменты, счётчики, ширина модуля (.wrow).
 * Телефон — KitchenEditor.dc.html (строки 15/42, серые контролы внутри белой панели); планшет — TKitchen2.dc.html
 * «десктопный» плотный вид (.kv2 13 px, .sgm, .btn 32 r8 с рамкой) — включается KDense.
 */
import { Ionicons } from '@expo/vector-icons';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { clamp } from '../../lib/kitchenScheme';
import { Press, T, resolveFont } from '../../ui/kit';
import { palette, type as ty } from '../../ui/theme';

/** Плотный вид планшета (TKitchen2). */
export const KDense = createContext(false);
export const useDense = () => useContext(KDense);

/** Цвета десктопного вида (TKitchen2.dc.html). */
export const desk = {
  ring: '#DEDCD7', line: '#E3E1DC', row: '#EFEDE9', bar: '#F7F6F3', pal: '#FBFAF8', sgm: '#E6E5E1', hover: '#F0EFEB', label: '#8E8B85',
  errBg: '#FFF0EE', errInput: '#FFF5F4',
};

/** .kv / .kv2: подпись слева, значение справа; onPress — с шевроном. */
export function KV({ k, v, onPress, line, num: isNum }: { k: string; v: string; onPress?: () => void; line?: boolean; num?: boolean }) {
  const dense = useDense();
  const body = (
    <>
      <T style={dense ? s.k2 : s.k} numberOfLines={1}>{k}</T>
      <T num={isNum} style={[dense ? s.v2 : s.v, isNum && !dense && { fontSize: 14 }]} numberOfLines={1}>{v}</T>
      {onPress ? <Ionicons name="chevron-forward" size={dense ? 15 : 18} color={palette.chev} /> : null}
    </>
  );
  const style = [dense ? s.kv2 : s.kv, line && !dense && s.line];
  return onPress
    ? <Press feedback="row" onPress={onPress} style={style} accessibilityRole="button">{body}</Press>
    : <View style={style}>{body}</View>;
}

/** Строка свойства: подпись слева, переключатель / счётчик справа. */
export function FRow({ label, children, line }: { label: string; children: ReactNode; line?: boolean }) {
  const dense = useDense();
  return (
    <View style={[dense ? [s.kv2, { minHeight: 40, paddingVertical: 4 }] : [s.kv, { minHeight: 50 }], line && !dense && s.line]}>
      <T style={[dense ? s.k2 : s.k, { flex: 1, flexShrink: 1, maxWidth: '100%' }]} numberOfLines={2}>{label}</T>
      {children}
    </View>
  );
}

/** Маленький сегментный выбор (двери 1/2, петли, открывание…). Планшет — .sgm (белый выбранный). */
export function MiniSeg({ value, options, onChange, disabled, wide }: { value: string; options: { v: string; l: string }[]; onChange: (v: string) => void; disabled?: boolean; wide?: boolean }) {
  const dense = useDense();
  return (
    <View style={[dense ? s.sgm : s.seg, wide && { flex: 1 }, disabled && { opacity: 0.5 }]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.v === value;
        return (
          <Press key={o.v} feedback="opacity" disabled={disabled} onPress={() => { if (!on) onChange(o.v); }} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={[dense ? s.sgmB : s.segB, wide && { flex: 1 }, on && (dense ? s.sgmOn : s.segOn)]}>
            <T style={dense ? { fontSize: 13, fontWeight: '600', color: on ? palette.ink : palette.muted2 } : { fontSize: 14, fontWeight: on ? '600' : '500', color: on ? palette.white : palette.ink }} numberOfLines={1}>{o.l}</T>
          </Press>
        );
      })}
    </View>
  );
}

/** Число с «− / +» и вводом с клавиатуры; auto — значение по умолчанию ядра (null), «авто» сбрасывает к нему. */
export function Stepper({ value, step, lim, onChange, disabled, auto, autoLabel }: {
  value: number; step: number; lim: readonly [number, number]; onChange: (v: number | null) => void; disabled?: boolean; auto?: boolean; autoLabel?: string;
}) {
  const dense = useDense();
  const [txt, setTxt] = useState(String(Math.round(value)));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(String(Math.round(value))); }, [value, focus]);
  const set = (v: number) => { const c = clamp(v, lim); if (c !== value || auto) onChange(c); };
  const btn = dense ? s.btn2 : s.sb;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: dense ? 4 : 6 }}>
      {autoLabel ? (
        <Press onPress={() => !auto && onChange(null)} disabled={disabled || auto} style={[dense ? s.auto2 : s.auto, auto && { backgroundColor: palette.blueSoft }]} accessibilityRole="button" accessibilityState={{ selected: !!auto }}>
          <T style={{ fontSize: dense ? 11 : 12, fontWeight: '600', color: auto ? palette.blue : palette.muted }}>{autoLabel}</T>
        </Press>
      ) : null}
      <Press onPress={() => set(value - step)} disabled={disabled || value <= lim[0]} style={btn} accessibilityRole="button" accessibilityLabel={`−${step}`}>
        <Ionicons name="remove" size={dense ? 15 : 18} color={palette.ink} />
      </Press>
      <TextInput value={txt} onChangeText={(x) => setTxt(x.replace(/\D/g, '').slice(0, 5))} editable={!disabled} keyboardType="number-pad" returnKeyType="done"
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} selectTextOnFocus
        onEndEditing={() => { const n = Number(txt); if (txt && Number.isFinite(n)) set(n); else setTxt(String(Math.round(value))); }}
        style={resolveFont([ty.body, dense ? s.sv2 : s.sv, auto && { color: palette.muted }])} />
      <Press onPress={() => set(value + step)} disabled={disabled || value >= lim[1]} style={btn} accessibilityRole="button" accessibilityLabel={`+${step}`}>
        <Ionicons name="add" size={dense ? 15 : 18} color={palette.ink} />
      </Press>
    </View>
  );
}

/**
 * .wrow — ширина модуля «−50 / значение мм / +50» (значение можно ввести); ошибка суммы — красная рамка.
 * Телефон: серая плашка r14, кнопки белые 46×40; планшет: кнопки .btn и поле .wv 32 с рамкой.
 */
export function WidthRow({ label, value, unit, err, disabled, lim, onChange }: { label: string; value: number; unit: string; err: boolean; disabled: boolean; lim: readonly [number, number]; onChange: (v: number) => void }) {
  const dense = useDense();
  const [txt, setTxt] = useState(String(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(String(value)); }, [value, focus]);
  const set = (v: number) => { const c = clamp(v, lim); if (c !== value) onChange(c); };
  const input = (
    <TextInput value={txt} onChangeText={(x) => setTxt(x.replace(/\D/g, '').slice(0, 4))} editable={!disabled} keyboardType="number-pad" returnKeyType="done" selectTextOnFocus
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} accessibilityLabel={label}
      onEndEditing={() => { const n = Number(txt); if (txt && Number.isFinite(n)) set(n); else setTxt(String(value)); }}
      style={resolveFont([ty.body, { minWidth: 46, fontSize: dense ? 15 : 20, lineHeight: dense ? 19 : 24, fontWeight: '600', textAlign: 'right', color: palette.ink, paddingVertical: 0, fontVariant: ['tabular-nums'] }])} />
  );
  const minus = (
    <Press onPress={() => set(value - 50)} disabled={disabled || value <= lim[0]} style={dense ? s.wbtn2 : s.pm} accessibilityRole="button" accessibilityLabel={`${label} −50`}>
      <T style={{ fontSize: dense ? 13 : 14, fontWeight: dense ? '600' : '500' }}>−50</T>
    </Press>
  );
  const plus = (
    <Press onPress={() => set(value + 50)} disabled={disabled || value >= lim[1]} style={dense ? s.wbtn2 : s.pm} accessibilityRole="button" accessibilityLabel={`${label} +50`}>
      <T style={{ fontSize: dense ? 13 : 14, fontWeight: dense ? '600' : '500' }}>+50</T>
    </Press>
  );
  if (dense) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {minus}
        <View style={[s.wv2, err && { borderWidth: 2, borderColor: palette.red, backgroundColor: desk.errInput }]}>
          {input}<T style={{ fontSize: 12, fontWeight: '500', color: palette.muted }}>{` ${unit}`}</T>
        </View>
        {plus}
      </View>
    );
  }
  return (
    <View style={[s.wrow, err && { backgroundColor: desk.errInput }]}>
      {err ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 14, borderWidth: 2, borderColor: palette.red }]} /> : null}
      {minus}
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center' }}>
        {input}<T style={{ fontSize: 13, fontWeight: '500', color: palette.muted }}>{` ${unit}`}</T>
      </View>
      {plus}
    </View>
  );
}

const s = StyleSheet.create({
  kv: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 42 },
  k: { flexShrink: 0, maxWidth: '58%', fontSize: 15, lineHeight: 20, color: palette.muted },
  v: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '500', textAlign: 'right' },
  line: { borderTopWidth: 1, borderTopColor: palette.hair },
  kv2: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: palette.hair },
  k2: { fontSize: 13, lineHeight: 17, color: palette.muted, flexShrink: 0, maxWidth: '58%' },
  v2: { flex: 1, fontSize: 13, lineHeight: 17, fontWeight: '600', textAlign: 'right' },
  seg: { flexDirection: 'row', height: 36, borderRadius: 12, padding: 3, gap: 2, backgroundColor: palette.segOnWhite },
  segB: { minWidth: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  segOn: { backgroundColor: palette.ink },
  sgm: { flexDirection: 'row', borderRadius: 8, padding: 2, backgroundColor: desk.sgm },
  sgmB: { height: 28, minWidth: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  sgmOn: { backgroundColor: palette.white, boxShadow: '0px 1px 2px rgba(0,0,0,0.08)' },
  sb: { width: 36, height: 36, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  btn2: { width: 28, height: 28, borderRadius: 7, backgroundColor: palette.white, borderWidth: 1, borderColor: desk.ring, alignItems: 'center', justifyContent: 'center' },
  sv: { width: 58, fontSize: 17, fontWeight: '600', textAlign: 'center', color: palette.ink, paddingVertical: 0, fontVariant: ['tabular-nums'] },
  sv2: { width: 46, fontSize: 13, fontWeight: '600', textAlign: 'center', color: palette.ink, paddingVertical: 0, fontVariant: ['tabular-nums'] },
  auto: { height: 28, borderRadius: 9, paddingHorizontal: 8, justifyContent: 'center', backgroundColor: palette.ground },
  auto2: { height: 24, borderRadius: 6, paddingHorizontal: 6, justifyContent: 'center', backgroundColor: palette.ground },
  wrow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, padding: 6, backgroundColor: palette.ground },
  pm: { width: 46, height: 40, borderRadius: 12, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  wbtn2: { height: 32, borderRadius: 8, paddingHorizontal: 11, backgroundColor: palette.white, borderWidth: 1, borderColor: desk.ring, alignItems: 'center', justifyContent: 'center' },
  wv2: { flex: 1, height: 32, borderRadius: 8, borderWidth: 1, borderColor: desk.ring, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
