# Eskiz DWG → Eskiz Mebel — контракт API (вход и «Входящие чертежи»)

Статус: реализовано на стороне API (2026-11-16). Eskiz DWG (бесплатный просмотрщик DWG на телефоне) входит в аккаунт мастера Eskiz Mebel и отправляет ему чертежи. Формат пакета — `eskiz-dwg/docs/package_format.md` (формат 1).
Экран «Входящие чертежи» в приложении Eskiz Mebel — следующий шаг (API уже готово, ручки ниже принимают и обычный токен мастера).

## 1. Вход

1. `POST /auth/request-code` `{phone, channel: "sms"}` — как в приложении мастера. Аккаунт для запроса кода не нужен; лимиты для номеров без аккаунта (IP, блок номеров, доля SMS) — те же. Если регистрация закрыта аварийным выключателем, номеру без аккаунта и без приглашения — `503 registration_closed` (SMS не тратится).
2. `POST /auth/verify-code` `{phone, code, create: false, scope: "dwg_upload"}` → `TokensOut` (`access_token`, `refresh_token`, `expires_in`, `user`, `scope: "dwg_upload"`).
   - Нет аккаунта с этим номером → `404 account_not_found` «Аккаунт с этим номером не найден — зарегистрируйтесь в приложении Eskiz Mebel». Не создаётся ничего: ни пользователя, ни цеха, приглашение в цех не трогается. **Код при этом погашен** — повторить его нельзя (ни с `create: false`, ни с `create: true`), для нового входа — новый код.
   - Код проверяется до всего остального: неверный — `400 code_invalid` (попытка списана, `details.attempts_left`), устарел — `400 code_expired`, много попыток — `429 code_attempts` / `code_locked`.
   - Аккаунт отключён владельцем цеха — `403 user_inactive`; цех заблокирован — `403 workshop_blocked` на любой ручке.
   - `device_id` / `platform` / `push_token` при `scope: "dwg_upload"` игнорируются: устройство не регистрируется, push Eskiz Mebel на него не идут. Поле `invite` в ответе всегда `null`.
3. `POST /auth/refresh` `{refresh_token}` → новая пара **с той же областью** (область хранится в `refresh_tokens.scope`): из `dwg_upload` полный токен не получить. Access — 30 минут, refresh — 30 дней, ротация как у мастера.
4. `POST /auth/logout` `{refresh_token}` → `{ok: true}`.

Поля `create` (по умолчанию `true`) и `scope` (по умолчанию `"full"`) необязательны — приложение мастера работает как раньше.

## 2. Ограниченный токен (`scope: "dwg_upload"`)

Claim `scp` в access-токене (нет claim — старый полный токен). Принимают его **только**:

| Метод | Путь |
| --- | --- |
| GET | `/auth/me` |
| POST | `/auth/refresh`, `/auth/logout` (по refresh-токену) |
| POST, GET | `/inbox/drawings` |
| GET, DELETE | `/inbox/drawings/{id}` |

Любая другая ручка мастера → `403 scope_limited` (тот же код, что у Eskiz Temir). Проверка централизованная и запрещающая по умолчанию (`deps.get_current_user`): ручка разрешает ограниченный токен только явно (`InboxCurrentDep`); тест обходит все маршруты приложения и сверяет список. Ручки сотрудников (`/staff/*`, `/admin/*`, `/vendor/*`) токен мастера не принимают вообще (`401`).

## 3. Входящие чертежи

Видит **только загрузивший пользователь** — не цех, не владелец цеха, не другие аккаунты. Чужой, удалённый и истёкший чертёж — одинаково `404 not_found`.

### `POST /inbox/drawings` — загрузить пакет
multipart, одно поле `file` — пакет `.eskiz` (zip). → `201 InboxDrawing`.
Тот же пакет (тот же sha256 файла), уже лежащий во входящих этого пользователя, — `200` с прежним чертежом (повтор после обрыва связи не плодит копий и не тратит квоту; имя файла остаётся первым).

Проверка пакета (одна функция `services/inbox.parse_manifest`): zip с `manifest.json` (≤ 256 КБ, JSON-объект) и обязательными полями `format = "eskiz"`, `format_version` (целое; сейчас принимается `1`), `source.sha256` (64 hex, нижний регистр), `source.kind`, `title` (строка), `files` (объект). Неизвестные поля не проверяются и хранятся как есть. `source.dwg|dxf` и `data.json` не распаковываются и не сверяются с `source.sha256`.

Превью: хранится **одно** — первого отмеченного листа (`sheets[].selected`, иначе `selected_sheets`), иначе первого листа с превью, иначе превью модели (`model_preview` / `previews/model.webp`). Только WebP (по сигнатуре), ≤ 5 МБ; нет или битое — чертёж принимается без превью.

### `GET /inbox/drawings?limit=50&offset=0` — мои входящие
Новые сверху. → `{items: InboxDrawing[], total, limit, offset}` (`limit` 1…200, как в других списках API).

