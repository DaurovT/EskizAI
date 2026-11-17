"""Проект по входящему чертежу (SCR-55 «Разбор чертежа», POST /inbox/drawings/{id}/project).

Из пакета .eskiz берётся один лист: его превью (WebP) становится исходным фото проекта, а из `data.json`
(формат 1, eskiz-dwg/docs/package_format.md) собирается короткий текст — габариты, цепочки размеров, оси,
отметки, марки, заголовки и надписи листа в мм. Этот текст приложение отправляет в обычное распознавание
(POST /projects/{id}/ai/design) — дальше всё как с фото и описанием.

Пакет читается из закрытой зоны хранилища с потолками размеров (zip-бомбы): data.json — до 4 МБ,
превью — до 5 МБ. Неизвестные и битые поля пропускаются: из того, что есть, текст всё равно собирается.
"""

import io
import json
import uuid
import zipfile
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain import PhotoKind, ProjectStatus
from ..errors import ApiError
from ..models import InboxDrawing, Project, ProjectPhoto, ProjectStatusChange
from . import inbox, titles
from .storage import Storage

MAX_DATA_BYTES = 4 * 1024 * 1024
MAX_TEXT = 1800  # с запасом до 4000 символов DesignIn.text (мастер может дописать своё)

LABELS = {
    "ru": {
        "head": "Чертёж из Eskiz DWG «{title}»", "sheet": "лист {n}", "scale": "масштаб 1:{s}", "mm": "Размеры в мм.",
        "frame": "Рамка листа", "overall": "Габариты", "axes": "Оси", "chains": "Цепочки размеров", "single": "Размеры",
        "levels": "Отметки", "marks": "Марки", "titles": "Виды", "texts": "Надписи", "tables": "Таблицы",
        "h": "гориз.", "v": "верт.", "rows": "строк", "guessed": "Единицы угаданы — проверьте размеры.",
    },
    "uz": {
        "head": "Eskiz DWG chizmasi «{title}»", "sheet": "varaq {n}", "scale": "masshtab 1:{s}", "mm": "O‘lchamlar mm da.",
        "frame": "Varaq ramkasi", "overall": "Gabaritlar", "axes": "O‘qlar", "chains": "O‘lcham zanjirlari", "single": "O‘lchamlar",
        "levels": "Belgilar", "marks": "Markalar", "titles": "Ko‘rinishlar", "texts": "Yozuvlar", "tables": "Jadvallar",
        "h": "gor.", "v": "vert.", "rows": "qator", "guessed": "Birliklar taxminiy — o‘lchamlarni tekshiring.",
    },
}


def _s(v: Any, limit: int = 120) -> str | None:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return _num(v)
    return (" ".join(v.split())[:limit] or None) if isinstance(v, str) else None


def _num(v: Any) -> str | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return str(int(round(v))) if abs(v - round(v)) < 0.05 else f"{v:.1f}"


def _list(v: Any) -> list:
    return v if isinstance(v, list) else []


def _dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


# --- выбор листа ---


def pick_sheet(manifest: dict[str, Any] | None, wanted: str | None) -> tuple[dict[str, Any] | None, int | None]:
    """(лист, его номер по порядку) из manifest: по id или номеру (`wanted`), иначе первый отмеченный,
    иначе первый. Листов нет — (None, None): берём модель. Запрошенного листа нет — 422 sheet_not_found."""
    sheets = inbox.sheets_of(manifest)
    if wanted is not None:
        w = wanted.strip()
        for i, s in enumerate(sheets):
            if w and w in (s["id"], s["number"]):
                return s, i
        raise ApiError(422, "sheet_not_found", "В чертеже нет такого листа", {"sheet": wanted})
    for i, s in enumerate(sheets):
        if s["selected"]:
            return s, i
    return (sheets[0], 0) if sheets else (None, None)


def data_sheet(data: dict[str, Any], sheet: dict[str, Any] | None, index: int | None) -> dict[str, Any]:
    """Лист в data.json: по id (`s1` или номер), по номеру, иначе по порядку. Без листа — раздел `model`."""
    sheets = [s for s in _list(data.get("sheets")) if isinstance(s, dict)]
    if sheet is None:
        return _dict(data.get("model"))
    for key in ("id", "number"):
        val = sheet.get(key)
        if val:
            for s in sheets:
                if str(s.get("id")) == val or str(s.get("number")) == val:
                    return s
    if index is not None and 0 <= index < len(sheets):
        return sheets[index]
    return {}


# --- текст для ИИ ---


def _chain(c: dict[str, Any], lb: dict[str, str]) -> str | None:
    values = _s(c.get("values"), 60)
    total = _num(c.get("overall")) or _num(c.get("sum"))
    if not values and not total:
        return None
    s = values or ""
    if total and total != values:
        s = f"{s} = {total}" if s else total
    extra = [x for x in (f"{_s(c.get('axes'), 20)}" if _s(c.get("axes"), 20) else None,
                         lb["h"] if c.get("dir") == "h" else lb["v"] if c.get("dir") == "v" else None) if x]
    return f"{s} ({', '.join(extra)})" if extra else s


