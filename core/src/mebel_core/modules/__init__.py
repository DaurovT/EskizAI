"""Реестр модулей.

Модуль — маленькая функция: получает свободное пространство и параметры,
добавляет детали и фурнитуру в контекст сборки. У каждого модуля есть
версия: она записывается в результат сборки, чтобы старый проект
пересчитывался по своим версиям (раздел 18 PRD).
"""

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class ModuleInfo:
    name: str
    version: str
    title: str
    fn: Callable


MODULES: dict[str, ModuleInfo] = {}


def module(name: str, version: str, title: str):
    def register(fn: Callable) -> Callable:
        if name in MODULES:
            raise ValueError(f"Модуль {name} уже зарегистрирован")
        MODULES[name] = ModuleInfo(name=name, version=version, title=title, fn=fn)
        return fn

    return register


def load_all() -> None:
    """Импортирует модули, чтобы они зарегистрировались."""
    from . import body, builtin, fill, fronts, kitchen, partition  # noqa: F401
