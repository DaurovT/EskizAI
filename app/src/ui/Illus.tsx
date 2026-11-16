/** Иллюстрации макетов из View (без SVG): .wood, шкаф .mini/.carc, логотип-плашка, знак Eskiz. */
import { Image, View, type ViewStyle } from 'react-native';
import { T } from './base';
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

/** Знак (шкаф) без плитки — белый, сетка 48 на весь квадрат (assets/brand/mark.png). */
export function BrandMark({ size, tint }: { size: number; tint?: string }) {
  return <Image source={require('../../assets/brand/mark.png')} style={{ width: size, height: size, tintColor: tint }} accessibilityIgnoresInvertColors />;
}

/**
 * Фирменная строка Login.dc.html: зелёная плитка 36 r8 с белым знаком 22 и «**Eskiz** Mebel» 20 (700/500, -.03em).
 * `onGreen` — на зелёном фоне (планшетный вход): плитка rgba(255,255,255,.12), текст белый.
 */
export function BrandLockup({ tile = 36, fontSize = 20, onGreen }: { tile?: number; fontSize?: number; onGreen?: boolean }) {
  const color = onGreen ? palette.white : palette.ink;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: Math.round(tile * 0.28) }} accessibilityRole="header" accessibilityLabel="Eskiz Mebel">
      <View style={{ width: tile, height: tile, borderRadius: tile * (8 / 36), backgroundColor: onGreen ? 'rgba(255,255,255,0.12)' : palette.green, alignItems: 'center', justifyContent: 'center' }}>
        <BrandMark size={Math.round(tile * (22 / 36))} />
      </View>
      <T style={{ fontSize, lineHeight: Math.round(fontSize * 1.25), fontWeight: '700', letterSpacing: -0.03 * fontSize }} color={color}>
        Eskiz <T style={{ fontSize, lineHeight: Math.round(fontSize * 1.25), fontWeight: '500', letterSpacing: -0.03 * fontSize }} color={color}>Mebel</T>
      </T>
    </View>
  );
}
