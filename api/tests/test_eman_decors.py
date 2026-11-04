"""/catalog/decors (каталог EMAN), /catalog/paint-colors, /static/textures, импорт в БД."""

from mebel_core.decors import load_decors
from sqlalchemy import select

from mebel_api.models import CatalogItem
from scripts.import_eman_decors import import_decors

from .conftest import ADMIN


def test_decors_filters_and_facets(client, owner):
    r = client.get("/catalog/decors?kind=ldsp&brand=Egger&min_thickness=16&limit=20", headers=owner).json()
    assert r["total"] > 20 and len(r["items"]) == 20 and "Egger" in r["brands"]
    x = r["items"][0]
    assert x["source"] in ("eman", "core", "catalog") and x["thickness"] >= 16
    egger = [i for i in r["items"] if i["source"] == "eman"]
    assert egger and all(i["brand"] == "Egger" and i["kind"] == "ldsp" for i in egger)
    assert egger[0]["id"].startswith("ldsp_") and egger[0]["decor"] and egger[0]["color"].startswith("#")
    assert "price" in egger[0]  # владелец видит цену листа
    fam = client.get("/catalog/decors?family=white&kind=ldsp", headers=owner).json()
    assert fam["total"] > 0 and all(i.get("family") in (None, "white") for i in fam["items"])
    assert set(fam["families"]) <= {"white", "grey", "beige", "wood-light", "wood-dark", "black", "colour"}
    s = client.get("/catalog/decors?q=h3395", headers=owner).json()
    assert any(i["decor"] and "H3395" in i["decor"] for i in s["items"])
    multi = client.get("/catalog/decors?kind=ldsp,acrylic&limit=500", headers=owner).json()["items"]
    assert {i.get("eman_kind", i["kind"]) for i in multi} >= {"ldsp", "acrylic"}
    assert all(i["kind"] != "edge" for i in client.get("/catalog/decors?limit=500", headers=owner).json()["items"])
    assert client.get("/catalog/decors?kind=edge&limit=5", headers=owner).json()["items"][0]["eman_kind"] == "edge"


def test_decors_hide_price_from_employee(api, client, owner):
    from .test_roles import employee

    emp = employee(api, client, owner)
    items = client.get("/catalog/decors?kind=ldsp&limit=200", headers=emp).json()["items"]
    assert items and all("price" not in i for i in items)


def test_paint_colors(client, owner):
    r = client.get("/catalog/paint-colors", headers=owner).json()
    assert r["total"] >= 60 and [g["id"] for g in r["gloss"]] == ["matte", "satin", "gloss"]
    assert [g["price_m2"] for g in r["gloss"]] == [220_000, 260_000, 380_000]
    assert {m["id"] for m in r["materials"]} == {"mdf_16_paint", "mdf_19_paint", "mdf_22_paint"} and r["back_factor"] == 0.5
    ral = client.get("/catalog/paint-colors?system=RAL&q=9010", headers=owner).json()["colors"]
    assert [c["code"] for c in ral] == ["RAL 9010"]


def test_texture_static(client):
    tex = next(d["texture"] for d in load_decors() if d.get("texture"))
    r = client.get(tex)
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"


def test_import_into_db(app, client, db):
    stats = import_decors(app.state.db)
    assert stats["created"] > 300 and stats["updated"] == 0
    again = import_decors(app.state.db)
    assert again["created"] == 0 and again["updated"] == stats["created"]
    db.expire_all()
    it = db.scalar(select(CatalogItem).where(CatalogItem.core_key.like("ldsp_16_egger_%")))
    assert it.type == "sheet" and it.price_source == "eman.uz" and it.price > 100_000
    items = client.get("/admin/catalog/items?q=egger&limit=5", headers=ADMIN).json()
    assert items["total"] > 5
