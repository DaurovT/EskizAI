/**
 * Сканы декоров для 3D в приложении (expo-gl): `bundled:<имя>` — из assets, `/static/…` и http — с API.
 * expo-gl умеет texImage2D/texSubImage2D из объекта `{ localUri: 'file://…' }` (stb_image внутри),
 * поэтому картинка — обычная THREE.Texture с image = { localUri, width, height }: клоны (свой повтор
 * на материал) делят одну загрузку на GPU.
 */
import { Asset } from 'expo-asset';
import { Image } from 'react-native';
import { LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, Texture } from 'three';
import { diagLog } from '../diag';
import { textureSource } from '../lib/decors';

const cache = new Map<string, Promise<{ localUri: string; width: number; height: number } | null>>();

function sizeOf(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject));
}

async function fetchImage(url: string): Promise<{ localUri: string; width: number; height: number } | null> {
  const src = textureSource(url);
  if (src == null) return null;
  const asset = typeof src === 'number' ? Asset.fromModule(src) : 'uri' in (src as object) && (src as { uri?: string }).uri ? Asset.fromURI((src as { uri: string }).uri) : null;
  if (!asset) return null;
  await asset.downloadAsync();
  const localUri = asset.localUri ?? '';
  if (!localUri.startsWith('file://')) return null;
  const { width, height } = asset.width && asset.height ? { width: asset.width, height: asset.height } : await sizeOf(localUri);
  return { localUri, width, height };
}

/** Загрузчик для ProductScene (`options.loadTexture`). Ошибка — null: останутся процедурные волокна / цвет. */
export async function loadExpoTexture(url: string): Promise<Texture | null> {
  try {
    let p = cache.get(url);
    if (!p) {
      p = fetchImage(url);
      cache.set(url, p);
    }
    const img = await p;
    if (!img) return null;
    const tex = new Texture();
    tex.image = { localUri: img.localUri, width: img.width, height: img.height };
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.colorSpace = SRGBColorSpace;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.name = url;
    tex.needsUpdate = true;
    return tex;
  } catch (e) {
    cache.delete(url);
    diagLog(`texture ${url} failed: ${String((e as Error)?.message ?? e)}`);
    return null;
  }
}
