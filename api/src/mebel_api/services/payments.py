"""Платежи цеха платформе (SCR-42, PayHistory.dc.html): пакеты, Pro, файлы проекта без заказа, возвраты.

Платёжных вебхуков (App Store / Google Play / Click / Payme) ещё нет — платежи записывает менеджер в админке
(`POST /admin/workshops/{id}/payments`, оплата файлов — вместе с открытием доступа). Ранние открытия файлов
«по оплате» без записи платежа показываются строкой без суммы — чтобы история была полной.
Оплаты материалов сюда не входят — их получает EMAN, они в карточке заказа.
"""

import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import FileAccess, Payment, Project

KINDS = ("pack", "pro", "files")
METHODS = ("app_store", "google_play", "click", "payme", "manual")
METHOD_LABELS = {"app_store": "App Store", "google_play": "Google Play", "click": "Click", "payme": "Payme",
                 "manual": {"ru": "Вручную", "uz": "Qo‘lda"}}
MONTHS = {
    "ru": ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь",
           "декабрь"],
    "uz": ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentyabr", "oktyabr", "noyabr",
           "dekabr"],
}


def _lang(lang: str) -> str:
    return "uz" if lang == "uz" else "ru"


def default_title(kind: str, lang: str, paid_at: datetime, project_title: str | None) -> str:
    lang = _lang(lang)
    if kind == "pack":
        return "10 ta loyiha paketi" if lang == "uz" else "Пакет 10 проектов"
    if kind == "pro":
        month = MONTHS[lang][paid_at.astimezone(ZoneInfo("Asia/Tashkent")).month - 1]
        return f"Pro · {month}"
    if project_title:
        return f"«{project_title}» loyihasi fayllari" if lang == "uz" else f"Файлы проекта «{project_title}»"
    return "Loyiha fayllari" if lang == "uz" else "Файлы проекта"


def method_label(method: str | None, lang: str) -> str | None:
    if method is None:
        return None
    v = METHOD_LABELS.get(method, method)
    return v[_lang(lang)] if isinstance(v, dict) else v


def _out(*, id: str, kind: str, title: str | None, amount: int | None, method: str | None, status: str,
         paid_at: datetime, refunded_at: datetime | None, receipt_url: str | None, project: Project | None,
         lang: str) -> dict[str, Any]:
    return {
        "id": id, "kind": kind,
        "title": title or default_title(kind, lang, paid_at, project.title if project else None),
        "amount": amount, "currency": "UZS", "method": method, "method_label": method_label(method, lang),
        "status": status, "paid_at": paid_at, "refunded_at": refunded_at, "receipt_url": receipt_url,
        "project_id": str(project.id) if project else None, "project_title": project.title if project else None,
    }


def payment_out(p: Payment, project: Project | None, lang: str) -> dict[str, Any]:
    return _out(id=str(p.id), kind=p.kind, title=p.title, amount=p.amount, method=p.method, status=p.status,
                paid_at=p.paid_at, refunded_at=p.refunded_at, receipt_url=p.receipt_url, project=project, lang=lang)


def history(db: Session, workshop_id: uuid.UUID, lang: str) -> list[dict[str, Any]]:
    rows = list(db.scalars(select(Payment).where(Payment.workshop_id == workshop_id)))
    pids = {p.project_id for p in rows if p.project_id}
    paid_projects = {p.project_id for p in rows if p.kind == "files" and p.project_id}
    legacy = db.execute(
        select(FileAccess, Project).join(Project, FileAccess.project_id == Project.id)
        .where(Project.workshop_id == workshop_id, FileAccess.basis == "payment")
    ).all()
    projects = {p.id: p for p in db.scalars(select(Project).where(Project.id.in_(pids)))} if pids else {}
    items = [payment_out(p, projects.get(p.project_id), lang) for p in rows]
    for fa, project in legacy:
        if project.id in paid_projects:
            continue
        items.append(_out(id=f"file_access:{fa.id}", kind="files", title=None, amount=None, method=None,
                          status="paid", paid_at=fa.created_at, refunded_at=None, receipt_url=None, project=project,
                          lang=lang))
    items.sort(key=lambda x: x["paid_at"], reverse=True)
    return items
