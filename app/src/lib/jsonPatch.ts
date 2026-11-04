/** Минимальный JSON Patch (RFC 6902: add / replace / remove) и JSON Pointer — для дерева модулей. */
export type PatchOp = { op: 'add' | 'replace' | 'remove' | string; path: string; value?: unknown };

export const parsePointer = (ptr: string): string[] =>
  ptr === '' || ptr === '/' ? [] : ptr.replace(/^\//, '').split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

export const toPointer = (parts: (string | number)[]): string =>
  '/' + parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

export function getAt(obj: unknown, ptr: string): unknown {
  let cur: unknown = obj;
  for (const k of parsePointer(ptr)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Возвращает новый объект; исходный не меняется. Отсутствующие объекты по пути создаются. */
export function setAt<T>(obj: T, ptr: string, value: unknown): T {
  return applyPatch(obj, [{ op: 'add', path: ptr, value }]);
}

export function applyPatch<T>(obj: T, ops: PatchOp[]): T {
  const root = clone(obj) as unknown as Record<string, unknown>;
  for (const op of ops) {
    const parts = parsePointer(op.path);
    const last = parts.pop();
    if (last === undefined) continue;
    let cur: Record<string, unknown> | unknown[] = root;
    for (const k of parts) {
      const c = cur as Record<string, unknown>;
      if (c[k] == null || typeof c[k] !== 'object') c[k] = {};
      cur = c[k] as Record<string, unknown>;
    }
    if (Array.isArray(cur)) {
      const i = last === '-' ? cur.length : Number(last);
      if (op.op === 'remove') cur.splice(i, 1);
      else if (op.op === 'add') cur.splice(i, 0, clone(op.value));
      else cur[i] = clone(op.value);
    } else if (op.op === 'remove') delete (cur as Record<string, unknown>)[last];
    else (cur as Record<string, unknown>)[last] = clone(op.value);
  }
  return root as unknown as T;
}
