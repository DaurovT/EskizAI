"""Push-уведомления мастеру (раздел 19 PRD).

- `notify(db, …)` пишет строки `notifications` (текст — на языке пользователя) в той же транзакции,
  что и событие. После коммита сессии их отправляет `Notifier` (событие after_commit): в фоне
  (`thread`) или сразу (`inline`, тесты).
- Отправитель подменяется: `ExpoPushSender` (Expo Push API по HTTP), `LogPushSender` (dev — только лог),
  в тестах — `MemoryPushSender`. Сети в тестах нет.
- Повторы гасятся ключом `dedupe_key` с окном (клиент открыл ссылку — не чаще раза в 30 минут и т. п.).
- Настройки мастера (services/notif_settings.py): выключенный тип — строка со status=muted, без push;
  в тихие часы push уходит без звука (silent).
"""

import json
import logging
import threading
import urllib.request
import uuid
from collections.abc import Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Protocol

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..domain import Role
from ..models import Device, Notification, Project, User

log = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


# --- Отправители ---


@dataclass
class PushMessage:
    to: str
    title: str
    body: str
    data: dict[str, Any] = field(default_factory=dict)
    silent: bool = False  # тихие часы: без звука

    def expo(self) -> dict[str, Any]:
        if self.silent:  # без sound — iOS не звучит; Android-канал quiet создан без звука
            return {"to": self.to, "title": self.title, "body": self.body, "data": self.data, "channelId": "quiet",
                    "priority": "normal"}
        return {"to": self.to, "title": self.title, "body": self.body, "data": self.data, "sound": "default",
                "channelId": "default"}


class PushSender(Protocol):
    def send(self, messages: Sequence[PushMessage]) -> list[dict[str, Any]]:
        """Возвращает «квитанции» по порядку: {"status": "ok"} или {"status": "error", "details": {"error": …}}."""
        ...


class LogPushSender:
    """Dev: ничего не отправляет, только пишет в лог."""

    def send(self, messages: Sequence[PushMessage]) -> list[dict[str, Any]]:
        for m in messages:
            log.info("push → %s: %s — %s %s", m.to[:24], m.title, m.body, m.data)
        return [{"status": "ok"} for _ in messages]


class MemoryPushSender:
    """Тесты и e2e: складывает сообщения в список. `fail_tokens` — токены, на которые Expo ответил бы ошибкой."""

    def __init__(self, fail_tokens: Iterable[str] = ()):
        self.sent: list[PushMessage] = []
        self.fail_tokens = set(fail_tokens)
        self._lock = threading.Lock()

    def send(self, messages: Sequence[PushMessage]) -> list[dict[str, Any]]:
        out = []
        with self._lock:
            for m in messages:
                if m.to in self.fail_tokens:
                    out.append({"status": "error", "details": {"error": "DeviceNotRegistered"}})
                else:
                    self.sent.append(m)
                    out.append({"status": "ok"})
        return out


