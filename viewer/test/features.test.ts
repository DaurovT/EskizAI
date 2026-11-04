import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mesh, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  ProductScene,
  computeDimensions,
  grainUv,
  grainUvAxes,
  materialType,
  parseViewerModel,
  partGeometry,
  qualitySettings,
  strokeTextGeometry,
  type ViewerModel,
  type ViewerPart,
} from '../src/index.js';

const fixture = (name: string): ViewerModel =>
  parseViewerModel(JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')));

function part(over: Partial<ViewerPart> & Pick<ViewerPart, 'placement'>): ViewerPart {
  return {
    number: 1,
    key: 'p',
    name: 'p',
    role: 'side',
    material: 'm',
    thickness: 16,
    length: 2400,
    width: 597,
    grain: 'length',
    contour: null,
    holes: [],
    node: null,
    ...over,
  };
}

/**
 * Для треугольников большой грани (нормаль вдоль `faceNormal` в сцене) — как меняются
 * u и v при сдвиге вдоль осей сцены: возвращает [du/dx, du/dy, du/dz] и то же для v (в плитках на мм).
 */
function uvGradient(p: ViewerPart, faceNormal: Vector3) {
  const g = partGeometry(p, { scale: 1, uv: { tileMm: 1000 } });
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i += 3) {
    const n = new Vector3().fromBufferAttribute(nor, i);
    if (n.dot(faceNormal) < 0.99) continue;
    // Решаем систему по трём вершинам: uv = A·(x,y,z) + c на плоскости грани.
    const P = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(pos, i + k));
    const U = [0, 1, 2].map((k) => uv.getX(i + k));
    const V = [0, 1, 2].map((k) => uv.getY(i + k));
    const e1 = P[1]!.clone().sub(P[0]!);
    const e2 = P[2]!.clone().sub(P[0]!);
    const grad = (f: number[]) => {
      // Градиент линейной функции в плоскости треугольника.
      const d1 = f[1]! - f[0]!;
      const d2 = f[2]! - f[0]!;
      const n12 = e1.clone().cross(e2);
      const a = e2.clone().cross(n12).multiplyScalar(d1);
      const b = n12.clone().cross(e1).multiplyScalar(d2);
      return a.add(b).divideScalar(n12.lengthSq());
    };
    return { du: grad(U), dv: grad(V) };
  }
  throw new Error('грань не найдена');
}

