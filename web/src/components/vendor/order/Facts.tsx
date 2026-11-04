'use client';

/** Замеры и размеры проекта: структура приходит из ядра и может меняться — показываем как есть, с подписями для известных ключей. */
import { AuthImg } from '@/components/staff/AuthImg';
import { dt } from '@/lib/admin/format';
import type { Attachment } from '@/components/staff/OrderChat';

const LABEL: Record<string, string> = {
  width: 'Ширина',
  height: 'Высота',
  depth: 'Глубина',
  width_mm: 'Ширина, мм',
  height_mm: 'Высота, мм',
  depth_mm: 'Глубина, мм',
  length_mm: 'Длина, мм',
  size_mm: 'Габарит, мм',
  wall: 'Стена',
  walls: 'Стены',
  ceiling: 'Потолок',
  ceiling_mm: 'Высота потолка, мм',
  floor: 'Пол',
  niche: 'Ниша',
  plinth_mm: 'Цоколь, мм',
  note: 'Примечание',
  notes: 'Примечание',
  data: 'Данные',
  created_at: 'Снят',
  comment: 'Комментарий',
  material: 'Материал',
  decor: 'Декор',
  thickness_mm: 'Толщина, мм',
  doors: 'Двери',
  sections: 'Секции',
  shelves: 'Полки',
};

const HIDDEN = new Set(['id', 'project_id', 'version_id']);

function label(k: string): string {
  return LABEL[k] ?? k.replace(/_/g, ' ');
}

function scalar(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return dt(v);
  return String(v);
}

export function Facts({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (Array.isArray(value)) {
    if (value.every((x) => typeof x !== 'object' || x === null)) return <span>{value.map(scalar).join(' × ')}</span>;
    return (
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {value.map((x, i) => (
          <li key={i}>
            <Facts value={x} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([k, v]) => !HIDDEN.has(k) && v !== null && v !== undefined && v !== '' && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0),
    );
    if (!entries.length) return <span className="muted">—</span>;
    return (
      <dl className="kv">
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{label(k)}</dt>
            <dd>
              <Facts value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{scalar(value)}</span>;
}

export function Photos({ items }: { items: (Attachment | string)[] | undefined | null }) {
  const list = (items ?? []).map((p) => (typeof p === 'string' ? { url: p } : p)).filter((p) => p.url);
  if (!list.length) return <span className="muted">Фото нет</span>;
  return (
    <div className="photos">
      {list.map((p, i) => (
        <AuthImg key={p.id ?? i} url={p.url!} alt={p.name ?? ''} />
      ))}
    </div>
  );
}
