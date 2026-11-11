"""GLB для AR и 3D: два варианта — «закрыто» и «открыто» (раздел 8 PRD).

Реальный масштаб в метрах. glTF — Y вверх: x = X, y = Z, z = −Y
(фасад смотрит на +z, к зрителю). Детали с контуром и вырезами выдавливаются
по контуру (дуги — отрезками по ~10°). Штанга — овальная труба по габариту детали.
Фурнитура (hw3d) — те же формы, что во viewer model: узлы `hw:<id>`.

Декор фасадов (decor.py): цвет покраски — цветом детали; накладной молдинг — выдавленная полоса по пути
(высота профиля); металлическая вставка/кант — полоса 0,6 мм металлом; фрезеровка — тёмная полоса
0,2 мм по пути фрезы (имитация канавки: настоящую выборку trimesh без булевых операций не делает);
скругление углов — контуром детали. Подсветка — светящийся профиль (emissive), узлы `led:<id>`.
"""

import io
from dataclasses import dataclass

import numpy as np
import trimesh
from trimesh.transformations import rotation_matrix, translation_matrix

from .assembler import BuildResult
from .catalog import material

_AXES = {"+X": (1, 0, 0), "-X": (-1, 0, 0), "+Y": (0, 1, 0), "-Y": (0, -1, 0), "+Z": (0, 0, 1), "-Z": (0, 0, -1)}

# dmm в осях ядра → метры в осях glTF
_TO_GLTF = np.array(
    [
        [1e-4, 0, 0, 0],
        [0, 0, 1e-4, 0],
        [0, -1e-4, 0, 0],
        [0, 0, 0, 1],
    ]
)


def _part_matrix(part) -> np.ndarray:
    """Локальный параллелепипед [0..L]×[0..W]×[0..T] → координаты изделия (dmm)."""
    m = np.eye(4)
    m[:3, 0] = _AXES[part.placement.u]
    m[:3, 1] = _AXES[part.placement.v]
    m[:3, 2] = _AXES[part.placement.n]
    o = part.placement.origin
    m[:3, 3] = (o.x, o.y, o.z)
    return m


def _node_matrix(node) -> np.ndarray:
    """Положение «открыто» для подвижного узла."""
    direction = np.array(_AXES[node.axis], dtype=float)
    if node.kind in ("rotate", "lift"):
        # Поворот на +range° вокруг оси по правилу правой руки
        return rotation_matrix(np.radians(node.range), direction, point=node.origin)
    return translation_matrix(direction * node.range)


def _contour_points(contour, arc_step_deg: float = 10) -> list[tuple[float, float]]:
    """Контур из линий и дуг → ломаная (дуги — отрезками по ~10°)."""
    import math

    pts = [(contour.start_x, contour.start_y)]
    for seg in contour.segments:
        if seg.kind == "arc":
            (px, py), cx, cy = pts[-1], seg.cx, seg.cy
            a1, a2 = math.atan2(py - cy, px - cx), math.atan2(seg.y - cy, seg.x - cx)
            sweep = -((a1 - a2) % (2 * math.pi)) if seg.clockwise else (a2 - a1) % (2 * math.pi)
            r = math.hypot(px - cx, py - cy)
            n = max(2, int(abs(math.degrees(sweep)) / arc_step_deg))
            for k in range(1, n):
                a = a1 + sweep * k / n
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        pts.append((seg.x, seg.y))
    return pts


def _part_mesh(p) -> trimesh.Trimesh:
    """Параллелепипед или выдавленный контур с вырезами (в локальных координатах детали)."""
    L, W, T = p.length, p.width, p.thickness
    if p.role == "rod" and p.contour is None and not p.cutouts:
        # Овальная труба вдоль длины: эллипс W × T
        tube = trimesh.creation.cylinder(radius=1.0, height=L, sections=20)
        tube.apply_scale((W / 2, T / 2, 1))
        tube.apply_transform(rotation_matrix(np.pi / 2, (0, 1, 0)))
        tube.apply_translation((L / 2, W / 2, T / 2))
        return tube
    if p.contour is None and not p.cutouts:
        return trimesh.creation.box(extents=(L, W, T), transform=translation_matrix((L / 2, W / 2, T / 2)))
    from shapely.geometry import Polygon, box

    outer = Polygon(_contour_points(p.contour)) if p.contour is not None else box(0, 0, L, W)
    holes = [Polygon(_contour_points(c)) for c in p.cutouts]
    shape = outer
    for h in holes:
        shape = shape.difference(h)
    return trimesh.creation.extrude_polygon(shape, height=T)


