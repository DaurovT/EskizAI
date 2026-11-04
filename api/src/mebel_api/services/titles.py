"""Осмысленные названия проектов: «Шкаф-купе 2400×650×2400», «Кухня угловая 2350+1760», «Пенал · Азиз».

Правила:
- проект без названия (или с названием по умолчанию «Новый проект 03.11.2026», или с названием, которое
  приложение само вырезало из описания) получает временное название по описанию — `title_source=auto`;
- после каждой новой версии модели (дизайн ИИ, замер, правка) автоназвание пересчитывается по модели;
- название, введённое мастером (`title_source=user`), не трогаем никогда;
- язык — язык автора проекта (ru / uz); размеры — Ш×Г×В в мм, у кухни — длины стен;
- клиент — в название, только если размеров ещё нет («Пенал · Азиз»): в списке клиент виден второй строкой.
"""

import re
from sqlalchemy.orm import Session

from ..models import ModelVersion, Project, User

AUTO, USER = "auto", "user"

# Вид изделия → (ru, uz)
KINDS: dict[str, tuple[str, str]] = {
    "wardrobe": ("Шкаф", "Shkaf"),
    "builtin": ("Шкаф встроенный", "O‘rnatilgan shkaf"),
    "kupe": ("Шкаф-купе", "Kupe shkaf"),
    "penal": ("Пенал", "Penal"),
    "tumba": ("Тумба", "Tumba"),
    "komod": ("Комод", "Komod"),
    "rack": ("Стеллаж", "Stellaj"),
    "hallway": ("Прихожая", "Dahliz shkafi"),
    "kitchen": ("Кухня", "Oshxona"),
    "kitchen_straight": ("Кухня прямая", "To‘g‘ri oshxona"),
    "kitchen_corner": ("Кухня угловая", "Burchakli oshxona"),
}
NEW_PROJECT = ("Новый проект", "Yangi loyiha")

# Подсказки в описании мастера и в ответе ИИ (product_kind); порядок важен — частное раньше общего
HINTS: list[tuple[str, tuple[str, ...]]] = [
    ("kitchen_corner", ("углов", "г-образ", "burchak")),
    ("kitchen", ("кухн", "oshxona")),
    ("hallway", ("прихож", "коридор", "dahliz", "koridor")),
    ("kupe", ("купе", "kupe")),
    ("penal", ("пенал", "penal")),
    ("komod", ("комод", "komod")),
    ("tumba", ("тумб", "tumba")),
    ("rack", ("стеллаж", "этажерк", "stellaj", "javon")),
    ("builtin", ("встро", "o‘rnatil", "o'rnatil")),
    ("wardrobe", ("шкаф", "shkaf", "garderob", "гардероб")),
]

_DEFAULT_RE = re.compile(r"^\s*(новый проект|yangi loyiha)(\s+\d{1,2}[./]\d{1,2}([./]\d{2,4})?)?\s*$", re.I)
_SIZES_RE = re.compile(r"(?<!\d)(\d{3,4})\s*(?:[×xXхХ*]|\s+на\s+)\s*(\d{3,4})(?:\s*(?:[×xXхХ*]|\s+на\s+)\s*(\d{3,4}))?")


def kind_from_text(text: str | None) -> str | None:
    t = (text or "").lower()
    if not t:
        return None
    for kind, words in HINTS:
        if any(w in t for w in words):
            if kind == "kitchen_corner" and not any(w in t for w in ("кухн", "oshxona")):
                continue  # «угловой шкаф» — не кухня
            return kind
    return None


def _has_doors(tree: dict) -> bool:
    """Двери секции или двери зоны (антресоль, нижняя зона за дверью)."""
    return any(s.get("doors") or any(z.get("doors") for z in s.get("fill", [])) for s in tree.get("sections", [])) \
        or bool((tree.get("mezzanine") or {}).get("doors"))


