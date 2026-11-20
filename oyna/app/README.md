# Eskiz Oyna — мобильное приложение

Expo SDK 58, expo-router, TypeScript (как Eskiz Temir: код семейства копируется, не подключается).
Макеты — `docs/design/*.dc.html` (холст «Eskiz Oyna — экраны приложения»). API — `../oyna_api` (README в корне).

```bash
npm install
npx tsc --noEmit                      # проверка типов
EXPO_PUBLIC_API_URL=http://localhost:8030 npx expo start   # локальный API: см. ../README.md
```

## Структура

| Путь | Что |
| --- | --- |
| `app/` | маршруты expo-router; каждый файл только реэкспортирует экран из `src/screens` |
| `src/screens/<группа>/` | экраны; общее для группы — `parts.tsx` в той же папке |
| `src/ui/kit.tsx` | компоненты по классам макета: `.app`→Screen, `.hdr`→TopBar, `.sheet`→Card, `.row`→Row, `.cta`→Button (стеклянная голубая), `.soft`→Button secondary, `.seg`→Seg, `.chip`→Chip, `.fld`→Field, `.tog`→Switch, `.stp`→Stepper, `.bs`→Sheet, `.foot`→Dock |
| `src/ui/Schema.tsx` | схема окна из дерева изделия (без сети), подсветка нарушений, нажатие на ячейку |
| `src/ui/Icon.tsx`, `Glass.tsx`, `TabBar.tsx`, `MainHeader.tsx` | иконки, «жидкое стекло», меню, шапка вкладок |
| `src/lib/tree.ts` | дерево изделия и команды (как в ядре) — для правки без сети; форма рамы `outline()`, раскладка, сборки (пути `A<i>/`) — `../docs/shapes_contract.md` |
| `src/lib/format.ts` | `money`, `sum`, `num`, `size`, `m2`, `date`, `ago`, `phone`, `STATUS_TITLE` |
| `src/lib/useLoad.ts` | загрузка данных экрана |
| `src/api/http.ts`, `types.ts` | запросы к API, типы ответов |
| `src/auth/AuthContext.tsx` | вход, цех, роль (`useAuth()`) |
| `src/offline/store.ts` | офлайн-хранилище замеров и синхронизация (`offline.*`) |
| `src/theme.ts` | цвета и шрифты макета (голубой Oyna `#1E6FD9`) |

## Правила для экранов

- Тексты, порядок блоков, состояния — как в макете (`docs/design/<Экран>.dc.html`). Цифры в макетах — примеры; на экране — данные API.
- Общие файлы (`src/ui`, `src/lib`, `src/api`, `src/auth`, `src/offline`, `theme.ts`) меняет только основная сессия. Нужно новое общее — сделайте у себя в `parts.tsx` и скажите.
- Цены: `money()` / `sum()` из `format.ts`; без `toLocaleString`. Кириллица в RegExp — без `\b`.
- Роль: `useAuth().role`. Себестоимость, наценку, маржу показывать только владельцу (сервер и так не отдаёт).
- ДЕМО-цены: если `price.demo` / `demo` — плашка «ДЕМО» (`.tag.est`), как в CalcDemo.
- Нарушения: `block`/`lock` — красный (`.ban.err`), `warn` — жёлтый (`.ban.est`), с кнопкой «Принять» → команда `accept_warning`; принятое — «принято: {accepted_by_name}, {date} · отменить» → `unaccept_warning`.
- Без сети: замер и редактор работают через `src/lib/tree.ts` + `offline.savePosition`; цена — «посчитаем, когда появится интернет».

## Маршруты и параметры

| Маршрут | Экран | Параметры |
| --- | --- | --- |
| `/login` | S01 вход: номер → код | — |
| `/setup` | S02 создание цеха (шаги) | — |
| `/orders` | S03 заказы (вкладка) | — |
| `/clients` | клиенты (вкладка) | — |
| `/new` | «+»: новый заказ (OrderNew) | — |
| `/catalog` | каталог (вкладка, просмотр) | — |
| `/profile` | S13 настройки / профиль | — |
| `/resume` | продолжить незаконченный замер | — |
| `/order/[id]` | S04 заказ | `id` — заказ (может быть ещё только на телефоне) |
| `/order/[id]/measure` | S05 мастер замера (v3: 3 шага, `../docs/design_v3/X2–X4`) | `pos?` — позиция (новая, если нет), `step?` 1–3 |
| `/order/[id]/summary` | итог замера (MSummary) | — |
| `/order/[id]/editor` | S06 редактор | `pos` |
| `/order/[id]/conflict` | лист: конфликт версий | `pos` |
| `/order/[id]/templates` | S07 шаблоны → габарит → позиция | — |
| `/order/[id]/kit` | S08 комплектация | `pos?`, `path?` (ячейка); без `pos` — на весь заказ |
| `/order/[id]/alternatives` | лист: варианты замены | `pos`, `what`, `path?` |
| `/order/[id]/swap` | лист: «замена тянет другие» | `pos`, `what`, `value` |
| `/order/[id]/calc` | S09 расчёт | `kit?` |
| `/order/[id]/quote` | S10 КП | — |
| `/order/[id]/docs` | S12 документы | — |

## API по группам экранов

- **Вход/цех/профиль:** `POST /auth/request-code {phone}` → `{length, resend_in, attempts}`; `POST /auth/verify-code {phone, code}` → токены, `needs_onboarding`; ошибка — `detail.attempts_left`. `POST /oyna/company`, `GET/PATCH /oyna/company`, `PUT /oyna/company/works|kits|systems|glass-prices|prices`, `GET/POST/DELETE /oyna/company/members`, `GET /oyna/systems?material=&q=` (chambers, depth_mm, demo_passport), `GET /oyna/fx/usd`, `GET /oyna/catalog/brands|items|review`.
- **Заказы:** `GET /oyna/orders?status=&q=`, `GET /oyna/orders/counts`, `POST /oyna/orders` (id с телефона), `GET/PATCH /oyna/orders/{id}` (client, kit_name, discount_pct), `POST /oyna/orders/{id}/extras`, `GET /oyna/templates` (ready, category, fixed_parts), `POST /oyna/positions/from-template {template, w, h, room}`.
- **Замер:** `POST /oyna/measure/frame {widths, heights}`, `GET /oyna/measure/check?value=`, позиции — `offline.savePosition` → `/oyna/sync`; итог — `GET /oyna/orders/{id}/variants`.
- **Редактор/комплектация:** `POST /oyna/orders/{id}/positions/{pid}/commands {commands, base_rev}` (409 → конфликт), `PUT …/positions/{pid}`, `POST /oyna/positions/alternatives {doc, what, path}`, `POST /oyna/glass/parse {formula, system}`, `GET /oyna/orders/{id}/variants`, `POST /oyna/orders/{id}/apply-kit {kit_name, base_revs}`, `GET /oyna/fitting-sets?system=`, `GET /oyna/decors?system=`, `GET /oyna/glass?system=`.
- **Расчёт/КП/документы:** `GET /oyna/orders/{id}/calc?kit=` (groups, cost только владельцу), `POST /oyna/orders/{id}/quotes {lang, kits, discount_pct}` (409 → блоки), `POST …/quotes/{v}/revoke`, PDF: `/oyna/orders/{id}/documents/{quote|shop|install|supplier}.pdf` (с токеном), клиенту — `public_url`, `pdf_url`, `telegram_share`.
