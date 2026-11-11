"""Модель для 3D-просмотра (приложение и ссылка клиента).

Формат «viewer model» — контракт между ядром и 3D. Размеры — в мм (float).
Оси ядра: X — ширина, Y — глубина от фасада назад, Z — высота.
В three.js (Y вверх) переводится так: three.x = X, three.y = Z, three.z = −Y.

Глубина изделия (size[2]) — корпус с задней стенкой; фасады стоят перед
корпусом, в области Y < 0.

Подвижные узлы: rotate/lift — поворот на +range градусов вокруг оси axis,
проходящей через origin, по правилу правой руки (так двери открываются к
зрителю); slide/sliding_door — сдвиг вдоль axis на range мм.

Фурнитура (hardware) — только для картинки: ручки, петли, штангодержатели, ножки,
направляющие, профили купе, угловые механизмы (см. hw3d.py). Формы — в мм, оси ядра;
node — узел, с которым фурнитура двигается; part — деталь, с которой она разлетается
при «взрыве». Отделки — в hardwareFinishes.

Декор фасада (docs/decor_contract.md) — необязательное поле детали `decor`: paint, milling[], overlay[],
inlay[], radius; пути — в системе детали (мм), первый сегмент {"kind": "move"} — начало пути; лицевая
сторона фасада — локальная z = 0 (face "front"). Подсветка — `lights[]` (from/to — точки изделия, мм).

Помещение (`room`, только у встроенной мебели / шкафа в нише и у кухни с замером) — стены, пол, потолок,
окно и выводы для контекста (room.py). Не детали: нет в смете, раскрое, DXF и в GLB для AR.

Себестоимости и поставщика здесь нет — модель можно отдавать клиенту.
"""

from .assembler import BuildResult
from .catalog import material
from .glb import ar_placement
from .hw3d import FINISHES, hardware_visuals_mm
from .units import to_mm

VIEWER_FORMAT_VERSION = "1"


def _contour_mm(contour) -> dict | None:
    if contour is None:
        return None
    segs = []
    for s in contour.segments:
        seg = {"kind": s.kind, "x": to_mm(s.x), "y": to_mm(s.y)}
        if s.kind == "arc":
            seg.update(cx=to_mm(s.cx), cy=to_mm(s.cy), clockwise=s.clockwise)
        segs.append(seg)
    return {"start": [to_mm(contour.start_x), to_mm(contour.start_y)], "segments": segs}


def _path_mm(c) -> list[dict]:
    """Путь декора → сегменты как у контура; первый — {"kind": "move"} в начало."""
    out = [{"kind": "move", "x": to_mm(c.start_x), "y": to_mm(c.start_y)}]
    for s in _contour_mm(c)["segments"]:
        out.append(s)
    return out


def decor_mm(d) -> dict:
    """Декор детали для 3D (мм); лицевая сторона — face (у фасадов B, локальная z = 0)."""
    out: dict = {"face": "front"}
    if d.paint:
        out["paint"] = {k: d.paint[k] for k in ("color", "gloss", "code") if d.paint.get(k) is not None}
    if d.milling:
        out["milling"] = [{"start": [to_mm(m.path.start_x), to_mm(m.path.start_y)], "path": _path_mm(m.path), "closed": m.closed, "width": to_mm(m.width),
                           "depth": to_mm(m.depth)} for m in d.milling]
    if d.overlay:
        out["overlay"] = [{"start": [to_mm(m.path.start_x), to_mm(m.path.start_y)], "path": _path_mm(m.path), "closed": m.closed, "width": to_mm(m.width),
                           "height": to_mm(m.height), "profile": m.profile} for m in d.overlay]
    if d.inlay:
        out["inlay"] = [{"start": [to_mm(m.path.start_x), to_mm(m.path.start_y)], "path": _path_mm(m.path), "closed": m.closed, "width": to_mm(m.width),
                         "finish": m.finish, "edge": d.inlay_kind == "edge"} for m in d.inlay]
    if d.radius:
        out["radius"] = to_mm(d.radius)
    return out


def lights_mm(result: BuildResult) -> list[dict]:
    from .lighting import PROFILE

    return [{"id": r.id, "zone": r.zone, "from": [to_mm(v) for v in r.start], "to": [to_mm(v) for v in r.end],
             "temp": r.temp, "nodeId": r.node, "part": r.part, "mount": r.mount,
             "profile": {"width": to_mm(PROFILE[0]), "height": to_mm(PROFILE[1])}} for r in result.lights]


def _part_mm(p) -> dict:
    out = {
        "number": p.number,
        "key": p.key,
        "name": p.name,
        "role": p.role,
        "material": p.material,
        "thickness": to_mm(p.thickness),
        "length": to_mm(p.length),
        "width": to_mm(p.width),
        "grain": p.grain,
        "contour": _contour_mm(p.contour),
        "placement": {
            "origin": [to_mm(p.placement.origin.x), to_mm(p.placement.origin.y), to_mm(p.placement.origin.z)],
            "u": p.placement.u,
            "v": p.placement.v,
            "n": p.placement.n,
        },
        "holes": [
            {"x": to_mm(h.x), "y": to_mm(h.y), "diameter": to_mm(h.diameter), "depth": to_mm(h.depth), "face": h.face}
            for h in p.holes
        ],
        "cutouts": [_contour_mm(c) for c in p.cutouts],
        "node": p.node,
    }
    if p.decor is not None:
        out["decor"] = decor_mm(p.decor)
    return out


def viewer_model(result: BuildResult) -> dict:
    from .room import room_model

    used = sorted({p.material for p in result.parts})
    out = {
        "format": VIEWER_FORMAT_VERSION,
        "size": [to_mm(v) for v in result.size],  # ширина, высота, глубина
        "materials": {
            mid: {
                "name": material(mid).name, "color": material(mid).color, "hasGrain": material(mid).has_grain,
                "type": material(mid).finish_type, "texture": material(mid).texture,
                "textureSizeMm": list(material(mid).texture_size_mm),
            }
            for mid in used
        },
        "parts": [_part_mm(p) for p in result.parts],
        "nodes": [
            {
                "id": n.id,
                "kind": n.kind,
                "origin": [to_mm(v) for v in n.origin],
                "axis": n.axis,
                "range": n.range if n.kind in ("rotate", "lift") else to_mm(int(n.range)),
                "parent": n.parent,
            }
            for n in result.nodes
        ],
        "sections": [
            {"key": sec.key, "x0": to_mm(sec.x0), "x1": to_mm(sec.x1), "zMin": to_mm(sec.z0), "zMax": to_mm(sec.z1)}
            for sec in result.sections
        ],
        "hardware": hardware_visuals_mm(result),
        "hardwareFinishes": FINISHES,
        "lights": lights_mm(result),
        # размещение в AR: "floor" — на пол (по умолчанию), "wall" — навесное, на стену (glb.ar_placement)
        "placement": ar_placement(result),
        "issues":[i.model_dump() for i in result.issues],
    }
    room = room_model(result)
    if room is not None:
        out["room"] = room
    return out
