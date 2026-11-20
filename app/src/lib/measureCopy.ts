/**
 * «Как прошлое» (v3: X1Orders): новый замер, где первое окно — копия последнего изделия мастера
 * (та же комплектация, деление, открывания, добивки) с пустыми размерами проёма.
 * Источник — последняя законченная позиция на телефоне или с сервера (список заказов: first_doc;
 * уточнение по заказу — позиция, которую последней правил этот мастер). Чистые функции — проверяются node-скриптом.
 */
import type { Doc, OrderFull, OrderRow } from '@/api/types';

type LocalLike = { doc: Doc; updated_at: string; deleted: boolean; step?: number };
export type LastSource = { doc: Doc; at: string; from: 'phone' | 'server'; order_id?: string };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const hasTree = (d?: Doc | null): d is Doc => !!d?.frame?.root;

/** Самое свежее изделие: законченная позиция на телефоне или первая позиция последнего заказа с сервера. */
export function pickLast(local: LocalLike[], rows: Pick<OrderRow, 'id' | 'updated_at' | 'first_doc'>[]): LastSource | null {
  const ph = local.filter((p) => !p.deleted && p.step === undefined && hasTree(p.doc))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const sv = rows.filter((r) => hasTree(r.first_doc)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const a: LastSource | null = ph ? { doc: ph.doc, at: ph.updated_at, from: 'phone' } : null;
  const b: LastSource | null = sv ? { doc: sv.first_doc as Doc, at: sv.updated_at, from: 'server', order_id: sv.id } : null;
  if (a && b) return b.at > a.at ? b : a;
  return a ?? b;
}

/** Из заказа с сервера — позиция, которую последней правил этот мастер (иначе — последняя по времени). */
export function lastOfOrder(full: Pick<OrderFull, 'positions'>, userId?: string | null): Doc | null {
  const ps = full.positions.filter((p) => !p.deleted && hasTree(p.doc)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const mine = userId ? ps.find((p) => p.updated_by?.id === userId) : undefined;
  return (mine ?? ps[0])?.doc ?? null;
}

/** Копия для нового замера: без помещения, размеров проёма, количества, принятых предупреждений и своих строк. */
export function blankCopy(src: Doc, id: string): Doc {
  const d = clone(src);
  d.id = id;
  d.qty = 1;
  d.accepted_warnings = [];
  delete d.room;
  delete d.template;
  delete d.custom_lines;
  if (d.opening) {
    delete d.opening.width;
    delete d.opening.height;
  }
  return d;
}
