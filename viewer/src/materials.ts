import {
  Color,
  DataTexture,
  LinearMipmapLinearFilter,
  LinearFilter,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  ShaderChunk,
  TextureLoader,
  UnsignedByteType,
  type Texture,
} from 'three';
import type { MaterialModel } from './quality.js';
import type { ViewerMaterial } from './types.js';

/**
 * Тип поверхности (PBR-пресет) по PRD: матовый, глянец, soft-touch, шпон,
 * акрил, зеркало, металл. `glass` — дополнительно, для стеклянных вставок.
 */
export type MaterialType = 'matte' | 'satin' | 'gloss' | 'softtouch' | 'veneer' | 'acrylic' | 'mirror' | 'metal' | 'glass';

/** Настройка материала снаружи: тип, своя текстура декора, масштаб. Ключ — id материала ядра. */
export interface MaterialConfig {
  type?: MaterialType;
  /** Цвет; по умолчанию из viewer model (с текстурой-картинкой — белый, чтобы не тонировать скан). */
  color?: string;
  /** URL картинки декора или готовая текстура. */
  map?: string | Texture;
  /** Размер одной плитки текстуры в мм: число или [по горизонтали картинки, по вертикали]. По умолчанию 1000. */
  tileMm?: number | [number, number];
  /** Вдоль какой оси картинки идут волокна. По умолчанию 'u' — горизонтально. */
  grainAxis?: 'u' | 'v';
  /** Процедурные волокна, если своей картинки нет. По умолчанию — для `hasGrain` и шпона. */
  proceduralGrain?: boolean;
  roughness?: number;
  metalness?: number;
  /** Цвет вершин умножается на цвет материала (декор фасада: тёмные пазы, накладки). */
  vertexColors?: boolean;
}

export interface PbrPreset {
  roughness: number;
  metalness: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  opacity?: number;
  /** Сила отражений окружения при quality high. */
  envIntensity: number;
  /** Отражает ли окружение и при quality medium. */
  reflective: boolean;
}

export const PBR_PRESETS: Readonly<Record<MaterialType, Readonly<PbrPreset>>> = {
  matte: { roughness: 0.72, metalness: 0, envIntensity: 0.25, reflective: false },
  // Полуматовая краска: мягкий блик и лёгкое отражение
  satin: { roughness: 0.45, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.35, envIntensity: 0.35, reflective: true },
  softtouch: { roughness: 0.92, metalness: 0, sheen: 0.35, envIntensity: 0.15, reflective: false },
  veneer: { roughness: 0.6, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5, envIntensity: 0.35, reflective: false },
  gloss: { roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envIntensity: 0.8, reflective: true },
  acrylic: { roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, envIntensity: 1, reflective: true },
  mirror: { roughness: 0.04, metalness: 1, envIntensity: 1.1, reflective: true },
  metal: { roughness: 0.28, metalness: 1, envIntensity: 0.9, reflective: true },
  glass: { roughness: 0.1, metalness: 0, opacity: 0.35, envIntensity: 0.8, reflective: true },
};

/**
 * Тип поверхности по id материала каталога ядра (пока в каталоге нет поля «тип»).
 * mirror_* → зеркало, rod_* / chrome / metal / alu / steel → металл, glass → стекло,
 * acryl → акрил, gloss / glyanec / countertop_* → глянец, soft → soft-touch,
 * veneer / shpon → шпон, остальное (ЛДСП, ХДФ, МДФ) → матовый.
 */
export function materialType(materialId: string, _def?: ViewerMaterial): MaterialType {
  const id = materialId.toLowerCase();
  if (id.includes('mirror') || id.includes('zerkal')) return 'mirror';
  if (id.includes('glass') || id.includes('steklo')) return 'glass';
  if (id.startsWith('rod_') || id.includes('chrome') || id.includes('metal') || id.includes('alu') || id.includes('steel'))
    return 'metal';
  if (id.includes('acryl') || id.includes('akril')) return 'acrylic';
  if (id.includes('soft')) return 'softtouch';
  if (id.includes('satin')) return 'satin';
  if (id.includes('veneer') || id.includes('shpon')) return 'veneer';
  if (id.includes('gloss') || id.includes('glyan') || id.startsWith('countertop_')) return 'gloss';
  return 'matte';
}

/** Совпадает с прежним `surfaceKind`: board — всё, что не металл, зеркало и стекло. */
export function isBoardType(t: MaterialType): boolean {
  return t !== 'metal' && t !== 'mirror' && t !== 'glass';
}

