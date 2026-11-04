"""Командная строка: собрать изделие из JSON и показать спецификацию.

    uv run mebel build tests/fixtures/wardrobe_2sec.json --svg out.svg
"""

import argparse
import json
import sys
from pathlib import Path

from .assembler import build
from .render_svg import front_view_svg
from .spec import format_text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mebel")
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="Собрать изделие из дерева модулей (JSON)")
    b.add_argument("input", type=Path)
    b.add_argument("--svg", type=Path, help="Сохранить вид спереди в SVG")
    b.add_argument("--svg-inside", type=Path, help="Сохранить вид спереди без фасадов")
    b.add_argument("--json", type=Path, help="Сохранить модель деталей в JSON")
    b.add_argument("--glb", type=Path, help="Сохранить GLB (закрыто); рядом — *_open.glb")
    args = parser.parse_args(argv)

    data = json.loads(args.input.read_text(encoding="utf-8"))
    result = build(data)
    print(format_text(result))
    if args.svg:
        args.svg.write_text(front_view_svg(result), encoding="utf-8")
        print(f"\nВид спереди: {args.svg}")
    if args.svg_inside:
        args.svg_inside.write_text(front_view_svg(result, fronts=False), encoding="utf-8")
        print(f"Вид без фасадов: {args.svg_inside}")
    if args.glb:
        from .glb import export_glb

        args.glb.write_bytes(export_glb(result))
        opened = args.glb.with_name(args.glb.stem + "_open.glb")
        opened.write_bytes(export_glb(result, opened=True))
        print(f"GLB: {args.glb}, {opened}")
    if args.json:
        args.json.write_text(result.model_dump_json(indent=2), encoding="utf-8")
        print(f"Модель деталей: {args.json}")
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
