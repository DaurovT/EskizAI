"""Иконки и заставка Eskiz Mebel из знака семейства Eskiz (шкаф на зелёной плитке, макет Logo.dc.html).

Знак задан линиями в сетке 48×48 (как SVG в макете): корпус, средняя стойка, ручки, цоколь, «линия земли»
и точка эскиза. Рисуем с запасом ×4 и уменьшаем — края гладкие без SVG-рендера.

    ../api/.venv/bin/python scripts/gen_brand.py      # из папки app/
"""

from pathlib import Path

from PIL import Image, ImageDraw

APP = Path(__file__).resolve().parents[1]
GREEN = (56, 125, 80, 255)  # #387D50
WHITE = (255, 255, 255, 255)
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
# знак Eskiz DWG (MOpenDwg.dc.html): лист с рамкой, штамп, размерная линия — для плитки «Открыть в Eskiz DWG»
DWG_LINES = [
    ([(10, 40), (10, 12), (38, 12), (38, 40)], 1.0),
    ([(27, 40), (27, 33), (38, 33)], 0.55),
    ([(15, 21), (33, 21)], 1.0),
    ([(15, 18), (15, 24)], 1.0),
    ([(33, 18), (33, 24)], 1.0),
    ([(4, 40), (44, 40)], 1.0),
]
DOT = ((41, 8), 2.6)
STROKE = 2.6


def mark(size: int, color=WHITE, stroke: float = STROKE, lines=None) -> Image.Image:
    """Знак без плитки, квадрат size×size (сетка 48 на весь квадрат), прозрачный фон."""
    S = size * SS
    k = S / 48
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    for pts, op in lines or LINES:
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
    """Нативная заставка (на зелёном фоне, imageWidth 260 pt → 3 px на pt): только полупрозрачная плитка 132 r29
    со знаком 84 — там же, где её рисует AppSplash (Splash.dc.html). «Eskiz Mebel» и «мебель в 3D» поднимаются
    уже в AppSplash (анимация rise из макета), поэтому в картинке их нет — иначе подъём дал бы мигание."""
    f = size / 780
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = round(396 * f)  # 132 pt
    # блок макета (плитка 132 + 22 + строка 48 + 6 + строка 22 = 230 pt) — по центру экрана, как и картинка 260 pt
    bx, by = (size - box) // 2, round(45 * f)
    im.alpha_composite(rounded(box, 87 * f, (255, 255, 255, 31)), (bx, by))
    m = round(252 * f)  # знак 84 pt
    im.alpha_composite(mark(m), (bx + (box - m) // 2, by + (box - m) // 2))
    return im


def main() -> None:
    a = APP / "assets"
    # значок приложения — из макета «Значки Eskiz · стиль Apple» (assets/brand/app-icon-1024.png, отрисован из app-icon.svg);
    # знак-шкаф ниже — для заставки, логотипа и favicon
    app_icon = Image.open(a / "brand/app-icon-1024.png").convert("RGB")
    app_icon.save(a / "icon.png")
    # Android adaptive-icon.png делается из того же значка (см. историю), здесь не трогаем
    splash(780).save(a / "splash-icon.png")
    mark(336).save(a / "brand/mark.png")
    mark(168, lines=DWG_LINES, stroke=STROKE * 1.15).save(a / "brand/dwg-mark.png")
    tile(96).save(a / "brand/logo.png")
    app_icon.resize((48, 48), Image.LANCZOS).save(a / "favicon.png")
    ios = APP / "ios/EskizAI/Images.xcassets"
    if ios.exists():  # нативный проект собран заранее (prebuild не запускаем) — кладём картинки и туда
        app_icon.save(ios / "AppIcon.appiconset/App-Icon-1024x1024@1x.png")
        for name, s in (("image.png", 260), ("image@2x.png", 520), ("image@3x.png", 780)):
            splash(780).resize((s, s), Image.LANCZOS).save(ios / "SplashScreenLogo.imageset" / name)
    print("ok")


if __name__ == "__main__":
    main()
