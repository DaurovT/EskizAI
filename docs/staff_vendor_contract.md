# Сотрудники, роли и кабинет поставщика — контракт API и веба

Статус: к реализации (2026-11-04), ред. 3 — роли поставщика (владелец бизнеса, конструктор) и суперадмин платформы (§4a). Источник требований: PRD §17 (ADM-01…ADM-14, «Роли в админке»), решения владельца:
вход по почте и паролю; пока один поставщик — EMAN, но заказ должен уметь делиться между поставщиками
(например, корпус из ЛДСП — EMAN, металлические ножки — металлоцех); кабинет поставщика — `vendor.eskizai.uz`.

## 1. Организации и роли

Сотрудник (`staff_users`) принадлежит либо **платформе** (`supplier_id = NULL`), либо **поставщику** (`supplier_id` → `suppliers`).
Мастера цехов — это `users` (вход по SMS), к сотрудникам отношения не имеют.

| Роль | Организация | Права (ключи) |
| --- | --- | --- |
| `superadmin` | платформа | всё (`*`) |
| `orders_manager` | платформа | `workshops.view`, `projects.view`, `orders.manage`, `nonstandard.manage` |
| `catalog_manager` | платформа | `catalog.manage`, `price_requests.manage`, `projects.view` |
| `support` | платформа | `workshops.view`, `workshops.grant`, `projects.view` |
| `vendor_owner` (владелец бизнеса) | поставщик | всё, что у конструктора, плюс `vendor.finance`, `vendor.analytics`, `vendor.orders.all` (все заказы и переназначение), `vendor.prices` (каталог, прайс, источник цен), `vendor.refunds.approve`, `vendor.staff`, `vendor.settings` |
| `vendor_designer` (конструктор) | поставщик | `vendor.orders.work`, `vendor.chat`, `vendor.corrections`, `vendor.returns`, `vendor.nonstandard`, `vendor.quotes` |

Подробно, что делает каждая роль поставщика, — §5.

Только `superadmin`: `staff.manage`, `suppliers.manage`, `finance`, `tariffs`, `settings`, `ai.log`, `audit.view`, `disputes`, `security`, `broadcasts`, `impersonate` — подробно в §4a.
Сотрудник поставщика видит **только данные своего поставщика** (заказы, заявки, позиции, прайс, сотрудники). Проверка — на сервере в каждом запросе.

Права вычисляются на сервере из роли (таблица выше — в коде одним словарём) и отдаются в `GET /staff/me` списком `permissions`; веб только прячет пункты меню.

## 2. Вход (почта + пароль)

- Пароль: не короче 10 символов; хеш `hashlib.scrypt` (n=2**14, r=8, p=1, соль 16 байт) — без новых зависимостей; сравнение `hmac.compare_digest`.
- Блокировка: 5 неверных паролей подряд с одного IP → вход по этой почте **с этого IP** закрыт на 15 минут (чужой IP не закрывает вход владельцу почты); плюс не больше 20 неудачных попыток с IP за 10 минут → `429 too_many_attempts`. Ответ при неверной почте, неверном пароле и закрытом входе одинаковый: `401 invalid_credentials`. Подробно — §8 «Вход и сессии».
- Почта хранится в нижнем регистре, уникальна.
- Токены: JWT с `typ: "staff"` (тот же `JWT_SECRET`, но мастерский токен не принимается в staff-ручках и наоборот). Access — 30 минут, refresh — 14 дней, ротация как у мастеров (таблица `staff_refresh_tokens`, старый отзывается).
- Сброса пароля по почте пока нет (официальной почты нет): пароль сбрасывает `superadmin` (любому) или `vendor_owner` (своим конструкторам) — выдаётся временный пароль один раз, `must_change_password = true`; пока он не сменён, доступны только `/staff/me` и смена пароля (`403 password_change_required`).
- Первый суперадмин: `python scripts/create_staff.py --email … --name … --role superadmin` (печатает временный пароль).
- Старый `X-Admin-Token` (переходный период) — суперадмин **только для чтения и повседневных дел**; в журнал пишется `actor_id = "admin-token"`. Сотрудники, «глазами мастера», запись настроек, лимитов, обслуживания, финансов, споров и все изменения поставщиков — `403 admin_token_not_allowed` (§8). Отключается `ADMIN_TOKEN_ENABLED=false` (в `deploy/.env.example` — по умолчанию); в prod при включённом токене `ADMIN_TOKEN` не короче 32 символов.

| Метод | Путь | Тело / ответ |
| --- | --- | --- |
| POST | `/staff/auth/login` | `{email, password}` → `{access_token, refresh_token, staff: StaffMe}` |
| POST | `/staff/auth/refresh` | `{refresh_token}` → `{access_token, refresh_token}` |
| POST | `/staff/auth/logout` | `{refresh_token}` → `{ok}` |
| GET | `/staff/me` | → `StaffMe` |
| POST | `/staff/me/password` | `{current_password, new_password}` → `{ok}` |

`StaffMe = {id, email, name, role, org: {kind: "platform"|"supplier", supplier_id?, supplier_code?, supplier_name?}, permissions: string[], must_change_password}`

## 3. Управление сотрудниками

| Метод | Путь | Кто |
| --- | --- | --- |
| GET | `/staff/users?supplier_id=` | `superadmin` — все; `vendor_owner` — только свои |
| POST | `/staff/users` `{email, name, role, supplier_id?}` → `{user, temp_password}` | `superadmin` — любые; `vendor_owner` — только роль `vendor_designer` в своём поставщике |
| PATCH | `/staff/users/{id}` `{name?, role?, is_active?}` | те же правила; нельзя отключить или понизить самого себя |
| POST | `/staff/users/{id}/reset-password` → `{temp_password}` | те же правила |

Владелец поставщика управляет **только конструкторами** своего поставщика (добавить, изменить, отключить, сбросить пароль, сессии, сброс 2FA). Учётные записи `vendor_owner` — в том числе второго владельца и свою — добавляет, сбрасывает и отключает только `superadmin` платформы (`POST /admin/suppliers/{id}/owner` или `/staff/users`); попытка владельца — `403`. Список `GET /staff/users` владелец видит целиком (все сотрудники своего поставщика). Почта, занятая в другой организации, — `422 cannot_create` (без подсказки, что она существует); в своём поставщике — `409 email_exists`.

## 4. Поставщики и деление заказа

- `suppliers` уже есть (`code`, `name`, …). EMAN создаётся импортом каталога (`ensure_supplier(s, "eman")`).
- Новая таблица `supplier_routes`: `category` → `supplier_id` (+ `active`). Категории — по типу строки состава заказа ядра (`sheet`, `edge`, `hardware`, `countertop`, `front`, `service`, `other`, и новые вроде `metal`, `glass`). Нет маршрута — уходит поставщику по умолчанию (`eman`).
- Оформление заказа мастером (`POST /projects/{id}/orders`): строки состава группируются по поставщику → **по одному `Order` на поставщика**, общий `group_id`. Пока все маршруты ведут в EMAN — получается ровно один заказ, как сейчас (ответ ручки для приложения не меняется; добавляются поля `group_id`, `supplier_id`, `supplier_name`).
- `orders`: новые колонки `supplier_id` (FK, заполняется миграцией по `supplier` = code), `group_id`, `vendor_status_note`. Старое поле `supplier` (code) остаётся.
- Админка: `GET/POST/PATCH /admin/suppliers`, `GET/PUT /admin/supplier-routes` (`superadmin`).

