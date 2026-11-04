# api — REST API

FastAPI + SQLAlchemy 2 + Alembic. Вход по коду, цеха, клиенты, проекты и статусы, версии модели, смета,
ссылка клиента, ИИ (распознавание, вопросы, правки словами, чат), файлы мастера, каталог и парсер прайса,
заказы, админка. Модель, смету и файлы считает ядро (`../core`, `mebel_core`), ИИ — пакет `../ai` (`mebel_ai`).

## Запуск

```bash
cd api
uv sync
uv run pytest                                  # тесты (SQLite в памяти, без Docker и без Claude API)

# Быстрый старт без Docker — SQLite
DATABASE_URL=sqlite:///./dev.db uv run alembic upgrade head
DATABASE_URL=sqlite:///./dev.db uv run uvicorn mebel_api.main:app --reload
# → http://localhost:8000/docs ; админка — web/ на /admin

# С Postgres и Redis
cp .env.example .env
docker compose up -d
uv run alembic upgrade head && uv run alembic check
uv run uvicorn mebel_api.main:app --reload
```

Тесты на Postgres: `TEST_DATABASE_URL=postgresql+psycopg://mebel:mebel@localhost:5432/mebel_test uv run pytest`.

Вход в dev: `POST /auth/verify-code {"phone": "+998901234567", "code": "0000"}` (код `0000` — только при `ENV=dev`).
Админка: заголовок `X-Admin-Token` (по умолчанию `dev-admin-token`).
ИИ: `ANTHROPIC_API_KEY` в `.env`; без ключа ИИ-эндпоинты отвечают 503.

## Правила

- Суммы — целые сумы (UZS), размеры — мм. Ошибки — `{"error": {"code", "message", "details"}}`, сообщения по-русски.
- Сотрудник не видит себестоимость, наценки и закупочные цены: отдельные типы ответа и фильтр полей (`services/visibility.py`).
- Ссылка клиента отдаёт ровно `SharePayload` страницы `web/p/[token]`: 3D, контакты мастера, снимок сметы в выбранном виде.
  Себестоимости, процента наценки, поставщика, артикулов и комиссии там нет — это проверяют тесты.
- Дерево модулей — шкаф (`type: wardrobe`) или прямая кухня (`type: kitchen`).
- Тяжёлые операции (ИИ) — через очередь: `POST` → `202 {task_id}`, результат — `GET /tasks/{id}` →
  `{id, status: queued|running|done|failed, result, error}`. Очередь — фоновый поток в процессе API (`TASK_QUEUE_MODE=thread`), в тестах — `inline`.

## Эндпоинты

