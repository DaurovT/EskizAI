"""JSON Pointer'ы значений «оценка» (RFC 6901): что ИИ оценил на глаз и мастер ещё не подтвердил."""

from typing import Any

_MISSING = object()


def resolve(tree: Any, pointer: str) -> Any:
    if pointer in ("", "/"):
        return tree
    cur = tree
    for raw in pointer.lstrip("/").split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, dict):
            if token not in cur:
                return _MISSING
            cur = cur[token]
        elif isinstance(cur, list):
            if not token.isdigit() or int(token) >= len(cur):
                return _MISSING
            cur = cur[int(token)]
        else:
            return _MISSING
    return cur


def related(a: str, b: str) -> bool:
    """Один указатель — тот же, предок или потомок другого."""
    return a == b or a.startswith(b.rstrip("/") + "/") or b.startswith(a.rstrip("/") + "/")


def remove(estimated: list[str], pointers: list[str]) -> list[str]:
    return [p for p in estimated if not any(related(p, q) for q in pointers)]


def carry(estimated: list[str], old_tree: dict, new_tree: dict) -> list[str]:
    """Пометки «оценка» переходят в новую версию, если значение не изменилось (изменённое — подтверждено
    мастером) и путь ещё существует."""
    out = []
    for p in estimated:
        new = resolve(new_tree, p)
        if new is _MISSING:
            continue
        if resolve(old_tree, p) == new:
            out.append(p)
    return out


def clean(pointers: list[str] | None) -> list[str]:
    seen, out = set(), []
    for p in pointers or []:
        if isinstance(p, str) and p.startswith("/") and p not in seen:
            seen.add(p)
            out.append(p)
    return out
