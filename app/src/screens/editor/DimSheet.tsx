/**
 * Лист ввода размера (v3: X5Dim): «Ширина створки 1», своё поле с курсором, «створка 2 станет 750»,
 * «Створки поровну», «Стёкла поровну», цифровая клавиатура, «Готово».
 * Пока вводят — схема над листом показывает новые размеры (onPreview). Команды — set_part_size / set_size (src/lib/dims.ts),
 * поэтому работает и в редакторе (сервер), и в мастере замера (без сети).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';

import type { Command, Doc } from '@/api/types';
import {
  dimTitle, dimValue, equalGlassCommands, equalPartsCommands, frameSizeCommands, partSizeCommands, type DimResult, type DimTarget,
} from '@/lib/dims';
import { C } from '@/theme';
import { Icon } from '@/ui/Icon';
import { Txt } from '@/ui/kit';
import { BigValue } from '@/ui/v3';
import { Keypad } from '../measure/parts';

export function DimSheet({ doc, target, onClose, onApply, onPreview }: {
  doc: Doc; target: DimTarget; onClose: () => void; onApply: (c: Command[]) => void;
  onPreview?: (d: Doc | null, changed: number[]) => void;
}) {
  const initial = useMemo(() => dimValue(doc, target), [doc, target]);
  const [text, setText] = useState(String(initial || ''));
  const fresh = useRef(true);               // первая цифра заменяет старое значение
  const [msg, setMsg] = useState<string | null>(null);
  const shake = useRef(new Animated.Value(0)).current;

  const value = Number(text);
  const res: DimResult | null = useMemo(() => {
    if (!text || value === initial) return null;
    return target.kind === 'part' ? partSizeCommands(doc, target.path, value) : frameSizeCommands(doc, target, value);
  }, [doc, target, text, value, initial]);

  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  useEffect(() => {
    previewRef.current?.(res && !res.error ? res.doc : null, res && !res.error ? res.changed.map((c) => c.index) : []);
  }, [res]);
  useEffect(() => () => previewRef.current?.(null, []), []);

  const bump = () => {
    shake.setValue(0);
    Animated.sequence([
      Animated.timing(shake, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const digit = (d: string) => {
    setMsg(null);
    if (fresh.current) { fresh.current = false; setText(d === '0' ? '' : d); return; }
    if (text.length >= 5 || (!text && d === '0')) return;
    setText(text + d);
  };
  const erase = () => { fresh.current = false; setMsg(null); setText(text.slice(0, -1)); };
  const done = () => {
    if (!text) { setMsg('Введите размер в мм'); bump(); return; }
    if (!res) { onClose(); return; }
    if (res.error || !res.commands.length) { setMsg(res.error ?? 'Не получилось'); bump(); return; }
    onApply(res.commands);
  };
  const run = (r: DimResult) => {
    if (r.error) { setMsg(r.error); bump(); return; }
    if (!r.commands.length) { onClose(); return; }
    onApply(r.commands);
  };

  const err = msg ?? res?.error ?? null;
  const note = err ?? res?.note ?? '';
  const tx = shake.interpolate({ inputRange: [-1, 1], outputRange: [-5, 5] });
  return (
    <View style={s.bs}>
      <View style={s.hdl}><View style={s.hdlBar} /></View>
      <View style={{ paddingHorizontal: 12, gap: 10, paddingBottom: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
          <Txt size={20} w={700} lines={1} style={{ flex: 1, lineHeight: 26 }}>{dimTitle(doc, target)}</Txt>
          <Pressable accessibilityRole="button" accessibilityLabel="Отменить ввод" onPress={onClose} hitSlop={6}
            style={({ pressed }) => [s.ib, pressed && { opacity: 0.7 }]}>
            <Icon name="close" size={22} />
          </Pressable>
        </View>
        <Animated.View style={[s.fld, err ? s.fldErr : null, { transform: [{ translateX: tx }] }]}>
          <BigValue text={text ? text.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : ''} focus />
          <Txt size={14} color={err ? C.danger : '#5F5C57'} lines={2} style={{ flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }}>{note}</Txt>
        </Animated.View>
        {target.kind === 'part' ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip title="Створки поровну" onPress={() => run(equalPartsCommands(doc, target.path))} />
            <Chip title="Стёкла поровну" onPress={() => run(equalGlassCommands(doc, target.path))} />
          </View>
        ) : null}
      </View>
      <Keypad onDigit={digit} onErase={erase} onNext={done} nextTitle="Готово" />
    </View>
  );
}

function Chip({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => [{ height: 40, borderRadius: 20, backgroundColor: C.soft, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
        { transform: [{ scale: pressed ? 0.97 : 1 }], opacity: pressed ? 0.85 : 1 }]}>
      <Txt size={15} w={500}>{title}</Txt>
    </Pressable>
  );
}

const s = StyleSheet.create({
  bs: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 6, backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    shadowColor: '#21201F', shadowOpacity: 0.1, shadowRadius: 24, shadowOffset: { width: 0, height: -4 }, elevation: 10, overflow: 'hidden' },
  hdl: { height: 22, alignItems: 'center', justifyContent: 'center' },
  hdlBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#D6D4CF' },
  ib: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' },
  fld: { minHeight: 68, borderRadius: 16, backgroundColor: C.card, borderWidth: 2, borderColor: C.accent, paddingHorizontal: 16, paddingVertical: 9,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  fldErr: { backgroundColor: C.dangerBg, borderColor: C.dangerLine },
});
