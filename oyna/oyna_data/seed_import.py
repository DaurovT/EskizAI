"""Загрузка демо-данных Eskiz Oyna в PostgreSQL.

Использование:
    pip install psycopg[binary]
    psql "$DATABASE_URL" -f schema.sql
    python seed_import.py "$DATABASE_URL"

Повторный запуск не дублирует справочники: ключевые — ON CONFLICT DO NOTHING, базовые цены стекла,
правила фурнитуры и сопутствующие товары перезаливаются. Демо-цех создаётся один раз.
Цены грузятся в новую версию прайса при каждом запуске.
"""
import csv
import json
import sys
from pathlib import Path

import psycopg

HERE = Path(__file__).parent


def main(dsn: str) -> None:
    with psycopg.connect(dsn) as con, con.cursor() as cur:
        # системы
        for r in csv.DictReader(open(HERE / "systems.csv", encoding="utf-8")):
            cur.execute(
                """INSERT INTO systems (code, brand, series, material_class, passport_class, colors, usable_for_calc, fitting_groove)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (code) DO NOTHING""",
                (r["system_code"], r["brand"], r["series"], r["material_class"],
                 r["passport_class"] or None, [c for c in r["colors"].split("|") if c],
                 r["usable_for_calc"] == "1", r["fitting_groove"] or None),
            )

        # паспорта
        passports = json.load(open(HERE / "passports.json", encoding="utf-8"))
        for cls, data in passports.items():
            if cls.startswith("_"):
                continue
            cur.execute(
                "INSERT INTO passports (class, data, verified) VALUES (%s,%s,%s) ON CONFLICT (class) DO NOTHING",
                (cls, json.dumps(data, ensure_ascii=False), bool(data.get("verified"))),
            )

        # каталог + цены
        cur.execute(
            "INSERT INTO price_versions (source, note) VALUES (%s,%s) RETURNING id",
            ("romchi_demo_2026-11", "Демо-цены, собраны вручную из приложения Romchi"),
        )
        pv = cur.fetchone()[0]
        for r in csv.DictReader(open(HERE / "catalog_items.csv", encoding="utf-8")):
            cur.execute(
                """INSERT INTO catalog_items (id, system_code, brand, material_class, article, role, unit,
                                              unit_confirmed, pack_kg, pack_m, sill_depth_cm, needs_review)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""",
                (r["item_id"], r["system_code"], r["brand"], r["material_class"], r["article"], r["role"],
                 r["unit"], r["unit_confirmed"] == "1", float(r["pack_kg"]) if r["pack_kg"] else None,
                 float(r["pack_m"]) if r["pack_m"] else None,
                 int(r["sill_depth_cm"]) if r["sill_depth_cm"] else None, r["needs_review"] == "1"),
            )
            cur.execute(
                """INSERT INTO item_prices (price_version_id, item_id, color, price_sum, demo_price_sum, demo_basis, updated)
                   VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (pv, r["item_id"], r["color"], r["price_sum"] or None, r["demo_price_sum"] or None,
                 r["demo_price_basis"] or None, r["price_updated"] or None),
            )

        # базовые справочники без ключа — перезаливаются целиком, чтобы повторный запуск не дублировал
        cur.execute("DELETE FROM glass_prices WHERE company_id IS NULL")
        cur.execute("DELETE FROM fitting_rules")
        cur.execute("DELETE FROM reinforcement_map")
        cur.execute("DELETE FROM glass_pricing WHERE company_id IS NULL")
        cur.execute("DELETE FROM extra_products WHERE company_id IS NULL")

        # стеклопакеты + базовые цены (company_id NULL); «оценка» — ДЕМО, цех заменяет своим прайсом
        for r in csv.DictReader(open(HERE / "glass.csv", encoding="utf-8")):
            cur.execute(
                """INSERT INTO glass_types (code, formula, thickness_mm, glass_mm_total, weight_kg_m2)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT (code) DO NOTHING""",
                (r["glass_code"], r["formula"], int(r["thickness_mm"]), int(r["glass_mm_total"]),
                 float(r["weight_kg_m2"])),
            )
            if r["price_sum_m2"]:
                cur.execute(
                    """INSERT INTO glass_prices (company_id, glass_code, price_sum_m2, min_area_m2, shaped_extra_pct, status, source)
                       VALUES (NULL,%s,%s,%s,%s,%s,%s)""",
                    (r["glass_code"], float(r["price_sum_m2"]), float(r["min_area_m2"] or 0.3),
                     float(r["shaped_extra_pct"] or 0), r["price_status"], r["price_source"] or None),
                )

        # паспорта наборов фурнитуры, декоры, надбавки своей формулы стеклопакета
        for code, data in json.load(open(HERE / "fitting_systems.json", encoding="utf-8")).items():
            if not code.startswith("_"):
                cur.execute("""INSERT INTO fitting_systems (code, data) VALUES (%s,%s)
                               ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data""",
                            (code, json.dumps(data, ensure_ascii=False)))
        dec = json.load(open(HERE / "decors.json", encoding="utf-8"))
        for d in dec["decors"]:
            cur.execute("INSERT INTO decors (id, data) VALUES (%s,%s) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
                        (d["id"], json.dumps(d, ensure_ascii=False)))
        cur.execute("INSERT INTO glass_pricing (company_id, data) VALUES (NULL,%s)",
                    (open(HERE / "glass_formula.json", encoding="utf-8").read(),))

        # правила фурнитуры; item_article → item_id (первая позиция каталога с таким названием)
        by_article, by_article_sys = {}, {}
        for r in csv.DictReader(open(HERE / "catalog_items.csv", encoding="utf-8")):
            by_article.setdefault(r["article"], r["item_id"])
            by_article_sys.setdefault((r["system_code"], r["article"]), r["item_id"])
        for r in csv.DictReader(open(HERE / "fitting_rules.csv", encoding="utf-8")):
            def num(v):
                return int(v) if v else None
            item_id = by_article.get(r["item_article"]) if r["item_article"] else None
            if r["item_article"] and not item_id:
                print("нет в каталоге:", r["item_article"])
            cur.execute(
                """INSERT INTO fitting_rules (code, option_group, is_default, fitting_system, opening, part_code, part_name,
                                              item_id, demo_price_sum,
                                              w_from, w_to, h_from, h_to, qty_expr, cams, when_expr, status, source)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (r["code"], r["option_group"] or None, (r["is_default"] == "1") if r["option_group"] else None,
                 r["fitting_system"], r["opening"], r["part_code"], r["part_name"], item_id,
                 float(r["demo_price_sum"]) if r["demo_price_sum"] else None, num(r["w_from"]),
                 num(r["w_to"]), num(r["h_from"]), num(r["h_to"]), r["qty"], num(r["cams"]),
                 r["when"] or None, r["status"], r["source"] or None),
            )

        # армирование: какой металл к какому профилю
        for r in csv.DictReader(open(HERE / "reinforcement_map.csv", encoding="utf-8")):
            item_id = by_article_sys.get((r["accessory_series"], r["item_article"]))
            if item_id:
                cur.execute("""INSERT INTO reinforcement_map (system_code, profile_role, item_id, thickness_mm, is_default, status)
                               VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                            (r["system_code"], r["profile_role"], item_id, float(r["thickness_mm"]) if r["thickness_mm"] else None,
                             r["is_default"] == "1", r["status"]))

        # сопутствующие товары (справочные)
        for r in csv.DictReader(open(HERE / "extra_products.csv", encoding="utf-8")):
            price = r["price_min_sum"] or None
            cur.execute(
                """INSERT INTO extra_products (company_id, category, name, unit, price_sum, includes_install, source_url)
                   VALUES (NULL,%s,%s,%s,%s,%s,%s)""",
                (r["category"], r["item"], r["unit"], price, r["includes_install"] == "да", r["source_url"] or None),
            )

        # шаблоны
        for t in json.load(open(HERE / "templates.json", encoding="utf-8"))["templates"]:
            cur.execute(                                   # системные шаблоны обновляются (форма, категория, short — в data)
                """INSERT INTO templates (id, company_id, name, kind, default_w, default_h, root, data)
                   VALUES (%s,NULL,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, default_w = EXCLUDED.default_w,
                     default_h = EXCLUDED.default_h, root = EXCLUDED.root, data = EXCLUDED.data
                   WHERE templates.company_id IS NULL""",
                (t["id"], t["name"], t["kind"], t["default_w"], t["default_h"],
                 json.dumps(t["root"], ensure_ascii=False), json.dumps(t, ensure_ascii=False)),
            )
        # новые работы (гибка профиля, shapes_contract.md §7) — уже созданному демо-цеху, без перезаписи его ставок
        NEW_WORKS = {"work_bend"}
        cur.execute("SELECT id FROM companies WHERE name = %s ORDER BY created_at LIMIT 1",
                    (json.load(open(HERE / "demo_company.json", encoding="utf-8"))["company"]["name"],))
        row = cur.fetchone()
        if row:
            for w in csv.DictReader(open(HERE / "works_defaults.csv", encoding="utf-8")):
                if w["work_code"] in NEW_WORKS and w["demo_price_sum"] != "":
                    cur.execute("""INSERT INTO work_rates (company_id, work_code, unit, price_sum) VALUES (%s,%s,%s,%s)
                                   ON CONFLICT (company_id, work_code) DO NOTHING""",
                                (row[0], w["work_code"], w["unit"], float(w["demo_price_sum"])))
        # демо-цех: настройки, работы (ДЕМО-цены), комплектации — только если его ещё нет
        demo = json.load(open(HERE / "demo_company.json", encoding="utf-8"))
        c = demo["company"]
        cur.execute("SELECT id FROM companies WHERE name = %s", (c["name"],))
        if not cur.fetchone():
            cur.execute(
                """INSERT INTO companies (name, mode, dealer_coef, markup_kind, markup_value, usd_rate, install_gap_mm,
                                           rounding_sum, lang_default, skew_warn_mm, demo_prices)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (c["name"], c["mode"], c["dealer_coef"], c["markup_kind"], c["markup_value"], c["usd_rate"],
                 c["install_gap_mm"], c["rounding_sum"], c["lang_default"], c["skew_warn_mm"], c["demo_prices"]),
            )
            cid = cur.fetchone()[0]
            for w in csv.DictReader(open(HERE / "works_defaults.csv", encoding="utf-8")):
                if w["demo_price_sum"] != "":
                    cur.execute("INSERT INTO work_rates (company_id, work_code, unit, price_sum) VALUES (%s,%s,%s,%s)",
                                (cid, w["work_code"], w["unit"], float(w["demo_price_sum"])))
            for k in demo["kits"]:
                cur.execute("INSERT INTO kits (company_id, name, setup) VALUES (%s,%s,%s)",
                            (cid, k["name"], json.dumps(k["setup"], ensure_ascii=False)))
            for code in {k["setup"]["system"] for k in demo["kits"]}:
                cur.execute("INSERT INTO company_systems (company_id, system_code) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                            (cid, code))
        con.commit()
    print("Готово")


if __name__ == "__main__":
    main(sys.argv[1])
