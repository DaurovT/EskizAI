"""Пакет файлов мастера (разделы 8–9 PRD).

- КП клиенту (PDF) и 3D (GLB закрыто / открыто) — бесплатно всегда.
- Производственные файлы (спецификация, карты раскроя, CSV, DXF, чертежи, общий вид, схема сборки,
  Excel со сметой) — бесплатно, когда по проекту оплачен заказ в EMAN (статус «В работе» / «Сдан»)
  или есть доступ к файлам (оплата файлов, решение менеджера). Pro — скидка на оплату (пока флаг).
  Иначе 402 «Файлы — после заказа в EMAN или оплаты».
- Сотрудник получает Excel без себестоимости (with_cost=False).
- После «Договора» файлы строятся только по замороженной версии.
- Файлы генерируются на сервере по запросу; в каждом — проект, версия и дата.
"""

import io
import re
import zipfile
from dataclasses import dataclass
from zoneinfo import ZoneInfo

import mebel_core
from mebel_core import BuildResult, build, client_view, estimate, nest, parse_tree
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import utcnow
from ..domain import EstimateView, Plan, ProjectStatus as S
from ..errors import ApiError
from ..models import FileAccess, ModelVersion, Order, Project, ShareLink, User, Workshop
from .estimate import compute_range, is_measured, pricing_settings

LOCKED_MESSAGE = "Файлы — после заказа в EMAN или оплаты"


@dataclass(frozen=True)
class FileKind:
    kind: str
    title: str
    ext: str
    content_type: str
    group: str  # purchase | production | assembly | client | model3d
    free: bool


PDF, XLSX = "application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
KINDS: dict[str, FileKind] = {k.kind: k for k in [
    FileKind("spec_xlsx", "Спецификация и смета мастера (Excel)", "xlsx", XLSX, "purchase", False),
    FileKind("spec_pdf", "Спецификация деталей (PDF)", "pdf", PDF, "purchase", False),
    FileKind("cutmaps_pdf", "Карты раскроя (PDF)", "pdf", PDF, "purchase", False),
    FileKind("csv", "CSV для онлайн-кроя", "csv", "text/csv; charset=utf-8", "purchase", False),
    FileKind("dxf_zip", "DXF деталей (архив)", "zip", "application/zip", "production", False),
    FileKind("drawings_pdf", "Чертежи деталей с присадкой (PDF)", "pdf", PDF, "production", False),
    FileKind("general_view_pdf", "Общий вид (PDF)", "pdf", PDF, "assembly", False),
    FileKind("assembly_pdf", "Схема сборки (PDF)", "pdf", PDF, "assembly", False),
    FileKind("kp_pdf", "Коммерческое предложение (PDF)", "pdf", PDF, "client", True),
    FileKind("glb_closed", "3D-модель, закрыто (GLB)", "glb", "model/gltf-binary", "model3d", True),
    FileKind("glb_open", "3D-модель, открыто (GLB)", "glb", "model/gltf-binary", "model3d", True),
    FileKind("archive", "Весь пакет одним архивом", "zip", "application/zip", "purchase", False),
]}


@dataclass
class Access:
    granted: bool
    basis: str | None  # order | payment | admin
    pro_discount: bool


def file_version(db: Session, project: Project) -> ModelVersion | None:
    """После договора — только замороженная версия."""
    vid = project.frozen_version_id or project.current_version_id
    return db.get(ModelVersion, vid) if vid else None


def production_access(db: Session, project: Project, workshop: Workshop) -> Access:
    pro = workshop.plan == Plan.pro
    if S(project.status) in (S.in_work, S.delivered):
        paid = db.scalar(select(Order.id).where(Order.project_id == project.id, Order.paid_at.is_not(None)).limit(1))
        if paid is not None:
            return Access(True, "order", pro)
    grant = db.scalar(select(FileAccess).where(FileAccess.project_id == project.id)
                      .order_by(FileAccess.created_at.desc()).limit(1))
    if grant is not None:
        return Access(True, grant.basis, pro)
    return Access(False, None, pro)


