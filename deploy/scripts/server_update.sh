#!/usr/bin/env bash
# Обновление сервера из архива кода (запускается НА сервере).
# С машины разработчика:
#   git archive HEAD -o /tmp/release.tar
#   scp release.tar deploy/scripts/server_update.sh azureuser@HOST:/tmp/
#   ssh azureuser@HOST "bash /tmp/server_update.sh" < /dev/null
# Порядок: резервная копия → код → сборка api+web → запуск → Caddy (если менялся Caddyfile) → миграции.
set -e
cd /opt/mebel
echo "== backup"; sudo deploy/scripts/backup.sh < /dev/null 2>&1 | tail -1
echo "== code"; tar -x -C /opt/mebel < /tmp/release.tar && rm /tmp/release.tar
C="sudo docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml --env-file deploy/.env"
echo "== build"; $C build api web < /dev/null 2>&1 | grep -E "Built|ERROR" | tail -3
echo "== up"; $C up -d < /dev/null 2>&1 | tail -2
for i in $(seq 1 60); do
  s=$($C ps --format "{{.Service}} {{.Status}}" < /dev/null)
  echo "$s" | grep -q "api.*(healthy)" && echo "$s" | grep -q "web.*(healthy)" && break
  sleep 5
done
$C ps --format "{{.Service}} {{.Status}}" < /dev/null
# Caddyfile примонтирован отдельным файлом: после замены файла reload его не видит — нужен перезапуск контейнера
echo "== caddy"
sudo docker exec mebel-caddy-1 cat /etc/caddy/Caddyfile | cmp -s - deploy/Caddyfile \
  || { sudo docker restart mebel-caddy-1 > /dev/null && echo "caddy restarted (new Caddyfile)"; }
echo "== alembic"; $C exec -T api alembic upgrade head < /dev/null 2>&1 | tail -1; $C exec -T api alembic current < /dev/null 2>&1 | tail -1
echo "DEPLOY DONE"
