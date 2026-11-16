/**
 * SCR-00 заставка (Splash.dc.html): продолжает нативную заставку (зелёный #387D50 + плитка со знаком) без скачка
 * и держится, пока грузится сессия, — максимум ~1,5 с, затем растворяется.
 * Плитка 132 r29 со знаком 84 стоит ровно там же, где на нативной картинке (её уже видно — «подъём» дал бы мигание);
 * «Eskiz Mebel» (700/500, оба белые) и «мебель в 3D» поднимаются как .rise в макете (.5 с, задержки .12 и .2 с),
 * подпись «для мебельных цехов» проявляется вместе с ними. При «уменьшить движение» — только прозрачность.
 * Нативная картинка — assets/splash-icon.png из scripts/gen_brand.py.
 */
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { T, ease, useReduceMotion } from './base';
import { BrandMark } from './Illus';
import { palette } from './theme';

const MIN_MS = 900; // не мигать, даже если всё готово сразу
const MAX_MS = 1250; // + 250 мс растворения = не дольше 1,5 с
const FADE_MS = 250;
const RISE_MS = 500;

export function AppSplash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const { t } = useT();
  const reduce = useReduceMotion();
  const [minPassed, setMinPassed] = useState(false);
  const [maxPassed, setMaxPassed] = useState(false);
  const fade = useRef(new Animated.Value(1)).current;
  const name = useRef(new Animated.Value(0)).current;
  const tag = useRef(new Animated.Value(0)).current;
  const leaving = useRef(false);

  useEffect(() => {
    const a = setTimeout(() => setMinPassed(true), MIN_MS);
    const b = setTimeout(() => setMaxPassed(true), MAX_MS);
    Animated.parallel([
      Animated.timing(name, { toValue: 1, duration: RISE_MS, delay: 120, easing: ease, useNativeDriver: true }),
      Animated.timing(tag, { toValue: 1, duration: RISE_MS, delay: 200, easing: ease, useNativeDriver: true }),
    ]).start();
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [name, tag]);

  useEffect(() => {
    if (leaving.current || !((ready && minPassed) || maxPassed)) return;
    leaving.current = true;
    Animated.timing(fade, { toValue: 0, duration: reduce ? 120 : FADE_MS, easing: ease, useNativeDriver: true }).start(() => onDone());
  }, [ready, minPassed, maxPassed, fade, onDone, reduce]);

  /** .rise: translateY 12 → 0 и прозрачность 0 → `to`. */
  const rise = (v: Animated.Value, to = 1) => ({
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, to] }),
    transform: reduce ? [] : [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  });

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, s.root, { opacity: fade }]}
      // нативную заставку убираем, когда эта уже нарисована — без кадра пустоты между ними
      onLayout={() => { SplashScreen.hideAsync().catch(() => undefined); }}
      pointerEvents="none"
    >
      <StatusBar style="light" />
      <View style={s.box}>
        <BrandMark size={84} />
      </View>
      <Animated.View style={rise(name)}>
        <T style={s.name} color={palette.white}>Eskiz <T style={[s.name, s.thin]} color={palette.white}>Mebel</T></T>
      </Animated.View>
      <Animated.View style={rise(tag, 0.85)}>
        <T style={s.tag} color={palette.white}>{t('splashTagline')}</T>
      </Animated.View>
      <Animated.View style={[s.footer, { opacity: tag.interpolate({ inputRange: [0, 1], outputRange: [0, 0.7] }) }]}>
        <T style={s.footerText} color={palette.white}>{t('splashFor')}</T>
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  // блок 132 + 22 + 48 + 6 + 22 = 230 — по центру, как плитка на нативной картинке (gen_brand.splash)
  box: { width: 132, height: 132, borderRadius: 29, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  name: { marginTop: 22, fontSize: 44, lineHeight: 48, fontWeight: '700', letterSpacing: -1.54 },
  thin: { marginTop: 0, fontWeight: '500' },
  tag: { marginTop: 6, fontSize: 17, lineHeight: 22 },
  footer: { position: 'absolute', bottom: 44, left: 0, right: 0, alignItems: 'center' },
  footerText: { fontSize: 14, lineHeight: 22 },
});
