/** Иконки из макета (inline stroke SVG, viewBox 24): добавляйте новые сюда же, по имени. */
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { C } from '@/theme';

type Shape = { d?: string; circle?: [number, number, number]; rect?: [number, number, number, number, number]; fill?: boolean };

const ICONS: Record<string, Shape[]> = {
  back: [{ d: 'M15 6l-6 6 6 6' }],
  chevron: [{ d: 'M9 6l6 6-6 6' }],
  close: [{ d: 'M6 6l12 12M18 6L6 18' }],
  check: [{ d: 'M20 6L9 17l-5-5' }],
  plus: [{ d: 'M12 5v14M5 12h14' }],
  home: [{ d: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' }],
  folder: [{ d: 'M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z' }],
  doc: [{ d: 'M6 3h8l5 5v13H6z' }, { d: 'M14 3v5h5M9 13h6M9 17h6' }],
  file: [{ d: 'M6 3h8l5 5v13H6z' }, { d: 'M14 3v5h5' }],
  more: [{ circle: [5, 12, 1.7], fill: true }, { circle: [12, 12, 1.7], fill: true }, { circle: [19, 12, 1.7], fill: true }],
  search: [{ circle: [11, 11, 7] }, { d: 'M20 20l-3.5-3.5' }],
  send: [{ d: 'M21 4L3 11l7 2 2 7z' }, { d: 'M10 13l5-5' }],
  camera: [{ d: 'M4 8h3l2-3h6l2 3h3v11H4z' }, { circle: [12, 13, 3.5] }],
  gallery: [{ rect: [3, 4, 18, 16, 2] }, { d: 'M3 16l5-5 4 4 3-3 6 6' }],
  clip: [{ d: 'M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.5 3.5 0 0 1 5 5L10.3 18a2 2 0 0 1-2.8-2.8l7.9-7.9' }],
  mic: [{ rect: [9, 3, 6, 11, 3] }, { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }],
  person: [{ circle: [12, 8, 4] }, { d: 'M4 21c1-4 4-6 8-6s7 2 8 6' }],
  pin: [{ d: 'M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z' }, { circle: [12, 9, 2.5] }],
  bell: [{ d: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z' }, { d: 'M10 20.5a2 2 0 0 0 4 0' }],
  share: [{ d: 'M12 15V3M7 8l5-5 5 5' }, { d: 'M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6' }],
  layers: [{ d: 'M12 3l9 5-9 5-9-5z' }, { d: 'M3 13l9 5 9-5' }],
  expand: [{ d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }],
  filter: [{ d: 'M4 6h16M7 12h10M10 18h4' }],
  text: [{ d: 'M4 7h16M4 12h10M4 17h7' }],
  window: [{ rect: [4, 3, 16, 18, 1.5] }, { d: 'M12 3v18M4 12h16' }],
  ruler: [{ d: 'M3 17L17 3l4 4L7 21z' }, { d: 'M7 13l2 2M10 10l2 2M13 7l2 2' }],
  undo: [{ d: 'M9 14L4 9l5-5' }, { d: 'M4 9h11a5 5 0 0 1 0 10h-3' }],
  redo: [{ d: 'M15 14l5-5-5-5' }, { d: 'M20 9H9a5 5 0 0 0 0 10h3' }],
  mirror: [{ d: 'M12 3v18' }, { d: 'M8 7L3 12l5 5V7zM16 7l5 5-5 5V7z' }],
  warn: [{ d: 'M12 3l10 18H2z' }, { d: 'M12 10v4M12 17.5v.5' }],
  cloud_off: [{ d: 'M3 3l18 18' }, { d: 'M8 8a5 5 0 0 0-1 9.5h10.5M12.5 6.2A5 5 0 0 1 18 10a4 4 0 0 1 2.5 6.8' }],
  sync: [{ d: 'M20 11a8 8 0 0 0-14.5-4.5L4 8M4 13a8 8 0 0 0 14.5 4.5L20 16' }, { d: 'M4 4v4h4M20 20v-4h-4' }],
  phone: [{ d: 'M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2z' }],
  link: [{ d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1' }, { d: 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }],
  calc: [{ rect: [5, 3, 14, 18, 2] }, { d: 'M8 7h8M8 11h2M12 11h2M16 11v6M8 15h2M12 15h2' }],
  telegram: [{ d: 'M21 4L3 11l6 2 2 6 3-4 5 4z' }, { d: 'M9 13l8-6' }],
  globe: [{ circle: [12, 12, 9] }, { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }],
  cube: [{ d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z' }, { d: 'M4 7.5L12 12l8-4.5M12 12v9' }],
  copy: [{ rect: [8, 8, 12, 12, 2] }, { d: 'M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8' }],
  grid: [{ rect: [4, 4, 7, 7, 1.5] }, { rect: [13, 4, 7, 7, 1.5] }, { rect: [4, 13, 7, 7, 1.5] }, { rect: [13, 13, 7, 7, 1.5] }],
  split: [{ rect: [4, 4, 16, 16, 1.5] }, { d: 'M12 4v16' }],
  chevron_down: [{ d: 'M6 9l6 6 6-6' }],
  inbox: [{ d: 'M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5' }, { d: 'M4 13.5L6.5 5h11l2.5 8.5h-4.5a3.5 3.5 0 0 1-7 0z' }],
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22, color = C.ink, stroke = 2.2 }: { name: IconName; size?: number; color?: string; stroke?: number }) {
  const shapes = ICONS[name] ?? [];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {shapes.map((s, i) =>
        s.d ? <Path key={i} d={s.d} /> :
        s.circle ? <Circle key={i} cx={s.circle[0]} cy={s.circle[1]} r={s.circle[2]} fill={s.fill ? color : 'none'} stroke={s.fill ? 'none' : color} /> :
        s.rect ? <Rect key={i} x={s.rect[0]} y={s.rect[1]} width={s.rect[2]} height={s.rect[3]} rx={s.rect[4]} /> : null,
      )}
    </Svg>
  );
}

