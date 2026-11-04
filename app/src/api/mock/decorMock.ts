/**
 * Мок декора фасадов, подсветки и встройки: ответы /catalog/front-styles, lighting-zones, builtin-options
 * (как api/routers/decor.py, превью — простые пути на двери 400×700), правила ядра в упрощённом виде
 * и «пересборка» viewer-модели образца под дерево (покраска, фрезеровка, вставки, ручки, свет, комната).
 */
import type { ViewerModel } from '@mebel/viewer';
import type * as T from '../types';
import { effectiveStyle, frontScope, inlayOn, millingOn, mdfNeeds, isMdf, nicheWarnings, type Builtin, builtinOf } from '../../lib/decorStyle';

const rect = (i: number) => `M${i} ${i} L${400 - i} ${i} L${400 - i} ${700 - i} L${i} ${700 - i} Z`;
const arch = (i: number, r: number) => `M${i} ${700 - i} L${i} ${i + r} A${(400 - 2 * i) / 2} ${(400 - 2 * i) / 2} 0 0 1 ${400 - i} ${i + r} L${400 - i} ${700 - i} Z`;
const diamond = (i: number) => `M200 ${i} L${400 - i} 350 L200 ${700 - i} L${i} 350 Z`;
const lines = (vertical: boolean, pitch: number) => {
  const out: string[] = [];
  for (let v = pitch; v < (vertical ? 400 : 700); v += pitch) out.push(vertical ? `M${v} 0 L${v} 700` : `M0 ${v} L400 ${v}`);
  return out;
};
const waves = () => {
  const out: string[] = [];
  for (let y = 90; y < 700; y += 104) {
    let d = `M0 ${y}`;
    for (let x = 0; x < 400; x += 50) d += ` A25 25 0 0 ${(x / 50) % 2 ? 0 : 1} ${x + 50} ${y}`;
    out.push(d);
  }
  return out;
};