## 4a. Суперадмин платформы (`superadmin`) — главная админка

Суперадмин — владелец системы. Видит и может всё, но каждое действие пишется в журнал, а самые опасные требуют причины.

**Безопасность входа (обязательно для `superadmin`)**
- Второй фактор — одноразовый код из приложения-аутентификатора (TOTP, RFC 6238, реализация на stdlib): включается при первом входе (QR + 10 резервных кодов), без него суперадмин дальше экрана настройки не проходит. Для остальных ролей — по желанию (`security` может сделать обязательным для роли).
- `POST /staff/auth/login` для пользователя с 2FA отвечает `{mfa_required: true, mfa_token}` → `POST /staff/auth/mfa` `{mfa_token, code}` → токены. `POST /staff/me/mfa/setup` → `{otpauth_url, secret}`, `POST /staff/me/mfa/enable` `{code}` → `{backup_codes}`, `POST /staff/me/mfa/disable` `{password, code}`.
- Сессии: список входов сотрудника (время, IP, браузер), «завершить все сессии» (отзыв refresh-токенов) — для себя и для любого сотрудника (`security`). Журнал входов и неудачных попыток.
- Опасные действия (блокировка цеха или поставщика, ручное начисление, отмена оплаченного заказа, решение спора, смена комиссии, вход «глазами мастера») требуют поля `reason`; без него `422`.

**Сводка (ADM-01)** — `GET /admin/dashboard?from=&to=`: активные цеха и мастера, новые регистрации, проекты, заказы по статусам и поставщикам, оборот заказов, комиссия (начислено / сторно / получено), выручка платформы от мастеров (пакеты, Pro, файлы, возвраты), расходы на ИИ и на SMS, просроченные заказы у поставщиков (дольше N часов без ответа конструктора), открытые споры и возвраты, ошибки ИИ.

**Цеха и мастера (ADM-02)**: список и карточка (контакты, тариф, лимиты, проекты, заказы, платежи, сотрудники цеха, журнал); блокировка/разблокировка с причиной; ручное начисление проектов и продление Pro с причиной; **просмотр «глазами мастера»** только на чтение (`POST /admin/workshops/{id}/impersonate` `{reason}` → короткий токен только для чтения, все запросы помечаются в журнале); удаление аккаунта по запросу (как в приложении).

**Поставщики (ADM-14, платформа)**: создание поставщика и первого `vendor_owner` (временный пароль); реквизиты, договор (номер, даты), **ставка комиссии** (общая и по категориям, с датой начала действия — старые заказы считаются по старой ставке); маршруты категорий (§4); блокировка поставщика (новые заказы уходят по маршруту запасного поставщика или в очередь платформы); показатели поставщика: время ответа конструкторов, доля возвратов и отклонений, просрочки.

**Взаиморасчёты (ADM-10)** — `GET /admin/finance?from=&to=&supplier_id=`: по каждому поставщику — оборот, комиссия начислена / сторно, выплачено, долг; внесение выплаты поставщика (`supplier_settlements`); акт сверки (CSV) — те же цифры, что видит владелец поставщика; платежи мастеров платформе и возвраты по ним.

**Заказы (ADM-08) и споры**: все заказы всех поставщиков с фильтрами; вмешательство с причиной — сменить поставщика у заказа, назначить статус, отменить; чтение переписки по любому заказу и сообщение от имени платформы (`author_type = platform`). **Спор**: если мастер не согласен с решением поставщика по возврату или с отклонением заказа, он открывает спор (`POST /orders/{id}/disputes` из приложения) → очередь споров у суперадмина → решение (в пользу мастера: возврат/переделка за счёт поставщика; в пользу поставщика; частично) с комментарием; решение видят обе стороны, комиссия пересчитывается.

**Каталог и правила (ADM-04…07)**: каталоги всех поставщиков; подтверждение изменений цен > 15% (если поставщик сам не подтвердил за 24 часа — эскалация); модули и правила ядра (публикация/откат — позже, раздел ADM-06).

**Тарифы и лимиты (ADM-12)**: цены пакетов, Pro, файлов, бесплатный лимит; **лимиты расходов**: общий дневной лимит на ИИ, лимит на цех в день, лимит SMS в час и в сутки; аварийный выключатель ИИ и регистрации новых цехов («режим обслуживания» с текстом для приложения).

**ИИ-журнал (ADM-11)**: каждый запрос — модель, токены, стоимость, цех, проект, результат; расход по цехам и по дням; подозрительная активность (цех превысил обычный расход в N раз).

**Рассылки (ADM-13)**: push и уведомления в приложении всем мастерам или сегменту (город, тариф, активность), на ru/uz; шаблоны системных уведомлений.

**Сотрудники платформы**: создание, роли, отключение, сброс пароля, сброс 2FA (с причиной), сессии. Последнего активного `superadmin` нельзя отключить или понизить.

**Журнал действий** — `GET /admin/audit?actor=&entity=&action=&from=&to=`: всё по §6, только чтение, нельзя удалить или изменить ни через API, ни через админку.

**Ручки для суперадмина (дополнительно к существующим `/admin/*`)**: `/admin/dashboard`, `/admin/finance`, `/admin/suppliers…` (+ `/settlements`, `/commission`, `/block`), `/admin/disputes…`, `/admin/orders/{id}/messages`, `/admin/orders/{id}/intervene` `{action, reason, …}`, `/admin/workshops/{id}/impersonate`, `/admin/limits` (GET/PUT), `/admin/maintenance` (GET/PUT), `/admin/broadcasts…`, `/admin/audit`, `/staff/users/{id}/sessions` (GET, DELETE), `/staff/users/{id}/mfa/reset`.

Новые сущности: `order_disputes` (заказ, кто открыл, причина, позиции/сумма, статус `open|resolved`, решение, комментарий, кто решил), `staff_sessions` (по refresh-токенам: IP, user agent, время), `staff_mfa` (секрет, резервные коды — хеши), `supplier_commissions` (поставщик, категория или все, ставка в б.п., действует с), лимиты и режим обслуживания — в `app_settings`.

## 5. Кабинет поставщика — роли, заказ, переписка, исправления, возвраты, деньги

### 5.1 Владелец бизнеса (`vendor_owner`)
- **Взаиморасчёты с платформой** (`vendor.finance`): за период — оборот заказов из приложения (оплаченные), число заказов, средний чек, комиссия платформе (начислено по оплаченным, сторно по возвратам), к оплате платформе, уже оплачено (выплаты фиксирует суперадмин в `supplier_settlements`), долг. Выгрузка акта сверки (CSV; PDF — позже).
- **Сводка** (`vendor.analytics`): заказы по статусам и по дням, оборот, топ цехов, очередь (сколько ждут и как давно), работа конструкторов: принято / возвращено / отклонено, среднее время до принятия и до «готово», открытые заказы на каждом.
- **Все заказы** (`vendor.orders.all`): видит заказы всех конструкторов, переписку и историю, может назначить или переназначить конструктора; может делать всё, что конструктор.
- **Цены** (`vendor.prices`): ручная правка цены и наличия позиций каталога; загрузка прайса файлом с предпросмотром; **источник цен** — подключение обновления по ссылке на файл (CSV/XLSX/JSON) или по API поставщика с ключом, по расписанию (раз в день, час), кнопка «обновить сейчас», журнал запусков; изменения больше 15% ждут подтверждения владельца, остальные применяются сразу. Ключ источника хранится на сервере и в ответах API не отдаётся (только «задан»).
- **Возвраты денег** (`vendor.refunds.approve`): подтверждает сумму возврата, оформленного конструктором; после подтверждения комиссия по заказу сторнируется на эту сумму.
- **Сотрудники** (`vendor.staff`) и **настройки организации** (`vendor.settings`): реквизиты, контакты, адрес склада и самовывоза, срок производства по умолчанию, текст ссылки на оплату.