| Группа | Методы |
| --- | --- |
| auth | `POST /auth/request-code`, `POST /auth/verify-code`, `POST /auth/refresh`, `POST /auth/logout`, `GET/PATCH /auth/me` |
| workshops | `GET/PATCH /workshops/me`, `GET/PATCH /workshops/me/pricing`, `GET/POST /workshops/me/employees`, `DELETE /workshops/me/employees/{id}`, `GET /workshops/me/action-log` |
| clients | `GET/POST /clients`, `GET/PATCH/DELETE /clients/{id}` |
| projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/{id}`, `POST …/archive`, `…/unarchive`, `GET …/history`, `POST/DELETE …/photos` |
| projects: статусы | `POST …/sketch`, `POST …/measurements` (`apply_to_model`, по умолчанию да), `POST …/contract`, `POST …/deliver`, `POST …/cancel` |
| models | `GET /models/schema`, `POST /models/validate`, `GET/POST /projects/{id}/model`, `POST …/model/undo`, `…/model/redo`, `…/model/fixes`, `GET …/versions`, `GET/PATCH …/versions/{vid}`, `POST …/versions/{vid}/restore`, **`POST …/versions/{vid}/confirm`** `{pointers}`, **`GET/POST /projects/{id}/hardware`** `{key, value}` |
| estimates | `GET /projects/{id}/estimate`, `GET /projects/{id}/estimate/client?view=`, **`GET /projects/{id}/nesting`**, **`GET /projects/{id}/price-requests`**, `POST …/price-requests/{rid}/accept\|decline` |
| **ai** | `POST /projects/{id}/ai/design` `{text?, photo_ids?, language?}`, `POST …/ai/answer` `{answers}`, `POST …/ai/choose-type` `{product_kind}`, `POST …/ai/edit` `{instruction, confirm_extra_project?}` — все `202 {task_id}`; `GET /projects/{id}/chat`, `GET …/ai/budget`, `GET …/ai/design` (последний результат) |
| **files** | `GET /projects/{id}/files` (пакет и доступ), `GET /projects/{id}/files/{kind}`: `kp_pdf`, `glb_closed`, `glb_open` (бесплатно); `spec_xlsx`, `spec_pdf`, `cutmaps_pdf`, `csv`, `dxf_zip`, `drawings_pdf`, `general_view_pdf`, `assembly_pdf`, `archive` (после заказа или оплаты) |
| **catalog** | `GET /catalog/items` (цены с источником и датой — владельцу; `price_stale` — старше 14 дней), **`GET /catalog/decors`** (листовые материалы: id ядра, название, цвет, текстура, толщина, наличие) |
| **orders** | `GET /projects/{id}/orders/preview?distance_km=`, `POST /projects/{id}/orders` `{distance_km?}` (из «Договора», состав — `supplier_order` ядра), `GET /projects/{id}/orders`, **`GET /orders?status=`**, **`GET /orders/{id}`** (шаги, `payment {status: waiting\|failed\|paid, method, url}`), **`POST /orders/{id}/cancel`** (только неоплаченный) |
| **nonstandard** | `POST /projects/{id}/nonstandard` `{description, photo_ids?, differences?, path: eman\|self}`, `GET …/nonstandard`, `GET …/nonstandard/{nid}`, `POST …/{nid}/accept`, `POST …/{nid}/cancel`, `GET …/{nid}/files/{fid}` |
| **devices** | `POST /devices` `{push_token, platform, device_id?}`, `DELETE /devices?device_id=\|push_token=`, `GET /notifications`, `POST /notifications/{id}/read` |
| share | `POST/GET /projects/{id}/share-links`, `DELETE …/share-links/{id}`; публичные `GET /share/{token}` (SharePayload), `GET /share/{token}/glb/{closed\|open}`, `POST /share/{token}/events` `{event, at, meta?}` → 204, `POST /share/{token}/agree` → `{agreedAt}` |
| billing | `GET /billing/limits` |
| tasks | `GET /tasks/{task_id}` |
| admin | `POST /admin/projects/{id}/order-paid`, `POST /admin/workshops/{id}/plan`, `GET /admin/ai-requests`, `GET /admin/action-log`; **новое:** `GET /admin/dashboard`, `GET /admin/workshops`, `GET /admin/workshops/{id}`, `POST …/block`, `GET /admin/projects`, `GET /admin/projects/{id}`, `GET …/versions/{vid}`, `POST …/file-access`, `GET /admin/orders`, `GET /admin/orders/{id}`, `GET …/csv`, `POST …/hand-over`, `POST …/status`, `GET /admin/ai-stats`, `GET/PATCH /admin/settings`, `GET/POST/PATCH /admin/suppliers`, `GET/POST/PATCH /admin/catalog/items`, `GET …/items/{id}/history`, `GET/POST /admin/catalog/parser-runs`, `GET …/parser-runs/{id}`, `POST …/match`, `POST …/publish`, `GET /admin/catalog/review-queue`, `POST /admin/catalog/raw-records/{id}/review`; **ещё новее:** `POST /admin/orders/{id}/payment` `{url?, method?, failed?}`, `GET /admin/price-requests`, `POST /admin/price-requests/{id}/price`, `GET /admin/nonstandard`, `GET/PATCH /admin/nonstandard/{id}`, `POST/GET/DELETE …/files` |

## ИИ (раздел 6 PRD)

- `design` берёт фото проекта (`photo_ids` или все исходные; HEIC пропускается — Claude его не принимает).
  Результат `DesignOut`: `status` (`ready|questions|choose_type|failed`), разбор, вопросы, `objects` (рамки, если
  на фото несколько предметов), `version_id` — новая версия модели, если дерево собралось; `budget` — расширение.
- `edit` — правка словами; удачная правка — новая версия (`undo`/`redo` работают), `price_delta` — цена клиенту
  до и после (по оценочным размерам, без округления диапазона). Неудачная — версия прежняя, причина в `error`.
- Сессия `DesignSession` хранится в `ai_sessions`, чат — в `chat_messages`; `undone` вычисляется по цепочке версий.
- Журнал: каждый запрос к Claude — строка `ai_requests` (модель, токены, кэш, стоимость в микродолларах, проверка);
  сбой вызова — строка с `validation_result=error`.
- Бюджет: $0,30 на проект (админка: `ai_budget_usd`, `ai_warn_ratio`). С 80% — `budget.warning` и плашка;
  после превышения следующий ИИ-запрос → 402 `ai_budget_exceeded`, пока не придёт `confirm_extra_project: true`
  (тогда списывается ещё один проект из лимита — `extra_charges`). В примере — 402 `ai_budget_example`.
- ИИ не запускается в несписанном проекте, если лимит проектов исчерпан (402 `limit_exhausted`); примеры — без лимита.
- LLM — зависимость `deps.get_llm`; тесты подменяют её подставным клиентом (`tests/fake_anthropic.py`).

## Файлы (разделы 8–9)

КП (PDF) и GLB — бесплатно всегда. Остальное — когда по проекту оплачен заказ в EMAN (статус «В работе» / «Сдан»)
или менеджер открыл доступ (`POST /admin/projects/{id}/file-access`, оплата файлов вручную); иначе 402
«Файлы — после заказа в EMAN или оплаты». Pro — пока только флаг `pro_discount`. Сотрудник получает Excel без
себестоимости. После «Договора» — только замороженная версия. В имени файла — проект и версия, в PDF — проект,
версия и дата. Скачивания пишутся в `file_downloads`.

## Стык с приложением мастера

- **Цена в списке проектов** — `price {from, to}` из кэша версии (`model_versions.price_cache`): цена запоминается,
  когда смету посчитали (карточка, смета, предпросмотр, ссылка, правка ИИ). Список смету не считает; `null` — ещё не считали.
- **«Оценка»** — `estimated` (JSON Pointer'ы из ИИ) хранится в версии; новая версия наследует пометки, кроме изменённых
  значений; `POST …/versions/{vid}/confirm` снимает их на всех устройствах. Замер (`POST …/measurements`) применяет
  размеры к модели новой версией (`apply_measurements` ядра) и снимает «оценку» с размеров; не собирается — версия
  прежняя, причина в `apply_error`.
- **Push** (раздел 19): `notifications` пишутся в той же транзакции, что и событие; после коммита их отправляет `Notifier`
  (Expo Push API, `PUSH_PROVIDER=expo`, ключ `EXPO_ACCESS_TOKEN`; в dev — только лог). Тексты — ru/uz по языку мастера,
  в `data` — `kind`, `project_id`, а также `order_id` / `screen`. События: модель готова, а мастер ушёл (приложение не
  опрашивало задачу > 10 с), клиент открыл ссылку / запустил AR (не чаще раза в 30 мин на ссылку), заказ оплачен / принят /
  в распиле / готов / выдан / отменён (владельцу и автору), позиция «под запрос» оценена, цены устарели (смета с
  `has_stale` или новый прайс при отправленной ссылке; раз в сутки), остался 1 бесплатный проект, нестандарт оценён / готов.
  `DeviceNotRegistered` от Expo — токен стирается. В тестах — `MemoryPushSender`, сети нет.
- **Заказ** — номер с 1001; оплата на мерчант EMAN: менеджер ставит ссылку (`/admin/orders/{id}/payment`), отмечает
  «не прошла» или оплату (`/admin/projects/{id}/order-paid`). Мастер отменяет сам только неоплаченный заказ.
- **«Под запрос»** (ADM-07, SCR-30): строки сметы со статусом `request` попадают в очередь при расчёте сметы; менеджер
  вводит цену и срок → позиция каталога с `core_key` (`REQ-…`, следующие сметы считают её как каталожную), та же
  позиция в других проектах получает цену, мастеру — push. В заказ позиция идёт только после «Принять» мастера.
- **Нестандарт** (ADM-09): отправлена → оценена (цена и срок от менеджера, push) → в работе (мастер принял цену) →
  готово (файлы, push). Админка — `web/` → `/admin/nonstandard`.
- **Файлы**: `Content-Disposition` с `filename*=UTF-8''Шкаф_Азиза_спецификация_v3.pdf` (ярлык на языке мастера) и ASCII-запасным
  `filename`; в списке файлов — `file_name` и `content_type`.
- **Чат**: реплика мастера и ответ ИИ привязаны к версии — после `undo` обе `undone: true`, после `redo` — снова `false`; есть `kind`.
- **Задачи**: `GET /tasks/{id}` → `{id, status, result, error}` (`state` и `task_id` — прежние имена, остаются для совместимости).

## Каталог и парсер (раздел 7, ADM-04/05)

Поставщики, позиции (артикул, тип, размеры, декор, толщина, текстура, цена, единица, дата и источник цены, наличие),
история цен, запуски парсера и сырые записи. Источники — интерфейс `PriceSource` (`services/catalog/sources.py`):
- `CsvFileSource` — прайс файлом (рус. или англ. заголовки, `;` или `,`, UTF-8/cp1251);
- `EmanHtmlSource` — **скелет** парсера eman.uz по образцу, который мы составили сами
  (`services/catalog/samples/eman_sample.html`). Сеть не трогает, автоматически не запускается; `fetch_pages()`
  намеренно не реализован. Перед включением — разрешение владельца сайта и адаптация под настоящую разметку.

Шаги: загрузка → сопоставление (артикул, затем наименование) → изменения цены > 15% в очередь проверки →
публикация (новые, изменённые, подтверждённые цены; исчезнувшие — «нет в наличии»). Каждое изменение цены — в
историю и журнал действий.

## Заглушки

- SMS (Eskiz) и Telegram Gateway — классы есть, отправки нет (503). В dev код пишется в лог.
- S3-хранилище — заглушка; в dev файлы лежат в `MEDIA_DIR` и отдаются по `/media`.
- Очередь — потоки в процессе API, результаты в памяти (после перезапуска `task_id` теряются). Redis-воркер — позже.
- Админка — один общий токен вместо ролей из раздела 17 PRD. Ссылку на оплату и очередь «под запрос» админка `web/` пока не показывает — только API.
- Оплата файлов и Pro-скидка — без платёжной системы (флаг и ручное открытие доступа).

## Известные пробелы

- Смета ядра считает по демо-прайсу ядра, а не по опубликованному каталогу API: для этого ядру нужен вход «прайс»
  (позиции по `core_key`). Пока каталог API хранится, публикуется и показывается мастеру отдельно.
- Пересчёт сметы по новым ценам перед отправкой ссылки — по прайсу ядра; «цена устарела» (14 дней) помечается только в каталоге.
- Доп. списания за перерасход ИИ в лимит не возвращаются при заказе в EMAN.
- Замер применяется только к шкафу (кухня — вручную, ограничение ядра). Ограничение частоты публичных событий и антифрод — не сделаны.
- Push отправляется из процесса API (поток); при перезапуске неотправленные строки остаются `pending` — повторной отправки нет.
- Кэш цены в списке не сбрасывается при смене наценок цеха — обновится при следующем расчёте сметы.
- Список материалов ядра для `/catalog/decors` берётся из внутреннего `mebel_core.catalog.MATERIALS`, толщины/обрезка
  раскроя — из `mebel_core.rules` (в публичном API ядра их нет).
- Старые версии хранят дерево своей версии схемы; при смене схемы ядра нужна миграция дерева для отката.