const MILLING: [string, string, string, string, string[]][] = [
  ['shaker', 'Шейкер (рамка)', 'Sheyker (ramka)', 'milling_frame', [rect(60)]],
  ['classic', 'Классика с филёнкой', 'Klassika (filyonka)', 'milling_frame', [rect(60), arch(100, 110)]],
  ['arcs', 'Арка', 'Arka', 'milling_figured', [arch(60, 140)]],
  ['rhombus', 'Ромб', 'Romb', 'milling_figured', [rect(60), diamond(110)]],
  ['grooves_v', 'Рифление вертикальное', 'Vertikal chiziqlar', 'milling_grooves', lines(true, 40)],
  ['grooves_h', 'Рифление горизонтальное', 'Gorizontal chiziqlar', 'milling_grooves', lines(false, 40)],
  ['waves', 'Волны', 'To‘lqinlar', 'milling_figured', waves()],
];
const OVERLAY: [string, string, string, string[]][] = [
  ['frame', 'Молдинг-рамка', 'Molding ramka', [rect(50)]],
  ['arch', 'Молдинг-арка', 'Molding arka', [arch(50, 150)]],
  ['rhombus', 'Молдинг-ромб', 'Molding romb', [rect(50), diamond(100)]],
  ['moulding', 'Двойной молдинг', 'Ikki qatorli molding', [rect(50), rect(90)]],
];
const INLAY: [string, string, string, string[]][] = [
  ['frame', 'Металлическая рамка', 'Metall ramka', [rect(40)]],
  ['line_h', 'Полоса поперёк', 'Ko‘ndalang chiziq', ['M0 350 L400 350']],
  ['line_v', 'Полоса вдоль', 'Bo‘ylama chiziq', ['M200 0 L200 700']],
  ['edge', 'Кант по краю', 'Chet bo‘yicha kant', [rect(3)]],
];
const FINISHES: [T.MetalFinish, string, string][] = [['brass', 'Латунь', 'Latun'], ['gold', 'Золото', 'Oltin'], ['black', 'Чёрный', 'Qora'], ['chrome', 'Хром', 'Xrom'], ['steel', 'Сталь', 'Po‘lat']];
/** Себестоимость-заглушки (как pricing.DECOR_PRICES, статус analog). */
const PRICES: Record<string, [number, string]> = {
  milling_frame: [90_000, 'фасад'], milling_figured: [130_000, 'фасад'], milling_grooves: [380_000, 'м²'],
  overlay_profile: [45_000, 'м'], inlay_brass: [85_000, 'м'], inlay_metal: [60_000, 'м'],
  paint_matte: [220_000, 'м²'], paint_satin: [260_000, 'м²'], paint_gloss: [380_000, 'м²'],
  handle: [22_000, 'шт'], knob: [18_000, 'шт'], gola_profile: [210_000, 'м'],
  sensor_door: [65_000, 'шт'], sensor_motion: [75_000, 'шт'], sensor_touch: [90_000, 'шт'], led_profile: [60_000, 'м'], led_strip: [40_000, 'м'],
  wedge_cut: [35_000, 'шт'], wall_anchor: [6_000, 'шт'], bracket: [4_000, 'шт'], vent_grille: [45_000, 'шт'], dw_front_kit: [25_000, 'комплект'], leg: [9_000, 'шт'], plinth_clip: [1_500, 'шт'],
};
/** Пресеты пола (core/room.py FLOOR_MATERIALS). */
export const FLOORS: T.FloorMaterial[] = [
  { id: 'oak_light', name: 'Дуб светлый', name_uz: 'Och eman', color: '#D9BF94', seam: '#CFB386', texture: 'planks', step_mm: 180 },
  { id: 'walnut', name: 'Орех', name_uz: 'Yong‘oq', color: '#7C5A3F', seam: '#6D4E36', texture: 'planks', step_mm: 180 },
  { id: 'tile', name: 'Плитка', name_uz: 'Kafel', color: '#C9C7C2', seam: '#B8B6B1', texture: 'tiles', step_mm: 600 },
  { id: 'concrete', name: 'Бетон', name_uz: 'Beton', color: '#A8A6A1', seam: '#94928D', texture: 'speckle', step_mm: 0 },
  { id: 'carpet', name: 'Ковролин', name_uz: 'Gilam', color: '#B9AE9E', seam: '#A89D8D', texture: 'plain', step_mm: 0 },
];
const hint = (id: string | null, see: boolean): T.PriceHint | null => {
  const p = id ? PRICES[id] : undefined;
  return see && p ? { price: p[0], unit: p[1], status: 'analog' } : null;
};

export function frontStyles(see: boolean): T.FrontStylesOut {
  const metal = (f: string) => (f === 'brass' || f === 'gold' ? 'inlay_brass' : 'inlay_metal');
  return {
    preview_viewbox: [0, 0, 400, 700], paint_material: 'mdf_19_paint',
    milling: MILLING.map(([id, name, name_uz, pid, preview]) => ({ id, name, name_uz, requires: ['mdf'], preview, defaults: { inset: 60, width: 8, depth: 3, pitch: 40 }, price_hint: hint(pid, see) })),
    overlay: OVERLAY.map(([id, name, name_uz, preview]) => ({ id, name, name_uz, requires: [], preview, profiles: ['flat_20', 'round_25'], price_hint: hint('overlay_profile', see) })),
    inlay: INLAY.map(([id, name, name_uz, preview]) => ({
      id, name, name_uz, requires: id === 'edge' ? [] : ['mdf'], preview, finishes: ['brass', 'gold', 'black', 'chrome'],
      price_hint: see ? Object.fromEntries(FINISHES.filter((f) => f[0] !== 'steel').map(([f]) => [f, hint(metal(f), see)])) : null,
    })),
    paint: {
      requires: ['mdf'], systems: ['RAL', 'NCS', 'custom'], back_factor: 0.5,
      gloss: [['matte', 'Матовая', 'Mat'], ['satin', 'Полуматовая', 'Yarim mat'], ['gloss', 'Глянцевая', 'Yaltiroq']].map(([id, name, name_uz]) => ({ id, name, name_uz, price_hint: hint(`paint_${id}`, see) })),
    },
    finishes: FINISHES.map(([id, name, name_uz]) => ({ id, name, name_uz })),
    handles: [['bar', 'Скоба', 'Skoba', 'handle'], ['knob', 'Кнопка (грибок)', 'Tugma', 'knob'], ['gola', 'Профиль Gola', 'Gola profili', 'gola_profile'], ['none', 'Без ручек (push)', 'Tutqichsiz', null]]
      .map(([id, name, name_uz, pid]) => ({ id: id!, name: name!, name_uz: name_uz!, price_hint: hint(pid, see) })),
    corners: { max_radius: 200, edge_min_radius: 30 },
  };
}

