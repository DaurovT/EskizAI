/** Иллюстрации макетов из View (без SVG): .wood, шкаф .mini/.carc, логотип-плашка, знак Eskiz. */
import { Image, View, type ViewStyle } from 'react-native';
import { palette } from './theme';

/** .wood — вертикальные волокна 7 px #E6D3B1 + 2 px #DCC59F. */
export function Wood({ style }: { style?: ViewStyle }) {
  return (
    <View style={[{ flex: 1, flexDirection: 'row', overflow: 'hidden', backgroundColor: '#E6D3B1' }, style]}>
      {Array.from({ length: 24 }, (_, k) => <View key={k} style={{ width: 9, borderRightWidth: 2, borderRightColor: '#DCC59F' }} />)}
    </View>
  );
}

/** .mini / .carc — шкаф из трёх створок, правая скруглена сверху. b — рамка (она же зазор между створками). */
export function Carcass({ w, h, r, b, style }: { w: number; h: number; r: number; b: number; style?: ViewStyle }) {
  return (
    <View style={[{ width: w, height: h, backgroundColor: palette.ink, borderTopRightRadius: r, padding: b * 2, flexDirection: 'row', gap: b }, style]}>
      <Wood /><Wood /><Wood style={{ borderTopRightRadius: r - b - 1 }} />
    </View>
  );
}

/** Знак Eskiz в зелёной плашке r24/100 (логотип в шапке онбординга). */
export function BrandLogo({ size = 32 }: { size?: number }) {
  return <Image source={require('../../assets/brand/logo.png')} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />;
}
