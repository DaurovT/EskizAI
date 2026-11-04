#!/bin/sh
# Точка входа образа API.
#   RUN_MIGRATIONS=1   — перед запуском команды выполнить `alembic upgrade head`
#                        (с повторами, пока база не станет доступна);
#   MIGRATION_RETRIES  — число попыток (по умолчанию 10, пауза 3 с);
#   аргумент `migrate` — только миграции и выход (для разового запуска при деплое).
set -eu

migrate() {
    attempt=1
    max="${MIGRATION_RETRIES:-10}"
    until alembic -c /app/alembic.ini upgrade head; do
        if [ "$attempt" -ge "$max" ]; then
            echo "alembic: миграции не прошли после $attempt попыток" >&2
            exit 1
        fi
        echo "alembic: попытка $attempt не удалась, повтор через 3 с…" >&2
        attempt=$((attempt + 1))
        sleep 3
    done
}

if [ "${1:-}" = "migrate" ]; then
    migrate
    exit 0
fi

if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
    migrate
fi

exec "$@"
