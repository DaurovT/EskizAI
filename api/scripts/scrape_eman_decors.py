"""Сбор публичного каталога декоров eman.uz → сырой JSON (для пилота, нужно разрешение EMAN).

Только страницы, которые видит обычный посетитель: списки категорий, фильтры списка,
карточки товаров. Без входа и форм, один запрос в ~1,2 с, кэш страниц на диске
(повторный запуск сеть не трогает).

    uv run python scripts/scrape_eman_decors.py --cache /tmp/eman_cache --out /tmp/eman_raw.json
"""

import argparse
import hashlib
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://eman.uz"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0 Safari/537.36")
DELAY = 1.2

# id категории → наш вид; product — читать ли карточки (наличие, размеры)
CATEGORIES = {
    15: ("ldsp", True), 16: ("acrylic", True), 182: ("acrylic", True), 60: ("lmdf", True),
    143: ("mdf", True), 183: ("lhdf", True), 186: ("hdf", True), 215: ("hpl", True),
    198: ("hpl", True), 269: ("hpl", True), 3: ("countertop", True), 83: ("edge", False),
}
FILTERS = ("decor_type", "surface_type")
FILTER_CATS = (15, 16, 60, 143, 183, 215, 3)

_last = 0.0


def fetch(cache: Path, url: str) -> tuple[str, str]:
    """Страница из кэша или с сайта; возвращает (html, время загрузки ISO)."""
    global _last
    key = hashlib.sha1(url.encode()).hexdigest()
    path = cache / f"{key}.html"
    meta = cache / f"{key}.meta"
    if path.exists():
        return path.read_text(), meta.read_text() if meta.exists() else ""
    wait = DELAY - (time.monotonic() - _last)
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru"})
    for attempt in range(3):
        try:
            body = urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "replace")
            break
        except Exception as e:  # noqa: BLE001
            print("retry", url, e, file=sys.stderr, flush=True)
            time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f"не загрузилось: {url}")
    _last = time.monotonic()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    path.write_text(body)
    meta.write_text(now)
    return body, now


def _text(s: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", s)).split())


def parse_cards(page: str) -> list[dict]:
    out = []
    chunks = page.split('data-product-id="')[1:]
    for ch in chunks:
        pid = ch.split('"', 1)[0]
        if not pid.isdigit():
            continue
        ch = ch[:6000]
        name = re.search(r'<h3>\s*<a href="/ru/product/\d+/">(.*?)</a>', ch, re.S)
        code = re.search(r'products-card-vendor-code">\s*<span>[^<]*</span>\s*<b>(.*?)</b>', ch, re.S)
        price = re.search(r"<span>([\d\s ]+)\s*so", ch)
        thumb = re.search(r'<img src="([^"]+)"', ch)
        orig = re.search(r"this\.src = '([^']+)'", ch)
        status = [_text(x) for x in re.findall(r'products-card-status">\s*<ul>(.*?)</ul>', ch, re.S)]
        out.append({
            "product_id": int(pid),
            "name": _text(name.group(1)) if name else "",
            "code": _text(code.group(1)) if code else None,
            "price": int(re.sub(r"\D", "", price.group(1))) if price else None,
            "thumb": urllib.parse.urljoin(BASE, thumb.group(1)) if thumb else None,
            "image": urllib.parse.urljoin(BASE, orig.group(1)) if orig else None,
            "badges": [s for s in status if s],
        })
    return out


def pages_of(page: str) -> int:
    return max([int(x) for x in re.findall(r"[?&]page=(\d+)", page)] + [1])


def list_all(cache: Path, cid: int, params: dict | None = None) -> tuple[list[dict], str]:
    q = dict(params or {})
    url = f"{BASE}/ru/product/{cid}/list/" + (f"?{urllib.parse.urlencode(q)}" if q else "")
    first, ts = fetch(cache, url)
    cards = parse_cards(first)
    for n in range(2, pages_of(first) + 1):
        q2 = {**q, "page": n}
        body, _ = fetch(cache, f"{BASE}/ru/product/{cid}/list/?{urllib.parse.urlencode(q2)}")
        cards += parse_cards(body)
    return cards, ts


def filter_values(page: str, param: str) -> list[str]:
    return [html.unescape(v) for v in re.findall(
        rf'data-filter-param="{param}"\s+value="([^"]+)"', page)]


def parse_product(page: str) -> dict:
    props: dict[str, str] = {}
    for k, v in re.findall(r"<li>\s*<span>([^<]+)</span>\s*<i></i>\s*<b>([^<]*)</b>", page):
        props.setdefault(_text(k).rstrip(":"), _text(v))
    stock = {_text(n): _text(q) for n, q in re.findall(
        r'branch-badge-name">(.*?)</span>\s*<span class="branch-badge-qty">(.*?)</span>', page, re.S)}
    gallery = re.findall(r'products-gallery-item">\s*<img src="([^"]+)"', page)
    desc = re.search(r"<h4>Описание</h4>\s*<p>(.*?)</p>", page, re.S)
    return {"props": props, "stock": stock, "images": [urllib.parse.urljoin(BASE, g) for g in gallery],
            "description": _text(desc.group(1)) if desc else ""}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--no-products", action="store_true", help="не читать карточки товаров")
    a = ap.parse_args()
    a.cache.mkdir(parents=True, exist_ok=True)
    items: dict[int, dict] = {}
    for cid, (kind, _) in CATEGORIES.items():
        cards, ts = list_all(a.cache, cid)
        for c in cards:
            c.update(category=cid, kind=kind, list_url=f"{BASE}/ru/product/{cid}/list/", fetched_at=ts)
            items.setdefault(c["product_id"], c)
        print(f"категория {cid} ({kind}): {len(cards)}", flush=True)
    for cid in FILTER_CATS:
        first, _ = fetch(a.cache, f"{BASE}/ru/product/{cid}/list/")
        for param in FILTERS:
            for value in filter_values(first, param):
                cards, _ = list_all(a.cache, cid, {param: value})
                for c in cards:
                    if c["product_id"] in items:
                        items[c["product_id"]].setdefault(param, value)
                print(f"фильтр {cid} {param}={value}: {len(cards)}", flush=True)
    if not a.no_products:
        todo = [it for it in items.values() if CATEGORIES[it["category"]][1]
                and (it["kind"] != "countertop" or re.search(r"столешниц|стенов", it["name"], re.I))]
        for n, it in enumerate(todo, 1):
            url = f"{BASE}/ru/product/{it['product_id']}/"
            body, ts = fetch(a.cache, url)
            it.update(parse_product(body), source_url=url, fetched_at=ts or it["fetched_at"])
            if n % 50 == 0:
                print(f"карточки: {n}/{len(todo)}", flush=True)
    a.out.write_text(json.dumps(list(items.values()), ensure_ascii=False, indent=1))
    print("всего", len(items), "→", a.out)


if __name__ == "__main__":
    main()
