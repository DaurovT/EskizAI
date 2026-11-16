import type { ChatMessage, ProductTree } from '../../api/types';
import { KITCHEN_EDITOR_DEMO, KITCHEN_PHOTO_DEMO, SAMPLES } from '../../api/mock/data';
import { chatView } from '../chatView';
import {
  BASE_KINDS, doorCount, drawerLines, duplicateAt, hasLift, hasOpenBottom, isFold, labelCode, moveAt, newModule, removeAt, schemeLayout, selFromPartKey, sumFixes,
  wallKindOf, wallModHeight, withKind,
} from '../kitchenScheme';

const straight = SAMPLES.kitchen_straight.tree;
const corner = SAMPLES.kitchen_corner.tree; // угол слева, Г-образный 900

describe('kitchenScheme: подписи', () => {
  it('верхние двери — «Дверь» / «2 двери» по числу дверей (null — по ширине), не «Полки»', () => {
    expect(labelCode({ kind: 'doors', width: 400 }, 'wall')).toBe('door');
    expect(labelCode({ kind: 'doors', width: 800 }, 'wall')).toBe('doors2');
    expect(labelCode({ kind: 'doors', width: 800, doors: 1 }, 'wall')).toBe('door');
    expect(doorCount({ kind: 'doors', width: 600 })).toBe(1);
  });
  it('новые виды верхних: подъёмные, ниша техники, открытые, пусто', () => {
    expect(labelCode({ kind: 'doors', width: 600, opening: 'lift' }, 'wall')).toBe('lift');
    expect(labelCode({ kind: 'doors', width: 600, opening: 'lift', flaps: 2 }, 'wall')).toBe('lift2');
    expect(labelCode({ kind: 'appliance', width: 600 }, 'wall')).toBe('micro');
    expect(labelCode({ kind: 'appliance', width: 600, appliance: 'oven' }, 'wall')).toBe('oven');
    expect(labelCode({ kind: 'open', width: 450 }, 'wall')).toBe('open');
    expect(labelCode({ kind: 'gap', width: 600 }, 'wall2')).toBe('gap');
    expect(labelCode({ kind: 'open', width: 300 }, 'mid')).toBe('mid');
  });
  it('нижняя ниша техники: варка / ПММ / техника', () => {
    expect(labelCode({ kind: 'appliance', width: 600, hob: true }, 'base')).toBe('hob');
    expect(labelCode({ kind: 'appliance', width: 600, dw: true }, 'base')).toBe('dw');
    expect(labelCode({ kind: 'appliance', width: 600 }, 'base')).toBe('tech');
  });
  it('высота верхнего: своя, вытяжка 360, ниша без верха — высота ниши, иначе как у ряда', () => {
    expect(wallModHeight({ kind: 'hood', width: 600 }, straight)).toBe(360);
    expect(wallModHeight({ kind: 'doors', width: 600, height: 900 }, straight)).toBe(900);
    expect(wallModHeight({ kind: 'appliance', width: 600, above: 'none' }, straight)).toBe(380);
    expect(wallModHeight({ kind: 'doors', width: 600 }, { ...straight, wall_height: 960 })).toBe(960);
  });
});

describe('kitchenScheme: раскладка по реальным ширинам', () => {
  it('оба ряда от x = 0, модули — подряд по своим ширинам', () => {
    const l = schemeLayout(straight);
    expect(l.base.map((b) => [b.x, b.w])).toEqual([[0, 400], [400, 600], [1000, 600], [1600, 800], [2400, 450]]);
    expect(l.wall.map((b) => b.x)).toEqual([0, 400, 1000, 1600, 2400]);
    expect(l.len).toBe(2850);
  });
  it('полка на столешнице — по своему x, пустое место занимает ширину', () => {
    const l = schemeLayout(KITCHEN_EDITOR_DEMO);
    expect(l.mid).toEqual([{ sel: { row: 'mid', i: 0 }, x: 1700, w: 300, m: (KITCHEN_EDITOR_DEMO.mid as unknown[])[0] as never }]);
    expect(l.wall[4]).toMatchObject({ x: 2450, w: 600, m: { kind: 'gap' } });
    expect(l.baseLen).toBe(3050);
  });
  it('ряд 2 угла слева: угол справа на виде стены Б, нижние за Г-модулем 900', () => {
    const l = schemeLayout(corner, 2);
    expect(l.corner).toMatchObject({ w: 900, sel: { row: 'base', i: 0 } });
    expect(l.baseLen).toBe(900 + 450 + 450);
    // от угла: base2[0] сразу за угловой зоной (у правого края вида)
    expect(l.base[0].x + l.base[0].w).toBe(l.len - 900);
    expect(l.base[1].x).toBeLessThan(l.base[0].x);
  });
});