### 5.2 Конструктор (`vendor_designer`)
- **Очередь входящих заказов**: новые заказы без конструктора видны всем конструкторам поставщика; «Взять в работу» назначает на себя. Свои заказы — отдельный список.
- **Проверка заказа**: состав, раскрой, замеры, фото, 3D-модель (ссылка на просмотр версии), файлы для станка; скачивание CSV и файлов.
- **Решение по заказу**:
  - «Принять» — заказ проверен; конструктор указывает сумму счёта (`invoice_total`, по умолчанию — по смете) и срок готовности → мастер получает уведомление и ссылку на оплату;
  - «Вернуть мастеру» — нужна правка (ошибка в замерах, не тот декор…), обязательный комментарий; мастер исправляет проект и отправляет заказ заново;
  - «Отклонить» — выполнить нельзя, обязательная причина (из списка + текст); заказ закрыт.
- **Исправление** (`vendor.corrections`): конструктор сам правит заказ — меняет строки состава (кол-во, позиция, цена), прикладывает исправленные файлы (раскрой, ЧПУ) и комментарий. Если сумма или состав изменились, мастер должен **подтвердить исправление** в приложении (до подтверждения заказ ждёт); отказ мастера возвращает к переписке.
- **Переписка с мастером** (`vendor.chat`): чат внутри заказа (текст + фото/файлы), мастер видит его в приложении и получает push; непрочитанные — счётчик в кабинете.
- **Производство**: статусы «в раскрое» → «готов» → «выдан/отгружен».
- **Возвраты и рекламации** (`vendor.returns`): по оплаченному заказу — брак, ошибка раскроя, недовложение, отмена после оплаты: причина, строки/сумма, фото; решение — переделать за счёт поставщика, вернуть деньги (сумму подтверждает владелец), отказать с объяснением. Мастер видит статус возврата в приложении.
- **Нестандарт** (`vendor.nonstandard`): оценка цены и срока, «в работе», загрузка доработанных файлов.
- **Позиции без цены** (`vendor.quotes`): цена для конкретного заказа/сметы (разовая), в общий каталог не пишется — каталог меняет только владелец.

### 5.3 Статусы заказа
`created` (отправлен поставщику, в очереди) → `accepted` (проверен, счёт выставлен) → `paid` → `cutting` → `ready` → `issued`.
Побочные: `returned` (возвращён мастеру на правку → после повторной отправки снова `created`), `awaiting_approval` (ждёт подтверждения исправления мастером → `accepted`), `rejected` (отклонён поставщиком, финал), `cancelled` (отменён мастером до оплаты).
Совместимость: старый порядок `created → paid → accepted` (оплата до проверки, как сейчас делает менеджер в админке) остаётся допустимым переходом. Каждый переход пишется в историю заказа (кто, когда, комментарий) и в `action_log`; мастеру — уведомление.

### 5.4 Новые сущности
- `order_messages`: `order_id`, `author_type` (`master` | `vendor` | `platform`), `author_id`, `text`, `attachments` (ключи файлов), `created_at`, `read_by_master_at`, `read_by_vendor_at`.
- `order_events`: история статусов и действий по заказу (тип, кто, комментарий, данные).
- `order_corrections`: `order_id`, автор, комментарий, `lines_before`, `lines_after`, `total_before`, `total_after`, файлы, статус (`pending` | `approved` | `declined`), решение мастера и время.
- `order_returns`: `order_id`, тип (`defect` | `cut_error` | `shortage` | `cancel_after_pay` | `other`), строки, сумма, фото, описание, решение (`redo` | `refund` | `declined`), статус (`open` | `awaiting_owner` | `resolved`), `refund_amount`, кто подтвердил.
- `orders`: + `assignee_id` (конструктор), `due_date`, `reject_reason`.
- `supplier_settlements`: выплаты поставщика платформе (период, сумма, дата, комментарий) — вносит суперадмин.
- `supplier_price_sources`: тип (`file_url` | `api`), URL, формат, сопоставление колонок, секрет (не отдаётся), расписание, активен; запуски — в существующую `parser_runs`. Загрузка по URL: только `https`, только публичные адреса (защита от SSRF), лимит размера и времени.
- `suppliers`: + реквизиты/настройки (`settings` JSON).

### 5.5 Ручки `/vendor/*` (только сотрудники поставщика, всё — в пределах своего поставщика)
| Метод | Путь | Право |
| --- | --- | --- |
| GET | `/vendor/dashboard` (счётчики очереди, моих заказов, непрочитанных сообщений, возвратов, нестандарта, позиций без цены) | любое |
| GET | `/vendor/orders?scope=queue|mine|all&status=&q=&page=` (`all` — только с `vendor.orders.all`) | `vendor.orders.work` |
| GET | `/vendor/orders/{id}` (заказ, состав, суммы, история, цех и мастер, проект с замерами, фото, ссылка на 3D, файлы, исправления, возвраты) | `vendor.orders.work` (конструктор — свои и очередь; владелец — все) |
| POST | `/vendor/orders/{id}/take` · `/assign` `{assignee_id}` (владелец) | `vendor.orders.work` / `vendor.orders.all` |
| POST | `/vendor/orders/{id}/accept` `{invoice_total, due_date?, comment?}` · `/return` `{comment}` · `/reject` `{reason, comment}` · `/status` `{status, comment?}` | `vendor.orders.work` |
| GET/POST | `/vendor/orders/{id}/messages` (POST: `text`, файлы multipart) · `POST /vendor/orders/{id}/messages/read` | `vendor.chat` |
| POST | `/vendor/orders/{id}/corrections` `{lines_after, comment}` + файлы | `vendor.corrections` |
| POST/PATCH | `/vendor/orders/{id}/returns` · `/vendor/returns/{id}` (решение) · `POST /vendor/returns/{id}/approve-refund` (владелец) | `vendor.returns` / `vendor.refunds.approve` |
| GET | `/vendor/orders/{id}/csv` и файлы заказа | `vendor.orders.work` |
| GET/PATCH | `/vendor/nonstandard…` (как раньше) | `vendor.nonstandard` |
| GET/POST | `/vendor/price-requests…` (цена разовая) | `vendor.quotes` |
| GET/PATCH | `/vendor/catalog…`, `POST /vendor/catalog/import…` | `vendor.prices` |
| GET/PUT | `/vendor/price-source` · `POST /vendor/price-source/run` · `GET /vendor/price-source/runs` · `POST /vendor/price-source/runs/{id}/confirm` | `vendor.prices` |
| GET | `/vendor/finance?from=&to=` · `GET /vendor/finance/act.csv?from=&to=` | `vendor.finance` |
| GET | `/vendor/analytics?from=&to=` | `vendor.analytics` |
| GET/PATCH | `/vendor/settings` | `vendor.settings` |
Платформа (суперадмин): `GET/POST /admin/suppliers/{id}/settlements`, взаиморасчёты всех поставщиков в разделе «Поставщики».

