/**
 * Мок «Входящих чертежей» (SCR-52…55): три синтетических пакета из Eskiz DWG.
 * Превью — `mock:<имя>` (картинки assets/mock/dwg_*.png, их подставляет ui/DrawingImage); текст листа — как
 * собирает сервер из data.json (services/inbox_project.sheet_text).
 */
import type * as T from '../types';

const DAY = 86_400_000;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

export interface MockSheet extends T.InboxSheet { id: string; text: string }
export interface MockDrawing { d: T.InboxDrawing; sheets: MockSheet[]; units?: { code: string; source: 'file' | 'guessed' }; release?: string; deleted?: boolean }

export function seedInbox(): MockDrawing[] {
  const exp = (msAgo: number) => new Date(Date.now() - msAgo + 90 * DAY).toISOString();
  const base = (o: Partial<T.InboxDrawing> & Pick<T.InboxDrawing, 'id' | 'title' | 'filename'>): T.InboxDrawing => ({
    size: 310_000, sha256: o.id.padEnd(64, '0'), created_at: iso(), last_opened_at: null, expires_at: exp(0), preview_url: null,
    sheet_count: 1, units_guessed: false, units_note: null, package_created_at: iso(), source_kind: 'dwg', project_id: null, ...o,
  });
  return [
    {
      d: base({ id: 'dwg-kitchen', title: 'Кухня_Юнусабад', filename: 'Кухня_Юнусабад.eskiz', size: 312_000, source_kind: 'dxf',
        created_at: iso(2 * 3600_000), expires_at: exp(2 * 3600_000), sheet_count: 2, preview_url: 'mock:dwg_kitchen_plan' }),
      sheets: [
        { id: 's1', number: '1', name: 'Кухня — план', selected: true, preview_url: 'mock:dwg_kitchen_plan',
          text: 'Чертёж из Eskiz DWG «Кухня Юнусабад», лист 1 «Кухня — план», масштаб 1:20. Размеры в мм.\nГабариты: 3200 × 2400.\n'
            + 'Цепочки размеров: 600 ×4 + 800 = 3200 (гориз.); 600 ×4 = 2400 (верт.).\nНадписи: Мойка у окна; Варочная 600; Мойка 800.' },
        { id: 's2', number: '2', name: 'Развёртка', selected: false, preview_url: 'mock:dwg_kitchen_elev',
          text: 'Чертёж из Eskiz DWG «Кухня Юнусабад», лист 2 «Развёртка», масштаб 1:20. Размеры в мм.\nГабариты: 3200.\n'
            + 'Размеры: 850, 720.\nНадписи: Столешница 38; Верхний ряд 720.' },
      ],
    },
    {
      d: base({ id: 'dwg-kupe', title: 'Шкаф-купе Чиланзар', filename: 'Шкаф-купе Чиланзар.eskiz', size: 1_420_000,
        created_at: iso(DAY + 3 * 3600_000), last_opened_at: iso(DAY), expires_at: exp(DAY), sheet_count: 3, preview_url: 'mock:dwg_kupe' }),
      release: '2018+',
      sheets: [
        { id: 's1', number: '1', name: 'Фасад', selected: true, preview_url: 'mock:dwg_kupe',
          text: 'Чертёж из Eskiz DWG «Шкаф-купе Чиланзар», лист 1 «Фасад». Размеры в мм.\nГабариты: 1800 × 2400.\nНадписи: Шкаф-купе, три двери, зеркало посередине; Антресоль.' },
        { id: 's2', number: '2', name: 'Наполнение', selected: false, preview_url: null,
          text: 'Чертёж из Eskiz DWG «Шкаф-купе Чиланзар», лист 2 «Наполнение». Размеры в мм.\nНадписи: Шкаф-купе; полки, штанга, 2 ящика.' },
        { id: 's3', number: '3', name: 'Разрез', selected: false, preview_url: null,
          text: 'Чертёж из Eskiz DWG «Шкаф-купе Чиланзар», лист 3 «Разрез». Размеры в мм.\nГабариты: 600 × 2400.' },
      ],
    },
    {
      d: base({ id: 'dwg-hall', title: 'Прихожая_Сергели', filename: 'Прихожая_Сергели.eskiz', size: 205_000,
        created_at: iso(5 * DAY), last_opened_at: iso(4 * DAY), expires_at: exp(4 * DAY), sheet_count: 1, preview_url: 'mock:dwg_hallway',
        units_guessed: true, units_note: 'В файле нет единиц — взяли сантиметры' }),
      units: { code: 'cm', source: 'guessed' }, release: '2013',
      sheets: [
        { id: 's1', number: '1', name: 'Прихожая', selected: true, preview_url: 'mock:dwg_hallway',
          text: 'Чертёж из Eskiz DWG «Прихожая Сергели», лист 1 «Прихожая». Размеры в мм.\nЕдиницы угаданы — проверьте размеры.\nГабариты: 2100 × 2000.' },
      ],
    },
  ];
}

/** Похоже ли описание на текст листа из чертежа (тогда мок «распознаёт» по-своему). */
export const isDrawingText = (text: string) => /^(Чертёж из Eskiz DWG|Eskiz DWG chizmasi)/.test(text.trim());