describe('kitchenScheme: правки рядов', () => {
  const list = [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }];
  it('удалить / дублировать / сдвинуть', () => {
    expect(removeAt(list, 1).map((x) => x.kind)).toEqual(['a', 'c']);
    expect(duplicateAt(list, 0).map((x) => x.kind)).toEqual(['a', 'a', 'b', 'c']);
    expect(moveAt(list, 0, 1).map((x) => x.kind)).toEqual(['b', 'a', 'c']);
    expect(moveAt(list, 0, -1)).toBe(list);
    expect(moveAt(list, 2, 1)).toBe(list);
  });
  it('копия не связана с оригиналом', () => {
    const src = [{ kind: 'doors', top: { doors: 1 } }];
    const out = duplicateAt(src, 0);
    (out[1].top as { doors: number }).doors = 2;
    expect(src[0].top.doors).toBe(1);
  });
  it('новый модуль: двери 600; полка на столешнице — правее последней', () => {
    expect(newModule('base', straight)).toEqual({ kind: 'doors', width: 600 });
    expect(newModule('mid', KITCHEN_EDITOR_DEMO)).toMatchObject({ kind: 'open', x: 2000, width: 300 });
  });
  it('смена вида: ширина и антресоль остаются, чужие поля уходят', () => {
    const m = { kind: 'doors', width: 450, doors: 1, hinge: 'right', shelves: 2, top: { doors: 1 } };
    expect(withKind(m, 'wall', 'lift')).toEqual({ kind: 'doors', width: 450, opening: 'lift', flaps: null, shelves: 2, top: { doors: 1 } });
    expect(withKind(m, 'wall', 'appliance')).toEqual({ kind: 'appliance', width: 450, appliance: 'microwave', shelves: 0, top: { doors: 1 } });
    expect(withKind(m, 'wall', 'gap')).toEqual({ kind: 'gap', width: 450 });
    expect(withKind({ kind: 'doors', width: 400 }, 'base', 'drawers')).toEqual({ kind: 'drawers', width: 400, drawers: 3 });
    expect(wallKindOf({ kind: 'doors', width: 1, opening: 'lift' })).toBe('lift');
  });
});

describe('kitchenScheme: подгонка суммы к стене', () => {
  const mods = [{ kind: 'drawers', width: 400 }, { kind: 'doors', width: 600 }, { kind: 'sink', width: 800 }, { kind: 'fridge', width: 600 }];
  it('соседний справа от выбранного, затем добор', () => {
    expect(sumFixes(mods, 150, 0)).toEqual([{ kind: 'neighbour', i: 1, from: 600, to: 750 }, { kind: 'add', width: 150 }]);
  });
  it('холодильник не трогаем; меньше 150 — без добора', () => {
    expect(sumFixes(mods, -50, 2)).toEqual([{ kind: 'neighbour', i: 1, from: 600, to: 550 }]);
  });
  it('без выбора — крайний подходящий; сошлось — ничего', () => {
    expect(sumFixes(mods, 100, null)[0]).toEqual({ kind: 'neighbour', i: 2, from: 800, to: 900 });
    expect(sumFixes(mods, 0, 1)).toEqual([]);
  });
});

