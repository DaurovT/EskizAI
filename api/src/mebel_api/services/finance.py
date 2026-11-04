"""Взаиморасчёты платформы с поставщиками (ADM-10, §4a, §5.1) и показатели поставщика.

Одни и те же цифры видят суперадмин (`/admin/finance`) и владелец поставщика (`/vendor/finance`):
- оборот — оплаченные заказы из приложения (по дате оплаты), число заказов, средний чек;
- комиссия начислена — при оплате (ставка по категориям на дату оформления заказа);
- сторно — отмена после оплаты, подтверждённые возвраты, решения споров;
- выплачено — `supplier_settlements` (вносит суперадмин); долг = начислено − сторно − выплачено.
"""

import csv
import io
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from mebel_core.exports.csv_safe import SafeWriter
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..errors import ApiError
from ..models import Order, OrderReturn, Project, Supplier, SupplierSettlement, Workshop

TZ = ZoneInfo("Asia/Tashkent")


def period(from_: str | None, to: str | None) -> tuple[datetime, datetime]:
    """`from`/`to` — даты YYYY-MM-DD (по Ташкенту, `to` включительно) или ISO-время. По умолчанию — текущий месяц."""

    def parse(v: str, end: bool) -> datetime:
        try:
            if len(v) == 10:
                d = date.fromisoformat(v)
                dt = datetime.combine(d + timedelta(days=1) if end else d, time(0), TZ)
            else:
                dt = datetime.fromisoformat(v)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=TZ)
        except ValueError:
            raise ApiError(422, "invalid_period", "Период — даты в виде 2026-11-01") from None
        return dt

    now = utcnow().astimezone(TZ)
    start = parse(from_, False) if from_ else now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = parse(to, True) if to else now + timedelta(seconds=1)
    if end <= start:
        raise ApiError(422, "invalid_period", "Конец периода раньше начала")
    return start, end


def _commission(o: Order, supplier: Supplier) -> int:
    if o.commission_amount is not None:
        return o.commission_amount
    if o.commission_status in ("accrued", "reversed"):  # заказы до 0008: по общей ставке поставщика
        total = o.invoice_total if o.invoice_total is not None else (o.estimate_total or 0)
        return round(total * (supplier.commission_bp or 0) / 10_000)
    return 0


def _reversed(o: Order, supplier: Supplier) -> int:
    if o.commission_reversed:
        return o.commission_reversed
    if o.commission_amount is None and o.commission_status == "reversed":
        return _commission(o, supplier)
    return 0


def supplier_finance(db: Session, supplier: Supplier, start: datetime, end: datetime) -> dict[str, Any]:
    paid = list(db.scalars(select(Order).where(Order.supplier_id == supplier.id, Order.paid_at.is_not(None),
                                               Order.paid_at >= start, Order.paid_at < end)))
    turnover = sum(o.invoice_total if o.invoice_total is not None else (o.estimate_total or 0) for o in paid)
    accrued = sum(_commission(o, supplier) for o in paid)
    reversed_ = sum(_reversed(o, supplier) for o in paid)
    refunds = db.scalar(select(func.coalesce(func.sum(OrderReturn.refund_amount), 0))
                        .join(Order, OrderReturn.order_id == Order.id)
                        .where(Order.supplier_id == supplier.id, OrderReturn.status == "resolved",
                               OrderReturn.decision == "refund", OrderReturn.resolved_at >= start,
                               OrderReturn.resolved_at < end)) or 0
    settled = db.scalar(select(func.coalesce(func.sum(SupplierSettlement.amount), 0)).where(
        SupplierSettlement.supplier_id == supplier.id, SupplierSettlement.paid_at >= start,
        SupplierSettlement.paid_at < end)) or 0
    # Баланс за всё время: долг поставщика платформе на сегодня
    all_paid = list(db.scalars(select(Order).where(Order.supplier_id == supplier.id, Order.paid_at.is_not(None))))
    all_due = sum(_commission(o, supplier) - _reversed(o, supplier) for o in all_paid)
    all_settled = db.scalar(select(func.coalesce(func.sum(SupplierSettlement.amount), 0)).where(
        SupplierSettlement.supplier_id == supplier.id)) or 0
    due = accrued - reversed_
    return {
        "supplier": {"id": str(supplier.id), "code": supplier.code, "name": supplier.name},
        "from": start.isoformat(), "to": end.isoformat(),
        "orders": len(paid), "turnover": turnover, "avg_check": round(turnover / len(paid)) if paid else 0,
        "commission": {"accrued": accrued, "reversed": reversed_, "due": due},
        "refunds": refunds, "settled": settled, "debt": due - settled,
        "balance": {"due": all_due, "settled": all_settled, "debt": all_due - all_settled},
    }


