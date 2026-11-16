"""Синтетические превью листов для мока «Входящих чертежей» (SCR-52…55): как WebP-превью из Eskiz DWG,
только нарисованные по макетам MDrawing / MInboxItem (настоящие чертежи заказчиков в репозиторий не кладём).

    ../api/.venv/bin/python scripts/gen_mock_dwg.py      # из папки app/ → assets/mock/dwg_*.png
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

APP = Path(__file__).resolve().parents[1]
OUT = APP / "assets/mock"
FONT = APP / "node_modules/@expo-google-fonts/onest/600SemiBold/Onest_600SemiBold.ttf"
K = 3  # px на единицу макета
INK, GRID, HATCH, GLASS, BLUE, CARC = "#2A2F36", "#EEF0F3", "#B6BEC9", "#9FC3E8", "#1F4FBF", "#F7F6F3"


def canvas(w: int, h: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    im = Image.new("RGB", (w * K, h * K), "white")
    d = ImageDraw.Draw(im)
    for x in range(0, w + 1, 12):
        d.line([(x * K, 0), (x * K, h * K)], fill=GRID, width=max(1, round(0.8 * K)))
    for y in range(0, h + 1, 12):
        d.line([(0, y * K), (w * K, y * K)], fill=GRID, width=max(1, round(0.8 * K)))
    return im, d


def rect(d, x, y, w, h, fill=None, outline=INK, width=1.3):
    d.rectangle([x * K, y * K, (x + w) * K, (y + h) * K], fill=fill, outline=outline, width=max(1, round(width * K)))


def line(d, pts, color=INK, width=1.0):
    d.line([(x * K, y * K) for x, y in pts], fill=color, width=max(1, round(width * K)))


def circle(d, cx, cy, r, width=1.0):
    d.ellipse([(cx - r) * K, (cy - r) * K, (cx + r) * K, (cy + r) * K], outline=INK, width=max(1, round(width * K)))


def label(d, x, y, text, rotate=False, im=None):
    f = ImageFont.truetype(str(FONT), 12 * K)
    w = d.textlength(text, font=f) / K + 8
    if not rotate:
        d.rounded_rectangle([(x - w / 2) * K, (y - 13) * K, (x + w / 2) * K, (y + 5) * K], radius=4 * K, fill="white")
        d.text((x * K, y * K), text, font=f, fill=BLUE, anchor="ms")
        return
    tile = Image.new("RGBA", (round(w * K), 18 * K), (255, 255, 255, 255))
    ImageDraw.Draw(tile).text((w * K / 2, 13 * K), text, font=f, fill=BLUE, anchor="ms")
    tile = tile.rotate(90, expand=True)
    im.paste(tile, (round((x - 9) * K), round((y - w / 2) * K)))


def dim_h(d, x1, x2, y, text):
    line(d, [(x1, y), (x2, y)], BLUE)
    line(d, [(x1, y - 5), (x1, y + 5)], BLUE)
    line(d, [(x2, y - 5), (x2, y + 5)], BLUE)
    label(d, (x1 + x2) / 2, y + 4, text)


def dim_v(d, x, y1, y2, text, im):
    line(d, [(x, y1), (x, y2)], BLUE)
    line(d, [(x - 5, y1), (x + 5, y1)], BLUE)
    line(d, [(x - 5, y2), (x + 5, y2)], BLUE)
    label(d, x, (y1 + y2) / 2, text, rotate=True, im=im)


def kitchen_plan() -> Image.Image:
    """Угловая кухня, план (MDrawing.dc.html: стены 3200 и 2400, мойка у окна, варочная)."""
    im, d = canvas(366, 300)
    line(d, [(58, 66), (318, 66)], width=4)
    line(d, [(58, 66), (58, 262)], width=4)
    d.rectangle([208 * K, 60 * K, 272 * K, 65 * K], fill=GLASS)
    for x, y, w, h in [(62, 70, 52, 52), (114, 70, 44, 52), (158, 70, 44, 52), (202, 70, 70, 52), (272, 70, 44, 52),
                       (62, 122, 52, 44), (62, 166, 52, 44), (62, 210, 52, 50)]:
        rect(d, x, y, w, h, fill=CARC)
    line(d, [(62, 70), (114, 122)], HATCH, 0.8)
    line(d, [(114, 70), (62, 122)], HATCH, 0.8)
    d.rounded_rectangle([220 * K, 80 * K, 258 * K, 108 * K], radius=8 * K, outline=INK, width=round(1.1 * K))
    for cx, cy in [(168, 86), (190, 86), (168, 108), (190, 108)]:
        circle(d, cx, cy, 6)
    dim_h(d, 58, 318, 40, "3200")
    dim_v(d, 32, 66, 262, "2400", im)
    return im


def kitchen_elevation() -> Image.Image:
    """Развёртка стены A: нижний ряд, столешница, верхний ряд."""
    im, d = canvas(366, 300)
    line(d, [(40, 250), (330, 250)], width=2.5)
    for i, w in enumerate([52, 44, 44, 70, 44]):
        x = 58 + sum([52, 44, 44, 70, 44][:i])
        rect(d, x, 172, w, 74, fill=CARC)
        line(d, [(x + w / 2 - 8, 180), (x + w / 2 + 8, 180)], width=2)
        rect(d, x, 70, w, 62, fill=CARC)
    rect(d, 54, 164, 266, 8, fill="#E7E3DA")
    line(d, [(202, 70), (272, 132)], HATCH, 0.8)
    line(d, [(272, 70), (202, 132)], HATCH, 0.8)
    dim_h(d, 58, 312, 40, "3200")
    dim_v(d, 32, 172, 250, "850", im)
    dim_v(d, 340, 70, 132, "720", im)
    return im


def wardrobe() -> Image.Image:
    """Шкаф-купе в нишу, фасад: три двери, зеркало посередине, антресоль."""
    im, d = canvas(366, 300)
    line(d, [(70, 268), (300, 268)], width=2.5)
    rect(d, 80, 40, 210, 228, width=1.8)
    line(d, [(80, 84), (290, 84)], width=1.3)
    for i in range(3):
        x = 82 + i * 69
        rect(d, x, 88, 68, 178, fill="#E9EEF3" if i == 1 else CARC, width=1.1)
    line(d, [(165, 120), (195, 160)], HATCH, 0.8)
    line(d, [(170, 190), (200, 230)], HATCH, 0.8)
    dim_h(d, 80, 290, 22, "1800")
    dim_v(d, 50, 40, 268, "2400", im)
    return im


def hallway() -> Image.Image:
    """Прихожая: вешалка, тумба, зеркало (единицы угаданы)."""
    im, d = canvas(366, 300)
    line(d, [(50, 262), (316, 262)], width=2.5)
    rect(d, 70, 60, 90, 202, fill=CARC)
    rect(d, 160, 190, 120, 72, fill=CARC)
    line(d, [(160, 226), (280, 226)], width=1.1)
    d.rounded_rectangle([180 * K, 70 * K, 260 * K, 170 * K], radius=10 * K, outline=INK, width=round(1.2 * K))
    for x in (90, 115, 140):
        circle(d, x, 90, 4)
    dim_h(d, 70, 280, 38, "210")
    dim_v(d, 40, 60, 262, "200", im)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in [("dwg_kitchen_plan", kitchen_plan), ("dwg_kitchen_elev", kitchen_elevation),
                     ("dwg_kupe", wardrobe), ("dwg_hallway", hallway)]:
        im = fn()
        im = im.resize((im.width * 2 // 3, im.height * 2 // 3), Image.LANCZOS)  # ~732 px, как превью DWG (~1000)
        im.save(OUT / f"{name}.png", optimize=True)
    print("ok")


if __name__ == "__main__":
    main()