def _overall(chains: list[dict[str, Any]], singles: list[Any] = ()) -> str | None:
    """Габарит по самым длинным горизонтальным и вертикальным размерам: цепочки и отдельные размеры
    (у отдельного размера значение в `v` — формат Eskiz DWG — или `mm`)."""
    best: dict[str, float] = {}
    items = list(chains) + [d for d in singles if isinstance(d, dict)]
    for c in items:
        d = c.get("dir")
        v = next((c.get(k) for k in ("overall", "sum", "v", "mm") if isinstance(c.get(k), (int, float))), None)
        if d in ("h", "v") and isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            best[d] = max(best.get(d, 0), float(v))
    if not best:
        return None
    return " × ".join(_num(best[k]) for k in ("h", "v") if k in best)


def _single(dims: dict[str, Any]) -> list[str]:
    out = []
    for d in _list(dims.get("single")):
        if isinstance(d, dict):
            v = _num(d.get("v")) or _num(d.get("mm")) or _num(d.get("value")) or _s(d.get("text"), 20)
            n = d.get("count") or d.get("n")
            if v:
                out.append(f"{v} ×{n}" if isinstance(n, int) and not isinstance(n, bool) and n > 1 else v)
        elif isinstance(d, (int, float, str)):
            v = _s(d, 20)
            if v:
                out.append(v)
    return out


def _uniq(items: list[str], n: int) -> list[str]:
    seen, out = set(), []
    for it in items:
        if it and it not in seen:
            seen.add(it)
            out.append(it)
        if len(out) >= n:
            break
    return out


def sheet_text(title: str, sheet: dict[str, Any] | None, ds: dict[str, Any], manifest: dict[str, Any] | None,
               lang: str = "ru") -> str:
    """Короткое описание листа для распознавания (до MAX_TEXT символов): самое нужное — первым."""
    lb = LABELS.get(lang, LABELS["ru"])
    head = [lb["head"].format(title=title)]
    if sheet:
        n = " ".join(x for x in (sheet.get("number"), f"«{sheet['name']}»" if sheet.get("name") else None) if x)
        if n:
            head.append(lb["sheet"].format(n=n))
    scale = _num(ds.get("scale")) or _num(next((s.get("scale") for s in _list(_dict(manifest).get("sheets"))
                                                if isinstance(s, dict) and sheet and s.get("id") == sheet.get("id")), None))
    if scale and scale != "1":
        head.append(lb["scale"].format(s=scale))
    lines = [", ".join(head) + ". " + lb["mm"]]
    if _dict(_dict(manifest).get("units")).get("source") == "guessed":
        lines.append(lb["guessed"])

    dims = _dict(ds.get("dimensions"))
    chains = [c for c in _list(dims.get("chains")) if isinstance(c, dict)]
    overall = _overall(chains, _list(dims.get("single")))
    if overall:
        lines.append(f"{lb['overall']}: {overall}.")
    frame = [_num(v) for v in _list(ds.get("frame_mm"))[:2]]
    if not overall and all(frame) and len(frame) == 2:
        lines.append(f"{lb['frame']}: {frame[0]} × {frame[1]}.")
    axes = _uniq([_s(a.get("summary"), 160) or "" for a in _list(ds.get("axes")) if isinstance(a, dict)], 3)
    if axes:
        lines.append(f"{lb['axes']}: {'; '.join(axes)}.")
    ch = _uniq([_chain(c, lb) or "" for c in chains], 10)
    if ch:
        lines.append(f"{lb['chains']}: {'; '.join(ch)}.")
    single = _uniq(_single(dims), 16)
    if single:
        lines.append(f"{lb['single']}: {', '.join(single)}.")
    levels = []
    for e in _list(ds.get("elevations")):
        if isinstance(e, dict):
            v = _s(e.get("v"), 20) or _num(e.get("mm"))
            note = _s(e.get("note"), 40)
            if v:
                levels.append(f"{v} ({note})" if note else v)
    levels = _uniq(levels, 8)
    if levels:
        lines.append(f"{lb['levels']}: {'; '.join(levels)}.")
    marks = _dict(ds.get("marks"))
    if marks:
        ms = [f"{_s(k, 20)} ×{v}" if isinstance(v, int) and not isinstance(v, bool) and v > 1 else _s(k, 20) or ""
              for k, v in list(marks.items())[:12]]
        ms = _uniq(ms, 12)
        if ms:
            lines.append(f"{lb['marks']}: {', '.join(ms)}.")
    vt = _uniq([_s(t, 120) or "" for t in _list(ds.get("titles"))], 3)
    if vt:
        lines.append(f"{lb['titles']}: {'; '.join(vt)}.")
    tables = []
    for t in _list(ds.get("tables")):
        if isinstance(t, dict):
            name = _s(t.get("title"), 60) or "—"
            rows = len(_list(t.get("rows")))
            hdr = ", ".join(x for x in (_s(h, 20) for h in _list(t.get("header"))[:6]) if x)
            tables.append(f"{name} ({rows} {lb['rows']}{': ' + hdr if hdr else ''})")
    tables = _uniq(tables, 3)
    if tables:
        lines.append(f"{lb['tables']}: {'; '.join(tables)}.")
    texts = []
    for t in _list(ds.get("texts")):
        v = _s(t.get("text") if isinstance(t, dict) else t, 80)
        if v:
            texts.append(v)
    texts = _uniq(texts, 12)
    if texts:
        lines.append(f"{lb['texts']}: {'; '.join(texts)}.")

    out = ""
    for ln in lines:  # строки целиком: обрезаем по строке, не посреди размера
        if len(out) + len(ln) + 1 > MAX_TEXT:
            break
        out = f"{out}\n{ln}" if out else ln
    return out


