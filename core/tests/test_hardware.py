import json
from pathlib import Path

from mebel_core import apply_patch, build, estimate, hardware_options

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def opt(groups, key, value):
    g = next(g for g in groups if g.key == key)
    return next(o for o in g.options if o.value == value)


def test_options_have_price_deltas_and_patches() -> None:
    tree = load("wardrobe_full")
    groups = hardware_options(tree)
    assert {g.key for g in groups} == {"hinge", "hinge_class", "slides", "slides_class", "handles", "handle_finish",
                                       "lighting"}
    assert opt(groups, "hinge", "soft_close").current
    premium = opt(groups, "hinge_class", "premium")
    econom = opt(groups, "hinge_class", "econom")
    assert premium.delta > 0 > econom.delta
    # Патч из варианта даёт ровно ту разницу в цене
    new_tree = apply_patch(tree, premium.patch)
    assert estimate(build(new_tree)).total_client - estimate(build(tree)).total_client == premium.delta


def test_hidden_slides_change_drawer_width() -> None:
    tree = load("wardrobe_full")
    hidden = apply_patch(tree, opt(hardware_options(tree), "slides", "hidden_full").patch)
    ball_box = next(p for p in build(tree).parts if p.role == "drawer_bottom")
    hidden_box = next(p for p in build(hidden).parts if p.role == "drawer_bottom")
    assert hidden_box.length - ball_box.length == 2 * (130 - 50)  # зазор 13 → 5 мм с каждой стороны


def test_push_hinges_warn_about_handles() -> None:
    tree = load("wardrobe_full")
    push = opt(hardware_options(tree), "hinge", "push")
    assert push.available and "ручки" in push.note.lower()
    r = build(apply_patch(tree, push.patch))
    fix = next(i for i in r.issues if i.code == "push_with_handles").fixes[0]
    assert "push_with_handles" not in {i.code for i in build(apply_patch(apply_patch(tree, push.patch), fix.patch)).issues}


def test_groups_only_for_present_hardware() -> None:
    groups = hardware_options(load("rack_no_back"))  # без дверей и ящиков — только подсветка ниш
    assert [g.key for g in groups] == ["lighting"]