def _rgba(hex_color: str) -> list[int]:
    h = hex_color.lstrip("#")
    return [int(h[i : i + 2], 16) for i in (0, 2, 4)] + [255]


def _sector_polygon(r: float, inner: float, start: float, sweep: float):
    """Сектор/кольцо в плоскости (угол от +x к +y, градусы)."""
    from shapely.geometry import Polygon

    n = max(8, int(abs(sweep) / 8))
    angles = [np.radians(start + sweep * k / n) for k in range(n + 1)]
    outer = [(r * np.cos(a), r * np.sin(a)) for a in angles]
    if inner > 0:
        ring = [(inner * np.cos(a), inner * np.sin(a)) for a in reversed(angles)]
        if abs(sweep) >= 360:
            return Polygon(outer, [ring])
        return Polygon(outer + ring)
    return Polygon(([] if abs(sweep) >= 360 else [(0.0, 0.0)]) + outer)


# Ось цилиндра (Z у trimesh) → ось ядра
_CYL_ROT = {"X": rotation_matrix(np.pi / 2, (0, 1, 0)), "Y": rotation_matrix(-np.pi / 2, (1, 0, 0)), "Z": np.eye(4)}


def _shape_mesh(s: dict) -> trimesh.Trimesh:
    """Форма фурнитуры (dmm, оси ядра) → меш в координатах изделия."""
    if s["type"] == "box":
        lo, hi = np.array(s["min"], dtype=float), np.array(s["max"], dtype=float)
        return trimesh.creation.box(extents=np.maximum(hi - lo, 1.0), transform=translation_matrix((lo + hi) / 2))
    r, length, inner = s["radius"], s["length"], s.get("inner", 0)
    sweep = s.get("sweep", 360)
    if inner or sweep < 360:
        m = trimesh.creation.extrude_polygon(_sector_polygon(r, inner, s.get("start", 0), sweep), height=length)
        m.apply_translation((0, 0, -length / 2))
    else:
        m = trimesh.creation.cylinder(radius=r, height=length, sections=24 if r > 100 else 14)
    m.apply_transform(_CYL_ROT[s["axis"]])
    m.apply_translation(s["center"])
    return m


def _hardware_meshes(result: BuildResult, nodes: dict, opened: bool):
    from .hw3d import FINISHES, hardware_visuals

    for item in hardware_visuals(result):
        if not item.shapes:
            continue
        mesh = trimesh.util.concatenate([_shape_mesh(s) for s in item.shapes])
        matrix = np.eye(4)
        if opened and item.node and item.node in nodes:
            matrix = _node_matrix(nodes[item.node])
        mesh.apply_transform(_TO_GLTF @ matrix)
        f = FINISHES[item.finish]
        mesh.visual = trimesh.visual.TextureVisuals(
            material=trimesh.visual.material.PBRMaterial(
                name=f"hw_{item.finish}", baseColorFactor=_rgba(f["color"]),
                metallicFactor=0.9 if f["metal"] else 0.0, roughnessFactor=f["roughness"],
            )
        )
        yield item, mesh


def _band(path, closed: bool, width: float, height: float, z0: float) -> trimesh.Trimesh | None:
    """Полоса шириной width вдоль пути, толщиной height от z0 вниз (наружу от лица фасада, локальная z < 0)."""
    from shapely.geometry import LineString, Polygon

    from .decor import path_points

    pts = path_points(path)
    if len(pts) < 2:
        return None
    line = LineString(pts + ([pts[0]] if closed and pts[0] != pts[-1] else []))
    shape = line.buffer(width / 2, cap_style=2, join_style=2, mitre_limit=3)
    if shape.is_empty:
        return None
    polys = list(shape.geoms) if hasattr(shape, "geoms") else [shape]
    meshes = [trimesh.creation.extrude_polygon(Polygon(pg.exterior, [i for i in pg.interiors]), height=height)
              for pg in polys if pg.area > 0]
    if not meshes:
        return None
    m = trimesh.util.concatenate(meshes)
    m.apply_translation((0, 0, z0 - height))
    return m


def _pbr(name: str, color: str, metal: bool = False, rough: float = 0.8, emissive: str | None = None):
    kw = {}
    if emissive:
        kw["emissiveFactor"] = [c / 255 for c in _rgba(emissive)[:3]]
    return trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
        name=name, baseColorFactor=_rgba(color), metallicFactor=0.9 if metal else 0.0, roughnessFactor=rough, **kw))


