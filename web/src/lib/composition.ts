/**
 * «Что в изделии» для клиента — из viewer model, которая уже есть в ссылке (data.model).
 *
 * Чистые функции без React и i18n: на выходе — факты (материалы, виды, количества),
 * подписи собирает компонент. Только то, что видно на изделии: цвет/декор, вид фасадов,
 * ручки, наполнение. Цен деталей, поставщика, артикулов и наценки здесь нет и быть не должно (NFR-10).
 *
 * Импорты — только типы (стираются), чтобы файл запускался напрямую `node --test`.
 */
import type { ViewerHardware, ViewerMaterial, ViewerModel, ViewerPart } from '@mebel/viewer';

/** Роли фасадов (как FRONT_ROLES ядра: decor.py, estimate.py). */
export const FRONT_ROLES: ReadonlySet<string> = new Set(['door', 'drawer_front', 'sliding_fill', 'facade', 'front']);
/** Роли корпуса — по ним «цвет корпуса». Задняя стенка и дно ящика (ХДФ) не в счёт: их не видно. */
export const BODY_ROLES: ReadonlySet<string> = new Set(['side', 'top', 'bottom', 'partition', 'divider', 'shelf', 'plinth']);
const DRAWER_ROLES: ReadonlySet<string> = new Set(['drawer_front', 'drawer_side', 'drawer_wall', 'drawer_bottom']);

/** Вид плиты/фасада для подписи. other — вид не узнали, показываем только декор. */
export type BoardKind = 'ldsp' | 'lmdf' | 'mdf' | 'hdf' | 'dsp' | 'acrylic' | 'veneer' | 'mirror' | 'glass' | 'other';
export type Finish = 'matte' | 'satin' | 'gloss' | 'softtouch';

export interface Swatch {
  /** "#rrggbb" — цвет кружка. */
  color: string;
  /** Скан декора (http(s) или /static/…), если есть — кружок с текстурой. */
  texture: string | null;
}

export interface DecorInfo {
  /** Название декора без вида и толщины: «Дуб сонома», «Белый». Для краски — код (RAL 9003) или null. */
  name: string | null;
  swatch: Swatch;
  /** Фасады крашеные: название — код краски. */
  painted: boolean;
}

export interface FrontsInfo {
  kind: BoardKind;
  /** Толщина фасада, мм (самая частая). */
  thicknessMm: number | null;
  finish: Finish | null;
  painted: boolean;
  /** Код краски (RAL / NCS), если мастер указал. */
  paintCode: string | null;
  /** На фасадах есть фрезеровка / накладки / вставки. */
  milling: boolean;
}

export type HandleKind = 'bracket' | 'knob' | 'gola';

export interface HandlesInfo {
  kind: HandleKind;
  /** Межосевое, мм, если есть в названии («Ручка-скоба 128 мм»). */
  sizeMm: number | null;
  /** Ключ отделки фурнитуры: steel, chrome, black… (подпись — в i18n). */
  finish: string | null;
  /** Цвет отделки для кружка. */
  color: string | null;
  count: number;
}

export interface InsideInfo {
  doors: number;
  slidingDoors: number;
  drawers: number;
  shelves: number;
  rods: number;
  lights: number;
}

export interface Composition {
  /** Главный цвет — фасады (или корпус, если фасадов нет). */
  decor: DecorInfo | null;
  /** Цвет корпуса — только если отличается от фасадов. */
  body: DecorInfo | null;
  fronts: FrontsInfo | null;
  handles: HandlesInfo | null;
  inside: InsideInfo;
}

const KIND_PREFIXES: [RegExp, BoardKind][] = [
  [/^лмдф/i, 'lmdf'],
  [/^лдсп/i, 'ldsp'],
  [/^мдф/i, 'mdf'],
  [/^хдф/i, 'hdf'],
  [/^двп/i, 'hdf'],
  [/^дсп/i, 'dsp'],
  [/^акрил/i, 'acrylic'],
  [/^шпон/i, 'veneer'],
  [/^зеркало/i, 'mirror'],
  [/^стекло/i, 'glass'],
];

