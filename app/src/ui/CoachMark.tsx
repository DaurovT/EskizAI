/**
 * SCR-41 подсказки поверх экрана (OnboardingHints.dc.html): затемнение с «окном» над целью, зелёное кольцо (.ring)
 * и тёмная карточка .tip (шаг, заголовок, текст, кнопки). Цель под окном остаётся живой — её можно нажать.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Press, T } from './base';
import { palette } from './theme';

export interface HoleRect { x: number; y: number; w: number; h: number; r: number }

// толщина рамки-затемнения вокруг окна: перекрывает экран телефона, но слой (×3 px) не больше 8192 px текстуры
const BIG = 900;

export function CoachMark({ hole, tipTop, tipBottom, label, title, text, actions }: {
  hole?: HoleRect | null;
  /** Положение карточки: сверху (от верха контейнера) или снизу. */
  tipTop?: number; tipBottom?: number;
  label?: string; title: string; text?: string;
  actions: { label: string; onPress: () => void; primary?: boolean }[];
}) {
  const { height } = useWindowDimensions();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {hole ? (
        <>
          {/* окно со скруглением: рамка BIG цвета затемнения вокруг прозрачной середины */}
          <View pointerEvents="none" style={{
            position: 'absolute', left: hole.x - BIG, top: hole.y - BIG, width: hole.w + 2 * BIG, height: hole.h + 2 * BIG,
            borderWidth: BIG, borderRadius: hole.r + BIG, borderColor: palette.scrim,
          }} />
          {/* кольцо: 3 px #8FD3A6 + ореол до 7 px */}
          <View pointerEvents="none" style={{ position: 'absolute', left: hole.x - 7, top: hole.y - 7, width: hole.w + 14, height: hole.h + 14, borderRadius: hole.r + 7, borderWidth: 4, borderColor: 'rgba(159,212,195,0.35)' }} />
          <View pointerEvents="none" style={{ position: 'absolute', left: hole.x - 3, top: hole.y - 3, width: hole.w + 6, height: hole.h + 6, borderRadius: hole.r + 3, borderWidth: 3, borderColor: palette.greenOnDark }} />
        </>
      ) : <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]} />}
      {/* касания мимо окна не проходят к экрану */}
      {hole ? <Blockers hole={hole} screenH={height} /> : <View style={StyleSheet.absoluteFill} />}
      <View style={[s.tip, tipTop != null ? { top: tipTop } : { bottom: tipBottom ?? 0 }]} accessibilityViewIsModal accessibilityLiveRegion="polite">
        {label ? <T style={s.lbl} color={palette.greenOnDark}>{label}</T> : null}
        <T style={s.tt} color={palette.white}>{title}</T>
        {text ? <T style={s.td} color="#D9D6CF">{text}</T> : null}
        <View style={s.act}>
          {actions.map((a) => (
            <Press key={a.label} feedback={a.primary ? 'scale' : 'opacity'} onPress={a.onPress} accessibilityRole="button" style={[s.tb, a.primary && { backgroundColor: palette.white }]}>
              <T style={s.tbText} color={a.primary ? palette.ink : '#D9D6CF'}>{a.label}</T>
            </Press>
          ))}
        </View>
      </View>
    </View>
  );
}

/** Четыре прямоугольника вокруг окна перехватывают касания. */
function Blockers({ hole, screenH }: { hole: HoleRect; screenH: number }) {
  const b = (st: object): ReactNode => <View style={[{ position: 'absolute' }, st]} />;
  return (
    <>
      {b({ left: 0, right: 0, top: -screenH, height: screenH + hole.y })}
      {b({ left: 0, right: 0, top: hole.y + hole.h, height: screenH * 2 })}
      {b({ left: 0, width: hole.x, top: hole.y, height: hole.h })}
      {b({ left: hole.x + hole.w, right: 0, top: hole.y, height: hole.h })}
    </>
  );
}

const s = StyleSheet.create({
  tip: {
    position: 'absolute', left: 12, right: 12, backgroundColor: palette.ink, borderRadius: 28, paddingTop: 18, paddingHorizontal: 18, paddingBottom: 14, gap: 6,
    shadowColor: palette.ink, shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 12 }, elevation: 12,
  },
  lbl: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  tt: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  td: { fontSize: 15, lineHeight: 21 },
  act: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 6 },
  tb: { height: 44, borderRadius: 14, paddingHorizontal: 18, justifyContent: 'center' },
  tbText: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
});
