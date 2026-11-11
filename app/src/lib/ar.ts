/**
 * AR мастера (SCR-47, docs/ar_contract.md): чистые помощники без нативных модулей — ссылки Scene Viewer,
 * подсказка по размещению, какой файл качать на какой платформе, подписи прогресса.
 * Запуск системного AR — src/lib/arLaunch.ts.
 */
import type { ArPlacement, EstimateView, Lang, ProjectArOut, ShareLinkOut } from '../api/types';
import type { DictKey } from '../i18n';

const enc = encodeURIComponent;

/** Google Scene Viewer только в AR, масштаб 1:1 зафиксирован (resizable=false). */
export function sceneViewerUrl(glbUrl: string, title: string, wall = false): string {
  // навесное: Scene Viewer сам на стену не ставит — разрешаем вертикальные плоскости
  return `https://arvr.google.com/scene-viewer/1.2?file=${enc(glbUrl)}&mode=ar_only&resizable=false&title=${enc(title)}${wall ? '&enable_vertical_placement=true' : ''}`;
}

/**
 * Запасной путь — intent:// на ARCore (Google Play Services for AR), как советует Google для mode=ar_only.
 * fallbackUrl — куда уйти, если Scene Viewer нет (S.browser_fallback_url).
 */
export function sceneViewerIntentUrl(glbUrl: string, title: string, fallbackUrl?: string, wall = false): string {
  const q = `file=${enc(glbUrl)}&mode=ar_only&resizable=false&title=${enc(title)}${wall ? '&enable_vertical_placement=true' : ''}`;
  const fb = fallbackUrl ? `S.browser_fallback_url=${enc(fallbackUrl)};` : '';
  return `intent://arvr.google.com/scene-viewer/1.2?${q}#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;${fb}end;`;
}

/** Подсказка под пунктами: на пол у стены или на стену (навесное). */
export const arHintKey = (placement: ArPlacement | null | undefined): DictKey => (placement === 'wall' ? 'ar_hint_wall' : 'ar_hint_floor');

/** iPhone — USDZ для AR Quick Look, Android — GLB для Scene Viewer. */
export function arFileFor(ar: Pick<ProjectArOut, 'glb_url' | 'usdz_url' | 'version_id'>, os: string): { url: string; name: string; mime: string } {
  const ios = os === 'ios';
  const safeId = ar.version_id.replace(/[^\w-]/g, '_');
  return ios
    ? { url: ar.usdz_url, name: `ar-${safeId}.usdz`, mime: 'model/vnd.usdz+zip' }
    : { url: ar.glb_url, name: `ar-${safeId}.glb`, mime: 'model/gltf-binary' };
}

/** Подписанные ссылки живут ~1 ч: перед запуском берём свежие, если до конца меньше marginMs. */
export function isArFresh(ar: Pick<ProjectArOut, 'expires_at'> | null | undefined, now = Date.now(), marginMs = 2 * 60_000): boolean {
  if (!ar) return false;
  const t = Date.parse(ar.expires_at);
  return Number.isFinite(t) && t - now > marginMs;
}

/** «1600 × 600 × 2400» — габарит как в контракте AR ([ширина, глубина, высота]). */
export function arDims(size: readonly (number | null | undefined)[] | null | undefined): string | null {
  const xs = (size ?? []).map((x) => (typeof x === 'number' && x > 0 ? Math.round(x) : null));
  return xs.length === 3 && xs.every((x) => x != null) ? xs.join(' × ') : null;
}

/** ModelSummary.size_mm и viewer.size ядра — [ширина, высота, глубина] → порядок AR [ширина, глубина, высота]. */
export const whdToWdh = (s: readonly number[] | null | undefined): [number, number, number] | null =>
  s && s.length === 3 ? [s[0], s[2], s[1]] : null;

/** 5 347 000 байт → «5,1» (МБ, одна цифра после запятой; меньше 0,1 — «0,1»). */
export function formatMb(bytes: number): string {
  const mb = Math.max(0.1, Math.round((bytes / 1_048_576) * 10) / 10);
  return (Number.isInteger(mb) ? String(mb) : mb.toFixed(1)).replace('.', ',');
}

/** Сколько секунд осталось по средней скорости; null — пока не ясно (мало данных или размер неизвестен). */
export function etaSeconds(written: number, total: number, elapsedMs: number): number | null {
  if (total <= 0 || written <= 0 || elapsedMs < 300 || written >= total) return null;
  const rate = written / elapsedMs; // байт/мс
  return Math.max(1, Math.ceil((total - written) / rate / 1000));
}

/** Доля загрузки 0…1; размер неизвестен (-1) — null (полоса «бегает»). */
export const progressRatio = (written: number, total: number): number | null => (total > 0 ? Math.min(1, Math.max(0, written / total)) : null);

/** Заголовок для Scene Viewer: «Шкаф · v4 · 1600 × 600 × 2400 мм». */
export function arTitle(kind: string, versionNumber: number | null | undefined, dims: string | null, lang: Lang): string {
  return [kind, versionNumber ? `v${versionNumber}` : null, dims ? `${dims} ${lang === 'uz' ? 'mm' : 'мм'}` : null].filter(Boolean).join(' · ');
}

/** «Клиенту на его телефон»: действующая ссылка клиента (не отозвана, не истекла) — самая свежая; нет — null. */
export function pickActiveLink(links: readonly ShareLinkOut[] | null | undefined, now = Date.now()): ShareLinkOut | null {
  const live = (links ?? []).filter((l) => !l.revoked_at && !(Date.parse(l.expires_at) <= now));
  return live.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}

/** Вид сметы новой ссылки — как на экране отправки: по умолчанию цеха, если он доступен (сотруднику — из разрешённых). */
export function linkView(preferred: EstimateView | null | undefined, allowed: readonly EstimateView[]): EstimateView {
  const list = allowed.length ? allowed : (['total'] as EstimateView[]);
  return preferred && list.includes(preferred) ? preferred : list[0];
}