// ---------- Процедурная текстура волокон ----------

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Сколько мм дерева покрывает одна плитка процедурной текстуры: [вдоль волокон, поперёк].
 * Годичные слои ~3,5 мм, «рисунок» (дуги, полосы тона) — 100–300 мм: как у настоящей плиты, а не «мрамор».
 */
export const GRAIN_TILE_MM: [number, number] = [800, 200];

/** Сглаженный шум по кругу (бесшовно), n значений. */
function loopNoise(n: number, seed: number, smooth: number): Float32Array {
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = hash(i + seed * 1013);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -smooth; k <= smooth; k++) acc += raw[(i + k + n) % n]!;
    out[i] = acc / (2 * smooth + 1);
  }
  return out;
}

/**
 * Серая бесшовная текстура древесных волокон (DataTexture — без canvas, работает в вебе, expo-gl и Node).
 * Волокна идут вдоль U; плитка — GRAIN_TILE_MM (800 × 200 мм), повтор задаёт сцена по реальному размеру.
 * Тонкие годичные слои (~3,5 мм) с тёмной поздней древесиной, поры-штрихи вдоль волокон,
 * мягкий изгиб слоёв (дуги 200–400 мм) и полосы тона ~100 мм. Яркость 0.8…1, цвет даёт material.color.
 */