# --- пакет ---


def read_package(storage: Storage, d: InboxDrawing, sheet: dict[str, Any] | None) -> tuple[dict[str, Any], bytes | None]:
    """data.json (или {} — нет, битый, огромный) и превью листа (WebP или None) из сохранённого пакета."""
    try:
        raw = storage.read(d.storage_key)
    except Exception:  # noqa: BLE001 — файла нет (чистка) — чертёж как удалённый
        raise ApiError(404, "not_found", "Чертёж не найден") from None
    data: dict[str, Any] = {}
    preview = None
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except (zipfile.BadZipFile, ValueError, OSError):
        return data, None
    with zf:
        name = _dict(_dict(d.manifest).get("files")).get("data")
        name = name if isinstance(name, str) and len(name) <= 200 else "data.json"
        try:
            b = inbox._read_member(zf, zf.getinfo(name), MAX_DATA_BYTES)
            parsed = json.loads(b.decode("utf-8-sig"), parse_constant=inbox._reject_constant) if b else None
            if isinstance(parsed, dict) and parsed.get("data_version") == 1:
                data = parsed
        except (KeyError, UnicodeDecodeError, ValueError, RecursionError, *inbox._ZIP_ERRORS):
            data = {}
        path = sheet["preview"] if sheet else inbox.preview_path(d.manifest)
        if path:
            try:
                img = inbox._read_member(zf, zf.getinfo(path), inbox.MAX_PREVIEW_BYTES)
            except (KeyError, *inbox._ZIP_ERRORS):
                img = None
            if img is not None and inbox.is_webp(img):
                preview = img
    return data, preview


def project_title(d: InboxDrawing) -> str:
    """«Кухня_Юнусабад» → «Кухня Юнусабад» (title пакета — имя файла без расширения)."""
    t = " ".join((d.title or d.filename.rsplit(".", 1)[0] or "").replace("_", " ").split())
    return t[:120] or "DWG"


def make_project(db: Session, storage: Storage, current, d: InboxDrawing, wanted: str | None) -> dict[str, Any]:
    """Создать проект цеха по листу чертежа (или обновить черновик без модели, уже созданный по нему).
    → поля InboxProjectOut."""
    sheet, index = pick_sheet(d.manifest, wanted)
    data, preview = read_package(storage, d, sheet)
    lang = current.user.language if current.user.language in ("ru", "uz") else "ru"
    title = project_title(d)
    text = sheet_text(title, sheet, data_sheet(data, sheet, index), d.manifest, lang)

    p = db.get(Project, d.project_id) if d.project_id else None
    reuse = (p is not None and p.deleted_at is None and p.workshop_id == current.workshop.id
             and p.status == ProjectStatus.draft and p.current_version_id is None)
    if reuse:
        # «Взять другой лист»: тот же черновик — старое превью листа убираем
        for ph in list(p.photos):
            if ph.kind == PhotoKind.source:
                if db.scalar(select(ProjectPhoto.id).where(ProjectPhoto.storage_key == ph.storage_key,
                                                           ProjectPhoto.id != ph.id).limit(1)) is None:
                    storage.delete(ph.storage_key)
                db.delete(ph)
        p.source_text = text
    else:
        p = Project(workshop_id=current.workshop.id, author_id=current.user.id, title=title,
                    title_source=titles.USER, source_text=text, is_example=False)
        db.add(p)
        db.flush()
        db.add(ProjectStatusChange(project_id=p.id, from_status=None, to_status=ProjectStatus.draft,
                                   actor_user_id=current.user.id))
    photo = None
    if preview is not None:
        key = f"workshops/{p.workshop_id}/projects/{p.id}/{PhotoKind.source}/{uuid.uuid4().hex}.webp"
        stored = storage.save(key, preview, "image/webp")
        photo = ProjectPhoto(project_id=p.id, kind=PhotoKind.source, storage_key=stored.key, url=stored.url,
                             content_type="image/webp", size_bytes=len(preview), uploaded_by=current.user.id)
        db.add(photo)
    d.project_id = p.id
    db.commit()
    return {
        "project_id": p.id, "created": not reuse, "text": text,
        "sheet": {"id": sheet["id"], "number": sheet["number"], "name": sheet["name"]} if sheet else None,
        "photo_id": photo.id if photo else None, "photo_url": photo.url if photo else None,
    }
