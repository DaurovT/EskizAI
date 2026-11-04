/**
 * Имена и типы файлов пакета мастера (раздел 8): сервер отдаёт
 * `Content-Disposition: attachment; filename="ascii.pdf"; filename*=UTF-8''Шкаф_Азиза_спецификация_v3.pdf`.
 * Без React и RN — покрыто тестами.
 */

/** Имя из Content-Disposition: сначала filename* (RFC 5987, UTF-8), затем filename. */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* битая кодировка — берём filename */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  const v = plain?.[1] ?? plain?.[2];
  return v ? v.trim() : null;
}

/** Безопасное имя для файловой системы: кириллица остаётся, запрещённые символы → «_». */
export function safeFileName(name: string): string {
  const s = name.replace(/[\/\\:*?"<>|\u0000-\u001f\s]+/g, '_').replace(/_+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return s || 'file';
}

export const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', csv: 'text/csv', zip: 'application/zip', glb: 'model/gltf-binary', dxf: 'application/dxf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain',
};
export const EXT_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]));

/** Тип для системного меню «Поделиться»: из заголовка, иначе по расширению. */
export function mimeOf(contentType: string | null | undefined, name: string): string {
  const ct = (contentType ?? '').split(';')[0].trim();
  if (ct && ct !== 'application/octet-stream') return ct;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** UTI для iOS (expo-sharing): иначе «Сохранить в Файлы» не знает тип. */
export function utiOf(mime: string): string | undefined {
  return ({ 'application/pdf': 'com.adobe.pdf', 'text/csv': 'public.comma-separated-values-text', 'application/zip': 'public.zip-archive',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'org.openxmlformats.spreadsheetml.sheet' } as Record<string, string>)[mime];
}
