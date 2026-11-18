"""Eskiz Oyna — ядро расчёта окон и дверей.

    from oyna_core import Catalog, Company, calc, commands
    cat = Catalog()                                   # oyna_data/
    doc = commands.create_from_template(cat, "T03", 1400, 1300)
    res = calc(doc, cat, Company.demo())              # нарушения + спецификация + цена

Ядро считает, ИИ и интерфейс только вызывают команды (PRD, принцип 1).
"""
from . import commands
from .api import calc, validate
from .data import Catalog, Company

__all__ = ["Catalog", "Company", "calc", "validate", "commands"]
