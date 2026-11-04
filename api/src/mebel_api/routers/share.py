import json
import secrets
import uuid
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Header
from fastapi.responses import Response
from mebel_core import build, export_glb, parse_tree
from sqlalchemy import select

from ..db import utcnow
from ..deps import CurrentDep, DbDep, SettingsDep
from ..domain import ESTIMATE_VIEW_LABELS, EstimateView, Plan, ProjectStatus as S, ShareEventKind
from ..errors import ERROR_RESPONSES, ApiError, forbidden, not_found
from ..models import ModelVersion, Project, ShareEvent, ShareLink, User, Workshop
from ..schemas.common import Ok
from ..schemas.projects import ShareLinkIn, ShareLinkOut
from ..schemas.share import AgreeOut, ShareEventIn, ShareGlb, ShareMaster, SharePayload, ShareProject
from ..services import lifecycle
from ..services.estimate import client_estimate, compute_range, is_measured, remember
from ..services.visibility import for_client
from .projects import get_project

router = APIRouter(tags=["share"], responses=ERROR_RESPONSES)

MAX_META_BYTES = 2000


def link_out(link: ShareLink, settings) -> ShareLinkOut:
    return ShareLinkOut.model_validate(
        {**{k: getattr(link, k) for k in ShareLinkOut.model_fields if k != "url"},
         "url": f"{settings.share_base_url.rstrip('/')}/{link.token}"}
    )


@router.post(
    "/projects/{project_id}/share-links",
    response_model=ShareLinkOut,
    status_code=201,
    summary="Создать ссылку клиента (Эскиз → Отправлен)",
)
def create_link(
    project_id: uuid.UUID, body: ShareLinkIn, current: CurrentDep, db: DbDep, settings: SettingsDep
) -> ShareLinkOut:
    """Ссылка показывает текущую версию модели и снимок сметы на момент отправки.

    Из «Эскиза» проект переходит в «Отправлен». До замера цена — диапазон «от–до», после — точная.
    """
    p = get_project(db, current, project_id)
    lifecycle.ensure_active(p)
    status = S(p.status)
    if status == S.draft:
        raise ApiError(409, "illegal_transition", "Черновик отправить нельзя — сначала сделайте эскиз")
    if status == S.cancelled:
        raise ApiError(409, "illegal_transition", "Проект отменён — ссылку отправить нельзя")
    view = body.estimate_view or EstimateView(current.workshop.default_estimate_view)
    if not current.is_owner and view not in current.workshop.employee_estimate_views:
        allowed = ", ".join(f"«{ESTIMATE_VIEW_LABELS[EstimateView(v)]}»" for v in current.workshop.employee_estimate_views)
        raise forbidden(f"Сотрудникам доступны только виды сметы: {allowed}")
    version = lifecycle.require_valid_model(db, p, S.sent)
    er = compute_range(version, current.workshop, measured=is_measured(p))
    remember(db, p, version, er, commit=False)
    now = utcnow()
    link = ShareLink(
        project_id=p.id,
        version_id=version.id,
        token=secrets.token_urlsafe(16),
        language=body.language,
        estimate_view=view,
        show_price=body.show_price,
        expires_at=now + timedelta(days=body.expires_in_days or settings.share_default_days),
        created_by=current.user.id,
        # снимок цены для клиента: после изменения цен клиент видит старую цену с датой
        price_snapshot=client_estimate(er, view, current.workshop) if er else None,
        price_snapshot_at=now if er else None,
    )
    db.add(link)
    if status == S.sketch:
        lifecycle.set_status(db, p, S.sent, actor_user_id=current.user.id)
    db.commit()
    return link_out(link, settings)


@router.get("/projects/{project_id}/share-links", response_model=list[ShareLinkOut], summary="Ссылки проекта и просмотры")
def list_links(project_id: uuid.UUID, current: CurrentDep, db: DbDep, settings: SettingsDep) -> list[ShareLinkOut]:
    p = get_project(db, current, project_id)
    rows = db.scalars(select(ShareLink).where(ShareLink.project_id == p.id).order_by(ShareLink.created_at.desc()))
    return [link_out(link, settings) for link in rows]


@router.delete("/projects/{project_id}/share-links/{link_id}", response_model=Ok, summary="Отозвать ссылку")
def revoke_link(project_id: uuid.UUID, link_id: uuid.UUID, current: CurrentDep, db: DbDep) -> Ok:
    p = get_project(db, current, project_id)
    link = db.get(ShareLink, link_id)
    if link is None or link.project_id != p.id:
        raise not_found("Ссылка")
    link.revoked_at = link.revoked_at or utcnow()
    db.commit()
    return Ok()


def _master(db, project: Project, workshop: Workshop) -> dict:
    """Контакты мастера для клиента: имя автора (если не удалил аккаунт) или цех."""
    author = db.get(User, project.author_id) if project.author_id else None
    if author is not None and author.deleted_at is not None:
        author = None  # сотрудник удалил аккаунт — показываем цех
    return ShareMaster(
        name=((author.name or None) if author else None) or workshop.name,
        workshop=workshop.name,
        city=workshop.city or None,
        phone=workshop.phone or (author.phone if author else "") or "",
        logoUrl=workshop.logo_url if workshop.plan == Plan.pro else None,
    ).model_dump(exclude_none=True)


