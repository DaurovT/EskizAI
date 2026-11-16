"""Иконки и заставка Eskiz Mebel из знака семейства Eskiz (шкаф на зелёной плитке, макет Logo.dc.html).

Знак задан линиями в сетке 48×48 (как SVG в макете): корпус, средняя стойка, ручки, цоколь, «линия земли»
и точка эскиза. Рисуем с запасом ×4 и уменьшаем — края гладкие без SVG-рендера.

    ../api/.venv/bin/python scripts/gen_brand.py      # из папки app/
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

APP = Path(__file__).resolve().parents[1]
GREEN = (56, 125, 80, 255)  # #387D50
WHITE = (255, 255, 255, 255)
FONTS = APP / "node_modules/@expo-google-fonts/onest"
SS = 4  # суперсэмплинг

# линии знака в сетке 48: (точки, прозрачность)
LINES = [
    ([(12, 40), (12, 13), (36, 13), (36, 40)], 1.0),
    ([(24, 13), (24, 40)], 1.0),
    ([(20, 24), (20, 29)], 1.0),
    ([(28, 24), (28, 29)], 1.0),
    ([(12, 34), (36, 34)], 0.55),
    ([(4, 40), (44, 40)], 1.0),
]
DOT = ((41, 8), 2.6)
STROKE = 2.6


def mark(size: int, color=WHITE, stroke: float = STROKE) -> Image.Image:
    """Знак без плитки, квадрат size×size (сетка 48 на весь квадрат), прозрачный фон."""
    S = size * SS
    k = S / 48
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    for pts, op in LINES:
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        w = max(1, round(stroke * k))
        xy = [(x * k, y * k) for x, y in pts]
        d.line(xy, fill=color, width=w, joint="curve")
        r = w / 2
        for x, y in xy:  # круглые концы
            d.ellipse((x - r, y - r, x + r, y + r), fill=color)
        if op < 1:
            a = layer.getchannel("A").point(lambda v: int(v * op))
            layer.putalpha(a)
        im.alpha_composite(layer)
    (cx, cy), rr = DOT
    ImageDraw.Draw(im).ellipse(((cx - rr) * k, (cy - rr) * k, (cx + rr) * k, (cy + rr) * k), fill=color)
    return im.resize((size, size), Image.LANCZOS)


def rounded(size: int, radius: float, fill) -> Image.Image:
    S = size * SS
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, S - 1, S - 1), radius=radius * SS, fill=fill)
    return im.resize((size, size), Image.LANCZOS)


def tile(size: int, *, square: bool = False, bg=GREEN) -> Image.Image:
    """Плитка как в макете: 140 → скругление 31, знак 88 по центру."""
    im = Image.new("RGBA", (size, size), bg) if square else rounded(size, size * 31 / 140, bg)
    m = round(size * 88 / 140)
    stroke = STROKE if size >= 96 else STROKE * 1.35  # на мелких размерах линии толще
    im.alpha_composite(mark(m, stroke=stroke), ((size - m) // 2, (size - m) // 2))
    return im


def splash(size: int = 780) -> Image.Image:
    """Нативная заставка (на зелёном фоне): полупрозрачная плитка со знаком, «Eskiz Mebel», «мебель в 3D».
    Пропорции — как у прежней картинки, чтобы AppSplash совпадал с ней без скачка."""
    f = size / 780
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = round(396 * f)
    bx, by = (size - box) // 2, round(46 * f)
    im.alpha_composite(rounded(box, 102 * f, (255, 255, 255, 31)), (bx, by))
    m = round(box * 112 / 132)
    im.alpha_composite(mark(m), (bx + (box - m) // 2, by + (box - m) // 2))
    d = ImageDraw.Draw(im)
    bold = ImageFont.truetype(str(FONTS / "700Bold/Onest_700Bold.ttf"), round(118 * f))
    med = ImageFont.truetype(str(FONTS / "500Medium/Onest_500Medium.ttf"), round(118 * f))
    reg = ImageFont.truetype(str(FONTS / "400Regular/Onest_400Regular.ttf"), round(44 * f))
    a, b = "Eskiz ", "Mebel"
    wa, wb = d.textlength(a, font=bold), d.textlength(b, font=med)
    x = (size - wa - wb) / 2
    y = round(620 * f)
    d.text((x, y), a, font=bold, fill=WHITE, anchor="ls")
    d.text((x + wa, y), b, font=med, fill=(255, 255, 255, 178), anchor="ls")
    t = "мебель в 3D"
    d.text(((size - d.textlength(t, font=reg)) / 2, round(720 * f)), t, font=reg, fill=(255, 255, 255, 217), anchor="ls")
    return im


def main() -> None:
    a = APP / "assets"
    tile(1024, square=True).convert("RGB").save(a / "icon.png")  # iOS скругляет сам
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))  # Android: знак в безопасной зоне (66%)
    m = mark(560)
    fg.alpha_composite(m, ((1024 - 560) // 2, (1024 - 560) // 2))
    fg.save(a / "adaptive-icon.png")
    splash(780).save(a / "splash-icon.png")
    mark(336).save(a / "brand/mark.png")
    tile(96).save(a / "brand/logo.png")
    tile(48).save(a / "favicon.png")
    ios = APP / "ios/EskizAI/Images.xcassets"
    if ios.exists():  # нативный проект собран заранее (prebuild не запускаем) — кладём картинки и туда
        tile(1024, square=True).convert("RGB").save(ios / "AppIcon.appiconset/App-Icon-1024x1024@1x.png")
        for name, s in (("image.png", 260), ("image@2x.png", 520), ("image@3x.png", 780)):
            splash(780).resize((s, s), Image.LANCZOS).save(ios / "SplashScreenLogo.imageset" / name)
    print("ok")


if __name__ == "__main__":
    main()
