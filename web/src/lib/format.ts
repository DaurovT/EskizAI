import { t } from './i18n';
import type { Lang, SumRange } from './share-types';

const NBSP = '\u00A0';
const TZ_MS = 5 * 3600 * 1000; // Ташкент UTC+5

/** 3450000 → "3 450 000" (неразрывные пробелы). */
export function groupDigits(n: number): string {
  const s = Math.round(Math.abs(n)).toString();
  const out = s.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return n < 0 ? `−${out}` : out;
}

export function formatSum(n: number, lang: Lang): string {
  return `${groupDigits(n)}${NBSP}${t(lang, 'sum')}`;
}

/** Число с одним знаком после запятой без «,0»: 6.1 → "6,1", 10 → "10". */
function dec1(x: number): string {
  const s = (Math.round(x * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s.replace('.', ',');
}

type Unit = 'mln' | 'thousand';

function unitOf(n: number): Unit {
  return n >= 1_000_000 ? 'mln' : 'thousand';
}

/** Значение в единицах: «от» округляем вниз, «до» — вверх, чтобы диапазон не сужался. */
function inUnit(n: number, u: Unit, dir: 'down' | 'up'): string {
  if (u === 'mln') {
    const x = n / 1_000_000;
    const r = dir === 'down' ? Math.floor(x * 10 + 1e-9) / 10 : Math.ceil(x * 10 - 1e-9) / 10;
    return dec1(r);
  }
  const k = n / 1000;
  return String(dir === 'down' ? Math.floor(k + 1e-9) : Math.ceil(k - 1e-9));
}

/**
 * Сумма для клиента без «сум»: точная — полностью ("2 400 000"),
 * диапазон — коротко, как в макете ("6,1–6,3 млн", "800–950 тыс").
 */
export function formatAmount(p: SumRange, lang: Lang, exact = false): string {
  if (exact || p.from === p.to) return groupDigits(p.from);
  const uf = unitOf(p.from);
  const ut = unitOf(p.to);
  if (uf === ut) return `${inUnit(p.from, uf, 'down')}–${inUnit(p.to, ut, 'up')}${NBSP}${t(lang, ut)}`;
  return `${inUnit(p.from, uf, 'down')}${NBSP}${t(lang, uf)} – ${inUnit(p.to, ut, 'up')}${NBSP}${t(lang, ut)}`;
}

/** То же с «сум» — для превью ссылки и текстов. */
export function formatPrice(p: SumRange, lang: Lang, exact = false): string {
  return `${formatAmount(p, lang, exact)}${NBSP}${t(lang, 'sum')}`;
}

/** Габарит [ширина, высота, глубина] → "1600 × 600 × 2400" (Ш × Г × В, как в макетах). */
export function formatSize(sizeMm: [number, number, number]): string {
  const [w, h, d] = sizeMm.map((v) => Math.round(v));
  return `${w}${NBSP}×${NBSP}${d}${NBSP}×${NBSP}${h}`;
}

/** ISO → "02.11.2026" (одинаково для рус и узб). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (x: number) => String(x).padStart(2, '0');
  // Ташкент UTC+5, без зависимости от часового пояса сервера/устройства.
  const tz = new Date(d.getTime() + TZ_MS);
  return `${pad(tz.getUTCDate())}.${pad(tz.getUTCMonth() + 1)}.${tz.getUTCFullYear()}`;
}

const MONTHS: Record<Lang, string[]> = {
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'],
};

/** ISO → "2 ноября" / "2-noyabr"; withTime — "2 ноября, 14:20". */
export function formatDay(iso: string, lang: Lang, withTime = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tz = new Date(d.getTime() + TZ_MS);
  const month = MONTHS[lang][tz.getUTCMonth()];
  const day = lang === 'uz' ? `${tz.getUTCDate()}-${month}` : `${tz.getUTCDate()}${NBSP}${month}`;
  if (!withTime) return day;
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${day}, ${pad(tz.getUTCHours())}:${pad(tz.getUTCMinutes())}`;
}

/** "+998901234567" → "+998 90 123 45 67". */
export function formatPhone(e164: string): string {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(e164);
  return m ? `+998${NBSP}${m[1]}${NBSP}${m[2]}${NBSP}${m[3]}${NBSP}${m[4]}` : e164;
}

/** Инициалы цеха для круглого логотипа: «Мебель Плюс» → «МП». */
export function initials(name: string): string {
  const words = name
    .replace(/[«»"'“”„()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0] ?? '');
  return letters.join('').toUpperCase() || '·';
}
