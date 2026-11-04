"""Подсветка: светодиодная лента в алюминиевом профиле (docs/decor_contract.md).

Профиль идёт под панелью (дно навесного шкафа, верх ниши, полка, крыша секции) у переднего края —
в паз (mount = groove) или накладной; по цоколю — накладной. Блок питания — один на изделие,
мощность по сумме длин лент: Вт/м × длина × 1,2.
"""

from __future__ import annotations

import math
import re

from .assembler import BuildContext
from .geometry import Vec3, to_local
from .parts import Groove, LightRun, Part
from .units import mm, to_mm

PROFILE = (mm(17), mm(7))  # ширина × высота профиля (паз — по этим размерам)
FRONT_OFFSET = mm(40)  # от переднего края панели до оси профиля
END_GAP = mm(10)  # от торцов панели до профиля
POWER_SIZES = (60, 100, 150)  # Вт
ZONE_NAMES = {"under_wall": "под навесными", "niche": "в нише", "shelf": "под полками",
              "wardrobe_rod": "над штангой", "plinth": "по цоколю", "inside_top": "внутри под крышей"}
SENSOR_NAMES = {"door": "датчик открывания двери", "motion": "датчик движения", "touch": "сенсорный выключатель"}

_AX = {"X": 0, "Y": 1, "Z": 2}


def _vec(axis: str) -> tuple[int, int, int]:
    v = [0, 0, 0]
    v[_AX[axis[1]]] = -1 if axis[0] == "-" else 1
    return v[0], v[1], v[2]


def _l2w(p: Part, x: float, y: float, z: float) -> tuple[int, int, int]:
    o = p.placement.origin
    u, v, n = _vec(p.placement.u), _vec(p.placement.v), _vec(p.placement.n)
    return tuple(round(c + x * a + y * b + z * d) for c, a, b, d in zip((o.x, o.y, o.z), u, v, n))


def _horizontal(p: Part) -> bool:
    return p.placement.n[1] == "Z"


def _under(ctx: BuildContext, panel: Part, idx: int, light, run_id: str, warn: list,
           x_range: tuple[int, int] | None = None) -> None:
    """Профиль под панелью у переднего края (локальная y = 0 — передний край у горизонтальных деталей).
    x_range — участок изделия по X (секция под общей крышей)."""
    pw, ph = PROFILE
    lo, hi = END_GAP, panel.length - END_GAP
    if x_range is not None and panel.placement.u[1] == "X":
        a0 = to_local(panel.placement, Vec3(x=x_range[0], y=0, z=0))[0]
        a1 = to_local(panel.placement, Vec3(x=x_range[1], y=0, z=0))[0]
        lo, hi = max(lo, min(a0, a1) + END_GAP), min(hi, max(a0, a1) - END_GAP)
    if hi - lo < mm(100):
        return
    # Нижняя пласть: локальная z = 0, если нормаль смотрит вверх
    z = 0 if panel.placement.n == "+Z" else panel.thickness
    a = _l2w(panel, lo, FRONT_OFFSET, z)
    b = _l2w(panel, hi, FRONT_OFFSET, z)
    mount = light.mount
    if mount == "groove":
        if ph * 2 > panel.thickness:
            mount = "surface"
            warn.append(panel.name)
        else:
            face = "B" if z == 0 else "A"
            panel.grooves.append(Groove(x0=lo, y0=FRONT_OFFSET - pw // 2, x1=hi,
                                        y1=FRONT_OFFSET + pw // 2, width=pw, depth=ph, face=face,
                                        purpose="паз под LED-профиль"))
    ctx.lights.append(LightRun(id=run_id, zone=light.zone, start=a, end=b, temp=light.temp, part=panel.key,
                               node=panel.node, mount=mount, light=idx))


def _panel_above(ctx: BuildContext, x0: int, x1: int, z: int) -> Part | None:
    """Горизонтальная панель, нижняя пласть которой на высоте z и которая перекрывает [x0, x1]."""
    mid = (x0 + x1) / 2
    best = None
    for p in ctx.parts:
        if not _horizontal(p) or p.role in ("door", "drawer_front", "countertop", "drawer_bottom"):
            continue
        b = p.aabb()
        if abs(b.min.z - z) <= mm(1) and b.min.x <= mid <= b.max.x:
            if best is None or p.length < best.length:
                best = p
    return best


def _wardrobe_targets(ctx: BuildContext, target: str) -> list:
    if target == "all":
        return list(zip(ctx.slots, ctx.product.sections))
    m = re.match(r"^sections\[(\d+)\]$", target)
    if m and int(m[1]) < len(ctx.slots):
        i = int(m[1])
        return [(ctx.slots[i], ctx.product.sections[i])]
    return []


def _kitchen_cabs(ctx: BuildContext, target: str, rows=("wall", "wall2")) -> list[str]:
    k = ctx.product
    out = []
    for row in rows:
        cabs = getattr(k, row, [])
        n = len(cabs)
        for i, c in enumerate(cabs):
            if c.kind == "gap":
                continue
            built = n - 1 - i if row.endswith("2") and k.corner_side == "left" else i
            if target in ("all", f"{row}[{i}]"):
                out.append((f"{row}[{built}]", c))
    return out