describe('UV и направление текстуры', () => {
  it('оси UV по grain: length → x, width → y, none → x', () => {
    expect(grainUvAxes('length', 2)).toEqual([0, 1]);
    expect(grainUvAxes('width', 2)).toEqual([1, 0]);
    expect(grainUvAxes('none', 2)).toEqual([0, 1]);
    // Кромка вдоль длины (нормаль y): волокна по-прежнему вдоль x.
    expect(grainUvAxes('length', 1)).toEqual([0, 2]);
    // Торец поперёк волокон: волокна уходят в толщину.
    expect(grainUvAxes('length', 0)).toEqual([2, 1]);
    expect(grainUvAxes('width', 1)).toEqual([2, 0]);
  });

  it('реальный масштаб: 1 плитка = 1000 мм, неквадратная плитка и волокна по V картинки', () => {
    expect(grainUv([500, 250, 0], 2, 'length')).toEqual([0.5, 0.25]);
    expect(grainUv([500, 250, 0], 2, 'width')).toEqual([0.25, 0.5]);
    expect(grainUv([2800, 1035, 0], 2, 'length', { tileMm: [2800, 2070] })).toEqual([1, 0.5]);
    expect(grainUv([500, 250, 0], 2, 'length', { grainAxis: 'v' })).toEqual([0.25, 0.5]);
  });

  it('боковина (длина вверх): волокна идут по высоте сцены', () => {
    const side = part({ placement: { origin: [0, 0, 0], u: '+Z', v: '+Y', n: '+X' }, grain: 'length' });
    const { du, dv } = uvGradient(side, new Vector3(1, 0, 0));
    // u растёт вдоль высоты (three y), 1/1000 на мм; v — вдоль глубины (three z).
    expect(Math.abs(du.y)).toBeCloseTo(0.001, 6);
    expect(du.x).toBeCloseTo(0, 9);
    expect(du.z).toBeCloseTo(0, 9);
    expect(Math.abs(dv.z)).toBeCloseTo(0.001, 6);
    expect(dv.y).toBeCloseTo(0, 9);
  });

  it('та же боковина с grain=width: волокна поперёк, по глубине', () => {
    const side = part({ placement: { origin: [0, 0, 0], u: '+Z', v: '+Y', n: '+X' }, grain: 'width' });
    const { du, dv } = uvGradient(side, new Vector3(1, 0, 0));
    expect(Math.abs(du.z)).toBeCloseTo(0.001, 6);
    expect(du.y).toBeCloseTo(0, 9);
    expect(Math.abs(dv.y)).toBeCloseTo(0.001, 6);
  });

  it('полка (длина по ширине изделия), зеркальное размещение: волокна вдоль X', () => {
    const shelf = part({
      length: 800,
      width: 500,
      placement: { origin: [0, 0, 500], u: '+X', v: '+Y', n: '+Z' }, // левая тройка (det < 0)
    });
    const { du } = uvGradient(shelf, new Vector3(0, 1, 0));
    expect(Math.abs(du.x)).toBeCloseTo(0.001, 6);
    expect(du.z).toBeCloseTo(0, 9);
  });

  it('у всех деталей есть uv; без UV по опции', () => {
    const p = part({ placement: { origin: [0, 0, 0], u: '+X', v: '+Z', n: '+Y' } });
    expect(partGeometry(p).getAttribute('uv')).toBeDefined();
    expect(partGeometry(p, { uv: false }).getAttribute('uv')).toBeUndefined();
  });

  it('вырез превращает плиту в выдавленный контур с дыркой', () => {
    const top = part({
      length: 1000,
      width: 600,
      thickness: 38,
      placement: { origin: [0, 0, 820], u: '+X', v: '+Y', n: '+Z' },
      cutouts: [
        {
          start: [300, 150],
          segments: [
            { kind: 'line', x: 700, y: 150 },
            { kind: 'line', x: 700, y: 450 },
            { kind: 'line', x: 300, y: 450 },
            { kind: 'line', x: 300, y: 150 },
          ],
        },
      ],
    });
    const g = partGeometry(top, { scale: 1 });
    // Площадь верхней грани = 1000·600 − 400·300.
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    let area = 0;
    for (let i = 0; i < pos.count; i += 3) {
      if (new Vector3().fromBufferAttribute(nor, i).y < 0.99) continue;
      const a = new Vector3().fromBufferAttribute(pos, i);
      const b = new Vector3().fromBufferAttribute(pos, i + 1);
      const c = new Vector3().fromBufferAttribute(pos, i + 2);
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    expect(area).toBeCloseTo(1000 * 600 - 400 * 300, 0);
  });
});

describe('материалы', () => {
  it('тип поверхности по id', () => {
    expect(materialType('mirror_4')).toBe('mirror');
    expect(materialType('rod_oval_chrome')).toBe('metal');
    expect(materialType('countertop_38_stone')).toBe('gloss');
    expect(materialType('ldsp_18_oak')).toBe('matte');
    expect(materialType('mdf_19_acryl_white')).toBe('acrylic');
    expect(materialType('mdf_softtouch_grey')).toBe('softtouch');
  });

  it('декор с волокнами получает процедурную текстуру; явная карта типов важнее', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const s = new ProductScene(m, { quality: 'high', materials: { ldsp_16_white: { type: 'gloss' } } });
    const oak = s.parts.find((h) => h.part.material === 'ldsp_18_oak')!.mesh.material as { map: unknown };
    const white = s.parts.find((h) => h.part.material === 'ldsp_16_white')!.mesh.material as unknown as {
      map: unknown;
      clearcoat?: number;
      userData: Record<string, unknown>;
    };
    expect(oak.map).toBeTruthy();
    expect(white.map).toBeNull();
    expect(white.userData.materialType).toBe('gloss');
    expect(white.clearcoat).toBe(1);
    expect(s.materialTypeOf('rod_oval_chrome')).toBe('metal');
    s.dispose();
  });
});

