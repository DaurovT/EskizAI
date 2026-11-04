"""Осмысленные названия проектов: временное по описанию → «вид + размеры» по модели; название мастера не трогаем."""

import re
import uuid

import pytest

from mebel_ai import LLM
from mebel_api.deps import get_llm
from mebel_api.models import Project
from mebel_api.services import titles

from .conftest import load_tree
from .fake_anthropic import FakeClient, design, response


@pytest.fixture
def fake(app):
    holder = FakeClient([])
    app.dependency_overrides[get_llm] = lambda: LLM(client=holder)
    yield holder
    app.dependency_overrides.clear()


def create(client, h, **body) -> dict:
    r = client.post("/projects", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def model(client, h, pid, tree) -> None:
    r = client.post(f"/projects/{pid}/model", json={"tree": tree}, headers=h)
    assert r.status_code == 201, r.text


def card(client, h, pid) -> dict:
    return client.get(f"/projects/{pid}", headers=h).json()


def test_provisional_title_from_text_then_model(client, owner):
    p = create(client, owner, title="Шкаф-купе в спальню 2400 на 2600", source_text="Шкаф-купе в спальню 2400 на 2600. Белый")
    assert p["title"] == "Шкаф-купе 2400×2600" and p["title_source"] == "auto"
    assert re.fullmatch(r"\d{2}\.\d{2}", p["short_date"])
    model(client, owner, p["id"], load_tree("kupe_3doors"))
    assert card(client, owner, p["id"])["title"] == "Шкаф-купе 2400×650×2400"
    item = client.get("/projects", headers=owner).json()["items"][0]
    assert item["title"] == "Шкаф-купе 2400×650×2400" and item["title_source"] == "auto" and item["short_date"]


def test_default_date_title_and_no_title(client, owner):
    c = client.post("/clients", json={"name": "Азиз Каримов", "phone": "+998901112233"}, headers=owner).json()
    p = create(client, owner, title="Новый проект 03.11.2026", client_id=c["id"])
    assert p["title"] == "Новый проект · Азиз" and p["title_source"] == "auto"
    q = create(client, owner, source_text="пенал в ванную", client_id=c["id"])  # без названия
    assert q["title"] == "Пенал · Азиз"
    model(client, owner, p["id"], load_tree("kitchen_corner"))
    assert card(client, owner, p["id"])["title"] == "Кухня угловая 2350+1760"
    model(client, owner, q["id"], load_tree("rack_no_back"))
    assert card(client, owner, q["id"])["title"] == "Стеллаж 600×400×1800"


def test_master_title_is_never_overwritten(client, owner):
    p = create(client, owner, title="Шкаф Азизы", source_text="шкаф в прихожую")
    assert p["title"] == "Шкаф Азизы" and p["title_source"] == "user"
    model(client, owner, p["id"], load_tree("kupe_3doors"))
    assert card(client, owner, p["id"])["title"] == "Шкаф Азизы"

    # авто → мастер переименовал → модель меняется, название остаётся
    q = create(client, owner)
    model(client, owner, q["id"], load_tree("wardrobe_full"))
    assert card(client, owner, q["id"])["title"] == "Шкаф 1800×600×2400"
    r = client.patch(f"/projects/{q['id']}", json={"title": "Спальня"}, headers=owner).json()
    assert r["title"] == "Спальня" and r["title_source"] == "user"
    model(client, owner, q["id"], load_tree("kupe_3doors"))
    assert card(client, owner, q["id"])["title"] == "Спальня"
    # вернуть автоназвание
    r = client.patch(f"/projects/{q['id']}", json={"title_source": "auto"}, headers=owner).json()
    assert r["title"] == "Шкаф-купе 2400×650×2400" and r["title_source"] == "auto"


def test_measurement_and_undo_update_title(client, owner):
    p = create(client, owner, source_text="стеллаж")
    model(client, owner, p["id"], load_tree("wardrobe_2sec"))
    assert card(client, owner, p["id"])["title"] == "Стеллаж 1200×600×2400"
    client.post(f"/projects/{p['id']}/sketch", headers=owner)
    r = client.post(f"/projects/{p['id']}/measurements", json={"width": 1300}, headers=owner)
    assert r.status_code == 201 and r.json()["applied_version_id"]
    assert card(client, owner, p["id"])["title"] == "Стеллаж 1300×600×2400"
    assert client.post(f"/projects/{p['id']}/model/undo", headers=owner).status_code == 200
    assert card(client, owner, p["id"])["title"] == "Стеллаж 1200×600×2400"


def test_uzbek_titles_follow_author_language(client, owner):
    client.patch("/auth/me", json={"language": "uz"}, headers=owner)
    p = create(client, owner, title="Yangi loyiha 03.11.2026")
    assert p["title"] == "Yangi loyiha"
    model(client, owner, p["id"], load_tree("kupe_3doors"))
    assert card(client, owner, p["id"])["title"] == "Kupe shkaf 2400×650×2400"
    q = create(client, owner, source_text="oshxona")
    model(client, owner, q["id"], load_tree("kitchen_straight"))
    assert card(client, owner, q["id"])["title"] == "To‘g‘ri oshxona 2850"


def test_ai_design_sets_title(client, owner, fake):
    p = create(client, owner, title="Новый проект 04.11.2026")
    fake.replies.append(response(design(tree=load_tree("wardrobe_full"))))
    r = client.post(f"/projects/{p['id']}/ai/design", json={"text": "шкаф с антресолью"}, headers=owner)
    assert r.status_code == 202, r.text
    assert client.get(f"/tasks/{r.json()['task_id']}", headers=owner).json()["result"]["version_id"]
    assert card(client, owner, p["id"])["title"] == "Шкаф 1800×600×2400"


def test_backfill_retitles_only_auto_and_date_titles(app, client, owner):
    ids = {}
    for key, title, text in (("date", "Новый проект 01.11.2026", None), ("user", "Кухня маме", None),
                             ("frag", "Тумба под ТВ", "Тумба под ТВ, белая")):
        ids[key] = create(client, owner, title="Мой проект", source_text=text)["id"]
        model(client, owner, ids[key], load_tree("kupe_3doors"))
        with app.state.db.sessionmaker() as s:  # как старые записи: до миграции 0007 всё — «user»
            pr = s.get(Project, uuid.UUID(ids[key]))
            pr.title, pr.title_source = title, "user"
            s.commit()
    with app.state.db.sessionmaker() as s:
        changed = titles.retitle_all(s)
        s.commit()
    assert [(old, new) for _, old, new in changed] == [("Новый проект 01.11.2026", "Шкаф-купе 2400×650×2400")]
    assert card(client, owner, ids["user"])["title"] == "Кухня маме"
    assert card(client, owner, ids["frag"])["title"] == "Тумба под ТВ"
    with app.state.db.sessionmaker() as s:  # первая фраза описания — по флагу; повтор — без изменений
        assert [old for _, old, _ in titles.retitle_all(s, include_fragments=True)] == ["Тумба под ТВ"]
        s.commit()
        assert titles.retitle_all(s, include_fragments=True) == []


def test_legacy_date_title_is_picked_up_on_next_model(app, client, owner):
    pid = create(client, owner, title="Мой проект")["id"]
    with app.state.db.sessionmaker() as s:
        pr = s.get(Project, uuid.UUID(pid))
        pr.title, pr.title_source = "Новый проект 02.11.2026", "user"
        s.commit()
    model(client, owner, pid, load_tree("wardrobe_full"))
    c = card(client, owner, pid)
    assert c["title"] == "Шкаф 1800×600×2400" and c["title_source"] == "auto"


@pytest.mark.parametrize("tree, expected", [
    ({"type": "wardrobe", "width": 450, "height": 2200, "depth": 560, "sections": [{"doors": {"count": 1}}]}, "penal"),
    ({"type": "wardrobe", "width": 1200, "height": 800, "depth": 450,
      "sections": [{"fill": [{"kind": "drawers"}]}, {"fill": [{"kind": "drawers"}]}]}, "komod"),
    ({"type": "wardrobe", "width": 1800, "height": 500, "depth": 400, "sections": [{"doors": {"count": 2}}]}, "tumba"),
    ({"type": "wardrobe", "width": 1200, "height": 2200, "depth": 400, "sections": [{"doors": {"count": 2}}]}, "wardrobe"),
])
def test_kind_rules(tree, expected):
    assert titles.kind_from_tree(tree) == expected
    assert titles.kind_from_tree(tree | {"width": 1500}, hint="шкаф в прихожую") == "hallway"


def test_text_helpers():
    assert titles.sizes_from_text("тумба 1800x450x500 под ТВ") == "1800×450×500"
    assert titles.sizes_from_text("в нишу 2400 на 2700") == "2400×2700"
    assert titles.kind_from_text("угловой шкаф") == "wardrobe"
    assert titles.kind_from_text("угловая кухня") == "kitchen_corner"
    assert titles.is_default_title("Новый проект 03.11.2026") and titles.is_default_title(None)
    assert titles.is_default_title("Шкаф", "Шкаф, белый") and not titles.is_default_title("Шкаф Азизы", "Шкаф, белый")


def test_hints_only_refine_what_tree_cannot_show():
    tall = {"type": "wardrobe", "width": 700, "height": 2200, "depth": 560, "sections": [{"doors": {"count": 1}}]}
    assert titles.kind_from_tree(tall, hint="ИИ: пенал") == "penal"
    assert titles.kind_from_tree(tall, hint="ИИ: распашной шкаф с тумбой") == "wardrobe"
    low = tall | {"height": 800, "sections": [{"doors": {"count": 2}}]}
    assert titles.kind_from_tree(low, hint="комод") == "komod"
    kupe = tall | {"width": 2400, "sliding_doors": {"count": 2}}
    assert titles.kind_from_tree(kupe, hint="стеллаж") == "kupe"