def purchase_price(db: Session, settings, pro: bool) -> dict:
    """Цена файлов проекта без заказа в EMAN (ADM-12: files_price, files_pro_discount_pct); Pro — со скидкой."""
    from .app_settings import get_setting

    full = int(get_setting(db, settings, "files_price"))
    pct = int(get_setting(db, settings, "files_pro_discount_pct"))
    discount = pct if pro else 0
    return {"price": round(full * (100 - discount) / 100), "full_price": full, "discount_pct": discount,
            "pro_discount_pct": pct, "currency": "UZS"}


def list_files(db: Session, project: Project, workshop: Workshop, language: str, settings) -> dict:
    version = file_version(db, project)
    access = production_access(db, project, workshop)
    items = []
    for k in KINDS.values():
        available, reason = True, None
        if version is None:
            available, reason = False, "Модель ещё не построена"
        elif not version.ok:
            available, reason = False, "В модели есть ошибки — исправьте их"
        elif not k.free and not access.granted:
            available, reason = False, LOCKED_MESSAGE
        items.append({
            "kind": k.kind, "title": k.title, "format": k.ext, "group": k.group, "free": k.free,
            "available": available, "reason": reason, "locked": not k.free and not access.granted,
            "url": f"/projects/{project.id}/files/{k.kind}", "content_type": k.content_type,
            "file_name": file_name(project, version, k, language) if version else None,
        })
    return {
        "version_id": str(version.id) if version else None,
        "version_number": version.number if version else None,
        "frozen": bool(version and version.frozen),
        "access": {"production": access.granted, "basis": access.basis, "pro_discount": access.pro_discount},
        # «Скачать без заказа ≈ 45 000 сум»; null — файлы уже открыты
        "purchase": None if access.granted else purchase_price(db, settings, access.pro_discount),
        "files": items,
    }


def _slug(text: str) -> str:
    s = re.sub(r"[^\w\-]+", "_", text, flags=re.UNICODE).strip("_")
    return s[:60] or "project"


# Короткие имена файлов для мастера: «Шкаф_Азиза_спецификация_v3.pdf» (раздел 8: проект и версия в имени)
FILE_LABELS: dict[str, tuple[str, str]] = {
    "spec_xlsx": ("смета_мастера", "usta_smetasi"),
    "spec_pdf": ("спецификация", "spetsifikatsiya"),
    "cutmaps_pdf": ("карты_раскроя", "kesish_xaritalari"),
    "csv": ("онлайн_крой", "onlayn_kesish"),
    "dxf_zip": ("DXF_детали", "DXF_detallar"),
    "drawings_pdf": ("чертежи_деталей", "detal_chizmalari"),
    "general_view_pdf": ("общий_вид", "umumiy_korinish"),
    "assembly_pdf": ("схема_сборки", "yigish_sxemasi"),
    "kp_pdf": ("КП", "TK"),
    "glb_closed": ("3D_закрыто", "3D_yopiq"),
    "glb_open": ("3D_открыто", "3D_ochiq"),
    "archive": ("пакет_файлов", "fayllar_toplami"),
}


def file_name(project: Project, version: ModelVersion, kind: FileKind, language: str = "ru") -> str:
    ru, uz = FILE_LABELS.get(kind.kind, (kind.kind, kind.kind))
    label = uz if language == "uz" else ru
    return f"{_slug(project.title)}_{label}_v{version.number}.{kind.ext}"