class ExpoPushSender:
    """Expo Push API: POST https://exp.host/--/api/v2/push/send, до 100 сообщений за запрос."""

    def __init__(self, url: str = EXPO_PUSH_URL, access_token: str = "", timeout: float = 10.0, opener=None):
        self.url = url
        self.access_token = access_token
        self.timeout = timeout
        self.opener = opener or urllib.request.urlopen  # подменяется в тестах

    def send(self, messages: Sequence[PushMessage]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for i in range(0, len(messages), 100):
            chunk = messages[i:i + 100]
            headers = {"Content-Type": "application/json", "Accept": "application/json"}
            if self.access_token:
                headers["Authorization"] = f"Bearer {self.access_token}"
            req = urllib.request.Request(self.url, data=json.dumps([m.expo() for m in chunk]).encode(),
                                         headers=headers, method="POST")
            try:
                with self.opener(req, timeout=self.timeout) as resp:
                    tickets = json.loads(resp.read().decode() or "{}").get("data") or []
            except Exception as e:  # сеть или 5xx — отметим ошибку, событие не теряется (строка в базе)
                log.warning("expo push failed: %s", e)
                tickets = [{"status": "error", "message": str(e)[:200]} for _ in chunk]
            if isinstance(tickets, dict):  # один получатель — Expo может вернуть объект
                tickets = [tickets]
            out.extend(tickets + [{"status": "error", "message": "no ticket"}] * (len(chunk) - len(tickets)))
        return out


def make_sender(settings) -> PushSender:
    if settings.push_provider == "expo":
        return ExpoPushSender(access_token=settings.expo_access_token)
    return LogPushSender()


# --- Шаблоны (ru / uz) ---

ORDER_STATUS_TEXT = {
    "ru": {"paid": "оплачен", "accepted": "принят поставщиком {supplier}", "cutting": "в распиле", "ready": "готов к выдаче",
           "issued": "выдан", "cancelled": "отменён", "returned": "возвращён на правку",
           "rejected": "отклонён поставщиком", "awaiting_approval": "исправлен поставщиком — подтвердите"},
    "uz": {"paid": "to‘landi", "accepted": "yetkazib beruvchi {supplier} qabul qildi", "cutting": "kesilmoqda", "ready": "olib ketishga tayyor",
           "issued": "berildi", "cancelled": "bekor qilindi", "returned": "tuzatish uchun qaytarildi",
           "rejected": "yetkazib beruvchi rad etdi", "awaiting_approval": "yetkazib beruvchi tuzatdi — tasdiqlang"},
}

TEMPLATES: dict[str, dict[str, tuple[str, str]]] = {
    "model_ready": {
        "ru": ("Модель готова", "{title} готов{price_part}"),
        "uz": ("Model tayyor", "«{title}» tayyor{price_part}"),
    },
    "share_opened": {
        "ru": ("Клиент смотрит", "Клиент смотрит «{title}» прямо сейчас"),
        "uz": ("Mijoz ko‘ryapti", "Mijoz hozir «{title}» loyihasini ko‘ryapti"),
    },
    "client_agreed": {
        "ru": ("Клиент согласовал", "Клиент согласовал «{title}»"),
        "uz": ("Mijoz rozi bo‘ldi", "Mijoz «{title}» loyihasiga rozi bo‘ldi"),
    },
    "ar_started": {
        "ru": ("Примерка в AR", "Клиент примерил «{title}» у себя в комнате"),
        "uz": ("AR orqali sinash", "Mijoz «{title}»ni o‘z xonasida sinab ko‘rdi"),
    },
    "order_status": {
        "ru": ("Заказ №{number}", "Заказ №{number} {status_text}"),
        "uz": ("Buyurtma №{number}", "Buyurtma №{number} {status_text}"),
    },
    "order_message": {
        "ru": ("Заказ №{number}: сообщение", "{text}"),
        "uz": ("Buyurtma №{number}: xabar", "{text}"),
    },
    "order_return": {
        "ru": ("Заказ №{number}: возврат", "Статус возврата обновлён"),
        "uz": ("Buyurtma №{number}: qaytarish", "Qaytarish holati yangilandi"),
    },
    "order_correction": {
        "ru": ("Заказ №{number}: исправление", "Поставщик исправил заказ — подтвердите в приложении"),
        "uz": ("Buyurtma №{number}: tuzatish", "Yetkazib beruvchi buyurtmani tuzatdi — ilovada tasdiqlang"),
    },
    "order_dispute": {
        "ru": ("Заказ №{number}: спор", "По спору принято решение"),
        "uz": ("Buyurtma №{number}: nizo", "Nizo bo‘yicha qaror qabul qilindi"),
    },
    "broadcast": {
        "ru": ("{head_ru}", "{text_ru}"),
        "uz": ("{head_uz}", "{text_uz}"),
    },
    "price_request_priced": {
        "ru": ("Цена под запрос", "Цена на «{name}» добавлена в смету"),
        "uz": ("So‘rov bo‘yicha narx", "«{name}» narxi smetaga qo‘shildi"),
    },
    "prices_stale": {
        "ru": ("Цены изменились", "Цены поставщика изменились — пересчитайте смету «{title}» перед отправкой"),
        "uz": ("Narxlar o‘zgardi", "Yetkazib beruvchi narxlari o‘zgardi — «{title}» smetasini yuborishdan oldin "
                                   "qayta hisoblang"),
    },
    "limit_one_left": {
        "ru": ("Остался 1 проект", "Остался 1 проект. Закажите материалы по проекту — лимит вернётся"),
        "uz": ("1 ta loyiha qoldi", "1 ta loyiha qoldi. Loyiha bo‘yicha materiallarni buyurtma qiling — limit qaytadi"),
    },
    "nonstandard_estimated": {
        "ru": ("Нестандарт оценён", "«{title}»: {price}, срок {days} дн. Примите цену в приложении"),
        "uz": ("Nostandart baholandi", "«{title}»: {price}, muddat {days} kun. Narxni ilovada qabul qiling"),
    },
    "nonstandard_done": {
        "ru": ("Нестандарт готов", "«{title}»: доработанные файлы в проекте"),
        "uz": ("Nostandart tayyor", "«{title}»: tayyor fayllar loyihada"),
    },
}


def money_short(value: int, lang: str) -> str:
    """9 800 000 → «9,8 млн»; 450 000 → «450 тыс.»."""
    mln, thousand = ("mln", "ming") if lang == "uz" else ("млн", "тыс.")
    if value >= 1_000_000:
        s = f"{value / 1_000_000:.1f}".rstrip("0").rstrip(".").replace(".", ",")
        return f"{s} {mln}"
    if value >= 1000:
        return f"{round(value / 1000)} {thousand}"
    return str(value)


def price_text(price: dict | None, lang: str) -> str:
    if not price:
        return ""
    lo, hi = price.get("from"), price.get("to")
    if lo is None:
        return ""
    if hi is None or hi == lo:
        return money_short(lo, lang)
    unit = " mln" if lang == "uz" else " млн"
    a, b = money_short(lo, lang), money_short(hi, lang)
    if a.endswith(unit) and b.endswith(unit):
        return f"{a[: -len(unit)]}–{b}"
    return f"{a} – {b}"


def render(kind: str, lang: str, params: dict[str, Any]) -> tuple[str, str]:
    lang = lang if lang in ("ru", "uz") else "ru"
    tpl = TEMPLATES[kind][lang]
    p = dict(params)
    if kind == "model_ready":
        pt = price_text(p.get("price"), lang)
        p["price_part"] = f" — {pt}" if pt else ""
    if kind == "order_status":
        text = ORDER_STATUS_TEXT[lang].get(p.get("status", ""), p.get("status", ""))
        p["status_text"] = " ".join(text.format(supplier=p.get("supplier") or "").split())  # без поставщика — без имени
        if p.get("comment"):  # «вернуть мастеру» / «отклонён»: причина — в том же push, без второго про сообщение
            p["status_text"] += f": {p['comment']}"
    if kind == "nonstandard_estimated" and isinstance(p.get("price"), int):
        p["price"] = money_short(p["price"], lang)
    return tpl[0].format(**p), tpl[1].format(**p)[:500]


# --- Создание уведомлений ---


def owners(db: Session, workshop_id: uuid.UUID) -> list[User]:
    return list(db.scalars(select(User).where(User.workshop_id == workshop_id, User.role == Role.owner,
                                             User.is_active.is_(True))))


def project_author(db: Session, project: Project) -> list[User]:
    if project.author_id:
        u = db.get(User, project.author_id)
        if u is not None and u.is_active:
            return [u]
    return owners(db, project.workshop_id)


def notify(db: Session, users: Iterable[User], kind: str, params: dict[str, Any] | None = None, *,
           project: Project | None = None, data: dict[str, Any] | None = None, dedupe_key: str | None = None,
           window: timedelta | None = None) -> list[Notification]:
    """Создаёт уведомления; отправка — после коммита. Повтор с тем же ключом в окне — пропускается
    (window=None — один раз навсегда)."""
    params = params or {}
    if project is not None:
        params.setdefault("title", project.title)
    from .notif_settings import type_enabled

    out = []
    seen: set[uuid.UUID] = set()
    for u in users:
        if u.id in seen:
            continue
        seen.add(u.id)
        if dedupe_key:
            stmt = select(Notification.id).where(Notification.user_id == u.id, Notification.dedupe_key == dedupe_key)
            if window is not None:
                stmt = stmt.where(Notification.created_at > utcnow() - window)
            if db.scalar(stmt.limit(1)) is not None:
                continue
        title, body = render(kind, u.language, params)
        payload = {"kind": kind, **({"project_id": str(project.id)} if project is not None else {}), **(data or {})}
        enabled = type_enabled(u, kind)
        n = Notification(user_id=u.id, workshop_id=u.workshop_id, project_id=project.id if project else None,
                         kind=kind, title=title, body=body, data=payload, dedupe_key=dedupe_key,
                         status="pending" if enabled else "muted")
        db.add(n)
        out.append(n)
    if out:
        db.flush()
        db.info.setdefault("push_pending", []).extend(n.id for n in out if n.status == "pending")
    return out


# --- Отправка после коммита ---


class Notifier:
    def __init__(self, database, sender: PushSender, mode: str = "thread"):
        self.database = database
        self.sender = sender
        self.mode = mode
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="push") if mode == "thread" else None

    def install(self) -> None:
        sm = self.database.sessionmaker
        sm.configure(info={"notifier": self})

        @event.listens_for(sm, "after_commit")
        def _after_commit(session: Session) -> None:
            ids = session.info.pop("push_pending", None)
            notifier = session.info.get("notifier")
            if ids and notifier is not None:
                notifier.submit(list(ids))

        @event.listens_for(sm, "after_rollback")
        def _after_rollback(session: Session) -> None:
            session.info.pop("push_pending", None)

    def submit(self, ids: list[uuid.UUID]) -> None:
        if self._pool is not None:
            self._pool.submit(self._safe_deliver, ids)
        else:
            self._safe_deliver(ids)

    def _safe_deliver(self, ids: list[uuid.UUID]) -> None:
        try:
            self.deliver(ids)
        except Exception:  # отправка не должна ронять запрос или поток
            log.exception("push delivery failed")

    def deliver(self, ids: list[uuid.UUID]) -> None:
        with self.database.sessionmaker() as db:
            db.info.pop("notifier", None)  # отправка не порождает новых отправок
            rows = list(db.scalars(select(Notification).where(Notification.id.in_(ids),
                                                              Notification.status == "pending")))
            from .notif_settings import in_quiet_hours

            messages: list[PushMessage] = []
            targets: list[tuple[Notification, Device]] = []
            now = utcnow()
            for n in rows:
                devices = list(db.scalars(select(Device).where(Device.user_id == n.user_id,
                                                               Device.push_token.is_not(None))))
                if not devices:
                    n.status = "no_devices"
                    continue
                data = {**n.data, "notification_id": str(n.id)}
                user = db.get(User, n.user_id)
                silent = user is not None and in_quiet_hours(user, now)
                for d in devices:
                    messages.append(PushMessage(to=d.push_token, title=n.title, body=n.body, data=data, silent=silent))
                    targets.append((n, d))
            tickets = self.sender.send(messages) if messages else []
            ok: set[uuid.UUID] = set()
            errors: dict[uuid.UUID, str] = {}
            for (n, d), t in zip(targets, tickets):
                if t.get("status") == "ok":
                    ok.add(n.id)
                    continue
                err = (t.get("details") or {}).get("error") or t.get("message") or "error"
                errors[n.id] = str(err)[:500]
                if err == "DeviceNotRegistered":  # приложение удалено — токен больше не действует
                    d.push_token = None
            for n, _ in targets:
                if n.id in ok:
                    n.status, n.sent_at, n.error = "sent", now, None
                elif n.status == "pending":
                    n.status, n.error = "failed", errors.get(n.id)
            db.commit()

    def shutdown(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=True)
