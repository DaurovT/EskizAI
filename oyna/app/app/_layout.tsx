import '@/dev/logCapture';
import { Onest_400Regular, Onest_500Medium, Onest_600SemiBold, Onest_700Bold, useFonts } from '@expo-google-fonts/onest';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { LogBox } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '@/auth/AuthContext';
import { DevNav } from '@/dev/DevNav';
import { startAutoSync } from '@/offline/store';
import { C } from '@/theme';

void SplashScreen.preventAutoHideAsync();
// безобидное предупреждение RN об анимациях без подписчиков (как в Temir) — не мешает сверке экранов
LogBox.ignoreLogs(['Sending `onAnimatedValueUpdate` with no listeners registered']);

const SHEET = { presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } } as const;

export default function RootLayout() {
  const [fonts] = useFonts({ Onest_400Regular, Onest_500Medium, Onest_600SemiBold, Onest_700Bold });
  useEffect(() => { if (fonts) void SplashScreen.hideAsync(); }, [fonts]);
  useEffect(() => startAutoSync(), []);                 // замеры уходят на сервер, как только появилась сеть
  if (!fonts) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="dark" />
          {__DEV__ ? <DevNav /> : null}
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
            {/* листы поверх экрана (макет: .scrim + .bs) */}
            <Stack.Screen name="order/[id]/alternatives" options={SHEET} />
            <Stack.Screen name="order/[id]/swap" options={SHEET} />
            <Stack.Screen name="order/[id]/conflict" options={SHEET} />
            <Stack.Screen name="resume" options={SHEET} />
          </Stack>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
