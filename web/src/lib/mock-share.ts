import 'server-only';
import type { ViewerModel } from '@mebel/viewer';
import wardrobeFull from '@/fixtures/wardrobe_full.viewer.json';
import wardrobeFullEst from '@/fixtures/wardrobe_full.estimate.json';
import kupe from '@/fixtures/kupe_3doors.viewer.json';
import kupeEst from '@/fixtures/kupe_3doors.estimate.json';
import niche from '@/fixtures/wardrobe_3sec_niche.viewer.json';
import nicheEst from '@/fixtures/wardrobe_3sec_niche.estimate.json';
import w2 from '@/fixtures/wardrobe_2sec.viewer.json';
import w2Est from '@/fixtures/wardrobe_2sec.estimate.json';
import cabinet from '@/fixtures/cabinet_door_drawer.viewer.json';
import type { ClientEstimate, EstimateView, Lang, LocalizedText, ShareGlb, SharePayload, ShareMaster } from './share-types';

/**
 * Мок-данные ссылок до появления бэкенда. Модели, сметы и GLB — образцы ядра
 * из schemas/samples (скопированы в src/fixtures и public/models).
 *
 * | токен   | изделие                               | язык | вид сметы  |
 * | demo    | шкаф: двери, ящики, антресоль, штанга | ru   | short      |
 * | kupe    | шкаф-купе, 3 двери (одна — зеркало)   | uz   | detailed   |
 * | niche   | шкаф в нишу, 3 секции                 | ru   | detailed   |
 * | 2sec    | шкаф 2 секции                         | ru   | total      |
 * | doors   | тестовая тумба viewer (дверь + ящик)  | ru   | total, после замера; GLB строится на лету |
 * | noprice | то же, мастер скрыл цену              | ru   | —          |
 * | 7Kx2    | шкаф из макета ClientPage (Мебель Плюс)| ru   | short      |
 * | expired | просроченная ссылка → 410             |      |            |
 * | revoked | ссылка отозвана → 410                 |      |            |
 *
 * Вид сметы можно подменить для проверки: ?view=total|short|detailed.
 */

const master: ShareMaster = {
  name: 'Азиз Каримов',
  workshop: 'Мебельный цех «Азиз»',
  phone: '+998901234567',
  telegram: 'aziz_mebel_demo',
};

/** Цех и мастер из макетов docs/design (ClientPage, ClientAgreed, ClientExpired). */
const designMaster: ShareMaster = {
  name: 'Тимур',
  workshop: 'Мебель Плюс',
  city: 'Ташкент',
  phone: '+998901234567',
  telegram: 'mebel_plus_demo',
};

const PRICE_DATE = '2026-11-02T09:00:00Z';

type EstimateSet = Record<EstimateView, ClientEstimate>;

/** Готовые GLB с сервера ядра (public/models). */
const serverGlb = (name: string): ShareGlb => ({
  closed: `/models/${name}.glb`,
  open: `/models/${name}_open.glb`,
});

/** Запасной вариант: GLB строит route handler тем же кодом viewer. */
const fallbackGlb = (token: string): ShareGlb => ({
  closed: `/api/share/${token}/glb/closed.glb`,
  open: `/api/share/${token}/glb/open.glb`,
});

interface Entry {
  title: LocalizedText;
  lang: Lang;
  view: EstimateView;
  model: ViewerModel;
  estimates: EstimateSet | null;
  glb: (token: string) => ShareGlb;
  modelVersion: string;
  /** Подменить габарит модели (мм: ширина, высота, глубина). */
  sizeMm?: [number, number, number];
  master?: ShareMaster;
}

/** Смета из макета: 6,1–6,3 млн + 3,1–3,2 млн, итого 9,2–10,5 млн. */
const designShort: ClientEstimate = {
  view: 'short',
  exact: false,
  total: { from: 9_200_000, to: 10_500_000 },
  materials: { from: 6_100_000, to: 6_300_000 },
  work: { from: 3_100_000, to: 3_200_000 },
};

const designEstimates: EstimateSet = {
  total: { view: 'total', exact: false, total: designShort.total },
  short: designShort,
  detailed: {
    ...designShort,
    view: 'detailed',
    groups: [
      { name: 'Листы', from: 4_300_000, to: 4_420_000 },
      { name: 'Кромка', from: 260_000, to: 270_000 },
      { name: 'Распил и кромкование', from: 640_000, to: 660_000 },
      { name: 'Фурнитура', from: 900_000, to: 950_000 },
    ],
    requests: [{ name: 'Ручки-скобы, цвет под фасад', note: 'уточняется' }],
  },
}

