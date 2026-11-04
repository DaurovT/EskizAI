/**
 * Декоры для SCR-09. Пока API каталога нет — копия id из core/src/mebel_core/catalog.py
 * (только то, что ядро уже принимает в дереве). Когда появится GET каталога, заменить источник.
 */
export interface Decor {
  id: string;
  name: string;
  name_uz: string;
  kind: 'ldsp' | 'hdf' | 'glass' | 'countertop' | 'metal';
  thickness: number;
  color: string;
  hasGrain: boolean;
  brand: string;
  inStock: boolean;
}

export const DECORS: Decor[] = [
  { id: 'ldsp_16_white', name: 'ЛДСП 16 Белый', name_uz: 'LDSP 16 Oq', kind: 'ldsp', thickness: 16, color: '#f2f0eb', hasGrain: false, brand: 'EMAN', inStock: true },
  { id: 'ldsp_16_grey', name: 'ЛДСП 16 Серый', name_uz: 'LDSP 16 Kulrang', kind: 'ldsp', thickness: 16, color: '#9b9b97', hasGrain: false, brand: 'EMAN', inStock: true },
  { id: 'ldsp_16_oak', name: 'ЛДСП 16 Дуб сонома', name_uz: 'LDSP 16 Sonoma eman', kind: 'ldsp', thickness: 16, color: '#c9a57b', hasGrain: true, brand: 'EMAN', inStock: true },
  { id: 'ldsp_18_white', name: 'ЛДСП 18 Белый', name_uz: 'LDSP 18 Oq', kind: 'ldsp', thickness: 18, color: '#f2f0eb', hasGrain: false, brand: 'EMAN', inStock: true },
  { id: 'ldsp_18_oak', name: 'ЛДСП 18 Дуб сонома', name_uz: 'LDSP 18 Sonoma eman', kind: 'ldsp', thickness: 18, color: '#c9a57b', hasGrain: true, brand: 'EMAN', inStock: true },
  { id: 'ldsp_10_white', name: 'ЛДСП 10 Белый', name_uz: 'LDSP 10 Oq', kind: 'ldsp', thickness: 10, color: '#f2f0eb', hasGrain: false, brand: 'EMAN', inStock: true },
  { id: 'ldsp_10_oak', name: 'ЛДСП 10 Дуб сонома', name_uz: 'LDSP 10 Sonoma eman', kind: 'ldsp', thickness: 10, color: '#c9a57b', hasGrain: true, brand: 'EMAN', inStock: false },
  { id: 'mirror_4_silver', name: 'Зеркало 4 мм серебро', name_uz: 'Oyna 4 mm kumush', kind: 'glass', thickness: 4, color: '#dfe6ea', hasGrain: false, brand: 'EMAN', inStock: true },
  { id: 'countertop_38_oak', name: 'Столешница 38 мм Дуб', name_uz: 'Stoleshnitsa 38 mm Eman', kind: 'countertop', thickness: 38, color: '#b98f62', hasGrain: true, brand: 'EMAN', inStock: true },
  { id: 'countertop_38_stone', name: 'Столешница 38 мм Камень серый', name_uz: 'Stoleshnitsa 38 mm Kulrang tosh', kind: 'countertop', thickness: 38, color: '#8f8f8b', hasGrain: false, brand: 'EMAN', inStock: true },
  { id: 'hdf_3_white', name: 'ХДФ 3 Белый', name_uz: 'XDF 3 Oq', kind: 'hdf', thickness: 3, color: '#efebe3', hasGrain: false, brand: 'EMAN', inStock: true },
  { id: 'rod_oval_chrome', name: 'Штанга овальная хром', name_uz: 'Oval shtanga xrom', kind: 'metal', thickness: 15, color: '#c3c7cc', hasGrain: false, brand: 'EMAN', inStock: true },
];

export const decorById = (id: string | null | undefined) => DECORS.find((d) => d.id === id);
/** Декоры корпуса и фасадов — плиты ЛДСП 16/18. */
export const boardDecors = () => DECORS.filter((d) => d.kind === 'ldsp' && d.thickness >= 16);

/** Роли деталей, которые относятся к фасадам (для смены декора в моке и подсветки). */
export const FRONT_ROLES = new Set(['door', 'drawer_front', 'sliding_fill']);
