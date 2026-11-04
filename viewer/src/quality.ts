/**
 * Пресеты качества. Главный враг на бюджетных Android — число вызовов отрисовки
 * (draw calls) и пиксели (pixel ratio), а не треугольники: у шкафа их пара тысяч.
 */

export type QualityLevel = 'low' | 'medium' | 'high';

/** Модель освещения материалов: lambert дешевле всего, physical — лак и акрил с бликом. */
export type MaterialModel = 'lambert' | 'standard' | 'physical';

export interface QualitySettings {
  /** Тёмные линии по рёбрам. */
  edges: boolean;
  /**
   * Тень на полу: 'dynamic' — пересчитывается каждый кадр (ещё один проход сцены),
   * 'static' — один раз после загрузки, 'none' — без тени.
   */
  shadows: 'dynamic' | 'static' | 'none';
  /** Отражения окружения: всем материалам, только металлу/зеркалу/глянцу или никому. */
  environment: 'all' | 'reflective' | 'none';
  /** Предел devicePixelRatio для Canvas (dpr={[1, maxPixelRatio]}). */
  maxPixelRatio: number;
  /** Сглаживание WebGL (MSAA). */
  antialias: boolean;
  materialModel: MaterialModel;
  /** Текстуры декоров (своя картинка или процедурные волокна). */
  textures: boolean;
  /** Размер процедурной текстуры волокон, px (степень двойки). */
  textureSize: number;
  /** Сливать неподвижные детали одного материала в один меш. */
  merge: boolean;
  /** Сегментов на дугу контура. */
  curveSegments: number;
  /**
   * Фурнитура: 'all' — вся (ручки, петли, направляющие…), 'visible' — только видная снаружи
   * (без петель и направляющих), 'none' — без фурнитуры.
   */
  hardware: 'all' | 'visible' | 'none';
  /** Тени у стыков (полосы-градиенты AO, один вызов отрисовки): ниша с глубиной, а не «дырка». */
  ao: boolean;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, Readonly<QualitySettings>>> = {
  high: {
    edges: true,
    shadows: 'dynamic',
    environment: 'all',
    maxPixelRatio: 2,
    antialias: true,
    materialModel: 'physical',
    textures: true,
    textureSize: 512,
    merge: false,
    curveSegments: 24,
    hardware: 'all',
    ao: true,
  },
  medium: {
    edges: true,
    shadows: 'static',
    environment: 'reflective',
    maxPixelRatio: 1.5,
    antialias: true,
    materialModel: 'standard',
    textures: true,
    textureSize: 256,
    merge: true,
    curveSegments: 16,
    hardware: 'all',
    ao: true,
  },
  low: {
    edges: false,
    shadows: 'none',
    environment: 'none',
    maxPixelRatio: 1,
    antialias: false,
    materialModel: 'lambert',
    textures: true,
    textureSize: 128,
    merge: true,
    curveSegments: 8,
    hardware: 'visible',
    ao: true,
  },
};

export function qualitySettings(level: QualityLevel = 'high'): QualitySettings {
  return { ...(QUALITY_PRESETS[level] ?? QUALITY_PRESETS.high) };
}

export interface DeviceHints {
  userAgent?: string;
  /** navigator.deviceMemory, ГБ (есть только в Chrome). */
  deviceMemory?: number;
  /** navigator.hardwareConcurrency. */
  cores?: number;
  /** window.devicePixelRatio. */
  pixelRatio?: number;
}

/**
 * Грубая догадка о качестве по устройству. Без аргументов читает navigator (в вебе).
 * Бюджетный Android (≤ 4 ГБ или ≤ 4 ядра) → low, остальные телефоны → medium,
 * компьютер → high. В приложении передайте свои данные (expo-device).
 */
export function detectQuality(hints?: DeviceHints): QualityLevel {
  const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
  const ua = hints?.userAgent ?? (typeof nav?.userAgent === 'string' ? (nav.userAgent as string) : '');
  const mem = hints?.deviceMemory ?? (typeof nav?.deviceMemory === 'number' ? (nav.deviceMemory as number) : undefined);
  const cores =
    hints?.cores ?? (typeof nav?.hardwareConcurrency === 'number' ? (nav.hardwareConcurrency as number) : undefined);
  const android = /Android/i.test(ua);
  const mobile = android || /iPhone|iPad|iPod|Mobile/i.test(ua);
  if (android && ((mem !== undefined && mem <= 4) || (cores !== undefined && cores <= 4))) return 'low';
  if (mobile) return 'medium';
  return 'high';
}
