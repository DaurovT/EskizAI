"""Команды изменения изделия (PRD, раздел 10). Каждая возвращает НОВЫЙ документ; исходный не меняется.

Одни и те же команды вызывают редактор, мастер замера, шаблоны и ИИ (tool calls).
apply(doc, [{"cmd": "split", "path": "", "dir": "v", "n": 2}, …]) — пакет команд.
"""
from __future__ import annotations

from datetime import datetime, timezone

from . import shapes as shp
from .data import Catalog
from .model import (GUILLOTINE_DEFAULTS, SLIDING_DEFAULTS, SLIDING_DEMO, assembly_frames, child, clone, frame_of,
                    guillotine_of, guillotine_problems, is_leaf, migrate, node_at, norm_colors, part_at, product_specials,
                    root_of, sliding_of, sliding_problems, special_kind, split_path, sync_assembly)


class CommandError(ValueError):
    pass


TEMPLATE_DOC_KEYS = ("loggia", "addons", "extras", "shutter", "grille", "custom_lines")


def template_from_doc(doc: dict) -> dict:
    """Изделие → шаблон (свои шаблоны цеха, §9.7): дерево, форма, комплектация и добавки; без комнаты и проёма."""
    d = migrate(doc)
    fr = d["frame"]
    t = {"kind": d.get("kind", "window"), "default_w": fr["w"], "default_h": fr["h"], "root": clone(fr["root"])}
    if fr.get("shape") not in (None, "rect"):
        t["shape"], t["shape_params"] = fr["shape"], dict(fr.get("shape_params") or {})
    if d.get("setup"):
        t["setup"] = norm_colors(dict(d["setup"]), write=True)
    for k in TEMPLATE_DOC_KEYS:
        if d.get(k):
            t[k] = clone(d[k])
    return t


def special_system(cat: Catalog, kinds: set, company_systems: list | None = None) -> str:
    """Система для раздвижных / гильотины (§11): своя система цеха с такими изделиями в паспорте, иначе ДЕМО."""
    for code in company_systems or []:
        p = cat.passport(code) if code in cat.systems else {}
        if code != SLIDING_DEMO and kinds and all(p.get(k) for k in kinds):
            return code
    return SLIDING_DEMO


def create_from_template(cat: Catalog, template_id: str, w: int | None = None, h: int | None = None,
                         setup: dict | None = None, template: dict | None = None, company_systems: list | None = None,
                         **pos) -> dict:
    """Изделие из шаблона: системного (templates.json) или переданного (свой шаблон цеха — template_from_doc).

    Раздвижные и гильотина без системы в шаблоне и в setup — на своей раздвижной системе цеха (company_systems),
    иначе на ДЕМО-системе «Раздвижная алюминиевая» (§11)."""
    t = template or cat.templates.get(template_id)
    if not t:
        raise CommandError(f"нет шаблона {template_id}")
    doc = {"id": pos.pop("id", None), "kind": t["kind"], "qty": 1,
           "frame": {"w": w or t["default_w"], "h": h or t["default_h"], "shape": t.get("shape", "rect"),
                     "root": clone(t["root"])},
           "extras": {}, "accepted_warnings": [], "template": template_id}
    if t.get("shape_params"):
        doc["frame"]["shape_params"] = _scale_shape(t.get("shape"), dict(t["shape_params"]), t["default_w"],
                                                    t["default_h"], doc["frame"]["w"], doc["frame"]["h"])
    if setup or t.get("setup"):                        # комплектация шаблона (алюминиевые входные группы) + своя
        doc["setup"] = norm_colors({**(t.get("setup") or {}), **(setup or {})}, write=True)
    for k in TEMPLATE_DOC_KEYS:
        if t.get(k):
            doc[k] = clone(t[k])
    doc.update(pos)
    doc = migrate({k: v for k, v in doc.items() if v is not None}, cat)    # рамы сборки из шаблонов, T16
    if "assembly" in doc["frame"]["root"]:
        if h:                                              # высота сборки — всем рамам
            for x in assembly_frames(doc):
                x["frame"]["h"] = h
        if w and w != doc["frame"]["w"]:                   # ширина — пропорционально развёртке
            k = w / sum(x["frame"]["w"] for x in assembly_frames(doc))
            for x in assembly_frames(doc):
                x["frame"]["w"] = int(round(x["frame"]["w"] * k / 5) * 5)
        sync_assembly(doc)
    _shape_fits(doc["frame"])
    kinds = product_specials(doc)
    if kinds and not (doc.get("setup") or {}).get("system"):
        doc.setdefault("setup", {})["system"] = special_system(cat, kinds, company_systems)
    return doc


