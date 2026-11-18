/**
 * Шапка главных вкладок (макет Orders/OrdersEmpty): слева кружок цеха (→ профиль), справа слот, ниже крупный заголовок.
 */
import { useRouter } from 'expo-router';
import { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useAuth } from '@/auth/AuthContext';
import { initials } from '@/lib/format';
import { C } from '@/theme';
import { Txt } from './kit';

export function MainHeader({ title, right }: { title: string; right?: ReactNode }) {
  const router = useRouter();
  const { company } = useAuth();
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Профиль цеха" onPress={() => router.push('/profile')}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center' }}>
          <Txt size={15} w={700} color="#fff">{initials(company?.name)}</Txt>
        </Pressable>
        <View style={{ flex: 1 }} />
        {right}
      </View>
      <Txt size={30} w={700} style={{ lineHeight: 36, letterSpacing: -0.75, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 }}>{title}</Txt>
    </View>
  );
}