class Builder:
    """Строит файлы одной версии; сборка и раскрой — один раз на запрос."""

    def __init__(self, db: Session, project: Project, workshop: Workshop, version: ModelVersion, *,
                 with_cost: bool, language: str, share_base_url: str = ""):
        self.db, self.project, self.workshop, self.version = db, project, workshop, version
        self.share_base_url = share_base_url
        self.with_cost, self.language = with_cost, language
        self._result: BuildResult | None = None
        self._nesting = None
        today = utcnow().astimezone(ZoneInfo("Asia/Tashkent")).strftime("%d.%m.%Y")
        self.label = f"{project.title} · версия {version.number} · {today}"

    @property
    def result(self) -> BuildResult:
        if self._result is None:
            self._result = build(parse_tree(self.version.tree))
        return self._result

    @property
    def nesting(self):
        if self._nesting is None:
            self._nesting = nest(self.result)
        return self._nesting

    def make(self, kind: str) -> bytes:
        return getattr(self, f"_{kind}")()

    def _spec_xlsx(self) -> bytes:
        from .prices import price_book_for

        est = estimate(self.result, pricing_settings(self.workshop), nesting=self.nesting,
                       prices=price_book_for(self.workshop))
        return mebel_core.export_xlsx(self.result, self.nesting, est, with_cost=self.with_cost)

    def _spec_pdf(self) -> bytes:
        return mebel_core.export_spec_pdf(self.result, project=self.label)

    def _cutmaps_pdf(self) -> bytes:
        return mebel_core.export_cutmaps_pdf(self.result, self.nesting, self.label)

    def _csv(self) -> bytes:
        return mebel_core.export_csv(self.result)

    def _dxf_zip(self) -> bytes:
        return mebel_core.export_dxf_zip(self.result)

    def _drawings_pdf(self) -> bytes:
        return mebel_core.export_part_drawings_pdf(self.result, self.label)

    def _general_view_pdf(self) -> bytes:
        return mebel_core.export_general_view_pdf(self.result, self.label)

    def _assembly_pdf(self) -> bytes:
        return mebel_core.export_assembly_pdf(self.result, self.label)

    def _glb_closed(self) -> bytes:
        return mebel_core.export_glb(self.result, opened=False)

    def _glb_open(self) -> bytes:
        return mebel_core.export_glb(self.result, opened=True)

    def _kp_pdf(self) -> bytes:
        """Смета — снимок последней ссылки клиента по этой версии, иначе вид по умолчанию из профиля цеха."""
        link = self.db.scalar(
            select(ShareLink).where(ShareLink.project_id == self.project.id, ShareLink.version_id == self.version.id,
                                    ShareLink.revoked_at.is_(None), ShareLink.price_snapshot.is_not(None))
            .order_by(ShareLink.created_at.desc()).limit(1)
        )
        if link is not None and link.show_price:
            view = link.price_snapshot
            language = link.language
        else:
            er = compute_range(self.version, self.workshop, measured=is_measured(self.project))
            if er is None:
                raise ApiError(503, "estimate_failed", "Не удалось посчитать смету для КП")
            view = client_view(er, EstimateView(self.workshop.default_estimate_view).value,
                               pricing_settings(self.workshop))
            language = self.language
        author = self.db.get(User, self.project.author_id) if self.project.author_id else None
        phone = self.workshop.phone or (author.phone if author else "")
        w = self.workshop
        terms = {k: v for k, v in (("lead", w.kp_lead), ("payment", w.kp_payment), ("warranty", w.kp_warranty)) if v}
        share_url = f"{self.share_base_url.rstrip('/')}/{link.token}" if link is not None and self.share_base_url else ""
        client = self.project.client.name if self.project.client is not None else ""
        return mebel_core.export_kp_pdf(
            self.result, view, workshop=w.name, master_phone=phone or "", project=self.project.title,
            language=language if language in ("ru", "uz") else "ru", client=client, city=w.city or "",
            number=self.version.number, issued=utcnow().astimezone(ZoneInfo("Asia/Tashkent")).date(),
            share_url=share_url, version=f"v{self.version.number}", terms=terms or None,
        )

    def _archive(self) -> bytes:
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for k in KINDS.values():
                if k.kind == "archive":
                    continue
                z.writestr(file_name(self.project, self.version, k, self.language), self.make(k.kind))
        return out.getvalue()
