"""Подсказка в строке списка проектов (Projects.dc.html): «открыл 2 раза», «не открыл 3 дн.»,
«готов — забрать в EMAN», «ждёт оплаты». Тон — ключ `tones` приложения: green | amber | gray.

Порядок: заказ EMAN → цена под запрос / нестандарт ждут решения → ссылка клиента (статус «Отправлен»).
Считается пачкой на страницу списка — 4 запроса на все строки.
"""

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..domain import OrderStatus, ProjectStatus as S
from ..models import NonstandardRequest, Order, PriceRequest, Project, ShareLink

TEXTS = {
    "ru": {
        "ready": "готов — забрать в EMAN", "wait_pay": "ждёт оплаты", "pay_failed": "оплата не прошла",
        "cutting": "в распиле EMAN", "order": "заказ EMAN №{n}", "price_came": "пришла цена — решите",
        "ns_estimated": "нестандарт оценён", "agreed": "клиент согласен", "opened": "открыл {n} {times}",
        "not_opened": "не открыл {n} дн.",
    },
    "uz": {
        "ready": "tayyor — EMANdan olib keting", "wait_pay": "to‘lov kutilmoqda", "pay_failed": "to‘lov o‘tmadi",
        "cutting": "EMANda kesilmoqda", "order": "EMAN buyurtma №{n}", "price_came": "narx keldi — qaror qiling",
        "ns_estimated": "nostandart baholandi", "agreed": "mijoz rozi", "opened": "{n} marta ochdi",
        "not_opened": "{n} kun ochmadi",
    },
}


def _times(n: int) -> str:
    """«раз» / «раза»: 2, 3, 4, 22… — «раза»."""
    return "раза" if n % 10 in (2, 3, 4) and not 12 <= n % 100 <= 14 else "раз"


def _a(lang: str, key: str, tone: str, **kw) -> dict:
    t = TEXTS["uz" if lang == "uz" else "ru"][key]
    return {"text": t.format(**kw), "tone": tone}


def _order_hint(o: Order, lang: str) -> dict | None:
    if o.status == OrderStatus.ready:
        return _a(lang, "ready", "green")
    if o.status == OrderStatus.created:
        return _a(lang, "pay_failed" if o.payment_failed_at else "wait_pay", "amber")
    if o.status == OrderStatus.cutting:
        return _a(lang, "cutting", "gray")
    if o.status in (OrderStatus.paid, OrderStatus.accepted):
        return _a(lang, "order", "gray", n=o.number or str(o.id)[:8].upper())
    return None  # выдан — подсказка не нужна


def activities(db: Session, projects: list[Project], lang: str, now: datetime | None = None) -> dict[uuid.UUID, dict]:
    ids = [p.id for p in projects if not p.is_example and p.archived_at is None]
    if not ids:
        return {}
    now = now or utcnow()
    orders: dict[uuid.UUID, Order] = {}
    for o in db.scalars(select(Order).where(Order.project_id.in_(ids), Order.status != OrderStatus.cancelled)
                        .order_by(Order.created_at)):
        orders[o.project_id] = o  # последний заказ проекта
    priced = set(db.scalars(select(PriceRequest.project_id).where(PriceRequest.project_id.in_(ids),
                                                                  PriceRequest.status == "priced")))
    estimated = set(db.scalars(select(NonstandardRequest.project_id).where(
        NonstandardRequest.project_id.in_(ids), NonstandardRequest.status == "estimated")))
    links: dict[uuid.UUID, ShareLink] = {}
    for link in db.scalars(select(ShareLink).where(ShareLink.project_id.in_(ids), ShareLink.revoked_at.is_(None))
                           .order_by(ShareLink.created_at)):
        links[link.project_id] = link  # последняя действующая ссылка

    out: dict[uuid.UUID, dict] = {}
    for p in projects:
        if p.id not in ids:
            continue
        hint = None
        if p.id in orders:
            hint = _order_hint(orders[p.id], lang)
        elif p.id in priced:
            hint = _a(lang, "price_came", "amber")
        elif p.id in estimated:
            hint = _a(lang, "ns_estimated", "amber")
        elif S(p.status) == S.sent and p.id in links:
            link = links[p.id]
            if link.agreed_at is not None:
                hint = _a(lang, "agreed", "green")
            elif link.views > 0:
                hint = _a(lang, "opened", "green", n=link.views, times=_times(link.views))
            else:
                days = (now - link.created_at).days
                if days >= 1:
                    hint = _a(lang, "not_opened", "amber", n=days)
        if hint is not None:
            out[p.id] = hint
    return out
