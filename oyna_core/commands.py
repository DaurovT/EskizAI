"""Команды изменения изделия (PRD, раздел 10). Каждая возвращает НОВЫЙ документ; исходный не меняется.

Одни и те же команды вызывают редактор, мастер замера, шаблоны и ИИ (tool calls).
apply(doc, [{"cmd": "split", "path": "", "dir": "v", "n": 2}, …]) — пакет команд.
"""
from __future__ import annotations

from datetime import datetime, timezone

from .data import Catalog
from .model import child, clone, is_leaf, node_at, part_at, root_of


class CommandError(ValueError):
    pass


def create_from_template(cat: Catalog, template_id: str, w: int | None = None, h: int | None = None,
                         setup: dict | None = None, **pos) -> dict:
    t = cat.templates.get(template_id)
    if not t:
        raise CommandError(f"нет шаблона {template_id}")
    doc = {"id": pos.pop("id", None), "kind": t["kind"], "qty": 1,
           "frame": {"w": w or t["default_w"], "h": h or t["default_h"], "shape": "rect", "root": clone(t["root"])},
           "extras": {}, "accepted_warnings": [], "template": template_id}
    if setup:
        doc["setup"] = dict(setup)
    doc.update(pos)
    return {k: v for k, v in doc.items() if v is not None}


def set_size(doc: dict, w: int | None = None, h: int | None = None) -> dict:
    d = clone(doc)
    if w is not None:
        d["frame"]["w"] = w
    if h is not None:
        d["frame"]["h"] = h
    return d


def split(doc: dict, path: str, dir: str, n: int = 2, sizes: list | None = None) -> dict:
    if dir not in ("v", "h", "shtulp"):
        raise CommandError("dir: v | h | shtulp")
    if n < 2:
        raise CommandError("n ≥ 2")
    d = clone(doc)
    node = node_at(d, path)
    if not is_leaf(node):
        raise CommandError(f"узел {path or 'корень'} уже разделён — делите его часть")
    base = node.pop("cell")
    sizes = sizes or ["eq"] * n
    if len(sizes) != n:
        raise CommandError("sizes: по одному на часть")
    parts = []
    for i in range(n):
        c = dict(base) if i == 0 else {"type": "fixed"}
        if dir == "shtulp":
            c = {"type": "sash", "open": "turn" if i == 0 else "tilt_turn",
                 "hinge": "left" if i == 0 else "right", "handle": True}
        parts.append({"size": sizes[i], "cell": c})
    new = {"split": dir, "parts": parts}
    part = part_at(d, path)
    if part is None:                       # корень
        node.update(new)
    else:                                  # часть деления: лист {"size","cell"} → {"size","node"}
        part["node"] = new
    return d


def merge(doc: dict, path: str) -> dict:
    d = clone(doc)
    node = node_at(d, path)
    if is_leaf(node):
        raise CommandError("объединять нечего — это одна ячейка")
    first = node["parts"][0]
    cell = first.get("cell") or {"type": "fixed"}
    part = part_at(d, path)
    if part is None:
        for k in ("split", "parts"):
            node.pop(k, None)
        node["cell"] = cell
    else:
        part.pop("node", None)
        part["cell"] = cell
    return d


def set_part_size(doc: dict, path: str, size) -> dict:
    if size != "eq" and not isinstance(size, (int, float)):
        raise CommandError("size: число мм или 'eq'")
    d = clone(doc)
    part = part_at(d, path)
    if part is None:
        raise CommandError("у корня нет размера части — используйте set_size")
    part["size"] = size
    return d


CELL_KEYS = {"type", "open", "hinge", "handle", "mosquito", "note"}


def set_cell(doc: dict, path: str, **props) -> dict:
    bad = set(props) - CELL_KEYS
    if bad:
        raise CommandError(f"неизвестные свойства ячейки: {', '.join(sorted(bad))}")
    d = clone(doc)
    node = node_at(d, path)
    if not is_leaf(node):
        raise CommandError("свойства задаются ячейке, а не делению")
    c = node["cell"]
    c.update(props)
    if c.get("type") in ("fixed", "panel"):
        for k in ("open", "hinge", "handle"):
            c.pop(k, None)
        if "mosquito" not in props:          # сетку на глухой оставляем, только если её задали явно (правило 9.1)
            c.pop("mosquito", None)
    elif c.get("type") in ("sash", "door_sash"):
        c.setdefault("open", "tilt_turn")
        c.setdefault("hinge", "left")
        c.setdefault("handle", True)
    return d


def set_fill(doc: dict, path: str, fill: dict | None) -> dict:
    """fill: {"kind": "glass", "glass": "6t-12-4"} | {"kind": "panel", "item": "lambri"} | None — как у позиции."""
    d = clone(doc)
    node = node_at(d, path)
    if not is_leaf(node):
        raise CommandError("заполнение задаётся ячейке")
    if fill is None:
        node["cell"].pop("fill", None)
    else:
        if fill.get("kind") not in ("glass", "panel"):
            raise CommandError("fill.kind: glass | panel")
        node["cell"]["fill"] = dict(fill)
    return d


SETUP_KEYS = {"system", "color_out", "color_in", "glass", "fittings", "options"}


def set_setup(doc: dict, **fields) -> dict:
    bad = set(fields) - SETUP_KEYS
    if bad:
        raise CommandError(f"неизвестные поля комплектации: {', '.join(sorted(bad))}")
    d = clone(doc)
    s = d.setdefault("setup", {})
    if "system" in fields and fields["system"] != s.get("system") and "fittings" not in fields:
        s.pop("fittings", None)          # новый паз — набор подберётся по умолчанию (FR-F1)
    s.update(fields)
    return d


def set_option(doc: dict, group: str, code: str | None, path: str | None = None) -> dict:
    """Вариант детали (handle, hinge, security, extra_lock, hinge_cap): у позиции или у ячейки. code=None — по умолчанию."""
    d = clone(doc)
    if path is None:
        opts = d.setdefault("setup", {}).setdefault("options", {})
    else:
        node = node_at(d, path)
        if not is_leaf(node):
            raise CommandError("вариант задаётся ячейке")
        opts = node["cell"].setdefault("options", {})
    if code is None:
        opts.pop(group, None)
    else:
        opts[group] = code
    return d


def set_extras(doc: dict, **extras) -> dict:
    d = clone(doc)
    d.setdefault("extras", {}).update(extras)
    return d


def mirror(doc: dict) -> dict:
    d = clone(doc)
    swap = {"left": "right", "right": "left"}

    def rec(node):
        if is_leaf(node):
            c = node["cell"]
            if c.get("hinge") in swap:
                c["hinge"] = swap[c["hinge"]]
            return
        if node.get("split") in ("v", "shtulp", "none"):
            node["parts"].reverse()
        for part in node.get("parts", []):
            rec(child(part))

    rec(root_of(d))
    return d


def accept_warning(doc: dict, rule: str, user: str, path: str = "", at: str | None = None) -> dict:
    d = clone(doc)
    d.setdefault("accepted_warnings", []).append(
        {"rule": rule, "path": path, "by": user, "at": at or datetime.now(timezone.utc).isoformat(timespec="seconds")})
    return d


COMMANDS = {f.__name__: f for f in (set_size, split, merge, set_part_size, set_cell, set_fill, set_setup,
                                    set_option, set_extras, mirror, accept_warning)}


def apply(doc: dict, commands: list[dict]) -> dict:
    for c in commands:
        c = dict(c)
        name = c.pop("cmd")
        if name not in COMMANDS:
            raise CommandError(f"нет команды {name}")
        doc = COMMANDS[name](doc, **c)
    return doc
