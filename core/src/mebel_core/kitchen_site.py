"""Кухня по замеру помещения (SCR-13b): стены A/B, потолок, окно, вода, канализация, газ, розетки, вентканал.

Расстояния — в мм от угла вдоль стены (у прямой кухни — от левого края стены A).
Стена A — под первым рядом (base/wall), стена B — под вторым (base2/wall2).

- check_site — проверки при каждой сборке (предупреждения в замечаниях модели);
- fit_kitchen — применить замер: подогнать ряды под стены, поставить мойку к воде и варку к газу
  (переставляя модули в ряду, при угловой кухне — и между стенами), убрать верхние модули с окна,
  верхние «до потолка» — по потолку.
"""

import copy
from dataclasses import dataclass
from itertools import product as _pairs

from .catalog import material
from .rules import DEFAULT_RULES, RuleSet
from .schema import Kitchen, KitchenSite
from .units import to_mm

INF = float("inf")
WALL_NAMES = {"a": "А", "b": "Б"}
ADJUSTABLE = ("doors", "drawers")  # модули, ширину которых можно менять
WALL_ADJUSTABLE = ("doors", "open")
MIN_WIDTH = 150.0


@dataclass
class Span:
    row: str  # base, wall, base2, wall2
    index: int
    wall: str  # a / b
    a: float  # от угла, мм
    b: float
    cab: dict

    @property
    def center(self) -> float:
        return (self.a + self.b) / 2


def _r(rules: RuleSet, name: str) -> float:
    return to_mm(getattr(rules, name))


def _square_corner(k: dict) -> dict | None:
    if k.get("layout") != "corner":
        return None
    return next((c for c in k.get("base", []) if c.get("kind") == "corner" and c.get("corner_shape") == "square"),
                None)


def row_offset(k: dict) -> float:
    """С какого расстояния от угла по стене B начинается второй ряд нижних."""
    sq = _square_corner(k)
    return float(sq["width"]) if sq else float(k.get("countertop", {}).get("depth", 600))


def _upper_offset(k: dict) -> float:
    """Верхние второго ряда начинаются от угла или перед фасадами верхних первого ряда (как в сборке)."""
    wall, base = k.get("wall", []), k.get("base", [])
    left = k.get("corner_side") == "left"
    wd = float(k.get("wall_depth", 300))
    reaches = bool(wall) and (left or sum(c["width"] for c in wall) > sum(c["width"] for c in base) - wd)
    return wd + 20 if reaches else 0.0


def spans(k: dict) -> list[Span]:
    """Положение всех модулей от угла."""
    corner = k.get("layout") == "corner"
    right = corner and k.get("corner_side", "right") == "right"
    out: list[Span] = []
    base = k.get("base", [])
    la = sum(c["width"] for c in base)
    x = 0.0
    for i, c in enumerate(base):
        w = c["width"]
        a = la - x - w if right else x
        out.append(Span("base", i, "a", a, a + w, c))
        x += w
    x = 0.0
    for j, c in enumerate(k.get("wall", [])):
        w = c["width"]
        a = la - x - w if right else x
        out.append(Span("wall", j, "a", a, a + w, c))
        x += w
    if corner:
        for row, start in (("base2", row_offset(k)), ("wall2", _upper_offset(k))):
            x = start
            for i, c in enumerate(k.get(row, [])):
                out.append(Span(row, i, "b", x, x + c["width"], c))
                x += c["width"]
    return out


def dist(wall: str, pos: float, s: Span, corner: bool) -> float:
    """Расстояние от вывода до модуля вдоль стен (у угловой кухни — через угол)."""
    if wall == s.wall:
        return 0.0 if s.a <= pos <= s.b else min(abs(pos - s.a), abs(pos - s.b))
    return pos + s.a if corner else INF


def find_hob(k: dict, sp: list[Span]) -> Span | None:
    """Варка: модуль с hob=true, иначе нижний модуль под вытяжкой (hood)."""
    base = [s for s in sp if s.row.startswith("base")]
    marked = next((s for s in base if s.cab.get("hob")), None)
    if marked:
        return marked
    for h in (s for s in sp if s.row.startswith("wall") and s.cab.get("kind") == "hood"):
        under = [s for s in base if s.wall == h.wall and s.a <= h.center <= s.b and s.cab.get("kind") != "corner"]
        if under:
            return under[0]
    return None


def _window_span(site: KitchenSite) -> tuple[str, float, float] | None:
    w = site.window
    return (w.wall, w.from_corner, w.from_corner + w.width) if w else None


