# syntax=docker/dockerfile:1.7
# Образ ссылки клиента: Next.js 15 (web/) + общий пакет 3D-сцены (viewer/).
# Сборка из корня репозитория:
#   docker build -f deploy/docker/web.Dockerfile -t mebel-web .
#
# web подключает viewer как file:../viewer, поэтому структура /repo/{viewer,web}
# повторяет репозиторий. Режим standalone включается обёрткой
# deploy/docker/next.config.standalone.mjs — исходный web/next.config.mjs не меняется.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- зависимости ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
COPY viewer/package.json viewer/package-lock.json viewer/.npmrc viewer/
COPY web/package.json web/package-lock.json web/.npmrc web/
RUN --mount=type=cache,target=/root/.npm \
    cd viewer && npm ci --no-audit --no-fund
RUN --mount=type=cache,target=/root/.npm \
    cd web && npm ci --no-audit --no-fund

# ---------- сборка ----------
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY viewer viewer
COPY web web
COPY deploy/docker/next.config.standalone.mjs /tmp/next.config.standalone.mjs
RUN npm --prefix viewer run build \
    && cd web \
    && mv next.config.mjs next.config.base.mjs \
    && cp /tmp/next.config.standalone.mjs next.config.mjs \
    && npx next build

# ---------- рабочий образ ----------
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# standalone при outputFileTracingRoot=/repo кладёт сервер в web/server.js,
# рядом — нужные файлы viewer/; статику и public копируем сами.
COPY --from=builder --chown=node:node /repo/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/web/.next/static ./web/.next/static
COPY --from=builder --chown=node:node /repo/web/public ./web/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SHARE_API_URL (необязательно) читается на сервере во время запроса — можно задавать при запуске.
CMD ["node", "web/server.js"]
