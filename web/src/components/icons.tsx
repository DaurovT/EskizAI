/** Иконки из макетов (stroke, 24×24). */

type P = { size?: number; sw?: number };

const base = (size: number, sw: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: sw,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function IconPhone({ size = 20, sw = 2.1 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2z" />
    </svg>
  );
}

export function IconTelegram({ size = 20, sw = 2.1 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M20 5L3.5 11.5l5 1.8L18 7.5l-7.5 7v4.5l3-3 4 3z" />
    </svg>
  );
}

export function IconCube({ size = 20, sw = 2.2 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5L12 12l8-4.5M12 12v9" />
    </svg>
  );
}

export function IconCamera({ size = 20, sw = 2.2 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2L9.5 5h5l1.8 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function IconCheck({ size = 20, sw = 2.8 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

export function IconInfo({ size = 20, sw = 2.1 }: P) {
  return (
    <svg {...base(size, sw)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8v.5" />
    </svg>
  );
}

export function IconClock({ size = 22, sw = 2.2 }: P) {
  return (
    <svg {...base(size, sw)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function IconLock({ size = 22, sw = 2.2 }: P) {
  return (
    <svg {...base(size, sw)}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </svg>
  );
}

export function IconSearch({ size = 22, sw = 2.2 }: P) {
  return (
    <svg {...base(size, sw)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}

/** Знак Eskiz AI (как в макете ClientExpired). */
export function EskizMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="26" fill="#387D50" />
      <path d="M79.2 78.5 L66.2 86.0 L66.2 44.9 L79.2 37.4Z" fill="#fff" opacity="0.55" />
      <path d="M38.7 14.0 L79.2 37.4 L66.2 44.9 L25.7 21.5Z" fill="#fff" opacity="0.85" />
      <g fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.8 59.8 L66.2 86.0" />
        <path d="M25.7 67.1 L25.7 21.5" />
        <path d="M46.0 74.3 L46.0 33.2" />
      </g>
    </svg>
  );
}