### 5.6 Мастер в приложении (`/projects/{id}/orders…`, `/orders/{id}…` — токен мастера)
- Карточка заказа показывает новые статусы (`returned` с комментарием, `rejected` с причиной, `awaiting_approval`), конструктора, срок готовности.
- `GET/POST /orders/{id}/messages`, `POST /orders/{id}/messages/read` — переписка с поставщиком (push мастеру о новом сообщении).
- `GET /orders/{id}/corrections`, `POST /orders/{id}/corrections/{cid}/approve` · `/decline` `{comment?}`.
- `POST /orders/{id}/resubmit` — повторная отправка после `returned` (берёт текущую версию проекта).
- `GET /orders/{id}/returns`, `POST /orders/{id}/returns` (мастер может сам открыть рекламацию: тип, описание, фото).

## 6. Журнал действий

`action_log`: `actor_type = "staff"`, `actor_id = staff id` (для старого токена — `"admin-token"`). Пишутся: вход, неудачный вход, создание и изменение сотрудников, сброс пароля, все изменения цен, статусов заказов, нестандарта, маршрутов. В админке и в кабинете поставщика — имя сотрудника рядом с действием.

## 7. Веб

- Один Next.js (`web/`). По хосту:
  - `app.eskizai.uz` — только `/p/*` (страница клиента); `/admin` и `/vendor` — 404;
  - `admin.eskizai.uz` — главная админка (`/` → `/admin`); `/p` и `/vendor` — 404;
  - `vendor.eskizai.uz` — кабинет поставщика (`/` → `/vendor`); `/admin` и `/p` — 404.
  - Хосты — переменные `ADMIN_HOST` (по умолчанию `admin.eskizai.uz`) и `VENDOR_HOST` (`vendor.eskizai.uz`); локально (localhost) доступно всё: `/admin/*`, `/vendor/*`, `/p/*`.
  - CORS API: `https://app.eskizai.uz`, `https://admin.eskizai.uz`, `https://vendor.eskizai.uz`.
- Токены сотрудника — в `localStorage` (как сейчас у админки), автоматическое обновление по refresh; при `password_change_required` — экран смены пароля.
- Админка (§4a): вход по почте и паролю + 2FA для суперадмина (настройка с QR и резервными кодами), в шапке имя и роль, меню по `permissions`; разделы: сводка, цеха (с просмотром «глазами мастера»), поставщики (реквизиты, комиссия, маршруты, взаиморасчёты, выплаты, показатели), заказы (вмешательство с причиной, переписка), споры, каталог, тарифы и лимиты (лимиты ИИ и SMS, режим обслуживания), ИИ-журнал, рассылки, сотрудники (роли, сессии, сброс пароля и 2FA), журнал действий.
- Кабинет поставщика — по §5: у владельца — сводка, взаиморасчёты, все заказы и конструкторы, цены и источник цен, возвраты на подтверждение, сотрудники, настройки; у конструктора — очередь и мои заказы, карточка заказа (проверка, принять / вернуть / отклонить, исправление, чат с мастером, файлы, производство, возвраты), нестандарт, цены по запросу. Смена пароля у всех. Язык — русский. Стиль — как у админки (`admin.css`).

## 8. Отклонения реализации

Реализация API (миграции `0008`, `0009`, `routers/staff.py`, `routers/vendor.py`, `routers/admin_platform.py`, сервисы `staff_auth`, `order_flow`, `supplier_routes`, `finance`, `price_import`, `signed_files`, `spend_limits`). Ниже — всё, что контракт не фиксировал или что сделано иначе.

**Права старых ручек `/admin/*`** (сотрудник платформы с правом; старый `X-Admin-Token` = суперадмин; сотрудник поставщика в `/admin` — `403`):

| Ручки | Право |
| --- | --- |
| `GET /admin/dashboard` | любой сотрудник платформы (блок `period` — только с `finance`) |
| `GET /admin/workshops`, `/admin/workshops/{id}` | `workshops.view` |
| `POST /admin/workshops/{id}/plan`, `/block`, `POST /admin/projects/{id}/file-access` | `workshops.grant` (`plan` и `block` — с `reason`) |
| `GET /admin/projects…`, `/admin/projects/{id}/versions/{vid}` | `projects.view` |
| `GET/POST /admin/orders…` (список, карточка, CSV, hand-over, status, payment), `POST /admin/projects/{id}/order-paid`, `/admin/orders/{id}/messages`, `/intervene`, `/timeline` | `orders.manage` |
| `/admin/nonstandard…` | `nonstandard.manage` |
| `/admin/catalog/…` (позиции, история, парсер, очередь > 15%) | `catalog.manage` |
| `/admin/price-requests…` | `price_requests.manage` |
| `GET /admin/suppliers`, `/admin/suppliers/{id}`, `GET /admin/supplier-routes`, `GET …/commission` | `suppliers.manage`, `catalog.manage` или `orders.manage` (чтение) |
| `POST/PATCH /admin/suppliers`, `/block`, `/owner`, `POST …/commission`, `PUT /admin/supplier-routes` | `suppliers.manage` |
| `/admin/workshops/{id}/payments`, `/admin/payments/{id}/refund`, `/admin/finance…`, `…/settlements` | `finance` |
| `/admin/ai-requests`, `/admin/ai-stats` | `ai.log` |
| `/admin/action-log`, `/admin/audit` | `audit.view` |
| `GET/PATCH /admin/settings`, `/admin/maintenance` | `settings` |
| `/admin/limits` | `tariffs` |
| `/admin/disputes…` | `disputes` · `/admin/broadcasts` — `broadcasts` · `/admin/workshops/{id}/impersonate` — `impersonate` |
| `/staff/users…` (+ `sessions`, `mfa/reset`) | `staff.manage` (все) или `vendor.staff` (конструкторы своего поставщика, §3) |

**Старый `X-Admin-Token`** — только чтение и повседневные дела. `403 admin_token_not_allowed` на: `/staff/users…` (все методы), `/admin/workshops/{id}/impersonate`, все изменения поставщиков (`POST/PATCH /admin/suppliers`, `/block`, `/owner`, `/commission`, `PUT /admin/supplier-routes`) и не-GET у `/admin/settings`, `/admin/limits`, `/admin/maintenance`, финансов (`/admin/workshops/{id}/payments`, `/admin/payments/{id}/refund`, `…/settlements`) и `/admin/disputes…`. GET этих разделов, заказы, нестандарт, каталог, заявки на цену, цеха (в т. ч. `plan`/`block`) — как раньше. В prod при `ADMIN_TOKEN_ENABLED=true` нужен `ADMIN_TOKEN` не короче 32 символов.

