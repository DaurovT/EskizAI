"""Сырой сбор eman.uz (scrape_eman_decors.py) → каталог декоров ядра + текстуры для 3D.

    uv run python scripts/build_eman_decors.py --raw /tmp/eman_raw.json --images /tmp/eman_img \
        --out ../core/src/mebel_core/data/eman_decors.json --textures static/textures

Только публичные картинки со страниц товаров, один запрос в ~1 с, оригиналы кэшируются на диске.
Для пилота; до продакшена нужно разрешение EMAN на использование изображений (docs/eman_research.md).
Нужен Pillow (есть в окружении API как зависимость).
"""

import argparse
import colorsys
import hashlib
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0 Safari/537.36")
DELAY = 1.0
WOOD_TILE = (800, 240)  # px, соответствует 1000×300 мм
FLAT_TILE = (512, 512)  # px, соответствует 600×600 мм
WOOD_MM, FLAT_MM = [1000, 300], [600, 600]

# --- бренды ---
BRANDS = [  # (шаблон по названию, бренд)
    (r"эггер|egger", "Egger"), (r"ультрадекор|ultradecor", "Ultradecor"), (r"кроностар|kronostar", "Kronostar"),
    (r"silkway", "Silkway"), (r"moonlight", "Moonlight"), (r"\bagt\b", "AGT"), (r"shanghai", "Shanghai UV"),
    (r"slotex", "Slotex"), (r"союз", "Союз"), (r"кедр", "КЕДР"), (r"термопласт", "Термопласт"),
    (r"кастамону|kastamonu", "Kastamonu"), (r"свисс\s*кроно|swiss\s*krono", "SwissKrono"), (r"алтай", "Алтай"),
    (r"huali", "Huali"), (r"кроношпан|kronospan", "Kronospan"),
    (r"синхро", "Синхро"), (r"супер\s*мат", "Супер Мат"), (r"каштан", "Каштан"), (r"фаворит", "Фаворит"),
    (r"смарт", "Смарт"), (r"\b3p\b", "AGT"),
]
KIND_NAME = {"ldsp": "ЛДСП", "lmdf": "ЛМДФ", "acrylic": "Акрил", "mdf": "МДФ", "lhdf": "ЛХДФ", "hdf": "ХДФ",
             "hpl": "HPL", "countertop": "Столешница", "edge": "Кромка"}
WOOD_WORDS = (r"дуб|орех|сосн|ясень|вяз|клён|клен|бук\b|венге|ольх|вишн|берёз|берез|древесин|лиственниц|тик\b|"
              r"палисандр|махагон|кедр|дерев|шпон|oak|walnut|pine|ash\b|elm|wood|teak|cherry|maple")
CYR2LAT = str.maketrans("НСЕКМАВОРТХ", "HCEKMABOPTX")
TRANSLIT = {**dict(zip("абвгдезийклмнопрстуфхцыэ", "abvgdezyiklmnoprstufhcye")), "ё": "e", "ж": "zh", "ч": "ch",
            "ш": "sh", "щ": "sch", "ю": "yu", "я": "ya", "ъ": "", "ь": ""}


def slug(s: str) -> str:
    s = s.lower()
    s = "".join(TRANSLIT.get(c, c) for c in s)
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


def num(s: str | None) -> float | None:
    m = re.search(r"\d+(?:[.,]\d+)?", s or "")
    return float(m.group(0).replace(",", ".")) if m else None


def brand_of(it: dict) -> str:
    n = it["name"].lower()
    for pat, b in BRANDS:
        if re.search(pat, n):
            return b
    prod = (it.get("props") or {}).get("Производитель") or ""
    for pat, b in BRANDS:
        if re.search(pat, prod.lower()):
            return b
    return prod.strip() or "EMAN"


def code_of(it: dict) -> str:
    c = " ".join((it.get("code") or "").split())
    c = re.split(r"\s*Индивидуал|\s*\(", c)[0]
    if re.search(r"\d", c) and re.search(r"[A-Za-z]", c):
        c = " ".join(w.translate(CYR2LAT) if re.search(r"\d", w) else w for w in c.split())
    return c[:60]