def _wall_len(site: KitchenSite, wall: str) -> float | None:
    return site.wall_a if wall == "a" else site.wall_b


# --- Проверки при сборке ---


def check_site(k: Kitchen, rules: RuleSet = DEFAULT_RULES) -> list[tuple[str, str]]:
    """Замечания (код, текст) по замеру помещения; пусто, если замера нет."""
    site = k.site
    if site is None:
        return []
    d = k.model_dump()
    corner = d["layout"] == "corner"
    sp = spans(d)
    out: list[tuple[str, str]] = []

    def warn(code: str, msg: str) -> None:
        out.append((f"site_{code}", msg))

    # Длины рядов и стен
    base_a = sum(c["width"] for c in d["base"]) + _panels(d, 1)  # фальш-панели тоже у стены
    rows = [("a", "Нижние модули", base_a, site.wall_a)]
    if corner and site.wall_b:
        rows.append(("b", "Ряд у стены Б (с углом)",
                     row_offset(d) + sum(c["width"] for c in d["base2"]) + _panels(d, 2), site.wall_b))
    for wall, what, length, target in rows:
        diff = round(target - length, 1)
        if diff < -2:
            warn(f"wall_{wall}", f"{what} {length:g} мм длиннее стены {WALL_NAMES[wall]} ({target:g} мм) на "
                                 f"{-diff:g} мм — не встанут")
        elif diff > 2:
            tail = "закройте зазор фальш-планкой" if diff <= 50 else "добавьте модуль или расширьте соседние"
            warn(f"wall_{wall}", f"{what} {length:g} мм короче стены {WALL_NAMES[wall]} ({target:g} мм) на "
                                 f"{diff:g} мм — {tail}")
    for s in sp:
        if s.row.startswith("wall") and s.cab["kind"] != "gap":
            length = _wall_len(site, s.wall)
            if length and s.b > length + 2:
                warn("wall_overflow", f"Верхний модуль {s.cab['width']:g} мм выходит за стену "
                                      f"{WALL_NAMES[s.wall]} ({length:g} мм)")
                break

    utils = site.utilities
    sinks = [s for s in sp if s.row.startswith("base") and s.cab["kind"] == "sink"]
    hob = find_hob(d, sp)
    reach = _r(rules, "outlet_reach")
    # Мойка — у воды и канализации
    for kind, what in (("water", "вывода воды"), ("sewer", "канализации")):
        outlets = [u for u in utils if u.kind == kind]
        if not outlets or not sinks:
            continue
        best = min(dist(u.wall, u.from_corner, s, corner) for u in outlets for s in sinks)
        if best == INF:
            warn(f"sink_{kind}", f"Мойка не на той стене, где вывод {'воды' if kind == 'water' else 'канализации'}")
        elif best > reach:
            tail = "нужна длинная подводка" if kind == "water" else "слив с уклоном может не получиться"
            warn(f"sink_{kind}", f"Мойка в {best:g} мм от {what} — {tail}")
    # Варка — у газа
    gas = [u for u in utils if u.kind == "gas"]
    ct_h = _r(rules, "countertop_height_guess")
    if gas and hob is None:
        warn("hob_unknown", "Есть вывод газа, но варка не отмечена — укажите модуль под варочной панелью")
    if gas and hob is not None:
        hose = min(dist(u.wall, u.from_corner, hob, corner) + (abs(u.height - ct_h) if u.height is not None else 0)
                   for u in gas)
        if hose > _r(rules, "gas_hose_max"):
            text = "на другой стене" if hose == INF else f"шланг ≈ {hose:g} мм"
            warn("gas_far", f"Газ далеко от варки: {text}, а гибкая подводка — до "
                            f"{_r(rules, 'gas_hose_max'):g} мм. Нужен перенос трубы газовщиком")
    if hob is not None:
        for s in sinks:
            if s.wall == hob.wall:
                gap = max(s.a - hob.b, hob.a - s.b)
                if gap < _r(rules, "hob_sink_min_gap"):
                    warn("hob_sink", f"Между мойкой и варкой {max(gap, 0):g} мм столешницы — нужно от "
                                     f"{_r(rules, 'hob_sink_min_gap'):g} мм: брызги на конфорки, негде резать")
        length = _wall_len(site, hob.wall)
        if d["installation"] == "niche" and length:
            ends = [length - hob.b] + ([hob.a] if not corner else [])
            near = min(ends)
            if near < _r(rules, "hob_wall_min_gap"):
                warn("hob_wall", f"Варка в {max(near, 0):g} мм от стены — нужно от "
                                 f"{_r(rules, 'hob_wall_min_gap'):g} мм, иначе стена греется и пачкается")
    # Окно
    win = _window_span(site)
    wall_top = d["wall_bottom"] + d["wall_height"]
    if win:
        ww, wa, wb = win
        if hob is not None and hob.wall == ww and hob.a < wb and wa < hob.b:
            warn("hob_window", "Варка под окном — сквозняк задувает огонь, штора может загореться")
        ct_top = d["legs_height"] + d["base_height"] + to_mm(material(k.countertop.material).thickness)
        if site.window.sill < ct_top:
            warn("sill_low", f"Подоконник {site.window.sill:g} мм ниже столешницы ({ct_top:g} мм) — "
                             "столешница упрётся в окно")
        if site.window.sill < wall_top:
            over = [s for s in sp if s.row.startswith("wall") and s.wall == ww and s.cab["kind"] != "gap"
                    and s.a < wb and wa < s.b]
            if over:
                warn("wall_window", f"Верхние модули перекрывают окно ({len(over)} шт.) — уберите их над окном")
    # Розетки над мойкой и варкой
    for u in (u for u in utils if u.kind == "socket"):
        if u.height is not None and u.height < ct_h:
            continue
        for s, name in [(x, "мойкой") for x in sinks] + ([(hob, "варкой")] if hob else []):
            if s.wall == u.wall and s.a - 100 <= u.from_corner <= s.b + 100:
                warn("socket", f"Розетка ({u.from_corner:g} мм от угла) над {name} — перенесите её в сторону")
                break
    # Вытяжка и вентканал
    vents = [u for u in utils if u.kind == "vent"]
    hoods = [s for s in sp if s.row.startswith("wall") and s.cab["kind"] == "hood"]
    if vents and hoods:
        far = min(dist(u.wall, u.from_corner, h, corner) for u in vents for h in hoods)
        if far > _r(rules, "hood_vent_max"):
            text = "на другой стене" if far == INF else f"в {far:g} мм"
            warn("hood_vent", f"Вентканал {text} от вытяжки — длинный воздуховод плохо тянет")
    # Потолок
    if site.ceiling and d["wall"] and wall_top > site.ceiling:
        warn("ceiling", f"Верх верхних модулей {wall_top:g} мм выше потолка {site.ceiling:g} мм")
    return out


