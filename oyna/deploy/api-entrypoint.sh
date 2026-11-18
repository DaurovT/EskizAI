#!/bin/sh
# Первый запуск: пустая база → schema.sql + справочники и демо-цех (seed_import.py). Повторно — пропуск.
# Обновление справочников без потери заказов: docker compose exec oyna-api python oyna_data/seed_import.py "$OYNA_DSN"
set -eu
attempt=1
until python -c "import os, psycopg; psycopg.connect(os.environ['OYNA_DSN']).close()" 2>/dev/null; do
    [ "$attempt" -ge 20 ] && { echo "база недоступна" >&2; exit 1; }
    attempt=$((attempt + 1)); sleep 3
done
if ! python -c "import os, psycopg; c = psycopg.connect(os.environ['OYNA_DSN']); assert c.execute(\"SELECT to_regclass('public.companies')\").fetchone()[0]" 2>/dev/null; then
    echo "новая база: схема и справочники"
    python -c "import os, psycopg; c = psycopg.connect(os.environ['OYNA_DSN'], autocommit=True); c.execute(open('/app/oyna_data/schema.sql').read())"
    python /app/oyna_data/seed_import.py "$OYNA_DSN"
fi
exec "$@"
