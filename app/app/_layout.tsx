import { DIAG, diagLog, installDiag } from '../src/diag';
import { SHOTS } from '../src/dev/shot';
import NetInfo from '@react-native-community/netinfo';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Stack, router, useSegments } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Onest_400Regular } from '@expo-google-fonts/onest/400Regular';
import { Onest_500Medium } from '@expo-google-fonts/onest/500Medium';
import { Onest_600SemiBold } from '@expo-google-fonts/onest/600SemiBold';
import { Onest_700Bold } from '@expo-google-fonts/onest/700Bold';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api } from '../src/api';
import { API_URL } from '../src/config';
import { I18nProvider, useT } from '../src/i18n';
import { checkAppStatus, useSystemScreen } from '../src/state/appStatus';
import { netState } from '../src/state/net';
import { SessionProvider, useSession } from '../src/state/session';
import { useOnboarded } from '../src/state/onboarding';
import { AppSplash } from '../src/ui/AppSplash';
import { shareStore } from '../src/state/shareIntent';
import { syncPushToken } from '../src/services/push';
import { routeForPush, type PushData } from '../src/lib/pushRoute';
import { DialogHost, Loading, ToastHost } from '../src/ui/kit';
import { StackHeader } from '../src/ui/navigation';
import { SystemScreen } from '../src/ui/SystemScreen';
import { colors } from '../src/ui/theme';

// EXPO_PUBLIC_DIAG=1: журнал Documents/diag.log и перехват глобальных ошибок — до всего остального
installDiag();

// заставка держится, пока не загрузится шрифт Onest (см. RootLayout)
SplashScreen.preventAutoHideAsync().catch(() => undefined);

// «Есть сеть» = отвечает наш сервер. По умолчанию NetInfo проверяет доступность Google — при живом сервере
// (локальная сеть, блокировки) это давало ложное «нет сети» и выключало кнопки.
if (API_URL) {
  NetInfo.configure({
    reachabilityUrl: `${API_URL}/health`,
    reachabilityMethod: 'GET',
    reachabilityTest: async (r) => r.status === 200,
  });
}

/** В Expo Go нативного модуля «Поделиться» нет — отключаем (запасной путь: галерея). */
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

function ShareIntentBridge() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { status } = useSession();
  useEffect(() => {
    if (!hasShareIntent || status !== 'signedIn') return;
    const images = (shareIntent.files ?? [])
      .filter((f) => (f.mimeType ?? '').startsWith('image/'))
      .slice(0, 5)
      .map((f) => ({ uri: f.path, mimeType: f.mimeType, name: f.fileName, width: f.width, height: f.height, size: f.size }));
    shareStore.set({ pending: { images, text: shareIntent.text ?? shareIntent.webUrl ?? null } });
    resetShareIntent();
    router.push('/project/new');
  }, [hasShareIntent, shareIntent, status, resetShareIntent]);
  return null;
}

