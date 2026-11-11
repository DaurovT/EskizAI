"""USDZ для AR Quick Look (iPhone): та же сцена, что GLB «закрыто» (glb.scene_items), без комнаты.

Формат (Apple, «USDZ File Format Specification»): zip без сжатия, данные каждого файла начинаются
с границы 64 байта, первый файл — слой сцены. Слой пишем текстом (.usda — Quick Look его принимает,
так же работает USDZExporter three.js, которым model-viewer собирал USDZ в браузере), текстуры — JPEG ≤ 1024 px.

Сцена: метры, Y вверх (`metersPerUnit = 1`, `upAxis = "Y"`), фасад смотрит на +Z (к зрителю).
Начало координат — по центру изделия по ширине; у напольного — на полу по центру глубины,
у навесного — по центру высоты на задней плоскости (её Quick Look прикладывает к стене).
Материалы — UsdPreviewSurface: цвет или текстура декора (UV по плитке декора), шероховатость, металл,
свечение у подсветки. Меши сгруппированы по материалу (один Mesh на материал) — меньше узлов и файл.

Зависимостей нет (только numpy и Pillow для ужатия текстур); проверка в тестах — usd-core (pxr), если стоит.
"""

import io
import re
import struct
import zlib
from collections.abc import Callable

import numpy as np

from ..assembler import BuildResult
from ..glb import Look, ar_placement, scene_items

LAYER_NAME = "model.usda"
MAX_TEXTURE_PX = 1024
_ALIGN = 64

TextureLoader = Callable[[str], bytes | None]


# ---------- zip (stored, 64-байтное выравнивание) ----------

_DOS_DATE = (0 << 9) | (1 << 5) | 1  # 1980-01-01: файл не зависит от времени сборки
_PAD_ID = 0x1986  # служебное поле extra для выравнивания (так же делает usdzip)


def pack_usdz(files: list[tuple[str, bytes]]) -> bytes:
    """Zip без сжатия; начало данных каждого файла — кратно 64 байтам. Первый файл — слой сцены."""
    out = bytearray()
    central = bytearray()
    for name, data in files:
        raw_name = name.encode()
        offset = len(out)
        pad = (-(offset + 30 + len(raw_name) + 4)) % _ALIGN
        extra = struct.pack("<HH", _PAD_ID, pad) + b"\0" * pad
        crc = zlib.crc32(data) & 0xFFFFFFFF
        out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, 0, 0, _DOS_DATE, crc, len(data), len(data),
                           len(raw_name), len(extra))
        out += raw_name + extra
        assert len(out) % _ALIGN == 0
        out += data
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, 0, 0, _DOS_DATE, crc, len(data),
                               len(data), len(raw_name), 0, 0, 0, 0, 0, offset)
        central += raw_name
    cd_offset = len(out)
    out += central
    out += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(files), len(files), len(central), cd_offset, 0)
    return bytes(out)


# ---------- текстуры ----------


def _prepare_texture(data: bytes, max_px: int = MAX_TEXTURE_PX) -> bytes | None:
    """JPEG (baseline, RGB), длинная сторона ≤ max_px. Не картинка — None (будет цвет)."""
    try:
        from PIL import Image

        im = Image.open(io.BytesIO(data))
        im.load()
        im = im.convert("RGB")
        if max(im.size) > max_px:
            im.thumbnail((max_px, max_px), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85, optimize=True, progressive=False)
        return buf.getvalue()
    except Exception:  # noqa: BLE001 — битая текстура не должна ронять AR
        return None


# ---------- USDA ----------


def _ident(s: str, prefix: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_]", "_", s)[:48]
    return f"{prefix}{s}"


def _rgb(hex_color: str) -> str:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return f"({r:.4g}, {g:.4g}, {b:.4g})"


def _vec(a: np.ndarray, fmt: str) -> str:
    return ", ".join("(" + ", ".join(fmt % v for v in row) + ")" for row in a.tolist())


def _ints(a) -> str:
    return ", ".join(str(int(v)) for v in a)


def _material(name: str, look: Look, tex_path: str | None) -> str:
    base = f"/Root/Materials/{name}"
    lines = [f'        def Material "{name}"', "        {",
             f"            token outputs:surface.connect = <{base}/PreviewSurface.outputs:surface>", "",
             '            def Shader "PreviewSurface"', "            {",
             '                uniform token info:id = "UsdPreviewSurface"']
    if tex_path:
        lines.append(f"                color3f inputs:diffuseColor.connect = <{base}/Texture.outputs:rgb>")
    else:
        lines.append(f"                color3f inputs:diffuseColor = {_rgb(look.color)}")
    if look.emissive:
        lines.append(f"                color3f inputs:emissiveColor = {_rgb(look.emissive)}")
    lines += [f"                float inputs:metallic = {look.metallic:.3g}",
              f"                float inputs:roughness = {look.roughness:.3g}",
              "                float inputs:opacity = 1",
              "                int inputs:useSpecularWorkflow = 0",
              "                token outputs:surface", "            }"]
    if tex_path:
        r, g, b = (v / 255 for v in (int(look.color.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)))
        lines += ["", '            def Shader "uvReader_st"', "            {",
                  '                uniform token info:id = "UsdPrimvarReader_float2"',
                  '                string inputs:varname = "st"',
                  "                float2 inputs:fallback = (0, 0)",
                  "                float2 outputs:result", "            }", "",
                  '            def Shader "Texture"', "            {",
                  '                uniform token info:id = "UsdUVTexture"',
                  f"                asset inputs:file = @{tex_path}@",
                  f"                float4 inputs:fallback = ({r:.4g}, {g:.4g}, {b:.4g}, 1)",
                  '                token inputs:sourceColorSpace = "sRGB"',
                  f"                float2 inputs:st.connect = <{base}/uvReader_st.outputs:result>",
                  '                token inputs:wrapS = "repeat"',
                  '                token inputs:wrapT = "repeat"',
                  "                float3 outputs:rgb", "            }"]
    lines.append("        }")
    return "\n".join(lines)