def _drawer_sections(tree: dict) -> int:
    return sum(1 for s in tree.get("sections", []) if any(z.get("kind") == "drawers" for z in s.get("fill", [])))


def kind_from_tree(tree: dict, hint: str | None = None) -> str:
    """Вид по дереву (купе, низкий — тумба/комод, без дверей — стеллаж, узкий высокий — пенал, встроенный);
    подсказка из описания / ответа ИИ различает только то, чего не видно по дереву: прихожая, пенал, тумба↔комод."""
    if tree.get("type") == "kitchen":
        return "kitchen_corner" if tree.get("layout") == "corner" or tree.get("base2") else "kitchen_straight"
    hinted = kind_from_text(hint)
    w, h = float(tree.get("width") or 0), float(tree.get("height") or 0)
    sections = tree.get("sections", [])
    if tree.get("sliding_doors"):
        return "kupe"  # «шкаф-купе в прихожую» — всё равно купе
    if hinted == "hallway":
        return "hallway"
    if h and h <= 1100:
        if hinted in ("komod", "tumba"):
            return hinted
        return "komod" if sections and _drawer_sections(tree) * 2 > len(sections) else "tumba"
    if not _has_doors(tree) and not _drawer_sections(tree):
        return "rack"
    if w and w <= 650 and h >= 1500:
        return "penal"
    if tree.get("builtin"):
        return "builtin"
    if hinted == "penal":  # высокий узкий — пенал, даже если шире 650
        return hinted
    return "wardrobe"


def _mm(v: float) -> str:
    return str(int(round(float(v))))


def sizes_from_model(tree: dict, size: list | None) -> str:
    """Ш×Г×В по габариту модели (viewer size = [Ш, В, Г]); кухня — длины стен «2350+1760»."""
    if not size or len(size) < 3:
        if tree.get("type") == "kitchen" or not tree.get("width"):
            return ""
        size = [tree["width"], tree.get("height") or 0, tree.get("depth") or 0]
    w, h, d = (float(x or 0) for x in size[:3])
    if tree.get("type") == "kitchen":
        site = tree.get("site") or {}
        if site.get("wall_a"):  # замер кухни: стены
            a, b = site["wall_a"], site.get("wall_b")
            return _mm(a) + (f"+{_mm(b)}" if b and (tree.get("layout") == "corner" or tree.get("base2")) else "")
        if tree.get("layout") == "corner" or tree.get("base2"):
            return f"{_mm(w)}+{_mm(d)}"
        return _mm(w)
    return f"{_mm(w)}×{_mm(d)}×{_mm(h)}" if w and h and d else ""


def sizes_from_text(text: str | None) -> str:
    m = _SIZES_RE.search(text or "")
    if not m:
        return ""
    return "×".join(g for g in m.groups() if g)


def _first_name(name: str | None) -> str:
    return (name or "").strip().split(" ")[0][:40] if name else ""


def compose(kind: str | None, sizes: str, client: str | None, lang: str) -> str:
    i = 1 if lang == "uz" else 0
    base = KINDS[kind][i] if kind else NEW_PROJECT[i]
    if sizes:
        return f"{base} {sizes}"[:200]
    first = _first_name(client)
    return f"{base} · {first}"[:200] if first else base


def model_title(tree: dict, size: list | None, *, hint: str | None = None, client: str | None = None,
                lang: str = "ru") -> str:
    return compose(kind_from_tree(tree, hint), sizes_from_model(tree, size), client, lang)


def provisional_title(source_text: str | None, *, client: str | None = None, lang: str = "ru") -> str:
    """До модели: вид и размеры из описания («шкаф-купе 2400 на 2600» → «Шкаф-купе 2400×2600»)."""
    return compose(kind_from_text(source_text), sizes_from_text(source_text), client, lang)


def app_fragment(source_text: str | None) -> str:
    """Название, которое приложение само вырезает из описания: первая фраза до «.», «,» или перевода строки."""
    text = (source_text or "").strip()
    return re.split(r"[.,\n]", text)[0][:60].strip() if text else ""


