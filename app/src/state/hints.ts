/** SCR-41: подсказки на примере показываем один раз; «вернуть» — в профиле → Помощь. */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'mebel.hints.done';

export async function hintsDone(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(KEY)) === '1'; } catch { return true; }
}
export function setHintsDone(done = true): void {
  (done ? AsyncStorage.setItem(KEY, '1') : AsyncStorage.removeItem(KEY)).catch(() => undefined);
}
