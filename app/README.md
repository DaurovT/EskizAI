# app — приложение мастера

React Native 0.88 + Expo SDK 58 + React 19.3 + TypeScript 6, навигация — expo-router 58. Только New Architecture (старой в SDK 58 нет). Русский и узбекский (латиница) с первого дня, переключатель в профиле.

3D: `@react-three/fiber/native` 9.8 + `expo-gl` 58 + three 0.169; общий `@mebel/viewer` (React 19 / R3F 9) — тот же, что в `web/`. Все версии закреплены точно (`expo install --check` → «Dependencies are up to date»; `expo-doctor` — 20/20). Node — 22.13+ или 24 LTS (Node 25 работает, но npm предупреждает EBADENGINE).

**expo-gl и New Architecture проверены на iPhone 16 Pro Max (iOS 26.5)**: геттеры WebGL отвечают (`LINK_STATUS`, `ACTIVE_ATTRIBUTES`, `getError`), кухня рисуется за 42 draw calls / 1020 треугольников (см. «Диагностика»). На SDK 52 под New Architecture геттеры возвращали `undefined` — серый холст; на SDK 58 это ушло. `checkShaderErrors = false` в `ProductCanvas` оставлен: журнал шейдеров теперь приходит, но проверка — лишние синхронные вызовы GL на каждую программу.

## Быстрый старт

```bash
cd viewer && npm install && cd ../app   # viewer подключён как file:../viewer, нужен его dist/
npm install
npm run start:mock                      # мок без сервера → QR-код для Expo Go
```

`npm start`, `start:mock` и `export:android` перед запуском сами собирают `../viewer` (`npm run viewer:build`).

