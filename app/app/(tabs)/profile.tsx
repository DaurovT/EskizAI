/**
 * SCR-18 Профиль (Profile.dc.html): аватар и цех, тариф с полосой лимита и «Купить пакет или Pro»,
 * строки: данные цеха, цены и смета, сотрудники, уведомления · язык, история платежей, поддержка, выйти, удалить аккаунт.
 */
import Constants from 'expo-constants';
import { Tabs, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import type { Lang } from '../../src/api/types';
import { MOCK, SUPPORT_TG } from '../../src/config';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { maskPhone } from '../../src/lib/format';
import { savedPushToken } from '../../src/services/push';
import { setHintsDone } from '../../src/state/hints';
import { useSession } from '../../src/state/session';
import { confirm } from '../../src/ui/dialogs';
import { Button, Card, Group, ListItem, Option, Press, Screen, Sheet, T, toast } from '../../src/ui/kit';
import { palette } from '../../src/ui/theme';

const initials = (n?: string | null) => (n ?? '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '·';

export default function Profile() {
  const { t, lang, setLang } = useT();
  const { user, workshop, isOwner, signOut } = useSession();
  const limits = useResource(() => api.limits(), []);
  const employees = useResource(() => api.listEmployees(), [], { enabled: isOwner });
  const pricing = useResource(() => api.getPricing(), [], { enabled: isOwner });
  const [push, setPush] = useState<boolean | null>(null);
  const [langSheet, setLangSheet] = useState(false);

  useEffect(() => { savedPushToken().then((tk) => setPush(!!tk)); }, []);

  const changeLang = (l: Lang) => {
    setLangSheet(false);
    setLang(l);
    api.updateMe({ language: l }).catch(() => undefined);
  };
  const logout = async () => { if (await confirm(t('profile_logout_confirm'), undefined, t('profile_logout'), t('cancel'), true)) signOut(); };
  const L = limits.data;
  const plan = L?.plan ?? workshop?.plan ?? 'free';
  const used = L ? L.free_limit - L.free_left : 0;
  const p = pricing.data;
  const staff = (employees.data ?? []).filter((e) => e.role === 'employee').length;

  return (
    <Screen edges={['top']} contentStyle={{ paddingTop: 14, gap: 8 }}>
      <Tabs.Screen options={{ headerShown: false }} />
      <Press feedback="opacity" onPress={() => isOwner && router.push('/workshop')} style={s.head} accessibilityRole="button" accessibilityLabel={workshop?.name || t('ws_title')}>
        <View style={s.av}><T style={s.avText} color={palette.white}>{initials(workshop?.name || user?.name)}</T></View>
        <T v="title" style={{ marginTop: 2 }} center>{workshop?.name || t('ws_title')}</T>
        <T v="cap" center>{[workshop?.city, user ? maskPhone(user.phone) : null].filter(Boolean).join(' · ')}</T>
      </Press>

      <Card style={s.plan}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <T style={{ fontSize: 18, lineHeight: 24, fontWeight: '600' }}>{t(plan === 'pro' ? 'pf_plan_pro' : plan === 'pack' ? 'pf_plan_pack' : 'pf_plan_free')}</T>
          {L && !L.unlimited ? <T num style={{ fontSize: 14, lineHeight: 19 }} color={palette.muted}>{t('pf_used', { n: used, total: L.free_limit })}</T> : null}
        </View>
        {L && !L.unlimited ? (
          <View style={s.bar}><View style={[s.barFill, { width: `${Math.min(100, (used / Math.max(1, L.free_limit)) * 100)}%` }]} /></View>
        ) : null}
        {isOwner && plan !== 'pro' ? <Button title={t('pf_buy')} onPress={() => router.push('/paywall')} style={s.buy} /> : null}
      </Card>

      <Group>
        {isOwner ? <ListItem compact style={s.pr} icon="hammer-outline" title={t('pf_ws_data')} onPress={() => router.push('/workshop')} /> : null}
        {isOwner ? (
          <ListItem compact style={s.pr} icon="document-outline" title={t('pf_prices')} chevron onPress={() => router.push('/settings/prices')}
            right={p ? <T num style={s.vv}>{p.labor_mode === 'percent' ? t('pf_labor', { n: p.labor_percent }) : ''}</T> : undefined} />
        ) : null}
        {isOwner ? <ListItem compact style={s.pr} icon="people-outline" title={t('profile_employees')} chevron onPress={() => router.push('/team')} right={<T num style={s.vv}>{String(staff)}</T>} /> : null}
        <ListItem compact style={s.pr} icon="notifications-outline" title={t('profile_push')} chevron
          right={push === false ? <T style={s.vv}>{t('profile_push_off')}</T> : undefined}
          onPress={() => router.push(push === false ? '/notif-prime' : '/notifications')} />
      </Group>

      <Group>
        <ListItem compact style={s.pr} icon="globe-outline" title={t('profile_language')} chevron right={<T style={s.vv}>{lang === 'uz' ? t('lang_uz') : t('lang_ru')}</T>} onPress={() => setLangSheet(true)} />
        {isOwner ? <ListItem compact style={s.pr} icon="card-outline" title={t('pf_history')} onPress={() => router.push('/payments')} /> : null}
        <ListItem compact style={s.pr} icon="paper-plane-outline" title={t('sys_support_tg')} onPress={() => Linking.openURL(`https://t.me/${SUPPORT_TG}`)} />
        <ListItem compact style={s.pr} icon="help-circle-outline" title={t('pf_help')} chevron={false}
          onPress={() => { setHintsDone(false); toast.show({ text: t('pf_help_done'), tone: 'success' }); }} />
        <ListItem compact style={s.pr} icon="close" title={t('profile_logout')} danger chevron={false} onPress={logout} />
        <ListItem compact style={s.pr} icon="trash-outline" title={t('profile_delete_account')} danger chevron onPress={() => router.push('/delete-account')} />
      </Group>

      <T v="cap" center style={{ fontSize: 13, paddingTop: 4 }}>{t('profile_version', { v: Constants.expoConfig?.version ?? '0.1.0' })}{MOCK ? ` · ${t('mock_badge')}` : ''}</T>

      <Sheet visible={langSheet} onClose={() => setLangSheet(false)} title={t('profile_language')}>
        <Option title={t('lang_ru')} selected={lang === 'ru'} onPress={() => changeLang('ru')} />
        <Option title={t('lang_uz')} selected={lang === 'uz'} onPress={() => changeLang('uz')} />
      </Sheet>
    </Screen>
  );
}

const s = StyleSheet.create({
  head: { alignItems: 'center', gap: 6, paddingBottom: 6 },
  av: { width: 64, height: 64, borderRadius: 32, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  avText: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  plan: { paddingTop: 18, paddingHorizontal: 18, paddingBottom: 16, gap: 12 },
  bar: { height: 6, borderRadius: 3, backgroundColor: palette.segOnWhite, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: palette.green },
  buy: { minHeight: 48, height: 48, borderRadius: 14 },
  vv: { fontSize: 15, lineHeight: 20, color: palette.muted },
  // .pr — строки профиля ниже обычных: min-height 48, отступы 4/20
  pr: { minHeight: 48, paddingVertical: 4 },
});
