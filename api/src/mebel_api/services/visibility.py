"""Фильтрация полей по ролям — вторая линия защиты поверх типов ответов.

Сотрудник цеха не видит себестоимость и наценки (раздел 2 PRD).
Клиент по ссылке не видит себестоимость, наценки, поставщика, артикулы,
комиссию (раздел 7 и NFR-10) — и служебные замечания мастеру.
"""

from typing import Any

EMPLOYEE_HIDDEN_PREFIXES = ("cost", "markup", "margin", "purchase", "commission")
CLIENT_HIDDEN_PREFIXES = EMPLOYEE_HIDDEN_PREFIXES + ("supplier", "sku", "article", "labor_percent", "labor_mode")
CLIENT_HIDDEN_KEYS = {"issues"}


def _hidden(key: str, prefixes: tuple[str, ...], keys: set[str]) -> bool:
    k = key.lower()
    return k in keys or k.startswith(prefixes)


def strip_keys(data: Any, prefixes: tuple[str, ...], keys: set[str] = frozenset()) -> Any:  # type: ignore[assignment]
    if isinstance(data, dict):
        return {k: strip_keys(v, prefixes, keys) for k, v in data.items() if not _hidden(str(k), prefixes, keys)}
    if isinstance(data, list):
        return [strip_keys(v, prefixes, keys) for v in data]
    return data


def for_employee(data: Any) -> Any:
    return strip_keys(data, EMPLOYEE_HIDDEN_PREFIXES)


def for_client(data: Any) -> Any:
    return strip_keys(data, CLIENT_HIDDEN_PREFIXES, CLIENT_HIDDEN_KEYS)


def find_forbidden_client_keys(data: Any, path: str = "") -> list[str]:
    """Для тестов и самопроверки: пути запрещённых ключей в ответе клиенту."""
    found: list[str] = []
    if isinstance(data, dict):
        for k, v in data.items():
            p = f"{path}.{k}" if path else str(k)
            if _hidden(str(k), CLIENT_HIDDEN_PREFIXES, CLIENT_HIDDEN_KEYS):
                found.append(p)
            found += find_forbidden_client_keys(v, p)
    elif isinstance(data, list):
        for i, v in enumerate(data):
            found += find_forbidden_client_keys(v, f"{path}[{i}]")
    return found
