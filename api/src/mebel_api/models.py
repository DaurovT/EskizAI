"""Таблицы базы (SQLAlchemy 2, типизированный ORM).

Типы колонок переносимые: JSON (не JSONB), строки вместо enum-типов Postgres,
Uuid, время в UTC. Суммы — целые сумы (UZS), проценты — целые.
"""

import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, UTCDateTime, utcnow
from .domain import EstimateView, LaborMode, Plan, ProjectStatus, Role


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(Uuid, primary_key=True, default=uuid.uuid4)


def _created() -> Mapped[datetime]:
    return mapped_column(UTCDateTime, default=utcnow, nullable=False)


class Workshop(Base):
    __tablename__ = "workshops"

    id: Mapped[uuid.UUID] = _id()
    name: Mapped[str] = mapped_column(String(200), default="Мой цех")
    city: Mapped[str] = mapped_column(String(100), default="Ташкент")
    logo_url: Mapped[Optional[str]] = mapped_column(String(500))
    logo_key: Mapped[Optional[str]] = mapped_column(String(500))  # ключ файла логотипа в хранилище
    phone: Mapped[Optional[str]] = mapped_column(String(20))
    # Условия для КП (PDF-1): пусто — блок в КП не рисуется
    kp_lead: Mapped[Optional[str]] = mapped_column(String(300))
    kp_payment: Mapped[Optional[str]] = mapped_column(String(300))
    kp_warranty: Mapped[Optional[str]] = mapped_column(String(300))

    # Цены (раздел 7 PRD)
    labor_mode: Mapped[str] = mapped_column(String(10), default=LaborMode.percent)
    labor_percent: Mapped[int] = mapped_column(Integer, default=50)
    labor_fixed: Mapped[int] = mapped_column(Integer, default=0)  # сумы
    markup_body: Mapped[int] = mapped_column(Integer, default=0)  # %, корпус
    markup_fronts: Mapped[int] = mapped_column(Integer, default=0)  # %, фасады
    markup_hardware: Mapped[int] = mapped_column(Integer, default=0)  # %, фурнитура
    markup_services: Mapped[int] = mapped_column(Integer, default=0)  # %, услуги поставщика
    default_estimate_view: Mapped[str] = mapped_column(String(10), default=EstimateView.total)
    employee_estimate_views: Mapped[list[str]] = mapped_column(JSON, default=lambda: [EstimateView.total.value])

    # Тариф (раздел 9 PRD)
    plan: Mapped[str] = mapped_column(String(10), default=Plan.free)
    pack_projects_left: Mapped[int] = mapped_column(Integer, default=0)
    pro_until: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)

    blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    # Аккаунт владельца удалён: данные стёрты, строка осталась ради заказов EMAN (SCR-44)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()

    users: Mapped[list["User"]] = relationship(back_populates="workshop")


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _id()
    phone: Mapped[str] = mapped_column(String(20), unique=True)  # один аккаунт на номер
    name: Mapped[str] = mapped_column(String(200), default="")
    role: Mapped[str] = mapped_column(String(10), default=Role.owner)
    language: Mapped[str] = mapped_column(String(2), default="ru")
    workshop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"), index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Должность сотрудника («Замерщик») и права сверх базовых (SCR-23); владельцу — всё
    title: Mapped[Optional[str]] = mapped_column(String(60))
    can_see_cost: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    can_order: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)  # аккаунт удалён, личные данные стёрты
    created_at: Mapped[datetime] = _created()
    last_login_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    # Настройки push (FR-66): {"types": {тип: bool}, "quiet": {"on", "from", "to"}}; null — по умолчанию
    notification_settings: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)

    workshop: Mapped[Workshop] = relationship(back_populates="users")


