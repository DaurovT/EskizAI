"""Оценка позиции: всё, что нужно проверкам и спецификации, собирается здесь один раз."""
from __future__ import annotations

from dataclasses import dataclass, field, replace

from . import fittings as fit
from .data import Catalog, Company
from .geometry import Geometry, GeometryError, build, sash_weight
from .glass import Glass, GlassError, parse
from .model import (assembly_frames, assembly_joints, cell_glass_spec, cell_options, decor, migrate, price_group,
                    profile_color_id, setup_of, special_root)

SPECIAL_OPENINGS = {"top_hung": ("fit_top_hung", "Фурнитура подвесного окна (комплект)"),
                    "pivot": ("fit_pivot", "Фурнитура среднеподвесного окна (комплект)"),
                    "folding": ("fit_folding", "Фурнитура гармошки (на створку)"),
                    "psk": ("fit_psk", "Фурнитура PSK (на створку)"),
                    "hs": ("fit_hs", "Фурнитура HS (на створку)")}
DOOR_OUT = ("fit_door_out", "Фурнитура двери наружу")
SHAPED_FIT = ("fit_shaped", "Спецфурнитура для фигурной створки")
# правила уровня комплектации: в сборке показываются один раз, без префикса рамы
SETUP_LEVEL = {"7.2", "7.10", "2.20", "5.3", "5.8"}


@dataclass
class Violation:
    code: str
    severity: str
    title: str
    msg: str = ""
    path: str = ""
    fix: str = ""
    accepted: bool = False
    accepted_by: str = ""
    accepted_at: str = ""
    scope: str = "construction"          # construction | price — ценовые (P.*, D.1, 7.7) не про конструкцию окна

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v not in ("", None) or k in ("code", "severity")}


@dataclass
class Eval:
    doc: dict
    cat: Catalog
    company: Company
    setup: dict
    passport: dict
    material: str
    groove: str
    group: str                                   # ценовая группа прайса
    geo: Geometry | None = None
    glass: dict = field(default_factory=dict)    # path -> Glass | GlassError
    fittings: dict = field(default_factory=dict) # path -> fittings.Selection
    violations: list = field(default_factory=list)
    stopped: bool = False                        # дальше проверять нельзя (нет геометрии)
    lam_extra_sides: int = 0                     # ламинация не в цене профиля (нет группы у системы) → роль lamination
    color_surcharge: dict | None = None          # цвет профиля в массе → наценка роли profile_color
    parts: list = field(default_factory=list)    # сборка: Eval каждой рамы
    joints: list = field(default_factory=list)   # сборка: стыки {index, joint, angle, height, role}
    offsets: list = field(default_factory=list)  # сборка: x начала рамы в развёртке

    @property
    def kind(self) -> str:
        return self.doc.get("kind", "window")

    def add(self, code: str, msg: str = "", path: str = "", fix: str = "") -> None:
        r = self.cat.rules.get(code, {"severity": "block", "title": code})
        if any(v.code == code and v.path == path for v in self.violations):
            return
        acc = next((a for a in self.doc.get("accepted_warnings", [])
                    if a.get("rule") == code and a.get("path", "") in ("", path)), None) if r["severity"] == "warn" else None
        scope = "price" if r.get("group") == "price" or code in ("7.6", "7.7") else "construction"
        self.violations.append(Violation(code, r["severity"], r["title"], msg, path, fix, acc is not None,
                                         (acc or {}).get("by", ""), (acc or {}).get("at", ""), scope))

    def has(self, code: str) -> bool:
        return any(v.code == code for v in self.violations)

    @property
    def blocking(self) -> list:
        return [v for v in self.violations if v.severity in ("block", "lock")]

    @property
    def area_m2(self) -> float:
        """Площадь изделия: по контуру рамы (у сборки — сумма рам) + полосы расширителей и подставочного (§9.3)."""
        from .model import addon_ext
        if self.parts:
            a = sum(p.area_m2 for p in self.parts)
        else:
            a = self.geo.area_m2 if self.geo else 0.0
        ext = addon_ext(self.doc)
        if any(ext.values()):
            W, H = float(self.doc["frame"]["w"]), float(self.doc["frame"]["h"])
            a += ((W + ext["left"] + ext["right"]) * (H + ext["top"] + ext["bottom"]) - W * H) / 1e6
        return a