describe('размеры', () => {
  it('wardrobe_full: 1800 × 2400 × 600, секции 570 / 596 / 570', () => {
    const info = computeDimensions(fixture('wardrobe_full.viewer.json'));
    expect(info.overall).toEqual({ width: 1800, height: 2400, depth: 600 });
    expect(info.rows).toHaveLength(1);
    expect(info.rows[0]!.sections.map((s) => s.width)).toEqual([570, 596, 570]);
    expect(info.rows[0]!.zMax).toBe(2400);
  });

  it('kitchen_straight: два ряда — нижние и верхние модули, стыки модулей не секции', () => {
    const info = computeDimensions(fixture('kitchen_straight.viewer.json'));
    expect(info.overall).toEqual({ width: 2850, height: 2120, depth: 560 });
    expect(info.rows).toHaveLength(2);
    const [base, wall] = info.rows;
    // Нижние: 400, 600, ниша 600 (без боковин), 800, 450 — по внутренним размерам.
    expect(base!.sections.map((s) => s.width)).toEqual([368, 568, 600, 768, 418]);
    expect(wall!.sections.map((s) => s.width)).toEqual([368, 568, 568, 768, 418]);
    expect(base!.zMax).toBe(820);
  });

  it('объекты размеров: подписи в мм, скрыты по умолчанию, переключаются, не мешают выбору', () => {
    const s = new ProductScene(fixture('wardrobe_full.viewer.json'));
    expect(s.dimensionsVisible).toBe(false);
    s.showDimensions(true);
    expect(s.dimensionsVisible).toBe(true);
    const texts = s.dimensions.labels.map((l) => l.name.replace('dim:', ''));
    expect(texts).toEqual(expect.arrayContaining(['1800', '2400', '600', '570', '596']));
    expect(texts.filter((t) => t === '570')).toHaveLength(2);
    expect(s.toggleDimensions()).toBe(false);
    // Луч в центр изделия попадает в деталь, а не в размер.
    s.showDimensions(true);
    const cam = new PerspectiveCamera(40, 1, 0.01, 100);
    cam.position.set(0.9, 1.2, 5);
    cam.lookAt(0.9, 1.2, 0);
    cam.updateMatrixWorld(true);
    expect(s.pickAt(cam, 0, 0)).not.toBeNull();
    s.dispose();
  });

  it('штриховой шрифт: ширина растёт с числом цифр', () => {
    const a = strokeTextGeometry('8', 60);
    const b = strokeTextGeometry('1800', 60);
    expect(b.userData.width).toBeGreaterThan(a.userData.width * 3);
    expect(a.getAttribute('position').count).toBe(7 * 6);
  });
});

