import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Box3, PerspectiveCamera, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  ProductScene,
  coreToThree,
  fitCamera,
  parseViewerModel,
  partGeometry,
  surfaceKind,
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
    grain: 'none',
    contour: null,
    holes: [],
    node: null,
    ...over,
  };
}

function model(parts: ViewerPart[], nodes: ViewerModel['nodes'] = []): ViewerModel {
  return {
    format: '1',
    size: [1000, 1000, 1000],
    materials: { m: { name: 'm', color: '#ffffff', hasGrain: false } },
    parts,
    nodes,
    issues: [],
  };
}

function expectBox(box: Box3, min: [number, number, number], max: [number, number, number], digits = 6) {
  expect(box.min.x).toBeCloseTo(min[0], digits);
  expect(box.min.y).toBeCloseTo(min[1], digits);
  expect(box.min.z).toBeCloseTo(min[2], digits);
  expect(box.max.x).toBeCloseTo(max[0], digits);
  expect(box.max.y).toBeCloseTo(max[1], digits);
  expect(box.max.z).toBeCloseTo(max[2], digits);
}

/** Нормали наружу: для каждой грани нормаль смотрит от центра детали. */
function normalsPointOutward(p: ViewerPart): boolean {
  const g = partGeometry(p);
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const c = g.boundingBox!.getCenter(new Vector3());
  for (let i = 0; i < pos.count; i += 3) {
    const a = new Vector3().fromBufferAttribute(pos, i);
    const b = new Vector3().fromBufferAttribute(pos, i + 1);
    const d = new Vector3().fromBufferAttribute(pos, i + 2);
    const faceN = b.clone().sub(a).cross(d.clone().sub(a)).normalize();
    const centroid = a.clone().add(b).add(d).divideScalar(3);
    const out = centroid.sub(c);
    if (faceN.dot(out) <= 0) return false;
    if (faceN.dot(new Vector3().fromBufferAttribute(nor, i)) <= 0.99) return false;
  }
  return true;
}

describe('оси и размещение', () => {
  it('ядро → three: x = X, y = Z, z = −Y', () => {
    const v = coreToThree([10, 20, 30]);
    expect(v.toArray()).toEqual([10, 30, -20]);
  });

  it('боковина u=+Z, v=+Y, n=+X в [0,0,0]: x 0..16, y 0..2400, z −597..0', () => {
    const p = part({ placement: { origin: [0, 0, 0], u: '+Z', v: '+Y', n: '+X' } });
    const g = partGeometry(p);
    expectBox(g.boundingBox!, [0, 0, -597], [16, 2400, 0]);
  });

  it('то же в метрах (масштаб для AR)', () => {
    const p = part({ placement: { origin: [0, 0, 0], u: '+Z', v: '+Y', n: '+X' } });
    const g = partGeometry(p, { scale: 0.001 });
    expectBox(g.boundingBox!, [0, 0, -0.597], [0.016, 2.4, 0]);
  });

  it('крыша u=+X, v=+Y, n=+Z со сдвигом origin', () => {
    const p = part({
      length: 1168,
      width: 597,
      placement: { origin: [16, 0, 2384], u: '+X', v: '+Y', n: '+Z' },
    });
    expectBox(partGeometry(p).boundingBox!, [16, 2384, -597], [1184, 2400, 0]);
  });

  it('отрицательные оси идут от origin в минус', () => {
    const p = part({
      length: 100,
      width: 50,
      thickness: 10,
      placement: { origin: [500, 300, 200], u: '-X', v: '-Z', n: '-Y' },
    });
    // X: 400..500; Z: 150..200; Y: 290..300 → three.z: −300..−290
    expectBox(partGeometry(p).boundingBox!, [400, 150, -300], [500, 200, -290]);
  });

  it('нормали наружу и при зеркальном размещении (левая тройка осей)', () => {
    const mirrored = part({ placement: { origin: [0, 0, 0], u: '+Z', v: '+Y', n: '+X' } });
    const regular = part({ placement: { origin: [0, 0, 0], u: '+X', v: '+Y', n: '+Z' } });
    expect(normalsPointOutward(mirrored)).toBe(true);
    expect(normalsPointOutward(regular)).toBe(true);
  });

  it('образцы ядра: габарит сцены совпадает с size', () => {
    for (const name of ['wardrobe_2sec.viewer.json', 'wardrobe_3sec_niche.viewer.json']) {
      const m = fixture(name);
      const s = new ProductScene(m, { units: 'mm' });
      const size = s.closedBounds.getSize(new Vector3());
      const [w, h, d] = m.size;
      expect(size.x).toBeCloseTo(w, 3);
      expect(size.y).toBeCloseTo(h, 3);
      expect(size.z).toBeCloseTo(d, 3);
      // фасад в z = 0, изделие уходит назад в −z
      expect(s.closedBounds.max.z).toBeCloseTo(0, 6);
      s.dispose();
    }
  });
});

