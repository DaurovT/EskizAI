"""Модель изделия: дерево, пути к узлам, комплектация по умолчанию, декоры → ценовая группа.

Изделие — JSON (PRD, раздел 6). Узел дерева — словарь:
  лист:    {"cell": {...}}                       (корень-лист или часть {"size":…, "cell":…})
  деление: {"split": "v|h|shtulp|none", "parts": [{"size": …, "cell"|"node": …}, …]}
Путь к узлу — строка индексов частей через точку: "" — корень, "1.0" — 1-я часть корня, в ней 0-я часть.
Составное изделие (kind = assembly, docs/shapes_contract.md §4): frame.root.assembly = [рама, стык, рама, …];
путь с префиксом рамы — "A1/0.1", "A2/" — корень третьей рамы.
"""
from __future__ import annotations

import copy

from .data import Catalog

DEFAULT_SYSTEM = "akfa__6000_qvt"
OPENING_CELLS = ("sash", "door_sash")


# ---------- дерево ----------
def root_of(doc: dict) -> dict:
    return doc["frame"]["root"]


def is_assembly(doc: dict) -> bool:
    return doc.get("kind") == "assembly" or "assembly" in (doc.get("frame") or {}).get("root", {})


def split_path(path: str) -> tuple[int | None, str]:
    """"A1/0.1" → (1, "0.1"); "0.1" → (None, "0.1")."""
    if path and path[0] == "A" and "/" in path:
        head, _, rest = path.partition("/")
        try:
            return int(head[1:]), rest
        except ValueError:
            raise KeyError(f"путь {path}: префикс рамы A<номер>/")
    return None, path


def assembly_frames(doc: dict) -> list[dict]:
    """Элементы-рамы сборки (словари {"frame": {...}}) по порядку."""
    return [x for x in root_of(doc).get("assembly", []) if "frame" in x]


def assembly_joints(doc: dict) -> list[dict]:
    return [x for x in root_of(doc).get("assembly", []) if "joint" in x]


def frame_of(doc: dict, path: str) -> tuple[dict, str]:
    """Рама (словарь frame с w, h, root) и путь внутри неё."""
    i, inner = split_path(path)
    if i is None:
        return doc["frame"], inner
    frames = assembly_frames(doc)
    if not 0 <= i < len(frames):
        raise KeyError(f"путь {path}: в сборке нет рамы A{i}")
    fr = frames[i]["frame"]
    if not isinstance(fr, dict):
        raise KeyError(f"рама A{i} задана шаблоном «{fr}» — пересоздайте изделие из шаблона")
    return fr, inner


def join_path(prefix: str, path: str) -> str:
    """("A1/", "0.1") → "A1/0.1"; без префикса — как есть."""
    if not prefix:
        return path
    return prefix + path


def is_leaf(node: dict) -> bool:
    return "cell" in node


def child(part: dict) -> dict:
    """Узел, который лежит в части деления: сама часть (если в ней cell) или part['node']."""
    return part if "cell" in part else part["node"]


def node_at(doc: dict, path: str) -> dict:
    fr, path = frame_of(doc, path)
    node = fr["root"]
    for idx in [int(i) for i in path.split(".") if i != ""]:
        if is_leaf(node) or "parts" not in node:
            raise KeyError(f"путь {path}: дальше листа")
        node = child(node["parts"][idx])
    return node


def part_at(doc: dict, path: str) -> dict | None:
    """Часть деления по пути (у неё size) или None для корня."""
    i, inner = split_path(path)
    if inner == "":
        return None
    parent_path, _, idx = inner.rpartition(".")
    parent = node_at(doc, (f"A{i}/" if i is not None else "") + parent_path)
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
    """То, что ядро ещё не считает: раздвижные (9.7). Формы и сборки считаются (shapes_contract.md)."""
    r = root_of(doc)
    if "sliding" in r:
        return "sliding"
    return None


# ---------- чтение старых записей ----------
LEGACY_JOINTS = {"angle_90": ("angle", 90), "angle_135": ("angle", 135), "straight": ("straight", None),
                 "angle_180": ("straight", None), "post": ("post", None)}


def migrate(doc: dict, cat: Catalog | None = None) -> dict:
    """Копия документа в текущем формате (исходный не меняется).

    - T16: root.shape = "arch", root.rise_mm → frame.shape = "arch", frame.shape_params.rise;
    - сборка: рама-строка (id шаблона + w) → полноценная рама; стык "angle_90" → {"joint": "angle", "angle": 90}.
    """
    d = copy.deepcopy(doc)
    fr = d.get("frame") or {}
    root = fr.get("root") or {}
    _migrate_frame(fr)
    if "assembly" in root:
        H = fr.get("h")
        items = []
        for x in root["assembly"]:
            x = dict(x)
            if "frame" in x and not isinstance(x["frame"], dict):
                t = cat.templates.get(x["frame"]) if cat else None
                if t:
                    sub = {"w": x.get("w") or t["default_w"], "h": x.get("h") or H or t["default_h"],
                           "root": copy.deepcopy(t["root"])}
                    if t.get("shape"):
                        sub["shape"], sub["shape_params"] = t["shape"], dict(t.get("shape_params") or {})
                    x = {"frame": sub}
            if "frame" in x and isinstance(x["frame"], dict):
                _migrate_frame(x["frame"])
            if "joint" in x and x["joint"] in LEGACY_JOINTS:
                j, a = LEGACY_JOINTS[x["joint"]]
                x["joint"] = j
                if a is not None:
                    x.setdefault("angle", a)
            items.append(x)
        root["assembly"] = items
        sync_assembly(d)
    return d


