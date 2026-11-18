/**
 * «Жидкое стекло» (макет V3.1: .glass, .top .ic, .lg .caps): на iOS 26 — системный Liquid Glass (expo-glass-effect),
 * иначе — размытие фона (expo-blur) + белый градиент .30→.08, светлая кромка и мягкая тень, как в макете.
 */
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { ReactNode } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

const LIQUID = (() => {
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

export function Glass({ children, style, radius = 22, dark, interactive, tint }: {
  children?: ReactNode; style?: StyleProp<ViewStyle>; radius?: number; dark?: boolean; interactive?: boolean; tint?: string;
}) {
  if (LIQUID) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive={interactive} colorScheme={dark ? 'dark' : 'light'} tintColor={tint}
        style={[{ borderRadius: radius, overflow: 'hidden' }, style]}>
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[dark ? st.shadowDark : st.shadow, { borderRadius: radius }, style]}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]} pointerEvents="none">
        <BlurView intensity={dark ? 40 : 28} tint={dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id="g" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#fff" stopOpacity={dark ? 0.22 : 0.3} />
              <Stop offset="1" stopColor="#fff" stopOpacity={0.08} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#g)" />
        </Svg>
        {tint ? <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} /> : null}
        <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: dark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.6)', borderTopColor: dark ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.95)' }]} />
      </View>
      {children}
    </View>
  );
}

const st = StyleSheet.create({
  shadow: { shadowColor: '#21201F', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  shadowDark: { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
});
