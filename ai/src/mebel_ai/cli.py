"""Живая проверка ИИ (нужен ANTHROPIC_API_KEY; каждый вызов стоит денег).

    uv run mebel-ai design "шкаф-купе 2,4 метра, три двери, зеркало посередине"
    uv run mebel-ai design --photo shkaf.jpg "как на фото, ниша 1800"
    uv run mebel-ai edit tree.json "шире на 20 см"
"""

import argparse
import json
import mimetypes
import sys
from pathlib import Path

from .design import DesignSession, Photo, describe
from .edit import edit_tree
from .llm import LLM


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="mebel-ai")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("design")
    d.add_argument("text", nargs="?", default="")
    d.add_argument("--photo", action="append", type=Path, default=[])
    d.add_argument("--lang", choices=["ru", "uz"], default="ru")
    d.add_argument("--out", type=Path, help="Сохранить дерево модулей")
    e = sub.add_parser("edit")
    e.add_argument("tree", type=Path)
    e.add_argument("instruction")
    args = ap.parse_args(argv)

    llm = LLM()
    if args.cmd == "design":
        photos = [Photo(p.read_bytes(), mimetypes.guess_type(p.name)[0] or "image/jpeg") for p in args.photo]
        s = DesignSession(language=args.lang, llm=llm)
        r = s.start(args.text, photos)
        print(describe(r))
        while r.status == "questions" and sys.stdin.isatty():
            answers = {q.id: (input(f"{q.text} [{q.default}]: ").strip() or q.default) for q in r.questions}
            r = s.answer(answers)
            print(describe(r))
        if args.out and r.tree:
            args.out.write_text(json.dumps(r.tree, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        tree = json.loads(args.tree.read_text(encoding="utf-8"))
        r = edit_tree(tree, args.instruction, llm=llm)
        print(r.summary or r.error)
        if r.ok:
            args.tree.write_text(json.dumps(r.tree, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nИИ: {len(llm.log)} запросов, {llm.total_tokens} токенов, ${llm.total_cost:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
