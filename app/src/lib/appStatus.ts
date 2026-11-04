/** Обязательное обновление и техработы (SCR-45): чистая логика без React. */
import type { AppStatusOut } from '../api/types';

export type SystemScreen =
  | { kind: 'required'; storeUrl: string }
  | { kind: 'optional'; storeUrl: string; version: string; notes: AppStatusOut['release_notes'] }
  | { kind: 'maintenance'; until: string | null; message: AppStatusOut['maintenance']['message'] };

export function parseVersion(v: string | null | undefined): number[] {
  const nums = (v ?? '').match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
  while (nums.length < 3) nums.push(0);
  return nums;
}

/** <0 — a старше b, 0 — равны, >0 — a новее b. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Какой экран показать. Техработы и обязательное обновление — всегда (блокируют);
 * «Вышла новая версия» — один раз на версию (`dismissed` — версия, на которой нажали «Позже»).
 */
export function decideScreen(s: AppStatusOut, appVersion: string, dismissed: string | null): SystemScreen | null {
  const required = s.update === 'required' || compareVersions(appVersion, s.min_version) < 0;
  if (required) return { kind: 'required', storeUrl: s.store_url };
  if (s.maintenance.on) return { kind: 'maintenance', until: s.maintenance.until, message: s.maintenance.message };
  const optional = s.update === 'optional' || compareVersions(appVersion, s.latest_version) < 0;
  if (optional && dismissed !== s.latest_version) {
    return { kind: 'optional', storeUrl: s.store_url, version: s.latest_version, notes: s.release_notes };
  }
  return null;
}

/** «Закончим к 14:00 по Ташкенту, примерно через 40 минут» — время по Ташкенту (UTC+5) и минуты до конца. */
export function maintenanceEta(until: string | null, now = Date.now()): { time: string; minutes: number } | null {
  if (!until) return null;
  const at = Date.parse(until);
  if (Number.isNaN(at)) return null;
  const tash = new Date(at + 5 * 3_600_000);
  const time = `${String(tash.getUTCHours()).padStart(2, '0')}:${String(tash.getUTCMinutes()).padStart(2, '0')}`;
  return { time, minutes: Math.max(0, Math.round((at - now) / 60_000)) };
}
