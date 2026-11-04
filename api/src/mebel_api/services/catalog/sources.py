"""Источники прайса: общий интерфейс + файл CSV + скелет парсера сайта eman.uz.

Источник только читает данные и отдаёт сырые записи (RawItem). Сопоставление с каталогом,
проверка изменений > 15% и публикация — в services/catalog/pipeline.py.

ВНИМАНИЕ про eman.uz: EmanHtmlSource написан по образцу HTML, который мы составили сами
(samples/eman_sample.html), а не по настоящему сайту. Сеть он не трогает и автоматически не
запускается. Перед включением: с разрешения владельца сайта посмотреть настоящую разметку,
адаптировать селекторы в EmanHtmlSource._Parser и реализовать fetch_pages() (расписание —
раз в сутки ночью, раздел 18 PRD). До этого — только загрузка сохранённой страницы файлом.
"""

import csv
import io
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Iterable, Protocol

ITEM_TYPES = {"sheet", "edge", "hardware", "service", "countertop", "front", "other"}

# Русские заголовки CSV → поля
CSV_ALIASES = {
    "sku": "sku", "артикул": "sku", "код": "sku",
    "name": "name", "наименование": "name", "название": "name",
    "type": "type", "тип": "type",
    "price": "price", "цена": "price",
    "unit": "unit", "ед": "unit", "единица": "unit", "ед.": "unit",
    "decor": "decor", "декор": "decor",
    "thickness": "thickness", "толщина": "thickness",
    "length": "length", "длина": "length",
    "width": "width", "ширина": "width",
    "has_grain": "has_grain", "текстура": "has_grain",
    "available": "available", "наличие": "available",
    "core_key": "core_key",
}
TYPE_ALIASES = {"лдсп": "sheet", "лист": "sheet", "хдф": "sheet", "мдф": "sheet", "кромка": "edge",
                "фурнитура": "hardware", "услуга": "service", "столешница": "countertop", "фасад": "front"}
YES = {"1", "да", "yes", "true", "есть", "в наличии", "+"}
NO = {"0", "нет", "no", "false", "нет в наличии", "-", "под заказ"}


@dataclass
class RawItem:
    """Запись прайса как есть (`raw`) и разобранные поля. Ошибка разбора — в `error`."""

    raw: dict[str, Any]
    sku: str | None = None
    name: str = ""
    type: str = "other"
    price: int | None = None
    unit: str = "шт"
    decor: str | None = None
    thickness_mm: float | None = None
    length_mm: float | None = None
    width_mm: float | None = None
    has_grain: bool = False
    available: bool = True
    core_key: str | None = None
    error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def parsed(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in ("sku", "name", "type", "price", "unit", "decor", "thickness_mm",
                                              "length_mm", "width_mm", "has_grain", "available", "core_key")}


class PriceSource(Protocol):
    """Подключаемый источник прайса."""

    code: str  # csv | eman_html | …
    price_source: str  # что писать в «источник цены» у позиции

    def records(self) -> Iterable[RawItem]: ...


# --- Разбор значений ---


def parse_price(value: Any) -> int | None:
    """«520 000», «520000 сум», «1 250,50» → целые сумы."""
    if value is None:
        return None
    s = str(value).replace(" ", " ").lower()
    s = re.sub(r"(сум|so'm|so‘m|uzs)", "", s).strip()
    s = s.replace(" ", "")
    if "," in s and "." not in s:
        s = s.replace(",", ".")
    m = re.search(r"\d+(\.\d+)?", s)
    if not m:
        return None
    return round(float(m.group(0)))


def parse_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    m = re.search(r"\d+([.,]\d+)?", str(value))
    return float(m.group(0).replace(",", ".")) if m else None


def parse_bool(value: Any, default: bool) -> bool:
    if value is None or str(value).strip() == "":
        return default
    v = str(value).strip().lower()
    if v in YES:
        return True
    if v in NO:
        return False
    return default


def normalize_type(value: Any, name: str = "") -> str:
    v = str(value or "").strip().lower()
    if v in ITEM_TYPES:
        return v
    if v in TYPE_ALIASES:
        return TYPE_ALIASES[v]
    low = name.lower()
    for word, t in TYPE_ALIASES.items():
        if word in low:
            return t
    return "other"


def item_from_fields(raw: dict[str, Any], f: dict[str, Any]) -> RawItem:
    name = str(f.get("name") or "").strip()
    item = RawItem(raw=raw, sku=(str(f.get("sku")).strip() or None) if f.get("sku") not in (None, "") else None,
                   name=name, type=normalize_type(f.get("type"), name), price=parse_price(f.get("price")),
                   unit=str(f.get("unit") or "шт").strip() or "шт",
                   decor=(str(f["decor"]).strip() or None) if f.get("decor") else None,
                   thickness_mm=parse_float(f.get("thickness")), length_mm=parse_float(f.get("length")),
                   width_mm=parse_float(f.get("width")), has_grain=parse_bool(f.get("has_grain"), False),
                   available=parse_bool(f.get("available"), True),
                   core_key=(str(f["core_key"]).strip() or None) if f.get("core_key") else None)
    if not item.name:
        item.error = "Нет наименования"
    elif item.price is None or item.price <= 0:
        item.error = "Нет цены"
    elif not item.sku:
        item.error = "Нет артикула"
    return item


