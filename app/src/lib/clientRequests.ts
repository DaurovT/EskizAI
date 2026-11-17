/**
 * «Просьбы клиентов» (SCR-58, ClientRequests.dc.html / TRequests.dc.html): подписи строк, счётчики, текст для чата
 * редактора. Без React — покрыто тестами (src/lib/__tests__/clientRequests.test.ts).
 */
import type { ClientRequestOut, Lang } from '../api/types';

/** Инициалы для кружка: «Азиз Каримов» → «АК», «Дилноза Р.» → «ДР», пусто → «·». */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').replace(/[.,]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '·';
}

const WD = { ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'], uz: ['ya', 'du', 'se', 'ch', 'pa', 'ju', 'sh'] } as const;
const MON = {
  ru: ['янв', 'февр', 'марта', 'апр', 'мая', 'июня', 'июля', 'авг', 'сент', 'окт', 'нояб', 'дек'],
  uz: ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'],
} as const;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Когда пришла просьба, коротко (как в макете): сегодня — «14:20», вчера — «вчера», на этой неделе — «пн»,
 * раньше — «3 нояб».
 */
export function shortWhen(iso: string, lang: Lang, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return lang === 'uz' ? 'kecha' : 'вчера';
  if (days < 7) return WD[lang][d.getDay()];
  return shortDate(iso, lang);
}

/** «3 нояб» / «3-noy» — дата коротко, без года (строки таблиц и списков планшета). */
export function shortDate(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return lang === 'uz' ? `${d.getDate()}-${MON.uz[d.getMonth()]}` : `${d.getDate()} ${MON.ru[d.getMonth()]}`;
}

/** Старый сервер статус не отдаёт — считаем просьбу новой. */
export const isNew = (r: Pick<ClientRequestOut, 'status'>) => r.status !== 'done';

export function requestCounts(items: Pick<ClientRequestOut, 'status'>[]): { fresh: number; all: number } {
  return { fresh: items.filter(isNew).length, all: items.length };
}

/** Чат редактора (?ask=) — «Клиент просит: …», без переносов строк и лишних пробелов. */
export const askText = (prefix: string, text: string) => `${prefix}: ${text.replace(/\s+/g, ' ').trim()}`;

/** Telegram по номеру клиента: t.me/+998… (номер без пробелов и скобок). */
export const telegramUrl = (phone: string) => `https://t.me/${phone.replace(/[^\d+]/g, '')}`;

/** Пометить просьбу локально (до ответа сервера): статус и время. */
export function withStatus<R extends ClientRequestOut>(r: R, status: 'new' | 'done', at = new Date().toISOString()): R {
  return { ...r, status, done_at: status === 'done' ? r.done_at ?? at : null };
}
