/**
 * Фото с камеры и из галереи (SCR-04 «Новый проект», переписка и рекламации по заказу): разрешения, выбор,
 * сжатие до 1600 px по длинной стороне (3G, NFR-06).
 */
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import type { UploadFile } from '../api/client';

export interface Photo { uri: string; width?: number | null; height?: number | null; size?: number | null; mimeType?: string | null; fromShare?: boolean; tint?: string }

/** Сжимаем до 1600 px по длинной стороне: 3G и NFR-06. */
export async function preparePhoto(p: Photo): Promise<Photo> {
  try {
    const big = (p.width ?? 0) > 1600 || (p.height ?? 0) > 1600 || (p.size ?? 0) > 2_000_000;
    if (!big) return p;
    const r = await ImageManipulator.manipulateAsync(p.uri, [{ resize: (p.width ?? 0) >= (p.height ?? 0) ? { width: 1600 } : { height: 1600 } }], { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
    return { ...p, uri: r.uri, width: r.width, height: r.height, mimeType: 'image/jpeg' };
  } catch {
    return p;
  }
}

const fromAssets = (r: ImagePicker.ImagePickerResult): Photo[] =>
  r.canceled ? [] : r.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, size: a.fileSize, mimeType: a.mimeType }));

export type PickResult = { photos: Photo[]; denied?: 'camera' | 'gallery' };

/** Снять фото или выбрать до `max` из галереи; результат уже сжат. */
export async function pickPhotos(source: 'camera' | 'gallery', max: number): Promise<PickResult> {
  if (max <= 0) return { photos: [] };
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return { photos: [], denied: 'camera' };
    const r = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    return { photos: await Promise.all(fromAssets(r).map(preparePhoto)) };
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { photos: [], denied: 'gallery' };
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: max > 1, selectionLimit: max, quality: 0.8 });
  return { photos: await Promise.all(fromAssets(r).slice(0, max).map(preparePhoto)) };
}

/** Фото → файл для multipart (имя по порядку). */
export const toUpload = (p: Photo, i: number, prefix = 'photo'): UploadFile => ({ uri: p.uri, name: `${prefix}_${i + 1}.jpg`, type: p.mimeType ?? 'image/jpeg' });