class Invite(Base):
    """Приглашение сотрудника по номеру (SCR-38a): действует 7 дней, принимается после входа."""

    __tablename__ = "invites"

    id: Mapped[uuid.UUID] = _id()
    workshop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"), index=True)
    phone: Mapped[str] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    title: Mapped[Optional[str]] = mapped_column(String(60))
    can_see_cost: Mapped[bool] = mapped_column(Boolean, default=False)
    can_order: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | accepted | declined | cancelled
    invited_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))  # кто принял
    sent_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    decided_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("user_id", "device_id"),)

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str] = mapped_column(String(200))
    platform: Mapped[Optional[str]] = mapped_column(String(20))
    push_token: Mapped[Optional[str]] = mapped_column(String(500))
    first_seen_at: Mapped[datetime] = _created()
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class AuthCode(Base):
    __tablename__ = "auth_codes"

    id: Mapped[uuid.UUID] = _id()
    phone: Mapped[str] = mapped_column(String(20), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    channel: Mapped[str] = mapped_column(String(10))
    # Назначение кода: login — вход, delete_account — удаление аккаунта (код входа для удаления не подходит)
    purpose: Mapped[str] = mapped_column(String(20), default="login", server_default="login")
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()
    # IP запроса кода (как его видит uvicorn за Caddy, --proxy-headers) — лимиты на IP против SMS-накрутки
    ip: Mapped[Optional[str]] = mapped_column(String(45), index=True)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = _id()  # jti
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = _id()
    workshop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[Optional[str]] = mapped_column(String(20))
    address: Mapped[Optional[str]] = mapped_column(String(500))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (Index("ix_projects_workshop_charge", "workshop_id", "charge_period"),)

    id: Mapped[uuid.UUID] = _id()
    workshop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"), index=True)
    client_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"), index=True)
    author_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(200))
    # auto — название ведёт сервер (вид и размеры модели), user — ввёл мастер, не трогаем
    title_source: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    status: Mapped[str] = mapped_column(String(20), default=ProjectStatus.draft, index=True)
    product_type: Mapped[Optional[str]] = mapped_column(String(40))
    source_text: Mapped[Optional[str]] = mapped_column(Text)
    is_example: Mapped[bool] = mapped_column(Boolean, default=False)

    # Лимит
    charged_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    charge_period: Mapped[Optional[str]] = mapped_column(String(7))  # "2026-11" по времени Ташкента
    charge_source: Mapped[Optional[str]] = mapped_column(String(10))
    returned_to_limit_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)

    # Версии модели
    current_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("model_versions.id", use_alter=True, name="fk_projects_current_version", ondelete="SET NULL")
    )
    frozen_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("model_versions.id", use_alter=True, name="fk_projects_frozen_version", ondelete="SET NULL")
    )

    client_agreed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    contract_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    delivered_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    materials_self_bought: Mapped[bool] = mapped_column(Boolean, default=False)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    cancelled_from: Mapped[Optional[str]] = mapped_column(String(20))
    cancel_reason: Mapped[Optional[str]] = mapped_column(String(500))
    archived_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)  # мягкое удаление: лимит не возвращается

    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    client: Mapped[Optional[Client]] = relationship()
    photos: Mapped[list["ProjectPhoto"]] = relationship(order_by="ProjectPhoto.created_at")


class ProjectStatusChange(Base):
    __tablename__ = "project_status_changes"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    from_status: Mapped[Optional[str]] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20))
    actor_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor: Mapped[str] = mapped_column(String(20), default="user")  # user | admin | client | system
    note: Mapped[Optional[str]] = mapped_column(String(500))
    created_at: Mapped[datetime] = _created()


class ModelVersion(Base):
    """Версия модели — дерево модулей и всё, что из него построено."""

    __tablename__ = "model_versions"
    __table_args__ = (UniqueConstraint("project_id", "number"),)

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    parent_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("model_versions.id", ondelete="SET NULL"))
    source: Mapped[str] = mapped_column(String(10), default="manual")
    label: Mapped[Optional[str]] = mapped_column(String(200))
    author_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    tree: Mapped[dict[str, Any]] = mapped_column(JSON)  # нормализованное дерево (со значениями по умолчанию)
    product_type: Mapped[str] = mapped_column(String(40))
    schema_version: Mapped[str] = mapped_column(String(20))
    rules_version: Mapped[str] = mapped_column(String(40))
    module_versions: Mapped[dict[str, str]] = mapped_column(JSON)
    issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON)
    viewer: Mapped[dict[str, Any]] = mapped_column(JSON)  # снимок 3D-модели на момент сборки
    ok: Mapped[bool] = mapped_column(Boolean)  # нет ошибок уровня error
    build_ms: Mapped[int] = mapped_column(Integer, default=0)
    frozen_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    # JSON Pointer'ы значений «оценка» (из ИИ); снимаются подтверждением мастера или замером
    estimated: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    # Последняя посчитанная цена клиенту: {"from", "to", "exact", "at"} — для списка проектов без пересчёта
    price_cache: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    created_at: Mapped[datetime] = _created()

    @property
    def frozen(self) -> bool:
        return self.frozen_at is not None


