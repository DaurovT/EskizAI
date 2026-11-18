"""Таблица армирования: какой металл к какому профилю каждой ПВХ-системы.

Запуск после build.py:  python build_flex.py
Пишет reinforcement_map.csv. Источник — catalog_items.csv (Romchi).

Логика подбора серии аксессуаров для системы:
  1) серия «<system_code>_aksessuarlari» (точное совпадение);
  2) серия аксессуаров того же бренда с тем же номером серии (6000, 7000…);
  3) любая серия аксессуаров того же бренда с «Metall Universal» — только универсальный металл;
  4) иначе — универсальный металл Akfa 6000 QVT, статус ДЕМО.
Внутри серии: рама → Kosa, створка → Qanot, импост → O'rta, балконные — Balkon *, штульп → Shtulp;
нет специального — Universal. Все толщины серии пишутся вариантами, по умолчанию — специальный металл
(для балконных — самый толстый).
"""
import csv
import re
from collections import defaultdict

items = list(csv.DictReader(open("catalog_items.csv", encoding="utf-8")))
systems = [s for s in csv.DictReader(open("systems.csv", encoding="utf-8"))
           if s["usable_for_calc"] == "1" and s["material_class"] == "pvc"]

reinf = defaultdict(list)                       # серия аксессуаров -> позиции армирования
for it in items:
    if it["role"] == "reinforcement" and re.search(r"metall|usilitel|universal|^balkon", it["article"], re.I):
        reinf[it["system_code"]].append(it)
acc_series = list(reinf)

ROLE_KEYS = {  # роль профиля -> ключевое слово в названии металла
    "frame": r"(?<!balkon )kosa", "sash": r"(?<!balkon )qanot", "mullion": r"(?<!balkon )o'?rta",
    "door_frame": r"balkon\s+kosa|^balkon\s+[\d.,]+\s*mm", "door_sash": r"balkon\s+qanot|^balkon\s+[\d.,]+\s*mm",
    "door_mullion": r"balkon\s+o'?rta|^balkon\s+[\d.,]+\s*mm",
    "shtulp": r"shtulp",
}


def thickness(a):
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*mm", a, re.I)
    return float(m.group(1).replace(",", ".")) if m else None


def pick_series(sysc, brand, pclass):
    exact = [a for a in acc_series if a.startswith(sysc + "_aks")]
    if exact:
        return exact[0], "серия аксессуаров системы"
    num = re.search(r"(\d{4})", sysc)
    same = [a for a in acc_series if a.split("__")[0] == sysc.split("__")[0] and num and num.group(1) in a]
    if same:
        return same[0], "серия аксессуаров бренда с тем же номером"
    anyb = [a for a in acc_series if a.split("__")[0] == sysc.split("__")[0]
            and any(re.search("universal|usilitel", x["article"], re.I) for x in reinf[a])]
    if anyb:
        return anyb[0], "универсальный металл бренда"
    fb = "akfa__7000_akfa_eko_aksessuarlari" if pclass == "pvc_70" else "akfa__6000_qvt_aksessuarlari"
    return fb, "ДЕМО: у бренда нет армирования в Romchi — универсальный металл Akfa того же класса"


rows = []
for s in systems:
    ser, how = pick_series(s["system_code"], s["brand"], s["passport_class"])
    pool = reinf[ser]
    if how.startswith("ДЕМО") or how.startswith("универсальный металл бренда"):
        pool = [x for x in pool if re.search("universal|usilitel", x["article"], re.I)]   # чужие специальные профили не подходят по сечению
    universal = [x for x in pool if re.search("universal|usilitel", x["article"], re.I)]
    for role, key in ROLE_KEYS.items():
        special = [x for x in pool if re.search(key, x["article"], re.I)]
        status = how if special else (how + "; специального нет — универсальный" if universal else how)
        cands = special or universal
        if not cands:
            continue
        if role.startswith("door") or role == "shtulp":
            cands = sorted(cands, key=lambda x: -(thickness(x["article"]) or 0))
        else:
            cands = sorted(cands, key=lambda x: -(thickness(x["article"]) or 0) if special else (thickness(x["article"]) or 0) != 1.0)
        seen = set()
        for i, c in enumerate(cands):
            if c["article"] in seen:
                continue
            seen.add(c["article"])
            rows.append(dict(system_code=s["system_code"], profile_role=role, item_article=c["article"],
                             accessory_series=ser, thickness_mm=thickness(c["article"]) or "",
                             is_default="1" if not any(r["system_code"] == s["system_code"] and r["profile_role"] == role
                                                       and r["is_default"] == "1" for r in rows) else "0",
                             status=status))

with open("reinforcement_map.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
covered = {r["system_code"] for r in rows}
print(f"reinforcement_map.csv: {len(rows)} строк, систем {len(covered)} из {len(systems)}")
for st in sorted({r['status'] for r in rows}):
    print(" ", sum(1 for r in rows if r['status'] == st and r['is_default'] == '1'), "—", st)
