"""Перечисления предметной области и их подписи по-русски."""

from enum import StrEnum


class Role(StrEnum):
    owner = "owner"
    employee = "employee"


class Language(StrEnum):
    ru = "ru"
    uz = "uz"


class Plan(StrEnum):
    free = "free"
    pack = "pack"  # пакет проектов: бесплатный лимит + остаток пакета
    pro = "pro"


class ChargeSource(StrEnum):
    free = "free"
    pack = "pack"
    pro = "pro"


class LaborMode(StrEnum):
    percent = "percent"  # процент от себестоимости материалов
    fixed = "fixed"  # фиксированная сумма за проект


class EstimateView(StrEnum):
    total = "total"
    short = "short"
    detailed = "detailed"


ESTIMATE_VIEW_LABELS = {
    EstimateView.total: "Только итог",
    EstimateView.short: "Короткая",
    EstimateView.detailed: "Подробная",
}


class ProjectStatus(StrEnum):
    draft = "draft"
    sketch = "sketch"
    sent = "sent"
    measured = "measured"
    contract = "contract"
    in_work = "in_work"
    delivered = "delivered"
    cancelled = "cancelled"


STATUS_LABELS = {
    ProjectStatus.draft: "Черновик",
    ProjectStatus.sketch: "Эскиз",
    ProjectStatus.sent: "Отправлен",
    ProjectStatus.measured: "Замер",
    ProjectStatus.contract: "Договор",
    ProjectStatus.in_work: "В работе",
    ProjectStatus.delivered: "Сдан",
    ProjectStatus.cancelled: "Отменён",
}


class OrderStatus(StrEnum):
    created = "created"
    paid = "paid"
    accepted = "accepted"
    cutting = "cutting"
    ready = "ready"
    issued = "issued"
    cancelled = "cancelled"


class ShareEventKind(StrEnum):
    opened = "opened"
    ar_started = "ar_started"
    ar_failed = "ar_failed"
    agreed = "agreed"


class PhotoKind(StrEnum):
    source = "source"  # исходные фото (Pinterest, объект)
    measurement = "measurement"  # фото замера
    result = "result"  # фото готовой работы


class VersionSource(StrEnum):
    manual = "manual"  # мастер (поля, тап)
    ai = "ai"  # правка ИИ
    restore = "restore"  # откат к старой версии из списка
    fix = "fix"  # готовое исправление из замечания ядра


class AiValidation(StrEnum):
    ok = "ok"
    retried = "retried"
    failed = "failed"
    # Значения из журнала mebel_ai (LLM.log): почему запрос не засчитан
    schema_error = "schema_error"
    build_error = "build_error"
    refusal = "refusal"
    error = "error"  # сбой вызова API (сеть, ключ)


ORDER_STATUS_LABELS = {
    "created": "Создан",
    "paid": "Оплачен",
    "accepted": "Принят EMAN",
    "cutting": "В распиле",
    "ready": "Готов",
    "issued": "Выдан",
    "cancelled": "Отменён",
}