def _darker(hex_color: str, k: float = 0.72) -> str:
    r, g, b, _ = _rgba(hex_color)
    return "#{:02x}{:02x}{:02x}".format(int(r * k), int(g * k), int(b * k))


def _decor_meshes(p, base_color: str):
    """Меши декора детали в локальных координатах: (имя, меш, материал)."""
    from .hw3d import FINISHES

    d = p.decor
    face_z = 0 if d.face == "B" else p.thickness  # лицо фасада — локальная z = 0, наружу — минус
    sign = 1 if d.face == "B" else -1
    out = []
    groups = (("milling", d.milling, lambda m: (m.width, 2), lambda m: _pbr("decor_milling", _darker(base_color)))
              , ("overlay", d.overlay, lambda m: (m.width, m.height), lambda m: _pbr("decor_overlay", base_color))
              , ("inlay", d.inlay, lambda m: (m.width, 6),
                 lambda m: _pbr(f"decor_{m.finish}", FINISHES.get(m.finish, FINISHES["steel"])["color"], True, 0.25)))
    for name, items, size, mat in groups:
        meshes = []
        for m in items:
            w, h = size(m)
            band = _band(m.path, m.closed, w, h, 0)
            if band is not None:
                meshes.append(band)
        if meshes:
            mesh = trimesh.util.concatenate(meshes)
            if sign < 0:
                mesh.apply_scale((1, 1, -1))
            mesh.apply_translation((0, 0, face_z))
            out.append((name, mesh, mat(items[0])))
    return out


@dataclass(frozen=True)
class Look:
    """Материал узла сцены: для GLB — PBRMaterial, для USDZ — UsdPreviewSurface."""

    name: str
    color: str
    metallic: float = 0.0
    roughness: float = 0.8
    emissive: str | None = None
    texture: str | None = None  # URL скана декора (Material.texture) — только для USDZ
    texture_mm: tuple[int, int] = (1000, 1000)


def _visual(look: Look):
    kw = {"emissiveFactor": [c / 255 for c in _rgba(look.emissive)[:3]]} if look.emissive else {}
    return trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
        name=look.name, baseColorFactor=_rgba(look.color), metallicFactor=look.metallic,
        roughnessFactor=look.roughness, **kw))


def _look_of(visual) -> Look:
    m = visual.material
    em = getattr(m, "emissiveFactor", None)
    emissive = None
    if em is not None and any(float(c) > 0 for c in em):
        emissive = "#{:02x}{:02x}{:02x}".format(*(int(round(float(c) * 255)) for c in em[:3]))
    color = "#{:02x}{:02x}{:02x}".format(*(int(c) for c in m.baseColorFactor[:3]))
    return Look(name=m.name, color=color, metallic=float(m.metallicFactor or 0), roughness=float(m.roughnessFactor),
                emissive=emissive)


def _part_uv(mesh: trimesh.Trimesh, grain: str, tile_mm: tuple[int, int]) -> np.ndarray:
    """UV на каждый угол треугольника (faceVarying), меш — в локальных координатах детали (dmm).

    Проекция по преобладающей оси нормали; плитка текстуры — tile_mm (вдоль u — направление рисунка:
    у дерева волокно идёт вдоль длинной стороны плитки). grain "width" — рисунок поперёк длины детали."""
    tri = mesh.triangles / 10.0  # мм
    normals = np.abs(mesh.face_normals)
    axis = np.argmax(normals, axis=1)
    # (u, v) — какие локальные оси идут в текстуру для грани с нормалью по x / y / z
    pairs = {0: (1, 2), 1: (0, 2), 2: (0, 1)} if grain != "width" else {0: (1, 2), 1: (2, 0), 2: (1, 0)}
    uv = np.empty((len(tri), 3, 2))
    for a, (iu, iv) in pairs.items():
        sel = axis == a
        uv[sel, :, 0] = tri[sel][:, :, iu] / tile_mm[0]
        uv[sel, :, 1] = tri[sel][:, :, iv] / tile_mm[1]
    return uv.reshape(-1, 2)