def _scale_shape(shape: str | None, sp: dict, w0: float, h0: float, w: float, h: float) -> dict:
    """Параметры формы шаблона — пропорционально новому габариту (полукруг остаётся полукругом)."""
    if (w, h) == (w0, h0) or not w0 or not h0:
        return sp
    kx, ky = w / w0, h / h0
    r5 = lambda v: int(round(v / 5) * 5)
    if shape == "arch" and "rise" in sp:
        semi = sp["rise"] >= min(w0 / 2, h0) - 0.5
        sp["rise"] = min(w / 2, h) if semi else max(50, min(r5(sp["rise"] * ky), w / 2, h))
    elif shape == "trapezoid":
        hl, hr = sp.get("h_left", h0), sp.get("h_right", h0)
        sp["h_left"] = h if hl >= hr else r5(hl * ky)
        sp["h_right"] = h if hr > hl else r5(hr * ky)
    elif shape == "bevel":
        sp["dx"], sp["dy"] = r5(sp.get("dx", 0) * kx), r5(sp.get("dy", 0) * ky)
    elif shape == "triangle" and "apex" in sp:
        sp["apex"] = r5(sp["apex"] * kx)
    return sp


def _shape_fits(fr: dict) -> None:
    if fr.get("shape") not in (None, "rect"):
        probs = shp.shape_problems(fr["shape"], fr.get("shape_params"), fr["w"], fr["h"])
        if probs:
            raise CommandError("; ".join(probs))


def set_size(doc: dict, w: int | None = None, h: int | None = None, path: str = "") -> dict:
    """Габарит рамы. В сборке: path "A1/" — рама; без пути — высота всех рам (ширина сборки = сумма рам)."""
    d = clone(doc)
    if "assembly" in root_of(d):
        i, _ = split_path(path)
        if i is None:
            if w is not None:
                raise CommandError("ширина сборки — сумма рам: задайте раму, path \"A<i>/\"")
            for x in assembly_frames(d):
                if h is not None:
                    x["frame"]["h"] = h
        else:
            fr, _ = frame_of(d, path)
            if w is not None:
                fr["w"] = w
            if h is not None:
                fr["h"] = h
        sync_assembly(d)
        return d
    if w is not None:
        d["frame"]["w"] = w
    if h is not None:
        d["frame"]["h"] = h
    return d


def split(doc: dict, path: str, dir: str, n: int = 2, sizes: list | None = None) -> dict:
    """dir: v | h | shtulp | folding (гармошка: n створок без импостов, §9.1) | vslide (гильотинное окно:
    два полотна сверху вниз — верхнее глухое, нижнее поднимается, §11.2)."""
    if dir not in ("v", "h", "shtulp", "folding", "vslide"):
        raise CommandError("dir: v | h | shtulp | folding | vslide")
    if n < 2:
        raise CommandError("n ≥ 2")
    if dir == "vslide" and n != 2:
        raise CommandError("гильотинное окно (vslide): ровно 2 полотна")
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
        elif dir == "folding":
            c = {"type": base.get("type") if base.get("type") in ("sash", "door_sash") else "door_sash",
                 "open": "folding", "hinge": "left" if i % 2 == 0 else "right", "handle": i == n - 1}
        elif dir == "vslide":
            c = {"type": "sash", "open": "vslide", "slide": "fixed" if i == 0 else "moving", "handle": i == 1}
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


