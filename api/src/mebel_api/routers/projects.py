import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, Query, UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from ..db import utcnow
from ..deps import CurrentDep, CurrentUser, DbDep, OwnerDep, SettingsDep, StorageDep
from ..domain import PhotoKind, ProjectStatus as S
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import Client, Measurement, ModelVersion, Project, ProjectPhoto, ProjectStatusChange
from ..schemas.common import Ok, Page
from ..schemas.projects import (
    ActionOut,
    CancelIn,
    DeliverIn,
    MeasurementIn,
    MeasurementOut,
    PhotoOut,
    ProjectCardOut,
    ProjectIn,
    ProjectListItem,
    ProjectUpdateIn,
    StatusChangeOut,
)
from ..services import lifecycle, titles
from ..services.activity import activities
from ..services.estimate import compute_range, is_measured, master_estimate, remember, staff_estimate
from ..services.limits import charge_project
from ..services.visibility import for_employee

router = APIRouter(prefix="/projects", tags=["projects"], responses=ERROR_RESPONSES)

ALLOWED_PHOTO_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic"}


def get_project(db, current: CurrentUser, project_id: uuid.UUID) -> Project:
    p = db.get(Project, project_id)
    if p is None or p.workshop_id != current.workshop.id or p.deleted_at is not None:
        raise not_found("Проект")
    return p


def _client(db, current: CurrentUser, client_id: uuid.UUID | None) -> Client | None:
    if client_id is None:
        return None
    c = db.get(Client, client_id)
    if c is None or c.workshop_id != current.workshop.id:
        raise not_found("Клиент")
    return c


def _price(cache: dict | None) -> dict | None:
    if not cache or cache.get("from") is None:
        return None
    return {"from": cache["from"], "to": cache["to"]}


def list_item(p: Project, price_cache: dict | None = None, activity: dict | None = None) -> ProjectListItem:
    return ProjectListItem.model_validate(
        {**{k: getattr(p, k) for k in ProjectListItem.model_fields if hasattr(p, k) and k not in ("price", "activity")},
         "status_label": lifecycle.label(p.status), "client": p.client, "price": _price(price_cache),
         "activity": activity, "short_date": titles.short_date(p), "title_source": p.title_source or titles.USER}
    )


def price_caches(db, projects: list[Project]) -> dict:
    """Кэш цены текущих версий одним запросом — список проектов без пересчёта сметы."""
    ids = [p.current_version_id for p in projects if p.current_version_id]
    if not ids:
        return {}
    return dict(db.execute(select(ModelVersion.id, ModelVersion.price_cache).where(ModelVersion.id.in_(ids))).all())


def project_estimate(db, current: CurrentUser, p: Project):
    """Смета по текущей версии: владелец — с себестоимостью, сотрудник — без. Цена запоминается в версии."""
    version = lifecycle.current_version(db, p)
    er = compute_range(version, current.workshop, measured=is_measured(p))
    if er is None:
        return None
    remember(db, p, version, er)
    return master_estimate(er, current.workshop) if current.sees_cost else staff_estimate(er)


def project_card(db, current: CurrentUser, p: Project, with_estimate: bool = False) -> ProjectCardOut:
    """Смета (50–160 мс) считается только для GET карточки, не для ответов на переходы."""
    version = lifecycle.current_version(db, p)
    estimate = project_estimate(db, current, p) if with_estimate else None
    card = ProjectCardOut(
        **list_item(p, version.price_cache if version else None).model_dump(by_alias=True),
        source_text=p.source_text,
        frozen_version_id=p.frozen_version_id,
        charged=p.charged_at is not None,
        charge_period=p.charge_period,
        returned_to_limit=p.returned_to_limit_at is not None,
        contract_at=p.contract_at,
        delivered_at=p.delivered_at,
        materials_self_bought=p.materials_self_bought,
        cancelled_at=p.cancelled_at,
        cancel_reason=p.cancel_reason,
        has_order=lifecycle.has_order(db, p),
        photos=[PhotoOut.model_validate(ph) for ph in p.photos],
        model_summary=version.summary if version else None,
        estimate=estimate,
        next_step=lifecycle.next_step(p),
        actions=[ActionOut(code=a.code, label=a.label, to_status=a.to_status) for a in lifecycle.available_actions(p)],
    )
    if not current.sees_cost:  # сотрудник без права не видит себестоимость и наценки
        return ProjectCardOut.model_validate(for_employee(card.model_dump(mode="json", by_alias=True)))
    return card