export function lightingZones(see: boolean): T.LightingZonesOut {
  return {
    zones: [
      ['under_wall', 'Под навесными шкафами', 'Osma shkaflar ostida', ['kitchen']], ['niche', 'В открытой нише', 'Ochiq tokchada', ['wardrobe', 'kitchen']],
      ['shelf', 'Под полками', 'Javonlar ostida', ['wardrobe', 'kitchen']], ['wardrobe_rod', 'Над штангой', 'Shtanga ustida', ['wardrobe']],
      ['plinth', 'По цоколю', 'Sokol bo‘ylab', ['wardrobe', 'kitchen']], ['inside_top', 'Внутри, под крышей', 'Ichida, tom ostida', ['wardrobe', 'kitchen']],
    ].map(([id, name, name_uz, products]) => ({ id: id as string, name: name as string, name_uz: name_uz as string, products: products as string[] })),
    temps: [{ value: 3000, name: 'Тёплый', name_uz: 'Iliq' }, { value: 4000, name: 'Нейтральный', name_uz: 'Neytral' }, { value: 6000, name: 'Холодный', name_uz: 'Sovuq' }],
    sensors: [['none', 'Без датчика', 'Sensorsiz', null], ['door', 'Датчик открывания двери', 'Eshik sensori', 'sensor_door'], ['motion', 'Датчик движения', 'Harakat sensori', 'sensor_motion'], ['touch', 'Сенсорный выключатель', 'Sensorli o‘chirgich', 'sensor_touch']]
      .map(([id, name, name_uz, pid]) => ({ id: id!, name: name!, name_uz: name_uz!, price_hint: hint(pid, see) })),
    mounts: [{ id: 'groove', name: 'В паз (заподлицо)', name_uz: 'Ariqchaga' }, { id: 'surface', name: 'Накладной', name_uz: 'Ustki' }],
    price_hint: see ? { profile: hint('led_profile', see), strip: hint('led_strip', see) } : null,
  };
}

