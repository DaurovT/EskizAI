"""Версии модели: каждая правка — новая версия (решение D2 плана).

Текущая версия — указатель project.current_version_id. Отмена — переход к
родителю текущей версии, повтор — к самому новому потомку текущей версии.
Замороженная версия (договор) не меняется никогда; правки после договора —
только новыми версиями.
"""

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..domain import ProjectStatus as S, VersionSource
from ..errors import ApiError
from ..models import ModelVersion, Project
from .lifecycle import ensure_active, label
from . import pointers
from .model_build import build_tree

EDITABLE = {S.draft, S.sketch, S.sent, S.measured, S.contract}


def ensure_model_editable(project: Project) -> None:
    ensure_active(project)
    if S(project.status) not in EDITABLE:
        raise ApiError(
            409,
            "model_locked",
            f"Проект в статусе «{label(project.status)}» — модель изменить нельзя",
        )


def ensure_version_mutable(version: ModelVersion) -> None:
    if version.frozen:
        raise ApiError(
            409,
            "version_frozen",
            "Эта версия заморожена договором и не меняется. Правки — только новой версией",
        )


def _next_number(db: Session, project_id: uuid.UUID) -> int:
    return (db.scalar(select(func.max(ModelVersion.number)).where(ModelVersion.project_id == project_id)) or 0) + 1


def create_version(
    db: Session,
    project: Project,
    tree: dict[str, Any],
    *,
    author_id: uuid.UUID | None,
    source: VersionSource = VersionSource.manual,
    label_text: str | None = None,
    reject_on_errors: bool = False,
    estimated: list[str] | None = None,
) -> ModelVersion:
    """estimated=None — пометки «оценка» переходят от текущей версии (кроме изменённых значений)."""
    ensure_model_editable(project)
    built = build_tree(tree)
    if reject_on_errors and not built.ok:
        raise ApiError(
            422,
            "model_has_errors",
            "Правка не применена: модель с этой правкой не собирается — "
            + "; ".join(i["message"] for i in built.issues if i["level"] == "error"),
            {"issues": built.issues},
        )
    # Смена типа изделия после эскиза — это новый проект (раздел 9 PRD)
    if project.status != S.draft and project.product_type and built.product.type != project.product_type:
        raise ApiError(
            409,
            "product_type_changed",
            "Смена типа изделия после эскиза создаёт новый проект — создайте проект заново",
        )
    parent = db.get(ModelVersion, project.current_version_id) if project.current_version_id else None
    if estimated is None:
        estimated = pointers.carry(parent.estimated or [], parent.tree, built.tree) if parent else []
    version = ModelVersion(
        estimated=pointers.clean(estimated),
        project_id=project.id,
        number=_next_number(db, project.id),
        parent_id=project.current_version_id,
        source=source,
        label=label_text,
        author_id=author_id,
        tree=built.tree,
        product_type=built.product.type,
        schema_version=built.product.schema_version,
        rules_version=built.result.rules_version,
        module_versions=built.result.module_versions,
        issues=built.issues,
        summary=built.summary,
        viewer=built.viewer,
        ok=built.ok,
        build_ms=built.build_ms,
    )
    db.add(version)
    db.flush()
    project.current_version_id = version.id
    project.product_type = built.product.type
    _retitle(db, project, version)
    return version


def _retitle(db: Session, project: Project, version: ModelVersion) -> None:
    """Автоназвание — по новой текущей версии (дизайн ИИ, замер, правка). Название мастера не трогаем."""
    from . import titles

    try:
        titles.refresh(db, project, version)
    except Exception:  # название не должно ломать сохранение модели
        import logging

        logging.getLogger(__name__).exception("retitle failed for project %s", project.id)


def undo_target(db: Session, project: Project) -> ModelVersion | None:
    if project.current_version_id is None:
        return None
    current = db.get(ModelVersion, project.current_version_id)
    return db.get(ModelVersion, current.parent_id) if current and current.parent_id else None


def redo_target(db: Session, project: Project) -> ModelVersion | None:
    if project.current_version_id is None:
        return None
    return db.scalar(
        select(ModelVersion)
        .where(ModelVersion.parent_id == project.current_version_id)
        .order_by(ModelVersion.number.desc())
        .limit(1)
    )


def undo(db: Session, project: Project) -> ModelVersion:
    ensure_model_editable(project)
    target = undo_target(db, project)
    if target is None:
        raise ApiError(409, "nothing_to_undo", "Отменять нечего — это первая версия модели")
    project.current_version_id = target.id
    _retitle(db, project, target)
    return target


def redo(db: Session, project: Project) -> ModelVersion:
    ensure_model_editable(project)
    target = redo_target(db, project)
    if target is None:
        raise ApiError(409, "nothing_to_redo", "Повторять нечего — это последняя правка")
    project.current_version_id = target.id
    _retitle(db, project, target)
    return target


def restore(db: Session, project: Project, version: ModelVersion, author_id: uuid.UUID | None) -> ModelVersion:
    """Откат к старой версии из списка — новой версией с тем же деревом."""
    return create_version(
        db,
        project,
        version.tree,
        author_id=author_id,
        source=VersionSource.restore,
        label_text=f"Возврат к версии {version.number}",
        estimated=list(version.estimated or []),
    )
