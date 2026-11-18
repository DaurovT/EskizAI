"""Модель изделия: дерево, пути к узлам, комплектация по умолчанию, декоры → ценовая группа.

Изделие — JSON (PRD, раздел 6). Узел дерева — словарь:
  лист:    {"cell": {...}}                       (корень-лист или часть {"size":…, "cell":…})
  деление: {"split": "v|h|shtulp|none", "parts": [{"size": …, "cell"|"node": …}, …]}
Путь к узлу — строка индексов частей через точку: "" — корень, "1.0" — 1-я часть корня, в ней 0-я часть.
"""
from __future__ import annotations

import copy

from .data import Catalog

DEFAULT_SYSTEM = "akfa__6000_qvt"
OPENING_CELLS = ("sash", "door_sash")


# ---------- дерево ----------
def root_of(doc: dict) -> dict:
    return doc["frame"]["root"]


def is_leaf(node: dict) -> bool:
    return "cell" in node


def child(part: dict) -> dict:
    """Узел, который лежит в части деления: сама часть (если в ней cell) или part['node']."""
    return part if "cell" in part else part["node"]


def node_at(doc: dict, path: str) -> dict:
    node = root_of(doc)
    for idx in [int(i) for i in path.split(".") if i != ""]:
        if is_leaf(node) or "parts" not in node:
            raise KeyError(f"путь {path}: дальше листа")
        node = child(node["parts"][idx])
    return node


def part_at(doc: dict, path: str) -> dict | None:
    """Часть деления по пути (у неё size) или None для корня."""
    if path == "":
        return None
    parent_path, _, idx = path.rpartition(".")
    parent = node_at(doc, parent_path)
    return parent["parts"][int(idx)]


def walk_cells(node: dict, path: str = ""):
    """Все листья: (path, cell)."""
    if is_leaf(node):
        yield path, node["cell"]
        return
    for i, part in enumerate(node.get("parts", [])):
        yield from walk_cells(child(part), f"{path}.{i}" if path else str(i))


def walk_nodes(node: dict, path: str = ""):
    yield path, node
    if not is_leaf(node):
        for i, part in enumerate(node.get("parts", [])):
            yield from walk_nodes(child(part), f"{path}.{i}" if path else str(i))


def special_root(doc: dict) -> str | None:
    r = root_of(doc)
    for k in ("sliding", "assembly"):
        if k in r:
            return k
    if r.get("shape") not in (None, "rect") or doc["frame"].get("shape") not in (None, "rect"):
        return "shape"
    return None


# ---------- комплектация ----------
def setup_of(doc: dict, cat: Catalog) -> dict:
    """setup с подставленными значениями по умолчанию (документ не меняется)."""
    s = dict(doc.get("setup") or {})
    s.setdefault("system", DEFAULT_SYSTEM)
    s.setdefault("color_out", "white")
    s.setdefault("color_in", "white")
    p = cat.passport(s["system"])
    s.setdefault("glass", p.get("default_glass") or ("g4_12_4" if cat.material(s["system"]) != "alu_thermo" else "g4_16_4"))
    if not s.get("fittings"):
        sets = cat.compatible_fitting_sets(s["system"])
        s["fittings"] = sets[0] if sets else "generic"
    s.setdefault("options", {})
    return s


def cell_options(doc: dict, cell: dict, cat: Catalog) -> dict:
    o = dict(setup_of(doc, cat).get("options") or {})
    o.update(cell.get("options") or {})
    return o


def cell_glass_spec(doc: dict, cell: dict, cat: Catalog) -> str:
    f = cell.get("fill") or {}
    if f.get("kind") == "glass" and f.get("glass"):
        return f["glass"]
    return setup_of(doc, cat)["glass"]


# ---------- декоры ----------
LEGACY_GROUP = {"Белый": "white"}


def decor(cat: Catalog, decor_id: str) -> dict:
    if decor_id in cat.decors:
        return cat.decors[decor_id]
    # старые документы: в color_* лежала ценовая группа
    return {"id": decor_id, "kind": {"Белый": "white", "Эксклюзив": "exclusive"}.get(decor_id, "lamination"),
            "legacy_group": decor_id}


def price_group(cat: Catalog, system: str, color_out: str, color_in: str) -> str:
    """Ценовая группа прайса (колонка color каталога) по декорам снаружи и внутри (decors.json)."""
    d_out, d_in = decor(cat, color_out), decor(cat, color_in)
    for d in (d_out, d_in):
        if d.get("legacy_group") and d["legacy_group"] != "Белый":
            return d["legacy_group"]
    mat = cat.material(system)
    if mat.startswith("alu"):
        order = ["white", "powder", "vacuum", "lamination", "exclusive"]
        k = max((d_out["kind"], d_in["kind"]), key=lambda x: order.index(x) if x in order else 0)
        return cat.decors_cfg["alu_kind_to_group"].get(k, "Белый")
    kinds = {d_out["kind"], d_in["kind"]}
    if kinds == {"white"}:
        return "Белый"
    if "exclusive" in kinds:
        return "Эксклюзив"
    if "white" in kinds:
        return "Внешний внутренний"
    return "Ламинация"


def clone(doc: dict) -> dict:
    return copy.deepcopy(doc)