# --- Применение замера ---


MAX_FILLER = 50.0  # столько мм у стены можно оставить под фальш-планку


def _fit_row(row: list[dict], target: float, what: str, kinds=ADJUSTABLE, notes: list[str] | None = None) -> None:
    """Подгоняет сумму ширин ряда под target: разницу забирают регулируемые модули с конца ряда.
    Если ряд короче стены не больше чем на MAX_FILLER, а подгонять нечего — остаётся зазор под фальш-планку."""
    diff = target - sum(c["width"] for c in row)
    for cab in reversed(row):
        if abs(diff) < 0.05:
            break
        if cab.get("kind") not in kinds or cab.get("hob"):
            continue
        new = min(1200.0, max(MIN_WIDTH, cab["width"] + diff))
        diff -= new - cab["width"]
        cab["width"] = round(new, 1)
    if 0.05 <= diff <= MAX_FILLER and notes is not None:
        notes.append(f"{what}: останется зазор {diff:g} мм — закройте фальш-планкой")
    elif abs(diff) >= 0.05:
        raise ValueError(f"{what}: модули не подогнать под замер {target:g} мм — измените состав вручную")


def _swap_to(t: dict, cab: dict, src: str, dst: str, kinds=ADJUSTABLE) -> dict | None:
    """Меняет модуль cab из ряда src местами с похожим по ширине регулируемым модулем ряда dst."""
    cands = [c for c in t[dst] if c.get("kind") in kinds and not c.get("hob")]
    if not cands:
        return None
    other = min(cands, key=lambda c: abs(c["width"] - cab["width"]))
    i, j = t[src].index(cab), t[dst].index(other)
    t[src][i], t[dst][j] = other, cab
    return other


def _row_for(wall: str, upper: bool = False) -> str:
    return ("wall" if upper else "base") + ("" if wall == "a" else "2")


