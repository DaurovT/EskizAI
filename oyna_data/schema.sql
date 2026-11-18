-- Eskiz Oyna — схема базы (PostgreSQL). Черновик для старта разработки.
-- Справочники (catalog_*, systems, passports, rules…) общие для всех цехов.
-- Всё, что принадлежит цеху, имеет company_id.

-- ===== Аккаунты (общие для семейства Eskiz) =====
CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  phone         text,
  logo_url      text,
  mode          text NOT NULL DEFAULT 'manufacturer' CHECK (mode IN ('manufacturer','dealer')), -- сам варю / заказываю у производителя
  dealer_coef   numeric(6,3),            -- для dealer: материалы × (1 + coef)
  markup_kind   text NOT NULL DEFAULT 'percent' CHECK (markup_kind IN ('percent','per_m2')),
  markup_value  numeric(12,2) NOT NULL DEFAULT 0,
  usd_rate      numeric(12,2),           -- свой курс; NULL = курс ЦБ
  install_gap_mm int NOT NULL DEFAULT 20,     -- монтажный шов с каждой стороны: рама = проём − 2 × шов
  rounding_sum  int NOT NULL DEFAULT 1000,
  lang_default  text NOT NULL DEFAULT 'ru' CHECK (lang_default IN ('ru','uz')),
  skew_warn_mm  int NOT NULL DEFAULT 10,      -- FR-M5: порог перекоса проёма
  demo_prices   boolean NOT NULL DEFAULT true,  -- новый цех стартует на ДЕМО-ценах (метка «ДЕМО» на КП), выключает владелец
  waste_pct     numeric(5,2) NOT NULL DEFAULT 10, -- отход профиля в цене позиции (FR-P2)
  quote_price_check_days int NOT NULL DEFAULT 14,   -- FR-Q5: через сколько дней проверять рост цен при «Согласен»
  inn           text,                         -- реквизиты для КП
  address       text,
  plan          text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),  -- брендированное КП, раскрой — pro -- true: где нет цены, берётся demo_price_sum + предупреждение D.1 + метка «ДЕМО» на КП
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text UNIQUE NOT NULL,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_members (
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner','manager','measurer','installer','production')),
  discount_limit_pct numeric(5,2) DEFAULT 0,
  PRIMARY KEY (company_id, user_id)
);

-- ===== Каталог =====
CREATE TABLE systems (
  code            text PRIMARY KEY,           -- akfa__6000_qvt
  brand           text NOT NULL,
  series          text NOT NULL,
  material_class  text NOT NULL,              -- pvc | alu_cold | alu_thermo | sill | ...
  passport_class  text,                       -- pvc_60 | pvc_70 | alu_cold | alu_thermo
  colors          text[] NOT NULL DEFAULT '{}',
  usable_for_calc boolean NOT NULL DEFAULT false,
  fitting_groove  text                        -- euro_pvc | euro_alu | alu_plain — совместимость с наборами фурнитуры
);

CREATE TABLE passports (
  class     text PRIMARY KEY,                 -- pvc_60 …; позже: код конкретной системы
  data      jsonb NOT NULL,                   -- см. passports.json
  verified  boolean NOT NULL DEFAULT false
);

CREATE TABLE price_versions (
  id          serial PRIMARY KEY,
  source      text NOT NULL,                  -- romchi_demo_2026-11 | supplier:<name>
  loaded_at   timestamptz NOT NULL DEFAULT now(),
  note        text
);

CREATE TABLE catalog_items (
  id            text PRIMARY KEY,             -- it00001
  system_code   text REFERENCES systems(code),
  brand         text NOT NULL,
  material_class text NOT NULL,
  article       text NOT NULL,                -- название как у поставщика
  role          text NOT NULL,                -- frame | sash | mullion | door_* | bead_* | reinforcement | seal | fit_* | sill | other …
  unit          text NOT NULL,                -- bar | m | kg | pcs | m2 | pack (бухта, вес в pack_kg)
  unit_confirmed boolean NOT NULL DEFAULT false,
  pack_kg       numeric(8,3),                 -- для unit = pack: вес упаковки, цена за кг = цена / pack_kg
  pack_m        numeric(8,1),                 -- для unit = pack: длина в упаковке, м (если указана)
  sill_depth_cm int,
  needs_review  boolean NOT NULL DEFAULT false
);

