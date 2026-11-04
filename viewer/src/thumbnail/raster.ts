import { Color, Vector3, type Material, type Mesh } from 'three';
import { ProductScene } from '../product.js';
import type { ViewerModel } from '../types.js';
import { bgColor, fitThumbnailCamera } from './fit.js';
import type { ThumbnailOptions } from './index.js';

/**
 * Превью без WebGL: программная растеризация треугольников с z-буфером,
 * плоская заливка, тёмный контур по границам деталей, сглаживание 3×3.
 * Нужна для сервера (Node): headless-gl даёт только WebGL1, а three ≥ 0.163 —
 * только WebGL2, так что настоящий рендер в Node недоступен.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 8 бит, построчно сверху вниз, не premultiplied. */
  data: Uint8Array;
}

export interface SoftwareThumbnailOptions extends ThumbnailOptions {
  /** Сглаживание: сэмплов на пиксель по стороне (1 — без сглаживания). По умолчанию 3. */
  supersample?: number;
  /** Контур деталей. По умолчанию true. */
  outline?: boolean;
  /**
   * Сжатие для PNG: функция zlib-deflate (например, `(d) => zlib.deflateSync(d)` в Node).
   * Без неё PNG пишется без сжатия (больше, но без зависимостей).
   */
  deflate?: (data: Uint8Array) => Uint8Array;
}

function materialColor(m: Material | Material[]): Color {
  const mat = (Array.isArray(m) ? m[0] : m) as Material & { color?: Color };
  return mat.color?.clone() ?? new Color('#cccccc');
}

/** Картинка RGBA без WebGL (Node, воркеры, тесты). */
export function thumbnailRgba(model: ViewerModel, opts: SoftwareThumbnailOptions = {}): RgbaImage {
  const width = opts.width ?? 512;
  const height = opts.height ?? 384;
  const ss = Math.max(1, Math.round(opts.supersample ?? 3));
  const W = width * ss;
  const H = height * ss;
  const product = new ProductScene(model, {
    units: 'mm',
    edges: false,
    textures: false,
    merge: false,
    quality: 'medium',
    room: false,
    ao: false,
    ...opts.sceneOptions,
  });
  const color = new Float32Array(W * H * 3);
  const depth = new Float32Array(W * H).fill(Infinity);
  const ids = new Int32Array(W * H).fill(-1);
  // Код направления грани (ось и знак) — для линий на сгибах внутри одной детали.
  const faces = new Int8Array(W * H);
  try {
    product.setAllOpen(opts.open ? 1 : 0);
    product.root.updateMatrixWorld(true);
    const cam = fitThumbnailCamera(product.currentBounds(), width / height, opts.fov ?? 30, opts.direction, opts.fill ?? 0.9);
    const camPos = cam.position;
    const light = new Vector3(0.45, 0.85, 0.6).normalize();
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const t = new Vector3();
    const n = new Vector3();
    const sa = new Vector3();
    const sb = new Vector3();
    const sc = new Vector3();
    const toScreen = (v: Vector3, out: Vector3) => {
      out.copy(v).project(cam);
      out.set(((out.x + 1) / 2) * W, ((1 - out.y) / 2) * H, out.z);
    };
    // Детали и видная фурнитура (петли и направляющие внутри — на превью не нужны)
    const meshes: Mesh[] = [
      ...product.parts.map((h) => h.mesh as Mesh),
      ...product.hardware.filter((h) => h.item.kind !== 'hinge' && h.item.kind !== 'slide').map((h) => h.mesh),
    ];
    meshes.forEach((mesh, partIndex) => {
      const pos = mesh.geometry.getAttribute('position');
      // Линейные компоненты (рабочее пространство three), в sRGB переводим в конце.
      const base = materialColor(mesh.material);
      // Декор фасада: цвет вершин (тёмные пазы) и металл вставок (metalMask) — в том же меше
      const vcol = mesh.geometry.getAttribute('color');
      const mask = mesh.geometry.getAttribute('metalMask');
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material;
      const inlay = (mat?.userData?.inlayUniforms as { inlayColor?: { value: Color } } | undefined)?.inlayColor?.value;
      for (let i = 0; i + 2 < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld);
        n.copy(b).sub(a).cross(t.copy(c).sub(a));
        if (n.lengthSq() === 0) continue;
        n.normalize();
        if (n.dot(t.copy(camPos).sub(a)) <= 0) continue; // задняя грань
        let shade = Math.min(1.1, 0.5 + 0.5 * Math.max(0, n.dot(light)) + 0.1 * n.y);
        let src = base;
        if (mask && inlay && mask.getX(i) + mask.getX(i + 1) + mask.getX(i + 2) > 1.5) {
          src = inlay;
          shade = Math.min(1.25, shade * 1.15); // металл чуть ярче — читается на превью
        } else if (vcol) {
          shade *= (vcol.getX(i) + vcol.getX(i + 1) + vcol.getX(i + 2)) / 3;
        }
        const r = src.r * shade;
        const g = src.g * shade;
        const bl = src.b * shade;
        const ax = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? 0 : Math.abs(n.y) >= Math.abs(n.z) ? 1 : 2;
        const face = ax * 2 + ((ax === 0 ? n.x : ax === 1 ? n.y : n.z) > 0 ? 1 : 0);
        toScreen(a, sa);
        toScreen(b, sb);
        toScreen(c, sc);
        rasterTri(sa, sb, sc, W, H, depth, (idx) => {
          color[idx * 3] = r;
          color[idx * 3 + 1] = g;
          color[idx * 3 + 2] = bl;
          ids[idx] = partIndex;
          faces[idx] = face;
        });
      }
    });
  } finally {
    product.dispose();
  }

  // Контур: граница детали или скачок глубины → темнее.
  if (opts.outline ?? true) {
    const line = Math.max(1, Math.round(ss / 2));
    // 1 — контур детали (сильно темнее), 2 — сгиб между гранями одной детали (слабее).
    const dark = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const id = ids[i]!;
        if (id < 0) continue;
        for (const [dx, dy] of [
          [line, 0],
          [0, line],
          [-line, 0],
          [0, -line],
        ] as const) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (ids[j] !== id && (ids[j]! < 0 || depth[j]! > depth[i]!)) {
            dark[i] = 1;
            break;
          }
          if (ids[j] === id && faces[j] !== faces[i]) dark[i] = 2;
        }
      }
    }
    for (let i = 0; i < W * H; i++) {
      if (!dark[i]) continue;
      const k = dark[i] === 1 ? 0.55 : 0.8;
      color[i * 3] = color[i * 3]! * k;
      color[i * 3 + 1] = color[i * 3 + 1]! * k;
      color[i * 3 + 2] = color[i * 3 + 2]! * k;
    }
  }

  // Уменьшение ss×ss → пиксель; альфа — доля покрытых сэмплов.
  const bg = bgColor(opts.background);
  const out = new Uint8Array(width * height * 4);
  const tmp = new Color();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cov = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = (y * ss + sy) * W + (x * ss + sx);
          if (ids[i]! < 0) continue;
          r += color[i * 3]!;
          g += color[i * 3 + 1]!;
          b += color[i * 3 + 2]!;
          cov++;
        }
      }
      const o = (y * width + x) * 4;
      const alpha = cov / (ss * ss);
      if (cov) {
        r /= cov;
        g /= cov;
        b /= cov;
      }
      if (bg) {
        r = r * alpha + bg.r * (1 - alpha);
        g = g * alpha + bg.g * (1 - alpha);
        b = b * alpha + bg.b * (1 - alpha);
      }
      // Линейные → sRGB через Color (учитывает ColorManagement three).
      tmp.setRGB(Math.min(1, r), Math.min(1, g), Math.min(1, b));
      const hex = tmp.getHex();
      out[o] = (hex >> 16) & 255;
      out[o + 1] = (hex >> 8) & 255;
      out[o + 2] = hex & 255;
      out[o + 3] = bg ? 255 : Math.round(alpha * 255);
    }
  }
  return { width, height, data: out };
}