def settlement_out(x: SupplierSettlement) -> dict[str, Any]:
    return {"id": str(x.id), "supplier_id": str(x.supplier_id), "amount": x.amount, "paid_at": x.paid_at,
            "period_from": x.period_from, "period_to": x.period_to, "comment": x.comment, "created_by": x.created_by,
            "created_at": x.created_at}


def act_csv(db: Session, supplier: Supplier, start: datetime, end: datetime) -> bytes:
    """Акт сверки: заказы за период, выплаты, итоги (те же цифры, что в supplier_finance)."""
    f = supplier_finance(db, supplier, start, end)
    out = io.StringIO()
    w = SafeWriter(csv.writer(out, delimiter=";"))  # названия цехов и комментарии — текстом, не формулой
    w.writerow([f"Акт сверки: {supplier.name}", start.astimezone(TZ).date().isoformat(),
                (end - timedelta(seconds=1)).astimezone(TZ).date().isoformat()])
    w.writerow([])
    w.writerow(["Заказ", "Оплачен", "Цех", "Сумма", "Комиссия", "Сторно", "Статус"])
    rows = db.execute(select(Order, Workshop).join(Project, Order.project_id == Project.id)
                      .join(Workshop, Project.workshop_id == Workshop.id)
                      .where(Order.supplier_id == supplier.id, Order.paid_at.is_not(None), Order.paid_at >= start,
                             Order.paid_at < end).order_by(Order.paid_at)).all()
    for o, wk in rows:
        w.writerow([o.number or str(o.id)[:8], o.paid_at.astimezone(TZ).strftime("%d.%m.%Y"), wk.name,
                    o.invoice_total if o.invoice_total is not None else (o.estimate_total or 0),
                    _commission(o, supplier), _reversed(o, supplier), o.status])
    w.writerow([])
    w.writerow(["Выплаты платформе", "Дата", "Сумма", "Комментарий"])
    for x in db.scalars(select(SupplierSettlement).where(SupplierSettlement.supplier_id == supplier.id,
                                                         SupplierSettlement.paid_at >= start,
                                                         SupplierSettlement.paid_at < end)
                        .order_by(SupplierSettlement.paid_at)):
        w.writerow(["", x.paid_at.astimezone(TZ).strftime("%d.%m.%Y"), x.amount, x.comment or ""])
    w.writerow([])
    w.writerow(["Итого оборот", f["turnover"]])
    w.writerow(["Комиссия начислена", f["commission"]["accrued"]])
    w.writerow(["Сторно", f["commission"]["reversed"]])
    w.writerow(["К оплате платформе", f["commission"]["due"]])
    w.writerow(["Оплачено", f["settled"]])
    w.writerow(["Долг за период", f["debt"]])
    return ("﻿" + out.getvalue()).encode("utf-8")


def _avg_hours(deltas: list[timedelta]) -> float | None:
    return round(sum(d.total_seconds() for d in deltas) / len(deltas) / 3600, 1) if deltas else None


def supplier_metrics(db: Session, supplier: Supplier, overdue_hours: int = 24) -> dict[str, Any]:
    """Показатели поставщика для платформы: время ответа, доля возвратов и отклонений, просрочки."""
    orders = list(db.scalars(select(Order).where(Order.supplier_id == supplier.id)))
    accepted = [o.accepted_at - o.created_at for o in orders if o.accepted_at and o.created_at]
    paid = [o for o in orders if o.paid_at is not None]
    returns = db.scalar(select(func.count(OrderReturn.id)).join(Order, OrderReturn.order_id == Order.id)
                        .where(Order.supplier_id == supplier.id)) or 0
    border = utcnow() - timedelta(hours=overdue_hours)
    overdue = [o for o in orders if o.status == "created" and o.created_at < border]
    return {
        "orders": len(orders), "paid": len(paid),
        "avg_response_hours": _avg_hours(accepted),
        "returns_share": round(returns / len(paid), 3) if paid else None,
        "rejected_share": round(sum(o.status == "rejected" for o in orders) / len(orders), 3) if orders else None,
        "overdue": len(overdue), "overdue_hours": overdue_hours,
    }
