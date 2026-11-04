import { Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ProductScene } from '../product.js';
import type { ViewerModel } from '../types.js';

export type GlbState = 'closed' | 'open';

export interface GlbVariants {
  closed: ArrayBuffer;
  open: ArrayBuffer;
}

/**
 * GLTFExporter читает Blob через FileReader. В Node (route handler Next.js,
 * тесты) FileReader нет — подставляем минимальную замену на время экспорта.
 */
function withFileReader<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { FileReader?: unknown };
  if (typeof g.FileReader !== 'undefined') return fn();
  class MiniFileReader {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then((buf) => {
        const b64 = typeof btoa === 'function'
          ? btoa(String.fromCharCode(...new Uint8Array(buf)))
          : '';
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
        this.onloadend?.();
      });
    }
  }
  g.FileReader = MiniFileReader;
  return fn().finally(() => {
    delete g.FileReader;
  });
}

/**
 * GLB изделия в метрах (реальный масштаб для AR): без рёбер, каждый подвижный
 * узел — отдельный объект `node:<id>` с точкой вращения на оси.
 *
 * Временное решение: позже GLB будет строить сервер.
 */
export async function exportGlb(model: ViewerModel, state: GlbState = 'closed'): Promise<ArrayBuffer> {
  const product = new ProductScene(model, { units: 'm', edges: false, textures: false, merge: false, room: false, ao: false });
  try {
    product.setAllOpen(state === 'open' ? 1 : 0);
    const scene = new Scene();
    scene.name = 'mebel';
    scene.add(product.root);
    scene.updateMatrixWorld(true);
    const exporter = new GLTFExporter();
    const result = await withFileReader(() => exporter.parseAsync(scene, { binary: true, onlyVisible: true, trs: true }));
    if (!(result instanceof ArrayBuffer)) throw new Error('GLTFExporter вернул не ArrayBuffer');
    return result;
  } finally {
    product.dispose();
  }
}

/** Два варианта для AR: «закрыто» и «открыто» (все двери и ящики открыты). */
export async function exportGlbVariants(model: ViewerModel): Promise<GlbVariants> {
  const closed = await exportGlb(model, 'closed');
  const open = await exportGlb(model, 'open');
  return { closed, open };
}
