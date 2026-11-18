"""Курс доллара ЦБ Узбекистана (cbu.uz) — для цехов без своего курса (companies.usd_rate = NULL).

Кэш в памяти на 6 часов. OYNA_FX_FIXED=12010.45 — фиксированный курс (тесты, работа без сети).
"""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import date

import httpx

log = logging.getLogger("oyna_api.fx")
URL = "https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/{day}/"
_cache: dict = {}
_lock = threading.Lock()


def usd() -> dict | None:
    """{'rate': 12010.45, 'date': '2026-11-18', 'source': 'cbu'} или None, если курс недоступен."""
    fixed = os.environ.get("OYNA_FX_FIXED")
    if fixed:
        return {"rate": float(fixed), "date": date.today().isoformat(), "source": "fixed"}
    with _lock:
        if _cache.get("at", 0) > time.time() - 6 * 3600:
            return _cache["value"]
    try:
        r = httpx.get(URL.format(day=date.today().isoformat()), timeout=5)
        row = r.json()[0]
        value = {"rate": float(row["Rate"]), "date": row["Date"], "source": "cbu"}
    except Exception as e:                                   # нет сети или ЦБ ответил не так — без курса
        log.warning("курс ЦБ недоступен: %s", e)
        value = _cache.get("value")
    with _lock:
        _cache.update(value=value, at=time.time())
    return value
