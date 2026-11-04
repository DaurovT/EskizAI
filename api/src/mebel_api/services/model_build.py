"""Построение модели через ядро и сводка версии.

Используются только публичные функции ядра: Product (схема), build(), viewer_model().
"""

import time
from collections import Counter
from dataclasses import dataclass
from typing import Any

from mebel_core import BuildResult, Kitchen, Product, build, parse_tree
from mebel_core.fixes import apply_fix
from mebel_core.parts import Fix
from mebel_core.viewer import viewer_model
from pydantic import ValidationError

from ..errors import ApiError


@dataclass
class Built:
    product: Product | Kitchen
    result: BuildResult
    tree: dict[str, Any]
    viewer: dict[str, Any]
    issues: list[dict[str, Any]]
    summary: dict[str, Any]
    ok: bool
    build_ms: int


def schema_errors(e: ValidationError) -> list[dict[str, Any]]:
    out = []
    for err in e.errors(include_url=False):
        loc = list(err["loc"])
        if loc and loc[0] in ("wardrobe", "kitchen"):  # тег дискриминатора — не часть пути в дереве
            loc = loc[1:]
        out.append({"path": ".".join(str(p) for p in loc), "message": err["msg"], "type": err["type"]})
    return out


def validate_tree(tree: dict[str, Any]) -> Product | Kitchen:
    """Шкаф (`type: wardrobe`, по умолчанию) или прямая кухня (`type: kitchen`)."""
    try:
        return parse_tree(tree)
    except ValidationError as e:
        raise ApiError(
            422,
            "invalid_tree",
            "Дерево модулей не прошло проверку схемы — модель не сохранена",
            schema_errors(e),
        )


def _sections_count(product: Product | Kitchen) -> int:
    if isinstance(product, Kitchen):
        return len(product.base) + len(product.wall)
    return len(product.sections)


def summarize(result: BuildResult, viewer: dict[str, Any]) -> dict[str, Any]:
    """Короткая сводка для списка версий и карточки проекта. Без цен."""
    errors = sum(1 for i in result.issues if i.level == "error")
    hardware: Counter[tuple[str, str]] = Counter()
    for h in result.hardware:
        hardware[(h.kind, h.name)] += h.qty
    materials: Counter[str] = Counter(p.material for p in result.parts)
    return {
        "product_type": result.product.type,
        "size_mm": viewer.get("size"),
        "sections": _sections_count(result.product),
        "parts_count": len(result.parts),
        "materials": [
            {"id": mid, "name": viewer.get("materials", {}).get(mid, {}).get("name", mid), "parts": n}
            for mid, n in sorted(materials.items())
        ],
        "hardware": [{"kind": k, "name": n, "qty": q} for (k, n), q in sorted(hardware.items())],
        "moving_nodes": len(result.nodes),
        "errors": errors,
        "warnings": len(result.issues) - errors,
    }


def build_tree(tree: dict[str, Any]) -> Built:
    product = validate_tree(tree)
    started = time.perf_counter()
    try:
        result = build(product)
        viewer = viewer_model(result)
    except Exception as e:  # ядро не должно падать, но правка не должна ронять API
        raise ApiError(422, "build_failed", f"Не удалось собрать модель: {e}") from e
    build_ms = int((time.perf_counter() - started) * 1000)
    issues = [i.model_dump() for i in result.issues]
    return Built(
        product=product,
        result=result,
        tree=product.model_dump(mode="json"),
        viewer=viewer,
        issues=issues,
        summary=summarize(result, viewer),
        ok=result.ok,
        build_ms=build_ms,
    )


def product_json_schema() -> dict[str, Any]:
    """Схема дерева: шкаф или прямая кухня (дискриминатор — поле `type`)."""
    from pydantic import TypeAdapter
    from typing import Annotated, Union
    from pydantic import Field

    return TypeAdapter(Annotated[Union[Product, Kitchen], Field(discriminator="type")]).json_schema()


def apply_issue_fix(tree: dict[str, Any], issues: list[dict[str, Any]], issue_index: int, fix_index: int):
    """Дерево с применённым исправлением и его описание."""
    if issue_index >= len(issues):
        raise ApiError(404, "issue_not_found", "Такого замечания в текущей версии нет")
    fixes = issues[issue_index].get("fixes") or []
    if fix_index >= len(fixes):
        raise ApiError(404, "fix_not_found", "У этого замечания нет такого исправления")
    fix = Fix.model_validate(fixes[fix_index])
    try:
        return apply_fix(tree, fix), fix.description
    except (KeyError, IndexError, ValueError, TypeError) as e:
        raise ApiError(409, "fix_not_applicable", f"Исправление не подходит к текущей модели: {e}") from e
