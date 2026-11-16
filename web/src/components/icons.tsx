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

export function IconDoor({ size = 20, sw = 2.1 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M6 20V4.5A.5.5 0 0 1 6.5 4H14l4 2v14" />
      <path d="M4 20h16M14 4v16" />
      <path d="M11 12.5v.5" />
    </svg>
  );
}

export function IconRuler({ size = 20, sw = 2.1 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M3.5 15.5l12-12 5 5-12 12z" />
      <path d="M7.5 11.5l2 2M10.5 8.5l2 2M13.5 5.5l2 2" />
    </svg>
  );
}

export function IconExpand({ size = 20, sw = 2.2 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M4.5 9.5v-5h5M19.5 9.5v-5h-5M4.5 14.5v5h5M19.5 14.5v5h-5" />
    </svg>
  );
}

export function IconClose({ size = 22, sw = 2.3 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export function IconRotate({ size = 22, sw = 2.1 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M3.5 12a8.5 4 0 0 0 15.6 2.2" />
      <path d="M20.5 12a8.5 4 0 0 0-15.6-2.2" />
      <path d="M17.2 16.7l1.9-2.5 2.6 1.6M6.8 7.3 4.9 9.8 2.3 8.2" />
    </svg>
  );
}

export function IconEdit({ size = 18, sw = 2.1 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5z" />
      <path d="M14 7l3 3" />
    </svg>
  );
}

export function IconChevron({ size = 20, sw = 2.2 }: P) {
  return (
    <svg {...base(size, sw)}>
      <path d="M9.5 6l6 6-6 6" />
    </svg>
  );
}

/** Знак Eskiz Mebel (семейство Eskiz: шкаф на зелёной плитке, макет Logo.dc.html). */
export function EskizMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 140 140" aria-hidden="true">
      <rect width="140" height="140" rx="31" fill="#387D50" />
      <g transform="translate(26 26) scale(1.8333)" fill="none" stroke="#fff" strokeWidth={size < 40 ? 3.4 : 2.6}
        strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 40V13h24v27" />
        <path d="M24 13v27" />
        <path d="M20 24v5M28 24v5" />
        <path d="M12 34h24" opacity=".55" />
        <path d="M4 40h40" />
        <circle cx="41" cy="8" r="2.6" fill="#fff" stroke="none" />
      </g>
    </svg>
  );
}
