#!/bin/sh
# Залить eskiz-oyna в репозиторий EskizAI (папка oyna/, ветка oyna) с историей коммитов.
# Локальный main у eskiz-mebel не трогается — работаем во временном worktree от origin/oyna.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
MEBEL="$HERE/../eskiz-mebel"
WT=$(mktemp -d)/eskizai-oyna
git -C "$MEBEL" fetch -q origin oyna
git -C "$MEBEL" worktree add -q "$WT" origin/oyna
cd "$WT"
git checkout -q -B oyna origin/oyna
git subtree pull -q --prefix=oyna "$HERE" main -m "oyna: обновление из eskiz-oyna"
git push origin oyna
git -C "$MEBEL" worktree remove --force "$WT"
echo "готово: https://github.com/DaurovT/EskizAI/tree/oyna/oyna"
