/**
 * Системный AR без своих нативных модулей (docs/ar_contract.md, SCR-47).
 *
 * iPhone: USDZ скачивается в кэш и открывается `File.preview()` из expo-file-system — это QLPreviewController,
 * т. е. AR Quick Look прямо поверх приложения (вкладки «AR / Объект», реальный масштаб). Модуль уже в сборке
 * (ExpoFileSystem 58 в Podfile.lock), новых нативных зависимостей не нужно. Запасной путь —
 * `Linking.openURL(usdz_url)`: Safari сам показывает Quick Look по model/vnd.usdz+zip (уходит из приложения).
 * expo-web-browser в проекте нет, поэтому SFSafariViewController не используем.
 *
 * Android: GLB тоже качается в кэш (прогресс и проверка ссылки; Scene Viewer всё равно читает по https),
 * затем Scene Viewer: https://arvr.google.com/scene-viewer/1.2?… через Linking, запасной — intent:// на ARCore,
 * иначе — понятное сообщение «AR не поддерживается».
 */
import { Directory, File, Paths } from 'expo-file-system';
import { Linking, Platform } from 'react-native';
import { ApiError } from '../api/errors';
import type { ProjectArOut } from '../api/types';
import { arFileFor, sceneViewerIntentUrl, sceneViewerUrl } from './ar';

export const AR_UNSUPPORTED = 'ar_unsupported';
export const AR_DOWNLOAD_FAILED = 'ar_download_failed';
const unsupported = () => new ApiError(422, AR_UNSUPPORTED, 'AR не поддерживается на этом устройстве');

export const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/** Файл модели для этой платформы в кэше (повторный показ той же версии — без загрузки). */
export async function downloadArFile(
  ar: ProjectArOut,
  onProgress: (written: number, total: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  const f = arFileFor(ar, Platform.OS);
  const dir = new Directory(Paths.cache, 'ar');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, f.name);
  if (dest.exists && (dest.size ?? 0) > 0) {
    onProgress(dest.size, dest.size);
    return dest;
  }
  const part = new File(dir, `${f.name}.part`);
  try {
    if (part.exists) part.delete();
    const got = await File.downloadFileAsync(f.url, part, {
      idempotent: true, signal,
      onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes),
    });
    if (dest.exists) dest.delete();
    got.move(dest);
    return dest;
  } catch (e) {
    try { if (part.exists) part.delete(); } catch { /* недокачанный файл не мешает */ }
    if (isAbort(e)) throw e;
    const m = /\b([45]\d\d)\b/.exec(String((e as Error)?.message ?? ''));
    // ответ сервера (просроченная ссылка, 404) — отдельная ошибка; иначе — связь
    throw m ? new ApiError(Number(m[1]), AR_DOWNLOAD_FAILED, (e as Error).message) : new ApiError(0, 'network', String((e as Error)?.message ?? e));
  }
}

/** iPhone: AR Quick Look поверх приложения; не вышло — Safari (тоже Quick Look). */
async function openIos(file: File, ar: ProjectArOut, title: string): Promise<void> {
  try {
    // симулятор: canPreview(usdz) = false (AR Quick Look есть только на устройстве) — уходим в Safari
    if (await file.canPreview()) {
      await file.preview({ title });
      return;
    }
  } catch {
    /* старый нативный модуль или файл не открылся — пробуем Safari */
  }
  try {
    await Linking.openURL(ar.usdz_url);
  } catch {
    throw unsupported();
  }
}

/** Android: Scene Viewer по https, затем intent:// на ARCore; иначе — «AR не поддерживается». */
async function openAndroid(ar: ProjectArOut, title: string): Promise<void> {
  try {
    await Linking.openURL(sceneViewerUrl(ar.glb_url, title, ar.placement === 'wall'));
    return;
  } catch {
    /* нет обработчика https-ссылки Scene Viewer */
  }
  try {
    await Linking.openURL(sceneViewerIntentUrl(ar.glb_url, title, undefined, ar.placement === 'wall'));
    return;
  } catch {
    throw unsupported();
  }
}

/** Запустить системный AR для скачанного файла. */
export async function launchAr(file: File, ar: ProjectArOut, title: string): Promise<void> {
  if (Platform.OS === 'ios') return openIos(file, ar, title);
  if (Platform.OS === 'android') return openAndroid(ar, title);
  throw unsupported();
}