/** Растеризация треугольника в экранных координатах (z — NDC, линеен в экране). */
function rasterTri(
  a: Vector3,
  b: Vector3,
  c: Vector3,
  W: number,
  H: number,
  depth: Float32Array,
  write: (idx: number) => void,
): void {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
      const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
      const z = w0 * a.z + w1 * b.z + w2 * c.z;
      if (z < -1 || z > 1) continue;
      const idx = y * W + x;
      if (z < depth[idx]!) {
        depth[idx] = z;
        write(idx);
      }
    }
  }
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zlib-поток из несжатых блоков deflate (без зависимостей). */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = len & 255;
    out[o++] = len >> 8;
    out[o++] = ~len & 255;
    out[o++] = (~len >> 8) & 255;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]!) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  out[o++] = adler >>> 24;
  out[o++] = (adler >>> 16) & 255;
  out[o++] = (adler >>> 8) & 255;
  out[o++] = adler & 255;
  return out;
}

/** RGBA → PNG (8 бит, без фильтров). `deflate` — zlib-сжатие, если есть. */
export function encodePng(img: RgbaImage, deflate?: (data: Uint8Array) => Uint8Array): Uint8Array {
  const { width, height, data } = img;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const idat = deflate ? deflate(raw) : zlibStored(raw);
  const chunks: Uint8Array[] = [];
  const u32 = (v: number) => new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const chunk = (type: string, body: Uint8Array) => {
    const t = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
    chunks.push(u32(body.length), t, body, u32(crc32([t, body])));
  };
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  chunks.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  chunk('IHDR', ihdr);
  chunk('IDAT', idat);
  chunk('IEND', new Uint8Array(0));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    png.set(c, o);
    o += c.length;
  }
  return png;
}

/** PNG превью без WebGL — для Node/сервера. */
export function thumbnailPng(model: ViewerModel, opts: SoftwareThumbnailOptions = {}): Uint8Array {
  return encodePng(thumbnailRgba(model, opts), opts.deflate);
}