class Measurement(Base):
    __tablename__ = "measurements"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("model_versions.id", ondelete="SET NULL"))
    author_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    width: Mapped[Optional[float]] = mapped_column()  # мм, ниша / место установки
    height: Mapped[Optional[float]] = mapped_column()
    depth: Mapped[Optional[float]] = mapped_column()
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # прочие замеры: перекосы, розетки, плинтус…
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class ProjectPhoto(Base):
    __tablename__ = "project_photos"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="source")
    storage_key: Mapped[str] = mapped_column(String(500))
    url: Mapped[str] = mapped_column(String(1000))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    uploaded_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()


class Order(Base):
    """Заказ поставщику. Пока минимум: факт заказа и оплаты (раздел 16 PRD)."""

    __tablename__ = "orders"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), index=True)
    version_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("model_versions.id", ondelete="SET NULL"))
    number: Mapped[Optional[int]] = mapped_column(Integer, index=True)  # «Заказ №1001» — для мастера и менеджера
    supplier: Mapped[str] = mapped_column(String(40), default="eman")
    status: Mapped[str] = mapped_column(String(20), default="created")
    estimate_total: Mapped[Optional[int]] = mapped_column(Integer)  # сумы, по смете
    invoice_total: Mapped[Optional[int]] = mapped_column(Integer)  # сумы, по счёту поставщика
    payment_provider: Mapped[Optional[str]] = mapped_column(String(20))
    payment_reference: Mapped[Optional[str]] = mapped_column(String(200))
    # Ссылка на оплату от EMAN (до интеграции её вставляет менеджер) и отметка «оплата не прошла»
    payment_url: Mapped[Optional[str]] = mapped_column(String(1000))
    payment_failed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    paid_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    # Ручная передача в EMAN (ADM-08): менеджер скачал CSV и отправил поставщику
    handed_over_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    handed_over_by: Mapped[Optional[str]] = mapped_column(String(64))
    status_changed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    commission_status: Mapped[Optional[str]] = mapped_column(String(20))  # accrued | reversed
    notes: Mapped[Optional[str]] = mapped_column(Text)
    distance_km: Mapped[Optional[float]] = mapped_column()  # None — самовывоз
    composition: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)  # снимок mebel_core.supplier_order()
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()
    # Поставщики и кабинет поставщика (docs/staff_vendor_contract.md §4, §5)
    supplier_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("suppliers.id", ondelete="SET NULL"),
                                                             index=True)
    group_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, index=True)  # заказы одного оформления
    vendor_status_note: Mapped[Optional[str]] = mapped_column(Text)
    assignee_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("staff_users.id", ondelete="SET NULL"),
                                                             index=True)  # конструктор
    due_date: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)  # срок готовности
    reject_reason: Mapped[Optional[str]] = mapped_column(String(500))
    return_comment: Mapped[Optional[str]] = mapped_column(Text)  # «вернуть мастеру»: что исправить
    accepted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    commission_amount: Mapped[Optional[int]] = mapped_column(Integer)  # сумы, начислено при оплате
    commission_reversed: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # сумы, сторно


class ShareLink(Base):
    __tablename__ = "share_links"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("model_versions.id", ondelete="CASCADE"))
    token: Mapped[str] = mapped_column(String(64), unique=True)
    language: Mapped[str] = mapped_column(String(2), default="ru")
    estimate_view: Mapped[str] = mapped_column(String(10), default="total")
    show_price: Mapped[bool] = mapped_column(Boolean, default=True)
    price_snapshot: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)  # смета для клиента на момент отправки
    price_snapshot_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    views: Mapped[int] = mapped_column(Integer, default=0)
    ar_starts: Mapped[int] = mapped_column(Integer, default=0)
    ar_failures: Mapped[int] = mapped_column(Integer, default=0)
    first_opened_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    agreed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


