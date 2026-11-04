"""Вид спереди в SVG — для быстрой визуальной проверки сборки.

Это не чертёж для мастера (чертежи — неделя 7), а отладочная картинка:
каждая деталь — прямоугольник своего габарита в плоскости X–Z.
"""

from .assembler import BuildResult
from .units import to_mm

COLORS = {
    "side": "#c9a27a",
    "top": "#b8895c",
    "bottom": "#b8895c",
    "partition": "#d4b08c",
    "shelf": "#e3c7a6",
    "plinth": "#8c6a4a",
    "back": "#f2ebe1",
    "divider": "#d4b08c",
    "door": "#c9a57b",
    "drawer_front": "#b98f62",
    "drawer_side": "#e8d5bd",
    "drawer_wall": "#e8d5bd",
    "drawer_bottom": "#f2ebe1",
    "rod": "#9aa0a6",
}
FRONT_ROLES = {"door", "drawer_front"}


def front_view_svg(result: BuildResult, scale: float = 0.25, margin: int = 40, fronts: bool = True) -> str:
    W, H, _ = (to_mm(v) for v in result.size)
    sw, sh = W * scale + 2 * margin, H * scale + 2 * margin

    def X(v: float) -> float:
        return margin + v * scale

    def Z(v: float) -> float:  # SVG растёт вниз, высота изделия — вверх
        return margin + (H - v) * scale

    # Сначала дальние детали, потом ближние
    parts = [p for p in result.parts if fronts or p.role not in FRONT_ROLES]
    items = sorted(parts, key=lambda p: -p.aabb().min.y)
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{sw:.0f}" height="{sh:.0f}" '
        f'viewBox="0 0 {sw:.0f} {sh:.0f}" font-family="sans-serif">',
        f'<rect width="100%" height="100%" fill="white"/>',
    ]
    for p in items:
        b = p.aabb()
        x0, x1 = to_mm(b.min.x), to_mm(b.max.x)
        z0, z1 = to_mm(b.min.z), to_mm(b.max.z)
        color = COLORS.get(p.role, "#ddd")
        out.append(
            f'<rect x="{X(x0):.1f}" y="{Z(z1):.1f}" width="{(x1 - x0) * scale:.1f}" '
            f'height="{(z1 - z0) * scale:.1f}" fill="{color}" stroke="#5a4632" stroke-width="0.6">'
            f"<title>{p.number}. {p.name} {to_mm(p.length):g}×{to_mm(p.width):g}</title></rect>"
        )
        if p.role != "back":
            cx, cz = X((x0 + x1) / 2), Z((z0 + z1) / 2)
            out.append(
                f'<text x="{cx:.1f}" y="{cz + 3:.1f}" font-size="9" text-anchor="middle" fill="#3a2a1a">{p.number}</text>'
            )
    out.append(
        f'<text x="{margin}" y="{margin - 14}" font-size="12" fill="#333">'
        f"Вид спереди · {W:g}×{H:g} мм · деталей: {len(result.parts)}</text>"
    )
    out.append("</svg>")
    return "\n".join(out)
