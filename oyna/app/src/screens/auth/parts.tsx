/**
 * Детали экранов входа и создания цеха: цифровая клавиатура (.kp), шаги (.prog), карточка варианта (.optc),
 * переключатель RU/UZ в шапке, тексты входа на двух языках.
 */
import { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C } from '@/theme';
import { GlassBlue, Seg, Txt } from '@/ui/kit';
import { plural } from '../profile/parts';

/** .kp — цифры 1–9, «Стереть», 0, «Готово» */
export function Keypad({ onDigit, onErase, onDone, doneTitle, eraseTitle, doneDisabled }: {
  onDigit: (d: string) => void; onErase: () => void; onDone: () => void; doneTitle: string; eraseTitle: string; doneDisabled?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const key = (k: string) => (
    <Pressable key={k} accessibilityRole="button" accessibilityLabel={k} onPress={() => onDigit(k)}
      style={({ pressed }) => [kp.key, pressed && kp.pressed]}>
      <Txt size={24} w={500} style={{ lineHeight: 30 }}>{k}</Txt>
    </Pressable>
  );
  return (
    <View style={[kp.wrap, { paddingBottom: Math.max(insets.bottom, 12) + 14 }]}>
      <View style={kp.line}>{keys.slice(0, 3).map(key)}</View>
      <View style={kp.line}>{keys.slice(3, 6).map(key)}</View>
      <View style={kp.line}>{keys.slice(6, 9).map(key)}</View>
      <View style={kp.line}>
        <Pressable accessibilityRole="button" accessibilityLabel={eraseTitle} onPress={onErase} onLongPress={onErase}
          style={({ pressed }) => [kp.key, { backgroundColor: C.keyFn }, pressed && kp.pressed]}>
          <Txt size={16} w={600}>{eraseTitle}</Txt>
        </Pressable>
        {key('0')}
        <Pressable accessibilityRole="button" accessibilityLabel={doneTitle} accessibilityState={{ disabled: !!doneDisabled }} disabled={doneDisabled} onPress={onDone}
          style={({ pressed }) => [kp.key, { borderRadius: 999, overflow: 'hidden', backgroundColor: doneDisabled ? C.seg : 'transparent', shadowOpacity: 0 },
            !doneDisabled && { borderWidth: 1.2, borderColor: 'rgba(64,92,138,0.95)' }, pressed && kp.pressed]}>
          {!doneDisabled ? <GlassBlue /> : null}
          <Txt size={17} w={600} color={doneDisabled ? C.faint : C.ctaText}>{doneTitle}</Txt>
        </Pressable>
      </View>
    </View>
  );
}
const kp = {
  wrap: { backgroundColor: C.keypad, paddingTop: 6, paddingHorizontal: 8, gap: 6 },
  line: { flexDirection: 'row' as const, gap: 6 },
  key: {
    flex: 1, height: 50, borderRadius: 12, backgroundColor: C.card, alignItems: 'center' as const, justifyContent: 'center' as const,
    shadowColor: '#21201F', shadowOpacity: 0.18, shadowRadius: 0, shadowOffset: { width: 0, height: 1 }, elevation: 1,
  },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.85 },
};

/** .prog — шаги: пройденные синие, текущий светло-синий */
export function Prog({ step, total }: { step: number; total: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4 }} accessibilityLabel={`Шаг ${step} из ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i + 1 < step ? C.accent : i + 1 === step ? C.accentMid : C.seg }} />
      ))}
    </View>
  );
}

/** .optc — карточка варианта (выбранная — синяя рамка) */
export function OptCard({ on, icon, title, text, onPress }: { on: boolean; icon: ReactNode; title: string; text: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={onPress}
      style={({ pressed }) => [{ borderRadius: 22, backgroundColor: C.card, padding: 14, gap: 10, minHeight: 120, borderWidth: 2.5, borderColor: on ? C.accent : 'transparent' },
        pressed && { transform: [{ scale: 0.98 }] }]}>
      <View style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.accentSoft : C.soft }}>{icon}</View>
      <Txt size={16} w={600} style={{ lineHeight: 20 }}>{title}</Txt>
      <Txt size={13} color={C.muted} style={{ lineHeight: 17 }}>{text}</Txt>
    </Pressable>
  );
}

/** RU / UZ в шапке входа */
export function LangSeg({ value, onChange }: { value: 'ru' | 'uz'; onChange: (v: 'ru' | 'uz') => void }) {
  return <Seg items={[{ value: 'ru', title: 'RU' }, { value: 'uz', title: 'UZ' }]} value={value} onChange={onChange} style={{ width: 112, marginHorizontal: 0 }} />;
}

type Lang = 'ru' | 'uz';
const T = {
  ru: {
    title: 'Вход в Eskiz Oyna', sub: 'Один аккаунт для всех приложений Eskiz', phone: 'Телефон',
    capSms: (n: number) => `Пришлём SMS с кодом из ${n} цифр`, getCode: 'Получить код', erase: 'Стереть', done: 'Готово',
    codeTitle: 'Код из SMS', sentTo: (p: string) => `Отправили на ${p}`, resendIn: 'Отправить снова через', resend: 'Отправить снова',
    wrong: (n: number) => `Неверный код. Осталось ${n} ${plural(n, 'попытка', 'попытки', 'попыток')}`, noAttempts: 'Попытки закончились — запросите новый код',
    badPhone: 'Номер в формате +998 XX XXX XX XX', changePhone: 'Изменить номер',
  },
  uz: {
    title: 'Eskiz Oyna’ga kirish', sub: 'Barcha Eskiz ilovalari uchun bitta akkaunt', phone: 'Telefon',
    capSms: (n: number) => `${n} xonali kodni SMS orqali yuboramiz`, getCode: 'Kodni olish', erase: 'O‘chirish', done: 'Tayyor',
    codeTitle: 'SMS-kod', sentTo: (p: string) => `${p} raqamiga yubordik`, resendIn: 'Qayta yuborish', resend: 'Qayta yuborish',
    wrong: (n: number) => `Kod noto‘g‘ri. ${n} ta urinish qoldi`, noAttempts: 'Urinishlar tugadi — yangi kod so‘rang',
    badPhone: 'Raqam +998 XX XXX XX XX ko‘rinishida', changePhone: 'Raqamni o‘zgartirish',
  },
};
export const loginText = (l: Lang) => T[l];