```json
{"id": "6f1c…", "title": "Кухня Азизы", "filename": "Кухня.eskiz", "size": 1583666,
 "sha256": "<sha256 пакета>", "created_at": "2026-11-16T15:00:00Z", "last_opened_at": null,
 "expires_at": "2027-02-14T15:00:00Z", "preview_url": "/signed-files/<токен>",
 "sheet_count": 8, "units_guessed": false, "units_note": null,
 "package_created_at": "2026-11-16T14:40:10.000344+00:00"}
```
`sheet_count` — `manifest.stats.sheets`; `units_guessed` — `units.source == "guessed"` (показать «проверьте размеры» и `units_note`); `package_created_at` — `manifest.created_at` как в пакете (строка). `sha256` — хэш загруженного пакета, не `source.sha256`.

### `GET /inbox/drawings/{id}` — открыть
Отмечает `last_opened_at` и продлевает `expires_at` до «сейчас + 90 дней». → `InboxDrawing` + 
```json
{"sheets": [{"number": "25", "name": "Схема расположения ферм…", "selected": true, "preview_url": "/signed-files/…"},
            {"number": "26", "name": "…", "selected": false, "preview_url": null}],
 "manifest": { "...": "manifest.json целиком" },
 "download_url": "/signed-files/<токен>"}
```
`preview_url` листа — только у листа, превью которого сохранено (см. выше); у остальных `null`.

### `DELETE /inbox/drawings/{id}` → `{ok: true}`
Мягкое удаление: из списка сразу; файл удаляется сразу, если тот же пакет не лежит живым у другого пользователя.

### Ссылки
`preview_url`, `download_url` — подписанные непрозрачные ссылки `/signed-files/{token}` (путь от адреса API), открываются без токена входа. Превью — 1 час (`image/webp`, inline), пакет — 30 минут (`application/zip`, attachment). Истекла — `410 link_expired`: заново `GET /inbox/drawings` или `GET /inbox/drawings/{id}`.

### Ошибки

| Код | HTTP | Когда |
| --- | --- | --- |
| `account_not_found` | 404 | verify-code с `create: false`, аккаунта нет |
| `scope_limited` | 403 | ограниченный токен на ручке приложения мастера |
| `file_too_large` | 413 | пакет больше 50 МБ (отсекается по Content-Length до разбора тела или по мере приёма) |
| `bad_package` | 422 | `details.reason`: `empty`, `not_zip`, `no_manifest`, `manifest_invalid`, `manifest_too_large`, `format`, `format_version`, `source`, `title`, `files` |
| `unsupported_package` | 422 | `format_version` не из поддерживаемых; `details: {format_version, supported: [1]}` |
| `inbox_quota_exceeded` | 409 | нет места; `details: {used, limit, size}` (байты) |
| `upload_limit` | 429 | больше 60 загрузок за 24 часа (удалённые считаются) |
| `not_found` | 404 | чужой / удалённый / истёкший чертёж |
| `validation_error` | 422 | нет поля `file` |

## 4. Лимиты и хранение

- Пакет — до 50 МБ (`INBOX_MAX_BYTES`); 60 загрузок в сутки на пользователя (`INBOX_UPLOADS_PER_DAY`); квота — 2 ГБ живых чертежей на пользователя (`INBOX_QUOTA_BYTES`).
- Срок — 90 дней с загрузки или последнего открытия (`INBOX_RETENTION_DAYS`). Чистка — `scripts/prune_inbox.py` (cron раз в сутки): файлы удалённых и истёкших чертежей, если на них не осталось живых строк; истёкшие строки — сразу, удалённые — через сутки.
- Файлы — в закрытой зоне хранилища (`private/inbox/<aa>/<sha256>/package.eskiz`, `…/preview.webp`), по `/media` не отдаются. Одинаковые байты у разных пользователей — один файл (только кэш хранилища): строки, квота и видимость — у каждого свои; загрузка и удаление одного sha256 на Postgres — под advisory-блокировкой.
- Удаление аккаунта Eskiz Mebel удаляет и его входящие чертежи (строки и файлы, если они больше ни у кого не живые).
- `workshop_id` в таблице `inbox_drawings` — на будущее (общие входящие цеха), сейчас пустой.

## 5. Позже

- Возобновляемая загрузка (tus / chunked с `Upload-Offset`) — сейчас пакет одним запросом.
- Превью каждого листа (сейчас хранится одно), сверка `source.sha256` с `source.dwg`, перечитывание пакетов по `converter.version`.
- Экран «Входящие чертежи» в приложении Eskiz Mebel.

## «Открыть в Eskiz DWG» из проекта (SCR-54, макет `MOpenDwg`) — следующий шаг

Договорённость с командой DWG (16.11.2026), в приложении Mebel ещё не сделано:
- ссылка `eskizdwg://open?src=<URL-encoded https-ссылка на файл>&name=<имя файла>`; `src` — наша подписанная ссылка (`*.eskizai.uz`, https, файл до 100 МБ). Можно передать `.eskiz` из «Входящих»: DWG возьмёт из него `source.*`;
- проверка, что DWG установлен: `Linking.canOpenURL("eskizdwg://")`; в `app/app.json` → `ios.infoPlist.LSApplicationQueriesSchemes: ["eskizdwg"]` (нужна новая сборка);
- не установлен — экран со ссылкой на App Store (ссылку DWG пришлёт после публикации, пока заглушка).
