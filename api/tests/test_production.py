"""Производство цеха (SCR-56) и оглавление «Комплекта чертежей» (SCR-57)."""

import io
import zipfile

from sqlalchemy import select

from mebel_api.models import ActionLog

from .conftest import ADMIN
from .test_roles import employee

URL = "/workshops/me/production"
DOORS = {"width": 1000, "height": 2200, "depth": 600, "body": {"material": "ldsp_16_white"},
         "sections": [{"fill": [{"kind": "shelves", "count": 4}], "doors": {"count": 2}}]}


def hardware(client, h, pid) -> dict[str, int]:
    out: dict[str, int] = {}
    for item in client.get(f"/projects/{pid}/model", headers=h).json()["version"]["summary"]["hardware"]:
        out[item["kind"]] = out.get(item["kind"], 0) + item["qty"]
    return out


def test_defaults_and_owner_only(api, client, owner):
    r = client.get(URL, headers=owner)
    assert r.status_code == 200, r.text
    data = r.json()
    assert {k: data[k] for k in ("fastener", "confirmat_depth", "hinge_brand", "shelf_pin_grid", "saved")} == \
        {"fastener": "confirmat", "confirmat_depth": 50, "hinge_brand": "blum", "shelf_pin_grid": False, "saved": False}
    brands = {b["id"]: b for b in data["hinge_brands"]}
    assert set(brands) == {"blum", "hettich", "gtv"}
    assert brands["blum"]["plate_pattern"] == "along" and brands["gtv"]["plate_pattern"] == "across"
    assert brands["blum"]["plate_spacing_mm"] == 32 and brands["blum"]["plate_line_mm"] == 37
    assert brands["hettich"]["cup_diameter_mm"] == 35 and brands["blum"]["cup_from_edge_mm"] == 22.5

    emp = employee(api, client, owner)
    assert client.get(URL, headers=emp).status_code == 403
    assert client.patch(URL, json={"fastener": "dowel"}, headers=emp).status_code == 403


def test_patch_validates_and_logs(client, owner, db):
    for bad in ({"fastener": "glue"}, {"confirmat_depth": 30}, {"hinge_brand": "noname"}, {"shelf_pin_grid": "x"}):
        assert client.patch(URL, json=bad, headers=owner).status_code == 422, bad
    r = client.patch(URL, json={"confirmat_depth": 40, "hinge_brand": "gtv"}, headers=owner)
    assert r.status_code == 200, r.text
    d = r.json()
    assert (d["fastener"], d["confirmat_depth"], d["hinge_brand"], d["shelf_pin_grid"], d["saved"]) == \
        ("confirmat", 40, "gtv", False, True)
    r = client.patch(URL, json={"shelf_pin_grid": True}, headers=owner)  # частично: остальное сохраняется
    assert (r.json()["confirmat_depth"], r.json()["hinge_brand"], r.json()["shelf_pin_grid"]) == (40, "gtv", True)
    assert client.get(URL, headers=owner).json()["shelf_pin_grid"] is True
    logs = list(db.scalars(select(ActionLog).where(ActionLog.entity == "workshop_production")))
    assert len(logs) == 2 and logs[0].after["hinge_brand"] == "gtv"
    client.patch(URL, json={"shelf_pin_grid": True}, headers=owner)  # без изменений — без записи
    assert len(list(db.scalars(select(ActionLog).where(ActionLog.entity == "workshop_production")))) == 2


def test_dowel_mode_reaches_versions_files_and_estimate(api, client, owner):
    pid = api.project(owner, tree=DOORS)
    before = hardware(client, owner, pid)
    assert before.get("confirmat", 0) > 0
    est_before = client.get(f"/projects/{pid}/estimate", headers=owner).json()

    assert client.patch(URL, json={"fastener": "dowel", "hinge_brand": "hettich"}, headers=owner).status_code == 200
    # новая версия собирается по правилам цеха
    r = client.post(f"/projects/{pid}/model", json={"tree": DOORS}, headers=owner)
    assert r.status_code == 201, r.text
    version = r.json()["version"]
    assert version["rules_version"].endswith("+d.hettich.single")
    after = hardware(client, owner, pid)
    assert after.get("confirmat", 0) == 0
    assert after["dowel"] == before.get("dowel", 0) + before["confirmat"]
    hinges = [h["name"] for h in client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["summary"]["hardware"]
              if h["kind"] == "hinge"]
    assert hinges and all(n.endswith("· Hettich") for n in hinges)
    parts = client.get(f"/projects/{pid}/model", headers=owner).json()["version"]["viewer"]["parts"]
    diameters = {h["diameter"] for p in parts for h in p.get("holes", [])}
    assert 8 in diameters and 7 not in diameters  # шкант Ø8 в 3D-детали, сквозных Ø7 конфирмата нет

    # смета: конфирматов нет, шканты есть
    est = client.get(f"/projects/{pid}/estimate", headers=owner).json()
    names = [line["name"] for line in est["lines"]]
    assert any("Шкант" in n for n in names) and not any("Конфирмат" in n for n in names)
    assert any("Конфирмат" in line["name"] for line in est_before["lines"])

    # файлы: DXF и CSV — по тем же правилам
    client.post(f"/admin/projects/{pid}/file-access", json={"basis": "payment"}, headers=ADMIN)
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/projects/{pid}/files/dxf_zip", headers=owner).content))
    dxf = b"".join(z.read(n) for n in z.namelist())
    assert b"DRILL_EDGE_x0_D8_Z30" in dxf and b"_D7_Z0" not in dxf and b"_D5_Z50" not in dxf  # шканты, не конфирматы
    assert client.get(f"/projects/{pid}/files/production_set_pdf", headers=owner).status_code == 200


def test_drawing_set_index(api, client, owner):
    pid = api.project(owner)
    fl = {f["kind"]: f for f in client.get(f"/projects/{pid}/files", headers=owner).json()["files"]}
    assert fl["production_set_pdf"]["sheets"] is None  # оглавление ещё не строилось
    r = client.get(f"/projects/{pid}/drawing-set", headers=owner)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["locked"] and not d["available"] and d["reason"]  # до оплаты — только оглавление
    assert d["pages"] == len(d["sheets"]) >= 8 and d["version_number"] == 1
    assert [s["n"] for s in d["sheets"]] == list(range(1, d["pages"] + 1))
    keys = [s["key"] for s in d["sections"]]
    assert keys[0] == "cover" and {"general", "assembly", "parts", "spec", "cutting"} <= set(keys)
    assert sum(s["count"] for s in d["sections"]) == d["pages"]
    assert all(s["parts"] for s in d["sheets"] if s["section"] == "parts")
    assert d["file_name"].endswith("_v1.pdf")
    # теперь число листов есть и в списке файлов
    fl = {f["kind"]: f for f in client.get(f"/projects/{pid}/files", headers=owner).json()["files"]}
    assert fl["production_set_pdf"]["sheets"] == d["pages"]
    cutting = next(s["count"] for s in d["sections"] if s["key"] == "cutting")
    assert fl["cutmaps_pdf"]["sheets"] == cutting

    client.post(f"/admin/projects/{pid}/file-access", json={"basis": "payment"}, headers=ADMIN)
    d2 = client.get(f"/projects/{pid}/drawing-set", headers=owner).json()
    assert d2["available"] and not d2["locked"] and d2["sheets"] == d["sheets"]

    empty = api.project(owner, tree=None)
    assert client.get(f"/projects/{empty}/drawing-set", headers=owner).status_code == 409
