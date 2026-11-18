"""Данные для разработки и скриншотов: владелец «Демо-цеха» и заказы в разных состояниях.

    OYNA_DSN=… python scripts/dev_seed.py [+998900000001]

Вход в приложении: этот номер и код 00000 (OYNA_ENV=dev, OYNA_CODE_PROVIDER=dev).
Через HTTP-клиент FastAPI, так что данные проходят те же проверки, что и из приложения.
"""
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("OYNA_FX_FIXED", "12010.45")

from fastapi.testclient import TestClient  # noqa: E402

from oyna_api import store  # noqa: E402
from oyna_api.app import app  # noqa: E402

PHONE = sys.argv[1] if len(sys.argv) > 1 else "+998900000001"

with store.conn() as c:
    u = c.execute("SELECT id FROM users WHERE phone = %s", (PHONE,)).fetchone() or \
        c.execute("INSERT INTO users (phone, name) VALUES (%s, 'Тимур') RETURNING id", (PHONE,)).fetchone()
    co = c.execute("SELECT id FROM companies WHERE name = 'Демо-цех'").fetchone()
    c.execute("INSERT INTO company_members (company_id, user_id, role) VALUES (%s,%s,'owner') ON CONFLICT DO NOTHING", (co["id"], u["id"]))

cl = TestClient(app)
cl.post("/auth/request-code", json={"phone": PHONE})
tok = cl.post("/auth/verify-code", json={"phone": PHONE, "code": "00000"}).json()
H = {"Authorization": f"Bearer {tok['access_token']}"}


def tmpl(t, **kw):
    return cl.post("/oyna/positions/from-template", json={"template": t, **kw}, headers=H).json()["doc"]


def order(address, client, floor, items, status=None, quote=False, accept=None, extras=()):
    oid = cl.post("/oyna/orders", json={"address": address, "floor": floor, "client": client}, headers=H).json()["id"]
    for t, room, w, h, qty in items:
        d = tmpl(t, w=w, h=h, room=room)
        d["qty"] = qty
        d["extras"] = {"sill": {"depth_cm": 30}, "slopes": True}
        cl.put(f"/oyna/orders/{oid}/positions/{uuid.uuid4()}", json={"doc": d}, headers=H)
    for name, qty, price in extras:
        cl.post(f"/oyna/orders/{oid}/extras", json={"name": name, "qty": qty, "price_sum": price}, headers=H)
    if quote:
        q = cl.post(f"/oyna/orders/{oid}/quotes", json={"lang": "ru"}, headers=H).json()
        if accept is not None:
            cl.post(f"/q/{q['token']}/accept", json={"variant": accept})
    if status:
        cl.patch(f"/oyna/orders/{oid}", json={"status": status}, headers=H)
    return oid


order("Чиланзар 9, кв. 42", {"name": "Азиз Каримов", "phone": "+998901112233", "telegram": "@aziz_k"}, 4,
      [("T03", "Кухня", 1400, 1300, 1), ("T05", "Зал", 2100, 1400, 2), ("T01", "Спальня", 700, 1300, 1)],
      quote=True, extras=[("Москитная сетка VSN", 2, 269000)])
order("Юнусабад 4, балкон", {"name": "Дилноза Р.", "phone": "+998935551122"}, 2,
      [("T03", "Балкон", 1400, 1400, 1)])
order("Мирабад 12", {"name": "Нигора С.", "phone": "+998977778899", "telegram": "@nigora"}, 3,
      [("T03", "Кухня", 1300, 1300, 1), ("T01", "Детская", 700, 1300, 2)], quote=True, accept=1)
order("Сергели, дом", {"name": "Бахром Т.", "phone": "+998933334455"}, 1,
      [("T03", "Гостиная", 1400, 1300, 1), ("T01", "Спальня", 1500, 1300, 1)])  # створка 1500 — блок 2.2
print("готово: вход", PHONE, "код 00000")
