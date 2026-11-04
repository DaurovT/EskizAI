# Быстрые команды монорепо. Подробнее о запуске стека и деплое — deploy/README.md.

COMPOSE := docker compose -f deploy/docker-compose.yml
COMPOSE_PROD := $(COMPOSE) -f deploy/docker-compose.prod.yml

.PHONY: help test test-core test-ai test-api test-api-pg test-viewer test-web test-app \
        build up down logs ps migrate prod-up backup restore-check

help:
	@echo "make test         — тесты core, ai, api (SQLite), viewer"
	@echo "make test-core | test-ai | test-api | test-api-pg | test-viewer | test-web | test-app"
	@echo "make build        — собрать образы api и web"
	@echo "make up / down    — поднять / остановить локальный стек (deploy/docker-compose.yml)"
	@echo "make logs | ps | migrate | prod-up | backup | restore-check"

test: test-core test-ai test-api test-viewer

test-core:
	cd core && uv sync --locked && uv run pytest -q

test-ai:
	cd ai && uv sync --locked && uv run pytest -q

test-api:
	cd api && uv sync --locked && uv run pytest -q

# Нужен запущенный Postgres (make up или cd api && docker compose up -d) и база mebel_test.
TEST_DATABASE_URL ?= postgresql+psycopg://mebel:mebel@localhost:5432/mebel_test
test-api-pg:
	cd api && uv sync --locked && TEST_DATABASE_URL=$(TEST_DATABASE_URL) uv run pytest -q

test-viewer:
	cd viewer && npm ci --no-audit --no-fund && npm test

test-web:
	cd viewer && npm ci --no-audit --no-fund
	cd web && npm ci --no-audit --no-fund && npm run build

test-app:
	cd viewer && npm ci --no-audit --no-fund && npm run build
	cd app && npm ci --no-audit --no-fund && npx tsc --noEmit && npx jest --ci --passWithNoTests

build:
	$(COMPOSE) build api web

up:
	$(COMPOSE) up -d --build
	@echo "API: http://localhost:8000/docs   web: http://localhost:3000/p/demo   MinIO: http://localhost:9001"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

migrate:
	$(COMPOSE) run --rm api migrate

prod-up:
	$(COMPOSE_PROD) up -d --build

backup:
	deploy/scripts/backup.sh

restore-check:
	deploy/scripts/restore_check.sh
