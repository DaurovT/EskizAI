/**
 * Paywall.dc.html: пакет 10 проектов / Pro / файлы проекта. Оплаты в приложении пока нет (нужны покупки в сторах
 * и API) — кнопка сообщает об этом; выбор и цены показываем по макету.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { api } from '../src/api';
import { useResource } from '../src/hooks/useResource';
import { useT, type DictKey } from '../src/i18n';
import { Button, IconButton, Press, Screen, T } from '../src/ui/kit';
import { palette } from '../src/ui/theme';

const PLANS = ['pack', 'pro', 'files'] as const;

export default function Paywall() {
  const { t } = useT();
  const limits = useResource(() => api.limits(), []);
  const [sel, setSel] = useState<(typeof PLANS)[number]>('pack');
  const k = (p: string, f: string) => t(`pw_${p}${f}` as DictKey);
  const out = limits.data ? limits.data.free_left <= 0 && limits.data.pack_left <= 0 && !limits.data.unlimited : false;
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return (
    <Screen
      edges={['top']}
      contentStyle={{ paddingTop: 4, gap: 8 }}
      header={<View style={s.hdr}><IconButton icon="close" label={t('close')} onPress={close} /></View>}
      footer={(
        <>
          <Button title={k(sel, '_cta')} value={sel === 'pro' ? t('pw_pro_v') : k(sel, '_price')} onPress={() => Alert.alert(t('profile_buy_soon'))} />
          <T v="cap" center style={{ fontSize: 13, lineHeight: 18 }}>{t('pw_stores')}</T>
        </>
      )}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <T style={s.ttl}>{out ? t('pw_title_out') : t('pw_title')}</T>
      <T v="cap" style={{ paddingHorizontal: 8, paddingBottom: 6, fontSize: 15, lineHeight: 20 }}>{t('pw_sub')}</T>
      {PLANS.map((p) => {
        const on = sel === p;
        return (
          <Press key={p} onPress={() => setSel(p)} style={[s.plan, on && { backgroundColor: palette.ink }]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
            <View style={[s.rd, on && s.rdOn]} />
            <T style={s.pn} color={on ? palette.white : palette.ink}>{k(p, '')}</T>
            <T num style={s.pp} color={on ? palette.white : palette.ink}>{k(p, '_price')}</T>
            <T style={s.pd} color={on ? palette.chev : palette.muted}>{k(p, '_desc')}</T>
          </Press>
        );
      })}
      <View style={{ gap: 10, paddingTop: 8, paddingHorizontal: 8 }}>
        {(['pw_b1', 'pw_b2'] as const).map((b) => (
          <View key={b} style={s.li}>
            <View style={s.liIco}><Ionicons name="checkmark" size={16} color={palette.greenDeep} /></View>
            <T style={{ flex: 1, fontSize: 15, lineHeight: 20 }}>{t(b)}</T>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  hdr: { flexDirection: 'row', alignItems: 'center', paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, minHeight: 72 },
  ttl: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.75, paddingHorizontal: 8 },
  plan: { backgroundColor: palette.white, borderRadius: 24, paddingVertical: 18, paddingHorizontal: 20, gap: 4 },
  rd: { position: 'absolute', right: 18, top: 18, width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: palette.handle },
  rdOn: { borderWidth: 6, borderColor: palette.green, backgroundColor: palette.white },
  pn: { fontSize: 18, lineHeight: 23, fontWeight: '700' },
  pp: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.44, marginTop: 2 },
  pd: { fontSize: 14, lineHeight: 19 },
  li: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  liIco: { width: 28, height: 28, borderRadius: 10, backgroundColor: palette.greenSoft, alignItems: 'center', justifyContent: 'center' },
});
