import uuid
from typing import Any

from fastapi import APIRouter
from sqlalchemy import select

from ..deps import CurrentDep, DbDep
from ..domain import ProjectStatus as S, VersionSource
from ..errors import ERROR_RESPONSES, ApiError, not_found
from ..models import ModelVersion, Project
from ..schemas.models_api import (
    ApplyFixIn,
    ConfirmIn,
    ConfirmOut,
    HardwareApplyIn,
    ModelIn,
    ModelStateOut,
    PartOut,
    ValidateIn,
    ValidateOut,
    VersionBrief,
    VersionOut,
    VersionUpdateIn,
)
from ..services import versions as vs
from ..services.model_build import apply_issue_fix, build_tree, product_json_schema
from .projects import get_project

router = APIRouter(tags=["models"], responses=ERROR_RESPONSES)


def _version_price(v: ModelVersion) -> dict | None:
    c = v.price_cache
    if not c or c.get("from") is None:
        return None
    return {"from": c["from"], "to": c["to"], "exact": bool(c.get("exact"))}


def _brief_data(v: ModelVersion, project: Project) -> dict[str, Any]:
    return {
        **{k: getattr(v, k) for k in VersionBrief.model_fields if k not in ("is_current", "price")},
        "is_current": v.id == project.current_version_id,
        "price": _version_price(v),
    }


PRICE_FILL_LIMIT = 10  # сколько версий без цены досчитать за один запрос списка (≈ 50–160 мс каждая)


def _fill_prices(db, project: Project, workshop, versions: list[ModelVersion]) -> None:
    """Цена версии — из кэша сметы; нет кэша — считаем (новые версии первыми) и запоминаем в версии."""
    from ..services.estimate import compute_range, is_measured, price_of

    todo = [v for v in versions if v.ok and _version_price(v) is None][:PRICE_FILL_LIMIT]
    for v in todo:
        er = compute_range(v, workshop, measured=is_measured(project))
        if er is not None:
            v.price_cache = price_of(er)
    if todo:
        db.commit()


def version_out(v: ModelVersion, project: Project) -> VersionOut:
    return VersionOut.model_validate(
        {**_brief_data(v, project), **{k: getattr(v, k) for k in ("tree", "schema_version", "module_versions", "issues", "viewer")}}
    )


def model_state(db, project: Project, v: ModelVersion) -> ModelStateOut:
    return ModelStateOut(
        version=version_out(v, project),
        can_undo=vs.undo_target(db, project) is not None,
        can_redo=vs.redo_target(db, project) is not None,
        frozen_version_id=project.frozen_version_id,
    )


def _get_version(db, project: Project, version_id: uuid.UUID) -> ModelVersion:
    v = db.get(ModelVersion, version_id)
    if v is None or v.project_id != project.id:
        raise not_found("Версия модели")
    return v


@router.get("/models/schema", summary="JSON Schema дерева модулей")
def tree_schema() -> dict[str, Any]:
    """Схема из ядра (mebel_core.Product) — та же, что schemas/product.schema.json."""
    return product_json_schema()


@router.post("/models/validate", response_model=ValidateOut, summary="Проверить дерево модулей без сохранения")
def validate(body: ValidateIn, _: CurrentDep) -> ValidateOut:
    try:
        built = build_tree(body.tree)
    except ApiError as e:
        if e.code == "invalid_tree":
            return ValidateOut(schema_valid=False, ok=False, schema_errors=e.details)
        raise
    return ValidateOut(
        schema_valid=True, ok=built.ok, issues=built.issues, summary=built.summary, build_ms=built.build_ms
    )