def sheet_of(it: dict) -> list[int] | None:
    p = it.get("props") or {}
    L, W = num(p.get("Длина,мм")), num(p.get("Ширина,мм"))
    if L and W:
        return sorted([int(L), int(W)], reverse=True)
    m = re.search(r"(\d{3,4})\s*[*xх×]\s*(\d{3,4})", it["name"])
    if m:
        return sorted([int(m.group(1)), int(m.group(2))], reverse=True)
    m = re.search(r"(\d)[.,](\d)\s*[*xх×]\s*(\d)[.,](\d+)", it["name"])  # 2,8*2,07
    if m:
        return sorted([round(float(f"{m.group(1)}.{m.group(2)}") * 1000), round(float(f"{m.group(3)}.{m.group(4)}") * 1000)], reverse=True)
    return None


def thickness_of(it: dict) -> float | None:
    t = num((it.get("props") or {}).get("Толщина,мм"))
    if t:
        return t
    n = it["name"]
    if it["kind"] == "edge":  # 19/04, 21/0,8, 35/2 → толщина кромки
        m = re.search(r"\b(\d{2})/(0?[.,]?\d+)", n)
        if m:
            v = m.group(2).replace(",", ".")
            return float("0." + v[1:]) if v.startswith("0") and "." not in v and len(v) > 1 else float(v)
        return None
    for pat in (r"(\d+(?:[.,]\d+)?)\s*(?:мм|mm)", r"\d{3,4}\s*[*xх×]\s*\d{3,4}\s*[*xх×]\s*(\d{1,2})\b",
                r"[xх×*](\d{2})\s*(?:мм|mm)?\b"):
        m = re.search(pat, n)
        if m:
            return float(m.group(1).replace(",", "."))
    return None


def clean_name(it: dict, brand: str, code: str) -> str:
    n = it["name"]
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r"\d{3,4}\s*[*xх×]\s*\d{3,4}(\s*[*xх×]\s*\d+(?:[.,]\d+)?)?", " ", n)
    n = re.sub(r"\d[.,]?\d*\s*[xх×*]\s*\d[.,]?\d*\s*[xх×*]\s*\d+", " ", n)
    n = re.sub(r"\d+(?:[.,]\d+)?\s*(?:мм|mm|кв)\b", " ", n)
    n = re.sub(r"\bmm\b", " ", n)
    n = re.sub(r"\bST\s?\d+\b|\b\d[.,]\d{3}\b|\b\d{3,4}\s*/\s*[A-Za-z]+\b", " ", n)
    for pat, _ in BRANDS:
        n = re.sub(pat, " ", n, flags=re.I)
    n = re.sub(r"^(ЛДСП|ЛМДФ|ЛХДФ|ХДФ|МДФ|Акрил|Панель|БСП|HPL|Compact|ДБСП|Scalar|Столешница|Стол|аналог|UV|PF\+|SP|"
               r"индивидуал\.?\s*упак\.?|\s)+", " ", n, flags=re.I)
    n = n.replace(code, " ") if code else n
    n = " ".join(n.split(" ,.-"))
    n = re.sub(r"\s+", " ", n).strip(" -,.")
    n = re.sub(r"\b(МДФ|ЛМДФ|ХДФ|ЛХДФ|ЛДСП|ПРОФ|Столешница|мм)\b|Индивидуал\S*\s*упак\S*", " ", n, flags=re.I)
    n = re.sub(r"\b\d{1,2}\b", " ", n) if it["kind"] in ("mdf", "hdf") else n
    n = re.sub(r"\s+", " ", n).strip(" -,.")
    return n if len(re.findall(r"[A-Za-zА-Яа-я]", n)) >= 2 else ""


def finish_of(it: dict, kind: str) -> str:
    n = it["name"].lower()
    surf = it.get("surface_type") or ""
    if re.search(r"soft\s*touch|софт|супер\s*мат|supermat|super\s*mat|суперматов", n) or surf == "Суперматовая":
        return "softtouch"
    if re.search(r"глянц|gloss|глосс|ultra gloss|\bug\b", n) or surf == "Глянцевая":
        return "gloss"
    if kind == "acrylic":
        return "acrylic"
    if kind in ("ldsp", "lmdf", "mdf", "lhdf", "hdf", "hpl"):
        return "matte"
    return ""


