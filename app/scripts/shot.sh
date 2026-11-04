#!/bin/bash
# Сверка экрана с макетом: ./scripts/shot.sh <Макет> <маршрут> [ожидание_с]
# Открывает маршрут в симуляторе iPhone 17e (390×844, как макеты), снимает экран
# и кладёт рядом с docs/design/png/<Макет>.png → /tmp/eskiz-shots/<Макет>.cmp.png
set -e
SIM=${SIM:-1F6192F5-C3B6-4910-809C-734B10B10D11}
NAME=$1; ROUTE=${2:-/}; WAIT=${3:-3}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=${SHOTS_DIR:-/tmp/eskiz-shots}; mkdir -p "$OUT"
# переход без системного «Открыть в приложении?»: команда в Documents/devnav.txt (src/dev/shot.ts)
# маршрут «-» — снять текущий экран; «login» — мок-вход; «push /x», «back» — как есть; иначе — go <маршрут>
if [ "$ROUTE" != "-" ]; then
  DOCS="$(xcrun simctl get_app_container "$SIM" uz.mebel.master data)/Documents"; mkdir -p "$DOCS"
  case "$ROUTE" in login|back|push\ *|go\ *|eval\ *) CMD="$ROUTE";; *) CMD="go /${ROUTE#/}";; esac
  echo "$CMD" > "$DOCS/devnav.txt"
fi
sleep "$WAIT"
xcrun simctl io "$SIM" screenshot "$OUT/$NAME.app.png" >/dev/null 2>&1
/usr/bin/python3 - "$ROOT/docs/design/png/$NAME.png" "$OUT/$NAME.app.png" "$OUT/$NAME.cmp.png" <<'PY'
import sys
from PIL import Image, ImageDraw
d, a, out = sys.argv[1:4]
app = Image.open(a).convert('RGB').resize((780, 1688))
try:
    des = Image.open(d).convert('RGB').resize((780, 1688))
except FileNotFoundError:
    des = Image.new('RGB', (780, 1688), '#ddd')
c = Image.new('RGB', (780 * 2 + 20, 1688 + 40), 'white')
c.paste(des, (0, 40)); c.paste(app, (800, 40))
dr = ImageDraw.Draw(c); dr.text((10, 10), 'DESIGN', fill='black'); dr.text((810, 10), 'APP', fill='black')
c.save(out)
print(out)
PY
