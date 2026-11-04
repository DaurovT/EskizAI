/**
 * SCR-00 заставка (Splash.dc.html): продолжает нативную заставку (зелёный #387D50 + та же картинка) без скачка
 * и держится, пока грузится сессия, — максимум ~1,5 с, затем растворяется.
 * Знак, «Eskiz AI» и «мебель в 3D» стоят там же, где на нативной картинке (её уже видно — «подъём» дал бы мигание);
 * подпись «для мебельных цехов» появляется с анимацией rise (.5 с, задержка .2 с).
 */
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { T, ease, useReduceMotion } from './base';
import { palette } from './theme';

const MIN_MS = 900; // не мигать, даже если всё готово сразу
const MAX_MS = 1250; // + 250 мс растворения = не дольше 1,5 с
const FADE_MS = 250;

export function AppSplash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const { t } = useT();
  const reduce = useReduceMotion();
  const [minPassed, setMinPassed] = useState(false);
  const [maxPassed, setMaxPassed] = useState(false);
  const fade = useRef(new Animated.Value(1)).current;
  const rise = useRef(new Animated.Value(0)).current;
  const leaving = useRef(false);

  useEffect(() => {
    const a = setTimeout(() => setMinPassed(true), MIN_MS);
    const b = setTimeout(() => setMaxPassed(true), MAX_MS);
    Animated.timing(rise, { toValue: 1, duration: 500, delay: 200, easing: ease, useNativeDriver: true }).start();
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [rise]);

  useEffect(() => {
    if (leaving.current || !((ready && minPassed) || maxPassed)) return;
    leaving.current = true;
    Animated.timing(fade, { toValue: 0, duration: reduce ? 120 : FADE_MS, easing: ease, useNativeDriver: true }).start(() => onDone());
  }, [ready, minPassed, maxPassed, fade, onDone, reduce]);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, s.root, { opacity: fade }]}
      // нативную заставку убираем, когда эта уже нарисована — без кадра пустоты между ними
      onLayout={() => { SplashScreen.hideAsync().catch(() => undefined); }}
      pointerEvents="none"
    >
      <StatusBar style="light" />
      <View style={s.box}>
        <Image source={require('../../assets/brand/mark.png')} style={s.mark} />
      </View>
      <T style={s.name} color={palette.white}>Eskiz <T style={s.name} color="rgba(255,255,255,0.7)">AI</T></T>
      <T style={s.tag} color={palette.white}>{t('splashTagline')}</T>
      <Animated.View
        style={[s.footer, { opacity: rise.interpolate({ inputRange: [0, 1], outputRange: [0, 0.7] }), transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}
      >
        <T style={s.footerText} color={palette.white}>{t('splashFor')}</T>
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  box: { width: 132, height: 132, borderRadius: 34, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  mark: { width: 112, height: 112 },
  name: { marginTop: 26, fontSize: 44, lineHeight: 48, fontWeight: '700', letterSpacing: -1.54 },
  tag: { marginTop: 2, fontSize: 17, lineHeight: 22, opacity: 0.85 },
  footer: { position: 'absolute', bottom: 44, left: 0, right: 0, alignItems: 'center' },
  footerText: { fontSize: 14, lineHeight: 22 },
});