# --- Источник: файл CSV ---


class CsvFileSource:
    """Прайс файлом: CSV (разделитель «;» или «,», UTF-8 или UTF-8 с BOM, cp1251).

    Колонки (рус. или англ.): Артикул, Наименование, Тип, Цена, Ед, Декор, Толщина, Длина, Ширина,
    Текстура, Наличие, core_key (id позиции в ядре — для будущей привязки сметы).
    """

    code = "csv"

    def __init__(self, data: bytes, file_name: str = "prices.csv"):
        self.data = data
        self.file_name = file_name
        self.price_source = f"file:{file_name}"

    def _text(self) -> str:
        for enc in ("utf-8-sig", "cp1251"):
            try:
                return self.data.decode(enc)
            except UnicodeDecodeError:
                continue
        raise ValueError("Не удалось прочитать файл: нужна кодировка UTF-8 или Windows-1251")

    def records(self) -> Iterable[RawItem]:
        text = self._text()
        first = text.splitlines()[0] if text else ""
        delimiter = ";" if first.count(";") >= first.count(",") else ","
        reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
        if not reader.fieldnames:
            raise ValueError("Пустой файл")
        mapping = {h: CSV_ALIASES.get(h.strip().lower()) for h in reader.fieldnames if h}
        if "price" not in mapping.values() or "name" not in mapping.values():
            raise ValueError("В файле нужны колонки «Наименование» и «Цена»")
        for row in reader:
            if not any((v or "").strip() for v in row.values() if isinstance(v, str)):
                continue
            fields = {mapping[k]: v for k, v in row.items() if k in mapping and mapping[k]}
            yield item_from_fields({k: v for k, v in row.items() if k}, fields)


# --- Источник: сайт eman.uz (скелет, НЕ запускается автоматически) ---


class EmanHtmlSource:
    """Парсер страниц каталога eman.uz — СКЕЛЕТ, адаптировать после просмотра настоящего сайта.

    Ожидаемая (выдуманная нами) разметка — samples/eman_sample.html:
      <div class="product-card" data-sku="…" data-type="sheet">
        <a class="product-card__title">ЛДСП 16 мм Белый 2800×2070</a>
        <span class="product-card__price">520 000 сум</span> <span class="product-card__unit">лист</span>
        <ul class="product-card__props"><li data-prop="decor">Белый</li><li data-prop="thickness">16</li>…</ul>
        <span class="product-card__stock">В наличии</span>
      </div>
    """

    code = "eman_html"
    price_source = "eman.uz"
    BASE_URL = "https://eman.uz"  # не используется, пока нет разрешения владельца

    def __init__(self, pages: list[str]):
        self.pages = pages  # сохранённые HTML-страницы каталога

    @classmethod
    def fetch_pages(cls) -> list[str]:
        """Загрузка страниц с сайта — НЕ реализована намеренно.

        TODO(после разрешения EMAN): список разделов каталога, пагинация, пауза между запросами,
        User-Agent с контактом, robots.txt; запуск — ночью по расписанию воркера.
        """
        raise NotImplementedError(
            "Загрузка с eman.uz не включена: сначала разрешение владельца сайта и адаптация под настоящую разметку"
        )

    class _Parser(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.items: list[dict[str, Any]] = []
            self._cur: dict[str, Any] | None = None
            self._depth = 0
            self._field: str | None = None

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            classes = (a.get("class") or "").split()
            if self._cur is None:
                if "product-card" in classes:
                    self._cur = {"sku": a.get("data-sku"), "type": a.get("data-type")}
                    self._depth = 1
                return
            self._depth += 1
            if "product-card__title" in classes:
                self._field = "name"
            elif "product-card__price" in classes:
                self._field = "price"
            elif "product-card__unit" in classes:
                self._field = "unit"
            elif "product-card__stock" in classes:
                self._field = "available"
            elif tag == "li" and a.get("data-prop"):
                self._field = a["data-prop"]

        def handle_endtag(self, tag):
            if self._cur is None:
                return
            self._field = None
            self._depth -= 1
            if self._depth == 0:
                self.items.append(self._cur)
                self._cur = None

        def handle_data(self, data):
            if self._cur is not None and self._field and data.strip():
                prev = self._cur.get(self._field)
                self._cur[self._field] = f"{prev} {data.strip()}" if prev else data.strip()

    def records(self) -> Iterable[RawItem]:
        for html in self.pages:
            p = self._Parser()
            p.feed(html)
            for card in p.items:
                yield item_from_fields(card, card)
