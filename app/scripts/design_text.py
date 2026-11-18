"""Видимая структура макета без CSS: python3 scripts/design_text.py Orders [Order …]
Печатает дерево блоков с классами (sheet, row, cta, ban.err, fld…) и текстом — чтобы собирать экран по макету."""
import html
import re
import sys
from pathlib import Path

D = Path(__file__).resolve().parent.parent / "docs" / "design"
VOID = {"img", "br", "input", "meta", "link", "path", "circle", "rect", "line", "polyline", "polygon"}


def dump(name: str) -> None:
    s = (D / f"{name}.dc.html").read_text()
    body = s[s.index('<div class="app"'):s.index("</x-dc>")]
    body = re.sub(r"<svg.*?</svg>", "[icon]", body, flags=re.S)
    depth, out = 0, []
    for m in re.finditer(r"<(/?)([a-zA-Z0-9-]+)([^>]*)>|([^<]+)", body):
        close, tag, attrs, text = m.groups()
        if text is not None:
            t = " ".join(html.unescape(text).split())
            if t:
                out.append("  " * depth + "· " + t)
            continue
        if close:
            depth = max(0, depth - 1)
            continue
        cls = re.search(r'class="([^"]*)"', attrs or "")
        href = re.search(r'href="([^"]*)"', attrs or "")
        sty = re.search(r'style="([^"]*)"', attrs or "")
        label = (cls.group(1) if cls else "") + (f" →{href.group(1)}" if href else "")
        if sty and any(k in sty.group(1) for k in ("background", "color:#")):
            label += "  {" + ";".join(x for x in sty.group(1).split(";") if "background" in x or x.strip().startswith("color"))[:80] + "}"
        if label.strip():
            out.append("  " * depth + f"<{tag} {label.strip()}>")
        if tag not in VOID and not (attrs or "").rstrip().endswith("/"):
            depth += 1
    print(f"===== {name}")
    print("\n".join(out))


for n in sys.argv[1:]:
    dump(n)