def _active_link(db, token: str) -> ShareLink:
    link = db.scalar(select(ShareLink).where(ShareLink.token == token))
    if link is None:
        raise ApiError(404, "share_not_found", "Ссылка не найдена. Проверьте адрес или попросите мастера прислать её снова")
    project = db.get(Project, link.project_id)
    workshop = db.get(Workshop, project.workshop_id) if project else None
    # отозвана мастером или аккаунт мастера удалён — страница клиента покажет «ссылка отозвана»
    # контакты мастера на экране «ссылка недоступна» (WEB-3); у удалённого аккаунта — без контактов
    alive = project is not None and workshop is not None and workshop.deleted_at is None
    details = {"master": _master(db, project, workshop)} if alive else None
    if link.revoked_at is not None or not alive:
        raise ApiError(410, "share_revoked", "Ссылка отозвана мастером и больше не работает", details)
    if link.expires_at <= utcnow() or project.deleted_at is not None:
        raise ApiError(410, "share_expired", "Ссылка устарела. Попросите мастера прислать новую", details)
    return link


@router.get("/share/{token}", response_model=SharePayload,
            summary="Данные ссылки клиента (без входа) — SharePayload страницы /p/[token]")
def public_share(token: str, db: DbDep, settings: SettingsDep) -> SharePayload:
    """Только данные для клиента: 3D-модель, контакты мастера, смета в выбранном виде.
    Форма — ровно `SharePayload` из web/src/lib/share-types.ts. 404 — нет ссылки, 410 — устарела.

    Себестоимость, процент наценки, поставщик, артикулы и комиссия сюда не попадают никогда.
    """
    link = _active_link(db, token)
    project = db.get(Project, link.project_id)
    workshop = db.get(Workshop, project.workshop_id)
    version = db.get(ModelVersion, link.version_id)
    viewer = for_client(version.viewer)
    estimate = None
    if link.show_price and link.price_snapshot is not None:
        estimate = for_client(link.price_snapshot)
    glb_base = f"{settings.public_api_url.rstrip('/')}/share/{link.token}/glb"
    size = viewer.get("size") or [0, 0, 0]
    return SharePayload(
        token=link.token,
        lang=link.language,
        expiresAt=link.expires_at.isoformat() if link.expires_at else None,
        agreedAt=link.agreed_at.isoformat() if link.agreed_at else None,
        project=ShareProject(title={"ru": project.title, "uz": project.title}, sizeMm=list(size)[:3],
                             modelVersion=str(version.number)),
        master=_master(db, project, workshop),
        model=viewer,
        glb=ShareGlb(closed=f"{glb_base}/closed", open=f"{glb_base}/open").model_dump(exclude_none=True),
        estimate=estimate,
        priceDate=link.price_snapshot_at.isoformat() if link.show_price and link.price_snapshot_at else None,
    )


@router.get("/share/{token}/glb/{state}", summary="GLB для AR (закрыто / открыто), публичный",
            responses={200: {"content": {"model/gltf-binary": {}}}})
def share_glb(token: str, state: Literal["closed", "open"], db: DbDep) -> Response:
    """Версия, отправленная клиенту; метры, реальный масштаб. Scene Viewer качает файл сам — без входа."""
    link = _active_link(db, token)
    version = db.get(ModelVersion, link.version_id)
    data = export_glb(build(parse_tree(version.tree)), opened=state == "open")
    return Response(content=data, media_type="model/gltf-binary",
                    headers={"Cache-Control": "public, max-age=3600"})


def _record_event(db, link: ShareLink, kind: ShareEventKind, meta: dict, user_agent: str | None) -> None:
    project = db.get(Project, link.project_id)
    now = utcnow()
    db.add(ShareEvent(share_link_id=link.id, project_id=project.id, kind=kind,
                      user_agent=(user_agent or "")[:500] or None, meta=meta))
    if kind == ShareEventKind.opened:
        link.views += 1
        link.first_opened_at = link.first_opened_at or now
    elif kind == ShareEventKind.ar_started:
        link.ar_starts += 1
    elif kind == ShareEventKind.ar_failed:
        link.ar_failures += 1
    elif kind == ShareEventKind.agreed:
        link.agreed_at = link.agreed_at or now
        project.client_agreed_at = project.client_agreed_at or now
    from ..services import events

    events.share_event(db, link, kind)  # «Клиент смотрит прямо сейчас» / «Клиент примерил в AR» (раздел 19)


@router.post("/share/{token}/events", status_code=204, summary="Событие ссылки клиента (без входа)")
def share_event(
    token: str,
    body: ShareEventIn,
    db: DbDep,
    user_agent: Annotated[str | None, Header()] = None,
) -> Response:
    """`{event, at, meta?}` → 204. opened, ar_started, ar_failed — аналитика; agreed — клиент согласовал."""
    kind = body.event_kind
    if kind is None:
        raise ApiError(422, "validation_error", "Нужно поле event")
    if len(json.dumps(body.meta, ensure_ascii=False)) > MAX_META_BYTES:
        raise ApiError(422, "meta_too_large", "Слишком много данных в событии")
    link = _active_link(db, token)
    meta = {**body.meta, **({"at": body.at} if body.at else {})}
    _record_event(db, link, kind, meta, user_agent)
    db.commit()
    return Response(status_code=204)


@router.post("/share/{token}/agree", response_model=AgreeOut, summary="Клиент нажал «Согласен» (без входа)")
def share_agree(token: str, db: DbDep, user_agent: Annotated[str | None, Header()] = None) -> AgreeOut:
    link = _active_link(db, token)
    if link.agreed_at is None:
        _record_event(db, link, ShareEventKind.agreed, {}, user_agent)
        db.commit()
    return AgreeOut(agreedAt=link.agreed_at.isoformat())