CELL_KEYS = {"type", "open", "hinge", "handle", "mosquito", "note", "open_dir", "threshold", "vent", "slide", "tilt_clean"}
OPENINGS = ("turn", "tilt_turn", "tilt", "sliding", "top_hung", "pivot", "folding", "psk", "hs", "vslide")
SLIDES = ("moving", "fixed")                                 # полотно гильотинного окна (§11.2)
MOSQ_TYPES = ("frame", "sliding", "pleated", "door", "antipet")
THRESHOLDS = ("standard", "low_alu", "none")
HINGE_OF = {"tilt": "bottom", "top_hung": "top"}            # петли, которые задаёт само открывание


def set_cell(doc: dict, path: str, **props) -> dict:
    bad = set(props) - CELL_KEYS
    if bad:
        raise CommandError(f"неизвестные свойства ячейки: {', '.join(sorted(bad))}")
    d = clone(doc)
    node = node_at(d, path)
    if not is_leaf(node):
        raise CommandError("свойства задаются ячейке, а не делению")
    c = node["cell"]
    if "open" in props and props["open"] not in OPENINGS:
        raise CommandError(f"open: {' | '.join(OPENINGS)}")
    if props.get("open_dir") not in (None, "in", "out"):
        raise CommandError("open_dir: in | out")
    if props.get("threshold") not in (None, True, False) + THRESHOLDS:
        raise CommandError(f"threshold: {' | '.join(THRESHOLDS)}")
    m = props.get("mosquito")
    if isinstance(m, dict) and m.get("type", "frame") not in MOSQ_TYPES or isinstance(m, str) and m not in MOSQ_TYPES:
        raise CommandError(f"mosquito.type: {' | '.join(MOSQ_TYPES)}")
    v = props.get("vent")
    if v not in (None, False) and not (isinstance(v, dict) and v.get("type", "supply_valve") == "supply_valve"):
        raise CommandError("vent: {type: 'supply_valve'} | null")
    if props.get("slide") not in (None,) + SLIDES:
        raise CommandError(f"slide: {' | '.join(SLIDES)}")
    if props.get("tilt_clean") not in (None, True, False):
        raise CommandError("tilt_clean: true | false")
    for k in ("open_dir", "threshold", "vent", "slide", "tilt_clean"):
        if k in props and props[k] is None:
            props.pop(k)
            c.pop(k, None)
    c.update(props)
    if "open" in props and "hinge" not in props:             # новое открывание без петель — петли по открыванию
        op = props["open"]
        if op in HINGE_OF:
            c["hinge"] = HINGE_OF[op]
        elif op in ("pivot", "vslide"):
            c.pop("hinge", None)
        elif c.get("hinge") in ("top", "bottom", None):
            c["hinge"] = "left"
    if c.get("open") != "vslide" or c.get("type") in ("fixed", "panel"):
        for k in ("slide", "tilt_clean"):                    # только у полотна гильотинного окна
            c.pop(k, None)
    elif "tilt_clean" in c and not c["tilt_clean"]:
        c.pop("tilt_clean")
    if c.get("type") in ("fixed", "panel"):
        for k in ("open", "hinge", "handle", "open_dir", "threshold"):
            c.pop(k, None)
        if "mosquito" not in props:          # сетку на глухой оставляем, только если её задали явно (правило 9.1)
            c.pop("mosquito", None)
    elif c.get("type") in ("sash", "door_sash"):
        c.setdefault("open", "tilt_turn")
        if c["open"] not in ("pivot", "vslide"):
            c.setdefault("hinge", HINGE_OF.get(c["open"], "left"))
        if c["open"] == "vslide":
            c.setdefault("slide", "moving")
        c.setdefault("handle", True)
    return d


GLASS_DECORS = ("matte", "tinted", "mirror", "pattern", "stained")
TINTS = ("bronze", "grey", "blue")
_UNSET = object()


