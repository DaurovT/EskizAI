"""События, по которым мастер получает push (раздел 19 PRD). Все функции только создают уведомления —
отправка идёт после коммита вызывающего кода (services/notify.py)."""

import logging
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain import ProjectStatus as S
from ..models import ModelVersion, NonstandardRequest, Order, PriceRequest, Project, ShareLink, Supplier, Workshop
from .notify import notify, owners, project_author

log = logging.getLogger(__name__)

SHARE_WINDOW = timedelta(minutes=30)
STALE_WINDOW = timedelta(hours=24)
ORDER_PUSH_STATUSES = {"paid", "accepted", "cutting", "ready", "issued", "cancelled", "returned", "rejected",
                       "awaiting_approval"}


def model_ready(db: Session, project: Project, version: ModelVersion) -> None:
    """Модель готова после ИИ-задачи, а мастер ушёл из приложения."""
    notify(db, project_author(db, project), "model_ready", {"price": version.price_cache}, project=project,
           data={"version_id": str(version.id)}, dedupe_key=f"model_ready:{version.id}")


def share_event(db: Session, link: ShareLink, kind: str) -> None:
    project = db.get(Project, link.project_id)
    if project is None:
        return
    push_kind = {"opened": "share_opened", "ar_started": "ar_started", "agreed": "client_agreed"}.get(kind)
    if push_kind is None:
        return
    # согласие — один раз на ссылку; просмотры и AR — не чаще раза в 30 минут
    notify(db, project_author(db, project), push_kind, project=project, data={"share_link_id": str(link.id)},
           dedupe_key=f"{push_kind}:{link.id}", window=None if push_kind == "client_agreed" else SHARE_WINDOW)


COMMENT_STATUSES = {"returned": "return_comment", "rejected": "vendor_status_note"}
_STATUS_PUSHED = "order_status_pushed"


def supplier_name(db: Session, order: Order) -> str | None:
    """Имя поставщика для push: «принят: EMAN». Заказ без поставщика (очередь платформы) — None."""
    if order.supplier_id:
        s = db.get(Supplier, order.supplier_id)
        if s is not None:
            return s.name
    return order.supplier.upper() if order.supplier and order.supplier != "platform" else None


def _status_pushed_now(db: Session, order: Order) -> bool:
    """В этой же транзакции мастеру уже ушёл push о смене статуса заказа."""
    txn, ids = db.info.get(_STATUS_PUSHED, (None, set()))
    return txn is not None and txn is db.get_transaction() and order.id in ids


def order_status(db: Session, order: Order) -> None:
    if order.status not in ORDER_PUSH_STATUSES:
        return
    project = db.get(Project, order.project_id)
    if project is None:
        return
    users = owners(db, project.workshop_id) + project_author(db, project)
    params = {"number": order.number or str(order.id)[:8], "status": order.status,
              "supplier": supplier_name(db, order)}
    attr = COMMENT_STATUSES.get(order.status)
    if attr and getattr(order, attr, None):
        params["comment"] = getattr(order, attr)[:200]
    notify(db, users, "order_status", params,
           project=project, data={"order_id": str(order.id), "status": order.status},
           dedupe_key=f"order:{order.id}:{order.status}")
    txn = db.get_transaction()
    prev_txn, ids = db.info.get(_STATUS_PUSHED, (None, set()))
    db.info[_STATUS_PUSHED] = (txn, (ids if prev_txn is txn else set()) | {order.id})


def _order_users(db: Session, order: Order) -> tuple[Project | None, list]:
    project = db.get(Project, order.project_id)
    if project is None:
        return None, []
    return project, owners(db, project.workshop_id) + project_author(db, project)


def order_message(db: Session, order: Order, message) -> None:
    """Новое сообщение от поставщика или платформы в переписке по заказу (§5.6)."""
    project, users = _order_users(db, order)
    if project is None:
        return
    if _status_pushed_now(db, order):  # «вернуть мастеру» + автоматическое сообщение — один push (о статусе)
        return
    notify(db, users, "order_message", {"number": order.number or str(order.id)[:8],
                                        "text": (message.text or "📎")[:120]},
           project=project, data={"order_id": str(order.id), "message_id": str(message.id), "screen": "order_chat"},
           dedupe_key=f"order_message:{message.id}")