def _arrange(t: dict, site: KitchenSite, rules: RuleSet, notes: list[str]) -> None:
    """Переставляет мойку и варку внутри рядов к выводам (перебором мест вставки)."""
    corner = t.get("layout") == "corner"
    water = [u for u in site.utilities if u.kind == "water"]
    sewer = [u for u in site.utilities if u.kind == "sewer"]
    gas = [u for u in site.utilities if u.kind == "gas"]
    win = _window_span(site)
    gap_min = _r(rules, "hob_sink_min_gap")
    wall_gap = _r(rules, "hob_wall_min_gap")
    for wall in ("a", "b") if corner else ("a",):
        row = t.get(_row_for(wall), [])
        sink = next((c for c in row if c.get("kind") == "sink"), None) if water or sewer else None
        hob = next((c for c in row if c.get("hob")), None) if gas else None
        if sink is None and hob is None:
            continue
        fixed_corner = next((c for c in row if c.get("kind") == "corner"), None)
        rest = [c for c in row if c is not sink and c is not hob and c is not fixed_corner]
        before = {id(s.cab): s for s in spans(t) if s.wall == wall and s.row == _row_for(wall)}
        length = _wall_len(site, wall) or sum(c["width"] for c in row)

        def candidate(i_s: int, i_h: int) -> list[dict]:
            seq = list(rest)
            items = sorted([(i_s, 0, sink), (i_h, 1, hob)], key=lambda x: (x[0], x[1]))
            shift = 0
            for idx, _, cab in items:
                if cab is not None:
                    seq.insert(idx + shift, cab)
                    shift += 1
            if fixed_corner is not None:
                if t.get("corner_side", "right") == "right":
                    seq.append(fixed_corner)
                else:
                    seq.insert(0, fixed_corner)
            return seq

        def cost(seq: list[dict]) -> float:
            trial = dict(t)
            trial[_row_for(wall)] = seq
            sp = {id(s.cab): s for s in spans(trial) if s.row == _row_for(wall)}
            total = 0.0
            if sink is not None:
                s = sp[id(sink)]
                dw = min((dist(u.wall, u.from_corner, s, corner) for u in water), default=0)
                ds = min((dist(u.wall, u.from_corner, s, corner) for u in sewer), default=0)
                total += dw + 0.5 * ds
                if win and win[0] == wall:  # мойку — к окну, если вода позволяет
                    total += 0.2 * abs(s.center - (win[1] + win[2]) / 2)
                total += 0.01 * abs(s.center - before[id(sink)].center)
            if hob is not None:
                h = sp[id(hob)]
                total += min(dist(u.wall, u.from_corner, h, corner) for u in gas)
                if win and win[0] == wall and h.a < win[2] and win[1] < h.b:
                    total += 2000
                if sink is not None:
                    s = sp[id(sink)]
                    if max(s.a - h.b, h.a - s.b) < gap_min:
                        total += 1000
                ends = [length - h.b] + ([h.a] if not corner else [])
                if t.get("installation", "niche") == "niche" and min(ends) < wall_gap:
                    total += 500
                total += 0.01 * abs(h.center - before[id(hob)].center)
            return total

        n = len(rest)
        best = min((candidate(i, j) for i, j in _pairs(range(n + 1), range(n + 1))), key=cost)
        if [id(c) for c in best] == [id(c) for c in row]:
            continue
        t[_row_for(wall)] = best
        sp = {id(s.cab): s for s in spans(t) if s.row == _row_for(wall)}
        for cab, name, outlets, what in ((sink, "мойку", water or sewer, "вывода воды" if water else "канализации"),
                                         (hob, "варку", gas, "газа")):
            if cab is not None and abs(sp[id(cab)].center - before[id(cab)].center) > 1:
                s = sp[id(cab)]
                d = min(dist(u.wall, u.from_corner, s, corner) for u in outlets)
                where = f"над выводом {what[7:] if what.startswith('вывода') else what}" if d == 0 else \
                    f"в {d:g} мм от {what}"
                notes.append(f"Переставил {name} {where}: стена {WALL_NAMES[wall]}, {s.a:g}–{s.b:g} мм от угла")