**Вход и сессии**
- Без токена: `/admin/*` → `401 admin_required` (как раньше), `/vendor/*` и `/staff/*` → `401 staff_required`. Мастерский токен в staff-ручках и токен сотрудника в ручках мастера — `401 token_invalid`.
- Закрытый после 5 ошибок вход отвечает тем же `401 invalid_credentials` (даже с верным паролем) — по ответу нельзя понять, есть ли почта; текст ошибки говорит о блокировке на 15 минут.
- Блокировка — по паре «почта + IP» (таблица `auth_throttle`, миграция `0009`; ключ — HMAC, сами почта и IP там не хранятся): кто подбирает пароль со своего адреса, закрывает вход только себе. Счётчик меняется одним `INSERT … ON CONFLICT DO UPDATE … RETURNING`, попытка резервируется **до** проверки пароля: из пачки параллельных запросов проверяется не больше 5 паролей, остальные сразу `401`. Неизвестная почта считается так же. Колонки `staff_users.failed_logins`/`locked_until` больше не используются; `locked` в `StaffUser` — вход закрыт хотя бы с одного IP; `reset-password` снимает все блокировки сотрудника.
- Лимит на IP: не больше `STAFF_LOGIN_IP_LIMIT` (20) **неудачных** попыток за `STAFF_LOGIN_IP_WINDOW_MINUTES` (10) — отдельно для `/staff/auth/login` и `/staff/auth/mfa`; сверх — `429 too_many_attempts` (по ответу нельзя понять, есть ли почта). Удачный вход попытку возвращает.
- IP сессии и счётчиков — `request.client.host`; заголовок `X-Forwarded-For` API сам не читает. За Caddy uvicorn (`--proxy-headers`) подставляет адрес из заголовка, который Caddy (без `trusted_proxies`) ставит сам по адресу соединения; порт API наружу не открыт (`127.0.0.1`).
- Журнал: неудачный вход по неизвестной почте — `{email_hash, ip}` (HMAC вместо почты), не больше 200 таких записей в час; превышение лимита IP — одна запись `login_throttled`/`mfa_throttled` за окно.
- Refresh: ротация условным `UPDATE … WHERE id = :jti AND revoked_at IS NULL` — из одного refresh получается не больше одной новой пары. Повтор уже использованного refresh позже `STAFF_REFRESH_REUSE_GRACE_SECONDS` (5 с) после ротации завершает **всю сессию** (все её refresh, access → `401 session_revoked`), в журнал — `refresh_reuse`; в эти 5 с (две вкладки обновили одновременно) — просто `401 token_revoked`.
- Каждый вход — запись `staff_sessions` (IP, user agent); access-токен несёт `sid`, отозванная сессия — сразу `401 session_revoked`. `GET/DELETE /staff/me/sessions` — свои сессии (DELETE — все, кроме текущей).
- `POST /staff/me/password` завершает остальные сессии сотрудника, текущая остаётся. Сброс пароля, сброс 2FA и отключение сотрудника завершают все его сессии. Свой пароль через `reset-password` — `409 self_reset`.
- `StaffMe` дополнен: `role_title`, `mfa_enabled`, `mfa_required`, `mfa_setup_required`. Суперадмину `permissions` = `["*", …все ключи платформы]`. Права `vendor.*` суперадмину не даются: кабинет поставщика — только сотрудникам поставщика (`403`).
- 2FA: пока не включена там, где обязательна, все ручки, кроме `/staff/me`, `/staff/me/password`, `/staff/me/mfa/*`, `/staff/me/sessions`, отвечают `403 mfa_setup_required` (после смены временного пароля). Обязательность для других ролей — настройка `mfa_required_roles` (`PATCH /admin/settings`). Неверный код — `401 invalid_mfa_code`; 5 неверных кодов подряд → второй шаг для сотрудника закрыт на 15 минут (`401 invalid_credentials`; счётчик свой, резерв попытки до проверки, как у пароля). Повтор уже использованного кода не принимается, резервный код — один раз; списание — условным `UPDATE` (`last_step`, `staff_mfa.version`), два параллельных запроса с одним кодом не проходят оба. `mfa_token` одноразовый (`staff_mfa_challenges`): после входа, завершения сессий, сброса/смены пароля и сброса 2FA — `401 invalid_credentials`; неверный код его не сжигает. `POST /staff/me/mfa/setup` идемпотентен: повтор в течение 10 минут (двойной клик, две вкладки) возвращает тот же секрет, позже — новый; включение (`enable`) — один раз. `POST /staff/auth/mfa` отвечает как `login`.
- Ответ `POST /staff/auth/login` всегда содержит `mfa_required` (`false` — сразу токены и `staff`).
- `GET /staff/users` → `{items, total}` (`?scope=platform|suppliers`, `?q=`); `PATCH` принимает `reason`. Последнего активного суперадмина нельзя отключить или понизить — `409 last_superadmin`; себя — `409 self_demote`. Чужие сотрудники для `vendor_owner` — `404`.
- `X-Admin-Token`: в журнал — `actor_type = "staff"`, `actor_id = "admin-token"`; поле `reason` для него не обязательно (переходный период); что ему закрыто — см. выше. Все прочие записи сотрудников — `actor_type = "staff"`, в выдаче журнала есть `actor_name`.
- Первый суперадмин: `python scripts/create_staff.py --email … --name … --role superadmin [--supplier код] [--database-url …]`.

**Поставщики и заказ**
- Ответ `POST /projects/{id}/orders` дополнен `group_orders: [{id, number, supplier_id, supplier, status, total}]` (основной заказ — поставщика по умолчанию). Доставка, позиции «под запрос» и вес — у основного заказа группы.
- Маршрут на заблокированного поставщика → поставщик по умолчанию; заблокирован и он → заказ без поставщика (`supplier_id = null`, `supplier = "platform"`) — очередь платформы, переносится `intervene`/`change_supplier`. Сотрудники заблокированного поставщика получают `403 supplier_blocked`.
- Нестандарт `path = "self"` поставщику не уходит (`supplier_id = null`); `path = "eman"` — по маршруту категории `nonstandard`. Миграция так же заполнила существующие заявки.
- Комиссия считается при оплате и хранится в заказе: `orders.commission_amount`, `orders.commission_reversed` (новые колонки). Ставка — средневзвешенная по категориям строк на дату оформления заказа (`supplier_commissions`, иначе `suppliers.commission_bp`), применяется к сумме счёта. Сторно — отмена после оплаты (целиком), подтверждённый возврат и решение спора (пропорционально сумме). Добавлены также `orders.accepted_at`, `orders.return_comment`.
- `POST /admin/suppliers` принимает `owner: {email, name}` → в ответе `owner: {user, temp_password}`; отдельно `POST /admin/suppliers/{id}/owner`. Комиссия: `GET/POST /admin/suppliers/{id}/commission` (`{rate_percent, category?, effective_from?, reason}`); смена общей ставки через `PATCH /admin/suppliers/{id}` — тоже с `reason`. `GET /admin/suppliers/{id}` — реквизиты (`settings`), ставки, маршруты, сотрудники, `metrics` (время ответа, доля возвратов и отклонений, просрочки). `PUT /admin/supplier-routes` `{routes: [{category, supplier_id, active}]}` заменяет набор целиком.
- `/admin/finance` → `{suppliers: [SupplierFinance], totals, platform_payments}`; акт сверки — `GET /admin/finance/act.csv?supplier_id=&from=&to=` (у поставщика — `/vendor/finance/act.csv`). `from`/`to` — даты `YYYY-MM-DD` по Ташкенту (`to` включительно), по умолчанию — текущий месяц. `SupplierFinance = {supplier, from, to, orders, turnover, avg_check, commission: {accrued, reversed, due}, refunds, settled, debt, balance: {due, settled, debt}}`.
- `/admin/orders/{id}/intervene` `{action: change_supplier|set_status|cancel, reason, supplier_id?, status?, comment?}` (`comment` уходит сообщением от платформы). `GET /admin/orders/{id}/timeline` — история, исправления, возвраты, споры. `/admin/orders/{id}/status` работает как раньше (старый порядок); заказ, принятый поставщиком до оплаты, оплачивается через `order-paid`; отмена оплаченного — с `reason`.
- Споры: `GET /admin/disputes?status=open|resolved` → `{items}`; `POST /admin/disputes/{id}/resolve` `{resolution, refund_amount?, comment, reason}`; `comment` — решение (видят обе стороны, у мастера — `decision_comment`). `reason` — отдельное обязательное поле для журнала (`comment` причиной не считается; без `reason` сотрудник получает `422 reason_required`). Сумма всех возвратов денег по заказу (возвраты «вернуть деньги» в `awaiting_owner`/`resolved` + решённые споры) не больше суммы заказа (счёт, иначе смета) — иначе `422 invalid_refund` с `details: {max_refund, order_total}`; то же в `PATCH /vendor/returns/{id}` и `POST …/approve-refund`.
- «Глазами мастера»: ответ `{access_token, expires_in, read_only: true, user_id, workshop_id}` — обычный access-токен мастера с пометками `imp`/`ro`, 15 минут; не-GET → `403 impersonation_read_only`; каждый запрос — в журнал (`entity = impersonation`).
- Лимиты — `GET/PUT /admin/limits` `{ai_daily_usd_global, ai_daily_usd_per_workshop, ai_anomaly_factor, sms_per_hour, sms_per_day, vendor_overdue_hours}` (0 — без лимита); режим обслуживания — `GET/PUT /admin/maintenance` `{maintenance_on, maintenance_until, maintenance_message_ru|uz, ai_enabled, registration_enabled, reason}`. Ошибки для приложения: `503 ai_disabled`, `503 ai_daily_limit`, `429 ai_workshop_daily_limit`, `429 sms_limit`, `503 registration_closed` (приглашённые номера проходят).
- Рассылки: `POST /admin/broadcasts` `{title_ru, body_ru, title_uz?, body_uz?, segment: {city?, plan?, active_days?, roles}, dry_run?}` → `{id, recipients, sent}`; хранятся в журнале действий (`GET /admin/broadcasts`), отдельной таблицы нет. Push `kind = broadcast`.
- `/admin/audit?actor=&entity=&action=&from=&to=&workshop_id=&page=` → `{items, total, page, page_size}`; изменяющих ручек у журнала нет.
- Сводка `/admin/dashboard` прежняя + `period` для суперадмина; `/admin/ai-stats` + `by_day`, `suspicious`; `/admin/catalog/review-queue` + `supplier_id`, `escalated` (поставщик не подтвердил за 24 ч).

