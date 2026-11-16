/**
 * «Входящие чертежи» из Eskiz DWG (SCR-52…55): ссылки, ссылка «Открыть в Eskiz DWG», разбивка списка, подписи.
 * Без React — проверяется тестами (src/lib/__tests__/inbox.test.ts).
 */
import type { InboxDrawing, InboxDrawingDetail, Lang } from '../api/types';
import { formatDate, formatDayMonth, plural } from './format';

/** Схема Eskiz DWG: `canOpenURL` её видит, только если она есть в LSApplicationQueriesSchemes (app.json + Info.plist). */
export const DWG_SCHEME = 'eskizdwg://';
/**
 * Страница Eskiz DWG в App Store / Google Play.
 * TODO: настоящие ссылки пришлёт команда DWG после публикации (пока — поиск по названию).
 */
export const DWG_STORE_URL = {
  ios: 'https://apps.apple.com/search?term=Eskiz%20DWG',
  android: 'https://play.google.com/store/search?q=Eskiz%20DWG&c=apps',
} as const;

/** Путь от адреса API (`/signed-files/…`) → полная ссылка; полную и пустую оставляет как есть. */
export function absUrl(base: string, url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `${base.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Ответ сервера → ссылки полные (картинки и «Открыть в Eskiz DWG» берут их без токена). */
export function withAbsUrls<D extends InboxDrawing | InboxDrawingDetail>(base: string, d: D): D {
  const out = { ...d, preview_url: absUrl(base, d.preview_url) } as D;
  if ('sheets' in d) {
    const det = out as InboxDrawingDetail;
    det.sheets = (d.sheets ?? []).map((s) => ({ ...s, preview_url: absUrl(base, s.preview_url) }));
    det.download_url = absUrl(base, d.download_url) ?? '';
  }
  return out;
}

/** `eskizdwg://open?src=<https-ссылка>&name=<имя файла>` (договорённость с командой DWG, docs/dwg_contract.md). */
export function dwgOpenUrl(src: string, name: string): string {
  return `${DWG_SCHEME}open?src=${encodeURIComponent(src)}&name=${encodeURIComponent(name)}`;
}

/** «Новые» — ещё не открывали; «Просмотрены» — остальные. Порядок сервера (новые сверху) сохраняется. */
export function inboxSections(items: InboxDrawing[]): { fresh: InboxDrawing[]; seen: InboxDrawing[] } {
  return { fresh: items.filter((d) => !d.last_opened_at), seen: items.filter((d) => !!d.last_opened_at) };
}

/** «Кухня_Юнусабад» → «Кухня Юнусабад» (title пакета — имя файла без расширения). */
export function drawingTitle(d: Pick<InboxDrawing, 'title' | 'filename'>): string {
  const raw = d.title?.trim() || d.filename.replace(/\.[^.]+$/, '');
  return raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || d.filename;
}

/** DXF / DWG — по manifest.source.kind, иначе по имени файла. */
export function drawingKind(d: Pick<InboxDrawing, 'source_kind' | 'filename'>): string | null {
  const k = d.source_kind || (/\.(dwg|dxf)$/i.exec(d.filename)?.[1] ?? null);
  return k ? k.toUpperCase() : null;
}

const DAY = 86_400_000;
const startOfDay = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();

/** «сегодня» / «вчера» / «14 ноября». */
export function relDay(iso: string, lang: Lang, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (diff === 0) return lang === 'uz' ? 'bugun' : 'сегодня';
  if (diff === 1) return lang === 'uz' ? 'kecha' : 'вчера';
  return formatDayMonth(iso, lang);
}

/** «1 лист» / «3 листа» / «8 листов» (uz — «3 varaq»). */
export function sheetsLabel(n: number, lang: Lang): string {
  return lang === 'uz' ? `${n} varaq` : `${n} ${plural(n, 'лист|листа|листов')}`;
}

/** Вторая строка в списке: «от вас · DXF · 1 лист · сегодня». */
export function drawingLine(d: InboxDrawing, lang: Lang, fromYou: string, now: Date = new Date()): string {
  return [fromYou, drawingKind(d), d.sheet_count != null ? sheetsLabel(d.sheet_count, lang) : null, relDay(d.created_at, lang, now)]
    .filter(Boolean).join(' · ');
}

/** Дата, когда чертёж удалится (если по нему нет проекта) — «14.02.2027». null — проект есть, не удалится. */
export function expiryDate(d: Pick<InboxDrawing, 'expires_at' | 'project_id'>, lang: Lang): string | null {
  return d.project_id ? null : formatDate(d.expires_at, lang);
}
