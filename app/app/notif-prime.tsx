/**
 * NotifPrime.dc.html: объяснение перед системным запросом уведомлений («момент ценности»).
 * «Включить» → системный запрос и токен на сервер; «Не сейчас» — назад (спросим снова позже из профиля).
 */
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useT, type DictKey } from '../src/i18n';
import { syncPushToken } from '../src/services/push';
import { BrandLogo } from '../src/ui/Illus';
import { Button, Card, ListItem, Screen, T, Tile } from '../src/ui/kit';
import { palette } from '../src/ui/theme';

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

function Note({ title, sub, time, top, scale = 1, opacity = 1 }: { title: string; sub: string; time: string; top: number; scale?: number; opacity?: number }) {
  return (
    <View style={[s.nt, { top, opacity, transform: [{ scale }] }]}>
      <BrandLogo size={36} />
      <View style={{ flex: 1 }}>
        <T style={s.ntB}>{title}</T>
        <T style={s.ntS}>{sub}</T>
      </View>
      <T style={s.ntTm}>{time}</T>
    </View>
  );
}

export default function NotifPrime() {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try { await syncPushToken(true); } catch { /* отказ в системном окне — не ошибка */ } finally { setBusy(false); close(); }
  };
  const n = (k: 1 | 2 | 3, f: 't' | 's') => t(`np_n${k}_${f}` as DictKey);
  return (
    <Screen
      edges={['top']}
      contentStyle={{ paddingTop: 24, gap: 14 }}
      footer={(
        <>
          <Button icon="notifications-outline" title={t('np_enable')} onPress={enable} loading={busy} />
          <Button v="ghost" color={palette.ink} title={t('np_later')} onPress={close} />
          <T v="cap" center style={{ fontSize: 13, lineHeight: 18 }}>{t('np_hint')}</T>
        </>
      )}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.stage} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Note top={22} scale={0.94} opacity={0.7} title={n(1, 't')} sub={n(1, 's')} time={t('np_n1_tm')} />
        <Note top={100} scale={0.97} title={n(2, 't')} sub={n(2, 's')} time="09:30" />
        <Note top={182} title={n(3, 't')} sub={n(3, 's')} time={t('np_now')} />
      </View>
      <View style={{ paddingTop: 4, paddingHorizontal: 8 }}>
        <T style={s.ttl}>{t('np_title')}</T>
        <T v="cap" style={{ fontSize: 15, lineHeight: 21, marginTop: 8 }}>{t('np_text')}</T>
      </View>
      <Card padded={false}>
        <ListItem left={<Tile icon="time-outline" size="s" />} title={t('np_quiet')} subtitle={t('np_quiet_sub')} />
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  stage: { height: 300, borderRadius: 28, backgroundColor: palette.greenSoft, overflow: 'hidden' },
  nt: {
    position: 'absolute', left: 16, right: 16, backgroundColor: palette.white, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 14,
    flexDirection: 'row', gap: 12, alignItems: 'flex-start',
    shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
  },
  ntB: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  ntS: { fontSize: 14, lineHeight: 19, color: palette.muted2, marginTop: 1 },
  ntTm: { fontSize: 12, lineHeight: 16, color: palette.faint },
  ttl: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.7 },
});
