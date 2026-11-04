"""Очередь задач для тяжёлых операций (ИИ, раскрой, экспорт файлов).

Сейчас — в процессе API: ThreadTaskQueue (фоновый поток, запрос возвращается
сразу, по умолчанию) или InlineTaskQueue (сразу при постановке — для тестов).
Позже — воркер на Redis (arq/RQ) с тем же интерфейсом: enqueue → task_id,
get → статус и результат. `deps` — объекты процесса (клиент LLM и т. п.);
воркер на Redis будет собирать их сам из настроек.
Приложение опрашивает GET /tasks/{task_id} раз в 2 секунды (раздел 18 PRD).
"""

import logging
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol

from ..db import utcnow

log = logging.getLogger(__name__)

TaskState = Literal["queued", "running", "done", "failed"]
TaskHandler = Callable[..., Any]  # handler(payload, **deps)
ACTIVE: tuple[TaskState, ...] = ("queued", "running")


class TaskBusy(Exception):
    """По этому ключу (например, ИИ в проекте) задача уже стоит в очереди или выполняется."""


@dataclass
class TaskInfo:
    id: str
    name: str
    workshop_id: str | None
    state: TaskState = "queued"
    result: Any = None
    error: str | None = None
    created_at: datetime = field(default_factory=utcnow)
    finished_at: datetime | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    # Когда приложение последний раз спрашивало статус (GET /tasks/{id}); по нему «мастер ушёл» → push
    seen_at: datetime = field(default_factory=utcnow)
    # Не больше одной активной задачи на ключ (ИИ — одна задача на проект); резерв стоимости ($) — пока задача
    # не завершилась, её оценка учитывается в лимитах расходов (services/spend_limits.py)
    key: str | None = None
    reserve_usd: float = 0.0


class TaskQueue(Protocol):
    def register(self, name: str, handler: TaskHandler) -> None: ...

    def add_listener(self, fn: Callable[[TaskInfo], None]) -> None: ...

    def enqueue(
        self, name: str, payload: dict[str, Any], workshop_id: str | None = None, *, deps: dict[str, Any] | None = None,
        key: str | None = None, reserve_usd: float = 0.0,
    ) -> str: ...

    def get(self, task_id: str) -> TaskInfo | None: ...

    def busy(self, key: str) -> bool: ...

    def reserved_usd(self, workshop_id: str | None = None) -> float: ...


class InlineTaskQueue:
    """Выполняет задачу сразу при постановке. Результаты — в памяти процесса."""

    def __init__(self, max_kept: int = 1000):
        self._handlers: dict[str, TaskHandler] = {}
        self._listeners: list[Callable[[TaskInfo], None]] = []
        self._tasks: dict[str, TaskInfo] = {}
        self._lock = threading.Lock()
        self._max_kept = max_kept

    def register(self, name: str, handler: TaskHandler) -> None:
        self._handlers[name] = handler

    def add_listener(self, fn: Callable[[TaskInfo], None]) -> None:
        """fn(info) — после завершения задачи (готово или ошибка). Ошибки слушателя не влияют на задачу."""
        self._listeners.append(fn)

    def _new(self, name: str, workshop_id: str | None, payload: dict[str, Any] | None = None,
             key: str | None = None, reserve_usd: float = 0.0) -> TaskInfo:
        if name not in self._handlers:
            raise KeyError(f"Неизвестная задача: {name}")
        info = TaskInfo(id=uuid.uuid4().hex, name=name, workshop_id=workshop_id, payload=dict(payload or {}),
                        key=key, reserve_usd=reserve_usd)
        with self._lock:
            if key is not None and any(t.key == key and t.state in ACTIVE for t in self._tasks.values()):
                raise TaskBusy(key)
            if len(self._tasks) >= self._max_kept:
                self._tasks.pop(next(iter(self._tasks)))
            self._tasks[info.id] = info
        return info

    def _run(self, info: TaskInfo, payload: dict[str, Any], deps: dict[str, Any] | None) -> None:
        info.state = "running"
        try:
            info.result = self._handlers[info.name](payload, **(deps or {}))
            info.state = "done"
        except Exception as e:  # ошибка задачи не роняет запрос — она в статусе
            log.exception("task %s failed", info.name)
            info.state = "failed"
            info.error = str(e) or e.__class__.__name__
        info.finished_at = utcnow()
        for fn in self._listeners:
            try:
                fn(info)
            except Exception:
                log.exception("task listener failed")

    def enqueue(
        self, name: str, payload: dict[str, Any], workshop_id: str | None = None, *, deps: dict[str, Any] | None = None,
        key: str | None = None, reserve_usd: float = 0.0,
    ) -> str:
        info = self._new(name, workshop_id, payload, key, reserve_usd)
        self._run(info, payload, deps)
        return info.id

    def get(self, task_id: str) -> TaskInfo | None:
        return self._tasks.get(task_id)

    def busy(self, key: str) -> bool:
        with self._lock:
            return any(t.key == key and t.state in ACTIVE for t in self._tasks.values())

    def reserved_usd(self, workshop_id: str | None = None) -> float:
        """Оценка стоимости активных задач (всех или цеха), $."""
        with self._lock:
            return sum(t.reserve_usd for t in self._tasks.values()
                       if t.state in ACTIVE and (workshop_id is None or t.workshop_id == workshop_id))


class ThreadTaskQueue(InlineTaskQueue):
    """Задача выполняется в фоновом потоке; enqueue сразу возвращает task_id (статус queued)."""

    def __init__(self, max_kept: int = 1000, workers: int = 4):
        super().__init__(max_kept)
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="task")

    def enqueue(
        self, name: str, payload: dict[str, Any], workshop_id: str | None = None, *, deps: dict[str, Any] | None = None,
        key: str | None = None, reserve_usd: float = 0.0,
    ) -> str:
        info = self._new(name, workshop_id, payload, key, reserve_usd)
        self._pool.submit(self._run, info, payload, deps)
        return info.id

    def shutdown(self) -> None:
        self._pool.shutdown(wait=True)


def make_task_queue(mode: str = "thread") -> TaskQueue:
    q: InlineTaskQueue = ThreadTaskQueue() if mode == "thread" else InlineTaskQueue()
    q.register("echo", lambda payload: payload)  # проверка очереди
    return q
