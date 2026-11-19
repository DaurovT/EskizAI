/**
 * Цвета декоров (ламинация) для рисунка схемы — копия oyna_data/decors.json (id → hex), работает без сети.
 * Неизвестный декор (свой RAL и т. п.) рисуется белым. Обновлять вместе с decors.json.
 */
export const DECOR_HEX: Record<string, string> = {
  "white": "#F4F4F2",
  "golden_oak": "#B5793A",
  "mahogany": "#6B2E1F",
  "dark_oak": "#4A3325",
  "walnut": "#7A4E2D",
  "mokko": "#5C4033",
  "anthracite": "#383E42",
  "grey": "#8A8D8F",
  "bronze": "#8C6A3F",
  "ral9016": "#F1F0EA",
  "ral_any": "#F4F4F2",
  "vacuum_gold": "#C9A44C",
};

export const WHITE = '#F7F6F3';

/** Цвет профиля в массе (setup.profile_color, shapes_contract §8) → hex для рисунка. */
export const PROFILE_HEX: Record<string, string> = {
  white: '#F7F6F3', cream: '#EFE6CF', brown: '#5A3A28', grey: '#8A8D8F', anthracite: '#383E42', anodized: '#B9BBBD',
};
/** RAL-коды, которые встречаются у алюминия (порошковая покраска); остальные — серым. */
const RAL_HEX: Record<string, string> = {
  '9016': '#F1F0EA', '9010': '#F1ECE1', '9003': '#ECECE7', '9005': '#0E0E10', '9006': '#A1A1A0', '9007': '#878581',
  '7016': '#383E42', '7024': '#474A50', '7035': '#C5C7C4', '7040': '#9DA3A6', '8017': '#45322E', '8014': '#4A3526',
  '8019': '#3D3635', '1013': '#E3D9C6', '1015': '#E6D2B5', '3005': '#5E2028', '5010': '#13447C', '6005': '#0F4336',
};
const GREY = '#8A8D8F';

export function profileColorHex(code?: string | null): string {
  if (!code) return WHITE;
  if (code.startsWith('ral:')) return RAL_HEX[code.slice(4).replace(/\s/g, '')] ?? GREY;
  return PROFILE_HEX[code] ?? GREY;
}

/** Ламинация стороны: lam_<side>; старые color_out / color_in (white → нет). null — ламинации нет. */
export function lamination(setup: { lam_out?: string | null; lam_in?: string | null; color_out?: string; color_in?: string } | undefined,
  side: 'inside' | 'outside'): string | null {
  const key = side === 'outside' ? 'lam_out' : 'lam_in';
  if (setup && key in setup) return setup[key] ?? null;
  const old = side === 'outside' ? setup?.color_out : setup?.color_in;
  return old && old !== 'white' ? old : null;
}

/** Видимый цвет стороны (схема, 3D): ламинация стороны, иначе цвет профиля в массе, иначе белый. */
export function profileHex(setup: { profile_color?: string; lam_out?: string | null; lam_in?: string | null; color_in?: string; color_out?: string } | undefined,
  side: 'inside' | 'outside'): string {
  const lam = lamination(setup, side);
  if (lam) return DECOR_HEX[lam] ?? WHITE;
  return profileColorHex(setup?.profile_color);
}

/** Тёмный ли цвет (для контрастных линий и ручки). */
export function isDark(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
}
