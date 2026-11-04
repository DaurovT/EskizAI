#!/usr/bin/env bash
# Ежедневный бэкап Postgres (PRD NFR-12) и, при локальном хранилище, папки media.
#
#   deploy/scripts/backup.sh            # из любого места; читает deploy/.env
#
# cron на сервере (03:15 по Ташкенту = 22:15 UTC), затем проверка восстановления:
#   15 22 * * * /opt/mebel/deploy/scripts/backup.sh >> /var/log/mebel-backup.log 2>&1 && /opt/mebel/deploy/scripts/restore_check.sh >> /var/log/mebel-backup.log 2>&1
#
# Переменные (из окружения или deploy/.env):
#   BACKUP_DIR            куда класть дампы (по умолчанию /var/backups/mebel)
#   BACKUP_KEEP_DAYS      сколько дней хранить локально (14)
#   BACKUP_RCLONE_TARGET  rclone remote:path для копии вне сервера (пусто — не копировать)
#   BACKUP_MEDIA          1 — архивировать том media (по умолчанию 1 при STORAGE_BACKEND=local)
#   PG_EXEC               префикс для pg_dump (по умолчанию `docker compose … exec -T postgres`;
#                         пустая строка — локальные pg_dump/psql с PGHOST/PGPORT)
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"

# Значение: окружение → deploy/.env → по умолчанию. .env не исполняем как shell-скрипт.
env_get() {
    local key="$1" default="${2:-}" val=""
    if [[ -n "${!key+x}" ]]; then
        printf '%s' "${!key}"
        return
    fi
    if [[ -f "$ENV_FILE" ]]; then
        val="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
        val="${val%\"}"; val="${val#\"}"
    fi
    printf '%s' "${val:-$default}"
}

COMPOSE=(docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml")
[[ -f "$ENV_FILE" ]] && COMPOSE+=(--env-file "$ENV_FILE")

if [[ -n "${PG_EXEC+x}" ]]; then
    read -r -a PG <<<"$PG_EXEC"
else
    PG=("${COMPOSE[@]}" exec -T postgres)
fi

BACKUP_DIR="$(env_get BACKUP_DIR /var/backups/mebel)"
KEEP_DAYS="$(env_get BACKUP_KEEP_DAYS 14)"
RCLONE_TARGET="$(env_get BACKUP_RCLONE_TARGET)"
DB_USER="$(env_get POSTGRES_USER mebel)"
DB_NAME="$(env_get POSTGRES_DB mebel)"
STORAGE_BACKEND="$(env_get STORAGE_BACKEND local)"
BACKUP_MEDIA="$(env_get BACKUP_MEDIA "$([[ "$STORAGE_BACKEND" == local ]] && echo 1 || echo 0)")"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
log() { echo "$(date -u +%FT%TZ) backup: $*"; }

mkdir -p "$BACKUP_DIR"
umask 077
ts="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$BACKUP_DIR/${DB_NAME}_${ts}.dump"

log "pg_dump $DB_NAME → $dump"
${PG[@]+"${PG[@]}"} pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner --no-privileges > "$dump.partial"
if [[ ! -s "$dump.partial" ]]; then
    log "ОШИБКА: пустой дамп"; rm -f "$dump.partial"; exit 1
fi
# Оглавление читается — архив не обрезан.
${PG[@]+"${PG[@]}"} pg_restore --list < "$dump.partial" > /dev/null
mv "$dump.partial" "$dump"
(cd "$BACKUP_DIR" && sha256 "$(basename "$dump")" > "$(basename "$dump").sha256")
log "готово: $(du -h "$dump" | cut -f1)"

files=("$dump" "$dump.sha256")

if [[ "$BACKUP_MEDIA" == 1 ]]; then
    media="$BACKUP_DIR/media_${ts}.tar.gz"
    log "media → $media"
    "${COMPOSE[@]}" exec -T api tar -C /data -czf - media > "$media"
    (cd "$BACKUP_DIR" && sha256 "$(basename "$media")" > "$(basename "$media").sha256")
    files+=("$media" "$media.sha256")
fi

if [[ -n "$RCLONE_TARGET" ]]; then
    log "копия вне сервера → $RCLONE_TARGET"
    for f in "${files[@]}"; do rclone copy --no-traverse "$f" "$RCLONE_TARGET"; done
fi

log "удаляю локальные копии старше $KEEP_DAYS дн."
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.tar.gz' -o -name '*.sha256' \) -mtime +"$KEEP_DAYS" -delete