**Кабинет поставщика**
- Решения — отдельными ручками: `accept` (`{invoice_total?, due_date?, comment?, payment_url?}`; без `payment_url` берётся `settings.payment_url` поставщика), `return` (`{comment}`), `reject` (`{reason, comment}`, коды `reason` — как в §9: `no_material`, `wrong_measurements`, `cannot_produce`, `duplicate`, `other`; код — в `orders.reject_reason`, текст — в `vendor_status_note`). `POST …/status` — только оплата и производство: `accepted → paid` (поставщик получил оплату: проект «В работе», комиссия), `paid → cutting → ready → issued`; старый порядок `paid → accepted` — через `accept`. Иное — `409 illegal_order_transition` с `details.allowed`; `accepted|returned|rejected` в `/status` — `422 use_action`. Карточка отдаёт `allowed_statuses`.
- Конструктор видит очередь (`created` без конструктора) и свои заказы; чужие — `404`. Заказ без конструктора в любом другом статусе (например, оплачен платформой по старому порядку) конструктору — тоже `404`: его назначает владелец. Решение по свободному заказу назначает его на себя. `POST /assign` `{assignee_id|null}` — владелец. `PATCH /vendor/orders/{id}` `{invoice_total?, payment_url?, notes?, due_date?}` оставлен.
- Списки `/vendor/orders`, `/vendor/nonstandard`, `/vendor/price-requests`, `/vendor/catalog` → `{items, total, page, page_size}`; `/vendor/returns`, `…/corrections`, `…/messages` → `{items}` (+ `unread_count` у сообщений).
- Дополнительно: `GET /vendor/orders/{id}/model` (3D версии заказа), `GET /vendor/orders/{id}/files/{kind}` (`csv`, `cutmaps_pdf`, `spec_pdf`, `dxf_zip`, `drawings_pdf`, `invoice`), `GET /vendor/returns?status=`, `GET /vendor/catalog/{id}/history`, `GET /vendor/catalog/import/{preview_id}`, `GET /vendor/nonstandard/{id}/files/{file_id}`.
- Исправление: multipart `lines_after` (JSON-строка `[{key?, name, unit?, qty, price}]`), `comment`, повторяющееся `files`. Состав или сумма не изменились — исправление сразу `applied`, иначе `pending` и заказ `awaiting_approval` (мастеру push `order_correction`). Исправление — только до оплаты.
- Возвраты: `POST /vendor/orders/{id}/returns` (multipart `type`, `description`, `amount?`, `lines?`, `files`); `PATCH /vendor/returns/{id}` `{decision: redo|refund|declined, comment, refund_amount?}` (`refund` → `awaiting_owner`); `POST /vendor/returns/{id}/approve-refund` `{amount?}` (владелец) → `resolved`, сторно комиссии.
- `/vendor/price-requests/{id}/price` `{price, lead_days?, note?, valid_until?}` — разовая цена, каталог не меняется. Позиции «под запрос» уходят поставщику по маршруту категории строки (миграция отдала существующие EMAN).
- Загрузка прайса: CSV (`;`/`,`), XLSX (openpyxl уже есть в зависимостях через `mebel-core`) и JSON; колонки — `sku;name;price;available` или русские названия; для известного артикула `name` можно не указывать. Предпросмотр = запуск парсера (`parser_runs`, `preview_id` = id запуска), живёт 1 час (`410 preview_expired`). Ответ: `{preview_id, status, created, changed, big_changes, missing, errors, unchanged, hide_missing, expires_at, published_at}`; `big_changes` — подмножество `changed`. «Пропавшие» только показываются; скрыть их — поле формы `hide_missing=true`. XLSX до разбора проверяется как zip: распакованный размер не больше 50 МБ, файлов в архиве не больше 1000, степень сжатия файла больше 1 МБ — не больше 100 (иначе `413 file_too_large`); читаются не больше 20 000 строк и 100 колонок. То же — для XLSX из источника цен.
- Источник цен: `PUT /vendor/price-source` `{kind: file_url|api, url, format: csv|xlsx|json, mapping: {поле: колонка}, secret?, schedule: off|hourly|daily, active}`; ключ в ответах — только `secret_set`; для `api` ключ уходит заголовком `Authorization: Bearer`, ответ — JSON-список. Только `https`, все IP имени — публичные, без редиректов, лимит 10 МБ (по `Content-Length` и по мере чтения) и 20 с на всю загрузку целиком (`422 invalid_source_url|source_forbidden`, `502 source_unreachable|source_http_error`, `413 source_too_large`, `504 source_timeout` — у запуска в `error`). Соединение — с IP, проверенным до запроса (имя — в `Host` и SNI, сертификат проверяется по имени), поэтому DNS rebinding не проходит. Кроме непубличных адресов запрещены IPv4-совместимые и IPv4-mapped IPv6 (`::127.0.0.1`, `::ffff:…`), NAT64 `64:ff9b::/96`, 6to4, Teredo, `168.63.129.16` (Azure), `100.100.100.200`. `POST /vendor/price-source/run` больше не ждёт загрузку: запуск создаётся сразу в статусе `running` (ответ — тот же объект запуска), загрузка и разбор — фоновой задачей; итог — в `GET /vendor/price-source/runs`. Второй запуск, пока идёт первый (до 10 минут), — `409 run_in_progress`. Расписание: `scripts/run_price_sources.py` по cron или `PRICE_SOURCE_SCHEDULER=true` (поток в процессе API; по умолчанию выключен).
- `/vendor/settings` — `{id, code, name, site_url, settings, commission_percent}`; `PATCH {name?, site_url?, settings?}`, ключи `settings`: `legal_name, inn, bank, account, mfo, contract_number, contract_date, contacts, phone, email, warehouse_address, pickup_address, default_lead_days, payment_url, payment_text`.
- `/vendor/dashboard` — счётчики по правам: `queue`, `queue_oldest_hours`, `mine`, `awaiting_payment`, `in_production`, `unread_messages`, `returns_open`, `refunds_awaiting` (владелец), `nonstandard`, `price_requests`, `price_review`.

