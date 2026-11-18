#!/bin/bash
# Сверка экрана с макетом в симуляторе: ./scripts/shot.sh <Макет> "<команда>" [ожидание_с]
# Команды DevNav: "go /orders", "push /order/ID", "back", "login +998901234567", "logout", "-" — снять как есть.
# Рядом кладёт картинку макета (docs/design/png/<Макет>.png, если есть) → $OUT/<Макет>.cmp.png
set -e
SIM=${SIM:-A5CFCB03-1B09-4155-9ED5-11F4F74190CD}
NAME=$1; CMD=${2:--}; WAIT=${3:-3}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=${SHOTS_DIR:-$HOME/oyna-dev/shots}; mkdir -p "$OUT"
if [ "$CMD" != "-" ]; then
  DOCS="$(xcrun simctl get_app_container "$SIM" uz.eskiz.oyna data)/Documents"; mkdir -p "$DOCS"
  echo "$CMD" > "$DOCS/devnav.txt"
fi
sleep "$WAIT"
xcrun simctl io "$SIM" screenshot "$OUT/$NAME.app.png" >/dev/null 2>&1
echo "$OUT/$NAME.app.png"
