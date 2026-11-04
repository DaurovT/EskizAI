/** Смета мока: образец ядра (schemas/samples/*.estimate.json), масштабированный по объёму изменённой модели. */
import type { ViewerModel } from '@mebel/viewer';
import type { ClientEstimate, EstimateView, MasterEstimate, MasterEstimateLine, PriceRange, PricingOut, StaffEstimate } from '../types';
import { layoutSheets } from '../../lib/cutting';
import type { Sample } from './data';

/** Ручка по фурнитуре модели: кнопка / Gola / скоба (с отделкой). */
const FIN: Record<string, string> = { brass: 'латунь', gold: 'золото', black: 'чёрный', chrome: 'хром', steel: 'сталь' };
function handleName(m: ViewerModel): string {
  const h = (m.hardware ?? []).find((x) => ['handle', 'knob', 'gola'].includes(String(x.kind)));
  const f = h?.finish ? ` (${FIN[String(h.finish)] ?? h.finish})` : '';
  return h?.kind === 'knob' ? `Ручка-кнопка${f}` : h?.kind === 'gola' ? `Профиль Gola${f}` : `Ручка-скоба 128 мм${f}`;
}

const r100k = (v: number) => Math.round(v / 100_000) * 100_000;

/** Грубая «материалоёмкость» модели: площадь плит. */
export const modelArea = (m: ViewerModel) => m.parts.reduce((s, p) => s + p.length * p.width, 0);

function scaleRange(r: PriceRange | null | undefined, f: number, exact: boolean, round = true): PriceRange | undefined {
  if (!r) return undefined;
  const from = r.from * f, to = r.to * f;
  if (exact) {
    const mid = round ? r100k((from + to) / 2) : Math.round((from + to) / 2);
    return { from: mid, to: mid };
  }
  // до замера — узкий диапазон ±6 % от середины (как на сервере)
  const mid = (from + to) / 2;
  return round ? { from: r100k(mid * 0.94), to: r100k(mid * 1.06) } : { from: Math.round(mid * 0.94), to: Math.round(mid * 1.06) };
}

const RANGE_NOTE = 'оценка: фасады, фурнитура';

/** Во сколько раз цена клиенту выше образца при текущих наценках и работе (образец посчитан при наценках 20/20/15 % и работе 50 %). */
export function pricingK(p: PricingOut | null | undefined): number {
  if (!p || p.labor_mode !== 'percent') return 1;
  const k = (mb: number, mf: number, mh: number, lab: number) => 1 + (mb + mf + mh) / 300 + lab / 100;
  return k(p.markup_body, p.markup_fronts, p.markup_hardware, p.labor_percent) / k(20, 20, 15, 50);
}

export function clientEstimate(sample: Sample, model: ViewerModel, view: EstimateView, exact: boolean, k = 1): ClientEstimate {
  const f = (modelArea(model) / modelArea(sample.viewer)) * k;
  const base = sample.estimate[view];
  return {
    ...base,
    view,
    exact,
    uncertainty_text: exact ? '' : RANGE_NOTE,
    uncertainty_text_uz: exact ? '' : 'taxminiy: fasadlar, furnitura',
    total: scaleRange(base.total, f, exact)!,
    materials: scaleRange(base.materials, f, exact),
    work: scaleRange(base.work, f, exact),
    groups: base.groups?.map((g) => ({ ...g, ...scaleRange(g, f, exact, false)! })),
  };
}

const UNIT_PRICE: Record<string, number> = {
  ldsp_16_white: 420_000, ldsp_16_grey: 440_000, ldsp_16_oak: 520_000, ldsp_18_white: 470_000,
  ldsp_18_oak: 560_000, ldsp_10_white: 300_000, ldsp_10_oak: 340_000, hdf_3_white: 150_000,
};

export function staffEstimate(sample: Sample, model: ViewerModel, exact: boolean, k = 1): StaffEstimate {
  const c = clientEstimate(sample, model, 'short', exact, k);
  const sheets: Record<string, number> = {};
  for (const s of layoutSheets(model)) sheets[s.material] = (sheets[s.material] ?? 0) + 1;
  return {
    exact, total: c.total, uncertainty_text: c.uncertainty_text, uncertainty_text_uz: c.uncertainty_text_uz, materials_client: c.materials!, work: c.work!,
    has_requests: false, sheets, priced_at: new Date().toISOString(),
  };
}