describe('контур с дугой', () => {
  const r = 100;
  const p = part({
    length: 600,
    width: 400,
    thickness: 16,
    placement: { origin: [0, 0, 0], u: '+X', v: '+Y', n: '+Z' },
    contour: {
      start: [0, 0],
      segments: [
        { kind: 'line', x: 500, y: 0 },
        { kind: 'arc', x: 600, y: 100, cx: 500, cy: 100, clockwise: false },
        { kind: 'line', x: 600, y: 400 },
        { kind: 'line', x: 0, y: 400 },
        { kind: 'line', x: 0, y: 0 },
      ],
    },
  });

  it('выдавливается на толщину и занимает полный габарит', () => {
    const g = partGeometry(p);
    // X 0..600, толщина по Z → three.y 0..16, ширина по Y → three.z −400..0
    expectBox(g.boundingBox!, [0, 0, -400], [600, 16, 0], 4);
  });

  it('угол скруглён: точка на дуге есть, острого угла нет', () => {
    const g = partGeometry(p, { curveSegments: 32 });
    const pos = g.getAttribute('position');
    let hasMid = false;
    let hasCorner = false;
    const mid = { x: 500 + r * Math.SQRT1_2, y: 100 - r * Math.SQRT1_2 }; // локальные (x, y)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const localY = -pos.getZ(i); // three.z = −Y
      if (Math.abs(x - mid.x) < 0.5 && Math.abs(localY - mid.y) < 0.5) hasMid = true;
      if (Math.abs(x - 600) < 1e-6 && Math.abs(localY) < 1e-6) hasCorner = true;
    }
    expect(hasMid).toBe(true);
    expect(hasCorner).toBe(false);
  });

  it('направление дуги учитывается (clockwise выгибает в другую сторону)', () => {
    const cw = part({
      ...p,
      contour: {
        start: [0, 0],
        segments: [
          { kind: 'line', x: 500, y: 0 },
          // та же хорда, но по часовой вокруг центра (600, 0): выемка внутрь
          { kind: 'arc', x: 600, y: 100, cx: 600, cy: 0, clockwise: true },
          { kind: 'line', x: 600, y: 400 },
          { kind: 'line', x: 0, y: 400 },
          { kind: 'line', x: 0, y: 0 },
        ],
      },
    });
    const pos = partGeometry(cw, { curveSegments: 32 }).getAttribute('position');
    // Середина дуги — (600 − r·cos45, r·sin45): ближе к углу (600, 0) изнутри
    const target = { x: 600 - r * Math.SQRT1_2, y: r * Math.SQRT1_2 };
    let found = false;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i) - target.x) < 0.5 && Math.abs(-pos.getZ(i) - target.y) < 0.5) found = true;
    }
    expect(found).toBe(true);
  });
});

