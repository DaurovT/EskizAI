"""«Попробовать на примере» (PRD §15, SCR-41): пример создаёт только сервер, из готового шаблона.

Пример не списывается из лимита, поэтому клиент не может сам пометить проект примером: один действующий пример
на цех (повторный запрос возвращает его же), за всё время — не больше `example_projects_max`; бюджет ИИ — общий
на все примеры цеха (`ai_example_budget_usd`, services/ai.py)."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..domain import ProjectStatus as S
from ..domain import VersionSource
from ..errors import ApiError
from ..models import Project, ProjectStatusChange, User, Workshop
from . import titles

# Шкаф-купе на 3 двери — тот же шаблон, что в приложении (SAMPLES.kupe_3doors, core/tests/fixtures/kupe_3doors.json)
EXAMPLE_TREE = {
    "schema_version": "0.2", "type": "wardrobe", "width": 2400, "height": 2400, "depth": 650, "installation": "niche",
    "body": {"material": "ldsp_16_white", "top": "between"},
    "sliding_doors": {"count": 3, "fills": ["panel", "mirror", "panel"]},
    "sections": [
        {"width": 780, "fill": [{"kind": "shelves", "count": 5}]},
        {"fill": [{"kind": "drawers", "count": 2, "height": 400}, {"kind": "rod"}]},
        {"width": 780, "fill": [{"kind": "shelves", "count": 5}]},
    ],
}
EXAMPLE_TITLE = {"ru": "Пример: шкаф-купе", "uz": "Namuna: kupe shkaf"}
EXAMPLE_ESTIMATED = ["/width"]  # ширина — «оценка»: мастер видит, как замер уточняет модель


def current_example(db: Session, workshop: Workshop) -> Project | None:
    return db.scalar(select(Project).where(Project.workshop_id == workshop.id, Project.is_example.is_(True),
                                           Project.deleted_at.is_(None))
                     .order_by(Project.created_at.desc()).limit(1))


def get_or_create_example(db: Session, settings: Settings, workshop: Workshop, user: User) -> tuple[Project, bool]:
    """(пример, создан ли сейчас). Коммит — на вызывающем."""
    from .versions import create_version

    # Блокируем строку цеха: два параллельных нажатия не создают два примера (Postgres)
    db.execute(select(Workshop.id).where(Workshop.id == workshop.id).with_for_update())
    existing = current_example(db, workshop)
    if existing is not None:
        return existing, False
    made = db.scalar(select(func.count(Project.id)).where(Project.workshop_id == workshop.id,
                                                          Project.is_example.is_(True))) or 0
    if made >= settings.example_projects_max:
        raise ApiError(409, "example_limit", "Пример уже был создан. Создайте свой проект — первые проекты бесплатны")
    lang = user.language if user.language in EXAMPLE_TITLE else "ru"
    p = Project(workshop_id=workshop.id, author_id=user.id, title=EXAMPLE_TITLE[lang], title_source=titles.USER,
                is_example=True)
    db.add(p)
    db.flush()
    db.add(ProjectStatusChange(project_id=p.id, from_status=None, to_status=S.draft, actor_user_id=user.id))
    create_version(db, p, EXAMPLE_TREE, author_id=user.id, source=VersionSource.manual, label_text=EXAMPLE_TITLE[lang],
                   estimated=list(EXAMPLE_ESTIMATED))
    return p, True
