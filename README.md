# Eskiz Oyna — ядро расчёта

Окна и двери: модель изделия, команды редактора, проверки конструкции, спецификация, цена, варианты КП, раскрой, замены.
Продуктовые требования — [PRD_oyna.md](PRD_oyna.md); данные — [oyna_data/](oyna_data/README.md).

## Состав

| Папка / файл | Что делает |
| --- | --- |
| `oyna_core/data.py` | Справочники из `oyna_data/` (каталог, системы, паспорта, правила, фурнитура, стекло, декоры); `Company` — настройки цеха, `Company.demo()` |
| `oyna_core/model.py` | Дерево изделия, пути к ячейкам (`"1.0"`), комплектация по умолчанию, декоры → ценовая группа |
| `oyna_core/commands.py` | Команды: `create_from_template`, `set_size`, `split`, `merge`, `set_part_size`, `set_cell`, `set_fill`, `set_setup`, `set_option`, `set_extras`, `mirror`, `accept_warning`, пакет `apply` |
| `oyna_core/geometry.py` | Размеры частей, световые проёмы, створки и размер по фальцу, стёкла, импосты, вес створки |
| `oyna_core/glass.py` | Пресеты и своя формула стеклопакета (`6t-14-4i`), цена за м² |
| `oyna_core/fittings.py` | Подбор фурнитуры: размер по фальцу, цапфы → ответные планки, варианты, петли по весу, накладки по декору |
| `oyna_core/rules.py` | Проверки уровня 1 + пределы паспорта системы |
| `oyna_core/bom.py`, `price.py` | Спецификация и цена: хлысты с отходом, бухты уплотнителя, работы, наценка, дилер, округление, P.1 / D.1 / P.2 / 7.7 |
| `oyna_core/order.py`, `cutting.py` | Заказ, варианты комплектации для КП, раскрой best-fit decreasing по целым хлыстам |
| `oyna_core/alternatives.py` | Замены «в рамках существующего» с разницей в цене |
| `oyna_core/measure.py` | Мастер замера: рама по 3 замерам, перекос, опечатки |
| `oyna_core/render.py` | SVG-схема: вид изнутри/снаружи, знаки открывания по ГОСТ, размеры, подсветка нарушений |
| `oyna_api/app.py` | FastAPI поверх ядра: расчёт, справочники, замер, замены (без базы) |
| `oyna_api/auth.py`, `settings.py` | Вход по коду из SMS (Eskiz; в разработке код в лог, `00000`), access/refresh-токены, роли из `company_members`; в dev без токена — заголовки `X-Company` / `X-Role` |
| `oyna_api/company.py` | Цех: создание на первом входе (S02), настройки (S13), работы, комплектации (проверяются ядром), системы, прайс стекольщика и свои надбавки, свои цены поверх базовых (FR-C4), сотрудники |
| `oyna_api/catalog.py` | Каталог (S14): бренды → серии → позиции с ценами цеха, очередь разметки, разметка ролей администратором (`X-Admin-Token`) |
| `oyna_api/docs.py` | PDF (S12): КП (`/oyna/orders/{id}/documents/quote.pdf`, клиенту — `/q/{token}/pdf`), лист для цеха (раскрой — в Pro), монтажный лист, заявка поставщику |
| `oyna_api/orders.py`, `store.py` | Заказы, позиции с ревизиями, синхронизация офлайн-замера (409 с обеими версиями), версии КП с замороженными ценами, публичная страница `/q/{token}`, «Согласен» с проверкой роста цен |
| `tests/` | `test_cases.py` — прогон `oyna_data/test_cases.json`; `test_core.py`, `test_api.py`; `test_store.py` — полный путь заказа на PostgreSQL |

## Запуск

```bash
python3 -m venv .venv && .venv/bin/pip install pytest httpx fastapi uvicorn
.venv/bin/pip install "psycopg[binary]" pyjwt reportlab svglib
.venv/bin/pytest -q                                          # 58 тестов без базы
OYNA_TEST_DSN="host=127.0.0.1 port=5432 user=postgres dbname=postgres" .venv/bin/pytest -q   # + 6 тестов хранения, входа и цеха
# с базой: psql -f oyna_data/schema.sql; python oyna_data/seed_import.py "$DSN"
# переменные: OYNA_ENV=prod, OYNA_JWT_SECRET, OYNA_CODE_PROVIDER=eskiz, ESKIZ_EMAIL, ESKIZ_PASSWORD, OYNA_ADMIN_TOKEN, OYNA_FONT
OYNA_DSN="$DSN" .venv/bin/uvicorn oyna_api.app:app --reload --port 8030      # http://localhost:8030/docs
```

```python
from oyna_core import Catalog, Company, calc, commands
cat = Catalog()
doc = commands.create_from_template(cat, "T03", 1400, 1300)
doc = commands.set_setup(doc, color_out="golden_oak", glass="4-12-4i")
res = calc(doc, cat, Company.demo())        # violations, bom, price, geometry
```

## Как устроено

- **Ядро считает, интерфейс и ИИ вызывают команды.** Команда возвращает новое изделие; исходное не меняется.
- **Проверки — данные.** Реакция, название и пороги берутся из `rules_level1.json`; код только проверяет условие.
- **Демо-цены отдельно.** Настоящая цена — `price_sum`; демо — `demo_price_sum` и только у цеха с `demo_prices` (предупреждение D.1, метка «ДЕМО»). У настоящего цеха позиция без цены блокирует КП (P.1); оценочная цена стекла — тоже, пока цех не внесёт прайс стекольщика.
- **Себестоимость видит только владелец** (`role`).
- **Скорость:** расчёт балконного блока ≈ 1 мс (требование ≤ 300 мс).

## Ориентир цены

T03 1400×1300, Akfa Quattro 6000, Fornax, 4-12-4, демо-цех (наценка 30%), без монтажа: материалы ≈ 987 000 сум,
цена 1 283 000 сум = 705 000 сум/м² — в рыночном коридоре Akfa Quattro в Ташкенте (600 000 – 720 000 сум/м², 11.2026).

## Что найдено, пока писалось ядро

- Шаблон **T09** (балконный блок 2100×2150) с Akfa 6000 упирается в паспорт: дверь до 2000 мм, створка окна до 850 мм — блок 2.2. Это реальное ограничение системы; для Akfa 6000 нужен шаблон ниже или другая система.
- Закалённый **6t-12-4** (22 мм) в Akfa 6000 не входит — подходит **4t-12-4** (20 мм).
- У Fornax нет своих деталей для откидных фрамуг — берётся типовая откидная фурнитура (видно в расчёте).

## Дальше

- Единый аккаунт семейства Eskiz (сейчас у Oyna свои пользователи, вход как в Temir).
- Отправка КП в Telegram (сейчас — ссылка и PDF, поделиться с телефона).
- Выкладка на VPS рядом с Eskiz Mebel / Temir (своя база).
- 3D (GLB), раздвижные, составные, арки (PRD 7.12).
- Эталонные заказы цеха-партнёра для сверки ±5% (TC10).
