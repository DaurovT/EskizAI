/**
 * Данные мока: viewer-модели и сметы — настоящие образцы ядра из schemas/samples,
 * деревья модулей — копии core/tests/fixtures (их в samples нет).
 */
import type { ViewerModel } from '@mebel/viewer';
import type { ClientEstimate, EstimateView, ProductTree } from '../types';

import wardrobeFullV from '../../../../schemas/samples/wardrobe_full.viewer.json';
import wardrobeFullE from '../../../../schemas/samples/wardrobe_full.estimate.json';
import kupeV from '../../../../schemas/samples/kupe_3doors.viewer.json';
import kupeE from '../../../../schemas/samples/kupe_3doors.estimate.json';
import w2V from '../../../../schemas/samples/wardrobe_2sec.viewer.json';
import w2E from '../../../../schemas/samples/wardrobe_2sec.estimate.json';
import nicheV from '../../../../schemas/samples/wardrobe_3sec_niche.viewer.json';
import nicheE from '../../../../schemas/samples/wardrobe_3sec_niche.estimate.json';
import kitchenV from '../../../../schemas/samples/kitchen_straight.viewer.json';
import kitchenE from '../../../../schemas/samples/kitchen_straight.estimate.json';
import kitchenCornerV from '../../../../schemas/samples/kitchen_corner.viewer.json';
import kitchenCornerE from '../../../../schemas/samples/kitchen_corner.estimate.json';
// декор фасадов, подсветка, встройка (docs/decor_contract.md) — деревья тоже из samples
import wardrobeDecorT from '../../../../schemas/samples/wardrobe_decor.json';
import wardrobeDecorV from '../../../../schemas/samples/wardrobe_decor.viewer.json';
import wardrobeDecorE from '../../../../schemas/samples/wardrobe_decor.estimate.json';
import kitchenDecorT from '../../../../schemas/samples/kitchen_decor.json';
import kitchenDecorV from '../../../../schemas/samples/kitchen_decor.viewer.json';
import kitchenDecorE from '../../../../schemas/samples/kitchen_decor.estimate.json';
import wardrobeBuiltinT from '../../../../schemas/samples/wardrobe_builtin.json';
import wardrobeBuiltinV from '../../../../schemas/samples/wardrobe_builtin.viewer.json';
import wardrobeBuiltinE from '../../../../schemas/samples/wardrobe_builtin.estimate.json';
import kitchenBuiltinT from '../../../../schemas/samples/kitchen_builtin.json';
import kitchenBuiltinV from '../../../../schemas/samples/kitchen_builtin.viewer.json';
import kitchenBuiltinE from '../../../../schemas/samples/kitchen_builtin.estimate.json';

export type SampleKey = 'wardrobe_full' | 'kupe_3doors' | 'wardrobe_2sec' | 'wardrobe_3sec_niche' | 'kitchen_straight' | 'kitchen_corner'
  | 'wardrobe_decor' | 'kitchen_decor' | 'wardrobe_builtin' | 'kitchen_builtin';

export interface Sample {
  key: SampleKey;
  productKind: string;
  title: { ru: string; uz: string };
  viewer: ViewerModel;
  estimate: Record<EstimateView, ClientEstimate>;
  tree: ProductTree;
}

const v = (x: unknown) => x as ViewerModel;
const e = (x: unknown) => x as Record<EstimateView, ClientEstimate>;
const tr = (x: unknown, type: string) => ({ schema_version: '0.2', type, ...(x as ProductTree) }) as ProductTree;

