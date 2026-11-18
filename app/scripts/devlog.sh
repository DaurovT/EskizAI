#!/bin/bash
# Журнал предупреждений/ошибок JS из симулятора (пишет src/dev/DevNav.tsx в режиме разработки).
SIM=${SIM:-8E3B6F94-0D78-497D-8DC7-A33EFEC42A5D}
F="$(xcrun simctl get_app_container "$SIM" uz.eskiz.oyna data)/Documents/devlog.txt"
[ "$1" = "-c" ] && { rm -f "$F"; echo "очищено"; exit 0; }
[ -f "$F" ] && cat "$F" || echo "(пусто)"
