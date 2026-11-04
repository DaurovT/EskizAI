"""Приложение FastAPI. Запуск: uv run uvicorn mebel_api.main:app --reload"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings, get_settings
from .db import Database
from .errors import install_error_handlers
from .routers import (
    admin,
    admin_catalog,
    admin_panel,
    ai,
    auth,
    billing,
    catalog,
    clients,
    devices,
    estimates,
    files,
    models,
    nonstandard,
    orders,
    price_requests,
    projects,
    share,
    tasks,
    workshops,
)
from .routers import admin_platform, app_status, decor, staff, vendor
from .services.ai import AiRunner
from .services.app_status import install_maintenance_guard
from .services.auth_codes import DevCodeSender, RoutingSender
from .services.notify import Notifier, PushSender, make_sender
from .services.storage import make_storage
from .services.tasks import make_task_queue
from .services.uploads import PublicMedia

TAGS = [
    {"name": "auth", "description": "Вход по номеру телефона и одноразовому коду, токены"},
    {"name": "workshops", "description": "Профиль цеха, цены и наценки, сотрудники, журнал изменений"},
    {"name": "clients", "description": "Клиенты мастера"},
    {"name": "projects", "description": "Проекты, статусы (раздел 16 PRD), замеры, фото"},
    {"name": "models", "description": "Дерево модулей → модель; версии, отмена и повтор"},
    {"name": "estimates", "description": "Смета мастера и предпросмотр сметы для клиента"},
    {"name": "share", "description": "Ссылка клиента: создание, публичные данные, события"},
    {"name": "ai", "description": "ИИ: распознавание фото и текста, вопросы, правки словами, чат (асинхронно)"},
    {"name": "files", "description": "Пакет файлов мастера: КП, 3D, спецификация, раскрой, CSV, DXF, чертежи"},
    {"name": "catalog", "description": "Каталог поставщика: декоры, фурнитура, цены с источником и датой"},
    {"name": "orders", "description": "Заказ поставщику из проекта в «Договоре»"},
    {"name": "nonstandard", "description": "Заявки «нестандарт»: отправлена → оценена → в работе → готово"},
    {"name": "devices", "description": "Push-токены устройств и уведомления мастера (раздел 19)"},
    {"name": "billing", "description": "Лимиты проектов и тариф"},
    {"name": "tasks", "description": "Статус фоновых задач (ИИ, раскрой, файлы)"},
    {"name": "admin", "description": "Админка: оплата заказа менеджером, тарифы, журналы"},
    {"name": "staff", "description": "Сотрудники платформы и поставщиков: вход по почте, 2FA, сессии, роли"},
    {"name": "vendor", "description": "Кабинет поставщика: заказы, переписка, исправления, возвраты, прайс, деньги"},
    {"name": "system", "description": "Служебное"},
]


def create_app(settings: Settings | None = None, *, code_sender: DevCodeSender | None = None,
               push_sender: PushSender | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=logging.INFO)
    app = FastAPI(
        title="Мебель API",
        version="0.1.0",
        description="API приложения для мебельщиков: цеха, клиенты, проекты, версии модели, ссылки клиента. "
        "Все суммы — целые сумы (UZS), размеры — мм. Ошибки: `{\"error\": {\"code\", \"message\", \"details\"}}`.",
        openapi_tags=TAGS,
        # В проде схема API и страницы документации не публикуются
        **({"docs_url": None, "redoc_url": None, "openapi_url": None} if settings.env == "prod" else {}),
    )
    app.state.settings = settings
    app.state.db = Database(settings.database_url)
    app.state.storage = make_storage(settings)
    app.state.tasks = make_task_queue(settings.task_queue_mode)
    AiRunner(app.state.db, app.state.storage, settings).register(app.state.tasks)
    from .services import price_import

    app.state.tasks.register("price_source_run",
                             lambda payload: price_import.run_source_task(app.state.db, settings, payload))
    app.state.code_sender = RoutingSender(settings, code_sender)
    # Push: отправитель подменяется (тесты — MemoryPushSender); отправка после коммита сессии
    app.state.push_sender = push_sender or make_sender(settings)
    app.state.notifier = Notifier(app.state.db, app.state.push_sender, mode=settings.task_queue_mode)
    app.state.notifier.install()

    install_error_handlers(app)
    install_maintenance_guard(app)  # техработы: 503 maintenance на изменения проектов (SCR-45)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "X-Model-Version"],
    )
    for r in (auth, workshops, clients, projects, models, estimates, ai, files, catalog, orders, share, billing, tasks,
              devices, nonstandard, price_requests, admin, admin_panel, admin_catalog):
        app.include_router(r.router)
    app.include_router(nonstandard.admin_router)
    app.include_router(price_requests.admin_router)
    app.include_router(app_status.router)
    app.include_router(decor.router)  # /catalog/front-styles, /catalog/lighting-zones
    app.include_router(staff.router)  # /staff/* — сотрудники (docs/staff_vendor_contract.md)
    app.include_router(admin_platform.router)  # суперадмин: поставщики, деньги, споры, лимиты, журнал
    app.include_router(vendor.router)  # /vendor/* — кабинет поставщика
    if settings.price_source_scheduler:
        from .services.price_import import start_scheduler

        start_scheduler(app.state.db, settings)

    if settings.storage_backend == "local":
        # Публичная зона (фото проектов, логотипы); MEDIA_DIR/private — закрытые файлы, по /media не отдаются
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        app.mount(settings.media_base_url,
                  PublicMedia(directory=settings.media_dir, blocked=app.state.storage.private_root), name="media")

    # Текстуры декоров EMAN: статика с кэшем (файлы не меняются под тем же именем)
    settings.textures_dir.mkdir(parents=True, exist_ok=True)
    app.mount(settings.textures_base_url, PublicMedia(directory=settings.textures_dir), name="textures")

    @app.get("/health", tags=["system"], summary="Проверка работы")
    def health() -> dict:
        # Приложению (проверка связи) нужен только код 200; окружение — не в проде
        return {"status": "ok"} if settings.env == "prod" else {"status": "ok", "env": settings.env}

    return app


_app: FastAPI | None = None


def __getattr__(name: str) -> FastAPI:
    """`mebel_api.main:app` создаётся лениво — импорт модуля в тестах не трогает базу."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