export function masterEstimate(sample: Sample, model: ViewerModel, exact: boolean, pricing: PricingOut): MasterEstimate {
  const st = staffEstimate(sample, model, exact, pricingK(pricing));
  const now = new Date().toISOString().slice(0, 10);
  const lines: MasterEstimateLine[] = [];
  for (const [mat, qty] of Object.entries(st.sheets)) {
    const price = UNIT_PRICE[mat] ?? 450_000;
    lines.push({ key: `sheet.${mat}`, category: 'body', group: 'Листы', name: model.materials[mat]?.name ?? mat, unit: 'лист', qty, unit_price: price, cost: qty * price, status: 'catalog', source: 'EMAN', priced_at: now });
  }
  const rot = model.nodes.filter((n) => n.kind === 'rotate').length;
  const slide = model.nodes.filter((n) => n.kind === 'slide').length;
  const sliding = model.nodes.filter((n) => n.kind === 'sliding_door').length;
  const hw: [string, number, number, string][] = [
    ['Петля накладная 110° с доводчиком', rot * 2, 38_000, 'catalog'],
    ['Направляющие шариковые 550 мм (пара)', slide, 65_000, 'catalog'],
    [handleName(model), rot + slide, 22_000, 'analog'],
    ['Конфирмат 7×50', model.parts.length * 4, 600, 'catalog'],
    ['Система купе (комплект на дверь)', sliding, 420_000, 'request'],
  ];
  for (const [name, qty, price, status] of hw) {
    if (qty > 0) lines.push({ key: `hw.${name}`, category: 'hardware', group: 'Фурнитура', name, unit: 'шт', qty, unit_price: price, cost: qty * price, status, source: 'EMAN', priced_at: now });
  }
  const edgeM = Math.round(model.parts.reduce((s, p) => s + 2 * (p.length + p.width), 0) / 1000);
  lines.push({ key: 'edge.04', category: 'body', group: 'Кромка', name: 'Кромка ПВХ 0,4 мм', unit: 'м', qty: edgeM, unit_price: 1_800, cost: edgeM * 1_800, status: 'catalog', source: 'EMAN', priced_at: now });
  lines.push(...decorLines(sample, model, now));
  const cuts = model.parts.length;
  lines.push({ key: 'svc.cut', category: 'services', group: 'Распил и кромкование', name: 'Распил', unit: 'деталь', qty: cuts, unit_price: 9_000, cost: cuts * 9_000, status: 'catalog', source: 'EMAN', priced_at: now });

  const byCat: Record<string, number> = { body: 0, fronts: 0, hardware: 0, services: 0 };
  for (const l of lines) byCat[l.category] += l.cost;
  const costTotal = Object.values(byCat).reduce((a, b) => a + b, 0);
  return {
    ...st,
    cost_materials: { from: costTotal, to: exact ? costTotal : Math.round(costTotal * 1.25) },
    cost_by_category: byCat,
    markup_percent: { body: pricing.markup_body, fronts: pricing.markup_fronts, hardware: pricing.markup_hardware, services: pricing.markup_services },
    lines,
  };
}

/** Группы строк, которые ядро пишет отдельно (core/estimate.py DECOR_GROUP, LIGHT_GROUP) + доборы встройки. */
export const DECOR_GROUP = 'Декор фасадов';
export const LIGHT_GROUP = 'Подсветка';
export const FILLER_GROUP = 'Доборы и панели';

/** Мок: строки декора и подсветки — из подробной сметы образца (то, что осталось в модели), доборы — по деталям. */
function decorLines(sample: Sample, model: ViewerModel, now: string): MasterEstimateLine[] {
  const out: MasterEstimateLine[] = [];
  const fronts = model.parts.filter((p) => p.decor);
  const has = { paint: fronts.some((p) => p.decor?.paint), milling: fronts.some((p) => p.decor?.milling?.length), inlay: fronts.some((p) => p.decor?.inlay?.length), light: !!model.lights?.length };
  for (const g of sample.estimate.detailed.groups ?? []) {
    const k = g.key ?? '';
    if (!k.startsWith('decor:')) continue;
    const light = /^decor:(led|sensor|power)/.test(k);
    const kind = k.split(':')[1];
    if (light ? !has.light : (kind === 'paint' && !has.paint) || (kind === 'milling' && !has.milling) || (kind.startsWith('inlay') && !has.inlay)) continue;
    const cost = Math.round((g.from * 0.62) / 1000) * 1000;
    out.push({ key: k, category: light ? 'hardware' : 'fronts', group: light ? LIGHT_GROUP : DECOR_GROUP, name: g.name, unit: 'компл.', qty: 1, unit_price: cost, cost, status: 'analog', source: 'EMAN', priced_at: now });
  }
  const fill = model.parts.filter((p) => ['niche_filler', 'false_panel', 'plinth_side'].includes(p.role));
  for (const p of fill) {
    const cost = Math.round((p.length * p.width) / 1e6 * 140_000 / 1000) * 1000 + 15_000;
    out.push({ key: `fill:${p.key}`, category: 'fronts', group: FILLER_GROUP, name: `${p.name} ${Math.round(p.length)}×${Math.round(p.width)}`, unit: 'шт', qty: 1, unit_price: cost, cost, status: 'catalog', source: 'EMAN', priced_at: now });
  }
  if (fill.length) out.push({ key: 'fill:anchors', category: 'hardware', group: FILLER_GROUP, name: 'Крепление к стене: дюбель 8×80 + уголок', unit: 'шт', qty: 8, unit_price: 6_000, cost: 48_000, status: 'catalog', source: 'EMAN', priced_at: now });
  return out;
}