describe('подвижные узлы', () => {
  const door = part({
    number: 7,
    key: 'door',
    role: 'facade',
    length: 600,
    width: 700,
    thickness: 18,
    placement: { origin: [0, -18, 0], u: '+X', v: '+Z', n: '+Y' },
    node: 'd',
  });

  it('дверь на петле: поворот −Z на 90° выводит её вперёд (+z в three)', () => {
    const s = new ProductScene(
      model([door], [{ id: 'd', kind: 'rotate', origin: [0, 0, 0], axis: '-Z', range: 90 }]),
      { units: 'mm', edges: false },
    );
    expectBox(s.currentBounds(), [0, 0, 0], [600, 700, 18], 4);
    s.setNodeOpen('d', 1);
    // X: −18..0, Y(ядра): −600..0 → three.z 0..600
    expectBox(s.currentBounds(), [-18, 0, 0], [0, 700, 600], 4);
    s.setNodeOpen('d', 0);
    expectBox(s.currentBounds(), [0, 0, 0], [600, 700, 18], 4);
    s.dispose();
  });

  it('ящик: slide по −Y на 400 мм', () => {
    const s = new ProductScene(
      model([{ ...door, key: 'drawer', node: 'dr' }], [{ id: 'dr', kind: 'slide', origin: [0, 0, 0], axis: '-Y', range: 400 }]),
      { units: 'mm', edges: false },
    );
    s.setNodeOpen('dr', 1);
    expectBox(s.currentBounds(), [0, 0, 400], [600, 700, 418], 4);
    s.dispose();
  });

  it('анимация: openAll + update доводит до конца и останавливается', () => {
    const s = new ProductScene(fixture('cabinet_door_drawer.viewer.json'), { units: 'mm', nodeDuration: 0.5 });
    expect(s.hasNodes).toBe(true);
    s.openAll();
    expect(s.animating).toBe(true);
    let frames = 0;
    while (s.update(1 / 60) && frames < 1000) frames++;
    expect(frames).toBeGreaterThan(20);
    expect(frames).toBeLessThan(40);
    expect(s.isNodeOpen('drawer[0]')).toBe(true);
    // ящик выехал вперёд на 400 мм: фасад ящика (передняя грань) в three.z = 18 + 400
    const front = s.parts.find((p) => p.part.key === 'drawer[0].front')!;
    const bb = front.mesh.geometry.boundingBox!.clone().applyMatrix4(front.mesh.matrixWorld);
    expect(bb.max.z).toBeCloseTo(418, 3);
    s.closeAll();
    while (s.update(1 / 60)) {
      /* ждём */
    }
    expect(s.currentBounds().max.z).toBeCloseTo(18, 3);
    s.dispose();
  });

  it('тап-логика: toggleNode переключает цель', () => {
    const s = new ProductScene(fixture('cabinet_door_drawer.viewer.json'), { units: 'mm' });
    s.toggleNode('door[0]');
    expect(s.isNodeOpen('door[0]')).toBe(true);
    s.toggleNode('door[0]');
    expect(s.isNodeOpen('door[0]')).toBe(false);
    s.dispose();
  });
});

