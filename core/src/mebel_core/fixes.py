"""Готовые исправления: построение и применение (JSON Patch, RFC 6902)."""

import copy
from typing import Any

from .catalog import THICKER, material
from .parts import Fix, PatchOp


def _tokens(path: str) -> list[str]:
    if not path.startswith("/"):
        raise ValueError(f"Путь должен начинаться с /: {path}")
    return [t.replace("~1", "/").replace("~0", "~") for t in path[1:].split("/")]


def apply_patch(tree: dict, patch: list[PatchOp]) -> dict:
    """Применяет патч к копии дерева модулей и возвращает новое дерево."""
    out = copy.deepcopy(tree)
    for op in patch:
        *parents, last = _tokens(op.path)
        node: Any = out
        for t in parents:
            node = node[int(t)] if isinstance(node, list) else node.setdefault(t, {})
        if isinstance(node, list):
            idx = len(node) if last == "-" else int(last)
            if op.op == "add":
                node.insert(idx, copy.deepcopy(op.value))
            elif op.op == "replace":
                node[idx] = copy.deepcopy(op.value)
            else:
                node.pop(idx)
        else:
            if op.op in ("add", "replace"):
                node[last] = copy.deepcopy(op.value)
            else:
                node.pop(last, None)
    return out


def apply_fix(tree: dict, fix: Fix) -> dict:
    return apply_patch(tree, fix.patch)


def split_section_fix(product, index: int) -> Fix:
    """Разделить секцию перегородкой на две одинаковые."""
    section = product.sections[index].model_dump(exclude_none=True)
    t = material(product.body.material).thickness / 10
    first, second = copy.deepcopy(section), copy.deepcopy(section)
    if "width" in section:
        first["width"] = second["width"] = round((section["width"] - t) / 2, 1)
    if section.get("doors", {}).get("count") == 2:
        first["doors"] = {"count": 1, "hinge": "left"}
        second["doors"] = {"count": 1, "hinge": "right"}
    return Fix(
        description=f"Разделить секцию {index + 1} перегородкой на две",
        patch=[
            PatchOp(op="replace", path=f"/sections/{index}", value=first),
            PatchOp(op="add", path=f"/sections/{index + 1}", value=second),
        ],
    )


def thicker_body_fix(product) -> Fix | None:
    thicker = THICKER.get(product.body.material)
    if not thicker:
        return None
    return Fix(
        description=f"Корпус из {material(thicker).name}",
        patch=[PatchOp(op="replace", path="/body/material", value=thicker)],
    )
