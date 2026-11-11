# AR — контракт сервера, страницы клиента и приложения мастера

Статус: к реализации (2026-11-11). PRD: SCR-47 (AR у мастера), WEB-4 (AR клиента), раздел 8. Макет мастера — `docs/design/ARMaster.dc.html` / `png/ARMaster.png` (три состояния: «Выбор», «Загрузка», «В AR»).

## Принципы

- AR — системный: iPhone — AR Quick Look (USDZ), Android — Google Scene Viewer (GLB). Своих AR-библиотек в приложении нет.
- Модель в AR всегда **закрытая** (двери и ящики закрыты), **масштаб 1:1 зафиксирован**, без стен/пола/потолка комнаты (они только для 3D).
- Размещение: `floor` — по умолчанию; `wall` — навесное (верхние шкафы кухни отдельно, полки, навесной шкаф: изделие, у которого нет опоры на пол). Решает ядро.
- Файлы AR строятся на сервере из версии модели и кэшируются по (версия, состояние, формат) — повторный запрос не пересобирает.

## Сервер

### Файлы
- `GET /share/{token}/glb/{state}` — уже есть (публичный, `closed|open`).
- **Новое:** `GET /share/{token}/usdz/closed` — USDZ для Quick Look (публичный, по токену ссылки клиента, как GLB). `Content-Type: model/vnd.usdz+zip`. Метры, Y вверх, `metersPerUnit = 1`, материалы `UsdPreviewSurface` с текстурами декоров (как в GLB), без подвижных узлов (закрыто).
- **Новое для мастера:** `GET /projects/{id}/ar` (токен мастера, право видеть проект) →
  ```json
  {"version_id": "…", "version_number": 4, "size_mm": [1600, 600, 2400],
   "placement": "floor" | "wall",
   "glb_url": "https://api…/ar-files/{signed}.glb",
   "usdz_url": "https://api…/ar-files/{signed}.usdz",
   "expires_at": "…"}
  ```
  Ссылки — короткоживущие подписанные (1 час, тот же механизм непрозрачных токенов, что `/signed-files/`), открываются без токена: системный AR-просмотрщик заголовки авторизации не передаёт. Текущая версия проекта; если модели нет — `409 no_model`.
- Данные ссылки клиента (`ShareGlb`): добавить `closedUsdz` (URL выше) и `placement`.

### Требования к USDZ
- Открывается в AR Quick Look на iOS 16+; размер ≤ 10 МБ для типового шкафа (текстуры ужимать до 1024 px).
- Проверка в тестах: файл — валидный zip-USDZ (первый файл — `.usdc`/`.usda`, выравнивание 64 байта), габариты сцены в метрах совпадают с моделью ±1 мм.

## Страница клиента (web)
- `ArLauncher`: `ios-src` = `closedUsdz` с сервера (больше не собирать USDZ в браузере), `ar-placement` = `placement`.

## Приложение мастера (SCR-47)
- Кнопка AR в редакторе → экран/шторка «Показать в AR» по макету: «Модель v4 · 1600 × 600 × 2400 мм, в натуральную величину»; два пункта:
  - «На этом телефоне» → `GET /projects/{id}/ar` → «Загрузка» (прогресс скачивания файла в кэш) → системный AR: iOS — открыть `usdz_url` в Quick Look; Android — Scene Viewer intent `https://arvr.google.com/scene-viewer/1.2?file=<glb_url>&mode=ar_only&resizable=false&title=…` (с запасным `intent://` и сообщением, если Scene Viewer недоступен).
  - «Клиенту на его телефон» → существующая ссылка клиента (создать, если нет) и меню «Поделиться».
- Подсказка внизу: «Наведите камеру на пол у стены и нажмите. Двери открываются в 3D-редакторе, в AR модель в закрытом виде». Для `placement: wall` — «…на стену».
- Ошибки: нет сети, `no_model`, AR не поддерживается устройством — понятные сообщения ru/uz.

## Реализация (сервер и web, 2026-11-11)