const cabinetEstimates: EstimateSet = {
  total: { view: 'total', exact: true, total: { from: 2_400_000, to: 2_400_000 } },
  short: {
    view: 'short',
    exact: true,
    total: { from: 2_400_000, to: 2_400_000 },
    materials: { from: 1_600_000, to: 1_600_000 },
    work: { from: 800_000, to: 800_000 },
  },
  detailed: {
    view: 'detailed',
    exact: true,
    total: { from: 2_400_000, to: 2_400_000 },
    materials: { from: 1_600_000, to: 1_600_000 },
    work: { from: 800_000, to: 800_000 },
    groups: [
      { name: 'Листы', from: 1_040_000, to: 1_040_000 },
      { name: 'Кромка', from: 60_000, to: 60_000 },
      { name: 'Распил и кромкование', from: 180_000, to: 180_000 },
      { name: 'Фурнитура', from: 320_000, to: 320_000 },
    ],
    requests: [{ name: 'Ручки-скобы, цвет под фасад', note: 'уточняется' }],
  },
};

const ENTRIES: Record<string, Entry> = {
  '7Kx2': {
    title: { ru: 'Шкаф', uz: 'Shkaf' },
    lang: 'ru',
    view: 'short',
    model: wardrobeFull as unknown as ViewerModel,
    estimates: designEstimates,
    glb: () => serverGlb('wardrobe_full'),
    modelVersion: 'v3',
    sizeMm: [1600, 2400, 600],
    master: designMaster,
  },
  demo: {
    title: { ru: 'Шкаф распашной с антресолью', uz: 'Antresolli ochiladigan shkaf' },
    lang: 'ru',
    view: 'short',
    model: wardrobeFull as unknown as ViewerModel,
    estimates: wardrobeFullEst as unknown as EstimateSet,
    glb: () => serverGlb('wardrobe_full'),
    modelVersion: 'v4',
  },
  kupe: {
    title: { ru: 'Шкаф-купе, 3 двери', uz: 'Kupe shkaf, 3 eshik' },
    lang: 'uz',
    view: 'detailed',
    model: kupe as unknown as ViewerModel,
    estimates: kupeEst as unknown as EstimateSet,
    glb: () => serverGlb('kupe_3doors'),
    modelVersion: 'v2',
  },
  niche: {
    title: { ru: 'Шкаф в нишу, 3 секции', uz: 'Nishaga shkaf, 3 seksiya' },
    lang: 'ru',
    view: 'detailed',
    model: niche as unknown as ViewerModel,
    estimates: nicheEst as unknown as EstimateSet,
    glb: () => serverGlb('wardrobe_3sec_niche'),
    modelVersion: 'v1',
  },
  '2sec': {
    title: { ru: 'Шкаф, 2 секции', uz: 'Shkaf, 2 seksiya' },
    lang: 'ru',
    view: 'total',
    model: w2 as unknown as ViewerModel,
    estimates: w2Est as unknown as EstimateSet,
    glb: () => serverGlb('wardrobe_2sec'),
    modelVersion: 'v1',
  },
  doors: {
    title: { ru: 'Тумба с дверью и ящиком', uz: 'Eshikli va tortmali tumba' },
    lang: 'ru',
    view: 'total',
    model: cabinet as unknown as ViewerModel,
    estimates: cabinetEstimates,
    glb: fallbackGlb,
    modelVersion: 'v2',
  },
  noprice: {
    title: { ru: 'Тумба с дверью и ящиком', uz: 'Eshikli va tortmali tumba' },
    lang: 'ru',
    view: 'total',
    model: cabinet as unknown as ViewerModel,
    estimates: null,
    glb: fallbackGlb,
    modelVersion: 'v2',
  },
};

/** Кто нажал «Согласен» (в памяти процесса — только для мока). */
const agreed = new Map<string, string>();

export type MockResult =
  | { ok: true; data: SharePayload }
  | { ok: false; status: 404 | 410; error: 'not_found' | 'expired' | 'revoked'; master?: ShareMaster };

function isView(v: unknown): v is EstimateView {
  return v === 'total' || v === 'short' || v === 'detailed';
}

export function mockShare(token: string, viewOverride?: string | null): MockResult {
  if (token === 'expired') return { ok: false, status: 410, error: 'expired', master: designMaster };
  if (token === 'revoked') return { ok: false, status: 410, error: 'revoked', master: designMaster };
  const e = ENTRIES[token];
  if (!e) return { ok: false, status: 404, error: 'not_found' };
  const view = isView(viewOverride) ? viewOverride : e.view;
  const m = e.model;
  return {
    ok: true,
    data: {
      version: 1,
      token,
      lang: e.lang,
      expiresAt: null,
      agreedAt: agreed.get(token) ?? null,
      project: {
        title: e.title,
        sizeMm: e.sizeMm ?? [m.size[0], m.size[1], m.size[2]],
        modelVersion: e.modelVersion,
      },
      master: e.master ?? master,
      model: m,
      glb: e.glb(token),
      // Как на сервере (NFR-10): только поля выбранного вида.
      estimate: e.estimates ? e.estimates[view] : null,
      priceDate: e.estimates ? PRICE_DATE : null,
    },
  };
}

export function mockAgree(token: string): string | null {
  const r = mockShare(token);
  if (!r.ok) return null;
  const at = agreed.get(token) ?? new Date().toISOString();
  agreed.set(token, at);
  return at;
}