class ShareEvent(Base):
    __tablename__ = "share_events"

    id: Mapped[uuid.UUID] = _id()
    share_link_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("share_links.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    user_agent: Mapped[Optional[str]] = mapped_column(String(500))
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = _created()


class AiRequest(Base):
    __tablename__ = "ai_requests"

    id: Mapped[uuid.UUID] = _id()
    workshop_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("workshops.id", ondelete="SET NULL"), index=True)
    project_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), index=True)
    purpose: Mapped[str] = mapped_column(String(40))  # recognize_photo, recognize_text, edit, clarify…
    model: Mapped[str] = mapped_column(String(80))
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_microusd: Mapped[int] = mapped_column(Integer, default=0)  # стоимость в миллионных долях доллара
    validation_result: Mapped[str] = mapped_column(String(20))  # ok | retried | failed
    validation_errors: Mapped[Optional[list[Any]]] = mapped_column(JSON)
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    stop_reason: Mapped[Optional[str]] = mapped_column(String(30))
    served_by: Mapped[Optional[str]] = mapped_column(String(80))  # модель, которая ответила (запасная при отказе)
    created_at: Mapped[datetime] = _created()


class ActionLog(Base):
    __tablename__ = "action_log"
    # Журнал в админке: фильтр по периоду, «объект + действие» (сработавшие лимиты, неудачные входы)
    __table_args__ = (Index("ix_action_log_created_at", "created_at"),
                      Index("ix_action_log_entity_action", "entity", "action"))

    id: Mapped[uuid.UUID] = _id()
    actor_type: Mapped[str] = mapped_column(String(20))  # user | admin | system
    actor_id: Mapped[Optional[str]] = mapped_column(String(64))
    workshop_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("workshops.id", ondelete="SET NULL"), index=True)
    entity: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[Optional[str]] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(40))
    before: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    after: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    created_at: Mapped[datetime] = _created()
    # IP запроса (как его видит uvicorn за Caddy) — только для действий сотрудников (actor_type = staff)
    ip: Mapped[Optional[str]] = mapped_column(String(64))


# --- ИИ: сессия проектирования и чат редактора (раздел 6, FR-43) ---


class AiSession(Base):
    """Сессия DesignSession (история сообщений Claude) — одна на проект."""

    __tablename__ = "ai_sessions"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), unique=True)
    language: Mapped[str] = mapped_column(String(2), default="ru")
    data: Mapped[str] = mapped_column(Text)  # DesignSession.to_json()
    last_status: Mapped[Optional[str]] = mapped_column(String(20))
    last_result: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)  # последний DesignOut
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class ChatMessage(Base):
    """Сообщение чата редактора. «Отменено» вычисляется по версиям (отмена = переход к родителю)."""

    __tablename__ = "chat_messages"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    author: Mapped[str] = mapped_column(String(10))  # master | ai
    kind: Mapped[str] = mapped_column(String(20), default="text")  # design, answer, choose_type, edit, question, error
    text: Mapped[str] = mapped_column(Text)
    options: Mapped[Optional[list[str]]] = mapped_column(JSON)
    version_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("model_versions.id", ondelete="SET NULL"))
    price_delta: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()


class ExtraCharge(Base):
    """Дополнительное списание проекта из лимита — перерасход бюджета ИИ (раздел 6 PRD)."""

    __tablename__ = "extra_charges"
    __table_args__ = (Index("ix_extra_charges_workshop_period", "workshop_id", "period"),)

    id: Mapped[uuid.UUID] = _id()
    workshop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"))
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    reason: Mapped[str] = mapped_column(String(20), default="ai_budget")
    period: Mapped[str] = mapped_column(String(7))
    source: Mapped[str] = mapped_column(String(10))  # free | pack | pro
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()