def _migrate_frame(fr: dict) -> None:
    root = fr.get("root") or {}
    if root.get("shape") not in (None, "rect"):
        fr["shape"] = root.pop("shape")
        if "rise_mm" in root:
            fr.setdefault("shape_params", {})["rise"] = root.pop("rise_mm")
    else:
        root.pop("shape", None)
    root.pop("rise_mm", None)
    root.pop("calc", None)


def sync_assembly(doc: dict) -> None:
    """frame.w сборки = сумма w рам (развёртка), frame.h = max h."""
    frames = [x["frame"] for x in assembly_frames(doc) if isinstance(x["frame"], dict)]
    if frames:
        doc["frame"]["w"] = sum(f.get("w") or 0 for f in frames)
        doc["frame"]["h"] = max(f.get("h") or 0 for f in frames)


# ---------- ячейка: сетка, порог, направление (§9) ----------
MOSQ_TYPES = ("frame", "sliding", "pleated", "door", "antipet")


def mosquito_type(cell: dict) -> str | None:
    """cell.mosquito: true → «frame», {"type": …} или строка типа; нет / false → None."""
    m = cell.get("mosquito")
    if not m:
        return None
    if m is True:
        return "frame"
    if isinstance(m, dict):
        return m.get("type") or "frame"
    return str(m)


def threshold_of(cell: dict) -> str | None:
    """cell.threshold у door_sash: true / standard → рамный, low_alu, none."""
    t = cell.get("threshold")
    if t is True:
        return "standard"
    if t in (False, None, "none"):
        return None
    return t


EXT_DEFAULT = {"base_profile": 30}                  # мм, на сколько подставочный профиль увеличивает габарит


def addon_ext(doc: dict) -> dict:
    """Насколько расширители и подставочный профиль увеличивают габарит по сторонам, мм."""
    ext = {"top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.0}
    for a in doc.get("addons") or []:
        if a.get("type") not in ("extender", "base_profile"):
            continue
        size = float(a.get("size_mm") or EXT_DEFAULT.get(a["type"], 0))
        sides = ext if a.get("side") == "all" else [a.get("side", "bottom")]
        for sd in sides:
            if sd in ext:
                ext[sd] += size
    return ext


# ---------- комплектация ----------
def setup_of(doc: dict, cat: Catalog) -> dict:
    """setup с подставленными значениями по умолчанию (документ не меняется)."""
    s = dict(doc.get("setup") or {})
    s.setdefault("system", DEFAULT_SYSTEM)
    norm_colors(s)
    p = cat.passport(s["system"])
    s.setdefault("glass", p.get("default_glass") or ("g4_12_4" if cat.material(s["system"]) != "alu_thermo" else "g4_16_4"))
    if not s.get("fittings"):
        sets = cat.compatible_fitting_sets(s["system"])
        if doc.get("kind") == "door":                       # входная дверь — набор, который делает дверь (8.6)
            sets = cat.compatible_fitting_sets(s["system"], "door") or sets
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


# ---------- цвет профиля, ламинация (shapes_contract.md §8) ----------
def norm_colors(s: dict, write: bool = False) -> dict:
    """setup → profile_color, lam_out, lam_in (+ производные color_out / color_in = видимый цвет стороны).

    Старые color_out / color_in: white → нет ламинации, иначе lam_* = значение. write=True — для записи
    в документ: старые поля убираются, производные не пишутся («новые документы пишут только новые поля»).
    """
    for side in ("out", "in"):
        old = s.pop(f"color_{side}", None) if write else s.get(f"color_{side}")
        if f"lam_{side}" not in s:
            s[f"lam_{side}"] = None if old in (None, "white", "") else old
    s.setdefault("profile_color", "white")
    if s["profile_color"] in (None, ""):
        s["profile_color"] = "white"
    if not write:
        s["color_out"], s["color_in"] = side_color(s, "out"), side_color(s, "in")
    return s


def side_color(setup: dict, side: str) -> str:
    """Видимый цвет стороны (out | in): ламинация этой стороны, иначе цвет профиля."""
    lam = setup.get(f"lam_{side}")
    if lam is None and f"lam_{side}" not in setup:
        old = setup.get(f"color_{side}")
        lam = None if old in (None, "white") else old
    return lam or setup.get("profile_color") or "white"


def profile_color_id(code: str | None) -> str:
    """"ral:8017" → "ral"; "cream" → "cream"."""
    code = code or "white"
    return code.split(":", 1)[0]


RAL_HEX = {"9016": "#F1F0EA", "9010": "#F1ECE1", "9003": "#F4F4F0", "8017": "#45322E", "8014": "#4A3526",
           "7016": "#383E42", "7024": "#474A51", "9005": "#0A0A0A", "9006": "#A5A5A5", "1015": "#E6D2B5",
           "3005": "#5E2129", "6005": "#2F4538", "5010": "#0E294B"}


def side_hex(cat: Catalog, setup: dict, side: str) -> str | None:
    """Цвет стороны для схемы: hex плёнки или цвета профиля."""
    c = side_color(setup, side)
    if c in cat.decors:
        return cat.decors[c].get("hex")
    pc = cat.profile_colors.get(profile_color_id(c))
    if c.startswith("ral:"):
        return RAL_HEX.get(c[4:], (pc or {}).get("hex"))
    return (pc or {}).get("hex")


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
