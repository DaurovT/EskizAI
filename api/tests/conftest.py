import copy
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mebel_api.config import Settings
from mebel_api.db import Base
from mebel_api.main import create_app
from mebel_api.services.auth_codes import DevCodeSender
from mebel_api.services.notify import MemoryPushSender

CORE_FIXTURES = Path(__file__).resolve().parents[2] / "core" / "tests" / "fixtures"
ADMIN = {"X-Admin-Token": "test-admin"}


def load_tree(name: str = "wardrobe_2sec") -> dict:
    return json.loads((CORE_FIXTURES / f"{name}.json").read_text())


GOOD_TREE = load_tree("wardrobe_2sec")
BAD_TREE = load_tree("bad_too_tall_side")  # собирается, но с ошибкой «деталь больше листа»


def make_settings(tmp_path: Path, **overrides) -> Settings:
    base = dict(
        env="test",
        database_url=os.environ.get("TEST_DATABASE_URL", "sqlite://"),
        jwt_secret="test-secret-test-secret-test-secret",
        admin_token="test-admin",
        media_dir=tmp_path / "media",
        auth_code_resend_seconds=0,
        task_queue_mode="inline",  # задачи выполняются сразу — тесты детерминированы
        # все тестовые входы идут с одного IP («testclient») и из соседних номеров — лимиты против
        # SMS-накрутки проверяются отдельно (test_auth_limits.py)
        auth_code_ip_per_10min=1000, auth_code_ip_per_day=1000,
        auth_code_prefix_per_hour=1000, auth_code_prefix_per_day=1000,
    )
    base.update(overrides)
    return Settings(_env_file=None, **base)


class Api:
    """Тестовый клиент с помощниками для входа и типовых шагов."""

    def __init__(self, client: TestClient, sender: DevCodeSender):
        self.c = client
        self.sender = sender

    def login(self, phone: str = "+998901234567") -> dict:
        r = self.c.post("/auth/request-code", json={"phone": phone, "channel": "sms"})
        assert r.status_code == 200, r.text
        code = self.sender.sent[-1][1]
        r = self.c.post("/auth/verify-code", json={"phone": phone, "code": code})
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    def employee(self, owner_h: dict, phone: str = "+998935550000", name: str = "", **perms) -> dict:
        """Приглашение владельца → вход сотрудника → «Принять приглашение». Возвращает заголовки сотрудника."""
        r = self.c.post("/workshops/me/employees", json={"phone": phone, "name": name, **perms}, headers=owner_h)
        assert r.status_code == 201, r.text
        self.c.post("/auth/request-code", json={"phone": phone, "channel": "sms"})
        r = self.c.post("/auth/verify-code", json={"phone": phone, "code": self.sender.sent[-1][1]})
        assert r.status_code == 200, r.text
        invite = r.json()["invite"]
        assert invite and invite["status"] == "pending", r.text
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        r = self.c.post(f"/auth/invite/{invite['id']}/accept", headers=h)
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    def project(self, h: dict, title: str = "Шкаф", tree: dict | None = GOOD_TREE, **extra) -> str:
        r = self.c.post("/projects", json={"title": title, **extra}, headers=h)
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        if tree is not None:
            r = self.c.post(f"/projects/{pid}/model", json={"tree": tree}, headers=h)
            assert r.status_code == 201, r.text
        return pid

    def advance(self, h: dict, pid: str, to: str) -> dict:
        """Ведёт проект по основному пути до статуса `to`."""
        steps = [
            ("sketch", lambda: self.c.post(f"/projects/{pid}/sketch", headers=h)),
            ("sent", lambda: self.c.post(f"/projects/{pid}/share-links", json={}, headers=h)),
            ("measured", lambda: self.c.post(f"/projects/{pid}/measurements", json={"width": 1200}, headers=h)),
            ("contract", lambda: self.c.post(f"/projects/{pid}/contract", headers=h)),
            ("in_work", lambda: self.c.post(f"/admin/projects/{pid}/order-paid", json={}, headers=ADMIN)),
            ("delivered", lambda: self.c.post(f"/projects/{pid}/deliver", json={}, headers=h)),
        ]
        for status, call in steps:
            r = call()
            assert r.status_code in (200, 201), (status, r.text)
            if status == to:
                break
        card = self.c.get(f"/projects/{pid}", headers=h).json()
        assert card["status"] == to
        return card


@pytest.fixture
def settings(tmp_path):
    return make_settings(tmp_path)


def build_app(settings: Settings):
    """Приложение с чистой схемой. TEST_DATABASE_URL=postgresql+psycopg://… — прогон на Postgres."""
    sender = DevCodeSender()
    push = MemoryPushSender()  # push в тестах — в память, без сети
    application = create_app(settings, code_sender=sender, push_sender=push)
    application.state.test_push = push
    engine = application.state.db.engine
    if engine.dialect.name != "sqlite":
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    application.state.test_sender = sender
    return application


@pytest.fixture
def app(settings):
    application = build_app(settings)
    yield application
    application.state.db.engine.dispose()


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


@pytest.fixture
def api(client, app) -> Api:
    return Api(client, app.state.test_sender)


@pytest.fixture
def owner(api) -> dict:
    return api.login("+998901234567")


@pytest.fixture
def db(app):
    with app.state.db.sessionmaker() as s:
        yield s


def tree_variant(**changes) -> dict:
    t = copy.deepcopy(GOOD_TREE)
    t.update(changes)
    return t


@pytest.fixture
def root_admin(app, client) -> dict:
    """Суперадмин с 2FA (Bearer) — для ручек, где старый X-Admin-Token не принимается (настройки, лимиты,
    поставщики, деньги, сотрудники; docs/staff_vendor_contract.md §8)."""
    from .staff_helpers import superadmin

    return superadmin(app, client, "root-admin@eskizai.uz")