| Команда | Что делает |
| --- | --- |
| `npm run start:mock` | Metro с `EXPO_PUBLIC_MOCK=1` — все экраны на образцах ядра |
| `EXPO_PUBLIC_API_URL=http://192.168.1.10:8000 npm start` | с настоящим FastAPI (адрес компьютера в локальной сети, не `localhost`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | jest: API-клиент, опрос задач и 402, мок, офлайн-кэш, полнота i18n, логика новых экранов |
| `E2E_API_URL=http://127.0.0.1:8765 npm run e2e` | настоящий API-клиент против запущенного FastAPI (см. «Сквозная проверка») |
| `npm run export:android` | проверка бандла (`expo export --platform android` → `dist-export/`) |
| `npm run doctor` | `expo-doctor` |

API для разработки: `cd api && DATABASE_URL=sqlite:///./dev.db uv run alembic upgrade head && DATABASE_URL=sqlite:///./dev.db uv run uvicorn mebel_api.main:app --host 0.0.0.0 --reload`. Код входа в dev — `00000`.

## Переменные окружения

| Переменная | Значение |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | адрес FastAPI. Не задан — включается мок |
| `EXPO_PUBLIC_MOCK` | `1` — мок, даже если адрес задан |
| `EXPO_PUBLIC_SUPPORT_TG` | Telegram поддержки без `@` (FR-57), по умолчанию `mebel_support` |
| `EXPO_PUBLIC_SHARE_URL` | только для мока: база ссылки клиента, по умолчанию `http://localhost:3000/p` (страница `web/` — `/p/{token}`) |
| `EXPO_PUBLIC_DIAG` | `1` — диагностика 3D: плашка под 3D, `Documents/diag.log`, маршрут `mebelmaster://diag`. По умолчанию выключена |
| `APP_VARIANT` | не `EXPO_PUBLIC`: читает `app.config.js` при prebuild/сборке. `development` / `preview` — разрешён обычный `http://` к API в локальной сети (iOS ATS, Android cleartext); `production` (по умолчанию) — нет |

В коде — только прямая запись `process.env.EXPO_PUBLIC_X` (`src/config.ts`): Expo подставляет значения лишь так, `process.env[name]` в Release-сборке пустой. `EXPO_PUBLIC_*` попадают в сборку открытым текстом: туда только адреса, никаких секретов. В EAS их задают через `eas env:create` (см. `deploy/README.md`); в `eas.json` есть профили `development` (dev client, internal), `preview` (internal APK / ad-hoc) и `production`, каждый со своим `environment`.

## Expo Go или dev build

| | Expo Go | Dev build |
| --- | --- | --- |
| Все экраны, мок, API, 3D (expo-gl), камера, галерея | да | да |
| «Поделиться» из Telegram → приложение | нет, только галерея | да |
| Push-токен | только Android и только с EAS `projectId` | да (нужен `projectId`: `eas init`) |

Dev build для Android:

```bash
npx expo prebuild --platform android   # android/ не коммитим (в .gitignore)
npx expo run:android                   # или: npx eas-cli build --profile development --platform android
```

**«Поделиться» из Telegram (SCR-04)** — пакет `expo-share-intent` 9 и его config plugin (настройки в `app.json`: `image/*` и `text/*`, несколько фото на Android через `androidMultiIntentFilters`, до 5 картинок на iOS). Когда мастер выбирает «Мебель Мастер» в меню «Поделиться», `app/_layout.tsx` (`ShareIntentBridge`) забирает картинки и текст и открывает «Новый проект» с ними. В Expo Go нативного модуля нет: провайдер отключается (`disabled`), запасной путь — кнопка «Галерея».

На **iOS** расширение включено: prebuild создаёт цель `EskizAIShare` (`uz.mebel.master.share-extension`) и App Group `group.uz.mebel.master` у приложения и расширения. Патч `xcode` через `patch-package` больше не нужен (config-plugins SDK 58 используют `xcode` 4). App Group Xcode регистрирует сам при сборке с `-allowProvisioningUpdates`.

## Сборка на iPhone без EAS

`ios/` — результат `expo prebuild`, в git не кладём, руками не правим: всё задаётся `app.json`, `app.config.js` и `plugins/`. На Xcode 27 из папки с пробелом в пути («AI Costructor») собирается без обходов: прежние проблемы SDK 52 (кавычки в скрипте Hermes, `fmt` и consteval, `IPHONEOS_DEPLOYMENT_TARGET` < 15, `switch` по `Calendar.Identifier` в expo-localization) в SDK 58 ушли. React Native и его зависимости приходят собранными, минимальная iOS — 16.4.

```bash
cd viewer && npm ci && npm run build && cd ../app && npm ci
APP_VARIANT=development npx expo prebuild -p ios --clean
APP_VARIANT=development EXPO_PUBLIC_API_URL=http://192.168.1.54:8000 EXPO_PUBLIC_DIAG=1 \
  xcodebuild -workspace ios/EskizAI.xcworkspace -scheme EskizAI -configuration Release \
  -destination 'id=<UDID>' -derivedDataPath ios/build -allowProvisioningUpdates build
xcrun devicectl device install app --device <UDID> ios/build/Build/Products/Release-iphoneos/EskizAI.app
xcrun devicectl device process launch --terminate-existing --device <UDID> uz.mebel.master
```

Сборка идёт и на iPhone, и на iPad (`ios.supportsTablet`). Новое устройство попадает в профиль подписи, только если собрать с `-destination 'id=<UDID>'` и `-allowProvisioningDeviceRegistration`; сборка под `generic/platform=iOS` на него не установится.

Подпись — команда `XQ35SJRLQH` (`ios.appleTeamId`), автоматическая; push (`aps-environment`) и App Group попадают в entitlements сами. `EXPO_PUBLIC_*` подставляются при сборке JS внутри `xcodebuild` — задавайте их в той же команде. Проверить, что адрес попал в сборку: `LC_ALL=C grep -a -c "192.168.1.54:8000" ios/build/Build/Products/Release-iphoneos/EskizAI.app/main.jsbundle` → 1.

## Диагностика (DIAG)

Сборка с `EXPO_PUBLIC_DIAG=1` (выключено по умолчанию, в production не включать):

- под 3D — плашка: версия GL, размер буфера, деталей, draw calls, треугольники, номер кадра, последняя JS-ошибка;
- `Documents/diag.log` (новый на каждый запуск): API и мок, версия GL и буфер, ответы геттеров WebGL по первой программе three, draw calls / треугольники по кадрам, глобальные JS-ошибки, необработанные промисы, `console.error`. Фатальная JS-ошибка в DIAG только пишется в журнал — приложение не падает;
- маршрут `/diag` без входа и без проектов: образец `schemas/samples/kitchen_straight.viewer.json` в том же `ProductCanvas`.

```bash
xcrun devicectl device process launch --terminate-existing --device <UDID> --payload-url mebelmaster://diag uz.mebel.master
# через ~10 с
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier uz.mebel.master --source Documents/diag.log --destination ./diag.log
```

Норма: `getters … LINK_STATUS=true ACTIVE_ATTRIBUTES=2 … getError=0`, `frame=… calls=42 triangles=1020` (кухня, medium), строк `ERROR` нет. Код — `src/diag.ts`, `DiagProbe` в `src/three/ProductCanvas.tsx`, `app/diag.tsx`.

## Демо в моке: что нажать

1. **Вход (SCR-01).** Выбрать язык, ввести любой номер (`90 123 45 67`), «Получить код», код `00000`. Таймер повтора — 60 с.
2. **Профиль цеха (SCR-02)** — при первом входе за сессию. Обязательны только название и город.
3. **Проекты (SCR-03).** Пять проектов в разных статусах, фильтр по статусу, поиск по клиенту. «Попробовать на примере» открывает шкаф-купе с плашкой «Пример — лимит не тратится».
4. **＋ Новый (SCR-04).** Варианты:
   - одно фото → разбор (SCR-05) → 3 вопроса (SCR-07) → модель;
   - **два и больше фото** → на первом фото рамки двух предметов (`objects`), тап по рамке отвечает на вопрос `object`;
   - текст «шкаф-купе 2,4 метра, три двери, зеркало посередине» → «Разобрал описание» (SCR-29), ширина 2400 понята, остальное помечено «оценка»;
   - короткий текст («шкаф») → выбор типа (SCR-06);
   - текст со словом «ошибка» → «Не смог разобрать» с тремя выходами.
5. **Редактор (SCR-08).** Вращение одним пальцем, зум щипком, тап по двери или ящику открывает его и выбирает деталь (SCR-25, подсветка и «рентген»). «Открыть всё», «Размеры» (размерные линии viewer), «Разобрать на детали». Поля ±10 мм; значения «оценка» до подтверждения (галочка или правка поля). Подсказка «Введите ширину ниши клиента» висит над полем ширины. Ширина 2600 с одной дверью в секции → замечание и исправление в одно касание. Чат: «ширина 2000», «добавь ящики», «антресоль», «белые фасады», «без ручек»; непонятная фраза → вопрос ИИ с быстрыми ответами. Каждая правка показывает разницу в цене, отменяется и повторяется. **На 6-й ИИ-правке в проекте** мок отвечает 402: появляется вопрос «списать ещё один проект из лимита».
6. **Версии (SCR-35)** — откат к любой версии, кроме замороженной. **Материалы (SCR-09)** — декоры корпуса и фасадов, ручки; модель перекрашивается.
7. **Смета (SCR-10)** — себестоимость по категориям и позиции со статусами (каталог / аналог / под запрос). **Цены цеха (SCR-32)** — в профиле.
8. **Раскрой и файлы (SCR-11 → SCR-36).** КП открыт всегда, остальные файлы закрыты (402), пока проект не «В работе». В проекте «Кухня Нигоры» открыто всё: CSV показывается таблицей, кнопка «Поделиться файлом» отправляет файл через меню телефона.
9. **Отправка (SCR-12).** Вид сметы (предпросмотр меняется сразу), цена вкл/выкл, язык ссылки, срок; «Отправить в Telegram» открывает выбор чата (`tg://msg_url`, запасной вариант — `t.me/share`), «Копировать ссылку». Эскиз → Отправлен.
10. **Карточка проекта (SCR-27)** — статус-лента и кнопка следующего шага из `actions`: Замер (SCR-13) → Договор → «Заказать в EMAN» (пока через менеджера) / «Материалы куплены сам — сдать».
11. **Заказы (SCR-15/16)** — два заказа: «В распиле» (оплачен Click) и «Создан» (ждёт оплаты, кнопка «Оплатить» открывает ссылку EMAN). **Клиенты (SCR-17/33)** — звонок и Telegram в один тап. **Профиль (SCR-18)** — лимит, сотрудники, язык, уведомления, архив.
12. **Офлайн.** Открыть пару проектов, включить авиарежим: плашка «Нет сети — показываем сохранённое», проекты, модель, смета и чат открываются из кэша. Замер без сети сохраняется в телефоне и уходит при появлении связи.

Состояние мока живёт в памяти: перезапуск JS возвращает исходные данные. Токен при этом остаётся в SecureStore, поэтому экран входа не появится.

## Офлайн (NFR-07)

- Кэш в AsyncStorage: `listProjects`, `getProject`, `getModel` (с 3D-моделью), `getEstimate`, `getClientEstimate`, `getChat`, `listVersions`, `listFiles`, клиенты, заказы, цех, лимиты. Без сети отдаётся последняя загруженная версия (`src/api/offline.ts`).
- Без сети отключены правка модели полями и словами, ИИ, создание ссылки и новый проект; 3D-просмотр, открывание дверей и «взрыв» работают.
- Замер без сети ставится в очередь (`outbox:measurements`) и отправляется, когда NetInfo сообщит о связи.
- Сами файлы (PDF, CSV) офлайн не хранятся: скачиваются при открытии.

## Что замокано и почему

С настоящим API все экраны работают по эндпоинтам из `api/README.md`; мок нужен только для показа без сервера.

| Что | В моке | С настоящим API |
| --- | --- | --- |
| ИИ (`/ai/design`, `/answer`, `/choose-type`, `/edit`, `/chat`) | правила по ключевым словам, задачи «работают» 4 / 1,5 с, 402 после 5 правок | очередь задач, `GET /tasks/{id}` → `status` |
| Пересборка модели | viewer-модель образца растягивается и перекрашивается (`src/lib/viewerEdit.ts`) | ядро на сервере |
| Смета | образец `*.estimate.json`, масштабированный по площади плит | ядро; цена в списке — кэш сервера |
| Раскрой SCR-11 | полосовая укладка (`src/lib/cutting.ts`) в формате API | `GET /projects/{id}/nesting` (раскрой ядра) |
| Декоры SCR-09 | копия списка ядра (`src/lib/catalog.ts`) | `GET /catalog/decors` |
| Заказы, оплата | два заказа + оформление в памяти | `GET /orders`, `GET /orders/{id}`, превью и оформление, ссылка на оплату от менеджера |
| Нестандарт | заявка «оценивается» через 4 с | `POST/GET …/nonstandard`, админка `/admin/nonstandard` |
| «Под запрос», фурнитура | две позиции у «Купе»; три группы фурнитуры | `…/price-requests`, `GET/POST …/hardware` (ядро `hardware_options`) |
| Push | токен не отправляется | `POST /devices` после входа, `DELETE /devices` при выходе |

## Новые экраны

- **SCR-14** `project/[id]/order` — состав заказа из превью (листы, распил, кромкование, фурнитура), самовывоз или доставка с расстоянием (пересчёт через 0,5 с после ввода), исключённые позиции «под запрос», итог; «Оформить заказ» → карточка заказа.
- **SCR-16 / SCR-31** `order/[id]` — шаги статуса с датами, позиции, доставка, оплата EMAN: «ждёт / не прошла / оплачено», кнопка «Оплатить» по ссылке менеджера, отмена неоплаченного заказа.
- **SCR-19 / SCR-34** `project/[id]/nonstandard` — заявка (описание, фото проекта, отличия из разбора ИИ; конструкторам EMAN или «доработаю сам») и статус заявок: цена и срок, «Принять цену», доработанные файлы (скачать и «Поделиться»).
- **SCR-26** `project/[id]/hardware` — варианты фурнитуры с разницей цены (сотруднику — только ↑/↓), замена — новая версия, отменяется в редакторе.
- **SCR-30** `project/[id]/price-requests` — цена и срок от EMAN, разница со сметой, «Принять» / «Отказаться» / «Предложить замену».
- **SCR-12** — плашка «Цены устарели — пересчитайте смету» при `has_stale`. **SCR-11** — точный раскрой ядра. **SCR-08** — «оценка» из версии на сервере, галочка подтверждает на всех телефонах. **SCR-13** — сервер сам применяет замер к модели.
- Push: тап открывает проект, заказ, «под запрос», нестандарт или профиль (`src/lib/pushRoute.ts`), в том числе при холодном старте.

## Сквозная проверка

```bash
cd api && ENV=dev DATABASE_URL=sqlite:///./e2e.db uv run alembic upgrade head
ENV=dev DATABASE_URL=sqlite:///./e2e.db uv run uvicorn mebel_api.main:app --port 8765
cd app && E2E_API_URL=http://127.0.0.1:8765 npm run e2e
```

`scripts/e2e.ts` собирается `tsc` в `.e2e-build/` и гоняет `createHttpApi` (тот же код, что в приложении): вход 0000 → цех → проект → дерево `core/tests/fixtures/wardrobe_full.json` → эскиз → смета и цена в списке → раскрой, фурнитура, декоры, «под запрос» → ссылка (клиент открыл — push) → замер → договор → превью заказа с доставкой → заказ → менеджер ставит ссылку и отмечает оплату (`X-Admin-Token`) → файлы открыты → PDF «Шкаф_Азиза_спецификация_v3.pdf» → нестандарт до «Готово» с файлом.

## Устройство

```
app/                     маршруты expo-router (экраны)
  _layout.tsx            провайдеры, вход, сеть, push, «Поделиться»
  (tabs)/                Проекты · Клиенты · ＋ Новый · Заказы · Профиль
  login.tsx workshop.tsx SCR-01, SCR-02
  project/new.tsx        SCR-04
  project/[id]/          index (SCR-27), breakdown (05/29), choose-type (06), questions (07),
                         editor (08 + 25), versions (35), materials (09), estimate (10),
                         files (11), file/[kind] (36), send (12), measure (13), nonstandard (19)
  order/[id] client/*    SCR-16, SCR-33;  settings/prices — SCR-32;  archive — SCR-39
src/api/                 types.ts (модели), http.ts (токены, refresh), httpApi.ts, mock/, tasks.ts (опрос + 402),
                         offline.ts (кэш и очередь), download.ts (файлы в кэш)
src/i18n/                ru.ts, uz.ts (один набор ключей — проверяют tsc и тест), провайдер
src/three/ProductCanvas  R3F native + expo-gl + ProductObject; свои жесты
src/ui/                  крупные кнопки (56 pt), NumberField ±10, статус-лента, ошибки (SCR-28)
```

- `metro.config.js` подключает `../viewer` и `../schemas`. Все «голые» импорты из файлов viewer резолвятся из `app/node_modules`, `viewer/node_modules` закрыт для бандла (иначе две копии three/React). `@mebel/viewer/react` указывает прямо на `ProductObject.js`: `ProductViewer` из того же index тянет drei и DOM. Проверено по source map: в бандле одна копия three, React и R3F (native), drei нет.
- `tsconfig.paths.json` нужен только tsc: `.d.ts` viewer должны брать типы three/react/R3F из app. Пути вынесены из `tsconfig.json`, потому что jest-expo превращает `paths` в алиасы модулей.
- Корневой npm workspace не делал: `file:../viewer` + Metro-резолвер проще и не трогает `web/`.

## Отклонения от контракта (сделано терпимо)

- `GET /projects/{id}/files`: принимаем и массив, и `{files: [...]}`.
- `DesignOut.objects` и `alternatives`: нет поля → `[]`; `alternatives` может быть массивом строк или `{product_kind, confidence}`.
- «Не знаю» на вопрос уходит строкой `"не знаю"` в `answers[qid]`.
- «К модели» на SCR-05 сам вызывает `POST …/sketch`, если проект в черновике и модель без ошибок (лимит списывается в этот момент, PRD §16).
- Правка полями сначала уходит с `reject_on_errors: true`; при ошибке модели мастер может сохранить версию с замечаниями.
- Локальная копия `estimated` в `projectMeta` осталась только для мока и старого кэша: источник — `VersionOut.estimated`.

## Известные пробелы

- **3D на бюджетном Android не замерен.** Качество выбирается по ОЗУ (`detectQuality` из viewer, ≤ 4 ГБ → `low`: без рёбер, Lambert, слияние мешей, ~20–25 draw calls; иначе `medium`). Рисуем по требованию (`frameloop="demand"`), без тени и без карты окружения. Но R3F native всегда рендерит в полный `PixelRatio` (ограничение expo-gl), на экранах 3× это главный риск для 30 кадров/с (NFR-04). Если не хватит: уменьшать размер GL-вью и растягивать его, или патчить R3F. Замер — на 3 бюджетных телефонах (план, неделя 17).
- **three 0.169 + expo-gl**: three ≥ 0.163 требует WebGL2. На iPhone проверено (DIAG), на старых Android-GPU контекст может не создаться: тогда вместо 3D будет текст «3D недоступно», остальное работает. На Android-устройствах не проверено.
- Вращение и зум — свои жесты (PanResponder): drei OrbitControls в RN нет. Нет инерции и панорамирования.
- **«Поделиться» из Telegram** собран (на iOS — расширение и App Group подписаны), но сам сценарий «Telegram → приложение» на устройстве руками не проверен. Делиться можно только в установленную сборку, не в Expo Go.
- Профиль EAS `development` помечен `developmentClient: true`, а `expo-dev-client` не установлен: для dev-клиента его надо добавить (`npx expo install expo-dev-client`), для обычных сборок не нужен.
- Push: без `eas init` (`projectId`) Expo push token не выдаётся. Приложение работает дальше, в профиле видно «Выключены».
- Превью 3D в карточках списка не сделано (иконка вместо превью): `renderThumbnailWith` из viewer требует `expo-three`, а одновременно рисовать GL-контексты на каждую карточку на бюджетных телефонах дорого. Логичнее брать PNG с сервера (`thumbnailPng` уже есть в viewer).
- SCR-37 (редактор кухни: кухню правим только словами), сравнение версий, оплата тарифов, документы заказа (счёт, накладная) — не в этом объёме. Оплата материалов — только по ссылке EMAN, которую вставляет менеджер (нет формы Click/Payme и вебхука).
- Ошибки сервера показываются как пришли — по-русски, в том числе в узбекском интерфейсе. Сетевые и типовые ошибки переведены.
