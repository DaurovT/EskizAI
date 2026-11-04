import re
import uuid

from sqlalchemy import select

from mebel_api.models import ModelVersion, Order

from .conftest import ADMIN, BAD_TREE

CYRILLIC = re.compile("[а-яА-ЯёЁ]")


def err(r) -> dict:
    e = r.json()["error"]
    assert CYRILLIC.search(e["message"]), e  # сообщения мастеру — по-русски
    return e


def test_happy_path_to_delivered(api, client, owner):
    pid = api.project(owner)
    card = api.advance(owner, pid, "delivered")
    assert card["status_label"] == "Сдан"
    assert card["has_order"] is True
    assert card["contract_at"] and card["delivered_at"]
    history = client.get(f"/projects/{pid}/history", headers=owner).json()
    assert [h["to_status"] for h in history] == [
        "draft", "sketch", "sent", "measured", "contract", "in_work", "delivered",
    ]
    assert history[5]["actor"] == "admin"


def test_sketch_to_measured_without_link(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "sketch")
    r = client.post(f"/projects/{pid}/measurements", json={"width": 1200, "height": 2400, "depth": 600}, headers=owner)
    assert r.status_code == 201
    assert client.get(f"/projects/{pid}", headers=owner).json()["status"] == "measured"
    # повторный замер — новая запись, статус тот же
    assert client.post(f"/projects/{pid}/measurements", json={"width": 1195}, headers=owner).status_code == 201
    assert len(client.get(f"/projects/{pid}/measurements", headers=owner).json()) == 2


def test_contract_to_delivered_self_bought(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "contract")
    r = client.post(f"/projects/{pid}/deliver", json={}, headers=owner)
    assert r.status_code == 409
    assert "куплены сам" in err(r)["message"]
    r = client.post(f"/projects/{pid}/deliver", json={"materials_self_bought": True}, headers=owner)
    assert r.status_code == 200
    card = r.json()
    assert card["status"] == "delivered" and card["materials_self_bought"] is True
    assert card["returned_to_limit"] is False  # «куплены сам» в лимит не возвращается


def test_illegal_transitions_have_clear_messages(api, client, owner):
    pid = api.project(owner)
    r = client.post(f"/projects/{pid}/contract", headers=owner)
    assert r.status_code == 409
    e = err(r)
    assert e["code"] == "illegal_transition"
    assert e["message"].startswith("Нельзя перейти из «Черновик» в «Договор»")

    r = client.post(f"/projects/{pid}/share-links", json={}, headers=owner)
    assert r.status_code == 409 and "Черновик отправить нельзя" in err(r)["message"]

    r = client.post(f"/projects/{pid}/measurements", json={"width": 1000}, headers=owner)
    assert r.status_code == 409 and "эскиз" in err(r)["message"]

    r = client.post(f"/admin/projects/{pid}/order-paid", json={}, headers=ADMIN)
    assert r.status_code == 409 and "«В работе»" in err(r)["message"]

    r = client.post(f"/projects/{pid}/deliver", json={"materials_self_bought": True}, headers=owner)
    assert r.status_code == 409

    api.advance(owner, pid, "sketch")
    r = client.post(f"/projects/{pid}/sketch", headers=owner)
    assert r.status_code == 409 and "уже в статусе «Эскиз»" in err(r)["message"]


def test_sketch_requires_model(api, client, owner):
    pid = api.project(owner, tree=None)
    r = client.post(f"/projects/{pid}/sketch", headers=owner)
    assert r.status_code == 409
    assert err(r)["code"] == "model_missing"


def test_sketch_requires_valid_model(api, client, owner):
    pid = api.project(owner, tree=BAD_TREE)
    r = client.post(f"/projects/{pid}/sketch", headers=owner)
    assert r.status_code == 409
    e = err(r)
    assert e["code"] == "model_invalid"
    assert e["details"]["issues"]
    assert client.get(f"/projects/{pid}", headers=owner).json()["charged"] is False


def test_cancel_rules(api, client, owner):
    pid = api.project(owner)
    api.advance(owner, pid, "measured")
    r = client.post(f"/projects/{pid}/cancel", json={"reason": "Клиент передумал"}, headers=owner)
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled" and r.json()["cancel_reason"] == "Клиент передумал"
    r = client.post(f"/projects/{pid}/cancel", json={}, headers=owner)
    assert r.status_code == 409 and "отменён" in err(r)["message"]
    r = client.post(f"/projects/{pid}/measurements", json={"width": 1}, headers=owner)
    assert r.status_code == 409

    pid2 = api.project(owner)
    api.advance(owner, pid2, "in_work")
    r = client.post(f"/projects/{pid2}/cancel", json={}, headers=owner)
    assert r.status_code == 409
    assert "заказ уже оплачен" in err(r)["message"]


def test_project_with_order_can_only_be_archived(api, client, owner, db):
    pid = api.project(owner)
    api.advance(owner, pid, "in_work")
    assert db.scalar(select(Order).where(Order.status == "paid")) is not None
    r = client.delete(f"/projects/{pid}", headers=owner)
    assert r.status_code == 409
    assert "только отправить в архив" in err(r)["message"]
    r = client.post(f"/projects/{pid}/archive", headers=owner)
    assert r.status_code == 200 and r.json()["archived_at"]
    assert r.json()["actions"] == [{"code": "unarchive", "label": "Вернуть из архива", "to_status": None}]
    assert client.get("/projects", headers=owner).json()["total"] == 0
    assert client.get("/projects?archived=true", headers=owner).json()["total"] == 1
    # в архиве статус не меняется
    r = client.post(f"/projects/{pid}/deliver", json={}, headers=owner)
    assert r.status_code == 409 and "архиве" in err(r)["message"]
    client.post(f"/projects/{pid}/unarchive", headers=owner)
    assert client.post(f"/projects/{pid}/deliver", json={}, headers=owner).status_code == 200


def test_delete_without_order_is_soft(api, client, owner):
    pid = api.project(owner)
    assert client.delete(f"/projects/{pid}", headers=owner).status_code == 200
    assert client.get(f"/projects/{pid}", headers=owner).status_code == 404


def test_contract_freezes_current_version(api, client, owner, db):
    pid = api.project(owner)
    card = api.advance(owner, pid, "contract")
    assert card["frozen_version_id"] == card["current_version_id"]
    v = db.get(ModelVersion, uuid.UUID(card["frozen_version_id"]))
    assert v.frozen


def test_card_actions_follow_status(api, client, owner):
    pid = api.project(owner)
    card = client.get(f"/projects/{pid}", headers=owner).json()
    assert [a["code"] for a in card["actions"]] == ["sketch", "cancel"]
    card = api.advance(owner, pid, "contract")
    assert [a["code"] for a in card["actions"]] == ["order", "deliver_self_bought", "cancel"]
    assert "EMAN" in card["next_step"]