def is_date_title(title: str | None) -> bool:
    """«Новый проект», «Новый проект 03.11.2026», «Yangi loyiha 03.11.2026» (или пусто)."""
    t = (title or "").strip()
    return not t or bool(_DEFAULT_RE.match(t))


def is_default_title(title: str | None, source_text: str | None = None) -> bool:
    """Название не придумано мастером: пусто, «Новый проект 03.11.2026» или кусок описания от приложения."""
    t = (title or "").strip()
    if not t or _DEFAULT_RE.match(t):
        return True
    frag = app_fragment(source_text)
    return bool(frag) and t == frag


def _lang(db: Session, project: Project) -> str:
    author = db.get(User, project.author_id) if project.author_id else None
    return author.language if author is not None and author.language in ("ru", "uz") else "ru"


def _client_name(project: Project) -> str | None:
    return project.client.name if project.client is not None else None


def _ai_kind(db: Session, project: Project, version: ModelVersion) -> str | None:
    """Что ИИ назвал изделием («ИИ: тумба под ТВ») — по последней версии ИИ, даже если потом были ручные правки."""
    from sqlalchemy import select

    if version.source == "ai":
        return version.label
    return db.scalar(select(ModelVersion.label).where(ModelVersion.project_id == project.id,
                                                      ModelVersion.source == "ai")
                     .order_by(ModelVersion.number.desc()).limit(1))


def is_auto(project: Project) -> bool:
    return project.title_source == AUTO


def refresh(db: Session, project: Project, version: ModelVersion | None = None) -> bool:
    """Пересчитать автоназвание по текущей модели (или по описанию, если модели нет). True — изменилось."""
    if not is_auto(project):
        if not is_date_title(project.title):
            return False
        project.title_source = AUTO  # старый проект с «Новый проект 03.11.2026» — тоже ведём сами
    if version is None and project.current_version_id:
        version = db.get(ModelVersion, project.current_version_id)
    lang = _lang(db, project)
    client = _client_name(project)
    if version is not None and version.ok and isinstance(version.tree, dict):
        size = (version.viewer or {}).get("size") if isinstance(version.viewer, dict) else None
        hint = " ".join(x for x in (project.source_text, _ai_kind(db, project, version)) if x)
        title = model_title(version.tree, size, hint=hint, client=client, lang=lang)
    else:
        title = provisional_title(project.source_text, client=client, lang=lang)
    if title and title != project.title:
        project.title = title
        return True
    return False


def short_date(project: Project) -> str:
    """Дата создания коротко, по Ташкенту: «03.11» (этот год) или «03.11.25»."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("Asia/Tashkent")
    created = project.created_at
    if created is None:
        return ""
    if created.tzinfo is None:
        from datetime import timezone

        created = created.replace(tzinfo=timezone.utc)
    d = created.astimezone(tz)
    now = datetime.now(tz)
    return d.strftime("%d.%m") if d.year == now.year else d.strftime("%d.%m.%y")



def retitle_all(db: Session, *, include_fragments: bool = False) -> list[tuple[str, str, str]]:
    """Бэкфилл: автоназвания и «Новый проект 03.11.2026» → «вид + размеры» по текущей модели.
    include_fragments — ещё и названия, которые приложение вырезало из описания. Коммит — на вызывающем.
    Возвращает [(id, было, стало)] — только изменённые."""
    from sqlalchemy import select

    changed: list[tuple[str, str, str]] = []
    for p in db.scalars(select(Project).where(Project.deleted_at.is_(None)).order_by(Project.created_at)):
        frag = include_fragments and bool(app_fragment(p.source_text)) and p.title.strip() == app_fragment(p.source_text)
        if p.title_source != AUTO and not is_date_title(p.title) and not frag:
            continue
        old = p.title
        p.title_source = AUTO
        if refresh(db, p) or old != p.title:
            changed.append((str(p.id), old, p.title))
    return changed
