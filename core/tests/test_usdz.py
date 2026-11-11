"""USDZ для AR Quick Look: валидный zip-USDZ, габариты в метрах = GLB ±1 мм, текстуры ≤ 1024 px, размещение."""

import io
import json
import re
import struct
import zipfile
from pathlib import Path

import numpy as np
import pytest
import trimesh

from mebel_core import ar_placement, build, export_glb, export_usdz, viewer_model
from mebel_core.catalog import DECOR_MATERIALS

FIXTURES = Path(__file__).parent / "fixtures"
MM = 1e-3


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def _layer(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return z.read(z.namelist()[0]).decode()


def _points_bounds(usda: str) -> tuple[np.ndarray, np.ndarray]:
    pts = []
    for block in re.findall(r"point3f\[\] points = \[(.*?)\]\n", usda):
        pts += [tuple(map(float, t.split(","))) for t in re.findall(r"\(([^()]*)\)", block)]
    a = np.array(pts)
    return a.min(axis=0), a.max(axis=0)


def _glb_bounds(result) -> np.ndarray:
    return trimesh.load(io.BytesIO(export_glb(result)), file_type="glb").bounds


def _textured_tree() -> tuple[dict, str]:
    """Шкаф из декора с текстурой (дерево): корпус и фасады."""
    decor = next(m for m in DECOR_MATERIALS.values() if m.texture and m.kind == "ldsp" and m.thickness == 160)
    s = json.dumps(load("wardrobe_full")).replace('"ldsp_16_white"', f'"{decor.id}"')
    return json.loads(s), decor.texture


def _big_png(w: int = 2000, h: int = 1500) -> bytes:
    from PIL import Image

    im = Image.linear_gradient("L").resize((w, h)).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def test_usdz_is_valid_aligned_package() -> None:
    data = export_usdz(build(load("wardrobe_full")))
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert z.testzip() is None
        infos = z.infolist()
        assert infos[0].filename == "model.usda"  # первый файл — слой сцены
        for info in infos:
            assert info.compress_type == zipfile.ZIP_STORED  # без сжатия
            # начало данных = смещение локального заголовка + 30 + имя + extra (из локального заголовка)
            name_len, extra_len = struct.unpack("<HH", data[info.header_offset + 26:info.header_offset + 30])
            assert (info.header_offset + 30 + name_len + extra_len) % 64 == 0, info.filename
    usda = _layer(data)
    assert usda.startswith("#usda 1.0")
    assert "metersPerUnit = 1" in usda and 'upAxis = "Y"' in usda and 'defaultPrim = "Root"' in usda
    assert 'info:id = "UsdPreviewSurface"' in usda and "inputs:roughness" in usda
    assert 'preliminary:planeAnchoring:alignment = "horizontal"' in usda


@pytest.mark.parametrize("name", ["wardrobe_full", "kitchen_corner", "wardrobe_builtin", "kupe_3doors", "wardrobe_decor"])
def test_usdz_size_matches_model(name: str) -> None:
    result = build(load(name))
    lo, hi = _points_bounds(_layer(export_usdz(result)))
    glo, ghi = _glb_bounds(result)
    # габариты сцены = габариты GLB «закрыто» (та же геометрия, без комнаты) ±1 мм
    assert np.allclose(hi - lo, ghi - glo, atol=MM)
    # ширина и высота — как у изделия (мм → м)
    assert abs((hi[0] - lo[0]) - result.size[0] * 1e-4) <= MM
    assert abs((hi[1] - lo[1]) - result.size[1] * 1e-4) <= MM
    # стоит на полу, по центру ширины и глубины
    assert abs(lo[1]) <= MM and abs(lo[0] + hi[0]) <= MM and abs(lo[2] + hi[2]) <= MM


def test_usdz_textures_downscaled_and_bound() -> None:
    tree, url = _textured_tree()
    calls = []

    def loader(u: str) -> bytes:
        calls.append(u)
        return _big_png()

    data = export_usdz(build(tree), texture_loader=loader)
    assert calls == [url]  # одна текстура на декор, загружена один раз
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        tex = [n for n in z.namelist() if n.startswith("textures/")]
        assert len(tex) == 1 and tex[0].endswith(".jpg")
        from PIL import Image

        im = Image.open(io.BytesIO(z.read(tex[0])))
        assert im.format == "JPEG" and max(im.size) <= 1024
    usda = _layer(data)
    assert f"@{tex[0]}@" in usda
    assert "inputs:diffuseColor.connect" in usda and "texCoord2f[] primvars:st" in usda
    assert len(data) < 10 * 1024 * 1024  # лимит для типового шкафа


def test_usdz_without_texture_falls_back_to_color() -> None:
    tree, _ = _textured_tree()
    data = export_usdz(build(tree), texture_loader=lambda u: None)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert z.namelist() == ["model.usda"]
    assert "diffuseColor.connect" not in _layer(data)
    # битая картинка — тоже цвет, не ошибка
    assert "diffuseColor.connect" not in _layer(export_usdz(build(tree), texture_loader=lambda u: b"not an image"))


def _wall_only(result):
    """Только верхние модули кухни — навесное изделие."""
    return result.model_copy(update={"parts": [p for p in result.parts if p.key.startswith("wall[")],
                                     "hardware": [], "lights": []})


def test_placement_floor_and_wall() -> None:
    kitchen = build(load("kitchen_straight"))
    assert ar_placement(build(load("wardrobe_full"))) == "floor"
    assert ar_placement(kitchen) == "floor"
    assert viewer_model(kitchen)["placement"] == "floor"
    wall = _wall_only(kitchen)
    assert ar_placement(wall) == "wall"
    usda = _layer(export_usdz(wall))
    assert 'preliminary:planeAnchoring:alignment = "vertical"' in usda
    lo, hi = _points_bounds(usda)
    # навесное: задняя плоскость на z = 0 (к стене), по центру высоты
    assert abs(lo[2]) <= MM and abs(lo[1] + hi[1]) <= MM


def test_usdz_opens_in_usd() -> None:
    """Проверка настоящим USD (usd-core, dev-зависимость): слой читается, габариты, валидаторы USD/USDZ."""
    pxr = pytest.importorskip("pxr")
    from pxr import Usd, UsdGeom, UsdValidation

    tree, _ = _textured_tree()
    result = build(tree)
    data = export_usdz(result, texture_loader=lambda u: _big_png(600, 400))
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "m.usdz"
        path.write_bytes(data)
        stage = Usd.Stage.Open(str(path))
        assert UsdGeom.GetStageMetersPerUnit(stage) == 1.0 and UsdGeom.GetStageUpAxis(stage) == "Y"
        box = UsdGeom.BBoxCache(Usd.TimeCode.Default(), ["default"]).ComputeWorldBound(
            stage.GetPseudoRoot()).ComputeAlignedRange()
        glo, ghi = _glb_bounds(result)
        assert np.allclose(np.array(box.GetSize()), ghi - glo, atol=MM)
        validators = [v for v in UsdValidation.ValidationRegistry().GetOrLoadAllValidators()
                      if not any(k in v.GetMetadata().name for k in ("Physics", "Skel"))]
        errors = UsdValidation.ValidationContext(validators).Validate(stage)
        assert not errors, [e.GetMessage() for e in errors]
    assert pxr