export const SAMPLES: Record<SampleKey, Sample> = {
  wardrobe_full: {
    key: 'wardrobe_full', productKind: 'wardrobe',
    title: { ru: 'Шкаф с антресолью', uz: 'Antresolli shkaf' },
    viewer: v(wardrobeFullV), estimate: e(wardrobeFullE),
    tree: {
      schema_version: '0.2', type: 'wardrobe', width: 1800, height: 2400, depth: 600,
      body: { material: 'ldsp_16_white' },
      fronts: { material: 'ldsp_18_oak', handles: { kind: 'bar', spacing: 128 } },
      mezzanine: { height: 400 },
      sections: [
        { width: 570, fill: [{ kind: 'shelves', count: 4 }], doors: { count: 1, hinge: 'left' } },
        { fill: [{ kind: 'drawers', count: 3, external: true, height: 600 }, { kind: 'rod' }], doors: { count: 2 } },
        { width: 570, fill: [{ kind: 'drawers', count: 2, height: 400 }, { kind: 'shelves', count: 3 }], doors: { count: 1, hinge: 'right' } },
      ],
    },
  },
  kupe_3doors: {
    key: 'kupe_3doors', productKind: 'wardrobe_sliding',
    title: { ru: 'Шкаф-купе, 3 двери', uz: 'Kupe shkaf, 3 eshik' },
    viewer: v(kupeV), estimate: e(kupeE),
    tree: {
      schema_version: '0.2', type: 'wardrobe', width: 2400, height: 2400, depth: 650, installation: 'niche',
      body: { material: 'ldsp_16_white', top: 'between' },
      sliding_doors: { count: 3, fills: ['panel', 'mirror', 'panel'] },
      sections: [
        { width: 780, fill: [{ kind: 'shelves', count: 5 }] },
        { fill: [{ kind: 'drawers', count: 2, height: 400 }, { kind: 'rod' }] },
        { width: 780, fill: [{ kind: 'shelves', count: 5 }] },
      ],
    },
  },
  wardrobe_2sec: {
    key: 'wardrobe_2sec', productKind: 'rack',
    title: { ru: 'Стеллаж, 2 секции', uz: 'Stellaj, 2 seksiya' },
    viewer: v(w2V), estimate: e(w2E),
    tree: {
      schema_version: '0.2', type: 'wardrobe', width: 1200, height: 2400, depth: 600,
      body: { material: 'ldsp_16_white' },
      sections: [{ fill: [{ kind: 'shelves', count: 4 }] }, { fill: [{ kind: 'shelves', count: 4 }] }],
    },
  },
  wardrobe_3sec_niche: {
    key: 'wardrobe_3sec_niche', productKind: 'wardrobe',
    title: { ru: 'Шкаф в нишу, 3 секции', uz: 'Nishaga shkaf, 3 seksiya' },
    viewer: v(nicheV), estimate: e(nicheE),
    tree: {
      schema_version: '0.2', type: 'wardrobe', width: 2400, height: 2600, depth: 650, installation: 'niche',
      body: { material: 'ldsp_18_oak' },
      sections: [{ fill: [{ kind: 'shelves', count: 5 }] }, { fill: [{ kind: 'shelves', count: 5 }] }, { fill: [{ kind: 'shelves', count: 5 }] }],
    },
  },
  kitchen_straight: {
    key: 'kitchen_straight', productKind: 'kitchen',
    title: { ru: 'Кухня прямая', uz: 'To‘g‘ri oshxona' },
    viewer: v(kitchenV), estimate: e(kitchenE),
    tree: {
      schema_version: '0.2', type: 'kitchen', installation: 'niche',
      body: { material: 'ldsp_16_white' }, fronts: { material: 'ldsp_18_oak' },
      countertop: { material: 'countertop_38_stone' },
      base: [
        { kind: 'drawers', width: 400, drawers: 3 }, { kind: 'doors', width: 600, hinge: 'right' },
        { kind: 'appliance', width: 600 }, { kind: 'sink', width: 800 }, { kind: 'doors', width: 450, hinge: 'right' },
      ],
      wall: [
        { kind: 'doors', width: 400 }, { kind: 'doors', width: 600 }, { kind: 'hood', width: 600 },
        { kind: 'doors', width: 800 }, { kind: 'open', width: 450, shelves: 2 },
      ],
    },
  },
  // Угловая кухня (Г-образный угол слева) — копия core/tests/fixtures/kitchen_corner_square.json
  kitchen_corner: {
    key: 'kitchen_corner', productKind: 'kitchen_corner',
    title: { ru: 'Кухня угловая', uz: 'Burchakli oshxona' },
    viewer: v(kitchenCornerV), estimate: e(kitchenCornerE),
    tree: {
      schema_version: '0.2', type: 'kitchen', layout: 'corner', corner_side: 'left', installation: 'niche',
      fronts: { material: 'ldsp_18_white' }, countertop: { material: 'countertop_38_oak' },
      base: [
        { kind: 'corner', width: 900, corner_shape: 'square', corner_fill: 'carousel' }, { kind: 'appliance', width: 600, hob: true },
        { kind: 'appliance', width: 450 }, { kind: 'sink', width: 850 },
      ],
      wall: [{ kind: 'doors', width: 600 }, { kind: 'hood', width: 600 }, { kind: 'gap', width: 1200 }, { kind: 'doors', width: 400 }],
      base2: [{ kind: 'drawers', width: 450, drawers: 3 }, { kind: 'doors', width: 450, shelf: true }],
      wall2: [{ kind: 'doors', width: 450 }, { kind: 'doors', width: 450, hinge: 'right' }],
    },
  },
  wardrobe_decor: {
    key: 'wardrobe_decor', productKind: 'wardrobe', title: { ru: 'Шкаф с декором фасадов', uz: 'Bezakli shkaf' },
    viewer: v(wardrobeDecorV), estimate: e(wardrobeDecorE), tree: tr(wardrobeDecorT, 'wardrobe'),
  },
  kitchen_decor: {
    key: 'kitchen_decor', productKind: 'kitchen', title: { ru: 'Кухня с фрезеровкой и подсветкой', uz: 'Bezakli oshxona' },
    viewer: v(kitchenDecorV), estimate: e(kitchenDecorE), tree: tr(kitchenDecorT, 'kitchen'),
  },
  wardrobe_builtin: {
    key: 'wardrobe_builtin', productKind: 'wardrobe', title: { ru: 'Встроенный шкаф в нишу', uz: 'Nishaga o‘rnatilgan shkaf' },
    viewer: v(wardrobeBuiltinV), estimate: e(wardrobeBuiltinE),
    // демо SCR-51: цвет стен снят с фото клиента, пол — пресет
    tree: { ...tr(wardrobeBuiltinT, 'wardrobe'), room_colors: { wall: '#E3D7C6', floor_material: 'oak_light', source: 'photo' } },
  },
  kitchen_builtin: {
    key: 'kitchen_builtin', productKind: 'kitchen', title: { ru: 'Кухня до потолка', uz: 'Shiftgacha oshxona' },
    viewer: v(kitchenBuiltinV), estimate: e(kitchenBuiltinE), tree: tr(kitchenBuiltinT, 'kitchen'),
  },
};