export function builtinOptions(see: boolean): T.BuiltinOptionsOut {
  return {
    fillers: {
      sides: [{ id: 'left', name: 'Слева', name_uz: 'Chapda' }, { id: 'right', name: 'Справа', name_uz: 'O‘ngda' }, { id: 'top', name: 'До потолка', name_uz: 'Shiftgacha' }],
      positions: [{ id: 'flush', name: 'Заподлицо с фасадами', name_uz: 'Fasad bilan bir tekisda' }, { id: 'setback', name: 'Утоплен', name_uz: 'Ichkariga botirilgan' }],
      mounts: [{ id: 'strip', name: 'На планке крепления', name_uz: 'Mahkamlash planka' }, { id: 'screws', name: 'Уголками и саморезами', name_uz: 'Burchak va shuruplar' }],
      materials: [{ id: null, name: 'Как фасады', name_uz: 'Fasadlar kabi' }, { id: 'body', name: 'Как корпус (id материала корпуса)', name_uz: 'Korpus kabi' }],
      defaults: { filler_width: 50, top_filler_width: 50, allowance_side: 10, allowance_top: 20, scribe: 15, filler_setback: 20 },
    },
    niche_fields: ['width_top', 'width_middle', 'width_bottom', 'height_left', 'height_right', 'depth', 'lean'],
    wedge: { field: 'builtin.wedge', name: 'Добор клином', name_uz: 'Ponasimon qo‘shimcha', hint: 'Кромка к стене режется по замеру (трапеция) — для заваленной стены', price_hint: hint('wedge_cut', see) },
    niche_lean: [{ id: null, name: 'Не знаю — поровну', name_uz: 'Bilmayman — teng' }, { id: 'left', name: 'Завалена левая стена', name_uz: 'Chap devor qiyshiq' }, { id: 'right', name: 'Завалена правая стена', name_uz: 'O‘ng devor qiyshiq' }],
    room: { view_only: true, walls_visible: true, floor_materials: FLOORS },
    side_panels: { sides: ['left', 'right'], kitchen_rows: [{ id: 'base', name: 'У нижних (до пола)', name_uz: 'Pastki (polgacha)' }, { id: 'wall', name: 'У верхних', name_uz: 'Yuqori' }, { id: 'both', name: 'Нижняя и верхняя', name_uz: 'Ikkalasi' }] },
    plinth: { wardrobe: { legs: true, floor_allowance: 5 }, kitchen: { setback: 50, floor_allowance: 5, sides: ['auto', 'none'], grilles: [{ id: 'sink', name: 'Под мойкой', name_uz: 'Rakovina ostida' }, { id: 'oven', name: 'Под духовкой', name_uz: 'Duxovka ostida' }] } },
    back: [{ id: 'nailed', name: 'ХДФ на гвоздях', name_uz: 'XDF mixlangan' }, { id: 'none', name: 'Без задней стенки (к ровной стене)', name_uz: 'Orqa devorsiz' }],
    kitchen_modules: [
      { kind: 'fridge', name: 'Ниша холодильника с панелью', name_uz: 'Muzlatgich joyi', defaults: { width: 600, fridge_height: 1850, top_panel: true } },
      { kind: 'appliance', dw: true, name: 'Посудомойка с фасадом', name_uz: 'Idish yuvish mashinasi fasadi', widths: [450, 600] },
    ],
    limits: { filler_min: 20, filler_max: 150, plumb_tolerance: 15, door_clearance: 30, top_panel_max: 600 },
    price_hint: see ? Object.fromEntries(['wall_anchor', 'bracket', 'vent_grille', 'dw_front_kit', 'leg', 'plinth_clip'].map((k) => [k, hint(k, see)])) : null,
  };
}

// ---------- правила (упрощённо, тексты — как у ядра) ----------

const NEED_WORDS: Record<string, string> = { milling: 'фрезеровка', paint: 'покраска', inlay: 'металлическая вставка' };

