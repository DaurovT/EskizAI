import { CubeUVReflectionMapping, DataTexture, LinearFilter, NoColorSpace, RGBAFormat, UnsignedByteType } from 'three';

/**
 * Маленькая «студия» для отражений металла и глянца без PMREM.
 *
 * Обычная карта окружения в three проходит через PMREMGenerator (рендер в half-float цели) —
 * в expo-gl это ненадёжно, поэтому приложение карту не ставило, и металл был «полуметаллом».
 * Здесь атлас CubeUV (тот же формат, что выдаёт PMREM) считается на CPU: three берёт
 * текстуру с mapping = CubeUVReflectionMapping как есть, без генерации на GPU.
 * Содержимое — гладкая студия: светлый верх, мягкий горизонт, тёплый тёмный пол и три софтбокса.
 * Размер 336 × 128 RGBA8 (~170 КБ), считается ~5 мс.
 */

const CUBE = 32; // грань самого резкого уровня
const MAX_MIP = 5; // log2(CUBE)
const TILE = 16; // минимальная грань (cubeUV_minTileSize)

/** Направление по грани PMREM и координатам u, v ∈ [−1, 1] (обратное к getUV в шейдере). */
function faceDir(face: number, u: number, v: number, out: [number, number, number]): void {
  let x: number, y: number, z: number;
  switch (face) {
    case 0: x = 1; y = v; z = u; break;
    case 1: x = -u; y = 1; z = -v; break;
    case 2: x = -u; y = v; z = 1; break;
    case 3: x = -1; y = v; z = -u; break;
    case 4: x = -u; y = -1; z = v; break;
    default: x = u; y = v; z = -1;
  }
  const l = Math.hypot(x, y, z);
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Софтбоксы: направление (мир, y вверх, +z — к зрителю), яркость, размер
const BOXES: ReadonlyArray<{ d: [number, number, number]; k: number; s: number }> = [
  { d: [0.55, 0.62, 0.56], k: 1.6, s: 0.05 },
  { d: [-0.7, 0.35, 0.62], k: 0.9, s: 0.07 },
  { d: [0.0, 0.97, -0.25], k: 1.1, s: 0.09 },
];

/** Яркость студии в направлении d при размытии b (0 — резко, 1 — освещённость). Линейный RGB. */
export function studioRadiance(d: [number, number, number], b: number): [number, number, number] {
  const y = d[1];
  const w = 0.08 + b * 0.9;
  // Небо → горизонт → пол
  const sky = smooth(-w, w + 0.35, y);
  let r = 0.2 + (0.78 - 0.2) * sky;
  let g = 0.17 + (0.78 - 0.17) * sky;
  let bl = 0.13 + (0.8 - 0.13) * sky;
  // Светлая полоса горизонта (стены комнаты)
  const band = Math.exp(-(y * y) / (0.02 + b * 0.3)) * 0.12 * (1 - b * 0.5);
  r += band;
  g += band;
  bl += band;
  for (const box of BOXES) {
    const dot = d[0] * box.d[0] + d[1] * box.d[1] + d[2] * box.d[2];
    const s = box.s + b * 0.6;
    const e = Math.exp(-(1 - dot) / s) * box.k * (box.s / s) ** 0.6;
    r += e;
    g += e * 0.98;
    bl += e * 0.95;
  }
  return [r, g, bl];
}

/** Атлас CubeUV со студией. Владелец текстуры вызывает dispose(). */
export function createStudioEnvironment(): DataTexture {
  const width = 3 * Math.max(CUBE, 7 * TILE);
  const height = 4 * CUBE;
  const data = new Uint8Array(width * height * 4);
  const dir: [number, number, number] = [0, 0, 0];
  const put = (x0: number, y0: number, size: number, blur: number) => {
    for (let face = 0; face < 6; face++) {
      const fx = x0 + (face % 3) * size;
      const fy = y0 + (face > 2 ? size : 0);
      for (let py = 0; py < size; py++) {
        // Центр тексела → координата грани (в шейдере: uv * (size − 2) + 1)
        const v = (((py + 0.5 - 1) / (size - 2)) * 2 - 1);
        for (let px = 0; px < size; px++) {
          const u = (((px + 0.5 - 1) / (size - 2)) * 2 - 1);
          faceDir(face, u, v, dir);
          const c = studioRadiance(dir, blur);
          const o = ((fy + py) * width + fx + px) * 4;
          data[o] = Math.min(255, Math.round(c[0] * 255));
          data[o + 1] = Math.min(255, Math.round(c[1] * 255));
          data[o + 2] = Math.min(255, Math.round(c[2] * 255));
          data[o + 3] = 255;
        }
      }
    }
  };
  // Уровни 2^MAX_MIP … 16: размытие растёт к мелким
  for (let m = MAX_MIP; m >= 4; m--) {
    const size = 2 ** m;
    put(0, 4 * (CUBE - size), size, m === MAX_MIP ? 0.02 : 0.08);
  }
  // Дополнительные размытые плитки 16 × 16 (шероховатость до 1)
  const extra = [0.16, 0.26, 0.38, 0.52, 0.7, 1];
  extra.forEach((blur, i) => put((i + 1) * 3 * TILE, 4 * (CUBE - TILE), TILE, blur));
  const tex = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  tex.mapping = CubeUVReflectionMapping;
  tex.colorSpace = NoColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.name = 'studio-env';
  tex.needsUpdate = true;
  return tex;
}
