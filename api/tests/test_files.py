"""Пакет файлов мастера: что бесплатно, что после заказа, замороженная версия, Excel без себестоимости."""

import io
import zipfile

from openpyxl import load_workbook

from .conftest import ADMIN, tree_variant
from .test_roles import employee

PRODUCTION = ["spec_xlsx", "spec_pdf", "cutmaps_pdf", "csv", "dxf_zip", "drawings_pdf", "general_view_pdf",
              "assembly_pdf", "archive"]


def files(client, h, pid):
    return {f["kind"]: f for f in client.get(f"/projects/{pid}/files", headers=h).json()["files"]}


def test_free_files_always_production_locked(api, client, owner):
    pid = api.project(owner)
    fl = files(client, owner, pid)
    assert {"kp_pdf", "glb_closed", "glb_open"} <= set(fl)
    for k in ("kp_pdf", "glb_closed", "glb_open"):
        assert fl[k]["available"] and fl[k]["free"]
    for k in PRODUCTION:
        assert not fl[k]["available"] and fl[k]["reason"] == "Файлы — после заказа в EMAN или оплаты"

    r = client.get(f"/projects/{pid}/files/kp_pdf", headers=owner)
    assert r.status_code == 200 and r.content[:4] == b"%PDF" and r.headers["content-type"] == "application/pdf"
    assert "filename*=UTF-8''" in r.headers["content-disposition"] and "_v1.pdf" in r.headers["content-disposition"]
    glb = client.get(f"/projects/{pid}/files/glb_open", headers=owner)
    assert glb.status_code == 200 and glb.content[:4] == b"glTF"

    r = client.get(f"/projects/{pid}/files/csv", headers=owner)
    assert r.status_code == 402
    assert r.json()["error"] == {"code": "files_locked", "message": "Файлы — после заказа в EMAN или оплаты",
                                 "details": {"pro_discount": False}}
    assert client.get(f"/projects/{pid}/files/bogus", headers=owner).status_code == 404


def test_pro_gets_discount_flag_only(api, client, owner):
    wid = client.get("/workshops/me", headers=owner).json()["id"]
    client.post(f"/admin/workshops/{wid}/plan", json={"plan": "pro"}, headers=ADMIN)
    pid = api.project(owner)
    data = client.get(f"/projects/{pid}/files", headers=owner).json()
    assert data["access"] == {"production": False, "basis": None, "pro_discount": True}
    assert client.get(f"/projects/{pid}/files/dxf_zip", headers=owner).json()["error"]["details"]["pro_discount"]


def test_paid_order_opens_files_from_frozen_version(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    frozen = client.get(f"/projects/{pid}", headers=owner).json()["frozen_version_id"]
    # правка после договора — новой версией; файлы — всё равно по замороженной
    r = client.post(f"/projects/{pid}/model", json={"tree": tree_variant(width=1300)}, headers=owner)
    assert r.status_code == 201
    assert client.get(f"/projects/{pid}/files/csv", headers=owner).status_code == 402  # «Договор» без оплаты
    client.post(f"/admin/projects/{pid}/order-paid", json={}, headers=ADMIN)
    data = client.get(f"/projects/{pid}/files", headers=owner).json()
    assert data["version_id"] == frozen and data["frozen"] and data["access"]["basis"] == "order"
    assert all(f["available"] for f in data["files"])

    r = client.get(f"/projects/{pid}/files/csv", headers=owner)
    assert r.status_code == 200 and r.headers["x-model-version"] == "1"
    for kind in ("spec_pdf", "cutmaps_pdf", "drawings_pdf", "general_view_pdf", "assembly_pdf"):
        r = client.get(f"/projects/{pid}/files/{kind}", headers=owner)
        assert r.status_code == 200 and r.content[:4] == b"%PDF", kind
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/projects/{pid}/files/dxf_zip", headers=owner).content))
    assert any(n.endswith(".dxf") for n in z.namelist())
    arch = zipfile.ZipFile(io.BytesIO(client.get(f"/projects/{pid}/files/archive", headers=owner).content))
    assert len(arch.namelist()) == 11


def test_employee_gets_xlsx_without_cost(api, client, owner):
    emp = employee(api, client, owner)
    pid = api.project(owner)
    api.advance(owner, pid, "in_work")
    owner_wb = load_workbook(io.BytesIO(client.get(f"/projects/{pid}/files/spec_xlsx", headers=owner).content))
    emp_wb = load_workbook(io.BytesIO(client.get(f"/projects/{pid}/files/spec_xlsx", headers=emp).content))
    assert len(owner_wb.sheetnames) > len(emp_wb.sheetnames)
    text = " ".join(str(c.value) for ws in emp_wb for row in ws.iter_rows() for c in row if c.value)
    assert "Себестоимость" not in text


def test_admin_file_access_and_download_log(api, client, owner, db):
    from sqlalchemy import select

    from mebel_api.models import ActionLog, FileDownload

    pid = api.project(owner)
    r = client.post(f"/admin/projects/{pid}/file-access", json={"basis": "payment", "note": "Click 123"},
                    headers=ADMIN)
    assert r.status_code == 200
    assert client.get(f"/projects/{pid}/files/csv", headers=owner).status_code == 200
    assert db.scalar(select(FileDownload).where(FileDownload.kind == "csv")).basis == "payment"
    assert db.scalar(select(ActionLog).where(ActionLog.entity == "file_access")) is not None


def test_no_model_no_files(api, client, owner):
    pid = api.project(owner, tree=None)
    fl = files(client, owner, pid)
    assert not fl["kp_pdf"]["available"] and fl["kp_pdf"]["reason"] == "Модель ещё не построена"
    assert client.get(f"/projects/{pid}/files/kp_pdf", headers=owner).status_code == 409