def _layout_uppers(t: dict, site: KitchenSite, wall: str, rules: RuleSet, notes: list[str]) -> None:
    """Верхние модули стены заново: вытяжка — над варкой, над окном — пусто (kind=gap)."""
    row_name = _row_for(wall, upper=True)
    uppers = [c for c in t.get(row_name, []) if c.get("kind") != "gap"]
    if not uppers:
        return
    corner = t.get("layout") == "corner"
    right = corner and t.get("corner_side", "right") == "right"
    la = sum(c["width"] for c in t.get("base", []))
    if wall == "a":
        avail = la - (t.get("wall_depth", 300) if right and t.get("wall2") else 0)
        to_x = (lambda p: la - p) if right else (lambda p: p)
    else:
        off = _upper_offset(t)
        avail = (site.wall_b or (row_offset(t) + sum(c["width"] for c in t.get("base2", [])))) - off
        to_x = lambda p: p - off  # noqa: E731

    forbidden: list[tuple[float, float]] = []
    win = _window_span(site)
    wall_top = t.get("wall_bottom", 1400) + t.get("wall_height", 720)
    if win and win[0] == wall and site.window.sill < wall_top:
        a, b = sorted((to_x(win[1]), to_x(win[2])))
        a, b = max(0.0, a), min(avail, b)
        if b > a:
            forbidden.append((a, b))
    # Вытяжка — над варкой
    placed: list[tuple[float, float, dict]] = []
    hood = next((c for c in uppers if c.get("kind") == "hood"), None)
    hob = find_hob(t, spans(t))
    if hood is not None and hob is not None and hob.wall == wall:
        hx = to_x(hob.center) - hood["width"] / 2
        hx = min(max(0.0, hx), avail - hood["width"])
        if hx >= 0 and not any(a < hx + hood["width"] and hx < b for a, b in forbidden):
            placed.append((hx, hx + hood["width"], hood))
    blocked = sorted(forbidden + [(a, b) for a, b, _ in placed])
    segments, cur = [], 0.0
    for a, b in blocked:
        if a > cur:
            segments.append([cur, a])
        cur = max(cur, b)
    if avail > cur:
        segments.append([cur, avail])

    dropped = []
    seg = 0
    for cab in uppers:
        if any(cab is p[2] for p in placed):
            continue
        w = cab["width"]
        while seg < len(segments):
            s, e = segments[seg]
            room = e - s
            if w <= room + 0.05:
                placed.append((s, s + w, cab))
                segments[seg][0] = s + w
                break
            if cab.get("kind") in WALL_ADJUSTABLE and room >= MIN_WIDTH and w - room <= 200:
                cab["width"] = round(room, 1)
                placed.append((s, e, cab))
                segments[seg][0] = e
                break
            seg += 1
        else:
            dropped.append(cab)
    placed.sort(key=lambda p: p[0])

    # Собираем ряд: промежутки ≥ 150 мм — пустые места (gap), меньше — забирает соседний модуль
    out: list[dict] = []
    cursor = 0.0
    for i, (a, b, cab) in enumerate(placed):
        gap = round(a - cursor, 1)
        if gap >= MIN_WIDTH:
            out.append({"kind": "gap", "width": gap})
        elif gap > 0.05:
            if out and out[-1]["kind"] != "gap" and out[-1]["width"] + gap <= 1200:
                out[-1]["width"] = round(out[-1]["width"] + gap, 1)
            else:
                cab["width"] = round(cab["width"] + gap, 1)
        out.append(cab)
        cursor = b
    t[row_name] = out
    if forbidden:
        a, b = forbidden[0]
        notes.append(f"Над окном верхние не вешаю: стена {WALL_NAMES[wall]}, проём {b - a:g} мм")
    for cab in dropped:
        notes.append(f"Верхний модуль {cab['width']:g} мм не поместился у стены {WALL_NAMES[wall]} — убрал")


def _panels(t: dict, run: int) -> float:
    """Толщина нижних фальш-панелей ряда, мм: они тоже стоят у стены."""
    from .catalog import material

    total = 0.0
    for sp in t.get("side_panels", []):
        if sp.get("run", 1) == run and sp.get("row", "base") != "wall":
            mat = sp.get("material") or (t.get("fronts") or {}).get("material") or \
                (t.get("body") or {}).get("material", "ldsp_16_white")
            total += material(mat).thickness / 10
    return total