def family_of(rgb: tuple[int, int, int], grain: bool) -> str:
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
    h *= 360
    if v < 0.2:
        return "black"
    if s < 0.12 and v > 0.82:
        return "white"
    if s < 0.14:
        return "grey" if v > 0.2 else "black"
    if grain or (10 <= h <= 45 and s >= 0.2 and v < 0.55):
        return "wood-light" if v > 0.55 else "wood-dark"
    if 15 <= h <= 60 and s < 0.4 and v >= 0.7:
        return "beige"
    return "colour"


def stock_of(it: dict) -> int | None:
    if "stock" not in it:
        return None
    return int(sum(num(q) or 0 for q in it["stock"].values()))


def select(items: list[dict]) -> list[dict]:
    out = []
    for it in items:
        k = it["kind"]
        if not it.get("price"):
            continue
        n = it["name"]
        if k == "countertop":
            if not re.search(r"столешниц|стенов|^(Союз|КЕДР)\s+(Стол|\d)", n, re.I) or re.search(r"угол|плинтус|торцев", n, re.I):
                continue
        if k == "hpl" and it["category"] == 269 and "Scalar" in n:
            pass
        out.append(it)
    return out


def normalize(raw: list[dict]) -> list[dict]:
    rows = []
    for it in select(raw):
        k = it["kind"]
        brand, code = brand_of(it), code_of(it)
        thk = thickness_of(it)
        sheet = sheet_of(it)
        row = {
            "kind": k, "name": "", "brand": brand, "code": code, "thickness_mm": thk,
            "sheet_mm": sheet, "price": it["price"], "unit": "шт" if k == "edge" else "лист",
            "available": (stock_of(it) or 0) > 0 if stock_of(it) is not None else True,
            "stock_qty": stock_of(it), "url": it.get("source_url") or f'https://eman.uz/ru/product/{it["product_id"]}/',
            "image_url": it.get("image") or it.get("thumb"), "product_id": it["product_id"],
            "fetched_at": it.get("fetched_at"), "decor_type": it.get("decor_type"),
        }
        dn = clean_name(it, brand, code)
        has_dn = bool(dn)
        t = f"{thk:g}".replace(".", ",") if thk else ""
        row["decor_name"] = dn
        row["name"] = " ".join(x for x in (KIND_NAME[k], t, dn or (brand if k != "edge" else "")) if x) if k != "edge" else it["name"]
        dn = dn or ""
        row["has_grain"] = bool(it.get("decor_type") == "Дерево" or re.search(WOOD_WORDS, dn, re.I)) and k != "edge"
        row["finish"] = finish_of(it, k)
        if k == "edge":
            m = re.search(r"\b(\d{2})/", it["name"])
            row["width_mm"] = int(m.group(1)) if m else None
            row["unit"] = "м"
        if k == "countertop" and sheet:
            area = sheet[0] * sheet[1] / 1e6
            row["price_per_m2"] = round(it["price"] / area) if area else None
            m = re.search(r"(\d{4})\s*[*xх×]\s*(\d{3})\s*[*xх×]\s*\d+", it["name"])
            if m and int(m.group(2)) == 600:
                row["price_per_m"] = round(it["price"] / (int(m.group(1)) / 1000))
        if k != "countertop" and sheet and k != "edge":
            row["price_per_m2"] = round(it["price"] / (sheet[0] * sheet[1] / 1e6))
        rows.append(row)
    # id: kind_thickness_brand_code; при совпадении — добавляем id товара EMAN
    def base(r):
        t = "x" if r["thickness_mm"] is None else f'{r["thickness_mm"]:g}'.replace(".", "_")
        pre = {"countertop": "ct"}.get(r["kind"], r["kind"])
        code_s = slug(r["code"])[:28] or slug(r["decor_name"])[:28] or str(r["product_id"])
        return f'{pre}_{t}_{slug(r["brand"])}_{code_s}'
    from collections import Counter
    cnt = Counter(base(r) for r in rows)
    for r in rows:
        b = base(r)
        r["id"] = b if cnt[b] == 1 else f'{b}_{r["product_id"]}'
    rows.sort(key=lambda r: (r["kind"], r["brand"], r["id"]))
    return rows