describe('качество и слияние', () => {
  it('low: детали слиты по материалу, но каждый узел отдельно (внутри своей группы)', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const hi = new ProductScene(m, { quality: 'high' });
    const lo = new ProductScene(m, { quality: 'low' });
    expect(qualitySettings('low').merge).toBe(true);
    expect(lo.mergedMeshes.length).toBeGreaterThan(0);
    const byNumber = new Map(m.parts.map((p) => [p.number, p]));
    const pivots = new Set([...lo.nodes.values()].map((h) => h.pivot));
    for (const mm of lo.mergedMeshes) {
      const nums = mm.userData.partNumbers as number[];
      const nodes = new Set(nums.map((n) => byNumber.get(n)!.node));
      const mats = new Set(nums.map((n) => byNumber.get(n)!.material));
      // Один материал и один узел (или все неподвижные) на общий меш.
      expect(nodes.size).toBe(1);
      expect(mats.size).toBe(1);
      const nodeId = [...nodes][0];
      if (nodeId) expect(mm.parent).toBe(lo.nodes.get(nodeId)!.pivot);
      else expect(mm.parent).toBe(lo.root);
      expect(mm.parent === lo.root || pivots.has(mm.parent as never)).toBe(true);
    }
    // Неподвижные: не больше одного общего меша на материал.
    const staticMerged = lo.mergedMeshes.filter((x) => x.parent === lo.root);
    const staticMaterials = new Set(m.parts.filter((p) => !p.node).map((p) => p.material));
    expect(staticMerged.length).toBeLessThanOrEqual(staticMaterials.size);
    // Узел по-прежнему двигает все свои детали: общий меш внутри группы узла.
    const drawerId = 'sections[1].fill[0].drawer[1]';
    const drawer = lo.nodes.get(drawerId)!;
    lo.setNodeOpen(drawerId, 1);
    lo.root.updateMatrixWorld(true);
    const mergedInDrawer = lo.mergedMeshes.filter((x) => x.parent === drawer.pivot);
    expect(mergedInDrawer.length).toBeGreaterThan(0);
    const moved = new Vector3().setFromMatrixPosition(mergedInDrawer[0]!.matrixWorld);
    const part = drawer.parts[0]!.mesh;
    expect(moved.distanceTo(new Vector3().setFromMatrixPosition(part.matrixWorld))).toBeLessThan(1e-9);
    // Треугольников столько же, вызовов отрисовки намного меньше.
    const sh = hi.stats();
    const sl = lo.stats();
    expect(sl.triangles).toBe(sh.triangles);
    expect(sl.drawCalls).toBeLessThan(sh.drawCalls / 3);
    hi.dispose();
    lo.dispose();
  });

  it('low: выбор лучом по-прежнему даёт номер детали; анимация узла работает', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const lo = new ProductScene(m, { quality: 'low' });
    const cam = new PerspectiveCamera(40, 1, 0.01, 100);
    cam.position.set(0.9, 1.2, 5);
    cam.lookAt(0.9, 1.2, 0);
    cam.updateMatrixWorld(true);
    const hit = lo.pickAt(cam, 0, 0);
    expect(hit).not.toBeNull();
    const nodeId = [...lo.nodes.keys()].find((id) => lo.nodes.get(id)!.node.kind === 'rotate')!;
    lo.setNodeOpen(nodeId, 1);
    expect(lo.nodes.get(nodeId)!.pivot.quaternion.w).toBeLessThan(0.99);
    lo.dispose();
  });

  it('low: при «взрыве» показываются отдельные детали, после сборки — снова общий меш', () => {
    const lo = new ProductScene(fixture('kitchen_straight.viewer.json'), { quality: 'low' });
    const merged = lo.parts.filter((h) => h.merged);
    expect(merged.length).toBeGreaterThan(10);
    lo.setExplode(1);
    expect(lo.mergedMeshes.every((x) => !x.visible)).toBe(true);
    expect(merged.every((h) => h.mesh.visible)).toBe(true);
    lo.setExplode(0);
    expect(lo.mergedMeshes.every((x) => x.visible)).toBe(true);
    expect(merged.every((h) => !h.mesh.visible)).toBe(true);
    lo.dispose();
  });

  it('явные опции важнее пресета', () => {
    const s = new ProductScene(fixture('wardrobe_2sec.viewer.json'), { quality: 'low', edges: true, merge: false });
    expect(s.settings.edges).toBe(true);
    expect(s.mergedMeshes).toHaveLength(0);
    expect(s.parts.every((h) => h.edges)).toBe(true);
    s.dispose();
  });
});

