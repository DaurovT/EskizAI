import type { Lang, LocalizedText } from './share-types';

/** Строки страницы клиента: русский и узбекский (латиница). Тексты — по макетам docs/design. */
const ru = {
  langName: 'Рус',
  mm: 'мм',
  // 3D
  no3d: '3D не открылось на этом устройстве. Цена и контакты мастера — ниже.',
  openDoors: 'Открыть двери',
  closeDoors: 'Закрыть',
  dims: 'Размеры',
  // смета
  materials: 'Материалы',
  labor: 'Работа мастера',
  total: 'Итого',
  pending: 'уточняется',
  requestsTitle: 'Под запрос',
  exactAfterMeasure: 'Точная цена после замера',
  pendingNote: 'Позиции «под запрос» мастер уточнит отдельно',
  priceOn: 'Цена на {date}',
  priceHidden: 'Стоимость мастер сообщит после замера',
  sum: 'сум',
  mln: 'млн',
  thousand: 'тыс',
  // AR на странице
  arButton: 'Примерить у себя дома (AR)',
  noAr: 'Телефон не поддерживает примерку в комнате. 3D работает: вращайте, открывайте двери, смотрите размеры.',
  arFailed: 'AR не запустился на этом устройстве.',
  tgHint: 'Вы открыли ссылку в Telegram. Если примерка не запускается, откройте страницу в браузере.',
  tgHintIos: 'Чтобы примерить в комнате, откройте страницу в Safari: ⋯ вверху → «Открыть в Safari».',
  tgHintAndroid: 'Если примерка не запускается: ⋮ вверху → «Открыть в браузере».',
  openInBrowser: 'Открыть',
  linkCopied: 'Ссылка скопирована — вставьте её в браузер',
  // WEB-4: шторка AR
  arTitle: 'Примерить в комнате',
  arLead: '{title} встанет в натуральную величину: {size} мм',
  arStep1: 'Встаньте в 2–3 метрах от места, где будет шкаф',
  arStep2: 'Медленно наведите камеру на пол у стены',
  arStep3: 'Нажмите на пол. Шкаф можно двигать и поворачивать пальцем',
  arOpenCamera: 'Открыть камеру',
  arModelSize: 'Модель {mb} МБ · лучше по Wi-Fi',
  arWifi: 'Лучше по Wi-Fi',
  arLoadingTitle: 'Готовим модель',
  arLoadingLead: 'Загружаем шкаф в натуральную величину',
  arProgress: '{done} из {total} МБ',
  arEta: 'ещё ~{s} с',
  arOpenWhenReady: 'Открыть, когда загрузится',
  arOpenNow: 'Открыть камеру',
  cancel: 'Отмена',
  arAfterTitle: 'Как шкаф в комнате?',
  arAfterLead: 'Мастер увидит ваш ответ и позвонит, чтобы договориться о замере',
  wantChange: 'Хочу изменить',
  arAgain: 'Ещё раз в AR',
  // действия
  agree: 'Согласен, жду замер',
  agreeSending: 'Отправляем…',
  agreeError: 'Не удалось отправить. Проверьте интернет и попробуйте ещё раз.',
  alreadyAgreed: 'Вы согласовали {date}',
  call: 'Позвонить',
  telegram: 'Telegram',
  // WEB-2
  agreedTitle: 'Мастер получил\nваш ответ',
  agreedText: '{who} позвонит и договорится о замере. Обычно в течение дня.',
  whoFrom: '{name} из «{workshop}»',
  youAgreed: 'Вы согласовали',
  facade: 'Фасад',
  priceBefore: 'Цена до замера',
  price: 'Цена',
  afterMeasure: 'точная цена после замера',
  view3dAgain: 'Ещё раз посмотреть 3D',
  // WEB-3
  notFoundTitle: 'Ссылка не найдена',
  notFoundText: 'Проверьте ссылку или попросите мастера прислать её ещё раз.',
  expiredTitle: 'Ссылка устарела',
  expiredText: 'Ссылка действует 30 дней, этот срок истёк. Мастер отправит новую с актуальной ценой.',
  revokedTitle: 'Мастер закрыл эту ссылку',
  revokedText: 'Скорее всего, проект изменился и мастер пришлёт новый вариант. Напишите ему, если ждёте.',
  askNewLink: 'Попросить новую ссылку',
  callMaster: 'Позвонить мастеру',
  masterIs: 'мастер {name}',
  madeIn: 'Сделано в Eskiz AI',
};

export type DictKey = keyof typeof ru;

