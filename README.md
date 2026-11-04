# Eskiz AI — мебельный конструктор для цехов

Приложение для малых мебельных цехов Узбекистана. Мастер фотографирует мебель (или описывает словами), ИИ собирает модель из стандартных модулей, программа считает детали, смету по прайсу поставщика EMAN Materials, раскрой и файлы для станка. Клиент получает ссылку с 3D, AR и сметой, мастер заказывает материалы в EMAN.

Этот файл — общий контекст проекта для того, кто будет его запускать и разворачивать на сервере (человек или ИИ-агент). Подробности по каждой части — в ссылках ниже.

**Состояние (4 ноября 2026):** всё работает на Mac разработчика и тестируется на iPhone. Боевого сервера ещё нет. Перед запуском обязательно закрыть пункты из раздела [«Что блокирует боевой запуск»](#что-блокирует-боевой-запуск).

---

## Документы

| Файл | Что в нём |
| --- | --- |
| [PRD_mebel.md](PRD_mebel.md) | Требования: экраны (SCR-xx), функции (FR-xx), монетизация, роли |
| [PLAN_razrabotki.md](PLAN_razrabotki.md) | План разработки и этапы |
| [deploy/README.md](deploy/README.md) | Docker, Caddy, бэкапы, EAS — техника выкладки |
| [docs/design/](docs/design/) | Макеты всех экранов (`*.dc.html`) и картинки для сверки (`png/`) |
| [docs/decor_contract.md](docs/decor_contract.md) | Формат декора фасадов, подсветки, встройки и комнаты между ядром, 3D и приложением |
| [docs/eman_research.md](docs/eman_research.md) | Что известно о поставщике EMAN, его сайте и прайсе |
| [app/README.md](app/README.md) | Приложение мастера: запуск, сборка, демо-режим |
| [app/src/ui/README.md](app/src/ui/README.md) | Компоненты интерфейса и соответствие макетам |
| [viewer/README.md](viewer/README.md) | 3D-сцена: детали, фурнитура, декор, подсветка, камера, размеры |

## Как устроено

```
фото / текст ──► ai/ (Claude) ──► дерево модулей (JSON) ──► core/ ──► модель деталей
                                                                      │
          ┌───────────────┬───────────────┬──────────────┬────────────┤
          ▼               ▼               ▼              ▼            ▼
   3D (viewer/)     AR (GLB)        смета «от–до»,   CSV, DXF,    проверки
   в app/ и web/                    раскрой          Excel, PDF   и исправления
```

Главное правило: **ИИ только понимает** (что на фото, что хочет мастер) и выдаёт дерево модулей. Детали, размеры распила, цены и файлы считает код ядра (`core/`), детерминированно и с тестами.

| Папка | Что это | Стек |
| --- | --- | --- |
| [core/](core/) | Ядро: модули (шкафы, кухни прямые и угловые, встройка), правила и исправления, присадка, раскрой, смета, файлы CSV/DXF/XLSX/PDF, GLB для AR, декор фасадов, подсветка, фурнитура в 3D, каталог EMAN (`src/mebel_core/data/`) | Python 3.12, uv |
| [ai/](ai/) | Фото/текст → дерево модулей, вопросы кругами, правки словами. Распознавание — Claude Opus 5.5, правки — Haiku/Sonnet 5.5 | Python, Anthropic API |
| [api/](api/) | Сервер: вход по коду, проекты и версии модели, смета, ссылки клиента, ИИ-задачи, файлы, каталог, заказы EMAN, сотрудники, лимиты и пакеты, админ-эндпоинты | FastAPI, SQLAlchemy, Alembic (миграции 0001–0007), PostgreSQL |
| [viewer/](viewer/) | Общая 3D-сцена для приложения и веба: детали, открывание, «разобрать», фурнитура, декор, подсветка, стены ниши, камера и размерные линии | TypeScript, three.js |
| [web/](web/) | Страница клиента `/p/{token}` (3D, AR, смета, «Согласен») и админка `/admin` | Next.js 15 |
| [app/](app/) | Приложение мастера (iOS/Android), дизайн по макетам `docs/design/` | Expo SDK 58, React Native 0.88, expo-router |
| [schemas/](schemas/) | JSON-схема дерева и образцы: деревья, модели для 3D, сметы, GLB | JSON |
| [deploy/](deploy/) | Docker-образы, docker-compose, Caddy (HTTPS), бэкапы | Docker Compose |

Деньги: оплата материалов идёт напрямую на мерчант EMAN (Click / Payme / счёт), оплата пакетов проектов и Pro — владельцу приложения. Комиссия EMAN — с оплаченного заказа.

---

## Выкладка на сервер

Целевая схема: **один VPS** с Docker Compose: Postgres 16, Redis, `api`, `web`, Caddy (HTTPS от Let's Encrypt). Подробно — [deploy/README.md](deploy/README.md), ниже — порядок действий целиком.

### 1. Что нужно заранее

- VPS: Ubuntu 24.04, от 2 ядер и 4 ГБ RAM (сборка `web` требует ~2 ГБ), диск от 40 ГБ. Доступ по SSH-ключу, входящие порты только 22, 80, 443.
- Два домена (A-записи на IP сервера), например `api.eskizai.uz` (API) и `eskizai.uz` (страница клиента и админка).
- Ключ Anthropic API (console.anthropic.com → API Keys). **Новый**: старый ключ разработки засвечен.
- Учётка SMS-провайдера Eskiz (notify.eskiz.uz) — см. блокеры ниже.
- Хранение данных за пределами Узбекистана (если VPS в ЕС) — подтвердить у юриста до пилота (PRD, NFR-11).

### 2. Код и настройки

```bash
sudo git clone https://github.com/DaurovT/EskizAI.git /opt/mebel && cd /opt/mebel
sudo cp deploy/.env.example deploy/.env && sudo chmod 600 deploy/.env
sudo nano deploy/.env
```

Обязательно задать в `deploy/.env` (все переменные с пояснениями — в [deploy/.env.example](deploy/.env.example)):

| Переменная | Значение |
| --- | --- |
| `ENV` | `prod` (в prod сервер не стартует с тестовыми секретами и тестовым кодом входа) |
| `POSTGRES_PASSWORD` | длинный пароль без символов `@ : / ? #` |
| `JWT_SECRET`, `ADMIN_TOKEN` | `openssl rand -hex 32` каждый |
| `API_DOMAIN`, `WEB_DOMAIN`, `ACME_EMAIL` | домены и почта для сертификатов |
| `PUBLIC_API_URL` | `https://<API_DOMAIN>` — из него строятся ссылки на модели для AR и файлы |
| `SHARE_BASE_URL` | `https://<WEB_DOMAIN>/p` — ссылки, которые мастер отправляет клиенту |
| `SHARE_API_URL` | `http://api:8000` — откуда страница клиента берёт данные (пусто = демо-данные) |
| `CORS_ORIGINS` | `["https://<WEB_DOMAIN>"]` |
| `ANTHROPIC_API_KEY` | ключ Anthropic (без него ИИ отвечает 503, остальное работает) |
| `AUTH_CODE_PROVIDER` | `eskiz` + `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, `ESKIZ_SENDER` — **после того как отправка SMS дописана** |
| `PUSH_PROVIDER` | `expo` + `EXPO_ACCESS_TOKEN` — когда приложение собирается через EAS |

### 3. Запуск

```bash
make prod-up      # docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
make ps && make logs
curl https://<API_DOMAIN>/health          # {"status":"ok","env":"prod"}
```

Миграции базы (Alembic, сейчас голова `0007`) применяются сами при старте `api`. Только миграции: `make migrate`.

### 4. Каталог EMAN (декоры, цены, текстуры)

Цены и список декоров EMAN (2807 позиций, 17 брендов) лежат в git: `core/src/mebel_core/data/eman_decors.json`, палитра покраски RAL/NCS — `paint_colors.json`. Смета считается по ним сразу.

Нужно сделать вручную после первого запуска:

1. **Импорт в базу** (чтобы админка ADM-04 видела позиции и вела историю цен):
   ```bash
   # кавычки одинарные: $DATABASE_URL берётся внутри контейнера api, а не на сервере
   docker compose -f deploy/docker-compose.yml exec api sh -c 'python scripts/import_eman_decors.py --database-url "$DATABASE_URL" --dry-run'
   docker compose -f deploy/docker-compose.yml exec api sh -c 'python scripts/import_eman_decors.py --database-url "$DATABASE_URL"'
   ```
   Скрипт можно запускать повторно, он обновляет цены и пишет историю.
2. **Текстуры декоров** (981 JPEG, ~33 МБ) в git **не входят**. Они лежат в томе `textures` (`TEXTURES_DIR=/data/textures`) и отдаются по `/static/textures/`. Два способа:
   - скопировать готовые с машины разработчика: `api/static/textures/` → том `textures` (например, `docker cp` в контейнер `api` по пути `/data/textures/`);
   - собрать заново на сервере: `scripts/scrape_eman_decors.py --cache <папка> --out raw.json` (читает публичный сайт eman.uz с паузами, ~1 час), затем `scripts/build_eman_decors.py --raw raw.json --out ../core/src/mebel_core/data/eman_decors.json --images <кэш> --textures /data/textures` (нужен Pillow).

   Без текстур всё работает, в 3D будет процедурная текстура дерева.
3. Картинки и цены EMAN используются для пилота. **Перед публичным запуском нужно письменное разрешение EMAN** (см. `docs/eman_research.md`).

### 5. Бэкапы и обновление

- Бэкапы: `deploy/scripts/backup.sh` (дамп Postgres + том `media`) и `restore_check.sh` по cron — см. [deploy/README.md](deploy/README.md#бэкапы-nfr-12). Том `textures` можно не бэкапить: он восстанавливается из шага 4.
- Обновление: `cd /opt/mebel && git pull && make prod-up`.

### 6. Приложение под сервер

Адрес сервера зашивается в сборку приложения (`EXPO_PUBLIC_API_URL`).

- **Боевые сборки** — через EAS (Expo Application Services), инструкция в [deploy/README.md](deploy/README.md#приложение-мастера-eas). Профиль `production` (`APP_VARIANT=production`) разрешает только `https://`.
- **Как сейчас собирают для теста** (Xcode на Mac, подпись команды PHARMIQ ACADEMY, Team ID `XQ35SJRLQH`, bundle id `uz.mebel.master`):
  ```bash
  cd app
  APP_VARIANT=production EXPO_PUBLIC_API_URL=https://<API_DOMAIN> EXPO_PUBLIC_SHARE_URL=https://<WEB_DOMAIN>/p \
    xcodebuild -workspace ios/MebelMaster.xcworkspace -scheme MebelMaster -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath ios/build -allowProvisioningUpdates build
  xcrun devicectl device install app --device <UDID> ios/build/Build/Products/Release-iphoneos/MebelMaster.app
  ```
  Нативный проект `app/ios/` правился вручную (иконка, заставка, название «Eskiz AI», доступ к локальной сети) — **не запускать `expo prebuild --clean`**, он это перезапишет.
- Название в сторах — «Eskiz AI». Bundle id и схема ссылок пока старые (`uz.mebel.master`, `mebelmaster://`) — менять только вместе с выпуском в стор.

---

## Что блокирует боевой запуск

| Что | Почему важно | Где |
| --- | --- | --- |
| **Отправка кода входа по SMS не реализована** | Eskiz и Telegram Gateway — заглушки, а в `ENV=prod` тестовый код `00000` запрещён. Без этого никто не войдёт | `api/src/mebel_api/services/auth_codes.py` (`EskizSmsSender.send`) |
| **Хранилище S3 — заглушка** | Фото и файлы хранятся в томе `media` на самом сервере (`STORAGE_BACKEND=local`). Для одного VPS это нормально, при росте нужен S3 | `api/src/mebel_api/services/storage.py` |
| **Оплаты не подключены** | Пакеты и Pro (App Store / Google Play / Click / Payme), оплата EMAN — пока вручную через админку | PRD, раздел монетизации |
| **Push** | Нужен EAS `projectId` (`npx eas-cli init`) и `EXPO_ACCESS_TOKEN` | `app/app.json`, `PUSH_PROVIDER` |
| **Ключ Anthropic** | Ключ разработки засвечен — выпустить новый для сервера | `ANTHROPIC_API_KEY` |
| **Разрешение EMAN** | На использование их фото декоров и цен | `docs/eman_research.md` |
| **AR у мастера в редакторе** | Кнопка AR в приложении пока показывает уведомление (у клиента на веб-странице AR работает) | PRD SCR-47 |

## Локальная разработка

Без Docker (так работают сейчас):

```bash
# сервер
cd api && uv sync
DATABASE_URL=sqlite:///./dev.db uv run alembic upgrade head
ANTHROPIC_API_KEY=... DATABASE_URL=sqlite:///./dev.db ENV=dev \
  PUBLIC_API_URL=http://<имя-мака>.local:8000 SHARE_BASE_URL=http://<имя-мака>.local:3010/p \
  uv run uvicorn mebel_api.main:app --host 0.0.0.0 --port 8000
# страница клиента
cd web && npm install && npx next dev -H 0.0.0.0 -p 3010
# приложение в демо-режиме без сервера (Metro)
cd app && npm install && EXPO_PUBLIC_MOCK=1 npx expo start
```

- Вход в dev: любой номер, код `00000`.
- Приложение на телефоне ищет Mac по имени в сети (`*.local`), поэтому работает и в Wi‑Fi, и через точку доступа без пересборки.
- Metro запускать **без** `CI=1`: в этом режиме Expo не следит за изменениями файлов.
- Сверка экранов с макетами: `app/scripts/shot.sh <Макет> <маршрут>` на симуляторе iPhone 17e (390×844, как макеты).

С Docker — весь стек одной командой: `make up` (см. [deploy/README.md](deploy/README.md)).

## Тесты

```bash
make test        # core, ai, api, viewer
cd app && npx tsc --noEmit -p . && npx jest --no-watchman
cd web && npx tsc --noEmit -p .
```

На 4 ноября 2026 всё зелёное: core 257, ai 37, api 235, viewer 99, app 95. CI — `.github/workflows/ci.yml` (по изменённым папкам, включая api на Postgres 16 и сборку Docker-образов).

## Безопасность

- Секреты только в `deploy/.env` на сервере (права 600) и в EAS. В git — только `*.env.example`.
- В приложение не кладём секретов: всё `EXPO_PUBLIC_*` попадает в сборку открытым текстом — только адреса.
- Клиент на странице `/p/{token}` никогда не видит себестоимость, наценку, поставщика и артикулы — это проверяют тесты API.
- Админка пока защищена общим токеном `ADMIN_TOKEN` (заголовок `X-Admin-Token`) — роли админов в планах.
