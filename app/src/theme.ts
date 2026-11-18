/** Дизайн-токены по макету «Eskiz Oyna — экраны приложения» (docs/design/*.dc.html: «V3 · Mebel base, Oyna = голубой»). */
export const C = {
  bg: '#F2F1EE', // фон экрана
  card: '#FFFFFF',
  ink: '#21201F', // основной текст
  muted: '#6E6B66', // вторичный текст
  faint: '#8E8B85', // подписи, неактивное
  line: '#F0EFEC', // разделители в списках
  seg: '#E6E5E1', // подложка сегментов
  soft: '#F2F1EE', // плашки внутри белых карточек
  accent: '#1E6FD9', // голубой Oyna (.cta, .fld.focus, .tog.on, .prog .d)
  accentSoft: '#E3EEFC', // .ban.info, .tag.info
  accentMid: '#A8C8F0', // .prog .c — текущий шаг
  navOn: '#E3EEFC',
  navOnIcon: '#154A99',
  accentText: '#185BB8', // ссылки, .txt
  accentDeep: '#154A99',
  ctaText: '#0F2E5C', // текст на «стеклянной» голубой кнопке
  badge: '#E5352B',
  dark: '#21201F',
  danger: '#C62A20',
  dangerBg: '#FFF5F4', // .fld.err
  dangerLine: '#E5352B',
  errBg: '#FFE7E4', errFg: '#8A1D16', // .ban.err
  estBg: '#FFF0D4', estFg: '#6E3C00', estLine: '#F3CF8F', estField: '#FFF9EE', // .ban.est, .fld.est
  okBg: '#E6F1EA', okFg: '#1F4A2F',
  ok: '#387D50',
  amber: '#E08A00',
  gray: '#A3A09A',
  heroMuted: '#B4B1AB',
  keypad: '#E4E2DE', keyFn: '#D2D0CB',
  canvas: '#ECEBE7', canvasDot: '#D5D3CE', // .cv — поле схемы
  dim: '#1F4FBF', // .dim — размерные плашки
  scrim: 'rgba(33,32,31,0.42)',
} as const;

/** Статус заказа — тонированная плашка (.st c-*): фон и текст. */
export const STATUS_BADGE: Record<string, { bg: string; fg: string }> = {
  measure: { bg: '#F2F1EE', fg: '#55524D' },
  quoted: { bg: '#E3EEFC', fg: '#154A99' },
  agreed: { bg: '#E6F1EA', fg: '#275C3A' },
  production: { bg: '#FFF0D4', fg: '#8A4B00' },
  ready: { bg: '#E6F1EA', fg: '#275C3A' },
  installed: { bg: '#E6F1EA', fg: '#275C3A' },
  closed: { bg: '#F2F1EE', fg: '#55524D' },
  cancelled: { bg: '#FFE7E4', fg: '#A1221A' },
};
export const STATUS_DOT: Record<string, string> = {
  measure: C.gray, quoted: C.accent, agreed: C.ok, production: C.amber, ready: C.ok, installed: C.ok, closed: C.gray, cancelled: C.dangerLine,
};

/** Тег (.tag): est / info / ok / n / err */
export const TAG: Record<string, { bg: string; fg: string }> = {
  est: { bg: '#FFF0D4', fg: '#8A4B00' }, info: { bg: '#E3EEFC', fg: '#154A99' }, ok: { bg: '#E6F1EA', fg: '#275C3A' },
  n: { bg: '#F2F1EE', fg: '#55524D' }, err: { bg: '#FFE7E4', fg: '#A1221A' },
};

export const F = {
  regular: 'Onest_400Regular',
  medium: 'Onest_500Medium',
  semibold: 'Onest_600SemiBold',
  bold: 'Onest_700Bold',
} as const;

export const R = { list: 28, button: 16, field: 16, chip: 20, sheet: 28, icon: 22 } as const;