def order_return(db: Session, order: Order, ret) -> None:
    project, users = _order_users(db, order)
    if project is None:
        return
    notify(db, users, "order_return", {"number": order.number or str(order.id)[:8], "status": ret.status},
           project=project, data={"order_id": str(order.id), "return_id": str(ret.id), "status": ret.status,
                                  "decision": ret.decision, "screen": "order_returns"},
           dedupe_key=f"order_return:{ret.id}:{ret.status}:{ret.decision}")


def order_dispute(db: Session, order: Order, dispute) -> None:
    project, users = _order_users(db, order)
    if project is None:
        return
    notify(db, users, "order_dispute", {"number": order.number or str(order.id)[:8]}, project=project,
           data={"order_id": str(order.id), "dispute_id": str(dispute.id), "status": dispute.status,
                 "return_id": str(dispute.return_id) if dispute.return_id else None,
                 # спор по рекламации — к рекламациям (решение видно у рекламации), по отклонению — карточка
                 "screen": "order_returns" if dispute.return_id else "order"},
           dedupe_key=f"order_dispute:{dispute.id}:{dispute.status}")


def order_correction(db: Session, order: Order, correction) -> None:
    """Поставщик исправил состав или сумму — мастеру подтвердить в карточке заказа."""
    project, users = _order_users(db, order)
    if project is None:
        return
    notify(db, users, "order_correction", {"number": order.number or str(order.id)[:8]}, project=project,
           data={"order_id": str(order.id), "correction_id": str(correction.id), "screen": "order"},
           dedupe_key=f"order_correction:{correction.id}")


def price_request_priced(db: Session, req: PriceRequest) -> None:
    project = db.get(Project, req.project_id)
    if project is None or project.deleted_at is not None:
        return
    notify(db, project_author(db, project), "price_request_priced", {"name": req.name}, project=project,
           data={"price_request_id": str(req.id), "screen": "price_requests"}, dedupe_key=f"price_request:{req.id}")


def prices_stale(db: Session, project: Project) -> None:
    """Цены в смете устарели — пока проект ещё не у клиента (или клиент видит старую цену)."""
    if S(project.status) not in (S.sketch, S.sent, S.measured) or project.archived_at is not None:
        return
    notify(db, project_author(db, project), "prices_stale", project=project, data={"screen": "estimate"},
           dedupe_key=f"prices_stale:{project.id}", window=STALE_WINDOW)


def prices_published(db: Session) -> int:
    """После публикации нового прайса: мастерам с отправленными ссылками — «цены изменились»."""
    projects = db.scalars(
        select(Project).where(Project.status.in_([S.sent.value, S.measured.value]), Project.deleted_at.is_(None),
                              Project.archived_at.is_(None), Project.is_example.is_(False))
    ).all()
    n = 0
    for p in projects:
        has_link = db.scalar(select(ShareLink.id).where(ShareLink.project_id == p.id, ShareLink.revoked_at.is_(None))
                             .limit(1))
        if has_link is not None:
            prices_stale(db, p)
            n += 1
    return n


def limit_left(db: Session, settings, workshop: Workshop) -> None:
    """Остался 1 бесплатный проект в месяце (и нет пакета/Pro)."""
    from .limits import limit_state

    db.flush()  # autoflush выключен — списание должно попасть в подсчёт
    st = limit_state(db, settings, workshop)
    if st.unlimited or st.pack_left > 0 or st.free_left != 1:
        return
    notify(db, owners(db, workshop.id), "limit_one_left", data={"screen": "profile"},
           dedupe_key=f"limit_one_left:{st.period}")


def nonstandard(db: Session, req: NonstandardRequest, kind: str) -> None:
    project = db.get(Project, req.project_id)
    if project is None:
        return
    params = {"price": req.price or 0, "days": req.lead_days or "—"}
    notify(db, project_author(db, project), kind, params, project=project,
           data={"nonstandard_id": str(req.id), "screen": "nonstandard"}, dedupe_key=f"{kind}:{req.id}")