@router.get("/projects/{project_id}/model", response_model=ModelStateOut, summary="Текущая версия модели")
def current_model(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ModelStateOut:
    p = get_project(db, current, project_id)
    if p.current_version_id is None:
        raise ApiError(404, "model_missing", "Модель ещё не построена")
    return model_state(db, p, _get_version(db, p, p.current_version_id))


@router.post(
    "/projects/{project_id}/model",
    response_model=ModelStateOut,
    status_code=201,
    summary="Построить модель из дерева модулей (новая версия)",
)
def save_model(project_id: uuid.UUID, body: ModelIn, current: CurrentDep, db: DbDep) -> ModelStateOut:
    """Проверка схемы → сборка ядром (синхронно, ≤ 300 мс) → новая версия, она становится текущей.

    Дерево с ошибкой схемы не сохраняется (422). Модель с ошибками проверок сохраняется
    с `ok=false`, чтобы мастер видел замечания; перейти в «Эскиз» с ней нельзя.
    С `reject_on_errors=true` такая правка отклоняется, текущая версия остаётся прежней.
    """
    p = get_project(db, current, project_id)
    v = vs.create_version(
        db, p, body.tree, author_id=current.user.id, source=VersionSource(body.source), label_text=body.label,
        reject_on_errors=body.reject_on_errors,
    )
    db.commit()
    return model_state(db, p, v)


@router.post(
    "/projects/{project_id}/model/fixes",
    response_model=ModelStateOut,
    status_code=201,
    summary="Применить готовое исправление из замечания (новая версия)",
)
def apply_fix(project_id: uuid.UUID, body: ApplyFixIn, current: CurrentDep, db: DbDep) -> ModelStateOut:
    """Замечания ядра несут `fixes` (JSON Patch над деревом). Исправление применяется к дереву
    текущей версии и сохраняется новой версией — его можно отменить, как любую правку."""
    p = get_project(db, current, project_id)
    if p.current_version_id is None:
        raise ApiError(404, "model_missing", "Модель ещё не построена")
    v = _get_version(db, p, p.current_version_id)
    tree, description = apply_issue_fix(v.tree, v.issues, body.issue_index, body.fix_index)
    new = vs.create_version(db, p, tree, author_id=current.user.id, source=VersionSource.fix, label_text=description)
    db.commit()
    return model_state(db, p, new)


@router.post("/projects/{project_id}/model/undo", response_model=ModelStateOut, summary="Отменить правку")
def undo(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ModelStateOut:
    p = get_project(db, current, project_id)
    v = vs.undo(db, p)
    db.commit()
    return model_state(db, p, v)


@router.post("/projects/{project_id}/model/redo", response_model=ModelStateOut, summary="Повторить правку")
def redo(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ModelStateOut:
    p = get_project(db, current, project_id)
    v = vs.redo(db, p)
    db.commit()
    return model_state(db, p, v)


@router.get("/projects/{project_id}/versions", response_model=list[VersionBrief], summary="Версии модели")
def list_versions(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> list[VersionBrief]:
    p = get_project(db, current, project_id)
    rows = list(db.scalars(select(ModelVersion).where(ModelVersion.project_id == p.id)
                           .order_by(ModelVersion.number.desc())))
    _fill_prices(db, p, current.workshop, rows)
    return [VersionBrief.model_validate(_brief_data(v, p)) for v in rows]


@router.get(
    "/projects/{project_id}/versions/{version_id}",
    response_model=VersionOut,
    summary="Версия модели: дерево, 3D-модель, замечания",
)
def get_version(project_id: uuid.UUID, version_id: uuid.UUID, current: CurrentDep, db: DbDep) -> VersionOut:
    p = get_project(db, current, project_id)
    return version_out(_get_version(db, p, version_id), p)


@router.patch(
    "/projects/{project_id}/versions/{version_id}", response_model=VersionBrief, summary="Подписать версию"
)
def update_version(
    project_id: uuid.UUID, version_id: uuid.UUID, body: VersionUpdateIn, current: CurrentDep, db: DbDep
) -> VersionBrief:
    p = get_project(db, current, project_id)
    v = _get_version(db, p, version_id)
    vs.ensure_version_mutable(v)
    v.label = body.label
    db.commit()
    return VersionBrief.model_validate(_brief_data(v, p))


@router.post(
    "/projects/{project_id}/versions/{version_id}/restore",
    response_model=ModelStateOut,
    status_code=201,
    summary="Вернуться к версии (создаёт новую версию)",
)
def restore_version(project_id: uuid.UUID, version_id: uuid.UUID, current: CurrentDep, db: DbDep) -> ModelStateOut:
    p = get_project(db, current, project_id)
    v = vs.restore(db, p, _get_version(db, p, version_id), current.user.id)
    db.commit()
    return model_state(db, p, v)


@router.post(
    "/projects/{project_id}/versions/{version_id}/confirm",
    response_model=ConfirmOut,
    summary="Подтвердить значения «оценка» (видно на всех устройствах)",
)
def confirm_values(project_id: uuid.UUID, version_id: uuid.UUID, body: ConfirmIn, current: CurrentDep,
                   db: DbDep) -> ConfirmOut:
    """Снимает пометки «оценка» с указанных путей (и их вложенных/родительских путей). Это не меняет дерево,
    поэтому разрешено и для замороженной версии. Правка поля сама снимает пометку в новой версии."""
    from ..services import pointers

    p = get_project(db, current, project_id)
    v = _get_version(db, p, version_id)
    v.estimated = [] if body.all else pointers.remove(v.estimated or [], pointers.clean(body.pointers))
    db.commit()
    return ConfirmOut(version_id=v.id, estimated=v.estimated)


def _hardware_tree(tree: dict) -> dict:
    import copy

    t = copy.deepcopy(tree)
    t.setdefault("hardware", {})
    t.setdefault("fronts", {}).setdefault("handles", {"kind": "bar", "spacing": 128})
    return t


@router.get("/projects/{project_id}/hardware", summary="Фурнитура и замены (SCR-26): варианты с разницей в цене")
def hardware(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    """Группы (петли, класс петель, направляющие, класс направляющих, ручки) из ядра (`hardware_options`):
    у варианта `delta` — разница цены для клиента, сумы (null — с этим вариантом модель не собирается),
    `available`, `note`. Цены — прайс каталога и наценки цеха. Сотрудник не видит суммы."""
    from mebel_core import hardware_options

    from ..services.estimate import pricing_settings
    from ..services.prices import price_book_for

    p = get_project(db, current, project_id)
    if p.current_version_id is None:
        raise ApiError(404, "model_missing", "Модель ещё не построена")
    v = _get_version(db, p, p.current_version_id)
    if not v.ok:
        raise ApiError(409, "model_invalid", "В модели есть ошибки — исправьте их, чтобы подобрать фурнитуру")
    groups = hardware_options(_hardware_tree(v.tree), pricing_settings(current.workshop), price_book_for(current.workshop))
    out = []
    for g in groups:
        opts = []
        for o in g.options:
            d = o.model_dump(mode="json", exclude={"patch"})
            if not current.sees_cost:
                d["delta"] = None if d["delta"] is None else (0 if d["delta"] == 0 else (1 if d["delta"] > 0 else -1))
            opts.append(d)
        out.append({"key": g.key, "title": g.title, "options": opts})
    summary = v.summary.get("hardware", []) if isinstance(v.summary, dict) else []
    return {"version_id": str(v.id), "groups": out, "items": summary,
            "editable": S(p.status) in vs.EDITABLE and p.archived_at is None}


@router.post("/projects/{project_id}/hardware", response_model=ModelStateOut, status_code=201,
             summary="Заменить фурнитуру вариантом (новая версия, отменяется)")
def apply_hardware(project_id: uuid.UUID, body: HardwareApplyIn, current: CurrentDep, db: DbDep) -> ModelStateOut:
    from mebel_core import apply_patch, hardware_options

    from ..services.estimate import pricing_settings
    from ..services.prices import price_book_for

    p = get_project(db, current, project_id)
    vs.ensure_model_editable(p)
    if p.current_version_id is None:
        raise ApiError(404, "model_missing", "Модель ещё не построена")
    v = _get_version(db, p, p.current_version_id)
    tree = _hardware_tree(v.tree)
    groups = hardware_options(tree, pricing_settings(current.workshop), price_book_for(current.workshop))
    group = next((g for g in groups if g.key == body.key), None)
    option = next((o for o in group.options if o.value == body.value), None) if group else None
    if option is None:
        raise ApiError(404, "hardware_option_not_found", "Такого варианта фурнитуры для этой модели нет")
    if option.current:
        raise ApiError(409, "hardware_already_set", "Этот вариант уже выбран")
    if not option.available:
        raise ApiError(409, "hardware_incompatible", f"Вариант несовместим с моделью: {option.note}")
    new_tree = apply_patch(tree, option.patch)
    new = vs.create_version(db, p, new_tree, author_id=current.user.id, source=VersionSource.manual,
                            label_text=f"{group.title}: {option.label}"[:200], reject_on_errors=True)
    db.commit()
    return model_state(db, p, new)


@router.get("/projects/{project_id}/parts/{number}", response_model=PartOut,
            summary="Деталь текущей версии: размеры, распил, кромка, присадка (SCR-25)")
def get_part(project_id: uuid.UUID, number: int, current: CurrentDep, db: DbDep) -> PartOut:
    """Номер детали — как в 3D (`viewer.parts[].number`) и во всех файлах. Сборка ядром синхронно (≤ 300 мс)."""
    from collections import Counter

    from mebel_core import edge_type, material
    from mebel_core.units import to_mm

    p = get_project(db, current, project_id)
    if p.current_version_id is None:
        raise ApiError(404, "model_missing", "Модель ещё не построена")
    v = _get_version(db, p, p.current_version_id)
    built = build_tree(v.tree)
    part = next((x for x in built.result.parts if x.number == number), None)
    if part is None:
        raise not_found("Деталь")
    edges = []
    for side in ("y0", "y1", "x0", "x1"):
        eid = part.edges.get(side)
        et = None
        if eid:
            try:
                et = edge_type(eid)
            except KeyError:
                et = None
        edges.append({"side": side, "edge_id": eid, "name": et.name if et else None,
                      "thickness_mm": to_mm(et.thickness) if et else 0})
    holes: Counter[tuple[str, int]] = Counter((h.purpose or "", h.diameter) for h in part.holes)
    try:
        mat_name = material(part.material).name
    except KeyError:
        mat_name = built.viewer.get("materials", {}).get(part.material, {}).get("name", part.material)
    return PartOut(
        number=part.number, key=part.key, name=part.name, role=part.role, module=part.module,
        material_id=part.material, material=mat_name,
        length_mm=to_mm(part.length), width_mm=to_mm(part.width), thickness_mm=to_mm(part.thickness),
        cut_length_mm=to_mm(part.cut_length), cut_width_mm=to_mm(part.cut_width), grain=part.grain,
        edges=edges,
        holes=[{"purpose": pur, "diameter_mm": to_mm(d), "count": n} for (pur, d), n in sorted(holes.items())],
        grooves=len(part.grooves), cutouts=len(part.cutouts),
        hardware=[{"kind": h.kind, "name": h.name, "qty": h.qty} for h in built.result.hardware
                  if h.module == part.module],
        product_size_mm=list(built.viewer.get("size") or []),
    )
