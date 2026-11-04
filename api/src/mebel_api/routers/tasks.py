from fastapi import APIRouter

from ..db import utcnow
from ..deps import CurrentDep, TasksDep
from ..errors import ERROR_RESPONSES, not_found
from ..schemas.common import TaskOut

router = APIRouter(prefix="/tasks", tags=["tasks"], responses=ERROR_RESPONSES)


@router.get("/{task_id}", response_model=TaskOut, summary="Статус фоновой задачи")
def get_task(task_id: str, current: CurrentDep, tasks: TasksDep) -> TaskOut:
    """Тяжёлые операции (ИИ, раскрой, файлы) возвращают task_id; приложение опрашивает раз в 2 секунды."""
    info = tasks.get(task_id)
    if info is None or info.workshop_id != str(current.workshop.id):
        raise not_found("Задача")
    info.seen_at = utcnow()  # приложение на месте — push «модель готова» не нужен
    return TaskOut(
        id=info.id, status=info.state, task_id=info.id, name=info.name, state=info.state, result=info.result, error=info.error,
        created_at=info.created_at, finished_at=info.finished_at,
    )
