"""Производственные чертежи: штамп на каждом листе, виды, развёртки, взрыв-схема, детали, комплект.

Тесты не сверяются с эталонами деталей (присадка и детали меняются вместе с модулями) — только то,
что документы строятся для всех изделий, листов разумное число и на листах есть нужные надписи.
"""

import json
import time
from pathlib import Path

import pytest
from reportlab.pdfgen import textobject

import mebel_core as mc
from mebel_core import build
from mebel_core.exports import drawings as d
from mebel_core.exports.sheet import SheetCanvas, page_count
from mebel_core.nesting import nest
from mebel_core.parts import Groove, Hole, Pocket

FIXTURES = Path(__file__).parent / "fixtures"
GOOD = sorted(p.stem for p in FIXTURES.glob("*.json") if not p.stem.startswith("bad_"))
KITCHENS = [n for n in GOOD if n.startswith("kitchen")]


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


@pytest.fixture
def texts(monkeypatch) -> list[str]:
    """Все строки, выведенные на холст (reportlab пишет текст через PDFTextObject._formatText)."""
    out: list[str] = []
    orig = textobject.PDFTextObject._formatText

    def spy(self, text):
        out.append(text)
        return orig(self, text)

    monkeypatch.setattr(textobject.PDFTextObject, "_formatText", spy)
    return out


@pytest.fixture
def stamps(monkeypatch) -> list[tuple[int, int, str]]:
    """(лист, листов, наименование) — что попало в штамп каждого листа."""
    out: list[tuple[int, int, str]] = []
    orig = SheetCanvas._frame_and_stamp

    def spy(self, n, total):
        out.append((n, total, self.sheet_title))
        return orig(self, n, total)

    monkeypatch.setattr(SheetCanvas, "_frame_and_stamp", spy)
    return out


@pytest.mark.parametrize("name", GOOD)
def test_drawing_set_for_every_product(name: str, texts, stamps) -> None:
    result = build(load(name))
    data = mc.export_drawing_set_pdf(result, nest(result), project=f"{name} · версия 1", workshop="Цех Тест")
    assert data[:5] == b"%PDF-"
    n = page_count(data)
    groups = d.part_groups(result)
    assert 8 <= n <= 20 + len(groups)  # титул, виды, взрыв, детали (до 4 на лист), спецификация, раскрой
    # Штамп на каждом листе: «Лист N из M» сквозной
    assert [s[0] for s in stamps] == list(range(1, n + 1)) and {s[1] for s in stamps} == {n}
    joined = "\n".join(texts)
    for label in ("Комплект чертежей", "Состав комплекта", "Лист", "Листов", "Масштаб", "Eskiz Mebel", "Цех: Цех Тест",
                  "Вид спереди", "А–А", "Вид спереди без фасадов", "Чертежи деталей", "Фурнитура и крепёж",
                  "Спецификация деталей", "Карта раскроя"):
        assert label in joined, label
    titles = [s[2] for s in stamps]
    assert titles[0].startswith("Комплект чертежей")
    assert any(t.startswith("Схема сборки") for t in titles)
    # Номера позиций на чертежах деталей — как в спецификации
    first = groups[0]
    assert f"Поз. {d.number_ranges(first.numbers)} · {first.p.name}" in joined
    if any(p.holes for p in result.parts):
        assert "Отверстия (координаты от угла 0, пласть A):" in joined and "Ø" in texts
    if name.startswith("kitchen"):
        assert "Развёртка стены А" in "\n".join(titles) and "План (вид сверху)" in titles


def test_corner_kitchen_has_both_walls_and_run_chains(texts, stamps) -> None:
    result = build(load("kitchen_corner"))
    mc.export_general_view_pdf(result, "Кухня")
    titles = [s[2] for s in stamps]
    assert "Развёртка стены А (от угла)" in titles and "Развёртка стены Б (от угла)" in titles
    for v in ("450", "800", "1100", "стена 1800", "угол"):  # модули ряда 1, длина ряда 2 по стене Б
        assert v in texts, v
    for h in ("100", "820", "858", "1400", "2120"):  # высоты от пола: ножки, корпус, столешница, верхние
        assert h in texts, h


def test_wall_layout_shows_utilities_from_site(texts) -> None:
    result = build(load("kitchen_builtin"))
    mc.export_general_view_pdf(result, "Кухня")
    joined = "\n".join(texts)
    assert "Вода" in joined and "Канализация" in joined and "Розетка" in joined
    assert "420" in texts and "1500" in texts and "стена 3518" in texts