class AppSetting(Base):
    """Настройки, которые меняются из админки (ADM-12): бюджет ИИ и т. п."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


# --- Файлы мастера (разделы 8–9) ---


class FileAccess(Base):
    """Основание доступа к производственным файлам: оплата файлов, ручное решение менеджера."""

    __tablename__ = "file_access"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    basis: Mapped[str] = mapped_column(String(20))  # payment | admin
    note: Mapped[Optional[str]] = mapped_column(String(500))
    granted_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = _created()


class FileDownload(Base):
    __tablename__ = "file_downloads"

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("model_versions.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(30))
    basis: Mapped[str] = mapped_column(String(20))  # free | order | payment | admin
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()


# --- Каталог и парсер прайса (раздел 7, ADM-04/05) ---


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[uuid.UUID] = _id()
    code: Mapped[str] = mapped_column(String(40), unique=True)  # eman
    name: Mapped[str] = mapped_column(String(200))
    order_method: Mapped[str] = mapped_column(String(40), default="manual_csv")
    commission_bp: Mapped[int] = mapped_column(Integer, default=0)  # комиссия, сотые доли процента
    contacts: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    site_url: Mapped[Optional[str]] = mapped_column(String(300))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _created()
    # Реквизиты, договор, склад, срок производства, текст ссылки на оплату (§4a, §5.1)
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}")
    blocked_reason: Mapped[Optional[str]] = mapped_column(String(500))


class CatalogItem(Base):
    __tablename__ = "catalog_items"
    __table_args__ = (UniqueConstraint("supplier_id", "sku"),)

    id: Mapped[uuid.UUID] = _id()
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"), index=True)
    sku: Mapped[str] = mapped_column(String(80))
    type: Mapped[str] = mapped_column(String(20), index=True)  # sheet, edge, hardware, service, countertop, front, other
    name: Mapped[str] = mapped_column(String(300))
    core_key: Mapped[Optional[str]] = mapped_column(String(80), index=True)  # id позиции в ядре (ldsp_16_white, hinge…)
    length_mm: Mapped[Optional[float]] = mapped_column()
    width_mm: Mapped[Optional[float]] = mapped_column()
    thickness_mm: Mapped[Optional[float]] = mapped_column()
    decor: Mapped[Optional[str]] = mapped_column(String(120))
    has_grain: Mapped[bool] = mapped_column(Boolean, default=False)
    price: Mapped[int] = mapped_column(Integer)  # сумы за единицу
    unit: Mapped[str] = mapped_column(String(20))
    price_date: Mapped[datetime] = mapped_column(UTCDateTime)
    price_source: Mapped[str] = mapped_column(String(120))  # eman.uz, file:prices.csv, manual
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class PriceHistory(Base):
    __tablename__ = "price_history"

    id: Mapped[uuid.UUID] = _id()
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("catalog_items.id", ondelete="CASCADE"), index=True)
    old_price: Mapped[Optional[int]] = mapped_column(Integer)
    new_price: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(120))
    run_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("parser_runs.id", ondelete="SET NULL"))
    changed_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = _created()


class ParserRun(Base):
    __tablename__ = "parser_runs"

    id: Mapped[uuid.UUID] = _id()
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(20))  # csv | eman_html
    file_name: Mapped[Optional[str]] = mapped_column(String(300))
    full_snapshot: Mapped[bool] = mapped_column(Boolean, default=True)  # полный прайс: чего нет — «исчезло»
    status: Mapped[str] = mapped_column(String(20), default="parsed")  # parsed, matched, review, published, failed
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    started_at: Mapped[datetime] = _created()
    finished_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    published_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)


class RawPriceRecord(Base):
    """Сырая запись прайса: как есть со страницы/файла + сопоставление и проверка."""

    __tablename__ = "raw_price_records"

    id: Mapped[uuid.UUID] = _id()
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("parser_runs.id", ondelete="CASCADE"), index=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)  # исходные поля как есть
    sku: Mapped[Optional[str]] = mapped_column(String(80))
    name: Mapped[str] = mapped_column(String(300), default="")
    parsed: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # нормализованные поля
    price: Mapped[Optional[int]] = mapped_column(Integer)
    matched_item_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("catalog_items.id", ondelete="SET NULL"))
    match_status: Mapped[str] = mapped_column(String(20), default="pending")  # new, changed, unchanged, invalid
    old_price: Mapped[Optional[int]] = mapped_column(Integer)
    change_pct: Mapped[Optional[float]] = mapped_column()
    review_status: Mapped[str] = mapped_column(String(20), default="auto")  # auto | pending | approved | rejected
    reviewed_by: Mapped[Optional[str]] = mapped_column(String(64))
    published_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    error: Mapped[Optional[str]] = mapped_column(String(500))
    created_at: Mapped[datetime] = _created()


# --- Push-уведомления (раздел 19) ---


class Notification(Base):
    """Уведомление мастеру: текст на языке пользователя, данные для перехода и результат отправки."""

    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_dedupe", "user_id", "dedupe_key"),)

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    workshop_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"))
    project_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(String(500))
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    dedupe_key: Mapped[Optional[str]] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | sent | no_devices | failed
    error: Mapped[Optional[str]] = mapped_column(String(500))
    sent_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    read_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


# --- Нестандарт (US-7, FR-34/56, ADM-09) ---


class NonstandardRequest(Base):
    """Заявка «нестандарт»: отправлена → оценена (цена, срок) → в работе → готово (доработанные файлы)."""

    __tablename__ = "nonstandard_requests"

    id: Mapped[uuid.UUID] = _id()
    number: Mapped[Optional[int]] = mapped_column(Integer)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    workshop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    version_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("model_versions.id", ondelete="SET NULL"))
    description: Mapped[str] = mapped_column(Text)
    photo_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    differences: Mapped[list[str]] = mapped_column(JSON, default=list)  # отличия от ближайшего варианта (ИИ)
    path: Mapped[str] = mapped_column(String(20), default="eman")  # eman — конструкторам EMAN | self — сам мастер
    status: Mapped[str] = mapped_column(String(20), default="sent")  # sent | estimated | in_work | done | cancelled
    assignee: Mapped[Optional[str]] = mapped_column(String(200))
    price: Mapped[Optional[int]] = mapped_column(Integer)  # сумы
    lead_days: Mapped[Optional[int]] = mapped_column(Integer)
    manager_note: Mapped[Optional[str]] = mapped_column(Text)
    designer_comment: Mapped[Optional[str]] = mapped_column(Text)  # комментарий конструктора мастеру (с ценой)
    files: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # доработанные файлы
    supplier_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("suppliers.id", ondelete="SET NULL"),
                                                             index=True)  # кому ушла (path=eman)
    assignee_staff_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("staff_users.id", ondelete="SET NULL"))
    estimated_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    accepted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    done_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


# --- Позиции «под запрос» (FR-53, ADM-07, SCR-30) ---


class PriceRequest(Base):
    """Позиция сметы без цены: менеджер вводит цену и срок, мастер принимает или отказывается."""

    __tablename__ = "price_requests"
    __table_args__ = (UniqueConstraint("project_id", "line_key"),)

    id: Mapped[uuid.UUID] = _id()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    workshop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"), index=True)
    line_key: Mapped[str] = mapped_column(String(120), index=True)  # ключ строки сметы ядра: sheet:hdf_3_white …
    name: Mapped[str] = mapped_column(String(300))
    unit: Mapped[str] = mapped_column(String(20))
    qty: Mapped[float] = mapped_column()
    estimate_price: Mapped[int] = mapped_column(Integer, default=0)  # цена за единицу в смете до оценки (часто 0)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | priced | accepted | declined
    price: Mapped[Optional[int]] = mapped_column(Integer)  # сумы за единицу
    lead_days: Mapped[Optional[int]] = mapped_column(Integer)
    supplier_name: Mapped[Optional[str]] = mapped_column(String(200))
    note: Mapped[Optional[str]] = mapped_column(String(500))
    catalog_item_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("catalog_items.id", ondelete="SET NULL"))
    supplier_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("suppliers.id", ondelete="SET NULL"),
                                                             index=True)  # по supplier_routes
    priced_by: Mapped[Optional[str]] = mapped_column(String(64))
    priced_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    valid_until: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)  # цена действует до (по умолчанию +7 дней)
    decided_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


# --- Платежи платформе (SCR-42) ---


class Payment(Base):
    """Платёж цеха платформе: пакет проектов, Pro, файлы проекта без заказа. Возврат — статус refunded.
    Оплаты материалов сюда не входят — их получает EMAN (заказ)."""

    __tablename__ = "payments"

    id: Mapped[uuid.UUID] = _id()
    workshop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workshops.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(20))  # pack | pro | files
    title: Mapped[Optional[str]] = mapped_column(String(200))  # «Пакет 10 проектов», «Pro · октябрь»
    amount: Mapped[int] = mapped_column(Integer)  # сумы
    method: Mapped[str] = mapped_column(String(20))  # app_store | google_play | click | payme | manual
    status: Mapped[str] = mapped_column(String(20), default="paid")  # paid | refunded
    receipt_url: Mapped[Optional[str]] = mapped_column(String(1000))
    reference: Mapped[Optional[str]] = mapped_column(String(200))  # номер транзакции платёжной системы
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    paid_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    refunded_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


# --- Сотрудники платформы и поставщиков (docs/staff_vendor_contract.md) ---


class StaffUser(Base):
    """Сотрудник: платформа (supplier_id = NULL) или поставщик. Вход по почте и паролю."""

    __tablename__ = "staff_users"

    id: Mapped[uuid.UUID] = _id()
    email: Mapped[str] = mapped_column(String(254), unique=True)  # в нижнем регистре
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(30))
    supplier_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"),
                                                             index=True)
    password_hash: Mapped[str] = mapped_column(String(300))
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    locked_until: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    password_changed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class StaffSession(Base):
    """Вход сотрудника (устройство): IP, браузер; отзыв — «завершить сессии». Токены — в staff_refresh_tokens."""

    __tablename__ = "staff_sessions"

    id: Mapped[uuid.UUID] = _id()
    staff_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("staff_users.id", ondelete="CASCADE"), index=True)
    ip: Mapped[Optional[str]] = mapped_column(String(64))
    user_agent: Mapped[Optional[str]] = mapped_column(String(300))
    created_at: Mapped[datetime] = _created()
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)


class StaffRefreshToken(Base):
    __tablename__ = "staff_refresh_tokens"

    id: Mapped[uuid.UUID] = _id()  # jti
    staff_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("staff_users.id", ondelete="CASCADE"), index=True)
    session_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("staff_sessions.id", ondelete="CASCADE"),
                                                            index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


class StaffMfa(Base):
    """TOTP (RFC 6238): секрет и резервные коды (хеши). enabled_at = NULL — настройка не завершена."""

    __tablename__ = "staff_mfa"

    staff_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("staff_users.id", ondelete="CASCADE"), primary_key=True)
    secret: Mapped[str] = mapped_column(String(64))
    backup_codes: Mapped[list[str]] = mapped_column(JSON, default=list)
    enabled_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    last_step: Mapped[Optional[int]] = mapped_column(Integer)  # защита от повтора кода
    # Растёт при каждом изменении кодов: резервный код списывается условным UPDATE … WHERE version = :v
    version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = _created()  # настройка начата (секрет выдан)


class StaffMfaChallenge(Base):
    """Выданный mfa_token (второй шаг входа): одноразовый, гаснет при сбросе пароля и завершении сессий."""

    __tablename__ = "staff_mfa_challenges"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)  # jti токена
    staff_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("staff_users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


class AuthThrottle(Base):
    """Счётчики попыток входа сотрудников: почта+IP (блокировка), IP (ограничение частоты), 2FA.
    key — HMAC от почты/IP (сами почта и IP не хранятся). Меняется только атомарным UPSERT … RETURNING."""

    __tablename__ = "auth_throttle"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    staff_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("staff_users.id", ondelete="CASCADE"),
                                                          index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    window_start: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    locked_until: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)


class SupplierRoute(Base):
    """Категория строки заказа → поставщик. Нет маршрута — поставщик по умолчанию (eman)."""

    __tablename__ = "supplier_routes"

    id: Mapped[uuid.UUID] = _id()
    category: Mapped[str] = mapped_column(String(40), unique=True)
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"), index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class SupplierCommission(Base):
    """Ставка комиссии платформы: поставщик, категория (NULL — все), б.п., действует с."""

    __tablename__ = "supplier_commissions"

    id: Mapped[uuid.UUID] = _id()
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"), index=True)
    category: Mapped[Optional[str]] = mapped_column(String(40))
    rate_bp: Mapped[int] = mapped_column(Integer)
    effective_from: Mapped[datetime] = mapped_column(UTCDateTime)
    reason: Mapped[Optional[str]] = mapped_column(String(500))
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = _created()


class SupplierSettlement(Base):
    """Выплата поставщика платформе (комиссия) — вносит суперадмин."""

    __tablename__ = "supplier_settlements"

    id: Mapped[uuid.UUID] = _id()
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"), index=True)
    period_from: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    period_to: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    amount: Mapped[int] = mapped_column(Integer)
    paid_at: Mapped[datetime] = mapped_column(UTCDateTime)
    comment: Mapped[Optional[str]] = mapped_column(String(1000))
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = _created()


class SupplierPriceSource(Base):
    """Источник цен поставщика: файл по ссылке или API. Запуски — в parser_runs."""

    __tablename__ = "supplier_price_sources"

    id: Mapped[uuid.UUID] = _id()
    supplier_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("suppliers.id", ondelete="CASCADE"), unique=True)
    kind: Mapped[str] = mapped_column(String(20), default="file_url")  # file_url | api
    url: Mapped[str] = mapped_column(String(1000))
    format: Mapped[str] = mapped_column(String(10), default="csv")  # csv | xlsx | json
    mapping: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # поле → колонка источника
    secret: Mapped[Optional[str]] = mapped_column(String(500))  # ключ API — в ответах не отдаётся
    schedule: Mapped[str] = mapped_column(String(10), default="daily")  # off | hourly | daily
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    last_status: Mapped[Optional[str]] = mapped_column(String(20))
    last_error: Mapped[Optional[str]] = mapped_column(String(1000))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


# --- Заказ у поставщика: переписка, история, исправления, возвраты, споры (§5.4, §4a) ---


class OrderMessage(Base):
    __tablename__ = "order_messages"

    id: Mapped[uuid.UUID] = _id()
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    author_type: Mapped[str] = mapped_column(String(10))  # master | vendor | platform
    author_id: Mapped[Optional[str]] = mapped_column(String(64))
    author_name: Mapped[Optional[str]] = mapped_column(String(200))
    text: Mapped[str] = mapped_column(Text, default="")
    attachments: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = _created()
    read_by_master_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    read_by_vendor_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)


class OrderEvent(Base):
    """История заказа: статусы и действия (кто, когда, комментарий)."""

    __tablename__ = "order_events"

    id: Mapped[uuid.UUID] = _id()
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # status | take | assign | correction | return | dispute | message…
    from_status: Mapped[Optional[str]] = mapped_column(String(20))
    to_status: Mapped[Optional[str]] = mapped_column(String(20))
    actor_type: Mapped[str] = mapped_column(String(10))  # master | staff | system
    actor_id: Mapped[Optional[str]] = mapped_column(String(64))
    actor_name: Mapped[Optional[str]] = mapped_column(String(200))
    comment: Mapped[Optional[str]] = mapped_column(Text)
    data: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    created_at: Mapped[datetime] = _created()


class OrderCorrection(Base):
    __tablename__ = "order_corrections"

    id: Mapped[uuid.UUID] = _id()
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("staff_users.id", ondelete="SET NULL"))
    comment: Mapped[str] = mapped_column(Text, default="")
    lines_before: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    lines_after: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    total_before: Mapped[int] = mapped_column(Integer, default=0)
    total_after: Mapped[int] = mapped_column(Integer, default=0)
    files: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    prev_status: Mapped[Optional[str]] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | approved | declined | applied
    decision_comment: Mapped[Optional[str]] = mapped_column(Text)
    decided_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    decided_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()


class OrderReturn(Base):
    """Возврат / рекламация по оплаченному заказу."""

    __tablename__ = "order_returns"

    id: Mapped[uuid.UUID] = _id()
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    opened_by_type: Mapped[str] = mapped_column(String(10))  # master | vendor
    opened_by: Mapped[Optional[str]] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(20))  # defect | cut_error | shortage | cancel_after_pay | other
    lines: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    amount: Mapped[Optional[int]] = mapped_column(Integer)  # сумы, заявлено
    photos: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    description: Mapped[str] = mapped_column(Text, default="")
    decision: Mapped[Optional[str]] = mapped_column(String(20))  # redo | refund | declined
    decision_comment: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | awaiting_owner | resolved
    refund_amount: Mapped[Optional[int]] = mapped_column(Integer)
    decided_by: Mapped[Optional[str]] = mapped_column(String(64))
    decided_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    approved_by: Mapped[Optional[str]] = mapped_column(String(64))
    resolved_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class OrderDispute(Base):
    """Спор мастера с решением поставщика (возврат, отклонение) — решает суперадмин."""

    __tablename__ = "order_disputes"

    id: Mapped[uuid.UUID] = _id()
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    return_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("order_returns.id", ondelete="SET NULL"))
    opened_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    subject: Mapped[str] = mapped_column(String(20))  # return | rejection
    # decision_unfair | amount_wrong | defect_not_accepted | can_be_done | other
    reason: Mapped[str] = mapped_column(String(40))
    comment: Mapped[str] = mapped_column(Text, default="")  # мастер: с чем не согласен
    photos: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    lines: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    amount: Mapped[Optional[int]] = mapped_column(Integer)  # сколько просит мастер
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | resolved
    resolution: Mapped[Optional[str]] = mapped_column(String(20))  # master | supplier | partial
    refund_amount: Mapped[Optional[int]] = mapped_column(Integer)  # решение: возврат за счёт поставщика
    decision_comment: Mapped[Optional[str]] = mapped_column(Text)  # решение суперадмина — видят обе стороны
    resolved_by: Mapped[Optional[str]] = mapped_column(String(64))
    resolved_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = _created()
