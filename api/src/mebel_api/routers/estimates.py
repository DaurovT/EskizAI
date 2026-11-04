import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from ..deps import CurrentDep, DbDep
from ..domain import EstimateView
from ..errors import ERROR_RESPONSES, ApiError
from ..schemas.estimate import ClientEstimate, MasterEstimate, StaffEstimate
from ..services import lifecycle
from ..services.estimate import client_estimate, compute_range, is_measured, remember
from .projects import get_project, project_estimate

router = APIRouter(tags=["estimates"], responses=ERROR_RESPONSES)


def _no_estimate(db, p) -> ApiError:
    v = lifecycle.current_version(db, p)
    if v is None:
        return ApiError(409, "model_missing", "Смета появится после построения модели")
    if not v.ok:
        return ApiError(409, "model_invalid", "В модели есть ошибки — исправьте их, чтобы посчитать смету")
    return ApiError(503, "estimate_failed", "Не удалось посчитать смету. Попробуйте позже")


@router.get(
    "/projects/{project_id}/estimate",
    response_model=MasterEstimate | StaffEstimate,
    summary="Смета мастера по текущей версии",
)
def get_estimate(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> MasterEstimate | StaffEstimate:
    """Владелец — с себестоимостью, наценками и строками; сотрудник — только суммы для клиента.
    До замера — диапазон «от–до», после замера — точная цена."""
    p = get_project(db, current, project_id)
    est = project_estimate(db, current, p)
    if est is None:
        raise _no_estimate(db, p)
    return est


@router.get(
    "/projects/{project_id}/estimate/client",
    response_model=ClientEstimate,
    summary="Как смету увидит клиент (предпросмотр перед отправкой)",
)
def client_preview(
    project_id: uuid.UUID,
    current: CurrentDep,
    db: DbDep,
    view: Annotated[EstimateView | None, Query(description="Не задан — вид по умолчанию из профиля цеха")] = None,
) -> dict:
    p = get_project(db, current, project_id)
    version = lifecycle.current_version(db, p)
    er = compute_range(version, current.workshop, measured=is_measured(p))
    if er is None:
        raise _no_estimate(db, p)
    remember(db, p, version, er)
    return client_estimate(er, (view or EstimateView(current.workshop.default_estimate_view)).value, current.workshop)


@router.get("/projects/{project_id}/nesting", summary="Раскрой по листам (SCR-11): листы, детали с координатами, отход")
def nesting(project_id: uuid.UUID, current: CurrentDep, db: DbDep) -> dict:
    """Раскрой ядра (`mebel_core.nest`, гильотинный, с текстурой и пропилом) по версии файлов (после договора —
    замороженной). Размеры — мм; `x`, `y` — от левого нижнего угла листа (обрезка кромок листа учтена);
    `length` идёт вдоль длины листа; `rotated` — деталь повёрнута."""
    from mebel_core import build, nest, parse_tree
    from mebel_core.units import to_mm

    from ..services.files import file_version

    p = get_project(db, current, project_id)
    v = file_version(db, p)
    if v is None:
        raise ApiError(409, "model_missing", "Раскрой появится после построения модели")
    if not v.ok:
        raise ApiError(409, "model_invalid", "В модели есть ошибки — исправьте их, чтобы посчитать раскрой")
    result = build(parse_tree(v.tree))
    n = nest(result)
    try:
        from mebel_core.rules import DEFAULT_RULES

        trim, kerf = DEFAULT_RULES.sheet_trim, DEFAULT_RULES.sheet_kerf
    except Exception:  # внутренний модуль ядра — на случай переименования
        trim, kerf = 100, 40
    names = {part.number: part.name for part in result.parts}
    materials = v.viewer.get("materials", {}) if isinstance(v.viewer, dict) else {}
    out = []
    for m in n.materials:
        mat = materials.get(m.material, {})
        out.append({
            "material": m.material, "material_name": mat.get("name", m.material),
            "has_grain": bool(mat.get("hasGrain", False)), "color": mat.get("color"),
            "sheets_count": len(m.sheets), "waste_percent": m.waste_percent,
            "parts_area_m2": round(m.parts_area / 1e8, 3),
            "sheets": [{
                "index": s.index, "length": to_mm(s.length), "width": to_mm(s.width), "usage": round(s.usage, 3),
                "parts": [{"number": pl.number, "name": names.get(pl.number, ""), "x": to_mm(pl.x + trim),
                           "y": to_mm(pl.y + trim), "length": to_mm(pl.length), "width": to_mm(pl.width),
                           "rotated": pl.rotated} for pl in s.parts],
            } for s in m.sheets],
        })
    return {"version_id": str(v.id), "version_number": v.number, "trim": to_mm(trim), "kerf": to_mm(kerf),
            "materials": out, "sheets_total": sum(len(m.sheets) for m in n.materials),
            "unplaced": [{"number": num, "name": names.get(num, "")} for num in n.unplaced]}