const ID_PREFIXES: [RegExp, BoardKind][] = [
  [/^lmdf/i, 'lmdf'],
  [/^ldsp/i, 'ldsp'],
  [/^mdf/i, 'mdf'],
  [/^hdf/i, 'hdf'],
  [/^dsp/i, 'dsp'],
  [/^acryl/i, 'acrylic'],
  [/^veneer/i, 'veneer'],
  [/^mirror/i, 'mirror'],
  [/^glass/i, 'glass'],
];

/** Вид материала по названию каталога («ЛДСП 18 Дуб сонома»), иначе по id («ldsp_18_oak»). */
export function boardKind(materialId: string, def: ViewerMaterial | undefined): BoardKind {
  const name = def?.name?.trim() ?? '';
  for (const [re, k] of KIND_PREFIXES) if (re.test(name)) return k;
  for (const [re, k] of ID_PREFIXES) if (re.test(materialId)) return k;
  if (def?.type === 'acrylic') return 'acrylic';
  if (def?.type === 'veneer') return 'veneer';
  if (def?.type === 'mirror') return 'mirror';
  return 'other';
}

/** «ЛДСП 18 Дуб сонома» → «Дуб сонома»; «МДФ 19 под покраску» → «под покраску»; «Белый» → «Белый». */
export function decorName(raw: string): string {
  const s = raw
    .trim()
    .replace(/^(ЛМДФ|ЛДСП|МДФ|ХДФ|ДВП|ДСП|Акрил|Шпон|Зеркало|Стекло)\s*/i, '')
    .replace(/^\d+(?:[.,]\d+)?\s*(?:мм)?\s*/i, '')
    .trim();
  const out = s || raw.trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function finishOf(t: string | undefined): Finish | null {
  if (t === 'matte' || t === 'satin' || t === 'gloss' || t === 'softtouch') return t;
  return null;
}

function texUrl(t: string | null | undefined): string | null {
  if (!t) return null;
  return /^(https?:)?\/\//.test(t) || t.startsWith('/') ? t : null; // bundled:… — только в приложении
}

/** Самое частое значение (при равенстве — первое встретившееся). */
function mode<T>(items: readonly T[]): T | null {
  const count = new Map<T, number>();
  let best: T | null = null;
  let max = 0;
  for (const x of items) {
    const n = (count.get(x) ?? 0) + 1;
    count.set(x, n);
    if (n > max) [best, max] = [x, n];
  }
  return best;
}

function paintOf(parts: readonly ViewerPart[]) {
  const painted = parts.filter((p) => p.decor?.paint?.color);
  if (painted.length === 0 || painted.length * 2 < parts.length) return null;
  const color = mode(painted.map((p) => p.decor!.paint!.color.toLowerCase()))!;
  const same = painted.filter((p) => p.decor!.paint!.color.toLowerCase() === color);
  const code = mode(same.map((p) => p.decor!.paint!.code?.trim()).filter((c): c is string => Boolean(c)));
  const gloss = mode(same.map((p) => p.decor!.paint!.gloss).filter((g): g is string => Boolean(g)));
  return { color, code, gloss: finishOf(gloss ?? undefined) };
}

function decorOf(model: ViewerModel, materialId: string): DecorInfo {
  const def = model.materials[materialId];
  return {
    name: def?.name ? decorName(def.name) : null,
    swatch: { color: def?.color ?? '#d9d6cf', texture: texUrl(def?.texture) },
    painted: false,
  };
}

function handlesOf(hw: readonly ViewerHardware[], model: ViewerModel): HandlesInfo | null {
  const items = hw.filter((h) => h.kind === 'handle' || h.kind === 'knob' || h.kind === 'gola');
  if (items.length === 0) return null;
  const kindKey = mode(items.map((h) => h.kind))!;
  const main = items.filter((h) => h.kind === kindKey);
  const kind: HandleKind = kindKey === 'knob' ? 'knob' : kindKey === 'gola' ? 'gola' : 'bracket';
  const name = mode(main.map((h) => h.name)) ?? '';
  const size = /(\d{2,4})\s*мм/i.exec(name);
  const finish = mode(main.map((h) => h.finish).filter(Boolean)) ?? null;
  const color = finish ? model.hardwareFinishes?.[finish]?.color ?? null : null;
  // gola — профиль на ряд фасадов, «штук» нет; у ручек одна деталь фурнитуры = одна ручка
  return { kind, sizeMm: size ? Number(size[1]) : null, finish, color, count: kind === 'gola' ? 0 : main.length };
}

function insideOf(model: ViewerModel): InsideInfo {
  const parts = model.parts;
  const nodeKind = new Map(model.nodes.map((n) => [n.id, n.kind]));
  const drawerNodes = new Set<string>();
  let drawerBottoms = 0;
  for (const p of parts) {
    if (DRAWER_ROLES.has(p.role) && p.node) drawerNodes.add(p.node);
    if (p.role === 'drawer_bottom') drawerBottoms += 1;
  }
  const slidingNodes = new Set<string>();
  for (const p of parts) if (p.role === 'sliding_fill' && p.node) slidingNodes.add(p.node);
  for (const n of model.nodes) if (n.kind === 'sliding_door') slidingNodes.add(n.id);
  const swingDoors = parts.filter((p) => p.role === 'door' && !(p.node && nodeKind.get(p.node) === 'sliding_door')).length;
  return {
    doors: swingDoors,
    slidingDoors: slidingNodes.size,
    drawers: drawerNodes.size || drawerBottoms,
    shelves: parts.filter((p) => p.role === 'shelf' || p.role === 'end_shelf').length,
    rods: parts.filter((p) => p.role === 'rod').length,
    lights: model.lights?.length ?? 0,
  };
}

/** Состав изделия для карточки «Что в изделии». */
export function composition(model: ViewerModel): Composition {
  const parts = model.parts ?? [];
  // зеркальное заполнение купе — не «цвет фасадов»
  const fronts = parts.filter((p) => FRONT_ROLES.has(p.role));
  const boardFronts = fronts.filter((p) => !['mirror', 'glass'].includes(boardKind(p.material, model.materials[p.material])));
  const body = parts.filter((p) => BODY_ROLES.has(p.role));
  const bodyMat = mode(body.map((p) => p.material));
  const frontMat = mode((boardFronts.length ? boardFronts : fronts).map((p) => p.material));

  let decor: DecorInfo | null = null;
  let frontsInfo: FrontsInfo | null = null;
  if (frontMat) {
    const sample = boardFronts.length ? boardFronts : fronts;
    const paint = paintOf(sample);
    const def = model.materials[frontMat];
    decor = paint
      ? { name: paint.code ?? null, swatch: { color: paint.color, texture: null }, painted: true }
      : decorOf(model, frontMat);
    const thickness = mode(sample.filter((p) => p.material === frontMat).map((p) => Math.round(p.thickness)));
    frontsInfo = {
      kind: paint && boardKind(frontMat, def) === 'other' ? 'mdf' : boardKind(frontMat, def),
      thicknessMm: thickness && thickness > 0 ? thickness : null,
      finish: paint?.gloss ?? finishOf(def?.type),
      painted: Boolean(paint),
      paintCode: paint?.code ?? null,
      milling: sample.some((p) => Boolean(p.decor?.milling?.length || p.decor?.overlay?.length || p.decor?.inlay?.length)),
    };
  }

  let bodyInfo: DecorInfo | null = null;
  if (bodyMat) {
    const b = decorOf(model, bodyMat);
    if (!decor) decor = b;
    else if (bodyMat !== frontMat || decor.painted) {
      const same = !decor.painted && b.swatch.color.toLowerCase() === decor.swatch.color.toLowerCase() && b.name === decor.name;
      if (!same) bodyInfo = b;
    }
  }

  return {
    decor,
    body: bodyInfo,
    fronts: frontsInfo,
    handles: handlesOf(model.hardware ?? [], model),
    inside: insideOf(model),
  };
}