def color_pricing(cat: Catalog, s: dict) -> tuple[str, int, dict | None]:
    """Ценовая группа прайса, сколько сторон ламинации считать ролью lamination, наценка цвета в массе.

    Ламинация — через группу прайса (Romchi уже дает цену ламинированного профиля), если такая группа
    есть у системы; иначе профиль по базовой группе + погонные метры ламинации по сторонам (роль lamination).
    Цвет в массе — наценка к цене белого (роль profile_color); у алюминия покраска RAL/анодирование —
    группа «Цветной», если она есть у системы.
    """
    system = s["system"]
    colors = cat.system_colors(system)
    alu = cat.material(system).startswith("alu")
    pc = profile_color_id(s.get("profile_color"))
    lo, li = s.get("lam_out"), s.get("lam_in")
    base_decor = "white"
    surcharge = None
    if pc != "white":
        if alu and pc in ("ral", "anodized") and "Цветной" in colors:
            base_decor = "ral_any"
        elif not (alu and s.get("profile_color") == "ral:9016"):
            surcharge = {"id": pc, "code": s.get("profile_color")}
    group = price_group(cat, system, lo or base_decor, li or base_decor)
    if not (lo or li) or not colors or group in colors:
        return group, 0, surcharge
    return price_group(cat, system, base_decor, base_decor), int(bool(lo)) + int(bool(li)), surcharge


def evaluate(doc: dict, cat: Catalog, company: Company | None = None) -> Eval:
    company = company or Company()
    doc = migrate(doc, cat)
    s = setup_of(doc, cat)
    system = s["system"]
    group, lam_sides, surcharge = color_pricing(cat, s)
    ev = Eval(doc, cat, company, s, cat.passport(system), cat.material(system), cat.groove(system), group,
              lam_extra_sides=lam_sides, color_surcharge=surcharge)
    if "assembly" in doc["frame"]["root"]:
        return _evaluate_assembly(ev)
    from . import rules                                  # проверки ввода — до геометрии
    rules.check_input(ev)
    if ev.stopped:
        return ev
    if special_root(doc):
        ev.add("9.7", "раздвижные считаются после MVP (PRD 7.12)")
        ev.stopped = True
        return ev
    try:
        ev.geo = build(doc, ev.passport)
    except GeometryError as e:
        ev.add(e.code, e.msg, e.path)
        ev.stopped = True
        return ev
    decor_in = decor(cat, s["lam_in"] or "white")
    for cg in ev.geo.cells:
        spec = cell_glass_spec(doc, cg.cell, cat)
        if cg.cell.get("type") == "panel" and not (cg.cell.get("fill") or {}).get("glass"):
            ev.glass[cg.path] = None
        else:
            try:
                ev.glass[cg.path] = parse(spec, cat)
            except GlassError as e:
                ev.glass[cg.path] = e
        g = ev.glass[cg.path]
        if cg.opening and isinstance(g, Glass):
            cg.weight_kg = sash_weight(cg, g.weight_kg_m2, ev.passport)
        if cg.opening:
            op = cg.cell.get("open") or "turn"
            if "folding" in cg.sides.values():               # створка гармошки — фурнитура гармошки
                op = "folding"
            if op in ("folding", "psk", "hs") or op in SPECIAL_OPENINGS and not (cg.cell.get("type") == "door_sash" and ev.kind == "door"):
                ev.fittings[cg.path] = _kit_selection(cat, s["fittings"], op, *SPECIAL_OPENINGS[op])
            else:
                ev.fittings[cg.path] = fit.select(cat, s["fittings"], ev.groove, cg.cell, ev.kind, cg.ffb, cg.ffh,
                                                  cg.weight_kg, cell_options(doc, cg.cell, cat), decor_in)
            if cg.shaped:
                ev.fittings[cg.path].parts.append(_kit_part(cat, *SHAPED_FIT))
            if cg.cell.get("type") == "door_sash" and cg.cell.get("open_dir") == "out":
                ev.fittings[cg.path].parts.append(_kit_part(cat, *DOOR_OUT))
    rules.check_all(ev)
    return ev


def _kit_part(cat: Catalog, role: str, name: str) -> fit.Part:
    it = cat.role_item(role)
    return fit.Part(role, (it or {}).get("article") or name, 1, 0, (it or {}).get("article", ""), None, role, "",
                    "ДЕМО" if it and not it.get("price_sum") else "")


def _kit_selection(cat: Catalog, fitting_set: str, opening: str, role: str, name: str) -> fit.Selection:
    """Подвесное и среднеподвесное: комплект фурнитуры одной позицией каталога (роль fit_top_hung / fit_pivot)."""
    sel = fit.Selection(fitting_set, opening)
    sel.parts.append(_kit_part(cat, role, name))
    return sel