def set_fill(doc: dict, path: str, fill: dict | None = _UNSET, decor=_UNSET, tint=_UNSET) -> dict:
    """fill: {"kind": "glass", "glass": "6t-12-4", "decor"?: "matte", "tint"?} | {"kind": "panel", "item": "lambri"} | None.

    decor / tint без fill — только декор стекла ячейки (§8): matte | tinted (+ tint bronze|grey|blue) | mirror |
    pattern | stained | None (убрать).
    """
    d = clone(doc)
    node = node_at(d, path)
    if not is_leaf(node):
        raise CommandError("заполнение задаётся ячейке")
    c = node["cell"]
    if fill is not _UNSET:
        if fill is None:
            c.pop("fill", None)
        else:
            if fill.get("kind") not in ("glass", "panel"):
                raise CommandError("fill.kind: glass | panel")
            c["fill"] = dict(fill)
    if decor is not _UNSET or tint is not _UNSET:
        f = c.setdefault("fill", {"kind": "glass"})
        if f.get("kind") != "glass":
            raise CommandError("декор стекла — у ячейки со стеклом")
        if decor is not _UNSET:
            if decor is None:
                f.pop("decor", None)
                f.pop("tint", None)
            else:
                f["decor"] = decor
        if tint is not _UNSET:
            if tint is None:
                f.pop("tint", None)
            else:
                f["tint"] = tint
        if f == {"kind": "glass"}:
            c.pop("fill", None)
    f = c.get("fill") or {}
    if f.get("decor") is not None and f["decor"] not in GLASS_DECORS:
        raise CommandError(f"fill.decor: {' | '.join(GLASS_DECORS)}")
    if f.get("tint") is not None and f["tint"] not in TINTS:
        raise CommandError(f"fill.tint: {' | '.join(TINTS)}")
    return d


MUNTIN_WIDTHS = {"inner": (8, 18, 26), "overlay": (18, 26, 45)}


def set_muntins(doc: dict, path: str, muntins: dict | None = None) -> dict:
    """Раскладка ячейки (§2): {"kind", "v", "h", "width_mm", "pattern", "color"} | None — убрать."""
    d = clone(doc)
    node = node_at(d, path)
    if not is_leaf(node):
        raise CommandError("раскладка задаётся ячейке")
    if muntins is None:
        node["cell"].pop("muntins", None)
        return d
    m = {"kind": "inner", "pattern": "grid", "color": "white", **muntins}
    if m["kind"] not in MUNTIN_WIDTHS:
        raise CommandError("muntins.kind: inner | overlay")
    m.setdefault("width_mm", 18 if m["kind"] == "inner" else 26)
    if m["width_mm"] not in MUNTIN_WIDTHS[m["kind"]]:
        raise CommandError(f"ширина раскладки {m['kind']}: " + ", ".join(map(str, MUNTIN_WIDTHS[m["kind"]])) + " мм")
    if m["pattern"] not in ("grid", "sun", "cross", "decor"):
        raise CommandError("muntins.pattern: grid | sun | cross | decor")
    if m["color"] not in ("white", "decor", "gold"):
        raise CommandError("muntins.color: white | decor | gold")
    for k in ("v", "h"):
        v = m.get(k, 0)
        if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 20:
            raise CommandError(f"muntins.{k}: целое 0…20")
        m[k] = v
    if m["pattern"] == "cross":
        m["v"], m["h"] = 1, 1
    if m["pattern"] in ("grid", "sun") and not (m["v"] or m["h"]):
        raise CommandError("раскладка без прутков: задайте v и/или h или muntins: null")
    node["cell"]["muntins"] = m
    return d


def set_shape(doc: dict, shape: str = "rect", params: dict | None = None, path: str = "") -> dict:
    """Форма рамы (§1). Не помещается (rise > h и т. п.) — ошибка. В сборке — path "A<i>/"."""
    if shape not in shp.SHAPES:
        raise CommandError(f"shape: {' | '.join(shp.SHAPES)}")
    d = migrate(doc)
    fr, _ = frame_of(d, path)
    if shape == "rect":
        fr["shape"] = "rect"
        fr.pop("shape_params", None)
        return d
    probs = shp.shape_problems(shape, params or {}, fr["w"], fr["h"])
    if probs:
        raise CommandError("; ".join(probs))
    fr["shape"], fr["shape_params"] = shape, dict(params or {})
    return d


