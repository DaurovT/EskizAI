import uuid

from fastapi import APIRouter, Query
from sqlalchemy import func, or_, select

from ..deps import CurrentDep, DbDep
from ..domain import STATUS_LABELS, ProjectStatus
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import Client, Project
from ..schemas.clients import ClientCardOut, ClientIn, ClientOut, ClientProjectBrief, ClientUpdateIn
from ..schemas.common import Ok, Page
from ..services.auth_codes import normalize_phone

router = APIRouter(prefix="/clients", tags=["clients"], responses=ERROR_RESPONSES)


def get_client(db, current, client_id: uuid.UUID) -> Client:
    c = db.get(Client, client_id)
    if c is None or c.workshop_id != current.workshop.id:
        raise not_found("Клиент")
    return c


def _phone(v: str | None) -> str | None:
    return normalize_phone(v) if v else None


@router.get("", response_model=Page[ClientOut], summary="Список клиентов")
def list_clients(
    current: CurrentDep,
    db: DbDep,
    q: str | None = Query(None, description="Поиск по имени или телефону"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> Page[ClientOut]:
    stmt = select(Client).where(Client.workshop_id == current.workshop.id)
    if q:
        like = f"%{q.strip().lower()}%"
        digits = "".join(ch for ch in q if ch.isdigit())
        conds = [func.lower(Client.name).like(like)]
        if digits:
            conds.append(Client.phone.like(f"%{digits}%"))
        stmt = stmt.where(or_(*conds))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(Client.created_at.desc()).limit(limit).offset(offset))
    return Page(items=[ClientOut.model_validate(c) for c in rows], total=total, limit=limit, offset=offset)


@router.post("", response_model=ClientOut, status_code=201, summary="Создать клиента")
def create_client(body: ClientIn, current: CurrentDep, db: DbDep) -> Client:
    c = Client(workshop_id=current.workshop.id, **body.model_dump(exclude={"phone"}), phone=_phone(body.phone))
    db.add(c)
    db.commit()
    return c


@router.get("/{client_id}", response_model=ClientCardOut, summary="Карточка клиента с проектами")
def client_card(client_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ClientCardOut:
    c = get_client(db, current, client_id)
    projects = db.scalars(
        select(Project)
        .where(Project.client_id == c.id, Project.deleted_at.is_(None))
        .order_by(Project.created_at.desc())
    )
    return ClientCardOut(
        **ClientOut.model_validate(c).model_dump(),
        projects=[
            ClientProjectBrief(
                id=p.id, title=p.title, status=p.status, status_label=STATUS_LABELS[ProjectStatus(p.status)],
                created_at=p.created_at,
            )
            for p in projects
        ],
    )


@router.patch("/{client_id}", response_model=ClientOut, summary="Изменить клиента")
def update_client(client_id: uuid.UUID, body: ClientUpdateIn, current: CurrentDep, db: DbDep) -> Client:
    c = get_client(db, current, client_id)
    data = body.model_dump(exclude_unset=True)
    if "phone" in data:
        data["phone"] = _phone(data["phone"])
    if data.get("name", "") is None:
        data.pop("name")
    for k, v in data.items():
        setattr(c, k, v)
    db.commit()
    return c


@router.delete("/{client_id}", response_model=Ok, summary="Удалить клиента")
def delete_client(client_id: uuid.UUID, current: CurrentDep, db: DbDep) -> Ok:
    c = get_client(db, current, client_id)
    if db.scalar(select(func.count(Project.id)).where(Project.client_id == c.id, Project.deleted_at.is_(None))):
        raise ApiError(409, "client_has_projects", "У клиента есть проекты — удалить его нельзя")
    db.delete(c)
    db.commit()
    return Ok()