export function decorIssues(tree: T.ProductTree): T.IssueOut[] {
  const out: T.IssueOut[] = [];
  const styles: T.FrontsStyle[] = [tree.fronts?.style ?? {}];
  JSON.stringify(tree, (k, v) => { if (k === 'style' && v && typeof v === 'object' && v !== tree.fronts?.style) styles.push(v); return v; });
  const need = [...new Set(styles.flatMap(mdfNeeds))];
  if (need.length && !isMdf(tree.fronts?.material)) {
    const what = need.map((n) => NEED_WORDS[n]).join(', ');
    out.push({ level: 'error', code: 'decor_needs_mdf', path: 'fronts.material',
      message: `${what[0].toUpperCase()}${what.slice(1)} — только по МДФ, а фасады из ЛДСП: ЛДСП при фрезеровке скалывается, плёнку не покрасить`,
      fixes: [{ description: 'Фасады — МДФ 19 под покраску', patch: [{ op: 'replace', path: '/fronts/material', value: 'mdf_19_paint' }] }] });
  }
  if (tree.fronts?.handles?.kind === 'gola' && tree.type !== 'kitchen') {
    out.push({ level: 'warning', code: 'gola_wardrobe', path: 'fronts.handles', message: 'Gola у шкафа — вертикальный профиль у края открывания, паз в боковине', fixes: [] });
  }
  const back = (tree.body?.back as { kind?: string } | undefined)?.kind;
  if (back === 'none') {
    out.push({ level: 'warning', code: 'back_none_wall', path: 'body.back',
      message: 'Без задней стенки корпус держит геометрию только креплением к стене: ставьте к ровной чистовой стене и крепите уголками с дюбелями (8 шт. в смете). Кривую стену будет видно',
      fixes: [{ description: 'Задняя стенка ХДФ', patch: [{ op: 'replace', path: '/body/back/kind', value: 'nailed' }] }] });
  }
  if (tree.builtin && tree.type !== 'kitchen') {
    const b = builtinOf(tree);
    const n = b.niche ?? {};
    for (const w of nicheWarnings(tree)) {
      const side = { left: 'слева', right: 'справа', top: 'сверху' }[w.side ?? 'left'];
      if (w.code === 'plumb_w') {
        out.push({ level: 'warning', code: 'niche_out_of_plumb', path: 'builtin', fixes: [],
          message: `Стены ниши не параллельны: ширина вверху ${n.width_top ?? '—'}, посередине ${n.width_middle ?? '—'}, внизу ${n.width_bottom ?? '—'} мм — разница ${w.value} мм (больше ${w.limit}). Корпус сделан по самому узкому месту, доборы выкроены по самому широкому с припуском — подрежьте их по стене на месте` });
      } else if (w.code === 'plumb_h') {
        out.push({ level: 'warning', code: 'niche_floor_slope', path: 'builtin', fixes: [],
          message: `Пол или потолок ниши с перекосом: разница высот ${w.value} мм. Корпус выставьте по уровню на ножках, верхний добор подрежьте по потолку` });
      } else if (w.code === 'filler_wide') {
        out.push({ level: 'warning', code: 'filler_too_wide', path: 'builtin',
          message: `Добор ${side} ${w.value} мм — шире ${w.limit} мм: широкая планка выглядит как недоделка. Сделайте корпус ${w.side === 'top' ? 'выше' : 'шире или добавьте секцию'}`,
          fixes: [{ description: w.side === 'top' ? 'Корпус выше — добор 50 мм' : 'Корпус шире — добор 50 мм', patch: [{ op: 'replace', path: w.side === 'top' ? '/height' : '/width', value: (w.side === 'top' ? tree.height ?? 0 : tree.width ?? 0) + (w.value - 50) * (w.side === 'top' ? 1 : 2) }] }] });
      } else {
        out.push({ level: 'warning', code: 'filler_too_narrow', path: 'builtin',
          message: `Добор ${side} ${w.value} мм — уже ${w.limit} мм, его не закрепить. Сделайте корпус меньше (добор 50 мм) или уберите добор и оставьте монтажный зазор`,
          fixes: [{ description: `Без добора ${side} — монтажный зазор`, patch: [{ op: 'replace', path: '/builtin/fillers', value: b.fillers.filter((s) => s !== w.side) }] }] });
      }
    }
  }
  return out;
}

// ---------- viewer под дерево ----------

/** Есть декор/подсветка/ручки-кнопки — для мока берём образец с декором. */
export const hasDecor = (t: T.ProductTree) => {
  const s = t.fronts?.style ?? {};
  return millingOn(s) || inlayOn(s) || !!s.paint || !!(t.lighting as unknown[] | undefined)?.length || ['knob', 'gola'].includes(t.fronts?.handles?.kind ?? '');
};
export const hasBuiltin = (t: T.ProductTree) => !!t.builtin || !!(t.side_panels as unknown[] | undefined)?.length || !!t.top_filler;