function Gate() {
  const { status, workshop, invite } = useSession();
  const system = useSystemScreen();
  const segments = useSegments();
  const { t } = useT();
  const onboarded = useOnboarded();

  useEffect(() => {
    if (status === 'loading' || onboarded === null) return;
    const inLogin = segments[0] === 'login';
    const inAuth = inLogin || segments[0] === 'onboarding';
    // /diag (только при EXPO_PUBLIC_DIAG=1) открывается без входа: проверка 3D на устройстве по ссылке mebelmaster://diag
    if (DIAG && segments[0] === 'diag') return;
    // служебные снимки экранов (DIAG/dev) — без перенаправлений
    if (SHOTS && segments[0] === 'shot') return;
    // SCR-00a: первый запуск — онбординг до входа (один раз)
    if (status === 'signedOut' && !inAuth) router.replace(onboarded ? '/login' : '/onboarding');
    // приглашение в цех (SCR-38a) — до онбординга; принято / отклонено — дальше как обычно
    const inInvite = segments[0] === 'invite';
    if (status === 'signedIn' && invite && !inInvite) { router.replace('/invite'); return; }
    if (status === 'signedIn' && !invite && inInvite) { router.replace(workshop && !workshop.name ? '/workshop' : '/'); return; }
    // после входа: новый цех без названия → SCR-02, иначе — список проектов
    if (status === 'signedIn' && inLogin) router.replace(workshop && !workshop.name ? '/workshop' : '/');
  }, [status, segments, workshop, invite, onboarded]);

  // SCR-45: версия приложения и техработы — при запуске и при возврате в приложение
  useEffect(() => {
    checkAppStatus();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') checkAppStatus(); });
    return () => sub.remove();
  }, []);

  // сеть: офлайн-плашка и отправка отложенных замеров при появлении связи
  useEffect(() => NetInfo.addEventListener((s) => {
    const online = s.isConnected !== false && s.isInternetReachable !== false;
    if (DIAG) diagLog(`net type=${s.type} connected=${s.isConnected} reachable=${s.isInternetReachable}`);
    netState.setOnline(online);
    if (online) api.flushOutbox().catch(() => undefined);
  }), []);

  // push: токен — после входа, без системного запроса (запрос — в профиле и после первой отправки)
  useEffect(() => { if (status === 'signedIn') syncPushToken(false).catch(() => undefined); }, [status]);

  // тап по уведомлению → проект (или заказ, цены под запрос, нестандарт — по data с сервера); и при холодном старте
  useEffect(() => {
    if (status !== 'signedIn') return;
    const open = (r: Notifications.NotificationResponse | null) => {
      const to = routeForPush(r?.notification.request.content.data as PushData | undefined);
      if (to) router.push(to as never);
    };
    Notifications.getLastNotificationResponseAsync().then(open).catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [status]);

  if (status === 'loading') return <Loading />;
  return (
    <>
    <Stack
      screenOptions={{
        // шапка V3 (круглая «назад» + большой заголовок): экраны задают title/headerRight как раньше
        header: (p) => <StackHeader {...p} />,
        headerBackTitle: t('back'),
        contentStyle: { backgroundColor: colors.bg },
        // вперёд — справа, свайп от края — назад (на iOS — системный push с параллаксом 30 %)
        animation: Platform.OS === 'android' ? 'slide_from_right' : 'default',
        animationDuration: 320,
        gestureEnabled: true,
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false, animation: 'fade' }} />
      <Stack.Screen name="project/new" options={{ presentation: 'fullScreenModal', headerShown: false }} />
      <Stack.Screen name="diag" options={{ title: 'DIAG · 3D' }} />
    </Stack>
    {/* SCR-45 поверх навигации: обязательное обновление и техработы блокируют, «новая версия» — до «Позже» */}
    {system ? <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}><SystemScreen screen={system} /></View> : null}
    <ToastHost />
    <DialogHost />
    </>
  );
}

/** SCR-00: заставка держится, пока читаются сессия и флаг онбординга (не дольше ~1,5 с). */
function SplashHost({ onDone }: { onDone: () => void }) {
  const { status } = useSession();
  const onboarded = useOnboarded();
  return <AppSplash ready={status !== 'loading' && onboarded !== null} onDone={onDone} />;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ Onest_400Regular, Onest_500Medium, Onest_600SemiBold, Onest_700Bold });
  // шрифт не загрузился за 4 с — не держим заставку (текст будет системным шрифтом)
  const [fontTimeout, setFontTimeout] = useState(false);
  useEffect(() => { const id = setTimeout(() => setFontTimeout(true), 4000); return () => clearTimeout(id); }, []);
  const ready = fontsLoaded || !!fontError || fontTimeout;
  // нативную заставку снимает AppSplash (SCR-00), когда нарисуется поверх, — без мигания
  const [splash, setSplash] = useState(true);
  if (!ready) return null;
  return (
    <ShareIntentProvider options={{ disabled: IN_EXPO_GO, resetOnBackground: true }}>
      <SafeAreaProvider>
        <I18nProvider>
          <SessionProvider>
            <StatusBar style="dark" />
            {!IN_EXPO_GO ? <ShareIntentBridge /> : null}
            <Gate />
            {splash ? <SplashHost onDone={() => setSplash(false)} /> : null}
          </SessionProvider>
        </I18nProvider>
      </SafeAreaProvider>
    </ShareIntentProvider>
  );
}