# ---------- сборка (§4) ----------
JOINTS = ("straight", "angle", "post", "corner_free")


def _assembly(d: dict) -> list:
    root = root_of(d)
    if "assembly" not in root:
        raise CommandError("это не составное изделие")
    return root["assembly"]


def set_joint(doc: dict, index: int, joint: str, angle: float | None = None) -> dict:
    """Стык index (0 — между A0 и A1): straight | angle (90…179°) | post | corner_free (угол без стойки, стекло
    к стеклу, §11.1; угол по умолчанию 90°)."""
    if joint not in JOINTS:
        raise CommandError(f"joint: {' | '.join(JOINTS)}")
    if joint == "corner_free" and angle is None:
        angle = 90
    if joint in ("angle", "corner_free") and not (isinstance(angle, (int, float)) and 90 <= angle <= 179):
        raise CommandError("угол стыка 90…179°; 180° — прямой (straight)")
    d = migrate(doc)
    items = _assembly(d)
    joints = [x for x in items if "joint" in x]
    if not 0 <= index < len(joints):
        raise CommandError(f"нет стыка {index}")
    j = joints[index]
    j.clear()
    j["joint"] = joint
    if joint in ("angle", "corner_free"):
        j["angle"] = angle
    return d


def add_frame(doc: dict, after: int, w: int = 1000, h: int | None = None) -> dict:
    """Новая рама после рамы after (−1 — в начало): глухая, а у раздвижной/гильотины — как соседняя; стык как у соседнего."""
    d = migrate(doc)
    items = _assembly(d)
    frames = [k for k, x in enumerate(items) if "frame" in x]
    if not -1 <= after < len(frames):
        raise CommandError(f"нет рамы {after}")
    joints = [x for x in items if "joint" in x]
    j = dict(joints[min(max(after, 0), len(joints) - 1)]) if joints else {"joint": "straight"}
    # у раздвижной/гильотины новая рама — такая же, как соседняя (у сборки одна система; глухая ПВХ-рама получала 7.21)
    nb = items[frames[max(after, 0)]]["frame"] if frames else {}
    nroot = nb.get("root") or {}
    root = clone({k: nroot[k] for k in ("sliding", "guillotine") if k in nroot}) or {"cell": {"type": "fixed"}}
    fr = {"frame": {"w": w, "h": h or d["frame"]["h"], "shape": "rect", "root": root}}
    if after == -1:
        items[0:0] = [fr, j]
    else:
        pos = frames[after] + 1
        items[pos:pos] = [j, fr]
    sync_assembly(d)
    return d


def remove_frame(doc: dict, index: int) -> dict:
    d = migrate(doc)
    items = _assembly(d)
    frames = [k for k, x in enumerate(items) if "frame" in x]
    if not 0 <= index < len(frames):
        raise CommandError(f"нет рамы {index}")
    if len(frames) <= 2:
        raise CommandError("в сборке остаются минимум две рамы")
    k = frames[index]
    if index == 0:
        del items[k:k + 2]                     # рама и стык после неё
    else:
        del items[k - 1:k + 1]                 # стык перед рамой и рама
    sync_assembly(d)
    return d


SETUP_KEYS = {"system", "color_out", "color_in", "glass", "fittings", "options", "profile_color", "lam_out", "lam_in",
              "seal_color", "bead", "suppliers"}


