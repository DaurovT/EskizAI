"""Свои шаблоны цеха (shapes_contract.md §9.7, FR-T3): «Ещё → Сохранить как шаблон» в редакторе.

Шаблон — изделие целиком без комнаты, проёма и принятых предупреждений. Видят все сотрудники цеха;
сохранить может владелец, менеджер и замерщик, удалить — владелец, менеджер или автор.
В GET /oyna/templates свои шаблоны идут первыми с own: true; POST /oyna/positions/from-template принимает их id.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from oyna_core import commands

from . import store
from .auth import Ctx, ctx, need_company, require

router = APIRouter(prefix="/oyna/company/templates", tags=["цех"])
CATEGORIES = ("window", "door", "balcony", "sliding", "shaped", "muntins", "corner", "facade")
STRIP = ("id", "room", "opening", "accepted_warnings", "qty", "template")


class TemplateIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    short: str | None = Field(None, max_length=22)
    category: str | None = None
    doc: dict[str, Any]


def _cat():
    from .app import CAT
    return CAT


def _is_uuid(v: str) -> bool:
    try:
        uuid.UUID(str(v))
        return True
    except ValueError:
        return False


def guess_category(doc: dict) -> str:
    kind = doc.get("kind", "window")
    root = (doc.get("frame") or {}).get("root") or {}
    if kind == "assembly" or "assembly" in root:
        return "corner"
    if (doc.get("frame") or {}).get("shape") not in (None, "rect"):
        return "shaped"
    return {"door": "door", "balcony_block": "balcony", "sliding": "sliding"}.get(kind, "window")


def row_out(r: dict) -> dict:
    """Строка company_templates → формат /oyna/templates (как системный шаблон) + own, doc."""
    from .app import template_row
    t = commands.template_from_doc(r["doc_json"])
    out = template_row({"id": str(r["id"]), "name": r["name"], "short": r.get("short") or r["name"][:22],
                        "category": r["category"], "ready": "sliding" not in t["root"], **t})
    out.update(own=True, doc=r["doc_json"], created_at=store.iso(r["created_at"]),
               created_by=str(r["created_by"]) if r.get("created_by") else None)
    return out


def own_templates(company_id: str | None) -> list[dict]:
    if not company_id or not store.dsn():
        return []
    with store.conn() as c:
        rows = c.execute("SELECT * FROM company_templates WHERE company_id = %s ORDER BY created_at DESC",
                         (company_id,)).fetchall()
    return [row_out(r) for r in rows]


def own_template(company_id: str | None, tid: str) -> dict | None:
    """Шаблон цеха для from-template (формат commands.template_from_doc) или None."""
    if not company_id or not store.dsn() or not _is_uuid(tid):
        return None
    with store.conn() as c:
        r = c.execute("SELECT * FROM company_templates WHERE company_id = %s AND id = %s", (company_id, tid)).fetchone()
    return commands.template_from_doc(r["doc_json"]) if r else None


@router.get("", summary="Свои шаблоны цеха")
def list_templates(cx: Ctx = Depends(ctx)):
    return own_templates(need_company(cx))


@router.post("", summary="Сохранить изделие как шаблон цеха")
def create_template(body: TemplateIn, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    require(cx, "owner", "manager", "measurer")
    doc = {k: v for k, v in body.doc.items() if k not in STRIP}
    if not isinstance(doc.get("frame"), dict) or "root" not in doc["frame"]:
        raise HTTPException(422, "doc: нужно изделие с frame.root")
    cat = body.category or guess_category(doc)
    if cat not in CATEGORIES:
        raise HTTPException(422, f"category: {' | '.join(CATEGORIES)}")
    try:
        commands.template_from_doc(doc)
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(422, f"изделие не читается: {e}")
    with store.conn() as c:
        r = c.execute("""INSERT INTO company_templates (company_id, name, short, category, doc_json, created_by)
                         VALUES (%s,%s,%s,%s,%s,%s) RETURNING *""",
                      (cid, body.name.strip(), (body.short or "").strip() or None, cat, Jsonb(doc),
                       cx.user_id if cx.user_id and _is_uuid(cx.user_id) else None)).fetchone()
    return row_out(r)


@router.delete("/{template_id}", summary="Удалить шаблон цеха")
def delete_template(template_id: str, cx: Ctx = Depends(ctx)):
    cid = need_company(cx)
    if not _is_uuid(template_id):
        raise HTTPException(404, "шаблон не найден")
    with store.conn() as c:
        r = c.execute("SELECT created_by FROM company_templates WHERE company_id = %s AND id = %s",
                      (cid, template_id)).fetchone()
        if not r:
            raise HTTPException(404, "шаблон не найден")
        if cx.role not in ("owner", "manager") and str(r["created_by"]) != str(cx.user_id):
            raise HTTPException(403, "удалить может владелец, менеджер или автор")
        c.execute("DELETE FROM company_templates WHERE id = %s", (template_id,))
    return {"ok": True}
