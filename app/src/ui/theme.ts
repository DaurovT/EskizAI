/**
 * Токены дизайн-системы V3 (docs/design, блок /*V3*\/ в любом *.dc.html).
 * Крупные кнопки и шрифт: мастер часто работает одной рукой и на объекте (PRD §14).
 */
import type { TextStyle } from 'react-native';

/** Сырые цвета макета. */
export const palette = {
  ground: '#F2F1EE', // фон страницы; контролы внутри белых контейнеров
  white: '#FFFFFF',
  ink: '#21201F', // основной текст, выбранный chip/opt, фокус поля
  muted: '#6E6B66', // .sub .cap .rs .fl
  muted2: '#55524D', // вторичный текст в диалогах, .st серый
  faint: '#8E8B85', // плейсхолдер, неактивная вкладка, .cta.off
  count: '#9C9993', // .chip .n
  hair: '#F0EFEC', // разделители строк
  chev: '#B4B1AB', // шеврон строки
  off: '#E6E5E1', // .cta.off, фон .seg
  segOnWhite: '#EDECE9', // .seg внутри белого, .av, полоса прогресса
  togOff: '#E1DFDB',
  handle: '#D6D4CF',
  rowPress: '#F7F7F5',
  wood: '#F4EBDD', // .thumb
  green: '#387D50', // .cta, .plus, .tog.on
  greenPress: '#2F6B44', // .cta:hover, .txt, ссылки
  greenDeep: '#275C3A', // текст .st/.tag зелёный, активная вкладка
  greenSoft: '#E6F1EA',
  greenOnDark: '#8FD3A6', // действие в тосте
  amber: '#E08A00',
  amberDeep: '#8A4B00',
  amberSoft: '#FFF0D4',
  blue: '#1F4FBF',
  blueSoft: '#E6EEFF',
  red: '#E5352B', // кнопка «Удалить», точка-бейдж
  redText: '#C62A20', // .txt.red, строка «Выйти»
  redDeep: '#A1221A',
  redSoft: '#FFE7E4',
  scrim: 'rgba(33,32,31,0.42)',
};

export const colors = {
  // --- V3 ---
  ground: palette.ground,
  white: palette.white,
  ink: palette.ink,
  muted2: palette.muted2,
  faint: palette.faint,
  hair: palette.hair,
  chev: palette.chev,
  off: palette.off,
  green: palette.green,
  greenPress: palette.greenPress,
  link: palette.greenPress,
  scrim: palette.scrim,
  // --- прежние имена (экраны до переноса) → палитра V3 ---
  bg: palette.ground,
  card: palette.white,
  text: palette.ink,
  muted: palette.muted,
  border: palette.off,
  primary: palette.green,
  primaryText: palette.white,
  primarySoft: palette.greenSoft,
  danger: palette.redText,
  dangerSoft: palette.redSoft,
  warn: palette.amberDeep,
  warnSoft: palette.amberSoft,
  ok: palette.greenDeep,
  okSoft: palette.greenSoft,
  estimate: palette.amberDeep,
  estimateSoft: palette.amberSoft,
  tg: '#229ED9',
  overlay: palette.scrim,
};

/** Цветовые наборы .st / .tag / .dot: fg — текст, bg — плашка, dot — точка/иконка. */
export type Tone = 'green' | 'amber' | 'blue' | 'red' | 'gray';
export const tones: Record<Tone, { fg: string; bg: string; dot: string }> = {
  green: { fg: palette.greenDeep, bg: palette.greenSoft, dot: palette.green },
  amber: { fg: palette.amberDeep, bg: palette.amberSoft, dot: palette.amber },
  blue: { fg: palette.blue, bg: palette.blueSoft, dot: palette.blue },
  red: { fg: palette.redDeep, bg: palette.redSoft, dot: palette.red },
  gray: { fg: palette.muted2, bg: palette.ground, dot: '#A3A09A' },
};

/** Баннеры .ban: ok / est / info / err / n (белый). */
export type BannerTone = 'ok' | 'est' | 'info' | 'err' | 'n';
export const bannerTones: Record<BannerTone, { fg: string; bg: string }> = {
  ok: { fg: '#1F4A2F', bg: palette.greenSoft },
  est: { fg: '#6E3C00', bg: palette.amberSoft },
  info: { fg: '#1A3F99', bg: palette.blueSoft },
  err: { fg: '#8A1D16', bg: palette.redSoft },
  n: { fg: palette.ink, bg: palette.white },
};

/** Теги .tag: est / info / ok / n / err. */
export type TagTone = 'est' | 'info' | 'ok' | 'n' | 'err';
export const tagTones: Record<TagTone, { fg: string; bg: string }> = {
  est: { fg: palette.amberDeep, bg: palette.amberSoft },
  info: { fg: palette.blue, bg: palette.blueSoft },
  ok: { fg: palette.greenDeep, bg: palette.greenSoft },
  n: { fg: palette.muted2, bg: palette.ground },
  err: { fg: palette.redDeep, bg: palette.redSoft },
};