describe('kitchenScheme: деталь 3D → модуль', () => {
  it('ключи ядра', () => {
    expect(selFromPartKey('base[2].doors.door[1]', straight)).toEqual({ row: 'base', i: 2 });
    expect(selFromPartKey('wall[0].doors.door[1]', straight)).toEqual({ row: 'wall', i: 0 });
    expect(selFromPartKey('wall[1].tier.doors.door[1]', straight)).toEqual({ row: 'wall', i: 1, tier: true });
    expect(selFromPartKey('wall[1].top', straight)).toEqual({ row: 'wall', i: 1 });
    expect(selFromPartKey('mid[0].side.left', KITCHEN_EDITOR_DEMO)).toEqual({ row: 'mid', i: 0 });
    expect(selFromPartKey('countertop[2]', straight)).toBe('top');
    expect(selFromPartKey('kitchen.plinth[1]', straight)).toBeNull();
    expect(selFromPartKey('wall[9].side.left', straight)).toBeNull();
  });
  it('ряд 2 угла слева ядро строит в обратном порядке', () => {
    expect(selFromPartKey('base2[0].side.left', corner)).toEqual({ row: 'base2', i: 1 });
    expect(selFromPartKey('wall2[1].doors.door[1]', corner)).toEqual({ row: 'wall2', i: 0 });
    expect(selFromPartKey('base2[0]', { ...corner, corner_side: 'right' } as ProductTree)).toEqual({ row: 'base2', i: 0 });
    expect(selFromPartKey('base2.corner.side', corner)).toEqual({ row: 'base', i: 0 });
  });
});

describe('chatView: переписка как у шкафа', () => {
  const at = '2026-01-01T10:00:00Z';
  const msg = (x: Partial<ChatMessage>): ChatMessage => ({ id: Math.random().toString(36), author: 'ai', text: '', undone: false, created_at: at, ...x });
  it('последняя правка — карточкой, вопрос с вариантами — блоком, остальное — история', () => {
    const a = msg({ author: 'master', text: 'шире' });
    const b = msg({ text: 'Готово', version_id: 'v2' });
    const c = msg({ author: 'master', text: 'ручки?' });
    const d = msg({ text: 'Какие ручки?', options: ['Gola', 'Скоба'] });
    const v = chatView([a, b, c, d]);
    expect(v.lastChange).toBe(b);
    expect(v.question).toBe(d);
    expect(v.history).toEqual([a, c]);
  });
  it('вопросы распознавания в хвосте — отвечаются разом', () => {
    const q = msg({ kind: 'question', text: 'Торцы открытые?', options: ['Да', 'Нет'] });
    const v = chatView([msg({ text: 'Собрано', version_id: 'v1' }), q], [{ id: 'q1', text: 'Торцы открытые?', options: ['Да', 'Нет'] }]);
    expect(v.designQs.map((x) => x.id)).toEqual(['q1']);
    expect(v.question).toBeNull();
    expect(v.history).toEqual([]);
  });
});

