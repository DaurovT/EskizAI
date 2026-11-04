/** .lang — переключатель «Рус / O‘zb» в шапке онбординга и входа (белая пилюля, выбранный — чёрный). */
import { StyleSheet, View, type ViewStyle } from 'react-native';
import type { Lang } from '../api/types';
import { useT } from '../i18n';
import { Press, T } from './base';
import { palette } from './theme';

const OPTS: { v: Lang; l: string }[] = [{ v: 'ru', l: 'Рус' }, { v: 'uz', l: 'O‘zb' }];

export function LangSwitch({ itemStyle }: { itemStyle?: ViewStyle }) {
  const { lang, setLang } = useT();
  return (
    <View style={s.lang} accessibilityRole="radiogroup">
      {OPTS.map((o) => {
        const on = lang === o.v;
        return (
          <Press key={o.v} feedback="opacity" accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => setLang(o.v)}
            style={[s.item, itemStyle, on && { backgroundColor: palette.ink }]}>
            <T style={s.text} color={on ? palette.white : palette.ink}>{o.l}</T>
          </Press>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  lang: { flexDirection: 'row', backgroundColor: palette.white, borderRadius: 22, padding: 3, gap: 2 },
  item: { height: 38, borderRadius: 19, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
});