/** Мок без ядра: дерево с декором/встройкой рисуем по похожему образцу ядра (та же сетка секций/модулей). */
export function sampleFor(sample: SampleKey, tree: ProductTree, hasDecor: boolean, hasBuiltin: boolean): SampleKey {
  if (tree.type === 'kitchen') {
    if (!['kitchen_straight', 'kitchen_decor', 'kitchen_builtin'].includes(sample)) return sample;
    return hasBuiltin ? 'kitchen_builtin' : hasDecor ? 'kitchen_decor' : sample;
  }
  if (hasBuiltin && ['wardrobe_full', 'wardrobe_3sec_niche', 'wardrobe_decor'].includes(sample)) return 'wardrobe_builtin';
  if (hasDecor && sample === 'wardrobe_full') return 'wardrobe_decor';
  return sample;
}

/** Типы изделий для SCR-06 (полный список). */
export const PRODUCT_KINDS = ['wardrobe', 'wardrobe_sliding', 'rack', 'kitchen', 'kitchen_corner', 'dresser', 'tv_stand', 'hallway'] as const;

export const kindToSample = (kind: string | null | undefined): SampleKey => {
  switch (kind) {
    case 'wardrobe_sliding': return 'kupe_3doors';
    case 'rack': return 'wardrobe_2sec';
    case 'kitchen': return 'kitchen_straight';
    case 'kitchen_corner': return 'kitchen_corner';
    default: return 'wardrobe_full';
  }
};
