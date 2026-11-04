"""Настройки push мастера (FR-66, Misc.dc.html «Уведомления»): типы событий и тихие часы.

- Выключенный тип — push не отправляется; строка в истории уведомлений остаётся (status=muted),
  чтобы событие было видно в приложении.
- Тихие часы (по умолчанию вкл., 22:00–08:00 по Ташкенту): push уходит сразу, но без звука
  (Expo: без `sound`, Android-канал `quiet`). Откладывать не стали: «клиент смотрит сейчас» к утру бесполезно.
- «Остался 1 проект» — служебное, не выключается.
"""

import re
from datetime import datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from ..errors import ApiError
from ..models import User

TIMEZONE = "Asia/Tashkent"

# ключ настройки → (виды уведомлений, заголовок ru, подпись ru, заголовок uz, подпись uz)
TYPES: dict[str, tuple[tuple[str, ...], str, str, str, str]] = {
    "client_opened": (("share_opened", "ar_started"), "Клиент открыл ссылку", "и запустил AR",
                      "Mijoz havolani ochdi", "va AR’ni ishga tushirdi"),
    "client_agreed": (("client_agreed",), "Клиент согласовал", "с выбранным вариантом",
                      "Mijoz rozi bo‘ldi", "tanlangan variant bilan"),
    "model_ready": (("model_ready",), "Модель готова", "если собиралась долго",
                    "Model tayyor", "agar uzoq yig‘ilgan bo‘lsa"),
    "order_status": (("order_status", "order_message", "order_return", "order_dispute", "order_correction"), "Заказ EMAN", "оплата, распил, готов",
                     "EMAN buyurtmasi", "to‘lov, kesish, tayyor"),
    "prices_stale": (("prices_stale",), "Цены изменились", "в отправленных сметах",
                     "Narxlar o‘zgardi", "yuborilgan smetalarda"),
    "price_request": (("price_request_priced",), "Пришла цена под запрос", "от EMAN или партнёра",
                      "So‘rov bo‘yicha narx keldi", "EMAN yoki hamkordan"),
    "nonstandard": (("nonstandard_estimated", "nonstandard_done"), "Нестандарт", "оценка и готовые файлы",
                    "Nostandart", "baho va tayyor fayllar"),
}
KIND_TO_TYPE = {kind: key for key, (kinds, *_) in TYPES.items() for kind in kinds}
QUIET_DEFAULT = {"enabled": True, "from": "22:00", "to": "08:00"}
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _stored(user: User) -> dict[str, Any]:
    return user.notification_settings if isinstance(user.notification_settings, dict) else {}


def type_enabled(user: User, kind: str) -> bool:
    key = KIND_TO_TYPE.get(kind)
    if key is None:
        return True
    return bool((_stored(user).get("types") or {}).get(key, True))


def quiet(user: User) -> dict[str, Any]:
    return {**QUIET_DEFAULT, **(_stored(user).get("quiet") or {})}


def _hm(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def in_quiet_hours(user: User, now: datetime) -> bool:
    q = quiet(user)
    if not q["enabled"]:
        return False
    t = now.astimezone(ZoneInfo(TIMEZONE)).time()
    start, end = _hm(q["from"]), _hm(q["to"])
    if start == end:
        return False
    if start < end:
        return start <= t < end
    return t >= start or t < end  # через полночь: 22:00–08:00


def settings_out(user: User) -> dict[str, Any]:
    uz = user.language == "uz"
    types = (_stored(user).get("types") or {})
    return {
        "types": [{"key": key, "enabled": bool(types.get(key, True)), "title": tuz if uz else tru,
                   "subtitle": suz if uz else sru}
                  for key, (_, tru, sru, tuz, suz) in TYPES.items()],
        "quiet": {**quiet(user), "timezone": TIMEZONE, "silent": True},
    }


def update(user: User, types: dict[str, bool] | None, quiet_in: dict[str, Any] | None) -> None:
    data = dict(_stored(user))
    if types:
        unknown = sorted(set(types) - set(TYPES))
        if unknown:
            raise ApiError(422, "unknown_notification_type", f"Неизвестный тип уведомлений: {', '.join(unknown)}")
        data["types"] = {**(data.get("types") or {}), **{k: bool(v) for k, v in types.items()}}
    if quiet_in:
        q = {**quiet(user), **{k: v for k, v in quiet_in.items() if v is not None}}
        for k in ("from", "to"):
            if not isinstance(q[k], str) or not _HHMM.match(q[k]):
                raise ApiError(422, "invalid_time", "Время тихих часов — в виде 22:00")
        data["quiet"] = {"enabled": bool(q["enabled"]), "from": q["from"], "to": q["to"]}
    user.notification_settings = data  # новый объект — JSON-колонка отметится изменённой
