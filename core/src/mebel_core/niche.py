"""Встроенный шкаф: щели до стен и потолка, доборы, подгонка корпуса под замер ниши.

Корпус (width × height изделия) целиком стоит в нише. Щель с каждой стороны — от фальш-панели (или боковины)
до стены. По самому узкому месту ниши считается видимая ширина добора, по самому широкому — заготовка
(+ припуск на подрезку по стене). Без замера доборы — номинальной ширины (filler_width).
"""

import copy
from dataclasses import dataclass, field

from .catalog import material
from .parts import PatchOp
from .rules import DEFAULT_RULES, RuleSet
from .units import mm


@dataclass
class Gap:
    side: str  # left / right / top
    filler: bool  # закрыта добором
    min: int  # щель в самом узком месте ниши, dmm
    max: int  # в самом широком
    blank: int  # ширина заготовки добора (max + припуск); 0 — без добора
    profile: list[tuple[float, int]] = field(default_factory=list)  # (доля высоты/ширины, щель) по точкам замера
    wedge: bool = False  # добор клином: кромка к стене — по профилю

    @property
    def lean(self) -> int:
        return self.max - self.min


@dataclass
class NicheLayout:
    left: Gap
    right: Gap
    top: Gap
    panel_left: int  # толщина фальш-панели слева (0 — нет)
    panel_right: int
    widths: list[float]  # замер ширины, мм
    heights: list[float]


def fronts_material_id(product) -> str:
    return product.fronts.material or product.body.material


def panel_thickness(product, side: str) -> int:
    for sp in getattr(product, "side_panels", []):
        if sp.side == side:
            return material(sp.material or fronts_material_id(product)).thickness
    return 0


def _split(total: int, both: bool) -> tuple[int, int]:
    left = total // 2 if both else total
    return left, total - left


def niche_layout(product, rules: RuleSet = DEFAULT_RULES) -> NicheLayout:
    b = product.builtin
    W, H = mm(product.width), mm(product.height)
    pl, pr = panel_thickness(product, "left"), panel_thickness(product, "right")
    fl, fr, ft = ("left" in b.fillers), ("right" in b.fillers), ("top" in b.fillers)
    al, atop = mm(b.allowance_side), mm(b.allowance_top)
    fw, ftw, scribe = mm(b.filler_width), mm(b.top_filler_width), mm(b.scribe)
    widths, heights = b.niche.widths(), b.niche.heights()

    n = b.niche
    lprof: list[tuple[float, int]] = []
    rprof: list[tuple[float, int]] = []
    if widths:
        g_min = mm(min(widths)) - W - pl - pr

        def split(g: int) -> tuple[int, int]:
            """Щель в точке замера → (слева, справа)."""
            if fl and fr or not (fl or fr):
                if n.lean == "left":  # правая стена ровная: справа щель как в узком месте
                    r = g_min - g_min // 2
                    return g - r, r
                if n.lean == "right":
                    left = g_min // 2
                    return left, g - left
                return _split(g, True)
            if fl:  # добор только слева: справа монтажный зазор, весь перекос — в добор
                return g - al, al
            return al, g - al

        pts = [(z, mm(v) - W - pl - pr) for z, v in ((0.0, n.width_bottom), (0.5, n.width_middle),
                                                    (1.0, n.width_top)) if v is not None]
        for z, g in pts:
            lg, rg = split(g)
            lprof.append((z, lg))
            rprof.append((z, rg))
        both = [split(mm(v) - W - pl - pr) for v in widths]
        l_min, l_max = min(x for x, _ in both), max(x for x, _ in both)
        r_min, r_max = min(x for _, x in both), max(x for _, x in both)
    else:
        l_min = l_max = fw if fl else al
        r_min = r_max = fw if fr else al
    tprof: list[tuple[float, int]] = []
    if heights:
        t_min, t_max = mm(min(heights)) - H, mm(max(heights)) - H
        tprof = [(x, mm(v) - H) for x, v in ((0.0, n.height_left), (1.0, n.height_right)) if v is not None]
    else:
        t_min = t_max = ftw if ft else atop

    def gap(side: str, has: bool, lo: int, hi: int, prof: list) -> Gap:
        wedge = has and side in b.wedge and len(prof) > 1 and hi > lo
        return Gap(side=side, filler=has, min=lo, max=hi, blank=hi + scribe if has else 0, profile=prof,
                   wedge=wedge)

    return NicheLayout(left=gap("left", fl, l_min, l_max, lprof), right=gap("right", fr, r_min, r_max, rprof),
                       top=gap("top", ft, t_min, t_max, tprof), panel_left=pl, panel_right=pr,
                       widths=widths, heights=heights)


def fitted_size(product) -> tuple[float | None, float | None]:
    """Размер корпуса (мм) под замер ниши: самое узкое место минус доборы (или монтажные зазоры)
    и фальш-панели. None — размер не мерили."""
    b = product.builtin
    widths, heights = b.niche.widths(), b.niche.heights()
    w = h = None
    if widths:
        panels = (panel_thickness(product, "left") + panel_thickness(product, "right")) / 10
        sides = sum(b.filler_width if s in b.fillers else b.allowance_side for s in ("left", "right"))
        w = round(min(widths) - panels - sides, 1)
    if heights:
        h = round(min(heights) - (b.top_filler_width if "top" in b.fillers else b.allowance_top), 1)
    return w, h


def fit_patch(product, width: float | None = None, height: float | None = None) -> list[PatchOp]:
    """Патч «подогнать корпус»: ширина/высота и последняя секция (зона) — по остатку."""
    if width is None and height is None:
        width, height = fitted_size(product)
    ops: list[PatchOp] = []
    if width is not None and abs(width - product.width) >= 0.05:
        ops.append(PatchOp(op="replace", path="/width", value=width))
        if product.sections and all(s.width is not None for s in product.sections):
            ops.append(PatchOp(op="replace", path=f"/sections/{len(product.sections) - 1}/width", value=None))
    if height is not None and abs(height - product.height) >= 0.05:
        ops.append(PatchOp(op="replace", path="/height", value=height))
        for i, s in enumerate(product.sections):
            if s.fill and all(z.height is not None for z in s.fill):
                ops.append(PatchOp(op="replace", path=f"/sections/{i}/fill/{len(s.fill) - 1}/height", value=None))
    return ops


def fit_to_niche(tree: dict, niche: dict | None = None) -> dict:
    """Замер ниши → дерево шкафа: шкаф становится встроенным, корпус — по самому узкому месту ниши
    минус доборы; последняя секция и верхние зоны забирают разницу. Глубина — не больше ниши."""
    from .assembler import parse_tree
    from .fixes import apply_patch

    t = copy.deepcopy(tree)
    b = t.get("builtin") or {}
    if niche:
        b["niche"] = {**(b.get("niche") or {}), **{k: v for k, v in niche.items() if v is not None}}
    t["builtin"] = b
    t["installation"] = "niche"
    product = parse_tree(t)
    nd = product.builtin.niche.depth
    if nd is not None and product.depth > nd:
        t["depth"] = nd
    return apply_patch(t, fit_patch(product))