describe('подсветка и кадр', () => {
  it('по номеру, ключу, префиксу секции и id узла', () => {
    const s = new ProductScene(fixture('wardrobe_full.viewer.json'));
    expect(s.highlight(8).map((h) => h.part.key)).toEqual(['partition[0]']);
    expect(s.highlight('partition[0]').map((h) => h.part.number)).toEqual([8]);
    const section = s.highlight('sections[1]');
    expect(section.length).toBeGreaterThan(3);
    expect(section.every((h) => h.part.key.startsWith('sections[1].'))).toBe(true);
    // Не цепляет sections[10] и т. п.
    expect(section.some((h) => h.part.key.startsWith('sections[1]0'))).toBe(false);
    const nodeId = 'sections[1].fill[0].drawer[1]';
    const drawer = s.highlight(nodeId);
    expect(drawer.length).toBeGreaterThan(1);
    expect(drawer.every((h) => h.part.node === nodeId)).toBe(true);
    expect(s.highlight([1, 2]).map((h) => h.part.number)).toEqual([1, 2]);
    expect(s.highlighted.map((h) => h.part.number)).toEqual([1, 2]);
    s.dispose();
  });

  it('подсвеченная деталь получает emissive-материал; снятие возвращает исходный', () => {
    const s = new ProductScene(fixture('wardrobe_full.viewer.json'));
    const h = s.parts.find((p) => p.part.number === 8)!;
    const base = h.mesh.material;
    s.highlight(8, { color: '#00ff00' });
    const hl = h.mesh.material as unknown as { emissive: { getHexString(): string }; name: string };
    expect(hl).not.toBe(base);
    expect(hl.emissive.getHexString()).toBe('00ff00');
    s.clearHighlight();
    expect(h.mesh.material).toBe(base);
    expect(s.highlighted).toHaveLength(0);
    s.dispose();
  });

  it('low: подсветка слитой детали показывает её отдельный меш; «рентген» прячет общий меш', () => {
    const s = new ProductScene(fixture('wardrobe_full.viewer.json'), { quality: 'low' });
    const h = s.parts.find((p) => p.part.number === 8)!;
    expect(h.merged).toBe(true);
    expect(h.mesh.visible).toBe(false);
    s.highlight(8);
    expect(h.mesh.visible).toBe(true);
    expect(s.mergedMeshes.every((m) => m.visible)).toBe(true);
    s.highlight(8, { ghost: true });
    expect(s.mergedMeshes.every((m) => !m.visible)).toBe(true);
    const other = s.parts.find((p) => p.part.number === 1)!;
    expect((other.mesh.material as { name: string }).name).toBe('ghost');
    s.clearHighlight();
    expect(h.mesh.visible).toBe(false);
    expect((other.mesh.material as { name: string }).name).toBe(other.part.material);
    s.dispose();
  });

  it('кадр на деталь: камера смотрит в центр детали и ближе, чем на всё изделие', () => {
    const s = new ProductScene(fixture('wardrobe_full.viewer.json'));
    const all = s.frameTarget(null)!;
    const fit = s.frameTarget('partition[0]')!;
    const b = s.boundsOf('partition[0]');
    expect(fit.target.distanceTo(b.getCenter(new Vector3()))).toBeLessThan(1e-9);
    expect(fit.position.distanceTo(fit.target)).toBeLessThan(all.position.distanceTo(all.target));
    expect(s.frameTarget('nothing')).toBeNull();
    s.dispose();
  });
});

describe('статистика', () => {
  it('high: детали + рёбра = 2 вызова на деталь (+1 — тени у стыков)', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const s = new ProductScene(m, { quality: 'high', ao: false });
    const st = s.stats();
    expect(st.drawCalls).toBe(m.parts.length * 2);
    expect(st.meshes).toBe(m.parts.length);
    const withAo = new ProductScene(m, { quality: 'high' });
    expect(withAo.ao).not.toBeNull();
    expect(withAo.stats().drawCalls).toBe(st.drawCalls + 1);
    withAo.dispose();
    expect(s.root.children.some((c) => c instanceof Mesh)).toBe(true);
    s.dispose();
  });
});

describe('превью', () => {
  it('PNG без WebGL: сигнатура, размер, изделие в центре, прозрачные углы', async () => {
    const { thumbnailPng, thumbnailRgba } = await import('../src/thumbnail/index.js');
    const m = fixture('wardrobe_full.viewer.json');
    const img = thumbnailRgba(m, { width: 160, height: 120, supersample: 2 });
    expect(img.data.length).toBe(160 * 120 * 4);
    const px = (x: number, y: number) => Array.from(img.data.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4));
    expect(px(80, 60)[3]).toBe(255);
    expect(px(0, 0)[3]).toBe(0);
    // Фасады дубовые: в центре тёплый цвет (красный > синего).
    const [r, , b] = px(80, 60);
    expect(r!).toBeGreaterThan(b!);
    const png = thumbnailPng(m, { width: 64, height: 48, background: 'white', supersample: 1 });
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(dv.getUint32(16)).toBe(64);
    expect(dv.getUint32(20)).toBe(48);
  });

  it('камера превью: изделие заполняет кадр на долю fill', async () => {
    const { fitThumbnailCamera } = await import('../src/thumbnail/index.js');
    const s = new ProductScene(fixture('kitchen_straight.viewer.json'));
    const b = s.closedBounds;
    const cam = fitThumbnailCamera(b, 4 / 3, 30, undefined, 0.9);
    let ext = 0;
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z]) {
          const p = new Vector3(x, y, z).project(cam);
          ext = Math.max(ext, Math.abs(p.x), Math.abs(p.y));
        }
    expect(ext).toBeGreaterThan(0.85);
    expect(ext).toBeLessThan(0.95);
    s.dispose();
  });
});