def scene_items(result: BuildResult, opened: bool = False, uv: bool = False):
    """Узлы сцены: (имя узла, имя геометрии, меш в метрах glTF, Look, UV на углы треугольников или None).

    Общий источник для GLB и USDZ: одна и та же геометрия и материалы. UV считаются только при uv=True
    и только у деталей с текстурой декора."""
    nodes = {n.id: n for n in result.nodes}
    for p in result.parts:
        mesh = _part_mesh(p)
        matrix = _part_matrix(p)
        if opened and p.node and p.node in nodes:
            matrix = _node_matrix(nodes[p.node]) @ matrix
        mat = material(p.material)
        paint = p.decor.paint if p.decor is not None else None
        color = paint["color"] if paint else mat.color
        rough = {"matte": 0.85, "satin": 0.5, "gloss": 0.15}.get(paint["gloss"], 0.8) if paint else None
        texture = None if paint else mat.texture
        look = Look(
            name=f"paint_{color.lstrip('#')}_{paint['gloss']}" if paint else p.material,
            color=color,
            metallic=0.8 if mat.kind == "metal" else 0.0,
            roughness=rough if rough is not None else (0.35 if mat.kind == "metal" else 0.8),
            texture=texture, texture_mm=tuple(mat.texture_size_mm),
        )
        part_uv = _part_uv(mesh, p.grain, look.texture_mm) if uv and texture else None
        mesh.apply_transform(_TO_GLTF @ matrix)
        yield f"{p.number}:{p.key}", f"part_{p.number}", mesh, look, part_uv
        if p.decor is not None:
            for name, dm, visual in _decor_meshes(p, color):
                dm.apply_transform(_TO_GLTF @ matrix)
                yield f"{p.number}:{p.key}:{name}", f"part_{p.number}_{name}", dm, _look_of(visual), None
    for i, (item, mesh) in enumerate(_hardware_meshes(result, nodes, opened)):
        yield f"hw:{item.id}", f"hw_{i}", mesh, _look_of(mesh.visual), None
    for i, mesh in enumerate(_light_meshes(result)):
        yield f"led:{result.lights[i].id}", f"led_{i}", mesh, _look_of(mesh.visual), None


def export_glb(result: BuildResult, opened: bool = False) -> bytes:
    scene = trimesh.Scene()
    for node_name, geom_name, mesh, look, _ in scene_items(result, opened):
        # Цвет — материалом PBR (без цветов вершин: так легче файл и не нужен scipy)
        mesh.visual = _visual(look)
        scene.add_geometry(mesh, node_name=node_name, geom_name=geom_name)
    buf = io.BytesIO()
    scene.export(buf, file_type="glb")
    return buf.getvalue()


# Навесное изделие: ни одна деталь не ниже этой высоты над полом (ножки и цоколь — до 200 мм)
WALL_MIN_Z = 3000  # dmm


def ar_placement(result: BuildResult) -> str:
    """Размещение в AR: "wall" — навесное (нет опоры на пол: только верхние шкафы, полка, навесной шкаф),
    иначе "floor". Решается по геометрии: самая низкая точка деталей выше WALL_MIN_Z — изделие висит."""
    lows = []
    for p in result.parts:
        o = p.placement.origin
        z = o.z + sum(min(0.0, _AXES[ax][2] * size) for ax, size in
                      ((p.placement.u, p.length), (p.placement.v, p.width), (p.placement.n, p.thickness)))
        lows.append(z)
    return "wall" if lows and min(lows) >= WALL_MIN_Z else "floor"


_TEMP_COLOR = {3000: "#ffd9a8", 4000: "#fff1de", 6000: "#eef4ff"}


def _light_meshes(result: BuildResult):
    """Профиль подсветки: алюминиевая коробка с светящимся рассеивателем (одним мешем, emissive)."""
    from .lighting import PROFILE

    pw, ph = PROFILE
    for r in result.lights:
        a, b = np.array(r.start, dtype=float), np.array(r.end, dtype=float)
        lo, hi = np.minimum(a, b), np.maximum(a, b)
        axis = int(np.argmax(hi - lo))
        size = np.array([pw, pw, pw], dtype=float)
        size[axis] = max(hi[axis] - lo[axis], 1.0)
        center = (lo + hi) / 2
        if r.zone == "plinth":
            size[1] = ph  # на лице цоколя — тонкий по глубине
            center[1] -= ph / 2
        else:
            size[2] = ph if r.mount == "surface" else 2.0  # в пазу — заподлицо, виден только рассеиватель
            center[2] -= size[2] / 2
        m = trimesh.creation.box(extents=size, transform=translation_matrix(center))
        m.apply_transform(_TO_GLTF)
        col = _TEMP_COLOR.get(r.temp, "#ffffff")
        m.visual = _pbr(f"led_{r.temp}", col, rough=0.4, emissive=col)
        yield m
