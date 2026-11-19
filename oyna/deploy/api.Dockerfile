# Образ API Eskiz Oyna: FastAPI (oyna_api) + ядро (oyna_core) + справочники (oyna_data).
# Сборка из корня репозитория:  docker build -f deploy/api.Dockerfile -t oyna-api .
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core postgresql-client \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY pyproject.toml /app/
RUN pip install "fastapi>=0.110" "uvicorn>=0.29" "psycopg[binary]>=3.1" "pyjwt>=2.8" "httpx>=0.27" "reportlab>=4" "svglib>=1.5" "openpyxl>=3.1"
COPY oyna_core /app/oyna_core
COPY oyna_api /app/oyna_api
COPY oyna_data /app/oyna_data
COPY deploy/api-entrypoint.sh /entrypoint.sh
RUN useradd -m -u 10001 app && chmod +x /entrypoint.sh
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "oyna_api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--workers", "2"]