def apply_lighting(ctx: BuildContext) -> None:
    p = ctx.product
    if not p.lighting:
        return
    kitchen = getattr(p, "type", "") == "kitchen"
    warn_surface: list[str] = []
    by_light: dict[int, float] = {}
    for idx, light in enumerate(p.lighting):
        before = len(ctx.lights)
        rid = lambda: f"led{len(ctx.lights) + 1}"  # noqa: E731
        z = light.zone
        if kitchen:
            if z in ("under_wall", "niche", "inside_top", "shelf"):
                for path, cab in _kitchen_cabs(ctx, light.target):
                    if z == "under_wall":  # над вытяжкой свет не нужен — у вытяжки свой
                        panels = [] if cab.kind == "hood" else [q for q in ctx.parts if q.key == f"{path}.bottom"]
                    elif z == "shelf":
                        panels = [q for q in ctx.parts if q.role == "shelf" and q.key.startswith(path + ".")]
                    elif z == "niche" and cab.kind != "open":
                        panels = []
                    else:
                        panels = [q for q in ctx.parts if q.key == f"{path}.top"]
                    for q in panels:
                        _under(ctx, q, idx, light, rid(), warn_surface)
            elif z == "plinth":
                for q in ctx.parts:
                    if q.role == "plinth":
                        _plinth(ctx, q, idx, light, rid())
        else:
            for slot, section in _wardrobe_targets(ctx, light.target):
                x0, x1 = slot.box.x0, slot.box.x1
                if z == "inside_top":
                    q = _panel_above(ctx, x0, x1, slot.box.z1)
                    if q:
                        _under(ctx, q, idx, light, rid(), warn_surface, (x0, x1))
                    continue
                if z == "plinth":
                    continue
                for zone in slot.zones:
                    opened = section.doors is None and zone.doors is None and not zone.external_drawers
                    if z == "niche" and opened and zone.kind != "drawers":
                        q = _panel_above(ctx, x0, x1, zone.z1)
                        if q:
                            _under(ctx, q, idx, light, rid(), warn_surface, (x0, x1))
                    elif z == "wardrobe_rod" and zone.kind == "rod":
                        q = _panel_above(ctx, x0, x1, zone.z1)
                        if q:
                            _under(ctx, q, idx, light, rid(), warn_surface, (x0, x1))
                    elif z == "shelf" and zone.kind == "shelves" and (opened or light.target != "all"):
                        for q in ctx.parts:
                            if q.role == "shelf" and q.key.startswith(zone.path + "."):
                                _under(ctx, q, idx, light, rid(), warn_surface)
            if z == "plinth":
                plinths = [q for q in ctx.parts if q.role == "plinth"]
                if plinths:
                    _plinth(ctx, min(plinths, key=lambda q: q.aabb().min.y), idx, light, rid())
        runs = ctx.lights[before:]
        if not runs:
            ctx.warn("light_no_place", f"Подсветка «{ZONE_NAMES[z]}»: в изделии нет подходящего места "
                                       f"(цель {light.target})", f"lighting[{idx}]")
            continue
        length = sum(r.length for r in runs)
        by_light[idx] = length
        mod = f"lighting[{idx}]"
        ctx.add_hardware("led_profile", "Профиль LED с рассеивателем", 1, mod, length=length, zone=z)
        ctx.add_hardware("led_strip", f"Лента LED {light.temp} K, {light.power:g} Вт/м", 1, mod, length=length,
                         temp=light.temp, zone=z)
        if light.sensor != "none":
            ctx.add_hardware("led_sensor", SENSOR_NAMES[light.sensor].capitalize(), 1, mod, sensor=light.sensor)
    if warn_surface:
        ctx.warn("light_surface", "Паз под LED-профиль глубже половины толщины — профиль накладной: "
                                  + ", ".join(sorted(set(warn_surface))), "lighting")
    if by_light:
        watts = sum(to_mm(length) / 1000 * p.lighting[i].power for i, length in by_light.items()) * 1.2
        size = next((s for s in POWER_SIZES if s >= watts), POWER_SIZES[-1])
        count = 1 if watts <= POWER_SIZES[-1] else math.ceil(watts / POWER_SIZES[-1])
        ctx.add_hardware("power_supply", f"Блок питания {size} Вт", count, "lighting", watts=size,
                         need=round(watts, 1))


def _plinth(ctx: BuildContext, q: Part, idx: int, light, run_id: str) -> None:
    """Накладной профиль по низу цоколя на лицевой стороне."""
    a = _l2w(q, END_GAP, mm(10), 0)
    b = _l2w(q, q.length - END_GAP, mm(10), 0)
    ctx.lights.append(LightRun(id=run_id, zone=light.zone, start=a, end=b, temp=light.temp, part=q.key,
                               mount="surface", light=idx))
