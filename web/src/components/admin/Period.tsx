'use client';

/** Фильтр периода «с — по» с быстрыми кнопками (сводка, финансы, журнал). */
import { daysAgo, isoDay } from '@/lib/admin/format';

export interface Period {
  from: string;
  to: string;
}

export function defaultPeriod(days = 30): Period {
  return { from: daysAgo(days), to: isoDay(new Date()) };
}

function monthStart(): string {
  const d = isoDay(new Date());
  return `${d.slice(0, 8)}01`;
}

export function PeriodFilter({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const today = isoDay(new Date());
  const quick: [string, Period][] = [
    ['Сегодня', { from: today, to: today }],
    ['7 дней', { from: daysAgo(6), to: today }],
    ['30 дней', { from: daysAgo(29), to: today }],
    ['Этот месяц', { from: monthStart(), to: today }],
  ];
  return (
    <div className="toolbar">
      <label className="chk">
        с <input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
      </label>
      <label className="chk">
        по <input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
      </label>
      {quick.map(([label, p]) => (
        <button
          key={label}
          type="button"
          className={`b ${p.from === value.from && p.to === value.to ? 'primary' : ''}`}
          onClick={() => onChange(p)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