def joint_role(j: dict) -> str | None:
    kind, ang = j.get("joint"), j.get("angle")
    if kind == "straight":
        return "conn_straight"
    if kind == "post":
        return "conn_post"
    if kind == "angle" and isinstance(ang, (int, float)):
        if ang >= 180:
            return "conn_straight"
        return "conn_corner90" if abs(ang - 90) < 0.5 else "conn_bay"
    return None


def _evaluate_assembly(ev: Eval) -> Eval:
    """Сборка: каждая рама — отдельное окно без монтажа; стыки — соединители; монтаж — один на сборку."""
    from . import rules
    doc, cat = ev.doc, ev.cat
    items = doc["frame"]["root"].get("assembly") or []
    kinds = ["frame" if "frame" in x else "joint" if "joint" in x else "?" for x in items]
    if not kinds or kinds[0] != "frame" or kinds[-1] != "frame" or "?" in kinds or \
            any(a == b for a, b in zip(kinds, kinds[1:])):
        ev.add("9.20", "сборка: рамы и стыки должны чередоваться (рама, стык, рама, …)")
        ev.stopped = True
        return ev
    frames, joints = assembly_frames(doc), assembly_joints(doc)
    acc = doc.get("accepted_warnings", [])
    x = 0.0
    for i, item in enumerate(frames):
        fr = item["frame"]
        if not isinstance(fr, dict):
            ev.add("9.20", f"рама A{i} задана шаблоном «{fr}», которого нет", f"A{i}/")
            ev.stopped = True
            continue
        pre = f"A{i}/"
        has_door = '"door_sash"' in _dumps(fr.get("root"))
        sub = {"kind": fr.get("kind") or ("balcony_block" if has_door else "window"), "qty": 1,
               "frame": {k: v for k, v in fr.items() if k != "kind"}, "setup": doc.get("setup") or {},
               "extras": {"install": False},
               "accepted_warnings": [dict(a, path=a.get("path", "")[len(pre):]) for a in acc
                                     if a.get("path", "") == "" or a.get("path", "").startswith(pre)]}
        se = evaluate(sub, cat, ev.company)
        ev.parts.append(se)
        ev.offsets.append(x)
        x += float(fr.get("w") or 0)
        for v in se.violations:
            if v.code == "6.10":
                continue
            if v.path == "" and v.code in SETUP_LEVEL:
                if any(o.code == v.code and o.path == "" for o in ev.violations):
                    continue
                ev.violations.append(v)
                continue
            path = pre + v.path
            if not any(o.code == v.code and o.path == path for o in ev.violations):
                ev.violations.append(replace(v, path=path))
        if se.stopped:
            ev.stopped = True
    for k, j in enumerate(joints):
        a = frames[k]["frame"] if k < len(frames) else {}
        b = frames[k + 1]["frame"] if k + 1 < len(frames) else {}
        ha = float(a.get("h") or 0) if isinstance(a, dict) else 0.0
        hb = float(b.get("h") or 0) if isinstance(b, dict) else 0.0
        role = joint_role(j)
        ang = j.get("angle")
        if j.get("joint") == "angle" and not (isinstance(ang, (int, float)) and 90 <= ang <= 179):
            ev.add("9.20", f"стык {k + 1} (A{k}–A{k + 1}): угол {ang!r}° вне 90…179°",
                   fix="угол 180° — прямой соединитель (joint: straight)")
            role = None
        elif role is None:
            ev.add("9.20", f"стык {k + 1} (A{k}–A{k + 1}): неизвестный тип «{j.get('joint')}»",
                   fix="straight | angle | post")
        p21 = cat.rules["9.21"]["params"]["max_diff_mm"]
        if abs(ha - hb) > p21:
            ev.add("9.21", f"стык {k + 1}: высоты A{k} {ha:g} и A{k + 1} {hb:g} мм различаются на {abs(ha - hb):g} мм")
        ev.joints.append({"index": k, "joint": j.get("joint"), "angle": ang, "height": max(ha, hb), "role": role,
                          "x": ev.offsets[k + 1] if k + 1 < len(ev.offsets) else x})
    if ev.parts and all(c.cell.get("type") in ("fixed", "panel") for p in ev.parts if p.geo for c in p.geo.cells):
        ev.add("6.10", "все части сборки глухие", fix="добавьте открывающуюся створку для проветривания")
    rules.check_opening(ev, float(doc["frame"].get("w") or 0), float(doc["frame"].get("h") or 0))
    return ev


def _dumps(x) -> str:
    import json
    return json.dumps(x, ensure_ascii=False)
