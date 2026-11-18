/** Форматирование для экранов: деньги (сум), размеры, даты — как в макете. */
const nbsp = ' ';

/** 612 500 000 → «612,5 млн»; 96 300 000 → «96,3 млн»; < 1 млн → «850 тыс.» */
export function money(sum?: number | null): string {
  if (sum === null || sum === undefined) return '';
  if (Math.abs(sum) >= 1e9) return `${trim(sum / 1e9)}${nbsp}млрд`;
  if (Math.abs(sum) >= 1e6) return `${trim(sum / 1e6)}${nbsp}млн`;
  if (Math.abs(sum) >= 1e3) return `${Math.round(sum / 1e3)}${nbsp}тыс.`;
  return `${sum}`;
}
/**
 * Число по-русски без Intl (в Hermes разделители у toLocaleString разные на iOS/Android):
 * 1234567.8 → «1 234 567,8»; decimals — знаков после запятой (лишние нули убираются).
 */
export function num(v: number, decimals = 0): string {
  const k = 10 ** decimals;
  const r = Math.round(Math.abs(v) * k) / k;
  const [int, frac = ''] = r.toFixed(decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, nbsp);
  const f = frac.replace(/0+$/, '');
  return `${v < 0 && r !== 0 ? '−' : ''}${grouped}${f ? ',' + f : ''}`;
}
/** Полная сумма с пробелами: 612 500 000 сум */
export function sum(n?: number | null, unit = 'сум'): string {
  if (n === null || n === undefined) return '';
  return `${num(n)}${unit ? nbsp + unit : ''}`;
}
function trim(v: number) {
  return (Math.round(v * 10) / 10).toString().replace('.', ',');
}
/** 1400, 1300 → «1400×1300» (мм, как в замере) */
export function size(w?: number | null, h?: number | null): string {
  return `${w ?? '?'}×${h ?? '?'}`;
}
/** м² → «12,2 м²» */
export function m2(v?: number | null): string {
  return v === null || v === undefined ? '' : `${trim(v)}${nbsp}м²`;
}
export function date(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
/** «сейчас», «5 мин», «вчера», дата */
export function ago(iso?: string | null): string {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'сейчас';
  if (diff < 3600) return `${Math.round(diff / 60)}${nbsp}мин`;
  if (diff < 86400) return `${Math.round(diff / 3600)}${nbsp}ч`;
  if (diff < 172800) return 'вчера';
  return date(iso);
}
/** Логин аккаунта — почта (вход по почте), а не номер. */
export const isEmail = (login?: string | null): boolean => !!login?.includes('@');
/** Номер Узбекистана (+998): ему доступны SMS; остальным — код только в WhatsApp. */
export const isUzPhone = (p?: string | null): boolean => (p ?? '').replace(/\D/g, '').startsWith('998');
/** +998901234567 → +998 90 123 45 67; иностранный номер и почта — как есть */
export function phone(p?: string | null): string {
  if (isEmail(p)) return p ?? '';
  const d = (p ?? '').replace(/\D/g, '');
  if (d.length !== 12 || !d.startsWith('998')) return p ?? '';
  return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}`;
}
/** Статусы заказа (orders.status на сервере) */
export const STATUS_TITLE: Record<string, string> = {
  measure: 'Замер', quoted: 'КП отправлено', agreed: 'Согласован', production: 'В цеху', ready: 'Готов',
  installed: 'Установлен', closed: 'Закрыт', cancelled: 'Отменён',
};
/** Инициалы для кружка компании/человека: «DGN METAL INVEST» → «DG» */
export function initials(name?: string | null): string {
  const words = (name ?? '').replace(/[«»"']/g, '').split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words[0].length > 3) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}