CREATE TABLE item_prices (
  price_version_id int REFERENCES price_versions(id),
  item_id     text REFERENCES catalog_items(id),
  color       text NOT NULL,                  -- 'Белый', 'Ламинация', … или '—'
  price_sum   numeric(14,2),                  -- NULL = «нет цены»
  demo_price_sum numeric(14,2),               -- ДЕМО-цена для позиций без цены (только при companies.demo_prices)
  demo_basis  text,                           -- как посчитана демо-цена
  updated     date,
  PRIMARY KEY (price_version_id, item_id, color)
);

-- Цены цеха поверх базовых (меняет только свои позиции)
CREATE TABLE company_prices (
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  item_id     text REFERENCES catalog_items(id),
  color       text NOT NULL,
  price_sum   numeric(14,2) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, item_id, color)
);

CREATE TABLE company_systems (               -- с какими системами работает цех
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  system_code text REFERENCES systems(code),
  PRIMARY KEY (company_id, system_code)
);

CREATE TABLE glass_types (
  code          text PRIMARY KEY,             -- g4_16_4
  formula       text NOT NULL,
  thickness_mm  int NOT NULL,
  glass_mm_total int NOT NULL,
  weight_kg_m2  numeric(6,2) NOT NULL
);

CREATE TABLE glass_prices (                   -- прайс стекольщика; company_id NULL = базовый
  company_id   uuid REFERENCES companies(id) ON DELETE CASCADE,
  glass_code   text REFERENCES glass_types(code),
  price_sum_m2 numeric(14,2) NOT NULL,
  min_area_m2  numeric(6,3) NOT NULL DEFAULT 0.3,
  shaped_extra_pct numeric(5,2) DEFAULT 0,
  status       text,                           -- найдено | оценка (ДЕМО) | от стекольщика
  source       text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fitting_systems (               -- паспорта наборов фурнитуры (fitting_systems.json)
  code        text PRIMARY KEY,               -- fornax | generic | maco_mm | alu_tr_a3400 | alu_uz | fapim_galicube
  data        jsonb NOT NULL                  -- grooves, materials, openings, sash_w/h_mm, max_sash_kg…
);

CREATE TABLE fitting_rules (
  id            serial PRIMARY KEY,
  code          text UNIQUE,                  -- fornax.tilt_turn.drive_gr02 — на него ссылается setup.options / cell.options
  option_group  text,                         -- handle | hinge | hinge_cap | security | extra_lock — варианты одной детали
  is_default    boolean,                      -- вариант по умолчанию в группе
  fitting_system text NOT NULL,               -- generic | fapim_galicube | …
  opening       text NOT NULL,                -- tilt_turn | turn | tilt | door | sliding
  part_code     text NOT NULL,
  part_name     text NOT NULL,
  item_id       text REFERENCES catalog_items(id), -- привязка к позиции каталога (может быть NULL до разметки)
  w_from int, w_to int, h_from int, h_to int,
  demo_price_sum numeric(14,2),               -- ДЕМО-цена детали без позиции каталога
  qty_expr      text NOT NULL DEFAULT '1',    -- число, выражение от w, h, или 'cams' (сумма цапф)
  cams          int,                           -- запорных цапф у детали (для подсчёта ответных планок)
  when_expr     text,                          -- handle | hinge=left | weight>100 | …
  status        text,                          -- найдено | каталог Maco | правило 3.3 | типовое | ДЕМО-формула
  source        text
);

CREATE TABLE reinforcement_map (             -- какой металл к какому профилю (reinforcement_map.csv)
  system_code   text REFERENCES systems(code),
  profile_role  text NOT NULL,                -- frame | sash | mullion | door_frame | door_sash | door_mullion | shtulp
  item_id       text REFERENCES catalog_items(id),
  thickness_mm  numeric(4,2),
  is_default    boolean NOT NULL DEFAULT false,
  status        text,
  PRIMARY KEY (system_code, profile_role, item_id)
);

CREATE TABLE decors (                         -- декоры для клиента → ценовые группы прайса (decors.json)
  id          text PRIMARY KEY,
  data        jsonb NOT NULL
);

CREATE TABLE glass_pricing (                  -- надбавки для своей формулы стеклопакета (glass_formula.json)
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = базовые
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE extra_products (                 -- сопутствующие: сетки, жалюзи, рольставни
  id            serial PRIMARY KEY,
  company_id    uuid REFERENCES companies(id) ON DELETE CASCADE, -- NULL = справочный
  category      text NOT NULL,
  name          text NOT NULL,
  unit          text NOT NULL,                -- pcs | m2 | m
  price_sum     numeric(14,2),
  includes_install boolean,
  source_url    text
);

CREATE TABLE work_rates (
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  work_code   text NOT NULL,                  -- install | dismantle | slopes | …
  unit        text NOT NULL,
  price_sum   numeric(14,2) NOT NULL,
  PRIMARY KEY (company_id, work_code)
);

CREATE TABLE kits (                           -- комплектации цеха: «Эконом», «Стандарт», «Тёплый»
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  setup       jsonb NOT NULL                  -- {"system":…, "color_out":…, "color_in":…, "glass":…, "fittings":…}
);

CREATE TABLE templates (
  id          text PRIMARY KEY,               -- T01 … или uuid для шаблонов цеха
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE, -- NULL = системный
  name        text NOT NULL,
  kind        text NOT NULL,
  default_w   int, default_h int,
  root        jsonb NOT NULL
);

-- ===== Вход (код по SMS, как в Eskiz Temir) =====
CREATE TABLE auth_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,                  -- +998XXXXXXXXX
  code_hash   text NOT NULL,                  -- HMAC(секрет, телефон:код) — сам код не хранится
  attempts    int NOT NULL DEFAULT 0,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX ON auth_codes (phone, created_at DESC);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

-- Разметка ролей каталога вручную (очередь role = other, FR-C2): поверх автоматической из build.py
CREATE TABLE catalog_role_overrides (
  item_id     text PRIMARY KEY REFERENCES catalog_items(id),
  role        text NOT NULL,
  unit        text,
  by_user     uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ===== Заказы =====
CREATE TABLE clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  name        text,
  phone       text,
  telegram    text,
  lang        text DEFAULT 'ru'
);

CREATE TABLE orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  client_id   uuid REFERENCES clients(id),
  address     text,
  floor       int,
  status      text NOT NULL DEFAULT 'measure' CHECK (status IN ('measure','quoted','agreed','production','ready','installed','closed','cancelled')),
  discount_pct numeric(5,2) DEFAULT 0,
  works       jsonb NOT NULL DEFAULT '{}',    -- доставка, этаж, работа снаружи
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  client_rev  bigint NOT NULL DEFAULT 0,      -- для синхронизации офлайн-замера
  kit_name    text,                           -- выбранная комплектация заказа («Стандарт»)
  quote_outdated boolean NOT NULL DEFAULT false -- позиции менялись после согласования — нужно новое КП
);

CREATE TABLE order_positions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid REFERENCES orders(id) ON DELETE CASCADE,
  sort        int NOT NULL DEFAULT 0,
  doc         jsonb NOT NULL,                 -- изделие целиком (модель в PRD, раздел 6)
  photos      text[] DEFAULT '{}',
  accepted_warnings jsonb NOT NULL DEFAULT '[]', -- [{"rule":"2.3","by":uuid,"at":ts}]; копия doc.accepted_warnings для запросов и листа цеха — источник истины doc, сервер обновляет при сохранении
  rev         bigint NOT NULL DEFAULT 1,      -- ревизия для синхронизации офлайн-замера (PRD 5)
  summary     jsonb NOT NULL DEFAULT '{}',    -- кэш расчёта для списка заказов: total, area_m2, units, can_quote, complete, demo
  deleted     boolean NOT NULL DEFAULT false, -- удаление тоже синхронизируется
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE extra_lines (                    -- строки сопутствующих товаров в заказе
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid REFERENCES orders(id) ON DELETE CASCADE,
  name        text NOT NULL,
  unit        text NOT NULL,
  qty         numeric(10,3) NOT NULL,
  price_sum   numeric(14,2) NOT NULL,             -- цена за единицу для клиента
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (                         -- версии КП с замороженными ценами
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid REFERENCES orders(id) ON DELETE CASCADE,
  version     int NOT NULL,
  price_version_id int REFERENCES price_versions(id),
  usd_rate    numeric(12,2),
  lang        text NOT NULL,
  variants    jsonb NOT NULL,                 -- до 3 комплектаций: позиции, итоги, цены
  public_token text UNIQUE NOT NULL,          -- ссылка для клиента
  demo        boolean NOT NULL DEFAULT false, -- в КП есть ДЕМО-цены (метка на странице и PDF)
  sent_at     timestamptz,
  accepted_at timestamptz,
  accepted_variant int,                       -- какой вариант комплектации выбрал клиент («Согласен»)
  revoked_at  timestamptz,                    -- ссылку отозвали — клиент видит «предложение недоступно»
  UNIQUE (order_id, version)
);

CREATE INDEX ON catalog_items (system_code, role);
CREATE INDEX ON orders (company_id, status, updated_at DESC);
CREATE INDEX ON order_positions (order_id);
CREATE INDEX ON quotes (order_id, version DESC);
