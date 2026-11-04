import type { ProductTree } from '../../api/types';
import { effectiveStyle, fitToNiche, fittedSize, frameLen, frontRects, frontScope, mdfNeeds, needsMdfFix, nicheLayout, nicheWarnings, parseSvgPath } from '../decorStyle';

describe('стиль фасада: область переопределения', () => {
  it('ключ детали → поле style дверей / ящиков / модуля кухни', () => {
    expect(frontScope('sections[1].doors.door[2]')).toMatchObject({ pointer: '/sections/1/doors/style', kind: 'doors', n: 2 });
    expect(frontScope('sections[1].fill[0].doors.door[1]')?.pointer).toBe('/sections/1/fill/0/doors/style');
    expect(frontScope('sections[0].fill[0].drawer[3].front')).toMatchObject({ pointer: '/sections/0/fill/0/style', kind: 'drawers' });
    expect(frontScope('base[2].doors.door[1]')).toMatchObject({ pointer: '/base/2/style', kind: 'module', row: 'base' });
    expect(frontScope('mezzanine.sections[0].doors.door[1]')).toBeNull();
  });

  it('переопределение целиком заменяет поле изделия', () => {
    const tree: ProductTree = { fronts: { style: { milling: { pattern: 'shaker' }, corners: { radius: 4 } } },
      sections: [{ doors: { count: 2, style: { milling: { pattern: 'arcs' } } } as never }] };
    expect(effectiveStyle(tree, '/sections/0/doors/style')).toMatchObject({ milling: { pattern: 'arcs' }, corners: { radius: 4 } });
    expect(effectiveStyle(tree).milling?.pattern).toBe('shaker');
  });

  it('МДФ нужен для фрезеровки, покраски и вставки (кроме канта)', () => {
    expect(mdfNeeds({ inlay: { kind: 'edge' } })).toEqual([]);
    expect(mdfNeeds({ milling: { pattern: 'shaker' }, inlay: { kind: 'frame' } })).toEqual(['milling', 'inlay']);
    expect(needsMdfFix({ fronts: { material: 'ldsp_18_oak', style: { milling: { pattern: 'none' } } } })).toBe(false);
    expect(needsMdfFix({ fronts: { material: 'ldsp_18_oak' }, sections: [{ doors: { style: { milling: { pattern: 'arcs' } } } as never }] })).toBe(true);
    expect(needsMdfFix({ fronts: { material: 'mdf_19_paint', style: { milling: { pattern: 'arcs' } } } })).toBe(false);
  });
});

describe('превью: SVG-пути', () => {
  it('M/L/Z — замкнутая ломаная, дуга — точками по окружности', () => {
    const [r] = parseSvgPath('M60 60 L340 60 L340 640 L60 640 Z');
    expect(r.closed).toBe(true);
    expect(r.pts[0]).toEqual([60, 60]);
    expect(r.pts[r.pts.length - 1]).toEqual([60, 60]);
    const [a] = parseSvgPath('M0 100 A100 100 0 0 1 200 100');
    const mid = a.pts[Math.floor(a.pts.length / 2)];
    expect(Math.hypot(mid[0] - 100, mid[1] - 100)).toBeCloseTo(100, 0);
    expect(a.pts[a.pts.length - 1][0]).toBeCloseTo(200, 5);
  });
});

describe('ниша: доборы и подгонка (как core/niche.py)', () => {
  // образец schemas/samples/wardrobe_builtin: фальш-панель слева 18 мм, доборы 50
  const tree: ProductTree = {
    width: 2276, height: 2642, fronts: { material: 'ldsp_18_oak' }, side_panels: [{ side: 'left', to_floor: true }],
    builtin: { fillers: ['left', 'right', 'top'], filler_width: 50, top_filler_width: 50, niche: { width_top: 2412, width_middle: 2400, width_bottom: 2394, height_left: 2700, height_right: 2692 } },
  };
  it('видимая ширина доборов в узком и широком месте', () => {
    const lay = nicheLayout(tree);
    expect(lay.left).toMatchObject({ min: 50, max: 59 });
    expect(lay.right).toMatchObject({ min: 50, max: 59 });
    expect(lay.top).toMatchObject({ min: 50, max: 58 });
  });
  it('стена завалена справа — весь перекос в правый добор', () => {
    const lay = nicheLayout({ ...tree, builtin: { ...(tree.builtin as object), niche: { ...(tree.builtin as { niche: object }).niche, lean: 'right' } } });
    expect(lay.left).toMatchObject({ min: 50, max: 50 });
    expect(lay.right).toMatchObject({ min: 50, max: 68 });
  });
  it('корпус по самому узкому месту минус доборы и панели', () => {
    expect(fittedSize(tree)).toEqual({ width: 2276, height: 2642 });
    const t2 = fitToNiche({ ...tree, builtin: { ...(tree.builtin as object), fillers: ['left', 'top'] } });
    expect(t2.width).toBe(2394 - 18 - 50 - 10);
  });
  it('предупреждения: перекос и узкий добор', () => {
    expect(nicheWarnings(tree).map((w) => w.code)).toEqual(['plumb_w']);
    const narrow = nicheWarnings({ ...tree, width: 2340 });
    expect(narrow.some((w) => w.code === 'filler_narrow' && w.side === 'left')).toBe(true);
  });
});

describe('схема фасадов', () => {
  it('деталь с осями u/v → прямоугольник в плоскости X–Z', () => {
    const r = frontRects([{ key: 'd', number: 1, role: 'door', length: 1694, width: 582, placement: { origin: [1, -19, 705], u: '+Z', v: '+X' } }]);
    expect(r[0]).toMatchObject({ x: 1, z: 705, w: 582, h: 1694 });
    expect(frameLen(400, 700, 50)).toBeCloseTo(1.8, 5);
  });
});