def set_setup(doc: dict, **fields) -> dict:
    bad = set(fields) - SETUP_KEYS
    if bad:
        raise CommandError(f"неизвестные поля комплектации: {', '.join(sorted(bad))}")
    d = clone(doc)
    s = d.setdefault("setup", {})
    if "system" in fields and fields["system"] != s.get("system") and "fittings" not in fields:
        s.pop("fittings", None)          # новый паз — набор подберётся по умолчанию (FR-F1)
    if fields.get("seal_color") not in (None, "black", "grey"):
        raise CommandError("seal_color: black | grey")
    if fields.get("bead") not in (None, "square", "round", "profiled"):
        raise CommandError("bead: square | round | profiled")
    old = {k: s.pop(k) for k in ("color_out", "color_in") if k in s}
    for side in ("out", "in"):                 # старые поля документа → новые (§8)
        if f"color_{side}" in old and f"lam_{side}" not in s:
            s[f"lam_{side}"] = None if old[f"color_{side}"] in (None, "white") else old[f"color_{side}"]
    for side in ("out", "in"):                 # старые поля команды → новые
        if f"color_{side}" in fields:
            v = fields.pop(f"color_{side}")
            fields[f"lam_{side}"] = None if v in (None, "white") else v
    s.update(fields)
    if s.get("profile_color") == "white":
        s.pop("profile_color")
    for k in ("profile_color", "lam_out", "lam_in", "seal_color", "bead", "suppliers"):
        if k in s and s[k] is None:            # null = убрать (нет ламинации, по умолчанию)
            s.pop(k)
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

    if "assembly" in root_of(d):
        items = root_of(d)["assembly"]
        items.reverse()
        for x in items:
            if "frame" in x and isinstance(x["frame"], dict):
                rec(x["frame"]["root"])
                _mirror_slide(x["frame"]["root"])
                sp = x["frame"].get("shape_params") or {}
                _mirror_shape(x["frame"], sp)
        return d
    rec(root_of(d))
    _mirror_slide(root_of(d))
    _mirror_shape(d["frame"], d["frame"].get("shape_params") or {})
    return d


def _mirror_slide(root: dict) -> None:
    """Раздвижная: подвижные полотна зеркально (§11.1)."""
    s = root.get("sliding")
    if s and isinstance(s.get("moving"), list):
        s["moving"] = list(reversed(s["moving"]))


def _mirror_shape(fr: dict, sp: dict) -> None:
    sh = fr.get("shape")
    if sh == "trapezoid" and sp:
        sp["h_left"], sp["h_right"] = sp.get("h_right"), sp.get("h_left")
    elif sh == "bevel" and sp.get("corner") in ("tl", "tr"):
        sp["corner"] = "tr" if sp["corner"] == "tl" else "tl"
    elif sh == "triangle" and "apex" in sp:
        sp["apex"] = fr["w"] - sp["apex"]


def accept_warning(doc: dict, rule: str, user: str, path: str = "", at: str | None = None) -> dict:
    d = clone(doc)
    d.setdefault("accepted_warnings", []).append(
        {"rule": rule, "path": path, "by": user, "at": at or datetime.now(timezone.utc).isoformat(timespec="seconds")})
    return d


def unaccept_warning(doc: dict, rule: str, path: str = "") -> dict:
    """Отменить принятие предупреждения (EditorIssues: «принято · отменить»)."""
    d = clone(doc)
    d["accepted_warnings"] = [a for a in d.get("accepted_warnings", [])
                              if not (a.get("rule") == rule and a.get("path", "") == path)]
    return d


def set_qty(doc: dict, qty: int) -> dict:
    if not isinstance(qty, int) or qty < 1:
        raise CommandError("qty ≥ 1")
    d = clone(doc)
    d["qty"] = qty
    return d


def set_meta(doc: dict, **meta) -> dict:
    """Помещение и данные проёма: room, kind, opening{width,height,floor_offset,quarter_mm,wall,slope_depth_mm,nearby,floor}."""
    bad = set(meta) - {"room", "kind", "opening"}
    if bad:
        raise CommandError(f"неизвестные поля: {', '.join(sorted(bad))}")
    d = clone(doc)
    if "opening" in meta:
        d.setdefault("opening", {}).update(meta.pop("opening") or {})
    d.update(meta)
    return d


# ---------- добавки изделия (§9.3–9.5, 9.7) ----------
ADDON_TYPES = ("extender", "base_profile", "frame_connector", "cover_strip", "canopy")
ADDON_SIDES = ("top", "bottom", "left", "right", "all")


