#!/usr/bin/env bash
# Проверка восстановления бэкапа (PRD NFR-12): последний дамп разворачивается во временную
# базу на том же Postgres, проверяются схема и данные, база удаляется.
# Код выхода ≠ 0 — бэкап непригоден (cron пришлёт письмо / не будет пинга мониторинга).
#
#   deploy/scripts/restore_check.sh                 # последний *.dump из BACKUP_DIR
#   deploy/scripts/restore_check.sh path/to.dump    # конкретный файл
#
# Переменные: те же, что у backup.sh (BACKUP_DIR, POSTGRES_USER, POSTGRES_DB, PG_EXEC), плюс
#   RESTORE_CHECK_PING_URL — URL, который дёрнуть при успехе (например, healthchecks.io).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"

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
DB_USER="$(env_get POSTGRES_USER mebel)"
DB_NAME="$(env_get POSTGRES_DB mebel)"
PING_URL="$(env_get RESTORE_CHECK_PING_URL)"

log() { echo "$(date -u +%FT%TZ) restore_check: $*"; }
fail() { log "ОШИБКА: $*"; exit 1; }
sha256_check() { if command -v sha256sum >/dev/null; then sha256sum -c "$@"; else shasum -a 256 -c "$@"; fi; }
q() { ${PG[@]+"${PG[@]}"} psql -U "$DB_USER" -d "$1" -v ON_ERROR_STOP=1 -tAc "$2"; }

dump="${1:-}"
if [[ -z "$dump" ]]; then
    dump="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -n1 || true)"
fi
[[ -n "$dump" && -s "$dump" ]] || fail "дамп не найден (BACKUP_DIR=$BACKUP_DIR)"
log "проверяю $dump"

if [[ -f "$dump.sha256" ]]; then
    (cd "$(dirname "$dump")" && sha256_check --status "$(basename "$dump").sha256") || fail "контрольная сумма не совпала"
fi

check_db="restore_check_$(date -u +%Y%m%d%H%M%S)"
cleanup() { ${PG[@]+"${PG[@]}"} dropdb -U "$DB_USER" --if-exists "$check_db" >/dev/null 2>&1 || true; }
trap cleanup EXIT

${PG[@]+"${PG[@]}"} createdb -U "$DB_USER" "$check_db"
${PG[@]+"${PG[@]}"} pg_restore -U "$DB_USER" -d "$check_db" --no-owner --no-privileges --exit-on-error < "$dump" \
    || fail "pg_restore завершился с ошибкой"

tables="$(q "$check_db" "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
[[ "$tables" -gt 0 ]] || fail "в восстановленной базе нет таблиц"

restored_rev="$(q "$check_db" "select version_num from alembic_version" 2>/dev/null || true)"
[[ -n "$restored_rev" ]] || fail "нет alembic_version — дамп не от этой схемы"
live_rev="$(q "$DB_NAME" "select version_num from alembic_version" 2>/dev/null || true)"
if [[ -n "$live_rev" && "$live_rev" != "$restored_rev" ]]; then
    log "внимание: ревизия дампа $restored_rev, рабочей базы $live_rev (миграция после бэкапа?)"
fi

# Сравнение числа строк по таблицам с рабочей базой: в дампе может быть меньше (данные
# добавились после бэкапа), но не пусто там, где в рабочей базе есть данные.
report=""
empty_bad=0
while IFS= read -r t; do
    [[ -z "$t" || "$t" == alembic_version ]] && continue
    n_restored="$(q "$check_db" "select count(*) from \"$t\"")"
    n_live="$(q "$DB_NAME" "select count(*) from \"$t\"" 2>/dev/null || echo "?")"
    report+="  $t: $n_restored (сейчас $n_live)"$'\n'
    if [[ "$n_restored" == 0 && "$n_live" =~ ^[0-9]+$ && "$n_live" -gt 100 ]]; then
        empty_bad=1
    fi
done < <(q "$check_db" "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")
printf '%s' "$report"
[[ "$empty_bad" == 0 ]] || fail "таблица пуста в дампе, хотя в рабочей базе >100 строк"

log "OK: $tables таблиц, ревизия $restored_rev"
if [[ -n "$PING_URL" ]]; then
    curl -fsS -m 10 --retry 3 "$PING_URL" > /dev/null || log "пинг мониторинга не прошёл"
fi
