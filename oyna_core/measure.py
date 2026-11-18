"""Мастер замера (FR-M4…M6): размер рамы по 3 замерам проёма, перекос, опечатки ввода.

Работает и на телефоне без сети — модуль без зависимостей; клиент может повторить ту же логику.
"""
from __future__ import annotations

from .data import Catalog, Company


def check_value(v, cat: Catalog | None = None) -> list[dict]:
    """Одно число в мм, как его ввели. Подсказки — до перехода к следующему полю (FR-M6)."""
    cat = cat or Catalog()
    r12, r17 = cat.rules["1.2"]["params"], cat.rules["1.7"]["params"]
    out = []
    if not isinstance(v, (int, float)) or v <= 0 or int(v) != v:
        return [{"code": "1.1", "severity": "block", "msg": "целое положительное число в мм"}]
    if v > r12["max"]:
        guess = v // 10 if v // 10 <= r12["max"] else None
        out.append({"code": "1.2", "severity": "block", "msg": f"{v} мм больше {r12['max']} мм",
                    "fix": f"лишний ноль? {guess} мм" if guess else "проверьте число"})
    elif v < r17["both_lt"]:
        out.append({"code": "1.7", "severity": "hint", "msg": f"{v} — похоже на сантиметры", "fix": f"{v * 10} мм?"})
    elif v % 5:
        out.append({"code": "1.6", "severity": "warn", "msg": f"{v} не кратно 5 мм"})
    return out


def frame_from_opening(widths: list[int], heights: list[int], company: Company | None = None,
                       cat: Catalog | None = None) -> dict:
    """3 ширины (верх/середина/низ) и 3 высоты (лево/центр/право) → габарит рамы.

    Рама = минимум замеров − 2 × монтажный зазор цеха (install_gap_mm — шов с каждой стороны),
    округление вниз до 5 мм. Перекос — разница замеров больше порога цеха (skew_warn_mm).
    """
    company = company or Company()
    cat = cat or Catalog()
    issues = []
    for name, arr in (("ширина", widths), ("высота", heights)):
        for i, v in enumerate(arr):
            for x in check_value(v, cat):
                issues.append(dict(x, field=f"{name}[{i}]"))
    if any(x["severity"] == "block" for x in issues):
        return {"ok": False, "issues": issues}
    gap = company.install_gap_mm
    w, h = min(widths) - 2 * gap, min(heights) - 2 * gap
    w5, h5 = w - w % 5, h - h % 5                     # рама в мм кратно 5 — вниз, чтобы влезла
    for name, arr in (("ширине", widths), ("высоте", heights)):
        d = max(arr) - min(arr)
        if d > company.skew_warn_mm:
            issues.append({"code": "M.skew", "severity": "warn", "field": name,
                           "msg": f"перекос проёма по {name}: разница замеров {d} мм (порог {company.skew_warn_mm})",
                           "fix": "проверьте замер; рама считается по наименьшему"})
    return {"ok": True, "frame_w": w5, "frame_h": h5, "opening_w": min(widths), "opening_h": min(heights),
            "gap_mm": gap, "issues": issues,
            "opening": {"width": list(widths), "height": list(heights)}}
