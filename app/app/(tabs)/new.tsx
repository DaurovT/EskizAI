import { Redirect } from 'expo-router';

/** Вкладка-кнопка: само нажатие открывает /project/new (см. _layout). Сюда попадают только по ссылке. */
export default function NewTab() {
  return <Redirect href="/project/new" />;
}