def set_addons(doc: dict, addons: list | None = None) -> dict:
    """Дополнительные профили: [{type, side, size_mm?, length_mm?}] | [] / None — убрать."""
    out = []
    for a in addons or []:
        if a.get("type") not in ADDON_TYPES:
            raise CommandError(f"addon.type: {' | '.join(ADDON_TYPES)}")
        if a.get("side", "bottom") not in ADDON_SIDES:
            raise CommandError(f"addon.side: {' | '.join(ADDON_SIDES)}")
        if a["type"] == "extender" and a.get("size_mm") not in (20, 40, 60, 100):
            raise CommandError("расширитель: size_mm 20 | 40 | 60 | 100")
        for k in ("size_mm", "length_mm"):
            if a.get(k) is not None and (not isinstance(a[k], (int, float)) or a[k] <= 0):
                raise CommandError(f"addon.{k}: число мм > 0")
        out.append({"side": "bottom", **a})
    d = clone(doc)
    if out:
        d["addons"] = out
    else:
        d.pop("addons", None)
    return d


def _set_obj(doc: dict, key: str, value: dict | None, allowed: dict) -> dict:
    d = clone(doc)
    if not value:
        d.pop(key, None)
        return d
    for k, vals in allowed.items():
        if k in value and value[k] not in vals:
            raise CommandError(f"{key}.{k}: {' | '.join(map(str, vals))}")
    d[key] = dict(value)
    return d


def set_shutter(doc: dict, shutter: dict | None = None) -> dict:
    """Рольставня / жалюзи в коробе: {type: roller | blinds, control: manual | electric} | None."""
    return _set_obj(doc, "shutter", shutter and {"type": "roller", "control": "manual", **shutter},
                    {"type": ("roller", "blinds"), "control": ("manual", "electric")})


def set_grille(doc: dict, grille: dict | None = None) -> dict:
    """Решётка: {type: fixed | opening, pattern: straight | forged} | None."""
    return _set_obj(doc, "grille", grille and {"type": "fixed", "pattern": "straight", **grille},
                    {"type": ("fixed", "opening"), "pattern": ("straight", "forged")})


def set_loggia(doc: dict, loggia: dict | None = None) -> dict:
    """Лоджия целиком: {outrigger_mm, roof, cladding: outside|inside|both|null, parapet: brick|metal|null, parapet_h_mm?}."""
    if loggia and loggia.get("outrigger_mm") is not None and not (isinstance(loggia["outrigger_mm"], (int, float)) and 0 <= loggia["outrigger_mm"] <= 1500):
        raise CommandError("outrigger_mm: 0…1500")
    return _set_obj(doc, "loggia", loggia, {"cladding": ("outside", "inside", "both", None), "parapet": ("brick", "metal", None)})


def set_custom_lines(doc: dict, lines: list | None = None) -> dict:
    """Свои строки позиции: [{name, qty, unit, price_sum, cost_sum?, no_markup?}] — заменяют весь список."""
    out = []
    for c in lines or []:
        if not (c.get("name") or "").strip():
            raise CommandError("строка: нужно название")
        for k in ("qty", "price_sum", "cost_sum"):
            v = c.get(k)
            if v is None and k == "cost_sum":
                continue
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
                raise CommandError(f"строка «{c.get('name')}»: {k} — число ≥ 0")
        row = {"name": c["name"].strip(), "qty": c["qty"], "unit": c.get("unit") or "pcs", "price_sum": c["price_sum"]}
        if c.get("cost_sum") is not None:
            row["cost_sum"] = c["cost_sum"]
        if c.get("no_markup"):
            row["no_markup"] = True
        out.append(row)
    d = clone(doc)
    if out:
        d["custom_lines"] = out
    else:
        d.pop("custom_lines", None)
    return d


# ---------- раздвижные и гильотина (§11) ----------
def _special_root(doc: dict, path: str, key: str, defaults: dict, fields: dict) -> tuple[dict, dict, dict]:
    """(новый документ, рама, параметры корня key с переданными полями)."""
    d = migrate(doc)
    fr, inner = frame_of(d, path)
    if inner or "assembly" in fr["root"]:
        raise CommandError(f"{key} задаётся раме целиком: path \"\" или в сборке \"A<i>/\"")
    cur = fr["root"].get(key)
    s = dict(cur) if cur else dict(defaults)
    s.update({k: v for k, v in fields.items() if v is not None})
    return d, fr, s


