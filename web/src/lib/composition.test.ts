/**
 * Тесты «Что в изделии»: `npm test` (node --test, типы стирает сам Node ≥ 22.18 — без сборщика).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ViewerModel, ViewerPart } from '@mebel/viewer';
import { boardKind, composition, decorName } from './composition.ts';

const fixture = (name: string): ViewerModel =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.viewer.json`, import.meta.url), 'utf8')) as ViewerModel;

const part = (role: string, material: string, extra: Partial<ViewerPart> = {}): ViewerPart => ({
  number: 1,
  key: `${role}.${material}.${Math.random()}`,
  name: role,
  role,
  material,
  thickness: 18,
  length: 700,
  width: 400,
  grain: 'none',
  contour: null,
  placement: { origin: [0, 0, 0], u: '+X', v: '+Z', n: '+Y' },
  holes: [],
  node: null,
  ...extra,
});

const model = (parts: ViewerPart[], extra: Partial<ViewerModel> = {}): ViewerModel => ({
  format: '1',
  size: [800, 720, 560],
  materials: {
    ldsp_16_white: { name: 'ЛДСП 16 Белый', color: '#f2f0eb', hasGrain: false, type: 'matte' },
    mdf_19_paint: { name: 'МДФ 19 под покраску', color: '#e9e6df', hasGrain: false },
    mirror_4_silver: { name: 'Зеркало 4 мм серебро', color: '#dfe6ea', hasGrain: false, type: 'mirror' },
  },
  parts,
  nodes: [],
  issues: [],
  ...extra,
});

test('decorName strips kind and thickness', () => {
  assert.equal(decorName('ЛДСП 18 Дуб сонома'), 'Дуб сонома');
  assert.equal(decorName('ЛМДФ 16 мм Шалфей'), 'Шалфей');
  assert.equal(decorName('Белый'), 'Белый');
  assert.equal(decorName('ЛДСП 16'), 'ЛДСП 16'); // нечего оставить — как есть
});

test('boardKind: by name, then by id', () => {
  assert.equal(boardKind('x', { name: 'ЛДСП 18 Белый', color: '#fff', hasGrain: false }), 'ldsp');
  assert.equal(boardKind('x', { name: 'ЛМДФ 16 Шалфей', color: '#fff', hasGrain: false }), 'lmdf');
  assert.equal(boardKind('mdf_19_paint', { name: 'Под покраску', color: '#fff', hasGrain: false }), 'mdf');
  assert.equal(boardKind('eman_123', { name: 'Kronospan K001', color: '#fff', hasGrain: false }), 'other');
});

test('full wardrobe: oak fronts, white body, bracket handles, contents', () => {
  const c = composition(fixture('wardrobe_full'));
  assert.equal(c.decor?.name, 'Дуб сонома');
  assert.equal(c.decor?.swatch.color, '#c9a57b');
  assert.equal(c.body?.name, 'Белый');
  assert.deepEqual(
    { kind: c.fronts?.kind, t: c.fronts?.thicknessMm, finish: c.fronts?.finish, painted: c.fronts?.painted },
    { kind: 'ldsp', t: 18, finish: 'matte', painted: false },
  );
  assert.deepEqual(c.handles, { kind: 'bracket', sizeMm: 128, finish: 'steel', color: '#b8bcc0', count: 11 });
  assert.deepEqual(c.inside, { doors: 8, slidingDoors: 0, drawers: 5, shelves: 9, rods: 1, lights: 0 });
});

test('sliding wardrobe: counts sliding doors, not swing doors', () => {
  const c = composition(fixture('kupe_3doors'));
  assert.equal(c.inside.slidingDoors, 3);
  assert.equal(c.inside.doors, 0);
  assert.equal(c.inside.rods, 1);
  assert.equal(c.body, null); // корпус того же цвета — второй строки нет
});

test('open shelving: no fronts, colour from body', () => {
  const c = composition(fixture('wardrobe_2sec'));
  assert.equal(c.fronts, null);
  assert.equal(c.decor?.name, 'Белый');
  assert.equal(c.body, null);
});

test('painted MDF fronts: paint colour and code, body shown separately', () => {
  const paint = { color: '#7A8B6F', code: 'RAL 6021', gloss: 'satin' };
  const c = composition(
    model([
      part('side', 'ldsp_16_white'),
      part('side', 'ldsp_16_white'),
      part('door', 'mdf_19_paint', { thickness: 19, decor: { face: 'front', paint, milling: [{ path: [] }] } }),
      part('door', 'mdf_19_paint', { thickness: 19, decor: { face: 'front', paint } }),
    ]),
  );
  assert.deepEqual(c.decor, { name: 'RAL 6021', swatch: { color: '#7a8b6f', texture: null }, painted: true });
  assert.equal(c.fronts?.kind, 'mdf');
  assert.equal(c.fronts?.painted, true);
  assert.equal(c.fronts?.paintCode, 'RAL 6021');
  assert.equal(c.fronts?.finish, 'satin');
  assert.equal(c.fronts?.thicknessMm, 19);
  assert.equal(c.fronts?.milling, true);
  assert.equal(c.body?.name, 'Белый');
});

test('mirror sliding fill does not become the front colour; gola has no count', () => {
  const c = composition(
    model(
      [
        part('side', 'ldsp_16_white'),
        part('sliding_fill', 'mirror_4_silver', { node: 'sd1' }),
        part('sliding_fill', 'ldsp_16_white', { node: 'sd2' }),
      ],
      {
        nodes: [
          { id: 'sd1', kind: 'sliding_door', origin: [0, 0, 0], axis: '+X', range: 800 },
          { id: 'sd2', kind: 'sliding_door', origin: [0, 0, 0], axis: '-X', range: 800 },
        ],
        hardware: [{ id: 'g', kind: 'gola', name: 'Профиль Gola', node: null, part: 'x', finish: 'black', shapes: [] }],
      },
    ),
  );
  assert.equal(c.decor?.name, 'Белый');
  assert.equal(c.inside.slidingDoors, 2);
  assert.deepEqual(c.handles, { kind: 'gola', sizeMm: null, finish: 'black', color: null, count: 0 });
});

test('never exposes prices, suppliers or article numbers', () => {
  const json = JSON.stringify(composition(fixture('wardrobe_full'))).toLowerCase();
  for (const bad of ['price', 'cost', 'supplier', 'sku', 'article', 'markup']) assert.ok(!json.includes(bad), bad);
});
