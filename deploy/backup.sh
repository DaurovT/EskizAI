#!/bin/sh
# Ночная копия базы Oyna: /var/backups/oyna, хранится 14 дней. Запуск — /etc/cron.d/oyna-backup.
set -eu
DIR=/var/backups/oyna
mkdir -p "$DIR"
docker exec oyna-oyna-db-1 pg_dump -U oyna -d oyna | gzip > "$DIR/oyna-$(date +%F).sql.gz"
find "$DIR" -name 'oyna-*.sql.gz' -mtime +14 -delete
