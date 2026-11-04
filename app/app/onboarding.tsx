/**
 * SCR-00a онбординг (Onboarding.dc.html): 3 слайда при первом запуске, до входа. Флаг — src/state/onboarding.
 * Иллюстрации нарисованы View (без SVG), текст в них переводится. Свайп влево/вправо листает слайды.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { ImageBackground, LayoutAnimation, PanResponder, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useT, type DictKey } from '../src/i18n';
import { markOnboarded } from '../src/state/onboarding';
import { Button, Footer, T } from '../src/ui/kit';
import { BrandLogo, Carcass, Wood } from '../src/ui/Illus';
import { LangSwitch } from '../src/ui/LangSwitch';
import { palette } from '../src/ui/theme';

const SLIDES: { t: DictKey; x: DictKey }[] = [
  { t: 'ob_t1', x: 'ob_x1' },
  { t: 'ob_t2', x: 'ob_x2' },
  { t: 'ob_t3', x: 'ob_x3' },
];
const ILL_H = 400; // высота иллюстрации в макете; на низком экране она ужимается (содержимое — масштабом)
const ILL_W = 358; // 390 − 2×16

export default function Onboarding() {
  const { t } = useT();
  // dev: ?slide=1|2 — открыть сразу нужный слайд (сверка с макетом без тапов)
  const { slide } = useLocalSearchParams<{ slide?: string }>();
  const [i, setI] = useState(() => (__DEV__ && slide ? Math.min(2, Math.max(0, Number(slide) || 0)) : 0));
  const [illH, setIllH] = useState(ILL_H);
  const last = i === SLIDES.length - 1;

  const go = (n: number) => {
    if (n < 0 || n >= SLIDES.length) return;
    LayoutAnimation.configureNext(LayoutAnimation.create(200, 'easeInEaseOut', 'opacity'));
    setI(n);
  };
  const finish = () => { markOnboarded(); router.replace('/login'); };

  const iRef = useRef(i); iRef.current = i;
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_, g) => { if (g.dx < -40) go(iRef.current + 1); else if (g.dx > 40) go(iRef.current - 1); },
  })).current;

  const scale = Math.min(1, illH / ILL_H);
  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.hdr}>
        <BrandLogo />
        <T style={s.brand}>Eskiz AI</T>
        <View style={{ flex: 1 }} />
        <LangSwitch itemStyle={{ minWidth: 68, paddingHorizontal: 10 }} />
      </View>
      <View style={{ flex: 1 }} {...pan.panHandlers}>
        <View style={s.ill} onLayout={(e) => setIllH(Math.round(e.nativeEvent.layout.height))}>
          <View style={[s.canvas, { top: (illH - ILL_H) / 2, transform: [{ scale }] }]}>
            {i === 0 ? <Ill1 t={t} /> : i === 1 ? <Ill2 t={t} /> : <Ill3 t={t} />}
          </View>
        </View>
        <View style={s.text}>
          <View style={s.dots} accessibilityLabel={`${i + 1} / ${SLIDES.length}`}>
            {SLIDES.map((_, k) => <View key={k} style={[s.dot, k === i && s.dotOn]} />)}
          </View>
          <T style={s.title}>{t(SLIDES[i].t)}</T>
          <T v="sub">{t(SLIDES[i].x)}</T>
        </View>
      </View>
      <Footer>
        <Button title={last ? t('ob_start') : t('ob_next')} onPress={() => (last ? finish() : go(i + 1))} />
        <Button v="ghost" color={palette.muted2} title={last ? t('ob_have_account') : t('skip')} onPress={finish} />
      </Footer>
    </SafeAreaView>
  );
}

// ---------- иллюстрации (координаты — из макета, холст 358×400) ----------
type TF = (k: DictKey) => string;
const abs = (st: ViewStyle): ViewStyle => ({ position: 'absolute', ...st });

function St({ children, fg, bg, big, style }: { children: ReactNode; fg: string; bg: string; big?: boolean; style?: ViewStyle }) {
  return (
    <View style={[s.st, { backgroundColor: bg }, big && { height: 30 }, style]}>
      <T style={[s.stText, big && { fontSize: 14 }]} color={fg}>{children}</T>
    </View>
  );
}

function Ill1({ t }: { t: TF }) {
  return (
    <>
      <View style={[abs({ left: 24, top: 40, width: 150, height: 190 }), s.photo]}>
        <View style={abs({ left: 20, top: 26, width: 110, height: 140, backgroundColor: '#D8CDBA', borderRadius: 4, overflow: 'hidden' })}>
          {[34, 71, 108].map((x) => <View key={x} style={abs({ left: x, top: 0, bottom: 0, width: 3, backgroundColor: '#C6B9A2' })} />)}
        </View>
        <St fg={palette.greenDeep} bg={palette.white} style={abs({ left: 10, bottom: 10 })}>{t('ob_i_photo')}</St>
      </View>
      <ImageBackground source={require('../assets/illus/dots.png')} resizeMode="repeat" imageStyle={{ borderRadius: 24 }}
        style={[abs({ right: 26, top: 110, width: 150, height: 230 }), { borderRadius: 24, backgroundColor: '#ECEBE7', alignItems: 'center', justifyContent: 'center' }]}>
        <Carcass w={96} h={150} r={30} b={3} />
        <View style={[abs({ top: 12 }), { height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: palette.white, justifyContent: 'center' }]}>
          <T style={s.stText} color={palette.blue}>{t('ob_i_mm')}</T>
        </View>
      </ImageBackground>
      <St big fg={palette.blue} bg={palette.blueSoft} style={abs({ left: 24, bottom: 28 })}>{t('ob_i_minutes')}</St>
    </>
  );
}

function Ill2({ t }: { t: TF }) {
  const line = (a: string, b: string, big?: boolean) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <T style={[s.est, big && { fontSize: 15 }]}>{a}</T>
      <T style={[s.est, big && { fontSize: 15 }, { fontWeight: '700' }]}>{b}</T>
    </View>
  );
  return (
    <>
      <View style={[abs({ left: 20, top: 30, width: 190 }), { backgroundColor: palette.ground, borderRadius: 20, padding: 14, gap: 8 }]}>
        <T style={[s.est, { fontSize: 15, fontWeight: '700' }]}>{t('ob_i_est')}</T>
        {line(t('ob_i_ldsp'), '3,4 млн')}
        {line(t('ob_i_cut'), '0,8 млн')}
        {line(t('ob_i_hw'), '1,1 млн')}
        <View style={{ height: 1, backgroundColor: '#E1DFDB' }} />
        {line(t('ob_i_client'), '9,2–10,5 млн', true)}
      </View>
      <View style={[abs({ right: 20, top: 150, width: 118, height: 220 }), { borderRadius: 24, backgroundColor: palette.ink, padding: 6 }]}>
        <View style={{ flex: 1, borderRadius: 20, backgroundColor: '#A99A86', overflow: 'hidden' }}>
          <View style={abs({ left: 0, right: 0, top: 0, height: '58%', backgroundColor: '#D9D3C8' })} />
          <Carcass w={58} h={88} r={20} b={2} style={abs({ left: 24, top: 44 })} />
          <View style={[abs({ left: 8, right: 8, bottom: 10 }), { backgroundColor: palette.white, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
            <T style={s.ar}>AR</T>
            <View style={{ backgroundColor: palette.green, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 6 }}>
              <T style={s.ar} color={palette.white}>{t('ob_i_agree')}</T>
            </View>
          </View>
        </View>
      </View>
      <View style={[abs({ left: 20, bottom: 28 }), s.st, { height: 30, backgroundColor: palette.greenSoft, gap: 4 }]}>
        <Ionicons name="paper-plane-outline" size={15} color={palette.greenDeep} />
        <T style={[s.stText, { fontSize: 14 }]} color={palette.greenDeep}>{t('ob_i_link')}</T>
      </View>
    </>
  );
}

function Ill3({ t }: { t: TF }) {
  const file = (ext: string, label: DictKey) => (
    <View key={ext} style={s.file}>
      <View style={s.tag}><T style={s.stText} color={palette.muted2}>{ext}</T></View>
      <T style={[s.stText, { lineHeight: 22 }]}>{t(label)}</T>
    </View>
  );
  return (
    <>
      <View style={[abs({ left: 22, top: 30, width: 314, height: 150 }), { backgroundColor: palette.ink, borderRadius: 6, padding: 3, gap: 3 }]}>
        <View style={{ flex: 1, flexDirection: 'row', gap: 3 }}><Wood style={{ flex: 2 }} /><Wood /></View>
        <View style={{ flex: 1, flexDirection: 'row', gap: 3 }}>
          <Wood style={{ flex: 2 }} />
          <ImageBackground source={require('../assets/illus/hatch.png')} resizeMode="repeat" style={{ flex: 1 }} />
        </View>
      </View>
      <St fg={palette.muted2} bg={palette.white} style={abs({ left: 32, top: 146 })}>{t('ob_i_nest')}</St>
      <View style={[abs({ left: 22, right: 22, top: 200 }), { flexDirection: 'row', gap: 6 }]}>
        {file('DXF', 'ob_i_parts')}{file('CSV', 'ob_i_cutlist')}{file('PDF', 'ob_i_drawings')}
      </View>
      <View style={[abs({ left: 22, right: 22, bottom: 24, height: 52 }), { borderRadius: 16, backgroundColor: palette.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 16, paddingRight: 8 }]}>
        <T style={{ fontSize: 15, fontWeight: '600' }} color={palette.white}>{t('ob_i_order')}</T>
        <View style={{ backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10 }}>
          <T style={{ fontSize: 14, lineHeight: 20, fontWeight: '600' }} color={palette.white}>{t('ob_i_free')}</T>
        </View>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.ground },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 4, minHeight: 74 },
  brand: { fontSize: 18, lineHeight: 24, fontWeight: '700', letterSpacing: -0.36 },
  ill: { flexShrink: 1, height: ILL_H, minHeight: 300, marginTop: 12, marginHorizontal: 16, borderRadius: 32, backgroundColor: palette.white, overflow: 'hidden' },
  canvas: { position: 'absolute', left: 0, width: ILL_W, height: ILL_H },
  text: { paddingTop: 24, paddingHorizontal: 24, gap: 10 },
  dots: { flexDirection: 'row', gap: 6, justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.handle },
  dotOn: { width: 24, backgroundColor: palette.green },
  title: { marginTop: 8, fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.75 },
  photo: { borderRadius: 18, backgroundColor: '#E7DFD2', transform: [{ rotate: '-5deg' }], shadowColor: palette.ink, shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 8 } },
  st: { height: 26, paddingHorizontal: 10, borderRadius: 9, flexDirection: 'row', alignItems: 'center' },
  stText: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  est: { fontSize: 13, lineHeight: 22 },
  ar: { fontSize: 10, lineHeight: 14, fontWeight: '600' },
  file: { flex: 1, height: 64, borderRadius: 14, backgroundColor: palette.ground, alignItems: 'flex-start', justifyContent: 'center', gap: 4, paddingHorizontal: 10 },
  tag: { height: 24, paddingHorizontal: 9, borderRadius: 8, backgroundColor: palette.ground, justifyContent: 'center' },
});