def set_sliding(doc: dict, leaves: int | None = None, rails: int | None = None, moving: list | None = None,
                kind: str | None = None, threshold: str | None = None, overlap_mm=None, path: str = "") -> dict:
    """Раздвижная система (§11.1): root.sliding {leaves, rails, overlap_mm, moving, kind, threshold}.

    На обычном окне заменяет дерево ячеек раздвижной (kind изделия → sliding). leaves без moving — moving убирается
    (по умолчанию: 2 — оба подвижные, 3 — крайние, 4+ — все, кроме крайних).
    В сборке — path "A<i>/"."""
    d, fr, s = _special_root(doc, path, "sliding", SLIDING_DEFAULTS, dict(leaves=leaves, rails=rails, moving=moving, kind=kind,
                                                                          threshold=threshold, overlap_mm=overlap_mm))
    if leaves is not None and moving is None:          # новое число полотен — подвижные по умолчанию
        s.pop("moving", None)
    probs = sliding_problems(sliding_of({"sliding": s}))
    if probs:
        raise CommandError("; ".join(probs))
    was = special_kind(fr["root"])
    fr["root"] = {"sliding": s}
    if was != "sliding":
        fr["shape"] = "rect"
        fr.pop("shape_params", None)
        if not path:
            d["kind"] = "sliding"
    return d


def set_guillotine(doc: dict, modules: int | None = None, panels: int | None = None, moving: int | None = None,
                   drive: str | None = None, glass: str | None = None, posts: str | None = None, path: str = "") -> dict:
    """Гильотинная система для террас (§11.3): root.guillotine {modules, panels, moving, drive, glass, posts}.

    На другом изделии заменяет корень (kind изделия → guillotine). Меньше полотен — moving не больше panels − 1."""
    d, fr, s = _special_root(doc, path, "guillotine", GUILLOTINE_DEFAULTS, dict(modules=modules, panels=panels, moving=moving,
                                                                                drive=drive, glass=glass, posts=posts))
    if panels is not None and moving is None and isinstance(panels, int) and isinstance(s.get("moving"), int):
        s["moving"] = max(1, min(s["moving"], panels - 1))
    probs = guillotine_problems(guillotine_of({"guillotine": s}))
    if probs:
        raise CommandError("; ".join(probs))
    was = special_kind(fr["root"])
    fr["root"] = {"guillotine": {**GUILLOTINE_DEFAULTS, **s}}
    if was != "guillotine":
        fr["shape"] = "rect"
        fr.pop("shape_params", None)
        if not path:
            d["kind"] = "guillotine"
    return d


KIT_KEEP_SPECIAL = ("system", "fittings")


def apply_kit(doc: dict, setup: dict) -> dict:
    """Комплектация цеха («Эконом / Стандарт / Тёплый») на позицию. Раздвижные и гильотина остаются на своей
    системе: оконная система и фурнитура комплектации их не меняют (§11), стекло и цвет — меняют."""
    fields = dict(setup or {})
    if product_specials(migrate(doc)):
        for k in KIT_KEEP_SPECIAL:
            fields.pop(k, None)
    return set_setup(doc, **fields) if fields else clone(doc)


COMMANDS = {f.__name__: f for f in (set_size, split, merge, set_part_size, set_cell, set_fill, set_setup,
                                    set_option, set_extras, mirror, accept_warning, unaccept_warning, set_qty, set_meta,
                                    set_shape, set_muntins, set_joint, add_frame, remove_frame,
                                    set_addons, set_shutter, set_grille, set_loggia, set_custom_lines,
                                    set_sliding, set_guillotine)}


def apply(doc: dict, commands: list[dict]) -> dict:
    doc = migrate(doc)
    for c in commands:
        c = dict(c)
        name = c.pop("cmd")
        if name not in COMMANDS:
            raise CommandError(f"нет команды {name}")
        doc = COMMANDS[name](doc, **c)
    if "assembly" in root_of(doc):
        sync_assembly(doc)
    return doc
