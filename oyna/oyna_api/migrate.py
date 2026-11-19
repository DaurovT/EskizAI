"""Схема базы при старте API: oyna_data/schema.sql идемпотентный и накатывается на существующую базу.

deploy/api-entrypoint.sh применяет схему только к пустой базе (и грузит справочники). Новые таблицы и колонки
(ALTER … ADD COLUMN IF NOT EXISTS) живой базе доносит этот модуль: при старте каждого процесса, под advisory-локом
(несколько воркеров uvicorn), с lock_timeout, и только если файл схемы изменился с прошлого раза (sha в schema_state).
Пустая база не трогается — её готовит entrypoint (схема + seed_import.py).
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from . import store

log = logging.getLogger("oyna_api.migrate")
SCHEMA = Path(__file__).resolve().parent.parent / "oyna_data" / "schema.sql"
LOCK_KEY = 0x0A1E5C4E  # pg_advisory_xact_lock: один процесс накатывает, остальные ждут и видят sha


def migrate() -> str:
    """'applied' | 'up-to-date' | 'empty-db' | 'no-dsn' | 'failed: …' — ошибка не роняет API."""
    if not store.dsn():
        return "no-dsn"
    sql = SCHEMA.read_text(encoding="utf-8")
    sha = hashlib.sha256(sql.encode()).hexdigest()
    try:
        with store.conn() as c:
            c.execute("SET lock_timeout = '10s'")
            c.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
            if not c.execute("SELECT to_regclass('public.companies') AS t").fetchone()["t"]:
                return "empty-db"
            c.execute("CREATE TABLE IF NOT EXISTS schema_state (id int PRIMARY KEY, sha text NOT NULL, "
                      "applied_at timestamptz NOT NULL DEFAULT now())")
            row = c.execute("SELECT sha FROM schema_state WHERE id = 1").fetchone()
            if row and row["sha"] == sha:
                return "up-to-date"
            c.execute(sql)
            c.execute("INSERT INTO schema_state (id, sha) VALUES (1, %s) ON CONFLICT (id) "
                      "DO UPDATE SET sha = EXCLUDED.sha, applied_at = now()", (sha,))
        log.warning("схема базы обновлена (schema.sql %s)", sha[:12])
        return "applied"
    except Exception as e:                                   # API работает и со старой схемой; повтор — при следующем старте
        log.error("схема базы не обновлена: %s", e)
        return f"failed: {e}"
