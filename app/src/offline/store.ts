/**
 * Офлайн-хранилище замера (PRD 5, FR-M10): заказы и позиции пишутся на телефон сразу, каждый шаг.
 * При появлении сети — пакетом в POST /oyna/sync. Конфликт (позицию правили в офисе) — обе версии
 * сохраняются, человек выбирает: «моя» (force) или «с сервера».
 * Хранится в AsyncStorage одним JSON — замеров на телефоне десятки, не тысячи.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

import { api, ApiError } from '@/api/http';
import type { Conflict, Doc, SyncResult } from '@/api/types';

const KEY = 'oyna.offline.v1';

export type LocalOrder = { id: string; address?: string; floor?: number; client?: { name?: string; phone?: string; telegram?: string }; synced: boolean; created_at: string };
export type LocalPosition = {
  id: string; order_id: string; doc: Doc; base_rev: number | null; dirty: boolean; deleted: boolean; updated_at: string;
  /** черновик мастера замера: на каком шаге остановились (MResume) */
  step?: number;
};
export type LocalConflict = { position_id: string; order_id: string; mine: Doc; server: Conflict['server'] };
type State = { orders: Record<string, LocalOrder>; positions: Record<string, LocalPosition>; conflicts: Record<string, LocalConflict>; last_sync?: string };

let state: State = { orders: {}, positions: {}, conflicts: {} };
let loaded = false;
const subs = new Set<() => void>();

/** UUID v4 без нативных модулей (id заказа и позиции создаются на телефоне — сервер принимает их как есть). */
export function uuid(): string {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += h[(Math.random() * 4) | 8];
    else s += h[(Math.random() * 16) | 0];
  }
  return s;
}

async function load() {
  if (loaded) return;
  const raw = await AsyncStorage.getItem(KEY);
  if (raw) state = JSON.parse(raw);
  loaded = true;
}
async function persist() {
  await AsyncStorage.setItem(KEY, JSON.stringify(state));
  subs.forEach((f) => f());
}
const now = () => new Date().toISOString();

export const offline = {
  subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; },
  async snapshot(): Promise<State> { await load(); return state; },

  async createOrder(o: Omit<LocalOrder, 'id' | 'synced' | 'created_at'> = {}): Promise<LocalOrder> {
    await load();
    const order: LocalOrder = { id: uuid(), synced: false, created_at: now(), ...o };
    state.orders[order.id] = order;
    await persist();
    return order;
  },
  /** Сохранить позицию локально (каждый шаг мастера, каждое изменение в редакторе без сети). */
  async savePosition(order_id: string, doc: Doc, opts: { id?: string; step?: number; base_rev?: number | null } = {}): Promise<LocalPosition> {
    await load();
    const id = opts.id ?? doc.id ?? uuid();
    const prev = state.positions[id];
    const p: LocalPosition = {
      id, order_id, doc: { ...doc, id }, base_rev: opts.base_rev !== undefined ? opts.base_rev : prev?.base_rev ?? null,
      dirty: true, deleted: false, updated_at: now(), step: opts.step,
    };
    state.positions[id] = p;
    await persist();
    return p;
  },
  async deletePosition(id: string) {
    await load();
    const p = state.positions[id];
    if (!p) return;
    if (p.base_rev === null) delete state.positions[id];       // на сервер не уходила — просто забываем
    else state.positions[id] = { ...p, deleted: true, dirty: true, updated_at: now() };
    await persist();
  },
  /** Незаконченные замеры (step задан) — для экрана «Продолжить замер». */
  async drafts(): Promise<LocalPosition[]> {
    await load();
    return Object.values(state.positions).filter((p) => p.step !== undefined && !p.deleted)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },
  async pendingCount(): Promise<number> {
    await load();
    return Object.values(state.orders).filter((o) => !o.synced).length + Object.values(state.positions).filter((p) => p.dirty).length;
  },

  /** Отправить всё несинхронизированное. Возвращает число отправленных и конфликтов. */
  async sync(): Promise<{ sent: number; conflicts: number; offline?: boolean }> {
    await load();
    const orders = Object.values(state.orders).filter((o) => !o.synced);
    const positions = Object.values(state.positions).filter((p) => p.dirty && p.step === undefined);
    if (!orders.length && !positions.length) return { sent: 0, conflicts: 0 };
    let res: SyncResult;
    try {
      res = await api.post<SyncResult>('/oyna/sync', {
        orders: orders.map(({ id, address, floor, client }) => ({ id, address, floor, client })),
        positions: positions.map((p) => ({ order_id: p.order_id, position_id: p.id, doc: p.doc, base_rev: p.base_rev, deleted: p.deleted })),
      });
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork) return { sent: 0, conflicts: 0, offline: true };
      throw e;
    }
    for (const o of res.orders) if (state.orders[o.id]) state.orders[o.id].synced = true;
    let conflicts = 0;
    for (const r of res.positions) {
      const p = state.positions[r.position_id];
      if (!p) continue;
      if (r.status === 'ok') {
        if (p.deleted) delete state.positions[p.id];
        else state.positions[p.id] = { ...p, base_rev: r.rev ?? p.base_rev, dirty: false };
      } else if (r.status === 'conflict' && r.server) {
        conflicts++;
        state.conflicts[p.id] = { position_id: p.id, order_id: p.order_id, mine: p.doc, server: r.server };
      }
    }
    state.last_sync = now();
    await persist();
    return { sent: res.positions.length + res.orders.length, conflicts };
  },
  /** Решить конфликт: «моя» — перезаписать сервер (force), «сервер» — взять серверную версию. */
  async resolve(position_id: string, take: 'mine' | 'server') {
    await load();
    const c = state.conflicts[position_id];
    if (!c) return;
    if (take === 'mine') {
      const out = await api.put<{ rev: number }>(`/oyna/orders/${c.order_id}/positions/${position_id}`, { doc: c.mine, force: true });
      state.positions[position_id] = { ...state.positions[position_id], base_rev: out.rev, dirty: false };
    } else {
      state.positions[position_id] = { ...state.positions[position_id], doc: c.server.doc, base_rev: c.server.rev, dirty: false };
    }
    delete state.conflicts[position_id];
    await persist();
  },
};

/** Синхронизация при появлении сети. Вызвать один раз в корне приложения. */
export function startAutoSync(onDone?: (r: { sent: number; conflicts: number }) => void) {
  return NetInfo.addEventListener((s) => {
    if (s.isConnected && s.isInternetReachable !== false) {
      offline.sync().then((r) => { if (r.sent || r.conflicts) onDone?.(r); }).catch(() => { /* повторим при следующем подключении */ });
    }
  });
}
