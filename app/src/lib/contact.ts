import { Linking } from 'react-native';

/** Звонок и Telegram в один тап (SCR-17/33). Telegram открываем по номеру: t.me/+998… */
export const callPhone = (phone: string) => Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`);
export const openTelegramPhone = (phone: string) => Linking.openURL(`https://t.me/${phone.replace(/[^\d+]/g, '')}`);

/** «Отправить в Telegram»: системный выбор чата с готовым текстом и ссылкой. */
export async function shareToTelegram(url: string, text: string) {
  const tg = `tg://msg_url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const web = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  try {
    if (await Linking.canOpenURL(tg)) return await Linking.openURL(tg);
  } catch {
    /* на Android 11+ canOpenURL без <queries> может врать — пробуем веб-вариант */
  }
  return Linking.openURL(web);
}