@router.post("", response_model=ProjectCardOut, status_code=201, summary="Создать проект")
def create_project(body: ProjectIn, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    client = _client(db, current, body.client_id)
    # Нет названия / «Новый проект 03.11.2026» / первая фраза описания — название ведёт сервер
    auto = titles.is_default_title(body.title, body.source_text)
    lang = current.user.language if current.user.language in ("ru", "uz") else "ru"
    p = Project(
        workshop_id=current.workshop.id,
        author_id=current.user.id,
        title=titles.provisional_title(body.source_text, client=client.name if client else None, lang=lang)
        if auto else body.title.strip(),
        title_source=titles.AUTO if auto else titles.USER,
        client_id=body.client_id,
        source_text=body.source_text,
        is_example=body.is_example,
    )
    db.add(p)
    db.flush()
    db.add(ProjectStatusChange(project_id=p.id, from_status=None, to_status=S.draft, actor_user_id=current.user.id))
    db.commit()
    return project_card(db, current, p)


@router.post("/{project_id}/duplicate", response_model=ProjectCardOut, status_code=201, summary="Дублировать проект")
def duplicate_project(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    """Новый черновик «… (копия)» с тем же клиентом, описанием, фото и деревом текущей версии (одна версия v1).
    Ссылки клиента, заказы, замеры, чат не копируются. Лимит — как у нового проекта: списывается при «Черновик → Эскиз»."""
    from ..domain import VersionSource
    from ..services import versions as vs

    src = get_project(db, current, project_id)
    title = src.title if len(src.title) <= 190 else src.title[:190]
    # копия — осознанное название мастера: не переименовываем
    p = Project(workshop_id=current.workshop.id, author_id=current.user.id, title=f"{title} (копия)",
                title_source=titles.USER, client_id=src.client_id, source_text=src.source_text, is_example=False)
    db.add(p)
    db.flush()
    db.add(ProjectStatusChange(project_id=p.id, from_status=None, to_status=S.draft, actor_user_id=current.user.id,
                               note=f"Копия проекта «{src.title}»"))
    for ph in src.photos:  # файл общий — удаление фото в одном проекте его не стирает (см. delete_photo)
        db.add(ProjectPhoto(project_id=p.id, kind=ph.kind, storage_key=ph.storage_key, url=ph.url,
                            content_type=ph.content_type, size_bytes=ph.size_bytes, uploaded_by=current.user.id))
    version = lifecycle.current_version(db, src)
    if version is not None:
        vs.create_version(db, p, version.tree, author_id=current.user.id, source=VersionSource.manual,
                          label_text=f"Копия v{version.number}", estimated=list(version.estimated or []))
    db.commit()
    return project_card(db, current, p)


@router.get("", response_model=Page[ProjectListItem], summary="Список проектов")
def list_projects(
    current: CurrentDep,
    db: DbDep,
    status: Annotated[list[S] | None, Query(description="Фильтр по статусу (можно несколько)")] = None,
    q: Annotated[str | None, Query(description="Поиск по названию, имени или телефону клиента")] = None,
    client_id: uuid.UUID | None = None,
    archived: Annotated[bool, Query(description="true — только архив")] = False,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> Page[ProjectListItem]:
    stmt = (
        select(Project)
        .outerjoin(Client, Project.client_id == Client.id)
        .where(Project.workshop_id == current.workshop.id, Project.deleted_at.is_(None))
        .where(Project.archived_at.is_not(None) if archived else Project.archived_at.is_(None))
    )
    if status:
        stmt = stmt.where(Project.status.in_([s.value for s in status]))
    if client_id:
        stmt = stmt.where(Project.client_id == client_id)
    if q:
        like = f"%{q.strip().lower()}%"
        conds = [func.lower(Project.title).like(like), func.lower(Client.name).like(like)]
        digits = "".join(ch for ch in q if ch.isdigit())
        if digits:
            conds.append(Client.phone.like(f"%{digits}%"))
        stmt = stmt.where(or_(*conds))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = list(db.scalars(
        stmt.options(selectinload(Project.client)).order_by(Project.updated_at.desc()).limit(limit).offset(offset)
    ))
    caches = price_caches(db, rows)
    hints = activities(db, rows, current.user.language)
    return Page(items=[list_item(p, caches.get(p.current_version_id), hints.get(p.id)) for p in rows], total=total,
                limit=limit, offset=offset)


@router.get("/{project_id}", response_model=ProjectCardOut, summary="Карточка проекта")
def get_project_card(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    """Со сметой по текущей версии. Сотрудник получает смету без себестоимости и наценок."""
    return project_card(db, current, get_project(db, current, project_id), with_estimate=True)


@router.patch("/{project_id}", response_model=ProjectCardOut, summary="Изменить название, клиента, описание")
def update_project(project_id: uuid.UUID, body: ProjectUpdateIn, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    p = get_project(db, current, project_id)
    data = body.model_dump(exclude_unset=True)
    if "client_id" in data:
        _client(db, current, data["client_id"])
    if data.get("title", "") is None:
        data.pop("title")
    reset = data.pop("title_source", None) == titles.AUTO
    for k, v in data.items():
        setattr(p, k, v)
    if "title" in data and not reset:
        p.title_source = titles.USER  # мастер ввёл сам — больше не трогаем
    elif reset:
        p.title_source = titles.AUTO
    if p.title_source == titles.AUTO and (reset or {"client_id", "source_text"} & set(data)):
        if "client_id" in data:
            db.flush()
            db.refresh(p, ["client"])
        titles.refresh(db, p)
    db.commit()
    return project_card(db, current, p)


@router.delete("/{project_id}", response_model=Ok, summary="Удалить проект (владелец)")
def delete_project(project_id: uuid.UUID, current: OwnerDep, db: DbDep) -> Ok:
    """Проект с заказом удалить нельзя — только в архив. Удалённый проект не возвращает лимит."""
    p = get_project(db, current, project_id)
    if lifecycle.has_order(db, p):
        raise ApiError(409, "project_has_order", "Проект с заказом удалить нельзя — его можно только отправить в архив")
    p.deleted_at = utcnow()
    db.commit()
    return Ok()


@router.post("/{project_id}/archive", response_model=ProjectCardOut, summary="Отправить в архив")
def archive_project(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    p = get_project(db, current, project_id)
    if p.archived_at is not None:
        raise ApiError(409, "already_archived", "Проект уже в архиве")
    p.archived_at = utcnow()
    db.commit()
    return project_card(db, current, p)


@router.post("/{project_id}/unarchive", response_model=ProjectCardOut, summary="Вернуть из архива")
def unarchive_project(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    p = get_project(db, current, project_id)
    if p.archived_at is None:
        raise ApiError(409, "not_archived", "Проект не в архиве")
    p.archived_at = None
    db.commit()
    return project_card(db, current, p)


@router.get("/{project_id}/history", response_model=list[StatusChangeOut], summary="История статусов")
def status_history(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> list[ProjectStatusChange]:
    p = get_project(db, current, project_id)
    return list(
        db.scalars(
            select(ProjectStatusChange)
            .where(ProjectStatusChange.project_id == p.id)
            .order_by(ProjectStatusChange.created_at, ProjectStatusChange.id)
        )
    )


# --- Переходы статусов (раздел 16 PRD) ---


@router.post("/{project_id}/sketch", response_model=ProjectCardOut, summary="Черновик → Эскиз")
def to_sketch(project_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> ProjectCardOut:
    """Нужна построенная модель без ошибок. В этот момент проект списывается из лимита (кроме примеров)."""
    p = get_project(db, current, project_id)
    lifecycle.ensure_transition(p, S.sketch)
    lifecycle.require_valid_model(db, p, S.sketch)
    charged = charge_project(db, settings, current.workshop, p)
    lifecycle.set_status(db, p, S.sketch, actor_user_id=current.user.id)
    if charged is not None:
        from ..services import events

        events.limit_left(db, settings, current.workshop)  # «Остался 1 проект» (раздел 19)
    db.commit()
    return project_card(db, current, p)


@router.post(
    "/{project_id}/measurements",
    response_model=MeasurementOut,
    status_code=201,
    summary="Внести замер (Эскиз/Отправлен → Замер)",
)
def add_measurement(project_id: uuid.UUID, body: MeasurementIn, current: CurrentDep, db: DbDep) -> Measurement:
    """Повторный замер в статусе «Замер» сохраняется новой записью. После договора замер не меняется."""
    p = get_project(db, current, project_id)
    lifecycle.ensure_active(p)
    status = S(p.status)
    if status == S.draft:
        raise ApiError(409, "illegal_transition", "Сначала сделайте эскиз — замер вносится после него")
    if status not in (S.sketch, S.sent, S.measured):
        raise ApiError(409, "illegal_transition", f"Проект в статусе «{lifecycle.label(status)}» — замер изменить нельзя")
    data = body.model_dump(exclude={"apply_to_model", "kitchen", "niche"})
    if body.kitchen is not None:  # замер кухни — в JSON data (без миграции), стена A — как ширина
        data["data"] = {**data["data"], "kitchen": body.kitchen.model_dump(mode="json", exclude_none=True)}
        if data["width"] is None:
            data["width"] = body.kitchen.wall_a
    if body.niche is not None:  # замер ниши в трёх точках — в JSON data; в колонки — самое узкое место
        n = body.niche
        data["data"] = {**data["data"], "niche": n.model_dump(mode="json", exclude_none=True)}
        for col, values in (("width", n.widths()), ("height", n.heights()), ("depth", [n.depth] if n.depth else [])):
            if data[col] is None and values:
                data[col] = min(values)
    m = Measurement(project_id=p.id, version_id=p.current_version_id, author_id=current.user.id, **data)
    db.add(m)
    if status != S.measured:
        lifecycle.set_status(db, p, S.measured, actor_user_id=current.user.id)
    notes: list[str] = []
    if body.kitchen is not None:
        applied, apply_error, notes = _apply_kitchen_measurement(db, current, p, body)
    else:
        applied, apply_error = _apply_measurement(db, current, p, body)
    if applied is not None:
        m.version_id = applied.id
    db.commit()
    # Смета после замера — точная (measured=True): считается при следующем GET карточки или сметы
    m.applied_version_id = applied.id if applied is not None else None
    m.apply_error = apply_error
    m.apply_notes = notes
    return m


def _apply_kitchen_measurement(db, current: CurrentUser, p: Project, body: MeasurementIn):
    """Замер кухни (стены, окно, коммуникации) → новая версия: ряды под стены, мойка и варка к выводам,
    верхние не на окне (ядро: fit_kitchen). Возвращает (версия, ошибка, что сделано)."""
    from mebel_core import fit_kitchen

    from ..domain import VersionSource
    from ..services import pointers, versions as vs

    version = lifecycle.current_version(db, p)
    if version is None or not body.apply_to_model:
        return None, None, []
    tree = version.tree
    if tree.get("type") != "kitchen":  # не кухня — как обычный замер по ширине
        return (*_apply_measurement(db, current, p, body), [])
    try:
        new_tree, notes = fit_kitchen(tree, body.kitchen)
    except ValueError as e:
        return None, str(e), []
    measured = [f"/{r}/{i}/width" for r in ("base", "base2", "wall", "wall2") for i in range(len(new_tree.get(r, [])))]
    if body.kitchen.ceiling:
        measured.append("/wall_height")
    est = pointers.remove(pointers.carry(version.estimated or [], tree, new_tree), measured)
    k = body.kitchen
    label = f"Замер кухни: стена А {k.wall_a:g}" + (f", Б {k.wall_b:g}" if k.wall_b else "")
    try:
        new = vs.create_version(db, p, new_tree, author_id=current.user.id, source=VersionSource.manual,
                                label_text=label, reject_on_errors=True, estimated=est)
    except ApiError as e:
        return None, e.message, notes
    return new, None, notes


def _apply_measurement(db, current: CurrentUser, p: Project, body: MeasurementIn):
    """Фактические размеры → дерево (ядро: apply_measurements) новой версией; размеры с замера больше не «оценка».
    Если с новыми размерами модель не собирается — версия прежняя, причина в apply_error."""
    from mebel_core import apply_measurements

    from ..domain import VersionSource
    from ..services import pointers, versions as vs

    version = lifecycle.current_version(db, p)
    if version is not None and body.niche is not None and version.tree.get("type") != "kitchen":
        return _apply_niche(db, current, p, body, version)
    dims = {k: getattr(body, k) for k in ("width", "height", "depth") if getattr(body, k) is not None}
    if version is None or not dims:
        return None, None
    measured_ptrs = [f"/{k}" for k in dims]
    tree = version.tree
    if all(tree.get(k) == v for k, v in dims.items()) or not body.apply_to_model:
        if all(tree.get(k) == v for k, v in dims.items()):
            version.estimated = pointers.remove(version.estimated or [], measured_ptrs)
        return None, None
    try:
        new_tree = apply_measurements(tree, **dims)
    except ValueError as e:  # кухня: замер применяется к модулям вручную
        return None, str(e)
    est = pointers.remove(pointers.carry(version.estimated or [], tree, new_tree), measured_ptrs)
    label = "Замер: " + ", ".join(f"{k} {v:g}" for k, v in dims.items())
    try:  # create_version проверяет всё до записи в сессию — откатывать нечего
        new = vs.create_version(db, p, new_tree, author_id=current.user.id, source=VersionSource.manual,
                                label_text=label, reject_on_errors=True, estimated=est)
    except ApiError as e:
        return None, e.message
    return new, None


def _apply_niche(db, current: CurrentUser, p: Project, body: MeasurementIn, version):
    """Замер ниши → встроенный шкаф новой версией: корпус по самому узкому месту минус доборы (ядро: fit_to_niche)."""
    from mebel_core import apply_measurements

    from ..domain import VersionSource
    from ..services import pointers, versions as vs

    if not body.apply_to_model:
        return None, None
    tree = version.tree
    niche = body.niche.model_dump(mode="json", exclude_none=True)
    try:
        new_tree = apply_measurements(tree, niche=niche)
    except ValueError as e:
        return None, str(e)
    measured = ["/width", "/height", "/depth", "/builtin/niche"]
    est = pointers.remove(pointers.carry(version.estimated or [], tree, new_tree), measured)
    n = body.niche

    def rng(values: list[float]) -> str:
        return f"{min(values):g}" if min(values) == max(values) else f"{min(values):g}–{max(values):g}"

    parts = ([f"ширина {rng(n.widths())}"] if n.widths() else []) + \
        ([f"высота {rng(n.heights())}"] if n.heights() else [])
    label = "Замер ниши: " + (", ".join(parts) or "глубина")
    try:
        new = vs.create_version(db, p, new_tree, author_id=current.user.id, source=VersionSource.manual,
                                label_text=label, reject_on_errors=True, estimated=est)
    except ApiError as e:
        return None, e.message
    return new, None


@router.get("/{project_id}/measurements", response_model=list[MeasurementOut], summary="Замеры проекта")
def list_measurements(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> list[Measurement]:
    p = get_project(db, current, project_id)
    return list(db.scalars(select(Measurement).where(Measurement.project_id == p.id).order_by(Measurement.created_at)))


@router.post("/{project_id}/contract", response_model=ProjectCardOut, summary="Замер → Договор (заморозка версии)")
def to_contract(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    """Клиент согласился. Текущая версия модели замораживается; правки — только новой версией."""
    p = get_project(db, current, project_id)
    lifecycle.ensure_transition(p, S.contract)
    version = lifecycle.require_valid_model(db, p, S.contract)
    now = utcnow()
    version.frozen_at = now
    p.frozen_version_id = version.id
    p.contract_at = now
    p.client_agreed_at = p.client_agreed_at or now
    lifecycle.set_status(db, p, S.contract, actor_user_id=current.user.id, note=f"Версия {version.number} заморожена")
    db.commit()
    return project_card(db, current, p)


@router.post("/{project_id}/deliver", response_model=ProjectCardOut, summary="В работе → Сдан / Договор → Сдан")
def deliver(project_id: uuid.UUID, body: DeliverIn, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    p = get_project(db, current, project_id)
    status = S(p.status)
    if status == S.contract and not body.materials_self_bought:
        raise ApiError(
            409,
            "order_not_paid",
            "Заказ в EMAN ещё не оплачен. Если материалы куплены самостоятельно — отметьте «материалы куплены сам»",
        )
    if status == S.in_work and body.materials_self_bought:
        raise ApiError(409, "order_exists", "По проекту оплачен заказ в EMAN — «материалы куплены сам» не отмечается")
    lifecycle.ensure_transition(p, S.delivered)
    p.materials_self_bought = body.materials_self_bought
    p.delivered_at = utcnow()
    lifecycle.set_status(
        db, p, S.delivered, actor_user_id=current.user.id,
        note="Материалы куплены сам" if body.materials_self_bought else None,
    )
    db.commit()
    return project_card(db, current, p)


@router.post("/{project_id}/cancel", response_model=ProjectCardOut, summary="Отменить проект")
def cancel(project_id: uuid.UUID, body: CancelIn, current: CurrentDep, db: DbDep) -> ProjectCardOut:
    """Из любого статуса до «В работе». Списанный проект в лимит не возвращается."""
    p = get_project(db, current, project_id)
    previous = p.status
    lifecycle.set_status(db, p, S.cancelled, actor_user_id=current.user.id, note=body.reason)
    p.cancelled_at = utcnow()
    p.cancelled_from = previous
    p.cancel_reason = body.reason
    db.commit()
    return project_card(db, current, p)


# --- Фото ---


@router.post("/{project_id}/photos", response_model=PhotoOut, status_code=201, summary="Загрузить фото")
async def upload_photo(
    project_id: uuid.UUID,
    current: CurrentDep,
    db: DbDep,
    settings: SettingsDep,
    storage: StorageDep,
    file: UploadFile = File(description="JPEG, PNG, WebP или HEIC, до 10 МБ"),
    kind: PhotoKind = Form(PhotoKind.source),
) -> ProjectPhoto:
    p = get_project(db, current, project_id)
    ext = ALLOWED_PHOTO_TYPES.get((file.content_type or "").lower())
    if ext is None:
        raise ApiError(415, "unsupported_photo", "Загрузите фото в формате JPEG, PNG, WebP или HEIC")
    count = db.scalar(
        select(func.count(ProjectPhoto.id)).where(ProjectPhoto.project_id == p.id, ProjectPhoto.kind == kind)
    ) or 0
    if count >= settings.max_photos_per_kind:
        raise ApiError(409, "too_many_photos", f"Можно загрузить не больше {settings.max_photos_per_kind} фото")
    data = await file.read(settings.max_photo_bytes + 1)
    if len(data) > settings.max_photo_bytes:
        raise ApiError(413, "photo_too_large", f"Фото больше {settings.max_photo_bytes // (1024 * 1024)} МБ")
    if not data:
        raise ApiError(422, "empty_file", "Файл пустой")
    key = f"workshops/{p.workshop_id}/projects/{p.id}/{kind}/{uuid.uuid4().hex}.{ext}"
    stored = storage.save(key, data, file.content_type or "application/octet-stream")
    photo = ProjectPhoto(
        project_id=p.id, kind=kind, storage_key=stored.key, url=stored.url, content_type=file.content_type,
        size_bytes=len(data), uploaded_by=current.user.id,
    )
    db.add(photo)
    db.commit()
    return photo


@router.delete("/{project_id}/photos/{photo_id}", response_model=Ok, summary="Удалить фото")
def delete_photo(project_id: uuid.UUID, photo_id: uuid.UUID, current: CurrentDep, db: DbDep, storage: StorageDep) -> Ok:
    p = get_project(db, current, project_id)
    photo = db.get(ProjectPhoto, photo_id)
    if photo is None or photo.project_id != p.id:
        raise not_found("Фото")
    # Файл общий у проектов, выделенных из одного фото (несколько предметов) — удаляем последнюю ссылку
    shared = db.scalar(select(ProjectPhoto.id).where(ProjectPhoto.storage_key == photo.storage_key,
                                                     ProjectPhoto.id != photo.id).limit(1))
    if shared is None:
        storage.delete(photo.storage_key)
    db.delete(photo)
    db.commit()
    return Ok()