describe('образцы ядра с узлами (wardrobe_full, kupe_3doors)', () => {
  it('wardrobe_full: фасады перед корпусом, size[2] — глубина корпуса', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const s = new ProductScene(m, { units: 'mm' });
    const b = s.closedBounds;
    expect(b.max.x - b.min.x).toBeCloseTo(m.size[0], 3);
    expect(b.max.y - b.min.y).toBeCloseTo(m.size[1], 3);
    expect(b.min.z).toBeCloseTo(-m.size[2], 3); // задняя стенка
    expect(b.max.z).toBeCloseTo(18, 3); // фасады 18 мм перед корпусом (Y < 0)
    s.dispose();
  });

  it('wardrobe_full: левая (−Z) и правая (+Z) двери открываются к зрителю', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const s = new ProductScene(m, { units: 'mm' });
    for (const id of ['sections[0].doors.door[1]', 'sections[2].doors.door[1]']) {
      const node = s.nodes.get(id)!;
      expect(node).toBeDefined();
      const before = new Box3();
      for (const p of node.parts) before.union(p.mesh.geometry.boundingBox!.clone().applyMatrix4(p.mesh.matrixWorld));
      s.setNodeOpen(id, 1);
      s.root.updateMatrixWorld(true);
      const after = new Box3();
      for (const p of node.parts) after.union(p.mesh.geometry.boundingBox!.clone().applyMatrix4(p.mesh.matrixWorld));
      // дверь ушла вперёд (+z), а не внутрь корпуса
      expect(after.max.z).toBeGreaterThan(before.max.z + 300);
      expect(after.min.z).toBeGreaterThan(-20);
    }
    s.dispose();
  });

  it('wardrobe_full: ящик выезжает на 550 мм, open/close всех узлов', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const s = new ProductScene(m, { units: 'mm' });
    expect(s.nodes.size).toBe(m.nodes.length);
    s.setAllOpen(1);
    const front = s.parts.find((p) => p.part.key === 'sections[1].fill[0].drawer[1].front')!;
    s.root.updateMatrixWorld(true);
    const bb = front.mesh.geometry.boundingBox!.clone().applyMatrix4(front.mesh.matrixWorld);
    expect(bb.max.z).toBeCloseTo(18 + 550, 3);
    s.setAllOpen(0);
    expect(s.currentBounds().max.z).toBeCloseTo(18, 3);
    s.dispose();
  });

  it('kupe_3doors: двери-купе едут вдоль X, зеркало — зеркальный материал', () => {
    const m = fixture('kupe_3doors.viewer.json');
    const s = new ProductScene(m, { units: 'mm' });
    const door = s.nodes.get('sliding_doors.door[1]')!;
    const x0 = door.pivot.position.x;
    s.setNodeOpen('sliding_doors.door[1]', 1);
    expect(door.pivot.position.x - x0).toBeCloseTo(780.6, 3);
    expect(door.pivot.quaternion.w).toBeCloseTo(1, 6);
    const mirror = s.parts.find((p) => p.part.material === 'mirror_4_silver');
    expect(mirror).toBeDefined();
    const mat = mirror!.mesh.material as import('three').MeshStandardMaterial;
    expect(mat.metalness).toBe(1);
    expect(surfaceKind('rod_oval_chrome')).toBe('metal');
    expect(surfaceKind('ldsp_16_white')).toBe('board');
    s.dispose();
  });
});

describe('«взрыв» и выбор детали', () => {
  it('взрыв раздвигает детали от центра и возвращает назад', () => {
    const s = new ProductScene(fixture('wardrobe_2sec.viewer.json'), { units: 'mm' });
    const before = s.currentBounds().getSize(new Vector3());
    s.setExplode(1);
    const after = s.currentBounds().getSize(new Vector3());
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
    s.setExplode(0);
    const back = s.currentBounds().getSize(new Vector3());
    expect(back.x).toBeCloseTo(before.x, 6);
    expect(back.y).toBeCloseTo(before.y, 6);
    s.dispose();
  });

  it('raycast: луч спереди в центр двери попадает в дверь', () => {
    const s = new ProductScene(fixture('cabinet_door_drawer.viewer.json'), { units: 'm' });
    const rc = new Raycaster(new Vector3(0.3, 0.3, 3), new Vector3(0, 0, -1));
    const hit = s.pick(rc);
    expect(hit).not.toBeNull();
    expect(hit!.key).toBe('door[0]');
    expect(hit!.node).toBe('door[0]');
    expect(hit!.number).toBe(8);
    s.dispose();
  });

  it('pickAt по камере от fitCamera: центр кадра попадает в изделие', () => {
    const s = new ProductScene(fixture('cabinet_door_drawer.viewer.json'), { units: 'm' });
    const fit = fitCamera(s.closedBounds, 40, 1, new Vector3(0, 0, 1));
    const cam = new PerspectiveCamera(40, 1, fit.near, fit.far);
    cam.position.copy(fit.position);
    cam.lookAt(fit.target);
    cam.updateMatrixWorld(true);
    const hit = s.pickAt(cam, 0, 0);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeGreaterThan(0);
    s.dispose();
  });
});
