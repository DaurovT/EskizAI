import { createMockApi } from '../../api/mock/mockApi';
import { isPaintMaterial, paintOf, textureSource } from '../decors';

describe('декоры EMAN в моке', () => {
  it('фильтры по бренду и семейству цвета, фасеты', async () => {
    const api = createMockApi();
    const all = await api.searchDecors({ kind: 'ldsp,mdf', min_thickness: 16 });
    expect(all.items.length).toBeGreaterThan(20);
    expect(all.brands.length).toBeGreaterThan(0);
    const white = await api.searchDecors({ family: 'white' });
    expect(white.items.every((d) => d.family === 'white')).toBe(true);
    const b = await api.searchDecors({ brand: all.brands[0] });
    expect(b.items.every((d) => d.brand === all.brands[0])).toBe(true);
  });
  it('палитра краски и помощники', async () => {
    const pal = await createMockApi().listPaintColors();
    expect(pal.gloss.map((g) => g.id)).toEqual(['matte', 'satin', 'gloss']);
    expect(paintOf(pal.colors[0], 'satin')).toMatchObject({ code: pal.colors[0].code, gloss: 'satin' });
    expect(isPaintMaterial('mdf_19_paint')).toBe(true);
    expect(isPaintMaterial('ldsp_16_oak')).toBe(false);
    expect(textureSource('/static/textures/a.jpg', 'http://api')).toEqual({ uri: 'http://api/static/textures/a.jpg' });
    expect(textureSource(null)).toBeNull();
  });
});