def _mesh(name: str, mat: str, points: np.ndarray, faces: np.ndarray, normals: np.ndarray,
          uv: np.ndarray | None) -> str:
    lo, hi = points.min(axis=0), points.max(axis=0)
    corner_normals = np.repeat(normals, 3, axis=0)
    lines = [f'            def Mesh "{name}" (', '                prepend apiSchemas = ["MaterialBindingAPI"]', "            )",
             "            {",
             f"                float3[] extent = [{_vec(np.array([lo, hi]), '%.6g')}]",
             f"                int[] faceVertexCounts = [{', '.join(['3'] * len(faces))}]",
             f"                int[] faceVertexIndices = [{_ints(faces.reshape(-1))}]",
             f"                rel material:binding = </Root/Materials/{mat}>",
             f"                normal3f[] normals = [{_vec(corner_normals, '%.4g')}] (",
             '                    interpolation = "faceVarying"', "                )",
             f"                point3f[] points = [{_vec(points, '%.6g')}]"]
    if uv is not None:
        lines += [f"                texCoord2f[] primvars:st = [{_vec(uv, '%.5g')}] (",
                  '                    interpolation = "faceVarying"', "                )"]
    lines += ['                uniform token subdivisionScheme = "none"', "            }"]
    return "\n".join(lines)


def _origin_shift(lo: np.ndarray, hi: np.ndarray, placement: str) -> np.ndarray:
    """Сдвиг сцены: по центру ширины; пол — y от 0, центр глубины; стена — центр высоты, задняя плоскость z = 0."""
    if placement == "wall":
        return np.array([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
    return np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])


def export_usdz(result: BuildResult, *, placement: str | None = None,
                texture_loader: TextureLoader | None = None, max_texture_px: int = MAX_TEXTURE_PX) -> bytes:
    """USDZ «закрыто» для AR Quick Look. texture_loader(url) → байты картинки декора (None — только цвет)."""
    placement = placement or ar_placement(result)
    groups: dict[tuple, dict] = {}
    for _, _, mesh, look, uv in scene_items(result, opened=False, uv=texture_loader is not None):
        if len(mesh.faces) == 0:
            continue
        textured = look.texture is not None and uv is not None
        key = (look.name, look.color, look.metallic, look.roughness, look.emissive, look.texture if textured else None)
        g = groups.setdefault(key, {"look": look, "parts": [], "textured": textured})
        g["parts"].append((np.asarray(mesh.vertices, dtype=float), np.asarray(mesh.faces), np.asarray(mesh.face_normals),
                           uv))
    if not groups:
        raise ValueError("Пустая модель — нечего показывать в AR")

    all_pts = np.vstack([v for g in groups.values() for v, *_ in g["parts"]])
    shift = _origin_shift(all_pts.min(axis=0), all_pts.max(axis=0), placement)

    textures: dict[str, str | None] = {}  # url → путь в архиве
    files: list[tuple[str, bytes]] = []
    materials, meshes = [], []
    for i, g in enumerate(groups.values()):
        look: Look = g["look"]
        tex_path = None
        if g["textured"]:
            if look.texture not in textures:
                raw = texture_loader(look.texture) if texture_loader else None
                jpg = _prepare_texture(raw, max_texture_px) if raw else None
                path = None
                if jpg:
                    path = f"textures/{_ident(look.texture.rsplit('/', 1)[-1].rsplit('.', 1)[0], 't')}_{len(files)}.jpg"
                    files.append((path, jpg))
                textures[look.texture] = path
            tex_path = textures[look.texture]
        mat = _ident(look.name, f"m{i}_")
        materials.append(_material(mat, look, tex_path))
        pts, fcs, nrm, uvs, base = [], [], [], [], 0
        for v, f, n, uv in g["parts"]:
            pts.append(v + shift)
            fcs.append(f + base)
            nrm.append(n)
            uvs.append(uv if uv is not None else np.zeros((len(f) * 3, 2)))
            base += len(v)
        meshes.append(_mesh(f"mesh_{i}", mat, np.vstack(pts), np.vstack(fcs), np.vstack(nrm),
                            np.vstack(uvs) if tex_path else None))

    alignment = "vertical" if placement == "wall" else "horizontal"
    layer = "\n".join([
        "#usda 1.0", "(", '    customLayerData = {', '        string creator = "Eskiz AI"', "    }",
        '    defaultPrim = "Root"', "    metersPerUnit = 1", '    upAxis = "Y"', ")", "",
        'def Xform "Root"', "{",
        '    def Scope "Scenes" (', '        kind = "sceneLibrary"', "    )", "    {",
        '        def Xform "Scene" (', "            customData = {",
        "                bool preliminary_collidesWithEnvironment = 0",
        '                string sceneName = "Scene"', "            }", "        )", "        {",
        '            token preliminary:anchoring:type = "plane"',
        f'            token preliminary:planeAnchoring:alignment = "{alignment}"', "",
        "\n\n".join(meshes), "        }", "    }", "",
        '    def Scope "Materials"', "    {", "\n\n".join(materials), "    }", "}", "",
    ])
    return pack_usdz([(LAYER_NAME, layer.encode()), *files])