def test_wardrobe_views_dimension_chains(texts) -> None:
    result = build(load("wardrobe_full"))
    mc.export_general_view_pdf(result, "Шкаф")
    for v in ("1800", "2400", "570", "596", "400", "600", "618"):  # габариты, проёмы секций, антресоль, глубина
        assert v in texts, v
    assert "592×1904" in texts  # размер двери — на двери


def test_every_existing_pdf_has_title_block(stamps) -> None:
    result = build(load("kupe_3doors"))
    n = nest(result)
    docs = {"spec": mc.export_spec_pdf(result, "П", workshop="Ц"), "cut": mc.export_cutmaps_pdf(result, n, "П"),
            "parts": mc.export_part_drawings_pdf(result, "П"), "view": mc.export_general_view_pdf(result, "П"),
            "assembly": mc.export_assembly_pdf(result, "П")}
    total = sum(page_count(v) for v in docs.values())
    assert len(stamps) == total and all(v[:5] == b"%PDF-" for v in docs.values())
    assert any(t.startswith("Карта раскроя") for _, _, t in stamps)


def test_identical_parts_grouped_with_qty() -> None:
    result = build(load("wardrobe_full"))
    groups = d.part_groups(result)
    sheet_parts = [p for p in result.parts if d._drawn(p)]
    assert sum(g.qty for g in groups) == len(sheet_parts)
    assert any(g.qty > 1 for g in groups) and len(groups) < len(sheet_parts)
    nums = sorted(n for g in groups for n in g.numbers)
    assert nums == sorted(p.number for p in sheet_parts)


def test_part_drawing_renders_any_holes_grooves_pockets(texts) -> None:
    """Присадка любого вида — в пласти A/B, в каждом торце, пазы и выборки — рисуется и попадает в таблицу."""
    result = build(load("wardrobe_2sec"))
    shelf = next(p for p in result.parts if p.role == "shelf")
    shelf.holes = [Hole(x=370, y=370, diameter=80, depth=120, face="A", purpose="эксцентрик"),
                   Hole(x=1000, y=500, diameter=50, depth=0, face="B", purpose="сквозное"),
                   Hole(x=0, y=320, diameter=80, depth=340, face="x0", purpose="шкант"),
                   Hole(x=shelf.length, y=320, diameter=80, depth=340, face="x1", purpose="шкант"),
                   Hole(x=640, y=0, diameter=50, depth=500, face="y0", purpose="конфирмат"),
                   Hole(x=640, y=shelf.width, diameter=50, depth=500, face="y1", purpose="конфирмат")]
    shelf.grooves = [Groove(x0=0, y0=200, x1=shelf.length, y1=240, width=40, depth=80, face="B", purpose="паз")]
    shelf.pockets = [Pocket(x=1200, y=1200, width=600, height=300, depth=60, face="A")]
    data = mc.export_part_drawings_pdf(result, "П")
    assert data[:5] == b"%PDF-"
    for label in ("торец Ш1", "торец Ш2", "торец Д1", "торец Д2", "т. Д2", "скв.", "эксцентрик", "паз 4×8 (B)",
                  "выборка гл. 6 (A)"):
        assert label in texts, label


def test_standard_scales() -> None:
    assert d.pick_scale(1800, 2400, 200 * d.MM, 200 * d.MM) == 15
    assert d.pick_scale(700, 400, 300 * d.MM, 300 * d.MM, scales=d.PART_SCALES) == 2.5
    assert d.scale_label(2.5) == "1:2,5" and d.fmt(397.5) == "397,5" and d.fmt(0.4) == "0,4"


def test_iso_order_draws_far_parts_first() -> None:
    result = build(load("wardrobe_2sec"))
    bs = d.boxes(result.parts)
    order = d.iso_order(bs)
    pos = {id(b): i for i, b in enumerate(order)}
    back = next(b for b in bs if b.p.role == "back")
    left = next(b for b in bs if b.p.key == "body.side.left")
    shelf = next(b for b in bs if b.p.role == "shelf")
    assert pos[id(back)] < pos[id(shelf)]  # задняя стенка дальше полки
    assert pos[id(left)] > pos[id(shelf)]  # левая боковина ближе к зрителю (вид спереди-слева)


@pytest.mark.parametrize("name", ["kitchen_builtin", "kitchen_corner_square"])
def test_big_kitchen_set_is_fast(name: str) -> None:
    result = build(load(name))
    n = nest(result)
    t = time.perf_counter()
    mc.export_drawing_set_pdf(result, n, project="Кухня")
    assert time.perf_counter() - t < 3.0