**Приложение мастера (§9)** — реализовано по §9 со следующими уточнениями:
- Вложения (`Attachment.url`) — подписанные ссылки `/signed-files/{token}` (2 часа; подделка или мусор — `404`, истекла — `410 link_expired`); токен входа не нужен. Токен непрозрачный: ключ хранилища, имя и тип зашифрованы и подписаны ключами, выведенными из `JWT_SECRET` (не JWT; ссылки старого формата после обновления — `404`, приложение и веб просто перезапрашивают список). Формат ответа (`{key, url, name, content_type, size}`) прежний; `key` — id файла, не ключ хранилища.

**Закрытые файлы и выгрузки (аудит безопасности)**
- Хранилище делится на публичную зону (`/media/…`: фото проектов — страница клиента `/p`, логотипы цехов; текстуры — `/static/textures`) и закрытую `MEDIA_DIR/private/…` (ключи `private/…`): вложения переписки по заказу (мастер, поставщик, платформа), фото и файлы возвратов, споров, исправлений, файлы «нестандарта». Закрытые файлы `/media` не отдаёт никогда (в т. ч. `PRIVATE/…`, `../`) — только `/signed-files/{token}` и ручки с проверкой доступа (`/vendor/nonstandard/{id}/files/{fid}`, `/projects/{id}/nonstandard/{rid}/files/{fid}`, `/admin/nonstandard/{id}/files/{fid}`). Том `media` в Docker прежний.
- Уже сохранённые файлы переносит `python scripts/move_private_media.py [--dry-run]` (идемпотентно; в Docker — `docker compose exec api python scripts/move_private_media.py`), выполнить один раз после выкладки.
- Тип загруженного файла определяется по содержимому (PNG, JPEG, WebP, GIF, HEIC, PDF): `content_type` вложения — найденный тип; заявленный клиентом `image/*` без картинки внутри, а также HTML/SVG/XML/JS — `application/octet-stream`. Логотип цеха — только если внутри действительно JPEG/PNG/WebP (`415 unsupported_image`), расширение — по содержимому. Имя файла в ключе хранилища — ASCII, расширение из белого списка (иначе `.bin`); показываемое имя (`name`) — без путей.
- Отдача загруженных файлов (подписанные ссылки, файлы «нестандарта»): в браузере открываются (`inline`) только PNG/JPEG/WebP по содержимому, остальное — `Content-Disposition: attachment` с типом по содержимому или `application/octet-stream`; всегда `X-Content-Type-Options: nosniff` и `Content-Security-Policy: sandbox`. На `/media` и `/static/textures` — те же два заголовка, всё, кроме `.png/.jpg/.jpeg/.webp`, — `attachment`.
- CSV-выгрузки (акт сверки `…/finance/act.csv`, CSV онлайн-кроя у мастера, поставщика и в админке): ячейка-строка, начинающаяся с `=`, `+`, `-`, `@`, табуляции или перевода строки, получает впереди `'` (защита от формул); числа не меняются. Общий помощник — `mebel_core/exports/csv_safe.py`.
- Заказ, поделённый между поставщиками: второй поставщик получает в CSV, DXF, картах раскроя, спецификации и чертежах деталей только детали из листов своих строк (нет таких — `409 no_parts`); основной (поставщик по умолчанию) — все, кроме листов, ушедших другим. Не ограничены (остаётся): 3D-модель версии (`/vendor/orders/{id}/model`), фото и замеры проекта в карточке.
- `ENV=prod`: `/docs`, `/redoc`, `/openapi.json` не публикуются (`404`); `/health` → `{"status": "ok"}` без `env` (приложению для проверки связи нужен только код 200).
- `OrderOut` дополнительно: `accepted_at`, `can_resubmit`, `pending_correction_id`. `events` — только типы из §9 (внутренние «взял», «назначил» — в кабинете поставщика). `actor_type` событий: `master | vendor | platform | system`.
- `POST /orders/{id}/returns` и `/disputes` принимают необязательное поле `amount` (сумма, которую просит мастер). В `OrderDispute.amount` — решённая сумма после решения, до решения — запрошенная (`requested_amount` — всегда запрошенная).
- `OrderReturn.created_by` — `master | vendor`; `number` — порядковый номер возврата в заказе.
- `POST /orders/{id}/resubmit` берёт **текущую** версию проекта (мастер исправил модель новой версией после «Вернуть мастеру») и делает её договорной (`projects.frozen_version_id`), чтобы файлы и смета проекта совпадали с заказом; `OrderOut.version_id` — новая версия.
- `GET /orders/{id}/messages` → `{items, unread_count}`; `POST /orders/{id}/messages/read` → `{ok, marked}`.
- Push: `order_message`, `order_return` (`data.return_id`, `status`, `decision`), `order_dispute` (`data.return_id?`, `status`; `screen = order_returns` для спора по рекламации, `order` — по отклонению), `order_status` (`data.status`), `order_correction` — у всех `data.order_id`; отключаются вместе с переключателем «Заказ» в настройках уведомлений.
- Ошибки вне списка §9: отмена оплаченного — `409 order_not_cancellable` (как раньше), спор по возврату без `return_id`/неверные коды — `422 validation_error`.

