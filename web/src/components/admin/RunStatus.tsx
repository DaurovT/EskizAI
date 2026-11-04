'use client';

import { Tag } from './ui';

export interface Run {
  id: string;
  supplier: string | null;
  source: string;
  file_name: string | null;
  full_snapshot: boolean;
  status: string;
  stats: { total?: number; new?: number; changed?: number; unchanged?: number; invalid?: number; review?: number; missing?: number; published?: Record<string, number> };
  error: string | null;
  created_by: string | null;
  started_at: string;
  finished_at: string | null;
  published_at: string | null;
}

const RUN_STATUS: Record<string, [string, 'green' | 'red' | 'yellow' | undefined]> = {
  parsed: ['разобран', undefined],
  matched: ['сопоставлен', undefined],
  review: ['ждёт проверки', 'yellow'],
  published: ['опубликован', 'green'],
  failed: ['ошибка', 'red'],
};

export function RunStatus({ status }: { status: string }) {
  const [label, color] = RUN_STATUS[status] ?? [status, undefined];
  return <Tag color={color}>{label}</Tag>;
}