const uz: Record<DictKey, string> = {
  langName: 'O‘zb',
  mm: 'mm',
  no3d: 'Bu qurilmada 3D ochilmadi. Narx va usta kontaktlari quyida.',
  openDoors: 'Eshiklarni ochish',
  closeDoors: 'Yopish',
  dims: 'O‘lchamlar',
  materials: 'Materiallar',
  labor: 'Usta ishi',
  total: 'Jami',
  pending: 'aniqlanmoqda',
  requestsTitle: 'So‘rov bo‘yicha',
  exactAfterMeasure: 'Aniq narx o‘lchovdan keyin',
  pendingNote: '«So‘rov bo‘yicha» pozitsiyalarni usta alohida aniqlaydi',
  priceOn: 'Narx {date} holatiga',
  priceHidden: 'Narxni usta o‘lchovdan keyin aytadi',
  sum: 'so‘m',
  mln: 'mln',
  thousand: 'ming',
  arButton: 'Uyda ko‘rish (AR)',
  noAr: 'Telefon xonada ko‘rishni qo‘llab-quvvatlamaydi. 3D ishlaydi: aylantiring, eshiklarni oching, o‘lchamlarni ko‘ring.',
  arFailed: 'Bu qurilmada AR ishga tushmadi.',
  tgHint: 'Havolani Telegram’da ochdingiz. Agar AR ishlamasa, sahifani brauzerda oching.',
  tgHintIos: 'Xonada ko‘rish uchun sahifani Safari’da oching: yuqorida ⋯ → «Safari’da ochish».',
  tgHintAndroid: 'Agar AR ishlamasa: yuqorida ⋮ → «Brauzerda ochish».',
  openInBrowser: 'Ochish',
  linkCopied: 'Havola nusxalandi — uni brauzerga qo‘ying',
  arTitle: 'Xonada ko‘rish',
  arLead: '{title} haqiqiy o‘lchamda turadi: {size} mm',
  arStep1: 'Shkaf turadigan joydan 2–3 metr narida turing',
  arStep2: 'Kamerani sekin devor yonidagi polga qarating',
  arStep3: 'Polga bosing. Shkafni barmoq bilan surish va aylantirish mumkin',
  arOpenCamera: 'Kamerani ochish',
  arModelSize: 'Model {mb} MB · Wi-Fi orqali yaxshiroq',
  arWifi: 'Wi-Fi orqali yaxshiroq',
  arLoadingTitle: 'Modelni tayyorlayapmiz',
  arLoadingLead: 'Shkafni haqiqiy o‘lchamda yuklayapmiz',
  arProgress: '{done} / {total} MB',
  arEta: 'yana ~{s} s',
  arOpenWhenReady: 'Yuklanganda ochish',
  arOpenNow: 'Kamerani ochish',
  cancel: 'Bekor qilish',
  arAfterTitle: 'Shkaf xonada qanday?',
  arAfterLead: 'Usta javobingizni ko‘radi va o‘lchov vaqtini kelishish uchun qo‘ng‘iroq qiladi',
  wantChange: 'O‘zgartirmoqchiman',
  arAgain: 'Yana AR’da ko‘rish',
  agree: 'Roziman, o‘lchovni kutaman',
  agreeSending: 'Yuborilmoqda…',
  agreeError: 'Yuborib bo‘lmadi. Internetni tekshirib, qayta urinib ko‘ring.',
  alreadyAgreed: 'Siz {date} rozilik bildirdingiz',
  call: 'Qo‘ng‘iroq',
  telegram: 'Telegram',
  agreedTitle: 'Usta javobingizni\noldi',
  agreedText: '{who} qo‘ng‘iroq qilib, o‘lchov vaqtini kelishib oladi. Odatda bir kun ichida.',
  whoFrom: '«{workshop}»dan {name}',
  youAgreed: 'Siz rozi bo‘ldingiz',
  facade: 'Fasad',
  priceBefore: 'O‘lchovgacha narx',
  price: 'Narx',
  afterMeasure: 'aniq narx o‘lchovdan keyin',
  view3dAgain: '3D’ni yana ko‘rish',
  notFoundTitle: 'Havola topilmadi',
  notFoundText: 'Havolani tekshiring yoki ustadan uni qayta yuborishni so‘rang.',
  expiredTitle: 'Havola eskirgan',
  expiredText: 'Havola 30 kun amal qiladi, bu muddat tugadi. Usta yangi narx bilan yangisini yuboradi.',
  revokedTitle: 'Usta bu havolani yopdi',
  revokedText: 'Ehtimol, loyiha o‘zgargan va usta yangi variant yuboradi. Kutayotgan bo‘lsangiz, unga yozing.',
  askNewLink: 'Yangi havola so‘rash',
  callMaster: 'Ustaga qo‘ng‘iroq',
  masterIs: 'usta {name}',
  madeIn: 'Eskiz AI’da yaratilgan',
};

const dict: Record<Lang, Record<DictKey, string>> = { ru, uz };

export const LANGS: Lang[] = ['ru', 'uz'];

export function isLang(v: unknown): v is Lang {
  return v === 'ru' || v === 'uz';
}

export function t(lang: Lang, key: DictKey, vars?: Record<string, string>): string {
  let s = dict[lang][key] ?? dict.ru[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

export function tl(lang: Lang, text: LocalizedText): string {
  return text[lang] || text.ru;
}

/**
 * Ядро отдаёт названия групп и позиций по-русски. Для узбекского — словарь
 * известных названий; неизвестное показываем как есть.
 */
const UZ_NAMES: Record<string, string> = {
  'Листы': 'Plitalar',
  'Кромка': 'Kromka',
  'Распил': 'Kesish',
  'Распил и кромкование': 'Kesish va kromkalash',
  'Фурнитура': 'Furnitura',
  'Фасады': 'Fasadlar',
  'Зеркало и стекло': 'Oyna va shisha',
  'Система купе': 'Kupe tizimi',
  'Прочее': 'Boshqa',
  'уточняется': 'aniqlanmoqda',
};

export function coreName(lang: Lang, ruName: string): string {
  return lang === 'uz' ? (UZ_NAMES[ruName] ?? ruName) : ruName;
}