export function createWoodGrainTexture(size = 256, seed = 1): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const TAU = Math.PI * 2;
  const rings = Math.round(GRAIN_TILE_MM[1] / 3.5); // слоёв на плитку поперёк
  // Поры: шум по строкам (поперёк), вдоль — длинные штрихи (свой шум на каждые 16 px)
  const rowNoise = loopNoise(size, seed, 0);
  const streak = loopNoise(size * 4, seed + 7, 1);
  const jitter = loopNoise(rings, seed + 3, 1);
  for (let t = 0; t < size; t++) {
    const v = t / size;
    for (let s = 0; s < size; s++) {
      const u = s / size;
      // Изгиб слоёв: несколько слоёв вбок на длине 200–400 мм; целые частоты — бесшовно
      const bend = 2.2 * Math.sin(TAU * (2 * u + v) + seed) + 1.1 * Math.sin(TAU * (u - 2 * v) + seed * 2.3);
      const ring = v * rings + bend;
      const ri = ((Math.floor(ring) % rings) + rings) % rings;
      const f = ring - Math.floor(ring);
      // Поздняя древесина — узкая тёмная полоса в конце слоя (ширина слоя чуть «дышит»)
      const late = smoothstep(0.62 + 0.12 * jitter[ri]!, 0.86, f) * (1 - smoothstep(0.9, 1, f));
      // Сила рисунка и тон — полосы ~100 мм поперёк, мягко гуляют вдоль
      const contrast = 0.55 + 0.45 * Math.sin(TAU * (2 * v + 0.35 * Math.sin(TAU * u + seed)) + seed * 0.7);
      const tone = 0.5 + 0.5 * Math.sin(TAU * (v + 0.5 * Math.sin(TAU * (u + v)) ) + seed * 1.7);
      const pore = rowNoise[t]! * streak[(Math.floor(u * size * 4) + t * 37) % (size * 4)]!;
      let l = 1 - 0.11 * late * contrast - 0.06 * pore - 0.045 * tone;
      l = Math.min(1, Math.max(0.8, l));
      const o = (t * size + s) * 4;
      const b = Math.round(l * 255);
      data[o] = b;
      data[o + 1] = b;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = SRGBColorSpace;
  tex.name = 'wood-grain';
  tex.needsUpdate = true;
  return tex;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Загрузка скана декора без ожидания (браузер: TextureLoader). Где нет DOM (Node, RN) — null:
 * в приложении передайте свой `loadTexture` (expo-gl).
 */
export function loadTextureAsync(url: string): Promise<Texture | null> {
  const doc = (globalThis as { document?: unknown }).document;
  if (!doc) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      new TextureLoader().load(url, (t) => resolve(t), undefined, () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** Загрузка картинки декора. В Node и там, где нет Image, вернёт null. */
export function loadTextureUrl(url: string): Texture | null {
  try {
    const tex = new TextureLoader().load(url);
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  } catch {
    return null;
  }
}

export type ProductMaterial = MeshStandardMaterial | MeshPhysicalMaterial | MeshLambertMaterial;

export interface CreateMaterialInput {
  id: string;
  def: ViewerMaterial | undefined;
  config?: MaterialConfig;
  model: MaterialModel;
  /** Готовая карта (процедурная или загруженная) или null. */
  map: Texture | null;
  /** Шероховатость матовых плит из старой опции `roughness`. */
  matteRoughness?: number;
  polygonOffset: boolean;
}

/** Материал детали по типу поверхности и качеству. */
export function createMaterial(input: CreateMaterialInput): ProductMaterial {
  const { id, def, config, model, map } = input;
  const type = config?.type ?? materialType(id, def);
  const preset = PBR_PRESETS[type];
  const userMap = config?.map !== undefined;
  const color = new Color(config?.color ?? (userMap ? '#ffffff' : def?.color ?? '#cfcac0'));
  const roughness = config?.roughness ?? (type === 'matte' && input.matteRoughness !== undefined ? input.matteRoughness : preset.roughness);
  const metalness = config?.metalness ?? preset.metalness;
  const transparent = preset.opacity !== undefined;
  const common = {
    color,
    map,
    transparent,
    opacity: preset.opacity ?? 1,
    // Небольшой сдвиг глубины, чтобы рёбра не мерцали на гранях.
    polygonOffset: input.polygonOffset,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    vertexColors: Boolean(config?.vertexColors),
  };
  let m: ProductMaterial;
  if (model === 'lambert') {
    // Без карты окружения металл в PBR чёрный; в Lambert делаем его просто светлым.
    if (type === 'metal' || type === 'mirror') color.lerp(new Color('#ffffff'), 0.25);
    m = new MeshLambertMaterial(common);
  } else if (model === 'physical' && (preset.clearcoat || preset.sheen)) {
    const p = new MeshPhysicalMaterial({ ...common, roughness, metalness });
    if (preset.clearcoat) {
      p.clearcoat = preset.clearcoat;
      p.clearcoatRoughness = preset.clearcoatRoughness ?? 0.1;
    }
    if (preset.sheen) {
      p.sheen = preset.sheen;
      p.sheenRoughness = 0.8;
      p.sheenColor = new Color('#ffffff');
    }
    m = p;
  } else {
    m = new MeshStandardMaterial({ ...common, roughness, metalness });
  }
  m.name = id;
  m.userData.materialType = type;
  m.userData.surface = isBoardType(type) ? 'board' : type;
  return m;
}

// ---------- Декор внутри меша фасада ----------

export interface InlayUniforms {
  inlayColor: { value: Color };
  inlayRough: { value: number };
  inlayMetal: { value: number };
  /** Множитель отражений окружения для краски и для металла (envMapIntensity = 1). */
  inlayPaintEnv: { value: number };
  inlayMetalEnv: { value: number };
}

/**
 * Сдвиг глубины декора (атрибут `decorLift` = 1) в шагах 16-битного буфера глубины — как polygonOffset units,
 * но по вершинам: паз и вставка лежат в 0,2–0,6 мм от лица фасада, а в expo-gl (16 бит) шаг глубины
 * на расстоянии 3–5 м — миллиметры. Без сдвига паз «рвётся» (z-fighting).
 */
export const DECOR_DEPTH_BIAS = (8 * 2) / 65536;

/**
 * Материал фасада с декором: (1) сдвиг глубины декора; (2) если есть вставка — атрибут `metalMask` (1 — металл)
 * подменяет в шейдере цвет, металличность, шероховатость и силу отражений. Так фасад с пазами, молдингом
 * и рамкой — один вызов отрисовки. Патч не переживает clone() — вызвать заново (см. highlightMaterial).
 */
export function patchDecorMaterial(m: ProductMaterial, uniforms: InlayUniforms | null): void {
  if (uniforms) m.userData.inlayUniforms = uniforms;
  m.userData.decorPatched = true;
  const lambert = m instanceof MeshLambertMaterial;
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float decorLift;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>\n\tgl_Position.z -= decorLift * ${DECOR_DEPTH_BIAS.toExponential(6)} * gl_Position.w;`,
      );
    if (!uniforms) return;
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('attribute float decorLift;', 'attribute float decorLift;\nattribute float metalMask;\nvarying float vMetalMask;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvMetalMask = metalMask;');
    let fs = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vMetalMask;\nuniform vec3 inlayColor;\nuniform float inlayRough;\nuniform float inlayMetal;\nuniform float inlayPaintEnv;\nuniform float inlayMetalEnv;',
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb = mix( diffuseColor.rgb, inlayColor, vMetalMask );');
    if (!lambert) {
      fs = fs
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, inlayRough, vMetalMask );')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = mix( metalnessFactor, inlayMetal, vMetalMask );')
        .replace(
          '#include <envmap_physical_pars_fragment>',
          ShaderChunk.envmap_physical_pars_fragment.replace(
            /\* envMapIntensity;/g,
            '* envMapIntensity * mix( inlayPaintEnv, inlayMetalEnv, vMetalMask );',
          ),
        );
    }
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => (uniforms ? 'mebel-decor-inlay' : 'mebel-decor');
  m.needsUpdate = true;
}