def _fit_rows(t: dict, site: KitchenSite, corner: bool, notes: list[str]) -> None:
    """Ряды под длины стен: нижние — точно (или с зазором под фальш-планку), верхние — если длиннее стены."""
    before = {(r, i): c["width"] for r in ("base", "base2") for i, c in enumerate(t.get(r, []))}
    _fit_row(t.get("base", []), site.wall_a - _panels(t, 1), "Нижние модули у стены А", notes=notes)
    if corner and site.wall_b:
        _fit_row(t.get("base2", []), site.wall_b - row_offset(t) - _panels(t, 2), "Нижние модули у стены Б",
                 notes=notes)
    for (r, i), w in before.items():
        new = t[r][i]["width"]
        if 0.05 <= abs(new - w) <= 50:
            notes.append(f"Модуль {w:g} мм у стены {WALL_NAMES['a' if r == 'base' else 'b']} сделал {new:g} мм "
                         "под замер")
    walls = (("wall", site.wall_a), ("wall2", site.wall_b)) if corner else (("wall", site.wall_a),)
    for r, length in walls:
        row = [c for c in t.get(r, []) if c.get("kind") != "gap"]
        if length and row and sum(c["width"] for c in t[r]) > length:
            _fit_row(t[r], length, "Верхние модули", WALL_ADJUSTABLE)


def fit_kitchen(tree: dict, site: KitchenSite | dict, rules: RuleSet = DEFAULT_RULES) -> tuple[dict, list[str]]:
    """Замер помещения → дерево кухни. Возвращает новое дерево и что сделано (для мастера).
    ValueError — если ряды не подогнать под стены."""
    site = site if isinstance(site, KitchenSite) else KitchenSite.model_validate(site)
    t = copy.deepcopy(tree)
    t["site"] = site.model_dump(mode="json", exclude_none=True)
    notes: list[str] = []
    corner = t.get("layout") == "corner"

    # Потолок
    if site.ceiling:
        bottom = t.get("wall_bottom", 1400)
        limit = site.ceiling - _r(rules, "wall_ceiling_gap") - bottom
        height = t.get("wall_height", 720)
        if t.get("wall_to_ceiling") or height > limit:
            new = max(300.0, min(1400.0, round(limit, 1)))
            if new != height:
                t["wall_height"] = new
                notes.append(f"Верхние модули — высотой {new:g} мм (потолок {site.ceiling:g} мм)")

    # Варка не отмечена — берём модуль под вытяжкой
    if not any(c.get("hob") for row in ("base", "base2") for c in t.get(row, [])):
        hob = find_hob(t, spans(t))
        if hob is not None:
            t[hob.row][hob.index]["hob"] = True

    hobs_before = [(s.wall, s.center) for s in spans(t) if s.cab.get("hob")]
    # Угловая кухня: мойка и варка — на стену с выводами (если после переноса ряды сходятся со стенами)
    if corner:
        for kind, key, name in (("water", "sink", "Мойку"), ("gas", "hob", "Варку")):
            u = next((u for u in site.utilities if u.kind == kind), None)
            if u is None:
                continue
            cab, src = next(((c, r) for r in ("base", "base2") for c in t.get(r, [])
                             if (c.get("kind") == "sink" if key == "sink" else c.get("hob"))), (None, None))
            dst = _row_for(u.wall)
            if cab is None or src == dst:
                continue
            trial = copy.deepcopy(t)
            moved = trial[src][next(i for i, c in enumerate(t[src]) if c is cab)]
            if _swap_to(trial, moved, src, dst) is None:
                continue
            if key == "hob":  # вытяжка — следом за варкой
                up_src, up_dst = _row_for("b" if u.wall == "a" else "a", True), _row_for(u.wall, True)
                hood = next((c for c in trial.get(up_src, []) if c.get("kind") == "hood"), None)
                if hood is not None:
                    _swap_to(trial, hood, up_src, up_dst, WALL_ADJUSTABLE)
            try:
                _fit_rows(copy.deepcopy(trial), site, corner, [])
            except ValueError:
                notes.append(f"{name} на стену {WALL_NAMES[u.wall]} не перенести — ряды не сходятся по длине. "
                             "Переставьте модули вручную")
                continue
            t = trial
            notes.append(f"{name} перенёс на стену {WALL_NAMES[u.wall]} — к выводу")
    else:
        if any(u.wall == "b" for u in site.utilities) or (site.window and site.window.wall == "b"):
            notes.append("У прямой кухни учитываю только стену А — выводы на стене Б пропущены")

    _fit_rows(t, site, corner, notes)

    _arrange(t, site, rules, notes)
    hobs_after = [(s.wall, s.center) for s in spans(t) if s.cab.get("hob")]
    for wall in ("a", "b") if corner else ("a",):
        win = site.window and site.window.wall == wall
        moved = hobs_before != hobs_after and any(w == wall for w, _ in hobs_after)
        if win or moved:
            _layout_uppers(t, site, wall, rules, notes)
    return t, notes
