/** Скачивание файла пакета мастера в кэш приложения (для «Поделиться» как файлом, не ссылкой). */
import * as FileSystem from 'expo-file-system/legacy';
import type { DownloadedFile } from './client';
import { ApiError } from './errors';
import { EXT_BY_MIME, fileNameFromDisposition, mimeOf, safeFileName as safe } from '../lib/files';

export async function downloadToCache(url: string, headers: Record<string, string>, kind: string): Promise<DownloadedFile> {
  const dir = `${FileSystem.cacheDirectory}files/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  const tmp = `${dir}${safe(kind)}.download`;
  let res: FileSystem.FileSystemDownloadResult;
  try {
    res = await FileSystem.downloadAsync(url, tmp, { headers });
  } catch (e) {
    throw new ApiError(0, 'network', (e as Error).message);
  }
  if (res.status >= 400) {
    let message = `HTTP ${res.status}`;
    let code = res.status === 402 ? 'files_locked' : `http_${res.status}`;
    try {
      const body = JSON.parse(await FileSystem.readAsStringAsync(tmp));
      message = body?.error?.message ?? message;
      code = body?.error?.code ?? code;
    } catch {
      /* не JSON */
    }
    await FileSystem.deleteAsync(tmp, { idempotent: true });
    throw new ApiError(res.status, code, message);
  }
  const disp = res.headers['Content-Disposition'] ?? res.headers['content-disposition'] ?? '';
  const fromHeader = fileNameFromDisposition(disp);
  const rawType = res.headers['Content-Type'] ?? res.headers['content-type'];
  const name = safe(fromHeader ?? (/\.\w{2,4}$/.test(kind) ? kind : `${kind}.${EXT_BY_MIME[(rawType ?? '').split(';')[0]] ?? 'bin'}`));
  const mime = mimeOf(rawType, name);
  const uri = `${dir}${name}`;
  await FileSystem.deleteAsync(uri, { idempotent: true });
  await FileSystem.moveAsync({ from: tmp, to: uri });
  return { uri, mimeType: mime, name };
}

/** Мок: записать сгенерированный файл, чтобы его можно было отправить через системное меню. */
export async function writeCacheFile(name: string, content: string): Promise<string> {
  const dir = `${FileSystem.cacheDirectory}files/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  const uri = `${dir}${safe(name)}`;
  await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 });
  return uri;
}
