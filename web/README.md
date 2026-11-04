# web — ссылка клиента

Next.js 15 (App Router). Страница `/p/[token]` — это ссылка, которую мастер отправляет клиенту в Telegram. На ней 3D, «Посмотреть у себя» (AR), смета в выбранном виде, контакты мастера и кнопка «Согласен». После неё открывается экран WEB-2 `/p/[token]/agreed`. Страница рассчитана на телефон, ширину 360–430 px и встроенный браузер Telegram. Языки — рус и ўзб (латиница), переключатель есть на странице.

React 19, @react-three/fiber 9 и drei 10 — те же версии, что у приложения: обе стороны берут 3D из общего `viewer` (`@mebel/viewer`).

## Запуск

```bash
cd viewer && npm install && cd ../web
npm install        # @mebel/viewer подключается как file:../viewer (симлинк)
npm run dev        # сначала собирает viewer, потом next dev → http://localhost:3000/p/demo
npm run build && npm start
```

Демо-токены (мок): `demo` (шкаф с дверями, ящиками и антресолью, короткая смета), `kupe` (купе с зеркалом, узб, подробная), `niche` (подробная), `2sec` (только итог), `doors` (тестовая тумба, точная цена, GLB строится на лету), `noprice` (цена скрыта), `expired` (410). Для проверки вид сметы можно подменить: `?view=total|short|detailed`, язык — `?lang=uz`.

## API (сейчас мок, потом FastAPI)

| Метод | Ответ |
| --- | --- |
| `GET /api/share/{token}` | `SharePayload`; 404 / 410 → `{ error: 'not_found' \| 'expired' }` |
| `POST /api/share/{token}/events` | тело `{ event: 'opened' \| 'ar_started' \| 'ar_failed' \| 'agreed', at, meta? }` → 204 |
| `POST /api/share/{token}/agree` | `{ agreedAt }` |
| `GET /api/share/{token}/glb/{closed\|open}.glb` | запасной GLB из viewer, если сервер не дал свой |

Если задать `SHARE_API_URL` (например `http://localhost:8000`), страница возьмёт данные из `GET {SHARE_API_URL}/share/{token}` (`src/lib/share-source.ts`), а `agree` и `events` перешлёт в `POST {SHARE_API_URL}/share/{token}/agree|events`. FastAPI отдаёт ровно `SharePayload` (это проверяет тест `api/tests/test_share.py`); GLB для AR — `GET /share/{token}/glb/{closed|open}` на API (адрес — из `PUBLIC_API_URL`). Дополнительно в `master` может прийти `logoUrl` (логотип цеха на Pro).

## Тип данных ссылки

Полное описание — `src/lib/share-types.ts`.

```ts
interface SharePayload {
  version: 1;
  token: string;
  lang: 'ru' | 'uz';                 // язык по умолчанию — язык мастера
  expiresAt: string | null;          // ISO; просроченная ссылка → HTTP 410
  agreedAt: string | null;           // клиент уже нажал «Согласен»
  project: { title: { ru: string; uz: string }; sizeMm: [w, h, d]; modelVersion: string };
  master: { name: string; workshop?: string; phone: string /* E.164 */; telegram?: string /* без @ */ };
  model: ViewerModel;                // viewer model ядра, формат "1"
  glb: { closed: string; open: string; closedUsdz?: string; openUsdz?: string }; // метры; URL публичный (Scene Viewer качает сам)
  estimate: ClientEstimate | null;   // null — мастер скрыл цену
  priceDate: string | null;          // дата снимка цены
}

// Ровно форма ядра: estimate.py → client_view(), schemas/samples/*.estimate.json
interface ClientEstimate {
  view: 'total' | 'short' | 'detailed';
  exact: boolean;                    // false — до замера, суммы «от–до»
  total: { from: number; to: number };
  materials?: { from: number; to: number };            // short, detailed
  work?: { from: number; to: number };                 // short, detailed — «Работа мастера»
  groups?: { name: string; from: number; to: number }[]; // detailed
  requests?: { name: string; note: string }[];         // detailed — «под запрос»
}
```

Суммы — целые сумы. Сервер отдаёт только поля выбранного вида (NFR-10). Поставщика, наценки, артикулов и комиссии в ответе нет и не будет.

## AR

Используется `<model-viewer>` 4.0 (`ar-modes="webxr scene-viewer quick-look"`, `ar-scale="fixed"`). USDZ для iOS model-viewer собирает сам из GLB. Перед запуском клиент выбирает «закрыто / открыто», если у изделия есть подвижные узлы. Под кнопкой написано: AR — не замер (±1–3 см). Если `canActivateAR` ложно, кнопки нет. Во встроенном браузере Telegram (определяется по UA и `TelegramWebviewProxy`) показывается подсказка и кнопка «Открыть в браузере». На Android это `intent://`, на iOS — копирование ссылки. «AR не запустился» фиксируется, если model-viewer прислал `ar-status: failed` или за 4 с после запуска страница не ушла в фон.

## Админка `/admin` и кабинет поставщика `/vendor`

Админка платформы и кабинет поставщика (`docs/staff_vendor_contract.md`) — в том же Next.js-приложении. Все страницы клиентские, ходят прямо в FastAPI (`api/`). Свои layout и стили (`src/app/admin/admin.css` + `src/app/vendor/vendor.css`, всё внутри `.adm`) — страница клиента `/p/[token]` не затронута.

