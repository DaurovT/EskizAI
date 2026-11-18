/** Развилка при запуске: вход → создание цеха → заказы. */
import { Redirect } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';
import { Loading } from '@/ui/kit';

export default function Index() {
  const { ready, user, company } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <Redirect href="/login" />;
  if (!company) return <Redirect href="/setup" />;
  return <Redirect href="/orders" />;
}