- Ядро: `mebel_core.export_usdz(result, placement=None, texture_loader=None)` (`core/src/mebel_core/exports/usdz.py`) — та же сцена, что `export_glb` «закрыто» (общий `glb.scene_items`), меши сгруппированы по материалу; `mebel_core.ar_placement(result)` → `"floor" | "wall"`; viewer model получил поле `placement`.
- Начало координат USDZ: по центру ширины; `floor` — на полу, по центру глубины; `wall` — по центру высоты, задняя плоскость на z = 0. Размещение для Quick Look — `preliminary:anchoring:type = "plane"`, `preliminary:planeAnchoring:alignment = "horizontal" | "vertical"` (как USDZExporter three.js у model-viewer).
- Кэш файлов AR: хранилище, закрытая зона `private/ar-cache/{version_id}/{rev}-{state}.{glb|usdz}` (`api/src/mebel_api/services/ar_files.py`, `CACHE_REV` — поднять при изменении сборки 3D в ядре). Кэш используют `/share/{token}/glb/{state}`, `/share/{token}/usdz/closed` и `/ar-files/…`.
- `GET /ar-files/{token}.{glb|usdz}` — `Content-Type` `model/gltf-binary` / `model/vnd.usdz+zip`, `Content-Disposition: inline; filename="eskiz_v{N}.{ext}"`, `Cache-Control: private, max-age=3600`. Подделка, чужой подписанный токен (вложения) или не то расширение — 404 `not_found`; истёк час — 410 `link_expired`; проект удалён — 404.

## Отклонения

- **USDZ без usd-core в рантайме.** `usd-core` (pxr) на linux x86_64 есть, но весит ~100 МБ в образе (236 МБ на macOS) ради одной функции, поэтому слой пишется своим кодом: текст `model.usda` + JPEG-текстуры в zip без сжатия с выравниванием 64 байта (спецификация Apple допускает usda; так же делает USDZExporter three.js, которым model-viewer раньше собирал USDZ для Quick Look в браузере). `usd-core` — только dev-зависимость (core и api) для тестов: файл открывается в `pxr`, габариты по `BBoxCache`, валидаторы `UsdValidation` (в т. ч. `UsdzPackageValidator`, `ShaderSdrCompliance`) — без ошибок. Docker-образ не меняется (`--no-dev`).
- **Текстуры.** В GLB текстур нет (только цвет), в USDZ — есть: скан декора из `TEXTURES_DIR` (`Material.texture`), перекодирован в baseline JPEG ≤ 1024 px, UV по плитке декора (`texture_size_mm`) с учётом направления рисунка детали. Покраска, фрезеровка, накладки, фурнитура, подсветка — цветом. Нет файла текстуры — цвет декора.
- **`size_mm`** в `GET /projects/{id}/ar` — `[ширина, глубина, высота]` (порядок подписи «1600 × 600 × 2400»), а `sizeMm` ссылки клиента и `viewer.size` — `[ширина, высота, глубина]`.
- **`placement: "wall"`** решается по геометрии: самая низкая деталь не ниже 300 мм от пола (ножки и цоколь — до 200 мм). В текущей схеме у кухни всегда есть нижние модули, а шкаф стоит на полу, поэтому сейчас на практике всегда `floor`; `wall` появится с навесными изделиями. Для старых версий без `viewer.placement` сервер считает размещение по дереву.
- **Android, `wall`:** Scene Viewer сам на стену не ставит — приложению для `placement: "wall"` добавить в intent `enable_vertical_placement=true`.
- **USDZ только «закрыто»:** `/share/{token}/usdz/open` — 404; `openUsdz` в `ShareGlb` не заполняется.
- `GET /projects/{id}/ar` берёт текущую версию даже если в модели есть ошибки (`ok = false`): 3D строится, AR тоже. Ссылки выдаются сразу, файлы строятся при первом скачивании (первый запрос USDZ/GLB — сборка ~0,1–1 с, дальше — из кэша).
- Кэш при удалении версии или проекта не чистится (файлы маленькие: шкаф ~0,1–0,6 МБ); ссылки на удалённый проект перестают работать сразу.
