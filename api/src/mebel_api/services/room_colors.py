"""Цвет стен и пола с фото пустой ниши — для 3D (фасады на фоне комнаты).

ИИ отмечает на фото участок стены и пола (рамки в долях фото), сервер берёт медианный цвет участка.
Тени и блики отбрасываются: медиана только по средней полосе яркости (25–75 %). Не вышло — подсказка ИИ.
Цвет, выбранный мастером вручную (`source: "manual"`), не перезаписывается.
"""

import io
import logging
import re
from typing import Any

log = logging.getLogger(__name__)
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def region_color(data: bytes, box: list[float]) -> str | None:
    """Медианный цвет участка фото по средней полосе яркости; None — участок пустой или фото не читается."""
    if len(box) != 4:
        return None
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        log.info("room colour: photo unreadable")
        return None
    w, h = img.size
    x0, y0, x1, y1 = (max(0.0, min(1.0, float(v))) for v in box)
    left, right = sorted((round(x0 * w), round(x1 * w)))
    top, bottom = sorted((round(y0 * h), round(y1 * h)))
    if right - left < 2 or bottom - top < 2:
        return None
    crop = img.crop((left, top, right, bottom))
    crop.thumbnail((96, 96))
    px = list(crop.get_flattened_data() if hasattr(crop, "get_flattened_data") else crop.getdata())
    px.sort(key=lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2])
    band = px[len(px) // 4: max(len(px) // 4 + 1, len(px) * 3 // 4)]

    def median(i: int) -> int:
        vals = sorted(c[i] for c in band)
        return vals[len(vals) // 2]

    return "#{:02X}{:02X}{:02X}".format(median(0), median(1), median(2))


def with_room_colors(tree: dict, room: Any, photos: list[bytes]) -> dict:
    """Дерево с `room_colors` по фото (или по подсказкам ИИ). Ручной выбор мастера не трогаем."""
    current = tree.get("room_colors") or {}
    if current.get("source") == "manual":
        return tree
    photo = photos[room.photo] if 0 <= room.photo < len(photos) else None
    out: dict[str, str] = {}
    for key, box, hint in (("wall", room.wall_region, room.wall_color_hint),
                           ("floor", room.floor_region, room.floor_color_hint)):
        color = region_color(photo, box) if photo is not None and box else None
        if color is None and isinstance(hint, str) and HEX.match(hint):
            color = hint.upper()
        if color:
            out[key] = color
    if not out:
        return tree
    return {**tree, "room_colors": {**out, "source": "photo"}}