**Вход по SMS, расходы ИИ и права мастера (аудит безопасности и расходов)**
- `POST /auth/request-code`: к прежним лимитам на номер (пауза, 5 в час) добавлены — для номеров **без аккаунта** — лимиты на IP (`AUTH_CODE_IP_PER_10MIN=5`, `AUTH_CODE_IP_PER_DAY=20`; IP — как его видит uvicorn за Caddy, `--proxy-headers`) и на блок из 10 000 номеров `+99890123xxxx` (`AUTH_CODE_PREFIX_PER_HOUR=10`, `AUTH_CODE_PREFIX_PER_DAY=30`) → `429 code_limit`. Новые номера тратят не больше `SMS_NEW_NUMBERS_SHARE=0.7` общего лимита SMS (`sms_per_hour`/`sms_per_day`) → `429 sms_limit`; остаток — только для входа существующих мастеров, поэтому накрутка новыми номерами не закрывает вход всем. IP пишется в `auth_codes.ip` (миграция `0011`).
- Регистрация закрыта (`registration_enabled = false`) → `503 registration_closed` уже на `request-code`, **до** отправки SMS; приглашённые номера и существующие мастера проходят (на `verify-code` проверка тоже осталась).
- Попытка кода списывается атомарно до сравнения (`UPDATE … SET attempts = attempts + 1 WHERE attempts < max`) и коммитится сразу; параллельные догадки не обходят 5 попыток; верный код гасится условным `UPDATE` — дважды им не войти. Суточная блокировка номера: `AUTH_CODE_MAX_FAILURES_PER_DAY=15` неверных кодов за 24 ч → `429 code_locked` и на `verify-code`, и на `request-code`. Коды — по-прежнему 5 цифр.
- Код разработчика `00000` — только при `ENV=dev` **и** `AUTH_CODE_PROVIDER=dev`; `ENV=dev` с публичным `PUBLIC_API_URL` (не localhost / частная сеть / `*.local` / имя без точки) — API не стартует.
- Сработавший лимит SMS или ИИ — `ERROR` в лог и запись журнала `actor_type = system`, `entity = limits`, `action = cap_hit`, `entity_id` — какой лимит (не чаще раза в час на лимит).
- «Попробовать на примере»: `POST /projects/example` → `201` новый пример из шаблона сервера (шкаф-купе, модель v1, ширина — «оценка») или `200` действующий пример цеха; удалённый пример можно создать заново, но не больше `EXAMPLE_PROJECTS_MAX=3` за всё время (`409 example_limit`). Флаг `is_example` в `POST /projects` устарел: клиентские данные он больше не принимает и отдаёт тот же пример цеха (совместимость со старыми сборками). ИИ в примерах — общий бюджет на все примеры цеха `AI_EXAMPLE_BUDGET_USD=0.10` (`402 ai_budget_example`).
- `POST /projects/{id}/ai/answer`: не больше 50 ответов, ответ до 500 символов (`422`); в ИИ уходят только ответы на вопросы последнего распознавания, уже отвеченные и `object`, прочие id отбрасываются (ничего не осталось — `422 no_answers`).
- ИИ: одна задача на проект — пока она в очереди или выполняется, новые `ai/*` по проекту → `409 ai_busy`. Перед постановкой резервируется `AI_TASK_RESERVE_USD=0.05` на задачу (резерв задач в очереди учитывается в лимитах). Дневной лимит цеха — не больше `AI_WORKSHOP_MAX_SHARE=0.2` общего (и при `ai_daily_usd_per_workshop = 0`); у нового цеха (без оплат платформе, Pro и оплаченных заказов) — не больше `AI_NEW_WORKSHOP_DAILY_USD=1`. Часовой лимит цеха: `AI_WORKSHOP_HOURLY_USD=2` / новый — `AI_NEW_WORKSHOP_HOURLY_USD=0.5` → `429 ai_workshop_hourly_limit`. Общий дневной лимит для новых цехов закрывается на `1 − AI_PAYING_RESERVE_SHARE` (70 %) — остаток только платящим (`503 ai_daily_limit`).
- Права в заказе: переписка (`GET/POST …/messages`, `…/messages/read`), возвраты, споры, исправления (список и решения), `resubmit` — владелец или сотрудник с `can_order` (иначе `403`). Суммы (`amount`, `refund_amount`, `requested_amount`, `total*`, `delta`, цены строк исправлений, суммы в `events[].data`) — только с правом «видит себестоимость»; без него `amount` в новых возвратах и спорах игнорируется. Подтвердить исправление — только с этим правом (`403`). Комиссия платформы в `events[].data` мастеру не отдаётся.
- Техработы (`maintenance_on`): кроме изменений `/projects/*`, `503 maintenance` получают изменения `/orders/*` (сообщения, `resubmit`, возвраты, споры, решения по исправлениям, отмена) и `/ai/*`; `POST /orders/{id}/messages/read` работает.
- `POST /projects/{id}/photos`: тип фото определяется по содержимому (JPEG, PNG, WebP, HEIC), заявленный `Content-Type` не учитывается; не картинка — `415 unsupported_photo`; `content_type` и расширение в `url` — найденный тип. Ответ прежний.
- Push: в тексте статуса — имя поставщика заказа («Заказ №1001 принят поставщиком EMAN Materials», без поставщика — без имени); «Цены поставщика изменились» вместо «Цены EMAN». «Вернуть мастеру» (и сообщение платформы при вмешательстве) — один push `order_status` с комментарием в тексте, без второго `order_message` (сообщение в переписке остаётся).

## 9. Форматы для приложения мастера (зафиксированы реализацией app/, сервер должен совпасть)

- `OrderOut` (+ поля): `supplier_id`, `supplier_name`, `group_id`, `invoice_total`, `due_date`, `assignee: {id, name} | null`, `vendor_status_note` (комментарий при `returned`/`rejected`), `reject_reason` (код: `no_material`, `wrong_measurements`, `cannot_produce`, `duplicate`, `other`), `unread_count`, `returns_count`, `disputes_count`, `events: OrderEvent[]`.
- `OrderEvent = {id, type, status?, actor_type: master|vendor|platform|system, actor_name?, comment?, data?, created_at}`; типы: `status_changed`, `correction_created|approved|declined`, `resubmitted`, `return_opened|decided`, `dispute_opened|resolved`.
- Списки (`messages`, `corrections`, `returns`, `disputes`) — `{items: [...]}`.
- `resubmit`, `corrections/{cid}/approve`, `corrections/{cid}/decline` (`{comment: string|null}`) → обновлённый `OrderOut`. `POST /orders/{id}/messages/read` — тело `{}`.
- Multipart, фото/файлы — повторяющееся поле `files`:
  - `POST /orders/{id}/messages`: `text`;
  - `POST /orders/{id}/returns`: `type`, `description`, `lines` (JSON-строка `[{key?, name, unit?, qty}]`);
  - `POST /orders/{id}/disputes`: `subject` (`return`|`rejection`), `return_id` (для `return`), `reason` (`decision_unfair`, `amount_wrong`, `defect_not_accepted`, `can_be_done`, `other`), `comment`.
- `GET /orders/{id}/disputes` — список споров по заказу.
- `Attachment = {key, url, name?, content_type?, size?}`; `url` — абсолютный или от корня API, открывается без токена (подписанная ссылка с ограниченным сроком).
- `OrderMessage = {id, order_id, author_type, author_id?, author_name?, text, attachments, created_at, read_by_master_at?, read_by_vendor_at?}`.
- `OrderCorrection = {id, order_id, author_name?, comment, lines_before, lines_after: [{key?, name, unit?, qty, price?, total?}], total_before, total_after, files, status, master_comment?, decided_at?, created_at}`.
- `OrderReturn = {id, order_id, number?, type, description, lines, amount?, photos, status, decision, decision_comment?, refund_amount?, created_by?, created_at, decided_at?}`.
- `OrderDispute = {id, order_id, subject, return_id?, reason, comment, photos, status: open|resolved, decision?: master|supplier|partial, decision_comment?, amount?, created_at, resolved_at?}`.
- Ошибки: `409 illegal_transition | correction_decided | order_not_paid | return_not_decided | dispute_exists`, `422 validation`.
- Push `data`: всегда `order_id`; `kind`: `order_message` → чат; `order_return`, `return_opened`, `return_decided` → возвраты; `order_dispute`, `dispute_resolved` (+ `return_id?`); `order_status` (+ `status`), `order_correction` → карточка заказа.
- Мастер может открыть возврат по заказам `paid`, `cutting`, `ready`, `issued` (и `accepted`, если оплата отмечена); спор — один на отклонение и один на каждый решённый возврат.