const FRONT = new Set(['door', 'drawer_front']);
type Stroke = { path: { kind: string; x: number; y: number }[]; closed?: boolean; width?: number; depth?: number; finish?: string; start?: [number, number] };
const rectStroke = (L: number, W: number, i: number, extra: object): Stroke => ({
  closed: true, start: [i, i], ...extra,
  path: [{ kind: 'move', x: i, y: i }, { kind: 'line', x: L - i, y: i }, { kind: 'line', x: L - i, y: W - i }, { kind: 'line', x: i, y: W - i }, { kind: 'line', x: i, y: i }],
});

/**
 * Образец → модель под дерево: покраска и скругление по стилю (с переопределениями), выключенные
 * фрезеровка/вставка убираются, новая рисуется рамкой; отделка ручек; свет по зонам; цвета комнаты.
 */
export function decorateViewer(src: ViewerModel, tree: T.ProductTree): ViewerModel {
  const m = JSON.parse(JSON.stringify(src)) as ViewerModel & { room?: { colors?: Record<string, string> } };
  const mdf = isMdf(tree.fronts?.material);
  for (const p of m.parts) {
    if (!FRONT.has(p.role)) continue;
    const sc = frontScope(p.key);
    const st = effectiveStyle(tree, sc?.pointer);
    const d = { ...((p.decor ?? {}) as Record<string, unknown>) };
    if (st.paint && mdf) d.paint = { color: st.paint.color, gloss: st.paint.gloss };
    else delete d.paint;
    if (!millingOn(st) || !mdf) delete d.milling;
    else if (!d.milling) d.milling = [rectStroke(p.length, p.width, st.milling?.inset ?? 60, { width: 8, depth: 3 })];
    if (!inlayOn(st) || (!mdf && st.inlay?.kind !== 'edge')) delete d.inlay;
    else {
      const fin = st.inlay?.finish ?? 'brass';
      d.inlay = d.inlay ? (d.inlay as Stroke[]).map((x) => ({ ...x, finish: fin })) : [rectStroke(p.length, p.width, st.inlay?.kind === 'edge' ? 3 : st.inlay?.inset ?? 40, { width: 6, finish: fin })];
    }
    if (st.corners?.radius != null) d.radius = st.corners.radius;
    p.decor = Object.keys(d).length > (d.face ? 1 : 0) ? (d as typeof p.decor) : undefined;
  }
  const h = tree.fronts?.handles;
  if (m.hardware) {
    m.hardware = m.hardware.filter((x) => !(h?.kind === 'none' && ['handle', 'knob', 'gola'].includes(String(x.kind))))
      .map((x) => (['handle', 'knob', 'gola'].includes(String(x.kind)) && h?.finish ? { ...x, finish: h.finish } : x));
  }
  const zones = ((tree.lighting as T.LightingItem[] | undefined) ?? []);
  if (!zones.length) delete m.lights;
  else if (m.lights) {
    m.lights = m.lights.filter((l) => zones.some((z) => z.zone === (l as { zone?: string }).zone) || !(l as { zone?: string }).zone)
      .map((l) => ({ ...l, temp: zones.find((z) => z.zone === (l as { zone?: string }).zone)?.temp ?? l.temp }));
  }
  const builtin = tree.installation === 'niche' || !!tree.builtin || !!tree.site;
  if (!builtin) delete m.room;
  else if (m.room && tree.room_colors) {
    const rc = tree.room_colors as { wall?: string; floor?: string };
    const fm = FLOORS.find((f) => f.id === (rc as { floor_material?: string }).floor_material);
    m.room.colors = { ...(m.room.colors ?? {}), ...(rc.wall ? { wall: rc.wall } : {}), ...(rc.floor ? { floor: rc.floor } : fm ? { floor: fm.color } : {}),
      ...((rc as { walls_visible?: boolean }).walls_visible === false ? { walls_visible: false } : {}) } as typeof m.room.colors;
  }
  return m;
}

/** builtin: значения по умолчанию + замер (мок POST /measurements с niche). */
export const withNiche = (b: Builtin | undefined, niche: T.NicheMeasure): Builtin => ({ ...(b ?? {}), niche: { ...(b?.niche ?? {}), ...niche } });
