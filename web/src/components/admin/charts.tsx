'use client';

/**
 * Лёгкие графики админки — inline SVG без библиотек. Одна величина на график (одна ось),
 * столбики по дням с подсказкой при наведении, тонкая сетка, подписи — цветом текста.
 * Цвета берутся из переменных admin.css (--a-accent и т. п.), поэтому следуют теме админки.
 */
import { useEffect, useRef, useState } from 'react';
import { dayLabel } from '@/lib/admin/insights';

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** «Красивый» верх шкалы: 1, 2, 2.5, 5 × 10^n. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export interface DayPoint {
  date: string;
  value: number;
}

export function DayBars({
  data,
  format,
  axisFormat,
  height = 150,
  label,
}: {
  data: DayPoint[];
  /** Значение в подсказке. */
  format: (v: number) => string;
  /** Подписи шкалы (короче). */
  axisFormat?: (v: number) => string;
  height?: number;
  /** Для чтения с экрана: что показывает график. */
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const padL = 44;
  const padR = 6;
  const padT = 8;
  const padB = 20;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padT - padB;
  const n = Math.max(1, data.length);
  const slot = plotW / n;
  const gap = n > 60 ? 1 : 2;
  const barW = Math.max(1, Math.min(28, slot - gap));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const fmtAxis = axisFormat ?? format;
  // Подписи дат: первая, последняя и равномерно между ними (не больше ~6)
  const every = Math.max(1, Math.ceil(n / 6));
  const empty = data.every((d) => !d.value);

  return (
    <div ref={ref} className="chart" role="img" aria-label={label}>
      {width > 0 && (
        <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} className="grid" />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="axis">
                {fmtAxis(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = padL + i * slot + (slot - barW) / 2;
            const h = Math.max(d.value > 0 ? 2 : 0, plotH - (y(d.value) - padT));
            const r = Math.min(4, barW / 2, h);
            const top = padT + plotH - h;
            return (
              <g key={d.date} onMouseEnter={() => setHover(i)}>
                {/* зона наведения — шире столбика */}
                <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent" />
                {h > 0 && (
                  <path
                    className={`bar ${hover === i ? 'on' : ''}`}
                    d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`}
                  />
                )}
                {(i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2) && (
                  <text x={padL + i * slot + slot / 2} y={height - 5} textAnchor="middle" className="axis">
                    {dayLabel(d.date)}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} className="base" />
        </svg>
      )}
      {empty && width > 0 && <div className="chart-empty">Нет данных за период</div>}
      {hover !== null && data[hover] && width > 0 && (
        <div
          className="chart-tip"
          style={{
            left: Math.min(Math.max(padL + hover * slot + slot / 2, 60), width - 60),
            top: Math.max(0, y(data[hover].value) - 44),
          }}
        >
          <div className="muted">{dayLabel(data[hover].date)}</div>
          <b>{format(data[hover].value)}</b>
        </div>
      )}
    </div>
  );
}

/** Горизонтальная полоса доли (топ цехов, статусы). */
export function Meter({ value, max, tone }: { value: number; max: number; tone?: 'warn' | 'bad' }) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <div className="meter" aria-hidden>
      <div className={tone ?? ''} style={{ width: `${pct}%` }} />
    </div>
  );
}
