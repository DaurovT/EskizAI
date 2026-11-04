# UI-кит V3 — каталог

Источник правды — макеты `docs/design/*.dc.html` и общий CSS-блок `/*V3*/ … /*/V3*/` в начале любого из них.
Всё импортируется из `src/ui/kit` (кит реэкспортирует `base.tsx` и `overlays.tsx`). Токены — `src/ui/theme.ts`.

```tsx
import { Screen, Card, Group, ListItem, Button, Field, T, toast } from '../src/ui/kit';
import { palette, type as ty, space, radius, tones } from '../src/ui/theme';
```

## Правила, которые кит соблюдает сам

- **Шрифт Onest.** Грузится в `app/_layout.tsx` (заставка держится до загрузки, максимум 4 с). У каждого начертания своё семейство:
  `fonts.regular/medium/semibold/bold` = `Onest_400Regular/500Medium/600SemiBold/700Bold`.
  `T` и все компоненты кита сами переводят `fontWeight` в семейство. **Сырые `<Text>`/`<TextInput>` шрифт не получат** — используйте `T`
  или `style={resolveFont([ty.rt, { fontWeight: '600' }])}` (`resolveFont` убирает `fontWeight` и ставит нужное семейство).
- **Табличные цифры** — `<T num>` или `ty.num` (`fontVariant: ['tabular-nums']`); `rv`, `bigN`, `nval` уже с ними.
- **«Внутри белого — серое».** `SurfaceProvider` (контекст `'ground' | 'white'`). `Card`, `Group`, `Sheet variant="white"`, `Dialog`,
  `Footer bar`, `Banner tone="n"` ставят `'white'`; `Button secondary/tg`, `IconButton`, `Chip`, `Option`, `Field`, `NumberField`, `Search`, `Tile`
  читают его через `useControlBg()` (белый `#FFF` на фоне `#F2F1EE`, серый `#F2F1EE` внутри белого), `Segmented` — `#E6E5E1` → `#EDECE9`.
  Для своих контролов: `const bg = useControlBg();`.
- **Нажатие** (`Press`): scale 0.97 + затемнение 6 % за 120 мс (отпускание 160 мс), кривая (.2,0,0,1). Строки — подсветка, `.txt` и вкладки — прозрачность 0.6.
  При системном «уменьшить движение» (`useReduceMotion()`) сжатия нет, шторка/тост/окно только меняют прозрачность.
- **Вибрация** — `haptics.light/selection/success/warning/error` (`src/ui/haptics.ts`, без нативного модуля молча ничего не делает).
  Уже вызывается: `Toggle` (light), `Segmented` (selection), закрытие шторки свайпом (light), `toast.show({ tone: 'success'|'error' })`,
  `Button haptic="success"|"error"|"light"`. По спецификации: success — оплата и заказ, error — неверный код.

## Шапки и навигация

Нативная шапка стека заменена на шапку V3 (`src/ui/navigation.tsx`, подключена в `screenOptions.header` корневого `Stack`).
Экраны **по-прежнему** задают шапку через `<Stack.Screen options={…} />`:

| option | результат |
|---|---|
| `title` / `headerTitle` (строка) | большой заголовок `.big` 28/34 под строкой шапки (`''` — без заголовка) |
| — (есть куда вернуться) | круглая кнопка «назад» `.ib` (chevron-back 22) слева; в `presentation: 'modal'` — «закрыть» (×) |
| `headerBackVisible: false` | без «назад» (онбординг цеха) |
| `headerLeft: () => node` | своё содержимое вместо «назад» (аватар цеха, логотип) |
| `headerRight: () => node` | правый слот (`IconButton`, `Button small v="secondary"`, `Badge`, `Segmented`) |
| `headerLargeTitle: false` | заголовок в строке шапки `.ht` 18/600 (редактор) |
| `headerShown: false` | без шапки — рисуйте сами: `<Screen header={<Header … topInset={insets.top} />} edges={['top','bottom']}>` или `edges={['top']}` |
| `header: (p) => <StackHeader14 {...p} />` | макеты с `.hdr` padding-top 14 (Recognition, TypeChoice, Clarify, TextParse): «назад» на 20, `headerRight`, `title` — большой 30/36 |

