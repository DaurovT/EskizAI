/** Декоры SCR-09 из GET /catalog/decors: семейства цвета, текстуры, краска (без React — покрыто тестами). */
import type { ImageSourcePropType } from 'react-native';
import type { ColorFamily, DecorOut, PaintColor, PaintGlossId } from '../api/types';
import { API_URL } from '../config';
import { BUNDLED_TEXTURES } from './bundledTextures';

export type Tone = 'all' | 'light' | 'wood' | 'dark';

export const toneOf = (d: Pick<DecorOut, 'has_grain' | 'color'>): Exclude<Tone, 'all'> =>
  d.has_grain ? 'wood' : parseInt(d.color.slice(1, 3), 16) > 200 ? 'light' : 'dark';

/** Плиты корпуса и фасадов: ЛДСП/МДФ от 16 мм; в наличии — первыми. */
export function boardDecorsOf(items: DecorOut[], f: { color?: Tone; q?: string } = {}): DecorOut[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return items
    .filter((d) => (d.kind === 'ldsp' || d.kind === 'mdf') && d.thickness >= 16)
    .filter((d) => !f.color || f.color === 'all' || toneOf(d) === f.color)
    .filter((d) => !q || `${d.name} ${d.name_uz} ${d.decor ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.available) - Number(a.available));
}

/** Семейства цвета в порядке чипов; ключ подписи — mat_fam_*. */
export const FAMILIES: { id: ColorFamily; key: string }[] = [
  { id: 'white', key: 'mat_fam_white' }, { id: 'grey', key: 'mat_fam_grey' }, { id: 'beige', key: 'mat_fam_beige' },
  { id: 'wood-light', key: 'mat_fam_wood_light' }, { id: 'wood-dark', key: 'mat_fam_wood_dark' },
  { id: 'black', key: 'mat_fam_black' }, { id: 'colour', key: 'mat_fam_colour' },
];

/** Картинка текстуры: `bundled:имя` — из assets (мок), путь `/static/…` — с API. */
export function textureSource(texture: string | null | undefined, apiUrl: string = API_URL): ImageSourcePropType | null {
  if (!texture) return null;
  if (texture.startsWith('bundled:')) return BUNDLED_TEXTURES[texture.slice(8)] ?? null;
  if (/^https?:\/\//.test(texture)) return { uri: texture };
  return apiUrl ? { uri: `${apiUrl.replace(/\/$/, '')}${texture.startsWith('/') ? '' : '/'}${texture}` } : null;
}

/** Фасады окрашены: id материала — МДФ под покраску (`mdf_19_paint`). */
export const isPaintMaterial = (id: string | null | undefined) => !!id && /^mdf_\d+_paint$/.test(id);

export interface PaintSel { color: string; code: string; system: 'RAL' | 'NCS'; gloss: PaintGlossId }
export const paintOf = (c: PaintColor, gloss: PaintGlossId): PaintSel => ({ color: c.hex, code: c.code, system: c.system, gloss });

/** Цвет точки в чипе семейства (как в макете Materials.dc.html). */
export const FAM_DOT: Record<ColorFamily | 'all', string> = {
  all: '#C9C6BF', white: '#F7F6F3', grey: '#A9A59D', beige: '#D9D0C3', 'wood-light': '#D2B486', 'wood-dark': '#6E4C33', black: '#2A2B2C', colour: '#3E6B4E',
};

/** Название на карточке без вида и толщины: «Дуб Бардолино» (вид и толщина — в строке над списком). */
export const decorTitle = (d: Pick<DecorOut, 'name' | 'name_uz'>, lang: 'ru' | 'uz'): string =>
  (lang === 'uz' ? d.name_uz : d.name).replace(/^(ЛДСП|ЛМДФ|МДФ|Акрил|LDSP|LMDF|MDF|Akril)\s+\d+(?:[.,]\d+)?\s*(мм|mm)?\s*/i, '') || d.name;