describe('kitchenScheme: кухня с фото — карго, ящики 1+2, два ряда дверей, ниша под подъёмным, рамка СВЧ', () => {
  const base = KITCHEN_PHOTO_DEMO.base as never[];
  const wall = KITCHEN_PHOTO_DEMO.wall as never[];
  it('подписи: бутылочница, 2 ряда дверей, подъёмный + ниша, двери + ниша', () => {
    expect(labelCode(base[1], 'base')).toBe('cargo');
    expect(labelCode(base[3], 'base')).toBe('drawers');
    expect(labelCode(wall[0], 'wall')).toBe('rows');
    expect(labelCode(wall[1], 'wall')).toBe('niche_lift');
    expect(labelCode({ kind: 'doors', width: 600, open_bottom: 300 }, 'wall')).toBe('niche_door');
    expect(labelCode(wall[2], 'wall')).toBe('micro');
    expect(labelCode({ kind: 'doors', width: 600, rows: 2, opening: 'lift' }, 'wall')).toBe('lift'); // ряды — только у распашных
    expect(BASE_KINDS).toContain('cargo');
  });
  it('ящики 1+2: верхний — 1/5, остальные поровну; по умолчанию — поровну', () => {
    const lines = drawerLines(base[3]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBeCloseTo(0.2);
    expect(lines[1]).toBeCloseTo(0.6);
    expect(drawerLines({ kind: 'drawers', width: 450, drawers: 3 })).toEqual([1 / 3, 2 / 3]);
    expect(drawerLines({ kind: 'drawers', width: 450, drawers: 1, drawer_layout: 'small_top' })).toEqual([]);
  });
  it('раскладка: ряды по 2250, ниша снизу распознаётся', () => {
    const l = schemeLayout(KITCHEN_PHOTO_DEMO);
    expect(l.baseLen).toBe(2250);
    expect(l.wallLen).toBe(2250);
    expect(l.wall.map((b) => b.x)).toEqual([0, 1200, 1650]);
    expect(hasOpenBottom(wall[1])).toBe(true);
    expect(hasOpenBottom(wall[0])).toBe(false);
  });
  it('смена вида: карго сужается до 150–300; ниша снизу и ряды сохраняются при смене дверей/подъёмных', () => {
    expect(withKind({ kind: 'doors', width: 600 }, 'base', 'cargo')).toEqual({ kind: 'cargo', width: 300 });
    expect(withKind({ kind: 'doors', width: 150 }, 'base', 'cargo')).toEqual({ kind: 'cargo', width: 150 });
    expect(withKind(wall[1], 'wall', 'doors')).toMatchObject({ kind: 'doors', open_bottom: 480 });
    expect(withKind(wall[0], 'wall', 'lift')).not.toHaveProperty('rows');
    expect(withKind({ ...(wall[0] as object), opening: 'lift' } as never, 'wall', 'doors')).toMatchObject({ rows: 2 });
  });
  it('подгонка суммы: бутылочница — только в пределах 150–300', () => {
    const mods = [{ kind: 'doors', width: 600 }, { kind: 'cargo', width: 150 }];
    expect(sumFixes(mods, 100, 0)).toEqual([{ kind: 'neighbour', i: 1, from: 150, to: 250 }]);
    expect(sumFixes(mods, 300, 0)[0]).toEqual({ kind: 'add', width: 300 }); // карго до 450 не растягиваем
  });
  it('деталь 3D бутылочницы → модуль схемы', () => {
    expect(selFromPartKey('base[1].cargo.front', KITCHEN_PHOTO_DEMO)).toEqual({ row: 'base', i: 1 });
    expect(selFromPartKey('wall[2].niche_frame', KITCHEN_PHOTO_DEMO)).toEqual({ row: 'wall', i: 2 });
    expect(selFromPartKey('wall[0].doors[2].door[1]', KITCHEN_PHOTO_DEMO)).toEqual({ row: 'wall', i: 0 });
  });
});

describe('kitchenScheme: складной подъёмник (lift_type fold)', () => {
  const fold = { kind: 'doors', width: 900, opening: 'lift', lift_type: 'fold' };
  it('подпись «Складной», а не «Подъёмные ×2»; flaps не учитывается', () => {
    expect(labelCode(fold, 'wall')).toBe('fold');
    expect(labelCode({ ...fold, flaps: 2 }, 'wall')).toBe('fold');
    expect(labelCode({ ...fold, opening: null }, 'wall')).toBe('doors2'); // без opening lift — обычные двери
    expect(labelCode({ ...fold, open_bottom: 300 }, 'wall')).toBe('niche_lift');
  });
  it('складной — только у подъёмных: двери/вытяжка с opening lift и ниша техники с above lift', () => {
    expect(isFold(fold)).toBe(true);
    expect(isFold({ ...fold, opening: 'hinged' })).toBe(false);
    expect(isFold({ kind: 'appliance', width: 600, above: 'lift', lift_type: 'fold' })).toBe(true);
    expect(isFold({ kind: 'appliance', width: 600, above: 'door', lift_type: 'fold' })).toBe(false);
    expect(hasLift({ kind: 'hood', width: 600, opening: 'lift' })).toBe(true);
    expect(hasLift({ kind: 'open', width: 600 })).toBe(false);
  });
  it('смена вида: «Подъёмные» сохраняет складной механизм, «Двери» — убирает', () => {
    expect(withKind(fold, 'wall', 'lift')).toMatchObject({ kind: 'doors', opening: 'lift', lift_type: 'fold', flaps: null });
    expect(withKind({ ...fold, flaps: 2 }, 'wall', 'lift').flaps).toBeNull();
    expect(withKind(fold, 'wall', 'doors').lift_type).toBeUndefined();
    expect(withKind({ kind: 'doors', width: 600, opening: 'lift', flaps: 2 }, 'wall', 'lift').lift_type).toBeUndefined();
  });
});