Переходы: iOS — системный push (параллакс 30 %, свайп от края = назад), Android — `slide_from_right`; `gestureEnabled: true`.

Вкладки (`app/(tabs)/_layout.tsx`): `TabHeader` — большой заголовок 30/36 из `headerTitle ?? title`; `headerLeft/headerRight` вкладки дают строку над ним
(как аватар «МП» и колокольчик в Projects.dc.html). `TabBar` — `.nav`: белая, r24 сверху, 84 с безопасной зоной; активная — зелёная «таблетка» `#E6F1EA`
под иконкой, подпись 12/500; центр — `.plus` 52×44 r16 → `/project/new`. Для своей шапки вкладки — `options={{ headerShown: false }}`.

### `Header` (`.hdr` + `.big`)
`back?: boolean` · `onBack?` · `backIcon?: 'back' | 'close'` · `backLabel?` · `title?` (.ht в строке) · `left?` · `right?` ·
`big?: string` · `bigSize?: 'root' | 'push'` (30/36 или 28/34) · `sub?` · `topInset?` · `style?`.
Строка: gap 10, отступы 12/12/4, мин. 72 (= min-height 56 по содержимому в CSS). Без кнопок и `title` строка не рисуется (только отступ 14).

### `BigTitle` (`.big` в теле экрана)
`children` · `sub?` (.sub, отступ 6) · `size?: 'root' | 'push'` (по умолчанию root 30/36) · `inset?` (по умолчанию 8 — как `padding:0 8px` в `.body`).
```tsx
<BigTitle sub="Фото, описание или и то и другое">Новый проект</BigTitle>
```

## Раскладка

### `Screen` (`.app` + `.body` + `.foot`)
`children` · `scroll = true` · `footer?: node` · `footerBar?: boolean` (`.foot.bar` — белый, r28 сверху, контролы серые) ·
`edges = ['bottom']` (добавьте `'top'`, если шапки нет) · `padded = true` (отступы 8/12/12) · `gap = 10` (между детьми — как `.body`) ·
`header?: node` · `refreshControl?` · `contentStyle?` · `style?` · `footerStyle?` (свои отступы/gap футера, напр. `{ gap: 2, paddingTop: 6 }`).
Фон `#F2F1EE`, офлайн-плашка сверху, клавиатура не перекрывает поля. С футером нижнюю безопасную зону берёт футер.
```tsx
<Screen footerBar footer={<><T v="cap">Клиенту до замера</T><ButtonRow><Button v="secondary" icon="resize-outline" title="Замер" /><Button title="Отправить клиенту" style={{ flex: 1 }} /></ButtonRow></>}>
```
`Gap` (`h = 12`) по-прежнему есть, но при `gap = 10` обычно не нужен.

### `Footer` (`.foot` / `.foot.bar`)
`children` · `bar?` · `style?`. Для экранов без `Screen` (редактор). Отступы 10/12 + safe area (мин. 16), gap 8.

### `ButtonRow` (`.fr`) — ряд кнопок, gap 8; кнопкам `style={{ flex: 1 }}`.
### `Row` — `children, style?, gap = 8` (row + center). `Grow` — растяжка (`.grow`). `Hairline` — линия `.hair` #F0EFEC.

## Карточки и строки

### `Card` (`.sheet`)
`children` · `onPress?` (сжатие при нажатии, как `a.sheet`) · `padded = true` (16/20) · `style?` · `accessibilityLabel?`.
Белая, r28, без рамки и без внешнего отступа (расстояние даёт `gap` экрана). `padded={false}` — для строк/картинок во всю ширину.
Внутри `padded` карточки `ListItem` идёт без горизонтального отступа.

### `Group` (`.sheet` со строками `.row+.row`)
`children` · `style?`. Белая r28, между дочерними `ListItem`/`MenuItem` — волосяная линия. Строки с отступом 20.
```tsx
<Group>
  <ListItem compact icon="storefront-outline" title="Данные цеха" onPress={…} />
  <ListItem compact icon="pricetag-outline" title="Цены и смета" value="работа 50 %" valueMuted onPress={…} />
  <ListItem compact icon="log-out-outline" title="Выйти" danger onPress={…} chevron={false} />
</Group>
```

