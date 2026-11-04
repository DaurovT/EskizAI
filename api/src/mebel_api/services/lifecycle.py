"""Жизненный цикл проекта (раздел 16 PRD).

Черновик → Эскиз → Отправлен → Замер → Договор → В работе → Сдан
Эскиз → Замер (без ссылки), Договор → Сдан («материалы куплены сам»),
отмена из любого статуса до «В работе». Проект с заказом — только в архив.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..domain import STATUS_LABELS, ProjectStatus as S
from ..errors import ApiError
from ..models import ModelVersion, Order, Project, ProjectStatusChange

TRANSITIONS: dict[S, set[S]] = {
    S.draft: {S.sketch, S.cancelled},
    S.sketch: {S.sent, S.measured, S.cancelled},
    S.sent: {S.measured, S.cancelled},
    S.measured: {S.contract, S.cancelled},
    S.contract: {S.in_work, S.delivered, S.cancelled},
    S.in_work: {S.delivered},
    S.delivered: set(),
    S.cancelled: set(),
}

# Подсказка «что дальше» для сообщения об ошибке и карточки проекта
NEXT_STEP: dict[S, str] = {
    S.draft: "постройте модель и переведите проект в «Эскиз»",
    S.sketch: "отправьте ссылку клиенту или внесите замер",
    S.sent: "внесите замер",
    S.measured: "отметьте договор с клиентом",
    S.contract: "оформите заказ в EMAN или отметьте «материалы куплены сам»",
    S.in_work: "отметьте сдачу, когда заказ выдан",
    S.delivered: "проект сдан",
    S.cancelled: "проект отменён",
}

# Действия, которые показывает карточка проекта
@dataclass(frozen=True)
class Action:
    code: str
    label: str
    to_status: S | None


ACTIONS: dict[S, list[Action]] = {
    S.draft: [Action("sketch", "Сделать эскиз", S.sketch)],
    S.sketch: [Action("share", "Отправить клиенту", S.sent), Action("measure", "Внести замер", S.measured)],
    S.sent: [Action("share", "Отправить ссылку ещё раз", None), Action("measure", "Внести замер", S.measured)],
    S.measured: [Action("measure", "Изменить замер", None), Action("contract", "Договор подписан", S.contract)],
    S.contract: [
        Action("order", "Заказать в EMAN", S.in_work),
        Action("deliver_self_bought", "Материалы куплены сам — сдать", S.delivered),
    ],
    S.in_work: [Action("deliver", "Отметить сдачу", S.delivered)],
    S.delivered: [],
    S.cancelled: [],
}


def label(status: str) -> str:
    return STATUS_LABELS[S(status)]


def ensure_active(project: Project) -> None:
    if project.archived_at is not None:
        raise ApiError(409, "project_archived", "Проект в архиве — сначала верните его из архива")


def ensure_transition(project: Project, to: S) -> None:
    ensure_active(project)
    current = S(project.status)
    if to in TRANSITIONS[current]:
        return
    if current == S.cancelled:
        raise ApiError(409, "illegal_transition", "Проект отменён — менять его статус нельзя")
    if to == S.cancelled:
        if current == S.in_work:
            msg = "Проект в работе отменить нельзя: заказ уже оплачен. Отмену заказа оформляет менеджер"
        else:
            msg = f"Проект в статусе «{label(current)}» отменить нельзя"
        raise ApiError(409, "illegal_transition", msg, {"from": current, "to": to})
    if current == to:
        msg = f"Проект уже в статусе «{label(current)}»"
    else:
        msg = f"Нельзя перейти из «{label(current)}» в «{label(to)}». Сейчас: {NEXT_STEP[current]}"
    raise ApiError(409, "illegal_transition", msg, {"from": current, "to": to, "allowed": sorted(TRANSITIONS[current])})


def set_status(
    db: Session,
    project: Project,
    to: S,
    *,
    actor_user_id: uuid.UUID | None,
    actor: str = "user",
    note: str | None = None,
) -> None:
    ensure_transition(project, to)
    db.add(
        ProjectStatusChange(
            project_id=project.id,
            from_status=project.status,
            to_status=to,
            actor_user_id=actor_user_id,
            actor=actor,
            note=note,
        )
    )
    project.status = to
    project.updated_at = utcnow()


def current_version(db: Session, project: Project) -> ModelVersion | None:
    return db.get(ModelVersion, project.current_version_id) if project.current_version_id else None


def require_valid_model(db: Session, project: Project, target: S) -> ModelVersion:
    version = current_version(db, project)
    if version is None:
        raise ApiError(409, "model_missing", f"Нельзя перевести в «{label(target)}»: модель ещё не построена")
    if not version.ok:
        errors = [i["message"] for i in version.issues if i.get("level") == "error"]
        raise ApiError(
            409,
            "model_invalid",
            f"Нельзя перевести в «{label(target)}»: в модели есть ошибки — {'; '.join(errors[:3])}",
            {"issues": [i for i in version.issues if i.get("level") == "error"]},
        )
    return version


def has_order(db: Session, project: Project) -> bool:
    return (db.scalar(select(func.count(Order.id)).where(Order.project_id == project.id)) or 0) > 0


def available_actions(project: Project) -> list[Action]:
    if project.archived_at is not None:
        return [Action("unarchive", "Вернуть из архива", None)]
    actions = list(ACTIONS[S(project.status)])
    if S.cancelled in TRANSITIONS[S(project.status)]:
        actions.append(Action("cancel", "Отменить проект", S.cancelled))
    return actions


def next_step(project: Project) -> str:
    return NEXT_STEP[S(project.status)]