**Хосты** (`src/middleware.ts`): `ADMIN_HOST` (по умолчанию `admin.eskizai.uz`) — «/» → `/admin`, `/p` и `/vendor` — 404; `VENDOR_HOST` (`vendor.eskizai.uz`) — «/» → `/vendor`, `/p` и `/admin` — 404; остальные хосты (`app.eskizai.uz`) — только `/p/*`. Локально (`next dev`, localhost, адрес в локальной сети) доступно всё. Проверить хост локально: `curl -H 'Host: vendor.eskizai.uz' http://localhost:3010/`.

```bash
# API (см. api/README.md); CORS должен пускать адрес веба
cd api && CORS_ORIGINS='["http://localhost:3010"]' uv run uvicorn mebel_api.main:app --reload
cd web && NEXT_PUBLIC_API_URL=http://localhost:8000 npx next dev -p 3010   # → /admin, /vendor
```

- `NEXT_PUBLIC_API_URL` — адрес API, подставляется при сборке. Не задан: на доменах `admin.` / `vendor.` / `app.<домен>` — `https://api.<домен>`, иначе `http://localhost:8000`.
- Вход сотрудника — почта и пароль (`/staff/auth/login`), для суперадмина — ещё код из приложения-аутентификатора (2FA, настройка с QR при первом входе). Токены в `localStorage` (у админки и кабинета — разные ключи), access обновляется по refresh автоматически; временный пароль → экран смены пароля. Меню и разделы — по `permissions` из `GET /staff/me`.
- Переходный режим админки: «Войти по токену» (`X-Admin-Token`, права суперадмина) — пока не создан первый суперадмин (`api/scripts/create_staff.py`).
- Мока нет: без запущенного API страницы показывают «API недоступен».

| Страница | Что делает |
| --- | --- |
| `/admin` | Дашборд: цеха, проекты и заказы по статусам, оборот и комиссия EMAN, расходы на ИИ за день / неделю / месяц |
| `/admin/workshops`, `/admin/workshops/[id]` | Список с поиском; карточка: лимиты, пользователи, проекты, заказы, журнал действий; ручное начисление проектов в пакет, тариф, блокировка |
| `/admin/projects`, `/admin/projects/[id]` | Поиск по проекту, клиенту, цеху, статусу, типу; карточка: 3D любой версии (`@mebel/viewer/react`), дерево модулей, смета мастера, ИИ-журнал и бюджет, чат редактора, заказы, открыть производственные файлы (оплата вручную) |
| `/admin/orders`, `/admin/orders/[id]` | Заказы; карточка: состав заказа поставщику (`supplier_order` ядра: позиции, «под запрос» вне заказа, доставка), CSV онлайн-кроя, отметка «передан в EMAN», отметка оплаты (`order-paid`), смена статусов |
| `/admin/catalog` | Позиции каталога: поиск, тип, устаревшие цены, правка цены, наличие, история цен, ручное добавление |
| `/admin/catalog/runs`, `/admin/catalog/runs/[id]` | Загрузка прайса (CSV или сохранённая страница eman.uz), сырые записи и сопоставление, исчезнувшие позиции, публикация (в т. ч. без непроверенных) |
| `/admin/catalog/review` | Очередь изменений цены > 15%: подтвердить / отклонить |
| `/admin/ai` | Расход ИИ, токены, результаты проверки, точность (сколько деревьев мастер исправил), запросы с фильтрами |
| `/admin/settings` | Бюджет ИИ на проект и порог предупреждения (пишется в журнал действий) |

Новые разделы админки (§4a): сотрудники, безопасность (2FA, сессии), поставщики (реквизиты, комиссия, маршруты, взаиморасчёты), финансы, споры, тарифы и лимиты, рассылки, журнал действий. Кабинет поставщика (§5): сводка, заказы (очередь / мои / все, карточка: принять / вернуть / отклонить, исправление, переписка, производство, возвраты), возвраты, нестандарт, позиции без цены, прайс с загрузкой файла, источник цен, взаиморасчёты, аналитика, сотрудники, настройки. Не сделано: модули и правила (ADM-06); на страницах нет сортировки столбцов.

## Известные пробелы

- Работу AR в Telegram на реальных iPhone и Android не проверяли (PRD §8 требует прототип). В WKWebView Telegram на iOS model-viewer не включает Quick Look, поэтому кнопки AR там не будет — только подсказка «Откройте в Safari».
- Без `SHARE_API_URL` аналитика — заглушка (события пишутся в лог сервера), «Согласен» мок хранит в памяти процесса. С `SHARE_API_URL` — пересылка в API.
- Названия групп и позиций сметы приходят от ядра только по-русски. Для узбекского стоит небольшой словарь известных названий (`coreName` в `src/lib/i18n.ts`).
- У позиций «под запрос» в форме ядра нет диапазона цены: показываем название и пометку «уточняется».
- «Нестандарт» (строка вне итога) в форме ядра пока отсутствует, поэтому не показывается.
- Просроченная ссылка отдаётся с HTTP 200 и экраном «срок истёк», неизвестный токен — с 404.
- Общего workspace в корне нет, потому что корень трогать нельзя. web подключает viewer через `file:../viewer`, а `next.config.mjs` берёт `three` и R3F из `web/node_modules`, чтобы в бандле не было двух копий.
