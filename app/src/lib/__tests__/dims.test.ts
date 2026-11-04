import type { ProductTree } from '../../api/types';
import { checkDim, dimLimits, furnitureKind, quickValues } from '../dims';

const pencil: ProductTree = { type: 'wardrobe', width: 820, height: 1800, depth: 450, sections: [{ doors: { count: 2 as const } }] };
const kupe: ProductTree = { type: 'wardrobe', width: 2400, height: 2400, depth: 650, sliding_doors: { count: 3 }, sections: [{}, {}, {}] };

describe('dims', () => {
  it('тип по пропорциям и подсказке', () => {
    expect(furnitureKind(pencil)).toBe('pencil');
    expect(furnitureKind(pencil, 'wardrobe')).toBe('pencil');
    expect(furnitureKind(kupe)).toBe('wardrobe_sliding');
    expect(furnitureKind({ width: 1600, height: 500, depth: 400 })).toBe('tv_stand');
    expect(furnitureKind({ width: 1000, height: 850, depth: 450 })).toBe('dresser');
    expect(furnitureKind({ width: 1200, height: 2000, depth: 400 }, 'rack')).toBe('rack');
  });

  it('быстрые значения — по типу и рядом с текущим, без текущего', () => {
    const k = furnitureKind(pencil);
    const q = (d: 'width' | 'height' | 'depth', v: number) => quickValues(k, d, v, dimLimits(pencil, k, d));
    expect(q('height', 1800)).toEqual([1600, 2000, 2100, 2200]);
    expect(q('depth', 450)).not.toContain(450);
    expect(q('depth', 450)).toEqual([350, 400, 500, 560]);
    const w = q('width', 820);
    expect(w.some((v) => v < 820) && w.some((v) => v > 820)).toBe(true);
    expect(w.every((v) => v >= 250 && v <= 1000)).toBe(true);
    // купе: 2400 не предлагает 2400
    const kk = furnitureKind(kupe);
    expect(quickValues(kk, 'height', 2400, dimLimits(kupe, kk, 'height'))).toEqual([2200, 2500, 2600, 2700]);
  });

  it('границы и причины', () => {
    const k = furnitureKind(kupe);
    const w = dimLimits(kupe, k, 'width');
    expect([w.min, w.max]).toEqual([1350, 3300]);
    expect(checkDim(w, 1000)?.key).toBe('dim_r_sliding_min');
    expect(checkDim(w, 2400)).toBeNull();
    const h = dimLimits(kupe, k, 'height');
    expect(checkDim(h, 2900)?.key).toBe('dim_r_sheet');
  });
});