# --- текстуры ---
def download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    from urllib.parse import quote, urlsplit, urlunsplit
    u = urlsplit(url)
    url = urlunsplit((u.scheme, u.netloc, quote(u.path, safe="/%"), u.query, ""))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            dest.write_bytes(urllib.request.urlopen(req, timeout=40).read())
            time.sleep(DELAY)
            return True
        except Exception as e:  # noqa: BLE001
            print("retry", url, e, file=sys.stderr, flush=True)
            time.sleep(4 * (attempt + 1))
    return False


def make_texture(src: Path, dest: Path, grain_hint: bool) -> dict | None:
    from PIL import Image, ImageStat

    try:
        im = Image.open(src).convert("RGB")
    except Exception:  # noqa: BLE001
        return None
    im.thumbnail((1024, 1024))
    gray = im.convert("L")
    std = ImageStat.Stat(gray).stddev[0]
    # направление: если рисунок идёт вертикально (градиент по x сильнее), поворачиваем — вдоль длинной стороны плитки
    w, h = gray.size
    px = gray.load()
    gx = sum(abs(px[x, y] - px[x - 1, y]) for y in range(0, h, 4) for x in range(1, w, 2))
    gy = sum(abs(px[x, y] - px[x, y - 1]) for y in range(1, h, 2) for x in range(0, w, 4))
    aniso = max(gx, gy) / max(1, min(gx, gy))
    grain = grain_hint or (aniso > 2.2 and std > 12)
    if gx > gy * 1.15 and grain:
        im = im.rotate(90, expand=True)
    w, h = im.size
    # центральная обрезка по пропорции плитки
    tile = WOOD_TILE if grain else FLAT_TILE
    ar = tile[0] / tile[1]
    cw, ch = (w, int(w / ar)) if w / h < ar else (int(h * ar), h)
    box = ((w - cw) // 2, (h - ch) // 2, (w + cw) // 2, (h + ch) // 2)
    cropped = im.crop(box)
    mean = tuple(int(c) for c in ImageStat.Stat(cropped).mean)
    color = "#%02x%02x%02x" % mean
    info = {"color": color, "family_rgb": mean, "grain_img": grain, "plain": std < 5 and not grain}
    if info["plain"]:
        return info
    cropped.resize(tile, Image.LANCZOS).save(dest, "JPEG", quality=78, optimize=True, progressive=True)
    return info


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--images", type=Path, help="кэш оригиналов картинок")
    ap.add_argument("--textures", type=Path, help="куда класть готовые текстуры (api/static/textures)")
    a = ap.parse_args()
    raw = json.loads(a.raw.read_text())
    rows = normalize(raw)
    if a.images and a.textures:
        a.images.mkdir(parents=True, exist_ok=True)
        a.textures.mkdir(parents=True, exist_ok=True)
        todo = [r for r in rows if r["kind"] != "edge" and r["image_url"]]
        for n, r in enumerate(todo, 1):
            src = a.images / (hashlib.sha1(r["image_url"].encode()).hexdigest() + ".img")
            if not download(r["image_url"], src):
                r["image_error"] = True
                continue
            dest = a.textures / f'{r["id"]}.jpg'
            info = make_texture(src, dest, r["has_grain"])
            if not info:
                r["image_error"] = True
                continue
            r["color"] = info["color"]
            r["family"] = family_of(info["family_rgb"], r["has_grain"])
            if info["grain_img"] and not r["has_grain"] and r["kind"] != "countertop":
                r["has_grain"] = True  # по картинке видно направление
            if info["plain"]:
                r["texture"], r["texture_size_mm"] = None, None
            else:
                r["texture"] = f'/static/textures/{r["id"]}.jpg'
                r["texture_size_mm"] = WOOD_MM if info["grain_img"] else FLAT_MM
            if n % 50 == 0:
                print(f"текстуры: {n}/{len(todo)}", flush=True)
    out = {"source": "eman.uz (публичные страницы, пилот: нужно разрешение EMAN)",
           "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "items": rows}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print("декоров", len(rows), "→", a.out)


if __name__ == "__main__":
    main()
