import type { Lang, PriceRange } from '../api/types';

const sum = { ru: 'сум', uz: 'so‘m' } as const;
const mln = { ru: 'млн', uz: 'mln' } as const;

/** 9800000 → «9,8». Округление до 0,1 млн, запятая — десятичный разделитель (ru и uz). */
const millions = (v: number) => {
  const x = Math.round(v / 100_000) / 10;
  return (Number.isInteger(x) ? String(x) : x.toFixed(1)).replace('.', ',');
};

/** 12345678 → «12 345 678» (неразрывный пробел U+00A0, как toLocaleString('ru-RU') в макетах). */
export const groupDigits = (v: number) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function formatMoney(v: number, lang: Lang): string {
  return `${groupDigits(v)} ${sum[lang]}`;
}

/** Диапазон «от–до»: «9,8–11,2 млн»; точная цена — «9 800 000 сум». */
export function formatRange(r: PriceRange | null | undefined, lang: Lang): string {
  if (!r) return '—';
  if (r.from === r.to) return r.from >= 1_000_000 ? `${millions(r.from)} ${mln[lang]} ${sum[lang]}` : formatMoney(r.from, lang);
  if (r.to >= 1_000_000) return `${millions(r.from)}–${millions(r.to)} ${mln[lang]} ${sum[lang]}`;
  return `${groupDigits(r.from)}–${groupDigits(r.to)} ${sum[lang]}`;
}

export function formatDelta(d: PriceRange | null | undefined, lang: Lang): string | null {
  if (!d) return null;
  const diff = d.to - d.from;
  if (!diff) return null;
  const sign = diff > 0 ? '+' : '−';
  const abs = Math.abs(diff);
  return `${sign}${abs >= 1_000_000 ? `${millions(abs)} ${mln[lang]}` : groupDigits(abs)} ${sum[lang]}`;
}

export const formatMm = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}`);

export function formatDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  void lang;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

const MONTHS = {
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
} as const;
/** «12 октября» / «12-oktabr» (год — только если не текущий). */
export function formatDayMonth(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return lang === 'uz' ? `${d.getDate()}-${MONTHS.uz[d.getMonth()]}${y}` : `${d.getDate()} ${MONTHS.ru[d.getMonth()]}${y}`;
}

/** +998901234567 → «+998 90 123 45 67». */
export function formatPhone(p: string | null | undefined): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('998')) return `+998 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}`;
  return p;
}

/** «+998 90 953 •• ••» — номер в подтверждениях (последние цифры скрыты). */
export function maskPhone(p: string | null | undefined): string {
  const d = (p ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('998')) return `+998 ${d.slice(3, 5)} ${d.slice(5, 8)} •• ••`;
  return formatPhone(p);
}

/** Ввод мастера → +998XXXXXXXXX (9 цифр после кода). null — номер неполный. */
export function normalizePhone(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.length === 9) d = `998${d}`;
  return d.length === 12 && d.startsWith('998') ? `+${d}` : null;
}

/** «лист|листа|листов» → форма для n по правилам русского (для узбекского все три формы одинаковые). */
export function plural(n: number, forms: string): string {
  const [one, few = one, many = few] = forms.split('|');
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** «9,2–10,5 млн сум» → «9,2–10,5 млн» (в макетах суммы в строках без валюты). */
export const noCurrency = (s: string) => s.replace(/\s(сум|so‘m)$/, '');

/** «2 ноября, 15:10». */
export function formatDayTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatDayMonth(iso, lang)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
