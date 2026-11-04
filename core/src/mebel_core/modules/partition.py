"""Секции и перегородки между ними (в нижней части и на антресоли)."""

from typing import Optional

from ..assembler import BuildContext, BuildError, Box, Slot, at
from ..geometry import Placement
from ..units import mm, to_mm
from . import module
from .body import VERTICAL


def split_widths(ctx: BuildContext, available: int) -> list[int]:
    """Ширины секций в свету: заданные + поровну из остатка."""
    sections = ctx.product.sections
    given = [mm(s.width) if s.width is not None else None for s in sections]
    free = [i for i, w in enumerate(given) if w is None]
    taken = sum(w for w in given if w is not None)
    if free:
        rest = available - taken
        if rest <= 0:
            raise BuildError(
                "sections_too_wide",
                f"Заданные секции ({to_mm(taken)} мм) не оставляют места остальным: "
                f"в свету {to_mm(available)} мм",
                "sections",
            )
        each, remainder = divmod(rest, len(free))
        for i in free:
            given[i] = each
        given[free[-1]] += remainder
    elif taken != available:
        diff = available - taken
        last = given[-1]
        if abs(diff) <= ctx.rules.max_auto_fit and last + diff >= ctx.rules.min_section_width:
            given[-1] = last + diff
            ctx.warn("sections_auto_fit", f"Сумма ширин секций не сходилась на {to_mm(abs(diff)):g} мм — "
                                          f"последняя секция стала {to_mm(given[-1]):g} мм", "sections")
        else:
            raise BuildError(
                "sections_mismatch",
                f"Сумма ширин секций {to_mm(taken)} мм не совпадает с шириной в свету {to_mm(available)} мм",
                "sections",
            )
    return [w for w in given if w is not None]


@module("sections", "0.2.0", "Секции")
def build_sections(ctx: BuildContext, lower: Box, upper: Optional[Box]) -> list[Slot]:
    r, t = ctx.rules, ctx.t
    n = len(ctx.product.sections)
    widths = split_widths(ctx, lower.width - (n - 1) * t)

    left_side, right_side = ctx.part("body.side.left"), ctx.part("body.side.right")
    bottom = ctx.part("body.bottom")
    top = ctx.part("body.top")
    divider = ctx.part("mezzanine.shelf") if upper else None

    slots: list[Slot] = []
    mezz_slots: list[Slot] = []
    x = lower.x0
    prev, prev_upper = left_side, left_side
    for i, w in enumerate(widths):
        if w < r.min_section_width:
            ctx.error(
                "section_too_narrow",
                f"Секция {i + 1}: ширина {to_mm(w)} мм меньше минимума {to_mm(r.min_section_width)} мм",
                f"sections[{i}]",
            )
        last = i == n - 1
        right = right_side
        right_upper = right_side
        if not last:
            right = ctx.run("partition", x=x + w, box=lower, key=f"partition[{i}]",
                            joins=(bottom, divider or top))
            if upper:
                right_upper = ctx.run("partition", x=x + w, box=upper, key=f"mezzanine.partition[{i}]",
                                      joins=(divider, top))
        box = Box(x0=x, x1=x + w, y0=lower.y0, y1=lower.y1, z0=lower.z0, z1=lower.z1)
        slots.append(Slot(index=i, path=f"sections[{i}]", box=box, left=prev, right=right,
                          bottom=bottom, top=divider or top))
        if upper:
            ubox = Box(x0=x, x1=x + w, y0=upper.y0, y1=upper.y1, z0=upper.z0, z1=upper.z1)
            mezz_slots.append(Slot(index=i, path=f"mezzanine.sections[{i}]", box=ubox,
                                   left=prev_upper, right=right_upper, bottom=divider, top=top))
        prev, prev_upper = right, right_upper
        x += w + t
    ctx.mezzanine_slots = mezz_slots
    return slots


@module("partition", "0.2.0", "Перегородка")
def build_partition(ctx: BuildContext, *, x: int, box: Box, key: str, joins: tuple) -> object:
    part = ctx.add_part(
        key=key,
        name="Перегородка антресоли" if key.startswith("mezzanine") else "Перегородка",
        role="partition",
        module=key,
        material_id=ctx.product.body.material,
        length=box.height,
        width=box.depth,
        placement=Placement(origin=at(x, box.y0, box.z0), **VERTICAL),
        edges={"y0": ctx.rules.edge_front},
    )
    for horizontal in joins:
        ctx.join(horizontal, part, key)
    return part