/** Статусы проекта → цвет плашки .st (по макетам Projects/ProjectCard: Эскиз серый, Отправлен синий, В работе зелёный, Сдан серый). */
export const statusTone: Record<string, Tone> = {
  draft: 'gray',
  sketch: 'gray',
  sent: 'blue',
  measured: 'amber',
  contract: 'amber',
  in_work: 'green',
  delivered: 'gray',
  cancelled: 'red',
  archived: 'gray',
};
export const status: Record<string, { fg: string; bg: string }> = Object.fromEntries(
  Object.entries(statusTone).map(([k, t]) => [k, { fg: tones[t].fg, bg: tones[t].bg }]),
);

/** Шрифт Onest: в RN у каждого начертания своё имя семейства (fontWeight с кастомным шрифтом не используем). */
export const fonts = {
  regular: 'Onest_400Regular',
  medium: 'Onest_500Medium',
  semibold: 'Onest_600SemiBold',
  bold: 'Onest_700Bold',
};
export type Weight = 400 | 500 | 600 | 700;
/** fontWeight (число/строка/'bold') → семейство Onest. 800/900 → Bold. */
export function fontFor(w?: TextStyle['fontWeight'] | Weight): string {
  const n = w === 'bold' ? 700 : w === 'normal' || w == null ? 400 : Number(w);
  if (n >= 700) return fonts.bold;
  if (n >= 600) return fonts.semibold;
  if (n >= 500) return fonts.medium;
  return fonts.regular;
}
const f = (size: number, line: number, w: Weight, extra?: TextStyle): TextStyle => ({ fontFamily: fontFor(w), fontSize: size, lineHeight: line, color: palette.ink, ...extra });
const tnum: TextStyle['fontVariant'] = ['tabular-nums'];

/** Шкала текста V3 (имена = классы CSS). */
export const type = {
  body: f(16, 22, 400),
  big: f(30, 36, 700, { letterSpacing: -0.75 }), // .big — заголовок корневого экрана
  bigPush: f(28, 34, 700, { letterSpacing: -0.7 }), // .big на вложенных экранах
  title: f(22, 28, 700, { letterSpacing: -0.44 }), // .title
  h3: f(18, 24, 700, { letterSpacing: -0.27 }), // заголовок секции внутри .sheet
  ht: f(18, 24, 600), // .ht — заголовок в строке шапки
  sub: f(16, 22, 400, { color: palette.muted }),
  cap: f(14, 19, 400, { color: palette.muted }),
  lbl: f(15, 20, 600, { color: palette.muted }),
  rt: f(16, 21, 500),
  rs: f(14, 19, 400, { color: palette.muted }),
  rv: f(16, 21, 600, { fontVariant: tnum }),
  bigN: f(28, 32, 700, { letterSpacing: -0.56, fontVariant: tnum }), // .big-n — крупная сумма
  num: { fontVariant: tnum } as TextStyle,
  btn: f(17, 22, 600),
  btnSoft: f(17, 22, 500),
  btnSm: f(15, 20, 600),
  txt: f(16, 22, 500, { color: palette.greenPress }),
  chip: f(15, 20, 500),
  sg: f(15, 20, 500),
  st: f(13, 18, 600),
  tag: f(13, 18, 600),
  fl: f(13, 17, 400, { color: palette.muted }),
  fv: f(17, 23, 500),
  nval: f(28, 32, 600, { fontVariant: tnum }),
  bt: f(16, 21, 600),
  bd: f(14, 19, 400),
  nav: f(12, 15, 500),
  toast: f(15, 20, 400, { color: palette.white }),
};

/** Отступы: .body — 8/12/12 и gap 10; строка — 10/20. */
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32, gutter: 12, gap: 10, rowX: 20 };
export const radius = {
  s: 8, m: 12, l: 16, pill: 999,
  tag: 8, st: 9, pm: 12, sm: 14, tile: 14, btn: 16, field: 16, thumb: 16, toast: 18,
  chip: 20, ban: 20, nav: 24, sheet: 28, dlg: 32,
};
/** Прежние размеры (экраны до переноса). */
export const font = { caption: 14, body: 16, bodyL: 17, h2: 22, h1: 30, price: 24 };
/** Минимальная высота касания (кнопки .cta/.soft, поля .fld). */
export const touch = 56;

/** Движение V3 (Motion.dc.html, PRD FR-68). Кривые — cubic-bezier. */
export const motion = {
  press: 120, release: 160, el: 200, screen: 320, sheet: 320, price: 400, out: 200,
  ease: [0.2, 0, 0, 1] as const, // элементы, нажатие
  sheetEase: [0.32, 0.72, 0, 1] as const, // шторка, экран
  exitEase: [0.4, 0, 1, 1] as const, // уход
  toastMs: 4000, undoMs: 6000,
};