### `SectionTitle` (`.sh` 19/24 bold, отступ 8) — `children`, `right?`, `style?`.

### `ListItem` (`.row`)
`title` (.rt 16/500) · `subtitle?` (.rs 14) · `icon?` → плитка `.tile` 44 r14 (compact — 36 r12) · `left?` (Thumb/Avatar вместо плитки) ·
`value?` (.rv 16/600 tnum; с `valueMuted` — серое .vv 15) · `right?` · `onPress?` (подсветка #F7F7F5) ·
`chevron?` (по умолчанию: есть `onPress` и нет `right`; шеврон 18 #B4B1AB) · `danger?` (красный текст и плитка) ·
`compact?` (мин. 50) · `numberOfLines?` · `disabled?` · `children?` (под подписью: статус, подсказка) · `style?`.
Мин. высота 60, отступы 10/20, gap 14.
```tsx
<ListItem left={<Thumb icon="file-tray-stacked-outline" />} title="Шкаф-купе" subtitle="Азиз Каримов" value="9,2–10,5 млн" onPress={…}>
  <Row style={{ marginTop: 6 }}><StatusBadge status="sent" /><T v="cap" color={tones.green.fg}>открыл 2 раза</T></Row>
</ListItem>
```

### `MenuItem` (`.mi`, для меню в шторке) — `icon?`, `title`, `onPress?`, `red?`, `disabled?`. Мин. 58, отступ 20. Кладите в `Group`.

## Кнопки

### `Button`
`title` · `onPress?` · `v?: 'primary' | 'secondary' | 'ghost' | 'ghostDanger' | 'danger' | 'tg'` · `icon?` · `iconRight?` · `small?` · `value?` ·
`loading?` · `disabled?` · `haptic?` · `style?` · `accessibilityLabel?` · `numberOfLines = 2`.

| v | CSS | вид |
|---|---|---|
| primary | `.cta` | зелёная #387D50, h56 r16, 17/600, белый текст |
| secondary | `.soft` | белая (серая внутри белого), 17/500 |
| ghost | `.txt` | текст #2F6B44 16/500, мин. 44 |
| ghostDanger | `.txt.red` | текст #C62A20 |
| danger | `.red` (DeleteAccount, Misc) | красная #E5352B, белый текст |
| tg | `.soft` + самолётик | иконка Telegram #229ED9 (по умолчанию `paper-plane-outline`) |

`small` — `.sm`: h44 r14 15/600. `value` — `.cta.val`: заголовок слева, значение справа в плашке rgba(255,255,255,.16) h40 r12.
`loading` — спиннер по центру, текст скрыт (ширина не меняется), повторный тап заблокирован. `disabled` у primary/danger — `.cta.off`
(#E6E5E1 / #8E8B85), у остальных — прозрачность 0.45. Ширина: в колонке растягивается, в `ButtonRow` — `style={{ flex: 1 }}`.
```tsx
<Button title="Собрать модель" value="осталось 2" icon="sparkles" onPress={start} loading={busy} />
<Button v="ghost" title="Без фото, только по описанию" onPress={…} />
```

### `IconButton` (`.ib`)
`icon?` · `label` (a11y, обязателен) · `onPress?` · `disabled?` · `color?` · `flat?` (`.ib.flat` прозрачная) · `badge?` (красная точка, как у колокольчика) ·
`dark?` (чёрная, белая иконка/текст — аватар цеха) · `size = 44` · `iconSize = 22` · `children?` (вместо иконки, например инициалы «МП») · `style?`.

### `Press` — база для своих нажимаемых блоков (`.svc`, плитки): `feedback?: 'scale' | 'row' | 'opacity' | 'none'` + все пропы `Pressable`.

## Поля

### `Field` (`.fld`) — `forwardRef<TextInputInstance>`
Все пропы `TextInput` + `label?` (`.fl` 13 внутри поля) · `error?` (рамка 2 px #E5352B, фон #FFF5F4, текст ошибки под полем) ·
`estimate?` (`.fld.est`: рамка #F3CF8F, фон #FFF9EE, метка «оценка») · `hint?` (под полем) · `right?` (единица/иконка внутри) · `containerStyle?`.
Значение 17/500, плейсхолдер #8E8B85, фокус — рамка 2 px #21201F на белом. Тап по подписи фокусирует поле. `multiline` — мин. 112.
Внешнего отступа нет (раньше был `marginBottom: 12`) — расстояние даёт `gap` экрана/шторки.

### `NumberField` (`src/ui/NumberField.tsx`, `.fld` + `.numf`)
`label` · `value: number | null` · `step = 10` · `min` · `max` · `unit?` · `estimated?` (рамка `.est` + «оценка»; тап по метке → `onConfirm`) ·
`onChange` · `onConfirm?` · `disabled?` · `nullable?` · `highlight?` (рамка фокуса). Кнопки `.pm` 40×40 r12 («−10/+10» при коротком шаге, иначе «−/+»),
значение 28/600 tnum по центру. `marginBottom: 8` оставлен для старых списков.

### `Search` (`.search`) — `value`, `onChangeText`, `placeholder?`, `autoFocus?`, `onSubmitEditing?`, `style?`. h48 r16, лупа, крестик очистки.

## Выбор

### `Chip` (`.chip`) — `label` · `selected?` (чёрный #21201F, белый текст) · `onPress?` · `icon?` · `count?` (`.n` серым) · `tone?: 'warn'` · `disabled?` · `style?`. h40 r20, 15/500.
### `ChipRow` (`.chips`) — горизонтальная прокрутка чипов во всю ширину экрана (компенсирует отступ 12).
```tsx
<ChipRow>{FILTERS.map((f) => <Chip key={f} label={label(f)} count={counts[f]} selected={f === filter} onPress={() => setFilter(f)} />)}</ChipRow>
```
### `Option` (`.opt`) — `title` · `subtitle?` · `selected?` (чёрный) · `onPress?` · `icon?` · `right?` · `disabled?` · `style?`. Мин. 56 r16, 16/500.
### `Segmented` (`.seg/.sg`) — `value` · `options: { value, label }[]` · `onChange` · `style?`. Фон #E6E5E1 r14 p3, сегмент h40 r11; выбранный белый с тенью.
### `Toggle` (`.tog`) — `value` · `onValueChange?` · `disabled?` · `accessibilityLabel?`. 51×31, зелёный во включённом, бегунок 200 мс. Вместо RN `Switch`.

## Метки и баннеры

| компонент | CSS | пропы |
|---|---|---|
| `Badge` | `.st` h26 r9 13/600 | `label`, `tone?: 'green' \| 'amber' \| 'blue' \| 'red' \| 'gray'` (по умолчанию gray) или `fg?/bg?`, `style?` |
| `StatusBadge` | `.st` | `status`, `archived?` — цвет из `theme.statusTone` |
| `Tag` | `.tag` h24 r8 13/600 | `label`, `tone?: 'est' \| 'info' \| 'ok' \| 'n' \| 'err'`, `icon?` |
| `EstimateBadge` | `.tag.est` | «оценка» |
| `Dot` | `.dot` 8 px | `tone?`, `size?` |
| `Banner` | `.ban` r20 | `tone?: 'ok' \| 'est' \| 'info' \| 'err' \| 'n'`, `title?` (.bt 16/600), `text?` (.bd 14), `icon?`, `action?: { label, onPress }` (.ba справа), `onPress?`, `children?` |

Статусы проекта (`statusTone`): draft, sketch — gray («Эскиз» серый в Projects); sent — blue («Отправлен»); measured, contract — amber
(ждут действия мастера); in_work — green («В работе»); delivered — gray («Сдан»); cancelled — red.
Цвета: `tones[t] = { fg, bg, dot }`, баннеры `bannerTones`, теги `tagTones`.

## Картинки
- `Tile` (`.tile`) — `icon?`, `size?: 's' | 'm'` (36 r12 / 44 r14), `danger?`, `color?`, `bg?`, `children?`. Серая на белом, белая на фоне.
- `Thumb` (`.thumb`) — `uri?` (фото cover), `icon?`, `size = 56`, `children?`. r16, «дерево» #F4EBDD.
- `Avatar` (`.av`) — `name?` (инициалы из 2 слов), `uri?`, `size = 44`, `dark?` (чёрный, как «МП»).

## Оверлеи

### `Sheet` (`.bs`) — нижняя шторка
`visible` · `onClose` · `title?` (.title 22) · `children` · `variant?: 'white' | 'gray'` (по умолчанию white = `.bs.white`: формы, контролы серые;
gray = `.bs`: меню из белых `Group`) · `footer?` (закреплённые кнопки) · `scroll = true` · `contentStyle?`.
Ручка 40×5, фон rgba(33,32,31,.42) за 200 мс, выезд 320 мс (.32,.72,0,1), уход 240 мс; закрытие — тап по фону, «назад» Android, свайп вниз по ручке/заголовку
(> 120 px или быстрее 0.5 px/мс). Дети идут с gap 8.
```tsx
<Sheet variant="gray" visible={menu} onClose={() => setMenu(false)}>
  <Group><MenuItem icon="copy-outline" title="Дублировать" onPress={dup} /><MenuItem icon="archive-outline" title="В архив" onPress={arch} /></Group>
  <Group><MenuItem icon="trash-outline" title="Удалить" red onPress={del} /></Group>
  <Button v="secondary" title={t('close')} onPress={() => setMenu(false)} />
</Sheet>
```

### `Dialog` (`.dlg`) — окно подтверждения
`visible` · `onClose` · `title` · `text?` (.sub #55524D) · `children?` · `actions?` (свой ряд кнопок) или `confirmLabel?`/`cancelLabel?`/`onConfirm?`/`destructive?`/`loading?`.
Белая r32, отступы 24/20/20, gap 12; появление — прозрачность и масштаб 0.96 → 1 за 200 мс.
Императивно: `if (await dialog.confirm({ title, text, confirmLabel: 'Удалить', cancelLabel: 'В архив', destructive: true })) …`
(хост `<DialogHost/>` уже в корневом `_layout`; не вызывайте при открытой `Sheet` — сначала закройте её). `ui/dialogs.ts → confirm()` пока на системном `Alert`.

### `toast` (`.toast`)
`toast.show('Сохранено')` или `toast.show({ text, action?: { label: 'Отменить', onPress }, tone?: 'default' | 'success' | 'error', duration?, icon?, bottom? })`, `toast.hide()`.
Тёмный r18, действие зелёным #8FD3A6; живёт 4 с, с действием 6 с; снизу на 16 px за 200 мс. По умолчанию на 96 над безопасной зоной (над таб-баром/футером).
Хост `<ToastHost/>` — в корневом `_layout`. Под открытым `Modal` (шторка) не виден.

## Состояния
- `Loading` — `label?`, `delay = 300` (спиннер появляется, только если ждём дольше 300 мс).
- `Skeleton` — `width?`, `height = 16`, `r = 12`, `style?`; пульсирует #ECEBE7 (без анимации при «уменьшить движение»). `SkeletonList` — `rows = 3`.
- `EmptyState` (Errors.dc.html) — `icon?`, `title` (30/36; `compact` — 22), `text?` (16/24 #55524D), `tone?` (плитка 76 r26: gray / amber / blue / red), `note?` (зелёный баннер),
  `actions?` (колонка gap 8: `.cta`, `.soft`, `.txt`), `align?: 'start' | 'center'` (по умолчанию слева, как в макете).
- `ErrorState` — `error`, `onRetry?`: причина из `errorInfo`, цвет плитки по виду ошибки, «Повторить» (cta) и «Поддержка» (txt).
- `ErrorScreen` (`ui/ErrorState`) — SCR-28 на весь экран: `icon`, `tone`, `title`, `text?`, `note?` (зелёная заметка), `primary/secondary/ghost?: { title, onPress }` — выходы в футере (.cta/.soft/.txt).
- `PhotoBoxes` / `Pin` (`ui/PhotoBoxes`) — фото r28 с рамками предметов (кольцо выбранного, метки с номером), `height`, `tint`; `Pin` — метка `.pin` (`dot`, `q` янтарная, `n` номер).
- `OfflineBanner` — тёмная плашка r16 «Нет сети — показываем сохранённое» (уже внутри `Screen`); в демо-режиме — янтарная строка.
- `StatusRibbon` — шаг проекта: название 18/700, «3 / 7», полоса сегментов (пройденные #387D50, текущий #A9CDB5, остальные #E6E5E1).

## Текст — `T`
`v?` · `style?` · `numberOfLines?` · `num?` (tnum) · `center?` · `color?` · `selectable?` · `onPress?`.

| v | размер | | v | размер |
|---|---|---|---|---|
| `big` | 30/36 700 | | `rt` | 16/21 500 (заголовок строки) |
| `bigPush` | 28/34 700 | | `rs` | 14/19 400 серый (подпись строки) |
| `title` | 22/28 700 | | `rv` | 16/21 600 tnum (значение) |
| `h3` | 18/24 700 | | `bigN` | 28/32 700 tnum (крупная сумма) |
| `ht` | 18/24 600 | | `fl` / `fv` | 13/17 серый / 17/23 500 (поле) |
| `body` | 16/22 400 | | `bt` / `bd` | 16/21 600 / 14/19 (баннер) |
| `sub` | 16/22 серый | | `link` | 16/22 500 #2F6B44 |
| `cap` | 14/19 серый | | `lbl` | 15/20 600 серый |

Прежние варианты работают: `h1`→big, `h2`→title, `bodyL`→17/23, `caption`→cap, `muted`→sub, `price`→24/30 700 tnum, `label`→lbl (без капса).
`style={{ fontWeight: '600' }}` у `T` превращается в Onest SemiBold.

## Токены (`theme.ts`)
- `palette` — сырые цвета макета: `ground #F2F1EE`, `ink #21201F`, `muted #6E6B66`, `muted2 #55524D`, `faint #8E8B85`, `hair #F0EFEC`, `chev #B4B1AB`,
  `off #E6E5E1`, `segOnWhite #EDECE9`, `green #387D50`, `greenPress #2F6B44`, `greenDeep #275C3A`, `greenSoft #E6F1EA`, `amber*`, `blue*`, `red #E5352B`,
  `redText #C62A20`, `redDeep #A1221A`, `redSoft #FFE7E4`, `wood #F4EBDD`, `scrim`.
- `colors` — прежние имена, переведённые на V3 (`primary` = зелёный, `bg` = ground, `danger` = #C62A20, `warn/estimate` = янтарный и т. д.) + новые (`ground`, `hair`, `chev`, `link`…).
- `type` — стили текста по классам CSS (с `fontFamily`): `big bigPush title h3 ht sub cap lbl rt rs rv bigN num btn btnSoft btnSm txt chip sg st tag fl fv nval bt bd nav toast`.
- `space` — `xs 4, s 8, m 12, l 16, xl 24, xxl 32, gutter 12, gap 10, rowX 20`.
- `radius` — `tag 8, st 9, pm 12, sm 14, tile 14, btn 16, field 16, thumb 16, toast 18, chip 20, ban 20, nav 24, sheet 28, dlg 32` (+ прежние `s m l pill`).
- `motion` — длительности (`press 120, release 160, el 200, screen 320, sheet 320, price 400`) и кривые (`ease`, `sheetEase`, `exitEase`); `toastMs 4000`, `undoMs 6000`.
- `fonts`, `fontFor(weight)`, `tones`, `bannerTones`, `tagTones`, `statusTone`, `status` (прежний формат `{ fg, bg }`).

## Чего пока нет (делать на экранах)
Докрутка цены 400 мс, подсветка пересобранной детали, шторка редактора с 3 положениями, ввод кода по клеткам, `.lang`-переключатель, `.svc`-плитки
главной, `.check`-галочка — собираются из `Press`, `T`, токенов. Смахивание назад на Android — системное «назад».
