import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ProductScene, type ProductSceneOptions } from '../product.js';
import { bgColor, fitThumbnailCamera } from './fit.js';
import type { ViewerModel } from '../types.js';

/**
 * Превью изделия для карточек проектов (SCR-03): вид 3/4, прозрачный или белый фон.
 *
 * - Браузер: `renderThumbnail(model)` → PNG Blob (свой WebGLRenderer вне экрана).
 * - Приложение (expo-gl): `thumbnailScene()` + свой рендерер, см. README.
 * - Node (сервер): WebGL нет — `thumbnailPng(model)`: программная растеризация с z-буфером → PNG.
 */

export interface ThumbnailOptions {
  /** Размер картинки, px. По умолчанию 512 × 384. */
  width?: number;
  height?: number;
  /** 'transparent' (по умолчанию), 'white' или любой CSS-цвет "#rrggbb". */
  background?: 'transparent' | 'white' | string;
  /** Открыть двери и ящики. */
  open?: boolean;
  /** Откуда смотреть (оси three.js). По умолчанию спереди-справа-сверху, вид 3/4. */
  direction?: [number, number, number];
  /** Вертикальный угол обзора камеры, градусы. */
  fov?: number;
  /** Доля кадра, которую занимает изделие (0..1). */
  fill?: number;
  /** Опции сцены (качество, материалы). По умолчанию high без рёбер. */
  sceneOptions?: ProductSceneOptions;
}

export interface ThumbnailScene {
  scene: Scene;
  camera: PerspectiveCamera;
  product: ProductScene;
  width: number;
  height: number;
  /** null — прозрачный фон. */
  background: Color | null;
  dispose(): void;
}

/** Сцена превью со светом и камерой — для любого рендерера (браузер, expo-gl). */
export function thumbnailScene(model: ViewerModel, opts: ThumbnailOptions = {}): ThumbnailScene {
  const width = opts.width ?? 512;
  const height = opts.height ?? 384;
  const product = new ProductScene(model, { quality: 'high', edges: false, room: false, ...opts.sceneOptions });
  product.setAllOpen(opts.open ? 1 : 0);
  const scene = new Scene();
  const background = bgColor(opts.background);
  scene.background = background;
  scene.add(new HemisphereLight('#ffffff', '#c9c1b4', 1.15));
  scene.add(new AmbientLight('#ffffff', 0.25));
  const key = new DirectionalLight('#ffffff', 1.35);
  key.position.set(2.5, 4, 3);
  const fillLight = new DirectionalLight('#ffffff', 0.45);
  fillLight.position.set(-3, 2.5, 1.5);
  scene.add(key, fillLight, product.root);
  scene.updateMatrixWorld(true);
  const camera = fitThumbnailCamera(product.currentBounds(), width / height, opts.fov ?? 30, opts.direction, opts.fill ?? 0.9);
  return {
    scene,
    camera,
    product,
    width,
    height,
    background,
    dispose() {
      product.dispose();
    },
  };
}

/**
 * Нарисовать превью в готовый рендерер (браузер или expo-gl). Сам кадр не
 * забирает: в браузере — canvas.toBlob, в expo-gl — GLView.takeSnapshotAsync.
 */
export function renderThumbnailWith(renderer: WebGLRenderer, model: ViewerModel, opts: ThumbnailOptions = {}): void {
  const t = thumbnailScene(model, opts);
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = t.product.needsEnvironment ? pmrem.fromScene(room, 0.04).texture : null;
  try {
    t.product.setEnvironment(env);
    renderer.setSize(t.width, t.height, false);
    renderer.setClearColor(t.background ?? new Color('#ffffff'), t.background ? 1 : 0);
    renderer.render(t.scene, t.camera);
  } finally {
    env?.dispose();
    room.dispose();
    pmrem.dispose();
    t.dispose();
  }
}

/**
 * PNG превью в браузере. Создаёт свой WebGL-контекст вне экрана и сразу его
 * освобождает (браузеры держат не больше ~16 контекстов). Для пачки карточек
 * передайте один `renderer` и вызывайте по очереди.
 */
export async function renderThumbnail(
  model: ViewerModel,
  opts: ThumbnailOptions & { renderer?: WebGLRenderer } = {},
): Promise<Blob> {
  const width = opts.width ?? 512;
  const height = opts.height ?? 384;
  const own = !opts.renderer;
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let renderer: WebGLRenderer;
  if (opts.renderer) {
    renderer = opts.renderer;
    canvas = renderer.domElement;
  } else {
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
    else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
    else throw new Error('renderThumbnail: нет canvas (Node?) — используйте thumbnailPng()');
    renderer = new WebGLRenderer({
      canvas: canvas as HTMLCanvasElement,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
  }
  try {
    renderThumbnailWith(renderer, model, { ...opts, width, height });
    if ('convertToBlob' in canvas) return await canvas.convertToBlob({ type: 'image/png' });
    return await new Promise<Blob>((resolve, reject) =>
      (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob вернул null'))), 'image/png'),
    );
  } finally {
    if (own) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}

/** То же, но data:URL (удобно сразу положить в <img> или отправить на сервер). */
export async function renderThumbnailDataUrl(
  model: ViewerModel,
  opts: ThumbnailOptions & { renderer?: WebGLRenderer } = {},
): Promise<string> {
  const blob = await renderThumbnail(model, opts);
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

export { DEFAULT_THUMBNAIL_DIRECTION, bgColor, fitThumbnailCamera } from './fit.js';
export { thumbnailPng, thumbnailRgba, encodePng, type SoftwareThumbnailOptions, type RgbaImage } from './raster.js';
