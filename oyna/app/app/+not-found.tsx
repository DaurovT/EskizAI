/** Нет такой страницы (неверная ссылка) — вместо английского «Unmatched Route». */
import { useRouter } from 'expo-router';

import { Button, Empty, Screen } from '@/ui/kit';

export default function NotFound() {
  const router = useRouter();
  return (
    <Screen>
      <Empty title="Такой страницы нет" text="Возможно, заказ удалён или ссылка неполная"
        action={<Button title="К заказам" onPress={() => router.replace('/orders')} />} />
    </Screen>
  );
}
