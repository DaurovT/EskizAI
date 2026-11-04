# syntax=docker/dockerfile:1.7
# Образ API: FastAPI (api/) + ядро (core/) + ИИ (ai/).
# Сборка из корня репозитория:
#   docker build -f deploy/docker/api.Dockerfile -t mebel-api .
#
# Пакеты core/ai/api ставятся НЕ в режиме editable (--no-editable): в итоговом образе
# нужен только /opt/venv и файлы Alembic, исходники не копируются.
# Шрифты DejaVu для PDF лежат внутри пакета mebel_core (core/src/mebel_core/fonts)
# и попадают в колесо вместе с кодом.

ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.5

FROM ${UV_IMAGE} AS uv

# ---------- сборка окружения ----------
FROM ${PYTHON_IMAGE} AS builder
COPY --from=uv /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /src

# 1) Только зависимости (слой кэшируется, пока не меняются pyproject/uv.lock).
#    У всех пакетов (numpy, shapely, mapbox-earcut, reportlab, ezdxf, trimesh, psycopg-binary …)
#    есть колёса manylinux для amd64/arm64; rectpack ставится из sdist, он на чистом Python.
COPY core/pyproject.toml core/
COPY ai/pyproject.toml ai/
COPY api/pyproject.toml api/uv.lock api/
RUN --mount=type=cache,target=/root/.cache/uv \
    cd api && uv sync --frozen --no-dev --no-editable --no-install-project --no-install-local

# 2) Свои пакеты.
COPY core/src core/src
COPY ai/src ai/src
COPY api/src api/src
RUN --mount=type=cache,target=/root/.cache/uv \
    cd api && uv sync --frozen --no-dev --no-editable \
    && /opt/venv/bin/python -c "import mebel_core, mebel_ai, mebel_api; from importlib.resources import files; assert files('mebel_core').joinpath('fonts/DejaVuSans.ttf').is_file()"

# ---------- рабочий образ ----------
FROM ${PYTHON_IMAGE} AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MEDIA_DIR=/data/media

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /app /data/media \
    && chown -R app:app /app /data

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=app:app api/alembic.ini ./alembic.ini
COPY --chown=app:app api/alembic ./alembic
COPY --chmod=0755 deploy/docker/api-entrypoint.sh /usr/local/bin/api-entrypoint

USER app
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"

# RUN_MIGRATIONS=1 → перед стартом `alembic upgrade head`. `docker run … mebel-api migrate` — только миграции.
ENTRYPOINT ["api-entrypoint"]
# Один процесс: очередь задач сейчас в памяти процесса (ThreadTaskQueue), результаты
# GET /tasks/{id} не видны из другого воркера. Масштабировать — после воркера на Redis.
CMD ["uvicorn", "mebel_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
